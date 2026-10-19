import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { fitPdf, inspectPdf } from "../server/pdf";
import { createApp } from "../server/app";
import { suggestEdits } from "../server/claude";

vi.mock("../server/claude", () => ({ suggestEdits: vi.fn() }));

const exec = promisify(execFile);
const python = resolve(".venv/bin/python");
describe.skipIf(!existsSync(python))("native PDF template preservation", () => {
  it("passes pixel-level layout, missing glyph, overflow, and no-op regression tests", async () => {
    const { stderr } = await exec(python, ["tests/pdf_layout_test.py"], {
      timeout: 60_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(stderr).toContain("Ran 12 tests");
    expect(stderr).toContain("OK");
  }, 60_000);
  it("wires original PDF extraction and rendering without a Word reconstruction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "resumator-native-pdf-"));
    try {
      const pdf = await PDFDocument.create();
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      pdf.addPage().drawText("Built reliable web applications.", { x: 50, y: 700, size: 12, font });
      const source = Buffer.from(await pdf.save());
      const inspected = await inspectPdf(source, directory);
      const generated = await fitPdf(source, inspected.paragraphs, [
        { id: "p0", text: "Built robust web applications.", reason: "Relevant wording" },
      ], directory, true);
      expect(generated.result).toMatchObject({ ready: true, pages: 1, scale: 1, blockedEdits: [] });
      expect(generated.document.docx).toBeUndefined();
      const rendered = await inspectPdf(generated.document.pdf, directory);
      expect(rendered.paragraphs.map((paragraph) => paragraph.text).join()).toContain("Built robust web applications.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("guards facts through the actual PDF upload/review/download API and refuses overflow", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage();
    page.drawText("Engineer with 10+ years of experience.", { x: 50, y: 700, size: 12, font });
    page.drawText("Built reliable web applications.", { x: 50, y: 660, size: 12, font });
    const source = Buffer.from(await pdf.save());
    const agent = request.agent(createApp());
    const upload = await agent.post("/api/resumes").attach("resume", source, "original.pdf").expect(201);
    const id: string = upload.body.id;
    expect(upload.body.paragraphs[0].text).toContain("10+ years");
    vi.mocked(suggestEdits).mockResolvedValue({
      summary: "Relevance suggestions", keywords: [], edits: [
        { id: "p0", text: "Engineer with 5+ years of experience.", reason: "Job minimum" },
        { id: "p1", text: "Built reliable web applications.", reason: "No change" },
      ],
    });
    const tailored = await agent.post(`/api/resumes/${id}/tailor`).send({
      consent: true, jobText: "Requires 5+ years of experience building reliable web applications and working with product stakeholders. ".repeat(2),
    }).expect(200);
    expect(tailored.body.edits).toEqual([]);
    expect(tailored.body.notices.join()).toContain("Blocked");
    expect(tailored.body.render.ready).toBe(true);
    await agent.post(`/api/resumes/${id}/approve`).send({ reviewed: true, revision: tailored.body.render.revision }).expect(200);
    const download = await agent.get(`/api/resumes/${id}/download/pdf`).expect(200);
    expect(download.body).toEqual(source);
    await agent.get(`/api/resumes/${id}/download/docx`).expect(409);
    const overflow = await agent.post(`/api/resumes/${id}/render`).send({
      edits: [{ id: "p1", text: "Long replacement wording ".repeat(30).trim(), reason: "Overflow test" }],
    }).expect(200);
    expect(overflow.body).toMatchObject({ pages: 1, ready: false });
    expect(overflow.body.blockedEdits.join()).toContain("does not fit");
    await agent.post(`/api/resumes/${id}/approve`).send({ reviewed: true, revision: overflow.body.revision }).expect(409);
    await agent.get(`/api/resumes/${id}/download/pdf`).expect(409);
  }, 60_000);
  it("exposes editable body text in a mixed-font paragraph and rejects stale region mappings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "resumator-styled-pdf-"));
    try {
      const pdf = await PDFDocument.create();
      const regular = await pdf.embedFont(StandardFonts.Helvetica);
      const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
      const page = pdf.addPage();
      page.drawText("SUMMARY", { x: 50, y: 700, size: 12, font: bold });
      page.drawText("Built reliable web applications.", { x: 50, y: 685, size: 11, font: regular });
      page.drawText("Led product delivery teams.", { x: 50, y: 671, size: 11, font: regular });
      const source = Buffer.from(await pdf.save());
      const inspected = await inspectPdf(source, directory);
      const body = inspected.paragraphs.find((paragraph) => paragraph.text.startsWith("Built"))!;
      expect(body.editable).toBe(true);
      expect(body.context).toContain("SUMMARY");
      expect(body.context).toContain("Led product delivery teams.");
      const generated = await fitPdf(source, inspected.paragraphs, [{
        id: body.id, text: "Built robust web applications. Led product delivery teams.", reason: "Relevant language",
      }], directory, false);
      expect(generated.result.ready).toBe(true);
      const output = await inspectPdf(generated.document.pdf, directory);
      expect(output.paragraphs.map((paragraph) => paragraph.text).join(" ")).toContain("Built robust");
      await expect(fitPdf(source, [{ ...body, id: "p999" }], [], directory, false)).rejects.toThrow("Re-upload");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
