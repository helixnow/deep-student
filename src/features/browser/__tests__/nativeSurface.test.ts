import { describe, expect, it } from 'vitest';

import {
  browserSurfaceBoundsFromRect,
  browserSurfaceOcclusionsFromRects,
  shouldShowBrowserSurface,
  shouldSuspendBrowserSurfaceForShellMotion,
} from '../nativeSurface';

describe('native browser surface geometry', () => {
  it('keeps DOMRect coordinates in logical pixels and includes viewport size', () => {
    expect(
      browserSurfaceBoundsFromRect(
        { left: 112.5, top: 86.25, width: 720, height: 480 },
        { width: 1440, height: 900 },
      ),
    ).toEqual({
      x: 112.5,
      y: 86.25,
      width: 720,
      height: 480,
      viewportWidth: 1440,
      viewportHeight: 900,
    });
  });

  it('rejects empty, invalid, and fully off-viewport slots', () => {
    expect(
      browserSurfaceBoundsFromRect(
        { left: 20, top: 20, width: 0, height: 300 },
        { width: 1200, height: 800 },
      ),
    ).toBeNull();
    expect(
      browserSurfaceBoundsFromRect(
        { left: 1200, top: 20, width: 300, height: 300 },
        { width: 1200, height: 800 },
      ),
    ).toBeNull();
    expect(
      browserSurfaceBoundsFromRect(
        { left: Number.NaN, top: 20, width: 300, height: 300 },
        { width: 1200, height: 800 },
      ),
    ).toBeNull();
  });

  it.each([
    [
      'left',
      { left: -40, top: 20, width: 300, height: 200 },
      { x: -40, y: 20, width: 300, height: 200 },
    ],
    [
      'right',
      { left: 1100, top: 20, width: 300, height: 200 },
      { x: 1100, y: 20, width: 300, height: 200 },
    ],
    [
      'top',
      { left: 20, top: -50, width: 300, height: 200 },
      { x: 20, y: -50, width: 300, height: 200 },
    ],
    [
      'bottom',
      { left: 20, top: 700, width: 300, height: 200 },
      { x: 20, y: 700, width: 300, height: 200 },
    ],
    [
      'top-left corner',
      { left: -40, top: -50, width: 300, height: 200 },
      { x: -40, y: -50, width: 300, height: 200 },
    ],
  ])('preserves the original frame when partially outside the %s edge', (_edge, rect, expected) => {
    expect(browserSurfaceBoundsFromRect(rect, { width: 1200, height: 800 })).toEqual({
      ...expected,
      viewportWidth: 1200,
      viewportHeight: 800,
    });
  });

  it.each([
    { left: -300, top: 20, width: 300, height: 200 },
    { left: 1200, top: 20, width: 300, height: 200 },
    { left: 20, top: -200, width: 300, height: 200 },
    { left: 20, top: 800, width: 300, height: 200 },
  ])('rejects a frame with no positive viewport intersection: %o', (rect) => {
    expect(browserSurfaceBoundsFromRect(rect, { width: 1200, height: 800 })).toBeNull();
  });

  it('keeps the full frame when it crosses the desktop Dock area', () => {
    expect(
      browserSurfaceBoundsFromRect(
        { left: 100, top: 80, width: 800, height: 560 },
        { width: 1200, height: 800 },
      ),
    ).toMatchObject({ x: 100, y: 80, width: 800, height: 560 });
    expect(
      browserSurfaceBoundsFromRect(
        { left: 100, top: 700, width: 800, height: 160 },
        { width: 1200, height: 800 },
      ),
    ).toMatchObject({ x: 100, y: 700, width: 800, height: 160 });
  });

  it('clips DOM occluders to the browser slot without changing its frame', () => {
    expect(
      browserSurfaceOcclusionsFromRects(
        { left: 100, top: 100, width: 500, height: 400 },
        { width: 1200, height: 800 },
        [
          { left: 0, top: 450, width: 1200, height: 100 },
          { left: 20, top: 20, width: 40, height: 40 },
        ],
      ),
    ).toEqual([{ x: 100, y: 450, width: 500, height: 50 }]);
  });

  it('returns a non-overlapping union for intersecting DOM occluders', () => {
    expect(
      browserSurfaceOcclusionsFromRects(
        { left: 0, top: 0, width: 300, height: 300 },
        { width: 300, height: 300 },
        [
          { left: 20, top: 20, width: 120, height: 120 },
          { left: 80, top: 80, width: 120, height: 120 },
        ],
      ),
    ).toEqual([
      { x: 20, y: 20, width: 120, height: 60 },
      { x: 20, y: 80, width: 180, height: 60 },
      { x: 80, y: 140, width: 120, height: 60 },
    ]);
  });

  it('coalesces excessive occlusion bands without exposing native content', () => {
    const occluders = Array.from({ length: 65 }, (_, index) => ({
      left: index * 4,
      top: 0,
      width: 2,
      height: 2,
    }));

    expect(
      browserSurfaceOcclusionsFromRects(
        { left: 0, top: 0, width: 300, height: 100 },
        { width: 300, height: 100 },
        occluders,
      ),
    ).toEqual([{ x: 0, y: 0, width: 258, height: 2 }]);
  });

  it('shows every visible session without overlays or suspension', () => {
    const ready = {
      isVisible: true,
      hasSession: true,
      overlayOpen: false,
      suspended: false,
    };

    expect(shouldShowBrowserSurface(ready)).toBe(true);
    expect(shouldShowBrowserSurface({ ...ready, isVisible: false })).toBe(false);
    expect(shouldShowBrowserSurface({ ...ready, hasSession: false })).toBe(false);
    expect(shouldShowBrowserSurface({ ...ready, overlayOpen: true })).toBe(false);
    expect(shouldShowBrowserSurface({ ...ready, suspended: true })).toBe(false);
  });

  it('keeps the child surface live while internal windows move and only suspends settling', () => {
    expect(
      shouldSuspendBrowserSurfaceForShellMotion({
        globalDragging: true,
        globalSettling: false,
        ownWindowDragging: true,
      }),
    ).toBe(false);
    expect(
      shouldSuspendBrowserSurfaceForShellMotion({
        globalDragging: true,
        globalSettling: false,
        ownWindowDragging: false,
      }),
    ).toBe(false);
    expect(
      shouldSuspendBrowserSurfaceForShellMotion({
        globalDragging: true,
        globalSettling: true,
        ownWindowDragging: true,
      }),
    ).toBe(true);
  });
});
