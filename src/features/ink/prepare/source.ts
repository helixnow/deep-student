import { pdfjs } from 'react-pdf';
import { initializePdfWorker } from '@/utils/pdfjsWorker';
import { PDF_OPTIONS } from '@/utils/pdfConfig';
import { convertOfficePages, type OfficePage } from './office';

export type SourceFormat = 'pdf' | 'image' | 'docx' | 'pptx';
export type SourcePreparationErrorCode = 'UNSUPPORTED_FORMAT' | 'CONVERSION_FAILED' | 'CANCELLED' | 'LIMIT_EXCEEDED';

export interface SourcePreparationOptions {
  signal?: AbortSignal;
  max_pages?: number;
  max_pixels_per_page?: number;
}

export interface SourcePreparationResult {
  pages: OfficePage[];
  warnings: string[];
  converter_version: string;
}

const MAX_PAGES = 500;
const MAX_PIXELS_PER_PAGE = 16_000_000;
const MAX_LONG_EDGE = 2048;

function fail(code: SourcePreparationErrorCode, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function boundedLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1) fail('LIMIT_EXCEEDED', 'Source conversion limit is invalid.');
  return Math.min(value, maximum);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) fail('CANCELLED', 'Source conversion was cancelled.');
}

function conversionError(error: unknown, signal?: AbortSignal): never {
  const cause = error as Error & { code?: string };
  if (signal?.aborted || cause?.name === 'AbortException' || cause?.name === 'RenderingCancelledException') {
    fail('CANCELLED', 'Source conversion was cancelled.');
  }
  if (cause?.code === 'UNSUPPORTED_FORMAT' || cause?.code === 'CONVERSION_FAILED' || cause?.code === 'LIMIT_EXCEEDED' || cause?.code === 'CANCELLED') {
    throw error;
  }
  throw Object.assign(new Error('Source file could not be converted.'), { code: 'CONVERSION_FAILED', cause: error });
}

async function canvasPng(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<Blob> {
  throwIfAborted(signal);
  const png = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png');
  });
  throwIfAborted(signal);
  if (png.type !== 'image/png') fail('CONVERSION_FAILED', 'Rendered page could not be encoded as PNG.');
  return png;
}

async function preparePdf(
  bytes: ArrayBuffer,
  options: SourcePreparationOptions,
  maxPages: number,
  maxPixels: number,
): Promise<SourcePreparationResult> {
  const signal = options.signal;
  throwIfAborted(signal);
  initializePdfWorker();

  const loadingTask = pdfjs.getDocument({ data: Uint8Array.from(new Uint8Array(bytes)), ...PDF_OPTIONS });
  let documentProxy: Awaited<typeof loadingTask.promise> | undefined;
  let renderTask: { promise: Promise<void>; cancel(): void } | undefined;
  let destroyPromise: Promise<void> | undefined;
  const destroyLoadingTask = () => destroyPromise ?? (destroyPromise = loadingTask.destroy());
  const abort = () => {
    renderTask?.cancel();
    void destroyLoadingTask().catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    documentProxy = await loadingTask.promise;
    throwIfAborted(signal);
    if (documentProxy.numPages < 1) fail('CONVERSION_FAILED', 'PDF contains no pages.');
    if (documentProxy.numPages > maxPages) fail('LIMIT_EXCEEDED', 'PDF exceeds the page limit.');

    const pages: OfficePage[] = [];
    for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
      throwIfAborted(signal);
      let pdfPage: Awaited<ReturnType<typeof documentProxy.getPage>> | undefined;
      let canvas: HTMLCanvasElement | undefined;
      try {
        pdfPage = await documentProxy.getPage(pageNumber);
        const baseViewport = pdfPage.getViewport({ scale: 1 });
        const scale = Math.min(
          MAX_LONG_EDGE / Math.max(baseViewport.width, baseViewport.height),
          Math.sqrt(maxPixels / (baseViewport.width * baseViewport.height)),
        ) * (1 - 1e-7);
        const viewport = pdfPage.getViewport({ scale });
        const width = Math.max(1, Math.round(viewport.width));
        const height = Math.max(1, Math.round(viewport.height));
        if (width > MAX_LONG_EDGE || height > MAX_LONG_EDGE || width * height > maxPixels) {
          fail('LIMIT_EXCEEDED', 'Rendered PDF page exceeds the image limits.');
        }
        canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) fail('CONVERSION_FAILED', 'Canvas 2D context is unavailable.');
        renderTask = pdfPage.render({ canvas: null, canvasContext: context, viewport, background: '#ffffff' });
        await renderTask.promise;
        throwIfAborted(signal);
        pages.push({ png: await canvasPng(canvas, signal), width, height });
      } finally {
        renderTask = undefined;
        pdfPage?.cleanup();
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
        }
      }
    }
    return { pages, warnings: [], converter_version: `pdfjs-dist@${pdfjs.version};png-pages-v1;max-edge-${MAX_LONG_EDGE}` };
  } catch (error) {
    return conversionError(error, signal);
  } finally {
    signal?.removeEventListener('abort', abort);
    try {
      await destroyLoadingTask();
    } catch {
      // Best-effort release after a failed or cancelled conversion.
    }
  }
}

