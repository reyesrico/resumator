import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { z } from "zod";
import { editSchema, type ResumeInfo, type RenderResult } from "../shared/types.js";
import { AppError } from "./errors.js";
import { readParagraphs, validateEdits } from "./docx.js";
import { conversionHealth, convertOffice, normalizeDocument, pageCount, renderDocx } from "./converter.js";
import { suggestEdits } from "./claude.js";
import { fetchJobText } from "./job.js";
import { fitDocument, type RenderedDocument } from "./fit.js";
import { fitPdf, inspectPdf, pdfHealth } from "./pdf.js";
import { filterSuggestions } from "./facts.js";
import { hasTextChange } from "../shared/changes.js";
import { ResumeLibrary } from "./library.js";
import { accessGate } from "./access.js";

interface StoredResume {
  owner: string;
  expires: number;
  busy: boolean;
  source: Buffer;
  originalPdf: Buffer;
  info: ResumeInfo;
  generated?: { result: RenderResult; document: RenderedDocument };
  approvedRevision?: string;
}
const lifetime = 30 * 60 * 1000;
const cookieLifetime = 365 * 24 * 60 * 60 * 1000;
const jobSchema = z.object({ jobText: z.string().trim().min(100).max(25_000), consent: z.literal(true) });
const editsSchema = z.object({ edits: z.array(editSchema).max(500) });

function asyncRoute(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => { void handler(req, res).catch(next); };
}
async function inWorkspace<T>(action: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "resumator-"));
  try { return await action(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
function owner(req: Request) {
  return req.headers.cookie?.match(/(?:^|;\s*)resumator=([a-f0-9]{64})(?:;|$)/)?.[1];
}
function sourceFormat(file: Express.Multer.File): ResumeInfo["format"] {
  const extension = file.originalname.split(".").pop()?.toLowerCase();
  if (extension === "pdf" && file.buffer.subarray(0, 5).toString() === "%PDF-") return "pdf";
  if (extension === "docx" && file.buffer.subarray(0, 2).toString() === "PK") return "docx";
  if (extension === "doc" && file.buffer.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))) return "doc";
  throw new AppError(415, "Upload a valid PDF, DOC, or DOCX file. The file contents must match its extension.");
}

