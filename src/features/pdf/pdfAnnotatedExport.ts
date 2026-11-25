import {
  decodePDFRawStream,
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
} from 'pdf-lib';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { Highlight } from './components/EnhancedPdfViewer';

export const ENCRYPTED_PDF_EXPORT_UNSUPPORTED = 'ENCRYPTED_PDF_EXPORT_UNSUPPORTED' as const;

export const ENCRYPTED_PDF_EXPORT_MESSAGE =
  '原 PDF 带有权限加密保护，无法直接写入批注副本；请先解除权限保护或导出为笔记摘要';

export class EncryptedPdfExportError extends Error {
  readonly code = ENCRYPTED_PDF_EXPORT_UNSUPPORTED;

  constructor(message: string = ENCRYPTED_PDF_EXPORT_MESSAGE, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EncryptedPdfExportError';
  }
}

export function isEncryptedPdfExportError(error: unknown): error is EncryptedPdfExportError {
  return (
    error instanceof EncryptedPdfExportError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === ENCRYPTED_PDF_EXPORT_UNSUPPORTED)
  );
}

export interface ExportCanvasSurface {
  width: number;
  height: number;
  getContext(contextId: '2d'): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  toBytes(mimeType: 'image/jpeg' | 'image/png', quality?: number): Promise<{
    bytes: Uint8Array;
    format: 'jpeg' | 'png';
  }>;
  release?: () => void;
}

export interface CreateAnnotatedPdfOptions {
  /** Optional canvas factory (used by tests or custom environments when rebuilding encrypted PDFs). */
  createCanvas?: (width: number, height: number) => ExportCanvasSurface | null;
  /** Maximum canvas edge in pixels when rasterizing encrypted PDFs (default 2000). */
  maxRasterEdgePx?: number;
  /** Maximum canvas area in pixels when rasterizing encrypted PDFs (default 3_600_000). */
  maxRasterPixels?: number;
}

export type AnnotatedPdfSource = Pick<PDFDocumentProxy, 'getData' | 'getPage'> & {
  numPages?: number;
};

const DEFAULT_MAX_RASTER_EDGE_PX = 2000;
const DEFAULT_MAX_RASTER_PIXELS = 3_600_000;
const TARGET_RASTER_SCALE = 2;

function pdfColor(value: string): [number, number, number] {
  const hex = /^#([\da-f]{6})(?:[\da-f]{2})?$/i.exec(value)?.[1];
  return hex
    ? ([0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number])
    : [1, 0.82, 0.25];
}

function pdfStringHasNonZeroBytes(obj: unknown): boolean {
  if (obj instanceof PDFHexString) {
    return /[^0\s]/i.test(obj.asString());
  }
  if (obj instanceof PDFString) {
    const raw = obj.asString();
    for (let i = 0; i < raw.length; i += 1) {
      if (raw.charCodeAt(i) !== 0) return true;
    }
    return false;
  }
  return false;
}

function firstStreamFilterName(dict: PDFDict): string | null {
  const filter = dict.lookup(PDFName.of('Filter'));
  if (filter instanceof PDFName) return filter.asString();
  if (filter instanceof PDFArray && filter.size() > 0) {
    const first = filter.lookup(0);
    if (first instanceof PDFName) return first.asString();
  }
  return null;
}

function isLikelyEncryptedRawContentStream(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const sampleLen = Math.min(bytes.length, 512);
  let nonTextCount = 0;
  for (let i = 0; i < sampleLen; i += 1) {
    const b = bytes[i]!;
    const isAsciiText =
      b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e);
    if (!isAsciiText) nonTextCount += 1;
  }
  return nonTextCount / sampleLen > 0.15;
}

/**
 * Distinguishes a real encrypted PDF (encrypted streams and/or real cryptographic /Encrypt keys)
 * from a stub/marker /Encrypt dictionary carrying only unencrypted streams and all-zero keys.
 */
