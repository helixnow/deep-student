/**
 * FSRS 调度设置区：每日限额、目标保持率、学习步 / 重学步、日切、最大间隔、间隔抖动。
 * 读写后端 fsrs_get_scheduler_config / fsrs_update_scheduler_config（默认牌组）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { CaretDown, CaretUp, CheckCircle, GearSix } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { Input } from '@/components/ui/shad/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/shad/Select';
import { cn } from '@/utils/cn';
import { getErrorMessage } from '@/utils/errorUtils';
import { requestFlashcardsDueRefresh } from '../events';
import {
  MAX_INTERVAL_DAYS,
  NEW_REVIEW_ORDERS,
  REVIEW_ORDERS,
  formatSteps,
  hasDayLongStep,
  parseSchedulerConfig,
  parseStepsInput,
  stepsEqual,
  type NewReviewOrder,
  type ReviewOrder,
  type SchedulerConfig,
} from '../schedulerConfig';
import { FsrsOptimizerPanel } from './FsrsOptimizerPanel';

const LIMIT_MAX = 9999;
const RETENTION_MIN = 0.5;
const RETENTION_MAX = 0.99;

const INPUT_CLASS = 'h-8 w-full text-sm';
const LABEL_CLASS = 'flex min-w-0 flex-col gap-1 text-xs font-medium text-muted-foreground';

export interface SchedulerSettingsSectionProps {
  /** 独立页面作为首块渲染时去掉顶部分隔线，避免与上方导航底线形成双线 */
  flushTop?: boolean;
  /** 打开后自动聚焦的目标字段（如从「调整每日新卡上限」进入） */
  initialFocusField?: 'newPerDay';
}

function parseIntegerInput(value: string, max: number, min = 0): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function parseRetentionInput(value: string): number | null {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.round(parsed * 1000) / 1000;
  return rounded >= RETENTION_MIN && rounded <= RETENTION_MAX ? rounded : null;
}

interface Drafts {
  newPerDay: string;
  reviewsPerDay: string;
  retention: string;
  learnAhead: string;
  learningSteps: string;
  relearningSteps: string;
  rollover: string;
  maximumInterval: string;
  enableFuzz: boolean;
  buryNewSiblings: boolean;
  buryReviewSiblings: boolean;
  reviewOrder: ReviewOrder;
  newReviewOrder: NewReviewOrder;
  maxAnswerSeconds: string;
}

function draftsFrom(config: SchedulerConfig): Drafts {
  return {
    newPerDay: String(config.newPerDay),
    reviewsPerDay: String(config.reviewsPerDay),
    retention: String(config.desiredRetention),
    learnAhead: String(config.learnAheadMinutes),
    learningSteps: formatSteps(config.learningSteps),
    relearningSteps: formatSteps(config.relearningSteps),
    rollover: String(config.dayRolloverHour),
    maximumInterval: String(config.maximumInterval),
    enableFuzz: config.enableFuzz,
    buryNewSiblings: config.buryNewSiblings,
    buryReviewSiblings: config.buryReviewSiblings,
    reviewOrder: config.reviewOrder,
    newReviewOrder: config.newReviewOrder,
    maxAnswerSeconds: String(config.maxAnswerSeconds),
  };
}

