import { expect, it } from 'vitest';
import {
  argumentsObject, ensureExpectedRevision, hasDynamicSensitivity, highlightOutput,
  paginatedAnnotations, parseRect, sensitivityLevel, sensitivityLevelForCall,
  type Highlight,
} from '../src/textbook-pdf.ts';

function errorMessage(run: () => unknown): string {
  try { run(); }
  catch (error) { return (error as Error).message; }
  throw new Error('expected an error');
}

it('rejects_unknown_fields_and_invalid_normalized_rectangles', () => {
  const err = errorMessage(() => argumentsObject({ action: 'get', extra: true }, ['action']));
  expect(err).toContain('INVALID_ARGUMENT');
  const rectErr = errorMessage(() => parseRect({ x: 0.9, y: 0.1, width: 0.2, height: 0.2 }, 0));
  expect(rectErr).toContain('normalized page coordinates');
});

it('paginates_at_twenty_and_marks_long_text_truncated', () => {
  const textbook = { id: 'file_test', updatedAt: '2026-01-01T00:00:00.000Z' };
  const highlights: Highlight[] = Array.from({ length: 21 }, (_, index) => ({
    id: `hl-${index}`,
    pageIndex: index,
    text: 'x'.repeat(2_001),
    color: '#fef08a',
    rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.1 }],
    createdAt: 1,
    coordVersion: 2,
  }));
  const output = paginatedAnnotations('highlights', highlights.map(highlightOutput), 1, 20, textbook);
  expect((output.items as unknown[]).length).toBe(20);
  expect(output.has_more).toBe(true);
  expect(output.truncated).toBe(true);
  const first = (output.items as Array<Record<string, unknown>>)[0]!;
  expect([...(first.text as string)].length).toBe(2_000);
});

it('rejects_stale_occ_with_bounded_current_value', () => {
  const current = [{ id: 'bm-1', page: 1, title: 'title', createdAt: 1 }];
  const error = errorMessage(() => ensureExpectedRevision('rev-2', 'rev-1', 'bookmarks', current));
  const parsed = JSON.parse(error) as Record<string, unknown>;
  expect(parsed.code).toBe('ANNOTATION_CONFLICT');
  expect(parsed.current_updated_at).toBe('rev-2');
});

it('sensitivity_keeps_reads_low_and_annotation_writes_medium', () => {
  expect(sensitivityLevel('builtin-pdf_page_image')).toBe('low');
  expect(sensitivityLevel('builtin-textbook_bookmarks')).toBe('medium');
  expect(sensitivityLevel('builtin-textbook_highlights')).toBe('medium');
  expect(hasDynamicSensitivity('builtin-textbook_bookmarks')).toBe(true);
  expect(hasDynamicSensitivity('builtin-textbook_highlights')).toBe(true);
  expect(hasDynamicSensitivity('builtin-pdf_page_image')).toBe(false);
  expect(sensitivityLevelForCall('builtin-textbook_bookmarks', { action: 'get' })).toBe('low');
  expect(sensitivityLevelForCall('builtin-textbook_highlights', { action: 'remove' })).toBe('medium');
  expect(sensitivityLevelForCall('builtin-textbook_highlights', {})).toBe('medium');
});
