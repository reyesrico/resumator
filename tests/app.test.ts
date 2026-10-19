import request from "supertest";
import { mkdtemp, rm, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { suggestEdits } from "../server/claude";
import { convertOffice, renderDocx } from "../server/converter";
import { makeDocx } from "./fixtures";

vi.mock("../server/converter", () => ({
  conversionHealth: vi.fn(async () => ({ libreoffice: true, pdf2docx: true })),
  normalizeDocument: vi.fn(async (buffer: Buffer) => buffer),
  pageCount: vi.fn(async () => 1),
  renderDocx: vi.fn(async (docx: Buffer) => ({ docx, pdf: Buffer.from("%PDF-preview"), pages: 1 })),
  convertOffice: vi.fn(async () => Buffer.from("legacy-doc")),
}));
vi.mock("../server/claude", () => ({ suggestEdits: vi.fn() }));
const suggestions = { summary: "Refined wording.", keywords: ["web applications"],
  edits: [{ id: "p0", text: "Delivered reliable web applications.", reason: "Active wording." }] };
const jobText = "We need an engineer who builds reliable web applications and communicates effectively with stakeholders. ".repeat(2);

beforeEach(() => {
  vi.mocked(suggestEdits).mockReset().mockResolvedValue(suggestions);
  vi.mocked(renderDocx).mockReset().mockImplementation(async (docx) => ({ docx, pdf: Buffer.from("%PDF-preview"), pages: 1 }));
  vi.mocked(convertOffice).mockClear();
});

describe("resume API workflow", () => {
  it("retains original versions across app restarts, defaults to the latest, and deletes durably", async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), "resumator-library-api-"));
    try {
      const app = createApp({ storageDirectory });
      const agent = request.agent(app);
      const original = makeDocx();
      const first = await agent.post("/api/resumes").attach("resume", original, "first.docx").expect(201);
      const cookie = first.headers["set-cookie"][0].split(";")[0];
      const second = await agent.post("/api/resumes").attach("resume", original, "second.docx").expect(201);
      expect(first.body).toMatchObject({ version: 1, createdAt: expect.any(String) });
      expect(second.body.version).toBe(2);
      const tailored = await agent.post(`/api/resumes/${second.body.id}/tailor`).send({ jobText, consent: true }).expect(200);
      expect(tailored.body.edits).toHaveLength(1);
      const restarted = createApp({ storageDirectory });
      const library = await request(restarted).get("/api/resumes").set("Cookie", cookie).expect(200);
      expect(library.body.latestId).toBe(second.body.id);
      expect(library.body.versions.map((version: { id: string }) => version.id)).toEqual([second.body.id, first.body.id]);
      await request(restarted).get(`/api/resumes/${first.body.id}`).set("Cookie", cookie).expect(200);
      await request(restarted).get(`/api/resumes/${second.body.id}/preview`).set("Cookie", cookie).expect(409);
      await request(restarted).get(`/api/resumes/${second.body.id}/original`).set("Cookie", cookie).expect(200);
      await request(restarted).post(`/api/resumes/${second.body.id}/tailor`).set("Cookie", cookie).send({ jobText, consent: true }).expect(200);
      expect(vi.mocked(suggestEdits).mock.calls.at(-1)?.[0][0].text).toBe("Built reliable web applications.");
      expect((await request(restarted).get("/api/resumes").expect(200)).body.versions).toEqual([]);
      await request(restarted).delete(`/api/resumes/${second.body.id}`).expect(404);
      await request(restarted).delete(`/api/resumes/${second.body.id}`).set("Cookie", cookie).expect(204);
      const again = createApp({ storageDirectory });
      const remaining = await request(again).get("/api/resumes").set("Cookie", cookie).expect(200);
      expect(remaining.body.latestId).toBe(first.body.id);
      await request(again).get(`/api/resumes/${second.body.id}`).set("Cookie", cookie).expect(404);
      const owners = await readdir(storageDirectory);
      const ownerDirectory = join(storageDirectory, owners[0]);
      expect((await stat(ownerDirectory)).mode & 0o777).toBe(0o700);
      const saved = await readdir(ownerDirectory);
      expect(saved).toEqual([`${first.body.id}.json`]);
      expect((await stat(join(ownerDirectory, saved[0]))).mode & 0o777).toBe(0o600);
      await request(again).delete(`/api/resumes/${first.body.id}`).set("Cookie", cookie).expect(204);
      expect((await request(again).get("/api/resumes").set("Cookie", cookie).expect(200)).body.latestId).toBeNull();
    } finally {
      await rm(storageDirectory, { recursive: true, force: true });
    }
  });
  it("reports storage failures without claiming an upload was saved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "resumator-storage-failure-"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const path = join(directory, "not-a-directory");
      await writeFile(path, "occupied");
      const app = createApp({ storageDirectory: path });
      const response = await request(app).post("/api/resumes").attach("resume", makeDocx(), "resume.docx").expect(500);
      expect(response.body.id).toBeUndefined();
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("uploads, tailors, requires approval, and downloads all three formats", async () => {
    const agent = request.agent(createApp());
    const uploaded = await agent.post("/api/resumes").attach("resume", makeDocx(), "resume.docx").expect(201);
    const id: string = uploaded.body.id;
    expect(uploaded.headers["set-cookie"][0]).toContain("HttpOnly");
    const tailored = await agent.post(`/api/resumes/${id}/tailor`).send({ jobText, consent: true }).expect(200);
    expect(tailored.body.render).toMatchObject({ pages: 1, ready: true, scale: 1 });
    await agent.get(`/api/resumes/${id}/download/pdf`).expect(409);
    await agent.get(`/api/resumes/${id}/preview`).expect("Content-Type", /pdf/).expect(200);
    await agent.post(`/api/resumes/${id}/approve`).send({ revision: tailored.body.render.revision, reviewed: true }).expect(200);
    for (const format of ["pdf", "docx", "doc"]) {
      const download = await agent.get(`/api/resumes/${id}/download/${format}`).expect(200);
      expect(download.headers["content-disposition"]).toContain(`resume-tailored.${format}`);
    }
    expect(convertOffice).toHaveBeenCalledTimes(2);
    await agent.delete(`/api/resumes/${id}`).expect(204);
    await agent.get(`/api/resumes/${id}/original`).expect(404);
  });
  it("requires explicit consent and isolates uploaded documents between sessions", async () => {
    const app = createApp();
    const agent = request.agent(app);
    const { body } = await agent.post("/api/resumes").attach("resume", makeDocx(), "resume.docx").expect(201);
    await agent.post(`/api/resumes/${body.id}/tailor`).send({ jobText }).expect(400);
    expect(suggestEdits).not.toHaveBeenCalled();
    await request(app).get(`/api/resumes/${body.id}/original`).expect(404);
  });
  it("shortens wording before reducing layout and blocks a persistent multi-page result", async () => {
    const agent = request.agent(createApp());
    const { body } = await agent.post("/api/resumes").attach("resume", makeDocx(), "resume.docx");
    vi.mocked(renderDocx).mockImplementation(async (docx) => ({ docx, pdf: Buffer.from("%PDF-two-pages"), pages: 2 }));
    const result = await agent.post(`/api/resumes/${body.id}/tailor`).send({ jobText, consent: true }).expect(200);
    expect(suggestEdits).toHaveBeenCalledTimes(2);
    expect(vi.mocked(suggestEdits).mock.calls[1][2]).toBe(true);
    expect(result.body.render).toMatchObject({ ready: false, pages: 2, scale: 0.94 });
    await agent.post(`/api/resumes/${body.id}/approve`).send({ revision: result.body.render.revision, reviewed: true }).expect(409);
    await agent.get(`/api/resumes/${body.id}/download/docx`).expect(409);
  });
  it("invalidates approval after a wording change and rejects stale revisions", async () => {
    const agent = request.agent(createApp());
    const { body } = await agent.post("/api/resumes").attach("resume", makeDocx(), "resume.docx");
    const first = await agent.post(`/api/resumes/${body.id}/tailor`).send({ jobText, consent: true });
    await agent.post(`/api/resumes/${body.id}/approve`).send({ revision: first.body.render.revision, reviewed: true }).expect(200);
    const updated = await agent.post(`/api/resumes/${body.id}/render`).send({ edits: [] }).expect(200);
    expect(updated.body.revision).not.toBe(first.body.render.revision);
    await agent.get(`/api/resumes/${body.id}/download/pdf`).expect(409);
    await agent.post(`/api/resumes/${body.id}/approve`).send({ revision: first.body.render.revision, reviewed: true }).expect(409);
  });
  it("rejects disguised file types and cross-origin mutations", async () => {
    const app = createApp();
    await request(app).post("/api/resumes").attach("resume", Buffer.from("not a PDF"), "resume.pdf").expect(415);
    await request(app).post("/api/resumes").set("Origin", "https://untrusted.example").expect(403);
  });
  it("blocks an AI downgrade of 10+ years and omits unchanged suggestions from the API result", async () => {
    const agent = request.agent(createApp());
    const source = makeDocx('<w:p><w:r><w:t>Engineer with 10+ years of experience.</w:t></w:r></w:p><w:p><w:r><w:t>Built reliable web applications.</w:t></w:r></w:p>');
    const { body } = await agent.post("/api/resumes").attach("resume", source, "resume.docx").expect(201);
    vi.mocked(suggestEdits).mockResolvedValue({
      summary: "Suggested changes", keywords: [], edits: [
        { id: "p0", text: "Engineer with 5+ years of experience.", reason: "Matches the job" },
        { id: "p1", text: "Built reliable web applications.", reason: "Same text" },
      ],
    });
    const tailored = await agent.post(`/api/resumes/${body.id}/tailor`).send({ jobText, consent: true }).expect(200);
    expect(tailored.body.edits).toEqual([]);
    expect(tailored.body.notices.join(" ")).toContain("Blocked");
    const renderedSource = vi.mocked(renderDocx).mock.calls.at(-1)?.[0];
    expect(renderedSource).toEqual(source);
    await agent.post(`/api/resumes/${body.id}/render`).send({ edits: [
      { id: "p0", text: "Engineer with 5+ years of experience.", reason: "Manual downgrade" },
    ] }).expect(422);
  });
});
