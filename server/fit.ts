import { randomUUID } from "node:crypto";
import type { Edit, RenderResult } from "../shared/types.js";
import { applyEdits } from "./docx.js";

export interface RenderedDocument { docx?: Buffer; pdf: Buffer; pages: number }
export type Renderer = (docx: Buffer) => Promise<RenderedDocument>;

export async function fitDocument(source: Buffer, edits: Edit[], render: Renderer, allowAdjustments: boolean) {
  let scale = 1;
  let document = await render(applyEdits(source, edits));
  if (document.pages > 1 && allowAdjustments) {
    for (const candidate of [0.97, 0.94]) {
      scale = candidate;
      document = await render(applyEdits(source, edits, scale));
      if (document.pages === 1) break;
    }
  }
  const result: RenderResult = {
    pages: document.pages, ready: document.pages === 1, scale, revision: randomUUID(),
    warnings: [
      ...(scale < 1 ? [`Font sizes and paragraph spacing were reduced by up to ${Math.round((1 - scale) * 100)}%. Review readability.`] : []),
      ...(document.pages !== 1 ? [`The result is ${document.pages} pages. Final downloads are blocked. Shorten the wording or simplify the source document.`] : []),
    ],
  };
  return { result, document };
}
