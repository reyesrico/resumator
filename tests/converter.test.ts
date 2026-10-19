import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { conversionHealth, convertOffice, normalizeDocument, pageCount, renderDocx } from "../server/converter";
import { readParagraphs } from "../server/docx";
import { makeDocx } from "./fixtures";

describe("PDF page measurement", () => {
  it("counts actual PDF pages rather than estimating from text", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    pdf.addPage();
    expect(await pageCount(Buffer.from(await pdf.save()))).toBe(2);
  });
  it("rejects invalid PDF content explicitly", async () => {
    await expect(pageCount(Buffer.from("invalid"))).rejects.toThrow("encrypted, damaged");
  });
});

const health = await conversionHealth();
describe.skipIf(!health.libreoffice || !health.pdf2docx)("native converter integration (requires LibreOffice and pdf2docx)", () => {
  it("renders DOCX and round-trips PDF and legacy DOC with readable text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "resumator-integration-"));
    try {
      const source = makeDocx();
      const pdf = await renderDocx(source, directory);
      expect(pdf.pages).toBe(1);
      const reconstructed = await normalizeDocument(pdf.pdf, "pdf", directory);
      expect(readParagraphs(reconstructed).map((paragraph) => paragraph.text).join(" ")).toContain("Built reliable");
      const input = join(directory, "source.docx");
      await writeFile(input, source);
      const legacy = await convertOffice(input, "doc", directory);
      expect(legacy.subarray(0, 8).toString("hex")).toBe("d0cf11e0a1b11ae1");
      const normalized = await normalizeDocument(legacy, "doc", directory);
      expect(readParagraphs(normalized)[0].text).toContain("Built reliable");
      expect((await renderDocx(normalized, directory)).pages).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
