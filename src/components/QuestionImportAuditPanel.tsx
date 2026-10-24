/**
 * Historical preview-only import audit / reconciliation panel.
 *
 * The panel is intentionally a leaf component: the host page decides where to
 * mount it. It never mutates anything until the user explicitly selects cards
 * or clicks a reparse action.
 *
 * IPC contract (registered by the parent command layer):
 * - qbank_legacy_audit(examId) -> LegacyMigrationAudit
 * - qbank_legacy_migrate_selected(examId, cardIds, expectedVersion)
 * - qbank_reparse_report(examId, jobId?) -> ReparseReport
 * - qbank_reparse_resolve(examId, jobId, decisions, expectedReportVersion)
 *
 * All reports are returned verbatim from the backend (snake_case). OCC values
 * (`audit_version` / `report_version` / per-item `canonical_revision`) are
 * passed back unchanged so a stale UI can never overwrite newer data.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { DsButton } from '@/components/ui/DsButton';

export type LegacyCardStatus =
  | 'matched'
  | 'unmatched'
  | 'ambiguous'
  | 'deleted'
  | 'invalid'
  | 'suppressed_canonical';

export interface LegacyAuditPage {
  page_index: number;
  blob_hash: string | null;
  original_image_path: string;
  width: number | null;
  height: number | null;
  card_count: number;
}

export interface LegacyAuditCard {
  card_id: string | null;
  page_index: number;
  card_index: number;
  question_label: string | null;
  preview_text: string;
  status: LegacyCardStatus;
  formal_question_id: string | null;
  candidate_question_ids: string[];
  deleted_question_ids: string[];
  migratable: boolean;
  reason: string | null;
}

export interface LegacyMigrationAudit {
  exam_id: string;
  canonical_marker: boolean;
  canonical_question_count: number;
  source_version: string;
  audit_version: string;
  pages: LegacyAuditPage[];
  cards: LegacyAuditCard[];
  migratable_card_ids: string[];
  matched_count: number;
  unmatched_count: number;
  ambiguous_count: number;
  deleted_count: number;
  invalid_count: number;
  suppressed_count: number;
}

export interface LegacyMigrationReceipt {
  exam_id: string;
  committed: boolean;
  idempotent: boolean;
  job_id: string | null;
  migrated_card_ids: string[];
  question_ids: string[];
  imported_count: number;
  audit_version_before: string;
  audit_version_after: string | null;
}

export interface ReparseFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export type ReparseItemStatus =
  | 'unchanged'
  | 'changed'
  | 'new'
  | 'unmapped'
  | 'deleted'
  | 'ambiguous';

export type ReparseAction = 'keep_existing' | 'import_as_new' | 'replace_existing';

export interface ReparseItem {
  local_id: string;
  source_key: string | null;
  status: ReparseItemStatus;
  canonical_question_id: string | null;
  canonical_revision: string | null;
  candidate_question_ids: string[];
  changes: ReparseFieldChange[];
  allowed_actions: ReparseAction[];
  reason: string | null;
}

export interface ReparseCanonicalOnlyItem {
  question_id: string;
  source_key: string;
  canonical_revision: string;
  question_label: string | null;
}

export interface ReparseReport {
  exam_id: string;
  job_id: string;
  job_version: number;
  report_version: string;
  canonical_marker: boolean;
  canonical_question_count: number;
  items: ReparseItem[];
  canonical_only: ReparseCanonicalOnlyItem[];
  changed_count: number;
  new_count: number;
  deleted_count: number;
  ambiguous_count: number;
  resolved?: boolean;
  resolution?: ReparseResolveReceipt | null;
}

export interface ReparseDecision {
  local_id: string;
  action: ReparseAction;
  expected_revision: string | null;
}

export interface ReparseAppliedItem {
  local_id: string;
  action: ReparseAction;
  question_id: string | null;
}

export interface ReparseResolveReceipt {
  exam_id: string;
  job_id: string;
  applied: ReparseAppliedItem[];
  imported_question_ids: string[];
  replaced_question_ids: string[];
  kept_local_ids: string[];
}

export async function auditLegacyCards(examId: string): Promise<LegacyMigrationAudit> {
  return invoke<LegacyMigrationAudit>('qbank_legacy_audit', { examId });
}

export async function migrateLegacyCards(
  examId: string,
  cardIds: string[],
  expectedVersion: string,
): Promise<LegacyMigrationReceipt> {
  return invoke<LegacyMigrationReceipt>('qbank_legacy_migrate_selected', {
    examId,
    cardIds,
    expectedVersion,
  });
}

export async function getReparseReport(
  examId: string,
  jobId?: string | null,
): Promise<ReparseReport> {
  return invoke<ReparseReport>('qbank_reparse_report', {
    examId,
    jobId: jobId ?? null,
  });
}

export async function resolveReparse(
  examId: string,
  jobId: string,
  decisions: ReparseDecision[],
  expectedReportVersion: string,
): Promise<ReparseResolveReceipt> {
  return invoke<ReparseResolveReceipt>('qbank_reparse_resolve', {
    examId,
    jobId,
    decisions,
    expectedReportVersion,
  });
}

export interface QuestionImportAuditPanelProps {
  examId: string;
  /** Called after a successful migration / reparse resolution. */
  onChanged?: () => void | Promise<void>;
  className?: string;
}

