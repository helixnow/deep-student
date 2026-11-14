import { describe, expect, it } from 'vitest';
import { resolveSprintImageSrc } from '../compoundCardModel';

describe('sprint evidence image sources', () => {
  it('allows raster images but rejects executable or unsupported protocol strings', () => {
    expect(resolveSprintImageSrc('data:image/png;base64,YQ==')).toBe('data:image/png;base64,YQ==');
    expect(resolveSprintImageSrc('https://example.com/crop.png')).toBe('https://example.com/crop.png');
    for (const ref of ['javascript:alert(1)', 'data:text/html;base64,YQ==', 'data:image/svg+xml,<svg/>', 'file:bad', 'not an image']) {
      expect(resolveSprintImageSrc(ref)).toBeNull();
    }
  });
});
