import { pressureWidth } from './geometryPrimitives';
import type { InkObject, InkPage, InkPageRef, InkRect, InkSample } from './types';

export interface RenderInkPageOptions {
  background?: CanvasImageSource;
  crop?: InkRect;
  scale?: number;
  max_pixels?: number;
  transparent?: boolean;
}

export interface RenderInkPageResult {
  width_px: number;
  height_px: number;
}

const DEFAULT_MAX_PIXELS = 16_000_000;
const MAX_CANVAS_SIDE = 16_384;
const DEFAULT_HIGHLIGHTER_ALPHA = 0.35;
const DEFAULT_REGION_ALPHA = 0.25;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function validateRect(rect: InkRect, pageRef: InkPageRef): void {
  if (
    !finite(rect.x) || !finite(rect.y) || !finite(rect.width) || !finite(rect.height)
    || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0
    || rect.x + rect.width > pageRef.width || rect.y + rect.height > pageRef.height
  ) throw new RangeError('Crop must be finite, positive, and inside the page');
}

function colorHasAlpha(color: string): boolean {
  return /^#[\da-f]{8}$/i.test(color.trim());
}

function applyFillColor(context: CanvasRenderingContext2D, color: string, defaultAlpha = 1): void {
  context.fillStyle = color;
  context.globalAlpha = colorHasAlpha(color) ? 1 : defaultAlpha;
}

function applyStrokeColor(context: CanvasRenderingContext2D, color: string, defaultAlpha = 1): void {
  context.strokeStyle = color;
  context.globalAlpha = colorHasAlpha(color) ? 1 : defaultAlpha;
}

function drawStrokePath(
  context: CanvasRenderingContext2D,
  samples: InkSample[],
  baseWidth: number,
  pressureEnabled: boolean,
): void {
  const points = samples.filter((sample) => finite(sample.x) && finite(sample.y));
  if (!points.length) return;
  context.beginPath();
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    const normalX = -dy / length;
    const normalY = dx / length;
    const startRadius = pressureWidth(start, baseWidth, pressureEnabled) / 2;
    const endRadius = pressureWidth(end, baseWidth, pressureEnabled) / 2;
    context.moveTo(start.x + normalX * startRadius, start.y + normalY * startRadius);
    context.lineTo(start.x - normalX * startRadius, start.y - normalY * startRadius);
    context.lineTo(end.x - normalX * endRadius, end.y - normalY * endRadius);
    context.lineTo(end.x + normalX * endRadius, end.y + normalY * endRadius);
    context.closePath();
  }
  for (const sample of points) {
    context.moveTo(sample.x + pressureWidth(sample, baseWidth, pressureEnabled) / 2, sample.y);
    context.arc(sample.x, sample.y, pressureWidth(sample, baseWidth, pressureEnabled) / 2, 0, Math.PI * 2);
  }
  context.fill();
}

function createLayer(context: CanvasRenderingContext2D): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const layer = context.canvas.ownerDocument.createElement('canvas');
  layer.width = context.canvas.width;
  layer.height = context.canvas.height;
  const layerContext = layer.getContext('2d');
  if (!layerContext) throw new Error('Canvas 2D context is unavailable');
  return { canvas: layer, context: layerContext };
}

function drawStroke(
  context: CanvasRenderingContext2D,
  content: Extract<InkObject['content'], { kind: 'stroke' }>,
): void {
  if (!finite(content.style.width) || content.style.width <= 0) return;
  if (content.style.tool === 'pen') {
    applyStrokeColor(context, content.style.color);
    context.fillStyle = content.style.color;
    drawStrokePath(context, content.samples, content.style.width, content.style.pressure_enabled);
    return;
  }

  const layer = createLayer(context);
  layer.context.setTransform(context.getTransform());
  layer.context.fillStyle = '#ffffff';
  layer.context.strokeStyle = '#ffffff';
  drawStrokePath(layer.context, content.samples, content.style.width, content.style.pressure_enabled);
  layer.context.setTransform(1, 0, 0, 1, 0, 0);
  layer.context.globalCompositeOperation = 'source-in';
  applyFillColor(layer.context, content.style.color, DEFAULT_HIGHLIGHTER_ALPHA);
  layer.context.fillRect(0, 0, layer.canvas.width, layer.canvas.height);
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'multiply';
  context.drawImage(layer.canvas, 0, 0);
  context.restore();
}

function drawArrow(context: CanvasRenderingContext2D, content: Extract<InkObject['content'], { kind: 'arrow' }>): void {
  const { from, to, width, color } = content;
  if (![from.x, from.y, to.x, to.y, width].every(finite) || width <= 0) return;
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const headLength = Math.max(8, width * 4);
  applyStrokeColor(context, color);
  context.lineWidth = width;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.moveTo(to.x, to.y);
  context.lineTo(to.x - headLength * Math.cos(angle - Math.PI / 6), to.y - headLength * Math.sin(angle - Math.PI / 6));
  context.moveTo(to.x, to.y);
  context.lineTo(to.x - headLength * Math.cos(angle + Math.PI / 6), to.y - headLength * Math.sin(angle + Math.PI / 6));
  context.stroke();
}

