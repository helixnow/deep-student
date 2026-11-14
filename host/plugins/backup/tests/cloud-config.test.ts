import { afterEach, describe, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import {
  insecureTransportAuthorized, validateConfig,
  type CloudStorage, type RuntimeCloudStorageConfig, type SyncProviderService,
} from '../../sync-providers/api.ts';
import {
  CLOUD_CONFIG_SSOT_SETTING_KEY, CLOUD_CONNECTION_CHECK_FAILED_CODE,
  CLOUD_CREDENTIALS_UNAVAILABLE_CODE, CloudConfigSsotError,
  applyCloudCredentials, hydrateCloudConfig, intoRuntimeConfig, loadCloudConfigSsot,
  parseSafeCloudStorageConfig, replaceWithPersistedCloudConfig, saveCloudConfigSsot,
  serializeSafeCloudStorageConfig, u64ToJsonNumber, validateAndNormalize,
  type SafeCloudStorageConfig,
} from '../src/cloud-config.ts';
import cloudConfigCommands from '../../../platform/errors/cloud-config-commands.ts';
import { createBackupHost } from './helpers.ts';

const hosts: Array<{ host: TestHost }> = [];
afterEach(async () => { for (const entry of hosts.splice(0)) await entry.host.dispose(); });

const DESKTOP = { ftpSupported: true, s3Supported: true };
const ANDROID = { ftpSupported: false, s3Supported: true };

function webdav(endpoint: string, allowInsecure: boolean): SafeCloudStorageConfig {
  return {
    provider: 'webdav',
    webdav: { endpoint, username: 'student' },
    root: null,
    allow_insecure: allowInsecure,
  };
}

function ftp(host: string, useTls: boolean, allowInsecure: boolean): SafeCloudStorageConfig {
  return {
    provider: 'ftp',
    ftp: { host, port: 21, username: 'student', useTls },
    root: null,
    allow_insecure: allowInsecure,
  };
}

function settings(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get(key: string): string | null { return values.get(key) ?? null; },
    save(key: string, value: string): void { values.set(key, value); },
  };
}

function fakeProvider(check: () => Promise<void> = async () => undefined) {
  const calls: Array<{ config: unknown }> = [];
  const service = {
    async createStorage(config: unknown): Promise<CloudStorage> {
      calls.push({ config });
      return { async checkConnection() { await check(); } } as unknown as CloudStorage;
    },
    setStatusHook() {},
    clearStatusHook() {},
    setCancelToken() {},
    clearCancelToken() {},
    isSyncCancelled() { return false; },
  };
  return { service: service as SyncProviderService, calls };
}

