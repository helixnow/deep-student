/**
 * Shared ink geometry primitives.
 *
 * The renderer paints a stroke as a disc per finite sample plus, for every
 * consecutive pair, a trapezoid whose end radii are the two sample radii
 * (renderer.ts `drawStrokePath`). These helpers expose that same footprint and
 * a bounded, analytic ellipse outline distance so hit-testing, sweep erasing,
 * selection, and clipboard placement cannot drift from the visible ink.
 */
import type { InkObjectContent, InkPoint, InkRect, InkSample } from './types';

/** Renderer floor for every painted stroke sample width. */
export const MIN_STROKE_WIDTH = 0.01;

export function pressureWidth(
  sample: InkSample,
  baseWidth: number,
  pressureEnabled: boolean,
): number {
  const pressure = Number.isFinite(sample.pressure)
    ? Math.max(0, Math.min(1, sample.pressure))
    : 0.5;
  return Math.max(MIN_STROKE_WIDTH, baseWidth * (pressureEnabled ? 0.25 + 0.75 * pressure : 1));
}

function finitePoint(point: InkPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function validVisibleRect(rect: InkRect): boolean {
  return Number.isFinite(rect.x) && Number.isFinite(rect.y)
    && Number.isFinite(rect.width) && Number.isFinite(rect.height)
    && rect.width > 0 && rect.height > 0;
}

/**
 * Bounds of what `renderer.ts` actually paints, using the same per-sample
 * pressure widths and arrowhead geometry. Region and text pads stay at zero
 * because the renderer fills/clips to their control rect. This is intentionally
 * tighter than the coarse culling box in `boardRenderer.ts`.
 */
export function visibleInkObjectBounds(content: InkObjectContent): InkRect | null {
  switch (content.kind) {
    case 'stroke': {
      if (!Number.isFinite(content.style.width) || content.style.width <= 0) return null;
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      let visible = false;
      for (const sample of content.samples) {
        if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y)) continue;
        visible = true;
        const radius = pressureWidth(sample, content.style.width, content.style.pressure_enabled) / 2;
        minX = Math.min(minX, sample.x - radius);
        minY = Math.min(minY, sample.y - radius);
        maxX = Math.max(maxX, sample.x + radius);
        maxY = Math.max(maxY, sample.y + radius);
      }
      if (!visible) return null;
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    case 'text':
    case 'region_highlight':
      return validVisibleRect(content.rect) ? { ...content.rect } : null;
    case 'rect':
    case 'ellipse': {
      if (!validVisibleRect(content.rect) || !Number.isFinite(content.width) || content.width <= 0) {
        return null;
      }
      const padding = content.width / 2;
      return {
        x: content.rect.x - padding,
        y: content.rect.y - padding,
        width: content.rect.width + padding * 2,
        height: content.rect.height + padding * 2,
      };
    }
    case 'arrow': {
      const { from, to, width } = content;
      if (!finitePoint(from) || !finitePoint(to) || !Number.isFinite(width) || width <= 0) {
        return null;
      }
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const headLength = Math.max(8, width * 4);
      const halfWidth = width / 2;
      const headA = {
        x: to.x - headLength * Math.cos(angle - Math.PI / 6),
        y: to.y - headLength * Math.sin(angle - Math.PI / 6),
      };
      const headB = {
        x: to.x - headLength * Math.cos(angle + Math.PI / 6),
        y: to.y - headLength * Math.sin(angle + Math.PI / 6),
      };
      const minX = Math.min(from.x, to.x, headA.x, headB.x) - halfWidth;
      const minY = Math.min(from.y, to.y, headA.y, headB.y) - halfWidth;
      const maxX = Math.max(from.x, to.x, headA.x, headB.x) + halfWidth;
      const maxY = Math.max(from.y, to.y, headA.y, headB.y) + halfWidth;
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    default:
      return null;
  }
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
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return pointOnSegment(bStart, aStart, aEnd) || pointOnSegment(bEnd, aStart, aEnd)
    || pointOnSegment(aStart, bStart, bEnd) || pointOnSegment(aEnd, bStart, bEnd);
}

function distanceSegmentToSegment(
  aStart: InkPoint,
  aEnd: InkPoint,
  bStart: InkPoint,
  bEnd: InkPoint,
): number {
  if (segmentsIntersect(aStart, aEnd, bStart, bEnd)) return 0;
  return Math.min(
    distancePointToSegment(aStart, bStart, bEnd),
    distancePointToSegment(aEnd, bStart, bEnd),
    distancePointToSegment(bStart, aStart, aEnd),
    distancePointToSegment(bEnd, aStart, aEnd),
  );
}

/** The four renderer trapezoid corners, or null for a zero-length segment. */
export function taperedSegmentQuad(
  start: InkPoint,
  end: InkPoint,
  startRadius: number,
  endRadius: number,
): InkPoint[] | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) return null;
  const normalX = -dy / length;
  const normalY = dx / length;
  const r0 = Math.max(0, startRadius);
  const r1 = Math.max(0, endRadius);
  return [
    { x: start.x + normalX * r0, y: start.y + normalY * r0 },
    { x: start.x - normalX * r0, y: start.y - normalY * r0 },
    { x: end.x - normalX * r1, y: end.y - normalY * r1 },
    { x: end.x + normalX * r1, y: end.y + normalY * r1 },
  ];
}

