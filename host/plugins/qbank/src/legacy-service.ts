/** Command-facing wrapper for qbank_legacy_reconcile.rs audit/migrate. */
import { CommandError } from '../../../kernel/api.ts';
import { AppError, type JsonValue } from '../../../platform/errors/api.ts';
import { rfc3339Now } from '../../../platform/storage/time.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { QbankServiceError } from './question-service.ts';
import { validateDocument } from './document.ts';
import { commitDraftInTx, saveDraftInTx } from './authoring-service.ts';
import {
  AuthoringConflict, AuthoringNotFound, AuthoringValidation, jsonField, jsonGet, readDraft,
} from '../repository/authoring.ts';
import { reparseDecision, reparseResolveReceipt } from '../repository/authoring-decode.ts';
import { vec } from '../repository/serde-decode.ts';
import { invalidateExamContentIndex, refreshCanonicalPreview } from '../repository/management.ts';
import {
  LegacyConflict, LegacyNotFound, LegacyValidation, auditLegacyCards, bindMigratedCard, hashValue,
  idempotentReceipt, legacySnapshot, mergePreviewUnion, previewCardToDraft, previewPages, rawPreview,
  savePreview, applyReparseImportMarker, decisionsEqual, draftSourceSlot, examImportState,
  imageExists, liveExamExists, loadCanonicalRow, normalizeReparseDecisions, reparseReport, reparseResolveRow,
  replaceCanonicalRow, supportsStandaloneImport, writeExamImportStateText,
  type AuditCard, type MigrationAudit, type MigrationReceipt, type ReparseDecision,
  type ReparseReport, type ReparseResolveReceipt,
} from '../repository/legacy.ts';
import type { DraftQuestion, QuestionDocument } from '../api.ts';
import { requireQuestions, type QbankPorts } from './ports.ts';
import { valueFromStr } from './raw-json-number.ts';

export interface LegacyHost extends QbankPorts { readonly db: DatabaseHandle }

function invoke<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof LegacyConflict) throw new QbankServiceError(AppError.conflict(error.message));
    if (error instanceof LegacyNotFound) throw new QbankServiceError(AppError.not_found(error.message));
    if (error instanceof LegacyValidation) throw new QbankServiceError(AppError.validation(error.message));
    if (error instanceof AuthoringConflict) throw new QbankServiceError(AppError.conflict(error.message));
    if (error instanceof AuthoringNotFound) throw new QbankServiceError(AppError.not_found(error.message));
    if (error instanceof AuthoringValidation) throw new QbankServiceError(AppError.validation(error.message));
    if (error instanceof CommandError) {
      const value = error.value as { error_type?: unknown; message?: unknown };
      if (value !== null && typeof value === 'object' && value.error_type === 'Validation') {
        throw new QbankServiceError(AppError.validation(`所选历史卡片无法迁移: ${String(value.message ?? '')}`));
      }
      throw error;
    }
    if (error instanceof QbankServiceError) throw error;
    throw new QbankServiceError(AppError.database(error instanceof Error ? error.message : String(error)));
  }
}

export function audit(host: LegacyHost, examId: string): MigrationAudit {
  return invoke(() => auditLegacyCards(host.db, examId));
}

