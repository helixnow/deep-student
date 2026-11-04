/**
 * E1 board renderer.
 *
 * Only the visible world rect is drawn into a viewport-sized backing store.
 * The board's logical bounds never become canvas dimensions: a board may span
 * ±10M world units while the canvas stays bounded by CSS size, DPR cap and the
 * 16M-pixel budget.
 *
 * Object drawing is delegated to the shared `renderInkPage` path by translating
 * visible objects into a viewport-local frame. That reuses stroke pressure,
 * highlighter compositing and text layout without editing the paged renderer.
 * The world-anchored ruling is drawn here because paged ruling is page-origin
 * based and would jump when the camera moves.
 */
import { cameraViewportRect, type Camera, type ViewportSize } from './camera';
import { drawObject } from './renderer';
import type { InkBoardBounds, InkBoardObject, InkBoardSurface, InkPoint, InkRect } from './types';

export const BOARD_MAX_PIXELS = 16_000_000;
export const BOARD_DPR_CAP = 2;
export const BOARD_GRID_SPACING = 24;
const BOARD_MAX_CANVAS_SIDE = 16_384;
const MAX_GRID_LINES = 4096;
const RULING_COLOR = '#d1d5db';

export interface BoardCanvasMetrics {
  /** CSS pixels. */
  cssWidth: number;
  cssHeight: number;
  /** Capped device pixel ratio. */
  dpr: number;
  /** Effective backing-store pixels per CSS pixel after the pixel budget. */
  pixelRatio: number;
  widthPx: number;
  heightPx: number;
}

export interface BoardRenderOptions {
  dpr?: number;
  maxPixels?: number;
  /** When true, skip background/ruling and draw objects only (overlay use). */
  transparent?: boolean;
  /**
   * Explicit CSS viewport for detached canvases. Without it the renderer uses
   * canvas.clientWidth/clientHeight, which are 0 for an unattached canvas.
   */
  viewport?: ViewportSize;
  /**
   * Explicit world rectangle to rasterize. Render/export callers already own
   * the crop, and their long-edge fit may be below the interactive camera zoom
   * floor; using their crop here keeps the full frozen range visible.
   */
  worldRect?: InkBoardBounds;
}

export interface BoardRenderResult {
  metrics: BoardCanvasMetrics;
  worldRect: InkBoardBounds;
  renderedObjectCount: number;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function validSize(width: number, height: number): boolean {
  return finite(width) && finite(height) && width > 0 && height > 0;
}

/** Caps DPR first, then lowers the effective pixel ratio until the budget fits. */
export function resolveBoardCanvasSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio = 1,
  maxPixels = BOARD_MAX_PIXELS,
): BoardCanvasMetrics {
  const width = validSize(cssWidth, cssHeight) ? cssWidth : 1;
  const height = validSize(cssWidth, cssHeight) ? cssHeight : 1;
  const budget = finite(maxPixels) && maxPixels >= 1
    ? Math.min(BOARD_MAX_PIXELS, Math.floor(maxPixels))
    : BOARD_MAX_PIXELS;
  const dpr = finite(devicePixelRatio) && devicePixelRatio > 0
    ? Math.min(BOARD_DPR_CAP, Math.max(1, devicePixelRatio))
    : 1;

  let pixelRatio = dpr;
  const sideLimit = Math.min(BOARD_MAX_CANVAS_SIDE / width, BOARD_MAX_CANVAS_SIDE / height);
  pixelRatio = Math.min(pixelRatio, sideLimit);

  let widthPx = Math.max(1, Math.floor(width * pixelRatio));
  let heightPx = Math.max(1, Math.floor(height * pixelRatio));
  for (let attempt = 0; attempt < 8 && widthPx * heightPx > budget; attempt += 1) {
    pixelRatio *= Math.sqrt((budget - 1) / (widthPx * heightPx));
    widthPx = Math.max(1, Math.floor(width * pixelRatio));
    heightPx = Math.max(1, Math.floor(height * pixelRatio));
  }

  return {
    cssWidth: width,
    cssHeight: height,
    dpr,
    pixelRatio,
    widthPx,
    heightPx,
  };
}

