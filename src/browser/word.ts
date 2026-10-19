import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { DOMParser, XMLSerializer, type Document, type Element } from "@xmldom/xmldom";
import { diffChars } from "diff";
import type { Edit, Paragraph } from "../../shared/types";
import { validateBrowserEdits } from "./validation";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
function parseXml(text: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("XML entities are not supported in resumes.");
  return new DOMParser({ onError: () => { throw new Error("This DOCX contains malformed XML."); } }).parseFromString(text,"application/xml");
}
function open(bytes: ArrayBuffer) {
  let size = 0, count = 0;
  const archive = unzipSync(new Uint8Array(bytes), { filter: file => {
    size += file.originalSize; count++;
    if (size > 40*1024*1024 || count > 2000) throw new Error("DOCX exceeds the 40 MB expanded processing limit.");
    return true;
  } });
  if (!archive["word/document.xml"]) throw new Error("This file is not a valid DOCX document.");
  for (const [name, data] of Object.entries(archive)) {
    if (/vbaProject|\/embeddings\/|afchunk|altchunk/i.test(name)) throw new Error("DOCX macros, embedded objects and HTML imports are not supported.");
    if (!name.endsWith(".rels")) continue;
    const xml = parseXml(strFromU8(data));
    for (const relationship of Array.from(xml.getElementsByTagName("Relationship"))) {
      if (relationship.getAttribute("TargetMode")==="External" && !relationship.getAttribute("Type")?.endsWith("/hyperlink")) {
        throw new Error("Externally linked templates or images are not supported. Embed them in Word first.");
      }
    }
  }
  return archive;
}
function nodes(document: Document) {
  return Array.from(document.getElementsByTagNameNS(W,"p")).filter(node=>node.getElementsByTagNameNS(W,"p").length===0);
}
function content(node: Element) { return Array.from(node.getElementsByTagNameNS(W,"t")).map(item=>item.textContent??"").join(""); }
export function inspectBrowserWord(bytes: ArrayBuffer): Paragraph[] {
  const archive = open(bytes), xml = parseXml(strFromU8(archive["word/document.xml"]));
  const paragraphs = nodes(xml).map((node,index)=>{
    const protectedText = ["fldChar","instrText","fldSimple","tab","br","hyperlink","ins","del","altChunk"]
      .some(name=>node.getElementsByTagNameNS(W,name).length>0);
    return {id:`p${index}`,text:content(node),editable:!protectedText,
      ...(protectedText?{protectedReason:"Links, fields, line breaks or tracked changes are protected."}:{})};
  }).filter(item=>item.text.trim());
  if (!paragraphs.length || paragraphs.length>500 || paragraphs.reduce((sum,p)=>sum+p.text.length,0)>60_000) {
    throw new Error("DOCX must contain selectable text within 500 paragraphs and 60,000 characters.");
  }
  return paragraphs;
}
export function renderBrowserWord(bytes: ArrayBuffer, edits: Edit[]) {
  const paragraphs = inspectBrowserWord(bytes);
  validateBrowserEdits(paragraphs,edits);
  if (!edits.length) return bytes;
  const archive = open(bytes), xml = parseXml(strFromU8(archive["word/document.xml"]));
  const changes = new Map(edits.map(edit=>[edit.id,edit.text]));
  nodes(xml).forEach((paragraph,index)=>{
    const replacement = changes.get(`p${index}`);
    if (replacement===undefined) return;
    const textNodes = Array.from(paragraph.getElementsByTagNameNS(W,"t"));
    const original = textNodes.map(node=>node.textContent??"");
    const owners = original.flatMap((text,owner)=>Array.from({length:text.length},()=>owner));
    const updated = original.map(()=>"");
    let offset=0,removedOwner:number|undefined;
    for (const part of diffChars(original.join(""),replacement)) {
      if(part.removed){removedOwner=owners[offset];offset+=part.value.length;}
      else if(part.added){updated[removedOwner??owners[offset]??owners[offset-1]??0]+=part.value;removedOwner=undefined;}
      else {for(const char of part.value.split("")){updated[owners[offset]]+=char;offset++;}removedOwner=undefined;}
    }
    textNodes.forEach((node,i)=>{node.textContent=updated[i];node.setAttribute("xml:space","preserve");});
  });
  archive["word/document.xml"]=strToU8(new XMLSerializer().serializeToString(xml));
  return zipSync(archive).slice().buffer as ArrayBuffer;
}
