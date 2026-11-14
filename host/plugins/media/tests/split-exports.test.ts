import { describe, expect, it } from 'vitest';

interface SplitCase {
  module: string;
  splitIn: string;
  /** Runtime export keys of the file at `splitIn^`. */
  preSplit: readonly string[];
  addedSince: readonly string[];
  load: () => Promise<Record<string, unknown>>;
}

const CASES: readonly SplitCase[] = [{
  module: 'src/document-parser.ts',
  splitIn: 'b413c09b',
  preSplit: [
    'BoundedCursor', 'DocumentParser', 'MAX_COMPRESSION_RATIO', 'MAX_DECOMPRESSED_SIZE', 'MAX_DOCUMENT_SIZE',
    'MAX_FILES_IN_ARCHIVE', 'MAX_NESTED_ZIP_DEPTH', 'MAX_SINGLE_ENTRY_SIZE', 'MAX_XLSX_CELL_EDITS',
    'MAX_XLSX_CELL_TEXT_BYTES', 'MAX_XLSX_EDITED_TEXT_BYTES', 'MAX_XLSX_REPLACEMENTS', 'MAX_XLSX_REPLACEMENT_TERM_BYTES',
    'PLAIN_TEXT_CODE_EXTENSIONS', 'ParsingError', 'decodeTextBytes', 'decodeXmlEntities', 'htmlToText',
    'isPlainTextCodeExtension', 'isZipLikeExtension', 'isZipMagicBytes', 'replaceXlsxTextBounded', 'validateXlsxEdits',
    'validateXlsxReplacements', 'xmlTokens',
  ],
  addedSince: [],
  load: () => import('../src/document-parser.ts'),
}, {
  module: 'src/pdf-ocr-service.ts',
  splitIn: '72a64cc3',
  preSplit: [
    'BoolWatch', 'BoundedChannel', 'DEFAULT_RENDER_DPI', 'INITIAL_BACKOFF_MS', 'LLM_OCR_PAGES_SERVICE', 'MAX_BACKOFF_MS',
    'MAX_OCR_CONCURRENCY', 'MAX_RENDER_DPI', 'MAX_RETRY_ATTEMPTS', 'PDF_OCR_CACHE_MAX_BYTES', 'PDF_OCR_CACHE_TARGET_BYTES',
    'PDF_OCR_IMAGES_MAX_BYTES', 'PDF_OCR_IMAGES_TARGET_BYTES', 'PdfOcrService', 'errorLike', 'normalizeBase64',
    'rateLimitHint', 'renderSize', 'sanitizePdfFileName',
  ],
  addedSince: [],
  load: () => import('../src/pdf-ocr-service.ts'),
}, {
  module: 'src/bilibili-bridge-server.ts',
  splitIn: '1f3c0237',
  preSplit: ['BridgeServer', 'WebSocketPeer', 'decodeAccount'],
  addedSince: [],
  load: () => import('../src/bilibili-bridge-server.ts'),
}, {
  module: 'src/exam-sheet-service.ts',
  splitIn: '4135ec8d',
  preSplit: ['ExamSheetSessionCordisService', 'ExamSheetSessionCore', 'ExamSheetSessionError', 'resolveImagePath'],
  addedSince: [],
  load: () => import('../src/exam-sheet-service.ts'),
}];

describe('split files keep exporting their pre-split surface', () => {
  it.each(CASES)('$module (split in $splitIn)', async ({ preSplit, addedSince, load }) => {
    expect(Object.keys(await load()).sort()).toEqual([...preSplit, ...addedSince].sort());
  });
});
