import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, SlidersHorizontal, Trash, X } from '@phosphor-icons/react';
import {
  getMemoryKernelSummarySnapshot,
  inspectMemoryKernel,
  invalidateMemoryKernelAttributionCache,
  isMemoryKernelSummaryFresh,
  mutateMemoryKernel,
  subscribeMemoryKernelSummary,
  type MemoryInspectionView,
} from '@/api/memoryApi';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { APP_EVENTS, dispatchAppEvent } from '@/events/app';
import { setPendingSettingsRoute } from '@/utils/pendingSettingsTab';
import { cn } from '@/lib/utils';
import {
  buildMemorySnapshotKey,
  clearPersistedMessageMemorySnapshots,
  extractMessageMemorySnapshotFromMeta,
  getPersistedMessageMemorySnapshot,
  hasNonEmptyFrozenSnapshot,
  parseFrozenMemorySnapshot,
  savePersistedMessageMemorySnapshot,
  snapshotFromInspectionView,
  snapshotFromSessionFrozen,
  type MessageMemoryAttributionSnapshot,
} from './memoryAttributionSnapshot';

export { invalidateMemoryKernelAttributionCache, clearPersistedMessageMemorySnapshots };
export type { MessageMemoryAttributionSnapshot };

let inflight: Promise<MemoryInspectionView | null> | null = null;
let memoryChangedSubscribed = false;

