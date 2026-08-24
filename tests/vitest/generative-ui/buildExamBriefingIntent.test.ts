import { describe, it, expect } from 'vitest';
import { buildExamBriefingIntent } from '@/features/generative-ui/utils/buildExamBriefingIntent';

const LABELS = {
  totalTitle: 'Total',
  masteryTrend: 'Mastery {{percent}}%',
  emptyTrend: 'Empty',
  progressTitle: 'Progress',
  masteredRow: '{{count}} mastered',
  reviewRow: 'Review',
  correctRateRow: 'Correct',
  startReview: 'Start review',
  openPractice: 'Practice',
};

const BASE_STATS = {
  total: 20,
  mastered: 10,
  review: 3,
  inProgress: 5,
  newCount: 2,
  correctRate: 0.75,
};

describe('buildExamBriefingIntent', () => {
  it('includes stat-card, progress, key-value-grid and action-bar', () => {
    const intent = buildExamBriefingIntent({
      stats: BASE_STATS,
      examName: 'Linear Algebra',
      labels: LABELS,
    });
    const types = intent.blocks.map((b) => b.type);
    expect(types).toEqual(['stat-card', 'progress', 'key-value-grid', 'action-bar']);
    expect(intent.meta?.description).toBe('Linear Algebra');
  });

  it('shows start-review when review count > 0', () => {
    const intent = buildExamBriefingIntent({ stats: BASE_STATS, labels: LABELS });
    const bar = intent.blocks.find((b) => b.type === 'action-bar');
    const ids = (bar?.props as { actions: Array<{ id: string }> }).actions.map((a) => a.id);
    expect(ids).toContain('start-review');
    expect(ids).toContain('open-practice');
  });

  it('omits start-review when no review items', () => {
    const intent = buildExamBriefingIntent({
      stats: { ...BASE_STATS, review: 0 },
      labels: LABELS,
    });
    const bar = intent.blocks.find((b) => b.type === 'action-bar');
    const ids = (bar?.props as { actions: Array<{ id: string }> }).actions.map((a) => a.id);
    expect(ids).not.toContain('start-review');
    expect(ids).toContain('open-practice');
  });

  it('formats correct rate as percent in key-value grid', () => {
    const intent = buildExamBriefingIntent({ stats: BASE_STATS, labels: LABELS });
    const grid = intent.blocks.find((b) => b.type === 'key-value-grid');
    const rows = (grid?.props as { rows: Array<{ key: string; value: string }> }).rows;
    expect(rows.find((r) => r.key === 'Correct')?.value).toBe('75%');
  });
});
