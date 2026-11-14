// @vitest-environment node
/**
 * 前端云配置 DTO 直接交给真实 Host 命令（不 mock invoke）：kernel 参数校验 + backup 插件的
 * `parseSafeCloudStorageConfig`（deny_unknown_fields）都会看到前端实际发出的字段名。
 * 地址用 192.168.x / TEST-NET，ssot_save 与 publish 不联网，草稿试连走替身 provider。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { TestHost } from '../../../host/kernel/testing';
import type { CloudStorage, SyncProviderService } from '../../../host/plugins/sync-providers/api';
import cloudConfigCommands from '../../../host/platform/errors/cloud-config-commands';
import { createBackupHost } from '../../../host/plugins/backup/tests/helpers';
import {
  fromSafeCloudStorageConfig,
  toSafeCloudStorageConfig,
  type CloudConfigSsotResponse,
  type CloudStorageConfig,
  type SafeCloudStorageConfig,
} from '@/utils/cloudStorageApi';

const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});

async function startHost(syncProvider?: SyncProviderService): Promise<TestHost> {
  const { host } = await createBackupHost({ secrets: true, ...(syncProvider ? { syncProvider } : {}) });
  hosts.push(host);
  await host.install(cloudConfigCommands);
  return host;
}

const LAN_WEBDAV: CloudStorageConfig = {
  provider: 'webdav',
  webdav: { endpoint: 'http://192.168.1.10/dav', username: 'u', password: '' },
  root: 'ds',
  allowInsecure: true,
};

const PLAIN_FTP: CloudStorageConfig = {
  provider: 'ftp',
  ftp: { host: '203.0.113.5', port: 21, username: 'u', password: '', useTls: false },
  allowInsecure: true,
};

describe('RF-W09-cloud-config-allow-insecure-wire-key: frontend DTO against the real Host commands', () => {
  it('RF-W09-cloud-config-allow-insecure-wire-key: cloud_config_ssot_save accepts LAN HTTP WebDAV and plain FTP and reads the opt-in back', async () => {
    const host = await startHost();
    for (const ui of [LAN_WEBDAV, PLAIN_FTP]) {
      const saved = await host.invoke('cloud_config_ssot_save', {
        config: toSafeCloudStorageConfig(ui),
      }) as CloudConfigSsotResponse;
      expect(saved.configured).toBe(true);
      expect(fromSafeCloudStorageConfig(saved.config!).allowInsecure).toBe(true);

      const got = await host.invoke('cloud_config_ssot_get') as CloudConfigSsotResponse;
      expect(fromSafeCloudStorageConfig(got.config!).allowInsecure).toBe(true);
    }
  });

  it('RF-W09-cloud-config-allow-insecure-wire-key: cloud_config_publish (the Settings save path) accepts the opt-in', async () => {
    const host = await startHost();
    const published = await host.invoke('cloud_config_publish', {
      config: toSafeCloudStorageConfig(LAN_WEBDAV),
      credentials: { webdavPassword: 'nas-secret' },
      encryptionPasswordIsPreexisting: false,
    }) as { ok: boolean; config: SafeCloudStorageConfig };
    expect(published.ok).toBe(true);
    expect(fromSafeCloudStorageConfig(published.config).allowInsecure).toBe(true);
  });

  it('RF-W09-cloud-config-allow-insecure-wire-key: cloud_config_test_connection_draft accepts the opt-in', async () => {
    const created: unknown[] = [];
    const provider = {
      async createStorage(config: unknown): Promise<CloudStorage> {
        created.push(config);
        return { async checkConnection() {} } as unknown as CloudStorage;
      },
      setStatusHook() {},
      clearStatusHook() {},
      setCancelToken() {},
      clearCancelToken() {},
      isSyncCancelled() { return false; },
    } as unknown as SyncProviderService;
    const host = await startHost(provider);

    const result = await host.invoke('cloud_config_test_connection_draft', {
      config: toSafeCloudStorageConfig(PLAIN_FTP),
      credentials: { ftpPassword: 'ftp-secret' },
      encryptionPasswordIsPreexisting: false,
    }) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(created).toHaveLength(1);
  });

  it('RF-W09-cloud-config-allow-insecure-wire-key: without the opt-in the backend still refuses public cleartext', async () => {
    const host = await startHost();
    await expect(host.invoke('cloud_config_ssot_save', {
      config: toSafeCloudStorageConfig({ ...LAN_WEBDAV, allowInsecure: false }),
    })).rejects.toMatchObject({ code: 'E_CLOUD_CONFIG_INVALID' });
  });
});
