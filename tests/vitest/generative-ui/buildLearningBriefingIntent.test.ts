import { describe, it, expect } from 'vitest';
import { buildLearningBriefingIntent } from '@/features/generative-ui/utils/buildLearningBriefingIntent';

describe('buildLearningBriefingIntent', () => {
  it('includes stat, progress and action-bar blocks', () => {
    const intent = buildLearningBriefingIntent({
      dueFlashcards: 5,
      pendingTodos: 10,
      overdueTodos: 2,
    });
    const types = intent.blocks.map((b) => b.type);
    expect(types).toContain('stat-card');
    expect(types).toContain('progress');
    expect(types).toContain('action-bar');
  });
});
