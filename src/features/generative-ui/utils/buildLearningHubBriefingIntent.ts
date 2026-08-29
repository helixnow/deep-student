import type { GenerativeUIIntent } from '../types';

export interface LearningHubBriefingListItem {
  label: string;
  description?: string;
  badge?: string;
}

export interface LearningHubReviewDay {
  date: string;
  dueCount: number;
  label?: string;
  completedCount?: number;
}

export interface LearningHubBriefingInput {
  resourceCount?: number;
  folderLabel?: string;
  dueReviewCount?: number;
  reviewDays?: LearningHubReviewDay[];
  recentResources?: LearningHubBriefingListItem[];
  labels: {
    statTitle: string;
    emptyTrend: string;
    activeTrend: string;
    startReview: string;
    openQbank: string;
    dueReviewTitle?: string;
    dueReviewTrend?: string;
    reviewCalendarTitle?: string;
    recentListTitle?: string;
    recentEmpty?: string;
    emptyAlertTitle?: string;
    emptyAlertDescription?: string;
    pathStepsTitle?: string;
    stepReview?: string;
    stepQbank?: string;
    chartTitle?: string;
    chartDue?: string;
    chartSeries?: string;
  };
}

export function buildLearningHubBriefingIntent(input: LearningHubBriefingInput): GenerativeUIIntent {
  const { resourceCount = 0, folderLabel, dueReviewCount, reviewDays, recentResources = [], labels } = input;
  const isEmpty = resourceCount === 0;
  const listItems = recentResources
    .filter((item) => item.label.trim().length > 0)
    .slice(0, 8)
    .map((item) => ({
      label: item.label.slice(0, 200),
      ...(item.description ? { description: item.description.slice(0, 300) } : {}),
      ...(item.badge ? { badge: item.badge.slice(0, 40) } : {}),
    }));
  const calendarDays = (reviewDays ?? [])
    .filter((day) => day.date.trim().length > 0 && day.dueCount >= 0)
    .slice(0, 14);
  const reviewStatus =
    dueReviewCount != null && dueReviewCount > 0 ? 'active' : isEmpty ? 'pending' : 'done';
  const dueCategory = labels.chartDue ?? labels.dueReviewTitle ?? labels.startReview;
  const chartSeriesName = (labels.chartSeries ?? labels.dueReviewTrend ?? labels.startReview).slice(0, 40);

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
                title: labels.emptyAlertTitle ?? labels.emptyTrend,
                description: labels.emptyAlertDescription ?? folderLabel,
              },
            },
          ]
        : []),
      {
        type: 'stat-card',
        span: 1,
        props: {
          title: labels.statTitle,
          value: resourceCount,
          trend: resourceCount > 0 ? 'neutral' : 'down',
          trendLabel: resourceCount > 0 ? labels.activeTrend : labels.emptyTrend,
        },
      },
      {
        type: 'steps',
        span: 1,
        props: {
          title: labels.pathStepsTitle ?? labels.startReview,
          steps: [
            {
              label: labels.stepReview ?? labels.startReview,
              status: reviewStatus,
              ...(dueReviewCount != null ? { description: String(dueReviewCount) } : {}),
            },
            {
              label: labels.stepQbank ?? labels.openQbank,
              status: 'pending',
            },
          ],
        },
      },
      ...(dueReviewCount != null
        ? [
            {
              type: 'stat-card' as const,
              span: 1 as const,
              props: {
                title: labels.dueReviewTitle ?? labels.startReview,
                value: dueReviewCount,
                trend: dueReviewCount > 0 ? ('up' as const) : ('neutral' as const),
                trendLabel: dueReviewCount > 0 ? (labels.dueReviewTrend ?? labels.activeTrend) : labels.emptyTrend,
              },
            },
          ]
        : []),
      ...(calendarDays.length > 0
        ? [
            {
              type: 'chart' as const,
              span: 2 as const,
              props: {
                title: labels.chartTitle ?? labels.reviewCalendarTitle ?? labels.dueReviewTitle ?? labels.startReview,
                kind: 'bar' as const,
                categories: calendarDays.map((day) => day.label ?? day.date).slice(0, 24),
                series: [
                  {
                    name: chartSeriesName,
                    values: calendarDays.map((day) => day.dueCount),
                  },
                ],
              },
            },
            {
              type: 'review-calendar' as const,
              span: 2 as const,
              props: {
                title: labels.reviewCalendarTitle,
                days: calendarDays,
              },
            },
          ]
        : dueReviewCount != null
          ? [
              {
                type: 'chart' as const,
                span: 2 as const,
                props: {
                  title: labels.chartTitle ?? labels.dueReviewTitle ?? labels.startReview,
                  kind: 'bar' as const,
                  categories: [dueCategory],
                  series: [
                    {
                      name: chartSeriesName,
                      values: [dueReviewCount],
                    },
                  ],
                },
              },
            ]
          : []),
      {
        type: 'list',
        span: 2,
        props: {
          title: labels.recentListTitle ?? labels.statTitle,
          items: listItems,
          emptyLabel: labels.recentEmpty ?? labels.emptyTrend,
        },
      },
      {
        type: 'action-bar',
        span: 2,
        props: {
          actions: [
            { id: 'open-qbank', label: labels.openQbank, variant: 'default', riskLevel: 'low' },
            { id: 'start-review', label: labels.startReview, variant: 'primary', riskLevel: 'low' },
          ],
        },
      },
    ],
    ...(folderLabel ? { meta: { description: folderLabel } } : {}),
  };
}
