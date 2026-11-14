/** D2 shared-permit command shells; backup owns the only coordinator instance. */
import { CommandError } from '../../../kernel/api.ts';
import type { SyncContext } from './dependencies.ts';
import { isOperationGuardError } from '../../backup/api.ts';
import { assertNotInMaintenance } from './cloud-runtime.ts';
import { importSyncData } from './transfer-commands.ts';
import { resolveRecordConflict, rollbackSyncSnapshotBatch } from './conflict-commands.ts';

function stringError(error: unknown): CommandError {
  return error instanceof CommandError && typeof error.value === 'string' ? error
    : new CommandError(error instanceof Error ? error.message : String(error));
}
function tryPermit(ctx: SyncContext, busyMessage: string) {
  try { return ctx.backup.tryAcquireOperation('sync'); }
  catch (error) {
    if (isOperationGuardError(error) && error.reason === 'busy') throw new CommandError(busyMessage);
    throw stringError(error);
  }
}
export async function importSyncDataCommand(ctx: SyncContext, inputPath: string, strategy: string | null) {
  ctx.logger('sync').info(`[data_governance] 导入同步数据: path=${inputPath}`);
  assertNotInMaintenance(ctx);
  let permit;
  try { permit = await ctx.backup.acquireOperation('sync', 60_000); }
  catch (error) { throw stringError(error); }
  try { return await importSyncData(ctx.storage, ctx.paths, inputPath, strategy, ctx.mastery, ctx.logger('sync')); }
  finally { permit.release(); }
}
export interface ResolveConflictArgs {
  databaseName: string; tableName: string; recordId: string; resolution: string;
  mergedDataJson: string | null; expectedConflictIds: readonly number[];
}
export function resolveRecordConflictCommand(ctx: SyncContext, args: ResolveConflictArgs): void {
  assertNotInMaintenance(ctx);
  const permit = tryPermit(ctx, '其他备份、恢复或同步操作正在进行，请刷新冲突后重试');
  try { resolveRecordConflict(ctx.storage, args.databaseName, args.tableName, args.recordId, args.resolution, args.mergedDataJson, args.expectedConflictIds); }
  finally { permit.release(); }
}
export function rollbackSyncSnapshotCommand(ctx: SyncContext, databaseName: string, batchId: string) {
  assertNotInMaintenance(ctx);
  const permit = tryPermit(ctx, '其他备份、恢复或同步操作正在进行，请稍后重试');
  try { return rollbackSyncSnapshotBatch(ctx.storage, databaseName, batchId); }
  finally { permit.release(); }
}
