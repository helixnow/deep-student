import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CalendarBlank, Play, X } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Z_INDEX } from '@/config/zIndex';
import { cn } from '@/utils/cn';
import { getErrorMessage } from '@/utils/errorUtils';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  SPRINT_BUDGET_PRESETS,
  clampSprintBudgetMinutes,
  formatReadinessPercent,
  type ExamReadinessSnapshot,
} from './sprintContracts';
import {
  openDailySprint,
  updateSprintHorizonSettings,
  useSprintLauncherSnapshot,
} from './sprintLauncherStore';

export type ExamReadinessHudVariant = 'study-space-header' | 'agenda-strip' | 'mobile-banner';

export interface ExamReadinessHudProps {
  variant: ExamReadinessHudVariant;
  className?: string;
}

function formatCountdownLabel(
  readiness: ExamReadinessSnapshot,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (readiness.daysUntilExam === null || readiness.examDate === null) {
    return t('examSprint.hud.readyUnscheduled');
  }
  if (readiness.daysUntilExam === 0) {
    return t('examSprint.hud.countdownToday');
  }
  if (readiness.daysUntilExam > 0) {
    return t('examSprint.hud.countdownDays', { count: readiness.daysUntilExam });
  }
  return `${t('examSprint.hud.countdownPost', { count: Math.abs(readiness.daysUntilExam) })} · ${t('examSprint.hud.phase.maintenance')}`;
}

