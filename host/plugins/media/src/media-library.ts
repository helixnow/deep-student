/**
 * `dstu-media/src/media/library.rs`: the audio/video view of the VFS library
 * (`media_library_list`) and notes generated from one media resource
 * (`media_related_notes`).
 *
 * Transcript running state comes from the (unmigrated) media task registry, so
 * callers pass `isRunning`; the command uses `false` until that service exists.
 */
import type { VfsDatabase } from '../../vfs/api.ts';
import {
  handoutCounts, findFileIds, listFolders, listLibraryRows, listRelatedNoteRows,
  type LibraryRow,
} from '../repository/media-library.ts';
import { MediaError } from './errors.ts';
import { parseDescriptor } from './bilibili-links.ts';
import { deriveStatus, isLinkItem, mediaKind, type SegmentCounts } from './media-types.ts';

const MAX_FOLDER_DEPTH = 64;
export const MAX_DESCRIPTOR_BYTES = 64 * 1024;

/**
 * 链接条目封面的字节来源。桌面由 `register-media.ts` 注入 `node:fs` 读 VFS blob；
 * 移动端没有 blob 文件系统（blobs 在 OPFS / SQLite，不在磁盘路径上），不传即 coverUrl 为 null，
 * 与 Rust 在“文件不存在”时返回 `null` 的行为一致。保持这里不 import Node 模块，让移动端
 * `dstu.media` 能装配本模块（`scripts/portability/scan.mjs --profile`）。
 */
export type MediaBlobReader = (database: VfsDatabase, id: string) => Uint8Array | null;

export interface MediaLibraryTranscript {
  status: string;
  completedSegments: number;
  totalSegments: number;
  failedSegments: number;
  source: string | null;
}

export interface MediaLibraryProgress {
  lastPositionMs: number;
  watchedMs: number;
  finished: boolean;
}

export interface MediaLibraryItem {
  id: string;
  resourceId: string | null;
  name: string;
  folderId: string | null;
  folderName: string | null;
  folderPath: string[];
  size: number;
  mimeType: string;
  kind: string;
  isLink: boolean;
  coverUrl: string | null;
  createdAt: number;
  updatedAt: number;
  durationMs: number | null;
  transcript: MediaLibraryTranscript;
  progress: MediaLibraryProgress;
  lastWatchedAt: number | null;
  handoutCount: number;
  lastActivityAt: number;
}

