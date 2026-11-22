import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle } from '@phosphor-icons/react';
import { dstu } from '@/dstu';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { DsButton } from '@/components/ui/DsButton';
import { learningPropsFromMetadata, localCalendarDate, readNoteLearningProps } from '../noteLearningProps';
import { NOTE_REVIEW_INTERVALS, rescheduleNoteReview } from '../noteReviewSchedule';

export interface NotesReviewCheckinBannerProps {
  noteId?: string;
  effectiveReadOnly: boolean;
  focusMode: boolean;
  /** Optional suppression flag (e.g. when a higher-priority top banner is active). */
  hidden?: boolean;
  /** Reports whether this note currently has a due review checkin eligible for display. */
  onDueChange?: (due: boolean) => void;
}

export const NotesReviewCheckinBanner: React.FC<NotesReviewCheckinBannerProps> = ({
  noteId,
  effectiveReadOnly,
  focusMode,
  hidden = false,
  onDueChange,
}) => {
  const { t } = useTranslation(['notes']);
  const [noteReviewDate, setNoteReviewDate] = useState<string | null>(null);
  const [reviewRescheduling, setReviewRescheduling] = useState(false);

  useEffect(() => {
    let active = true;
    setNoteReviewDate(null);
    if (!noteId || typeof dstu?.get !== 'function') return () => { active = false; };
    void dstu
      .get(`/${noteId}`)
      .then((res) => {
        if (!active || !res?.ok || !res.value) return;
        const { reviewDate } = readNoteLearningProps(learningPropsFromMetadata(res.value.metadata));
        setNoteReviewDate(reviewDate ?? null);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [noteId]);

  const handleCompleteNoteReview = useCallback(
    (days: number | null) => {
      if (!noteId || reviewRescheduling || effectiveReadOnly) return;
      setReviewRescheduling(true);
      void rescheduleNoteReview(noteId, days)
        .then((nextDate) => {
          setNoteReviewDate(nextDate);
          showGlobalNotification(
            'success',
            nextDate
              ? t('notes:learning.review_done.scheduled', {
                  defaultValue: '已安排下次复习：{{date}}',
                  date: nextDate,
                })
              : t('notes:learning.review_done.cleared', { defaultValue: '已标记为掌握' }),
          );
        })
        .catch((error: unknown) => {
          showGlobalNotification(
            'error',
            t('notes:learning.review_done.failed', {
              defaultValue: '更新复习计划失败：{{error}}',
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        })
        .finally(() => {
          setReviewRescheduling(false);
        });
    },
    [noteId, reviewRescheduling, effectiveReadOnly, t],
  );

  const todayCalendarDate = localCalendarDate();
  const isNoteReviewDue = Boolean(noteReviewDate && noteReviewDate <= todayCalendarDate);
  const effectiveDue = Boolean(noteId && isNoteReviewDue && !effectiveReadOnly && !focusMode);

  useEffect(() => {
    onDueChange?.(effectiveDue);
  }, [effectiveDue, onDueChange]);

  useEffect(() => () => {
    onDueChange?.(false);
  }, [onDueChange]);

  if (!effectiveDue || hidden) {
    return null;
  }

  return (
    <div
      className="notes-banner"
      role="status"
      data-testid="notes-review-checkin-bar"
    >
      <div className="notes-column notes-banner-row">
        <CheckCircle size={14} className="shrink-0 text-primary" aria-hidden="true" />
        <span className="text-xs text-foreground">
          {noteReviewDate && noteReviewDate < todayCalendarDate
            ? t('notes:learning.review_due_overdue', {
                defaultValue: '已到期复习（{{date}}）· 完成本次复习：',
                date: noteReviewDate,
              })
            : t('notes:learning.review_due_today', {
                defaultValue: '今日待复习 · 完成本次复习：',
              })}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {NOTE_REVIEW_INTERVALS.map((days) => (
            <DsButton
              key={days}
              variant="ghost"
              size="sm"
              disabled={reviewRescheduling}
              className="h-6 px-2 text-xs text-foreground hover:bg-muted [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
              data-testid={`notes-review-checkin-${days}d`}
              onClick={() => handleCompleteNoteReview(days)}
            >
              {t(`notes:learning.review_done.d${days}`, { defaultValue: `${days}天` })}
            </DsButton>
          ))}
          <DsButton
            variant="ghost"
            size="sm"
            disabled={reviewRescheduling}
            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
            data-testid="notes-review-checkin-mastered"
            onClick={() => handleCompleteNoteReview(null)}
          >
            {t('notes:learning.review_done.mastered', { defaultValue: '已掌握' })}
          </DsButton>
        </div>
      </div>
    </div>
  );
};