export function hasRealEncryptedContent(pdf: PDFDocument): boolean {
  if (!pdf.isEncrypted) return false;
  const encryptDict = pdf.context.lookupMaybe(pdf.context.trailerInfo.Encrypt, PDFDict);
  if (!encryptDict) return false;

  const filterName = encryptDict.lookupMaybe(PDFName.of('Filter'), PDFName);
  if (!filterName) return false;
  if (filterName.asString() !== '/Standard') return true;

  const versionObj = encryptDict.lookupMaybe(PDFName.of('V'), PDFNumber);
  if (versionObj && versionObj.asNumber() === 0) return false;

  const encryptMetadataObj = encryptDict.lookupMaybe(PDFName.of('EncryptMetadata'), PDFBool);
  const encryptMetadata = encryptMetadataObj ? encryptMetadataObj.asBoolean() : true;

  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const typeName = obj.dict.lookupMaybe(PDFName.of('Type'), PDFName)?.asString();
    if (typeName === '/XRef') continue;
    if (typeName === '/Metadata' && !encryptMetadata) continue;

    const firstFilter = firstStreamFilterName(obj.dict);
    if (firstFilter === '/Crypt') {
      const decodeParms = obj.dict.lookupMaybe(PDFName.of('DecodeParms'), PDFDict);
      const cryptName = decodeParms?.lookupMaybe(PDFName.of('Name'), PDFName)?.asString();
      if (cryptName === '/Identity') continue;
      return true;
    }

    if (
      firstFilter === '/FlateDecode' ||
      firstFilter === '/LZWDecode' ||
      firstFilter === '/ASCII85Decode' ||
      firstFilter === '/ASCIIHexDecode' ||
      firstFilter === '/RunLengthDecode'
    ) {
      try {
        decodePDFRawStream(obj).decode();
      } catch {
        return true;
      }
      continue;
    }

    if (firstFilter === '/DCTDecode') {
      if (obj.contents.length >= 2 && (obj.contents[0] !== 0xff || obj.contents[1] !== 0xd8)) {
        return true;
      }
      continue;
    }

    if (!firstFilter) {
      const subtype = obj.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString();
      if (subtype !== '/Image' && isLikelyEncryptedRawContentStream(obj.contents)) {
        return true;
      }
    }
  }

  // Even when a real encrypted PDF has blank pages (0 streams), Standard Security Handler
  // always writes non-zero cryptographic hash digests in /O, /U, /OE, /UE, or /Perms.
  const hasRealKeyMaterial =
    pdfStringHasNonZeroBytes(encryptDict.lookup(PDFName.of('O'))) ||
    pdfStringHasNonZeroBytes(encryptDict.lookup(PDFName.of('U'))) ||
    pdfStringHasNonZeroBytes(encryptDict.lookup(PDFName.of('OE'))) ||
    pdfStringHasNonZeroBytes(encryptDict.lookup(PDFName.of('UE'))) ||
    pdfStringHasNonZeroBytes(encryptDict.lookup(PDFName.of('Perms')));

  if (hasRealKeyMaterial) return true;
  if (versionObj && versionObj.asNumber() >= 4) return true;
  if (pdf.context.trailerInfo.ID) return true;

  return false;
}

function decodeBase64(base64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

async function htmlCanvasToBytes(
  canvas: HTMLCanvasElement,
  mimeType: 'image/jpeg' | 'image/png',
  quality?: number,
): Promise<{ bytes: Uint8Array; format: 'jpeg' | 'png' }> {
  const format = mimeType === 'image/jpeg' ? 'jpeg' : 'png';
  if (typeof canvas.toBlob === 'function') {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((result) => resolve(result), mimeType, quality),
    );
    if (blob && blob.size > 0) {
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const actualFormat = blob.type === 'image/png' ? 'png' : format;
      return { bytes, format: actualFormat };
    }
  }
  const dataUrl = canvas.toDataURL(mimeType, quality);
  const match = /^data:image\/(jpeg|png);base64,(.+)$/i.exec(dataUrl);
  if (!match) {
    throw new Error('Canvas serialization returned unsupported image data');
  }
  return {
    bytes: decodeBase64(match[2]!),
    format: match[1]!.toLowerCase() === 'png' ? 'png' : 'jpeg',
  };
}

function createBrowserCanvasSurface(width: number, height: number): ExportCanvasSurface | null {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (ctx) {
      return {
        get width() {
          return canvas.width;
        },
        set width(v: number) {
          canvas.width = v;
        },
        get height() {
          return canvas.height;
        },
        set height(v: number) {
          canvas.height = v;
        },
        getContext: () => ctx,
        toBytes: (mimeType, quality) => htmlCanvasToBytes(canvas, mimeType, quality),
        release: () => {
          canvas.width = 0;
          canvas.height = 0;
        },
      };
    }
  }

  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const offscreen = new OffscreenCanvas(width, height);
      const ctx = offscreen.getContext('2d');
      if (ctx) {
        return {
          get width() {
            return offscreen.width;
          },
          set width(v: number) {
            offscreen.width = v;
          },
          get height() {
            return offscreen.height;
          },
          set height(v: number) {
            offscreen.height = v;
          },
          getContext: () => ctx,
          toBytes: async (mimeType, quality) => {
            const blob = await offscreen.convertToBlob({ type: mimeType, quality });
            const buf = await blob.arrayBuffer();
            return {
              bytes: new Uint8Array(buf),
              format: blob.type === 'image/png' ? 'png' : 'jpeg',
            };
          },
          release: () => {
            offscreen.width = 0;
            offscreen.height = 0;
          },
        };
      }
    } catch {
      return null;
    }
  }

  return null;
}

