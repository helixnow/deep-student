/** mod.rs:12593-12652: local references veto file-level tombstones. Read-only. */
import { fs } from '../src/local-runtime.ts';
import { dirname, join } from '../../../platform/util/path.ts';
import type { StorageService, DatabaseHandle } from '../../../platform/storage/api.ts';
import type { SyncLogger } from '../src/log.ts';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export function blobHashesWithLocalRefs(storage: StorageService, blobsDir: string, hashes: Iterable<string>, logger: SyncLogger): Set<string> {
  const referenced = new Set<string>(), path = join(dirname(blobsDir), 'databases/vfs.db');
  if (!fs.existsSync(path)) return referenced;
  let db: DatabaseHandle;
  try { db = storage.openFile(path, { profile: 'plain' }); }
  catch (error) { logger.warn(`[sync] 无法打开 vfs.db 检查 blob 引用（防线跳过）: ${message(error)}`); return referenced; }
  try {
    let exists;
    try { exists = db.pluck<number>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='blobs')"); }
    catch { return referenced; }
    if (!exists) return referenced;
    const all = [...hashes];
    for (let offset = 0; offset < all.length; offset += 999) {
      const chunk = all.slice(offset, offset + 999);
      let rows;
      try { rows = db.all<{ hash: unknown }>(`SELECT hash FROM blobs WHERE ref_count > 0 AND hash IN (${chunk.map(() => '?').join(',')})`, chunk); }
      catch (error) { logger.warn(`[sync] 查询 blobs.ref_count 失败（防线跳过）: ${message(error)}`); return referenced; }
      for (const row of rows) if (typeof row.hash === 'string') referenced.add(row.hash);
    }
    return referenced;
  } finally { storage.close(db); }
}