describe('cloud_config_commands.rs', () => {
  it('dto_rejects_secret_fields', () => {
    const encoded = {
      provider: 'webdav',
      webdav: { endpoint: 'https://dav.example.test', username: 'u', password: 'secret' },
    };
    expect(() => parseSafeCloudStorageConfig(encoded)).toThrow(/unknown field `password`/);
  });

  it('public_http_requires_persisted_opt_in', () => {
    const store = settings();
    const endpoint = 'http://dav.security-contract.test';
    const denied = (() => {
      try { saveCloudConfigSsot(store, webdav(endpoint, false)); return null; }
      catch (error) { return error; }
    })();
    expect(denied).toBeInstanceOf(CloudConfigSsotError);
    expect((denied as CloudConfigSsotError).code).toBe('E_CLOUD_CONFIG_INVALID');

    const stored = saveCloudConfigSsot(store, webdav(endpoint, true));
    expect(loadCloudConfigSsot(store)).toEqual(stored);
    const runtime = intoRuntimeConfig(stored);
    expect(runtime[insecureTransportAuthorized]).toBe(true);
    runtime.webdav!.password = 'secret';
    expect(() => validateConfig(runtime)).not.toThrow();

    const unpersisted = intoRuntimeConfig(webdav(endpoint, false));
    unpersisted.webdav!.password = 'secret';
    expect(() => validateConfig(unpersisted)).toThrow();
  });

  it('loopback_http_does_not_persist_risk_override', () => {
    const store = settings();
    const stored = saveCloudConfigSsot(store, webdav('http://127.42.0.1:8080/dav', true));
    expect(stored.provider).toBe('webdav');
    expect(stored.allow_insecure).toBe(false);
  });

  it('public_plaintext_ftp_requires_persisted_opt_in', () => {
    const store = settings();
    const stored = saveCloudConfigSsot(store, ftp('ftp.security-contract.test', false, true));
    const runtime = intoRuntimeConfig(stored);
    expect(runtime[insecureTransportAuthorized]).toBe(true);
    runtime.ftp!.password = 'secret';
    expect(() => validateConfig(runtime)).not.toThrow();
  });

  it('ftp_platform_error_has_stable_code_and_shared_diagnostic', () => {
    const error = (() => {
      try { validateAndNormalize(ftp('ftp.example.test', true, false), ANDROID); return null; }
      catch (caught) { return caught as CloudConfigSsotError; }
    })();
    expect(error).toBeInstanceOf(CloudConfigSsotError);
    // Rust 1138 `matches!(Invalid(_))`：TS 以 Invalid 变体的 Display 前缀区分。
    expect(error!.message).toMatch(/^invalid non-secret cloud configuration: /);
    expect(error!.code).toBe('E_FTP_UNSUPPORTED_ON_ANDROID');
    expect(error!.message).toContain('FTP/FTPS storage is not available on Android.');
    const envelope = error!.toCommandError();
    expect(envelope.value).toMatchObject({ code: 'E_FTP_UNSUPPORTED_ON_ANDROID' });
    expect((envelope.value as { message: string }).message).toContain('FTP/FTPS storage is not available on Android.');
  });

  it('s3_platform_error_has_stable_code_independent_of_message', () => {
    const config: SafeCloudStorageConfig = {
      provider: 's3',
      s3: {
        endpoint: 'https://s3.example.test', bucket: 'b', accessKeyId: 'a', region: null, pathStyle: false,
      },
      root: null,
      allow_insecure: false,
    };
    const error = (() => {
      try { validateAndNormalize(config, { ftpSupported: true, s3Supported: false }); return null; }
      catch (caught) { return caught as CloudConfigSsotError; }
    })();
    expect(error!.code).toBe('E_S3_UNSUPPORTED_IN_BUILD');
    expect(error!.message).toContain('当前安装包不支持 S3 兼容存储，请改用 WebDAV。');
    // Rust cloud_config_commands.rs:1161-1165：稳定码/诊断也必须保留到 IPC envelope。
    const envelope = error!.toCommandError();
    expect(envelope.value).toMatchObject({
      code: 'E_S3_UNSUPPORTED_IN_BUILD',
      message: expect.stringContaining('当前安装包不支持 S3 兼容存储，请改用 WebDAV。'),
    });
  });

  it('android_rejects_ftp_on_save_and_persists_nothing', () => {
    const store = settings();
    expect(() => saveCloudConfigSsot(store, ftp('ftp.example.test', true, false), ANDROID))
      .toThrow(/FTP\/FTPS storage is not available on Android\./);
    expect(store.get(CLOUD_CONFIG_SSOT_SETTING_KEY)).toBeNull();
  });

  it('android_rejects_stored_ftp_record_on_load', () => {
    const store = settings({
      [CLOUD_CONFIG_SSOT_SETTING_KEY]: JSON.stringify({
        provider: 'ftp',
        ftp: { host: 'ftp.example.test', port: 21, username: 'student', useTls: true },
      }),
    });
    expect(() => loadCloudConfigSsot(store, ANDROID)).toThrow(/FTP\/FTPS storage is not available on Android\./);
  });
});

