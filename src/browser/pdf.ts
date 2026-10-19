import * as m from "mupdf";
import type { Edit, Paragraph } from "../../shared/types";
import { hasTextChange } from "../../shared/changes";

interface Glyph { font: m.Font; matrix: m.Matrix; gid: number; unicode: number }
interface Character { text: string; origin: m.Point; quad: m.Quad; font: m.Font; size: number; color: m.Color }
interface Line { chars: Character[]; box: m.Rect; direction: m.Point; context: string }
interface Region extends Paragraph { page: number; lines: Line[]; chars: Character[] }
interface Decoration { path: m.Path; box: m.Rect; color: m.Color; alpha: number; stroke?: m.StrokeState; evenOdd: boolean }
interface Inspection { regions: Region[]; glyphs: Map<number, Map<number, Glyph>>; placed:Map<number,Glyph[]>; decorations: Map<number, Decoration[]>; pages: number; fonts: Set<m.Font> }
const intersects = (a: m.Rect, b: m.Rect) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const contains = (a: m.Rect, b: m.Rect) => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];
function charBox(c: Character): m.Rect {
  const xs = [c.quad[0], c.quad[2], c.quad[4], c.quad[6]], ys = [c.quad[1], c.quad[3], c.quad[5], c.quad[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function bounds(chars: Character[]): m.Rect {
  const boxes = chars.map(charBox);
  return [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])), Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))];
}
function copyPath(path: m.Path, transform: m.Matrix) {
  const copy = new m.Path();
  path.walk({ moveTo: (x,y) => copy.moveTo(x,y), lineTo: (x,y) => copy.lineTo(x,y),
    curveTo: (a,b,c,d,e,f) => copy.curveTo(a,b,c,d,e,f), closePath: () => copy.closePath() });
  copy.transform(transform);
  return copy;
}
function inspect(document: m.PDFDocument): Inspection {
  if (document.needsPassword()) throw new Error("Unlock the encrypted PDF before opening it here.");
  const pages = document.countPages();
  if (!pages || pages > 5) throw new Error("Use a PDF containing one to five pages. Final PDF downloads require one page.");
  const regions: Region[] = [], glyphs = new Map<number, Map<number, Glyph>>(), placed = new Map<number,Glyph[]>(), decorations = new Map<number, Decoration[]>(), fonts = new Set<m.Font>();
  for (let pageIndex = 0; pageIndex < pages; pageIndex++) {
    const page = document.loadPage(pageIndex);
    const vectors: Decoration[] = [];
    const strokeZero = new m.StrokeState({ lineWidth: 0, lineCap:"Butt", lineJoin:"Miter", miterLimit:10 });
    const capture = new m.Device({
      fillText(text, ctm,_space,_color,alpha) {
        text.walk({ showGlyph(font, trm, gid, unicode, wmode) {
          fonts.add(font);
          if (wmode || gid < 0 || unicode < 0 || alpha!==1) return;
          const matrix = m.Matrix.concat(trm, ctm);
          const map = glyphs.get(font.pointer) ?? new Map<number, Glyph>();
          map.set(unicode, { font, matrix, gid, unicode }); glyphs.set(font.pointer, map);
          const positions=placed.get(pageIndex)??[];
          positions.push({font,matrix,gid,unicode});placed.set(pageIndex,positions);
        } });
      },
      fillPath(path, evenOdd, ctm, _space, color, alpha) {
        const box = path.getBounds(strokeZero, ctm);
        if (box[2] > box[0] && box[3] - box[1] <= 1.5 && box[3] >= box[1]) vectors.push({
          path: copyPath(path, ctm), box, color: color as m.Color, alpha, evenOdd,
        });
      },
      strokePath(path,stroke,ctm,_space,color,alpha){
        const box=path.getBounds(strokeZero,ctm);
        if(box[2]>box[0]&&box[3]-box[1]<=1.5&&box[3]>=box[1]){
          const copy=new m.StrokeState({lineWidth:stroke.getLineWidth(),lineCap:m.StrokeState.LINE_CAP[stroke.getLineCap()],
            lineJoin:m.StrokeState.LINE_JOIN[stroke.getLineJoin()],miterLimit:stroke.getMiterLimit(),
            dashPhase:stroke.getDashPhase(),dashes:stroke.getDashes()??[]});
          vectors.push({path:copyPath(path,ctm),box,color:color as m.Color,alpha,evenOdd:false,stroke:copy});
        }
      },
    });
    page.runPageContents(capture, m.Matrix.identity); capture.close(); capture.destroy(); strokeZero.destroy();
    decorations.set(pageIndex, vectors);
    const text = page.toStructuredText("inhibit-spaces");
    const lines: Line[] = [];
    let blockLines: Line[] = [], line: Line | undefined;
    text.walk({
      beginTextBlock() { blockLines = []; },
      beginLine(box, _wmode, direction) { line = { chars: [], box, direction, context: "" }; },
      onChar(c, origin, font, size, quad, color) {
        fonts.add(font);
        line?.chars.push({ text: c, origin, font, size, quad, color });
      },
      endLine() { if (line?.chars.length) { lines.push(line); blockLines.push(line); } },
      endTextBlock() { const context = blockLines.map(item => item.chars.map(c => c.text).join("")).join(" "); blockLines.forEach(item => item.context = context); },
    });
    const links = page.getLinks().map(link => link.getBounds());
    const transform = page.getTransform();
    const pageBounds=page.getBounds();
    for (const sourceLine of lines) {
      const groups: Character[][] = [];
      for (const char of sourceLine.chars) {
        const prior = groups.at(-1)?.[0];
        if (prior && prior.font.pointer === char.font.pointer && Math.abs(prior.size - char.size) < 0.01 &&
          JSON.stringify(prior.color) === JSON.stringify(char.color)) groups.at(-1)!.push(char);
        else groups.push([char]);
      }
      for (const chars of groups) {
        const content = chars.map(c => c.text).join("").trim();
        if (!content) continue;
        const box = bounds(chars), first = chars[0];
        const reason = Math.abs(sourceLine.direction[0] - 1) > 0.001 || Math.abs(sourceLine.direction[1]) > 0.001 ||
          Math.abs(transform[1]) > 0.001 || Math.abs(transform[2]) > 0.001 || Math.abs(transform[4]) > 0.001
          || Math.abs(transform[0]-1)>.001 || Math.abs(transform[3]+1)>.001 || Math.abs(transform[5]-pageBounds[3])>.001
          ? "Rotated or offset page geometry is protected."
          : links.some(link => chars.some(char=>char.text.trim()&&intersects(charBox(char),link))) ? "Link labels are protected; their targets remain unchanged."
          : vectors.some(vector=>contains([box[0]-.3,box[1],box[2]+.3,box[3]+1],vector.box))
            ? "Underlined inline text is protected; neighboring wording can still be edited."
          : !glyphs.has(first.font.pointer) ? "This original text style cannot be safely reused in the browser." : undefined;
        const id = `p${regions.length}`;
        regions.push({ id, text: content, editable: !reason, ...(reason ? { protectedReason: reason } : {}),
          context: sourceLine.context, page: pageIndex, lines: [sourceLine], chars });
      }
    }
    text.destroy(); page.destroy();
  }
  if (!regions.length || regions.length > 500 || regions.reduce((sum,r) => sum+r.text.length,0) > 60_000) {
    throw new Error("PDF must contain selectable text within the 500-region / 60,000-character limit. Scanned resumes need OCR.");
  }
  return { regions, glyphs, placed, decorations, pages, fonts };
}
function cleanup(data: Inspection) {
  data.fonts.forEach(font => font.destroy());
  data.decorations.forEach(items => items.forEach(item => {item.path.destroy();item.stroke?.destroy();}));
}
function unicodeMap(glyphs:Map<number,number>){
  const entries=[...glyphs].map(([gid,unicode])=>{
    const encoded=Array.from(String.fromCodePoint(unicode).split(""),char=>char.charCodeAt(0).toString(16).padStart(4,"0")).join("");
    return `<${gid.toString(16).padStart(4,"0")}> <${encoded}>`;
  });
  const groups:string[]=[];
  for(let i=0;i<entries.length;i+=100){const part=entries.slice(i,i+100);groups.push(`${part.length} beginbfchar\n${part.join("\n")}\nendbfchar`);}
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /ResumatorUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n${groups.join("\n")}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
}
export function inspectBrowserPdf(bytes: ArrayBuffer) {
  const document = new m.PDFDocument(bytes);
  let data: Inspection | undefined;
  try {
    data = inspect(document);
    return { pages: data.pages, paragraphs: data.regions.map(({ id,text,editable,protectedReason,context }) => ({ id,text,editable,protectedReason,context })) };
  } finally { if (data) cleanup(data); document.destroy(); }
}

