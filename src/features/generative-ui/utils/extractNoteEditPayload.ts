/**
 * 从 render_generative_ui toolInput / toolOutput 提取 noteEdit 写入载荷
 */

import { z } from 'zod';

export const noteEditPayloadSchema = z.object({
  operation: z.enum(['append', 'replace', 'set']),
  content: z.string().optional(),
  search: z.string().optional(),
  replace: z.string().optional(),
  isRegex: z.boolean().optional(),
  section: z.string().optional(),
});

export type NoteEditPayload = z.infer<typeof noteEditPayloadSchema>;

function readNoteEditField(source: unknown): unknown {
  if (!source || typeof source !== 'object') return undefined;
  return (source as Record<string, unknown>).noteEdit;
}

/** 解析并校验 noteEdit；无效则返回 null */
export function extractNoteEditPayload(
  toolInput?: unknown,
  toolOutput?: unknown,
): NoteEditPayload | null {
  const raw = readNoteEditField(toolInput) ?? readNoteEditField(toolOutput);
  if (raw === undefined) return null;

  const result = noteEditPayloadSchema.safeParse(raw);
  return result.success ? result.data : null;
}