describe('cloud_credentials.rs', () => {
  it('backend_hydration_fills_only_secret_fields', () => {
    const config: RuntimeCloudStorageConfig = {
      provider: 'webdav' as const,
      webdav: { endpoint: 'https://dav.example.test', username: 'student', password: '' },
      s3: {
        endpoint: 'https://s3.example.test', bucket: 'coursework', accessKeyId: 'public-id',
        secretAccessKey: '', region: null, pathStyle: false,
      },
      ftp: {
        host: 'ftp.example.test', port: 21, username: 'student', password: '', useTls: true,
      },
      root: 'coursework',
      encryptionPassword: null,
    };
    applyCloudCredentials(config, {
      webdavPassword: 'webdav-secret',
      s3SecretAccessKey: 's3-secret',
      ftpPassword: 'ftp-secret',
      encryptionPassword: 'encryption-secret',
    });
    expect(config.webdav!.password).toBe('webdav-secret');
    expect(config.s3!.secretAccessKey).toBe('s3-secret');
    expect(config.ftp!.password).toBe('ftp-secret');
    expect(config.encryptionPassword).toBe('encryption-secret');
    expect(config.root).toBe('coursework');
  });

  it('hydration_rejects_ipc_secret_in_favor_of_secure_store', () => {
    const config: RuntimeCloudStorageConfig = {
      provider: 'webdav' as const,
      webdav: { endpoint: 'https://dav.example.test', username: 'student', password: 'new-secret' },
      s3: null,
      ftp: null,
      root: null,
      encryptionPassword: null,
    };
    applyCloudCredentials(config, { webdavPassword: 'stored-secret' });
    expect(config.webdav!.password).toBe('stored-secret');
  });

  it('hydration_clears_ipc_secrets_when_secure_store_is_empty', () => {
    const config: RuntimeCloudStorageConfig = {
      provider: 'webdav' as const,
      webdav: { endpoint: 'https://dav.example.test', username: 'student', password: 'ipc-secret' },
      s3: null,
      ftp: null,
      root: null,
      encryptionPassword: 'ipc-encryption-secret',
    };
    applyCloudCredentials(config, null);
    expect(config.webdav!.password).toBe('');
    expect(config.encryptionPassword).toBeNull();
  });

  it('persisted_nonsecret_config_replaces_the_complete_ipc_shape', () => {
    const config: RuntimeCloudStorageConfig = {
      provider: 'webdav' as const,
      webdav: { endpoint: 'http://attacker.example.test', username: 'attacker', password: 'ipc-secret' },
      s3: null,
      ftp: null,
      root: 'attacker-root',
      encryptionPassword: null,
    };
    replaceWithPersistedCloudConfig(config, {
      provider: 'webdav',
      webdav: { endpoint: 'https://persisted.example.test', username: 'persisted-user' },
      root: 'persisted-root',
      allow_insecure: false,
    });
    expect(config.webdav!.endpoint).toBe('https://persisted.example.test');
    expect(config.webdav!.username).toBe('persisted-user');
    expect(config.webdav!.password).toBe('');
    expect(config.root).toBe('persisted-root');
    expect(config[insecureTransportAuthorized]).toBe(false);
  });

  it('missing_backend_ssot_discards_the_complete_ipc_shape', () => {
    const config: RuntimeCloudStorageConfig = {
      provider: 'ftp' as const,
      webdav: null,
      s3: null,
      ftp: { host: 'ftp.example.test', port: 21, username: 'attacker', password: 'ipc-secret', useTls: false },
      root: null,
      encryptionPassword: null,
    };
    replaceWithPersistedCloudConfig(config, null);
    expect(config.webdav).toBeNull();
    expect(config.s3).toBeNull();
    expect(config.ftp).toBeNull();
    expect(config[insecureTransportAuthorized]).toBe(false);
  });

  it('hydrateCloudConfig loads the SSOT shape and secure-store secrets', async () => {
    const store = settings({
      [CLOUD_CONFIG_SSOT_SETTING_KEY]: serializeSafeCloudStorageConfig(webdav('https://persisted.example.test', false)),
    });
    const config: RuntimeCloudStorageConfig = {
      provider: 'ftp' as const,
      webdav: null,
      s3: null,
      ftp: { host: 'attacker.example.test', port: 21, username: 'attacker', password: 'ipc', useTls: false },
      root: null,
      encryptionPassword: 'ipc-encryption',
    };
    const warnings: string[] = [];
    const fakeSecrets = {
      openStore() {
        return { async getCloudCredentials() { return { webdavPassword: 'stored-secret' }; } };
      },
    };
    await hydrateCloudConfig(config, {
      settings: store,
      secrets: fakeSecrets as never,
      dataDir: '/unused',
      warn: message => warnings.push(message),
    });
    expect(config.provider).toBe('webdav');
    expect(config.webdav?.endpoint).toBe('https://persisted.example.test');
    expect(config.webdav?.password).toBe('stored-secret');
    expect(config.ftp).toBeNull();
    expect(config.encryptionPassword).toBeNull();
    expect(warnings).toEqual([]);
  });
});

