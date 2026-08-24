import type { GenerativeUIIntent } from '../types';
import { buildTableIntent } from './buildTableIntent';

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

function categoryFromCountLabel(template: string, fallback: string): string {
  const stripped = template.replace(/\{\{count\}\}/g, '').replace(/\s+/g, ' ').trim();
  return stripped || fallback;
}

export function buildLearningBriefingIntent(
  input: LearningBriefingInput,
  labels: LearningBriefingLabels,
): GenerativeUIIntent {
  const { dueFlashcards = 0, pendingTodos = 0, overdueTodos = 0 } = input;
  const hasWorkload = dueFlashcards > 0 || pendingTodos > 0 || overdueTodos > 0;
  const workloadTable = hasWorkload
    ? buildTableIntent({
        title: labels.progressTitle,
        columns: [
          { key: 'metric', label: labels.progressTitle.slice(0, 80) },
          { key: 'count', label: labels.dueTrendDue.slice(0, 80), align: 'right' },
        ],
        rows: [
          { metric: labels.dueFlashcardsTitle, count: dueFlashcards },
          {
            metric: categoryFromCountLabel(labels.pendingLabel, labels.progressTitle),
            count: pendingTodos,
          },
          {
            metric: categoryFromCountLabel(labels.overdueLabel, labels.progressTitle),
            count: overdueTodos,
          },
        ],
        labels: {},
      }).blocks
    : [];

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
      ...workloadTable,
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
