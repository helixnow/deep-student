import React, { useEffect, useState, useSyncExternalStore } from 'react';
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

export { invalidateMemoryKernelAttributionCache };

let inflight: Promise<MemoryInspectionView | null> | null = null;

async function ensureMemoryKernelSummary(): Promise<MemoryInspectionView | null> {
  if (isMemoryKernelSummaryFresh()) return getMemoryKernelSummarySnapshot();
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

export interface MemoryKernelAttributionPillProps {
  className?: string;
  sessionMetadata?: Record<string, unknown> | null;
}

interface FrozenRuleRef {
  id: string;
  instruction: string;
  scope?: string;
}

interface ParsedFrozenMemorySnapshot {
  rulesVersion: number;
  profileVersion: number;
  includedRuleIds: string[];
  includedRules: FrozenRuleRef[];
  includedWeakPointKeys: string[];
}

function parseFrozenMemorySnapshot(
  sessionMetadata: Record<string, unknown> | null | undefined,
): ParsedFrozenMemorySnapshot | null {
  if (!sessionMetadata || typeof sessionMetadata !== 'object') return null;
  const raw = sessionMetadata.memoryKernelSnapshot;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const includedRuleIds = Array.isArray(obj.includedRuleIds)
    ? obj.includedRuleIds.filter((item): item is string => typeof item === 'string')
    : [];
  const includedWeakPointKeys = Array.isArray(obj.includedWeakPointKeys)
    ? obj.includedWeakPointKeys.filter((item): item is string => typeof item === 'string')
    : [];
  const includedRules: FrozenRuleRef[] = [];
  if (Array.isArray(obj.includedRules)) {
    for (const item of obj.includedRules) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const ruleObj = item as Record<string, unknown>;
      if (typeof ruleObj.id === 'string' && typeof ruleObj.instruction === 'string') {
        includedRules.push({
          id: ruleObj.id,
          instruction: ruleObj.instruction,
          ...(typeof ruleObj.scope === 'string' ? { scope: ruleObj.scope } : {}),
        });
      }
    }
  }
  return {
    rulesVersion: typeof obj.rulesVersion === 'number' ? obj.rulesVersion : 0,
    profileVersion: typeof obj.profileVersion === 'number' ? obj.profileVersion : 0,
    includedRuleIds,
    includedRules,
    includedWeakPointKeys,
  };
}

interface AttributionRuleEntry {
  id: string;
  instruction: string;
  scope: string;
  pinned: boolean;
  inLive: boolean;
}

interface AttributionWeakPointEntry {
  subject: string;
  knowledge_point: string;
  inLive: boolean;
}

