/**
 * MemoryKernelPanel — 记忆体系 v2 双区透明工作台的上半区（RFC-001 M3）
 *
 * 直接可视化并支持编辑 AI 每轮冻结注入的 `<memory_kernel>`：
 * 1. L1 互动硬规则（HardRules）：增删、作用域、必遵置顶、字符预算进度条；
 * 2. L1/L2 学习者长期画像（LearnerProfile）：活跃薄弱点、学习目标、近期状态、字符预算进度条；
 * 3. 透明检查与安全兜底：原始注入快照预览 + 10 版历史快照一键回滚。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowUUpLeft,
  CaretDown,
  CaretRight,
  ClockCounterClockwise,
  Eye,
  Plus,
  PushPin,
  Sparkle,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  getMemoryAuditLogs,
  inspectMemoryKernel,
  invalidateMemoryKernelAttributionCache,
  mutateMemoryKernel,
  reflectMemoryKernel,
  type MemoryAuditLogItem,
  type MemoryDialecticReflectionReport,
  type MemoryHardRule,
  type MemoryHardRuleOrigin,
  type MemoryInspectionView,
} from '@/api/memoryApi';

interface MemoryKernelPanelProps {
  /** External refresh counter bumped when `memory://changed` arrives. */
  refreshSignal?: number;
}

interface DeletedRuleSnapshot {
  instruction: string;
  scope: string;
  origin: MemoryHardRuleOrigin;
  pinned: boolean;
}

const RULE_UNDO_DURATION_MS = 5000;

const SCOPE_OPTIONS = [
  { value: 'global', labelKey: 'settings:memory.kernel.scopeGlobal' },
  { value: 'subject:math', labelKey: 'settings:memory.kernel.scopeMath' },
  { value: 'subject:english', labelKey: 'settings:memory.kernel.scopeEnglish' },
  { value: 'mode:essay', labelKey: 'settings:memory.kernel.scopeEssay' },
] as const;

function BudgetBar({ label, used, max }: { label: string; used: number; max: number }) {
  const ratio = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  const tone = ratio >= 90 ? 'bg-destructive' : ratio >= 70 ? 'bg-amber-500' : 'bg-primary/75';
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0">{label}</span>
      <div className="h-1.5 w-20 rounded-full bg-muted overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', tone)} style={{ width: `${ratio}%` }} />
      </div>
      <span className="tabular-nums shrink-0">{used}/{max}</span>
    </div>
  );
}

