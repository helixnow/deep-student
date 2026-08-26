import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  checkConnection,
  CLOUD_STORAGE_CONFIG_V2_STORAGE_KEY,
  CLOUD_STORAGE_LEGACY_STORAGE_KEY,
  CLOUD_STORAGE_SSOT_MIGRATED_STORAGE_KEY,
  isPublicHttpEndpoint,
  resolveCloudStorageConfig,
  toRuntimeCloudStorageConfig,
  toSafeCloudStorageConfig,
  type CloudStorageConfig,
} from '../cloudStorageApi';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe('cloud storage backend SSOT DTO', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('strips WebDAV and encryption credentials', () => {
    const config: CloudStorageConfig = {
      provider: 'webdav',
      webdav: { endpoint: 'https://dav.example.test', username: 'student', password: 'secret' },
      s3: {
        endpoint: 'https://s3.example.test',
        bucket: 'ignored',
        accessKeyId: 'ignored',
        secretAccessKey: 'ignored',
      },
      root: 'deep-student-sync',
      encryptionPassword: 'encryption-secret',
    };

    expect(toSafeCloudStorageConfig(config)).toEqual({
      provider: 'webdav',
      webdav: { endpoint: 'https://dav.example.test', username: 'student' },
      root: 'deep-student-sync',
    });
    expect(JSON.stringify(toSafeCloudStorageConfig(config))).not.toMatch(/password|secret|s3/i);
  });

  it('keeps only non-secret S3 connection fields', () => {
    const safe = toSafeCloudStorageConfig({
      provider: 's3',
      s3: {
        endpoint: 'https://s3.example.test',
        bucket: 'coursework',
        accessKeyId: 'public-id',
        secretAccessKey: 'secret',
        region: 'cn-test-1',
        pathStyle: true,
      },
      encryptionPassword: 'secret',
    });

    expect(safe).toEqual({
      provider: 's3',
      s3: {
        endpoint: 'https://s3.example.test',
        bucket: 'coursework',
        accessKeyId: 'public-id',
        region: 'cn-test-1',
        pathStyle: true,
      },
    });
    expect(JSON.stringify(safe)).not.toMatch(/secretAccessKey|encryptionPassword/);
  });

  it('rejects a selected provider without its config block', () => {
    expect(() => toSafeCloudStorageConfig({ provider: 'ftp' })).toThrow('Missing FTP');
    expect(() => toSafeCloudStorageConfig({ provider: 'webdav' })).toThrow(
      i18next.t('backend_errors:cloud_storage.missing_webdav_config'),
    );
    expect(() => toSafeCloudStorageConfig({ provider: 's3' })).toThrow(
      i18next.t('backend_errors:cloud_storage.missing_s3_config'),
    );
  });

  it('never lets localStorage overwrite an existing backend config', async () => {
    const storage = new MemoryStorage();
    storage.setItem(CLOUD_STORAGE_CONFIG_V2_STORAGE_KEY, JSON.stringify({
      provider: 'webdav',
      webdav: {
        endpoint: 'https://stale-local.example.test',
        username: 'stale',
        password: 'local-leaked-secret',
      },
    }));
    invokeMock.mockResolvedValueOnce({
      configured: true,
      provider: 'webdav',
      config: {
        provider: 'webdav',
        webdav: {
          endpoint: 'https://backend.example.test',
          username: 'backend',
        },
      },
    });

    const resolved = await resolveCloudStorageConfig(storage);

    expect(resolved).toEqual({
      provider: 'webdav',
      webdav: {
        endpoint: 'https://backend.example.test',
        username: 'backend',
        password: '',
      },
      root: undefined,
      allowInsecure: false,
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('cloud_config_ssot_get');
    expect(storage.getItem(CLOUD_STORAGE_CONFIG_V2_STORAGE_KEY)).not.toContain('local-leaked-secret');
    expect(storage.getItem(CLOUD_STORAGE_SSOT_MIGRATED_STORAGE_KEY)).toBe('1');
  });

  it('migrates local config only after an explicit backend miss', async () => {
    const storage = new MemoryStorage();
    storage.setItem(CLOUD_STORAGE_LEGACY_STORAGE_KEY, JSON.stringify({
      provider: 'ftp',
      ftp: {
        host: 'localhost',
        port: 2121,
        username: 'student',
        password: 'ftp-migration-secret',
        useTls: false,
      },
      root: 'coursework',
      encryptionPassword: 'encryption-migration-secret',
    }));
    invokeMock
      .mockResolvedValueOnce({ configured: false })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        configured: true,
        provider: 'ftp',
        root: 'coursework',
        config: {
          provider: 'ftp',
          ftp: {
            host: 'localhost',
            port: 2121,
            username: 'student',
            useTls: false,
          },
          root: 'coursework',
        },
      });

    await resolveCloudStorageConfig(storage);

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'cloud_config_ssot_get',
      'secure_save_cloud_credentials',
      'cloud_config_ssot_save',
    ]);
    expect(invokeMock.mock.calls[1][1]).toEqual({
      credentials: {
        webdavPassword: undefined,
        s3SecretAccessKey: undefined,
        ftpPassword: 'ftp-migration-secret',
        encryptionPassword: 'encryption-migration-secret',
      },
      // 迁移携带的是 v0.9.44 存量口令：必须按存量口令提交，
      // 否则短口令会让整个云配置解析失败。
      encryptionPasswordIsPreexisting: true,
    });
    expect(JSON.stringify(invokeMock.mock.calls[2][1])).not.toMatch(
      /ftp-migration-secret|encryption-migration-secret|password/i,
    );
    expect(storage.getItem(CLOUD_STORAGE_LEGACY_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(CLOUD_STORAGE_CONFIG_V2_STORAGE_KEY)).not.toMatch(
      /ftp-migration-secret|encryption-migration-secret|password/i,
    );
    expect(storage.getItem(CLOUD_STORAGE_SSOT_MIGRATED_STORAGE_KEY)).toBe('1');
  });

  it('migrates a v0.9.44 short encryption password as a preexisting credential', async () => {
    const storage = new MemoryStorage();
    storage.setItem(CLOUD_STORAGE_LEGACY_STORAGE_KEY, JSON.stringify({
      provider: 'webdav',
      webdav: {
        endpoint: 'https://dav.example.test',
        username: 'student',
        password: 'webdav-secret',
      },
      root: 'coursework',
      // v0.9.44 从不限制口令长度；6 位存量口令必须原样迁入安全存储。
      encryptionPassword: 'short6',
    }));
    invokeMock
      .mockResolvedValueOnce({ configured: false })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        configured: true,
        provider: 'webdav',
        root: 'coursework',
        config: {
          provider: 'webdav',
          webdav: { endpoint: 'https://dav.example.test', username: 'student' },
          root: 'coursework',
        },
      });

    await expect(resolveCloudStorageConfig(storage)).resolves.not.toBeNull();

    const [command, payload] = invokeMock.mock.calls[1];
    expect(command).toBe('secure_save_cloud_credentials');
    expect(payload.credentials.encryptionPassword).toBe('short6');
    expect(payload.encryptionPasswordIsPreexisting).toBe(true);
    expect(storage.getItem(CLOUD_STORAGE_SSOT_MIGRATED_STORAGE_KEY)).toBe('1');
  });

  it('does not resurrect a stale cache after a completed SSOT migration', async () => {
    const storage = new MemoryStorage();
    storage.setItem(CLOUD_STORAGE_SSOT_MIGRATED_STORAGE_KEY, '1');
    storage.setItem(CLOUD_STORAGE_CONFIG_V2_STORAGE_KEY, JSON.stringify({
      provider: 'webdav',
      webdav: {
        endpoint: 'https://stale.example.test',
        username: 'stale',
      },
    }));
    storage.setItem(CLOUD_STORAGE_LEGACY_STORAGE_KEY, JSON.stringify({
      provider: 'webdav',
      webdav: {
        endpoint: 'https://legacy.example.test',
        username: 'legacy',
        password: 'must-not-be-remigrated',
      },
    }));
    invokeMock.mockResolvedValueOnce({ configured: false });

    await expect(resolveCloudStorageConfig(storage)).resolves.toBeNull();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(storage.getItem(CLOUD_STORAGE_CONFIG_V2_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(CLOUD_STORAGE_LEGACY_STORAGE_KEY)).toBeNull();
  });

  it('strips secrets from routine IPC payloads', async () => {
    invokeMock.mockResolvedValueOnce(true);

    await checkConnection({
      provider: 'webdav',
      webdav: {
        endpoint: 'https://dav.example.test',
        username: 'student',
        password: 'must-not-cross-routine-ipc',
      },
      encryptionPassword: 'must-not-cross-routine-ipc-either',
      allowInsecure: true,
    });

    const payload = invokeMock.mock.calls[0][1];
    expect(payload.config.webdav.password).toBe('');
    expect(JSON.stringify(payload)).not.toContain('must-not-cross-routine-ipc');
    expect(payload.config.encryptionPassword).toBeUndefined();
    expect(payload.config.allowInsecure).toBeUndefined();
  });

  it('never serializes the backend-only insecure transport capability', () => {
    const runtime = toRuntimeCloudStorageConfig({
      provider: 'ftp',
      ftp: {
        host: 'ftp.example.test',
        port: 21,
        username: 'student',
        password: 'secret',
        useTls: false,
      },
      allowInsecure: true,
    });

    expect(runtime.ftp?.password).toBe('');
    expect(runtime.allowInsecure).toBeUndefined();
    expect(JSON.stringify(runtime)).not.toContain('secret');
  });

  it('distinguishes loopback HTTP from public HTTP', () => {
    expect(isPublicHttpEndpoint('http://dav.example.test')).toBe(true);
    expect(isPublicHttpEndpoint('http://localhost:8080')).toBe(false);
    expect(isPublicHttpEndpoint('http://127.42.0.1:9000')).toBe(false);
    expect(isPublicHttpEndpoint('http://[::1]:8080')).toBe(false);
    expect(isPublicHttpEndpoint('https://dav.example.test')).toBe(false);
  });
});
