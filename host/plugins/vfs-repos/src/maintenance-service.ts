/**
 * Production provider for the `vfsMaintenance` service handed over by L13b.
 *
 * The service is connection-free for command code: every call resolves the
 * shared `vfs` handle and blob directory here. `vfsDatabase` is looked up
 * lazily because tests (and minimal profiles) may install only `storage`;
 * when present it remains the authority for maintenance-mode checks and the
 * blob directory, matching how the rest of the host reaches the VFS database.
 */
import { join } from '../../../platform/util/path.ts';
import { Service, type Context } from '@deepseek-ai/cordis';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import { vfsReposLocalRuntime } from './local-runtime.ts';
import {
  vfsMaintenanceService,
  type BeforeVectorClear,
  type ClearMediaCacheParams,
  type ClearMediaCacheResult,
  type TodoItem,
  type VfsIndexResetCounts,
  type VfsMaintenanceService,
  type VfsReposService,
} from '../api.ts';

export class VfsMaintenance extends Service implements VfsMaintenanceService {
  private readonly repos: VfsReposService;

  constructor(ctx: Context, repos: VfsReposService) {
    super(ctx, vfsMaintenanceService.name);
    this.repos = repos;
  }

  createTodoSubtasks(listId: string, parentId: string, titles: readonly string[]): TodoItem[] {
    return this.repos.maintenance.createTodoSubtasks(this.database(), listId, parentId, titles);
  }

  resetDisabledToPending(): number {
    return this.repos.maintenance.resetDisabledToPending(this.database());
  }

  resetIndexedWithoutEmbeddings(): number {
    return this.repos.maintenance.resetIndexedWithoutEmbeddings(this.database());
  }

  resetAllIndexStateRows(): VfsIndexResetCounts {
    return this.repos.maintenance.resetAllIndexStateRows(this.database());
  }

  clearMediaCache(params: ClearMediaCacheParams, beforeVectorClear?: BeforeVectorClear): Promise<ClearMediaCacheResult> {
    return this.repos.maintenance.clearMediaCache(
      this.database(), this.blobsDir(), params, beforeVectorClear);
  }

  clearResourceOcr(resourceId: string): void {
    this.repos.maintenance.clearResourceOcr(this.database(), resourceId);
  }

  getResourcePath(sourceId: string): string {
    return this.repos.maintenance.getResourcePath(this.database(), sourceId);
  }

  updatePathCache(folderId: string): number {
    return this.repos.maintenance.updatePathCache(this.database(), folderId);
  }

  /**
   * `dstu-sync/src/data_governance/backup/mod.rs:2307 reset_rebuildable_vfs_index`。
   * 顺序照 Rust：先删候选槽的 Lance 目录（失败则不碰 SQLite），再打开
   * `<targetDir>/databases/vfs.db`，在 `BEGIN IMMEDIATE` 内按现有列重置 L11 账本。
   * 调用方只传目标槽根目录，不持有连接、不执行 VFS SQL。
   */
  resetRebuildableIndex(targetDir: string): void {
    const lanceDir = join(targetDir, 'databases', 'lance', 'vfs');
    if (vfsReposLocalRuntime().exists(lanceDir)) {
      try {
        vfsReposLocalRuntime().removeDirForce(lanceDir);
      } catch (error) {
        throw new Error(
          `无法清理恢复目标中的陈旧 Lance 索引 ${lanceDir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const dbPath = join(targetDir, 'databases', 'vfs.db');
    if (!vfsReposLocalRuntime().exists(dbPath)) return;
    // `openFile` 是 `StorageService` 的公开入口（桌面独立连接 / 移动端同一文件单连接），
    // 不需要直接依赖桌面的 `SqliteDatabase` 实现。
    const database = this.ctx.storage.openFile(dbPath, {
      label: 'vfs-restore', profile: 'plain', mustExist: true,
    });
    try {
      database.transaction((tx) => {
        this.repos.maintenance.resetRebuildableIndex(tx);
      }, { behavior: 'immediate' });
    } finally {
      this.ctx.storage.close(database);
    }
  }

  private database(): DatabaseHandle {
    const database = this.ctx.get('vfsDatabase') as VfsDatabase | undefined;
    if (database !== undefined) return database.getConnSafe();
    return this.ctx.storage.database('vfs');
  }

  private blobsDir(): string {
    const database = this.ctx.get('vfsDatabase') as VfsDatabase | undefined;
    if (database !== undefined) return database.blobsDir();
    return join(this.ctx.storage.locations.activeDir, 'vfs_blobs');
  }
}
