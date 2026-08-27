/**
 * CloudStorageSection 平台能力拒绝映射测试（R11-android2 / P2-LOCALE）
 *
 * 覆盖（与 r09-ux-cloud-storage.test.tsx、CloudStorageSection.cloudUi.test.tsx 不重复）：
 * 1. 后端稳定 code（message 可任意变化）→ 前端映射为
 *    cloudStorage:errors.s3DisabledInBuild（zh/en 均有键，en 用户可读）；
 * 2. 跨层契约：Rust/TypeScript 的两个 code 常量逐字一致，组件不再含平台文案正则；
 * 3. 回归：FTP-on-Android code 映射；E2EE 分类优先于平台能力映射；
 * 4. 源码契约：配置发布失败通知必须带 localizeCloudError 映射后的原因
 *    （与加载路径对齐，不再吞掉后端拒绝原因）。
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

// ============================================================================
// Mocks（与 r09-ux-cloud-storage.test.tsx 同构：稳定身份 t，避免无限重渲染）
// ============================================================================

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  const translation = {
    t,
    i18n: { language: 'zh-CN', changeLanguage: () => Promise.resolve(), t },
  };
  return {
    useTranslation: () => translation,
    initReactI18next: { type: '3rdParty', init: () => {} },
  };
});

const mockShowGlobalNotification = vi.hoisted(() => vi.fn());
const mockGetCloudPlatformErrorI18nKey = vi.hoisted(() => vi.fn());
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mockShowGlobalNotification,
}));

const mockParseEnvelope = vi.hoisted(() => vi.fn(() => null as unknown));
vi.mock('@/api/tauriClient', () => ({
  parseCommandErrorEnvelope: mockParseEnvelope,
}));

vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: {
    getAppVersion: vi.fn(async () => '0.0.0-test'),
    getAppDataDir: vi.fn(async () => '/tmp/app-data'),
    restartApp: vi.fn(async () => undefined),
  },
}));

vi.mock('@/api/dataGovernance', () => ({
  DataGovernanceApi: {
    backupTiered: vi.fn(),
    exportZip: vi.fn(),
    importZip: vi.fn(),
    restoreBackup: vi.fn(),
    checkDiskSpaceForRestore: vi.fn(),
    getBackupJob: vi.fn(),
    cancelBackup: vi.fn(),
  },
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));

vi.mock('@/utils/platform', () => ({
  isAndroid: vi.fn(() => false),
  isMobilePlatform: vi.fn(() => false),
}));

vi.mock('@/utils/cloudStorageApi', () => ({
  CLOUD_STORAGE_CONFIG_V2_STORAGE_KEY: 'cloud_storage_config_v2',
  CLOUD_STORAGE_LEGACY_STORAGE_KEY: 'cloud_storage_config',
  CLOUD_STORAGE_SSOT_MIGRATED_STORAGE_KEY: 'cloud_storage_ssot_migrated',
  isS3Enabled: vi.fn(async () => true),
  resolveCloudStorageConfig: vi.fn(async () => null),
  getCredentialStatus: vi.fn(async () => ({
    webdavPasswordConfigured: false,
    s3SecretAccessKeyConfigured: false,
    ftpPasswordConfigured: false,
    encryptionPasswordConfigured: false,
  })),
  getDeviceId: vi.fn(async () => 'device-test'),
  clearCloudConfigSsot: vi.fn(async () => undefined),
  clearEncryptionPassword: vi.fn(),
  saveCredentials: vi.fn(),
  saveCloudConfigSsot: vi.fn(),
  checkConnection: vi.fn(),
  getSyncStatus: vi.fn(),
  listVersions: vi.fn(),
  uploadBackup: vi.fn(),
  downloadBackup: vi.fn(),
  deleteVersion: vi.fn(),
  requiresInsecureTransportOptIn: vi.fn(() => false),
  isPublicHttpEndpoint: vi.fn(() => false),
  formatFileSize: (n: number) => `${n}B`,
  formatTimestamp: (n: number) => String(n),
  getCloudPlatformErrorI18nKey: mockGetCloudPlatformErrorI18nKey,
  findCloudBackupVersion: () => undefined,
  isKnownPortableCloudBackup: () => false,
}));

vi.mock('@/components/ui/DsDialog', () => ({
  DsAlertDialog: () => null,
}));

import { CloudStorageSection } from '@/features/settings/components/CloudStorageSection';
import * as cloudApi from '@/utils/cloudStorageApi';

// ============================================================================
// 契约来源：后端常量原文、前端源码、zh/en locale
// ============================================================================

const backendSource = readFileSync(
  resolve(process.cwd(), 'src-tauri/src/cloud_config_commands.rs'),
  'utf-8',
);
const componentSource = readFileSync(
  resolve(process.cwd(), 'src/features/settings/components/CloudStorageSection.tsx'),
  'utf-8',
);
const localizeSource = readFileSync(
  resolve(
    process.cwd(),
    'src/features/settings/components/data-governance/localizeCloudError.ts',
  ),
  'utf-8',
);
const zhLocale = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/locales/zh-CN/cloudStorage.json'), 'utf-8'),
);
const enLocale = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/locales/en-US/cloudStorage.json'), 'utf-8'),
);

/** 从 Rust 源码提取常量字面量，保证测试跟随后端文案而非凭空复述 */
function extractRustStringConst(name: string): string {
  const match = backendSource.match(
    new RegExp(`${name}:\\s*&str\\s*=\\s*"([^"]+)"`),
  );
  if (!match) throw new Error(`constant ${name} not found in cloud_config_commands.rs`);
  return match[1];
}

