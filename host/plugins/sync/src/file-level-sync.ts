/** commands_sync.rs:698-1013: file phases, progress and workspace maintenance. */
import { join } from '../../../platform/util/path.ts';
import type { WorkspaceCoordinator } from '../../agent-workspace/api.ts';
import { isCloudRateLimited, type CloudStorage } from '../../sync-providers/api.ts';
import type { AsyncAssetTombstones, AsyncBlobTombstones, AsyncTombstoneWriter, AsyncWorkspaceTombstones } from './tombstone-needs.ts';
import { syncWorkspaceDatabases, type WorkspaceSyncOptions, type FileSyncDirection, type FileTransferProgress } from './workspace-sync.ts';
import { syncBlobsWithTombstones, syncAssetsWithTombstones } from './file-tombstone-sync.ts';
import { drainDeletionQueue } from './deletion-queues.ts';
import { FILENAME_CONFLICT_MARKER } from './asset-filenames.ts';
import { OptionalEmitter } from './emitter.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { PortableAssetOptions } from './portable-assets.ts';
import { syncPreferences } from './preferences-sync.ts';

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

export interface FileLevelSyncOptions extends WorkspaceSyncOptions, PortableAssetOptions {
  settings?: SettingsStore;
  appDataDir?: string;
  tombstones: AsyncWorkspaceTombstones & AsyncBlobTombstones & AsyncAssetTombstones & AsyncTombstoneWriter;
}
export interface FileLevelSyncReport { failed: boolean; warning: string | null }
type Maintenance = Pick<WorkspaceCoordinator, 'enterMaintenanceMode' | 'exitMaintenanceMode'>;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const f32 = Math.fround;
const clamp = (value: number) => Math.min(1, Math.max(0, value));

export class FileLevelProgress {
  private emitter: OptionalEmitter;
  private start: number;
  private end: number;
  constructor(emitter: OptionalEmitter, start: number, end: number) {
    this.emitter = emitter; this.start = f32(start); this.end = f32(end);
  }
  private send(direction: FileSyncDirection, current: number, total: number, percent: number, item: string): void {
    this.emitter.emitForceSync({ operation_id: null, outcome: null, phase: direction === 'Download' ? 'downloading' : 'uploading',
      percent, current, total, current_item: item, speed_bytes_per_sec: null, eta_seconds: null, error: null });
  }
  emit(direction: FileSyncDirection, current: number, total: number, item: string): void {
    total = Math.max(total, 1);
    const fraction = clamp(f32(f32(current) / f32(total)));
    this.send(direction, current, total, f32(this.start + f32(f32(this.end - this.start) * fraction)), item);
  }
  transferCallback(direction: FileSyncDirection, step: number, totalSteps: number, label: string): FileTransferProgress {
    const total = Math.max(totalSteps, 1); let last = 0;
    return (item, done, bytes) => {
      if (!(bytes > 0 && done >= bytes)) {
        const now = Math.max(0, Date.now());
        if (Math.max(0, now - last) < 100) return;
        last = now;
      }
      const inner = bytes > 0 ? clamp(f32(f32(done) / f32(bytes))) : 0;
      const stage = f32(f32(f32(step) + inner) / f32(total));
      this.send(direction, done, bytes, f32(this.start + f32(f32(this.end - this.start) * clamp(stage))), `${label}：${item}`);
    };
  }
}

