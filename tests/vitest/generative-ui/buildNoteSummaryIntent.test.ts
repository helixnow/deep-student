import { describe, it, expect } from 'vitest';
import { markdownPropsSchema } from '@/features/generative-ui/components/MarkdownBlock';
import { buildNoteSummaryIntent } from '@/features/generative-ui/utils/buildNoteSummaryIntent';
import { parseGenerativeUIIntent } from '@/features/generative-ui/schema';

const LABELS = {
  defaultTitle: 'Summary',
  updatedPrefix: 'Updated',
  headingStatTitle: 'Sections',
  overviewTitle: 'Overview',
  charCountKey: 'Chars',
  tagsKey: 'Tags',
  tagsEmpty: '—',
  headingsTitle: 'Headings',
  updatedAtKey: 'Updated at',
  emptyNoteTitle: 'Empty note',
  emptyNoteDescription: 'Write something',
  emptyHeadings: 'No headings',
};

function expectValidIntent(intent: ReturnType<typeof buildNoteSummaryIntent>) {
  const parsed = parseGenerativeUIIntent(JSON.stringify(intent));
  expect(parsed.ok).toBe(true);
  expect(intent.version).toBe('1');
}

describe('buildNoteSummaryIntent', () => {
  it('builds valid intent from note metadata with injected labels', () => {
    const intent = buildNoteSummaryIntent({
      title: 'Linear Algebra',
      tags: ['math', 'exam'],
      headingCount: 4,
      charCount: 1200,
      updatedAtLabel: 'Aug 24, 2026',
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
    expect(rows.find((r) => r.key === 'Chars')?.value).toBe('1200');
    expect(rows.find((r) => r.key === 'Updated at')?.value).toBe('Aug 24, 2026');
    expect(intent.blocks.some((b) => b.type === 'list')).toBe(true);
    const markdown = intent.blocks.find((b) => b.type === 'markdown');
    expect(markdown).toBeDefined();
    expect((markdown?.props as { body?: string }).body).toContain('1200');
    expect(markdownPropsSchema.safeParse(markdown?.props).success).toBe(true);
    expectValidIntent(intent);
  });

  it('uses default title, tags empty placeholder and empty-state blocks', () => {
    const intent = buildNoteSummaryIntent({
      title: '',
      labels: LABELS,
    });
    expect(intent.meta?.title).toBe('Summary');
    const grid = intent.blocks.find((b) => b.type === 'key-value-grid');
    const rows = (grid?.props as { rows: Array<{ key: string; value: string }> }).rows;
    expect(rows.find((r) => r.key === 'Tags')?.value).toBe('—');
    expect(rows.find((r) => r.key === 'Chars')).toBeUndefined();
    expect(rows.find((r) => r.key === 'Updated at')).toBeUndefined();
    expect(intent.blocks.some((b) => b.type === 'alert')).toBe(true);
    const list = intent.blocks.find((b) => b.type === 'list');
    expect((list?.props as { items: unknown[]; emptyLabel?: string }).items).toEqual([]);
    expect((list?.props as { emptyLabel?: string }).emptyLabel).toBe('No headings');
    expect(intent.blocks.some((b) => b.type === 'markdown')).toBe(true);
    expectValidIntent(intent);
  });
});
