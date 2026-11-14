/** SQLite operations from mod.rs:10559-10612,10754-10757. */
import { fs } from '../src/local-runtime.ts';
import { dirname, join } from '../../../platform/util/path.ts';
import type { StorageService, DatabaseHandle } from '../../../platform/storage/api.ts';
import { nowEpochNanos } from '../../../platform/time/index.ts';
import { SyncError } from '../src/errors.ts';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function discard(path: string): void {
  try { fs.rmSync(path, { force: true }); }
  catch { // boundary-allow empty-catch: mod.rs:10568,10577 explicitly ignores snapshot removal failures.
  }
}
export function createWorkspaceSnapshot(storage: StorageService, path: string, id: string): string {
  const snapshot = join(dirname(path), `${id}.sync-snapshot-${nowEpochNanos()}.db`);
  discard(snapshot);
  let db: DatabaseHandle;
  try { db = storage.openFile(path, { profile: 'plain' }); }
  catch (error) { throw new SyncError(`Database error: 打开工作区数据库失败 ${JSON.stringify(path)}: ${message(error)}`); }
  try {
    try { db.exec('PRAGMA busy_timeout = 5000'); }
    catch { // boundary-allow empty-catch: mod.rs:10571 ignores busy_timeout execution errors.
    }
    try { db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}';`); }
    catch (error) { discard(snapshot); throw new SyncError(`Database error: 创建工作区数据库一致快照失败 ${JSON.stringify(path)}: ${message(error)}`); }
    return snapshot;
  } finally { storage.close(db); }
}
export function checkpointWorkspace(storage: StorageService, path: string): void {
  let db: DatabaseHandle;
  try { db = storage.openFile(path, { profile: 'plain' }); }
  catch { return; }
  try {
    try { db.exec('PRAGMA busy_timeout = 1000'); }
    catch { // boundary-allow empty-catch: mod.rs:10755 ignores busy_timeout errors.
    }
    try { db.checkpoint('PASSIVE'); }
    catch { // boundary-allow empty-catch: mod.rs:10756 ignores PASSIVE checkpoint errors.
    }
  } finally { storage.close(db); }
}
export function verifyWorkspaceIntegrity(storage: StorageService, path: string): void {
  let db: DatabaseHandle;
  try { db = storage.openFile(path, { profile: 'plain' }); }
  catch (error) { throw new SyncError(`Database error: 打开下载的 SQLite 文件失败 ${JSON.stringify(path)}: ${message(error)}`); }
  try {
    let result;
    try { result = db.pluck<string>('PRAGMA integrity_check'); }
    catch (error) { throw new SyncError(`Database error: 执行 integrity_check 失败 ${JSON.stringify(path)}: ${message(error)}`); }
    if (result?.toLowerCase() !== 'ok') throw new SyncError(`Database error: 下载的 SQLite 文件完整性检查失败 ${JSON.stringify(path)}: ${result}`);
  } finally { storage.close(db); }
}
