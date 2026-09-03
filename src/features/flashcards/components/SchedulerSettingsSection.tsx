/**
 * FSRS 调度设置区（settings tab）：每日新卡上限 / 每日复习上限 / 目标保持率。
 * 读写后端 fsrs_get_scheduler_config / fsrs_update_scheduler_config（默认牌组）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { CheckCircle, GearSix } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { getErrorMessage } from '@/utils/errorUtils';
import { requestFlashcardsDueRefresh } from '../events';

interface SchedulerConfig {
  newPerDay: number;
  reviewsPerDay: number;
  desiredRetention: number;
}

const LIMIT_MAX = 9999;
const RETENTION_MIN = 0.5;
const RETENTION_MAX = 0.99;

function parseConfig(raw: unknown): SchedulerConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const readNumber = (camel: string, snake: string): number | null => {
    const value = row[camel] ?? row[snake];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const newPerDay = readNumber('newPerDay', 'new_per_day');
  const reviewsPerDay = readNumber('reviewsPerDay', 'reviews_per_day');
  const desiredRetention = readNumber('desiredRetention', 'desired_retention');
  if (newPerDay == null || reviewsPerDay == null || desiredRetention == null) return null;
  return { newPerDay, reviewsPerDay, desiredRetention };
}

function parseLimitInput(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= LIMIT_MAX ? parsed : null;
}

function parseRetentionInput(value: string): number | null {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.round(parsed * 1000) / 1000;
  return rounded >= RETENTION_MIN && rounded <= RETENTION_MAX ? rounded : null;
}

export const SchedulerSettingsSection: React.FC = () => {
  const { t } = useTranslation('flashcards');
  const [config, setConfig] = useState<SchedulerConfig | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [draftNew, setDraftNew] = useState('');
  const [draftReviews, setDraftReviews] = useState('');
  const [draftRetention, setDraftRetention] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<'saved' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      try {
        const parsed = parseConfig(await invoke<unknown>('fsrs_get_scheduler_config'));
        if (!mountedRef.current) return;
        if (!parsed) {
          setUnavailable(true);
          return;
        }
        setConfig(parsed);
        setDraftNew(String(parsed.newPerDay));
        setDraftReviews(String(parsed.reviewsPerDay));
        setDraftRetention(String(parsed.desiredRetention));
      } catch {
        if (mountedRef.current) setUnavailable(true);
      }
    })();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const nextNew = parseLimitInput(draftNew);
  const nextReviews = parseLimitInput(draftReviews);
  const nextRetention = parseRetentionInput(draftRetention);
  const limitsInvalid = nextNew == null || nextReviews == null;
  const retentionInvalid = nextRetention == null;
  const dirty = config != null && !limitsInvalid && !retentionInvalid && (
    nextNew !== config.newPerDay
    || nextReviews !== config.reviewsPerDay
    || nextRetention !== config.desiredRetention
  );

  const handleSave = useCallback(async () => {
    if (!config || nextNew == null || nextReviews == null || nextRetention == null) return;
    const update: Record<string, number> = {};
    if (nextNew !== config.newPerDay) update.newPerDay = nextNew;
    if (nextReviews !== config.reviewsPerDay) update.reviewsPerDay = nextReviews;
    if (nextRetention !== config.desiredRetention) update.desiredRetention = nextRetention;
    if (Object.keys(update).length === 0) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const parsed = parseConfig(
        await invoke<unknown>('fsrs_update_scheduler_config', { update }),
      );
      if (!mountedRef.current) return;
      if (parsed) {
        setConfig(parsed);
        setDraftNew(String(parsed.newPerDay));
        setDraftReviews(String(parsed.reviewsPerDay));
        setDraftRetention(String(parsed.desiredRetention));
      }
      setNotice('saved');
      // 限额影响今日到期数：通知 Today / 统计屏刷新
      requestFlashcardsDueRefresh();
    } catch (saveError) {
      if (mountedRef.current) {
        setError(getErrorMessage(saveError) || t('settings.scheduler.saveFailed'));
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [config, nextNew, nextReviews, nextRetention, t]);

  return (
    <section className="wb-fcx-panel" data-testid="fsrs-scheduler-settings">
      <div className="wb-fcx-panel-head">
        <h3 className="wb-fcx-panel-title">
          <GearSix size={14} weight="duotone" />
          {t('settings.scheduler.title')}
        </h3>
        <p className="wb-fcx-panel-sub">{t('settings.scheduler.subtitle')}</p>
      </div>
      <div className="wb-fcx-panel-body">
        {unavailable ? (
          <p className="wb-fcx-note">{t('settings.scheduler.unavailable')}</p>
        ) : !config ? (
          <p className="wb-fcx-note">{t('settings.scheduler.loading')}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                {t('settings.scheduler.newPerDay')}
                <Input
                  inputMode="numeric"
                  value={draftNew}
                  disabled={saving}
                  onChange={(event) => {
                    setDraftNew(event.target.value);
                    setNotice(null);
                  }}
                  className="h-8 w-28 text-sm [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:text-[16px]"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                {t('settings.scheduler.reviewsPerDay')}
                <Input
                  inputMode="numeric"
                  value={draftReviews}
                  disabled={saving}
                  onChange={(event) => {
                    setDraftReviews(event.target.value);
                    setNotice(null);
                  }}
                  className="h-8 w-28 text-sm [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:text-[16px]"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                {t('settings.scheduler.desiredRetention')}
                <Input
                  inputMode="decimal"
                  value={draftRetention}
                  disabled={saving}
                  onChange={(event) => {
                    setDraftRetention(event.target.value);
                    setNotice(null);
                  }}
                  className="h-8 w-28 text-sm [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:text-[16px]"
                />
              </label>
              <DsButton
                type="button"
                variant="primary"
                size="sm"
                disabled={saving || !dirty}
                onClick={() => void handleSave()}
                className="text-xs [@media(pointer:coarse)]:!min-h-11"
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
            <p className="wb-fcx-footnote">{t('settings.scheduler.retentionHint')}</p>
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
            {error ? (
              <p role="status" className="text-xs text-destructive">{error}</p>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
};

export default SchedulerSettingsSection;
