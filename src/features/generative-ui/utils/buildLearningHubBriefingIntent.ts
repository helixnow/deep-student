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

  return {
    version: '1',
    blocks: [
      ...(isEmpty
        ? [
            {
              type: 'alert' as const,
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
        props: {
          title: labels.statTitle,
          value: resourceCount,
          trend: resourceCount > 0 ? 'neutral' : 'down',
          trendLabel: resourceCount > 0 ? labels.activeTrend : labels.emptyTrend,
        },
      },
      ...(dueReviewCount != null
        ? [
            {
              type: 'stat-card' as const,
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
              type: 'review-calendar' as const,
              props: {
                title: labels.reviewCalendarTitle,
                days: calendarDays,
              },
            },
          ]
        : []),
      {
        type: 'list',
        props: {
          title: labels.recentListTitle ?? labels.statTitle,
          items: listItems,
          emptyLabel: labels.recentEmpty ?? labels.emptyTrend,
        },
      },
      {
        type: 'action-bar',
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
