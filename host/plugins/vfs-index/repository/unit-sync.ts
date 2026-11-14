/**
 * Input resolution for `index_service.rs::sync_resource_to_units`
 * (`indexing.rs:2066-2167`). Read-only support SQL; all unit writes go through
 * the L11 owner repositories.
 */
import type { Row, SqlExecutor } from '../../../platform/storage/api.ts';
import type { Question, VfsReposService } from '../../vfs-repos/api.ts';
import type { UnitBuildInput } from '../api.ts';
import { getExamIdForResource } from './index-content.ts';
import { getFullResource, getResourceOcrText } from './index-units.ts';

/** `pdfium_utils::PDF_PAGE_SEPARATOR`: one form feed between pages. */
export const PDF_PAGE_SEPARATOR = '\f';

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * A legacy multi-page PDF is missing the page separators required by
 * `native_pdf_pages`, so the Rust path re-extracts it from the original bytes.
 * `indexing.rs:2093-2103`.
 */
export function needsLegacyPdfReextract(input: UnitBuildInput): boolean {
  return (input.resourceType === 'file' || input.resourceType === 'image')
    && input.extractedText !== null
    && input.extractedText !== undefined
    && input.blobHash !== null
    && input.blobHash !== undefined
    && input.pageCount !== null
    && input.pageCount !== undefined
    && input.pageCount > 1
    && !input.extractedText.includes(PDF_PAGE_SEPARATOR);
}

/** `media_index.rs::file_id_for_resource`: `files.id` for a `res_*` resource. */
export function getFileIdForResource(db: SqlExecutor, resourceId: string): string | null {
  const value = db.pluck<unknown>(
    'SELECT id FROM files WHERE resource_id = ?1 LIMIT 1',
    [resourceId],
  );
  return value === null || value === undefined ? null : text(value);
}

/**
 * Reconstructs the `qbank_read::context_with_conn` document from L11's
 * canonical question read model. L11 exposes the questions/materials but not
 * `provenance_json` or the qbank group version, so those two leaf fields use
 * the closest published value (`source_refs` / first material version).
 */
function canonicalExamDocument(examId: string, questions: readonly Question[]): string {
  const materials = new Map<string, Record<string, unknown>>();
  const groups = new Map<string, Record<string, unknown>>();
  for (const question of questions) {
    for (const material of question.materials) {
      if (materials.has(material.id)) continue;
      materials.set(material.id, {
        id: material.id,
        content: material.content,
        images: material.images,
        source_refs: material.source_refs,
        version: material.version,
      });
    }
    if (question.group_id !== null && !groups.has(question.group_id)) {
      groups.set(question.group_id, {
        group_id: question.group_id,
        label: question.group_label ?? '',
        version: question.materials[0]?.version ?? 0,
        material_id: question.materials[0]?.id ?? null,
      });
    }
  }
  return JSON.stringify({
    schema_version: 2,
    exam_id: examId,
    materials: [...materials.values()],
    groups: [...groups.values()],
    questions: questions.map((question) => ({
      id: question.id,
      original_label: question.question_label,
      content: question.content,
      question_type: question.question_type,
      options: question.options,
      answer: question.answer,
      explanation: question.explanation,
      structured_data: question.structured_data,
      images: question.images,
      group_id: question.group_id,
      group_position: question.group_position,
      provenance: question.source_refs.length > 0 ? question.source_refs : null,
    })),
  });
}

/**
 * Builds the `UnitBuildInput` used by the background indexer.
 *
 * File/image rows keep the Rust column selection. Exam rows read the canonical
 * question-bank text through L11 (`questions.canonicalQuestions` /
 * `canonicalText`, `indexing.rs:2127-2153`); without an owner binding they fall
 * back to the inline resource payload.
 */
export function getIndexingUnitSource(
  db: SqlExecutor,
  resourceId: string,
  repositories?: VfsReposService,
): UnitBuildInput | undefined {
  const resource = getFullResource(db, resourceId);
  if (resource === undefined) return undefined;

  if (resource.resourceType === 'file' || resource.resourceType === 'image') {
    const row = db.get<Row>(
      `SELECT blob_hash, page_count, extracted_text, preview_json, ocr_pages_json
       FROM files WHERE resource_id = ?1`,
      [resourceId],
    );
    return {
      resourceId,
      resourceType: resource.resourceType,
      data: resource.data,
      ocrText: getResourceOcrText(db, resourceId),
      ocrPagesJson: row === undefined ? null : nullableText(row['ocr_pages_json']),
      blobHash: row === undefined ? null : nullableText(row['blob_hash']),
      pageCount: row === undefined ? null : nullableInteger(row['page_count']),
      extractedText: row === undefined ? null : nullableText(row['extracted_text']),
      previewJson: row === undefined ? null : nullableText(row['preview_json']),
    };
  }

  if (resource.resourceType === 'exam') {
    const examId = getExamIdForResource(db, resourceId);
    let canonicalData: string | null = null;
    let canonicalText: string | null = null;
    if (examId !== null && repositories !== undefined) {
      const questions = repositories.questions.canonicalQuestions(db, examId);
      if (questions.length > 0) {
        canonicalData = canonicalExamDocument(examId, questions);
        canonicalText = repositories.questions.canonicalText(db, examId);
      } else {
        const canonical = Number(db.pluck<number>(
          `SELECT EXISTS(SELECT 1 FROM exam_sheets WHERE id = ?1
             AND json_extract(metadata_json, '$.question_document_version') = 2)`,
          [examId],
        ) ?? 0) > 0;
        if (canonical) {
          canonicalData = canonicalExamDocument(examId, questions);
          canonicalText = repositories.questions.canonicalText(db, examId);
        }
      }
    }
    return {
      resourceId,
      resourceType: 'exam',
      data: canonicalData ?? resource.data,
      ocrText: canonicalText,
      // RUST-FIX(RF-W04-exam-unit-canonical-text): indexing.rs:2149 serializes
      // `[{"page_index":0,"text":...}]`, which its own `parse_ocr_pages_json` rejects, so Rust exam
      // units end up with NULL text and lexical retrieval over unit text never matches an exam.
      ocrPagesJson: canonicalText === null ? null : JSON.stringify([canonicalText]),
      blobHash: null,
      pageCount: 1,
      extractedText: null,
      previewJson: null,
    };
  }

  return {
    resourceId,
    resourceType: resource.resourceType,
    data: resource.data,
    ocrText: null,
    ocrPagesJson: null,
    blobHash: resource.hash,
    pageCount: null,
    extractedText: null,
    previewJson: null,
  };
}
