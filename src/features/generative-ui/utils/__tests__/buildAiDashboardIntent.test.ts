import { describe, expect, it } from 'vitest';
import { buildAiDashboardIntent, type AiDashboardLabels } from '../buildAiDashboardIntent';

const LABELS: AiDashboardLabels = {
  dueFlashcardsTitle: 'Cards due',
  dueTrendDue: 'due',
  dueTrendNone: 'none',
  progressTitle: 'Progress',
  overdueLabel: '{{count}} overdue',
  pendingLabel: '{{count}} pending',
  startReview: 'Review',
  openQbank: 'Qbank',
  ankiTasksTitle: 'Tasks',
  ankiTasksTrendActive: 'running',
  openTaskDashboard: 'Open tasks',
  dueMistakesTitle: 'Mistakes due',
  dueNotesTitle: 'Notes due',
  reviewNotes: 'Review notes',
};

const statTitles = (intent: ReturnType<typeof buildAiDashboardIntent>) =>
  intent.blocks.filter((b) => b.type === 'stat-card').map((b) => (b.props as { title: string }).title);

describe('buildAiDashboardIntent — unified today learning', () => {
  it('shows cards, mistakes and notes side by side and offers note review', () => {
    const intent = buildAiDashboardIntent({ dueFlashcards: 3, dueMistakes: 2, dueNotes: 1 }, LABELS);
    expect(statTitles(intent).slice(0, 3)).toEqual(['Cards due', 'Mistakes due', 'Notes due']);
    expect(intent.blocks.some((b) => b.type === 'alert')).toBe(false);
    const bar = intent.blocks.find((b) => b.type === 'action-bar');
    expect(JSON.stringify(bar)).toContain('review-notes');
  });

  it('is not idle when only mistakes are due', () => {
    const intent = buildAiDashboardIntent({ dueMistakes: 4 }, LABELS);
    expect(intent.blocks.some((b) => b.type === 'alert')).toBe(false);
  });

  it('keeps the old layout when callers do not pass the new labels', () => {
    const { dueMistakesTitle: _m, dueNotesTitle: _n, ...legacy } = LABELS;
    const intent = buildAiDashboardIntent({ dueFlashcards: 0, dueMistakes: 5 }, legacy);
    // 待办由满格进度条改为统计卡（标题回退 progressTitle），制卡任务卡排在它前面
    expect(statTitles(intent)).toEqual(['Cards due', 'Tasks', 'Progress']);
    expect(intent.blocks.some((b) => b.type === 'alert')).toBe(true);
  });
});