export const ExamReadinessHud: React.FC<ExamReadinessHudProps> = ({ variant, className }) => {
  const { t } = useTranslation('review');
  const { readiness, config } = useSprintLauncherSnapshot();
  const [configOpen, setConfigOpen] = useState(false);
  const [draftExamDate, setDraftExamDate] = useState('');
  const [draftBudget, setDraftBudget] = useState(15);
  const [savingConfig, setSavingConfig] = useState(false);
  const savingRef = useRef(false);
  const configSessionRef = useRef(0);

  useEffect(() => {
    configSessionRef.current += 1;
    savingRef.current = false;
    setSavingConfig(false);
    setConfigOpen(false);
    return () => { configSessionRef.current += 1; };
  }, [config?.spaceId]);

  useEffect(() => {
    if (!configOpen) return undefined;
    setDraftExamDate(readiness?.examDate ?? config?.examDate ?? '');
    setDraftBudget(clampSprintBudgetMinutes(config?.sprintBudgetMinutes, 15));

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isComposingKeyEvent(event) && !savingRef.current) {
        event.preventDefault();
        setConfigOpen(false);
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [config?.examDate, config?.sprintBudgetMinutes, configOpen, readiness?.examDate]);

  if (!readiness) return null;

  const hasExamDate = readiness.examDate !== null;
  const hasSprintItems = readiness.selectedSprintCount > 0;

  if (variant === 'study-space-header' || variant === 'agenda-strip') {
    if (!hasExamDate && !hasSprintItems) return null;
  } else if (!hasExamDate && !hasSprintItems && readiness.totalActiveItems === 0) {
    return null;
  }

  const readinessPct = formatReadinessPercent(readiness.predictedExamRetrievability);
  const countdownText = formatCountdownLabel(readiness, t);
  const displayMinutes =
    readiness.estimatedSprintMinutes > 0
      ? readiness.estimatedSprintMinutes
      : hasSprintItems
        ? Math.max(1, Math.ceil(readiness.estimatedSprintSeconds / 60))
        : 0;
  const ctaText =
    displayMinutes > 0
      ? t('examSprint.hud.startCta', { minutes: displayMinutes })
      : t('examSprint.hud.startCtaIdle');

  const forecastLabel =
    readinessPct !== null
      ? hasExamDate
        ? t('examSprint.hud.readinessForecast', { value: readinessPct })
        : t('examSprint.hud.readinessSevenDay', { value: readinessPct })
      : t('examSprint.hud.readinessPending');

  const handleSaveConfig = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    const session = configSessionRef.current;
    setSavingConfig(true);
    try {
      await updateSprintHorizonSettings({
        examDate: draftExamDate.trim() ? draftExamDate.trim() : null,
        sprintBudgetMinutes: draftBudget,
      });
      if (session === configSessionRef.current) setConfigOpen(false);
    } catch (error) {
      if (session === configSessionRef.current) showGlobalNotification('error', getErrorMessage(error));
    } finally {
      if (session === configSessionRef.current) {
        savingRef.current = false;
        setSavingConfig(false);
      }
    }
  };

  const configDialogContent = configOpen ? (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('examSprint.hud.editConfigLabel')}
      data-testid="exam-horizon-config-dialog"
      style={{ zIndex: Z_INDEX.modal }}
      onClick={() => { if (!savingRef.current) setConfigOpen(false); }}
      className="fixed inset-0 flex items-center justify-center bg-background/75 p-4 backdrop-blur-xs"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-[400px] rounded-xl border border-border/35 bg-card p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between gap-2 border-b border-border/35 pb-3">
          <h3 className="text-sm font-semibold text-foreground">
            {t('examSprint.hud.editConfigLabel')}
          </h3>
          <button
            type="button"
            disabled={savingConfig}
            aria-label={t('examSprint.hud.cancelConfig')}
            onClick={() => { if (!savingRef.current) setConfigOpen(false); }}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label
                htmlFor="exam-sprint-date-input"
                className="text-xs font-medium text-foreground"
              >
                {t('examSprint.hud.examDateField')}
              </label>
              {draftExamDate ? (
                <button
                  type="button"
                  onClick={() => setDraftExamDate('')}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {t('examSprint.hud.clearExamDate')}
                </button>
              ) : null}
            </div>
            <input
              id="exam-sprint-date-input"
              type="date"
              value={draftExamDate}
              onChange={(event) => setDraftExamDate(event.target.value)}
              className="min-h-[44px] w-full rounded-lg border border-border/35 bg-background px-3 py-2 font-mono text-sm tabular-nums text-foreground focus:border-primary/50 focus:outline-none"
            />
          </div>

          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-foreground">
              {t('examSprint.hud.budgetField')}
            </span>
            <div className="grid grid-cols-4 gap-2">
              {SPRINT_BUDGET_PRESETS.map((minutes) => {
                const active = draftBudget === minutes;
                return (
                  <button
                    key={minutes}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setDraftBudget(minutes)}
                    className={cn(
                      'min-h-[44px] rounded-lg border px-2 py-1.5 font-mono text-xs font-medium tabular-nums transition-colors active:scale-95 active:opacity-80',
                      active
                        ? 'border-primary/50 bg-primary/12 text-primary'
                        : 'border-border/35 bg-card text-foreground hover:bg-muted/50',
                    )}
                  >
                    {t('examSprint.hud.budgetMinutesOption', { minutes })}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2 border-t border-border/35 pt-3.5">
          <button
            type="button"
            disabled={savingConfig}
            onClick={() => { if (!savingRef.current) setConfigOpen(false); }}
            className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-border/35 bg-card px-4 py-2 text-xs font-medium text-foreground hover:bg-muted/50 disabled:opacity-50"
          >
            {t('examSprint.hud.cancelConfig')}
          </button>
          <button
            type="button"
            disabled={savingConfig}
            onClick={() => void handleSaveConfig()}
            className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {t('examSprint.hud.saveConfig')}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const configDialog =
    configDialogContent && typeof document !== 'undefined'
      ? createPortal(configDialogContent, document.body)
      : configDialogContent;

  if (variant === 'study-space-header') {
    return (
      <>
        <div
          data-no-drag
          data-testid="exam-readiness-hud-header"
          className={cn(
            'hidden h-7 shrink-0 items-center gap-2 rounded-lg border border-border/35 bg-card/80 px-2.5 text-xs md:inline-flex',
            className,
          )}
        >
          <button
            type="button"
            data-testid="hud-header-exam-trigger"
            aria-label={t('examSprint.hud.editConfigLabel')}
            onClick={() => setConfigOpen(true)}
            className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-muted/60"
          >
            <span className="font-mono font-medium tabular-nums text-foreground">
              {countdownText}
            </span>
          </button>

          <span className="h-3 w-px shrink-0 bg-border/35" aria-hidden="true" />

          <span className="font-mono tabular-nums text-muted-foreground">{forecastLabel}</span>

          <button
            type="button"
            data-testid="hud-header-sprint-cta"
            onClick={() => openDailySprint({ source: 'study-space-header' })}
            className="inline-flex h-5 items-center gap-1 rounded-md bg-primary/12 px-2 font-mono text-2xs font-medium tabular-nums text-primary transition-colors hover:bg-primary/20 active:scale-95 active:opacity-80"
          >
            <Play size={12} weight="fill" aria-hidden="true" />
            <span>{ctaText}</span>
          </button>
        </div>
        {configDialog}
      </>
    );
  }

  if (variant === 'agenda-strip') {
    const agendaSummary = hasExamDate
      ? readinessPct !== null
        ? `${countdownText} · ${t('examSprint.hud.readinessShort', { value: readinessPct })}`
        : countdownText
      : t('examSprint.hud.readyUnscheduled');

    return (
      <>
        <div
          data-testid="exam-readiness-hud-agenda"
          className={cn(
            'wb-agenda-sprint-strip mb-2.5 flex items-center justify-between gap-2 pb-2.5 text-xs',
            className,
          )}
        >
          <button
            type="button"
            onClick={() => setConfigOpen(true)}
            aria-label={t('examSprint.hud.editConfigLabel')}
            className="wb-agenda-sprint-summary inline-flex min-w-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 text-left transition-colors"
          >
            <span className="truncate font-medium tabular-nums">
              {agendaSummary}
            </span>
          </button>

          <button
            type="button"
            data-testid="wb-agenda-sprint-cta"
            onClick={() => openDailySprint({ source: 'desktop-agenda' })}
            className="wb-agenda-sprint-cta inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 font-medium tabular-nums transition-colors active:scale-95 active:opacity-80"
          >
            <Play size={10} weight="fill" aria-hidden="true" />
            <span>{ctaText}</span>
          </button>
        </div>
        {configDialog}
      </>
    );
  }

  const cardsBreakdownCount = readiness.breakdown.fsrsDueCount + readiness.breakdown.fsrsNewCount;
  const breakdownParts = [
    cardsBreakdownCount > 0 ? t('examSprint.hud.breakdownCards', { count: cardsBreakdownCount }) : null,
    readiness.breakdown.mistakeDueCount > 0 ? t('examSprint.hud.breakdownMistakes', { count: readiness.breakdown.mistakeDueCount }) : null,
    readiness.breakdown.mindmapWeakCount > 0 ? t('examSprint.hud.breakdownMindmap', { count: readiness.breakdown.mindmapWeakCount }) : null,
  ].filter((part): part is string => Boolean(part));

  return (
    <>
      <section
        data-testid="exam-readiness-hud-mobile"
        className={cn(
          'flex flex-col gap-3 rounded-xl border border-border/50 bg-card/55 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-5',
          className,
        )}
      >
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-foreground">
              {countdownText}
            </span>
            <span className="h-3 w-px shrink-0 bg-border/50" aria-hidden="true" />
            <span className="font-mono tabular-nums text-muted-foreground">{forecastLabel}</span>
          </div>

          {(breakdownParts.length > 0 || readiness.newIntakeFrozen || (hasSprintItems && readiness.deferredBacklogCount > 0)) ? (
            <div
              data-testid="hud-mobile-breakdown"
              className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground"
            >
              {breakdownParts.length > 0 ? (
                <span className="font-mono tabular-nums text-foreground/80">
                  {breakdownParts.join(' · ')}
                </span>
              ) : null}
              {readiness.newIntakeFrozen ? (
                <span className="text-warning">{t('examSprint.hud.frozenIntake')}</span>
              ) : hasSprintItems && readiness.deferredBacklogCount > 0 ? (
                <span data-testid="hud-mobile-deferred">
                  {t('examSprint.hud.deferredHint', {
                    selected: readiness.selectedSprintCount,
                    count: readiness.deferredBacklogCount,
                  })}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:flex-nowrap">
          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            data-testid="hud-mobile-set-exam"
            onClick={() => setConfigOpen(true)}
            className="min-h-[44px] px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground sm:min-h-0"
          >
            <CalendarBlank size={14} aria-hidden="true" />
            <span>
              {hasExamDate ? readiness.examDate : t('examSprint.hud.setExamDate')}
            </span>
          </DsButton>

          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            data-testid="hud-mobile-sprint-cta"
            onClick={() => openDailySprint({ source: 'mobile-banner' })}
            className="min-h-[48px] w-full justify-center gap-1.5 rounded-lg border border-primary/40 bg-primary/15 px-3.5 text-xs font-medium tabular-nums text-primary hover:bg-primary/25 hover:text-primary active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100 sm:min-h-0 sm:w-auto sm:whitespace-nowrap"
          >
            <Play size={13} weight="fill" aria-hidden="true" />
            <span>{ctaText}</span>
          </DsButton>
        </div>
      </section>
      {configDialog}
    </>
  );
};

export default ExamReadinessHud;