export function createApp(options: { storageDirectory?: string } = {}) {
  const app = express();
  const publicDeployment = process.env.RESUMATOR_PUBLIC === "true";
  const library = new ResumeLibrary(options.storageDirectory ?? process.env.RESUMATOR_DATA_DIR ?? resolve(".resumator-data"));
  const resumes = new Map<string, StoredResume>();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0 } });
  app.disable("x-powered-by");
  if (publicDeployment) app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: {
    directives: { "frame-src": ["'self'"], "frame-ancestors": ["'self'"], "upgrade-insecure-requests": null },
  } }));
  app.get("/healthz", (_req, res) => { res.type("text").send("ok"); });
  const gate = accessGate(process.env.APP_ACCESS_USERNAME, process.env.APP_ACCESS_PASSWORD, publicDeployment);
  if (gate.length) app.use(...gate);
  app.use("/api", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  app.use("/api", (req, res, next) => {
    const session = owner(req);
    if (session) res.cookie("resumator", session, { httpOnly: true, sameSite: "strict", secure: req.secure, maxAge: cookieLifetime });
    next();
  });
  app.use("/api", (req, _res, next) => {
    const origin = req.get("origin");
    if (origin && origin !== `${req.protocol}://${req.get("host")}`) {
      next(new AppError(403, "Cross-origin requests are not allowed."));
      return;
    }
    next();
  });
  app.use("/api", rateLimit({ windowMs: 60_000, limit: 80, standardHeaders: "draft-7", legacyHeaders: false,
    message: { error: "Too many requests. Wait a minute and try again." } }));
  app.use(express.json({ limit: "512kb" }));
  app.use("/api", (_req, _res, next) => {
    for (const [id, resume] of resumes) {
      if (resume.expires < Date.now() && !resume.busy) resumes.delete(id);
    }
    next();
  });

  async function getResume(req: Request) {
    const session = owner(req);
    if (!session) throw new AppError(404, "Saved resume not found in this browser's library.");
    let resume = resumes.get(req.params.id);
    if (resume && resume.owner !== session) throw new AppError(404, "Saved resume not found.");
    if (!resume) {
      const stored = await library.get(session, req.params.id);
      if (!stored) throw new AppError(404, "Saved resume not found.");
      resume = { owner: session, expires: Date.now() + lifetime, busy: false,
        info: stored.info, source: stored.source, originalPdf: stored.originalPdf };
      resumes.set(req.params.id, resume);
    }
    resume.expires = Date.now() + lifetime;
    return resume;
  }
  async function locked<T>(resume: StoredResume, action: (directory: string) => Promise<T>) {
    if (resume.busy) throw new AppError(409, "This resume is already processing. Wait for it to finish.");
    resume.busy = true;
    try { return await inWorkspace(action); }
    finally { resume.busy = false; }
  }

  app.get("/api/health", asyncRoute(async (_req, res) => {
    const [converters, pdfNative] = await Promise.all([conversionHealth(), pdfHealth()]);
    const claude = Boolean(process.env.ANTHROPIC_API_KEY);
    res.json({ ...converters, pdfNative, claude, ready: claude && converters.libreoffice && pdfNative,
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5" });
  }));
  app.post("/api/job", asyncRoute(async (req, res) => {
    const { url } = z.object({ url: z.string().url().max(4000) }).parse(req.body);
    res.json({ text: await fetchJobText(url) });
  }));
  app.get("/api/resumes", asyncRoute(async (req, res) => {
    const session = owner(req);
    const versions = session ? await library.list(session) : [];
    res.json({ versions, latestId: versions[0]?.id ?? null });
  }));
  app.get("/api/resumes/:id", asyncRoute(async (req, res) => {
    res.json((await getResume(req)).info);
  }));
  app.post("/api/resumes", upload.single("resume"), asyncRoute(async (req, res) => {
    if (!req.file) throw new AppError(400, "Choose a resume to upload.");
    const file = req.file;
    const format = sourceFormat(file);
    const [converters, pdfNative] = await Promise.all([conversionHealth(), pdfHealth()]);
    if ((format !== "pdf" && !converters.libreoffice) || (format === "pdf" && !pdfNative)) {
      throw new AppError(503, "Document tools are missing. Word requires LibreOffice; PDF editing requires Python with PyMuPDF. See the setup instructions.");
    }
    const document = await inWorkspace(async (directory) => {
      if (format === "pdf" && await pageCount(file.buffer) > 5) throw new AppError(413, "Upload a resume of five pages or fewer.");
      if (format === "pdf") {
        const inspected = await inspectPdf(file.buffer, directory);
        return { source: file.buffer, originalPdf: file.buffer, paragraphs: inspected.paragraphs, originalPages: inspected.pages };
      }
      const source = await normalizeDocument(file.buffer, format, directory);
      const paragraphs = readParagraphs(source);
      const rendered = await renderDocx(source, directory);
      return { source, originalPdf: rendered.pdf, paragraphs, originalPages: rendered.pages };
    });
    const session = owner(req) || randomBytes(32).toString("hex");
    res.cookie("resumator", session, { httpOnly: true, sameSite: "strict", secure: req.secure, maxAge: cookieLifetime });
    const info: ResumeInfo = {
      id: randomUUID(), name: file.originalname.slice(0, 200), format,
      originalPages: document.originalPages, paragraphs: document.paragraphs,
      warnings: [
        ...(format === "pdf"
          ? ["PDF text is edited inside its original areas, without rebuilding the template in Word. Mixed-style paragraphs are split into independently editable regions with full paragraph context. Unsupported fonts and unsafe regions stay protected; changes that cannot fit are blocked.",
            "PDF-to-Word downloads are optional reconstructed copies and may change the design. The PDF is the layout-preserving output."]
          : ["Word rendering can differ from Microsoft Word when fonts are missing. Compare the source and tailored previews; unchanged text retains its original runs."]),
      ],
    };
    const savedInfo = await library.save(session, {
      info, source: document.source, originalPdf: document.originalPdf, originalUpload: file.buffer,
    });
    resumes.set(info.id, { owner: session, expires: Date.now() + lifetime, busy: false,
      source: document.source, originalPdf: document.originalPdf, info: savedInfo });
    res.status(201).json(savedInfo);
  }));

  const aiLimit = rateLimit({ windowMs: 60_000, limit: 4, legacyHeaders: false,
    message: { error: "Please wait a minute before requesting more Claude edits." } });
  async function generate(resume: StoredResume, edits: z.infer<typeof editSchema>[], directory: string, allowAdjustments: boolean) {
    return resume.info.format === "pdf"
      ? fitPdf(resume.source, resume.info.paragraphs, edits, directory, allowAdjustments)
      : fitDocument(resume.source, edits, (docx) => renderDocx(docx, directory), allowAdjustments);
  }
  app.post("/api/resumes/:id/tailor", aiLimit, asyncRoute(async (req, res) => {
    const resume = await getResume(req);
    const { jobText } = jobSchema.parse(req.body);
    const result = await locked(resume, async (directory) => {
      resume.approvedRevision = undefined;
      resume.generated = undefined;
      let suggestions = filterSuggestions(resume.info.paragraphs, await suggestEdits(resume.info.paragraphs, jobText));
      let generated = await generate(resume, suggestions.edits, directory, false);
      if (!generated.result.ready) {
        const notices = suggestions.notices ?? [];
        suggestions = filterSuggestions(resume.info.paragraphs, await suggestEdits(resume.info.paragraphs, jobText, true));
        suggestions.notices = [...new Set([...notices, ...(suggestions.notices ?? [])])];
        generated = await generate(resume, suggestions.edits, directory, true);
      }
      resume.generated = generated;
      return { ...suggestions, render: generated.result };
    });
    res.json(result);
  }));
  app.post("/api/resumes/:id/render", asyncRoute(async (req, res) => {
    const resume = await getResume(req);
    const { edits: suppliedEdits } = editsSchema.parse(req.body);
    const edits = suppliedEdits.filter((edit) => {
      const paragraph = resume.info.paragraphs.find((item) => item.id === edit.id);
      return !paragraph || hasTextChange(paragraph.text, edit.text);
    });
    validateEdits(resume.info.paragraphs, edits);
    const result = await locked(resume, async (directory) => {
      resume.approvedRevision = undefined;
      resume.generated = undefined;
      const generated = await generate(resume, edits, directory, true);
      resume.generated = generated;
      return generated.result;
    });
    res.json(result);
  }));
  app.get("/api/resumes/:id/original", asyncRoute(async (req, res) => {
    res.type("pdf").send((await getResume(req)).originalPdf);
  }));
  app.get("/api/resumes/:id/preview", asyncRoute(async (req, res) => {
    const generated = (await getResume(req)).generated;
    if (!generated) throw new AppError(409, "Generate a preview first.");
    res.type("pdf").send(generated.document.pdf);
  }));
  app.post("/api/resumes/:id/approve", asyncRoute(async (req, res) => {
    const resume = await getResume(req);
    const { revision } = z.object({ revision: z.string().uuid(), reviewed: z.literal(true) }).parse(req.body);
    if (resume.busy || !resume.generated?.result.ready || revision !== resume.generated.result.revision) {
      throw new AppError(409, "Only the latest one-page preview can be approved.");
    }
    resume.approvedRevision = revision;
    res.json({ approved: true });
  }));
  app.get("/api/resumes/:id/download/:format", asyncRoute(async (req, res) => {
    const resume = await getResume(req);
    const generated = resume.generated;
    if (resume.busy || !generated?.result.ready || resume.approvedRevision !== generated.result.revision) {
      throw new AppError(409, "Review and approve the current one-page preview before downloading.");
    }
    const format = z.enum(["pdf", "docx", "doc"]).parse(req.params.format);
    let buffer: Buffer;
    if (format !== "pdf" && !generated.document.docx) {
      if (req.query.allowConversion !== "true") {
        throw new AppError(409, "Word export from a PDF reconstructs the template. Explicitly allow converted Word downloads, or download the original-layout PDF.");
      }
      buffer = await locked(resume, async (directory) => {
        const docx = await normalizeDocument(generated.document.pdf, "pdf", directory);
        const input = join(directory, "resume.docx");
        await writeFile(input, docx);
        let result = docx;
        let checkInput = input;
        if (format === "doc") {
          result = await convertOffice(input, "doc", directory);
          checkInput = join(directory, "resume.doc");
          await writeFile(checkInput, result);
        }
        if (await pageCount(await convertOffice(checkInput, "pdf", directory)) !== 1) {
          throw new AppError(409, "The reconstructed Word copy does not fit one page. Download the layout-preserving PDF instead.");
        }
        return result;
      });
    } else if (format === "doc") {
      buffer = await locked(resume, async (directory) => {
        const input = join(directory, "resume.docx");
        if (!generated.document.docx) throw new AppError(409, "No editable Word document is available.");
        await writeFile(input, generated.document.docx);
        const legacy = await convertOffice(input, "doc", directory);
        const legacyPath = join(directory, "resume.doc");
        await writeFile(legacyPath, legacy);
        const check = await convertOffice(legacyPath, "pdf", directory);
        if (await pageCount(check) !== 1) throw new AppError(409, "Legacy DOC conversion no longer fits one page. Download the verified PDF or DOCX instead.");
        return legacy;
      });
    } else {
      const selected = generated.document[format];
      if (!selected) throw new AppError(409, "This download format is not available.");
      buffer = selected;
    }
    const name = resume.info.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 80) || "resume";
    res.attachment(`${name}-tailored.${format}`).send(buffer);
  }));
  app.delete("/api/resumes/:id", asyncRoute(async (req, res) => {
    const resume = await getResume(req);
    if (resume.busy) throw new AppError(409, "Wait for processing to finish before deleting this resume.");
    await library.delete(resume.owner, req.params.id);
    resumes.delete(req.params.id);
    res.status(204).end();
  }));
  app.use("/api", (_req, _res, next) => next(new AppError(404, "API endpoint not found.")));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof z.ZodError) { res.status(400).json({ error: "Invalid request. Check the required fields, text lengths, and consent." }); return; }
    if (error instanceof multer.MulterError) { res.status(400).json({ error: "Upload one PDF, DOC, or DOCX file, up to 10 MB." }); return; }
    if (error instanceof SyntaxError) { res.status(400).json({ error: "The request contains invalid JSON." }); return; }
    console.error("Request failed:", error instanceof Error ? error.name : "unknown error");
    res.status(500).json({ error: "An unexpected server error occurred. Check the server logs and try again." });
  });
  return app;
}
