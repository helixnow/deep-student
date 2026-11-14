/** handlers.rs:6790-7309 and 7622-7897. Legacy cache statistics deliberately retain Rust SQL. */
import { dirname, join } from '../../../platform/util/path.ts';
import type { FileKind } from '../../../platform/files/api.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { MediaCacheStats, ResourceOcrInfo, OcrPageInfo,
  TextChunkInfo } from '../../../../contracts/ipc/generated/L13-vfs-api.ts';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
type Warn = (message: string) => void;
function attempt<T>(fn: () => T, fallback: T, warn: Warn): T {
  try { return fn(); } catch (error) { warn(message(error)); return fallback; }
}
async function attemptAsync<T>(fn: () => Promise<T>, fallback: T, warn: Warn): Promise<T> {
  try { return await fn(); } catch (error) { warn(message(error)); return fallback; }
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function parse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}
function pages(raw: string): Record<string, unknown>[] {
  const value = object(parse(raw))?.['pages'];
  return Array.isArray(value) ? value.map(object).filter((p): p is Record<string, unknown> => p !== null) : [];
}
function field(row: Record<string, unknown>, key: string, alias?: string): string | null {
  const value = row[key] === undefined && alias !== undefined ? row[alias] : row[key];
  return typeof value === 'string' ? value : null;
}
/** `ctx.files` 中媒体缓存统计用到的部分。 */
export interface MediaCacheFiles {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ readonly kind: FileKind; readonly size: number }>;
  readDir(path: string): Promise<readonly { readonly name: string }[]>;
}
async function directorySize(files: MediaCacheFiles, path: string): Promise<number> {
  if ((await files.stat(path)).kind !== 'directory') return 0;
  let total = 0;
  for (const entry of await files.readDir(path)) {
    const target = join(path, entry.name);
    const stat = await files.stat(target);
    total += stat.kind === 'directory' ? await directorySize(files, target) : stat.size;
  }
  return total;
}
const ocrCountSql = `SELECT COUNT(*) FROM files f LEFT JOIN resources r ON r.id=f.resource_id
  WHERE r.ocr_text IS NOT NULL OR f.ocr_pages_json IS NOT NULL`;
const vectorCountSql = 'SELECT COUNT(*) FROM resources WHERE vector_indexed_at IS NOT NULL';
const blobSize = (db: SqlExecutor, hash: string, warn: Warn): number => attempt(() => db.pluck<number>('SELECT size FROM blobs WHERE hash=?1', [hash]) ?? 0, 0, warn);

export async function mediaCacheStats(db: SqlExecutor, blobsDir: string, warn: Warn, files: MediaCacheFiles): Promise<MediaCacheStats> {
  let pdfPreviewCount = 0;
  let pdfPreviewSize = 0;
  for (const row of db.all<{ preview_json: string }>('SELECT preview_json FROM files WHERE preview_json IS NOT NULL')) {
    for (const page of pages(row.preview_json)) {
      // Rust stats accept only snake_case, unlike the cache-clear command.
      const hash = field(page, 'blob_hash');
      if (hash !== null) { pdfPreviewCount++; pdfPreviewSize += blobSize(db, hash, warn); }
    }
  }
  const compressed = attempt(() => db.one<{ count: number; size: number }>(`SELECT COUNT(*) AS count, COALESCE(SUM(b.size),0) AS size
    FROM files f JOIN blobs b ON f.compressed_blob_hash=b.hash WHERE f.compressed_blob_hash IS NOT NULL`), { count: 0, size: 0 }, warn);
  const ocrTextCount = attempt(() => db.pluck<number>(ocrCountSql) ?? 0, 0, warn);
  const lance = join(dirname(blobsDir), 'lance', 'vfs');
  let vectorIndexCount = 0;
  let vectorIndexSize = 0;
  if (await files.exists(lance)) {
    for (const entry of await attemptAsync(() => files.readDir(lance), [], warn)) {
      vectorIndexSize += await attemptAsync(async () => {
        const path = join(lance, entry.name); const stat = await files.stat(path);
        return stat.kind === 'file' ? stat.size : stat.kind === 'directory' ? await directorySize(files, path) : 0;
      }, 0, warn);
    }
    vectorIndexCount = attempt(() => db.pluck<number>(vectorCountSql) ?? 0, 0, warn);
  }
  return { pdfPreviewCount, pdfPreviewSize, compressedImageCount: compressed.count,
    compressedImageSize: compressed.size, ocrTextCount, vectorIndexCount, vectorIndexSize,
    totalSize: pdfPreviewSize + compressed.size + vectorIndexSize };
}