export function migrate(host: LegacyHost, examId: string, cardIds: string[],
  expectedVersion: string): MigrationReceipt {
  return invoke(() => {
    if (cardIds.length === 0) throw new LegacyValidation('请选择要迁移的历史题目卡片');
    if (new Set(cardIds).size !== cardIds.length) throw new LegacyValidation('迁移选择包含重复的卡片 ID');
    if (cardIds.some(id => id.trim() === '')) throw new LegacyValidation('卡片 ID 不能为空');
    return host.db.transaction(tx => {
      const auditResult = auditLegacyCards(tx, examId);
      const replay = idempotentReceipt(tx, examId, cardIds, auditResult.audit_version);
      if (replay !== null) return replay;
      if (auditResult.audit_version !== expectedVersion) {
        throw new LegacyConflict('历史导入审计已变化，请重新载入后再选择迁移（未修改任何内容）');
      }
      const byId = new Map<string, AuditCard>();
      for (const card of auditResult.cards) if (card.card_id !== null) byId.set(card.card_id, card);
      const selected: AuditCard[] = [];
      for (const id of cardIds) {
        const item = byId.get(id);
        if (item === undefined) throw new LegacyValidation(`审计结果中不存在卡片: ${id}`);
        if (!item.migratable || item.status !== 'unmatched') {
          throw new LegacyValidation(`卡片 ${id} 当前不可迁移（状态 ${item.status}）：${item.reason ?? '需要用户重新复核'}`);
        }
        selected.push(item);
      }
      const preview = previewPages(tx, examId);
      const pageMap = new Map<string, typeof preview[number]>();
      const cardMap = new Map<string, typeof preview[number]['cards'][number]>();
      for (const page of preview) {
        for (const card of page.cards) {
          const key = `${page.page_index}:${card.card_index}`;
          pageMap.set(key, page);
          cardMap.set(key, card);
        }
      }
      const originalPreview = rawPreview(tx, examId);
      const document: QuestionDocument = {
        schema_version: 2, mode: 'extract', materials: [], groups: [], questions: [],
        unmatched_answers: [], coverage: [], issues: [],
      };
      const localIds: string[] = [];
      const snapshots: Record<string, unknown>[] = [];
      for (const item of selected) {
        const cardId = item.card_id!;
        const key = `${item.page_index}:${item.card_index}`;
        const card = cardMap.get(key);
        const page = pageMap.get(key);
        if (card === undefined) throw new LegacyValidation(`卡片 ${cardId} 的预览内容已变化，请重新载入`);
        if (page === undefined) throw new LegacyValidation(`卡片 ${cardId} 所在页面已变化，请重新载入`);
        const draft = previewCardToDraft(tx, card, page);
        localIds.push(draft.local_id);
        snapshots.push(legacySnapshot(cardId, card, page));
        document.questions.push(draft);
      }
      validateDocument(document);
      const selectionHash = hashValue(cardIds);
      const metadata = {
        idempotency_key: `legacy-migrate:${examId}:${selectionHash}`,
        legacy_migration: { exam_id: examId, card_ids: cardIds, audit_version: expectedVersion },
      };
      const job = saveDraftInTx(tx, examId, document, metadata);
      const draft = readDraft(tx, job);
      const receipt = commitDraftInTx(tx, job, localIds, draft.version, host);
      if (!receipt.committed || receipt.question_ids.length !== localIds.length) {
        throw new Error('历史卡片迁移未返回完整题目映射，未继续写入卡片身份');
      }
      const stamp = rfc3339Now();
      for (let index = 0; index < cardIds.length; index += 1) {
        bindMigratedCard(requireQuestions(host), tx, examId, cardIds[index]!, receipt.question_ids[index]!,
          snapshots[index]!, expectedVersion, stamp);
      }
      refreshCanonicalPreview(tx, examId, host);
      const projected = rawPreview(tx, examId);
      const merged = mergePreviewUnion(originalPreview, projected);
      savePreview(tx, examId, merged, host);
      requireQuestions(host).refreshStats(tx, examId);
      let after: string | null = null;
      try {
        after = auditLegacyCards(tx, examId).audit_version;
      } catch (error) {
        host.log?.warn(`[qbank] legacy re-audit failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return {
        exam_id: examId, committed: true, idempotent: false, job_id: job,
        migrated_card_ids: [...cardIds], question_ids: receipt.question_ids,
        imported_count: receipt.imported_count, audit_version_before: expectedVersion,
        audit_version_after: after,
      };
    });
  });
}

function commandValidationMessage(error: unknown): string | null {
  if (!(error instanceof CommandError)) return null;
  const value = error.value as { error_type?: unknown; message?: unknown };
  if (value === null || typeof value !== 'object' || value.error_type !== 'Validation') return null;
  return String(value.message ?? '');
}

function validateReparseQuestion(tx: import('../../../platform/storage/api.ts').SqlExecutor,
  question: DraftQuestion): void {
  const standalone: DraftQuestion = { ...question, group_id: null, parent_id: null, parent_local_id: null };
  try {
    validateDocument({
      schema_version: 2, mode: 'extract', materials: [], groups: [], questions: [standalone],
      unmatched_answers: [], coverage: [], issues: [],
    });
  } catch (error) {
    const message = commandValidationMessage(error);
    if (message !== null) throw new LegacyValidation(`复核内容无效: ${message}`);
    throw error;
  }
  for (const image of question.images) {
    if (!imageExists(tx, image.id, image.hash)) {
      throw new LegacyValidation(`复核题目图片不可用: ${image.name}`);
    }
  }
}

function importReparseQuestion(tx: import('../../../platform/storage/api.ts').SqlExecutor,
  examId: string, jobId: string, reportVersion: string, question: DraftQuestion, keepSlot: boolean,
  metadata: JsonValue, ports?: QbankPorts): string {
  if (!supportsStandaloneImport(question)) {
    throw new LegacyValidation('题组/变式题不能单独导入为新题');
  }
  const draftQuestion: DraftQuestion = {
    ...question, group_id: null, parent_id: null, parent_local_id: null,
    source_refs: keepSlot ? question.source_refs : [],
    answer_source_refs: keepSlot ? question.answer_source_refs : [],
  };
  const document: QuestionDocument = {
    schema_version: 2, mode: 'extract', materials: [], groups: [], questions: [draftQuestion],
    unmatched_answers: [], coverage: [], issues: [],
  };
  try {
    validateDocument(document);
  } catch (error) {
    const message = commandValidationMessage(error);
    if (message !== null) throw new LegacyValidation(`导入为新题失败: ${message}`);
    throw error;
  }
  const meta: Record<string, unknown> = {
    idempotency_key: `reparse-import:${examId}:${jobId}:${question.local_id}:${reportVersion}`,
    reparse_import: {
      exam_id: examId, job_id: jobId, local_id: question.local_id, keep_source_slot: keepSlot,
    },
  };
  if (keepSlot) {
    const sources = jsonGet(metadata, 'sources');
    const pages = jsonGet(metadata, 'pages');
    if (sources !== undefined) meta.sources = sources;
    if (pages !== undefined) meta.pages = pages;
  }
  const job = saveDraftInTx(tx, examId, document, meta);
  const draft = readDraft(tx, job);
  const receipt = commitDraftInTx(tx, job, [draftQuestion.local_id], draft.version, ports);
  if (!receipt.committed || receipt.imported_count !== 1 || receipt.question_ids.length !== 1) {
    throw new LegacyConflict('来源槽已被占用，未导入新题，也未复用既有题目身份');
  }
  const id = receipt.question_ids[0];
  if (id === undefined) throw new Error('新题导入未返回题目 ID');
  applyReparseImportMarker(requireQuestions(ports ?? {}), tx, id, jobId, question, nowStamp());
  return id;
}

function nowStamp(): string {
  return rfc3339Now();
}

/** 导入状态里的 `job_id`；非法 JSON 或不是对象时为 null（这类状态一律保留）。 */
function importStateJobId(importState: string): JsonValue | undefined {
  let parsed: JsonValue;
  try {
    parsed = valueFromStr(importState);
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.job_id : null;
}

export function reparse(host: LegacyHost, examId: string, jobId: string | null): ReparseReport {
  return invoke(() => reparseReport(host.db, examId, jobId));
}

export function resolveReparse(host: LegacyHost, examId: string, jobId: string,
  decisions: ReparseDecision[], expectedReportVersion: string): ReparseResolveReceipt {
  return invoke(() => host.db.transaction(tx => {
    if (!liveExamExists(tx, examId)) throw new LegacyNotFound('目标题目集不存在');
    const draft = readDraft(tx, jobId);
    if (draft.exam_id !== examId) throw new LegacyValidation('草稿不属于目标题目集');
    try {
      validateDocument(draft.document);
    } catch (error) {
      const message = commandValidationMessage(error);
      if (message !== null) throw new LegacyValidation(message);
      throw error;
    }
    const normalized = normalizeReparseDecisions(draft.document, decisions);
    // qbank_legacy_reconcile.rs:508-516: `metadata.get(..)` then `from_value(saved[..])`.
    const saved = jsonGet(draft.metadata, 'reparse_resolution');
    if (saved !== undefined) {
      const previous = vec(reparseDecision)(jsonField(saved, 'decisions'), 'decisions');
      if (!decisionsEqual(previous, normalized)) {
        throw new LegacyConflict('该草稿已完成复核，不能改变已确认的选择；请创建新草稿');
      }
      return reparseResolveReceipt(jsonField(saved, 'receipt'), 'receipt');
    }
    if (!['ready', 'needs_review', 'partial', 'committed'].includes(draft.status)) {
      throw new LegacyConflict('该草稿已取消或不可复核，请重新载入');
    }
    const report = reparseReport(tx, examId, jobId);
    if (report.report_version !== expectedReportVersion) {
      throw new LegacyConflict('重解析报告已变化，请重新载入后再确认操作（未修改任何内容）');
    }
    const items = new Map<string, (typeof report.items)[number]>();
    for (const item of report.items) items.set(item.local_id, item);
    const byLocal = new Map<string, DraftQuestion>();
    for (const question of draft.document.questions) byLocal.set(question.local_id, question);
    const replacementTargets = new Set<string>();
    const importSlots = new Set<string>();
    for (const decision of normalized) {
      const item = items.get(decision.local_id);
      if (item === undefined) throw new LegacyValidation(`草稿题目不存在: ${decision.local_id}`);
      if (!item.allowed_actions.includes(decision.action)) {
        throw new LegacyValidation(`题目 ${decision.local_id} 不允许操作 ${decision.action}（状态 ${item.status}）`);
      }
      const question = byLocal.get(decision.local_id)!;
      if (decision.action === 'import_as_new' && !supportsStandaloneImport(question)) {
        throw new LegacyValidation('题组/变式题不能单独导入为新题');
      }
      if (decision.action === 'import_as_new' && item.status === 'new' && item.source_key !== null) {
        if (importSlots.has(item.source_key)) {
          throw new LegacyValidation('多个草稿题目使用同一新增来源槽，不能猜测身份');
        }
        importSlots.add(item.source_key);
      }
      if (decision.action !== 'keep_existing') validateReparseQuestion(tx, question);
      if (decision.action === 'replace_existing') {
        const expected = decision.expected_revision;
        if (expected === null || expected === undefined || expected === '') {
          throw new LegacyValidation('替换操作必须携带 expected_revision');
        }
        if (item.canonical_revision !== expected) {
          throw new LegacyConflict('题目版本已变化，请重新载入后再替换');
        }
        if (item.canonical_question_id === null) {
          throw new LegacyValidation('该草稿项没有可替换的正式题目');
        }
        if (replacementTargets.has(item.canonical_question_id)) {
          throw new LegacyValidation('同一正式题目不能在一次复核中被重复替换');
        }
        replacementTargets.add(item.canonical_question_id);
      }
    }
    const originalPreview = rawPreview(tx, examId);
    const importState = examImportState(tx, examId, host);
    const receipt: ReparseResolveReceipt = {
      exam_id: examId, job_id: jobId, applied: [], imported_question_ids: [],
      replaced_question_ids: [], kept_local_ids: [],
    };
    for (const decision of normalized) {
      const item = items.get(decision.local_id)!;
      const question = byLocal.get(decision.local_id)!;
      if (decision.action === 'keep_existing') {
        receipt.kept_local_ids.push(decision.local_id);
        receipt.applied.push({ local_id: decision.local_id, action: decision.action,
          question_id: item.canonical_question_id });
      } else if (decision.action === 'import_as_new') {
        const keepSlot = item.status === 'new' && item.source_key !== null;
        const id = importReparseQuestion(tx, examId, jobId, report.report_version, question,
          keepSlot, draft.metadata, host);
        receipt.imported_question_ids.push(id);
        receipt.applied.push({ local_id: decision.local_id, action: decision.action, question_id: id });
      } else {
        const questionId = item.canonical_question_id!;
        const expected = decision.expected_revision!;
        replaceCanonicalRow(requireQuestions(host), tx, examId, questionId, expected, question, jobId, nowStamp());
        receipt.replaced_question_ids.push(questionId);
        receipt.applied.push({ local_id: decision.local_id, action: decision.action,
          question_id: questionId });
      }
    }
    if (receipt.imported_question_ids.length > 0 || receipt.replaced_question_ids.length > 0) {
      refreshCanonicalPreview(tx, examId, host);
      const projected = rawPreview(tx, examId);
      savePreview(tx, examId, mergePreviewUnion(originalPreview, projected), host);
      invalidateExamContentIndex(tx, examId, host);
      requireQuestions(host).refreshStats(tx, examId);
    }
    const resolution = {
      report_version: expectedReportVersion, decisions: normalized, receipt, resolved_at: nowStamp(),
    };
    if (reparseResolveRow(tx, jobId, examId, draft.version, resolution, nowStamp()) !== 1) {
      throw new LegacyConflict('草稿已被其他操作修改，未应用任何复核选择');
    }
    // qbank_legacy_reconcile.rs:691-699：无条件写一次（exam_sheets 触发器记一行 __change_log）；
    // 属于本草稿的状态写 NULL，其余（含 NULL、非法 JSON）按原文写回。
    const retainedState = importState !== null && importStateJobId(importState) === jobId ? null : importState;
    writeExamImportStateText(tx, examId, retainedState);
    return receipt;
  }, { behavior: 'immediate' }));
}
