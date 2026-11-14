import { expect, it } from 'vitest';
import { parseExamPreview } from '../src/exam-preview.ts';

const atom = (text: string) => (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON(text);
const preview = (pageIndex: unknown, x: unknown) => ({
  pages: [{ page_index: pageIndex, cards: [{ bbox: { x, y: 0, width: 1, height: 1 } }] }],
});

it('ExamSheetPreviewResult numbers read back from raw Value text decode like serde (f32 from 0.5 / 1.0, usize rejects 1.0)', () => {
  expect(parseExamPreview(preview(0, atom('0.5'))).pages[0]!.cards[0]!.bbox.x).toBe(0.5);
  expect(parseExamPreview(preview(0, atom('1.0'))).pages[0]!.cards[0]!.bbox.x).toBe(1);
  expect(parseExamPreview(preview(atom('12345678901234567890'), 0)).pages[0]!.page_index).toBe(12345678901234567890);
  expect(() => parseExamPreview(preview(atom('1.0'), 0))).toThrow('invalid type: floating point `1.0`, expected usize');
  expect(() => parseExamPreview(preview(atom('1e2'), 0))).toThrow('invalid type: floating point `100.0`, expected usize');
  expect(() => parseExamPreview(preview(atom('18446744073709551616'), 0)))
    .toThrow('invalid value: integer `18446744073709551616`, expected usize');
  expect(() => parseExamPreview(preview(-1, 0))).toThrow('invalid value: integer `-1`, expected usize');
});
