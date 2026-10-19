import { editSchema, type Edit, type Paragraph } from "../../shared/types";
import { validateFacts } from "../../server/facts";

export function validateBrowserEdits(paragraphs: Paragraph[], edits: Edit[]) {
  if (edits.length > 500) throw new Error("Too many edits.");
  const seen = new Set<string>();
  for (const edit of edits) {
    if (!editSchema.safeParse(edit).success || /[\u0000-\u001f\u007f]/.test(edit.text)) throw new Error("Invalid replacement text.");
    const original = paragraphs.find((paragraph) => paragraph.id === edit.id);
    if (!original || seen.has(edit.id)) throw new Error("An edit references an unknown or duplicate region.");
    if (!original.editable) throw new Error("This text region is protected to preserve its original formatting.");
    seen.add(edit.id);
  }
  validateFacts(paragraphs, edits);
}
