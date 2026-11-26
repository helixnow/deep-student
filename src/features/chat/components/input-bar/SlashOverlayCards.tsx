/**
 * Chat V2 - Slash Command Interactive Overlay Cards
 *
 * Non-modal cards anchored right above the composer for zero-context-pollution
 * and instant diagnostic/study workflows:
 * - `/btw <question>`: Side-channel quick Q&A (`call_llm_for_boundary`), convertible to Anki card or main chat
 * - `/learn`: Distills an L1 Hard Rule from the latest turn with 1-click save to Memory v2
 * - `/memory`: Live `<memory_kernel>` snapshot & hygiene reflection (`inspectMemoryKernel` / `reflectMemoryKernel`)
 * - `/context`: Instant zero-token session & context window overview
 * - `/doctor`: Environment & workbench health check
 * - `/help`: Categorized slash command & shortcut quick reference
 */

import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  Brain,
  Cards,
  ChatDots,
  Check,
  CheckCircle,
  Copy,
  FirstAidKit,
  Info,
  Lightning,
  Question,
  Sparkle,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import {
  getMemoryConfig,
  inspectMemoryKernel,
  invalidateMemoryKernelAttributionCache,
  mutateMemoryKernel,
  reflectMemoryKernel,
  type MemoryDialecticReflectionReport,
  type MemoryInspectionView,
} from '@/api/memoryApi';
import type { SessionUsageSummary } from '@/api/llmUsageApi';
import type { GoalRecord } from '../../core/types/goal';
import type { ContextWindowUsage } from './contextWindowUsage';
import type { SlashOverlayCardState } from '../../commands/slashCommandExecutor';
import { BUILTIN_SLASH_COMMANDS } from '../../commands/slashCommandProtocol';

const LazyMarkdownRenderer = React.lazy(() =>
  import('../renderers/MarkdownRenderer').then((m) => ({ default: m.MarkdownRenderer })),
);

export interface SlashOverlayCardProps {
  card: SlashOverlayCardState | null;
  onClose: () => void;
  onInsertToComposer: (text: string) => void;
  onCreateFlashcardFromBtw: (question: string, answer: string) => void;
  // Live session snapshot for `/context` and `/doctor`
  runtimeModelLabel?: string;
  effectiveChatModelId?: string;
  thinkingStateLabel?: string;
  permissionLabel?: string;
  authorityMode?: 'ask' | 'plan' | 'craft';
  webSearchEnabled?: boolean;
  ragEnabled?: boolean;
  knowledgeBaseProactive?: boolean;
  activeSkillIds?: string[];
  selectedMcpServerCount?: number;
  contextWindowUsage?: ContextWindowUsage | null;
  sessionUsage?: SessionUsageSummary | null;
  goal?: GoalRecord | null;
}

const RULE_SCOPES = [
  { value: 'global', labelKey: 'settings:memory.kernel.scopeGlobal' },
  { value: 'subject:math', labelKey: 'settings:memory.kernel.scopeMath' },
  { value: 'subject:english', labelKey: 'settings:memory.kernel.scopeEnglish' },
  { value: 'mode:essay', labelKey: 'settings:memory.kernel.scopeEssay' },
] as const;