interface ReparseChoice {
  action: ReparseAction;
  expectedRevision: string | null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function statusTone(status: LegacyCardStatus | ReparseItemStatus): string {
  switch (status) {
    case 'matched':
    case 'unchanged':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'unmatched':
    case 'new':
    case 'unmapped':
      return 'bg-sky-50 text-sky-700 border-sky-200';
    case 'changed':
      return 'bg-amber-50 text-amber-700 border-amber-200';
    case 'ambiguous':
      return 'bg-orange-50 text-orange-700 border-orange-200';
    case 'deleted':
    case 'suppressed_canonical':
      return 'bg-rose-50 text-rose-700 border-rose-200';
    default:
      return 'bg-slate-50 text-slate-600 border-slate-200';
  }
}

export function QuestionImportAuditPanel({
  examId,
  onChanged,
  className,
}: QuestionImportAuditPanelProps) {
  const { t } = useTranslation('exam_sheet');
  const tr = useCallback(
    (key: string, fallback: string, options?: Record<string, string | number>) =>
      t(key, { defaultValue: fallback, ...options }),
    [t],
  );
  const [audit, setAudit] = useState<LegacyMigrationAudit | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [migrating, setMigrating] = useState(false);
  const [receipt, setReceipt] = useState<LegacyMigrationReceipt | null>(null);

  const [reparse, setReparse] = useState<ReparseReport | null>(null);
  const [reparseError, setReparseError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, ReparseChoice>>({});
  const [resolving, setResolving] = useState(false);
  const [resolveReceipt, setResolveReceipt] = useState<ReparseResolveReceipt | null>(null);

  const loadAudit = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await auditLegacyCards(examId);
      setAudit(next);
      setSelected((previous) => {
        const allowed = new Set(next.migratable_card_ids);
        const kept = new Set<string>();
        previous.forEach((id) => {
          if (allowed.has(id)) kept.add(id);
        });
        return kept;
      });
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }, [examId]);

  const loadReparse = useCallback(async () => {
    setReparseError(null);
    try {
      const next = await getReparseReport(examId);
      setReparse(next);
      if (next.resolution) setResolveReceipt(next.resolution);
      const nextChoices: Record<string, ReparseChoice> = {};
      next.items.forEach((item) => {
        const action: ReparseAction = item.allowed_actions.includes('keep_existing')
          ? 'keep_existing'
          : item.allowed_actions[0] ?? 'keep_existing';
        nextChoices[item.local_id] = {
          action,
          expectedRevision:
            action === 'replace_existing' ? item.canonical_revision : null,
        };
      });
      setChoices(nextChoices);
    } catch (loadError) {
      setReparse(null);
      setReparseError(errorText(loadError));
    }
  }, [examId]);

  useEffect(() => {
    void loadAudit();
    void loadReparse();
  }, [loadAudit, loadReparse]);

  const migratable = useMemo(
    () => new Set(audit?.migratable_card_ids ?? []),
    [audit],
  );
  const selectedIds = useMemo(
    () =>
      Array.from(selected).filter((id) => migratable.has(id)),
    [selected, migratable],
  );
  const allSelected =
    selectedIds.length > 0 && selectedIds.length === migratable.size;

