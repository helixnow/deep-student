/**
 * CloudStorageSection 平台能力拒绝映射测试（R10-ux / P2-LOCALE-PLATFORM-MSG）
 *
 * 覆盖（与 r09-ux-cloud-storage.test.tsx、CloudStorageSection.cloudUi.test.tsx 不重复）：
 * 1. 后端 S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE（中文常量）→ 前端映射为
 *    cloudStorage:errors.s3DisabledInBuild（zh/en 均有键，en 用户可读）；
 * 2. 跨层契约：用 src-tauri 源码里的常量原文钉死前端匹配片段；
 * 3. 回归：FTP-on-Android 英文常量映射不受影响；E2EE 分类优先于平台能力映射；
 * 4. 源码契约：SSOT 保存失败通知必须带 localizeCloudError 映射后的原因
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

/** 与 CloudStorageSection.localizeCloudError 内的匹配片段保持一致 */
const S3_FRONTEND_PATTERN = /当前安装包不支持\s*S3\s*兼容存储/;

beforeEach(() => {
  vi.clearAllMocks();
  mockParseEnvelope.mockReturnValue(null);
  localStorage.clear();
});

// ============================================================================
// 跨层契约：后端常量 ↔ 前端匹配片段 ↔ locale 键
// ============================================================================

describe('S3 拒绝文案跨层契约（P2-LOCALE-PLATFORM-MSG）', () => {
  it('前端匹配片段命中后端常量原文（后端改文案必须同步前端映射）', () => {
    expect(S3_FRONTEND_PATTERN.test(S3_BACKEND_MESSAGE)).toBe(true);
    // 后端常量保持面向用户（R09-android P3-2 修复不回退）
    expect(S3_BACKEND_MESSAGE).toContain('WebDAV');
    expect(S3_BACKEND_MESSAGE).not.toMatch(/feature|编译/);
  });

  it('组件源码使用同一匹配片段并映射到 s3DisabledInBuild 键', () => {
    expect(componentSource).toContain('当前安装包不支持\\s*S3\\s*兼容存储');
    expect(componentSource).toContain("t('cloudStorage:errors.s3DisabledInBuild')");
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
  it('后端 S3 拒绝原文 → 通知携带 s3DisabledInBuild（不再裸透中文常量）', async () => {
    vi.mocked(cloudApi.resolveCloudStorageConfig).mockRejectedValue(
      new Error(S3_BACKEND_MESSAGE),
    );

    render(<CloudStorageSection />);

    await waitFor(() => {
      expect(mockShowGlobalNotification).toHaveBeenCalledWith(
        'error',
        'cloudStorage:messages.configSsotFailed: cloudStorage:errors.s3DisabledInBuild',
      );
    });
  });

  it('回归：FTP-on-Android 英文常量仍映射到 ftpDisabledAndroid', async () => {
    vi.mocked(cloudApi.resolveCloudStorageConfig).mockRejectedValue(
      new Error(FTP_BACKEND_MESSAGE),
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
    vi.mocked(cloudApi.resolveCloudStorageConfig).mockRejectedValue(new Error(mixed));

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
// 源码契约：SSOT 保存失败不得吞掉原因
// ============================================================================

describe('SSOT 保存失败通知（源码契约）', () => {
  it('doSaveConfig 的 SSOT catch 必须带 localizeCloudError 映射后的原因', () => {
    expect(componentSource).toMatch(
      /Failed to save credential-free cloud config SSOT[^]{0,600}configSsotFailed'\)\}: \$\{localizeCloudError\(e\)\}/,
    );
  });
});
