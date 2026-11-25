import React from 'react';
import { useTranslation } from 'react-i18next';
import { Trophy, Confetti, ArrowClockwise } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { formatTime } from '@/utils/formatUtils';
import { practiceAccuracyPercent } from '@/stores/questionBankStore';

export interface QuestionCompletionStats {
  totalAnswered: number;
  correctCount: number;
  totalTime: number;
}

export interface QuestionCompletionCardProps {
  stats: QuestionCompletionStats;
  onRestart: () => void;
  onDismiss: () => void;
}

/** 完成庆祝（内联卡片，随内容滚动，不使用遮罩层） */
export const QuestionCompletionCard: React.FC<QuestionCompletionCardProps> = ({
  stats,
  onRestart,
  onDismiss,
}) => {
  const { t } = useTranslation('practice');
  const correctRate = practiceAccuracyPercent(stats.correctCount, stats.totalAnswered);

  return (
    <div className="ui-rise-in p-4 rounded-md bg-card border border-border/50 shadow-sm text-center space-y-3">
      <div className="flex justify-center">
        <div className="p-2 rounded-md bg-warning/10">
          <Trophy size={24} className="text-warning qbank-anim-pop" />
        </div>
      </div>
      <div>
        <h2 className="text-lg font-semibold flex items-center justify-center gap-2">
          <Confetti size={16} className="text-warning" />
          {t('editor.congratulations')}
          <Confetti size={16} className="text-warning" />
        </h2>
        <p className="text-muted-foreground mt-1">{t('editor.completedMessage')}</p>
      </div>
      <div className="grid grid-cols-3 gap-2 py-2">
        <div className="p-2 rounded-md bg-muted/50">
          <div className="text-lg font-semibold">{stats.totalAnswered}</div>
          <div className="text-xs text-muted-foreground">{t('editor.answeredCount')}</div>
        </div>
        <div className="p-2 rounded-md bg-success/10">
          <div className="text-lg font-semibold text-success">{correctRate}%</div>
          <div className="text-xs text-success">{t('editor.correctRate')}</div>
        </div>
        <div className="p-2 rounded-md bg-primary/10">
          <div className="text-lg font-semibold text-primary">{formatTime(stats.totalTime)}</div>
          <div className="text-xs text-primary">{t('editor.timeSpent')}</div>
        </div>
      </div>
      <div className="flex gap-2">
        <DsButton
          variant="outline"
          className="flex-1"
          onClick={onRestart}
        >
          <ArrowClockwise size={16} className="mr-1" />
          {t('editor.restart')}
        </DsButton>
        <DsButton
          className="flex-1"
          onClick={onDismiss}
        >
          {t('editor.viewQuestions')}
        </DsButton>
      </div>
    </div>
  );
};
