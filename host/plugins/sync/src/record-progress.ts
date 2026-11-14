/** v2 record progress paths, commands_sync.rs:3569-4017. */
import type { WorkspaceCoordinator } from '../../agent-workspace/api.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';
import type { NativeCompression } from '../../../platform/native/api.ts';
import type { ApplyToDatabasesResult } from '../repository/apply-databases.ts';
import { keyOf } from '../repository/apply-shared.ts';
import { markUploadedChanges, rollbackMarkedChanges, archiveSyncedChangeLogs } from '../repository/sync-pass.ts';
import type { EngineChange } from './change-payload.ts';
import type { SyncManifest, MergeStrategy } from './merge.ts';
import { collectLocalManifest } from './transfer-commands.ts';
import { detectChangeLogGaps } from './change-availability.ts';
import { changeLogGapDiagnostic } from './change-keys.ts';
import { executeDownload, executeBidirectional, type SyncExecutionResult, type PendingChangeSummary } from './execute-download.ts';
import { commitDownloadProgress, type DownloadChangesResult } from './download-changes.ts';
import { uploadManifest } from './manifest-upload.ts';
import { uploadEnrichedChanges } from './upload-changes.ts';
import { runFileLevelSync, FileLevelProgress, type FileLevelSyncOptions } from './file-level-sync.ts';
import { OptionalEmitter } from './emitter.ts';

