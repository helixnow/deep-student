import { describe, expect, it } from 'vitest';
import {
  IME_PLACEHOLDER_ZWS,
  sanitizeAssetUrlsForCrepe,
  stripImePlaceholder,
} from '../crepeMarkdownSanitizer';

describe('crepeMarkdownSanitizer', () => {
  describe('stripImePlaceholder', () => {
    it('strips all U+200B zero-width placeholders without mutating normal text', () => {
      const input = `Hello${IME_PLACEHOLDER_ZWS} world\n\n${IME_PLACEHOLDER_ZWS}中文段落${IME_PLACEHOLDER_ZWS}`;
      expect(stripImePlaceholder(input)).toBe('Hello world\n\n中文段落');
    });

    it('returns empty and clean strings unchanged', () => {
      expect(stripImePlaceholder('')).toBe('');
      expect(stripImePlaceholder('# Heading\n\nParagraph')).toBe('# Heading\n\nParagraph');
    });
  });

  describe('sanitizeAssetUrlsForCrepe', () => {
    it('keeps plain markdown and relative notes_assets paths untouched', () => {
      const md = '![photo](notes_assets/2026/sample.png)\n\n[link](https://example.com)';
      expect(sanitizeAssetUrlsForCrepe(md)).toBe(md);
    });

    it('normalizes double-encoded %2F / %5C separators in asset:// URLs', () => {
      const md = '![pic](asset://localhost/Users%2Falice%5Cdocs%2fimage.png)';
      expect(sanitizeAssetUrlsForCrepe(md)).toBe(
        '![pic](asset://localhost/Users/alice/docs/image.png)',
      );
    });

    it('collapses duplicate slashes after asset://localhost/', () => {
      const md = '![pic](asset://localhost///Users/alice/image.png)';
      expect(sanitizeAssetUrlsForCrepe(md)).toBe(
        '![pic](asset://localhost/Users/alice/image.png)',
      );
    });

    it('rewrites legacy absolute asset://localhost/.../notes_assets/... URLs back to relative paths', () => {
      const md =
        '![a](asset://localhost//Users%2Falice%2Fapp%2Fnotes_assets%2Fimg-1.png)\n'
        + '![b](asset://localhost/C:%5Cdata%5Cnotes_assets%5Csub/img-2.webp)';
      expect(sanitizeAssetUrlsForCrepe(md)).toBe(
        '![a](notes_assets/img-1.png)\n'
        + '![b](notes_assets/sub/img-2.webp)',
      );
    });

    it('preserves non-notes_assets asset:// URLs after normalization', () => {
      const md = '![x](asset://localhost//tmp%2Fcache%2Fdiagram.svg) and text';
      expect(sanitizeAssetUrlsForCrepe(md)).toBe(
        '![x](asset://localhost/tmp/cache/diagram.svg) and text',
      );
    });

    it('handles empty input gracefully', () => {
      expect(sanitizeAssetUrlsForCrepe('')).toBe('');
    });
  });
});
