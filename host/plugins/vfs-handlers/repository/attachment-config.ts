/** handlers.rs vfs_get_attachment_content `img_` lookup: read-only questions/blobs. Root-folder config is L13 `ctx.vfs.attachmentConfig`. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { Context } from '@deepseek-ai/cordis';
export function questionImagePaths(db: SqlExecutor, id: string, log: Context['logger']): Array<{ hash: string; relative: string }> {
  const hashes: Array<{ hash: string; relative: string }> = [];
  for (const row of db.all<{ images_json: string }>('SELECT images_json FROM questions WHERE images_json LIKE ?1 AND deleted_at IS NULL LIMIT 5', [`%${id}%`])) {
    let images: unknown;
    try { images = JSON.parse(row.images_json); } catch { continue; }
    if (!Array.isArray(images)) continue;
    for (const img of images) {
      if (img !== null && typeof img === 'object' && img.id === id && typeof img.hash === 'string') {
        try {
          const relative = db.pluck<string>('SELECT relative_path FROM blobs WHERE hash=?1', [img.hash]);
          if (relative !== undefined) hashes.push({ hash: img.hash, relative });
          else log.warn('[VFS::handlers] img_ blob not in DB: hash=%s', img.hash);
        } catch { continue; }
      }
    }
  }
  return hashes;
}
