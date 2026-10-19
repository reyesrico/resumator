import AdmZip from "adm-zip";
import { DOMParser, XMLSerializer, type Document, type Element } from "@xmldom/xmldom";
import type { Edit, Paragraph } from "../shared/types.js";
import { AppError } from "./errors.js";
import { diffChars } from "diff";
import { validateFacts } from "./facts.js";
import { hasTextChange } from "../shared/changes.js";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function openZip(buffer: Buffer) {
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    if (entries.length > 2000 || entries.reduce((sum, entry) => sum + entry.header.size, 0) > 40 * 1024 * 1024) {
      throw new AppError(413, "The document exceeds the 40 MB expanded processing limit.");
    }
    if (!zip.getEntry("word/document.xml")) throw new AppError(422, "This is not a valid DOCX document.");
    for (const entry of entries) {
      if (/vbaProject|\/embeddings\//i.test(entry.entryName)) {
        throw new AppError(422, "Documents with macros or embedded executable objects are not supported.");
      }
      if (!entry.entryName.endsWith(".rels")) continue;
      const relations = parseXml(zip.readAsText(entry));
      for (const node of Array.from(relations.getElementsByTagName("Relationship"))) {
        if (node.getAttribute("TargetMode") === "External" && !node.getAttribute("Type")?.endsWith("/hyperlink")) {
          throw new AppError(422, "Externally linked templates and assets are not supported. Embed the assets in Word first.");
        }
      }
    }
    return zip;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(422, "The Word document is corrupt, encrypted, or unsupported.");
  }
}

function parseXml(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new AppError(422, "XML document entities are not supported.");
  try {
    return new DOMParser({
      onError: (level, message) => { throw new Error(`${level}: ${message}`); },
    }).parseFromString(xml, "application/xml");
  } catch {
    throw new AppError(422, "The document contains malformed XML.");
  }
}

function paragraphNodes(document: Document) {
  // A text box has its own paragraphs; do not count its outer anchor twice.
  return Array.from(document.getElementsByTagNameNS(W, "p"))
    .filter((paragraph) => paragraph.getElementsByTagNameNS(W, "p").length === 0);
}

function paragraphText(paragraph: Element) {
  return Array.from(paragraph.getElementsByTagNameNS(W, "t")).map((node) => node.textContent ?? "").join("");
}

export function readParagraphs(buffer: Buffer): Paragraph[] {
  const zip = openZip(buffer);
  const document = parseXml(zip.readAsText("word/document.xml"));
  const paragraphs = paragraphNodes(document)
    .map((node, index) => ({
      id: `p${index}`,
      text: paragraphText(node),
      editable: !["fldChar", "instrText", "fldSimple", "tab", "br", "hyperlink", "ins", "del"]
        .some((tag) => node.getElementsByTagNameNS(W, tag).length),
    }))
    .filter((paragraph) => paragraph.text.trim());
  if (!paragraphs.length) throw new AppError(422, "No editable text was found. Scanned or image-only resumes require OCR before upload.");
  if (paragraphs.length > 500 || paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0) > 60_000) {
    throw new AppError(413, "The resume exceeds 500 paragraphs or 60,000 characters.");
  }
  return paragraphs;
}

export function validateEdits(paragraphs: Paragraph[], edits: Edit[]) {
  const allowed = new Set(paragraphs.map((paragraph) => paragraph.id));
  const protectedIds = new Set(paragraphs.filter((paragraph) => !paragraph.editable).map((paragraph) => paragraph.id));
  const seen = new Set<string>();
  for (const edit of edits) {
    if (!allowed.has(edit.id) || seen.has(edit.id)) throw new AppError(422, "An edit references an unknown or duplicate paragraph.");
    if (protectedIds.has(edit.id)) throw new AppError(422, "This paragraph contains layout controls, links, fields, or tracked changes and cannot be edited safely.");
    if (!edit.text.trim() || edit.text.length > 8000 || /[\u0000-\u001F\u007F]/.test(edit.text)) {
      throw new AppError(422, "A replacement paragraph contains empty, oversized, multiline, or invalid text.");
    }
    seen.add(edit.id);
  }
  validateFacts(paragraphs, edits);
}

export function applyEdits(buffer: Buffer, edits: Edit[], scale = 1): Buffer {
  if (scale < 0.94 || scale > 1) throw new AppError(422, "Layout adjustments cannot exceed six percent.");
  validateEdits(readParagraphs(buffer), edits);
  const paragraphs = readParagraphs(buffer);
  const actualEdits = edits.filter((edit) => hasTextChange(paragraphs.find((paragraph) => paragraph.id === edit.id)!.text, edit.text));
  if (actualEdits.length === 0 && scale === 1) return buffer;
  const zip = openZip(buffer);
  const document = parseXml(zip.readAsText("word/document.xml"));
  const replacements = new Map(actualEdits.map((edit) => [edit.id, edit.text]));
  paragraphNodes(document).forEach((paragraph, index) => {
    const text = replacements.get(`p${index}`);
    if (text === undefined) return;
    const nodes = Array.from(paragraph.getElementsByTagNameNS(W, "t"));
    const original = nodes.map((node) => node.textContent ?? "");
    const owners = original.flatMap((value, owner) => Array.from({ length: value.length }, () => owner));
    const updated = original.map(() => "");
    let offset = 0;
    let removedOwner: number | undefined;
    // Unchanged characters keep their exact run; only replacements inherit a neighboring style.
    for (const part of diffChars(original.join(""), text)) {
      if (part.removed) {
        removedOwner = owners[offset];
        offset += part.value.length;
      } else if (part.added) {
        const owner = removedOwner ?? owners[offset] ?? owners[offset - 1] ?? 0;
        updated[owner] += part.value;
        removedOwner = undefined;
      } else {
        for (let index = 0; index < part.value.length; index++) {
          updated[owners[offset]] += part.value[index];
          offset++;
        }
        removedOwner = undefined;
      }
    }
    nodes.forEach((node, nodeIndex) => {
      node.textContent = updated[nodeIndex];
      node.setAttribute("xml:space", "preserve");
    });
  });
  zip.updateFile("word/document.xml", Buffer.from(new XMLSerializer().serializeToString(document)));
  if (scale < 1) {
    for (const entry of zip.getEntries()) {
      if (!/^word\/(document|styles|header\d*|footer\d*)\.xml$/.test(entry.entryName)) continue;
      const xml = parseXml(zip.readAsText(entry));
      for (const tag of ["sz", "szCs", "spacing"]) {
        for (const node of Array.from(xml.getElementsByTagNameNS(W, tag))) {
          for (const attribute of tag === "spacing" ? ["before", "after"] : ["val"]) {
            const raw = node.getAttributeNS(W, attribute);
            if (!raw || !Number.isFinite(Number(raw))) continue;
            const current = Number(raw);
            const floor = tag === "spacing" ? 0 : Math.min(18, current);
            node.setAttributeNS(W, `w:${attribute}`, String(Math.max(floor, Math.ceil(current * scale))));
          }
        }
      }
      zip.updateFile(entry.entryName, Buffer.from(new XMLSerializer().serializeToString(xml)));
    }
  }
  return zip.toBuffer();
}