async function prepareImage(
  bytes: ArrayBuffer,
  maxPixels: number,
  signal?: AbortSignal,
): Promise<SourcePreparationResult> {
  throwIfAborted(signal);
  let bitmap: ImageBitmap | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    bitmap = await createImageBitmap(new Blob([bytes]), { imageOrientation: 'from-image' });
    throwIfAborted(signal);
    if (!bitmap.width || !bitmap.height) fail('CONVERSION_FAILED', 'Image has no renderable pixels.');
    const scale = Math.min(
      1,
      MAX_LONG_EDGE / Math.max(bitmap.width, bitmap.height),
      Math.sqrt(maxPixels / (bitmap.width * bitmap.height)),
    );
    const width = Math.max(1, Math.floor(bitmap.width * scale));
    const height = Math.max(1, Math.floor(bitmap.height * scale));
    if (width > MAX_LONG_EDGE || height > MAX_LONG_EDGE || width * height > maxPixels) {
      fail('LIMIT_EXCEEDED', 'Rendered image exceeds the image limits.');
    }
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) fail('CONVERSION_FAILED', 'Canvas 2D context is unavailable.');
    context.drawImage(bitmap, 0, 0, width, height);
    const png = await canvasPng(canvas, signal);
    return { pages: [{ png, width, height }], warnings: [], converter_version: `browser-imagebitmap-v1;png-pages-v1;max-edge-${MAX_LONG_EDGE}` };
  } catch (error) {
    return conversionError(error, signal);
  } finally {
    bitmap?.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

export async function prepareSourcePages(
  bytes: ArrayBuffer,
  format: SourceFormat,
  options: SourcePreparationOptions = {},
): Promise<SourcePreparationResult> {
  const maxPages = boundedLimit(options.max_pages, MAX_PAGES);
  const maxPixels = boundedLimit(options.max_pixels_per_page, MAX_PIXELS_PER_PAGE);
  throwIfAborted(options.signal);
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) fail('UNSUPPORTED_FORMAT', 'Source file is empty or invalid.');

  try {
    if (format === 'pdf') return await preparePdf(bytes, options, maxPages, maxPixels);
    if (format === 'image') {
      if (maxPages < 1) fail('LIMIT_EXCEEDED', 'Image exceeds the page limit.');
      return await prepareImage(bytes, maxPixels, options.signal);
    }
    if (format === 'docx' || format === 'pptx') {
      const result = await convertOfficePages(bytes, format, options);
      return { pages: result.pages, warnings: result.warnings, converter_version: result.converter_version };
    }
  } catch (error) {
    return conversionError(error, options.signal);
  }
  fail('UNSUPPORTED_FORMAT', 'Unsupported source format.');
}
