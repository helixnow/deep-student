import { describe, it, expect } from 'vitest';
import { buildIndexStatusBriefingIntent } from '@/features/generative-ui/utils/buildIndexStatusBriefingIntent';
import { parseGenerativeUIIntent } from '@/features/generative-ui/schema';

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
  failedAlertTitle: 'Index errors',
  failedAlertDescription: 'Retry failed items',
  emptyIndexTitle: 'No resources',
  emptyIndexDescription: 'Nothing to index',
  scanProgressTitle: 'Scan',
  scanProgressLabel: '{{count}} scanning',
};

function expectValidIntent(intent: ReturnType<typeof buildIndexStatusBriefingIntent>) {
  const parsed = parseGenerativeUIIntent(JSON.stringify(intent));
  expect(parsed.ok).toBe(true);
  expect(intent.version).toBe('1.1');
}

describe('buildIndexStatusBriefingIntent', () => {
  it('includes progress, status grid and failure alert', () => {
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
    expect(types).toContain('markdown');
    expect(types).toContain('table');
    expect(types).toEqual([
      'alert',
      'markdown',
      'stat-card',
      'progress',
      'table',
      'key-value-grid',
      'action-bar',
    ]);
    const alert = intent.blocks.find((b) => b.type === 'alert');
    expect(alert?.props).toMatchObject({ title: 'Index errors', variant: 'destructive' });
    const table = intent.blocks.find((b) => b.type === 'table');
    const rows = (table?.props as { rows: Array<{ status: string; count: number }> }).rows;
    expect(rows.map((r) => r.count)).toEqual([7, 2, 1, 0]);
    expectValidIntent(intent);
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
    expect(intent.blocks.some((b) => b.type === 'alert')).toBe(false);
    expect(intent.blocks.some((b) => b.type === 'markdown')).toBe(false);
    expect(intent.blocks.some((b) => b.type === 'table')).toBe(true);
    expectValidIntent(intent);
  });

  it('adds empty alert and scan progress when those states exist', () => {
    const empty = buildIndexStatusBriefingIntent({
      summary: {
        totalResources: 0,
        indexedCount: 0,
        pendingCount: 0,
        failedCount: 0,
        indexingCount: 0,
      },
      labels: LABELS,
    });
    expect(empty.blocks.some((b) => b.type === 'alert')).toBe(true);
    expect((empty.blocks.find((b) => b.type === 'alert')?.props as { title?: string }).title).toBe(
      'No resources',
    );

    const scanning = buildIndexStatusBriefingIntent({
      summary: {
        totalResources: 6,
        indexedCount: 2,
        pendingCount: 3,
        failedCount: 0,
        indexingCount: 1,
      },
      labels: LABELS,
    });
    const progressTitles = scanning.blocks
      .filter((b) => b.type === 'progress')
      .map((b) => (b.props as { title?: string }).title);
    expect(progressTitles).toContain('Scan');
    expectValidIntent(empty);
    expectValidIntent(scanning);
  });
});
