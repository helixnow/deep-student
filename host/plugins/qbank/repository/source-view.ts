/** Read-only source-page lookup for the question source viewer (qbank_source_view.rs). */
import { toBase64 } from '../../../platform/crypto/encoding.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';

export class SourceViewNotFound extends Error {}
export class SourceViewValidation extends Error {}

export interface SourcePageView {
  source_id: string;
  page: number | null;
  blob_hash: string | null;
  width: number | null;
  height: number | null;
  text: string | null;
  source_name: string | null;
  source_format: string | null;
  original_path: string | null;
  page_count: number | null;
  available_pages: number[];
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function nonEmptyString(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed !== '') return candidate;
  }
  return null;
}

function positiveU32(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 0xFFFFFFFF
    ? value : null;
}

function fileFormat(fileName: string, fileType: string, mimeType: string | null): string | null {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (extension !== '') return extension;
  if (mimeType !== null) {
    const parts = mimeType.split('/');
    const last = parts[parts.length - 1]!.toLowerCase();
    if (last !== '') return last;
  }
  const type = fileType.toLowerCase();
  return type !== '' ? type : null;
}

function parseJson(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

function hasImage(view: SourcePageView): boolean {
  return view.blob_hash !== null && view.blob_hash.trim() !== '';
}

interface FileRow {
  file_name: string;
  original_path: string | null;
  type: string;
  mime_type: string | null;
  blob_hash: string | null;
  page_count: number | null;
}

const FILE_QUERY = `SELECT file_name, original_path, type, mime_type, blob_hash, page_count
  FROM files WHERE (id = ?1 OR resource_id = ?1) AND deleted_at IS NULL
  ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1`;

function vfsFileFallback(db: SqlExecutor, sourceId: string, page: number | null): SourcePageView | null {
  const row = db.get<FileRow>(FILE_QUERY, [sourceId]);
  if (row === undefined) return null;
  const mime = row.mime_type;
  const isImage = row.type.toLowerCase() === 'image'
    || (mime !== null && mime.toLowerCase().startsWith('image/'));
  const rawBlob = row.blob_hash;
  const imageBlob = isImage && rawBlob !== null && rawBlob.trim() !== ''
    && (page === null || page === 1) ? rawBlob : null;
  const view: SourcePageView = {
    source_id: sourceId,
    page,
    blob_hash: imageBlob,
    width: null,
    height: null,
    text: null,
    source_name: row.file_name,
    source_format: fileFormat(row.file_name, row.type, mime),
    original_path: row.original_path ?? row.file_name,
    page_count: isImage ? 1 : row.page_count !== null && row.page_count > 0 ? row.page_count : null,
    available_pages: isImage ? [1] : [],
  };
  if (isImage) return view;
  const previewRaw = db.pluck<string>(
    `SELECT preview_json FROM files WHERE (id = ?1 OR resource_id = ?1) AND deleted_at IS NULL
     ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1`, [sourceId]);
  if (previewRaw === undefined || previewRaw === null) return view;
  let preview: unknown;
  try {
    preview = parseJson(previewRaw);
  } catch (error) {
    throw new SourceViewValidation(
      `原始文件页图索引无效: ${error instanceof Error ? error.message : String(error)}`);
  }
  const pages = Array.isArray(object(preview)?.pages) ? object(preview)!.pages as unknown[] : [];
  const pageIndex = (entry: Record<string, unknown>): number | null => {
    const raw = entry.pageIndex ?? entry.page_index;
    if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
    const oneBased = raw + 1;
    return oneBased > 0 && oneBased <= 0xFFFFFFFF ? oneBased : null;
  };
  view.available_pages = [];
  for (const raw of pages) {
    const entry = object(raw);
    if (entry === null) continue;
    const index = pageIndex(entry);
    if (index !== null) view.available_pages.push(index);
  }
  if (page !== null) {
    for (const raw of pages) {
      const entry = object(raw);
      if (entry === null) continue;
      if (pageIndex(entry) !== page) continue;
      view.blob_hash = nonEmptyString(entry, ['blobHash', 'blob_hash']);
      view.width = positiveU32(entry.width);
      view.height = positiveU32(entry.height);
      break;
    }
  }
  return view;
}

export function getSourcePage(db: SqlExecutor, examId: string, sourceId: string,
  pageInput: number | null): SourcePageView {
  const page = pageInput !== null && pageInput > 0 ? pageInput : null;
  if (examId.trim() === '' || sourceId.trim() === '') {
    throw new SourceViewValidation('题目集或来源标识为空');
  }
  const examExists = Boolean(db.pluck<number>(
    'SELECT EXISTS(SELECT 1 FROM exam_sheets WHERE id = ?1 AND deleted_at IS NULL)', [examId]));
  if (!examExists) throw new SourceViewNotFound('题目集不存在或已删除');

  const descriptorJson = db.pluck<string>(
    `SELECT descriptor_json FROM qbank_sources
     WHERE id = ?1 AND exam_id = ?2 AND deleted_at IS NULL`, [sourceId, examId]);
  if (descriptorJson === undefined || descriptorJson === null) {
    const fallback = vfsFileFallback(db, sourceId, page);
    if (fallback !== null) return fallback;
    throw new SourceViewNotFound('来源不存在或不属于该题目集');
  }

  let parsed: unknown;
  try {
    parsed = parseJson(descriptorJson);
  } catch (error) {
    throw new Error(
      `来源描述无效: ${error instanceof Error ? error.message : String(error)}`);
  }
  const descriptor = object(parsed) ?? {};

  const sourceName = nonEmptyString(descriptor, ['name', 'file_name', 'title']);
  const sourceFormat = nonEmptyString(descriptor, ['format', 'source_format']);
  const originalPath = nonEmptyString(descriptor,
    ['original_path', 'originalPath', 'path', 'anchor', 'name', 'file_name']);
  const pageCount = positiveU32(descriptor.page_count);
  const rawPages = Array.isArray(descriptor.pages) ? descriptor.pages as unknown[] : [];
  const available: number[] = [];
  for (const raw of rawPages) {
    const entry = object(raw);
    if (entry === null) continue;
    const number = positiveU32(entry.page);
    if (number !== null) available.push(number);
  }
  available.sort((left, right) => left - right);
  const availablePages = available.filter((value, index) => index === 0 || value !== available[index - 1]);
  const nativeText = nonEmptyString(descriptor, ['text', 'native_text', 'content', 'extracted_text']);

  const view: SourcePageView = {
    source_id: sourceId,
    page,
    blob_hash: null,
    width: null,
    height: null,
    text: nativeText,
    source_name: sourceName,
    source_format: sourceFormat,
    original_path: originalPath,
    page_count: pageCount,
    available_pages: availablePages,
  };
  if (page === null) return view;

  let found: Record<string, unknown> | null = null;
  for (const raw of rawPages) {
    const entry = object(raw);
    if (entry !== null && positiveU32(entry.page) === page) { found = entry; break; }
  }
  if (found === null) return view;

  view.width = positiveU32(found.width);
  view.height = positiveU32(found.height);
  view.blob_hash = nonEmptyString(found, ['blob_hash']);
  view.text = nonEmptyString(found, ['text_hint', 'text']) ?? view.text;
  if (!hasImage(view)) view.blob_hash = null;
  return view;
}

export interface SourceImageInfo { blobHash: string; dataUrl: string; pageIndex: number }

/** `ctx.files` 的子集（桌面 Node 实现、移动端 OPFS 实现）。 */
export interface SourceImageFileSystem {
  exists(path: string): Promise<boolean>;
  readBytes(path: string): Promise<Uint8Array>;
}

function mimeFor(data: Uint8Array): string {
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) return 'image/jpeg';
  if (data.length > 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp';
  return 'image/png';
}

function joinBlobPath(blobsDir: string, relative: string): string {
  return `${blobsDir.replace(/\/$/, '')}/${relative.replace(/^\//, '')}`;
}

export async function getSourceImages(db: SqlExecutor, blobsDir: string, fileSystem: SourceImageFileSystem,
  examId: string): Promise<SourceImageInfo[]> {
  const exam = db.get<{ metadata_json: string; preview_json: string }>(
    `SELECT metadata_json, preview_json FROM exam_sheets WHERE id = ?1 AND deleted_at IS NULL`, [examId]);
  if (exam === undefined) throw new SourceViewNotFound('题目集不存在');
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = parseJson(exam.metadata_json);
    metadata = object(parsed) ?? {};
  } catch (error) {
    throw new Error(`获取题目集失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  const hashes: string[] = [];
  const rawHashes = metadata.source_image_hashes;
  if (Array.isArray(rawHashes)) {
    for (const item of rawHashes) if (typeof item === 'string') hashes.push(item);
  }
  if (hashes.length === 0) {
    let preview: Record<string, unknown> = {};
    try {
      preview = object(parseJson(exam.preview_json)) ?? {};
    } catch (error) {
      throw new Error(`获取题目集失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    const pages = Array.isArray(preview.pages) ? preview.pages as unknown[] : [];
    for (const raw of pages) {
      const entry = object(raw);
      const hash = entry === null ? null : entry.blob_hash;
      if (typeof hash === 'string' && hash !== '') hashes.push(hash);
    }
  }
  if (hashes.length === 0) return [];
  const results: SourceImageInfo[] = [];
  for (const [index, hash] of hashes.entries()) {
    const relative = db.pluck<string>('SELECT relative_path FROM blobs WHERE hash = ?1', [hash]);
    if (relative === undefined || relative === null) continue;
    const file = joinBlobPath(blobsDir, relative);
    let data: Uint8Array;
    // commands.rs:8560-8567 `exists()` 为假或 `fs::read` 失败都跳过；越出允许根（OutsideRoots）同样视为不可读。
    try {
      if (!(await fileSystem.exists(file))) continue;
      data = await fileSystem.readBytes(file);
    } catch {
      continue;
    }
    const mime = mimeFor(data);
    results.push({
      blobHash: hash, dataUrl: `data:${mime};base64,${toBase64(data)}`,
      pageIndex: index,
    });
  }
  return results;
}
