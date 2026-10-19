import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TextDiff, { OriginalContext } from "../src/TextDiff";

describe("wording review", () => {
  it("shows the exact removed and added words under explicit original/replacement labels", () => {
    const html = renderToStaticMarkup(createElement(TextDiff, {
      before: "Built reliable web applications.",
      after: "Built robust web applications.",
    }));
    expect(html).toContain("ORIGINAL");
    expect(html).toContain("REPLACEMENT");
    expect(html).toContain("<del>reliable</del>");
    expect(html).toContain("<ins>robust</ins>");
    expect(html).not.toContain("<del>Built");
    expect(html).not.toContain("<ins>Built");
  });
  it("highlights the original edited region within the full surrounding paragraph", () => {
    const html = renderToStaticMarkup(createElement(OriginalContext, {
      context: "EXPERIENCE Built reliable web applications. Led delivery teams.",
      text: "Built reliable web applications.",
    }));
    expect(html).toContain("EXPERIENCE <mark>Built reliable web applications.</mark> Led delivery teams.");
  });
  it("keeps the original context readable if normalized fragments do not match exactly", () => {
    const html = renderToStaticMarkup(createElement(OriginalContext, {
      context: "Original surrounding context.", text: "Different fragment",
    }));
    expect(html).toBe("<p>Original surrounding context.</p>");
  });
});
