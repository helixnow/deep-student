/** PdfPreviewJson/PdfPagePreview serde projection (vfs/types.rs:2849-2897). */
import { JsonReader, JsonSyntaxError } from '../../../platform/util/portable.ts';

export interface PreviewPage {
  pageIndex: number | bigint;
  blobHash: string;
  width: number;
  height: number;
  mimeType: string;
  compressedBlobHash?: string;
}

export interface PreviewJson {
  pages: PreviewPage[];
  renderDpi: number;
  totalPages: number | bigint;
  renderedAt: string;
  isTruncated?: boolean;
  maxRenderedPages?: number | bigint;
}

function readUsize(reader: JsonReader): number | bigint {
  const value = reader.readUnsigned('usize', 18446744073709551615n);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

const pageFields = ['pageIndex', 'blobHash', 'width', 'height', 'mimeType', 'compressedBlobHash'] as const;
function readPageField(reader: JsonReader, field: typeof pageFields[number], page: PreviewPage): void {
  switch (field) {
    case 'pageIndex': page.pageIndex = readUsize(reader); break;
    case 'blobHash': page.blobHash = reader.readString(); break;
    case 'width': page.width = Number(reader.readUnsigned('u32', 4294967295n)); break;
    case 'height': page.height = Number(reader.readUnsigned('u32', 4294967295n)); break;
    case 'mimeType': page.mimeType = reader.readString(); break;
    case 'compressedBlobHash':
      if (!reader.readOptionNone()) page.compressedBlobHash = reader.readString();
      break;
  }
}

function readPage(reader: JsonReader): PreviewPage {
  const page: PreviewPage = { pageIndex: 0, blobHash: '', width: 0, height: 0, mimeType: '' };
  if (reader.peekKind() === 'array') {
    reader.beginArray();
    let count = 0;
    while (reader.nextItem()) {
      const field = pageFields[count++];
      if (field === undefined) throw reader.error('extra PdfPagePreview element');
      readPageField(reader, field, page);
    }
    if (count < pageFields.length) throw reader.error('missing PdfPagePreview element');
  } else {
    reader.beginObject('struct PdfPagePreview');
    const seen = new Set<typeof pageFields[number]>();
    for (let key = reader.nextKey(); key !== null; key = reader.nextKey()) {
      const field = pageFields.find(value => value === key);
      if (field === undefined) { reader.skipIgnoredValue(); continue; }
      if (seen.has(field)) throw reader.fieldError(`duplicate field \`${field}\``);
      seen.add(field);
      readPageField(reader, field, page);
    }
    for (const field of pageFields.slice(0, 5)) {
      if (!seen.has(field)) throw reader.error(`missing field \`${field}\``);
    }
  }
  return page;
}

const previewFields = ['pages', 'renderDpi', 'totalPages', 'renderedAt', 'isTruncated', 'maxRenderedPages'] as const;
function readPreviewField(reader: JsonReader, field: typeof previewFields[number], preview: PreviewJson): void {
  switch (field) {
    case 'pages':
      reader.beginArray();
      while (reader.nextItem()) preview.pages.push(readPage(reader));
      break;
    case 'renderDpi': preview.renderDpi = Number(reader.readUnsigned('u32', 4294967295n)); break;
    case 'totalPages': preview.totalPages = readUsize(reader); break;
    case 'renderedAt': preview.renderedAt = reader.readString(); break;
    case 'isTruncated': preview.isTruncated = reader.readBool(); break;
    case 'maxRenderedPages': preview.maxRenderedPages = readUsize(reader); break;
  }
}

/** All-or-nothing serde decode; callers retain their existing invalid-preview fallback. */
export function parsePreviewJson(text: string | null): PreviewJson | null {
  if (text === null) return null;
  try {
    return decodePreviewJson(text);
  } catch (error) {
    if (error instanceof JsonSyntaxError) return null;
    throw error;
  }
}

/** `serde_json::from_str::<PdfPreviewJson>`: a malformed document throws serde's `JsonSyntaxError`. */
export function decodePreviewJson(text: string): PreviewJson {
  const reader = new JsonReader(text);
  const preview: PreviewJson = {
    pages: [], renderDpi: 0, totalPages: 0, renderedAt: '', isTruncated: false, maxRenderedPages: 0,
  };
  if (reader.peekKind() === 'array') {
    reader.beginArray();
    let count = 0;
    while (reader.nextItem()) {
      const field = previewFields[count++];
      if (field === undefined) throw reader.error('extra PdfPreviewJson element');
      readPreviewField(reader, field, preview);
    }
    if (count < 4) throw reader.error('missing PdfPreviewJson element');
  } else {
    reader.beginObject('struct PdfPreviewJson');
    const seen = new Set<typeof previewFields[number]>();
    for (let key = reader.nextKey(); key !== null; key = reader.nextKey()) {
      const field = previewFields.find(value => value === key);
      if (field === undefined) { reader.skipIgnoredValue(); continue; }
      if (seen.has(field)) throw reader.fieldError(`duplicate field \`${field}\``);
      seen.add(field);
      readPreviewField(reader, field, preview);
    }
    for (const field of previewFields.slice(0, 4)) {
      if (!seen.has(field)) throw reader.error(`missing field \`${field}\``);
    }
  }
  reader.end();
  return preview;
}

/** serde emits both default fields, omits None hashes and writes usize as JSON numbers. */
export function serializePreviewJson(preview: PreviewJson): string {
  const json = JSON as typeof JSON & { rawJSON(value: string): unknown };
  return JSON.stringify({ ...preview,
    isTruncated: preview.isTruncated ?? false, maxRenderedPages: preview.maxRenderedPages ?? 0,
  }, (_key, value: unknown) => typeof value === 'bigint' ? json.rawJSON(value.toString()) : value);
}
