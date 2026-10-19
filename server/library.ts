import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ResumeInfo } from "../shared/types.js";
import { AppError } from "./errors.js";

const storedSchema = z.object({
  info: z.object({
    id: z.string().uuid(), name: z.string(), format: z.enum(["pdf", "doc", "docx"]),
    originalPages: z.number(), warnings: z.array(z.string()),
    paragraphs: z.array(z.object({
      id: z.string(), text: z.string(), editable: z.boolean(),
      protectedReason: z.string().optional(), context: z.string().optional(),
    })),
    version: z.number().int().positive(), createdAt: z.string().datetime(),
  }),
  source: z.string(), originalPdf: z.string(), originalUpload: z.string(),
});

export interface SavedResume {
  info: ResumeInfo;
  source: Buffer;
  originalPdf: Buffer;
  originalUpload: Buffer;
}

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export class ResumeLibrary {
  private writes = new Map<string, Promise<unknown>>();
  constructor(private root: string) {}
  private directory(owner: string) {
    return join(this.root, createHash("sha256").update(owner).digest("hex"));
  }
  private path(owner: string, id: string) {
    if (!z.string().uuid().safeParse(id).success) throw new AppError(404, "Saved resume not found.");
    return join(this.directory(owner), `${id}.json`);
  }
  async get(owner: string, id: string): Promise<SavedResume | undefined> {
    let text: string;
    try { text = await readFile(this.path(owner, id), "utf8"); }
    catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    let input: unknown;
    try { input = JSON.parse(text); }
    catch (error) {
      if (error instanceof SyntaxError) throw new AppError(500, "A saved resume record is damaged. Restore your local library from backup.");
      throw error;
    }
    const parsed = storedSchema.safeParse(input);
    if (!parsed.success) throw new AppError(500, "A saved resume record has invalid metadata. Restore your local library from backup.");
    const stored = parsed.data;
    if (stored.info.id !== id) throw new AppError(500, "Saved resume metadata is inconsistent. Restore the source from your backup.");
    return { info: stored.info, source: Buffer.from(stored.source, "base64"),
      originalPdf: Buffer.from(stored.originalPdf, "base64"), originalUpload: Buffer.from(stored.originalUpload, "base64") };
  }
  async list(owner: string) {
    let files: string[];
    try { files = await readdir(this.directory(owner)); }
    catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const documents = await Promise.all(files.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
      .map((name) => this.get(owner, name.slice(0, -5))));
    return documents.filter((document): document is SavedResume => Boolean(document))
      .map((document) => document.info).sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
  }
  async save(owner: string, document: SavedResume) {
    const previous = this.writes.get(owner) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      const versions = await this.list(owner);
      const info: ResumeInfo = { ...document.info, version: (versions[0]?.version ?? 0) + 1, createdAt: new Date().toISOString() };
      const directory = this.directory(owner);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = this.path(owner, info.id);
      const temporary = join(directory, `${info.id}-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify({ info,
          source: document.source.toString("base64"), originalPdf: document.originalPdf.toString("base64"),
          originalUpload: document.originalUpload.toString("base64"),
        }), { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      return info;
    });
    this.writes.set(owner, task);
    try { return await task; }
    finally { if (this.writes.get(owner) === task) this.writes.delete(owner); }
  }
  async delete(owner: string, id: string) {
    await rm(this.path(owner, id));
  }
}
