/**
 * PDF 框选截图：选框落在哪一页、换算成该页 canvas 的像素区域、裁出 PNG。
 *
 * 只裁一页：选框跨页时取与选框重叠面积最大的那页，并裁到该页范围内。
 * 坐标一律用 getBoundingClientRect（屏幕坐标），canvas 像素宽高 / 显示尺寸即渲染倍率，
 * 缩放、设备像素比、pdf.js 旋转都自然覆盖；高亮等 DOM 覆盖层不在 canvas 里，不会被截进去。
 */

export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PixelRegion {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** 选框任一边小于这个尺寸（CSS 像素）视为误触 */
export const MIN_CAPTURE_SIZE_PX = 8;

const PAGE_CANVAS_SELECTOR = 'canvas.react-pdf__Page__canvas';

export function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): ScreenRect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export function intersectRects(a: ScreenRect, b: ScreenRect): ScreenRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/** 与选框重叠面积最大的一项；都不重叠返回 null */
export function pickMostOverlapping<T extends { rect: ScreenRect }>(selection: ScreenRect, candidates: readonly T[]): T | null {
  let best: T | null = null;
  let bestArea = 0;
  for (const candidate of candidates) {
    const overlap = intersectRects(selection, candidate.rect);
    const area = overlap ? overlap.width * overlap.height : 0;
    if (area > bestArea) {
      best = candidate;
      bestArea = area;
    }
  }
  return best;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 选框（屏幕坐标）→ canvas 像素区域；与 canvas 不重叠或重叠部分太小返回 null */
export function toCanvasPixels(
  selection: ScreenRect,
  canvasRect: ScreenRect,
  canvasWidth: number,
  canvasHeight: number,
): PixelRegion | null {
  if (canvasRect.width <= 0 || canvasRect.height <= 0 || canvasWidth <= 0 || canvasHeight <= 0) return null;
  const overlap = intersectRects(selection, canvasRect);
  if (!overlap || overlap.width < MIN_CAPTURE_SIZE_PX || overlap.height < MIN_CAPTURE_SIZE_PX) return null;
  const scaleX = canvasWidth / canvasRect.width;
  const scaleY = canvasHeight / canvasRect.height;
  const sx = clamp(Math.floor((overlap.left - canvasRect.left) * scaleX), 0, canvasWidth - 1);
  const sy = clamp(Math.floor((overlap.top - canvasRect.top) * scaleY), 0, canvasHeight - 1);
  const ex = clamp(Math.ceil((overlap.left + overlap.width - canvasRect.left) * scaleX), sx + 1, canvasWidth);
  const ey = clamp(Math.ceil((overlap.top + overlap.height - canvasRect.top) * scaleY), sy + 1, canvasHeight);
  return { sx, sy, sw: ex - sx, sh: ey - sy };
}

export type RegionCaptureOutcome =
  | { kind: 'ok'; blob: Blob; page: number }
  /** 误触，或没框到任何页面 */
  | { kind: 'too-small' }
  /** 那一页的画面还没渲染出来（滚得太快、还在加载） */
  | { kind: 'not-rendered'; page: number }
  | { kind: 'failed' };

/** 在页面视口里按选框（屏幕坐标）裁出 PNG */
export async function capturePdfRegion(viewport: HTMLElement, selection: ScreenRect): Promise<RegionCaptureOutcome> {
  if (selection.width < MIN_CAPTURE_SIZE_PX || selection.height < MIN_CAPTURE_SIZE_PX) return { kind: 'too-small' };
  const pages = Array.from(viewport.querySelectorAll<HTMLElement>('[data-page-number]')).map((element) => ({
    element,
    rect: element.getBoundingClientRect(),
  }));
  const target = pickMostOverlapping(selection, pages);
  if (!target) return { kind: 'too-small' };
  const page = Number.parseInt(target.element.getAttribute('data-page-number') ?? '', 10);
  const canvas = target.element.querySelector<HTMLCanvasElement>(PAGE_CANVAS_SELECTOR)
    ?? target.element.querySelector<HTMLCanvasElement>('canvas');
  if (!canvas || canvas.width === 0 || canvas.height === 0) return { kind: 'not-rendered', page };
  const region = toCanvasPixels(selection, canvas.getBoundingClientRect(), canvas.width, canvas.height);
  if (!region) return { kind: 'too-small' };
  try {
    const output = document.createElement('canvas');
    output.width = region.sw;
    output.height = region.sh;
    const context = output.getContext('2d');
    if (!context) return { kind: 'failed' };
    context.drawImage(canvas, region.sx, region.sy, region.sw, region.sh, 0, 0, region.sw, region.sh);
    const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, 'image/png'));
    return blob ? { kind: 'ok', blob, page } : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

/** 文件名里去掉扩展名和文件系统不认的字符 */
export function captureBaseName(documentTitle: string | undefined, fallback: string): string {
  const base = (documentTitle ?? '').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, ' ').trim();
  return base || fallback;
}
