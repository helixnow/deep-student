/**
 * PDFium adapter over `@embedpdf/pdfium`'s raw FPDF exports.
 *
 * Rust uses `pdfium-render 0.9.4` bound to the `pdfium_7350` prebuilt. The
 * npm package embeds PDFium `chromium/7689`, so API behaviour is reproduced
 * call-for-call but raster output is not guaranteed to be byte-identical.
 *
 * Text uses the same `FPDFText_GetBoundedText(0, height, width, 0)` call as
 * `pdfium-render`'s `PdfPageText::all()`; rendering clears to white and asks
 * PDFium to reverse BGRA into RGBA (`FPDF_REVERSE_BYTE_ORDER`).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium';
import type { NativePdfium, PdfiumDocument, PdfiumPage } from './api.ts';
import { pdfiumDiagnostics } from './diagnostics.ts';

const FPDF_ANNOT = 0x01;
const FPDF_REVERSE_BYTE_ORDER = 0x10;
const FPDF_BITMAP_BGRA = 4;

let pdfiumPromise: Promise<WrappedPdfiumModule> | null = null;

/** Rust logs page-level text failures with `debug!`; the plugin installs the sink. */
let logSink: ((line: string) => void) | null = null;

export function setPdfiumLogSink(sink: ((line: string) => void) | null): void {
  logSink = sink;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadPdfium(): Promise<WrappedPdfiumModule> {
  if (pdfiumPromise === null) {
    // Rust OnceLock caches failures as well as successful initialization.
    pdfiumPromise = Promise.resolve().then(() => {
      const require = createRequire(import.meta.url);
      const wasmPath = require.resolve('@embedpdf/pdfium/pdfium.wasm');
      return init({ wasmBinary: readFileSync(wasmPath) });
    }).then((module) => {
      module.PDFiumExt_Init();
      return module;
    });
  }
  return pdfiumPromise;
}

/** `FPDF_GetLastError` values; `pdfium-render` surfaces these as load failures. */
const LOAD_ERRORS: Record<number, string> = {
  0: 'success',
  1: 'unknown error',
  2: 'file not found or could not be opened',
  3: 'file not in PDF format or corrupted',
  4: 'password required or incorrect password',
  5: 'unsupported security scheme',
  6: 'page not found or content cannot be rendered',
};

function loadErrorCode(module: WrappedPdfiumModule): number {
  return module.FPDF_GetLastError();
}

function describeLoadError(module: WrappedPdfiumModule): string {
  const code = loadErrorCode(module);
  return `PDF document load failed (FPDF_GetLastError=${code}: ${LOAD_ERRORS[code] ?? 'unknown'})`;
}

export class PdfiumError extends Error {
  readonly code: number | null;
  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = 'PdfiumError';
    this.code = code;
  }
}

function utf16(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf16le');
}