export function pointInConvexPolygon(point: InkPoint, vertices: InkPoint[]): boolean {
  if (vertices.length < 3) return false;
  let positive = false;
  let negative = false;
  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index];
    const end = vertices[(index + 1) % vertices.length];
    const side = cross(end.x - start.x, end.y - start.y, point.x - start.x, point.y - start.y);
    if (side > 0) positive = true;
    else if (side < 0) negative = true;
    if (positive && negative) return false;
  }
  return true;
}

function pointToConvexPolygonDistance(point: InkPoint, vertices: InkPoint[]): number {
  if (pointInConvexPolygon(point, vertices)) return 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < vertices.length; index += 1) {
    distance = Math.min(distance, distancePointToSegment(point, vertices[index], vertices[(index + 1) % vertices.length]));
  }
  return distance;
}

function segmentToConvexPolygonDistance(
  start: InkPoint,
  end: InkPoint,
  vertices: InkPoint[],
): number {
  if (pointInConvexPolygon(start, vertices) || pointInConvexPolygon(end, vertices)) return 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < vertices.length; index += 1) {
    const edgeStart = vertices[index];
    const edgeEnd = vertices[(index + 1) % vertices.length];
    if (segmentsIntersect(start, end, edgeStart, edgeEnd)) return 0;
    distance = Math.min(distance, distanceSegmentToSegment(start, end, edgeStart, edgeEnd));
  }
  return distance;
}

/**
 * Distance from a point to the union of one trapezoid and its two end discs.
 * This is the exact footprint the renderer fills for one stroke segment.
 */
export function pointToTaperedSegmentDistance(
  point: InkPoint,
  start: InkPoint,
  end: InkPoint,
  startRadius: number,
  endRadius: number,
): number {
  const r0 = Math.max(0, startRadius);
  const r1 = Math.max(0, endRadius);
  let distance = Math.min(
    Math.max(0, Math.hypot(point.x - start.x, point.y - start.y) - r0),
    Math.max(0, Math.hypot(point.x - end.x, point.y - end.y) - r1),
  );
  const quad = taperedSegmentQuad(start, end, r0, r1);
  if (quad) distance = Math.min(distance, pointToConvexPolygonDistance(point, quad));
  return distance;
}

/** Distance from a segment to the same trapezoid-plus-discs footprint. */
export function segmentToTaperedSegmentDistance(
  start: InkPoint,
  end: InkPoint,
  shapeStart: InkPoint,
  shapeEnd: InkPoint,
  startRadius: number,
  endRadius: number,
): number {
  const r0 = Math.max(0, startRadius);
  const r1 = Math.max(0, endRadius);
  let distance = Math.min(
    Math.max(0, distancePointToSegment(shapeStart, start, end) - r0),
    Math.max(0, distancePointToSegment(shapeEnd, start, end) - r1),
  );
  const quad = taperedSegmentQuad(shapeStart, shapeEnd, r0, r1);
  if (quad) distance = Math.min(distance, segmentToConvexPolygonDistance(start, end, quad));
  return distance;
}

function validEllipse(rect: InkRect): boolean {
  return Number.isFinite(rect.x) && Number.isFinite(rect.y)
    && Number.isFinite(rect.width) && Number.isFinite(rect.height)
    && rect.width > 0 && rect.height > 0;
}

/**
 * Distance from a point to the true ellipse outline.
 *
 * A circle keeps its closed form. Otherwise the point is folded into the first
 * quadrant by absolute value, the axes are ordered major/minor, and the
 * stationary condition
 *   g(t) = (B^2 - A^2) sin t cos t + A P sin t - B Q cos t
 * has exactly one sign change from g(0) = -BQ < 0 to g(pi/2) = AP > 0 for
 * P, Q > 0. A fixed 64-step bisection isolates that root; no starting-point or
 * world-size heuristic is involved. Center, minor-axis, and major-axis points
 * use their exact closed forms, which also keeps interior points stable.
 */
