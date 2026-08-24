import type { GenerativeUIIntent } from '../types';

export interface LearningHubBriefingInput {
  resourceCount?: number;
  folderLabel?: string;
}

export function buildLearningHubBriefingIntent(input: LearningHubBriefingInput): GenerativeUIIntent {
  const { resourceCount = 0, folderLabel = '当前目录' } = input;

  return {
    version: '1',
    meta: {
      title: '资源库概览',
      description: folderLabel,
    },
    blocks: [
      {
        type: 'stat-card',
        props: {
          title: '可见资源',
          value: resourceCount,
          trend: resourceCount > 0 ? 'neutral' : 'down',
          trendLabel: resourceCount > 0 ? '可继续探索' : '目录为空',
        },
      },
      {
        type: 'action-bar',
        props: {
          actions: [
            { id: 'open-qbank', label: '打开题库', variant: 'default', riskLevel: 'low' },
            { id: 'start-review', label: '开始复习', variant: 'primary', riskLevel: 'low' },
          ],
        },
      },
    ],
  };
}
