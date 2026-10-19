import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import { applyEdits, readParagraphs, validateEdits } from "../server/docx";
import { makeDocx } from "./fixtures";

describe("template-preserving text changes", () => {
  it("reads stable IDs and replaces text across formatted runs without losing styles or page geometry", () => {
    const source = makeDocx();
    expect(readParagraphs(source)).toEqual([{ id: "p0", text: "Built reliable web applications.", editable: true }]);
    const edited = applyEdits(source, [{ id: "p0", text: "Delivered reliable web applications.", reason: "Use active wording." }]);
    expect(readParagraphs(edited)[0].text).toBe("Delivered reliable web applications.");
    const xml = new AdmZip(edited).readAsText("word/document.xml");
    expect(xml).toContain("<w:b/>");
    expect(xml).toContain('w:val="24"');
    expect(xml).toContain('w:w="12240"');
    expect(new AdmZip(edited).readAsText("word/styles.xml")).toBe(new AdmZip(source).readAsText("word/styles.xml"));
    expect(readParagraphs(source)[0].text).toBe("Built reliable web applications.");
  });
  it("escapes XML text and keeps Unicode intact at run boundaries", () => {
    const edited = applyEdits(makeDocx(), [{ id: "p0", text: "Built <tools> & improved 🚀 delivery.", reason: "Test" }]);
    expect(readParagraphs(edited)[0].text).toBe("Built <tools> & improved 🚀 delivery.");
    expect(new AdmZip(edited).readAsText("word/document.xml")).toContain("&lt;tools&gt;");
  });
  it("keeps unchanged emphasized text in the exact original run after a local wording edit", () => {
    const source = makeDocx('<w:p><w:r><w:t>Built </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>reliable</w:t></w:r><w:r><w:t> applications.</w:t></w:r></w:p>');
    const edited = applyEdits(source, [{ id: "p0", text: "Delivered reliable applications.", reason: "Active wording" }]);
    const xml = new AdmZip(edited).readAsText("word/document.xml");
    expect(xml).toContain('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">reliable</w:t>');
    expect(readParagraphs(edited)[0].text).toBe("Delivered reliable applications.");
  });
  it("returns the original document bytes for empty or unchanged edits", () => {
    const source = makeDocx();
    expect(applyEdits(source, [])).toEqual(source);
    expect(applyEdits(source, [{ id: "p0", text: "Built reliable web applications.", reason: "No change" }])).toEqual(source);
  });
  it("rejects unknown, duplicate, multiline, and protected paragraph edits", () => {
    const paragraphs = readParagraphs(makeDocx());
    const edit = { id: "p0", text: "Improved delivery.", reason: "Test" };
    expect(() => validateEdits(paragraphs, [{ ...edit, id: "p99" }])).toThrow("unknown");
    expect(() => validateEdits(paragraphs, [edit, edit])).toThrow("duplicate");
    expect(() => validateEdits(paragraphs, [{ ...edit, text: "One\nTwo" }])).toThrow("multiline");
    const protectedSource = makeDocx('<w:p><w:r><w:t>Company</w:t><w:tab/><w:t>2024</w:t></w:r></w:p>');
    expect(readParagraphs(protectedSource)[0].editable).toBe(false);
    expect(() => applyEdits(protectedSource, [edit])).toThrow("cannot be edited safely");
  });
  it("reduces explicit font sizes and spacing only within the permitted bounds", () => {
    const edited = applyEdits(makeDocx(), [], 0.94);
    expect(new AdmZip(edited).readAsText("word/document.xml")).toContain('w:val="23"');
    expect(new AdmZip(edited).readAsText("word/styles.xml")).toContain('w:after="113"');
    expect(() => applyEdits(makeDocx(), [], 0.90)).toThrow("six percent");
    const small = makeDocx('<w:p><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>Small</w:t></w:r></w:p>');
    expect(new AdmZip(applyEdits(small, [], 0.94)).readAsText("word/document.xml")).toContain('w:val="18"');
    const fractional = makeDocx('<w:p><w:r><w:rPr><w:sz w:val="26"/></w:rPr><w:t>Text</w:t></w:r></w:p>');
    expect(new AdmZip(applyEdits(fractional, [], 0.94)).readAsText("word/document.xml")).toContain('w:val="25"');
  });
  it("handles nested text boxes without duplicate text", () => {
    const source = makeDocx("<w:p><w:r><w:drawing><w:txbxContent><w:p><w:r><w:t>Nested content</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r></w:p>");
    expect(readParagraphs(source)).toHaveLength(1);
    expect(readParagraphs(source)[0].text).toBe("Nested content");
  });
  it("rejects corrupt, image-only, entity-bearing, and external-asset documents", () => {
    expect(() => readParagraphs(Buffer.from("not a zip"))).toThrow("corrupt");
    expect(() => readParagraphs(makeDocx("<w:p/>"))).toThrow("OCR");
    const zip = new AdmZip(makeDocx());
    zip.updateFile("word/document.xml", Buffer.from('<!DOCTYPE x [<!ENTITY x "unsafe">]><x/>'));
    expect(() => readParagraphs(zip.toBuffer())).toThrow("entities");
    const external = new AdmZip(makeDocx());
    external.updateFile("word/_rels/document.xml.rels", Buffer.from('<Relationships><Relationship TargetMode="External" Type="image" Target="http://localhost/image"/></Relationships>'));
    expect(() => readParagraphs(external.toBuffer())).toThrow("Externally linked");
  });
});
