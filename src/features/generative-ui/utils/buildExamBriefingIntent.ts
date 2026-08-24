import type { QuestionBankStats } from '@/api/questionBankApi';
import type { GenerativeUIIntent } from '../types';

export interface ExamBriefingLabels {
  totalTitle: string;
  masteryTrend: string;
  emptyTrend: string;
  progressTitle: string;
  masteredRow: string;
  reviewRow: string;
  correctRateRow: string;
  startReview: string;
  openPractice: string;
}

export interface ExamBriefingInput {
  stats: QuestionBankStats;
  examName?: string;
  labels: ExamBriefingLabels;
}

export function buildExamBriefingIntent(input: ExamBriefingInput): GenerativeUIIntent {
  const { stats, examName, labels } = input;
  const masteryRatio = stats.total > 0 ? stats.mastered / stats.total : 0;
  const masteryPercent = Math.round(masteryRatio * 100);
  const correctPercent = Math.round(stats.correctRate * 100);

  const reviewActions =
    stats.review > 0
      ? [{ id: 'start-review', label: labels.startReview, variant: 'primary' as const, riskLevel: 'low' as const }]
      : [];

  return {
    version: '1',
    blocks: [
      {
        type: 'stat-card',
        props: {
          title: labels.totalTitle,
          value: stats.total,
          trend: stats.total === 0 ? 'down' : masteryRatio >= 0.5 ? 'up' : 'neutral',
          trendLabel:
            stats.total > 0
              ? labels.masteryTrend.replace('{{percent}}', String(masteryPercent))
              : labels.emptyTrend,
        },
      },
      {
        type: 'progress',
        props: {
          title: labels.progressTitle,
          current: stats.mastered,
          total: Math.max(stats.total, 1),
          label: labels.masteredRow.replace('{{count}}', String(stats.mastered)),
        },
      },
      {
        type: 'key-value-grid',
        props: {
          rows: [
            { key: labels.reviewRow, value: String(stats.review) },
            { key: labels.correctRateRow, value: `${correctPercent}%` },
          ],
        },
      },
      {
        type: 'action-bar',
        props: {
          actions: [
            ...reviewActions,
            {
              id: 'open-practice',
              label: labels.openPractice,
              variant: reviewActions.length > 0 ? ('default' as const) : ('primary' as const),
              riskLevel: 'low' as const,
            },
          ],
        },
      },
    ],
    ...(examName ? { meta: { description: examName } } : {}),
  };
}
