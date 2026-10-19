import { z } from "zod";

export const editSchema = z.object({
  id: z.string().regex(/^p\d+$/),
  text: z.string().trim().min(1).max(8000),
  reason: z.string().min(1).max(500),
}).strict();
export const suggestionSchema = z.object({
  summary: z.string().min(1).max(2000),
  keywords: z.array(z.string().min(1).max(100)).max(20),
  edits: z.array(editSchema).max(500),
}).strict();
export type Edit = z.infer<typeof editSchema>;
export type Suggestions = z.infer<typeof suggestionSchema> & { notices?: string[] };
export interface Paragraph { id: string; text: string; editable: boolean; protectedReason?: string; context?: string }
export interface ResumeInfo {
  id: string;
  name: string;
  format: "pdf" | "doc" | "docx";
  originalPages: number;
  warnings: string[];
  paragraphs: Paragraph[];
  version?: number;
  createdAt?: string;
}
export interface RenderResult {
  pages: number;
  ready: boolean;
  scale: number;
  warnings: string[];
  revision: string;
  blockedEdits?: string[];
}
export interface TailorResult extends Suggestions { render: RenderResult }
export interface Health {
  ready: boolean;
  claude: boolean;
  libreoffice: boolean;
  pdf2docx: boolean;
  pdfNative: boolean;
  model: string;
}
