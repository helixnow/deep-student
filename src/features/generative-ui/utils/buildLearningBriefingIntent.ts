import type { GenerativeUIIntent } from '../types';

export interface LearningBriefingInput {
  dueFlashcards?: number;
  pendingTodos?: number;
  overdueTodos?: number;
}

export function buildLearningBriefingIntent(input: LearningBriefingInput): GenerativeUIIntent {
  const { dueFlashcards = 0, pendingTodos = 0, overdueTodos = 0 } = input;

  return {
    version: '1',
    meta: {
      title: '今日学习简报',
      description: '基于待办与闪卡到期数据',
    },
    blocks: [
      {
        type: 'stat-card',
        props: {
          title: '到期闪卡',
          value: dueFlashcards,
          trend: dueFlashcards > 0 ? 'up' : 'neutral',
          trendLabel: dueFlashcards > 0 ? '待复习' : '暂无到期',
        },
      },
      {
        type: 'progress',
        props: {
          title: '待办进度',
          current: Math.max(0, pendingTodos - overdueTodos),
          total: Math.max(pendingTodos, 1),
          label: overdueTodos > 0 ? `${overdueTodos} 项逾期` : `${pendingTodos} 项待办`,
        },
      },
      {
        type: 'action-bar',
        props: {
          actions: [
            { id: 'start-review', label: '开始复习', variant: 'primary', riskLevel: 'low' },
            { id: 'open-qbank', label: '打开题库', variant: 'default', riskLevel: 'low' },
          ],
        },
      },
    ],
  };
}