export const SchedulerSettingsSection: React.FC<SchedulerSettingsSectionProps> = ({
  flushTop = false,
  initialFocusField,
}) => {
  const { t } = useTranslation('flashcards');
  const [config, setConfig] = useState<SchedulerConfig | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<'saved' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const mountedRef = useRef(true);
  const newPerDayInputRef = useRef<HTMLInputElement | null>(null);
  const hasAutoFocusedRef = useRef(false);

  const applyConfig = useCallback((next: SchedulerConfig) => {
    setConfig(next);
    setDrafts(draftsFrom(next));
  }, []);

  useEffect(() => {
    hasAutoFocusedRef.current = false;
  }, [initialFocusField]);

  useEffect(() => {
    if (initialFocusField !== 'newPerDay' || !drafts || hasAutoFocusedRef.current) return;
    const el = newPerDayInputRef.current;
    if (!el) return;
    hasAutoFocusedRef.current = true;
    requestAnimationFrame(() => {
      el.focus();
      el.select();
    });
  }, [initialFocusField, drafts]);

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      try {
        const parsed = parseSchedulerConfig(await invoke<unknown>('fsrs_get_scheduler_config'));
        if (!mountedRef.current) return;
        if (!parsed) {
          setUnavailable(true);
          return;
        }
        applyConfig(parsed);
      } catch {
        if (mountedRef.current) setUnavailable(true);
      }
    })();
    return () => {
      mountedRef.current = false;
    };
  }, [applyConfig]);

  const setDraft = useCallback(<K extends keyof Drafts>(key: K, value: Drafts[K]) => {
    setDrafts((current) => (current ? { ...current, [key]: value } : current));
    setNotice(null);
  }, []);

  const nextNew = drafts ? parseIntegerInput(drafts.newPerDay, LIMIT_MAX) : null;
  const nextReviews = drafts ? parseIntegerInput(drafts.reviewsPerDay, LIMIT_MAX) : null;
  const nextRetention = drafts ? parseRetentionInput(drafts.retention) : null;
  const nextLearnAhead = drafts ? parseIntegerInput(drafts.learnAhead, 60) : null;
  const nextLearningSteps = drafts ? parseStepsInput(drafts.learningSteps) : null;
  const nextRelearningSteps = drafts ? parseStepsInput(drafts.relearningSteps) : null;
  const nextRollover = drafts ? parseIntegerInput(drafts.rollover, 23) : null;
  const nextMaxInterval = drafts ? parseIntegerInput(drafts.maximumInterval, MAX_INTERVAL_DAYS, 1) : null;
  const nextMaxAnswer = drafts ? parseIntegerInput(drafts.maxAnswerSeconds, 3600, 1) : null;

  const limitsInvalid = nextNew == null || nextReviews == null;
  const retentionInvalid = nextRetention == null;
  const learnAheadInvalid = nextLearnAhead == null;
  const stepsInvalid = nextLearningSteps == null || nextRelearningSteps == null;
  const rolloverInvalid = nextRollover == null;
  const maxIntervalInvalid = nextMaxInterval == null;
  const maxAnswerInvalid = nextMaxAnswer == null;
  const anyInvalid = limitsInvalid || retentionInvalid || learnAheadInvalid || stepsInvalid
    || rolloverInvalid || maxIntervalInvalid || maxAnswerInvalid;

  const update: Record<string, unknown> = {};
  if (config && drafts && !anyInvalid) {
    if (nextNew !== config.newPerDay) update.newPerDay = nextNew;
    if (nextReviews !== config.reviewsPerDay) update.reviewsPerDay = nextReviews;
    if (nextRetention !== config.desiredRetention) update.desiredRetention = nextRetention;
    if (nextLearnAhead !== config.learnAheadMinutes) update.learnAheadMinutes = nextLearnAhead;
    if (nextLearningSteps && !stepsEqual(nextLearningSteps, config.learningSteps)) {
      update.learningSteps = nextLearningSteps;
    }
    if (nextRelearningSteps && !stepsEqual(nextRelearningSteps, config.relearningSteps)) {
      update.relearningSteps = nextRelearningSteps;
    }
    if (nextRollover !== config.dayRolloverHour) update.dayRolloverHour = nextRollover;
    if (nextMaxInterval !== config.maximumInterval) update.maximumInterval = nextMaxInterval;
    if (drafts.enableFuzz !== config.enableFuzz) update.enableFuzz = drafts.enableFuzz;
    if (drafts.buryNewSiblings !== config.buryNewSiblings) update.buryNewSiblings = drafts.buryNewSiblings;
    if (drafts.buryReviewSiblings !== config.buryReviewSiblings) {
      update.buryReviewSiblings = drafts.buryReviewSiblings;
    }
    if (drafts.reviewOrder !== config.reviewOrder) update.reviewOrder = drafts.reviewOrder;
    if (drafts.newReviewOrder !== config.newReviewOrder) update.newReviewOrder = drafts.newReviewOrder;
    if (nextMaxAnswer !== config.maxAnswerSeconds) update.maxAnswerSeconds = nextMaxAnswer;
  }
  const dirty = Object.keys(update).length > 0;

  const handleSave = useCallback(async () => {
    if (!dirty) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const parsed = parseSchedulerConfig(
        await invoke<unknown>('fsrs_update_scheduler_config', { update }),
      );
      if (!mountedRef.current) return;
      if (!parsed) throw new Error(t('settings.scheduler.saveFailed'));
      applyConfig(parsed);
      setNotice('saved');
      // 限额与日切影响今日到期数：通知 Today / 统计屏刷新
      requestFlashcardsDueRefresh();
    } catch (saveError) {
      if (mountedRef.current) {
        setError(getErrorMessage(saveError) || t('settings.scheduler.saveFailed'));
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
    // update 每次渲染重建；dirty 与之同源
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, JSON.stringify(update), applyConfig, t]);

  const checkboxField = (key: 'enableFuzz' | 'buryNewSiblings' | 'buryReviewSiblings', label: string) => (
    <label className="flex min-h-8 items-center gap-2 text-xs font-medium text-muted-foreground">
      <Checkbox
        checked={drafts?.[key] ?? false}
        disabled={saving}
        onCheckedChange={(checked) => setDraft(key, checked === true)}
      />
      <span className="min-w-0 leading-snug">{label}</span>
    </label>
  );

  const selectField = <K extends 'reviewOrder' | 'newReviewOrder'>(
    key: K,
    label: string,
    options: readonly Drafts[K][],
    optionLabel: (value: Drafts[K]) => string,
  ) => (
    <div className={LABEL_CLASS}>
      {label}
      <Select
        value={drafts?.[key]}
        disabled={saving}
        onValueChange={(value) => setDraft(key, value as Drafts[K])}
      >
        <SelectTrigger className="h-8 w-full text-sm" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>{optionLabel(option)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const textField = (
    key: keyof Drafts,
    label: string,
    inputMode: 'numeric' | 'decimal' | 'text' = 'numeric',
    className = INPUT_CLASS,
    inputRef?: React.RefObject<HTMLInputElement | null>,
  ) => (
    <label className={LABEL_CLASS}>
      {label}
      <Input
        ref={inputRef}
        inputMode={inputMode}
        value={String(drafts?.[key] ?? '')}
        disabled={saving}
        onChange={(event) => setDraft(key, event.target.value as never)}
        className={className}
      />
    </label>
  );

  const hasAdvancedError = learnAheadInvalid || stepsInvalid || rolloverInvalid || maxIntervalInvalid || maxAnswerInvalid;
  const showAdvanced = advancedOpen || hasAdvancedError;

  const content = unavailable ? (
    <p className="wb-fcx-note">{t('settings.scheduler.unavailable')}</p>
  ) : !config || !drafts ? (
    <p className="wb-fcx-note">{t('settings.scheduler.loading')}</p>
  ) : (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div className="text-xs font-semibold text-foreground">
          {t('settings.scheduler.basicGroup')}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {textField('newPerDay', t('settings.scheduler.newPerDay'), 'numeric', INPUT_CLASS, newPerDayInputRef)}
          {textField('reviewsPerDay', t('settings.scheduler.reviewsPerDay'))}
          {textField('retention', t('settings.scheduler.desiredRetention'), 'decimal')}
        </div>
        <p className="wb-fcx-footnote">{t('settings.scheduler.retentionHint')}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="fsrs-scheduler-order">
          {selectField('reviewOrder', t('settings.scheduler.reviewOrder'), REVIEW_ORDERS,
            (value) => t(`settings.scheduler.reviewOrders.${value}`))}
          {selectField('newReviewOrder', t('settings.scheduler.newReviewOrder'), NEW_REVIEW_ORDERS,
            (value) => t(`settings.scheduler.newReviewOrders.${value}`))}
        </div>
      </div>

      <div className="border-t border-border/60 pt-3">
        <DsButton
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={showAdvanced}
          onClick={() => setAdvancedOpen((prev) => !prev)}
          data-testid="fsrs-scheduler-advanced-toggle"
          className="h-7 -ml-1.5 px-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {showAdvanced ? <CaretUp size={13} aria-hidden="true" /> : <CaretDown size={13} aria-hidden="true" />}
          <span>{showAdvanced ? t('settings.scheduler.collapseAdvanced') : t('settings.scheduler.expandAdvanced')}</span>
        </DsButton>

        {showAdvanced ? (
          <div className="mt-3 flex flex-col gap-3" data-testid="fsrs-scheduler-advanced">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="fsrs-scheduler-steps">
              {textField('learningSteps', t('settings.scheduler.learningSteps'), 'text')}
              {textField('relearningSteps', t('settings.scheduler.relearningSteps'), 'text')}
              {textField('learnAhead', t('settings.scheduler.learnAheadMinutes'))}
              {textField('rollover', t('settings.scheduler.dayRolloverHour'))}
              {textField('maximumInterval', t('settings.scheduler.maximumInterval'))}
              {textField('maxAnswerSeconds', t('settings.scheduler.maxAnswerSeconds'))}
            </div>
            <div className="flex flex-col gap-1.5">
              {checkboxField('enableFuzz', t('settings.scheduler.enableFuzz'))}
              {checkboxField('buryNewSiblings', t('settings.scheduler.buryNewSiblings'))}
              {checkboxField('buryReviewSiblings', t('settings.scheduler.buryReviewSiblings'))}
            </div>
            <p className="wb-fcx-footnote">{t('settings.scheduler.stepsHint')}</p>
            <p className="wb-fcx-footnote">{t('settings.scheduler.rolloverHint')}</p>
            <p className="wb-fcx-footnote">{t('settings.scheduler.orderHint')}</p>
            {nextLearningSteps && nextRelearningSteps
              && (hasDayLongStep(nextLearningSteps) || hasDayLongStep(nextRelearningSteps)) ? (
                <p role="status" className="text-xs text-warning">
                  {t('settings.scheduler.longStepWarning')}
                </p>
              ) : null}
            {config.model !== 'fsrs-7' && (
              <FsrsOptimizerPanel
                fsrsParams={config.fsrsParams}
                optimizedAtMs={config.fsrsOptimizedAtMs}
                optimizedReviewCount={config.fsrsOptimizedReviewCount}
                onConfigChanged={applyConfig}
                disabled={saving}
              />
            )}
          </div>
        ) : null}
      </div>

      {learnAheadInvalid ? (
        <p role="status" className="text-xs text-destructive">
          {t('settings.scheduler.invalidLearnAhead')}
        </p>
      ) : null}
      {limitsInvalid ? (
        <p role="status" className="text-xs text-destructive">
          {t('settings.scheduler.invalidLimit', { max: LIMIT_MAX })}
        </p>
      ) : null}
      {!limitsInvalid && retentionInvalid ? (
        <p role="status" className="text-xs text-destructive">
          {t('settings.scheduler.invalidRetention', {
            min: RETENTION_MIN,
            max: RETENTION_MAX,
          })}
        </p>
      ) : null}
      {stepsInvalid ? (
        <p role="status" className="text-xs text-destructive">
          {t('settings.scheduler.invalidSteps')}
        </p>
      ) : null}
      {rolloverInvalid ? (
        <p role="status" className="text-xs text-destructive">
          {t('settings.scheduler.invalidRollover')}
        </p>
      ) : null}
      {maxAnswerInvalid ? (
        <p role="status" className="text-xs text-destructive">
          {t('settings.scheduler.invalidMaxAnswerSeconds')}
        </p>
      ) : null}
      {maxIntervalInvalid ? (
        <p role="status" className="text-xs text-destructive">
          {t('settings.scheduler.invalidMaximumInterval', { max: MAX_INTERVAL_DAYS })}
        </p>
      ) : null}
      {error ? (
        <p role="status" className="text-xs text-destructive">{error}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-border/60 pt-3">
        <DsButton
          type="button"
          variant="ghost"
          size="sm"
          disabled={saving || !dirty}
          onClick={() => void handleSave()}
          className={cn(
            'rounded-xl border border-primary/40 bg-primary/15 px-4 text-xs font-medium text-primary hover:bg-primary/25',
            'disabled:border-border/50 disabled:bg-muted/40 disabled:text-muted-foreground',
          )}
        >
          {t('settings.scheduler.save')}
        </DsButton>
        {notice === 'saved' ? (
          <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
            <CheckCircle size={13} aria-hidden="true" />
            {t('settings.scheduler.saved')}
          </span>
        ) : null}
      </div>
    </div>
  );

  return (
    <section
      className={cn('wb-fcx-panel', flushTop && 'border-t-0 pt-0')}
      data-testid="fsrs-scheduler-settings"
    >
      <div className="wb-fcx-panel-head">
        <h3 className="wb-fcx-panel-title">
          <GearSix size={14} weight="duotone" />
          {t('settings.scheduler.title')}
        </h3>
        <p className="wb-fcx-panel-sub">{t('settings.scheduler.subtitle')}</p>
      </div>
      <div className="wb-fcx-panel-body">{content}</div>
    </section>
  );
};

export default SchedulerSettingsSection;
