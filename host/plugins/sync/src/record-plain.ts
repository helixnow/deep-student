/** Non-progress execution path, commands_sync.rs:1822-2206. */
import type { CloudStorage } from '../../sync-providers/api.ts';
import type { WorkspaceCoordinator } from '../../agent-workspace/api.ts';
import type { EngineChange } from './change-payload.ts';
import type { SyncManifest, MergeStrategy } from './merge.ts';
import { executeDownload, executeBidirectional, type SyncExecutionResult } from './execute-download.ts';
import { enforcePruneGapCheck, markApplyFailuresVisible, ensureDownloadApplyIsDurable, commitDownloadProgressIfNeeded, type SyncPassOptions } from './record-progress.ts';
import { runFileLevelSync } from './file-level-sync.ts';
import type { FileSyncDirection } from './workspace-sync.ts';
import { uploadEnrichedChanges } from './upload-changes.ts';
import { uploadManifest } from './manifest-upload.ts';
import { collectLocalManifest } from './transfer-commands.ts';
import { markUploadedChanges, rollbackMarkedChanges, archiveSyncedChangeLogs } from '../repository/sync-pass.ts';
import { keyOf } from '../repository/apply-shared.ts';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function append(result: SyncExecutionResult, text: string) { result.error_message = result.error_message ? `${result.error_message}；${text}` : text; }
export async function executePlainSync(
  storage: CloudStorage, enriched: readonly EngineChange[], local: SyncManifest, direction: FileSyncDirection, strategy: MergeStrategy,
  options: SyncPassOptions, coordinator: Pick<WorkspaceCoordinator, 'enterMaintenanceMode' | 'exitMaintenanceMode'> | null, start: number,
): Promise<[SyncExecutionResult, number]> {
  const active = options.localStorage.locations.activeDir; let result: SyncExecutionResult, skipped = 0;
  if (direction === 'Upload') {
    const files = await runFileLevelSync(storage, active, 'Upload', options, coordinator);
    if (files.failed) result = { success: false, direction: 'Upload', changes_uploaded: 0, changes_downloaded: 0, conflicts_detected: 0,
      duration_ms: Math.floor(performance.now() - start), error_message: files.warning };
    else {
      try { await uploadEnrichedChanges(storage, enriched, options, options.openState, options.compression); }
      catch (error) { throw new Error(`上传同步失败: ${message(error)}`); }
      const marked = markUploadedChanges(options.localStorage, enriched, true);
      const refreshed = collectLocalManifest(options.localStorage, options.deviceId, false).manifest;
      try { await uploadManifest(storage, refreshed, options, options.openState); }
      catch (error) { rollbackMarkedChanges(options.localStorage, marked, options.logger); throw new Error(`上传清单失败: ${message(error)}`); }
      options.logger.info('[sync] 跳过 v1 UPSERT-only 快照发布：权威 replace/delete-set 协议尚未启用');
      result = { success: true, direction: 'Upload', changes_uploaded: enriched.length, changes_downloaded: 0, conflicts_detected: 0,
        duration_ms: Math.floor(performance.now() - start), error_message: null };
    }
  } else {
    await enforcePruneGapCheck(storage, options);
    let downloaded, ids: (number | bigint)[] = [];
    try {
      if (direction === 'Download') [result, downloaded] = await executeDownload(storage, local, strategy, options, options.openState, options.compression);
      else [result, ids, downloaded] = await executeBidirectional(storage,
        { total_count: enriched.length, entries: enriched.map(change => ({ id: change.change_log_id ?? 0 })) }, local, strategy, options, options.openState, options.compression);
    } catch (error) { throw new Error(`${direction === 'Download' ? '下载' : '双向'}同步失败: ${message(error)}`); }
    result.conflicts_detected = 0; let appliedKeys = new Set<string>();
    if (downloaded.changes.length > 0) {
      const applied = await options.application.apply(downloaded.changes, strategy);
      result.conflicts_detected = applied.total_conflicts; skipped = applied.total_incomplete_skipped;
      markApplyFailuresVisible(result, applied); ensureDownloadApplyIsDurable(applied); appliedKeys = applied.applied_keys;
      if (skipped > 0) {
        options.logger.warn(direction === 'Download'
          ? `[data_governance] 同步完成但有 ${skipped} 条变更被跳过（旧格式数据缺失），建议在源设备重新执行完整同步`
          : `[data_governance] 双向同步完成但有 ${skipped} 条变更被跳过（旧格式数据缺失）`);
        append(result, `同步已完成，但有 ${skipped} 条变更因数据不完整被跳过。建议在源设备重新执行完整同步以补全数据。`);
      }
    }
    await commitDownloadProgressIfNeeded(storage, downloaded, options);
    if (direction === 'Bidirectional') {
      const filtered = enriched.filter(change => !appliedKeys.has(keyOf(change.table_name, change.record_id)));
      if (filtered.length < enriched.length) options.logger.info(`[data_governance] 双向同步: 已从上传列表中剔除 ${enriched.length - filtered.length} 条被下载覆盖的记录`);
      result.changes_uploaded = filtered.length;
      const files = await runFileLevelSync(storage, active, 'Upload', options, coordinator);
      if (files.failed) { append(result, files.warning ?? '文件级同步失败'); result.success = false; }
      if (result.success) {
        if (filtered.length > 0) {
          try { await uploadEnrichedChanges(storage, filtered, options, options.openState, options.compression); }
          catch (error) { throw new Error(`上传变更失败: ${message(error)}`); }
        }
        const marked = markUploadedChanges(options.localStorage, filtered, true);
        if (ids.length > 0) options.logger.debug(`[data_governance] 双向同步标记变更完成: ${ids.length} 条`);
        const refreshed = collectLocalManifest(options.localStorage, options.deviceId, false).manifest;
        try { await uploadManifest(storage, refreshed, options, options.openState); }
        catch (error) { rollbackMarkedChanges(options.localStorage, marked, options.logger); throw new Error(`上传刷新清单失败: ${message(error)}`); }
        options.logger.info('[sync] 跳过 v1 UPSERT-only 快照发布：权威 replace/delete-set 协议尚未启用');
      }
    }
  }
  if (direction !== 'Upload' && result.success) {
    const files = await runFileLevelSync(storage, active, 'Download', options, coordinator);
    if (files.failed) { result.success = false; if (files.warning !== null) append(result, files.warning); }
  }
  if (direction !== 'Download' && result.success) {
    options.logger.info('[sync] 自动 prune 已禁用：当前快照不具备权威 replace/delete-set 语义');
    archiveSyncedChangeLogs(options.localStorage, 30, options.deviceId, options.logger);
  }
  return [result, skipped];
}
