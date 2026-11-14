/** commands_sync.rs:3372-3565. File phase first, then batches of 1000 enriched rows. */
import type { CloudStorage } from '../../sync-providers/api.ts';
import type { WorkspaceCoordinator } from '../../agent-workspace/api.ts';
import type { EngineChange } from './change-payload.ts';
import type { SyncManifest } from './merge.ts';
import type { SyncExecutionResult } from './execute-download.ts';
import type { SyncPassOptions } from './record-progress.ts';
import { OptionalEmitter } from './emitter.ts';
import { runFileLevelSync, FileLevelProgress } from './file-level-sync.ts';
import { uploadEnrichedChanges } from './upload-changes.ts';
import { uploadManifest } from './manifest-upload.ts';
import { collectLocalManifest } from './transfer-commands.ts';
import { markUploadedChanges, rollbackMarkedChanges, archiveSyncedChangeLogs } from '../repository/sync-pass.ts';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export async function executeUploadWithProgress(
  storage: CloudStorage, enriched: readonly EngineChange[], local: SyncManifest, options: SyncPassOptions,
  coordinator: Pick<WorkspaceCoordinator, 'enterMaintenanceMode' | 'exitMaintenanceMode'> | null, emitter: OptionalEmitter,
): Promise<[SyncExecutionResult, number]> {
  const start = performance.now(), total = enriched.length;
  const report = await runFileLevelSync(storage, options.localStorage.locations.activeDir, 'Upload', options, coordinator, new FileLevelProgress(emitter, 10, 55));
  if (report.failed) return [{ success: false, direction: 'Upload', changes_uploaded: 0, changes_downloaded: 0, conflicts_detected: 0,
    duration_ms: Math.floor(performance.now() - start), error_message: report.warning }, 0];
  if (total === 0) {
    try { await uploadManifest(storage, local, options, options.openState); }
    catch (error) { throw new Error(`上传清单失败: ${message(error)}`); }
  } else {
    await emitter.emitUploading(0, total, null);
    const count = Math.ceil(total / 1000);
    for (let index = 0; index < count; index++) {
      const f = Math.fround;
      const base = f(60 + f(f(f(index) / f(count)) * 25)), span = f(25 / f(count)); let last = 0;
      const progress = (done: number, bytes: number) => {
        if (!(bytes > 0 && done >= bytes)) { const now = Math.max(0, Date.now()); if (Math.max(0, now - last) < 100) return; last = now; }
        const inner = bytes > 0 ? f(f(done) / f(bytes)) : 0;
        emitter.emitForceSync({ operation_id: null, outcome: null, phase: 'uploading', percent: f(base + f(inner * span)), current: done, total: bytes,
          current_item: `上传批次 ${index + 1}/${count}`, speed_bytes_per_sec: null, eta_seconds: null, error: null });
      };
      try { await uploadEnrichedChanges(storage, enriched.slice(index * 1000, (index + 1) * 1000), options, options.openState, options.compression, progress); }
      catch (error) { throw new Error(`上传同步失败（批次 ${index + 1}/${count}）: ${message(error)}`); }
      await new Promise<void>(resolve => { setTimeout(resolve, 0); });
    }
    await emitter.emitUploading(total, total, null);
    const marked = markUploadedChanges(options.localStorage, enriched);
    const refreshed = collectLocalManifest(options.localStorage, options.deviceId, false).manifest;
    try { await uploadManifest(storage, refreshed, options, options.openState); }
    catch (error) { rollbackMarkedChanges(options.localStorage, marked, options.logger); throw new Error(`上传清单失败: ${message(error)}`); }
  }
  options.logger.info('[sync] 跳过 v1 UPSERT-only 快照发布：权威 replace/delete-set 协议尚未启用');
  await emitter.emitApplying(total, total, null);
  options.logger.info('[sync] 自动 prune 已禁用：当前快照不具备权威 replace/delete-set 语义');
  archiveSyncedChangeLogs(options.localStorage, 30, options.deviceId, options.logger);
  return [{ success: true, direction: 'Upload', changes_uploaded: total, changes_downloaded: 0, conflicts_detected: 0,
    duration_ms: Math.floor(performance.now() - start), error_message: null }, 0];
}
