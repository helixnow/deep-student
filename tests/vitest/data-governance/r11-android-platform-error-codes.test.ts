/**
 * R11-android2 / P2-LOCALE：平台能力错误必须按稳定 code 本地化。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseCommandErrorEnvelope } from '@/api/tauriClient';
import {
  FTP_UNSUPPORTED_ON_ANDROID_CODE,
  S3_UNSUPPORTED_IN_BUILD_CODE,
  getCloudPlatformErrorI18nKey,
  getCloudStorageErrorCode,
  normalizeCloudStorageError,
} from '@/utils/cloudStorageApi';

const rustSource = readFileSync(
  resolve(process.cwd(), 'src-tauri/src/cloud_config_commands.rs'),
  'utf-8',
);

function rustStringConst(name: string): string {
  const match = rustSource.match(new RegExp(`${name}:\\s*&str\\s*=\\s*"([^"]+)"`));
  if (!match) throw new Error(`missing Rust string const ${name}`);
  return match[1];
}

describe('Android/S3 平台错误码跨层契约', () => {
  it('Rust 与 TypeScript 的稳定 code 完全一致', () => {
    expect(FTP_UNSUPPORTED_ON_ANDROID_CODE).toBe(
      rustStringConst('FTP_UNSUPPORTED_ON_ANDROID_CODE'),
    );
    expect(S3_UNSUPPORTED_IN_BUILD_CODE).toBe(
      rustStringConst('S3_UNSUPPORTED_IN_BUILD_CODE'),
    );
  });

  it.each([
    [FTP_UNSUPPORTED_ON_ANDROID_CODE, 'cloudStorage:errors.ftpDisabledAndroid'],
    [S3_UNSUPPORTED_IN_BUILD_CODE, 'cloudStorage:errors.s3DisabledInBuild'],
  ] as const)('code %s 的映射不依赖 message', (code, expectedKey) => {
    expect(getCloudPlatformErrorI18nKey({ code, message: 'first wording' })).toBe(expectedKey);
    expect(getCloudPlatformErrorI18nKey({ code, message: '完全不同的诊断文案' })).toBe(
      expectedKey,
    );
  });

  it('未知 code 与只有旧平台文案的错误都不映射', () => {
    expect(getCloudPlatformErrorI18nKey({
      code: 'E_FUTURE_PROVIDER_ERROR',
      message: 'FTP/FTPS storage is not available on Android.',
    })).toBeUndefined();
    expect(getCloudPlatformErrorI18nKey(
      new Error('当前安装包不支持 S3 兼容存储，请改用 WebDAV。'),
    )).toBeUndefined();
  });
});

describe('云存储 API 兼容错误形态时保留 code', () => {
  it('读取 canonical CommandError 对象与 JSON 字符串', () => {
    const envelope = {
      code: S3_UNSUPPORTED_IN_BUILD_CODE,
      message: 'changed',
    };
    expect(getCloudStorageErrorCode(envelope)).toBe(S3_UNSUPPORTED_IN_BUILD_CODE);
    expect(getCloudStorageErrorCode(JSON.stringify(envelope))).toBe(S3_UNSUPPORTED_IN_BUILD_CODE);
  });

  it('读取 create_storage 的 legacy AppError.details.code', () => {
    const appError = {
      error_type: 'Configuration',
      message: 'changed',
      details: { code: FTP_UNSUPPORTED_ON_ANDROID_CODE },
    };
    expect(getCloudStorageErrorCode(appError)).toBe(FTP_UNSUPPORTED_ON_ANDROID_CODE);
    expect(getCloudStorageErrorCode(new Error(JSON.stringify(appError)))).toBe(
      FTP_UNSUPPORTED_ON_ANDROID_CODE,
    );
  });

  it('包装后仍可由统一 CommandError 解析器按 code 识别', () => {
    const normalized = normalizeCloudStorageError({
      error_type: 'Configuration',
      message: 'diagnostic only',
      details: { code: S3_UNSUPPORTED_IN_BUILD_CODE },
    });
    expect(normalized.message).toBe('diagnostic only');
    expect(parseCommandErrorEnvelope(normalized)?.code).toBe(S3_UNSUPPORTED_IN_BUILD_CODE);
  });
});
