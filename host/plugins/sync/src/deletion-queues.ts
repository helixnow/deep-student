import { fs } from '../src/local-runtime.ts';
import type { StorageService } from '../../../platform/storage/api.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';
import { readDeletionQueue, finishDeletionQueue, type DeletionKind } from '../repository/deletion-queues.ts';
import { markBlobDeletions, markAssetDeletions, markWorkspaceDeletions, type DeletionOptions } from './file-deletions.ts';
import type { SyncLogger } from './log.ts';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export async function drainDeletionQueue(local: StorageService, cloud: CloudStorage, kind: DeletionKind, options: DeletionOptions & { logger: SyncLogger }): Promise<number> {
  const name = kind === 'workspace' ? 'chat_v2' : 'vfs', path = local.pathOf(name);
  if (!fs.existsSync(path)) return 0;
  let db;
  try { db = local.openFile(path, { profile: 'plain' }); }
  catch (error) { throw new Error(`打开 ${name}.db 失败（无法传播 ${kind} 删除队列）: ${message(error)}`); }
  try {
    let rows;
    try { rows = readDeletionQueue(db, kind); }
    catch (error) { throw new Error(`读取 ${kind} 删除队列失败: ${message(error)}`); }
    if (rows.length === 0) return 0;
    try {
      if (kind === 'blob') await markBlobDeletions(cloud, rows.map(row => [row.id, row.path, row.size, row.deletedAt]), options);
      else if (kind === 'asset') await markAssetDeletions(cloud, rows.map(row => [row.id, row.size, row.deletedAt]), options);
      else await markWorkspaceDeletions(cloud, rows.map(row => [row.id, row.deletedAt]), options);
    } catch (error) {
      const detail = `批量传播 ${kind} 删除失败（将重试 ${rows.length} 条）: ${message(error)}`;
      options.logger.warn(`[data_governance] ${detail}`);
      finishDeletionQueue(db, kind, rows.map(row => row.id), false);
      throw new Error(detail);
    }
    finishDeletionQueue(db, kind, rows.map(row => row.id), true);
    options.logger.info(`[data_governance] ${kind} 删除队列已批量传播 ${rows.length} 条到云端`);
    return rows.length;
  } finally { local.close(db); }
}
