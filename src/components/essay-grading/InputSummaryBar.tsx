import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, CircleNotch, GraduationCap, PencilSimple, Plus, Robot } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import type { EssayTextStats } from '@/essay-grading/textStats';
import { useInlineConfirm } from './useInlineConfirm';

interface InputSummaryBarProps {
  modeName?: string;
  modelName?: string;
  textStats: EssayTextStats;
  isGrading: boolean;
  canGrade: boolean;
  onExpand: () => void;
  onGrade: () => void;
  onCancelGrading: () => void;
  onOpenCustomRubric?: () => void;
}

/** 结果优先布局：开始批改后原文收成一行摘要，高度让给批改结果 */
export const InputSummaryBar: React.FC<InputSummaryBarProps> = ({
  modeName,
  modelName,
  textStats,
  isGrading,
  canGrade,
  onExpand,
  onGrade,
  onCancelGrading,
  onOpenCustomRubric,
}) => {
  const { t } = useTranslation(['essay_grading', 'common']);
  const cancelConfirm = useInlineConfirm(onCancelGrading);
  const resetCancel = cancelConfirm.reset;
  useEffect(() => {
    resetCancel();
  }, [isGrading, resetCancel]);

  const length = textStats.englishWords >= textStats.hanChars
    ? t('essay_grading:input_summary.word_count', { count: textStats.englishWords })
    : t('essay_grading:input_summary.han_count', { count: textStats.hanChars });

  return (
    <div
      className="essay-summary-bar flex min-h-[38px] shrink-0 items-center gap-1 border-b border-border/25 bg-foreground/[0.015] px-2 py-0.5 sm:gap-1.5 sm:px-4"
      data-essay-input-summary
    >
      <div className="essay-summary-bar-inner flex min-w-0 flex-1 items-center gap-3 text-xs text-muted-foreground">
        {modeName && (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-sm text-foreground/80" title={modeName}>
            <GraduationCap size={14} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{modeName}</span>
          </span>
        )}
        {onOpenCustomRubric && !isGrading && (
          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            data-testid="essay-summary-custom-rubric-button"
            onClick={onOpenCustomRubric}
            aria-label={t('essay_grading:mode.manage_custom_rubric')}
            title={t('essay_grading:mode.manage_custom_rubric')}
            className="h-6 shrink-0 rounded-full border border-border/45 px-2 text-[11px] text-muted-foreground hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
          >
            <Plus size={11} className="shrink-0" />
            <span className="essay-summary-btn-label hidden sm:inline">{t('essay_grading:mode.manage_custom_rubric_short')}</span>
          </DsButton>
        )}
        {modelName && (
          <span className="essay-summary-model hidden min-w-0 items-center gap-1.5 sm:inline-flex" title={modelName}>
            <Robot size={13} className="shrink-0" />
            <span className="min-w-0 truncate">{modelName}</span>
          </span>
        )}
        <span className="shrink-0 tabular-nums">{length}</span>
      </div>

      <DsButton
        variant="ghost"
        size="sm"
        onClick={onExpand}
        aria-label={isGrading ? t('essay_grading:input_summary.view') : t('essay_grading:input_summary.edit')}
        title={isGrading ? t('essay_grading:input_summary.view') : t('essay_grading:input_summary.edit')}
        className="h-7 shrink-0 px-2 text-muted-foreground/70 hover:bg-[var(--interactive-hover)] hover:text-foreground"
      >
        <PencilSimple size={14} />
        <span className="essay-summary-btn-label hidden text-xs sm:inline">
          {isGrading ? t('essay_grading:input_summary.view') : t('essay_grading:input_summary.edit')}
        </span>
      </DsButton>

      {isGrading ? (
        cancelConfirm.armed ? (
          <DsButton
            variant="destructive"
            size="sm"
            onClick={cancelConfirm.handleClick}
            className="h-7 shrink-0 px-2 text-xs"
          >
            {t('essay_grading:confirm.cancel')}
          </DsButton>
        ) : (
          <DsButton
            variant="ghost"
            size="sm"
            onClick={cancelConfirm.handleClick}
            aria-label={t('common:aria.cancel_grading')}
            title={t('common:aria.cancel_grading')}
            className="h-7 shrink-0 px-2 text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground"
          >
            <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" />
            <span className="essay-summary-btn-label hidden text-xs sm:inline">{t('common:cancel')}</span>
          </DsButton>
        )
      ) : (
        <DsButton
          variant="ghost"
          size="sm"
          onClick={onGrade}
          disabled={!canGrade}
          aria-label={t('essay_grading:input_summary.regrade')}
          title={t('essay_grading:input_summary.regrade')}
          className="h-7 shrink-0 px-2 text-muted-foreground/70 hover:bg-[var(--interactive-hover)] hover:text-foreground"
        >
          <ArrowClockwise size={14} />
          <span className="essay-summary-btn-label hidden text-xs sm:inline">{t('essay_grading:input_summary.regrade')}</span>
        </DsButton>
      )}
    </div>
  );
};