export function renderBrowserPdf(bytes: ArrayBuffer, edits: Edit[]) {
  const document = new m.PDFDocument(bytes);
  let data: Inspection | undefined;
  try {
    data = inspect(document);
    const plans: { region: Region; text: string; glyphs: Glyph[]; delta: number; widthScale: number }[] = [];
    const issues: string[] = [];
    for (const edit of edits) {
      const region = data.regions.find(region => region.id === edit.id);
      if (!region || !region.editable) throw new Error("An edit references an unsupported PDF text region.");
      if (!hasTextChange(region.text, edit.text)) continue;
      const first = region.chars[0], map = data.glyphs.get(first.font.pointer)!;
      const tail = region.chars.map(c=>c.text).join("").match(/\s+$/)?.[0] ?? "";
      const text = edit.text.trim() + tail;
      const glyphList: Glyph[] = [];
      for (const char of text) {
        const code = char.codePointAt(0)!;
        let glyph = map.get(code);
        if (!glyph) {
          const gid = first.font.encodeCharacter(code);
          const reliable = [...map].every(([unicode, old]) => first.font.encodeCharacter(unicode) === old.gid);
          if (gid && reliable) glyph = { font: first.font, gid, unicode: code, matrix: map.values().next().value!.matrix };
        }
        if (!glyph) { issues.push(`${region.id}: "${char}" is missing from this original font. Reword without substituting the font.`); break; }
        glyphList.push(glyph);
      }
      if (glyphList.length !== Array.from(text).length) continue;
      const box = bounds(region.chars);
      const originalWidth = region.chars.reduce((sum,c) => {
        const glyph = map.get(c.text.codePointAt(0)!);
        return sum + (glyph ? first.font.advanceGlyph(glyph.gid) * first.size : 0);
      },0);
      const widthScale = originalWidth > 0 ? (box[2] - first.origin[0]) / originalWidth : 1;
      const width = glyphList.reduce((sum,g) => sum + first.font.advanceGlyph(g.gid)*first.size*widthScale,0);
      const delta = first.origin[0]+width-box[2];
      if (delta > 0.15) { issues.push(`${region.id}: wording is too wide for its original line. Shorten it; the browser will not shrink or rebuild your template.`); continue; }
      plans.push({ region, text, glyphs: glyphList, delta, widthScale });
    }
    if (issues.length || !plans.length) return { bytes, pages: data.pages, issues };
    for (let index = 0; index < data.pages; index++) {
      const pagePlans = plans.filter(plan => plan.region.page === index);
      if (!pagePlans.length) continue;
      const page = document.loadPage(index);
      const pageRegions = data.regions.filter(region => region.page === index);
      const offsetAt = (x: number,y: number) => pagePlans.filter(plan =>
        Math.abs(plan.region.chars[0].origin[1] - y) < 0.1 && plan.region.chars.at(-1)!.origin[0] + .1 < x
      ).reduce((sum,plan) => sum+plan.delta,0);
      const altered = pageRegions.filter(region => pagePlans.some(plan=>plan.region === region) ||
        Math.abs(offsetAt(region.chars[0].origin[0], region.chars[0].origin[1])) > 0.05);
      const movedDecorations: { decoration: Decoration; offset: number }[] = [];
      for (const decoration of data.decorations.get(index) ?? []) {
        const region = altered.find(region => {
          const box = bounds(region.chars);
          return contains([box[0]-.3,box[1],box[2]+.3,box[3]+1], decoration.box);
        });
        if (!region) continue;
        const offset = offsetAt(region.chars[0].origin[0],region.chars[0].origin[1]);
        if (Math.abs(offset) < .05) continue;
        movedDecorations.push({ decoration, offset });
        const redact = page.createAnnotation("Redact");
        const padding=decoration.stroke?decoration.stroke.getLineWidth()*decoration.stroke.getMiterLimit()/2+.05:.05;
        const removal:m.Rect=[decoration.box[0]-padding,decoration.box[1]-padding,decoration.box[2]+padding,decoration.box[3]+padding];
        if((data.decorations.get(index)??[]).some(other=>other!==decoration&&contains(removal,other.box))){
          issues.push("An inline underline overlaps another decoration; this edit cannot be moved safely.");
        }
        redact.setRect(removal);
        redact.setColor([]);
      }
      if (movedDecorations.length) page.applyRedactions(false,0,1,1);
      for (const region of altered) {
        for (const c of region.chars) {
          const box = charBox(c);
          const removal: m.Rect = [box[0]+.02,c.origin[1]-c.size*.4,box[2]-.02,c.origin[1]-c.size*.3];
          if(!c.text.trim()){
            const neighbor=pageRegions.filter(other=>other!==region&&Math.abs(other.chars[0].origin[1]-c.origin[1])<.1&&other.chars[0].origin[0]>c.origin[0])
              .sort((a,b)=>a.chars[0].origin[0]-b.chars[0].origin[0])[0];
            if(neighbor)removal[2]=Math.min(removal[2],neighbor.chars[0].origin[0]-.05);
            if(removal[2]<=removal[0])continue;
          }
          if (pageRegions.some(other => other !== region && !altered.includes(other) && other.chars.some(char => char.text.trim() && intersects(removal,charBox(char))))) {
            issues.push(`${region.id}: overlapping text prevents safe browser editing.`);
          }
          const redact = page.createAnnotation("Redact"); redact.setRect(removal); redact.setColor([]);
        }
      }
      if (issues.length) { page.destroy(); return { bytes, pages: data.pages, issues }; }
      const linkMoves = page.getLinks().map(link => ({ link, uri:link.getURI(), box: link.getBounds() })).filter(({box}) =>
        altered.some(region => intersects(bounds(region.chars),box)));
      for(const {link} of linkMoves)page.deleteLink(link);
      page.applyRedactions(false,0,0,0);
      const buffer = new m.Buffer();
      const writer = new m.DocumentWriter(buffer,"PDF","");
      const device = writer.beginPage(page.getBounds());
      const usedFonts=new Map<number,{font:m.Font;glyphs:Map<number,number>}>();
      const recordGlyph=(font:m.Font,gid:number,unicode:number)=>{
        const used=usedFonts.get(font.pointer)??{font,glyphs:new Map<number,number>()};
        if(used.glyphs.has(gid)&&used.glyphs.get(gid)!==unicode)issues.push("Ambiguous original glyph mapping prevents a searchable PDF export.");
        used.glyphs.set(gid,unicode);usedFonts.set(font.pointer,used);
      };
      for (const region of altered) {
        const first = region.chars[0], plan = pagePlans.find(plan => plan.region === region);
        const offset = offsetAt(first.origin[0], first.origin[1]);
        const text = new m.Text();
        if (plan) {
          let x = first.origin[0] + offset;
          for (const glyph of plan.glyphs) {
            text.showGlyph(first.font,[first.size*plan.widthScale,0,0,-first.size,x,first.origin[1]],glyph.gid,glyph.unicode);
            recordGlyph(first.font,glyph.gid,glyph.unicode);
            x += first.font.advanceGlyph(glyph.gid)*first.size*plan.widthScale;
          }
        } else {
          for (const c of region.chars) {
            const glyph = data.placed.get(index)?.find(glyph=>glyph.font.pointer===c.font.pointer&&glyph.unicode===c.text.codePointAt(0)&&
              Math.abs(glyph.matrix[4]-c.origin[0])<.1&&Math.abs(glyph.matrix[5]-c.origin[1])<.1);
            if(!glyph&&!c.text.trim())continue;
            if (!glyph) { issues.push(`${region.id}: an inline glyph cannot be moved safely.`); break; }
            const matrix:m.Matrix=[...glyph.matrix];matrix[4]+=offset;
            text.showGlyph(c.font,matrix,glyph.gid,glyph.unicode);
            recordGlyph(c.font,glyph.gid,glyph.unicode);
          }
        }
        device.fillText(text,m.Matrix.identity,m.ColorSpace.DeviceRGB,first.color.length===3 ? first.color : [0,0,0],1);
        text.destroy();
      }
      for (const {decoration,offset} of movedDecorations) {
        if(decoration.stroke)device.strokePath(decoration.path,decoration.stroke,m.Matrix.translate(offset,0),m.ColorSpace.DeviceRGB,decoration.color,decoration.alpha);
        else device.fillPath(decoration.path,decoration.evenOdd,m.Matrix.translate(offset,0),m.ColorSpace.DeviceRGB,decoration.color,decoration.alpha);
      }
      writer.endPage(); writer.close(); writer.destroy();
      const overlay = new m.PDFDocument(buffer);
      const overlayPage = overlay.findPage(0);
      let fontIndex=0;
      for(const {font,glyphs} of usedFonts.values()){
        const resource=overlayPage.get("Resources","Font",`F${fontIndex++}`);
        if(resource.isNull()||resource.get("BaseFont").asName()!==font.getName()){
          issues.push("The PDF writer changed an original font resource. This edit cannot be exported safely.");
          continue;
        }
        resource.put("ToUnicode",overlay.addStream(unicodeMap(glyphs),{}));
      }
      const map = document.newGraftMap();
      const form = document.addStream(overlayPage.get("Contents").readStream(), {
        Type:"XObject",Subtype:"Form",BBox:overlayPage.get("MediaBox").asJS(),
        Resources:map.graftObject(overlayPage.get("Resources")),
      });
      const resources = page.getObject().getInheritable("Resources");
      const copied = document.newDictionary();
      resources.forEach((value,key)=>copied.put(key,value));
      const xobjects = document.newDictionary();
      resources.get("XObject").forEach((value,key)=>xobjects.put(key,value));
      let name = "ResumatorBrowserOverlay",suffix=0;
      while(!xobjects.get(name).isNull())name=`ResumatorBrowserOverlay${++suffix}`;
      xobjects.put(name,form);copied.put("XObject",xobjects);page.getObject().put("Resources",copied);
      const contents = page.getObject().get("Contents");
      const streams = document.newArray(); streams.push(document.addStream("q\n",{}));
      if (contents.isArray()) contents.forEach(value=>streams.push(value)); else streams.push(contents);
      streams.push(document.addStream(`Q\nq /${name} Do Q\n`,{})); page.getObject().put("Contents",streams);
      for (const {uri,box} of linkMoves) {
        const shift = offsetAt(box[0],(box[1]+box[3])/2);
        const touching = altered.find(region=>region.chars.some(char=>char.text.trim()&&intersects(charBox(char),box)));
        const dx = touching ? offsetAt(touching.chars[0].origin[0],touching.chars[0].origin[1]) : shift;
        page.createLink([box[0]+dx,box[1],box[2]+dx,box[3]],uri);
      }
      map.destroy();overlay.destroy();buffer.destroy();page.destroy();
    }
    if (issues.length) return { bytes, pages: data.pages, issues };
    const saved = document.saveToBuffer("garbage=1,compress");
    try { return { bytes: saved.asUint8Array().slice().buffer as ArrayBuffer, pages: data.pages, issues }; }
    finally { saved.destroy(); }
  } finally { if(data)cleanup(data);document.destroy(); }
}

export function pdfImages(bytes: ArrayBuffer) {
  const document = new m.PDFDocument(bytes);
  try {
    return Array.from({length:document.countPages()},(_,index)=>{
      const page = document.loadPage(index);
      const pixmap = page.toPixmap(m.Matrix.scale(1.4,1.4),m.ColorSpace.DeviceRGB,false,true);
      try { return new Blob([pixmap.asPNG().slice().buffer as ArrayBuffer],{type:"image/png"}); }
      finally { pixmap.destroy();page.destroy(); }
    });
  } finally { document.destroy(); }
}
