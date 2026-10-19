import { useEffect, useRef, useState } from "react";
import { documentBytes } from "./browser/studio";

export default function DocumentPreview({id,format,tailored=false,revision,onStatus}:{
  id:string;format:string;tailored?:boolean;revision?:string;onStatus:(ready:boolean)=>void;
}){
  const [images,setImages]=useState<string[]>([]),[html,setHtml]=useState(""),[error,setError]=useState("");
  const status=useRef(onStatus);status.current=onStatus;
  useEffect(()=>{
    let active=true;const urls:string[]=[];
    setImages([]);setHtml("");setError("");status.current(false);
    void(async()=>{
      const bytes=await documentBytes(id,tailored);
      if(format==="pdf"){
        const {pdfImages}=await import("./browser/pdf");
        const images=pdfImages(bytes).map(blob=>{const url=URL.createObjectURL(blob);urls.push(url);return url;});
        if(active){setImages(images);status.current(true);}
      }else{
        const {renderAsync}=await import("docx-preview");
        const body=document.createElement("div"),style=document.createElement("div");
        await renderAsync(bytes,body,style,{inWrapper:true,ignoreWidth:false,ignoreHeight:false,useBase64URL:true,
          renderAltChunks:false,renderComments:false,renderChanges:false,breakPages:true});
        const markup=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:"><style>body{margin:0;background:#edf0f5}.docx-wrapper{padding:12px!important}section.docx{max-width:100%;box-sizing:border-box}img{max-width:100%}</style>${style.innerHTML}</head><body>${body.innerHTML}</body></html>`;
        if(active){setHtml(markup);status.current(true);}
      }
    })().catch((cause:unknown)=>{if(active){setError(cause instanceof Error?cause.message:"Could not render this document.");status.current(false);}});
    return()=>{active=false;urls.forEach(url=>URL.revokeObjectURL(url));};
  },[id,format,tailored,revision]);
  if(error)return <div className="notice error" role="alert">Preview failed: {error}. Downloads cannot be approved without previews.</div>;
  if(html)return <iframe className="pdf-preview" title={`${tailored?"Tailored":"Original"} DOCX preview (approximate)`} sandbox="" srcDoc={html}/>;
  if(!images.length)return <div className="preview-placeholder">Rendering on your device…</div>;
  return <div className="browser-pdf-preview">{images.map((url,index)=><img key={url} src={url} alt={`${tailored?"Tailored":"Original"} resume, page ${index+1}`} />)}</div>;
}
