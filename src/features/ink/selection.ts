/**
 * Stage C1 pure selection geometry.
 *
 * - objectIntersectsPolygon: polygon is implicitly closed. Strokes and arrows
 *   are tested as pressure-aware round-capped thick polylines (tapered quads
 *   plus per-sample discs, matching renderer.ts), not by their sample-point
 *   bounding box. rect/ellipse are hollow contour bands of width / 2.
 *   text/region_highlight are filled rects. Non-finite geometry and
 *   polygons with fewer than 3 points return false.
 * - selectionBounds: tight bounds of the finite points, or null when none.
 * - selectedInkObjects: whole page objects in page order whose geometry
 *   intersects the polygon; never splits strokes and never includes background.
 *
 * Coordinates are logical units and may be signed. No page-origin clamp is
 * applied here; fixed-page bounds are enforced by clipboard placement.
 */
import {
  pointInConvexPolygon,
  pressureWidth,
  segmentToEllipseOutlineDistance,
  taperedSegmentQuad,
} from './geometryPrimitives';
import type { InkObject, InkPage, InkPoint, InkRect } from './types';

const ON_SEGMENT_EPSILON = 1e-9;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function validPoint(point: InkPoint): boolean {
  return !!point && finite(point.x) && finite(point.y);
}

function validPolygon(polygon: InkPoint[]): boolean {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  for (const point of polygon) {
    if (!validPoint(point)) return false;
  }
  return true;
}

function validRect(rect: InkRect): boolean {
  return !!rect && finite(rect.x) && finite(rect.y) && finite(rect.width) && finite(rect.height)
    && rect.width > 0 && rect.height > 0;
}

function pointInRect(point: InkPoint, rect: InkRect, padding = 0): boolean {
  return point.x >= rect.x - padding && point.x <= rect.x + rect.width + padding
    && point.y >= rect.y - padding && point.y <= rect.y + rect.height + padding;
}

function pointOnSegment(point: InkPoint, start: InkPoint, end: InkPoint): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return point.x === start.x && point.y === start.y;
  const cross = (point.x - start.x) * dy - (point.y - start.y) * dx;
  const scale = Math.max(1, Math.abs(dx) + Math.abs(dy));
  if (Math.abs(cross) > ON_SEGMENT_EPSILON * scale) return false;
  const dot = (point.x - start.x) * dx + (point.y - start.y) * dy;
  return dot >= 0 && dot <= lengthSquared;
}

function pointInPolygon(point: InkPoint, polygon: InkPoint[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const start = polygon[previous];
    const end = polygon[index];
    if (pointOnSegment(point, start, end)) return true;
    if (
      (end.y > point.y) !== (start.y > point.y)
      && point.x < ((start.x - end.x) * (point.y - end.y)) / (start.y - end.y) + end.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

export function distancePointToSegment(point: InkPoint, start: InkPoint, end: InkPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  );
  return Math.hypot(point.x - (start.x + projection * dx), point.y - (start.y + projection * dy));
}

function orientation(a: InkPoint, b: InkPoint, c: InkPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegmentCollinear(a: InkPoint, b: InkPoint, point: InkPoint): boolean {
  return point.x >= Math.min(a.x, b.x) - ON_SEGMENT_EPSILON
    && point.x <= Math.max(a.x, b.x) + ON_SEGMENT_EPSILON
    && point.y >= Math.min(a.y, b.y) - ON_SEGMENT_EPSILON
    && point.y <= Math.max(a.y, b.y) + ON_SEGMENT_EPSILON;
}

function segmentsIntersect(a: InkPoint, b: InkPoint, c: InkPoint, d: InkPoint): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);

  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
    return true;
  }
  if (o1 === 0 && onSegmentCollinear(a, b, c)) return true;
  if (o2 === 0 && onSegmentCollinear(a, b, d)) return true;
  if (o3 === 0 && onSegmentCollinear(c, d, a)) return true;
  if (o4 === 0 && onSegmentCollinear(c, d, b)) return true;
  return false;
}

/**
 * Capsule (round-capped thick segment) vs polygon intersection.
 * Covers axis-inside-polygon, polygon-inside-capsule, edge crossing, and
 * near-edge contact without expanding the stroke into a bounding box.
 */
function capsuleIntersectsPolygon(
  start: InkPoint,
  end: InkPoint,
  radius: number,
  polygon: InkPoint[],
): boolean {
  const extent = Math.max(0, radius);
  if (pointInPolygon(start, polygon) || pointInPolygon(end, polygon)) return true;

  for (const point of polygon) {
    if (distancePointToSegment(point, start, end) <= extent) return true;
  }

  for (let index = 0; index < polygon.length; index += 1) {
    const edgeStart = polygon[index];
    const edgeEnd = polygon[(index + 1) % polygon.length];
    if (segmentsIntersect(start, end, edgeStart, edgeEnd)) return true;
    if (distancePointToSegment(start, edgeStart, edgeEnd) <= extent) return true;
    if (distancePointToSegment(end, edgeStart, edgeEnd) <= extent) return true;
  }
  return false;
}

function discIntersectsPolygon(center: InkPoint, radius: number, polygon: InkPoint[]): boolean {
  if (pointInPolygon(center, polygon)) return true;
  for (let index = 0; index < polygon.length; index += 1) {
    if (distancePointToSegment(center, polygon[index], polygon[(index + 1) % polygon.length]) <= radius) {
      return true;
    }
  }
  return false;
}

