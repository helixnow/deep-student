/** context_compiler.rs:603–671. VFS owns resolution, L03 verifies request-local image bytes. */
import type { Context } from '@deepseek-ai/cordis';
import type { FilesService } from '../../../platform/files/api.ts';
import { toBase64 } from '../../../platform/crypto/encoding.ts';
import type { CanonicalContentPart } from '../../chat/api.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { BlobRepository } from '../../vfs-repos/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { sniffImageMime, type ResolvedCanonicalImage } from './images.ts';

/** L11 requested getBlobHashByFileOrResourceId: exact id wins over resource_id; same connection. */
export type CanonicalFileBlobLookup = (conn: SqlExecutor, sourceId: string) => string | null;

/** `ctx.files` 中读取 blob 字节用到的操作。 */
export type CanonicalImageFiles = Pick<FilesService, 'readBytes'>;

export async function resolveCanonicalImagePayloads(parts: readonly CanonicalContentPart[],
  database: VfsDatabase | null, blobs: BlobRepository | null, fileBlob: CanonicalFileBlobLookup,
  log: Pick<Context['logger'], 'warn'>, files: () => CanonicalImageFiles): Promise<(ResolvedCanonicalImage | null)[]> {
  const images = parts.filter(part => part.type === 'image_ref');
  if (database === null || blobs === null) return images.map(() => null);
  let conn: SqlExecutor;
  try { conn = database.getConnSafe(); } catch { return images.map(() => null); }
  const payloads: (ResolvedCanonicalImage | null)[] = [];
  for (const image of images) {
    let hash = image.blob_hash ?? null;
    let bytes: Uint8Array;
    try {
      if (hash === null && image.source_id != null) hash = fileBlob(conn, image.source_id);
      if (hash === null) { payloads.push(null); continue; }
      const path = blobs.getBlobPath(conn, database.blobsDir(), hash);
      if (path === null) { payloads.push(null); continue; }
      bytes = await files().readBytes(path);
    } catch { payloads.push(null); continue; } // Rust query/path/read .ok()? returns None for this slot.
    const actualMime = sniffImageMime(bytes);
    if (actualMime === null) {
      log.warn(`[ChatV2::ContextCompiler] dropping canonical image payload with non-image bytes (declared mime ${JSON.stringify(image.mime_type)}, blob hash prefix ${hash.slice(0, 12)})`);
      payloads.push(null); continue;
    }
    if (actualMime !== image.mime_type) {
      log.warn(`[ChatV2::ContextCompiler] canonical image mime mismatch: declared ${JSON.stringify(image.mime_type)}, actual ${actualMime} (blob hash prefix ${hash.slice(0, 12)})`);
    }
    payloads.push({ mimeType: actualMime, base64: toBase64(bytes) });
  }
  return payloads;
}