async function openDocument(bytes: Uint8Array, password: string | null | undefined): Promise<PdfiumDocument> {
  if (bytes.length === 0) throw new PdfiumError('PDF document load failed (empty input)');
  const module = await loadPdfium();
  // Emscripten may grow (and replace) the heap during any PDFium call, so never
  // cache HEAPU8 across allocations or library calls.
  const heap = (): Uint8Array => (module.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
  const dataPointer = module.pdfium.wasmExports.malloc(bytes.length);
  if (dataPointer === 0) throw new PdfiumError('PDF document load failed (out of memory)');
  heap().set(bytes, dataPointer);
  // PDFium keeps the memory buffer alive for the lifetime of the document.
  const document = module.FPDF_LoadMemDocument64(dataPointer, bytes.length, password ?? '');
  if (document === 0) {
    module.pdfium.wasmExports.free(dataPointer);
    throw new PdfiumError(describeLoadError(module), loadErrorCode(module));
  }
  const pageCount = module.FPDF_GetPageCount(document);
  let closed = false;

  const requireOpen = (): void => {
    if (closed) throw new PdfiumError('PDF document is closed');
  };

  const withPage = async <T>(index: number, action: (page: number, width: number, height: number) => T): Promise<T> => {
    requireOpen();
    if (!Number.isInteger(index) || index < 0 || index >= pageCount) {
      throw new PdfiumError(`PDF page index out of range: ${index}`);
    }
    const page = module.FPDF_LoadPage(document, index);
    if (page === 0) {
      throw new PdfiumError(describeLoadError(module), loadErrorCode(module));
    }
    try {
      return action(page, module.FPDF_GetPageWidthF(page), module.FPDF_GetPageHeightF(page));
    } finally {
      module.FPDF_ClosePage(page);
    }
  };

  const text = (page: number, width: number, height: number): string => {
    const textPage = module.FPDFText_LoadPage(page);
    // pdfium-render's `PdfPage::text()` propagates the constructor failure;
    // `extract_text_from_document` logs it and skips the page.
    if (textPage === 0) throw new PdfiumError('PDF text page load failed');
    try {
      // pdfium-render 0.9.4 `PdfPageText::all()` -> `inside_rect(page_size())`,
      // whose PDF coordinate rect is (bottom=0, left=0, top=height, right=width).
      const count = module.FPDFText_GetBoundedText(textPage, 0, height, width, 0, 0, 0);
      if (count <= 0) return '';
      const buffer = module.pdfium.wasmExports.malloc(count * 2);
      if (buffer === 0) throw new PdfiumError('PDF text extraction failed (out of memory)');
      try {
        const written = module.FPDFText_GetBoundedText(textPage, 0, height, width, 0, buffer, count);
        if (written <= 0) return '';
        return utf16(heap().subarray(buffer, buffer + written * 2));
      } finally {
        module.pdfium.wasmExports.free(buffer);
      }
    } finally {
      module.FPDFText_ClosePage(textPage);
    }
  };

  const documentHandle: PdfiumDocument = {
    pageCount,
    async page(index: number): Promise<PdfiumPage> {
      const [width, height] = await withPage(index, (_page, pageWidth, pageHeight) => [pageWidth, pageHeight]);
      return {
        width,
        height,
        async text() {
          return withPage(index, (page, pageWidth, pageHeight) => text(page, pageWidth, pageHeight));
        },
        async render(options) {
          const { width: targetWidth, height: targetHeight, annotations } = options;
          if (!Number.isSafeInteger(targetWidth) || targetWidth <= 0
            || !Number.isSafeInteger(targetHeight) || targetHeight <= 0) {
            throw new RangeError('render width and height must be positive integers');
          }
          return withPage(index, (page) => {
            const stride = targetWidth * 4;
            const size = stride * targetHeight;
            const buffer = module.pdfium.wasmExports.malloc(size);
            if (buffer === 0) throw new PdfiumError('PDF render failed (out of memory)');
            const bitmap = module.FPDFBitmap_CreateEx(targetWidth, targetHeight, FPDF_BITMAP_BGRA, buffer, stride);
            if (bitmap === 0) {
              module.pdfium.wasmExports.free(buffer);
              throw new PdfiumError('PDF render failed (bitmap allocation)');
            }
            try {
              module.FPDFBitmap_FillRect(bitmap, 0, 0, targetWidth, targetHeight, 0xffffffff);
              const flags = FPDF_REVERSE_BYTE_ORDER | (annotations ? FPDF_ANNOT : 0);
              module.FPDF_RenderPageBitmap(bitmap, page, 0, 0, targetWidth, targetHeight, 0, flags);
              return {
                width: targetWidth,
                height: targetHeight,
                rgba: new Uint8Array(heap().subarray(buffer, buffer + size)),
              };
            } finally {
              module.FPDFBitmap_Destroy(bitmap);
              module.pdfium.wasmExports.free(buffer);
            }
          });
        },
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      module.FPDF_CloseDocument(document);
      module.pdfium.wasmExports.free(dataPointer);
    },
  };

  return documentHandle;
}

export const pdfium: NativePdfium = {
  diagnostics: () => pdfiumDiagnostics(loadPdfium, (bytes) => openDocument(bytes, null),
    createRequire(import.meta.url).resolve('@embedpdf/pdfium/pdfium.wasm')),
  open: openDocument,
  async extractText(bytes) {
    // `pdfium_utils.rs::extract_text_from_document`: one `\f` between pages,
    // each page trimmed, embedded form feeds replaced by newlines, empty pages skipped.
    const document = await openDocument(bytes, null);
    try {
      let output = '';
      for (let index = 0; index < document.pageCount; index++) {
        if (index > 0) output += '\f';
        try {
          const page = await document.page(index);
          try {
            const pageText = await page.text();
            if (pageText.trim().length > 0) output += pageText.split('\f').join('\n').trim();
          } catch (error) {
            logSink?.(`[Pdfium] Failed to extract text from page ${index}: ${errorText(error)}`);
          }
        } catch (error) {
          logSink?.(`[Pdfium] Failed to get page ${index}: ${errorText(error)}`);
          continue;
        }
      }
      return output;
    } finally {
      await document.close();
    }
  },
};

export { openDocument as openPdfiumDocument };