function hasAnyValidHighlight(highlights: readonly Highlight[], pageCount: number): boolean {
  for (const highlight of highlights) {
    const n = highlight.pageIndex;
    if (!Number.isInteger(n) || n < 1 || n > pageCount) continue;
    if (
      highlight.rects.some(
        ({ x, y, width, height }) =>
          [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0,
      )
    ) {
      return true;
    }
  }
  return false;
}

function computeExportRasterScale(
  widthPt: number,
  heightPt: number,
  maxEdgePx: number,
  maxPixels: number,
): number {
  const safeW = Math.max(1, widthPt);
  const safeH = Math.max(1, heightPt);
  const edgeCap = maxEdgePx / Math.max(safeW, safeH);
  const areaCap = Math.sqrt(maxPixels / (safeW * safeH));
  return Math.max(0.25, Math.min(TARGET_RASTER_SCALE, edgeCap, areaCap));
}

function addHighlightAnnotation(
  pdf: PDFDocument,
  pageIndexZeroBased: number,
  highlight: Highlight,
  points: Array<[number, number]>,
): void {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const annotation = pdf.context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Highlight'),
    Rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    QuadPoints: points.flat(),
    C: pdfColor(highlight.color),
    CA: 0.45,
    F: 4,
    Contents: PDFHexString.fromText(highlight.comment?.trim() || highlight.text),
    NM: PDFHexString.fromText(highlight.id),
  });
  pdf.getPage(pageIndexZeroBased).node.addAnnot(pdf.context.register(annotation));
}

async function rebuildEncryptedPdfWithAnnotations(
  original: AnnotatedPdfSource,
  highlights: readonly Highlight[],
  pageCount: number,
  options?: CreateAnnotatedPdfOptions,
): Promise<Uint8Array> {
  const factory = options?.createCanvas ?? createBrowserCanvasSurface;
  const maxEdgePx = options?.maxRasterEdgePx ?? DEFAULT_MAX_RASTER_EDGE_PX;
  const maxPixels = options?.maxRasterPixels ?? DEFAULT_MAX_RASTER_PIXELS;

  // Probe canvas availability before creating output document
  const probe = factory(1, 1);
  if (!probe || !probe.getContext('2d')) {
    probe?.release?.();
    throw new EncryptedPdfExportError();
  }
  probe.release?.();

  const cleanPdf = await PDFDocument.create();
  const pageSizes = new Map<number, { width: number; height: number }>();

  for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
    let sourcePage: PDFPageProxy;
    try {
      sourcePage = await original.getPage(pageNum);
    } catch (error) {
      throw new EncryptedPdfExportError(ENCRYPTED_PDF_EXPORT_MESSAGE, { cause: error });
    }

    const baseViewport = sourcePage.getViewport({ scale: 1 });
    const pageW = Math.max(1, baseViewport.width);
    const pageH = Math.max(1, baseViewport.height);
    pageSizes.set(pageNum, { width: pageW, height: pageH });

    const renderScale = computeExportRasterScale(pageW, pageH, maxEdgePx, maxPixels);
    const renderViewport = sourcePage.getViewport({ scale: renderScale });
    const pixelW = Math.max(1, Math.round(renderViewport.width));
    const pixelH = Math.max(1, Math.round(renderViewport.height));

    const surface = factory(pixelW, pixelH);
    const ctx = surface?.getContext('2d');
    if (!surface || !ctx) {
      surface?.release?.();
      throw new EncryptedPdfExportError();
    }

    try {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, pixelW, pixelH);

      const renderTask = sourcePage.render({
        canvas: null,
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport: renderViewport,
      });
      await renderTask.promise;

      const { bytes, format } = await surface.toBytes('image/jpeg', 0.92);
      const embedded =
        format === 'png'
          ? await cleanPdf.embedPng(bytes)
          : await cleanPdf.embedJpg(bytes);

      const outPage = cleanPdf.addPage([pageW, pageH]);
      outPage.drawImage(embedded, {
        x: 0,
        y: 0,
        width: pageW,
        height: pageH,
      });
    } catch (error) {
      if (isEncryptedPdfExportError(error)) throw error;
      throw new EncryptedPdfExportError(ENCRYPTED_PDF_EXPORT_MESSAGE, { cause: error });
    } finally {
      surface.release?.();
      if (typeof sourcePage.cleanup === 'function') {
        try {
          sourcePage.cleanup();
        } catch {
          // Best-effort cleanup of per-page PDF.js caches
        }
      }
    }

    // Yield periodically on multi-page encrypted documents so the UI stays responsive
    if (pageNum % 4 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  let exported = 0;
  for (const highlight of highlights) {
    const n = highlight.pageIndex;
    if (!Number.isInteger(n) || n < 1 || n > pageCount) continue;
    const size = pageSizes.get(n);
    if (!size) continue;

    // Pages in cleanPdf are upright [0, 0, pageW, pageH] matching baseViewport orientation
    const corners = highlight.rects.flatMap(({ x, y, width, height }) => {
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
      const w = highlight.coordVersion === 2 ? size.width : 1;
      const h = highlight.coordVersion === 2 ? size.height : 1;
      const x1 = x * w;
      const x2 = (x + width) * w;
      const yTop = size.height - y * h;
      const yBottom = size.height - (y + height) * h;
      const quad: Array<[number, number]> = [
        [x1, yTop],
        [x2, yTop],
        [x1, yBottom],
        [x2, yBottom],
      ];
      return [quad];
    });
    if (!corners.length) continue;

    addHighlightAnnotation(cleanPdf, n - 1, highlight, corners.flat());
    exported += 1;
  }

  if (!exported) throw new Error('No valid PDF markup to export');
  return cleanPdf.save();
}

