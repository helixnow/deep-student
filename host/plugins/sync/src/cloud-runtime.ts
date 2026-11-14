/**
 * 同步命令的云运行时接线。
 *
 * 传输由 L23 `syncProvider` 提供，凭据补全由 L21 `backup` 提供；
 * 两者都是已发布服务，本插件不复制配置/加密实现。
 */
import type { SyncContext } from './dependencies.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { CloudStorageConfig } from '../../../../contracts/ipc/generated/_shared.ts';
import type { CloudStorage, RuntimeCloudStorageConfig } from '../../sync-providers/api.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Rust `check_maintenance_mode`（commands.rs:106）：服务缺失时与 Rust `try_state` 一样放行。 */
export function assertNotInMaintenance(ctx: SyncContext): void {
  if (ctx.vfsDatabase.isInMaintenanceMode()) {
    throw new CommandError('数据治理操作正在进行（维护模式），请稍后再试。');
  }
}

/** 补全云端凭据并创建传输实例。错误文案由调用方按 Rust 命令上下文包装。 */
export async function createCloudStorage(ctx: SyncContext, config: CloudStorageConfig): Promise<CloudStorage> {
  const runtimeConfig = config as RuntimeCloudStorageConfig;
  await ctx.backup.hydrateCloudConfig(runtimeConfig);
  return ctx.syncProvider.createStorage(runtimeConfig);
}

export { message as cloudErrorMessage };