describe('cloud_config_test_connection_draft', () => {
  it('tests the draft credentials without persisting them and returns the active generation', async () => {
    const provider = fakeProvider();
    const { host, settings: stored } = await createBackupHost({
      secrets: true, syncProvider: provider.service, generation: 7n,
    });
    hosts.push({ host });
    const response = await host.invoke('cloud_config_test_connection_draft', {
      config: {
        provider: 'webdav',
        webdav: { endpoint: 'https://dav.example.test', username: 'student' },
      },
      credentials: { webdavPassword: 'draft-secret' },
    }) as { ok: boolean; generation: number };
    expect(response).toEqual({ ok: true, generation: 7 });
    expect(provider.calls).toHaveLength(1);
    const runtime = provider.calls[0]!.config as { webdav: { password: string } };
    expect(runtime.webdav.password).toBe('draft-secret');
    expect(stored.size).toBe(0);
  });

  it('rejects a short new encryption password but allows a preexisting one', async () => {
    const provider = fakeProvider();
    const { host } = await createBackupHost({ secrets: true, syncProvider: provider.service });
    hosts.push({ host });
    const args = {
      config: {
        provider: 'webdav',
        webdav: { endpoint: 'https://dav.example.test', username: 'student' },
      },
      credentials: { webdavPassword: 'draft-secret', encryptionPassword: 'short' },
    };
    await expect(host.invoke('cloud_config_test_connection_draft', args))
      .rejects.toMatchObject({ code: 'E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT' });
    const accepted = await host.invoke('cloud_config_test_connection_draft', {
      ...args, encryptionPasswordIsPreexisting: true,
    }) as { ok: boolean };
    expect(accepted.ok).toBe(true);
  });

  it('rejects missing draft credentials with the credentials-unavailable code', async () => {
    const provider = fakeProvider();
    const { host } = await createBackupHost({ secrets: true, syncProvider: provider.service });
    hosts.push({ host });
    await expect(host.invoke('cloud_config_test_connection_draft', {
      config: {
        provider: 'webdav',
        webdav: { endpoint: 'https://dav.example.test', username: 'student' },
      },
      credentials: {},
    })).rejects.toMatchObject({ code: CLOUD_CREDENTIALS_UNAVAILABLE_CODE });
    expect(provider.calls).toHaveLength(0);
  });

  it('rejects a public HTTP draft without persisted allowInsecure', async () => {
    const provider = fakeProvider();
    const { host } = await createBackupHost({ secrets: true, syncProvider: provider.service });
    hosts.push({ host });
    await expect(host.invoke('cloud_config_test_connection_draft', {
      config: {
        provider: 'webdav',
        webdav: { endpoint: 'http://public.example.test/dav', username: 'student' },
      },
      credentials: { webdavPassword: 'draft-secret' },
    })).rejects.toMatchObject({ code: 'E_CLOUD_CONFIG_INVALID' });
    expect(provider.calls).toHaveLength(0);
  });

  it('maps check-connection failures to the stable connection code', async () => {
    const provider = fakeProvider(async () => { throw new Error('dns failed'); });
    const { host } = await createBackupHost({ secrets: true, syncProvider: provider.service });
    hosts.push({ host });
    await expect(host.invoke('cloud_config_test_connection_draft', {
      config: {
        provider: 'webdav',
        webdav: { endpoint: 'https://dav.example.test', username: 'student' },
      },
      credentials: { webdavPassword: 'draft-secret' },
    })).rejects.toMatchObject({ code: CLOUD_CONNECTION_CHECK_FAILED_CODE, message: 'dns failed' });
  });
});