export async function runFileLevelSync(
  cloud: CloudStorage, active: string, direction: FileSyncDirection, options: FileLevelSyncOptions,
  coordinator: Maintenance | null, progress?: FileLevelProgress | null,
): Promise<FileLevelSyncReport> {
  const report: FileLevelSyncReport = { failed: false, warning: null }, { logger } = options;
  const append = (text: string) => { report.failed = true; report.warning = report.warning ? `${report.warning}；${text}` : text; };
  const rateLimited = () => report.warning !== null && isCloudRateLimited(report.warning);
  const transfer = (step: number) => progress?.transferCallback(direction, step, 3, '文件级传输');
  progress?.emit(direction, 0, 3, '文件级同步：工作区数据库');
  let entered = false;
  try {
    if (coordinator === null) throw new Error('WorkspaceCoordinator 尚未初始化，无法取得一致性屏障');
    try { await coordinator.enterMaintenanceMode(); }
    catch (error) { throw new Error(`进入工作区维护模式失败: ${message(error)}`); }
    entered = true;
  } catch (error) {
    const detail = `工作区数据库同步已跳过: ${message(error)}`;
    logger.warn(`[data_governance] ${detail}`); append(detail);
  }
  if (entered) {
    try {
      if (direction !== 'Download') {
        try { await drainDeletionQueue(options.localStorage, cloud, 'workspace', options); }
        catch (error) { logger.warn(`[data_governance] ${message(error)}`); append(message(error)); if (rateLimited()) return report; }
      }
      try { await syncWorkspaceDatabases(cloud, active, direction, options, transfer(0)); }
      catch (error) { const detail = `工作区数据库同步失败: ${message(error)}`; logger.warn(`[data_governance] ${detail}`); append(detail); }
    } finally {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { coordinator!.exitMaintenanceMode(); break; }
        catch (error) {
          if (attempt < 3) await sleep(50 * attempt);
          else logger.error(`[data_governance] 退出工作区维护模式连续失败，工作区保持只读以避免写入内存池丢失: ${message(error)}`);
        }
      }
    }
  }
  if (rateLimited()) return report;
  progress?.emit(direction, 1, 3, '文件级同步：VFS blob');
  if (direction !== 'Download') {
    try { await drainDeletionQueue(options.localStorage, cloud, 'blob', options); }
    catch (error) { logger.warn(`[data_governance] ${message(error)}`); append(message(error)); if (rateLimited()) return report; }
  }
  try {
    const result = await syncBlobsWithTombstones(cloud, join(active, 'vfs_blobs'), direction, options, transfer(1));
    if (result.upload_failures.length || result.download_failures.length) {
      const detail = `附件同步部分失败：${result.upload_failures.length} 个上传失败，${result.download_failures.length} 个下载失败`;
      logger.warn(`[data_governance] VFS blob 部分失败: ${detail}`); append(detail);
    }
  } catch (error) { const detail = `附件同步失败: ${message(error)}`; logger.error(`[data_governance] ${detail}`); append(detail); }
  if (rateLimited()) return report;
  progress?.emit(direction, 2, 3, '文件级同步：资产目录');
  if (direction !== 'Download') {
    try { await drainDeletionQueue(options.localStorage, cloud, 'asset', options); }
    catch (error) { logger.warn(`[data_governance] ${message(error)}`); append(message(error)); if (rateLimited()) return report; }
  }
  try {
    // Rust intentionally maps legacy app_data asset keys to the active slot.
    if (options.settings) await syncPreferences(cloud, options.settings, options.deviceId, direction, options.codec);
    const assetOptions = { ...options,
      includeSkills: options.settings ? options.settings.get('sync.include_skills') !== 'false' : options.includeSkills,
      includePlugins: options.settings ? options.settings.get('sync.include_plugins') !== 'false' : options.includePlugins };
    const result = await syncAssetsWithTombstones(cloud, active, options.appDataDir ?? active, direction, assetOptions, transfer(2));
    if (result.upload_failures.length || result.download_failures.length) {
      let detail = `资产目录同步部分失败：${result.upload_failures.length} 个上传失败，${result.download_failures.length} 个下载失败`;
      const conflict = [...result.upload_failures, ...result.download_failures].find(text => text.includes(FILENAME_CONFLICT_MARKER));
      if (conflict !== undefined) detail += `；${conflict}`;
      logger.warn(`[data_governance] 资产目录部分失败: ${detail}`); append(detail);
    }
  } catch (error) { const detail = `资产目录同步失败: ${message(error)}`; logger.error(`[data_governance] ${detail}`); append(detail); }
  progress?.emit(direction, 3, 3, '文件级同步完成');
  return report;
}
