import { CommandError, definePlugin } from '../../kernel/api.ts';
import { mobileOperations } from '../../platform/storage-mobile/operation-guard.ts';
import { registerCloudConfigCommands } from '../../platform/errors/cloud-config-commands.ts';
import { cloudCredentialCommands, registerCloudCredentialCommands } from '../../platform/secrets/cloud-commands.ts';
import { ANDROID_CAPABILITIES } from '../sync-providers/src/config.ts';
import type { SyncGovernance } from './api.ts';
import { createCloudConfigService, hydrateCloudConfig, testConnectionDraft, type CloudConfigDraftArgs } from './src/cloud-config.ts';
import { createSyncCommandPorts } from './src/sync-ports.ts';

export default definePlugin({
  meta: {
    id: 'dstu.mobile.cloud-config', platforms: ['mobile'], provides: ['cloudConfig', 'mobileSyncGovernance'],
    commands: ['cloud_config_ssot_get', 'cloud_config_ssot_clear', 'cloud_config_ssot_save', 'cloud_config_publish', 'cloud_config_test_connection_draft', ...cloudCredentialCommands],
  },
  inject: ['settings', 'secrets', 'storage', 'syncProvider'],
  apply(ctx) {
    const deps = { settings: ctx.settings, secrets: ctx.secrets, dataDir: ctx.app.dataDir, capabilities: ANDROID_CAPABILITIES, warn: (message: string) => ctx.logger('backup').warn(message) };
    const ports = createSyncCommandPorts(ctx, mobileOperations);
    const governance: SyncGovernance = {
      hydrateCloudConfig: config => hydrateCloudConfig(config, deps),
      tryAcquireOperation: kind => mobileOperations.tryAcquire(kind),
      async acquireOperation(kind, timeoutMs) {
        const permit = await mobileOperations.acquireWithTimeout(kind, timeoutMs);
        if (permit === 'timeout') throw new CommandError('等待备份、恢复或同步任务超时');
        return permit;
      },
      syncCommandPorts: () => ports,
    };
    ctx.reflect.provide('mobileSyncGovernance', governance);
    ctx.provide('cloudConfig', createCloudConfigService(deps));
    registerCloudConfigCommands(ctx);
    registerCloudCredentialCommands(ctx);
    ctx.commands.register<CloudConfigDraftArgs>('cloud_config_test_connection_draft', args => testConnectionDraft(ctx, args, { ...deps, provider: ctx.syncProvider }));
  },
});