export const SlashOverlayCard: React.FC<SlashOverlayCardProps> = ({
  card,
  onClose,
  onInsertToComposer,
  onCreateFlashcardFromBtw,
  runtimeModelLabel,
  effectiveChatModelId,
  thinkingStateLabel,
  permissionLabel,
  authorityMode,
  webSearchEnabled,
  ragEnabled,
  knowledgeBaseProactive,
  activeSkillIds,
  selectedMcpServerCount = 0,
  contextWindowUsage,
  sessionUsage,
  goal,
}) => {
  const { t } = useTranslation(['chatV2', 'settings', 'common']);
  const reqIdRef = useRef(0);

  // `/btw` state
  const [btwLoading, setBtwLoading] = useState(false);
  const [btwAnswer, setBtwAnswer] = useState('');
  const [btwError, setBtwError] = useState<string | null>(null);
  const [btwCopied, setBtwCopied] = useState(false);

  // `/learn` state
  const [learnLoading, setLearnLoading] = useState(false);
  const [learnRuleDraft, setLearnRuleDraft] = useState('');
  const [learnScope, setLearnScope] = useState<string>('global');
  const [learnSaving, setLearnSaving] = useState(false);

  // `/memory` state
  const [memLoading, setMemLoading] = useState(false);
  const [memView, setMemView] = useState<MemoryInspectionView | null>(null);
  const [memPrivacy, setMemPrivacy] = useState(false);
  const [memReflection, setMemReflection] = useState<MemoryDialecticReflectionReport | null>(null);

  // `/doctor` state
  const [docLoading, setDocLoading] = useState(false);
  const [docChecks, setDocChecks] = useState<
    Array<{ id: string; ok: boolean; warn?: boolean; label: string; detail: string }>
  >([]);

  // Effect: run async side-channel or diagnostic task when card changes
  useEffect(() => {
    if (!card) return;
    const reqId = ++reqIdRef.current;

    if (card.kind === 'btw') {
      setBtwLoading(true);
      setBtwAnswer('');
      setBtwError(null);
      setBtwCopied(false);
      const prompt = t('chatV2:slashCommands.btw.llmPrompt', { question: card.question });
      invoke<{ assistant_message: string; input_tokens: number; output_tokens: number }>(
        'call_llm_for_boundary',
        { prompt },
      )
        .then((res) => {
          if (reqIdRef.current !== reqId) return;
          setBtwAnswer(res.assistant_message || '');
          setBtwLoading(false);
        })
        .catch((err) => {
          if (reqIdRef.current !== reqId) return;
          setBtwError(err instanceof Error ? err.message : String(err));
          setBtwLoading(false);
        });
      return;
    }

    if (card.kind === 'learn') {
      setLearnScope('global');
      if (card.hint && !card.recentContext) {
        setLearnRuleDraft(card.hint);
        setLearnLoading(false);
        return;
      }
      setLearnLoading(true);
      setLearnRuleDraft(card.hint ?? '');
      const prompt = t('chatV2:slashCommands.learn.llmPrompt', {
        context: card.recentContext,
        hint: card.hint ?? '',
      });
      invoke<{ assistant_message: string; input_tokens: number; output_tokens: number }>(
        'call_llm_for_boundary',
        { prompt },
      )
        .then((res) => {
          if (reqIdRef.current !== reqId) return;
          const cleaned = (res.assistant_message || '').trim().replace(/^[-*•\d.)\s]+/, '');
          if (cleaned) setLearnRuleDraft(cleaned.slice(0, 300));
          setLearnLoading(false);
        })
        .catch(() => {
          if (reqIdRef.current !== reqId) return;
          setLearnLoading(false);
        });
      return;
    }

    if (card.kind === 'memory') {
      setMemLoading(true);
      setMemReflection(null);
      Promise.all([
        inspectMemoryKernel().catch(() => null),
        getMemoryConfig().catch(() => null),
        card.mode === 'clean' ? reflectMemoryKernel().catch(() => null) : Promise.resolve(null),
      ])
        .then(([view, cfg, reflection]) => {
          if (reqIdRef.current !== reqId) return;
          setMemView(view);
          setMemPrivacy(Boolean(cfg?.privacyMode));
          setMemReflection(reflection);
          setMemLoading(false);
        });
      return;
    }

    if (card.kind === 'doctor') {
      setDocLoading(true);
      Promise.all([
        getMemoryConfig().catch(() => null),
        inspectMemoryKernel().catch(() => null),
        invoke<{
          safeMode?: boolean;
          profileCorrupted?: boolean;
          plugins?: Array<{ state?: string }>;
        }>('plugin:manager|list', {}).catch(() => null),
      ]).then(([memCfg, kernelView, pluginInv]) => {
        if (reqIdRef.current !== reqId) return;
        const hasModel = Boolean(effectiveChatModelId || runtimeModelLabel);
        const degradedCount = (pluginInv?.plugins ?? []).filter(
          (p) => p.state === 'degraded',
        ).length;
        const checks = [
          {
            id: 'model',
            ok: hasModel,
            label: t('chatV2:slashCommands.doctor.checkModel'),
            detail: hasModel
              ? (runtimeModelLabel || effectiveChatModelId || '')
              : t('chatV2:slashCommands.doctor.modelMissing'),
          },
          {
            id: 'search',
            ok: true,
            warn: webSearchEnabled === false,
            label: t('chatV2:slashCommands.doctor.checkRetrieval'),
            detail: t('chatV2:slashCommands.doctor.retrievalDetail', {
              web: webSearchEnabled ? t('chatV2:slashCommands.common.onBadge') : t('chatV2:slashCommands.common.offBadge'),
              rag: ragEnabled ? t('chatV2:slashCommands.common.onBadge') : t('chatV2:slashCommands.common.offBadge'),
            }),
          },
          {
            id: 'memory',
            ok: Boolean(kernelView || memCfg),
            warn: Boolean(memCfg?.privacyMode),
            label: t('chatV2:slashCommands.doctor.checkMemory'),
            detail: memCfg?.privacyMode
              ? t('chatV2:slashCommands.memory.privacyActiveBadge')
              : kernelView
                ? t('chatV2:slashCommands.doctor.memoryDetail', {
                    rules: kernelView.hardRules.rules.length,
                    weaknesses: kernelView.learnerProfile.weak_points.length,
                  })
                : t('chatV2:slashCommands.doctor.available'),
          },
          {
            id: 'plugins',
            ok: !pluginInv?.profileCorrupted && degradedCount === 0,
            warn: Boolean(pluginInv?.safeMode),
            label: t('chatV2:slashCommands.doctor.checkPlugins'),
            detail: pluginInv?.safeMode
              ? t('chatV2:slashCommands.doctor.safeModeActive')
              : degradedCount > 0
                ? t('chatV2:slashCommands.doctor.degradedPlugins', { count: degradedCount })
                : t('chatV2:slashCommands.doctor.pluginsHealthy'),
          },
        ];
        setDocChecks(checks);
        setDocLoading(false);
      });
    }
  }, [card, effectiveChatModelId, ragEnabled, runtimeModelLabel, t, webSearchEnabled]);

  const handleSaveLearnedRule = useCallback(async () => {
    const instruction = learnRuleDraft.trim();
    if (!instruction || learnSaving) return;
    setLearnSaving(true);
    try {
      const updated = await mutateMemoryKernel({
        kind: 'upsert_rule',
        input: {
          instruction,
          scope: learnScope,
          origin: 'user_explicit',
          pinned: true,
        },
      });
      invalidateMemoryKernelAttributionCache(updated);
      showGlobalNotification('success', t('chatV2:slashCommands.remember.savedToast'));
      onClose();
    } catch (err) {
      showGlobalNotification('error', err instanceof Error ? err.message : String(err));
    } finally {
      setLearnSaving(false);
    }
  }, [learnRuleDraft, learnScope, learnSaving, onClose, t]);

  if (!card) return null;

  return (
    <div
      data-testid={`slash-overlay-card-${card.kind}`}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
      className="mb-2 rounded-2xl border border-border/60 bg-popover/90 p-3 shadow-md backdrop-blur-xl outline-none"
    >
      {/* 1. /btw Side-channel Quick Q&A */}
      {card.kind === 'btw' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Sparkle size={15} weight="fill" className="shrink-0 text-amber-500" />
            <span className="text-xs font-semibold text-foreground">
              {t('chatV2:slashCommands.btw.cardTitle')}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {card.question}
            </span>
            <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-2xs text-muted-foreground">
              {t('chatV2:slashCommands.btw.isolatedBadge')}
            </span>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="!h-6 !w-6 shrink-0"
              aria-label={t('common:close')}
              onClick={onClose}
            >
              <X size={14} />
            </DsButton>
          </div>
          <div className="max-h-56 overflow-y-auto rounded-xl bg-muted/35 px-3 py-2 text-sm">
            {btwLoading ? (
              <div className="py-2 text-xs text-muted-foreground">
                {t('chatV2:slashCommands.btw.thinking')}
              </div>
            ) : btwError ? (
              <div className="text-xs text-destructive">{btwError}</div>
            ) : (
              <Suspense fallback={<div className="whitespace-pre-wrap">{btwAnswer}</div>}>
                <LazyMarkdownRenderer content={btwAnswer} />
              </Suspense>
            )}
          </div>
          {!btwLoading && btwAnswer && (
            <div className="flex flex-wrap items-center justify-end gap-1.5 pt-0.5">
              <DsButton
                variant="ghost"
                size="sm"
                onClick={() => {
                  void copyTextToClipboard(btwAnswer);
                  setBtwCopied(true);
                }}
              >
                {btwCopied ? <Check size={13} /> : <Copy size={13} />}
                <span>{t('common:copy')}</span>
              </DsButton>
              <DsButton
                variant="ghost"
                size="sm"
                onClick={() => {
                  onInsertToComposer(`> ${card.question}\n\n${btwAnswer}\n\n`);
                  onClose();
                }}
              >
                <ChatDots size={13} />
                <span>{t('chatV2:slashCommands.btw.insertToChat')}</span>
              </DsButton>
              <DsButton
                variant="secondary"
                size="sm"
                onClick={() => {
                  onCreateFlashcardFromBtw(card.question, btwAnswer);
                  onClose();
                }}
              >
                <Cards size={13} />
                <span>{t('chatV2:slashCommands.btw.toFlashcard')}</span>
              </DsButton>
            </div>
          )}
        </div>
      )}

      {/* 2. /learn Rule Distillation Confirmation */}
      {card.kind === 'learn' && (
        <div className="space-y-2.5">
          <div className="flex items-center gap-2">
            <Brain size={15} weight="bold" className="shrink-0 text-primary" />
            <span className="text-xs font-semibold text-foreground">
              {t('chatV2:slashCommands.learn.cardTitle')}
            </span>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="ml-auto !h-6 !w-6"
              aria-label={t('common:close')}
              onClick={onClose}
            >
              <X size={14} />
            </DsButton>
          </div>
          {learnLoading ? (
            <div className="py-2 text-xs text-muted-foreground">
              {t('chatV2:slashCommands.learn.distilling')}
            </div>
          ) : (
            <>
              <Input
                value={learnRuleDraft}
                onChange={(e) => setLearnRuleDraft(e.target.value)}
                placeholder={t('chatV2:slashCommands.learn.inputPlaceholder')}
                aria-label={t('chatV2:slashCommands.learn.inputPlaceholder')}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1">
                  {RULE_SCOPES.map((sc) => (
                    <DsButton
                      key={sc.value}
                      variant={learnScope === sc.value ? 'secondary' : 'ghost'}
                      size="sm"
                      className="!h-6 !px-2 text-2xs"
                      onClick={() => setLearnScope(sc.value)}
                    >
                      {t(sc.labelKey)}
                    </DsButton>
                  ))}
                </div>
                <DsButton
                  variant="primary"
                  size="sm"
                  disabled={!learnRuleDraft.trim() || learnSaving}
                  onClick={() => void handleSaveLearnedRule()}
                >
                  {t('chatV2:slashCommands.learn.saveButton')}
                </DsButton>
              </div>
            </>
          )}
        </div>
      )}

      {/* 3. /memory Live Kernel & Hygiene */}
      {card.kind === 'memory' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Brain size={15} weight="bold" className="shrink-0 text-primary" />
            <span className="text-xs font-semibold text-foreground">
              {t('chatV2:slashCommands.memory.cardTitle')}
            </span>
            {memPrivacy && (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-2xs text-amber-600 dark:text-amber-400">
                {t('chatV2:slashCommands.memory.privacyActiveBadge')}
              </span>
            )}
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="ml-auto !h-6 !w-6"
              aria-label={t('common:close')}
              onClick={onClose}
            >
              <X size={14} />
            </DsButton>
          </div>
          {memLoading ? (
            <div className="py-2 text-xs text-muted-foreground">
              {t('chatV2:slashCommands.common.loading')}
            </div>
          ) : memView ? (
            <div className="space-y-1.5 text-xs">
              <div className="flex flex-wrap gap-3 text-muted-foreground">
                <span>
                  {t('chatV2:slashCommands.memory.rulesCount', {
                    count: memView.hardRules.rules.length,
                    used: memView.budgets.rulesChars,
                    max: memView.budgets.rulesMaxChars,
                  })}
                </span>
                <span>
                  {t('chatV2:slashCommands.memory.weaknessCount', {
                    count: memView.learnerProfile.weak_points.length,
                  })}
                </span>
              </div>
              {memView.hardRules.rules.length > 0 && (
                <ul className="max-h-32 space-y-1 overflow-y-auto rounded-lg bg-muted/40 p-2">
                  {memView.hardRules.rules.slice(0, 6).map((r) => (
                    <li key={r.id} className="truncate text-foreground/90">
                      • [{r.scope}] {r.instruction}
                    </li>
                  ))}
                </ul>
              )}
              {memReflection && (
                <div className="rounded-lg border border-border/50 bg-muted/25 p-2 text-muted-foreground">
                  {t('chatV2:slashCommands.memory.hygieneSummary', {
                    count: memReflection.proposals.length,
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              {t('chatV2:slashCommands.memory.unavailable')}
            </div>
          )}
        </div>
      )}

      {/* 4. /context Instant Session & Context Overview */}
      {card.kind === 'context' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Info size={15} weight="bold" className="shrink-0 text-primary" />
            <span className="text-xs font-semibold text-foreground">
              {t('chatV2:slashCommands.context.cardTitle')}
            </span>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="ml-auto !h-6 !w-6"
              aria-label={t('common:close')}
              onClick={onClose}
            >
              <X size={14} />
            </DsButton>
          </div>
          <div className="grid grid-cols-2 gap-1.5 text-xs sm:grid-cols-3">
            <div className="rounded-lg bg-muted/40 px-2.5 py-1.5">
              <div className="text-2xs text-muted-foreground">{t('chatV2:slashCommands.model.label')}</div>
              <div className="truncate font-medium">{runtimeModelLabel || effectiveChatModelId || '—'}</div>
            </div>
            <div className="rounded-lg bg-muted/40 px-2.5 py-1.5">
              <div className="text-2xs text-muted-foreground">{t('chatV2:slashCommands.think.label')}</div>
              <div className="truncate font-medium">{thinkingStateLabel || '—'}</div>
            </div>
            <div className="rounded-lg bg-muted/40 px-2.5 py-1.5">
              <div className="text-2xs text-muted-foreground">{t('chatV2:slashCommands.mode.label')}</div>
              <div className="truncate font-medium">
                {permissionLabel || '—'}
                {authorityMode === 'plan' ? ` · ${t('chatV2:slashCommands.plan.label')}` : ''}
              </div>
            </div>
            <div className="rounded-lg bg-muted/40 px-2.5 py-1.5">
              <div className="text-2xs text-muted-foreground">{t('chatV2:slashCommands.context.windowLabel')}</div>
              <div className="truncate font-medium tabular-nums">
                {contextWindowUsage
                  ? `${contextWindowUsage.usedPercent}% (${contextWindowUsage.usedTokens.toLocaleString()})`
                  : '0%'}
              </div>
            </div>
            <div className="rounded-lg bg-muted/40 px-2.5 py-1.5">
              <div className="text-2xs text-muted-foreground">{t('chatV2:slashCommands.context.switchesLabel')}</div>
              <div className="truncate font-medium">
                {t('chatV2:slashCommands.context.switchesValue', {
                  rag: ragEnabled ? (knowledgeBaseProactive ? '+' : '✓') : '×',
                  web: webSearchEnabled ? '✓' : '×',
                })}
              </div>
            </div>
            <div className="rounded-lg bg-muted/40 px-2.5 py-1.5">
              <div className="text-2xs text-muted-foreground">{t('chatV2:slashCommands.context.extensionsLabel')}</div>
              <div className="truncate font-medium">
                {t('chatV2:slashCommands.context.extensionsValue', {
                  skills: activeSkillIds?.length ?? 0,
                  mcp: selectedMcpServerCount,
                  tokens: sessionUsage ? sessionUsage.totalTokens.toLocaleString() : '0',
                })}
              </div>
            </div>
          </div>
          {goal && (
            <div className="rounded-lg border border-primary/25 bg-primary/5 px-2.5 py-1.5 text-xs">
              <span className="font-medium text-primary">{t('chatV2:slashCommands.goal.label')} </span>
              <span className="text-foreground">{goal.objective}</span>
              <span className="ml-2 tabular-nums text-muted-foreground">
                {t('chatV2:slashCommands.context.goalMeta', {
                  status: goal.status,
                  tokens: goal.tokensUsed.toLocaleString(),
                })}
              </span>
            </div>
          )}
        </div>
      )}

      {/* 5. /doctor Environment Health Check */}
      {card.kind === 'doctor' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <FirstAidKit size={15} weight="bold" className="shrink-0 text-primary" />
            <span className="text-xs font-semibold text-foreground">
              {t('chatV2:slashCommands.doctor.cardTitle')}
            </span>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="ml-auto !h-6 !w-6"
              aria-label={t('common:close')}
              onClick={onClose}
            >
              <X size={14} />
            </DsButton>
          </div>
          {docLoading ? (
            <div className="py-2 text-xs text-muted-foreground">
              {t('chatV2:slashCommands.common.loading')}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-1.5 text-xs sm:grid-cols-2">
              {docChecks.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5"
                >
                  {item.ok && !item.warn ? (
                    <CheckCircle size={15} weight="fill" className="mt-0.5 shrink-0 text-emerald-500" />
                  ) : (
                    <WarningCircle
                      size={15}
                      weight="fill"
                      className={cn(
                        'mt-0.5 shrink-0',
                        item.ok ? 'text-amber-500' : 'text-destructive',
                      )}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-foreground">{item.label}</div>
                    <div className="truncate text-muted-foreground">{item.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 6. /help Categorized Quick Reference */}
      {card.kind === 'help' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Question size={15} weight="bold" className="shrink-0 text-primary" />
            <span className="text-xs font-semibold text-foreground">
              {t('chatV2:slashCommands.help.cardTitle')}
            </span>
            <span className="text-2xs text-muted-foreground">
              {t('chatV2:slashCommands.help.shortcutSummary')}
            </span>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="ml-auto !h-6 !w-6"
              aria-label={t('common:close')}
              onClick={onClose}
            >
              <X size={14} />
            </DsButton>
          </div>
          <div className="max-h-56 space-y-2 overflow-y-auto pr-1 text-xs">
            <div>
              <div className="mb-1 flex items-center gap-1 font-semibold text-muted-foreground">
                <Lightning size={12} weight="bold" />
                <span>{t('chatV2:inputBar.slashCommand.groupControl')}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {BUILTIN_SLASH_COMMANDS.filter((c) => c.category === 'control').map((cmd) => (
                  <DsButton
                    key={cmd.id}
                    variant="ghost"
                    size="sm"
                    className="!h-6 !px-2 font-mono text-2xs"
                    onClick={() => {
                      onInsertToComposer(`/${cmd.id} `);
                      onClose();
                    }}
                  >
                    /{cmd.id} · {t(cmd.labelKey)}
                  </DsButton>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1 flex items-center gap-1 font-semibold text-muted-foreground">
                <Sparkle size={12} weight="fill" className="text-amber-500" />
                <span>{t('chatV2:inputBar.slashCommand.groupStudy')}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {BUILTIN_SLASH_COMMANDS.filter((c) => c.category === 'study').map((cmd) => (
                  <DsButton
                    key={cmd.id}
                    variant="ghost"
                    size="sm"
                    className="!h-6 !px-2 font-mono text-2xs"
                    onClick={() => {
                      onInsertToComposer(`/${cmd.id} `);
                      onClose();
                    }}
                  >
                    /{cmd.id} · {t(cmd.labelKey)}
                  </DsButton>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
