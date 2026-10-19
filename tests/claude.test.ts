import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { suggestEdits } from "../server/claude";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class MockAnthropic {
    static APIError = original.default.APIError;
    messages = { create };
  }
  return { default: MockAnthropic };
});
const paragraphs = [{ id: "p0", text: "Built reliable web applications.", editable: true }];
const suggestions = {
  summary: "Rephrased existing experience; cloud skills are not supplied.",
  keywords: ["web applications"],
  edits: [{ id: "p0", text: "Delivered reliable web applications.", reason: "Clearer active wording." }],
};
const response = (input: unknown) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(input) }] });

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-only-placeholder");
  create.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("Claude API integration", () => {
  it("uses Anthropic Messages with schema-constrained JSON and an untrusted-data boundary", async () => {
    create.mockResolvedValue(response(suggestions));
    await expect(suggestEdits(paragraphs, "Role requirements")).resolves.toEqual(suggestions);
    const payload = create.mock.calls[0][0];
    expect(payload.model).toBe("claude-sonnet-5-5");
    expect(payload.output_config.format.type).toBe("json_schema");
    expect(payload.output_config.format.schema.required).toEqual(["summary", "keywords", "edits"]);
    expect(payload).not.toHaveProperty("tool_choice");
    expect(payload).not.toHaveProperty("tools");
    expect(payload.system).toContain("Never add skills");
    expect(payload.system).toContain("untrusted");
    expect(JSON.parse(payload.messages[0].content)).toEqual({ resume: paragraphs, jobDescription: "Role requirements" });
    expect(payload.system).toContain('KEEP "10+ years" verbatim');
  });
  it("honors an explicitly configured Claude model", async () => {
    vi.stubEnv("ANTHROPIC_MODEL", "configured-claude-model");
    create.mockResolvedValue(response(suggestions));
    await suggestEdits(paragraphs, "Job", true);
    expect(create.mock.calls[0][0].model).toBe("configured-claude-model");
    expect(create.mock.calls[0][0].system).toContain("25% less");
  });
  it("requires server credentials before calling the API", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(suggestEdits(paragraphs, "Job")).rejects.toThrow("ANTHROPIC_API_KEY");
    expect(create).not.toHaveBeenCalled();
  });
  it("rejects truncated, missing, invalid, or unknown-ID responses", async () => {
    create.mockResolvedValueOnce({ stop_reason: "max_tokens", content: [] });
    await expect(suggestEdits(paragraphs, "Job")).rejects.toThrow("truncated");
    create.mockResolvedValueOnce({ content: [] });
    await expect(suggestEdits(paragraphs, "Job")).rejects.toThrow("structured");
    create.mockResolvedValueOnce(response({ edits: [] }));
    await expect(suggestEdits(paragraphs, "Job")).rejects.toThrow("invalid edits");
    create.mockResolvedValueOnce(response({ ...suggestions, edits: [{ ...suggestions.edits[0], id: "p99" }] }));
    await expect(suggestEdits(paragraphs, "Job")).rejects.toThrow("unknown");
  });
  it("rejects malformed JSON and reports explicit refusals", async () => {
    create.mockResolvedValueOnce({ content: [{ type: "text", text: "not JSON" }] });
    await expect(suggestEdits(paragraphs, "Job")).rejects.toThrow("malformed JSON");
    create.mockResolvedValueOnce({ stop_reason: "refusal", content: [] });
    await expect(suggestEdits(paragraphs, "Job")).rejects.toThrow("declined");
  });
  it("does not return unchanged or fact-changing AI suggestions as accepted edits", async () => {
    create.mockResolvedValueOnce(response({ summary: "Align experience", keywords: [], edits: [
      { id: "p0", text: "Engineer with 5+ years of experience.", reason: "Job minimum" },
    ] }));
    const result = await suggestEdits([{ id: "p0", text: "Engineer with 10+ years of experience.", editable: true }], "Requires 5+ years.");
    expect(result.edits).toEqual([]);
    expect(result.notices?.join()).toContain("Blocked");
    create.mockResolvedValueOnce(response({ ...suggestions, edits: [{ ...suggestions.edits[0], text: paragraphs[0].text }] }));
    expect((await suggestEdits(paragraphs, "Job")).edits).toEqual([]);
  });
  it("provides shared full-paragraph context once for independently styled PDF regions", async () => {
    create.mockResolvedValueOnce(response({ summary: "No required changes", keywords: [], edits: [] }));
    const context = "Built reliable applications with React.";
    await suggestEdits([
      { id: "p0", text: "Built reliable applications with", editable: true, context },
      { id: "p1", text: "React.", editable: true, context },
    ], "Role");
    const payload = JSON.parse(create.mock.calls[0][0].messages[0].content);
    expect(payload.contexts).toEqual({ c0: context });
    expect(payload.resume.map((region: { contextId: string }) => region.contextId)).toEqual(["c0", "c0"]);
    expect(create.mock.calls[0][0].system).toContain("ONLY that region's replacement text");
  });
  it("surfaces invalid credentials and API usage limits explicitly", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    create.mockRejectedValueOnce(new Anthropic.APIError(401, undefined, "unauthorized", new Headers()));
    await expect(suggestEdits(paragraphs, "Job")).rejects.toThrow("API key is invalid");
    create.mockRejectedValueOnce(new Anthropic.APIError(429, undefined, "rate limit", new Headers()));
    await expect(suggestEdits(paragraphs, "Job")).rejects.toThrow("billing limit");
    log.mockRestore();
  });
});
