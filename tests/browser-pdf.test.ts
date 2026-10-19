import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from "pdf-lib";
import * as m from "mupdf";
import { inspectBrowserPdf, renderBrowserPdf } from "../src/browser/pdf";

async function source(inline=false,linked=false,stroked=false) {
  const doc=await PDFDocument.create(),page=doc.addPage([612,792]),font=await doc.embedFont(StandardFonts.Helvetica);
  const prefix=inline?"Implemented a new global website with ":"Built reliable web applications.";
  page.drawText(prefix,{x:50,y:700,size:11,font});
  if(inline){
    const x=50+font.widthOfTextAtSize(prefix,11),width=font.widthOfTextAtSize("Spigit",11);
    page.drawText("Spigit",{x,y:700,size:11,font,color:rgb(0,0,1)});
    if(stroked)page.drawLine({start:{x,y:698},end:{x:x+width,y:698},thickness:.7,color:rgb(0,0,1)});
    else page.drawRectangle({x,y:698,width,height:.7,color:rgb(0,0,1)});
    page.drawText(" (platform).",{x:x+width,y:700,size:11,font});
    if(linked)page.node.set(PDFName.of("Annots"),doc.context.obj([doc.context.register(doc.context.obj({
      Type:"Annot",Subtype:"Link",Rect:[x+.1,697,x+width-.1,710],
      A:{Type:"Action",S:"URI",URI:PDFString.of("https://example.com/platform")},
    }))]));
  }
  page.drawText("Unrelated line stays unchanged.",{x:50,y:650,size:11,font});
  page.drawLine({start:{x:40,y:600},end:{x:560,y:600},color:rgb(.3,.4,.5)});
  return (await doc.save()).slice().buffer as ArrayBuffer;
}
function outsidePixels(before:ArrayBuffer,after:ArrayBuffer){
  const a=new m.PDFDocument(before),b=new m.PDFDocument(after),pa=a.loadPage(0),pb=b.loadPage(0);
  const ap=pa.toPixmap(m.Matrix.identity,m.ColorSpace.DeviceRGB,false),bp=pb.toPixmap(m.Matrix.identity,m.ColorSpace.DeviceRGB,false);
  try{
    const x=ap.getPixels(),y=bp.getPixels();let outside=0,inside=0;
    for(let i=0;i<x.length;i+=3){
      if(x[i]===y[i]&&x[i+1]===y[i+1]&&x[i+2]===y[i+2])continue;
      const row=Math.floor(i/3/ap.getWidth());
      if(row<76||row>99)outside++;else inside++;
    }
    return {outside,inside};
  }finally{ap.destroy();bp.destroy();pa.destroy();pb.destroy();a.destroy();b.destroy();}
}
describe("browser-only PDF engine",()=>{
  it("edits with original glyphs, remains one page, and changes no unrelated pixels",async()=>{
    const bytes=await source();const info=inspectBrowserPdf(bytes);
    const rendered=renderBrowserPdf(bytes,[{id:info.paragraphs[0].id,text:"Built robust web applications.",reason:"Relevant wording"}]);
    expect(rendered.issues).toEqual([]);expect(rendered.pages).toBe(1);
    const pixels=outsidePixels(bytes,rendered.bytes);expect(pixels.outside).toBe(0);expect(pixels.inside).toBeGreaterThan(0);
    const result=inspectBrowserPdf(rendered.bytes);expect(result.paragraphs.map(p=>p.text).join(" ")).toContain("Built robust web applications.");
  });
  it("keeps blue inline labels, underlines and suffixes together after shortening",async()=>{
    const bytes=await source(true);
    const result=renderBrowserPdf(bytes,[{id:"p0",text:"Built a website with",reason:"Targeted wording"}]);
    expect(result.issues).toEqual([]);
    const doc=new m.PDFDocument(result.bytes),page=doc.loadPage(0);
    const lines:string[]=[];const text=page.toStructuredText("");
    text.walk({beginLine(){lines.push("");},onChar(c){lines[lines.length-1]+=c;}});
    expect(lines.join(" ")).toContain("Built a website with Spigit (platform).");
    const before=new m.PDFDocument(bytes),oldPage=before.loadPage(0);
    const oldX=oldPage.search("Spigit",{})[0][0][0],newX=page.search("Spigit",{})[0][0][0];
    expect(newX).toBeLessThan(oldX-60);
    expect(outsidePixels(bytes,result.bytes).outside).toBe(0);
    text.destroy();oldPage.destroy();before.destroy();page.destroy();doc.destroy();
  });
  it("blocks overflow and missing glyphs atomically and preserves exact no-op bytes",async()=>{
    const bytes=await source();
    expect(renderBrowserPdf(bytes,[]).bytes).toBe(bytes);
    const result=renderBrowserPdf(bytes,[{id:"p0",text:"Long replacement ".repeat(30),reason:"Overflow"}]);
    expect(result.issues.join()).toContain("too wide");expect(result.bytes).toBe(bytes);
    const missing=renderBrowserPdf(bytes,[{id:"p0",text:"Built 🚀 applications.",reason:"Unsupported glyph"}]);
    expect(missing.issues.join()).toContain("missing");expect(missing.bytes).toBe(bytes);
  });
  it("moves actual URI link targets with their unchanged inline labels, without duplicates",async()=>{
    for(const stroked of [false,true]){
      const bytes=await source(true,true,stroked);
      const result=renderBrowserPdf(bytes,[{id:"p0",text:"Built a website with",reason:"Relevant supported wording"}]);
      expect(result.issues).toEqual([]);
      const doc=new m.PDFDocument(result.bytes),page=doc.loadPage(0),links=page.getLinks();
      expect(links).toHaveLength(1);expect(links[0].getURI()).toBe("https://example.com/platform");
      expect(links[0].getBounds()[0]).toBeCloseTo(page.search("Spigit",{})[0][0][0]+.1,0);
      expect(outsidePixels(bytes,result.bytes).outside).toBe(0);
      page.destroy();doc.destroy();
    }
  });
});
