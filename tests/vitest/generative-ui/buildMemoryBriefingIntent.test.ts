import { describe, it, expect } from 'vitest';
import { buildMemoryBriefingIntent } from '@/features/generative-ui/utils/buildMemoryBriefingIntent';

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
};

describe('buildMemoryBriefingIntent', () => {
  it('includes stat-card, key-value-grid and action-bar', () => {
    const intent = buildMemoryBriefingIntent({
      memoryCount: 8,
      rootFolderTitle: 'Study Notes',
      autoExtractFrequency: 'balanced',
      labels: LABELS,
    });
    const types = intent.blocks.map((b) => b.type);
    expect(types).toEqual(['stat-card', 'key-value-grid', 'action-bar']);

    const grid = intent.blocks.find((b) => b.type === 'key-value-grid');
    const rows = (grid?.props as { rows: Array<{ key: string; value: string }> }).rows;
    expect(rows.find((r) => r.key === 'Root')?.value).toBe('Study Notes');
    expect(rows.find((r) => r.key === 'Auto extract')?.value).toBe('Balanced');
  });

  it('uses down trend when memory list is empty', () => {
    const intent = buildMemoryBriefingIntent({ memoryCount: 0, labels: LABELS });
    const stat = intent.blocks.find((b) => b.type === 'stat-card');
    expect(stat?.props).toMatchObject({ trend: 'down', trendLabel: 'Empty' });
  });
});
