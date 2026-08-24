import { describe, it, expect } from 'vitest';
import { buildMemoryBriefingIntent } from '@/features/generative-ui/utils/buildMemoryBriefingIntent';
import { parseGenerativeUIIntent } from '@/features/generative-ui/schema';

const LABELS = {
  countTitle: 'Memories',
  activeTrend: 'Active',
  emptyTrend: 'Empty',
  overviewTitle: 'Overview',
  rootFolderRow: 'Root',
  autoExtractRow: 'Auto extract',
  freqOff: 'Off',
  freqBalanced: 'Balanced',
  freqAggressive: 'Aggressive',
  refresh: 'Refresh',
  createMemory: 'Create',
  recentListTitle: 'Recent',
  recentEmpty: 'No entries',
  openMemory: 'Open',
};

function expectValidIntent(intent: ReturnType<typeof buildMemoryBriefingIntent>) {
  const parsed = parseGenerativeUIIntent(JSON.stringify(intent));
  expect(parsed.ok).toBe(true);
  expect(intent.version).toBe('1.1');
}

describe('buildMemoryBriefingIntent', () => {
  it('includes stat-card, key-value-grid, recent list and action-bar', () => {
    const intent = buildMemoryBriefingIntent({
      memoryCount: 8,
      rootFolderTitle: 'Study Notes',
      autoExtractFrequency: 'balanced',
      recentItems: [{ label: 'Eigenvalues', badge: 'note' }],
      labels: LABELS,
    });
    const types = intent.blocks.map((b) => b.type);
    expect(types).toContain('steps');
    expect(types).toContain('table');
    expect(types).toEqual(['stat-card', 'steps', 'key-value-grid', 'table', 'action-bar']);

    const grid = intent.blocks.find((b) => b.type === 'key-value-grid');
    const rows = (grid?.props as { rows: Array<{ key: string; value: string }> }).rows;
    expect(rows.find((r) => r.key === 'Root')?.value).toBe('Study Notes');
    expect(rows.find((r) => r.key === 'Auto extract')?.value).toBe('Balanced');

    const table = intent.blocks.find((b) => b.type === 'table');
    const tableRows = (table?.props as { rows: Array<{ title: string }> }).rows;
    expect(tableRows.map((row) => row.title)).toEqual(['Eigenvalues']);

    const bar = intent.blocks.find((b) => b.type === 'action-bar');
    const ids = (bar?.props as { actions: Array<{ id: string }> }).actions.map((a) => a.id);
    expect(ids).toEqual(['create-memory', 'open-memory', 'refresh-memory']);
    expectValidIntent(intent);
  });

  it('uses down trend and empty list when memory list is empty', () => {
    const intent = buildMemoryBriefingIntent({ memoryCount: 0, labels: LABELS });
    const stat = intent.blocks.find((b) => b.type === 'stat-card');
    expect(stat?.props).toMatchObject({ trend: 'down', trendLabel: 'Empty' });
    const types = intent.blocks.map((b) => b.type);
    expect(types).toContain('markdown');
    expect(types).toContain('steps');
    const table = intent.blocks.find((b) => b.type === 'table');
    expect((table?.props as { rows: unknown[]; emptyLabel?: string }).rows).toEqual([]);
    expect((table?.props as { emptyLabel?: string }).emptyLabel).toBe('No entries');
    expectValidIntent(intent);
  });
});
