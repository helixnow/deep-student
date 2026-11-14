import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Play } from '@phosphor-icons/react';
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
}

function getConceptOutcomeDotClass(outcome: ConceptMasteryDelta['outcome']): string {
  switch (outcome) {
    case 'improved':
      return 'bg-emerald-500';
    case 'needs_reinforce':
      return 'bg-amber-500';
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
}) => {
  const { t } = useTranslation('review');

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
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
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') {
        event.preventDefault();
        onFinish();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onFinish]);

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

  return (
    <div
      className="mx-auto flex w-full max-w-2xl flex-col gap-5 py-4"
      data-testid="sprint-settlement-screen"
    >
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('examSprint.settlement.eyebrow')}
        </span>
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
                    ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : 'border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400',
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

        <div className="relative mt-4 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="absolute inset-y-0 left-0 bg-primary/45 transition-all"
            style={{ width: `${baseWidthPct}%` }}
          />
          {gainWidthPct > 0 ? (
            <div
              className="absolute inset-y-0 bg-emerald-500 transition-all"
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
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {t('examSprint.settlement.completedBreakdown', {
              cards: settlement.byKind.fsrsCards,
              mistakes: settlement.byKind.mistakes,
              mindmaps: settlement.byKind.mindmapNodes,
            })}
          </span>
          {settlement.byKind.variantsSolved > 0 ? (
            <span className="font-mono text-[11px] tabular-nums text-primary">
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
        </div>
      </section>

      {visibleConcepts.length > 0 ? (
        <section
          className="rounded-xl border border-border/35 bg-card/70 p-4"
          data-testid="settlement-concepts-receipt"
        >
          <div className="mb-2.5 text-xs font-medium text-muted-foreground">
            {t('examSprint.settlement.conceptsHeading')}
          </div>
          <ul className="divide-y divide-border/35">
            {visibleConcepts.map((concept) => (
              <li
                key={concept.concept}
                className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      getConceptOutcomeDotClass(concept.outcome),
                    )}
                    aria-hidden="true"
                  />
                  <span className="truncate text-sm text-foreground">{concept.concept}</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t(`examSprint.settlement.outcome.${concept.outcome}`)}
                  </span>
                  <span className="font-mono text-xs font-semibold tabular-nums text-foreground">
                    {formatWholePercent(concept.scoreAfter) ?? '0%'}
                  </span>
                </div>
              </li>
            ))}
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
          <button
            type="button"
            data-testid="settlement-extra-sprint"
            onClick={() => onExtraSprint(10)}
            className="inline-flex min-h-[44px] max-sm:min-h-[48px] items-center gap-1.5 rounded-lg border border-border/35 bg-card px-4 py-2.5 font-mono text-sm font-medium tabular-nums text-foreground transition-colors hover:bg-muted/60 active:scale-95 active:opacity-80"
          >
            <Play size={14} weight="bold" aria-hidden="true" />
            <span>{t('examSprint.settlement.extraTenMinutes')}</span>
          </button>
        ) : null}
        <button
          type="button"
          data-testid="settlement-finish-button"
          onClick={onFinish}
          className="inline-flex min-h-[44px] max-sm:min-h-[48px] items-center justify-center rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 active:scale-95 active:opacity-80"
        >
          {t('examSprint.settlement.finishReturn')}
        </button>
      </div>
    </div>
  );
};

export default SprintSettlementScreen;
