import { renderInkPage } from './renderer';
import { INK_LIMITS, type InkPage, type InkPageRef, type InkRect } from './types';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';

export interface InkExportPage {
  page_ref: InkPageRef;
  page: InkPage;
  background?: CanvasImageSource;
}

export interface InkPngExportOptions {
  long_edge?: number;
  signal?: AbortSignal;
}

export interface InkPdfExportOptions extends InkPngExportOptions {
  page_ids?: string[];
}

interface RasterSize {
  width: number;
  height: number;
  scale: number;
}

const MAX_LONG_EDGE = 4096;
const MAX_PIXELS = 16_000_000;
const MAX_ESTIMATED_BYTES = 200 * 1024 * 1024;
const DEFAULT_LONG_EDGE = MAX_LONG_EDGE;

function checkAbort(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Ink export was cancelled');
  error.name = 'AbortError';
  throw error;
}

function longEdge(options: InkPngExportOptions): number {
  const value = options.long_edge ?? DEFAULT_LONG_EDGE;
  if (!Number.isFinite(value) || value <= 0 || value > MAX_LONG_EDGE) {
    throw new RangeError(`long_edge must be finite, positive, and no greater than ${MAX_LONG_EDGE}`);
  }
  return value;
}

function rasterSize(pageRef: InkPageRef, crop: InkRect | undefined, maxEdge: number): RasterSize {
  const { width: pageWidth, height: pageHeight } = pageRef;
  if (
    !Number.isFinite(pageWidth) || !Number.isFinite(pageHeight)
    || pageWidth <= 0 || pageHeight <= 0
    || pageWidth > INK_LIMITS.dimension_max || pageHeight > INK_LIMITS.dimension_max
  ) throw new RangeError('Page dimensions must be finite, positive, and within the ink limits');

  const rect = crop ?? { x: 0, y: 0, width: pageWidth, height: pageHeight };
  if (
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0
    || rect.x + rect.width > pageWidth || rect.y + rect.height > pageHeight
  ) throw new RangeError('Crop must be finite, positive, and inside the page');

  let scale = Math.min(1, maxEdge / Math.max(rect.width, rect.height));
  const requestedPixels = rect.width * rect.height * scale * scale;
  if (requestedPixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / requestedPixels);
  let width = Math.max(1, Math.floor(rect.width * scale));
  let height = Math.max(1, Math.floor(rect.height * scale));
  while (width * height > MAX_PIXELS) {
    scale *= Math.sqrt((MAX_PIXELS - 1) / (width * height));
    width = Math.max(1, Math.floor(rect.width * scale));
    height = Math.max(1, Math.floor(rect.height * scale));
  }
  return { width, height, scale };
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG encoding failed'));
    }, 'image/png');
  });
}

async function renderPng(page: InkExportPage, crop: InkRect | undefined, maxEdge: number, signal?: AbortSignal): Promise<Blob> {
  checkAbort(signal);
  const size = rasterSize(page.page_ref, crop, maxEdge);
  const canvas = document.createElement('canvas');
  try {
    renderInkPage(canvas, page.page_ref, page.page, {
      background: page.background,
      crop,
      scale: size.scale,
      max_pixels: MAX_PIXELS,
    });
    const blob = await canvasPng(canvas);
    checkAbort(signal);
    return blob;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('PNG data URL conversion failed'));
    reader.onerror = () => reject(reader.error ?? new Error('PNG data URL conversion failed'));
    reader.readAsDataURL(blob);
  });
}

export async function exportInkPng(
  input: InkExportPage & { crop?: InkRect },
  options: InkPngExportOptions = {},
): Promise<Blob> {
  checkAbort(options.signal);
  const maxEdge = longEdge(options);
  const blob = await renderPng(input, input.crop, maxEdge, options.signal);
  checkAbort(options.signal);
  return blob;
}

function orderedPages(pages: InkExportPage[], pageIds?: string[]): InkExportPage[] {
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > INK_LIMITS.pages_max) {
    throw new RangeError(`PDF export requires 1 to ${INK_LIMITS.pages_max} pages`);
  }
  const byId = new Map<string, InkExportPage>();
  for (const page of pages) {
    const id = page?.page_ref?.page_id;
    if (!id || byId.has(id)) throw new RangeError('PDF page IDs must be present and unique');
    byId.set(id, page);
  }
  if (pageIds === undefined) return pages;
  if (!Array.isArray(pageIds) || pageIds.length === 0) throw new RangeError('At least one PDF page ID must be selected');
  const selected = new Set<string>();
  return pageIds.map((id) => {
    if (selected.has(id)) throw new RangeError(`Duplicate selected page ID: ${id}`);
    selected.add(id);
    const page = byId.get(id);
    if (!page) throw new RangeError(`Unknown selected page ID: ${id}`);
    return page;
  });
}

export async function exportInkPdf(
  pages: InkExportPage[],
  options: InkPdfExportOptions = {},
): Promise<Blob> {
  checkAbort(options.signal);
  const maxEdge = longEdge(options);
  const selectedPages = orderedPages(pages, options.page_ids);
  const sizes = selectedPages.map(({ page_ref }) => rasterSize(page_ref, undefined, maxEdge));
  const estimatedBytes = sizes.reduce((total, size) => total + size.width * size.height * 10, 0);
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > MAX_ESTIMATED_BYTES) {
    throw new RangeError('PDF export exceeds the 200 MiB estimated byte limit');
  }

  const sections: Content[] = [];
  let retainedBytes = 0;
  for (let index = 0; index < selectedPages.length; index += 1) {
    checkAbort(options.signal);
    const page = selectedPages[index];
    const blob = await renderPng(page, undefined, maxEdge, options.signal);
    const image = await blobDataUrl(blob);
    retainedBytes += image.length;
    if (retainedBytes > MAX_ESTIMATED_BYTES) throw new RangeError('PDF export exceeds the 200 MiB encoded raster byte limit');
    const { width, height } = sizes[index];
    sections.push({
      section: { image, width, height },
      pageSize: { width, height },
      pageMargins: [0, 0, 0, 0],
    });
  }

  checkAbort(options.signal);
  const { default: pdfMake } = await import('pdfmake/build/pdfmake');
  const definition: TDocumentDefinitions = { content: sections, pageMargins: [0, 0, 0, 0] };
  const bytes = new Uint8Array(await pdfMake.createPdf(definition).getBuffer());
  checkAbort(options.signal);
  if (bytes.byteLength > MAX_ESTIMATED_BYTES) throw new RangeError('PDF output exceeds the 200 MiB byte limit');
  return new Blob([bytes], { type: 'application/pdf' });
}