export interface MediaRelatedNote {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function databaseError(error: unknown): MediaError {
  return new MediaError('Database', messageOf(error));
}

/** Rust `parse_timestamp`：RFC3339 / SQLite UTC 两种格式 / 数字秒或毫秒。 */
export function parseLibraryTimestamp(value: string, nowMs: number = Date.now()): number {
  const trimmed = value.trim();
  if (trimmed === '') return nowMs;
  const sql = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(trimmed);
  if (sql !== null) {
    const fraction = (sql[7] ?? '').padEnd(3, '0').slice(0, 3);
    const ms = Date.UTC(Number(sql[1]), Number(sql[2]) - 1, Number(sql[3]),
      Number(sql[4]), Number(sql[5]), Number(sql[6]), Number(fraction || '0'));
    return Number.isFinite(ms) ? ms : nowMs;
  }
  if (trimmed.includes('T') && /(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    const ms = Date.parse(trimmed);
    if (Number.isFinite(ms)) return ms;
  }
  if (/^[+-]?[0-9]+$/.test(trimmed)) {
    const raw = Number(trimmed);
    if (Number.isSafeInteger(raw)) {
      return Math.abs(raw) < 100_000_000_000 ? raw * 1000 : raw;
    }
  }
  return nowMs;
}

function isOpaqueDocumentId(name: string): boolean {
  const colon = name.indexOf(':');
  if (colon >= 0) {
    const after = name.slice(colon + 1);
    if (after !== '' && /^[0-9]+$/.test(after)) return true;
  }
  return name !== '' && /^[0-9]+$/.test(name);
}

function formatImportTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

/** `sanitize_textbook_display_name`：不透明文件名换成带导入时间的显示名。 */
export function sanitizeMediaDisplayName(fileName: string, createdAt: string): string {
  const trimmed = fileName.trim();
  const dot = trimmed.lastIndexOf('.');
  const split = dot > 0 && dot < trimmed.length - 1;
  const base = split ? trimmed.slice(0, dot) : trimmed;
  const ext = split ? trimmed.slice(dot) : '';
  if (base === '文件' || isOpaqueDocumentId(base)) {
    const parsed = parseLibraryTimestamp(createdAt);
    return `导入文档_${formatImportTime(parsed)}${ext}`;
  }
  return fileName;
}

function folderPathOf(
  folders: Map<string, { parentId: string | null; title: string }>,
  folderId: string,
): string[] {
  const path: string[] = [];
  let current: string | null = folderId;
  while (current !== null) {
    if (path.length >= MAX_FOLDER_DEPTH) break;
    const folder = folders.get(current);
    if (folder === undefined) break;
    path.push(folder.title);
    current = folder.parentId;
  }
  return path.reverse();
}

function coverUrlOf(database: VfsDatabase, id: string, readBlob: MediaBlobReader | undefined): string | null {
  if (readBlob === undefined) return null;
  try {
    const bytes = readBlob(database, id);
    if (bytes === null || bytes.length > MAX_DESCRIPTOR_BYTES) return null;
    return parseDescriptor(bytes).cover;
  } catch {
    return null;
  }
}

function kindLabel(kind: 'Audio' | 'Video'): string {
  return kind === 'Audio' ? 'audio' : 'video';
}

export interface MediaLibraryOptions {
  limit?: number | null;
  isRunning?: (id: string) => boolean;
  /** 链接条目封面的字节来源；不传表示当前平台没有磁盘 blob（移动端），封面为 null。 */
  readBlob?: MediaBlobReader;
}

/** `media_library_list`。 */
export function listMediaLibrary(
  database: VfsDatabase,
  options: MediaLibraryOptions = {},
): MediaLibraryItem[] {
  const isRunning = options.isRunning ?? (() => false);
  let rows: LibraryRow[];
  let folders = new Map<string, { parentId: string | null; title: string }>();
  let handouts: Map<string, number>;
  try {
    const conn = database.getConnSafe();
    rows = listLibraryRows(conn);
    if (rows.some(row => row.folder_id !== null)) {
      folders = new Map(listFolders(conn).map(folder =>
        [folder.id, { parentId: folder.parent_id, title: folder.title }]));
    }
    handouts = handoutCounts(conn);
  } catch (error) {
    throw databaseError(error);
  }

  const items: MediaLibraryItem[] = [];
  for (const row of rows) {
    const kind = mediaKind(row.mime_type, row.file_name);
    if (kind === null) continue;
    const counts: SegmentCounts = {
      total: row.seg_total,
      done: row.seg_done,
      failed: row.seg_failed,
      pending: row.seg_total - row.seg_done - row.seg_failed,
    };
    const status = deriveStatus(isRunning(row.id), row.processing_status, counts);
    const progress: MediaLibraryProgress = {
      lastPositionMs: row.progress_position ?? 0,
      watchedMs: row.progress_watched ?? 0,
      finished: (row.progress_finished ?? 0) !== 0,
    };
    const watchedAny = progress.lastPositionMs > 0 || progress.watchedMs > 0 || progress.finished;
    const lastWatchedAt = watchedAny ? row.progress_updated_at : null;
    const createdAt = parseLibraryTimestamp(row.created_at);
    const updatedAt = parseLibraryTimestamp(row.updated_at);
    const folder = row.folder_id !== null && folders.has(row.folder_id)
      ? (() => {
        const path = folderPathOf(folders, row.folder_id!);
        return {
          folderId: row.folder_id,
          folderName: path.length > 0 ? path[path.length - 1]! : null,
          folderPath: path,
        };
      })()
      : { folderId: null, folderName: null, folderPath: [] as string[] };
    const handoutCount = (handouts.get(row.id) ?? 0)
      + (row.resource_id !== null && row.resource_id !== row.id
        ? handouts.get(row.resource_id) ?? 0
        : 0);
    const isLink = isLinkItem(row.mime_type, row.file_name);
    items.push({
      id: row.id,
      resourceId: row.resource_id,
      name: sanitizeMediaDisplayName(row.file_name, row.created_at),
      folderId: folder.folderId,
      folderName: folder.folderName,
      folderPath: folder.folderPath,
      size: row.size,
      mimeType: row.mime_type,
      kind: kindLabel(kind),
      isLink,
      coverUrl: isLink ? coverUrlOf(database, row.id, options.readBlob) : null,
      createdAt,
      updatedAt,
      durationMs: row.progress_duration !== null && row.progress_duration > 0
        ? row.progress_duration : null,
      transcript: {
        status,
        completedSegments: counts.done,
        totalSegments: counts.total,
        failedSegments: counts.failed,
        source: counts.total > 0 ? row.seg_source : null,
      },
      progress,
      lastWatchedAt,
      handoutCount,
      lastActivityAt: lastWatchedAt === null ? updatedAt : Math.max(lastWatchedAt, updatedAt),
    });
  }

  items.sort((left, right) => right.lastActivityAt - left.lastActivityAt
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  if (options.limit !== null && options.limit !== undefined) {
    items.splice(Math.max(0, Math.trunc(options.limit)));
  }
  return items;
}

/** `media_related_notes`。 */
export function listMediaRelatedNotes(
  database: VfsDatabase,
  rawResourceId: string,
): MediaRelatedNote[] {
  const resourceId = rawResourceId.trim();
  if (resourceId === '') throw new MediaError('InvalidInput', 'resourceId 不能为空');

  let rows;
  try {
    const conn = database.getConnSafe();
    const file = findFileIds(conn, resourceId);
    const fileId = file === null ? resourceId : file.id;
    const resId = file === null ? '' : file.resource_id ?? '';
    rows = listRelatedNoteRows(conn, fileId, resId);
  } catch (error) {
    throw databaseError(error);
  }

  return rows.map(row => ({
    id: row.id,
    title: row.title,
    createdAt: parseLibraryTimestamp(row.created_at),
    updatedAt: parseLibraryTimestamp(row.updated_at),
  })).sort((left, right) => right.updatedAt - left.updatedAt
    || right.createdAt - left.createdAt
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}
