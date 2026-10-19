import { describe, expect, it } from "vitest";
import { factChangeReason, filterSuggestions, validateFacts } from "../server/facts";
import { hasTextChange, wordChanges } from "../shared/changes";

describe("original resume facts are authoritative", () => {
  it.each([
    ["Engineer with 10+ years of experience.", "Engineer with 5+ years of experience."],
    ["Engineer with 10+ years of experience.", "Engineer with 10 years of experience."],
    ["Over ten years of delivery experience.", "Five years of delivery experience."],
    ["Over 10 years of experience.", "10 years of experience."],
    ["Reduced latency by 35% in 2024.", "Reduced latency by 50% in 2025."],
    ["Built products for 3 teams.", "Built products for 3 teams and 500 users."],
  ])("blocks factual changes: %s -> %s", (before, after) => {
    expect(factChangeReason(before, after)).toBeDefined();
  });
  it("allows relevant rewording without changing facts", () => {
    expect(factChangeReason("Engineer with 10+ years of delivery experience.", "Engineer with 10+ years of product delivery experience.")).toBeUndefined();
    expect(factChangeReason("Reduced latency by 35% in 2024.", "Cut latency by 35% in 2024.")).toBeUndefined();
  });
  it("filters no-ops and unsafe edits while retaining valid changes and reporting blocked facts", () => {
    const paragraphs = [
      { id: "p0", text: "Engineer with 10+ years of experience.", editable: true },
      { id: "p1", text: "Built reliable web applications.", editable: true },
      { id: "p2", text: "Led delivery teams.", editable: true },
    ];
    const filtered = filterSuggestions(paragraphs, { summary: "Changes", keywords: [], edits: [
      { id: "p0", text: "Engineer with 5+ years of experience.", reason: "Job minimum" },
      { id: "p1", text: " Built reliable   web applications. ", reason: "No actual change" },
      { id: "p2", text: "Led product delivery teams.", reason: "Relevant wording" },
    ] });
    expect(filtered.edits.map((edit) => edit.id)).toEqual(["p2"]);
    expect(filtered.notices?.join(" ")).toContain("Blocked");
    expect(filtered.notices?.join(" ")).toContain("p0");
    expect(() => validateFacts(paragraphs, [{ id: "p0", text: "5+ years.", reason: "Manual" }])).toThrow("original facts");
  });
});

describe("visible wording differences", () => {
  it("does not count whitespace-only changes", () => {
    expect(hasTextChange("Built  products.", "Built products.")).toBe(false);
    expect(hasTextChange("10+ years", "5+ years")).toBe(true);
  });
  it("highlights added and removed words, not the whole paragraph", () => {
    const changes = wordChanges("Built reliable applications.", "Delivered reliable applications.");
    expect(changes.filter((part) => part.removed).map((part) => part.value).join("")).toBe("Built");
    expect(changes.filter((part) => part.added).map((part) => part.value).join("")).toBe("Delivered");
    expect(changes.filter((part) => !part.added && !part.removed).map((part) => part.value).join("")).toContain("reliable applications.");
  });
});
