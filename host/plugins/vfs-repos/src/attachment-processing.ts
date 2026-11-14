/**
 * Production assembly for `AttachmentProcessingAdapter`.
 *
 * Rust `attachment_repo.rs` calls `DocumentParser` (dstu-docs) for encryption
 * checks/text extraction and `pdf_preview.rs` for PDF text + page rendering.
 * In the Host runtime:
 * - PDF preview/text uses F7 `nativePdfium` + `nativeImage.encode`;
 * - document text/encryption uses L18 `docs` (DocumentParser owner);
 * - plain text/CSV uses F7 `nativeOfficeText` (same encoding/csv-core logic);
 * - binary Office (docx/xlsx/xls/pptx/rtf) remains F7's pending parser; L18
 *   `extractTextFromBytes` currently throws UnsupportedFormat for those and the
 *   upload path logs the failure like Rust's extraction-error branch.
 *
 * Dependencies are resolved on every call so providers installed after this
 * plugin are picked up; missing capabilities fail at the specific operation,
 * never with fabricated text/preview.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { NativePdfium } from '../../../platform/native/pdfium/api.ts';
import type { NativeOfficeText } from '../../../platform/native/api.ts';
import type { DocsService } from '../../media/api.ts';
import type { AttachmentProcessingAdapter, BlobRepository, PdfRenderProgress } from '../api.ts';
import {
  DEFAULT_PDF_PREVIEW_CONFIG,
  renderPdfPreview,
  type PdfImageEncoder,
  type PdfPreviewConfig,
  type PdfPreviewResult,
} from '../repository/pdf-preview.ts';
import {
  buildZipManifestText,
  extensionOf,
} from '../repository/attachment-utils.ts';

export type AttachmentDocs = Pick<DocsService,
  'checkPdfEncryptionBytes' | 'extractTextFromBytes' | 'extractEpubPagesFromBytes'>;

export interface AttachmentProcessingSources {
  pdfium(): NativePdfium | null;
  image(): PdfImageEncoder | null;
  docs(): AttachmentDocs | null;
  officeText(): NativeOfficeText | null;
  blobs(): BlobRepository;
}

const PLAIN_TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'log', 'text', 'ini', 'cfg', 'conf', 'yaml', 'yml',
  'toml', 'jsonc', 'json5',
]);
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'kts', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'swift', 'scala', 'sh',
  'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'sql', 'css', 'scss', 'less',
  'vue', 'svelte', 'lua', 'r', 'dart', 'ex', 'exs', 'erl', 'hrl', 'clj',
  'cljs', 'hs', 'ml', 'mli', 'fs', 'fsx', 'pl', 'pm', 'groovy', 'gradle',
]);

function isPlainText(name: string): boolean {
  const extension = extensionOf(name);
  return extension !== null
    && (PLAIN_TEXT_EXTENSIONS.has(extension) || CODE_EXTENSIONS.has(extension));
}

export class NativeAttachmentProcessing implements AttachmentProcessingAdapter {
  private readonly sources: AttachmentProcessingSources;

  constructor(sources: AttachmentProcessingSources) {
    this.sources = sources;
  }

  checkPdfEncryption(bytes: Uint8Array, name: string): void {
    const docs = this.sources.docs();
    if (docs === null) {
      throw new Error('L18 docs service is not available: PDF encryption check requires DocumentParser');
    }
    docs.checkPdfEncryptionBytes(bytes, name);
  }

  renderPdf(conn: SqlExecutor, blobsDir: string, bytes: Uint8Array,
    config: PdfPreviewConfig = DEFAULT_PDF_PREVIEW_CONFIG,
    progress?: PdfRenderProgress): Promise<PdfPreviewResult> {
    return renderPdfPreview(conn, blobsDir, bytes, config, {
      pdfium: () => this.sources.pdfium(),
      image: () => this.sources.image(),
      storeBlob: (target, dir, imageBytes, mimeType, extension) =>
        this.sources.blobs().storeBlob(target, dir, imageBytes, mimeType, extension),
      checkEncryption: (pdfBytes, pdfName) => {
        const docs = this.sources.docs();
        if (docs !== null) docs.checkPdfEncryptionBytes(pdfBytes, pdfName);
      },
    }, progress);
  }

  /** Rust `extract_paged_text_from_bytes`: epub chapters are available via L18 docs. */
  async extractPagedText(name: string, bytes: Uint8Array): Promise<string[] | null> {
    if (extensionOf(name) !== 'epub') return null;
    const docs = this.sources.docs();
    if (docs === null) throw new Error('L18 docs service is not available: EPUB page extraction requires DocumentParser');
    return docs.extractEpubPagesFromBytes(bytes);
  }

  async extractText(name: string, bytes: Uint8Array): Promise<string | null> {
    const extension = extensionOf(name);
    if (extension === 'csv') {
      const officeText = this.sources.officeText();
      if (officeText !== null) return officeText.extractCsv(bytes);
    }
    if (isPlainText(name)) {
      const officeText = this.sources.officeText();
      if (officeText !== null) return officeText.extractPlainText(bytes);
    }
    const docs = this.sources.docs();
    if (docs === null) {
      throw new Error('L18 docs service is not available: document text extraction requires DocumentParser');
    }
    return docs.extractTextFromBytes(name, bytes);
  }

  buildZipManifest(name: string, bytes: Uint8Array): string | null {
    // Rust parses the central directory in-process; the fallback helper is the
    // same L11 implementation, not a model-generated summary.
    return buildZipManifestText(name, bytes);
  }
}
