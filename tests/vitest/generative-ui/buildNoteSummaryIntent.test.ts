import { describe, it, expect } from 'vitest';
import { buildNoteSummaryIntent } from '@/features/generative-ui/utils/buildNoteSummaryIntent';

const LABELS = {
  defaultTitle: 'Summary',
  updatedPrefix: 'Updated',
  headingStatTitle: 'Sections',
  overviewTitle: 'Overview',
  charCountKey: 'Chars',
  tagsKey: 'Tags',
  tagsEmpty: '—',
  headingsTitle: 'Headings',
};

describe('buildNoteSummaryIntent', () => {
  it('builds valid intent from note metadata with injected labels', () => {
    const intent = buildNoteSummaryIntent({
      title: 'Linear Algebra',
      tags: ['math', 'exam'],
      headingCount: 4,
      charCount: 1200,
      topHeadings: ['Eigenvalues', 'Matrix factorization'],
      labels: LABELS,
    });
    expect(intent.version).toBe('1');
    expect(intent.blocks.length).toBeGreaterThanOrEqual(2);
    expect(intent.blocks[0]?.type).toBe('stat-card');
    expect(intent.meta?.title).toBe('Linear Algebra');

    const grid = intent.blocks.find((b) => b.type === 'key-value-grid');
    const rows = (grid?.props as { rows: Array<{ key: string; value: string }> }).rows;
    expect(rows.find((r) => r.key === 'Tags')?.value).toBe('math、exam');
  });

  it('uses default title and tags empty placeholder', () => {
    const intent = buildNoteSummaryIntent({
      title: '',
      labels: LABELS,
    });
    expect(intent.meta?.title).toBe('Summary');
    const grid = intent.blocks.find((b) => b.type === 'key-value-grid');
    const rows = (grid?.props as { rows: Array<{ key: string; value: string }> }).rows;
    expect(rows.find((r) => r.key === 'Tags')?.value).toBe('—');
  });
});
