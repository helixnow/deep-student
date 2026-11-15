/**
 * `dstu-media/src/media/bilibili.rs` link-item persistence: find/reuse the
 * `.bilibili` file for a video page, or create it atomically with imported
 * subtitle cues. Descriptor bytes are never decoded as media.
 */
import { fromBase64 } from '../../../platform/crypto/encoding.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type {
  AttachmentRepository, FileRepository, MediaTranscriptRepository,
  VfsAttachment, VfsReposService,
} from '../../vfs-repos/api.ts';
import type { BiliLinkDescriptor } from '../api.ts';
import { MediaError } from './errors.ts';
import { BILIBILI_LINK_MIME } from './media-types.ts';
import {
  MAX_DESCRIPTOR_BYTES, descriptorFileName, descriptorToBytes, parseDescriptor,
} from './bilibili-links.ts';
import { formatLine } from './transcript.ts';
import { parseSubtitle } from './subtitle.ts';
import {
  isLinkItem, loadMediaFile, type MediaFileInfo,
} from './media-commands.ts';
import { loadMediaFileRow } from '../repository/media-commands.ts';
import { linkFileCandidates } from '../repository/bilibili-link-files.ts';

const SUBTITLE_FILE_NAME = 'bilibili.json';

export interface LinkItemRepos {
  files: FileRepository;
  attachments: AttachmentRepository;
  mediaTranscripts: MediaTranscriptRepository;
}

export function linkItemRepos(service: VfsReposService): LinkItemRepos {
  return {
    files: service.files,
    attachments: service.attachments,
    mediaTranscripts: service.mediaTranscripts,
  };
}

/** Reads the small descriptor through the platform repository (OPFS on mobile). */
export function readLinkDescriptor(conn: SqlExecutor, repos: LinkItemRepos, blobsDir: string, fileId: string): BiliLinkDescriptor {
  const row = loadMediaFileRow(conn, fileId);
  if (!row) throw new MediaError('NotFound', `媒体文件内容缺失: ${fileId}`);
  return readDescriptorById(conn, repos.files, blobsDir, fileId, row.size);
}

function readDescriptorById(
  conn: SqlExecutor,
  files: FileRepository,
  blobsDir: string,
  fileId: string,
  size: number,
): BiliLinkDescriptor {
  if (size > MAX_DESCRIPTOR_BYTES) {
    throw new MediaError('InvalidInput', '不是有效的 B 站链接条目');
  }
  const content = files.getContent(conn, blobsDir, fileId);
  if (content === null) {
    throw new MediaError('NotFound', `媒体文件内容缺失: ${fileId}`);
  }
  const bytes = fromBase64(content);
  if (bytes.length > MAX_DESCRIPTOR_BYTES) {
    throw new MediaError('InvalidInput', '不是有效的 B 站链接条目');
  }
  return parseDescriptor(bytes);
}

export function findLinkItemWithConn(
  conn: SqlExecutor,
  files: FileRepository,
  blobsDir: string,
  bvid: string,
  page: number,
): string | null {
  for (const { id } of linkFileCandidates(conn)) {
    const row = loadMediaFileRow(conn, id);
    if (row === null) continue;
    let descriptor: BiliLinkDescriptor;
    try { descriptor = readDescriptorById(conn, files, blobsDir, row.id, row.size); }
    catch { continue; }
    if (descriptor.bvid === bvid && descriptor.page === page) return row.id;
  }
  return null;
}

export function findLinkItem(
  database: VfsDatabase,
  repos: LinkItemRepos,
  bvid: string,
  page: number,
): string | null {
  return findLinkItemWithConn(
    database.getConnSafe(), repos.files, database.blobsDir(), bvid, page);
}

export interface UpsertLinkItemResult {
  info: MediaFileInfo;
  attachment: VfsAttachment | null;
}

/** `upsert_link_item_finalized`：新建条目或复用；已有字幕时保留用户编辑。 */
export function upsertLinkItem(
  database: VfsDatabase,
  repos: LinkItemRepos,
  descriptor: BiliLinkDescriptor,
  subtitle: Uint8Array | null = null,
  persistedPath?: string,
): UpsertLinkItemResult {
  const cues = subtitle === null
    ? null
    : parseSubtitle(SUBTITLE_FILE_NAME, subtitle);
  const conn = database.getConnSafe();
  const blobsDir = database.blobsDir();
  const existing = findLinkItemWithConn(conn, repos.files, blobsDir,
    descriptor.bvid, descriptor.page);
  let fileId: string;
  let attachment: VfsAttachment | null = null;
  if (existing !== null) {
    if (cues !== null) {
      conn.transaction((tx) => {
        if (repos.mediaTranscripts.listSegments(tx, existing).length === 0) {
          applyImportedCues(tx, repos, existing, cues);
        }
      });
    }
    fileId = existing;
  } else {
    const result = repos.attachments.uploadMediaStreamFinalized(
      conn,
      blobsDir,
      {
        name: descriptorFileName(descriptor),
        mimeType: BILIBILI_LINK_MIME,
        base64Content: '',
        type: null,
      },
      [descriptorToBytes(descriptor)],
      null,
      (tx, uploaded) => {
        if (cues !== null) {
          applyImportedCues(tx, repos, uploaded.sourceId, cues);
        }
        if (descriptor.durationMs > 0) {
          repos.mediaTranscripts.recordDuration(
            tx, uploaded.sourceId, descriptor.durationMs);
        }
      },
      persistedPath,
    );
    fileId = result.sourceId;
    attachment = result.isNew ? result.attachment : null;
  }
  const info = loadMediaFile(conn, fileId);
  if (descriptor.durationMs > 0) {
    repos.mediaTranscripts.recordDuration(conn, info.fileId, descriptor.durationMs);
  }
  if (!isLinkItem(info)) {
    throw new MediaError('InvalidInput', `不是 B 站链接条目: ${info.fileName}`);
  }
  return { info, attachment };
}

function applyImportedCues(
  conn: SqlExecutor,
  repos: Pick<LinkItemRepos, 'files' | 'mediaTranscripts'>,
  fileId: string,
  cues: ReadonlyArray<readonly [{ start_ms: number; end_ms: number }, string]>,
): void {
  repos.mediaTranscripts.setImportedSegments(conn, fileId, cues.map(([span, text]) => [
    { startMs: span.start_ms, endMs: span.end_ms }, text,
  ] as const));
  // bilibili.rs:1006-1014,1039-1047 写 `join("\n")` 原值，不像 write_transcript_text 把空串转 NULL。
  const text = cues.map(([span, value]) => formatLine(span.start_ms, value)).join('\n');
  repos.files.setMediaExtractedTextWithConn(conn, fileId, text);
}
