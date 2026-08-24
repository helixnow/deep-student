import { describe, it, expect } from 'vitest';
import { buildLearningBriefingIntent } from '@/features/generative-ui/utils/buildLearningBriefingIntent';

const LABELS = {
  dueFlashcardsTitle: 'Due',
  dueTrendDue: 'To review',
  dueTrendNone: 'None',
  progressTitle: 'Todos',
  overdueLabel: '{{count}} overdue',
  pendingLabel: '{{count}} pending',
  startReview: 'Review',
  openQbank: 'QBank',
};

describe('buildLearningBriefingIntent', () => {
  it('includes stat, progress and action-bar blocks without duplicate meta title', () => {
    const intent = buildLearningBriefingIntent(
      {
        dueFlashcards: 5,
        pendingTodos: 10,
        overdueTodos: 2,
      },
      LABELS,
    );
    const types = intent.blocks.map((b) => b.type);
    expect(types).toContain('stat-card');
    expect(types).toContain('progress');
    expect(types).toContain('action-bar');
    expect(intent.meta?.title).toBeUndefined();
  });
});