/** Adds standard markup annotations to a copy of the original PDF, with editable comments. */
export async function createAnnotatedPdf(
  original: AnnotatedPdfSource,
  highlights: readonly Highlight[],
  options?: CreateAnnotatedPdfOptions,
): Promise<Uint8Array> {
  const raw = await original.getData();
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const pdf = await PDFDocument.load(bytes, {
    updateMetadata: false,
    ignoreEncryption: true,
  });

  const pageCount =
    typeof original.numPages === 'number' && original.numPages > 0
      ? original.numPages
      : pdf.getPageCount();

  if (pdf.isEncrypted) {
    if (hasRealEncryptedContent(pdf)) {
      if (!hasAnyValidHighlight(highlights, pageCount)) {
        throw new Error('No valid PDF markup to export');
      }
      return rebuildEncryptedPdfWithAnnotations(original, highlights, pageCount, options);
    }
    // Dummy /Encrypt trailer marker with unencrypted streams: strip stale /Encrypt so
    // the exported PDF opens cleanly in PDF.js and standard viewers without PasswordException.
    delete pdf.context.trailerInfo.Encrypt;
  }

  const viewports = new Map<number, Awaited<ReturnType<PDFDocumentProxy['getPage']>>>();
  let exported = 0;
  for (const highlight of highlights) {
    const n = highlight.pageIndex;
    if (!Number.isInteger(n) || n < 1 || n > pdf.getPageCount()) continue;
    let source = viewports.get(n);
    if (!source) {
      source = await original.getPage(n);
      viewports.set(n, source);
    }
    const viewport = source.getViewport({ scale: 1 });
    const corners = highlight.rects.flatMap(({ x, y, width, height }) => {
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
      const w = highlight.coordVersion === 2 ? viewport.width : 1;
      const h = highlight.coordVersion === 2 ? viewport.height : 1;
      const points: Array<[number, number]> = [
        viewport.convertToPdfPoint(x * w, y * h) as [number, number],
        viewport.convertToPdfPoint((x + width) * w, y * h) as [number, number],
        viewport.convertToPdfPoint(x * w, (y + height) * h) as [number, number],
        viewport.convertToPdfPoint((x + width) * w, (y + height) * h) as [number, number],
      ];
      return [points];
    });
    if (!corners.length) continue;
    addHighlightAnnotation(pdf, n - 1, highlight, corners.flat());
    exported += 1;
  }
  if (!exported) throw new Error('No valid PDF markup to export');
  return pdf.save();
}
