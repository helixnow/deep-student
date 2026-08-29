import { describe, it, expect } from 'vitest';
import { buildExamBriefingIntent } from '@/features/generative-ui/utils/buildExamBriefingIntent';
import { parseGenerativeUIIntent } from '@/features/generative-ui/schema';

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
  tableTitle: 'Mastery table',
  tableMetricColumn: 'Metric',
  tableValueColumn: 'Value',
  chartTitle: 'Distribution',
  chartSeries: 'Questions',
  masteredCategory: 'Mastered',
  emptyBankTitle: 'Bank empty',
  emptyBankDescription: 'Add questions first',
  mistakeSuggestion: 'Review weak topics',
  statusListTitle: 'Status',
  inProgressRow: 'In progress',
  newCountRow: 'New',
  statusEmpty: 'No status',
};

const BASE_STATS = {
  total: 20,
  mastered: 10,
  review: 3,
  inProgress: 5,
  newCount: 2,
  correctRate: 0.75,
};

function expectValidIntent(intent: ReturnType<typeof buildExamBriefingIntent>) {
  const parsed = parseGenerativeUIIntent(JSON.stringify(intent));
  expect(parsed.ok).toBe(true);
  expect(intent.version).toBe('1.1');
}

describe('buildExamBriefingIntent', () => {
  it('includes stat-card, progress, key-value-grid, list and action-bar', () => {
    const intent = buildExamBriefingIntent({
      stats: BASE_STATS,
      examName: 'Linear Algebra',
      labels: LABELS,
    });
    const types = intent.blocks.map((b) => b.type);
    expect(types).toContain('table');
    expect(types).toContain('chart');
    expect(types).toEqual([
      'stat-card',
      'chart',
      'progress',
      'table',
      'key-value-grid',
      'mistake-analysis',
      'list',
      'action-bar',
    ]);
    expect(intent.layout).toEqual({ mode: 'grid', columns: 2 });
    const chart = intent.blocks.find((b) => b.type === 'chart');
    expect(chart?.props).toMatchObject({
      kind: 'bar',
      categories: ['Mastered', 'Review', 'In progress'],
      series: [{ name: 'Questions', values: [10, 3, 5] }],
    });
    const table = intent.blocks.find((b) => b.type === 'table');
    const rows = (table?.props as { rows: Array<{ metric: string; value: string | number }> }).rows;
    expect(rows.map((r) => r.metric)).toEqual(['10 mastered', 'Review', 'Correct']);
    expect(rows.map((r) => r.value)).toEqual([10, 3, '75%']);
    expect(intent.meta?.description).toBe('Linear Algebra');
    expectValidIntent(intent);
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
    expect(intent.blocks.some((b) => b.type === 'mistake-analysis')).toBe(false);
    expectValidIntent(intent);
  });

  it('formats correct rate as percent in key-value grid', () => {
    const intent = buildExamBriefingIntent({ stats: BASE_STATS, labels: LABELS });
    const grid = intent.blocks.find((b) => b.type === 'key-value-grid');
    const rows = (grid?.props as { rows: Array<{ key: string; value: string }> }).rows;
    expect(rows.find((r) => r.key === 'Correct')?.value).toBe('75%');
  });

  it('adds empty-bank alert and empty status list when the bank is empty', () => {
    const intent = buildExamBriefingIntent({
      stats: { total: 0, mastered: 0, review: 0, inProgress: 0, newCount: 0, correctRate: 0 },
      labels: LABELS,
    });
    const alert = intent.blocks.find((b) => b.type === 'alert');
    expect(alert?.props).toMatchObject({ title: 'Bank empty', variant: 'info' });
    const list = intent.blocks.find((b) => b.type === 'list');
    expect((list?.props as { items: unknown[]; emptyLabel?: string }).items).toEqual([]);
    expect((list?.props as { emptyLabel?: string }).emptyLabel).toBe('No status');
    expect(intent.blocks.some((b) => b.type === 'mistake-analysis')).toBe(false);
    expect(intent.blocks.some((b) => b.type === 'table')).toBe(false);
    expect(intent.blocks.some((b) => b.type === 'chart')).toBe(false);
    expectValidIntent(intent);
  });
});
