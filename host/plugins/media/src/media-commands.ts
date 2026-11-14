/**
 * `dstu-media/src/media/{commands,pipeline}.rs`: media file loading, transcript
 * view assembly, subtitle import/export and progress persistence. Transactional
 * writes are delegated to the L11 `vfsRepo.mediaTranscripts` service.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { StorageError } from '../../../platform/storage/errors.ts';
import { decodeBase64Standard } from '../../../platform/util/base64-core.ts';
import { VfsError, type VfsDatabase } from '../../vfs/api.ts';
import {
  VfsRepositoryError,
  type FileRepository, type MediaProgressRow, type MediaTranscriptRepository,
} from '../../vfs-repos/api.ts';
import type {
  BiliLinkDescriptor, MediaChapter, MediaProgressRow as WireMediaProgressRow, TranscriptView,
} from '../api.ts';
import { MediaError } from './errors.ts';
import { deriveStatus, isLinkItem as isMediaLinkItem, mediaKind } from './media-types.ts';
import {
  loadMediaFileRow, loadMediaTaskRow, type MediaFileRow,
} from '../repository/media-commands.ts';
import { exportSegments, parseExportFormat, parseSubtitle } from './subtitle.ts';
import { buildTranscriptText } from './transcript.ts';
import { parseHandoutChapters } from './ledger.ts';
import { parseDescriptor } from './bilibili-links.ts';

export interface MediaFileInfo {
  fileId: string;
  fileName: string;
  mimeType: string;
  size: number;
  resourceId: string | null;
}

export type MediaKind = 'Audio' | 'Video';

export function kindOf(info: MediaFileInfo): MediaKind | null {
  return mediaKind(info.mimeType, info.fileName);
}

export function isLinkItem(info: MediaFileInfo): boolean {
  return isMediaLinkItem(info.mimeType, info.fileName);
}

function toInfo(row: MediaFileRow): MediaFileInfo {
  return {
    fileId: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    size: row.size,
    resourceId: row.resource_id,
  };
}

/** `mod.rs:107-111` `From<VfsError> for MediaError`：VFS 连接/仓储错误 → `Database(Display)`。 */
function vfsStep<T>(run: () => T): T {
  try { return run(); }
  catch (error) {
    if (error instanceof VfsError || error instanceof VfsRepositoryError) {
      throw new MediaError('Database', error.message);
    }
    throw error;
  }
}

/** `commands.rs:540,555` `db.get_conn_safe().map_err(|e| err(e.into()))`。 */
export function mediaConn(database: Pick<VfsDatabase, 'getConnSafe'>): SqlExecutor {
  return vfsStep(() => database.getConnSafe());
}

/** `pipeline.rs::load_media_file`：`res_*` 也可作为入口 ID。 */
export function loadMediaFile(conn: SqlExecutor, id: string): MediaFileInfo {
  let row: MediaFileRow | null;
  try { row = loadMediaFileRow(conn, id); }
  catch (error) {
    // pipeline.rs:132-136：QueryReturnedNoRows 之外的 rusqlite 错误 → Database(e.to_string())
    if (error instanceof StorageError) throw new MediaError('Database', error.message);
    throw error;
  }
  if (row === null) throw new MediaError('NotFound', `媒体文件不存在: ${id}`);
  if (kindOf(toInfo(row)) === null) {
    throw new MediaError('InvalidInput', `不是音视频文件: ${row.file_name} (${row.mime_type})`);
  }
  return toInfo(row);
}

export function mediaTypeLabel(info: MediaFileInfo): string {
  return kindOf(info) === 'Video' ? 'video' : 'audio';
}

export function linkOnlyError(): MediaError {
  return new MediaError('LinkOnly',
    'B 站链接条目没有本地音视频，不能语音转写；字幕来自 B 站，可在「⋯」菜单里重新获取');
}

function parsePercent(raw: string | null): number | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || !('percent' in value) || typeof value.percent !== 'number') return null;
    return Math.fround(value.percent);
  } catch { return null; }
}

/** `commands.rs::build_view`. */
export function buildTranscriptView(
  conn: SqlExecutor,
  repo: MediaTranscriptRepository,
  info: MediaFileInfo,
  running: boolean,
  withSegments: boolean,
): TranscriptView {
  const task = loadMediaTaskRow(conn, info.fileId);
  const counts = repo.counts(conn, info.fileId);
  const plan = repo.planInfo(conn, info.fileId);
  const progressRow = repo.getProgress(conn, info.fileId);
  const status = deriveStatus(running, task.status, counts);
  const percent = parsePercent(task.progress_json)
    ?? (status === 'completed' ? 100 : 0);
  const error = status === 'error' || status === 'partial' ? task.error : null;
  return {
    resourceId: info.fileId,
    mediaType: mediaTypeLabel(info),
    status,
    segments: withSegments
      ? repo.listSegments(conn, info.fileId).map(segment => ({
        idx: segment.idx,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
        status: segment.status,
      }))
      : [],
    progress: {
      stage: task.status,
      percent,
      completedSegments: counts.done,
      totalSegments: counts.total,
      failedSegments: counts.failed,
      durationMs: progressRow?.durationMs ?? null,
      source: plan?.[1] ?? null,
      planVersion: plan?.[0] ?? null,
      error,
    },
  };
}

