import {
  pointToEllipseOutlineDistance,
  pointToTaperedSegmentDistance,
  pressureWidth,
  segmentToEllipseOutlineDistance,
  segmentToTaperedSegmentDistance,
} from './geometryPrimitives';
import type { InkObject, InkPoint, InkRect } from './types';

export type { InkObject, InkPoint, InkRect } from './types';

export interface InkViewport {
  left: number;
  top: number;
  scale: number;
  pan_x: number;
  pan_y: number;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function assertPoint(point: InkPoint): void {
  if (!finite(point.x) || !finite(point.y)) throw new RangeError('Point coordinates must be finite');
}

function assertViewport(viewport: InkViewport): void {
  if (
    !finite(viewport.left) || !finite(viewport.top) || !finite(viewport.pan_x) || !finite(viewport.pan_y)
    || !finite(viewport.scale) || viewport.scale <= 0
  ) throw new RangeError('Viewport values must be finite and scale must be positive');
}

export function screenToPage(point: InkPoint, viewport: InkViewport): InkPoint {
  assertPoint(point);
  assertViewport(viewport);
  return {
    x: (point.x - viewport.left - viewport.pan_x) / viewport.scale,
    y: (point.y - viewport.top - viewport.pan_y) / viewport.scale,
  };
}

export function pageToScreen(point: InkPoint, viewport: InkViewport): InkPoint {
  assertPoint(point);
  assertViewport(viewport);
  return {
    x: viewport.left + viewport.pan_x + point.x * viewport.scale,
    y: viewport.top + viewport.pan_y + point.y * viewport.scale,
  };
}

export function mapCropPoint(
  point: InkPoint,
  crop: InkRect,
  pageSize: { width: number; height: number },
): InkPoint {
  assertPoint(point);
  if (
    !finite(crop.x) || !finite(crop.y) || !finite(crop.width) || !finite(crop.height)
    || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0
    || !finite(pageSize.width) || !finite(pageSize.height) || pageSize.width <= 0 || pageSize.height <= 0
    || crop.x + crop.width > pageSize.width || crop.y + crop.height > pageSize.height
  ) throw new RangeError('Crop must be positive finite geometry inside the page');
  if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
    throw new RangeError('Normalized crop point must be between zero and one');
  }
  return { x: crop.x + point.x * crop.width, y: crop.y + point.y * crop.height };
}

function distanceToSegment(point: InkPoint, start: InkPoint, end: InkPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + projection * dx), point.y - (start.y + projection * dy));
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

function pointOnSegment(point: InkPoint, start: InkPoint, end: InkPoint): boolean {
  return Math.abs(cross(end.x - start.x, end.y - start.y, point.x - start.x, point.y - start.y)) < 1e-9
    && point.x >= Math.min(start.x, end.x) - 1e-9 && point.x <= Math.max(start.x, end.x) + 1e-9
    && point.y >= Math.min(start.y, end.y) - 1e-9 && point.y <= Math.max(start.y, end.y) + 1e-9;
}

function segmentsIntersect(aStart: InkPoint, aEnd: InkPoint, bStart: InkPoint, bEnd: InkPoint): boolean {
  const d1 = cross(aEnd.x - aStart.x, aEnd.y - aStart.y, bStart.x - aStart.x, bStart.y - aStart.y);
  const d2 = cross(aEnd.x - aStart.x, aEnd.y - aStart.y, bEnd.x - aStart.x, bEnd.y - aStart.y);
  const d3 = cross(bEnd.x - bStart.x, bEnd.y - bStart.y, aStart.x - bStart.x, aStart.y - bStart.y);
  const d4 = cross(bEnd.x - bStart.x, bEnd.y - bStart.y, aEnd.x - bStart.x, aEnd.y - bStart.y);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return pointOnSegment(bStart, aStart, aEnd) || pointOnSegment(bEnd, aStart, aEnd)
    || pointOnSegment(aStart, bStart, bEnd) || pointOnSegment(aEnd, bStart, bEnd);
}

/** Exact minimum distance between two line segments. */
function distanceSegmentToSegment(aStart: InkPoint, aEnd: InkPoint, bStart: InkPoint, bEnd: InkPoint): number {
  if (segmentsIntersect(aStart, aEnd, bStart, bEnd)) return 0;
  return Math.min(
    distanceToSegment(aStart, bStart, bEnd),
    distanceToSegment(aEnd, bStart, bEnd),
    distanceToSegment(bStart, aStart, aEnd),
    distanceToSegment(bEnd, aStart, aEnd),
  );
}


