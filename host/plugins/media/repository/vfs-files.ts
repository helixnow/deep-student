/**
 * VFS `files`/`resources` reads for
 * `src/chat_v2/tools/document_processing_executor.rs::resolve_file`.
 *
 * The three-ID resolve order matches
 * `dstu-vfs/src/vfs/repos/attachment_repo.rs::resolve_file_id_with_conn` and
 * `file_repo.rs::get_file`.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';

export interface VfsFileRow {
  id: string;
  resource_id: string | null;
  blob_hash: string | null;
  sha256: string;
  file_name: string;
  size: number;
  type: string;
  mime_type: string | null;
  page_count: number | null;
  extracted_text: string | null;
}

/** `SELECT id FROM files WHERE resource_id = ?1 ORDER BY deleted_at IS NULL DESC LIMIT 1` */
function fileIdByResource(conn: SqlExecutor, resourceId: string): string | null {
  return conn.pluck<string>(
    'SELECT id FROM files WHERE resource_id = ?1 ORDER BY deleted_at IS NULL DESC LIMIT 1',
    [resourceId],
  ) ?? null;
}

/** `VfsFileRepo::get_file` 的投影（解析管线只需要这些字段）。 */
export function fileRowById(conn: SqlExecutor, id: string): VfsFileRow | null {
  const row = conn.get<Omit<VfsFileRow, 'page_count'> & { page_count: number | bigint | null }>(
    'SELECT id, resource_id, blob_hash, sha256, file_name, size, "type", mime_type, page_count, extracted_text '
    + 'FROM files WHERE id = ?1',
    [id],
  );
  if (row === undefined) return null;
  return { ...row, page_count: row.page_count === null ? null : Number(row.page_count) };
}

/**
 * `VfsAttachmentRepo::resolve_file_id_with_conn`：res_* 的三级反查；
 * 非 res_* 原样返回；解析不到返回 null。
 */
export function resolveFileId(conn: SqlExecutor, rawId: string): string | null {
  const id = rawId.trim();
  if (!id.startsWith('res_')) return id;

  const uploaded = fileIdByResource(conn, id);
  if (uploaded !== null) return uploaded;

  const source = conn.pluck<string | null>(
    'SELECT source_id FROM resources WHERE id = ?1', [id]) ?? null;
  const sourceId = source === null ? null : source.trim();
  if (sourceId === null || sourceId === '' || sourceId === id) return null;

  const direct = conn.pluck<string>('SELECT id FROM files WHERE id = ?1', [sourceId]) ?? null;
  if (direct !== null) return direct;

  const viaResource = fileIdByResource(conn, sourceId);
  if (viaResource !== null) return viaResource;

  // 同步去重后的远端 files 主键：交给下游别名回退。
  return ['att_', 'file_', 'tb_'].some(prefix => sourceId.startsWith(prefix))
    ? sourceId
    : null;
}
