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
  emptyBankTitle?: string;
  emptyBankDescription?: string;
  mistakeSuggestion?: string;
  statusListTitle?: string;
  inProgressRow?: string;
  newCountRow?: string;
  statusEmpty?: string;
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
  const errorRate = Math.min(100, Math.max(0, Math.round((1 - stats.correctRate) * 100)));
  const isEmpty = stats.total === 0;

  const reviewActions =
    stats.review > 0
      ? [{ id: 'start-review', label: labels.startReview, variant: 'primary' as const, riskLevel: 'low' as const }]
      : [];

  const statusItems = [
    { label: labels.reviewRow, badge: String(stats.review) },
    ...(labels.inProgressRow
      ? [{ label: labels.inProgressRow, badge: String(stats.inProgress) }]
      : []),
    ...(labels.newCountRow
      ? [{ label: labels.newCountRow, badge: String(stats.newCount) }]
      : []),
  ];

  return {
    version: '1',
    blocks: [
      ...(isEmpty
        ? [
            {
              type: 'alert' as const,
              props: {
                variant: 'info' as const,
                title: labels.emptyBankTitle ?? labels.emptyTrend,
                description: labels.emptyBankDescription,
              },
            },
          ]
        : []),
      {
        type: 'stat-card',
        props: {
          title: labels.totalTitle,
          value: stats.total,
          trend: isEmpty ? 'down' : masteryRatio >= 0.5 ? 'up' : 'neutral',
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
      ...(!isEmpty && stats.review > 0
        ? [
            {
              type: 'mistake-analysis' as const,
              props: {
                topic: examName?.trim() || labels.totalTitle,
                errorRate,
                mistakeCount: stats.review,
                suggestion: labels.mistakeSuggestion ?? labels.startReview,
                severity: errorRate >= 50 ? ('high' as const) : errorRate >= 25 ? ('medium' as const) : ('low' as const),
              },
            },
          ]
        : []),
      {
        type: 'list',
        props: {
          title: labels.statusListTitle ?? labels.reviewRow,
          items: isEmpty ? [] : statusItems,
          emptyLabel: labels.statusEmpty ?? labels.emptyTrend,
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
