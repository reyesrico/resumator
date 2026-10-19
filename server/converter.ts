import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PDFDocument } from "pdf-lib";
import { AppError } from "./errors.js";

const exec = promisify(execFile);
const office = () => process.env.LIBREOFFICE_BIN || (process.platform === "darwin"
  ? "/Applications/LibreOffice.app/Contents/MacOS/soffice" : "libreoffice");
const pdf2docx = () => process.env.PDF2DOCX_BIN || "pdf2docx";

export async function conversionHealth() {
  const [libreoffice, pdf] = await Promise.all([
    exec(office(), ["--version"], { timeout: 10_000 }).then(() => true, () => false),
    exec(pdf2docx(), ["--help"], { timeout: 15_000 }).then(() => true, () => false),
  ]);
  return { libreoffice, pdf2docx: pdf };
}

export async function convertOffice(input: string, format: "pdf" | "docx" | "doc", directory: string) {
  const work = await mkdtemp(join(directory, "office-"));
  const output = join(work, "output");
  await mkdir(output);
  try {
    await exec(office(), [
      `-env:UserInstallation=${pathToFileURL(join(work, "profile")).href}`,
      "--headless", "--nologo", "--nodefault", "--norestore",
      "--convert-to", format === "doc" ? "doc:MS Word 97" : format,
      "--outdir", output, resolve(input),
    ], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    const result = join(output, `${basename(input).replace(/\.[^.]+$/, "")}.${format}`);
    await access(result);
    return await readFile(result);
  } catch (error) {
    console.error("Office conversion failed:", error instanceof Error ? error.name : "unknown error");
    throw new AppError(422, "Document conversion failed. Check LibreOffice is installed and the document is not encrypted or damaged.");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function normalizeDocument(input: Buffer, format: "pdf" | "doc" | "docx", directory: string) {
  if (format === "docx") return input;
  const path = join(directory, `original.${format}`);
  await writeFile(path, input);
  if (format === "doc") return convertOffice(path, "docx", directory);
  const output = join(directory, "converted.docx");
  try {
    await exec(pdf2docx(), ["convert", path, output], { timeout: 90_000, maxBuffer: 1024 * 1024 });
    return await readFile(output);
  } catch (error) {
    console.error("PDF conversion failed:", error instanceof Error ? error.name : "unknown error");
    throw new AppError(422, "PDF conversion failed. Check pdf2docx is installed. Scanned PDFs require OCR; encrypted PDFs must be unlocked first.");
  }
}

export async function pageCount(pdf: Buffer) {
  try { return (await PDFDocument.load(pdf)).getPageCount(); }
  catch { throw new AppError(422, "The PDF is encrypted, damaged, or unsupported."); }
}

export async function renderDocx(docx: Buffer, directory: string) {
  const input = join(directory, "candidate.docx");
  await writeFile(input, docx);
  const pdf = await convertOffice(input, "pdf", directory);
  return { docx, pdf, pages: await pageCount(pdf) };
}
