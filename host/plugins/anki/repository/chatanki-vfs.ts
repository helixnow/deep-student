/**
 * L16 chatanki APKG 资源解析，复用 L11 已发布的 `VfsReposService` 公共仓储 API
 * （`files` / `resources` / `attachments` / `blobs`），不再按 VFS schema 复制 SQL。
 *
 * 语义对应 `chatanki_executor.rs:10209-10360,10549-10687`：
 * - `resolve_context_ref_from_vfs_source` → `files.getFile` + `resources.getLiveResource`
 * - `resolve_file_like_source_id_by_resource_id` → `attachments.resolveFileId`
 * - `VfsBlobRepo::get_blob_path` → `blobs.getBlobPath`
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { AnkiResolvedApkgFile, AnkiVfsFile } from '../api.ts';
import { ankiLocalRuntime } from '../src/local-runtime.ts';

function mapFile(file: {
  id: string;
  resourceId?: string;
  fileName: string;
  size: number;
  sha256: string;
  blobHash?: string;
  originalPath?: string;
}): AnkiVfsFile {
  return {
    id: file.id,
    resourceId: file.resourceId ?? null,
    fileName: file.fileName,
    size: file.size,
    sha256: file.sha256,
    blobHash: file.blobHash ?? null,
    originalPath: file.originalPath ?? null,
  };
}

/** `resolve_context_ref_from_vfs_source`：file_/tb_/att_ 直查存活 files + resources。 */
function resolveVfsSource(
  repos: VfsReposService,
  conn: SqlExecutor,
  sourceId: string,
): AnkiVfsFile | null {
  if (!sourceId.startsWith('file_') && !sourceId.startsWith('tb_') && !sourceId.startsWith('att_')) {
    return null;
  }
  const file = repos.files.getFile(conn, sourceId);
  if (file === null || file.deletedAt !== undefined) return null;
  // Rust 要求 LEFT JOIN 到的 resource hash 非空；无 resource_id 时返回 None。
  const resource = file.resourceId === undefined
    ? null
    : repos.resources.getLiveResource(conn, file.resourceId);
  if (resource === null || resource.hash.trim() === '') return null;
  return mapFile(file);
}

/** `unsupported_chatanki_resource_message`。 */
function unsupportedResourceMessage(rawId: string): string | null {
  const trimmed = rawId.trim();
  const kind = trimmed.startsWith('mm_')
    ? 'mindmap'
    : trimmed.startsWith('note_')
      ? 'note'
      : trimmed.startsWith('exam_')
        ? 'exam'
        : trimmed.startsWith('essay_')
          ? 'essay'
          : trimmed.startsWith('tr_')
            ? 'translation'
            : trimmed.startsWith('fld_')
              ? 'folder'
              : null;
  if (kind === null) return null;
  return `Resource '${trimmed}' is a ${kind} resource. chatanki_run currently supports direct file/image/textbook attachments only; please pass a file_/att_/tb_/res_ resource instead.`;
}

/** `resolve_file_like_source_id_by_resource_id`：L11 公共附件解析。 */
function resolveFileLikeSourceIdByResource(
  repos: VfsReposService,
  conn: SqlExecutor,
  resourceId: string,
): string | null {
  const fileId = repos.attachments.resolveFileId(conn, resourceId);
  if (fileId === null) return null;
  // L11 的通用解析也会回退 source_id / 已删除 file。Rust 此处只按 resource_id 找存活 file。
  const file = repos.files.getFile(conn, fileId);
  return file !== null && file.deletedAt === undefined && file.resourceId === resourceId
    ? file.id
    : null;
}

/** `resolve_context_ref_from_any_id` 的文件行投影。 */
export function resolveApkgFile(
  repos: VfsReposService,
  conn: SqlExecutor,
  rawResourceId: string,
): AnkiResolvedApkgFile | null {
  const trimmed = rawResourceId.trim();
  if (trimmed === '') return null;

  const unsupported = unsupportedResourceMessage(trimmed);
  if (unsupported !== null) throw new Error(unsupported);

  if (
    trimmed.startsWith('file_')
    || trimmed.startsWith('tb_')
    || trimmed.startsWith('att_')
  ) {
    const file = resolveVfsSource(repos, conn, trimmed);
    return file === null ? null : { resourceId: trimmed, file };
  }

  if (!trimmed.startsWith('res_')) return null;

  const resource = repos.resources.getResource(conn, trimmed);
  if (resource === null) throw new Error(`Resource '${trimmed}' not found in VFS.`);

  if (resource.sourceId !== undefined && resource.sourceId.trim() !== '') {
    const unsupportedSource = unsupportedResourceMessage(resource.sourceId);
    if (unsupportedSource !== null) throw new Error(unsupportedSource);
    const direct = resolveVfsSource(repos, conn, resource.sourceId);
    if (direct !== null) return { resourceId: resource.sourceId, file: direct };
  }

  const type = resource.type.trim().toLowerCase();
  if (type === 'file' || type === 'image' || type === 'textbook') {
    const sourceId = resolveFileLikeSourceIdByResource(repos, conn, resource.id);
    if (sourceId === null) {
      throw new Error(
        `Resource '${trimmed}' exists, but chatanki_run cannot map it to a readable file/image source ID.`,
      );
    }
    // 已找到 file 与最后一步得到 ContextRef 是两个阶段：关联 resource 软删时返回 None，
    // 不误报成“找不到 file”。对应 Rust :10615-10622。
    const file = resolveVfsSource(repos, conn, sourceId);
    return file === null ? null : { resourceId: sourceId, file };
  }
  if (type === 'mindmap') {
    throw new Error(
      `Resource '${trimmed}' is a mindmap resource and cannot be used directly by chatanki_run. Please choose the underlying file/image resource instead.`,
    );
  }
  if (type === 'note') {
    throw new Error(
      `Resource '${trimmed}' is a note resource and cannot be used directly by chatanki_run. Please export or attach the source file/text first.`,
    );
  }
  if (type === 'exam' || type === 'essay' || type === 'translation') {
    throw new Error(
      `Resource '${trimmed}' has unsupported type '${resource.type}' for chatanki_run direct input.`,
    );
  }
  if (type === 'insight_card' || type === 'insightcard') {
    throw new Error(
      `Resource '${trimmed}' is an insight card; use the insight SRS projection channel instead of chatanki_run.`,
    );
  }
  return null;
}

/** `VfsBlobRepo::get_blob_path` + `read_apkg_file_bounded` 的磁盘读取。 */
export function readVfsBlob(
  repos: VfsReposService,
  conn: SqlExecutor,
  blobsDir: string,
  hash: string,
): Uint8Array | null {
  const blobPath = repos.blobs.getBlobPath(conn, blobsDir, hash);
  if (blobPath === null) return null;
  return ankiLocalRuntime().readBytes(blobPath);
}
