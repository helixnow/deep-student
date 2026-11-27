import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Play, Sparkle } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { cn } from '@/utils/cn';
import {
  formatReadinessPercent,
  formatSignedDeltaPoints,
  formatWholePercent,
  type ConceptMasteryDelta,
  type SprintSessionSettlement,
} from './sprintContracts';

export interface SprintSettlementScreenProps {
  settlement: SprintSessionSettlement;
  deferredBacklogCount?: number;
  onFinish: () => void;
  onExtraSprint?: (minutes: number) => void;
  onReinforceConcept?: (concept: string) => void;
}

function getConceptOutcomeBarClass(outcome: ConceptMasteryDelta['outcome']): string {
  switch (outcome) {
    case 'improved':
      return 'bg-success';
    case 'needs_reinforce':
      return 'bg-warning';
    case 'steady':
    default:
      return 'bg-primary/70';
  }
}

export const SprintSettlementScreen: React.FC<SprintSettlementScreenProps> = ({
  settlement,
  deferredBacklogCount,
  onFinish,
  onExtraSprint,
  onReinforceConcept,
}) => {
  const { t } = useTranslation('review');

  const handleReinforceConcept = useCallback(
    (concept: string) => {
      if (onReinforceConcept) {
        onReinforceConcept(concept);
        return;
      }
      dispatchAppEvent(APP_EVENTS.PREFILL_CHAT_INPUT, {
        content: t('examSprint.settlement.reinforcePrompt', {
          concept,
          defaultValue:
            '帮我针对薄弱知识点「{{concept}}」复习：先用三句话讲清核心概念；再出 3 道由浅入深的练习题，用题库工具写进题目集「薄弱点练习」，每道题的第一个知识点标签写「{{concept}}」，我会在题目集里作答，这样掌握度才会更新；最后告诉我最容易错在哪里。',
        }),
        autoSend: false,
        newSession: true,
      });
      onFinish();
    },
    [onFinish, onReinforceConcept, t],
  );

  const onWindowKeyDown = useCallback(
    (rawEvent: Event) => {
      const event = rawEvent as KeyboardEvent;
      if (event.isComposing || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (
        target
        && (target.tagName === 'INPUT'
          || target.tagName === 'TEXTAREA'
          || target.isContentEditable)
      ) {
        return;
      }
      if (
        (event.key === 'Enter' || event.key === ' ')
        && target
        && (target.tagName === 'BUTTON' || (typeof target.closest === 'function' && Boolean(target.closest('button, a'))))
      ) {
        return;
      }
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') {
        event.preventDefault();
        onFinish();
      }
    },
    [onFinish],
  );
  useEventRegistry(
    [{ target: 'window', type: 'keydown', listener: onWindowKeyDown }],
    [onWindowKeyDown],
  );

  const isScheduled =
    settlement.readinessAfter.phase !== 'unscheduled'
    && settlement.readinessAfter.examDate !== null;

  const beforePct = formatReadinessPercent(
    settlement.readinessBefore.predictedExamRetrievability,
  );
  const afterPct = formatReadinessPercent(
    settlement.readinessAfter.predictedExamRetrievability,
  );

  const rawDelta =
    settlement.readinessDeltaPctPoints !== null
      ? settlement.readinessDeltaPctPoints
      : settlement.readinessBefore.predictedExamRetrievability !== null
        && settlement.readinessAfter.predictedExamRetrievability !== null
        ? (settlement.readinessAfter.predictedExamRetrievability
            - settlement.readinessBefore.predictedExamRetrievability)
          * 100
        : null;
  const deltaBadge = formatSignedDeltaPoints(rawDelta);
  const deltaNonNegative = rawDelta === null || rawDelta >= 0;

  const beforeRatio = Math.max(
    0,
    Math.min(1, settlement.readinessBefore.predictedExamRetrievability ?? 0),
  );
  const afterRatio = Math.max(
    0,
    Math.min(1, settlement.readinessAfter.predictedExamRetrievability ?? beforeRatio),
  );
  const baseWidthPct = Math.min(beforeRatio, afterRatio) * 100;
  const gainWidthPct = Math.max(0, afterRatio - beforeRatio) * 100;
  const targetRatio = Math.max(
    0.5,
    Math.min(0.99, settlement.readinessAfter.effectiveTargetRetention || 0.92),
  );
  const targetPctLabel = formatReadinessPercent(targetRatio);

  const elapsedMinutes = Math.floor(Math.max(0, settlement.totalElapsedSeconds) / 60);
  const durationDisplay =
    settlement.totalElapsedSeconds < 60
      ? t('examSprint.settlement.durationUnderOneMinute')
      : t('examSprint.settlement.durationMinutes', {
          minutes: Math.max(1, Math.round(settlement.totalElapsedSeconds / 60)),
        });

  const firstPassRatio =
    settlement.totalCompleted > 0
      ? Math.max(0, Math.min(1, settlement.passedCount / settlement.totalCompleted))
      : 0;
  const firstPassDisplay = `${(firstPassRatio * 100).toFixed(1)}%`;

  const effectiveDeferredCount = Math.max(
    0,
    deferredBacklogCount ?? settlement.readinessAfter.deferredBacklogCount ?? 0,
  );
  const visibleConcepts = settlement.conceptDeltas.slice(0, 5);
  const encouragementText =
    settlement.totalCompleted <= 0
      ? null
      : settlement.readinessAfter.predictedExamRetrievability !== null && afterRatio >= targetRatio
        ? t('examSprint.settlement.encourageTargetMet')
        : firstPassRatio >= 0.8
          ? t('examSprint.settlement.encourageStrong')
          : t('examSprint.settlement.encourageSteady');

  return (
    <div
      className="mx-auto flex w-full max-w-2xl flex-col gap-5 py-4 animate-chat-rise-in motion-reduce:animate-none"
      data-testid="sprint-settlement-screen"
    >
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t('examSprint.settlement.eyebrow')}
          </span>
        </div>
        {encouragementText ? (
          <p
            data-testid="settlement-encouragement"
            className="text-sm leading-relaxed text-foreground/90"
          >
            {encouragementText}
          </p>
        ) : null}
      </div>

      <section className="rounded-xl border border-border/35 bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {isScheduled
              ? t('examSprint.settlement.readinessExamLabel')
              : t('examSprint.settlement.readinessRollingLabel')}
          </span>
          {targetPctLabel ? (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {t('examSprint.settlement.targetMarker', { value: targetPctLabel })}
            </span>
          ) : null}
        </div>

        {beforePct !== null && afterPct !== null ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
            <span
              data-testid="settlement-readiness-before"
              className="font-mono text-2xl font-semibold tabular-nums text-muted-foreground"
            >
              {beforePct}
            </span>
            <ArrowRight size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
            <span
              data-testid="settlement-readiness-after"
              className="font-mono text-2xl font-semibold tabular-nums text-foreground"
            >
              {afterPct}
            </span>
            {deltaBadge !== null ? (
              <span
                data-testid="settlement-readiness-delta"
                className={cn(
                  'rounded-md border px-2 py-0.5 font-mono text-xs font-semibold tabular-nums',
                  deltaNonNegative
                    ? 'border-success/25 bg-success/10 text-success'
                    : 'border-warning/25 bg-warning/10 text-warning',
                )}
              >
                {deltaBadge}
              </span>
            ) : null}
          </div>
        ) : (
          <div className="mt-2.5 font-mono text-lg font-medium tabular-nums text-muted-foreground">
            {afterPct ?? beforePct ?? t('examSprint.hud.readinessPending')}
          </div>
        )}

        <div className="relative mt-4 h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="absolute inset-y-0 left-0 bg-primary/45 transition-[width] duration-500 ease-standard motion-reduce:transition-none"
            style={{ width: `${baseWidthPct}%` }}
          />
          {gainWidthPct > 0 ? (
            <div
              className="absolute inset-y-0 bg-success transition-[left,width] duration-500 ease-standard motion-reduce:transition-none"
              style={{ left: `${baseWidthPct}%`, width: `${gainWidthPct}%` }}
            />
          ) : null}
          <div
            className="absolute inset-y-0 w-px border-l border-dashed border-foreground/60"
            style={{ left: `${targetRatio * 100}%` }}
            aria-hidden="true"
          />
        </div>
      </section>

      <section
        className="grid grid-cols-1 divide-y divide-border/35 rounded-xl border border-border/35 bg-card/60 sm:grid-cols-3 sm:divide-x sm:divide-y-0"
        data-testid="settlement-metrics-grid"
      >
        <div className="flex flex-col gap-1 p-4">
          <span className="text-xs text-muted-foreground">
            {t('examSprint.settlement.metricDuration')}
          </span>
          <span
            data-testid="settlement-duration-value"
            data-elapsed-minutes={elapsedMinutes}
            className="font-mono text-lg font-semibold tabular-nums text-foreground"
          >
            {durationDisplay}
          </span>
        </div>

        <div className="flex flex-col gap-1 p-4">
          <span className="text-xs text-muted-foreground">
            {t('examSprint.settlement.metricCompleted')}
          </span>
          <span
            data-testid="settlement-completed-total"
            className="font-mono text-lg font-semibold tabular-nums text-foreground"
          >
            {settlement.totalCompleted}
          </span>
          <span className="font-mono text-2xs tabular-nums text-muted-foreground">
            {t('examSprint.settlement.completedBreakdown', {
              cards: settlement.byKind.fsrsCards,
              mistakes: settlement.byKind.mistakes,
              mindmaps: settlement.byKind.mindmapNodes,
            })}
          </span>
          {settlement.byKind.variantsSolved > 0 ? (
            <span className="font-mono text-2xs tabular-nums text-primary">
              {t('examSprint.settlement.variantsSolvedNote', {
                count: settlement.byKind.variantsSolved,
              })}
            </span>
          ) : null}
        </div>

        <div className="flex flex-col gap-1 p-4">
          <span className="text-xs text-muted-foreground">
            {t('examSprint.settlement.metricFirstPass')}
          </span>
          <span
            data-testid="settlement-first-pass-rate"
            className="font-mono text-lg font-semibold tabular-nums text-foreground"
          >
            {firstPassDisplay}
          </span>
          {settlement.totalCompleted > 0 ? (
            <span className="font-mono text-2xs tabular-nums text-muted-foreground">
              {t('examSprint.settlement.firstPassDetail', {
                passed: settlement.passedCount,
                total: settlement.totalCompleted,
              })}
            </span>
          ) : null}
        </div>
      </section>

      {visibleConcepts.length > 0 ? (
        <section
          className="rounded-xl border border-border/35 bg-card/70 p-4"
          data-testid="settlement-concepts-receipt"
        >
          <div className="mb-2.5 flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
            <span>{t('examSprint.settlement.conceptsHeading')}</span>
            <span className="text-2xs text-muted-foreground/80">
              {t('examSprint.settlement.conceptsTapHint', { defaultValue: '点击知识点进入 AI 讲练巩固' })}
            </span>
          </div>
          <ul className="divide-y divide-border/35">
            {visibleConcepts.map((concept) => {
              const scorePct = Math.max(0, Math.min(100, Math.round((concept.scoreAfter ?? 0) * 100)));
              const needsReinforce = concept.outcome === 'needs_reinforce';
              return (
                <li
                  key={concept.concept}
                  className="py-1 first:pt-0 last:pb-0"
                >
                  <button
                    type="button"
                    data-testid="settlement-concept-button"
                    data-concept={concept.concept}
                    data-outcome={concept.outcome}
                    onClick={() => handleReinforceConcept(concept.concept)}
                    title={t('examSprint.settlement.reinforceTooltip', {
                      concept: concept.concept,
                      defaultValue: '针对「{{concept}}」开启 AI 讲练巩固',
                    })}
                    className={cn(
                      'group flex min-h-[44px] w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/50 active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100',
                      needsReinforce && 'bg-warning/[0.04] hover:bg-warning/[0.1]',
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm text-foreground">{concept.concept}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {needsReinforce ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-warning/35 bg-warning/10 px-2 py-0.5 text-2xs font-medium text-warning">
                          <Sparkle size={11} weight="bold" aria-hidden="true" />
                          <span>
                            {t('examSprint.settlement.reinforceCta', { defaultValue: 'AI 讲练' })}
                          </span>
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {t(`examSprint.settlement.outcome.${concept.outcome}`)}
                        </span>
                      )}
                      <span
                        aria-hidden="true"
                        className="hidden h-1.5 w-12 overflow-hidden rounded-full bg-muted sm:inline-block"
                      >
                        <span
                          className={cn(
                            'block h-full rounded-full transition-[width] duration-300 ease-standard motion-reduce:transition-none',
                            getConceptOutcomeBarClass(concept.outcome),
                          )}
                          style={{ width: `${scorePct}%` }}
                        />
                      </span>
                      <span className="w-9 text-right font-mono text-xs font-semibold tabular-nums text-foreground">
                        {formatWholePercent(concept.scoreAfter) ?? '0%'}
                      </span>
                      <ArrowRight
                        size={13}
                        aria-hidden="true"
                        className="shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:transition-none"
                      />
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {effectiveDeferredCount > 0 ? (
        <p
          data-testid="settlement-deferred-note"
          className="rounded-lg border border-border/35 bg-primary/[0.05] px-3.5 py-2.5 font-mono text-xs tabular-nums text-muted-foreground"
        >
          {t('examSprint.settlement.deferredCalmNote', { count: effectiveDeferredCount })}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2.5 pt-1">
        {effectiveDeferredCount > 0 && onExtraSprint ? (
          <DsButton
            type="button"
            variant="default"
            data-testid="settlement-extra-sprint"
            onClick={() => onExtraSprint(10)}
            className="!h-auto min-h-[44px] max-sm:min-h-[48px] gap-1.5 rounded-lg px-4 py-2.5 font-mono text-sm font-medium tabular-nums active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            <Play size={14} weight="bold" aria-hidden="true" />
            <span>{t('examSprint.settlement.extraTenMinutes')}</span>
          </DsButton>
        ) : null}
        <DsButton
          type="button"
          variant="primary"
          data-testid="settlement-finish-button"
          aria-keyshortcuts="Enter Space"
          onClick={onFinish}
          className="!h-auto min-h-[44px] max-sm:min-h-[48px] gap-2 rounded-lg !border-transparent !bg-primary px-5 py-2.5 text-sm font-medium !text-primary-foreground hover:!bg-primary/90 active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
        >
          <span>{t('examSprint.settlement.finishReturn')}</span>
          <kbd
            aria-hidden="true"
            className="hidden rounded border border-primary-foreground/25 bg-primary-foreground/15 px-1.5 py-0.5 font-mono text-2xs font-normal sm:inline-block"
          >
            Enter
          </kbd>
        </DsButton>
      </div>
    </div>
  );
};

export default SprintSettlementScreen;
