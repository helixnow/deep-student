import { describe, it, expect } from 'vitest';
import { buildIndexStatusBriefingIntent } from '@/features/generative-ui/utils/buildIndexStatusBriefingIntent';

const LABELS = {
  totalTitle: 'Total',
  progressTitle: 'Progress',
  indexedRow: '{{count}} indexed',
  pendingRow: 'Pending',
  failedRow: 'Failed',
  indexingRow: 'Indexing',
  allIndexedTrend: 'Ready',
  needsAttentionTrend: 'Attention',
  batchIndex: 'Index all',
  refresh: 'Refresh',
};

describe('buildIndexStatusBriefingIntent', () => {
  it('includes progress and status grid', () => {
    const intent = buildIndexStatusBriefingIntent({
      summary: {
        totalResources: 10,
        indexedCount: 7,
        pendingCount: 2,
        failedCount: 1,
        indexingCount: 0,
      },
      labels: LABELS,
    });
    const types = intent.blocks.map((b) => b.type);
    expect(types).toEqual(['stat-card', 'progress', 'key-value-grid', 'action-bar']);
  });

  it('shows batch-index when work remains', () => {
    const intent = buildIndexStatusBriefingIntent({
      summary: {
        totalResources: 5,
        indexedCount: 2,
        pendingCount: 2,
        failedCount: 1,
        indexingCount: 0,
      },
      labels: LABELS,
    });
    const bar = intent.blocks.find((b) => b.type === 'action-bar');
    const ids = (bar?.props as { actions: Array<{ id: string }> }).actions.map((a) => a.id);
    expect(ids).toContain('batch-index-pending');
  });

  it('omits batch-index when fully indexed', () => {
    const intent = buildIndexStatusBriefingIntent({
      summary: {
        totalResources: 4,
        indexedCount: 4,
        pendingCount: 0,
        failedCount: 0,
        indexingCount: 0,
      },
      labels: LABELS,
    });
    const bar = intent.blocks.find((b) => b.type === 'action-bar');
    const ids = (bar?.props as { actions: Array<{ id: string }> }).actions.map((a) => a.id);
    expect(ids).not.toContain('batch-index-pending');
    expect(ids).toContain('refresh-index-status');
  });
});