function quadIntersectsPolygon(quad: InkPoint[], polygon: InkPoint[]): boolean {
  for (const point of polygon) {
    if (pointInConvexPolygon(point, quad)) return true;
  }
  for (const corner of quad) {
    if (pointInPolygon(corner, polygon)) return true;
  }
  for (let index = 0; index < polygon.length; index += 1) {
    const edgeStart = polygon[index];
    const edgeEnd = polygon[(index + 1) % polygon.length];
    for (let side = 0; side < quad.length; side += 1) {
      if (segmentsIntersect(edgeStart, edgeEnd, quad[side], quad[(side + 1) % quad.length])) {
        return true;
      }
    }
  }
  return false;
}

function strokeIntersectsPolygon(
  content: Extract<InkObject['content'], { kind: 'stroke' }>,
  polygon: InkPoint[],
): boolean {
  const { samples, style } = content;
  if (!Array.isArray(samples) || samples.length === 0) return false;
  if (!finite(style.width) || style.width <= 0) return false;

  const halfWidths: number[] = [];
  for (const sample of samples) {
    if (!validPoint(sample)) return false;
    halfWidths.push(pressureWidth(sample, style.width, style.pressure_enabled) / 2);
  }

  for (let index = 0; index < samples.length; index += 1) {
    const point = samples[index];
    if (discIntersectsPolygon(point, halfWidths[index], polygon)) return true;
    if (index > 0) {
      const previous = samples[index - 1];
      const quad = taperedSegmentQuad(previous, point, halfWidths[index - 1], halfWidths[index]);
      if (quad && quadIntersectsPolygon(quad, polygon)) return true;
    }
  }
  return false;
}

function rectOutlineIntersectsPolygon(rect: InkRect, width: number, polygon: InkPoint[]): boolean {
  if (!validRect(rect) || !finite(width) || width < 0) return false;
  const radius = width / 2;
  const corners: InkPoint[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
  for (let index = 0; index < 4; index += 1) {
    if (capsuleIntersectsPolygon(corners[index], corners[(index + 1) % 4], radius, polygon)) return true;
  }
  return false;
}

function ellipseIntersectsPolygon(rect: InkRect, width: number, polygon: InkPoint[]): boolean {
  if (!validRect(rect) || !finite(width) || width < 0) return false;
  const radiusX = rect.width / 2;
  const radiusY = rect.height / 2;
  const centerX = rect.x + radiusX;
  const centerY = rect.y + radiusY;

  // A polygon that covers the whole outline selects the ellipse even when its
  // own edges never come near the contour.
  const extrema: InkPoint[] = [
    { x: centerX - radiusX, y: centerY },
    { x: centerX + radiusX, y: centerY },
    { x: centerX, y: centerY - radiusY },
    { x: centerX, y: centerY + radiusY },
  ];
  for (const point of extrema) {
    if (pointInPolygon(point, polygon)) return true;
  }

  const padding = width / 2;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    if (segmentToEllipseOutlineDistance(start, end, rect) <= padding) return true;
  }
  return false;
}

function filledRectIntersectsPolygon(rect: InkRect, polygon: InkPoint[]): boolean {
  if (!validRect(rect)) return false;
  const corners: InkPoint[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
  for (const corner of corners) {
    if (pointInPolygon(corner, polygon)) return true;
  }
  for (const point of polygon) {
    if (pointInRect(point, rect)) return true;
  }
  for (let index = 0; index < 4; index += 1) {
    const edgeStart = corners[index];
    const edgeEnd = corners[(index + 1) % 4];
    for (let edge = 0; edge < polygon.length; edge += 1) {
      if (segmentsIntersect(edgeStart, edgeEnd, polygon[edge], polygon[(edge + 1) % polygon.length])) {
        return true;
      }
    }
  }
  return false;
}

function arrowIntersectsPolygon(
  content: Extract<InkObject['content'], { kind: 'arrow' }>,
  polygon: InkPoint[],
): boolean {
  const { from, to, width } = content;
  if (!validPoint(from) || !validPoint(to) || !finite(width) || width <= 0) return false;
  const radius = width / 2;
  if (capsuleIntersectsPolygon(from, to, radius, polygon)) return true;

  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const headLength = Math.max(8, width * 4);
  for (const side of [-1, 1]) {
    const headPoint: InkPoint = {
      x: to.x - headLength * Math.cos(angle + (side * Math.PI) / 6),
      y: to.y - headLength * Math.sin(angle + (side * Math.PI) / 6),
    };
    if (capsuleIntersectsPolygon(to, headPoint, radius, polygon)) return true;
  }
  return false;
}

export function objectIntersectsPolygon(object: InkObject, polygon: InkPoint[]): boolean {
  if (!object || !validPolygon(polygon)) return false;
  const content = object.content;
  if (!content || typeof content !== 'object') return false;

  switch (content.kind) {
    case 'stroke':
      return strokeIntersectsPolygon(content, polygon);
    case 'rect':
      return rectOutlineIntersectsPolygon(content.rect, content.width, polygon);
    case 'ellipse':
      return ellipseIntersectsPolygon(content.rect, content.width, polygon);
    case 'text':
    case 'region_highlight':
      return filledRectIntersectsPolygon(content.rect, polygon);
    case 'arrow':
      return arrowIntersectsPolygon(content, polygon);
    default:
      return false;
  }
}

export function selectionBounds(points: InkPoint[]): InkRect | null {
  if (!Array.isArray(points)) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let count = 0;

  for (const point of points) {
    if (!validPoint(point)) continue;
    count += 1;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  if (count === 0) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function selectedInkObjects(page: InkPage, polygon: InkPoint[]): InkObject[] {
  if (!page || !Array.isArray(page.objects) || !validPolygon(polygon)) return [];
  return page.objects.filter((object) => objectIntersectsPolygon(object, polygon));
}
