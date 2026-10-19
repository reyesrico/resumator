import { diffWordsWithSpace } from "diff";

export function comparableText(text: string) {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function hasTextChange(before: string, after: string) {
  return comparableText(before) !== comparableText(after);
}

export function wordChanges(before: string, after: string) {
  return diffWordsWithSpace(before, after);
}
