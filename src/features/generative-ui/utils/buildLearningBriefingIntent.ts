import type { GenerativeUIIntent } from '../types';

export interface LearningBriefingInput {
  dueFlashcards?: number;
  pendingTodos?: number;
  overdueTodos?: number;
}

export interface LearningBriefingLabels {
  dueFlashcardsTitle: string;
  dueTrendDue: string;
  dueTrendNone: string;
  progressTitle: string;
  overdueLabel: string;
  pendingLabel: string;
  startReview: string;
  openQbank: string;
}

export function buildLearningBriefingIntent(
  input: LearningBriefingInput,
  labels: LearningBriefingLabels,
): GenerativeUIIntent {
  const { dueFlashcards = 0, pendingTodos = 0, overdueTodos = 0 } = input;

  return {
    version: '1',
    blocks: [
      {
        type: 'stat-card',
        props: {
          title: labels.dueFlashcardsTitle,
          value: dueFlashcards,
          trend: dueFlashcards > 0 ? 'up' : 'neutral',
          trendLabel: dueFlashcards > 0 ? labels.dueTrendDue : labels.dueTrendNone,
        },
      },
      {
        type: 'progress',
        props: {
          title: labels.progressTitle,
          current: Math.max(0, pendingTodos - overdueTodos),
          total: Math.max(pendingTodos, 1),
          label:
            overdueTodos > 0
              ? labels.overdueLabel.replace('{{count}}', String(overdueTodos))
              : labels.pendingLabel.replace('{{count}}', String(pendingTodos)),
        },
      },
      {
        type: 'action-bar',
        props: {
          actions: [
            { id: 'start-review', label: labels.startReview, variant: 'primary', riskLevel: 'low' },
            { id: 'open-qbank', label: labels.openQbank, variant: 'default', riskLevel: 'low' },
          ],
        },
      },
    ],
  };
}
