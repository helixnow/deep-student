/**
 * [R4-P01/P02] Command-boundary configuration errors and unit-enum map input.
 *
 * `create_storage` maps `CloudStorageConfigError` to an IPC `AppError`
 * (`cloud/mod.rs:279-291`): platform refusals are `Configuration` with
 * `details.code`, ordinary validation failures are `Validation`. The public
 * service must normalize serde's externally-tagged provider map before the
 * same validation runs.
 */

import { describe, expect, it } from 'vitest';
import { CloudStorageError } from '../src/errors.ts';
import {
  DESKTOP_CAPABILITIES,
  configErrorToAppError,
  providerKey,
  validateConfig,
  CloudStorageConfigError,
} from '../src/config.ts';
import { createStorage, providerService } from '../index.ts';
import type { RuntimeCloudStorageConfig } from '../api.ts';
import { createSyncHost } from './host_fixture.ts';

function webdav(overrides: Partial<{ endpoint: string; username: string; password: string }> = {}): RuntimeCloudStorageConfig {
  return {
    provider: 'webdav',
    webdav: { endpoint: 'https://dav.example.com/dav/', username: 'student', password: 'secret', ...overrides },
  };
}

async function serviceFailure(run: Promise<unknown>): Promise<CloudStorageError> {
  try { await run; }
  catch (error) {
    if (error instanceof CloudStorageError) return error;
    throw error;
  }
  throw new Error('expected the production service to reject');
}

describe('cloud_storage config → IPC AppError', () => {
  it('maps ordinary validation errors to Validation without details', () => {
    const error = configErrorToAppError(new CloudStorageConfigError('缺少 WebDAV 配置'));
    expect(error.value).toEqual({ error_type: 'Validation', message: '缺少 WebDAV 配置', details: null });
  });

  it('maps platform capability errors to Configuration with the stable code', () => {
    const error = configErrorToAppError(new CloudStorageConfigError('unsupported', 'E_FTP_UNSUPPORTED_ON_ANDROID'));
    expect(error.value).toEqual({
      error_type: 'Configuration',
      message: 'unsupported',
      details: { code: 'E_FTP_UNSUPPORTED_ON_ANDROID' },
    });
  });

  it('createStorage({}) returns an AppError value instead of leaking the raw config error', async () => {
    const error = await serviceFailure(providerService.createStorage({}));
    expect(error).toBeInstanceOf(CloudStorageError);
    expect(error.value).toEqual({ error_type: 'Validation', message: '缺少 WebDAV 配置', details: null });
  });

  it('normalizes the serde map form before validating public plaintext HTTP', async () => {
    const config = {
      provider: { webdav: null },
      webdav: { endpoint: 'http://dav.example.com/dav/', username: 'student', password: 'secret' },
    } as unknown as RuntimeCloudStorageConfig;
    const error = await serviceFailure(providerService.createStorage(config));
    expect(error.value.error_type).toBe('Validation');
    expect(error.message).toContain('公网 WebDAV 必须使用 HTTPS');
  });

  it('normalizes the map form before accepting a valid loopback configuration', async () => {
    const config = {
      provider: { webdav: null },
      webdav: { endpoint: 'http://127.0.0.1:8080/dav/', username: 'student', password: 'secret' },
    } as unknown as RuntimeCloudStorageConfig;
    const storage = await createStorage(config);
    expect(storage.providerName()).toBe('WebDAV');
  });

  it('map form reaches the same username/password checks as the string form', async () => {
    const mapForm = {
      provider: { webdav: null },
      webdav: { endpoint: 'https://dav.example.com/dav/', username: '', password: 'secret' },
    } as unknown as RuntimeCloudStorageConfig;
    expect(providerKey(mapForm.provider)).toBe('webdav');
    expect(() => validateConfig(mapForm, DESKTOP_CAPABILITIES)).toThrow('WebDAV 用户名不能为空');
    const error = await serviceFailure(providerService.createStorage(mapForm));
    expect(error.value.error_type).toBe('Validation');
  });

  it('does not accept an HTTP endpoint through the IPC command either', async () => {
    const fixture = await createSyncHost();
    try {
      await expect(fixture.host.invoke('cloud_storage_check_connection', {
        config: {
          provider: { webdav: null },
          webdav: { endpoint: 'http://dav.example.com/dav/', username: 'student', password: 'secret' },
        },
      })).rejects.toEqual({
        error_type: 'Validation',
        message: '公网 WebDAV 必须使用 HTTPS；HTTP 仅允许 loopback 或已持久化的 allowInsecure 授权',
        details: null,
      });
      // hydrate ran before validation, exactly like Rust's command order.
      expect(fixture.hydrateCalls).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });

  it('missing configuration at the real command boundary is a Validation object, not a panic', async () => {
    const fixture = await createSyncHost();
    try {
      await expect(fixture.host.invoke('cloud_storage_check_connection', { config: {} }))
        .rejects.toEqual({ error_type: 'Validation', message: '缺少 WebDAV 配置', details: null });
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps the string form valid (control group)', () => {
    expect(() => validateConfig(webdav(), DESKTOP_CAPABILITIES)).not.toThrow();
  });
});