/** `commands.rs::status_view`：`TranscriptView` → 去掉 segments 的状态视图。 */
export function toTranscriptStatusView(view: TranscriptView): import('../api.ts').TranscriptStatusView {
  return {
    resourceId: view.resourceId,
    mediaType: view.mediaType,
    status: view.status,
    progress: view.progress,
  };
}

/** `commands.rs::export_impl`：无完成段时报错；返回导出文本与段数。 */
export function exportTranscript(
  conn: SqlExecutor,
  repo: MediaTranscriptRepository,
  info: MediaFileInfo,
  rawFormat: string,
): { format: string; content: string; segments: number } {
  const format = parseExportFormat(rawFormat);
  const segments = repo.listSegments(conn, info.fileId);
  const done = segments.filter(segment => segment.status === 1 && segment.text.trim() !== '').length;
  if (done === 0) {
    throw new MediaError('InvalidInput', '还没有可导出的字幕（请先转写或导入字幕）');
  }
  const content = exportSegments(segments.map(segment => ({
    idx: segment.idx,
    start_ms: segment.startMs,
    end_ms: segment.endMs,
    text: segment.text,
    status: segment.status,
    source: segment.source,
    plan_version: segment.planVersion,
  })), format);
  return { format, content, segments: done };
}

/** `commands.rs::import_subtitle_impl`：替换为导入段并写回转写文本投影。 */
export function importSubtitle(
  conn: SqlExecutor,
  repo: MediaTranscriptRepository,
  files: Pick<FileRepository, 'setMediaExtractedTextWithConn'>,
  info: MediaFileInfo,
  fileName: string,
  bytes: Uint8Array,
): number {
  const cues = parseSubtitle(fileName, bytes);
  repo.setImportedSegments(conn, info.fileId, cues.map(([span, text]) => [
    { startMs: span.start_ms, endMs: span.end_ms }, text,
  ] as const));
  const last = cues.reduce<number | null>(
    (max, [span]) => max === null || span.end_ms > max ? span.end_ms : max, null);
  if (last !== null) {
    const known = repo.getProgress(conn, info.fileId)?.durationMs != null;
    if (!known) repo.recordDuration(conn, info.fileId, last);
  }
  const text = buildTranscriptText(repo.listSegments(conn, info.fileId).map(segment => ({
    idx: segment.idx,
    start_ms: segment.startMs,
    end_ms: segment.endMs,
    text: segment.text,
    status: segment.status,
    source: segment.source,
    plan_version: segment.planVersion,
  })));
  files.setMediaExtractedTextWithConn(conn, info.fileId, text === '' ? null : text);
  return cues.length;
}

export function getProgress(
  conn: SqlExecutor,
  repo: MediaTranscriptRepository,
  resourceId: string,
): WireMediaProgressRow | null {
  const info = loadMediaFile(conn, resourceId);
  const row = vfsStep(() => repo.getProgress(conn, info.fileId));
  return row === null ? null : toWireProgress(row);
}

export function setProgress(
  conn: SqlExecutor,
  repo: MediaTranscriptRepository,
  resourceId: string,
  update: { positionMs?: number | null; durationMs?: number | null; watchedDeltaMs?: number | null; finished?: boolean | null },
): WireMediaProgressRow {
  const info = loadMediaFile(conn, resourceId);
  return toWireProgress(vfsStep(() => repo.setProgress(conn, info.fileId, update)));
}

function toWireProgress(row: MediaProgressRow): WireMediaProgressRow {
  return {
    resourceId: row.resourceId,
    lastPositionMs: row.lastPositionMs,
    durationMs: row.durationMs,
    watchedMs: row.watchedMs,
    finished: row.finished,
    updatedAt: row.updatedAt,
  };
}

/** `ledger.rs::chapters_with_conn`：按相关笔记顺序找第一份有章节的讲义。 */
export function listMediaChapters(
  relatedNotes: ReadonlyArray<{ id: string }>,
  noteContent: (noteId: string) => string | null,
  resourceId: string,
): MediaChapter[] {
  for (const note of relatedNotes) {
    const chapters = parseHandoutChapters(noteContent(note.id) ?? '', resourceId);
    if (chapters.length > 0) return chapters;
  }
  return [];
}

/** `bilibili.rs::read_link_descriptor`：链接条目内容是描述 JSON，整读并校验。 */
export function readLinkDescriptor(
  conn: SqlExecutor,
  files: FileRepository,
  blobsDir: string,
  info: MediaFileInfo,
): BiliLinkDescriptor {
  const encoded = files.getContent(conn, blobsDir, info.fileId);
  if (encoded === null) {
    throw new MediaError('NotFound', `媒体文件内容缺失: ${info.fileId}`);
  }
  // 可移植 base64（`platform/util/base64-core.ts`）：移动端 Worker 没有 `Buffer`。
  const decoded = decodeBase64Standard(encoded);
  if (decoded.error !== undefined) {
    throw new MediaError('InvalidInput', '不是有效的 B 站链接条目');
  }
  const bytes = decoded.bytes;
  if (bytes.length > 64 * 1024) {
    throw new MediaError('InvalidInput', '不是有效的 B 站链接条目');
  }
  return parseDescriptor(bytes);
}
