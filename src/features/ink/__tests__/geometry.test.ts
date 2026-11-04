import { describe, expect, it } from 'vitest';
import type { InkObject, InkViewport } from '../geometry';
import { mapCropPoint, objectHitTest, objectHitTestSweep, pageToScreen, screenToPage } from '../geometry';
import { pointToEllipseOutlineDistance, segmentToEllipseOutlineDistance } from '../geometryPrimitives';

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

  it('matches the renderer pressureWidth floor and taper for stroke hit and sweep', () => {
    // renderer.ts pressureWidth (lines 47-50) is
    //   max(0.01, baseWidth * (pressureEnabled ? 0.25 + 0.75p : 1)),
    // so a 0.001-wide stroke paints a 0.005 half-width rim. geometry.ts
    // widthAt (lines 135-139, 254-258) has no floor and uses 0.0005.
    const wire: InkObject = {
      id: 'wire', author: 'user', created_at: 0,
      content: {
        kind: 'stroke',
        samples: [{ x: 0, y: 0, pressure: 0.5 }, { x: 10, y: 0, pressure: 0.5 }],
        style: { tool: 'pen', color: '#000000', width: 0.001, pressure_enabled: false },
      },
    };
    expect(objectHitTest(wire, { x: 5, y: 0.002 }, 0)).toBe(true);
    expect(objectHitTestSweep(wire, { x: 5, y: 0.002 }, { x: 6, y: 0.002 }, 0)).toBe(true);

    // renderer.ts (lines 61-76) fills a trapezoid between per-sample radii, so
    // at x=90 the painted half-width is 0.125 + 0.9 * (0.5 - 0.125) = 0.4625.
    // geometry.ts (line 266) uses the segment average 0.3125, and the nearest
    // sample circle (x=100) is 10.008 away.
    const taper: InkObject = {
      id: 'taper', author: 'user', created_at: 1,
      content: {
        kind: 'stroke',
        samples: [{ x: 0, y: 0, pressure: 0 }, { x: 100, y: 0, pressure: 1 }],
        style: { tool: 'pen', color: '#000000', width: 1, pressure_enabled: true },
      },
    };
    expect(objectHitTest(taper, { x: 90, y: 0.4 }, 0)).toBe(true);
    expect(objectHitTestSweep(taper, { x: 90, y: 0.4 }, { x: 91, y: 0.4 }, 0)).toBe(true);
  });

  it('sweeps a large thin ellipse at its rendered rim despite chord flattening', () => {
    // renderer.ts (lines 211-219) strokes the true ellipse with lineWidth 1,
    // covering 0.5 either side. geometry.ts (lines 227-244) flattens it to at
    // most 256 chords; for r=5000 each chord midpoint lies
    // r * (1 - cos(pi/256)) = 0.3765 inside the true rim. A point 0.4 outside
    // the ellipse is painted (0.4 < 0.5) but sits 0.7765 from the chord
    // polyline, beyond the radius + width / 2 = 0.5 threshold.
    const ellipse: InkObject = {
      id: 'ellipse', author: 'user', created_at: 0,
      content: {
        kind: 'ellipse',
        rect: { x: 0, y: 0, width: 10000, height: 10000 },
        color: '#000000',
        width: 1,
      },
    };
    const angle = Math.PI / 256;
    const rim = {
      x: 5000 + 5000.4 * Math.cos(angle),
      y: 5000 + 5000.4 * Math.sin(angle),
    };

    expect(objectHitTestSweep(ellipse, { x: rim.x, y: rim.y - 1 }, { x: rim.x, y: rim.y + 1 }, 0))
      .toBe(true);
  });

  it('measures a highly eccentric ellipse rim without losing its near-vertex branch', () => {
    // rect 16384 x 64 => radiusX 8192, radiusY 32. The first point is exactly
    // E(6.2769) = (centerX + 8192 cos t, centerY + 32 sin t), so its true
    // outline distance is 0; the previous uniform-Newton solver returned 1.8783.
    const rect = { x: 0, y: 0, width: 16384, height: 64 };
    const onRim = { x: 16383.838187699046, y: 31.798871494525844 };
    expect(pointToEllipseOutlineDistance(onRim, rect)).toBeCloseTo(0, 6);

    // Endpoint a lies 0.2 outside the true outline (endpoint b is 0.8 outside),
    // so the segment minimum is 0.2; the previous solver returned 1.3327.
    expect(segmentToEllipseOutlineDistance(
      { x: 16382.715342945288, y: 32.77142041842316 },
      { x: 16382.84257628689, y: 33.357774984181006 },
      rect,
    )).toBeCloseTo(0.2, 3);
  });

  it('keeps ellipse center and axis points exact at an extreme aspect ratio', () => {
    const rect = { x: 0, y: 0, width: 16384, height: 64 };

    // Center: minor semiaxis. Minor-axis interior: 32 - 10. Major-axis
    // exterior: 1000 beyond the right vertex.
    expect(pointToEllipseOutlineDistance({ x: 8192, y: 32 }, rect)).toBe(32);
    expect(pointToEllipseOutlineDistance({ x: 8192, y: 42 }, rect)).toBe(22);
    expect(pointToEllipseOutlineDistance({ x: 17384, y: 32 }, rect)).toBe(1000);
  });
});
