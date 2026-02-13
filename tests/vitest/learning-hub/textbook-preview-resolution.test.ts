import { describe, expect, it } from 'vitest';

import { resolveTextbookPreviewType } from '@/components/learning-hub/apps/views/textbookPreviewResolver';

describe('textbook preview resolver', () => {
  it('keeps explicit modern preview type', () => {
    expect(resolveTextbookPreviewType('docx', 'paper.pdf')).toBe('docx');
  });

  it('falls back to filename when preview type is none', () => {
    expect(resolveTextbookPreviewType('none', 'slides.pptx')).toBe('pptx');
    expect(resolveTextbookPreviewType(undefined, 'outline.txt')).toBe('text');
  });

  it('handles legacy card preview and unknown values safely', () => {
    expect(resolveTextbookPreviewType('card', 'legacy.pdf')).toBe('pdf');
    expect(resolveTextbookPreviewType('weird', 'archive.bin')).toBe('none');
  });
});
