import { describe, expect, it } from 'vitest';
import { inferFilePreviewTypeFromName } from '../../../types';
import { resolveFilePreviewMode } from '../filePreviewResolver';
import { resolveTextbookPreviewType } from '../textbookPreviewResolver';

describe('EPUB preview routing', () => {
  it('infers the structured EPUB preview type', () => {
    expect(inferFilePreviewTypeFromName('book.epub')).toBe('epub');
    expect(inferFilePreviewTypeFromName('BOOK.EPUB')).toBe('epub');
  });

  it('upgrades historical text preview metadata using extension or MIME', () => {
    expect(resolveFilePreviewMode('application/octet-stream', 'book.epub', 'text')).toBe('epub');
    expect(resolveFilePreviewMode('application/epub+zip', 'book.bin', 'text')).toBe('epub');
    expect(resolveTextbookPreviewType('text', 'book.epub')).toBe('epub');
  });
});
