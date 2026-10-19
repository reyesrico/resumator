import { describe, expect, it, vi } from "vitest";
import { fitDocument } from "../server/fit";
import { makeDocx } from "./fixtures";

describe("measured one-page export gate", () => {
  it("does not adjust an already one-page result", async () => {
    const renderer = vi.fn(async (docx: Buffer) => ({ docx, pdf: Buffer.from("pdf"), pages: 1 }));
    const { result } = await fitDocument(makeDocx(), [], renderer, true);
    expect(result).toMatchObject({ ready: true, pages: 1, scale: 1 });
    expect(renderer).toHaveBeenCalledTimes(1);
  });
  it("tries modest adjustments and stops when a one-page rendering is achieved", async () => {
    let count = 0;
    const renderer = vi.fn(async (docx: Buffer) => ({ docx, pdf: Buffer.from("pdf"), pages: ++count < 3 ? 2 : 1 }));
    const { result } = await fitDocument(makeDocx(), [], renderer, true);
    expect(result).toMatchObject({ ready: true, pages: 1, scale: 0.94 });
    expect(result.warnings.join()).toContain("6%");
  });
  it("blocks output that still exceeds one page and never shrinks beyond six percent", async () => {
    const renderer = vi.fn(async (docx: Buffer) => ({ docx, pdf: Buffer.from("pdf"), pages: 2 }));
    const { result } = await fitDocument(makeDocx(), [], renderer, true);
    expect(result).toMatchObject({ ready: false, pages: 2, scale: 0.94 });
    expect(renderer).toHaveBeenCalledTimes(3);
    expect(result.warnings.join()).toContain("blocked");
  });
  it("leaves first-pass layout untouched so text shortening happens first", async () => {
    const renderer = vi.fn(async (docx: Buffer) => ({ docx, pdf: Buffer.from("pdf"), pages: 2 }));
    const { result } = await fitDocument(makeDocx(), [], renderer, false);
    expect(result.scale).toBe(1);
    expect(renderer).toHaveBeenCalledTimes(1);
  });
});