export const MemoryKernelAttributionPill: React.FC<MemoryKernelAttributionPillProps> = ({
  className,
  sessionMetadata,
}) => {
  const { t } = useTranslation(['settings', 'chatV2', 'common']);
  const view = useSyncExternalStore(
    subscribeMemoryKernelSummary,
    getMemoryKernelSummarySnapshot,
    getMemoryKernelSummarySnapshot,
  );
  const [open, setOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [lastRemovedRule, setLastRemovedRule] = useState<{ instruction: string; scope: string; pinned: boolean } | null>(null);

  useEffect(() => {
    void ensureMemoryKernelSummary();
  }, []);

  if (!view || view.privacyMode) return null;
  const liveRules = view.hardRules?.rules ?? [];
  const liveWeakPoints = view.learnerProfile?.weak_points ?? [];
  const frozenSnapshot = parseFrozenMemorySnapshot(sessionMetadata);

  const rules: AttributionRuleEntry[] = (() => {
    if (!frozenSnapshot) {
      return liveRules.map((rule) => ({
        id: rule.id,
        instruction: rule.instruction,
        scope: rule.scope,
        pinned: rule.pinned,
        inLive: true,
      }));
    }
    const liveById = new Map(liveRules.map((rule) => [rule.id, rule]));
    const frozenById = new Map(frozenSnapshot.includedRules.map((rule) => [rule.id, rule]));
    return frozenSnapshot.includedRuleIds.map((ruleId) => {
      const liveRule = liveById.get(ruleId);
      if (liveRule) {
        return {
          id: liveRule.id,
          instruction: liveRule.instruction,
          scope: liveRule.scope,
          pinned: liveRule.pinned,
          inLive: true,
        };
      }
      const frozenRule = frozenById.get(ruleId);
      return {
        id: ruleId,
        instruction: frozenRule?.instruction ?? ruleId,
        scope: frozenRule?.scope ?? 'global',
        pinned: false,
        inLive: false,
      };
    });
  })();

  const weakPoints: AttributionWeakPointEntry[] = (() => {
    if (!frozenSnapshot) {
      return liveWeakPoints.map((wp) => ({
        subject: wp.subject,
        knowledge_point: wp.knowledge_point,
        inLive: true,
      }));
    }
    const liveByKey = new Map(
      liveWeakPoints.map((wp) => [`${wp.subject}:${wp.knowledge_point}`, wp]),
    );
    return frozenSnapshot.includedWeakPointKeys.map((key) => {
      const liveWp = liveByKey.get(key);
      if (liveWp) {
        return {
          subject: liveWp.subject,
          knowledge_point: liveWp.knowledge_point,
          inLive: true,
        };
      }
      const sepIndex = key.indexOf(':');
      return {
        subject: sepIndex > 0 ? key.slice(0, sepIndex) : '',
        knowledge_point: sepIndex > 0 ? key.slice(sepIndex + 1) : key,
        inLive: false,
      };
    });
  })();

  const hasGlobalDrift = Boolean(
    frozenSnapshot && (
      frozenSnapshot.rulesVersion !== view.hardRules.version ||
      liveRules.length !== frozenSnapshot.includedRuleIds.length ||
      liveRules.some((rule, idx) => frozenSnapshot.includedRuleIds[idx] !== rule.id)
    ),
  );

  const totalCount = rules.length + weakPoints.length;
  if (totalCount === 0 && !lastRemovedRule) return null;

  const handleRemoveRule = async (id: string) => {
    const targetRule = rules.find((r) => r.id === id);
    setBusyKey(`rule:${id}`);
    try {
      const updated = await mutateMemoryKernel({ kind: 'remove_rule', idOrInstruction: id });
      invalidateMemoryKernelAttributionCache(updated);
      if (targetRule) {
        setLastRemovedRule({ instruction: targetRule.instruction, scope: targetRule.scope, pinned: targetRule.pinned });
      }
      showGlobalNotification('success', t('settings:memory.attribution.ruleRemovedSuccess'));
    } catch {
      showGlobalNotification('error', t('settings:memory.attribution.ruleRemovedError'));
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
      showGlobalNotification('success', t('settings:memory.attribution.ruleRestoredSuccess'));
    } catch {
      showGlobalNotification('error', t('settings:memory.attribution.ruleRestoredError'));
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
      showGlobalNotification('success', t('settings:memory.attribution.weakPointRemovedSuccess', { knowledgePoint }));
    } catch {
      showGlobalNotification('error', t('settings:memory.attribution.weakPointRemovedError'));
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
            title={t('settings:memory.attribution.pillTitle')}
          >
            <Brain className="h-3 w-3 shrink-0" />
            <span>
              {t('settings:memory.attribution.label')} ·{' '}
              {rules.length > 0 ? t('settings:memory.attribution.rulesCount', { count: rules.length }) : ''}
              {rules.length > 0 && weakPoints.length > 0 ? ' / ' : ''}
              {weakPoints.length > 0 ? t('settings:memory.attribution.weakPointsCount', { count: weakPoints.length }) : ''}
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
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 font-medium">
              <Brain className="h-3.5 w-3.5 text-primary" />
              <span>{t('settings:memory.attribution.panelTitle')}</span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={t('common:actions.close')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {hasGlobalDrift && (
            <div
              data-testid="memory-kernel-frozen-drift-hint"
              className="mb-2 rounded-md border border-border/50 bg-muted/40 px-2 py-1.5 text-[11px] leading-snug text-muted-foreground"
            >
              {t('chatV2:memoryAttribution.frozenMismatchHint', { liveCount: liveRules.length })}
            </div>
          )}

          {rules.length > 0 && (
            <div className="mb-2 space-y-1">
              <div className="text-[11px] font-medium text-muted-foreground">
                {t('settings:memory.attribution.hardRulesHeading')}
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
                        {t('chatV2:memoryAttribution.removedFromGlobal')}
                      </div>
                    )}
                  </div>
                  {rule.inLive ? (
                    <button
                      type="button"
                      disabled={busyKey === `rule:${rule.id}`}
                      onClick={() => void handleRemoveRule(rule.id)}
                      className="shrink-0 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label={t('settings:memory.attribution.forgetRuleAria', {
                        preview: rule.instruction.slice(0, 24),
                      })}
                      title={t('settings:memory.attribution.forgetRule')}
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
                {t('settings:memory.attribution.removedRuleBanner', {
                  instruction: lastRemovedRule.instruction,
                })}
              </span>
              <button
                type="button"
                disabled={busyKey === 'rule:undo'}
                onClick={() => void handleUndoRemovedRule()}
                className="shrink-0 font-medium text-primary hover:underline"
              >
                {t('settings:memory.attribution.undo')}
              </button>
            </div>
          )}

          {weakPoints.length > 0 && (
            <div className="mb-2 space-y-1">
              <div className="text-[11px] font-medium text-muted-foreground">
                {t('settings:memory.attribution.weakPointsHeading')}
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
                        title={t('settings:memory.attribution.markMasteredTitle')}
                      >
                        <Trash className="h-3 w-3" />
                      </button>
                    ) : null}
                  </div>
                );
              })}
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
              <span>{t('settings:memory.attribution.openSettings')}</span>
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};
