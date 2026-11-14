/**
 * `dstu-vfs/src/vfs/qbank_read.rs`: canonical question-bank read model.
 *
 * The export adapter (dstu/export/exam_adapter.rs) reads the canonical context
 * before falling back to `exam_sheets.preview_json`. Read-only by design.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';

export interface CanonicalContextQuestion {
  id: string;
  original_label: string | null;
  content: string;
  question_type: string;
  options: unknown;
  answer: string | null;
  explanation: string | null;
  structured_data: unknown;
  images: unknown;
  group_id: string | null;
  group_position: number | null;
  provenance: unknown;
}

export interface CanonicalContextDocument {
  schema_version: number;
  exam_id: string;
  materials: Record<string, unknown>[];
  groups: Record<string, unknown>[];
  questions: CanonicalContextQuestion[];
}

function parseOrNull(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parseOrEmptyArray(raw: string | null): unknown {
  if (raw === null) return [];
  try { return JSON.parse(raw) as unknown; }
  catch { return []; }
}

/** `context_with_conn` (qbank_read.rs:5-29). */
export function contextWithConn(conn: SqlExecutor, examId: string): CanonicalContextDocument | null {
  const questions = conn.all<{
    id: string; question_label: string | null; content: string; question_type: string;
    options_json: string | null; answer: string | null; explanation: string | null;
    structured_data: string | null; images_json: string | null; group_id: string | null;
    group_position: number | null; provenance_json: string | null;
  }>(`SELECT id, question_label, content, question_type, options_json, answer, explanation,
      structured_data, images_json, group_id, group_position, provenance_json
    FROM questions WHERE exam_id = ?1 AND deleted_at IS NULL ORDER BY created_at, rowid`, [examId])
    .map(row => ({
      id: row.id,
      original_label: row.question_label,
      content: row.content,
      question_type: row.question_type,
      options: parseOrNull(row.options_json),
      answer: row.answer,
      explanation: row.explanation,
      structured_data: parseOrNull(row.structured_data),
      images: parseOrNull(row.images_json),
      group_id: row.group_id,
      group_position: row.group_position,
      provenance: parseOrNull(row.provenance_json),
    }));

  const canonical = Boolean(conn.pluck<number>(
    `SELECT EXISTS(SELECT 1 FROM exam_sheets WHERE id = ?1
      AND json_extract(metadata_json, '$.question_document_version') = 2)`, [examId]));
  if (questions.length === 0 && !canonical) return null;

  const materials = conn.all<{
    id: string; content: string; images_json: string; source_refs_json: string; local_version: number;
  }>(`SELECT DISTINCT m.id, m.content, m.images_json, m.source_refs_json, m.local_version
    FROM qbank_materials m
    JOIN qbank_group_materials l ON l.material_id = m.id
    JOIN qbank_groups g ON g.id = l.group_id
    WHERE m.exam_id = ?1 AND m.deleted_at IS NULL AND l.deleted_at IS NULL
      AND g.deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM questions q WHERE q.group_id = g.id AND q.deleted_at IS NULL)
    ORDER BY m.created_at, m.id`, [examId])
    .map(row => ({
      id: row.id,
      content: row.content,
      images: parseOrEmptyArray(row.images_json),
      source_refs: parseOrEmptyArray(row.source_refs_json),
      version: row.local_version,
    }));

  const groups = conn.all<{
    id: string; label: string; local_version: number; material_id: string | null;
  }>(`SELECT g.id, g.label, g.local_version, l.material_id
    FROM qbank_groups g
    LEFT JOIN qbank_group_materials l ON l.group_id = g.id AND l.deleted_at IS NULL
    WHERE g.exam_id = ?1 AND g.deleted_at IS NULL
    ORDER BY g.position, l.position`, [examId])
    .map(row => ({
      group_id: row.id,
      label: row.label,
      version: row.local_version,
      material_id: row.material_id,
    }));

  return { schema_version: 2, exam_id: examId, materials, groups, questions };
}

function jsonText(value: unknown): string {
  return value === undefined ? 'null' : JSON.stringify(value);
}

/** `context_text` (qbank_read.rs:31-44). */
export function contextText(document: CanonicalContextDocument): string {
  const lines: string[] = [];
  for (const material of document.materials) {
    lines.push(`Shared material ${typeof material.id === 'string' ? material.id : ''}\n`
      + `${typeof material.content === 'string' ? material.content : ''}`);
  }
  for (const question of document.questions) {
    lines.push(`Question ${question.id}\n`
      + `${question.content}\n`
      + `options: ${jsonText(question.options)}\n`
      + `answer: ${jsonText(question.answer)}\n`
      + `explanation: ${jsonText(question.explanation)}\n`
      + `structured_data: ${jsonText(question.structured_data)}\n`
      + `group: ${jsonText(question.group_id)}\n`
      + `source: ${jsonText(question.provenance)}`);
  }
  return lines.join('\n\n');
}

/** `image_refs` (qbank_read.rs:46-65): materials before questions, first hash wins. */
export function imageRefs(document: CanonicalContextDocument): Record<string, unknown>[] {
  const seen = new Set<string>();
  const result: Record<string, unknown>[] = [];
  for (const item of [...document.materials, ...document.questions]) {
    if (!Array.isArray(item.images)) continue;
    for (const image of item.images) {
      if (image === null || typeof image !== 'object' || typeof image.hash !== 'string' || seen.has(image.hash)) continue;
      seen.add(image.hash);
      result.push(image as Record<string, unknown>);
    }
  }
  return result;
}
