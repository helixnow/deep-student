/**
 * Plugin body shared by the platform entries of `dstu.sync-providers` (`index.ts` is the desktop
 * entry). An entry describes its platform with {@link SyncProvidersPlatform}: the storage capability
 * matrix (Rust `PlatformStorageCapabilities::current()`) and the transports it links.
 *
 * FTP is desktop-only (`DESKTOP_ONLY_PROVIDERS`): its transport needs `node:net` / `node:tls`, so
 * only the desktop entry imports `ftp.ts`. This module must not import it.
 */

import type { CryptoService } from '../../../platform/crypto/api.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import type { HttpService } from '../../../platform/http/api.ts';
import type { BackupCrypto } from '../../../platform/secrets/api.ts';
import {
  isOperationGuardError,
  type BackupOperationGuard,
  type DataGovernanceOperationKind,
} from '../../backup/api.ts';
import {
  syncProviderService,
  type CloudStorage,
  type Context,
  type FtpConfig,
  type PlatformStorageCapabilities,
  type RuntimeCloudStorageConfig,
  type StorageProvider,
  type SyncProviderService,
} from '../api.ts';
import {
  createCloudProgress,
  runDeleteVersionCommand,
  runDownloadCommand,
  runUploadCommand,
  type CloudProgress,
} from './cloud_commands.ts';
import {
  FTP_UNSUPPORTED_ON_ANDROID_CODE,
  FTP_UNSUPPORTED_ON_ANDROID_MESSAGE,
  configErrorToAppError,
  configRoot,
  platformCapabilityError,
  providerKey,
  s3EnabledForCapabilities,
  validateConfig,
} from './config.ts';
import { dataSpaceDeviceId } from './device_identity.ts';
import { CloudStorageError } from './errors.ts';
import { setFilesLookup } from './files.ts';
import { setCryptoLookup } from './hashing.ts';
import { setHttpLookup } from './http.ts';
import { setDefaultLogSink } from './logging.ts';
import { CloudSyncManager } from './sync_manager.ts';
import { clearCancelToken, clearStatusHook, isSyncCancelled, setCancelToken, setStatusHook } from './traits.ts';
import { WebDavStorage } from './webdav.ts';

