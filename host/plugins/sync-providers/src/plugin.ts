/**
 * L23-sync-providers 插件本体（可移植）：入口按平台在 `index.ts` / `mobile.ts` 之间选择。
 *
 * 平台差异只有两处，都由 {@link SyncProvidersPluginOptions} 注入：
 * - `platform`：能力矩阵与链接的传输（FTP 需要 `node:net` / `node:tls`，只有桌面入口链接
 *   `src/desktop-platform.ts`，见 `DESKTOP_ONLY_PROVIDERS`）；
 * - `localFs`：按路径的对象落地/续传/增量归档走 `src/local-fs.ts` 端口，桌面入口注入
 *   `node:fs/promises` 实现，移动端不注入（缺省端口无本地文件系统）。
 */
import { definePlugin } from '../../../kernel/api.ts';
import type { HostPlugin, PluginPlatform } from '../../../kernel/core.ts';
import type { CloudStorage, PlatformStorageCapabilities, RuntimeCloudStorageConfig } from '../api.ts';
import {
  applySyncProviders,
  createPlatformStorage,
  providerServiceFor,
  type SyncProvidersPlatform,
  type SyncProvidersPluginConfig,
} from './entry.ts';
import { setAesGcm, type AesGcm } from './aes-gcm.ts';
import { setLocalFs, type LocalFs } from './local-fs.ts';

export const COMMANDS = [
  'cloud_storage_check_connection',
  'cloud_storage_delete',
  'cloud_storage_exists',
  'cloud_storage_get',
  'cloud_storage_is_s3_enabled',
  'cloud_storage_list',
  'cloud_storage_put',
  'cloud_storage_stat',
  'cloud_sync_delete_version',
  'cloud_sync_download',
  'cloud_sync_get_device_id',
  'cloud_sync_get_status',
  'cloud_sync_list_versions',
  'cloud_sync_upload',
] as const;

export interface SyncProvidersPluginOptions {
  platforms?: readonly PluginPlatform[];
  /** 能力矩阵与链接的传输；FTP 只在桌面入口链接。 */
  platform: SyncProvidersPlatform;
  /** `() => port` 在 apply 时求值并安装；缺省用无本地文件系统的端口。 */
  localFs?: () => LocalFs;
  /** Sync V5 的 AES-GCM 实现；缺省用纯 JS（`src/aes-gcm.ts`），桌面入口注入 OpenSSL。 */
  aesGcm?: () => AesGcm;
}

/** 某个平台入口的存储工厂与 provider 服务（`index.ts` 再导出桌面实例）。 */
export function createStorageFactory(platform: SyncProvidersPlatform): {
  createStorage: (
    config: RuntimeCloudStorageConfig,
    capabilities?: PlatformStorageCapabilities,
    pluginConfig?: SyncProvidersPluginConfig,
  ) => Promise<CloudStorage>;
  providerService: ReturnType<typeof providerServiceFor>;
} {
  const createStorage = (
    config: RuntimeCloudStorageConfig,
    capabilities: PlatformStorageCapabilities = platform.capabilities,
    pluginConfig: SyncProvidersPluginConfig = {},
  ): Promise<CloudStorage> => createPlatformStorage(platform, config, capabilities, pluginConfig);
  return { createStorage, providerService: providerServiceFor(createStorage) };
}

export function createSyncProvidersPlugin(options: SyncProvidersPluginOptions): HostPlugin<SyncProvidersPluginConfig> {
  return definePlugin<SyncProvidersPluginConfig>({
    meta: {
      id: 'dstu.sync-providers',
      lane: 'L23-sync-providers',
      provides: ['syncProvider'],
      ...(options.platforms === undefined ? {} : { platforms: options.platforms }),
      commands: COMMANDS,
    },
    inject: options.platforms?.includes('mobile') ? ['secrets', 'paths'] : ['secrets', 'backup', 'paths'],
    apply(ctx, pluginConfig = {}) {
      setLocalFs(options.localFs?.() ?? null);
      ctx.effect(() => () => setLocalFs(null));
      setAesGcm(options.aesGcm?.() ?? null);
      ctx.effect(() => () => setAesGcm(null));
      return applySyncProviders(ctx, pluginConfig, options.platform);
    },
  });
}
