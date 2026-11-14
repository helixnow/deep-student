import { expect, it } from 'vitest';
import { classifyPdfContent, hasValidOcrPages, parseOcrPages } from '../src/ocr.ts';

it('classifies_short_text_as_scanned', () => {
  expect(classifyPdfContent('short', 100)).toBe('scanned');
  expect(classifyPdfContent('x'.repeat(100), 100)).toBe('text');
});
it('rejects_failed_or_empty_ocr', () => {
  expect(hasValidOcrPages(parseOcrPages('["__OCR_FAILED__", "  "]'), 1)).toBe(false);
});
it('preserves sparse page positions and compares normalized block text by UTF-8 bytes', () => {
  expect(parseOcrPages(JSON.stringify({ total_pages: 1, pages: [
    { page_index: 2, blocks: [{ text: '  汉字  ' }], text: 'abcde' },
    { page_index: null, pageIndex: 9, text: '  second  ' },
  ] }))).toEqual([null, 'second', '汉字']);
});