function validRect(rect: InkRect): boolean {
  return finite(rect.x) && finite(rect.y) && finite(rect.width) && finite(rect.height) && rect.width > 0 && rect.height > 0;
}

function insideRect(point: InkPoint, rect: InkRect, padding = 0): boolean {
  return point.x >= rect.x - padding && point.x <= rect.x + rect.width + padding
    && point.y >= rect.y - padding && point.y <= rect.y + rect.height + padding;
}

function hitRectOutline(point: InkPoint, rect: InkRect, padding: number): boolean {
  if (!validRect(rect)) return false;
  const outer = insideRect(point, rect, padding);
  const inner = point.x > rect.x + padding && point.x < rect.x + rect.width - padding
    && point.y > rect.y + padding && point.y < rect.y + rect.height - padding;
  return outer && !inner;
}

function hitEllipseOutline(point: InkPoint, rect: InkRect, padding: number): boolean {
  if (!validRect(rect)) return false;
  return pointToEllipseOutlineDistance(point, rect) <= padding;
}

function hitStroke(object: Extract<InkObject['content'], { kind: 'stroke' }>, point: InkPoint, radius: number): boolean {
  const { samples, style } = object;
  if (!samples.length || !finite(style.width) || style.width <= 0) return false;
  let previousIndex = -1;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (!finite(sample.x) || !finite(sample.y)) continue;
    const halfWidth = pressureWidth(sample, style.width, style.pressure_enabled) / 2;
    if (Math.hypot(point.x - sample.x, point.y - sample.y) <= radius + halfWidth) return true;
    if (previousIndex >= 0) {
      const previous = samples[previousIndex];
      const previousHalfWidth = pressureWidth(previous, style.width, style.pressure_enabled) / 2;
      // The footprint stays inside a capsule of the larger sample radius, so
      // far samples skip trapezoid construction entirely.
      if (distanceToSegment(point, previous, sample) <= radius + Math.max(previousHalfWidth, halfWidth)
        && pointToTaperedSegmentDistance(point, previous, sample, previousHalfWidth, halfWidth) <= radius) {
        return true;
      }
    }
    previousIndex = index;
  }
  return false;
}

export function objectHitTest(object: InkObject, point: InkPoint, radius: number): boolean {
  assertPoint(point);
  if (!finite(radius) || radius < 0) throw new RangeError('Hit-test radius must be finite and nonnegative');

  const content = object.content;
  switch (content.kind) {
    case 'stroke':
      return hitStroke(content, point, radius);
    case 'text':
      return validRect(content.rect) && insideRect(point, content.rect, radius);
    case 'region_highlight':
      return validRect(content.rect) && insideRect(point, content.rect, radius);
    case 'rect':
      return hitRectOutline(point, content.rect, radius + Math.max(0, content.width) / 2);
    case 'ellipse':
      return hitEllipseOutline(point, content.rect, radius + Math.max(0, content.width) / 2);
    case 'arrow': {
      if (!finite(content.from.x) || !finite(content.from.y) || !finite(content.to.x) || !finite(content.to.y)) return false;
      const extent = radius + Math.max(0, content.width) / 2;
      if (distanceToSegment(point, content.from, content.to) <= extent) return true;
      const angle = Math.atan2(content.to.y - content.from.y, content.to.x - content.from.x);
      const headLength = Math.max(8, content.width * 4);
      for (const side of [-1, 1]) {
        const headPoint = {
          x: content.to.x - headLength * Math.cos(angle + side * Math.PI / 6),
          y: content.to.y - headLength * Math.sin(angle + side * Math.PI / 6),
        };
        if (distanceToSegment(point, content.to, headPoint) <= extent) return true;
      }
      return false;
    }
  }
}

function rectEdges(rect: InkRect): Array<[InkPoint, InkPoint]> {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return [
    [{ x: rect.x, y: rect.y }, { x: right, y: rect.y }],
    [{ x: right, y: rect.y }, { x: right, y: bottom }],
    [{ x: right, y: bottom }, { x: rect.x, y: bottom }],
    [{ x: rect.x, y: bottom }, { x: rect.x, y: rect.y }],
  ];
}

