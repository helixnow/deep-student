import { fs } from '../src/local-runtime.ts';
import { dirname } from '../../../platform/util/path.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { CoordinatedDatabaseName, DatabaseHandle, StorageService } from '../../../platform/storage/api.ts';
import type { SyncSnapshotBatchRow } from '../api.ts';
import { sqliteTableExists, purgeResolvedConflicts as purgeConflicts } from '../repository/conflicts.ts';
import { listBatches } from '../repository/history.ts';
import { nowEpochNanos, toRfc3339 } from '../../../platform/time/index.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';

const databases: readonly CoordinatedDatabaseName[] = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function open(storage: StorageService, name: CoordinatedDatabaseName): DatabaseHandle {
  const path = storage.pathOf(name);
  if (!fs.existsSync(dirname(path))) throw new Error(`unable to open database file: ${path}`);
  return storage.openFile(path, { profile: 'plain' });
}

/** commands_sync.rs:5187-5222. */
export function listSyncSnapshotBatches(storage: StorageService, limit?: number | null): SyncSnapshotBatchRow[] {
  const perDbLimit = Math.min(limit ?? 50, 500);
  const rows: SyncSnapshotBatchRow[] = [];
  for (const name of databases) {
    if (!fs.existsSync(storage.pathOf(name))) continue;
    let db: DatabaseHandle;
    try { db = open(storage, name); } catch { continue; }
    try {
      let batches;
      try {
        batches = listBatches(db, perDbLimit);
      } catch (error) {
        throw new CommandError(`读取 ${name} 的快照批次失败: ${message(error)}`);
      }
      for (const batch of batches) {
        rows.push({
          database_name: name,
          batch_id: batch.batch_id,
          reason: batch.reason,
          created_at: batch.created_at,
          record_count: batch.record_count,
          rolled_back_at: batch.rolled_back_at,
        });
      }
    } finally {
      storage.close(db);
    }
  }
  rows.sort((left, right) => compareUtf8(right.batch_id, left.batch_id));
  return rows.slice(0, perDbLimit);
}

/** commands_sync.rs:5011-5049. SQL failures per database are counted as zero. */
export function purgeResolvedConflicts(storage: StorageService, olderThanDays?: number | null): number {
  const cutoffDays = olderThanDays ?? 30;
  const cutoff = toRfc3339(nowEpochNanos() - BigInt(cutoffDays) * 86_400_000_000_000n);
  let total = 0;
  for (const name of databases) {
    if (!fs.existsSync(storage.pathOf(name))) continue;
    let db: DatabaseHandle;
    try { db = open(storage, name); } catch { continue; }
    try {
      if (!sqliteTableExists(db, '__sync_conflicts')) continue;
      try { total += purgeConflicts(db, cutoff); } catch { continue; }
    } finally {
      storage.close(db);
    }
  }
  return total;
}
