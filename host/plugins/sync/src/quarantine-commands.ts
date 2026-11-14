import { fs } from '../src/local-runtime.ts';
import { dirname } from '../../../platform/util/path.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { CoordinatedDatabaseName, DatabaseHandle, StorageService } from '../../../platform/storage/api.ts';
import type { PathsService } from '../../../platform/paths/api.ts';
import type { BatchQuarantineResult } from '../api.ts';
import { buildIdColumnMap } from './conflict-commands.ts';
import { retryQuarantinedChange } from '../repository/quarantine.ts';
import { listQuarantineIds, sqliteTableExists } from '../repository/conflicts.ts';

const databases: readonly CoordinatedDatabaseName[] = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function open(storage: StorageService, name: CoordinatedDatabaseName): DatabaseHandle {
  const path = storage.pathOf(name);
  if (!fs.existsSync(dirname(path))) throw new Error(`unable to open database file: ${path}`);
  return storage.openFile(path, { profile: 'plain' });
}

/** commands_sync.rs:4233-4255 `data_governance_retry_quarantine`。 */
export async function retryQuarantine(
  storage: StorageService,
  paths: PathsService,
  databaseName: string,
  quarantineId: number,
): Promise<boolean> {
  const name = databases.find(value => value === databaseName);
  if (!name) throw new CommandError(`未知数据库: ${databaseName}`);
  let db: DatabaseHandle;
  try {
    db = open(storage, name);
  } catch (error) {
    throw new CommandError(`打开数据库 ${databaseName} 失败: ${message(error)}`);
  }
  try {
    if (!sqliteTableExists(db, '__sync_quarantine')) return false;
    try {
      return retryQuarantinedChange(db, quarantineId, buildIdColumnMap(), await paths.deviceId());
    } catch (error) {
      throw new CommandError(`重试隔离记录失败: ${message(error)}`);
    }
  } finally {
    storage.close(db);
  }
}

/** commands_sync.rs:4294-4350 `data_governance_retry_all_quarantine`。 */
export async function retryAllQuarantine(storage: StorageService, paths: PathsService): Promise<BatchQuarantineResult> {
  let success = 0;
  let failed = 0;
  const errors: string[] = [];
  const device = await paths.deviceId();
  for (const name of databases) {
    if (!fs.existsSync(storage.pathOf(name))) continue;
    let db: DatabaseHandle;
    try {
      db = open(storage, name);
    } catch {
      continue;
    }
    try {
      if (!sqliteTableExists(db, '__sync_quarantine')) continue;
      let quarantineIds;
      try {
        quarantineIds = listQuarantineIds(db);
      } catch (error) {
        throw new CommandError(message(error));
      }
      const idColumns = buildIdColumnMap();
      for (const quarantineId of quarantineIds) {
        try {
          if (retryQuarantinedChange(db, quarantineId, idColumns, device)) {
            success += 1;
          } else {
            errors.push(`记录 ${quarantineId}: 重试后仍未能应用`);
            failed += 1;
          }
        } catch (error) {
          errors.push(`记录 ${quarantineId}: ${message(error)}`);
          failed += 1;
        }
      }
    } finally {
      storage.close(db);
    }
  }
  return { success, failed, errors };
}
