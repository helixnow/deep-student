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
  it('includes stat cards, table and action-bar blocks without duplicate meta title', () => {
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
    expect(types.filter((t) => t === 'stat-card')).toHaveLength(2);
    expect(types).toContain('table');
    expect(types).toContain('action-bar');
    expect(intent.meta?.title).toBeUndefined();
  });

  it('omits table when there is no workload data', () => {
    const intent = buildLearningBriefingIntent(
      { dueFlashcards: 0, pendingTodos: 0, overdueTodos: 0 },
      LABELS,
    );
    expect(intent.blocks.some((b) => b.type === 'table')).toBe(false);
  });

  it('待办统计卡：不再把「未逾期 / 待办」画成满格进度（1 项待办 0 逾期曾显示 100%）', () => {
    const intent = buildLearningBriefingIntent(
      { dueFlashcards: 0, pendingTodos: 1, overdueTodos: 0 },
      { ...LABELS, todosTitle: 'To-dos', noOverdueLabel: 'Nothing overdue' },
    );
    expect(intent.blocks.some((b) => b.type === 'progress')).toBe(false);
    const todos = intent.blocks.find((b) => b.type === 'stat-card' && (b.props as { title: string }).title === 'To-dos');
    expect(todos?.props).toMatchObject({ value: 1, trend: 'neutral', trendLabel: 'Nothing overdue' });

    const overdue = buildLearningBriefingIntent({ pendingTodos: 3, overdueTodos: 2 }, LABELS);
    const card = overdue.blocks.find((b) => b.type === 'stat-card' && (b.props as { title: string }).title === 'Todos');
    expect(card?.props).toMatchObject({ value: 3, trend: 'down', trendLabel: '2 overdue' });
  });
});
