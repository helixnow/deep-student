import { renderInkPage } from './renderer';
import type { InkObject, InkPage, InkPageRef, InkRect } from './types';

export function sourceHighlightObjects(
  pageRef: InkPageRef,
  highlights: Array<Record<string, unknown>>,
): InkObject[] {
  const objects: InkObject[] = [];
  for (const [index, value] of highlights.entries()) {
    if (!value || typeof value !== 'object') continue;
    const raw = value as Record<string, unknown>;
    if (pageRef.background.kind !== 'pdf_page') continue;
    const sourcePageIndex = pageRef.background.source_page_index;
    const rawPageIndex = raw.pageIndex ?? raw.page_index;
    if (rawPageIndex !== sourcePageIndex) continue;
    if (!Array.isArray(raw.rects)) continue;
    const color = typeof raw.color === 'string' ? raw.color : '#ffff0080';
    const timestamp = raw.createdAt ?? raw.created_at;
    const createdAt = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : 0;
    for (const [rectIndex, rawRect] of raw.rects.entries()) {
      if (!rawRect || typeof rawRect !== 'object') continue;
      const rect = rawRect as Record<string, unknown>;
      const { x: rawX, y: rawY, width: rawWidth, height: rawHeight } = rect;
      if (![rawX, rawY, rawWidth, rawHeight].every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))) continue;
      const normalized = raw.coordVersion === 2 || raw.coord_version === 2;
      const scaleX = normalized ? pageRef.width : 1;
      const scaleY = normalized ? pageRef.height : 1;
      const sourceX = rawX as number;
      const sourceY = rawY as number;
      const sourceWidth = rawWidth as number;
      const sourceHeight = rawHeight as number;
      let x = sourceX * scaleX;
      let y = sourceY * scaleY;
      const width = sourceWidth * scaleX;
      const height = sourceHeight * scaleY;
      if (width <= 0 || height <= 0) continue;
      const right = Math.min(pageRef.width, x + width);
      const bottom = Math.min(pageRef.height, y + height);
      x = Math.max(0, x);
      y = Math.max(0, y);
      const clipped: InkRect = { x, y, width: right - x, height: bottom - y };
      if (clipped.width <= 0 || clipped.height <= 0) continue;
      objects.push({
        id: `source-highlight-${String(raw.id ?? index)}-${rectIndex}`,
        author: 'ai',
        created_at: Number.isFinite(createdAt) ? createdAt : 0,
        content: { kind: 'region_highlight', rect: clipped, color, width: 1 },
      });
    }
  }
  return objects;
}

export function withSourceHighlights(
  pageRef: InkPageRef,
  page: InkPage,
  highlights: Array<Record<string, unknown>>,
): InkPage {
  const objects = sourceHighlightObjects(pageRef, highlights);
  return objects.length ? { ...page, objects: [...objects, ...page.objects] } : page;
}

export function composeSourceHighlights(
  background: CanvasImageSource | undefined,
  pageRef: InkPageRef,
  highlights: Array<Record<string, unknown>>,
): HTMLCanvasElement | undefined {
  const objects = sourceHighlightObjects(pageRef, highlights);
  if (!objects.length) return undefined;

  const scale = Math.min(1, 2048 / Math.max(pageRef.width, pageRef.height), Math.sqrt(16_000_000 / (pageRef.width * pageRef.height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(pageRef.width * scale));
  canvas.height = Math.max(1, Math.floor(pageRef.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context is unavailable.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (background) context.drawImage(background, 0, 0, canvas.width, canvas.height);

  const overlay = document.createElement('canvas');
  renderInkPage(overlay, pageRef, { schema_version: 1, page_id: pageRef.page_id, objects }, {
    scale: canvas.width / pageRef.width,
    max_pixels: 16_000_000,
    transparent: true,
  });
  context.globalCompositeOperation = 'multiply';
  context.drawImage(overlay, 0, 0, canvas.width, canvas.height);
  return canvas;
}
