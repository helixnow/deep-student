import { describe, expect, it } from 'vitest';
import type { InkObject, InkViewport } from '../geometry';
import { mapCropPoint, objectHitTest, pageToScreen, screenToPage } from '../geometry';

const viewport: InkViewport = { left: 12, top: 8, scale: 2, pan_x: 5, pan_y: -3 };

describe('ink geometry', () => {
  it('maps a logical page point to screen coordinates and back without DPR scaling', () => {
    const pagePoint = { x: 17, y: 23 };
    const screenPoint = pageToScreen(pagePoint, viewport);

    expect(screenPoint).toEqual({ x: 51, y: 51 });
    expect(screenToPage(screenPoint, viewport)).toEqual({ x: 17, y: 23 });
  });

  it('maps a crop-relative normalized point into page logical coordinates', () => {
    expect(mapCropPoint({ x: 0.25, y: 0.75 }, { x: 20, y: 10, width: 40, height: 20 }, { width: 100, height: 80 }))
      .toEqual({ x: 30, y: 25 });
  });

  it('rejects crop geometry outside the page', () => {
    expect(() => mapCropPoint({ x: 0.5, y: 0.5 }, { x: 90, y: 10, width: 20, height: 20 }, { width: 100, height: 80 }))
      .toThrow();
  });

  it('does not hit an empty interior of a stroke bounding box far from its segment', () => {
    const stroke: InkObject = {
      id: 'line', author: 'user', created_at: 0,
      content: {
        kind: 'stroke', samples: [{ x: 10, y: 10, pressure: 0.5 }, { x: 90, y: 90, pressure: 0.5 }],
        style: { tool: 'pen', color: '#000000', width: 2, pressure_enabled: false },
      },
    };

    expect(objectHitTest(stroke, { x: 10, y: 90 }, 3)).toBe(false);
    expect(objectHitTest(stroke, { x: 50, y: 50 }, 3)).toBe(true);
  });

  it('hits a single-point stroke as a dot', () => {
    const dot: InkObject = {
      id: 'dot', author: 'user', created_at: 0,
      content: {
        kind: 'stroke', samples: [{ x: 14, y: 18, pressure: 0.5 }],
        style: { tool: 'pen', color: '#000000', width: 4, pressure_enabled: false },
      },
    };

    expect(objectHitTest(dot, { x: 16, y: 18 }, 1)).toBe(true);
    expect(objectHitTest(dot, { x: 20, y: 18 }, 1)).toBe(false);
  });
});