/** Signed world rectangle visible through a CSS-pixel viewport. */
export function boardWorldRect(camera: Camera, viewport: ViewportSize): InkBoardBounds {
  return cameraViewportRect(camera, viewport);
}

function expandPoint(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  return { minX, minY, maxX, maxY };
}

function boundsFromExtent(
  extent: { minX: number; minY: number; maxX: number; maxY: number } | null,
): InkBoardBounds | null {
  if (!extent) return null;
  const width = extent.maxX - extent.minX;
  const height = extent.maxY - extent.minY;
  if (!finite(width) || !finite(height)) return null;
  return { x: extent.minX, y: extent.minY, width, height };
}

/** Coarse bounds used only for culling; canonical content remains whole objects. */
export function boardObjectBounds(object: InkBoardObject): InkBoardBounds | null {
  const content = object.content;
  switch (content.kind) {
    case 'stroke': {
      if (!content.samples.length || !finite(content.style.width) || content.style.width <= 0) return null;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const sample of content.samples) {
        if (!finite(sample.x) || !finite(sample.y)) continue;
        minX = Math.min(minX, sample.x);
        minY = Math.min(minY, sample.y);
        maxX = Math.max(maxX, sample.x);
        maxY = Math.max(maxY, sample.y);
      }
      if (!finite(minX)) return null;
      const padding = content.style.width / 2;
      return boundsFromExtent(expandPoint(minX - padding, minY - padding, maxX + padding, maxY + padding));
    }
    case 'text':
    case 'region_highlight': {
      const rect = content.rect;
      if (!validRect(rect)) return null;
      return rect;
    }
    case 'rect':
    case 'ellipse': {
      const rect = content.rect;
      if (!validRect(rect) || !finite(content.width) || content.width <= 0) return null;
      const padding = content.width / 2;
      return boundsFromExtent(
        expandPoint(rect.x - padding, rect.y - padding, rect.x + rect.width + padding, rect.y + rect.height + padding),
      );
    }
    case 'arrow': {
      if (!validPoint(content.from) || !validPoint(content.to) || !finite(content.width) || content.width <= 0) {
        return null;
      }
      const padding = Math.max(8, content.width * 4);
      return boundsFromExtent(expandPoint(
        Math.min(content.from.x, content.to.x) - padding,
        Math.min(content.from.y, content.to.y) - padding,
        Math.max(content.from.x, content.to.x) + padding,
        Math.max(content.from.y, content.to.y) + padding,
      ));
    }
  }
}

function validPoint(point: InkPoint): boolean {
  return !!point && finite(point.x) && finite(point.y);
}

function validRect(rect: InkRect): boolean {
  return !!rect && finite(rect.x) && finite(rect.y) && finite(rect.width) && finite(rect.height)
    && rect.width > 0 && rect.height > 0;
}

