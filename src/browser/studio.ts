import { editSchema, type Edit, type RenderResult, type ResumeInfo } from "../../shared/types";
import { z } from "zod";
import { deleteDocument, getDocument, listDocuments, saveDocument } from "./library";
import { hasSessionKey, suggestBrowserEdits } from "./claude";
import { validateBrowserEdits } from "./validation";
import { inspectBrowserWord, renderBrowserWord } from "./word";

const previews = new Map<string,{ bytes:ArrayBuffer; result:RenderResult; approved?:string }>();
export async function localRender(id:string, edits:Edit[]) {
  const saved=await getDocument(id);
  validateBrowserEdits(saved.info.paragraphs,edits);
  let bytes:ArrayBuffer, pages:number, issues:string[], verified:boolean;
  if(saved.info.format==="pdf"){
    const engine=await import("./pdf");
    const rendered=engine.renderBrowserPdf(saved.bytes,edits);
    bytes=rendered.bytes;pages=rendered.pages;issues=rendered.issues;verified=true;
    engine.pdfImages(bytes);
  } else {
    bytes=renderBrowserWord(saved.bytes,edits);pages=0;issues=[];verified=false;
  }
  const result:RenderResult={pages,ready:verified&&pages===1&&issues.length===0,scale:1,revision:crypto.randomUUID(),
    blockedEdits:issues, warnings:[...issues,...(!verified?["DOCX is an editable draft. Browser Word previews cannot certify Microsoft Word pagination. Open it in Word/Pages and verify one page, or use a one-page PDF source for certified PDF export."]:[]),
      ...(verified&&pages!==1?["The original PDF has more than one page. Pages are not deleted to force a one-page result."]:[])]};
  previews.set(id,{bytes,result});return result;
}
export async function browserRequest(path:string,options?:RequestInit):Promise<unknown>{
  const method=options?.method??"GET";
  if(path==="/health") return {ready:true,claude:hasSessionKey(),libreoffice:false,pdf2docx:false,pdfNative:true,model:"claude-sonnet-5-5"};
  if(path==="/resumes"&&method==="GET"){const versions=await listDocuments();return {versions,latestId:versions[0]?.id??null};}
  if(path==="/resumes"&&method==="POST"){
    if(!(options?.body instanceof FormData))throw new Error("Choose a resume file.");
    const file=options.body.get("resume");
    if(!(file instanceof File)||file.size>10*1024*1024)throw new Error("Choose a PDF or DOCX up to 10 MB.");
    const bytes=await file.arrayBuffer(),signature=new Uint8Array(bytes,0,Math.min(5,bytes.byteLength));
    let info:ResumeInfo;
    const base={id:crypto.randomUUID(),name:file.name,createdAt:new Date().toISOString()};
    if(/\.pdf$/i.test(file.name)&&new TextDecoder().decode(signature)==="%PDF-"){
      const engine=await import("./pdf");const inspected=engine.inspectBrowserPdf(bytes);
      info={...base,format:"pdf",originalPages:inspected.pages,paragraphs:inspected.paragraphs,
        warnings:["Browser PDF editing keeps original fonts and blocks unsupported glyphs or overflow. Review the full layout before approval."]};
    }else if(/\.docx$/i.test(file.name)&&signature[0]===0x50&&signature[1]===0x4b){
      info={...base,format:"docx",originalPages:0,paragraphs:inspectBrowserWord(bytes),
        warnings:["DOCX previews are approximate. Browser-only mode cannot certify Word page count or automatically convert Word to an original-layout PDF."]};
    }else throw new Error("Choose a valid PDF or DOCX. Legacy .doc is not supported in the browser; save it as DOCX or PDF first.");
    return saveDocument({info,bytes});
  }
  const match=path.match(/^\/resumes\/([a-f0-9-]+)(?:\/(tailor|render|approve))?$/);
  if(!match)throw new Error("This operation is unavailable in browser-only mode. Paste the job description instead of importing a URL.");
  const [,id,action]=match;
  if(method==="DELETE"){await deleteDocument(id);previews.delete(id);return undefined;}
  if(!action)return (await getDocument(id)).info;
  const body:unknown=typeof options?.body==="string"?JSON.parse(options.body):undefined;
  if(action==="tailor"){
    const input=z.object({jobText:z.string(),consent:z.literal(true)}).parse(body);
    const saved=await getDocument(id);
    const suggestions=await suggestBrowserEdits(saved.info.paragraphs,input.jobText,input.consent);
    const render=await localRender(id,suggestions.edits);
    return {...suggestions,render};
  }
  if(action==="render")return localRender(id,z.object({edits:z.array(editSchema).max(500)}).parse(body).edits);
  const input=z.object({revision:z.string().uuid(),reviewed:z.literal(true)}).parse(body);
  const preview=previews.get(id);
  if(!preview?.result.ready||preview.result.revision!==input.revision)throw new Error("Review the latest one-page PDF preview first.");
  preview.approved=input.revision;return {approved:true};
}
export async function documentBytes(id:string,tailored=false){
  if(!tailored)return (await getDocument(id)).bytes;
  const preview=previews.get(id);
  if(!preview)throw new Error("Generate a preview first.");
  return preview.bytes;
}
export async function downloadDocument(id:string,original=false,draft=false){
  const saved=await getDocument(id);
  if(original)return {bytes:saved.bytes,name:saved.info.name,type:saved.info.format};
  const preview=previews.get(id);
  if(!preview)throw new Error("Generate a preview first.");
  if(draft){
    if(saved.info.format!=="docx")throw new Error("Only DOCX sources have Word draft exports.");
  }else if(!preview.result.ready||preview.approved!==preview.result.revision)throw new Error("Approve the latest one-page PDF before downloading.");
  return {bytes:preview.bytes,name:saved.info.name.replace(/\.[^.]+$/,"")+(draft?"-draft.docx":"-tailored.pdf"),type:saved.info.format};
}
export function saveFile(bytes:ArrayBuffer,name:string,type:string){
  const blob=new Blob([bytes],{type:type==="pdf"?"application/pdf":"application/vnd.openxmlformats-officedocument.wordprocessingml.document"});
  const url=URL.createObjectURL(blob),anchor=document.createElement("a");
  anchor.href=url;anchor.download=name;document.body.append(anchor);anchor.click();anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60_000);
}
