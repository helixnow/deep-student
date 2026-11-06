import { describe, expect, it } from 'vitest';
import type { InkObject, InkPage, InkPoint } from '../types';
import { objectIntersectsPolygon, selectedInkObjects, selectionBounds } from '../selection';

/**
 * Stage C1 pure contract for `src/features/ink/selection.ts`.
 *
 * Contract:
 *   objectIntersectsPolygon(object, polygon): boolean
 *   selectionBounds(points): InkRect | null
 *   selectedInkObjects(page, polygon): InkObject[]
 *
 * Semantics:
 * - polygon is implicitly closed; fewer than 3 finite points yields false / [].
 * - stroke selection uses the pressure-aware thick-line footprint, not the
 *   sample-point bounding box.
 * - rect/ellipse are hollow: only the contour band (width / 2) may intersect.
 * - text/region_highlight are filled: their interior may intersect.
 * - selectedInkObjects preserves page order and returns whole objects.
 */
function polygon(x: number, y: number, width: number, height: number): InkPoint[] {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

function stroke(
  id: string,
  samples: Array<{ x: number; y: number; pressure?: number }>,
  width: number,
): InkObject {
  return {
    id,
    author: 'user',
    created_at: 0,
    content: {
      kind: 'stroke',
      samples: samples.map((sample) => ({ pressure: 0.5, ...sample })),
      style: { tool: 'pen', color: '#000000', width, pressure_enabled: false },
    },
  };
}

describe('ink selection (stage C pure contract)', () => {
  it('computes a tight selection bound and returns null when no finite points exist', () => {
    expect(selectionBounds([
      { x: 10, y: 20 },
      { x: 30, y: 5 },
      { x: 20, y: 40 },
    ])).toEqual({ x: 10, y: 5, width: 20, height: 35 });

    expect(selectionBounds([])).toBeNull();
    expect(selectionBounds([
      { x: Number.NaN, y: 5 },
      { x: Number.POSITIVE_INFINITY, y: 2 },
    ])).toBeNull();
  });

  it('selects a stroke by crossing its segment, not by its bounding-box interior', () => {
    const line = stroke('line', [{ x: 10, y: 10 }, { x: 90, y: 90 }], 2);

    // Inside the sample bounding box but ~39.6 units away from the diagonal segment.
    expect(objectIntersectsPolygon(line, polygon(18, 78, 4, 4))).toBe(false);
    // Crosses the segment at (50, 50).
    expect(objectIntersectsPolygon(line, polygon(48, 48, 4, 4))).toBe(true);
  });

  it('selects by the true thick-line footprint outside the sample-point bounding box', () => {
    const thick = stroke('thick', [{ x: 0, y: 50 }, { x: 100, y: 50 }], 20);

    // Sample points all have y = 50; footprint reaches y = 60 and this polygon starts at 56.
    expect(objectIntersectsPolygon(thick, polygon(46, 56, 8, 4))).toBe(true);
    // Two units beyond the 10-unit half-width.
    expect(objectIntersectsPolygon(thick, polygon(46, 62, 8, 4))).toBe(false);
  });

  it('selects the renderer-visible rim of a sub-0.01-width stroke', () => {
    // renderer.ts pressureWidth (lines 47-50) clamps every sample to
    // max(0.01, baseWidth * ...), so a width 0.001 stroke paints a 0.005
    // half-width band. selection.ts (lines 153-156) uses the raw width / 2
    // (0.0005), so this polygon is wholly inside the painted band but outside
    // the geometry's half-width.
    const wire = stroke('wire', [{ x: 0, y: 0 }, { x: 10, y: 0 }], 0.001);

    expect(objectIntersectsPolygon(wire, polygon(4, 0.002, 2, 0.002))).toBe(true);
    // Control: past the 0.005 painted rim, outside both models.
    expect(objectIntersectsPolygon(wire, polygon(4, 0.006, 2, 0.001))).toBe(false);
  });

  it('does not select hollow ellipse or rect interiors unless the contour crosses the polygon', () => {
    const ellipse: InkObject = {
      id: 'ellipse',
      author: 'user',
      created_at: 0,
      content: {
        kind: 'ellipse',
        rect: { x: 20, y: 20, width: 60, height: 40 },
        color: '#000000',
        width: 4,
      },
    };
    const hollowRect: InkObject = {
      id: 'rect',
      author: 'user',
      created_at: 1,
      content: {
        kind: 'rect',
        rect: { x: 100, y: 20, width: 40, height: 40 },
        color: '#000000',
        width: 4,
      },
    };

    // Strictly interior boxes, far from the 2-unit contour bands.
    expect(objectIntersectsPolygon(ellipse, polygon(45, 38, 10, 4))).toBe(false);
    expect(objectIntersectsPolygon(hollowRect, polygon(115, 35, 10, 10))).toBe(false);

    // The left ellipse edge is x = 20, y = 40; the bottom rect edge is y = 60.
    expect(objectIntersectsPolygon(ellipse, polygon(18, 38, 4, 4))).toBe(true);
    expect(objectIntersectsPolygon(hollowRect, polygon(118, 58, 4, 4))).toBe(true);
  });

  it('treats text and region highlights as filled and returns whole objects in page order', () => {
    const region: InkObject = {
      id: 'region',
      author: 'user',
      created_at: 0,
      content: {
        kind: 'region_highlight',
        rect: { x: 10, y: 10, width: 30, height: 10 },
        color: '#ffee00',
        width: 1,
      },
    };
    const text: InkObject = {
      id: 'text',
      author: 'user',
      created_at: 1,
      content: {
        kind: 'text',
        rect: { x: 60, y: 10, width: 30, height: 10 },
        text: 'note',
        font_size: 12,
        color: '#000000',
      },
    };
    const hollowEllipse: InkObject = {
      id: 'ellipse',
      author: 'user',
      created_at: 2,
      content: {
        kind: 'ellipse',
        rect: { x: 110, y: 10, width: 30, height: 10 },
        color: '#000000',
        width: 2,
      },
    };
    const page: InkPage = {
      schema_version: 1,
      page_id: 'page-1',
      objects: [region, text, hollowEllipse],
    };

    // Broad region covers region + text, stops before the hollow ellipse at x = 110.
    expect(selectedInkObjects(page, polygon(5, 5, 90, 20)).map((object) => object.id))
      .toEqual(['region', 'text']);

    // Interior-only polygons prove both filled kinds are selectable away from their borders.
    expect(objectIntersectsPolygon(text, polygon(65, 12, 5, 5))).toBe(true);
    expect(objectIntersectsPolygon(region, polygon(15, 12, 5, 5))).toBe(true);

    // A polygon inside the hollow ellipse selects nothing.
    expect(selectedInkObjects(page, polygon(122, 13, 6, 4)).map((object) => object.id))
      .toEqual([]);
  });

  it('selects a highly eccentric ellipse whose rendered rim reaches a polygon edge', () => {
    // rect 16384 x 64, line width 1 => the painted band is 0.5 either side.
    // Edge a->b stays 0.2 from the true outline (a alone is 0.2 outside), so
    // the renderer paints it; the previous solver reported 1.3327 for that
    // edge, left the whole polygon at 0.8304, and did not select the object.
    const ellipse: InkObject = {
      id: 'wide-ellipse', author: 'user', created_at: 0,
      content: {
        kind: 'ellipse',
        rect: { x: 0, y: 0, width: 16384, height: 64 },
        color: '#000000',
        width: 1,
      },
    };
    const a = { x: 16382.715342945288, y: 32.77142041842316 };
    const b = { x: 16382.84257628689, y: 33.357774984181006 };
    const polygonNearRim = [
      a,
      b,
      { x: b.x + 1, y: b.y },
      { x: a.x + 1, y: a.y },
    ];

    expect(objectIntersectsPolygon(ellipse, polygonNearRim)).toBe(true);
  });
});
