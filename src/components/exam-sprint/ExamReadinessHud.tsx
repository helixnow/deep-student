import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CalendarBlank, Play, X } from '@phosphor-icons/react';
import { Z_INDEX } from '@/config/zIndex';
import { cn } from '@/utils/cn';
import { getErrorMessage } from '@/utils/errorUtils';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  SPRINT_BUDGET_PRESETS,
  clampSprintBudgetMinutes,
  formatReadinessPercent,
  getExamPhaseDotClass,
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
      onClick={() => setConfigOpen(false)}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-background/75 p-4 backdrop-blur-xs"
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
            aria-label={t('examSprint.hud.cancelConfig')}
            onClick={() => setConfigOpen(false)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground"
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
            onClick={() => setConfigOpen(false)}
            className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-border/35 bg-card px-4 py-2 text-xs font-medium text-foreground hover:bg-muted/50"
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
            <span
              className={cn('h-1.5 w-1.5 shrink-0 rounded-full', getExamPhaseDotClass(readiness.phase))}
              aria-hidden="true"
            />
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
            className="inline-flex h-5 items-center gap-1 rounded-md bg-primary/12 px-2 font-mono text-[11px] font-medium tabular-nums text-primary transition-colors hover:bg-primary/20 active:scale-95 active:opacity-80"
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
            'wb-agenda-sprint-strip mb-2 flex items-center justify-between gap-2 border-b border-border/35 pb-2 text-xs',
            className,
          )}
        >
          <button
            type="button"
            onClick={() => setConfigOpen(true)}
            aria-label={t('examSprint.hud.editConfigLabel')}
            className="inline-flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-foreground/5 [@media(pointer:coarse)]:min-h-[44px]"
          >
            <span
              className={cn('h-1.5 w-1.5 shrink-0 rounded-full', getExamPhaseDotClass(readiness.phase))}
              aria-hidden="true"
            />
            <span className="truncate font-mono text-[11px] font-medium tabular-nums text-foreground">
              {agendaSummary}
            </span>
          </button>

          <button
            type="button"
            data-testid="wb-agenda-sprint-cta"
            onClick={() => openDailySprint({ source: 'desktop-agenda' })}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-primary/25 bg-primary/12 px-2 py-1 font-mono text-[11px] font-medium tabular-nums text-primary transition-colors hover:bg-primary/20 active:scale-95 active:opacity-80 [@media(pointer:coarse)]:min-h-[44px]"
          >
            <Play size={11} weight="fill" aria-hidden="true" />
            <span>{ctaText}</span>
          </button>
        </div>
        {configDialog}
      </>
    );
  }

  return (
    <>
      <section
        data-testid="exam-readiness-hud-mobile"
        className={cn(
          'space-y-3 rounded-xl border border-border/35 bg-card/90 p-3.5',
          className,
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
            <span
              className={cn('h-1.5 w-1.5 shrink-0 rounded-full', getExamPhaseDotClass(readiness.phase))}
              aria-hidden="true"
            />
            <span className="font-mono font-medium tabular-nums text-foreground">
              {countdownText}
            </span>
            <span className="h-3 w-px shrink-0 bg-border/35" aria-hidden="true" />
            <span className="font-mono tabular-nums text-muted-foreground">{forecastLabel}</span>
          </div>

          <button
            type="button"
            data-testid="hud-mobile-set-exam"
            onClick={() => setConfigOpen(true)}
            className="inline-flex min-h-[44px] items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground active:scale-95 active:opacity-80"
          >
            <CalendarBlank size={14} aria-hidden="true" />
            <span>
              {hasExamDate ? readiness.examDate : t('examSprint.hud.setExamDate')}
            </span>
          </button>
        </div>

        <button
          type="button"
          data-testid="hud-mobile-sprint-cta"
          onClick={() => openDailySprint({ source: 'mobile-banner' })}
          className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 font-mono text-sm font-medium tabular-nums text-primary-foreground transition-colors hover:bg-primary/90 active:scale-95 active:opacity-80"
        >
          <Play size={15} weight="fill" aria-hidden="true" />
          <span>{ctaText}</span>
        </button>
      </section>
      {configDialog}
    </>
  );
};

export default ExamReadinessHud;
