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

describe('移动端指南对 Android 云存储诚实', () => {
  const guide = readFileSync(
    resolve(process.cwd(), 'docs/user-guide/17-移动端指南.md'),
    'utf-8',
  );

  it('对照表与 FAQ 写明 Android 仅 WebDAV，不把 S3 写成手机可用', () => {
    expect(guide).toContain('Android 仅 WebDAV');
    expect(guide).toContain('S3 与 FTP 均不可用');
    expect(guide).toContain('Android 目前只能配置 **WebDAV**');
    expect(guide).toContain('桌面写入的 S3 / FTP 配置在 Android 上不会被加载');
    expect(guide).not.toMatch(/云同步（WebDAV\/S3，实验性）/);
    expect(guide).not.toMatch(/两端配置同一个 WebDAV\/S3/);
    expect(guide).not.toMatch(/一端「立即备份到云端」，另一端「从云端恢复」/);
    expect(guide).toContain('便携归档');
    expect(guide).toContain('未配置云端端到端加密密码时');
    expect(guide).toContain('校验会拒绝');
    expect(guide).not.toMatch(/不要指望默认「立即备份到云端」再「从云端恢复」能整槽换机/);
  });

  it('隐私数据流向不把云同步写成笼统的 WebDAV/S3', () => {
    const zh = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src/locales/zh-CN/common.json'), 'utf-8'),
    );
    const en = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src/locales/en-US/common.json'), 'utf-8'),
    );
    expect(zh.legal.settingsSection.dataFlow.syncDataDesc).toContain('Android 仅 WebDAV');
    expect(zh.legal.settingsSection.dataFlow.syncDataDesc).not.toMatch(/WebDAV\/S3 服务/);
    expect(en.legal.settingsSection.dataFlow.syncDataDesc).toMatch(/WebDAV on Android/i);
    expect(en.legal.settingsSection.dataFlow.syncDataDesc).not.toMatch(/configured WebDAV\/S3 service/);
    expect(zh.legal.privacyPolicy.sections.cloudSync.content).toContain('Android 仅支持 WebDAV');
    expect(en.legal.privacyPolicy.sections.cloudSync.content).toMatch(/Android supports WebDAV only/i);
  });

  it('根 README 不再把云同步写成笼统的 S3 & WebDAV，并写明默认云端包不能整槽恢复', () => {
    const enReadme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf-8');
    const zhReadme = readFileSync(resolve(process.cwd(), 'README_CN.md'), 'utf-8');
    expect(enReadme).toContain('Android is WebDAV only');
    expect(enReadme).toContain('portable archive and cannot slot-restore');
    expect(enReadme).toMatch(/export is refused/i);
    expect(enReadme).not.toMatch(/backup-style sync via S3-compatible storage & WebDAV/);
    expect(zhReadme).toContain('Android 仅 WebDAV');
    expect(zhReadme).toContain('不能整槽恢复');
    expect(zhReadme).toContain('没有增量传输');
    expect(zhReadme).toContain('拒绝导出');
  });
});

describe('CI Vitest 堆上限不把 4GB worker 顶死当产品红', () => {
  it('CI forks 使用 6144MB 堆且最多 2 个 worker，不放宽用例', () => {
    const vitestConfig = readFileSync(resolve(process.cwd(), 'vitest.config.ts'), 'utf-8');
    const ciYml = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf-8');
    expect(vitestConfig).toContain("process.env.CI ? '--max-old-space-size=6144'");
    expect(vitestConfig).toContain('maxForks: 2');
    expect(ciYml).toContain("NODE_OPTIONS: '--max-old-space-size=6144'");
    expect(vitestConfig).not.toContain('testTimeout: 0');
  });
});
