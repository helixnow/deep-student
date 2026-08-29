/**
 * CloudStorageSection「测试连接失败 ⇒ SSOT 未变」红灯测试（0824 Wave2-D R2 / 测试 A）
 *
 * 契约：点击「测试连接」必须先走不落盘的草稿测试 `testConnectionDraft`（对
 * 用户当前输入直接探测，不写安全存储、不写后端 SSOT、不发布配置）。只有
 * 草稿测试成功后才允许保存/发布。因此当草稿测试失败（reject）时：
 * - `saveCredentials` 绝不能被调用（凭据没进安全存储）；
 * - `saveCloudConfigSsot` 绝不能被调用（后端 SSOT 未变）；
 * - `publishCloudConfig` 绝不能被调用（配置未发布）；
 * - localStorage 的 UI 缓存（cloud_storage_config_v2）保持为空。
 *
 * 【为什么修复前应红】旧 doTestConnection（CloudStorageSection.tsx）的顺序是
 * 「先 save 再 check」：saveCredentials → saveCloudConfigSsot（成功后还写
 * localStorage）→ checkConnection。即使连接测试最终失败，凭据与 SSOT 已经
 * 被一个失败的配置污染。在旧实现下本用例会在
 * `expect(saveCredentials).not.toHaveBeenCalled()` 处失败（红），且
 * `testConnectionDraft` 根本不会被调用。
 *
 * 【修复后应绿】新路径先调 testConnectionDraft(草稿配置)，reject 后直接报错
 * 返回，三个持久化入口全部未被触碰。本轮只写测试不执行。
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// 与 CloudStorageSection.cloudUi.test.tsx 相同的稳定身份 t mock：
// 组件的加载 useEffect 依赖 t，全局 mock 每次渲染换新 t 会造成无限重渲染。
vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  const translation = { t, i18n: { language: 'zh-CN', changeLanguage: () => Promise.resolve(), t } };
  return {
    useTranslation: () => translation,
    initReactI18next: { type: '3rdParty', init: () => {} },
  };
});

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/api/tauriClient', () => ({
  parseCommandErrorEnvelope: vi.fn(() => null),
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

// 整体替换 cloudStorageApi：除组件现用的 API 外，额外提供修复后新增的
// `testConnectionDraft`（草稿连接测试，不落盘）与 `publishCloudConfig`
// （测试成功后的发布入口）。修复前组件不会 import/调用这两个名字——这正是
// 红灯的一部分。
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
  // ↓ 修复后新增的两个 API（红灯靶点）
  testConnectionDraft: vi.fn(),
  publishCloudConfig: vi.fn(),
  getSyncStatus: vi.fn(),
  listVersions: vi.fn(),
  uploadBackup: vi.fn(),
  downloadBackup: vi.fn(),
  deleteVersion: vi.fn(),
  requiresInsecureTransportOptIn: vi.fn(() => false),
  isPublicHttpEndpoint: vi.fn(() => false),
  formatFileSize: (n: number) => `${n}B`,
  formatTimestamp: (n: number) => String(n),
  getCloudPlatformErrorI18nKey: () => undefined,
  findCloudBackupVersion: () => undefined,
  isKnownPortableCloudBackup: () => false,
}));

vi.mock('@/components/ui/DsDialog', () => ({
  DsAlertDialog: ({ open, title, description, confirmText, onConfirm, children }: any) =>
    open ? (
      <div role="alertdialog">
        <div>{title}</div>
        <div>{description}</div>
        {children}
        <button type="button" onClick={onConfirm}>{confirmText}</button>
      </div>
    ) : null,
}));

import { CloudStorageSection } from '../CloudStorageSection';
import * as cloudApi from '@/utils/cloudStorageApi';
import { showGlobalNotification } from '@/components/UnifiedNotification';

// 真实模块（修复前）尚未导出 draft/publish 两个名字；通过类型拓宽访问
// mock 工厂里的对应 vi.fn()，避免编译期依赖尚未落地的实现签名。
type DraftAwareCloudApi = typeof cloudApi & {
  testConnectionDraft: (config: cloudApi.CloudStorageConfig) => Promise<unknown>;
  publishCloudConfig: (config: cloudApi.CloudStorageConfig) => Promise<unknown>;
};
const draftApi = cloudApi as DraftAwareCloudApi;

const componentSource = readFileSync(
  resolve(process.cwd(), 'src/features/settings/components/CloudStorageSection.tsx'),
  'utf-8',
);

async function fillValidWebdavForm(): Promise<void> {
  fireEvent.change(
    await screen.findByPlaceholderText('cloudStorage:webdav.endpointPlaceholder'),
    { target: { value: 'https://dav.example.test' } },
  );
  fireEvent.change(
    screen.getByPlaceholderText('cloudStorage:webdav.usernamePlaceholder'),
    { target: { value: 'student' } },
  );
  fireEvent.change(
    screen.getByPlaceholderText('cloudStorage:webdav.passwordPlaceholder'),
    { target: { value: 'webdav-secret' } },
  );
}

describe('CloudStorageSection draft connection test keeps SSOT untouched on failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  test('a failing connection test persists nothing: no credentials, no SSOT, no publish', async () => {
    // 修复后的路径：草稿测试直接 reject
    vi.mocked(draftApi.testConnectionDraft).mockRejectedValue(
      new Error('E_CONNECTION_FAILED: unreachable endpoint'),
    );
    // 旧路径兜底桩：若组件仍走旧 doTestConnection（先 save 再 check），让
    // save 系列都「成功」、check 失败——这样红灯会精确落在下面的
    // not.toHaveBeenCalled() 断言上，而不是提前抛错掩盖问题。
    vi.mocked(cloudApi.saveCredentials).mockResolvedValue({
      webdavPasswordConfigured: true,
      s3SecretAccessKeyConfigured: false,
      ftpPasswordConfigured: false,
      encryptionPasswordConfigured: false,
    });
    vi.mocked(cloudApi.saveCloudConfigSsot).mockResolvedValue({
      configured: true,
      config: {
        provider: 'webdav',
        webdav: { endpoint: 'https://dav.example.test', username: 'student' },
      },
    } as never);
    vi.mocked(cloudApi.checkConnection).mockRejectedValue(
      new Error('E_CONNECTION_FAILED: unreachable endpoint'),
    );

    render(<CloudStorageSection />);
    await fillValidWebdavForm();

    fireEvent.click(
      screen.getByRole('button', { name: 'cloudStorage:actions.testConnection' }),
    );

    // 无论新旧路径，失败最终都会以 error 通知收尾——以此作为流程结束信号
    await waitFor(() => {
      expect(vi.mocked(showGlobalNotification)).toHaveBeenCalledWith(
        'error',
        expect.any(String),
      );
    });

    // ===== 核心断言：连接测试失败时 SSOT 必须一字未动 =====
    // 修复前（旧 doTestConnection 先 save 再 check）：saveCredentials 与
    // saveCloudConfigSsot 都已被调用、localStorage 已被写入 → 本用例红。
    expect(cloudApi.saveCredentials).not.toHaveBeenCalled();
    expect(cloudApi.saveCloudConfigSsot).not.toHaveBeenCalled();
    expect(draftApi.publishCloudConfig).not.toHaveBeenCalled();
    expect(localStorage.getItem('cloud_storage_config_v2')).toBeNull();

    // 修复后：失败来自草稿测试本身（恰被调用一次）
    expect(draftApi.testConnectionDraft).toHaveBeenCalledTimes(1);
  });

  test('source contract: the test-connection path routes through testConnectionDraft', () => {
    // 修复前组件源码没有 testConnectionDraft（红）；修复后测试连接必须
    // 引用草稿测试入口，且不得在测试路径里保留「先 save 再 check」的顺序。
    expect(componentSource).toContain('testConnectionDraft');
  });
});
