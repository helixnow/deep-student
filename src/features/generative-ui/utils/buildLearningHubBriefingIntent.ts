import type { GenerativeUIIntent } from '../types';

export interface LearningHubBriefingInput {
  resourceCount?: number;
  folderLabel?: string;
  labels: {
    statTitle: string;
    emptyTrend: string;
    activeTrend: string;
    startReview: string;
    openQbank: string;
  };
}

export function buildLearningHubBriefingIntent(input: LearningHubBriefingInput): GenerativeUIIntent {
  const { resourceCount = 0, folderLabel, labels } = input;

  return {
    version: '1',
    blocks: [
      {
        type: 'stat-card',
        props: {
          title: labels.statTitle,
          value: resourceCount,
          trend: resourceCount > 0 ? 'neutral' : 'down',
          trendLabel: resourceCount > 0 ? labels.activeTrend : labels.emptyTrend,
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
