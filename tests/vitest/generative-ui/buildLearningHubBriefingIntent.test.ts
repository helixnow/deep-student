import { describe, it, expect } from 'vitest';
import { buildLearningHubBriefingIntent } from '@/features/generative-ui/utils/buildLearningHubBriefingIntent';
import { parseGenerativeUIIntent } from '@/features/generative-ui/schema';

const LABELS = {
  statTitle: 'Resources',
  emptyTrend: 'Empty',
  activeTrend: 'Active',
  startReview: 'Review',
  openQbank: 'QBank',
  dueReviewTitle: 'Due',
  dueReviewTrend: 'Items due',
  reviewCalendarTitle: 'Calendar',
  recentListTitle: 'Recent',
  recentEmpty: 'No resources',
  emptyAlertTitle: 'Folder empty',
  emptyAlertDescription: 'Add notes first',
};

function expectValidIntent(intent: ReturnType<typeof buildLearningHubBriefingIntent>) {
  const parsed = parseGenerativeUIIntent(JSON.stringify(intent));
  expect(parsed.ok).toBe(true);
  expect(intent.version).toBe('1.1');
}

describe('buildLearningHubBriefingIntent', () => {
  it('includes stat-card, recent list and action-bar', () => {
    const intent = buildLearningHubBriefingIntent({
      resourceCount: 12,
      folderLabel: 'Notes',
      recentResources: [{ label: 'note.md' }],
      labels: LABELS,
    });
    const types = intent.blocks.map((b) => b.type);
    expect(types).toContain('stat-card');
    expect(types).toContain('steps');
    expect(types).toContain('list');
    expect(types).toContain('action-bar');
    expect(intent.meta?.description).toBe('Notes');
    const list = intent.blocks.find((b) => b.type === 'list');
    expect((list?.props as { items: Array<{ label: string }> }).items[0]?.label).toBe('note.md');
    expectValidIntent(intent);
  });

  it('uses down trend and empty alert when folder is empty', () => {
    const intent = buildLearningHubBriefingIntent({
      resourceCount: 0,
      labels: LABELS,
    });
    const stat = intent.blocks.find((b) => b.type === 'stat-card');
    expect(stat?.props).toMatchObject({ trend: 'down', trendLabel: 'Empty' });
    const alert = intent.blocks.find((b) => b.type === 'alert');
    expect(alert?.props).toMatchObject({ title: 'Folder empty' });
    const list = intent.blocks.find((b) => b.type === 'list');
    expect((list?.props as { items: unknown[]; emptyLabel?: string }).items).toEqual([]);
    expect((list?.props as { emptyLabel?: string }).emptyLabel).toBe('No resources');
    expect(intent.blocks.some((b) => b.type === 'steps')).toBe(true);
    expectValidIntent(intent);
  });

  it('adds due-review stat and review-calendar when those data exist', () => {
    const intent = buildLearningHubBriefingIntent({
      resourceCount: 3,
      dueReviewCount: 2,
      reviewDays: [{ date: '2026-08-24', dueCount: 2 }],
      labels: LABELS,
    });
    expect(
      intent.blocks.some(
        (b) => b.type === 'stat-card' && (b.props as { title?: string }).title === 'Due',
      ),
    ).toBe(true);
    expect(intent.blocks.some((b) => b.type === 'review-calendar')).toBe(true);
    expect(intent.blocks.some((b) => b.type === 'steps')).toBe(true);
    expect(intent.blocks.some((b) => b.type === 'chart')).toBe(true);
    const chart = intent.blocks.find((b) => b.type === 'chart');
    expect(chart?.props).toMatchObject({
      kind: 'bar',
      categories: ['2026-08-24'],
      series: [{ values: [2] }],
    });
    expectValidIntent(intent);
  });
});
