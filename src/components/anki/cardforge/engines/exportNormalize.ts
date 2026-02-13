import type { AnkiCardResult } from '../types';

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object') return false;
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (typeof v !== 'string') return false;
  }
  return true;
}

/**
 * Normalize `anki_export_cards` tool arguments into CardForge `AnkiCardResult[]`.
 *
 * The Chat V2 tool-call payload may be:
 * - Full CardForge shape (preferred), or
 * - Legacy minimal cards: `{ front, back, tags? }`, or
 * - Snake_case variants from older bridges.
 */
export function normalizeToolExportCards(cards: unknown[]): AnkiCardResult[] {
  const now = new Date().toISOString();

  return cards.map((raw, i): AnkiCardResult => {
    const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

    const frontFromFields = isStringRecord(obj.fields) ? obj.fields.Front : undefined;
    const backFromFields = isStringRecord(obj.fields) ? obj.fields.Back : undefined;
    const textFromFields = isStringRecord(obj.fields) ? obj.fields.Text : undefined;

    const front = (typeof obj.front === 'string' ? obj.front : frontFromFields) ?? '';
    const back = (typeof obj.back === 'string' ? obj.back : backFromFields) ?? '';
    const text = typeof obj.text === 'string' ? obj.text : textFromFields;

    const tags = Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === 'string') : [];
    const images = Array.isArray(obj.images) ? obj.images.filter((p): p is string => typeof p === 'string') : [];

    const templateId =
      typeof obj.templateId === 'string' && obj.templateId.trim()
        ? obj.templateId
        : typeof obj.template_id === 'string' && obj.template_id.trim()
          ? obj.template_id
          : 'basic';

    const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id : `temp-${i}`;

    const taskId =
      typeof obj.taskId === 'string' && obj.taskId.trim()
        ? obj.taskId
        : typeof obj.task_id === 'string' && obj.task_id.trim()
          ? obj.task_id
          : 'chat-v2';

    const createdAt =
      typeof obj.createdAt === 'string' && obj.createdAt.trim()
        ? obj.createdAt
        : typeof obj.created_at === 'string' && obj.created_at.trim()
          ? obj.created_at
          : now;

    const isErrorCard =
      typeof obj.isErrorCard === 'boolean'
        ? obj.isErrorCard
        : typeof obj.is_error_card === 'boolean'
          ? obj.is_error_card
          : false;

    const errorContent =
      typeof obj.errorContent === 'string'
        ? obj.errorContent
        : typeof obj.error_content === 'string'
          ? obj.error_content
          : undefined;

    // Prefer explicit fields/extras if provided; otherwise fallback to Front/Back.
    const rawFields = isStringRecord(obj.fields)
      ? obj.fields
      : isStringRecord(obj.extra_fields)
        ? obj.extra_fields
        : {};

    const fields: Record<string, string> = {
      ...rawFields,
    };

    if (!fields.Front) fields.Front = front;
    if (!fields.Back) fields.Back = back;
    if (text && !fields.Text) fields.Text = text;

    return {
      id,
      taskId,
      templateId,
      front,
      back,
      text,
      tags,
      fields,
      images,
      isErrorCard,
      errorContent,
      createdAt,
    };
  });
}

