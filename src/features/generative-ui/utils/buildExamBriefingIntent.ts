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
  tableTitle?: string;
  tableMetricColumn?: string;
  tableValueColumn?: string;
  chartTitle?: string;
  chartSeries?: string;
  masteredCategory?: string;
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

  const masteredCategory =
    (labels.masteredCategory ?? labels.masteredRow.replace('{{count}}', '').trim()) ||
    labels.progressTitle;
  const inProgressLabel = labels.inProgressRow ?? labels.progressTitle;

  return {
    version: '1.1',
    layout: { mode: 'grid', columns: 2 },
    blocks: [
      ...(isEmpty
        ? [
            {
              type: 'alert' as const,
              span: 2 as const,
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
        span: 1,
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
      ...(!isEmpty
        ? [
            {
              type: 'chart' as const,
              span: 1 as const,
              props: {
                title: labels.chartTitle ?? labels.progressTitle,
                kind: 'bar' as const,
                categories: [masteredCategory, labels.reviewRow, inProgressLabel],
                series: [
                  {
                    name: (labels.chartSeries ?? labels.totalTitle).slice(0, 40),
                    values: [stats.mastered, stats.review, stats.inProgress],
                  },
                ],
              },
            },
          ]
        : []),
      {
        type: 'progress',
        span: 2,
        props: {
          title: labels.progressTitle,
          current: stats.mastered,
          total: Math.max(stats.total, 1),
          label: labels.masteredRow.replace('{{count}}', String(stats.mastered)),
        },
      },
      ...(!isEmpty
        ? [
            {
              type: 'table' as const,
              span: 2 as const,
              props: {
                title: labels.tableTitle ?? labels.statusListTitle ?? labels.progressTitle,
                columns: [
                  { key: 'metric', label: labels.tableMetricColumn ?? labels.progressTitle },
                  {
                    key: 'value',
                    label: labels.tableValueColumn ?? labels.totalTitle,
                    align: 'right' as const,
                  },
                ],
                rows: [
                  {
                    metric: labels.masteredRow.replace('{{count}}', String(stats.mastered)),
                    value: stats.mastered,
                  },
                  { metric: labels.reviewRow, value: stats.review },
                  { metric: labels.correctRateRow, value: `${correctPercent}%` },
                ],
              },
            },
          ]
        : []),
      {
        type: 'key-value-grid',
        span: 2,
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
              span: 2 as const,
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
        span: 2,
        props: {
          title: labels.statusListTitle ?? labels.reviewRow,
          items: isEmpty ? [] : statusItems,
          emptyLabel: labels.statusEmpty ?? labels.emptyTrend,
        },
      },
      {
        type: 'action-bar',
        span: 2,
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