/** Shared orchestration boundary; the production caller uses ctx.sync's public multi-DB apply. */
export interface SyncDatabaseApplication {
  /** applied_keys encodes Rust (table_name, record_id) as `${table}\u001f${recordId}`. */
  apply(changes: readonly EngineChange[], strategy: MergeStrategy): ApplyToDatabasesResult | Promise<ApplyToDatabasesResult>;
}
export interface SyncPassOptions extends FileLevelSyncOptions {
  compression: NativeCompression;
  application: SyncDatabaseApplication;
}
type Maintenance = Pick<WorkspaceCoordinator, 'enterMaintenanceMode' | 'exitMaintenanceMode'>;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function append(result: SyncExecutionResult, text: string): void { result.error_message = result.error_message ? `${result.error_message}；${text}` : text; }
export async function enforcePruneGapCheck(storage: CloudStorage, options: SyncPassOptions): Promise<void> {
  let availability;
  try { availability = await detectChangeLogGaps(storage, options, options.openState); }
  catch (error) { throw new Error(`检查云端变更断层失败: ${message(error)}`); }
  if (availability.gaps.length > 0) throw new Error(availability.gaps.map(changeLogGapDiagnostic).join('；'));
}
export function ensureDownloadApplyIsDurable(result: ApplyToDatabasesResult): void {
  if (result.db_errors.length > 0) throw new Error(`下载变更未能持久处理，已保留远端游标等待重试：${result.db_errors.map(([db, error]) => `${db}: ${error}`).join('；')}`);
}
export function markApplyFailuresVisible(result: SyncExecutionResult, applied: ApplyToDatabasesResult): void {
  if (applied.total_failed === 0) return;
  result.success = false;
  append(result, applied.db_errors.length === 0
    ? `${applied.total_failed} 条云端变更未能应用，已移入同步隔离区或失败记录。请处理后重试同步。`
    : `${applied.total_failed} 条云端变更未能应用：${applied.db_errors.map(([db, error]) => `${db}: ${error}`).join('；')}。请处理后重试同步。`);
}
function skippedWarning(result: SyncExecutionResult, count: number): void {
  if (count > 0) append(result, `同步已完成，但有 ${count} 条变更因数据不完整被跳过。建议在源设备重新执行完整同步以补全数据。`);
}
export async function commitDownloadProgressIfNeeded(storage: CloudStorage, downloaded: DownloadChangesResult, options: SyncPassOptions): Promise<void> {
  if (downloaded.cursor_advancements.size === 0 && downloaded.legacy_processed_keys.length === 0) return;
  try { await commitDownloadProgress(storage, downloaded, options, options.openState); }
  catch (error) { throw new Error(`提交下载游标失败: ${message(error)}`); }
  const manifest = collectLocalManifest(options.localStorage, options.deviceId, false).manifest;
  try { await uploadManifest(storage, manifest, options, options.openState); }
  catch (error) { throw new Error(`上传当前设备清单失败: ${message(error)}`); }
}
export async function executeDownloadWithProgress(
  storage: CloudStorage, local: SyncManifest, strategy: MergeStrategy, options: SyncPassOptions,
  coordinator: Maintenance | null, emitter: OptionalEmitter,
): Promise<[SyncExecutionResult, number]> {
  await enforcePruneGapCheck(storage, options);
  // commands_sync.rs:3646-3656 explicitly disables UPSERT-only snapshot bootstrap.
  await emitter.emitDownloading(0, 0, null);
  let result: SyncExecutionResult, downloaded: DownloadChangesResult;
  try { [result, downloaded] = await executeDownload(storage, local, strategy, options, options.openState, options.compression); }
  catch (error) { throw new Error(`下载同步失败: ${message(error)}`); }
  const total = downloaded.changes.length;
  await emitter.emitDownloading(total, total, null);
  result.conflicts_detected = 0; let skipped = 0;
  if (total > 0) {
    await emitter.emitApplying(0, total, '应用变更');
    const applied = await options.application.apply(downloaded.changes, strategy);
    result.conflicts_detected = applied.total_conflicts; skipped = applied.total_incomplete_skipped;
    markApplyFailuresVisible(result, applied); ensureDownloadApplyIsDurable(applied); skippedWarning(result, skipped);
    await emitter.emitApplying(total, total, null);
  }
  await commitDownloadProgressIfNeeded(storage, downloaded, options);
  const report = await runFileLevelSync(storage, options.localStorage.locations.activeDir, 'Download', options, coordinator, new FileLevelProgress(emitter, 85, 99));
  if (report.failed) { result.success = false; if (report.warning !== null) append(result, report.warning); }
  return [result, skipped];
}
export async function executeBidirectionalWithProgress(
  storage: CloudStorage, enriched: readonly EngineChange[], pending: PendingChangeSummary, local: SyncManifest, strategy: MergeStrategy,
  options: SyncPassOptions, coordinator: Maintenance | null, emitter: OptionalEmitter,
): Promise<[SyncExecutionResult, number]> {
  await enforcePruneGapCheck(storage, options);
  let result: SyncExecutionResult, ids: (number | bigint)[], downloaded: DownloadChangesResult;
  try { [result, ids, downloaded] = await executeBidirectional(storage, pending, local, strategy, options, options.openState, options.compression); }
  catch (error) { throw new Error(`双向同步失败: ${message(error)}`); }
  const total = downloaded.changes.length;
  if (total > 0) await emitter.emitDownloading(total, total, null);
  result.conflicts_detected = 0; let skipped = 0, appliedKeys = new Set<string>();
  if (total > 0) {
    await emitter.emitApplying(0, total, '应用下载变更');
    const applied = await options.application.apply(downloaded.changes, strategy);
    result.conflicts_detected = applied.total_conflicts; skipped = applied.total_incomplete_skipped;
    markApplyFailuresVisible(result, applied); ensureDownloadApplyIsDurable(applied); appliedKeys = applied.applied_keys; skippedWarning(result, skipped);
    await emitter.emitApplying(total, total, null);
  }
  await commitDownloadProgressIfNeeded(storage, downloaded, options);
  const filtered = enriched.filter(change => !appliedKeys.has(keyOf(change.table_name, change.record_id)));
  if (filtered.length < enriched.length) options.logger.info(`[data_governance] 双向同步: 已从上传列表中剔除 ${enriched.length - filtered.length} 条被下载覆盖的记录`);
  result.changes_uploaded = filtered.length;
  const active = options.localStorage.locations.activeDir;
  const upload = await runFileLevelSync(storage, active, 'Upload', options, coordinator, new FileLevelProgress(emitter, 60, 70));
  if (upload.failed) { result.success = false; if (upload.warning !== null) append(result, upload.warning); return [result, skipped]; }
  if (filtered.length > 0) {
    await emitter.emitUploading(0, filtered.length, null);
    let last = 0;
    const progress = (done: number, bytes: number) => {
      if (!(bytes > 0 && done >= bytes)) { const now = Math.max(0, Date.now()); if (Math.max(0, now - last) < 100) return; last = now; }
      const percent = bytes > 0 ? Math.fround(60 + Math.fround(Math.fround(Math.fround(done) / Math.fround(bytes)) * 25)) : 60;
      emitter.emitForceSync({ operation_id: null, outcome: null, phase: 'uploading', percent, current: done, total: bytes,
        current_item: null, speed_bytes_per_sec: null, eta_seconds: null, error: null });
    };
    try { await uploadEnrichedChanges(storage, filtered, options, options.openState, options.compression, progress); }
    catch (error) { throw new Error(`上传变更失败: ${message(error)}`); }
    await emitter.emitUploading(filtered.length, filtered.length, null);
  }
  const marked = markUploadedChanges(options.localStorage, filtered);
  if (ids.length > 0) options.logger.debug(`[data_governance] 双向同步标记变更完成: ${ids.length} 条`);
  const refreshed = collectLocalManifest(options.localStorage, options.deviceId, false).manifest;
  try { await uploadManifest(storage, refreshed, options, options.openState); }
  catch (error) { rollbackMarkedChanges(options.localStorage, marked, options.logger); throw new Error(`上传刷新清单失败: ${message(error)}`); }
  // mod.rs:3510,3893: authoritative replacement is disabled in the Rust build.
  options.logger.info('[sync] 跳过 v1 UPSERT-only 快照发布：权威 replace/delete-set 协议尚未启用');
  const download = await runFileLevelSync(storage, active, 'Download', options, coordinator, new FileLevelProgress(emitter, 85, 99));
  if (download.failed) { result.success = false; if (download.warning !== null) append(result, download.warning); }
  options.logger.info('[sync] 自动 prune 已禁用：当前快照不具备权威 replace/delete-set 语义');
  archiveSyncedChangeLogs(options.localStorage, 30, options.deviceId, options.logger);
  return [result, skipped];
}
