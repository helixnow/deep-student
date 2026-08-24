import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkle } from '@phosphor-icons/react';
import type { QuestionBankStats } from '@/api/questionBankApi';
import { GenerativeUIPanel } from '@/features/generative-ui/components/GenerativeUIPanel';
import { buildExamBriefingIntent } from '@/features/generative-ui/utils/buildExamBriefingIntent';
import { createExamBriefingActionHandlers } from '@/features/generative-ui/handlers/examBriefingActionHandlers';
import './ExamGenerativeBriefing.css';

export interface ExamGenerativeBriefingProps {
  stats: QuestionBankStats;
  examName?: string;
  onStartReview: () => void;
  onOpenPractice: () => void;
}

export const ExamGenerativeBriefing: React.FC<ExamGenerativeBriefingProps> = React.memo(
  ({ stats, examName, onStartReview, onOpenPractice }) => {
    const { t } = useTranslation(['generativeUi']);

    const labels = useMemo(
      () => ({
        totalTitle: t('generativeUi:exam.briefing.total_title'),
        masteryTrend: t('generativeUi:exam.briefing.mastery_trend'),
        emptyTrend: t('generativeUi:exam.briefing.empty_trend'),
        progressTitle: t('generativeUi:exam.briefing.progress_title'),
        masteredRow: t('generativeUi:exam.briefing.mastered_row'),
        reviewRow: t('generativeUi:exam.briefing.review_row'),
        correctRateRow: t('generativeUi:exam.briefing.correct_rate_row'),
        startReview: t('generativeUi:exam.briefing.start_review'),
        openPractice: t('generativeUi:exam.briefing.open_practice'),
      }),
      [t],
    );

    const intent = useMemo(
      () => buildExamBriefingIntent({ stats, examName, labels }),
      [examName, labels, stats],
    );

    const actionHandlers = useMemo(
      () =>
        createExamBriefingActionHandlers(
          { onStartReview, onOpenPractice },
          { startReview: labels.startReview, openPractice: labels.openPractice },
        ),
      [labels.openPractice, labels.startReview, onOpenPractice, onStartReview],
    );

    return (
      <section
        className="exam-generative-briefing"
        data-testid="exam-generative-briefing"
        aria-label={t('generativeUi:exam.briefing_label')}
      >
        <header className="exam-generative-briefing-header">
          <Sparkle className="h-3.5 w-3.5 text-primary" weight="fill" aria-hidden />
          {t('generativeUi:exam.briefing_label')}
        </header>
        <GenerativeUIPanel intent={intent} showChrome={false} actionHandlers={actionHandlers} />
      </section>
    );
  },
);

ExamGenerativeBriefing.displayName = 'ExamGenerativeBriefing';

export default ExamGenerativeBriefing;