export const MemoryKernelPanel: React.FC<MemoryKernelPanelProps> = ({ refreshSignal = 0 }) => {
  const { t } = useTranslation(['settings', 'common']);
  const [view, setView] = useState<MemoryInspectionView | null>(null);
  const [auditLogs, setAuditLogs] = useState<MemoryAuditLogItem[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [showPreview, setShowPreview] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [reflectionReport, setReflectionReport] = useState<MemoryDialecticReflectionReport | null>(null);
  const [busy, setBusy] = useState(false);

  // Inline HardRule creation state
  const [newRuleText, setNewRuleText] = useState('');
  const [newRuleScope, setNewRuleScope] = useState<string>('global');
  const [newRulePinned, setNewRulePinned] = useState(true);

  // Inline Goal creation state
  const [newGoalText, setNewGoalText] = useState('');

  // 5-second undo state for deleted HardRule
  const [pendingUndoRule, setPendingUndoRule] = useState<DeletedRuleSnapshot | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearUndoTimer = useCallback(() => {
    if (undoTimerRef.current !== null) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearUndoTimer();
    };
  }, [clearUndoTimer]);

  const viewRef = useRef<MemoryInspectionView | null>(null);
  viewRef.current = view;

  const load = useCallback(async () => {
    try {
      const [next, logs] = await Promise.all([
        inspectMemoryKernel(),
        typeof getMemoryAuditLogs === 'function'
          ? getMemoryAuditLogs({ limit: 50 }).catch(() => [] as MemoryAuditLogItem[])
          : Promise.resolve([] as MemoryAuditLogItem[]),
      ]);
      if (next && typeof next === 'object' && next.hardRules && next.learnerProfile) {
        setView(next);
        setUnavailable(false);
      }
      if (Array.isArray(logs)) {
        setAuditLogs(logs);
      }
    } catch {
      // Never wipe an already-loaded panel on a transient background refresh error.
      if (!viewRef.current) {
        setUnavailable(true);
      }
    }
  }, []);

  const refreshAuditLogs = useCallback(async () => {
    if (typeof getMemoryAuditLogs !== 'function') return;
    try {
      const logs = await getMemoryAuditLogs({ limit: 50 });
      if (Array.isArray(logs)) {
        setAuditLogs(logs);
      }
    } catch {
      // Ignore audit log refresh failure to preserve existing view.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const handleAddRule = useCallback(async () => {
    const instruction = newRuleText.trim();
    if (!instruction || busy) return;
    setBusy(true);
    try {
      const updated = await mutateMemoryKernel({
        kind: 'upsert_rule',
        input: {
          instruction,
          scope: newRuleScope,
          origin: 'user_explicit',
          pinned: newRulePinned,
        },
      });
      setView(updated);
      invalidateMemoryKernelAttributionCache(updated);
      setNewRuleText('');
      void refreshAuditLogs();
      showGlobalNotification('success', t('settings:memory.kernel.ruleSaved'));
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : t('settings:memory.kernel.ruleSaveError'));
    } finally {
      setBusy(false);
    }
  }, [newRuleText, newRuleScope, newRulePinned, busy, refreshAuditLogs, t]);

  const handleRemoveRule = useCallback(async (rule: MemoryHardRule) => {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await mutateMemoryKernel({ kind: 'remove_rule', idOrInstruction: rule.id });
      setView(updated);
      invalidateMemoryKernelAttributionCache(updated);
      clearUndoTimer();
      setPendingUndoRule({
        instruction: rule.instruction,
        scope: rule.scope,
        origin: rule.origin,
        pinned: rule.pinned,
      });
      undoTimerRef.current = setTimeout(() => {
        setPendingUndoRule(null);
        undoTimerRef.current = null;
      }, RULE_UNDO_DURATION_MS);
      void refreshAuditLogs();
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : t('settings:memory.kernel.ruleDeleteError'));
    } finally {
      setBusy(false);
    }
  }, [busy, clearUndoTimer, refreshAuditLogs, t]);

  const handleUndoRemoveRule = useCallback(async () => {
    if (!pendingUndoRule || busy) return;
    const snapshot = pendingUndoRule;
    clearUndoTimer();
    setBusy(true);
    try {
      const updated = await mutateMemoryKernel({
        kind: 'upsert_rule',
        input: {
          instruction: snapshot.instruction,
          scope: snapshot.scope,
          origin: snapshot.origin,
          pinned: snapshot.pinned,
        },
      });
      setView(updated);
      invalidateMemoryKernelAttributionCache(updated);
      setPendingUndoRule(null);
      void refreshAuditLogs();
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : t('settings:memory.kernel.ruleRestoreError'));
    } finally {
      setBusy(false);
    }
  }, [pendingUndoRule, busy, clearUndoTimer, refreshAuditLogs, t]);

  const handleRemoveWeakPoint = useCallback(async (subject: string, knowledge_point: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await mutateMemoryKernel({
        kind: 'update_profile',
        update: {
          weak_points_add: [],
          weak_points_remove: [{ subject, knowledge_point }],
          goals_add: [],
          goals_remove: [],
        },
      });
      setView(updated);
      void refreshAuditLogs();
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : t('settings:memory.kernel.weakPointRemoveError'));
    } finally {
      setBusy(false);
    }
  }, [busy, refreshAuditLogs, t]);

  const handleAddGoal = useCallback(async () => {
    const goal = newGoalText.trim();
    if (!goal || busy) return;
    setBusy(true);
    try {
      const updated = await mutateMemoryKernel({
        kind: 'update_profile',
        update: {
          weak_points_add: [],
          weak_points_remove: [],
          goals_add: [{ goal, deadline: null }],
          goals_remove: [],
        },
      });
      setView(updated);
      setNewGoalText('');
      void refreshAuditLogs();
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : t('settings:memory.kernel.goalSaveError'));
    } finally {
      setBusy(false);
    }
  }, [newGoalText, busy, refreshAuditLogs, t]);

  const handleRemoveGoal = useCallback(async (goal: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await mutateMemoryKernel({
        kind: 'update_profile',
        update: {
          weak_points_add: [],
          weak_points_remove: [],
          goals_add: [],
          goals_remove: [goal],
        },
      });
      setView(updated);
      void refreshAuditLogs();
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : t('settings:memory.kernel.goalRemoveError'));
    } finally {
      setBusy(false);
    }
  }, [busy, refreshAuditLogs, t]);

  const handleRollback = useCallback(async (version: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await mutateMemoryKernel({ kind: 'rollback_profile', targetVersion: version });
      setView(updated);
      invalidateMemoryKernelAttributionCache(updated);
      setShowHistory(false);
      void refreshAuditLogs();
      showGlobalNotification('success', t('settings:memory.kernel.rollbackSuccess', { version }));
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : t('settings:memory.kernel.rollbackError'));
    } finally {
      setBusy(false);
    }
  }, [busy, refreshAuditLogs, t]);

  const handleToggleReflection = useCallback(async () => {
    if (reflectionReport) {
      setReflectionReport(null);
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const report = await reflectMemoryKernel();
      setReflectionReport(report);
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : t('settings:memory.kernel.reflectionError'));
    } finally {
      setBusy(false);
    }
  }, [reflectionReport, busy, t]);

  const handlePromoteProposal = useCallback(async (instruction: string, scope: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await mutateMemoryKernel({
        kind: 'upsert_rule',
        input: { instruction, scope, origin: 'dialectic_promoted', pinned: true },
      });
      setView(updated);
      invalidateMemoryKernelAttributionCache(updated);
      setReflectionReport(await reflectMemoryKernel().catch(() => null));
      void refreshAuditLogs();
      showGlobalNotification('success', t('settings:memory.kernel.promoteSuccess'));
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : t('settings:memory.kernel.promoteError'));
    } finally {
      setBusy(false);
    }
  }, [busy, refreshAuditLogs, t]);

  if (unavailable || !view) return null;

  const rules = view.hardRules.rules;
  const profile = view.learnerProfile;
  const historyCount = view.profileHistory.length + auditLogs.length;

  return (
    <section
      data-memory-kernel-panel
      className="rounded-lg border border-primary/20 bg-primary/[0.025] overflow-hidden"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border/35 bg-background/60">
        <button
          type="button"
          onClick={() => setExpanded(prev => !prev)}
          className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-foreground hover:text-primary transition-colors text-left"
        >
          {expanded ? <CaretDown size={13} /> : <CaretRight size={13} />}
          <Sparkle size={14} className="text-primary" weight="fill" />
          <span>{t('settings:memory.kernel.title')}</span>
          <span className="text-xs font-normal text-muted-foreground">
            {t('settings:memory.kernel.subtitle')}
          </span>
        </button>

        {view.privacyMode && (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs bg-amber-500/15 text-amber-600 dark:text-amber-400">
            <WarningCircle size={11} /> {t('settings:memory.kernel.privacyPaused')}
          </span>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <BudgetBar label={t('settings:memory.kernel.budgetRules')} used={view.budgets.rulesChars} max={view.budgets.rulesMaxChars} />
          <BudgetBar label={t('settings:memory.kernel.budgetProfile')} used={view.budgets.profileChars} max={view.budgets.profileMaxChars} />
          <DsButton
            variant="ghost"
            size="sm"
            data-testid="memory-kernel-reflect-btn"
            disabled={busy}
            onClick={() => void handleToggleReflection()}
            className="h-6 px-2 text-xs"
            title={t('settings:memory.kernel.reflectionTitle')}
          >
            <Sparkle size={12} className="mr-1" />
            {reflectionReport ? t('settings:memory.kernel.collapseSuggestions') : t('settings:memory.kernel.reflectionButton')}
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => setShowPreview(prev => !prev)}
            className="h-6 px-2 text-xs"
          >
            <Eye size={12} className="mr-1" />
            {showPreview ? t('settings:memory.kernel.collapsePreview') : t('settings:memory.kernel.previewButton')}
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            disabled={historyCount === 0}
            onClick={() => {
              if (historyCount === 0) return;
              setShowHistory(prev => !prev);
            }}
            className={cn(
              'h-6 px-2 text-xs',
              historyCount === 0 && 'text-muted-foreground disabled:pointer-events-auto'
            )}
            title={
              historyCount === 0
                ? t('settings:memory.kernel.emptyHistoryTooltip')
                : t('settings:memory.kernel.historyTooltip')
            }
          >
            <ClockCounterClockwise size={12} className="mr-1" />
            {t('settings:memory.kernel.historyButton', { count: historyCount })}
          </DsButton>
        </div>
      </div>

      {expanded && (
        <div className="p-3 space-y-3">
          {reflectionReport && (
            <div
              data-testid="memory-kernel-reflection-drawer"
              className="rounded-md border border-primary/25 bg-primary/[0.04] p-2.5 space-y-2 text-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground">{reflectionReport.summary}</span>
                <button
                  type="button"
                  onClick={() => setReflectionReport(null)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {t('common:actions.close')}
                </button>
              </div>
              {reflectionReport.proposals.length > 0 && (
                <div className="space-y-1.5">
                  {reflectionReport.proposals.map(p => (
                    <div
                      key={p.id}
                      className="flex items-start justify-between gap-2 rounded border border-border/40 bg-background/80 px-2 py-1.5"
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-foreground/90">{p.title}</div>
                        <div className="text-xs text-muted-foreground">{p.rationale}</div>
                      </div>
                      {p.kind === 'promote_preference_to_rule' && typeof p.suggestedPayload?.instruction === 'string' && (
                        <DsButton
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => void handlePromoteProposal(
                            String(p.suggestedPayload?.instruction ?? ''),
                            String(p.suggestedPayload?.scope ?? 'global'),
                          )}
                          className="h-6 shrink-0 px-2 text-xs text-primary"
                        >
                          {t('settings:memory.kernel.promoteRule')}
                        </DsButton>
                      )}
                      {p.kind === 'resolve_rule_conflict' && typeof p.suggestedPayload?.ruleBId === 'string' && (
                        <DsButton
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={async () => {
                            if (busy) return;
                            setBusy(true);
                            try {
                              const updated = await mutateMemoryKernel({
                                kind: 'remove_rule',
                                idOrInstruction: String(p.suggestedPayload?.ruleBId ?? ''),
                              });
                              setView(updated);
                              invalidateMemoryKernelAttributionCache(updated);
                              setReflectionReport(await reflectMemoryKernel().catch(() => null));
                              void refreshAuditLogs();
                              showGlobalNotification('success', t('settings:memory.kernel.conflictResolved'));
                            } catch (error) {
                              showGlobalNotification('error', error instanceof Error ? error.message : t('settings:memory.kernel.conflictResolveError'));
                            } finally {
                              setBusy(false);
                            }
                          }}
                          className="h-6 shrink-0 px-2 text-xs text-destructive hover:bg-destructive/10"
                        >
                          {t('settings:memory.kernel.removeLatterRule')}
                        </DsButton>
                      )}
                      {p.kind === 'retire_stale_weak_point'
                        && typeof p.suggestedPayload?.subject === 'string'
                        && typeof p.suggestedPayload?.knowledge_point === 'string' && (
                        <DsButton
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => void handleRemoveWeakPoint(
                            String(p.suggestedPayload?.subject ?? ''),
                            String(p.suggestedPayload?.knowledge_point ?? ''),
                          )}
                          className="h-6 shrink-0 px-2 text-xs text-muted-foreground hover:text-foreground"
                        >
                          {t('settings:memory.kernel.markMastered')}
                        </DsButton>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 1. L1 互动硬规则 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium text-foreground/85">
                {t('settings:memory.kernel.hardRulesTitle')}
              </div>
              <span className="text-xs text-muted-foreground">
                {t('settings:memory.kernel.rulesCount', { count: rules.length })}
              </span>
            </div>

            {rules.length === 0 ? (
              <div className="text-xs text-muted-foreground/75 px-2.5 py-2 rounded border border-dashed border-border/50">
                {t('settings:memory.kernel.noRulesHint')}
              </div>
            ) : (
              <div className="space-y-1.5">
                {rules.map(rule => (
                  <div
                    key={rule.id}
                    data-hard-rule-row={rule.id}
                    className="flex items-start gap-2 rounded-md border border-border/40 bg-background/80 px-2.5 py-1.5 text-xs"
                  >
                    <div className="flex-1 min-w-0 leading-relaxed">
                      {rule.pinned && (
                        <span className="inline-flex items-center gap-0.5 mr-1.5 rounded bg-primary/10 px-1 py-0.5 text-2xs font-medium text-primary">
                          <PushPin size={10} weight="fill" /> {t('settings:memory.kernel.pinned')}
                        </span>
                      )}
                      {rule.scope !== 'global' && (
                        <span className="mr-1.5 rounded bg-muted px-1 py-0.5 text-2xs text-muted-foreground">
                          {rule.scope}
                        </span>
                      )}
                      <span className="text-foreground">{rule.instruction}</span>
                    </div>
                      <DsButton
                        variant="ghost"
                        size="sm"
                        type="button"
                        disabled={busy}
                        onClick={() => void handleRemoveRule(rule)}
                        className="h-6 w-6 p-0 shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label={t('settings:memory.kernel.deleteRuleAria', {
                          preview: rule.instruction.slice(0, 24),
                        })}
                        title={t('settings:memory.kernel.deleteRuleTitle')}
                      >
                        <Trash size={12} />
                      </DsButton>
                  </div>
                ))}
              </div>
            )}

            {/* 5-second inline undo banner after rule deletion */}
            {pendingUndoRule && (
              <div
                role="status"
                className="flex items-center justify-between gap-2 rounded-md border border-amber-500/35 bg-amber-500/10 px-2.5 py-1.5 text-xs text-foreground"
              >
                <span className="truncate">
                  {t('settings:memory.kernel.deletedRuleToast', {
                    instruction: pendingUndoRule.instruction,
                  })}
                </span>
                <DsButton
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void handleUndoRemoveRule()}
                  data-testid="memory-kernel-undo-rule"
                  className="h-6 px-2 text-xs shrink-0 text-primary hover:text-primary"
                >
                  <ArrowUUpLeft size={12} className="mr-1" />
                  {t('settings:memory.kernel.undo')}
                </DsButton>
              </div>
            )}

            {/* Add rule inline form */}
            <div className="flex flex-wrap items-center gap-1.5">
              <Input
                value={newRuleText}
                onChange={e => setNewRuleText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleAddRule(); } }}
                placeholder={t('settings:memory.kernel.addRulePlaceholder')}
                className="h-8 text-xs flex-1 min-w-[200px]"
                disabled={busy}
              />
              <select
                value={newRuleScope}
                onChange={e => setNewRuleScope(e.target.value)}
                className="h-8 rounded-md border border-border/60 bg-background px-2 text-xs text-foreground"
                disabled={busy}
              >
                {SCOPE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
                ))}
              </select>
              <label
                className="inline-flex items-center gap-1 text-xs text-muted-foreground px-1 select-none cursor-pointer"
                title={t('settings:memory.kernel.addRulePinTitle')}
              >
                <input
                  type="checkbox"
                  checked={newRulePinned}
                  onChange={e => setNewRulePinned(e.target.checked)}
                  disabled={busy}
                />
                {t('settings:memory.kernel.pinned')}
              </label>
              <DsButton
                variant="primary"
                size="sm"
                disabled={busy || !newRuleText.trim()}
                onClick={() => void handleAddRule()}
                className="h-8 px-2.5 text-xs"
              >
                <Plus size={12} className="mr-1" /> {t('settings:memory.kernel.addRuleButton')}
              </DsButton>
            </div>
          </div>

          {/* 2. 学习者活跃薄弱点 & 目标 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 pt-2 border-t border-border/30">
            {/* Weak points */}
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-foreground/85">
                {t('settings:memory.kernel.weakPointsTitle', { count: profile.weak_points.length })}
              </div>
              {profile.weak_points.length === 0 ? (
                <div className="text-xs text-muted-foreground/70">
                  {t('settings:memory.kernel.noWeakPoints')}
                </div>
              ) : (
                <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                  {profile.weak_points.slice(0, 12).map(wp => (
                    <div
                      key={`${wp.subject}:${wp.knowledge_point}`}
                      className="flex items-start gap-1.5 rounded border border-border/35 bg-background/70 px-2 py-1 text-xs"
                    >
                      <div className="flex-1 min-w-0">
                        <span className="mr-1 rounded bg-amber-500/12 px-1 py-0.5 text-2xs font-medium text-amber-700 dark:text-amber-300">
                          {wp.subject}
                        </span>
                        <span className="font-medium text-foreground">{wp.knowledge_point}</span>
                        <span className="ml-1 text-muted-foreground">×{wp.evidence_count}</span>
                        {wp.error_pattern && (
                          <div className="text-2xs text-muted-foreground truncate mt-0.5">{wp.error_pattern}</div>
                        )}
                      </div>
                      <DsButton
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void handleRemoveWeakPoint(wp.subject, wp.knowledge_point)}
                        className="h-5 w-5 p-0 shrink-0 text-muted-foreground hover:text-destructive"
                        title={t('settings:memory.kernel.removeWeakPointTitle')}
                      >
                        <Trash size={11} />
                      </DsButton>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Goals */}
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-foreground/85">
                {t('settings:memory.kernel.goalsTitle', { count: profile.goals.length })}
              </div>
              <div className="space-y-1">
                {profile.goals.map(g => (
                  <div
                    key={g.goal}
                    className="flex items-center gap-1.5 rounded border border-border/35 bg-background/70 px-2 py-1 text-xs"
                  >
                    <span className="flex-1 truncate text-foreground">{g.goal}</span>
                    {g.deadline && <span className="text-2xs text-muted-foreground shrink-0">{g.deadline}</span>}
                    <DsButton
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void handleRemoveGoal(g.goal)}
                      className="h-5 w-5 p-0 shrink-0 text-muted-foreground hover:text-destructive"
                      title={t('settings:memory.kernel.removeGoalTitle')}
                    >
                      <Trash size={11} />
                    </DsButton>
                  </div>
                ))}
                <div className="flex items-center gap-1.5">
                  <Input
                    value={newGoalText}
                    onChange={e => setNewGoalText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleAddGoal(); } }}
                    placeholder={t('settings:memory.kernel.addGoalPlaceholder')}
                    className="h-7 text-xs flex-1"
                    disabled={busy}
                  />
                  <DsButton
                    variant="ghost"
                    size="sm"
                    disabled={busy || !newGoalText.trim()}
                    onClick={() => void handleAddGoal()}
                    className="h-7 px-2 text-xs"
                  >
                    <Plus size={11} />
                  </DsButton>
                </div>
              </div>
            </div>
          </div>

          {/* 3. 注入内容预览 */}
          {showPreview && (
            <div className="rounded border border-border/45 bg-muted/40 p-2.5 space-y-1">
              <div className="text-xs font-medium text-muted-foreground">
                {t('settings:memory.kernel.previewHeading')}
              </div>
              <pre className="text-xs text-foreground/90 whitespace-pre-wrap break-words font-mono max-h-48 overflow-y-auto">
                {view.renderedKernelPreview || t('settings:memory.kernel.previewEmpty')}
              </pre>
            </div>
          )}

          {/* 4. 审计变更历史 & 10 版画像快照回滚抽屉 */}
          {showHistory && historyCount > 0 && (
            <div className="rounded border border-border/45 bg-muted/30 p-2.5 space-y-2.5" data-testid="memory-kernel-history-drawer">
              {auditLogs.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-muted-foreground">
                    {t('settings:memory.kernel.auditHeading', { count: auditLogs.length })}
                  </div>
                  <div className="space-y-1 max-h-44 overflow-y-auto">
                    {auditLogs.map((entry) => {
                      const opUpper = (entry.event ?? entry.operation ?? '').toUpperCase();
                      const opBadge = opUpper.includes('ADD') || opUpper.includes('CREATE')
                        ? t('settings:memory.kernel.auditOpAdd')
                        : opUpper.includes('DELETE') || opUpper.includes('REMOVE')
                          ? t('settings:memory.kernel.auditOpDelete')
                          : t('settings:memory.kernel.auditOpUpdate');
                      return (
                        <div
                          key={entry.id}
                          className="flex items-start justify-between gap-2 rounded bg-background/80 px-2 py-1 text-xs"
                        >
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex items-center gap-1.5">
                              <span className="rounded bg-primary/10 px-1 py-0.5 text-2xs font-medium text-primary shrink-0">
                                {opBadge}
                              </span>
                              <span className="font-medium text-foreground truncate">
                                {entry.title || entry.operation}
                              </span>
                            </div>
                            {(entry.contentPreview || entry.reason) && (
                              <div className="text-2xs text-muted-foreground truncate">
                                {entry.contentPreview || entry.reason}
                              </div>
                            )}
                          </div>
                          {entry.timestamp && (
                            <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                              {entry.timestamp.slice(0, 16).replace('T', ' ')}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {view.profileHistory.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-muted-foreground">
                    {t('settings:memory.kernel.historyHeading')}
                  </div>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {view.profileHistory.map(snap => (
                      <div
                        key={snap.version}
                        className="flex items-center justify-between gap-2 rounded bg-background/80 px-2 py-1 text-xs"
                      >
                        <span className="text-foreground">
                          {t('settings:memory.kernel.snapshotSummary', {
                            version: snap.version,
                            weakCount: snap.weak_points.length,
                            goalCount: snap.goals.length,
                          })}
                          {snap.updated_at ? ` · ${snap.updated_at.slice(0, 16).replace('T', ' ')}` : ''}
                        </span>
                        <DsButton
                          variant="ghost"
                          size="sm"
                          disabled={busy || snap.version === profile.version}
                          onClick={() => void handleRollback(snap.version)}
                          className="h-6 px-2 text-xs"
                        >
                          {snap.version === profile.version
                            ? t('settings:memory.kernel.currentVersion')
                            : t('settings:memory.kernel.rollback')}
                        </DsButton>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
};
