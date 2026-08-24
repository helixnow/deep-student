/**
 * 从 render_generative_ui toolInput / toolOutput 提取 noteEdit 写入载荷
 */

import { z } from 'zod';

/** Generative UI 模型可提交的单次笔记编辑文本上限（UTF-8，256 KiB）。 */
export const MAX_GENERATIVE_NOTE_EDIT_INPUT_BYTES = 256 * 1024;
const MAX_GENERATIVE_NOTE_EDIT_FIELD_LENGTH = MAX_GENERATIVE_NOTE_EDIT_INPUT_BYTES;
const MAX_GENERATIVE_NOTE_EDIT_SECTION_LENGTH = 1024;

export const noteEditPayloadSchema = z.object({
  operation: z.enum(['append', 'replace', 'set']),
  content: z.string().max(MAX_GENERATIVE_NOTE_EDIT_FIELD_LENGTH).optional(),
  search: z.string().max(MAX_GENERATIVE_NOTE_EDIT_FIELD_LENGTH).optional(),
  replace: z.string().max(MAX_GENERATIVE_NOTE_EDIT_FIELD_LENGTH).optional(),
  // Generative UI payloads are model-controlled. Regex is deliberately unavailable here.
  isRegex: z.literal(false).optional(),
  section: z.string().max(MAX_GENERATIVE_NOTE_EDIT_SECTION_LENGTH).optional(),
}).superRefine((payload, ctx) => {
  if (payload.operation === 'append' && !payload.content) {
    ctx.addIssue({
      code: 'custom',
      path: ['content'],
      message: 'append requires non-empty content',
    });
  }
  if (payload.operation === 'set' && payload.content === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['content'],
      message: 'set requires content',
    });
  }
  if (payload.operation === 'replace' && !payload.search) {
    ctx.addIssue({
      code: 'custom',
      path: ['search'],
      message: 'replace requires non-empty search',
    });
  }

  const totalBytes = [payload.content, payload.search, payload.replace, payload.section]
    .reduce((total, value) => total + (value ? new TextEncoder().encode(value).byteLength : 0), 0);
  if (totalBytes > MAX_GENERATIVE_NOTE_EDIT_INPUT_BYTES) {
    ctx.addIssue({
      code: 'custom',
      message: `note edit input exceeds ${MAX_GENERATIVE_NOTE_EDIT_INPUT_BYTES} bytes`,
    });
  }
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