function intersects(a: InkBoardBounds, b: InkBoardBounds): boolean {
  return a.x <= b.x + b.width && a.x + a.width >= b.x
    && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

export function cullBoardObjects(objects: InkBoardObject[], worldRect: InkBoardBounds): InkBoardObject[] {
  if (!validRect(worldRect)) return [];
  return objects.filter((object) => {
    const bounds = boardObjectBounds(object);
    return bounds !== null && intersects(bounds, worldRect);
  });
}

/** World-space grid line coordinates anchored to the world origin. */
export function boardGridLines(worldRect: InkBoardBounds, spacing = BOARD_GRID_SPACING): { x: number[]; y: number[] } {
  if (!validRect(worldRect) || !finite(spacing) || spacing <= 0) return { x: [], y: [] };
  const xs: number[] = [];
  const ys: number[] = [];
  const startX = Math.ceil(worldRect.x / spacing);
  const endX = Math.floor((worldRect.x + worldRect.width) / spacing);
  for (let index = startX; index <= endX && xs.length < MAX_GRID_LINES; index += 1) {
    xs.push(index * spacing || 0);
  }
  const startY = Math.ceil(worldRect.y / spacing);
  const endY = Math.floor((worldRect.y + worldRect.height) / spacing);
  for (let index = startY; index <= endY && ys.length < MAX_GRID_LINES; index += 1) {
    ys.push(index * spacing || 0);
  }
  return { x: xs, y: ys };
}

function drawWorldRuling(
  context: CanvasRenderingContext2D,
  surface: InkBoardSurface,
  camera: Camera,
  metrics: BoardCanvasMetrics,
): void {
  if (surface.ruling === 'blank') return;
  const lines = boardGridLines(
    { x: camera.x, y: camera.y, width: metrics.cssWidth / camera.zoom, height: metrics.cssHeight / camera.zoom },
  );
  const scaleX = metrics.widthPx / metrics.cssWidth;
  const scaleY = metrics.heightPx / metrics.cssHeight;
  context.save();
  context.strokeStyle = RULING_COLOR;
  context.lineWidth = 1;
  context.beginPath();
  if (surface.ruling === 'grid') {
    for (const worldX of lines.x) {
      const deviceX = (worldX - camera.x) * camera.zoom * scaleX;
      context.moveTo(deviceX, 0);
      context.lineTo(deviceX, metrics.heightPx);
    }
  }
  // Lined boards keep only the horizontal lines; both anchor at the world origin.
  for (const worldY of lines.y) {
    const deviceY = (worldY - camera.y) * camera.zoom * scaleY;
    context.moveTo(0, deviceY);
    context.lineTo(metrics.widthPx, deviceY);
  }
  context.stroke();
  context.restore();
}

/**
 * Renders the visible board viewport. Callers pass CSS size via
 * canvas.clientWidth/clientHeight and devicePixelRatio (or options.dpr).
 */
export function renderInkBoard(
  canvas: HTMLCanvasElement,
  surface: InkBoardSurface,
  objects: InkBoardObject[],
  camera: Camera,
  options: BoardRenderOptions = {},
): BoardRenderResult {
  const cssWidth = options.viewport?.width ?? (canvas.clientWidth || 1);
  const cssHeight = options.viewport?.height ?? (canvas.clientHeight || 1);
  const metrics = resolveBoardCanvasSize(
    cssWidth,
    cssHeight,
    options.dpr ?? globalThis.devicePixelRatio ?? 1,
    options.maxPixels ?? BOARD_MAX_PIXELS,
  );
  const worldRect = options.worldRect && validRect(options.worldRect)
    ? options.worldRect
    : boardWorldRect(camera, { width: metrics.cssWidth, height: metrics.cssHeight });
  if (canvas.width !== metrics.widthPx) canvas.width = metrics.widthPx;
  if (canvas.height !== metrics.heightPx) canvas.height = metrics.heightPx;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context is unavailable');

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
  context.clearRect(0, 0, metrics.widthPx, metrics.heightPx);

  if (!options.transparent) {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, metrics.widthPx, metrics.heightPx);
    drawWorldRuling(context, surface, camera, metrics);
  }

  const visible = cullBoardObjects(objects, worldRect)
    .slice()
    .sort((a, b) => a.z_index - b.z_index);
  if (visible.length && worldRect.width > 0 && worldRect.height > 0) {
    const scaleX = metrics.widthPx / worldRect.width;
    const scaleY = metrics.heightPx / worldRect.height;
    context.save();
    context.beginPath();
    context.rect(0, 0, metrics.widthPx, metrics.heightPx);
    context.clip();
    context.setTransform(scaleX, 0, 0, scaleY, -worldRect.x * scaleX, -worldRect.y * scaleY);
    for (const object of visible) drawObject(context, object);
    context.restore();
  }

  return { metrics, worldRect, renderedObjectCount: visible.length };
}