async function ensureMemoryKernelSummary(force = false): Promise<MemoryInspectionView | null> {
  if (!force && isMemoryKernelSummaryFresh()) return getMemoryKernelSummarySnapshot();
  if (inflight) return inflight;
  inflight = inspectMemoryKernel()
    .then((view) => {
      if (view && typeof view === 'object' && view.hardRules && view.learnerProfile) {
        invalidateMemoryKernelAttributionCache(view);
        return view;
      }
      return null;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function ensureMemoryChangedListener(): void {
  if (memoryChangedSubscribed || typeof window === 'undefined') return;
  memoryChangedSubscribed = true;
  void import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen('memory://changed', () => {
        invalidateMemoryKernelAttributionCache();
        void ensureMemoryKernelSummary(true);
      }),
    )
    .catch(() => {
      // Non-Tauri test environments may not provide the event bridge.
      memoryChangedSubscribed = false;
    });
}

export interface MemoryKernelAttributionPillProps {
  className?: string;
  /** Message ID for per-message immutable snapshot capture & persistence. */
  messageId?: string;
  /** Session ID paired with messageId for snapshot keying. */
  sessionId?: string | null;
  /** Active variant ID so regenerated versions keep independent attribution snapshots. */
  variantId?: string | null;
  /** Message-level metadata (reads `memoryAttributionSnapshot` / `memoryKernelSnapshot` when present). */
  messageMeta?: Record<string, unknown> | null;
  /** Explicit per-message snapshot override (highest priority, immutable). */
  messageSnapshot?: MessageMemoryAttributionSnapshot | null;
  sessionMetadata?: Record<string, unknown> | null;
  /** Whether this assistant reply is Turn 1 of the session (baseline snapshot) vs Turn 2+ (delta-synced). */
  isFirstAssistantTurn?: boolean;
  /** Mounts invisibly while Turn 1 is streaming so kernel summary is prefetched before settle. */
  prefetchOnly?: boolean;
}

interface AttributionRuleEntry {
  id: string;
  instruction: string;
  scope: string;
  pinned: boolean;
  inLive: boolean;
  replacedInLive: boolean;
}

interface AttributionWeakPointEntry {
  subject: string;
  knowledge_point: string;
  inLive: boolean;
}

export const MemoryKernelAttributionPill: React.FC<MemoryKernelAttributionPillProps> = ({
  className,
  messageId,
  sessionId,
  variantId,
  messageMeta,
  messageSnapshot,
  sessionMetadata,
  isFirstAssistantTurn,
  prefetchOnly = false,
}) => {
  const { t } = useTranslation('common');
  const view = useSyncExternalStore(
    subscribeMemoryKernelSummary,
    getMemoryKernelSummarySnapshot,
    getMemoryKernelSummarySnapshot,
  );
  const [open, setOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [lastRemovedRule, setLastRemovedRule] = useState<{ instruction: string; scope: string; pinned: boolean } | null>(null);
  const prevPrefetchOnlyRef = useRef(prefetchOnly);

  const snapshotKey = useMemo(
    () => buildMemorySnapshotKey({ sessionId, messageId, variantId }),
    [sessionId, messageId, variantId],
  );

  const explicitSnapshot = useMemo(
    () => messageSnapshot ?? extractMessageMemorySnapshotFromMeta(messageMeta),
    [messageSnapshot, messageMeta],
  );

  const frozenSessionSnapshot = useMemo(
    () => parseFrozenMemorySnapshot(sessionMetadata),
    [sessionMetadata],
  );

  const hasNonEmptySessionBaseline = hasNonEmptyFrozenSnapshot(frozenSessionSnapshot);
  const useTurnOneSessionBaseline = hasNonEmptySessionBaseline && isFirstAssistantTurn !== false;

  const [persistedSnapshot, setPersistedSnapshot] = useState<MessageMemoryAttributionSnapshot | null>(
    () => (snapshotKey ? getPersistedMessageMemorySnapshot(snapshotKey) : null),
  );

  useEffect(() => {
    setPersistedSnapshot(snapshotKey ? getPersistedMessageMemorySnapshot(snapshotKey) : null);
  }, [snapshotKey]);

  // Freeze Turn-1 session baseline into per-message persisted store as soon as Turn 1 settles.
  useEffect(() => {
    if (prefetchOnly || explicitSnapshot || persistedSnapshot) return;
    if (!snapshotKey || !useTurnOneSessionBaseline || !frozenSessionSnapshot) return;
    const saved = savePersistedMessageMemorySnapshot(
      snapshotKey,
      snapshotFromSessionFrozen(frozenSessionSnapshot),
    );
    setPersistedSnapshot(saved);
  }, [
    prefetchOnly,
    explicitSnapshot,
    persistedSnapshot,
    snapshotKey,
    useTurnOneSessionBaseline,
    frozenSessionSnapshot,
  ]);

  useEffect(() => {
    let cancelled = false;
    ensureMemoryChangedListener();
    const shouldForceRefresh = prevPrefetchOnlyRef.current && !prefetchOnly;
    prevPrefetchOnlyRef.current = prefetchOnly;

    void ensureMemoryKernelSummary(shouldForceRefresh).then((freshView) => {
      if (cancelled || prefetchOnly || !freshView || freshView.privacyMode) return;
      if (explicitSnapshot || !snapshotKey) return;
      if (getPersistedMessageMemorySnapshot(snapshotKey)) return;
      if (useTurnOneSessionBaseline && frozenSessionSnapshot) {
        const saved = savePersistedMessageMemorySnapshot(
          snapshotKey,
          snapshotFromSessionFrozen(frozenSessionSnapshot),
        );
        setPersistedSnapshot(saved);
        return;
      }
      const saved = savePersistedMessageMemorySnapshot(
        snapshotKey,
        snapshotFromInspectionView(freshView),
      );
      setPersistedSnapshot(saved);
    });

    if (!prefetchOnly) {
      return () => {
        cancelled = true;
      };
    }
    return () => {
      cancelled = true;
      // Mark TTL stale when streaming prefetcher unmounts (keeps cached snapshot for frame-0 paint, forces post-turn refresh).
      invalidateMemoryKernelAttributionCache();
    };
  }, [prefetchOnly, explicitSnapshot, snapshotKey, useTurnOneSessionBaseline, frozenSessionSnapshot]);

  if (prefetchOnly) return null;
  if (view?.privacyMode) return null;

  const effectiveSnapshot: MessageMemoryAttributionSnapshot | null = (() => {
    if (explicitSnapshot) return explicitSnapshot;
    if (persistedSnapshot) return persistedSnapshot;
    if (useTurnOneSessionBaseline && frozenSessionSnapshot) {
      return snapshotFromSessionFrozen(frozenSessionSnapshot);
    }
    // Wait for post-stream refresh before painting/capturing when a keyed message has a stale cache.
    if (snapshotKey && !isMemoryKernelSummaryFresh()) return null;
    if (!view) return null;
    return snapshotFromInspectionView(view);
  })();

  if (!effectiveSnapshot) return null;

  const liveRules = view?.hardRules?.rules ?? [];
  const liveWeakPoints = view?.learnerProfile?.weak_points ?? [];

  const liveRulesById = new Map(liveRules.map((rule) => [rule.id, rule]));
  const rules: AttributionRuleEntry[] = effectiveSnapshot.rules.map((rule) => {
    const liveRule = liveRulesById.get(rule.id);
    const exactMatch = Boolean(
      liveRule && liveRule.instruction.trim() === rule.instruction.trim(),
    );
    return {
      id: rule.id,
      // Always preserve the historical snapshot instruction; never mutate with live edits.
      instruction: rule.instruction,
      scope: rule.scope,
      pinned: exactMatch && liveRule ? liveRule.pinned : rule.pinned,
      inLive: exactMatch,
      replacedInLive: Boolean(liveRule && !exactMatch),
    };
  });

  const liveWeakPointKeys = new Set(
    liveWeakPoints.map((wp) => `${wp.subject}:${wp.knowledge_point}`),
  );
  const weakPoints: AttributionWeakPointEntry[] = effectiveSnapshot.weakPoints.map((wp) => ({
    subject: wp.subject,
    knowledge_point: wp.knowledge_point,
    inLive: liveWeakPointKeys.has(`${wp.subject}:${wp.knowledge_point}`),
  }));

  const snapshotGoals = effectiveSnapshot.goals;

  const snapshotDriftedFromLive = Boolean(
    view && (
      (effectiveSnapshot.rulesVersion > 0 && effectiveSnapshot.rulesVersion !== view.hardRules.version) ||
      liveRules.length !== effectiveSnapshot.rules.length ||
      liveRules.some((liveRule, idx) => {
        const snapRule = effectiveSnapshot.rules[idx];
        return (
          !snapRule ||
          snapRule.id !== liveRule.id ||
          snapRule.instruction.trim() !== liveRule.instruction.trim()
        );
      })
    ),
  );

  const sessionBaselineDriftedFromLive = Boolean(
    view &&
      frozenSessionSnapshot && (
        frozenSessionSnapshot.rulesVersion !== view.hardRules.version ||
        liveRules.length !== frozenSessionSnapshot.includedRuleIds.length ||
        liveRules.some((rule, idx) => frozenSessionSnapshot.includedRuleIds[idx] !== rule.id)
      ),
  );

  const hasGlobalDrift = snapshotDriftedFromLive || sessionBaselineDriftedFromLive;
  const effectiveKernelPreview = effectiveSnapshot.renderedKernel.trim();

  const structuredCount = rules.length + weakPoints.length + snapshotGoals.length;
  const hasKernelContextOnly = structuredCount === 0 && effectiveKernelPreview.length > 0;
  if (structuredCount === 0 && !hasKernelContextOnly && !lastRemovedRule) return null;

  const summaryParts: string[] = [];
  if (rules.length > 0) {
    summaryParts.push(t('memoryAttribution.rulesCount', { count: rules.length }));
  }
  if (weakPoints.length > 0) {
    summaryParts.push(t('memoryAttribution.weakPointsCount', { count: weakPoints.length }));
  }
  if (summaryParts.length === 0 && snapshotGoals.length > 0) {
    summaryParts.push(t('memoryAttribution.goalsCount', { count: snapshotGoals.length }));
  }
  if (summaryParts.length === 0) {
    summaryParts.push(t('memoryAttribution.activeSummary'));
  }

  const handleRemoveRule = async (id: string) => {
    const targetRule = rules.find((r) => r.id === id);
    setBusyKey(`rule:${id}`);
    try {
      const updated = await mutateMemoryKernel({ kind: 'remove_rule', idOrInstruction: id });
      invalidateMemoryKernelAttributionCache(updated);
      if (targetRule) {
        setLastRemovedRule({ instruction: targetRule.instruction, scope: targetRule.scope, pinned: targetRule.pinned });
      }
      showGlobalNotification('success', t('memoryAttribution.ruleRemovedSuccess'));
    } catch {
      showGlobalNotification('error', t('memoryAttribution.ruleRemovedError'));
    } finally {
      setBusyKey(null);
    }
  };

  const handleUndoRemovedRule = async () => {
    if (!lastRemovedRule) return;
    setBusyKey('rule:undo');
    try {
      const updated = await mutateMemoryKernel({
        kind: 'upsert_rule',
        input: {
          instruction: lastRemovedRule.instruction,
          scope: lastRemovedRule.scope,
          origin: 'user_explicit',
          pinned: lastRemovedRule.pinned,
        },
      });
      invalidateMemoryKernelAttributionCache(updated);
      setLastRemovedRule(null);
      showGlobalNotification('success', t('memoryAttribution.ruleRestoredSuccess'));
    } catch {
      showGlobalNotification('error', t('memoryAttribution.ruleRestoredError'));
    } finally {
      setBusyKey(null);
    }
  };

  const handleRemoveWeakPoint = async (subject: string, knowledgePoint: string) => {
    setBusyKey(`wp:${subject}:${knowledgePoint}`);
    try {
      const updated = await mutateMemoryKernel({
        kind: 'update_profile',
        update: {
          weak_points_add: [],
          weak_points_remove: [{ subject, knowledge_point: knowledgePoint }],
          goals_add: [],
          goals_remove: [],
        },
      });
      invalidateMemoryKernelAttributionCache(updated);
      showGlobalNotification('success', t('memoryAttribution.weakPointRemovedSuccess', { knowledgePoint }));
    } catch {
      showGlobalNotification('error', t('memoryAttribution.weakPointRemovedError'));
    } finally {
      setBusyKey(null);
    }
  };

  const handleOpenMemorySettings = () => {
    setOpen(false);
    setPendingSettingsRoute({ tab: 'memory' });
    dispatchAppEvent(APP_EVENTS.SETTINGS_NAVIGATE_TAB, { tab: 'memory' });
  };

  return (
    <div className={cn('relative inline-flex items-center', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="memory-kernel-attribution-pill"
            aria-haspopup="dialog"
            className={cn(
              'pointer-events-auto inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground',
              open && 'border-primary/50 bg-primary/10 text-primary',
            )}
            title={t('memoryAttribution.pillTitle')}
          >
            <Brain className="h-3 w-3 shrink-0" />
            <span>
              {t('memoryAttribution.label')} · {summaryParts.join(' / ')}
            </span>
          </button>
        </PopoverTrigger>

        <PopoverContent
          data-testid="memory-kernel-attribution-popover"
          side="top"
          align="start"
          sideOffset={6}
          className="w-80 max-w-[90vw] p-3 text-xs text-popover-foreground"
        >
          <div className="mb-2 flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-0.5">
              <div className="flex items-center gap-1.5 font-medium">
                <Brain className="h-3.5 w-3.5 shrink-0 text-primary" />
                <span>{t('memoryAttribution.panelTitle')}</span>
              </div>
              <p
                data-testid="memory-kernel-attribution-subtitle"
                className="text-[11px] leading-snug text-muted-foreground"
              >
                {t('memoryAttribution.panelSubtitle')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={t('actions.close')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {hasGlobalDrift && (
            <div
              data-testid="memory-kernel-frozen-drift-hint"
              className="mb-2 rounded-md border border-border/50 bg-muted/40 px-2 py-1.5 text-[11px] leading-snug text-muted-foreground"
            >
              {t('memoryAttribution.deltaDriftHint', { liveCount: liveRules.length })}
            </div>
          )}

          {rules.length > 0 && (
            <div className="mb-2 space-y-1">
              <div className="text-[11px] font-medium text-muted-foreground">
                {t('memoryAttribution.hardRulesHeading')}
              </div>
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className="flex items-start justify-between gap-2 rounded-md border border-border/40 bg-muted/30 px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <span className="leading-snug text-foreground/90">{rule.instruction}</span>
                    {!rule.inLive && (
                      <div className="text-[10px] text-muted-foreground">
                        {rule.replacedInLive
                          ? t('memoryAttribution.updatedInGlobal', {
                              defaultValue: '已更新（新规则自后续轮次生效）',
                            })
                          : t('memoryAttribution.removedFromGlobal')}
                      </div>
                    )}
                  </div>
                  {rule.inLive ? (
                    <button
                      type="button"
                      disabled={busyKey === `rule:${rule.id}`}
                      onClick={() => void handleRemoveRule(rule.id)}
                      className="shrink-0 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label={t('memoryAttribution.forgetRuleAria', {
                        preview: rule.instruction.slice(0, 24),
                      })}
                      title={t('memoryAttribution.forgetRule')}
                    >
                      <Trash className="h-3 w-3" />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          {lastRemovedRule && (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-amber-500/35 bg-amber-500/10 px-2 py-1.5 text-[11px]">
              <span className="truncate">
                {t('memoryAttribution.removedRuleBanner', {
                  instruction: lastRemovedRule.instruction,
                })}
              </span>
              <button
                type="button"
                disabled={busyKey === 'rule:undo'}
                onClick={() => void handleUndoRemovedRule()}
                className="shrink-0 font-medium text-primary hover:underline"
              >
                {t('memoryAttribution.undo')}
              </button>
            </div>
          )}

          {weakPoints.length > 0 && (
            <div className="mb-2 space-y-1">
              <div className="text-[11px] font-medium text-muted-foreground">
                {t('memoryAttribution.weakPointsHeading')}
              </div>
              {weakPoints.slice(0, 5).map((wp) => {
                const key = `${wp.subject}:${wp.knowledge_point}`;
                return (
                  <div
                    key={key}
                    className="flex items-center justify-between gap-2 rounded-md border border-border/40 bg-muted/30 px-2 py-1"
                  >
                    <span className="truncate">
                      {wp.subject ? <span className="text-muted-foreground">[{wp.subject}] </span> : null}
                      {wp.knowledge_point}
                    </span>
                    {wp.inLive ? (
                      <button
                        type="button"
                        disabled={busyKey === `wp:${key}`}
                        onClick={() => void handleRemoveWeakPoint(wp.subject, wp.knowledge_point)}
                        className="shrink-0 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        title={t('memoryAttribution.markMasteredTitle')}
                      >
                        <Trash className="h-3 w-3" />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          {rules.length === 0 && weakPoints.length === 0 && snapshotGoals.length > 0 && (
            <div className="mb-2 space-y-1">
              <div className="text-[11px] font-medium text-muted-foreground">
                {t('memoryAttribution.goalsHeading')}
              </div>
              {snapshotGoals.slice(0, 3).map((goalItem) => (
                <div
                  key={goalItem.goal}
                  className="rounded-md border border-border/40 bg-muted/30 px-2 py-1 text-foreground/90"
                >
                  {goalItem.goal}
                </div>
              ))}
            </div>
          )}

          {hasKernelContextOnly && (
            <div className="mb-2 space-y-1">
              <div className="text-[11px] font-medium text-muted-foreground">
                {t('memoryAttribution.kernelContextHeading')}
              </div>
              <div className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-md border border-border/40 bg-muted/30 px-2 py-1.5 text-[11px] leading-relaxed text-foreground/85">
                {effectiveKernelPreview}
              </div>
            </div>
          )}

          <div className="mt-2 border-t border-border/40 pt-2">
            <button
              type="button"
              data-testid="memory-kernel-open-settings"
              onClick={handleOpenMemorySettings}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/10"
            >
              <SlidersHorizontal className="h-3 w-3 shrink-0" />
              <span>{t('memoryAttribution.openSettings')}</span>
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};
