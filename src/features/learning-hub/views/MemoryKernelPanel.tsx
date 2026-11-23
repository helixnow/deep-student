/**
 * MemoryKernelPanel — 记忆体系 v2 双区透明工作台的上半区（RFC-001 M3）
 *
 * 直接可视化并支持编辑 AI 每轮冻结注入的 `<memory_kernel>`：
 * 1. L1 互动硬规则（HardRules）：增删、作用域、必遵置顶、字符预算进度条；
 * 2. L1/L2 学习者长期画像（LearnerProfile）：活跃薄弱点、学习目标、近期状态、字符预算进度条；
 * 3. 透明检查与安全兜底：原始注入快照预览 + 10 版历史快照一键回滚。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { invalidateMemoryKernelAttributionCache } from '@/features/chat/components/message/MemoryKernelAttributionPill';
import {
  inspectMemoryKernel,
  mutateMemoryKernel,
  reflectMemoryKernel,
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
const EMPTY_HISTORY_TOOLTIP = '每次画像变化会自动保留最近 10 个版本，支持一键回滚';

const SCOPE_OPTIONS = [
  { value: 'global', label: '全局' },
  { value: 'subject:math', label: '数学' },
  { value: 'subject:english', label: '英语' },
  { value: 'mode:essay', label: '作文批改' },
] as const;

function BudgetBar({ label, used, max }: { label: string; used: number; max: number }) {
  const ratio = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  const tone = ratio >= 90 ? 'bg-destructive' : ratio >= 70 ? 'bg-amber-500' : 'bg-primary/75';
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <span className="shrink-0">{label}</span>
      <div className="h-1.5 w-20 rounded-full bg-muted overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', tone)} style={{ width: `${ratio}%` }} />
      </div>
      <span className="tabular-nums shrink-0">{used}/{max}</span>
    </div>
  );
}

export const MemoryKernelPanel: React.FC<MemoryKernelPanelProps> = ({ refreshSignal = 0 }) => {
  const [view, setView] = useState<MemoryInspectionView | null>(null);
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

  const load = useCallback(async () => {
    try {
      const next = await inspectMemoryKernel();
      setView(next);
      setUnavailable(false);
    } catch {
      setUnavailable(true);
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
      showGlobalNotification('success', '已保存常驻互动规则（下个新会话首轮自动生效）');
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : '保存规则失败');
    } finally {
      setBusy(false);
    }
  }, [newRuleText, newRuleScope, newRulePinned, busy]);

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
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : '删除规则失败');
    } finally {
      setBusy(false);
    }
  }, [busy, clearUndoTimer]);

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
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : '恢复规则失败');
    } finally {
      setBusy(false);
    }
  }, [pendingUndoRule, busy, clearUndoTimer]);

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
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : '移除薄弱点失败');
    } finally {
      setBusy(false);
    }
  }, [busy]);

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
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : '保存目标失败');
    } finally {
      setBusy(false);
    }
  }, [newGoalText, busy]);

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
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : '移除目标失败');
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const handleRollback = useCallback(async (version: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await mutateMemoryKernel({ kind: 'rollback_profile', targetVersion: version });
      setView(updated);
      invalidateMemoryKernelAttributionCache(updated);
      setShowHistory(false);
      showGlobalNotification('success', `已回滚学习者画像至 v${version}`);
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : '回滚失败');
    } finally {
      setBusy(false);
    }
  }, [busy]);

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
      showGlobalNotification('error', error instanceof Error ? error.message : '生成整理建议失败');
    } finally {
      setBusy(false);
    }
  }, [reflectionReport, busy]);

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
      showGlobalNotification('success', '已升格为常驻硬规则');
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : '升格规则失败');
    } finally {
      setBusy(false);
    }
  }, [busy]);

  if (unavailable || !view) return null;

  const rules = view.hardRules.rules;
  const profile = view.learnerProfile;

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
          <span>长期记忆内核</span>
          <span className="text-[11px] font-normal text-muted-foreground">
            新会话首轮自动生效，会话内保持稳定
          </span>
        </button>

        {view.privacyMode && (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] bg-amber-500/15 text-amber-600 dark:text-amber-400">
            <WarningCircle size={11} /> 隐私模式暂停注入
          </span>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <BudgetBar label="规则" used={view.budgets.rulesChars} max={view.budgets.rulesMaxChars} />
          <BudgetBar label="画像" used={view.budgets.profileChars} max={view.budgets.profileMaxChars} />
          <DsButton
            variant="ghost"
            size="sm"
            data-testid="memory-kernel-reflect-btn"
            disabled={busy}
            onClick={() => void handleToggleReflection()}
            className="h-6 px-2 text-[11px]"
            title="基于薄弱点复发与规则预算生成一键整理建议"
          >
            <Sparkle size={12} className="mr-1" />
            {reflectionReport ? '收起建议' : '梳理建议'}
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => setShowPreview(prev => !prev)}
            className="h-6 px-2 text-[11px]"
          >
            <Eye size={12} className="mr-1" />
            {showPreview ? '收起注入内容' : '预览注入内容'}
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            disabled={view.profileHistory.length === 0}
            onClick={() => {
              if (view.profileHistory.length === 0) return;
              setShowHistory(prev => !prev);
            }}
            className={cn(
              'h-6 px-2 text-[11px]',
              view.profileHistory.length === 0 && 'text-muted-foreground disabled:pointer-events-auto'
            )}
            title={
              view.profileHistory.length === 0
                ? EMPTY_HISTORY_TOOLTIP
                : '查看最近 10 个画像版本并一键回滚'
            }
          >
            <ClockCounterClockwise size={12} className="mr-1" />
            历史 ({view.profileHistory.length})
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
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  关闭
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
                        <div className="text-[11px] text-muted-foreground">{p.rationale}</div>
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
                          className="h-6 shrink-0 px-2 text-[11px] text-primary"
                        >
                          升格硬规则
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
                          className="h-6 shrink-0 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          标记已掌握
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
                互动硬规则（首轮 100% 强制遵循）
              </div>
              <span className="text-[11px] text-muted-foreground">{rules.length} 条</span>
            </div>

            {rules.length === 0 ? (
              <div className="text-[11px] text-muted-foreground/75 px-2.5 py-2 rounded border border-dashed border-border/50">
                暂无常驻规则。可添加如「每次回答结尾附 1 道变式自测题，先不给答案」。
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
                        <span className="inline-flex items-center gap-0.5 mr-1.5 rounded bg-primary/10 px-1 py-0.5 text-[10px] font-medium text-primary">
                          <PushPin size={10} weight="fill" /> 必遵
                        </span>
                      )}
                      {rule.scope !== 'global' && (
                        <span className="mr-1.5 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                          {rule.scope}
                        </span>
                      )}
                      <span className="text-foreground">{rule.instruction}</span>
                    </div>
                    <DsButton
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void handleRemoveRule(rule)}
                      className="h-6 w-6 p-0 shrink-0 text-muted-foreground hover:text-destructive"
                      title="删除规则"
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
                  已删除规则「{pendingUndoRule.instruction}」
                </span>
                <DsButton
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void handleUndoRemoveRule()}
                  data-testid="memory-kernel-undo-rule"
                  className="h-6 px-2 text-[11px] shrink-0 text-primary hover:text-primary"
                >
                  <ArrowUUpLeft size={12} className="mr-1" />
                  撤销
                </DsButton>
              </div>
            )}

            {/* Add rule inline form */}
            <div className="flex flex-wrap items-center gap-1.5">
              <Input
                value={newRuleText}
                onChange={e => setNewRuleText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleAddRule(); } }}
                placeholder="新增常驻互动规则，例如：每次讲解结束后附 1 道自测题..."
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
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <label className="inline-flex items-center gap-1 text-[11px] text-muted-foreground px-1 select-none cursor-pointer">
                <input
                  type="checkbox"
                  checked={newRulePinned}
                  onChange={e => setNewRulePinned(e.target.checked)}
                  disabled={busy}
                />
                必遵
              </label>
              <DsButton
                variant="primary"
                size="sm"
                disabled={busy || !newRuleText.trim()}
                onClick={() => void handleAddRule()}
                className="h-8 px-2.5 text-xs"
              >
                <Plus size={12} className="mr-1" /> 添加规则
              </DsButton>
            </div>
          </div>

          {/* 2. 学习者活跃薄弱点 & 目标 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 pt-2 border-t border-border/30">
            {/* Weak points */}
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-foreground/85">
                活跃薄弱点（{profile.weak_points.length}）
              </div>
              {profile.weak_points.length === 0 ? (
                <div className="text-[11px] text-muted-foreground/70">
                  暂无活跃薄弱点（做题/闪卡/作文批改会自动沉淀）。
                </div>
              ) : (
                <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                  {profile.weak_points.slice(0, 12).map(wp => (
                    <div
                      key={`${wp.subject}:${wp.knowledge_point}`}
                      className="flex items-start gap-1.5 rounded border border-border/35 bg-background/70 px-2 py-1 text-[11px]"
                    >
                      <div className="flex-1 min-w-0">
                        <span className="mr-1 rounded bg-amber-500/12 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                          {wp.subject}
                        </span>
                        <span className="font-medium text-foreground">{wp.knowledge_point}</span>
                        <span className="ml-1 text-muted-foreground">×{wp.evidence_count}</span>
                        {wp.error_pattern && (
                          <div className="text-[10px] text-muted-foreground truncate mt-0.5">{wp.error_pattern}</div>
                        )}
                      </div>
                      <DsButton
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void handleRemoveWeakPoint(wp.subject, wp.knowledge_point)}
                        className="h-5 w-5 p-0 shrink-0 text-muted-foreground hover:text-destructive"
                        title="移出薄弱点"
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
                学习目标（{profile.goals.length}）
              </div>
              <div className="space-y-1">
                {profile.goals.map(g => (
                  <div
                    key={g.goal}
                    className="flex items-center gap-1.5 rounded border border-border/35 bg-background/70 px-2 py-1 text-[11px]"
                  >
                    <span className="flex-1 truncate text-foreground">{g.goal}</span>
                    {g.deadline && <span className="text-[10px] text-muted-foreground shrink-0">{g.deadline}</span>}
                    <DsButton
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void handleRemoveGoal(g.goal)}
                      className="h-5 w-5 p-0 shrink-0 text-muted-foreground hover:text-destructive"
                      title="移除目标"
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
                    placeholder="添加学习目标，如：12 月前拿下雅思写作 7.0"
                    className="h-7 text-[11px] flex-1"
                    disabled={busy}
                  />
                  <DsButton
                    variant="ghost"
                    size="sm"
                    disabled={busy || !newGoalText.trim()}
                    onClick={() => void handleAddGoal()}
                    className="h-7 px-2 text-[11px]"
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
              <div className="text-[11px] font-medium text-muted-foreground">
                AI 在新会话首轮自动读取的长期记忆注入内容（会话内保持稳定）：
              </div>
              <pre className="text-[11px] text-foreground/90 whitespace-pre-wrap break-words font-mono max-h-48 overflow-y-auto">
                {view.renderedKernelPreview || '（当前内核为空）'}
              </pre>
            </div>
          )}

          {/* 4. 10 版历史回滚抽屉 */}
          {showHistory && view.profileHistory.length > 0 && (
            <div className="rounded border border-border/45 bg-muted/30 p-2.5 space-y-1.5">
              <div className="text-[11px] font-medium text-muted-foreground">
                学习者画像历史快照（最近 10 版，点击一键回滚）
              </div>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {view.profileHistory.map(snap => (
                  <div
                    key={snap.version}
                    className="flex items-center justify-between gap-2 rounded bg-background/80 px-2 py-1 text-[11px]"
                  >
                    <span className="text-foreground">
                      v{snap.version} · 薄弱点 {snap.weak_points.length} · 目标 {snap.goals.length}
                      {snap.updated_at ? ` · ${snap.updated_at.slice(0, 16).replace('T', ' ')}` : ''}
                    </span>
                    <DsButton
                      variant="ghost"
                      size="sm"
                      disabled={busy || snap.version === profile.version}
                      onClick={() => void handleRollback(snap.version)}
                      className="h-6 px-2 text-[11px]"
                    >
                      {snap.version === profile.version ? '当前版本' : '回滚'}
                    </DsButton>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
};
