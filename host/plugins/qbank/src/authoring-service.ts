/** Authoring draft review, material edits and commit (qbank_authoring_service.rs). */
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { rfc3339Now } from '../../../platform/storage/time.ts';
import { QbankServiceError } from './question-service.ts';
import { validateDocument } from './document.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { QuestionAuthoringDraft, QuestionDraftSummary, QuestionMaterial } from '../api.ts';
import {
  AuthoringConflict, AuthoringNotFound, AuthoringValidation, commitDraftRows, countLiveQuestions, deleteMaterialRow,
  examExists,
  findJobByIdempotency, insertDraft, listDraftSummaries, markDraftCommitted, markExamCompleted, newId, readDraft,
  jsonField, readCommittedReceipt, readMaterial, updateDraftRow, updateMaterialRow,
} from '../repository/authoring.ts';
import type { AuthoringDraft, CommitReceipt } from '../repository/authoring.ts';
import { refreshCanonicalPreview } from '../repository/management.ts';
import { commitReceipt } from '../repository/authoring-decode.ts';
import { fromStr } from '../repository/serde-decode.ts';
import { requireQuestions, type QbankPorts } from './ports.ts';
import { valueFromStr } from './raw-json-number.ts';

export interface AuthoringHost extends QbankPorts { readonly db: DatabaseHandle }

function invoke<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof AuthoringConflict) throw new QbankServiceError(AppError.validation(error.message));
    if (error instanceof AuthoringNotFound) throw new QbankServiceError(AppError.not_found(error.message));
    if (error instanceof AuthoringValidation) throw new QbankServiceError(AppError.validation(error.message));
    if (error instanceof CommandError) {
      const value = error.value as { error_type?: unknown; message?: unknown; details?: unknown };
      if (value !== null && typeof value === 'object' && value.error_type === 'Validation') {
        throw new QbankServiceError(AppError.validation(String(value.message ?? '')));
      }
      throw error;
    }
    if (error instanceof QbankServiceError) throw error;
    throw new QbankServiceError(AppError.database(error instanceof Error ? error.message : String(error)));
  }
}

function validate(document: QuestionDocumentLike): void {
  validateDocument(document);
}
type QuestionDocumentLike = import('../api.ts').QuestionDocument;

export function getDraft(host: AuthoringHost, jobId: string): QuestionAuthoringDraft {
  return invoke(() => {
    const draft = readDraft(host.db, jobId);
    return { job_id: draft.job_id, exam_id: draft.exam_id, document: draft.document,
      status: draft.status, version: draft.version, metadata: draft.metadata };
  });
}

export function listDrafts(host: AuthoringHost, examId: string): QuestionDraftSummary[] {
  return invoke(() => listDraftSummaries(host.db, examId));
}

function coverageEntryValid(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false;
  const value = entry as Record<string, unknown>;
  const sourceId = value.source_id;
  const status = value.status;
  const page = value.page;
  return typeof sourceId === 'string' && sourceId.trim() !== ''
    && (status === 'processed' || status === 'uncertain' || status === 'unprocessed')
    && (page === null || (typeof page === 'number' && Number.isInteger(page) && page > 0));
}

export function reviewDraft(host: AuthoringHost, jobId: string, expectedVersion: number,
  coverage: unknown[] | null, issues: unknown[] | null, unmatchedAnswers: unknown[] | null): QuestionAuthoringDraft {
  return invoke(() => host.db.transaction(tx => {
    const draft = readDraft(tx, jobId);
    if (draft.version !== expectedVersion
      || (draft.status !== 'ready' && draft.status !== 'needs_review' && draft.status !== 'partial')) {
      throw new AuthoringConflict('CONFLICT: 草稿已提交或版本变化，请重新读取');
    }
    if (coverage !== null) {
      for (const entry of coverage) {
        if (!coverageEntryValid(entry)) throw new AuthoringValidation('coverage 必须为真实 {source_id,page,status} 列表');
      }
      const expected = jsonField(draft.metadata, 'expected_coverage');
      if (Array.isArray(expected)) {
        for (const page of expected) {
          const found = coverage.some(entry => {
            const value = entry as JsonValue;
            return jsonField(value, 'source_id') === jsonField(page, 'source_id')
              && jsonField(value, 'page') === jsonField(page, 'page');
          });
          if (!found) throw new AuthoringValidation('复核不能删除来源覆盖范围');
        }
      }
      draft.document.coverage = coverage;
    }
    if (issues !== null) draft.document.issues = issues;
    if (unmatchedAnswers !== null) draft.document.unmatched_answers = unmatchedAnswers;
    validate(draft.document);
    const status = jsonField(draft.metadata, 'complete_document') === false ? 'partial'
      : needsReview(draft.document) ? 'needs_review' : 'ready';
    const stamp = rfc3339Now();
    if (updateDraftRow(tx, jobId, draft.document, status, expectedVersion, stamp) !== 1) {
      throw new AuthoringConflict('CONFLICT: 草稿已提交或版本变化，请重新读取');
    }
    const updated = readDraft(tx, jobId);
    return { job_id: updated.job_id, exam_id: updated.exam_id, document: updated.document,
      status: updated.status, version: updated.version, metadata: updated.metadata };
  }));
}

function needsReview(document: QuestionDocumentLike): boolean {
  return document.issues.length > 0 || document.unmatched_answers.length > 0
    || document.coverage.some(entry => (entry as Record<string, unknown>).status !== 'processed');
}

function stableEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => stableEqual(value, right[index]));
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => stableEqual(a[key], b[key]));
  }
  return false;
}

export function saveDraftInTx(tx: import('../../../platform/storage/api.ts').SqlExecutor, examId: string,
  document: QuestionDocumentLike, metadata: Record<string, unknown>): string {
  validate(document);
  if (!examExists(tx, examId)) throw new AuthoringNotFound('目标题目集不存在');
  const key = typeof metadata.idempotency_key === 'string' ? metadata.idempotency_key : null;
  if (key !== null) {
    const existing = findJobByIdempotency(tx, examId, key);
    if (existing !== null) {
      // `from_str::<Value>(existing) != to_value(document)`：arbitrary_precision 下数字按原文比较。
      if (!stableEqual(valueFromStr(existing.document_json), valueFromStr(JSON.stringify(document)))) {
        throw new AuthoringConflict('CONFLICT: 相同幂等键对应不同内容');
      }
      return existing.id;
    }
  }
  const status = metadata.complete_document === false ? 'partial'
    : needsReview(document) ? 'needs_review' : 'ready';
  const jobId = newId('qjob');
  insertDraft(tx, examId, document, metadata, jobId, status, key);
  return jobId;
}

export function saveDraft(host: AuthoringHost, examId: string, document: QuestionDocumentLike,
  metadata: Record<string, unknown>): string {
  return invoke(() => saveDraftInTx(host.db, examId, document, metadata));
}

export function submitDocument(host: AuthoringHost, examId: string, document: QuestionDocumentLike,
  idempotencyKey: string): CommitReceipt {
  const jobId = saveDraft(host, examId, document, { idempotency_key: idempotencyKey });
  const draft = getDraft(host, jobId);
  if (needsReview(draft.document) || draft.status === 'partial') {
    throw new QbankServiceError(AppError.validation('草稿存在待复核事项，请用户明确选择后提交'));
  }
  return commitDraft(host, jobId, draft.document.questions.map(question => question.local_id), draft.version);
}

export function commitDraftInTx(tx: import('../../../platform/storage/api.ts').SqlExecutor, jobId: string,
  selectedLocalIds: string[], expectedVersion: number, ports?: QbankPorts): CommitReceipt {
    const draft: AuthoringDraft = readDraft(tx, jobId);
    const selected = new Set(selectedLocalIds);
    if (selectedLocalIds.length === 0 || selected.size !== selectedLocalIds.length) {
      throw new AuthoringValidation('请选择不重复的有效题目');
    }
    const selection = JSON.stringify([...selectedLocalIds].sort());
    if (draft.status === 'committed') {
      const row = readCommittedReceipt(tx, jobId);
      if (row === null || row.selected_json !== selection) {
        throw new AuthoringConflict('CONFLICT: 该草稿已按其他选择提交，请刷新题目集');
      }
      // qbank_authoring_service.rs:280
      return fromStr(row.receipt_json, commitReceipt);
    }
    if (draft.version !== expectedVersion) throw new AuthoringConflict('CONFLICT: 草稿版本已变化，请重新载入');
    if (draft.status !== 'ready' && draft.status !== 'needs_review' && draft.status !== 'partial') {
      throw new AuthoringValidation('该草稿不可提交');
    }
    validate(draft.document);
    if (selectedLocalIds.some(local => !draft.document.questions.some(question => question.local_id === local))) {
      throw new AuthoringValidation('所选题目不属于当前草稿');
    }
    if (!examExists(tx, draft.exam_id)) throw new AuthoringNotFound('目标题目集已删除');
    const stamp = rfc3339Now();
    const receipt: CommitReceipt = {
      committed: true, exam_id: draft.exam_id, question_ids: [], material_ids: [], group_ids: [],
      imported_count: 0, total_questions: 0,
      partial: selected.size !== draft.document.questions.length || jsonField(draft.metadata, 'complete_document') === false,
      needs_review: needsReview(draft.document) || jsonField(draft.metadata, 'complete_document') === false,
      coverage: draft.document.coverage, unmatched_answers: draft.document.unmatched_answers,
    };
    commitDraftRows(tx, draft, selectedLocalIds, receipt, stamp, ports);
    receipt.total_questions = countLiveQuestions(tx, draft.exam_id);
    requireQuestions(ports ?? {}).refreshStats(tx, draft.exam_id);
    refreshCanonicalPreview(tx, draft.exam_id, ports);
    markExamCompleted(tx, draft.exam_id, ports);
    if (markDraftCommitted(tx, jobId, receipt, selection, expectedVersion, stamp) !== 1) {
      throw new AuthoringConflict('CONFLICT: 草稿已被其他操作修改');
    }
    return receipt;
}

export function commitDraft(host: AuthoringHost, jobId: string, selectedLocalIds: string[],
  expectedVersion: number): CommitReceipt {
  return invoke(() => host.db.transaction(tx =>
    commitDraftInTx(tx, jobId, selectedLocalIds, expectedVersion, host)));
}

export function updateMaterial(host: AuthoringHost, materialId: string, content: string,
  expectedVersion: number): QuestionMaterial {
  return invoke(() => {
    if (content.trim() === '') throw new AuthoringValidation('材料内容不能为空');
    return updateMaterialRow(host.db, materialId, content, expectedVersion, host);
  });
}

export function deleteMaterial(host: AuthoringHost, materialId: string, expectedVersion: number): void {
  invoke(() => deleteMaterialRow(host.db, materialId, expectedVersion));
}

export { readMaterial };
