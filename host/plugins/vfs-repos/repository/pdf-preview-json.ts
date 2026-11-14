/** Persisted PdfPreviewJson boundary (types.rs:2851-2898), shared by copy/purge. */
interface PreviewPage {
  pageIndex: bigint;
  blobHash: string;
  width: number;
  height: number;
  mimeType: string;
  compressedBlobHash?: string;
}
interface Preview {
  pages: PreviewPage[];
  renderDpi: number;
  totalPages: bigint;
  renderedAt: string;
  isTruncated: boolean;
  maxRenderedPages: bigint;
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isUsize = (value: unknown): value is bigint =>
  typeof value === 'bigint' && value >= 0n && value <= 0xffff_ffff_ffff_ffffn;
const isU32 = (value: unknown): value is bigint =>
  typeof value === 'bigint' && value >= 0n && value <= 0xffff_ffffn;

export function parsePdfPreviewJson(raw: string): Preview | null {
  let value: unknown;
  try {
    // Node's source-aware reviver preserves desktop usize before IEEE-754 rounding.
    // serde integer fields reject float lexemes, including 1.0 and 1e0.
    value = JSON.parse(raw, (_key: string, item: unknown, context?: { source: string }) => {
      if (typeof item === 'number' && context !== undefined && /^(0|[1-9][0-9]*)$/.test(context.source)) {
        return BigInt(context.source);
      }
      return item;
    });
  } catch {
    // Rust callers use `if let Ok(preview) = serde_json::from_str`, without a log.
    return null;
  }
  // serde derived structs accept both map and field-order sequence forms.
  if (Array.isArray(value)) {
    if (value.length < 4 || value.length > 6) return null;
    value = { pages: value[0], renderDpi: value[1], totalPages: value[2], renderedAt: value[3],
      isTruncated: value[4], maxRenderedPages: value[5] };
  }
  if (!isObject(value) || !Array.isArray(value.pages) || !isU32(value.renderDpi)
    || !isUsize(value.totalPages) || typeof value.renderedAt !== 'string') return null;
  if (value.isTruncated !== undefined && typeof value.isTruncated !== 'boolean') return null;
  if (value.maxRenderedPages !== undefined && !isUsize(value.maxRenderedPages)) return null;
  const pages: PreviewPage[] = [];
  for (let entry of value.pages) {
    if (Array.isArray(entry)) {
      if (entry.length < 5 || entry.length > 6) return null;
      entry = { pageIndex: entry[0], blobHash: entry[1], width: entry[2], height: entry[3],
        mimeType: entry[4], compressedBlobHash: entry[5] };
    }
    if (!isObject(entry) || !isUsize(entry.pageIndex) || typeof entry.blobHash !== 'string'
      || !isU32(entry.width) || !isU32(entry.height) || typeof entry.mimeType !== 'string'
      || (entry.compressedBlobHash != null && typeof entry.compressedBlobHash !== 'string')) return null;
    pages.push({ pageIndex: entry.pageIndex, blobHash: entry.blobHash,
      width: Number(entry.width), height: Number(entry.height), mimeType: entry.mimeType,
      ...(typeof entry.compressedBlobHash === 'string' ? { compressedBlobHash: entry.compressedBlobHash } : {}) });
  }
  return { pages, renderDpi: Number(value.renderDpi), totalPages: value.totalPages,
    renderedAt: value.renderedAt, isTruncated: value.isTruncated ?? false,
    maxRenderedPages: value.maxRenderedPages ?? 0n };
}