const S3_BACKEND_MESSAGE = extractRustStringConst(
  'S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE',
);
const FTP_BACKEND_MESSAGE = extractRustStringConst(
  'FTP_UNSUPPORTED_ON_ANDROID_MESSAGE',
);
const S3_BACKEND_CODE = extractRustStringConst('S3_UNSUPPORTED_IN_BUILD_CODE');
const FTP_BACKEND_CODE = extractRustStringConst('FTP_UNSUPPORTED_ON_ANDROID_CODE');

beforeEach(() => {
  vi.clearAllMocks();
  mockParseEnvelope.mockReturnValue(null);
  mockGetCloudPlatformErrorI18nKey.mockImplementation((error: unknown) => {
    const code = (error as { code?: string } | null)?.code;
    if (code === S3_BACKEND_CODE) return 'cloudStorage:errors.s3DisabledInBuild';
    if (code === FTP_BACKEND_CODE) return 'cloudStorage:errors.ftpDisabledAndroid';
    return undefined;
  });
  localStorage.clear();
});

// ============================================================================
// 跨层契约：后端常量 ↔ 前端匹配片段 ↔ locale 键
// ============================================================================

describe('平台拒绝 code 跨层契约（P2-LOCALE）', () => {
  it('后端稳定 code 与产品契约一致，message 仅保留面向用户的诊断', () => {
    expect(S3_BACKEND_CODE).toBe('E_S3_UNSUPPORTED_IN_BUILD');
    expect(FTP_BACKEND_CODE).toBe('E_FTP_UNSUPPORTED_ON_ANDROID');
    // 后端常量保持面向用户（R09-android P3-2 修复不回退）
    expect(S3_BACKEND_MESSAGE).toContain('WebDAV');
    expect(S3_BACKEND_MESSAGE).not.toMatch(/feature|编译/);
    expect(FTP_BACKEND_MESSAGE).toContain('Android');
  });

  it('组件委托 code 映射，源码不再匹配 FTP/S3 平台文案', () => {
    expect(componentSource).toContain('localizeCloudStorageError');
    expect(localizeSource).toContain('getCloudPlatformErrorI18nKey(error)');
    expect(componentSource).not.toContain('FTP\\/FTPS storage is not available on Android');
    expect(componentSource).not.toContain('当前安装包不支持\\s*S3\\s*兼容存储');
    expect(localizeSource).not.toContain('FTP\\/FTPS storage is not available on Android');
    expect(localizeSource).not.toContain('当前安装包不支持\\s*S3\\s*兼容存储');
  });

  it('zh/en locale 均有 s3DisabledInBuild 键且给出可操作替代（WebDAV / ZIP 导入）', () => {
    expect(zhLocale.errors.s3DisabledInBuild).toContain('S3');
    expect(zhLocale.errors.s3DisabledInBuild).toContain('WebDAV');
    expect(zhLocale.errors.s3DisabledInBuild).toContain('ZIP');
    expect(enLocale.errors.s3DisabledInBuild).toMatch(/S3/);
    expect(enLocale.errors.s3DisabledInBuild).toMatch(/WebDAV/);
    expect(enLocale.errors.s3DisabledInBuild).toMatch(/ZIP/i);
    // 不得面向编译者
    expect(enLocale.errors.s3DisabledInBuild).not.toMatch(/feature|compile/i);
  });
});

// ============================================================================
// 渲染路径：SSOT 加载失败 → 映射后的人话通知
// ============================================================================

describe('平台能力拒绝的加载路径映射', () => {
  it('S3 code → 通知携带 s3DisabledInBuild，message 改写不影响映射', async () => {
    vi.mocked(cloudApi.resolveCloudStorageConfig).mockRejectedValue(
      { code: S3_BACKEND_CODE, message: 'arbitrary changed S3 diagnostic' },
    );

    render(<CloudStorageSection />);

    await waitFor(() => {
      expect(mockShowGlobalNotification).toHaveBeenCalledWith(
        'error',
        'cloudStorage:messages.configSsotFailed: cloudStorage:errors.s3DisabledInBuild',
      );
    });
  });

  it('FTP-on-Android code 映射到 ftpDisabledAndroid，message 不参与分派', async () => {
    vi.mocked(cloudApi.resolveCloudStorageConfig).mockRejectedValue(
      { code: FTP_BACKEND_CODE, message: '任意语言的 FTP 诊断' },
    );

    render(<CloudStorageSection />);

    await waitFor(() => {
      expect(mockShowGlobalNotification).toHaveBeenCalledWith(
        'error',
        'cloudStorage:messages.configSsotFailed: cloudStorage:errors.ftpDisabledAndroid',
      );
    });
  });

  it('E2EE 分类优先于平台能力映射（同时命中时归 E2EE 且保留原文供排查）', async () => {
    const mixed = `解密失败（密码不一致）；${S3_BACKEND_MESSAGE}`;
    vi.mocked(cloudApi.resolveCloudStorageConfig).mockRejectedValue(
      Object.assign(new Error(mixed), { code: S3_BACKEND_CODE }),
    );

    render(<CloudStorageSection />);

    await waitFor(() => {
      expect(mockShowGlobalNotification).toHaveBeenCalledWith(
        'error',
        `cloudStorage:messages.configSsotFailed: cloudStorage:errors.e2eeWrongPassword\n(${mixed})`,
      );
    });
  });
});

// ============================================================================
// 源码契约：配置发布失败不得吞掉原因
// ============================================================================

describe('配置发布失败通知（源码契约）', () => {
  it('doSaveConfig 的 publish catch 必须带 localizeCloudError 映射后的原因', () => {
    expect(componentSource).toMatch(
      /Failed to publish cloud configuration[^]{0,600}configPublishFailed'\)\}: \$\{localizeCloudError\(e\)\}/,
    );
  });
});