  const toggleCard = (cardId: string) => {
    if (!migratable.has(cardId)) return;
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(migratable));
  };

  const migrateSelected = async () => {
    if (!audit || selectedIds.length === 0) return;
    setMigrating(true);
    setError(null);
    setReceipt(null);
    try {
      const result = await migrateLegacyCards(
        examId,
        selectedIds,
        audit.audit_version,
      );
      setReceipt(result);
      await loadAudit();
      await onChanged?.();
    } catch (migrationError) {
      // A stale selection must be re-audited; never retry blindly.
      await loadAudit();
      setError(errorText(migrationError));
    } finally {
      setMigrating(false);
    }
  };

  const updateChoice = (item: ReparseItem, action: ReparseAction) => {
    setChoices((previous) => ({
      ...previous,
      [item.local_id]: {
        action,
        expectedRevision:
          action === 'replace_existing' ? item.canonical_revision : null,
      },
    }));
  };

  const resolveDecisions = async () => {
    if (!reparse || reparse.resolved || resolving) return;
    setResolving(true);
    setReparseError(null);
    setResolveReceipt(null);
    try {
      const decisions: ReparseDecision[] = reparse.items.map((item) => {
        const choice = choices[item.local_id] ?? {
          action: 'keep_existing' as ReparseAction,
          expectedRevision: null,
        };
        return {
          local_id: item.local_id,
          action: choice.action,
          expected_revision:
            choice.action === 'replace_existing'
              ? item.canonical_revision
              : null,
        };
      });
      const result = await resolveReparse(
        examId,
        reparse.job_id,
        decisions,
        reparse.report_version,
      );
      setResolveReceipt(result);
      await loadReparse();
      await onChanged?.();
    } catch (resolveError) {
      await loadReparse();
      setReparseError(errorText(resolveError));
    } finally {
      setResolving(false);
    }
  };

  const canonicalAllDeleted =
    !!audit &&
    audit.canonical_marker &&
    audit.canonical_question_count === 0 &&
    audit.cards.length > 0;

  return (
    <section
      className={className}
      data-testid="question-import-audit-panel"
      aria-label={tr('legacyAudit.title', '历史导入审计与重解析复核')}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">
            {tr('legacyAudit.title', '历史导入审计与重解析复核')}
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {tr(
              'legacyAudit.subtitle',
              '仅按 card_id/id 建立身份映射；不会猜测语义对应，也不会覆盖已有正式题目。',
            )}
          </p>
        </div>
        <DsButton
          variant="outline"
          size="sm"
          className="text-xs"
          onClick={() => {
            void loadAudit();
            void loadReparse();
          }}
          disabled={loading || migrating || resolving}
          data-testid="legacy-audit-refresh"
        >
          {tr('legacyAudit.refresh', '重新读取')}
        </DsButton>
      </header>

      {loading && (
        <p className="py-4 text-sm text-slate-500" data-testid="legacy-audit-loading">
          {tr('legacyAudit.loading', '正在读取历史导入审计…')}
        </p>
      )}
      {error && (
        <div
          className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
          data-testid="legacy-audit-error"
          role="alert"
        >
          {error}
        </div>
      )}

      {audit && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-1.5 text-xs" data-testid="legacy-audit-summary">
            <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5">
              {tr('legacyAudit.total', '预览卡片')}: {audit.cards.length}
            </span>
            <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5" data-testid="audit-matched-count">
              {tr('legacyAudit.matched', '已映射')}: {audit.matched_count}
            </span>
            <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5" data-testid="audit-unmatched-count">
              {tr('legacyAudit.unmatched', '待迁移')}: {audit.unmatched_count}
            </span>
            <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5" data-testid="audit-ambiguous-count">
              {tr('legacyAudit.ambiguous', '歧义')}: {audit.ambiguous_count}
            </span>
            <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5" data-testid="audit-deleted-count">
              {tr('legacyAudit.deleted', '已删除')}: {audit.deleted_count}
            </span>
            {audit.suppressed_count > 0 && (
              <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5" data-testid="audit-suppressed-count">
                {tr('legacyAudit.suppressed', '受规范化标记保护')}: {audit.suppressed_count}
              </span>
            )}
          </div>

          {canonicalAllDeleted && (
            <div
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
              data-testid="canonical-all-deleted-warning"
              role="status"
            >
              {tr(
                'legacyAudit.allDeleted',
                '该题目集已有规范化标记，但正式题目已全部删除。系统不会从历史预览快照重建题目；如需恢复，请显式恢复原题目。',
              )}
            </div>
          )}

          <div
            className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600"
            data-testid="audit-page-assets"
          >
            <div className="font-medium text-slate-700">
              {tr('legacyAudit.pageAssets', '原始页面资产（仅审计，不修改）')}
            </div>
            <ul className="mt-1 space-y-0.5">
              {audit.pages.map((page) => (
                <li key={`${page.page_index}-${page.blob_hash ?? 'none'}`}>
                  #{page.page_index} · {page.blob_hash ?? '—'} ·{' '}
                  {page.original_image_path || '—'} · {page.card_count}{' '}
                  {tr('legacyAudit.cardsUnit', '张卡片')}
                </li>
              ))}
            </ul>
          </div>

          <div className="overflow-hidden rounded-md border border-slate-200">
            <div className="flex items-center justify-between bg-slate-50 px-3 py-2 text-xs text-slate-600">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={migratable.size === 0}
                  data-testid="legacy-select-all"
                />
                {tr('legacyAudit.selectAll', '全选可迁移卡片')}
              </label>
              <DsButton
                variant="primary"
                size="sm"
                className="text-xs"
                onClick={() => void migrateSelected()}
                disabled={
                  selectedIds.length === 0 ||
                  migrating ||
                  canonicalAllDeleted
                }
                data-testid="legacy-migrate-selected"
              >
                {migrating
                  ? tr('legacyAudit.migrating', '正在迁移…')
                  : tr('legacyAudit.migrate', '迁移所选 {{count}} 张', {
                      count: selectedIds.length,
                    })}
              </DsButton>
            </div>
            <ul className="divide-y divide-slate-100">
              {audit.cards.map((card, index) => {
                const key = `${card.card_id ?? 'missing'}-${card.page_index}-${card.card_index}`;
                const canSelect =
                  card.migratable &&
                  !!card.card_id &&
                  migratable.has(card.card_id);
                return (
                  <li
                    key={key}
                    className="flex items-start gap-2 px-3 py-2 text-sm"
                    data-testid={`legacy-card-${card.card_id ?? `missing-${index}`}`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      aria-label={tr('legacyAudit.selectCard', '选择卡片')}
                      checked={!!card.card_id && selected.has(card.card_id)}
                      onChange={() => card.card_id && toggleCard(card.card_id)}
                      disabled={!canSelect}
                      data-testid={`legacy-card-checkbox-${card.card_id ?? `missing-${index}`}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-slate-800">
                          {card.card_id ?? '—'}
                        </span>
                        {card.question_label && (
                          <span className="text-xs text-slate-500">
                            {card.question_label}
                          </span>
                        )}
                        <span
                          className={`rounded border px-1.5 py-0.5 text-2xs ${statusTone(card.status)}`}
                          data-testid={`legacy-status-${card.card_id ?? index}`}
                        >
                          {card.status}
                        </span>
                        <span className="text-2xs text-slate-400">
                          p{card.page_index} / #{card.card_index}
                        </span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs text-slate-600">
                        {card.preview_text || '—'}
                      </p>
                      {card.formal_question_id && (
                        <p className="mt-0.5 text-2xs text-slate-400">
                          → {card.formal_question_id}
                        </p>
                      )}
                      {card.reason && (
                        <p className="mt-0.5 text-2xs text-rose-600">
                          {card.reason}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          {receipt && (
            <div
              className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
              data-testid="legacy-migration-receipt"
            >
              {tr('legacyAudit.migrated', '已迁移 {{count}} 张卡片', {
                count: receipt.migrated_card_ids.length,
              })}
              {receipt.idempotent
                ? ` · ${tr('legacyAudit.idempotent', '重复选择已幂等返回')}`
                : ''}
            </div>
          )}
        </div>
      )}

      <div className="mt-6 border-t border-slate-200 pt-4" data-testid="reparse-section">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold text-slate-900">
              {tr('legacyAudit.reparseTitle', '重解析差异复核')}
            </h4>
            <p className="text-xs text-slate-500">
              {tr(
                'legacyAudit.reparseSubtitle',
                '按规范化来源槽比较草稿与正式题目；保留 / 导入为新题 / 替换均需明确选择。',
              )}
            </p>
          </div>
          <DsButton
            variant="outline"
            size="sm"
            className="text-xs"
            onClick={() => void resolveDecisions()}
            disabled={!reparse || reparse.resolved || resolving || reparse.items.length === 0}
            data-testid="reparse-resolve"
          >
            {resolving
              ? tr('legacyAudit.resolving', '正在应用…')
              : tr('legacyAudit.resolve', '应用复核选择')}
          </DsButton>
        </div>

        {reparseError && (
          <div
            className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
            data-testid="reparse-error"
            role="alert"
          >
            {reparseError}
          </div>
        )}
        {!reparse && !reparseError && (
          <p className="mt-2 text-sm text-slate-500" data-testid="reparse-empty">
            {tr('legacyAudit.noDraft', '当前题目集没有可复核的导入草稿。')}
          </p>
        )}
        {reparse && (
          <div className="mt-2 space-y-2">
            <div className="text-xs text-slate-500" data-testid="reparse-summary">
              job {reparse.job_id} · v{reparse.job_version} · {tr('legacyAudit.changed', '内容变化')}:{' '}
              {reparse.changed_count} · {tr('legacyAudit.new', '新增')}: {reparse.new_count} ·{' '}
              {tr('legacyAudit.deleted', '已删除')}: {reparse.deleted_count}
            </div>
            <ul className="space-y-2">
              {reparse.items.map((item) => {
                const choice = choices[item.local_id] ?? {
                  action: 'keep_existing' as ReparseAction,
                  expectedRevision: null,
                };
                return (
                  <li
                    key={item.local_id}
                    className="rounded-md border border-slate-200 px-3 py-2"
                    data-testid={`reparse-item-${item.local_id}`}
                  >
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-mono text-xs text-slate-800">
                        {item.local_id}
                      </span>
                      <span
                        className={`rounded border px-1.5 py-0.5 text-2xs ${statusTone(item.status)}`}
                        data-testid={`reparse-status-${item.local_id}`}
                      >
                        {item.status}
                      </span>
                      {item.canonical_question_id && (
                        <span className="text-2xs text-slate-400">
                          → {item.canonical_question_id}
                        </span>
                      )}
                      <select
                        className="ml-auto rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                        aria-label={tr('legacyAudit.action', '复核操作')}
                        value={choice.action}
                        disabled={reparse.resolved || resolving || item.allowed_actions.length === 0}
                        onChange={(event) =>
                          updateChoice(item, event.target.value as ReparseAction)
                        }
                        data-testid={`reparse-action-${item.local_id}`}
                      >
                        {item.allowed_actions.length === 0 && (
                          <option value="keep_existing">
                            {tr('legacyAudit.resolved', '已完成复核')}
                          </option>
                        )}
                        {item.allowed_actions.map((action) => (
                          <option key={action} value={action}>
                            {action}
                          </option>
                        ))}
                      </select>
                    </div>
                    {item.reason && (
                      <p className="mt-1 text-2xs text-rose-600">
                        {item.reason}
                      </p>
                    )}
                    {item.changes.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-2xs text-slate-600">
                        {item.changes.map((change) => (
                          <li key={change.field} data-testid={`reparse-change-${item.local_id}-${change.field}`}>
                            <span className="font-medium">{change.field}</span>:{' '}
                            {JSON.stringify(change.before)} →{' '}
                            {JSON.stringify(change.after)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {resolveReceipt && (
          <div
            className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
            data-testid="reparse-receipt"
          >
            {tr('legacyAudit.reparseApplied', '已应用复核选择')} ·{' '}
            {tr('legacyAudit.imported', '新题')}: {resolveReceipt.imported_question_ids.length} ·{' '}
            {tr('legacyAudit.replaced', '替换')}: {resolveReceipt.replaced_question_ids.length}
          </div>
        )}
      </div>
    </section>
  );
}

export default QuestionImportAuditPanel;
