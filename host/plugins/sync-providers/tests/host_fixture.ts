/**
 * Host integration fixture for L23 command tests.
 *
 * Installs the real plugin with the real F4 `paths` implementation and F4
 * `BackupCrypto`. L21 `backup`'s guard contract is imported from its published
 * `api.ts`; tests provide the external guard implementation and never replace
 * L23 code under test.
 */

import type { HostPlugin } from '../../../kernel/api.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createPaths, type PathsService, type Platform as PathsPlatform } from '../../../platform/paths/index.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import type { BackupCrypto, SecretsService } from '../../../platform/secrets/api.ts';
import type {
  BackupOperationGuard, BackupService, DataGovernanceOperationKind,
} from '../../backup/api.ts';
import type { RuntimeCloudStorageConfig } from '../api.ts';
import desktopPlugin, { type SyncProvidersPluginConfig } from '../index.ts';

export type OperationGuardLike = BackupOperationGuard;

export interface SyncHostOptions {
  env?: Record<string, string | undefined>;
  backup?: BackupCrypto;
  /** L21 operation guard (only when the test wants write commands to run). */
  guard?: (kind: DataGovernanceOperationKind) => OperationGuardLike;
  hydrate?: (config: RuntimeCloudStorageConfig) => void | Promise<void>;
  pathsLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** OS whose default directories F4 `paths` derives (default: the host OS). */
  pathsPlatform?: PathsPlatform;
  /** Plugin entry to install (default: the desktop entry `index.ts`). */
  plugin?: HostPlugin<SyncProvidersPluginConfig>;
  /**
   * Test double for F4 `paths.dataSpaceDeviceId()` used by command tests that
   * need a manager. It is never used to assert identity semantics; those run
   * only when the real owner method is present.
   */
  dataSpaceDeviceId?: () => Promise<string>;
}

export interface SyncHost {
  host: TestHost;
  paths: PathsService;
  backup: BackupCrypto;
  hydrateCalls: RuntimeCloudStorageConfig[];
  dispose(): Promise<void>;
}

export async function createSyncHost(options: SyncHostOptions = {}): Promise<SyncHost> {
  const host = await createTestHost();
  const pathsEnv = { HOME: host.app.dataDir, ...options.env };
  const pathsLog = options.pathsLog ?? (() => undefined);
  const paths = createPaths({
    dataDir: host.app.dataDir,
    platform: options.pathsPlatform ?? host.app.platform,
    env: pathsEnv,
    log: pathsLog,
  });
  if (options.dataSpaceDeviceId !== undefined) {
    Object.assign(paths, { dataSpaceDeviceId: options.dataSpaceDeviceId });
  }
  host.ctx.provide('paths', paths);

  const backup = options.backup ?? createBackupCrypto();
  host.ctx.provide('secrets', { backup } as unknown as SecretsService);

  const hydrateCalls: RuntimeCloudStorageConfig[] = [];
  const backupService: Record<string, unknown> = {
    async hydrateCloudConfig(config: RuntimeCloudStorageConfig): Promise<void> {
      hydrateCalls.push(config);
      await options.hydrate?.(config);
    },
  };
  if (options.guard !== undefined) {
    backupService.tryAcquireOperation = (kind: DataGovernanceOperationKind) => options.guard!(kind);
  }
  host.ctx.provide('backup', backupService as unknown as BackupService);

  await host.install(options.plugin ?? desktopPlugin);
  return {
    host,
    paths,
    backup,
    hydrateCalls,
    async dispose() {
      await host.unload('dstu.sync-providers').catch(() => undefined);
      await host.dispose();
    },
  };
}
