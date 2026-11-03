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
  const rx = rect.width / 2;
  const ry = rect.height / 2;
  const dx = point.x - (rect.x + rx);
  const dy = point.y - (rect.y + ry);
  const normalized = Math.hypot(dx / rx, dy / ry);
  return Math.abs(normalized - 1) * Math.min(rx, ry) <= padding;
}

function hitStroke(object: Extract<InkObject['content'], { kind: 'stroke' }>, point: InkPoint, radius: number): boolean {
  const { samples, style } = object;
  if (!samples.length || !finite(style.width) || style.width <= 0) return false;
  const widthAt = (index: number) => {
    const sample = samples[index];
    const pressure = finite(sample.pressure) ? Math.max(0, Math.min(1, sample.pressure)) : 0.5;
    return style.width * (style.pressure_enabled ? 0.25 + 0.75 * pressure : 1);
  };
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (!finite(sample.x) || !finite(sample.y)) continue;
    const extent = radius + widthAt(index) / 2;
    if (index === 0 && Math.hypot(point.x - sample.x, point.y - sample.y) <= extent) return true;
    if (index > 0) {
      const previous = samples[index - 1];
      if (!finite(previous.x) || !finite(previous.y)) continue;
      const segmentExtent = radius + (widthAt(index - 1) + widthAt(index)) / 4;
      if (distanceToSegment(point, previous, sample) <= segmentExtent) return true;
    }
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
