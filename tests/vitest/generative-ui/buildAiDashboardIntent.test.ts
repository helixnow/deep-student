import { describe, it, expect } from 'vitest';
import { buildAiDashboardIntent } from '@/features/generative-ui/utils/buildAiDashboardIntent';

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
  openTaskDashboard: 'Open tasks',
};

describe('buildAiDashboardIntent', () => {
  it('extends learning briefing with anki task stat and action when tasks active', () => {
    const intent = buildAiDashboardIntent(
      { dueFlashcards: 5, pendingTodos: 2, overdueTodos: 1, activeAnkiTasks: 2 },
      labels,
    );

    expect(intent.blocks.some((b) => b.type === 'stat-card' && (b.props as { title?: string }).title === labels.ankiTasksTitle)).toBe(true);
    const actionBar = intent.blocks.find((b) => b.type === 'action-bar');
    const actions = (actionBar?.props as { actions?: Array<{ id: string }> })?.actions ?? [];
    expect(actions.map((a) => a.id)).toEqual(['start-review', 'open-qbank', 'open-task-dashboard']);
  });

  it('omits anki blocks when no active tasks', () => {
    const intent = buildAiDashboardIntent(
      { dueFlashcards: 0, pendingTodos: 0, overdueTodos: 0, activeAnkiTasks: 0 },
      labels,
    );
    const titles = intent.blocks
      .filter((b) => b.type === 'stat-card')
      .map((b) => (b.props as { title?: string }).title);
    expect(titles).not.toContain(labels.ankiTasksTitle);
    const actionBar = intent.blocks.find((b) => b.type === 'action-bar');
    const actions = (actionBar?.props as { actions?: Array<{ id: string }> })?.actions ?? [];
    expect(actions.map((a) => a.id)).toEqual(['start-review', 'open-qbank']);
  });
});
