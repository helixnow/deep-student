import { fs } from '../src/local-runtime.ts';
import { dirname } from '../../../platform/util/path.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { CoordinatedDatabaseName, DatabaseHandle, StorageService } from '../../../platform/storage/api.ts';
import type { BatchQuarantineResult, RecordConflictCounts } from '../api.ts';
import { countUnresolvedConflicts, discardAllQuarantine, discardQuarantine, sqliteTableExists } from '../repository/conflicts.ts';

// DatabaseId::all_ordered(), schema_registry.rs:86-94.
const databases: readonly CoordinatedDatabaseName[] = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The plain profile matches commands_backup.rs:113-118, not the business DB profiles. */
function open(storage: StorageService, name: CoordinatedDatabaseName): DatabaseHandle {
  const path = storage.pathOf(name);
  if (!fs.existsSync(dirname(path))) throw new Error(`unable to open database file: ${path}`);
  return storage.openFile(path, { profile: 'plain' });
}

export function countRecordConflicts(storage: StorageService): RecordConflictCounts {
  const result: RecordConflictCounts = { per_database: {}, total_groups: 0, total_rows: 0 };
  for (const name of databases) {
    if (!fs.existsSync(storage.pathOf(name))) continue;
    let db: DatabaseHandle;
    try { db = open(storage, name); } catch { continue; }
    try {
      let count;
      try { count = countUnresolvedConflicts(db); } catch { count = { groups: 0, rows: 0 }; }
      if (count.groups > 0) {
        result.per_database[name] = count;
        result.total_groups += count.groups;
        result.total_rows += count.rows;
      }
    } finally { storage.close(db); }
  }
  return result;
}

export function discardOne(storage: StorageService, databaseName: string, quarantineId: number): boolean {
  const name = databases.find(value => value === databaseName);
  if (!name) throw new CommandError(`未知数据库: ${databaseName}`);
  let db: DatabaseHandle;
  try { db = open(storage, name); }
  catch (error) { throw new CommandError(`打开数据库 ${databaseName} 失败: ${message(error)}`); }
  try {
    if (!sqliteTableExists(db, '__sync_quarantine')) return false;
    try { return discardQuarantine(db, quarantineId); }
    catch (error) { throw new CommandError(`丢弃隔离记录失败: ${message(error)}`); }
  } finally { storage.close(db); }
}

export function discardAll(storage: StorageService): BatchQuarantineResult {
  let success = 0;
  for (const name of databases) {
    if (!fs.existsSync(storage.pathOf(name))) continue;
    let db: DatabaseHandle;
    try { db = open(storage, name); } catch { continue; }
    try {
      if (!sqliteTableExists(db, '__sync_quarantine')) continue;
      try { success += discardAllQuarantine(db); }
      catch (error) { throw new CommandError(`批量清除失败: ${message(error)}`); }
    } finally { storage.close(db); }
  }
  return { success, failed: 0, errors: [] };
}
