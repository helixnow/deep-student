import { describe, it, expect } from 'vitest';
import { chartBlockPropsSchema } from '@/features/generative-ui/components/ChartBlock';
import { buildAiDashboardIntent } from '@/features/generative-ui/utils/buildAiDashboardIntent';
import { parseGenerativeUIIntent } from '@/features/generative-ui/schema';

const labels = {
  dueFlashcardsTitle: 'Due flashcards',
  dueTrendDue: 'To review',
  dueTrendNone: 'None due',
  progressTitle: 'Todo progress',
  overdueLabel: '{{count}} overdue',
  pendingLabel: '{{count}} pending',
  startReview: 'Start review',
  openQbank: 'Open qbank',
  ankiTasksTitle: 'Active tasks',
  ankiTasksTrendActive: 'Running',
  ankiTasksTrendIdle: 'Idle',
  openTaskDashboard: 'Open tasks',
  reviewCalendarTitle: 'Calendar',
  reviewEmptyTitle: 'Reviews',
  reviewEmpty: 'Nothing due',
  idleAlertTitle: 'Idle queue',
  idleAlertDescription: 'No work pending',
};

function expectValidIntent(intent: ReturnType<typeof buildAiDashboardIntent>) {
  const parsed = parseGenerativeUIIntent(JSON.stringify(intent));
  expect(parsed.ok).toBe(true);
  expect(intent.version).toBe('1');
}

describe('buildAiDashboardIntent', () => {
  it('extends learning briefing with anki task stat, review list and action when tasks active', () => {
    const intent = buildAiDashboardIntent(
      { dueFlashcards: 5, pendingTodos: 2, overdueTodos: 1, activeAnkiTasks: 2 },
      labels,
    );

    expect(intent.blocks.some((b) => b.type === 'stat-card' && (b.props as { title?: string }).title === labels.ankiTasksTitle)).toBe(true);
    expect(intent.blocks.some((b) => b.type === 'list')).toBe(true);
    const chart = intent.blocks.find((b) => b.type === 'chart');
    expect(chart).toBeDefined();
    expect((chart?.props as { series?: Array<{ values: number[] }> }).series?.[0]?.values).toEqual([5, 2, 1, 2]);
    expect(chartBlockPropsSchema.safeParse(chart?.props).success).toBe(true);
    const actionBar = intent.blocks.find((b) => b.type === 'action-bar');
    const actions = (actionBar?.props as { actions?: Array<{ id: string }> })?.actions ?? [];
    expect(actions.map((a) => a.id)).toEqual(['start-review', 'open-qbank', 'open-task-dashboard']);
    expectValidIntent(intent);
  });

  it('keeps idle anki stat and omits task action when no active tasks', () => {
    const intent = buildAiDashboardIntent(
      { dueFlashcards: 0, pendingTodos: 0, overdueTodos: 0, activeAnkiTasks: 0 },
      labels,
    );
    const anki = intent.blocks.find(
      (b) => b.type === 'stat-card' && (b.props as { title?: string }).title === labels.ankiTasksTitle,
    );
    expect(anki?.props).toMatchObject({ value: 0, trendLabel: 'Idle' });
    expect(intent.blocks.some((b) => b.type === 'alert')).toBe(true);
    expect(intent.blocks.some((b) => b.type === 'list')).toBe(true);
    expect(intent.blocks.some((b) => b.type === 'chart')).toBe(true);
    const actionBar = intent.blocks.find((b) => b.type === 'action-bar');
    const actions = (actionBar?.props as { actions?: Array<{ id: string }> })?.actions ?? [];
    expect(actions.map((a) => a.id)).toEqual(['start-review', 'open-qbank']);
    expectValidIntent(intent);
  });

  it('renders review-calendar when review days are provided', () => {
    const intent = buildAiDashboardIntent(
      {
        dueFlashcards: 3,
        pendingTodos: 1,
        overdueTodos: 0,
        activeAnkiTasks: 0,
        reviewDays: [{ date: '2026-08-24', dueCount: 3 }],
      },
      labels,
    );
    expect(intent.blocks.some((b) => b.type === 'review-calendar')).toBe(true);
    expectValidIntent(intent);
  });
});
