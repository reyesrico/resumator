import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Edit, Paragraph, RenderResult } from "../shared/types.js";
import { AppError } from "./errors.js";
import { validateEdits } from "./docx.js";
import type { RenderedDocument } from "./fit.js";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("./pdf_layout.py", import.meta.url));
const python = () => process.env.PDF_PYTHON_BIN || (process.env.PDF2DOCX_BIN
  ? join(dirname(process.env.PDF2DOCX_BIN), process.platform === "win32" ? "python.exe" : "python")
  : existsSync(resolve(".venv/bin/python")) ? resolve(".venv/bin/python") : "python3");
const paragraphSchema = z.object({
  id: z.string(), text: z.string(), editable: z.boolean(), protectedReason: z.string().optional(), context: z.string().optional(),
});

export async function pdfHealth() {
  return exec(python(), ["-c", "import pymupdf"], { timeout: 10_000 }).then(() => true, () => false);
}

async function run(args: string[]) {
  try {
    const { stdout } = await exec(python(), [script, ...args], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    if (typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string") {
      let payload: unknown;
      try { payload = JSON.parse(error.stdout || "{}"); }
      catch { payload = undefined; }
      const parsed = z.object({ error: z.string() }).safeParse(payload);
      if (parsed.success) throw new AppError(422, parsed.data.error);
    }
    console.error("Native PDF editing failed:", error instanceof Error ? error.name : "unknown error");
    throw new AppError(422, "Native PDF editing failed. Check the Python/PyMuPDF setup. No reconstructed template was substituted.");
  }
}

export async function inspectPdf(pdf: Buffer, directory: string) {
  const source = join(directory, "source.pdf");
  await writeFile(source, pdf);
  return z.object({ pages: z.number().int().positive(), paragraphs: z.array(paragraphSchema) })
    .parse(await run(["inspect", source]));
}

export async function fitPdf(
  source: Buffer, paragraphs: Paragraph[], edits: Edit[], directory: string, allowAdjustments: boolean,
): Promise<{ result: RenderResult; document: RenderedDocument }> {
  const current = await inspectPdf(source, directory);
  if (JSON.stringify(current.paragraphs) !== JSON.stringify(paragraphs)) {
    throw new AppError(409, "PDF text regions changed after an application update. Re-upload the original resume before applying edits.");
  }
  validateEdits(paragraphs, edits);
  const input = join(directory, "source.pdf");
  const request = join(directory, "edits.json");
  const output = join(directory, "tailored.pdf");
  await writeFile(input, source);
  await writeFile(request, JSON.stringify({ edits, allowAdjustments }));
  const rendered = z.object({ pages: z.number().int().positive(), scale: z.number(), issues: z.array(z.string()) })
    .parse(await run(["apply", input, request, output]));
  const pdf = await readFile(output);
  const ready = rendered.pages === 1 && rendered.issues.length === 0;
  return {
    document: { pdf, pages: rendered.pages },
    result: {
      pages: rendered.pages, ready, scale: rendered.scale, revision: randomUUID(),
      blockedEdits: rendered.issues,
      warnings: [
        ...rendered.issues,
        ...(rendered.issues.length ? ["The preview remains the original PDF because not all proposed edits fit. Shorten or reject the listed changes, then update the preview."] : []),
        ...(rendered.scale < 1 ? ["Only edited PDF text was reduced by at most 6% to fit its original area. All other geometry is unchanged."] : []),
        ...(rendered.pages !== 1 ? ["This PDF has more than one page. Pages will not be deleted or reconstructed to force a one-page result. Upload a one-page source."] : []),
      ],
    },
  };
}