export function pointToEllipseOutlineDistance(point: InkPoint, rect: InkRect): number {
  if (!validEllipse(rect)) return Number.POSITIVE_INFINITY;
  const radiusX = rect.width / 2;
  const radiusY = rect.height / 2;
  const centerX = rect.x + radiusX;
  const centerY = rect.y + radiusY;
  const px = point.x - centerX;
  const py = point.y - centerY;
  if (radiusX === radiusY) return Math.abs(Math.hypot(px, py) - radiusX);

  let major = radiusX;
  let minor = radiusY;
  let alongMajor = Math.abs(px);
  let alongMinor = Math.abs(py);
  if (minor > major) {
    const swapRadius = major;
    major = minor;
    minor = swapRadius;
    const swapPoint = alongMajor;
    alongMajor = alongMinor;
    alongMinor = swapPoint;
  }

  const P = alongMajor;
  const Q = alongMinor;
  if (P === 0 && Q === 0) return minor;
  // Point on the minor axis: the nearest outline point is the minor vertex.
  if (P === 0) return Math.abs(Q - minor);
  // Point on the major axis: either the major vertex or the interior normal
  // that turns off the axis when P is inside the evolute threshold.
  if (Q === 0) {
    const threshold = (major * major - minor * minor) / major;
    if (P < threshold) {
      const cos = (major * P) / (major * major - minor * minor);
      const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
      return Math.hypot(major * cos - P, minor * sin);
    }
    return Math.abs(P - major);
  }

  const delta = minor * minor - major * major;
  let low = 0;
  let high = Math.PI / 2;
  for (let step = 0; step < 64; step += 1) {
    const mid = (low + high) / 2;
    if (mid === low || mid === high) break;
    const cos = Math.cos(mid);
    const sin = Math.sin(mid);
    const value = delta * sin * cos + major * P * sin - minor * Q * cos;
    if (value === 0) {
      low = mid;
      high = mid;
      break;
    }
    if (value < 0) low = mid;
    else high = mid;
  }
  const angle = (low + high) / 2;
  return Math.hypot(
    major * Math.cos(angle) - P,
    minor * Math.sin(angle) - Q,
  );
}

function segmentIntersectsEllipse(start: InkPoint, end: InkPoint, rect: InkRect): boolean {
  const radiusX = rect.width / 2;
  const radiusY = rect.height / 2;
  const centerX = rect.x + radiusX;
  const centerY = rect.y + radiusY;
  const u0 = (start.x - centerX) / radiusX;
  const v0 = (start.y - centerY) / radiusY;
  const u1 = (end.x - centerX) / radiusX;
  const v1 = (end.y - centerY) / radiusY;
  const du = u1 - u0;
  const dv = v1 - v0;
  const a = du * du + dv * dv;
  if (!(a > 0)) return false;
  const b = 2 * (u0 * du + v0 * dv);
  const c = u0 * u0 + v0 * v0 - 1;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return false;
  const root = Math.sqrt(discriminant);
  const first = (-b - root) / (2 * a);
  const second = (-b + root) / (2 * a);
  return (first >= 0 && first <= 1) || (second >= 0 && second <= 1);
}

/**
 * Distance from a segment to the true ellipse outline. Endpoint distances and
 * the two tangent-parallel stationary points cover the constrained minimum;
 * the bounded intersection test short-circuits genuine crossings to zero.
 */
export function segmentToEllipseOutlineDistance(
  start: InkPoint,
  end: InkPoint,
  rect: InkRect,
): number {
  if (!validEllipse(rect)) return Number.POSITIVE_INFINITY;
  if (segmentIntersectsEllipse(start, end, rect)) return 0;

  let best = Math.min(
    pointToEllipseOutlineDistance(start, rect),
    pointToEllipseOutlineDistance(end, rect),
  );
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!(lengthSquared > 0)) return best;

  const radiusX = rect.width / 2;
  const radiusY = rect.height / 2;
  const centerX = rect.x + radiusX;
  const centerY = rect.y + radiusY;
  const tangentA = radiusX * dy;
  const tangentB = radiusY * dx;
  if (tangentA === 0 && tangentB === 0) return best;

  const firstAngle = Math.atan2(-tangentB, tangentA);
  for (let side = 0; side < 2; side += 1) {
    const angle = firstAngle + side * Math.PI;
    const pointX = centerX + radiusX * Math.cos(angle);
    const pointY = centerY + radiusY * Math.sin(angle);
    const projection = ((pointX - start.x) * dx + (pointY - start.y) * dy) / lengthSquared;
    if (projection < 0 || projection > 1) continue;
    const nearestX = start.x + projection * dx;
    const nearestY = start.y + projection * dy;
    best = Math.min(best, Math.hypot(pointX - nearestX, pointY - nearestY));
  }
  return best;
}