/** `Path::join(name)` under the absolute, already-normalized app data dir (drive / UNC roots use `\\`). */
export function childPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, '')}${dir.startsWith('/') ? '/' : '\\'}${name}`;
}

export interface SyncProvidersPluginConfig {
  /** Rust env `DEEP_STUDENT_WEBDAV_RATE_LIMIT`: Nutstore requests per 30-minute window, `0` disables. */
  webdavRateLimit?: string;
}

/** Transports an entry links on top of the shared ones; a provider without one is not in this build. */
export interface StorageTransports {
  /** Desktop only (`DESKTOP_ONLY_PROVIDERS`). */
  ftp?: (config: FtpConfig, root: string) => CloudStorage;
}

export interface SyncProvidersPlatform {
  capabilities: Readonly<PlatformStorageCapabilities>;
  transports: StorageTransports;
}

/**
 * mod.rs:228-277 `create_storage_with_capabilities`. `capabilities` defaults to the entry's own
 * matrix; tests inject another one like the Rust R09 host tests.
 */
export async function createPlatformStorage(
  platform: SyncProvidersPlatform,
  config: RuntimeCloudStorageConfig,
  capabilities: Readonly<PlatformStorageCapabilities> = platform.capabilities,
  pluginConfig: SyncProvidersPluginConfig = {},
): Promise<CloudStorage> {
  try { validateConfig(config, capabilities); }
  catch (error) { throw configErrorToAppError(error); }
  const root = configRoot(config);
  const provider: StorageProvider = config.provider ?? 'webdav';
  switch (providerKey(provider)) {
    case 'webdav': {
      const webdav = config.webdav;
      if (!webdav) throw new CloudStorageError('Validation', '缺少 WebDAV 配置');
      return new WebDavStorage(webdav, root, { rateLimitEnv: pluginConfig.webdavRateLimit });
    }
    case 's3': {
      const s3 = config.s3;
      if (!s3) throw new CloudStorageError('Validation', '缺少 S3 配置');
      // `@aws-sdk/client-s3` dominates the plugin's load time; only S3 users pay for it.
      const { S3Storage } = await import('./s3.ts');
      return new S3Storage(s3, root);
    }
    case 'ftp': {
      // mod.rs:271-275: without the FTP backend the build answers with the platform code even
      // when injected capabilities claim FTP support.
      const link = platform.transports.ftp;
      if (!link) throw platformCapabilityError(FTP_UNSUPPORTED_ON_ANDROID_CODE, FTP_UNSUPPORTED_ON_ANDROID_MESSAGE);
      const ftp = config.ftp;
      if (!ftp) throw new CloudStorageError('Validation', '缺少 FTP 配置');
      return link(ftp, root);
    }
  }
}

export function providerServiceFor(createStorage: SyncProviderService['createStorage']): SyncProviderService {
  return {
    createStorage,
    setStatusHook,
    clearStatusHook,
    setCancelToken,
    clearCancelToken,
    isSyncCancelled,
  };
}

export async function applySyncProviders(
  ctx: Context,
  pluginConfig: SyncProvidersPluginConfig,
  platform: SyncProvidersPlatform,
): Promise<void> {
  setDefaultLogSink(ctx.logger('dstu_sync'));
  ctx.effect(() => {
    setCryptoLookup(() => ctx.get('crypto') as CryptoService | undefined);
    setHttpLookup(() => ctx.get('http') as HttpService | undefined);
    setFilesLookup(() => ctx.get('files') as FilesService | undefined);
    return () => { setCryptoLookup(null); setHttpLookup(null); setFilesLookup(null); };
  });
  const createStorage = (config: RuntimeCloudStorageConfig): Promise<CloudStorage> =>
    createPlatformStorage(platform, config, platform.capabilities, pluginConfig);
  ctx.provide(syncProviderService.name, providerServiceFor(createStorage));

  const backup: BackupCrypto = ctx.secrets.backup;

  const hydrate = async (config: RuntimeCloudStorageConfig): Promise<RuntimeCloudStorageConfig> => {
    const backupService = ctx.reflect.get('backup', false) as typeof ctx.backup | undefined;
    if (backupService) await backupService.hydrateCloudConfig(config);
    return config;
  };

  const acquireOperation = (kind: DataGovernanceOperationKind): BackupOperationGuard => {
    const backupService = ctx.reflect.get('backup', false) as typeof ctx.backup | undefined;
    if (backupService) return backupService.tryAcquireOperation(kind);
    const id = globalThis.crypto.randomUUID();
    return {
      snapshot: { operation_id: id, kind, started_at: new Date().toISOString(), process_id: 0 },
      operationId: () => id, release: () => {},
    };
  };

  /**
   * RAII equivalent: release on success, error and cancellation paths.
   *
   * An expected structured guard failure (`isOperationGuardError`, e.g. lock
   * IO) is logged, matching Rust `Drop` which cannot surface an error.
   * Contract/programming failures (missing `release`, TypeError) propagate
   * instead of being swallowed, so a broken provider can never turn a
   * successful command into a silent success.
   */
  const withOperation = async <T>(
    kind: DataGovernanceOperationKind,
    body: (operationId: string) => Promise<T>,
  ): Promise<T> => {
    const guard = acquireOperation(kind);
    const release = (failed: boolean): void => {
      try { guard.release(); }
      catch (error) {
        if (failed || isOperationGuardError(error)) {
          ctx.logger('dstu_sync::cloud_storage').warn(
            `[CloudSync] 释放数据治理操作租约失败: ${error instanceof Error ? error.message : String(error)}`,
          );
        } else {
          // Missing `release` or an unknown programming error: do not claim success.
          throw error;
        }
      }
    };
    let result: T;
    try {
      result = await body(guard.operationId());
    } catch (error) {
      release(true);
      throw error;
    }
    release(false);
    return result;
  };

  const managerFor = async (config: RuntimeCloudStorageConfig): Promise<CloudSyncManager> => {
    const storage = await createStorage(config);
    const deviceId = await dataSpaceDeviceId(ctx.paths);
    return new CloudSyncManager(storage, deviceId, {
      backup,
      encryptionMemoryPath: childPath(ctx.app.dataDir, '.cloud-encrypted-roots.json'),
    });
  };

  const progress: CloudProgress = createCloudProgress(
    event => ctx.backendEvents.emit('cloud-sync-progress', event),
    ctx.logger('dstu_sync::cloud_storage'),
  );

  // ---------------------------------------------------------------- storage commands

  ctx.commands.register<{ config: RuntimeCloudStorageConfig }>('cloud_storage_check_connection', async ({ config }) => {
    const storage = await createStorage(await hydrate(config));
    await storage.checkConnection();
    return true;
  });

  ctx.commands.register<{ config: RuntimeCloudStorageConfig; key: string; data: number[] }>('cloud_storage_put', async ({ config, key, data }) => {
    const storage = await createStorage(await hydrate(config));
    await storage.put(key, Uint8Array.from(data));
    return null;
  });

  ctx.commands.register<{ config: RuntimeCloudStorageConfig; key: string }>('cloud_storage_get', async ({ config, key }) => {
    const storage = await createStorage(await hydrate(config));
    const data = await storage.get(key);
    return data === null ? null : Array.from(data);
  });

  ctx.commands.register<{ config: RuntimeCloudStorageConfig; prefix: string }>('cloud_storage_list', async ({ config, prefix }) => {
    const storage = await createStorage(await hydrate(config));
    return storage.list(prefix);
  });

  ctx.commands.register<{ config: RuntimeCloudStorageConfig; key: string }>('cloud_storage_delete', async ({ config, key }) => {
    const storage = await createStorage(await hydrate(config));
    await storage.delete(key);
    return null;
  });

  ctx.commands.register<{ config: RuntimeCloudStorageConfig; key: string }>('cloud_storage_stat', async ({ config, key }) => {
    const storage = await createStorage(await hydrate(config));
    return storage.stat(key);
  });

  ctx.commands.register<{ config: RuntimeCloudStorageConfig; key: string }>('cloud_storage_exists', async ({ config, key }) => {
    const storage = await createStorage(await hydrate(config));
    return storage.exists(key);
  });

  // ---------------------------------------------------------------- sync manager commands

  ctx.commands.register<{ config: RuntimeCloudStorageConfig }>('cloud_sync_get_status', async ({ config }) => {
    const manager = await managerFor(await hydrate(config));
    return manager.getStatus();
  });

  ctx.commands.register<{ config: RuntimeCloudStorageConfig }>('cloud_sync_list_versions', async ({ config }) => {
    const manager = await managerFor(await hydrate(config));
    return manager.listVersions();
  });

  ctx.commands.register<{
    config: RuntimeCloudStorageConfig;
    zipPath: string;
    appVersion?: string | null;
    note?: string | null;
    recoveryKind?: string | null;
  }>('cloud_sync_upload', async ({ config, zipPath, appVersion, note, recoveryKind }) => {
    // Rust order: hydrate → acquire → create_storage/manager → encryption policy.
    const hydrated = await hydrate(config);
    return withOperation('backup', async operationId => {
      const manager = await managerFor(hydrated);
      return runUploadCommand({
        manager,
        backup,
        sourcePath: zipPath,
        appVersion,
        note,
        recoveryKind,
        encryptionPassword: hydrated.encryptionPassword,
        operationId,
        progress,
        log: ctx.logger('dstu_sync::cloud_storage'),
      });
    });
  });

  ctx.commands.register<{
    config: RuntimeCloudStorageConfig;
    versionId?: string | null;
    localDir: string;
    allowPlaintextHistory?: boolean | null;
  }>('cloud_sync_download', async ({ config, versionId, localDir, allowPlaintextHistory }) => {
    const hydrated = await hydrate(config);
    return withOperation('restore', async operationId => {
      const manager = await managerFor(hydrated);
      return runDownloadCommand({
        manager,
        backup,
        versionId,
        localDir,
        allowPlaintextHistory,
        encryptionPassword: hydrated.encryptionPassword,
        operationId,
        progress,
        log: ctx.logger('dstu_sync::cloud_storage'),
      });
    });
  });

  ctx.commands.register<{ config: RuntimeCloudStorageConfig; versionId: string }>('cloud_sync_delete_version', async ({ config, versionId }) => {
    const hydrated = await hydrate(config);
    return withOperation('prune', async () => {
      const manager = await managerFor(hydrated);
      return runDeleteVersionCommand(manager, versionId, ctx.logger('dstu_sync::cloud_storage'));
    });
  });

  // ---------------------------------------------------------------- sync (non-command) helpers

  ctx.commands.register('cloud_sync_get_device_id', () => dataSpaceDeviceId(ctx.paths));

  ctx.commands.register('cloud_storage_is_s3_enabled', () => s3EnabledForCapabilities(platform.capabilities));
}
