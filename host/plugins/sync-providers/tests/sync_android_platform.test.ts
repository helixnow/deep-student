/**
 * Ports of the host-runnable platform-capability tests from
 * `sync_android_restart.rs` and `sync_android_device_switch.rs`.
 *
 * Rust differentiates the mobile build with compile-time `cfg(target_os)` and
 * feature flags. The Host build always contains both transports; the same
 * production branches are driven by the explicit `PlatformStorageCapabilities`
 * argument (`validate_config` / `create_storage_with_capabilities`), exactly as
 * the Rust R09 tests do on the host.
 */

import { describe, expect, it } from 'vitest';
import {
  ANDROID_CAPABILITIES,
  DESKTOP_CAPABILITIES,
  FTP_UNSUPPORTED_ON_ANDROID_CODE,
  FTP_UNSUPPORTED_ON_ANDROID_MESSAGE,
  S3_UNSUPPORTED_IN_BUILD_CODE,
  S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE,
  s3EnabledForCapabilities,
  validateConfig,
} from '../src/config.ts';
import { CloudStorageConfigError } from '../src/config.ts';
import { CloudStorageError } from '../src/errors.ts';
import { createStorageWithCapabilities } from '../index.ts';
import type { RuntimeCloudStorageConfig } from '../api.ts';

function completeFtpConfig(): RuntimeCloudStorageConfig {
  return {
    provider: 'ftp',
    ftp: {
      host: 'ftp.example.com',
      port: 21,
      username: 'student',
      password: 'secret',
      useTls: true,
    },
  };
}

function validWebDavConfig(): RuntimeCloudStorageConfig {
  return {
    provider: 'webdav',
    webdav: {
      endpoint: 'https://dav.example.com/dav/',
      username: 'student',
      password: 'secret',
    },
  };
}

function validS3Config(): RuntimeCloudStorageConfig {
  return {
    provider: 's3',
    s3: {
      endpoint: 'https://s3.example.com',
      bucket: 'bucket',
      accessKeyId: 'AK',
      secretAccessKey: 'SK',
    },
  };
}

function expectConfigError(run: () => unknown): CloudStorageConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof CloudStorageConfigError) return error;
    throw error;
  }
  throw new Error('expected a CloudStorageConfigError');
}

/** cloud/mod.rs:279-291: create_storage maps the config error to an IPC AppError. */
async function expectStorageError(run: Promise<unknown>): Promise<CloudStorageError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof CloudStorageError) return error;
    throw error;
  }
  throw new Error('expected a CloudStorageError');
}

describe('sync_android_restart.rs / sync_android_device_switch.rs', () => {
  it('platform_rejection_codes_are_stable_contract', () => {
    expect(FTP_UNSUPPORTED_ON_ANDROID_CODE).toBe('E_FTP_UNSUPPORTED_ON_ANDROID');
    expect(S3_UNSUPPORTED_IN_BUILD_CODE).toBe('E_S3_UNSUPPORTED_IN_BUILD');
    expect(FTP_UNSUPPORTED_ON_ANDROID_MESSAGE).toBe('FTP/FTPS storage is not available on Android.');
  });

  it('desktop_accepts_complete_ftp_config_so_android_gate_is_the_only_difference', () => {
    expect(() => validateConfig(completeFtpConfig(), DESKTOP_CAPABILITIES)).not.toThrow();
  });

  it('android_validate_rejects_complete_ftp_config', () => {
    const error = expectConfigError(() => validateConfig(completeFtpConfig(), ANDROID_CAPABILITIES));
    expect(error.code).toBe(FTP_UNSUPPORTED_ON_ANDROID_CODE);
    expect(error.message).toBe(FTP_UNSUPPORTED_ON_ANDROID_MESSAGE);
  });

  it('android_create_storage_rejects_ftp_before_any_network_io', async () => {
    const error = await expectStorageError(createStorageWithCapabilities(completeFtpConfig(), ANDROID_CAPABILITIES));
    expect(error.value.error_type).toBe('Configuration');
    expect(error.value.details).toEqual({ code: FTP_UNSUPPORTED_ON_ANDROID_CODE });
  });

  it('android_create_storage_rejects_ftp_with_mappable_message', async () => {
    const validationError = expectConfigError(() => validateConfig(completeFtpConfig(), ANDROID_CAPABILITIES));
    expect(validationError.code).toBe(FTP_UNSUPPORTED_ON_ANDROID_CODE);
    expect(validationError.message).toBe(FTP_UNSUPPORTED_ON_ANDROID_MESSAGE);

    const error = await expectStorageError(createStorageWithCapabilities(completeFtpConfig(), ANDROID_CAPABILITIES));
    expect(error.value.error_type).toBe('Configuration');
    expect(error.value.details).toEqual({ code: FTP_UNSUPPORTED_ON_ANDROID_CODE });
    expect(error.message).toBe(FTP_UNSUPPORTED_ON_ANDROID_MESSAGE);

    // Control group: the same config passes under desktop capabilities.
    expect(() => validateConfig(completeFtpConfig(), DESKTOP_CAPABILITIES)).not.toThrow();
  });

  it('mobile_feature_profiles_exclude_s3_backend', () => {
    // Mobile profiles exclude the S3 backend; desktop includes it.
    expect(DESKTOP_CAPABILITIES.s3Supported).toBe(true);
    expect(s3EnabledForCapabilities(DESKTOP_CAPABILITIES)).toBe(true);
    expect(ANDROID_CAPABILITIES.s3Supported).toBe(false);
    expect(s3EnabledForCapabilities(ANDROID_CAPABILITIES)).toBe(false);
  });

  it('platform_capability_constants_stay_mappable', () => {
    expect(FTP_UNSUPPORTED_ON_ANDROID_MESSAGE).toBe('FTP/FTPS storage is not available on Android.');
    expect(FTP_UNSUPPORTED_ON_ANDROID_CODE).toBe('E_FTP_UNSUPPORTED_ON_ANDROID');
    expect(S3_UNSUPPORTED_IN_BUILD_CODE).toBe('E_S3_UNSUPPORTED_IN_BUILD');
    // Host is a non-Android build with the S3 transport compiled in.
    expect(DESKTOP_CAPABILITIES.ftpSupported).toBe(true);
    expect(DESKTOP_CAPABILITIES.s3Supported).toBe(true);
    expect(ANDROID_CAPABILITIES.ftpSupported).toBe(false);
    expect(ANDROID_CAPABILITIES.s3Supported).toBe(false);
  });

  it('webdav_transfer_path_constructible_without_network', async () => {
    const storage = await createStorageWithCapabilities(validWebDavConfig(), DESKTOP_CAPABILITIES);
    expect(storage.providerName()).toBe('WebDAV');
  });

  it('s3_disabled_build_fails_closed_like_mobile_slim', async () => {
    expect(s3EnabledForCapabilities(DESKTOP_CAPABILITIES)).toBe(true);
    expect(s3EnabledForCapabilities(ANDROID_CAPABILITIES)).toBe(false);
    const validationError = expectConfigError(() => validateConfig(validS3Config(), ANDROID_CAPABILITIES));
    expect(validationError.code).toBe(S3_UNSUPPORTED_IN_BUILD_CODE);
    expect(validationError.message).toBe(S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE);

    const error = await expectStorageError(createStorageWithCapabilities(validS3Config(), ANDROID_CAPABILITIES));
    expect(error.value.error_type).toBe('Configuration');
    expect(error.value.details).toEqual({ code: S3_UNSUPPORTED_IN_BUILD_CODE });
    expect(error.message).toBe(S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE);
  });
});