/** Exact distance from a segment to the filled area of an axis-aligned rect. */
function distanceSegmentToRect(start: InkPoint, end: InkPoint, rect: InkRect): number {
  if (!validRect(rect)) return Number.POSITIVE_INFINITY;
  if (insideRect(start, rect) || insideRect(end, rect)) return 0;
  let distance = Number.POSITIVE_INFINITY;
  for (const [edgeStart, edgeEnd] of rectEdges(rect)) {
    distance = Math.min(distance, distanceSegmentToSegment(start, end, edgeStart, edgeEnd));
  }
  return distance;
}

/** Exact distance from a segment to a rect outline (its stroke centerline). */
function distanceSegmentToRectOutline(start: InkPoint, end: InkPoint, rect: InkRect): number {
  if (!validRect(rect)) return Number.POSITIVE_INFINITY;
  let distance = Number.POSITIVE_INFINITY;
  for (const [edgeStart, edgeEnd] of rectEdges(rect)) {
    distance = Math.min(distance, distanceSegmentToSegment(start, end, edgeStart, edgeEnd));
  }
  return distance;
}

/**
 * Distance from a segment to an ellipse outline. The shared helper uses a
 * bounded analytic search (endpoint minima plus tangent-parallel stationary
 * points) instead of a fixed chord count, so large thin ellipses do not lose
 * their visible rim on mobile-sized budgets.
 */
function distanceSegmentToEllipseOutline(start: InkPoint, end: InkPoint, rect: InkRect): number {
  return segmentToEllipseOutlineDistance(start, end, rect);
}

function hitStrokeSweep(
  object: Extract<InkObject['content'], { kind: 'stroke' }>,
  start: InkPoint,
  end: InkPoint,
  radius: number,
): boolean {
  const { samples, style } = object;
  if (!samples.length || !finite(style.width) || style.width <= 0) return false;
  let previousIndex = -1;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (!finite(sample.x) || !finite(sample.y)) continue;
    const halfWidth = pressureWidth(sample, style.width, style.pressure_enabled) / 2;
    if (distanceToSegment(sample, start, end) <= radius + halfWidth) return true;
    if (previousIndex >= 0) {
      const previous = samples[previousIndex];
      const previousHalfWidth = pressureWidth(previous, style.width, style.pressure_enabled) / 2;
      if (distanceSegmentToSegment(start, end, previous, sample) <= radius + Math.max(previousHalfWidth, halfWidth)
        && segmentToTaperedSegmentDistance(start, end, previous, sample, previousHalfWidth, halfWidth) <= radius) {
        return true;
      }
    }
    previousIndex = index;
  }
  return false;
}

/**
 * Whole-object eraser sweep hit test.
 *
 * `start` and `end` are adjacent pointer samples in logical page units. The
 * capsule between them is intersected analytically with each editable object
 * shape, so a single fast pointer move cannot skip an object between samples.
 */
export function objectHitTestSweep(object: InkObject, start: InkPoint, end: InkPoint, radius: number): boolean {
  assertPoint(start);
  assertPoint(end);
  if (!finite(radius) || radius < 0) throw new RangeError('Hit-test radius must be finite and nonnegative');

  const content = object.content;
  switch (content.kind) {
    case 'stroke':
      return hitStrokeSweep(content, start, end, radius);
    case 'text':
    case 'region_highlight':
      return distanceSegmentToRect(start, end, content.rect) <= radius;
    case 'rect':
      return distanceSegmentToRectOutline(start, end, content.rect) <= radius + Math.max(0, content.width) / 2;
    case 'ellipse':
      return distanceSegmentToEllipseOutline(start, end, content.rect) <= radius + Math.max(0, content.width) / 2;
    case 'arrow': {
      const extent = radius + Math.max(0, content.width) / 2;
      if (distanceSegmentToSegment(start, end, content.from, content.to) <= extent) return true;
      const angle = Math.atan2(content.to.y - content.from.y, content.to.x - content.from.x);
      const headLength = Math.max(8, content.width * 4);
      for (const side of [-1, 1]) {
        const headPoint = {
          x: content.to.x - headLength * Math.cos(angle + side * Math.PI / 6),
          y: content.to.y - headLength * Math.sin(angle + side * Math.PI / 6),
        };
        if (distanceSegmentToSegment(start, end, content.to, headPoint) <= extent) return true;
      }
      return false;
    }
  }
}
