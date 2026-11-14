import { expect, it } from 'vitest';
import { CommandError } from '../../../kernel/api.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import type { CloudConfigPublishResponse, CloudConfigSsotResponse } from '../../../../contracts/ipc/generated/F4-security.ts';
import cloudConfig from '../cloud-config-commands.ts';
import type { CloudConfigService } from '../cloud-config-api.ts';

const safeConfig = { provider: 'webdav' as const, webdav: { endpoint: 'https://dav.example.com', username: 'user' } };

it('cloud config commands delegate to the SSOT service and preserve CommandError values', async () => {
  const calls: unknown[] = [];
  let failure: unknown = null;
  const ssot: CloudConfigSsotResponse = {
    configured: true,
    provider: 'webdav',
    config: safeConfig,
  };
  const published: CloudConfigPublishResponse = {
    ok: true,
    generation: 2,
    provider: 'webdav',
    config: safeConfig,
  };
  const service: CloudConfigService = {
    async save(config) {
      calls.push(['save', config]);
      return ssot;
    },
    async get() {
      calls.push(['get']);
      if (failure !== null) throw failure;
      return { configured: false };
    },
    async clear() {
      calls.push(['clear']);
      return { configured: false };
    },
    async publish(args) {
      calls.push(['publish', args]);
      return published;
    },
  };
  const host = await createTestHost({ plugins: [cloudConfig], provide: { cloudConfig: service } });
  try {
    expect(await host.invoke('cloud_config_ssot_save', { config: safeConfig })).toEqual(ssot);
    expect(await host.invoke('cloud_config_ssot_get')).toEqual({ configured: false });
    expect(await host.invoke('cloud_config_ssot_clear')).toEqual({ configured: false });
    const credentials = { webdavPassword: 'secret' };
    expect(await host.invoke('cloud_config_publish', {
      config: safeConfig,
      credentials,
      encryptionPasswordIsPreexisting: true,
    })).toEqual(published);
    expect(calls).toEqual([
      ['save', safeConfig],
      ['get'],
      ['clear'],
      ['publish', { config: safeConfig, credentials, encryptionPasswordIsPreexisting: true }],
    ]);

    failure = new CommandError({ code: 'E_CLOUD_CONFIG_STORAGE', message: 'storage failed' });
    await expect(host.invoke('cloud_config_ssot_get')).rejects.toEqual({ code: 'E_CLOUD_CONFIG_STORAGE', message: 'storage failed' });
  } finally {
    await host.dispose();
  }
});