/** Unlike ocr_utils, the display parser uses [OCR_FAILED] and byte counts. */
export function parseOcrPagesForDisplay(raw: string | null): OcrPageInfo[] | null {
  if (raw === null || !rustTrim(raw)) return null;
  const value = parse(raw);
  if (Array.isArray(value) && value.every(v => v === null || typeof v === 'string')) {
    return value.map((v: string | null, pageIndex) => {
      const text = v === null || v === '[OCR_FAILED]' ? '' : v;
      return { pageIndex, text, charCount: utf8ByteLength(text), isFailed: !rustTrim(text) };
    });
  }
  const list = object(value)?.['pages'];
  if (!Array.isArray(list)) return null;
  const result: OcrPageInfo[] = [];
  for (const item of list) {
    const page = object(item);
    const pageIndex = page?.['pageIndex']; const blocks = page?.['blocks'];
    if (typeof pageIndex !== 'number' || !Number.isInteger(pageIndex) || pageIndex < 0 || !Array.isArray(blocks)) return null;
    const parts = blocks.map(block => object(block)?.['text']);
    if (!parts.every((text): text is string => typeof text === 'string')) return null;
    const text = parts.join('\n');
    result.push({ pageIndex, text, charCount: utf8ByteLength(text), isFailed: !rustTrim(text) });
  }
  return result;
}

export function resourceOcrInfo(db: SqlExecutor, id: string, warn: Warn): ResourceOcrInfo {
  let type: string;
  try { type = db.one<{ type: string }>('SELECT type FROM resources WHERE id=?1', [id]).type; }
  catch (error) { throw new Error(`Resource not found: ${message(error)}`); }
  const ocrText = attempt(() => db.pluck<string | null>('SELECT ocr_text FROM resources WHERE id=?1', [id]) ?? null, null, warn);
  type FileText = { extracted_text: string | null; ocr_pages_json: string | null };
  let file = attempt(() => db.get<FileText>('SELECT extracted_text,ocr_pages_json FROM files WHERE resource_id=?1', [id]), undefined, warn);
  if (file === undefined) {
    const source = attempt(() => db.pluck<string | null>('SELECT source_id FROM resources WHERE id=?1', [id]), undefined, warn);
    if (source != null) file = attempt(() => db.get<FileText>('SELECT extracted_text,ocr_pages_json FROM files WHERE id=?1', [source]), undefined, warn);
  }
  const extractedText = file?.extracted_text ?? null;
  const ocrTextLength = utf8ByteLength(ocrText ?? '');
  const extractedTextLength = utf8ByteLength(extractedText ?? '');
  const ocrPages = parseOcrPagesForDisplay(file?.ocr_pages_json ?? null);
  return { resourceId: id, resourceType: type, hasOcr: ocrTextLength > 0 || ocrPages !== null,
    ocrText, ocrTextLength, extractedText, extractedTextLength, activeSource: ocrTextLength ? 'ocr' : extractedTextLength ? 'extracted' : 'none', ocrPages };
}

export function resourceTextChunks(db: SqlExecutor, id: string): TextChunkInfo[] {
  const sql = `SELECT id,unit_index,text_content,text_source,text_state,text_chunk_count FROM vfs_index_units
    WHERE resource_id=?1 ORDER BY unit_index ASC`;
  let rows;
  try { rows = db.all<{ id: string; unit_index: number; text_content: string | null; text_source: string | null; text_state: string; text_chunk_count: number }>(sql, [id]); }
  catch (error) { throw new Error(`Prepare failed: ${message(error)}`); }
  return rows.map(r => ({ unitId: r.id, unitIndex: r.unit_index, textContent: r.text_content, textSource: r.text_source,
    textState: r.text_state, textChunkCount: r.text_chunk_count, charCount: utf8ByteLength(r.text_content ?? '') }));
}