describe('cloudConfig 服务接线（F4 cloud_config_ssot_* / cloud_config_publish）', () => {
  it('registers the F4 commands, persists the SSOT and publishes staged credentials', async () => {
    const { host, settings: stored } = await createBackupHost({
      secrets: true, credentials: { webdavPassword: 'active-secret' }, generation: 3n,
    });
    hosts.push({ host });
    await host.install(cloudConfigCommands);

    const config = {
      provider: 'webdav',
      webdav: { endpoint: 'https://dav.example.test', username: 'student' },
      root: 'deep-student-sync',
    };
    const saved = await host.invoke('cloud_config_ssot_save', { config }) as Record<string, unknown>;
    expect(saved).toMatchObject({ configured: true, provider: 'webdav', root: 'deep-student-sync' });
    expect(stored.has(CLOUD_CONFIG_SSOT_SETTING_KEY)).toBe(true);

    const got = await host.invoke('cloud_config_ssot_get') as Record<string, unknown>;
    expect(got).toMatchObject({ configured: true, provider: 'webdav', root: 'deep-student-sync' });

    const published = await host.invoke('cloud_config_publish', {
      config,
      credentials: { webdavPassword: 'new-secret' },
    }) as Record<string, unknown>;
    expect(published).toMatchObject({ ok: true, generation: 4, provider: 'webdav', root: 'deep-student-sync' });

    const cleared = await host.invoke('cloud_config_ssot_clear') as Record<string, unknown>;
    expect(cleared).toStrictEqual({ configured: false });
    expect(stored.has(CLOUD_CONFIG_SSOT_SETTING_KEY)).toBe(false);
  });

  it('V02-02 ssot get/save/clear and publish omit None fields like Rust CloudConfigSsotResponse / CloudConfigPublishResponse', async () => {
    const { host } = await createBackupHost({ secrets: true });
    hosts.push({ host });
    await host.install(cloudConfigCommands);
    // cloud_config_commands.rs:115-125、744-752：Option 字段 skip_serializing_if；内层配置按 serde（:88-113）省略 None 与 false。
    expect(await host.invoke('cloud_config_ssot_get')).toStrictEqual({ configured: false });

    const bare = { provider: 'webdav', webdav: { endpoint: 'https://dav.example.test', username: 'student' } };
    const bareView = { provider: 'webdav', webdav: { endpoint: 'https://dav.example.test', username: 'student' } };
    expect(await host.invoke('cloud_config_ssot_save', { config: bare }))
      .toStrictEqual({ configured: true, provider: 'webdav', config: bareView });
    expect(await host.invoke('cloud_config_ssot_get'))
      .toStrictEqual({ configured: true, provider: 'webdav', config: bareView });
    expect(await host.invoke('cloud_config_publish', { config: bare, credentials: { webdavPassword: 'secret' } }))
      .toStrictEqual({ ok: true, generation: expect.any(Number), provider: 'webdav', config: bareView });

    const full = { provider: 'webdav', webdav: { endpoint: 'http://dav.example.test', username: 'student' },
      root: 'deep-student-sync', allow_insecure: true };
    expect(await host.invoke('cloud_config_ssot_save', { config: full }))
      .toStrictEqual({ configured: true, provider: 'webdav', root: 'deep-student-sync', config: full });

    expect(await host.invoke('cloud_config_ssot_clear')).toStrictEqual({ configured: false });
  });

  it('publish rejects an empty provider secret after config validation', async () => {
    const { host } = await createBackupHost({ secrets: true });
    hosts.push({ host });
    await host.install(cloudConfigCommands);
    await expect(host.invoke('cloud_config_publish', {
      config: {
        provider: 'webdav',
        webdav: { endpoint: 'https://dav.example.test', username: 'student' },
      },
      credentials: {},
    })).rejects.toMatchObject({ code: CLOUD_CREDENTIALS_UNAVAILABLE_CODE });
  });

  it('u64 generation follows Tauri JSON number output without extra rejection', () => {
    expect(u64ToJsonNumber(7n)).toBe(7);
    // D3：IPC 与原 Tauri number 输出一致；不因 > MAX_SAFE_INTEGER 额外拒绝合法 u64。
    expect(u64ToJsonNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n))
      .toBe(Number(BigInt(Number.MAX_SAFE_INTEGER) + 1n));
  });
});