function drawText(context: CanvasRenderingContext2D, content: Extract<InkObject['content'], { kind: 'text' }>): void {
  const { rect, text, font_size: fontSize, color } = content;
  if (
    ![rect.x, rect.y, rect.width, rect.height, fontSize].every(finite)
    || rect.width <= 0 || rect.height <= 0 || fontSize <= 0
  ) return;
  context.save();
  context.beginPath();
  context.rect(rect.x, rect.y, rect.width, rect.height);
  context.clip();
  context.fillStyle = color;
  context.globalAlpha = 1;
  context.font = `${fontSize}px system-ui, sans-serif`;
  context.textBaseline = 'top';
  const lineHeight = fontSize * 1.2;
  let y = rect.y;
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && context.measureText(candidate).width > rect.width) {
        context.fillText(line, rect.x, y);
        y += lineHeight;
        line = '';
      }
      if (!line && context.measureText(word).width > rect.width) {
        for (const character of word) {
          if (line && context.measureText(line + character).width > rect.width) {
            context.fillText(line, rect.x, y);
            y += lineHeight;
            line = character;
          } else {
            line += character;
          }
        }
      } else {
        line = line ? `${line} ${word}` : word;
      }
      if (y >= rect.y + rect.height) break;
    }
    if (line) {
      context.fillText(line, rect.x, y);
      y += lineHeight;
    } else if (!paragraph) {
      y += lineHeight;
    }
    if (y >= rect.y + rect.height) break;
  }
  context.restore();
}

/** Shared object drawing used by the paged renderer and the board viewport renderer. */
export function drawObject(context: CanvasRenderingContext2D, object: InkObject): void {
  const content = object.content;
  switch (content.kind) {
    case 'stroke':
      drawStroke(context, content);
      return;
    case 'text':
      drawText(context, content);
      return;
    case 'rect': {
      const { rect, color, width } = content;
      if (![rect.x, rect.y, rect.width, rect.height, width].every(finite) || rect.width <= 0 || rect.height <= 0 || width <= 0) return;
      applyStrokeColor(context, color);
      context.lineWidth = width;
      context.strokeRect(rect.x, rect.y, rect.width, rect.height);
      return;
    }
    case 'ellipse': {
      const { rect, color, width } = content;
      if (![rect.x, rect.y, rect.width, rect.height, width].every(finite) || rect.width <= 0 || rect.height <= 0 || width <= 0) return;
      applyStrokeColor(context, color);
      context.lineWidth = width;
      context.beginPath();
      context.ellipse(rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width / 2, rect.height / 2, 0, 0, Math.PI * 2);
      context.stroke();
      return;
    }
    case 'region_highlight': {
      const { rect, color } = content;
      if (![rect.x, rect.y, rect.width, rect.height].every(finite) || rect.width <= 0 || rect.height <= 0) return;
      context.save();
      context.globalCompositeOperation = 'multiply';
      applyFillColor(context, color, DEFAULT_REGION_ALPHA);
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
      context.restore();
      return;
    }
    case 'arrow':
      drawArrow(context, content);
  }
}

function drawRuling(context: CanvasRenderingContext2D, pageRef: InkPageRef): void {
  if (pageRef.background.kind !== 'blank' || pageRef.background.ruling === 'blank') return;
  context.save();
  context.strokeStyle = '#d1d5db';
  context.lineWidth = 1;
  context.beginPath();
  for (let y = 24; y < pageRef.height; y += 24) {
    context.moveTo(0, y);
    context.lineTo(pageRef.width, y);
  }
  if (pageRef.background.ruling === 'grid') {
    for (let x = 24; x < pageRef.width; x += 24) {
      context.moveTo(x, 0);
      context.lineTo(x, pageRef.height);
    }
  }
  context.stroke();
  context.restore();
}

export function renderInkPage(
  canvas: HTMLCanvasElement,
  pageRef: InkPageRef,
  page: InkPage,
  options: RenderInkPageOptions = {},
): RenderInkPageResult {
  if (page.page_id !== pageRef.page_id) throw new RangeError('Page and page reference ids must match');
  if (!finite(pageRef.width) || !finite(pageRef.height) || pageRef.width <= 0 || pageRef.height <= 0) {
    throw new RangeError('Page dimensions must be finite and positive');
  }
  if (options.scale !== undefined && (!finite(options.scale) || options.scale <= 0)) {
    throw new RangeError('Render scale must be finite and positive');
  }
  const crop = options.crop ?? { x: 0, y: 0, width: pageRef.width, height: pageRef.height };
  validateRect(crop, pageRef);
  const requestedScale = options.scale ?? 1;
  const requestedBudget = options.max_pixels ?? DEFAULT_MAX_PIXELS;
  if (!finite(requestedBudget) || requestedBudget < 1) throw new RangeError('Pixel budget must be finite and positive');
  const pixelBudget = Math.min(DEFAULT_MAX_PIXELS, Math.floor(requestedBudget));
  let outputScale = requestedScale;
  const requestedPixels = crop.width * crop.height * outputScale * outputScale;
  if (requestedPixels > pixelBudget) outputScale *= Math.sqrt(pixelBudget / requestedPixels);
  outputScale = Math.min(outputScale, MAX_CANVAS_SIDE / crop.width, MAX_CANVAS_SIDE / crop.height);
  let width = Math.max(1, Math.floor(crop.width * outputScale));
  let height = Math.max(1, Math.floor(crop.height * outputScale));
  while (width * height > pixelBudget) {
    outputScale *= Math.sqrt((pixelBudget - 1) / (width * height));
    width = Math.max(1, Math.floor(crop.width * outputScale));
    height = Math.max(1, Math.floor(crop.height * outputScale));
  }

  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context is unavailable');
  context.save();
  context.setTransform(outputScale, 0, 0, outputScale, -crop.x * outputScale, -crop.y * outputScale);
  context.beginPath();
  context.rect(crop.x, crop.y, crop.width, crop.height);
  context.clip();
  if (!options.transparent) {
    context.fillStyle = '#ffffff';
    context.fillRect(crop.x, crop.y, crop.width, crop.height);
    if (options.background) context.drawImage(options.background, 0, 0, pageRef.width, pageRef.height);
    drawRuling(context, pageRef);
  }
  for (const object of page.objects) drawObject(context, object);
  context.restore();
  return { width_px: width, height_px: height };
}
