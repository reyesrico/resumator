import type { Edit, Paragraph, Suggestions } from "../shared/types.js";
import { hasTextChange } from "../shared/changes.js";
import { AppError } from "./errors.js";

function numericFacts(text: string) {
  return (text.normalize("NFKC").match(/\d[\d,]*(?:\.\d+)?(?:\s*\+)?(?:\s*%)?/gu) ?? [])
    .map((fact) => fact.replace(/[\s,]/g, ""))
    .sort();
}

function experienceFacts(text: string) {
  return (text.toLowerCase().match(
    /(?:(?:over|more than|at least|nearly|approximately|about)\s+)?(?:\d+(?:\s*\+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)[\s-]+years?/g,
  ) ?? []).map((fact) => fact.replace(/\s+/g, " ").trim()).sort();
}

export function factChangeReason(before: string, after: string): string | undefined {
  if (JSON.stringify(numericFacts(before)) !== JSON.stringify(numericFacts(after))) {
    return "Numbers, dates, percentages, and experience totals must stay exactly as supplied in the resume.";
  }
  if (JSON.stringify(experienceFacts(before)) !== JSON.stringify(experienceFacts(after))) {
    return "Years of experience and qualifiers such as 'over' or '+' cannot be rewritten to match a job's minimum.";
  }
  return undefined;
}

export function validateFacts(paragraphs: Paragraph[], edits: Edit[]) {
  const originals = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph.text]));
  for (const edit of edits) {
    const original = originals.get(edit.id);
    if (original === undefined) continue;
    const reason = factChangeReason(original, edit.text);
    if (reason) throw new AppError(422, `${edit.id}: ${reason} Keep the original facts and edit only the surrounding wording.`);
  }
}

export function filterSuggestions(paragraphs: Paragraph[], suggestions: Suggestions): Suggestions {
  const originals = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const notices = [...(suggestions.notices ?? [])];
  const seen = new Set<string>();
  const edits = suggestions.edits.filter((edit) => {
    if (seen.has(edit.id)) throw new AppError(422, "An edit references a duplicate paragraph.");
    seen.add(edit.id);
    const original = originals.get(edit.id);
    if (!original) throw new AppError(422, "An edit references an unknown paragraph.");
    if (!hasTextChange(original.text, edit.text)) return false;
    if (!original.editable) {
      notices.push(`Kept ${edit.id} unchanged: its original formatting is protected.`);
      return false;
    }
    const reason = factChangeReason(original.text, edit.text);
    if (reason) {
      notices.push(`Blocked a proposed change to ${edit.id}. ${reason}`);
      return false;
    }
    return true;
  });
  return { ...suggestions, edits, ...(notices.length ? { notices } : {}) };
}
