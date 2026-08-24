/**
 * CloudStorageSection E2EE 覆盖与失败人话测试（R09-ux）
 *
 * 覆盖（与既有 CloudStorageSection.cloudUi.test.tsx 不重复）：
 * 1. E2EE 文案契约：加密说明覆盖整包 ZIP + 记录级 + 文件级全链路，
 *    并诚实说明明文遗留对象会被拒绝下载；停用通知不承诺明文上传；
 * 2. 安全存储读失败 → role=alert 的人话横幅（不静默、不改动现有凭据）；
 * 3. 清除配置后端部分失败 → 界面缓存仍清、以 configClearPartial 人话上报；
 * 4. 源码契约：恢复/删除版本确认框仍接线且用 warning/danger 变体。
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// ============================================================================
// Mocks
// ============================================================================

// 稳定身份 t：CloudStorageSection 的加载 useEffect 依赖 t，全局 mock 会无限重渲染
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
  getCloudPlatformErrorI18nKey: () => undefined,
}));

vi.mock('@/components/ui/DsDialog', () => ({
  DsAlertDialog: ({ open, title, confirmText, onConfirm, children }: any) =>
    open ? (
      <div role="alertdialog">
        <div>{title}</div>
        {children}
        <button type="button" onClick={onConfirm}>
          {confirmText}
        </button>
      </div>
    ) : null,
}));

import { CloudStorageSection } from '@/features/settings/components/CloudStorageSection';
import * as cloudApi from '@/utils/cloudStorageApi';

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
const dashboardSource = readFileSync(
  resolve(
    process.cwd(),
    'src/features/settings/components/DataGovernanceDashboard.tsx',
  ),
  'utf-8',
);
const zhLocale = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/locales/zh-CN/cloudStorage.json'), 'utf-8'),
);
const enLocale = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/locales/en-US/cloudStorage.json'), 'utf-8'),
);

beforeEach(() => {
  vi.clearAllMocks();
  mockParseEnvelope.mockReturnValue(null);
  localStorage.clear();
});

// ============================================================================
// E2EE 文案覆盖契约
// ============================================================================

describe('CloudStorageSection E2EE 覆盖文案', () => {
  it('zh/en 加密说明覆盖整包 ZIP、记录级与文件级对象全链路', () => {
    expect(zhLocale.encryption.description).toContain('整包 ZIP');
    expect(zhLocale.encryption.description).toContain('记录级');
    expect(zhLocale.encryption.description).toContain('文件级对象');
    expect(zhLocale.encryption.description).toContain('AES-256-GCM');
    expect(enLocale.encryption.description).toMatch(/full ZIP backups/i);
    expect(enLocale.encryption.description).toMatch(/record-level/i);
    expect(enLocale.encryption.description).toMatch(/file-level/i);
    expect(enLocale.encryption.description).toContain('AES-256-GCM');
  });

  it('zh/en 诚实说明明文遗留对象会被拒绝下载并给出迁移路径', () => {
    expect(zhLocale.encryption.description).toContain('明文遗留对象');
    expect(zhLocale.encryption.description).toContain('拒绝下载');
    expect(zhLocale.encryption.description).toContain('重新同步');
    expect(enLocale.encryption.description).toMatch(/legacy plaintext objects/i);
    expect(enLocale.encryption.description).toMatch(/rejected on download/i);
    expect(enLocale.encryption.description).toMatch(/re-sync/i);
  });

  it('停用通知诚实：有加密标记的根目录绝不静默降级为明文上传', () => {
    expect(zhLocale.encryption.disabledNotice).toContain('不会以明文上传');
    expect(zhLocale.encryption.disabledNotice).toContain('拒绝');
    expect(enLocale.encryption.disabledNotice).toMatch(/rejected/i);
    expect(enLocale.encryption.disabledNotice).toMatch(
      /instead of uploaded unencrypted/i,
    );
  });

  it('拒绝保存短于 8 字符的云端 E2EE 密码，避免徽章冒充已配置', () => {
    expect(componentSource).toContain('cloudStorage:encryption.tooShort');
    expect(componentSource).toContain('isExplicitCloudEncryptionPasswordTooShort');
    expect(componentSource).toContain('CLOUD_ENCRYPTION_PASSWORD_MIN_CHARS');

    const saveStart = componentSource.indexOf('const doSaveConfig = useCallback');
    const saveEnd = componentSource.indexOf('const saveConfig = useCallback', saveStart);
    const saveBlock = componentSource.slice(saveStart, saveEnd);
    expect(saveBlock.indexOf('isExplicitCloudEncryptionPasswordTooShort')).toBeGreaterThan(-1);
    expect(saveBlock.indexOf('isExplicitCloudEncryptionPasswordTooShort')).toBeLessThan(
      saveBlock.indexOf('await cloudApi.saveCredentials'),
    );

    const testStart = componentSource.indexOf('const doTestConnection = useCallback');
    const testEnd = componentSource.indexOf('const handleConfirmInsecureFtpSave = useCallback', testStart);
    const testBlock = componentSource.slice(testStart, testEnd);
    expect(testBlock.indexOf('isExplicitCloudEncryptionPasswordTooShort')).toBeGreaterThan(-1);
    expect(testBlock.indexOf('isExplicitCloudEncryptionPasswordTooShort')).toBeLessThan(
      testBlock.indexOf('setTesting(true)'),
    );
    expect(testBlock.indexOf('isExplicitCloudEncryptionPasswordTooShort')).toBeLessThan(
      testBlock.indexOf('await cloudApi.saveCredentials'),
    );
    expect(testBlock).toContain('cloudStorage:messages.configSavedButCredentialsFailed');
    expect(testBlock).toContain('cloudStorage:messages.configSsotFailed');
    expect(testBlock).toContain('cloudStorage:errors.connectionFailed');
    expect(testBlock.indexOf('configSavedButCredentialsFailed')).toBeLessThan(
      testBlock.indexOf('errors.connectionFailed'),
    );

    const uploadStart = componentSource.indexOf('const handleBackupAndUpload = useCallback');
    const uploadEnd = componentSource.indexOf('const openRestoreConfirm = useCallback', uploadStart);
    const uploadBlock = componentSource.slice(uploadStart, uploadEnd);
    expect(uploadBlock.indexOf('isExplicitCloudEncryptionPasswordTooShort')).toBeGreaterThan(-1);
    expect(uploadBlock.indexOf('isExplicitCloudEncryptionPasswordTooShort')).toBeLessThan(
      uploadBlock.indexOf('setUploading(true)'),
    );

    const restoreStart = componentSource.indexOf('const performRestore = useCallback');
    const restoreEnd = componentSource.indexOf('const handleRestore = useCallback', restoreStart);
    const restoreBlock = componentSource.slice(restoreStart, restoreEnd);
    expect(restoreBlock.indexOf('isExplicitCloudEncryptionPasswordTooShort')).toBeGreaterThan(-1);
    expect(restoreBlock.indexOf('isExplicitCloudEncryptionPasswordTooShort')).toBeLessThan(
      restoreBlock.indexOf('setDownloading(true)'),
    );

    expect(componentSource).toContain('localizeCloudStorageError');
    expect(localizeSource).toContain('云端端到端加密密码至少需要');
    expect(localizeSource).toContain('备份密码至少需要');
    expect(componentSource).toContain("packageZipFailed', { error: localizeCloudError(e) }");
    expect(componentSource).toContain("importZipFailed', { error: localizeCloudError(e) }");

    expect(zhLocale.encryption.tooShort).toContain('至少需要');
    expect(zhLocale.encryption.tooShort).toContain('Unicode 码点');
    expect(zhLocale.encryption.tooShort).toContain('不会保存');
    expect(enLocale.encryption.tooShort).toMatch(/at least \{\{min\}\} Unicode characters/i);
    expect(enLocale.encryption.tooShort).toMatch(/code points/i);
    expect(enLocale.encryption.tooShort).toMatch(/will not be saved/i);
    expect(localizeSource).toContain('无法整槽恢复的便携归档当成加密全保真');
    expect(localizeSource).toContain('cloudStorage:encryption.storedPasswordRequired');
    expect(zhLocale.encryption.storedPasswordRequired).toContain('便携归档');
    expect(enLocale.encryption.storedPasswordRequired).toMatch(/portable archive/i);
    expect(localizeSource).toContain('Missing WebDAV configuration');
    expect(localizeSource).toContain('cloudStorage:errors.missingWebdavConfig');
    expect(localizeSource).toContain('cloudStorage:errors.missingS3Config');
    expect(localizeSource).toContain('cloudStorage:errors.missingFtpConfig');
    expect(Object.keys(zhLocale.encryption).sort()).toEqual(
      Object.keys(enLocale.encryption).sort(),
    );
    expect(Object.keys(zhLocale.errors).sort()).toEqual(
      Object.keys(enLocale.errors).sort(),
    );
    expect(
      (dashboardSource.match(/localizeCloudStorageError\(error, t\)/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================================
// 安全存储失败人话
// ============================================================================

describe('CloudStorageSection 安全存储失败人话', () => {
  it('凭据读取失败（SECURE_STORE_*）→ role=alert 横幅 + warning 通知', async () => {
    vi.mocked(cloudApi.getCredentialStatus).mockRejectedValue(
      new Error('SECURE_STORE_READ_FAILED: keyring unavailable'),
    );
    mockParseEnvelope.mockReturnValue({
      code: 'SECURE_STORE_READ_FAILED',
      message: 'keyring unavailable',
    });

    render(<CloudStorageSection />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('cloudStorage:messages.secureStoreIssueTitle');
    expect(alert).toHaveTextContent('cloudStorage:messages.secureStoreReadFailed');
    expect(mockShowGlobalNotification).toHaveBeenCalledWith(
      'warning',
      'cloudStorage:messages.secureStoreReadFailed',
    );
  });

  it('人话文案不空且写明凭据未被修改（zh/en）', () => {
    expect(zhLocale.messages.secureStoreReadFailed).toContain('未被修改');
    expect(enLocale.messages.secureStoreReadFailed).toMatch(/not changed/i);
    expect(zhLocale.messages.secureStoreWriteFailed).toContain('尚未保存');
    expect(enLocale.messages.secureStoreWriteFailed).toMatch(/not saved/i);
  });
});

// ============================================================================
// 清除配置部分失败
// ============================================================================

describe('CloudStorageSection 清除配置部分失败', () => {
  it('后端清理失败时仍清 UI 缓存，并以 configClearPartial 上报', async () => {
    vi.mocked(cloudApi.clearCloudConfigSsot).mockRejectedValue(
      new Error('backend cleanup failed'),
    );
    localStorage.setItem('cloud_storage_config_v2', '{"provider":"webdav"}');
    localStorage.setItem('cloud_storage_config', '{"legacy":true}');

    render(<CloudStorageSection />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'cloudStorage:actions.clearConfig' }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'cloudStorage:clearConfirm.confirm' }),
    );

    await waitFor(() => {
      expect(mockShowGlobalNotification).toHaveBeenCalledWith(
        'error',
        'cloudStorage:messages.configClearPartial',
      );
    });
    // WebView 本地缓存必须清掉，避免过期凭据被重新引入
    expect(localStorage.getItem('cloud_storage_config_v2')).toBeNull();
    expect(localStorage.getItem('cloud_storage_config')).toBeNull();
    expect(localStorage.getItem('cloud_storage_ssot_migrated')).toBe('1');
  });
});

// ============================================================================
// 整包 ZIP 无增量传输（对外诚实）
// ============================================================================

describe('CloudStorageSection 整包备份诚实文案', () => {
  it('zh/en 在上传入口写明每次都是完整 ZIP 单对象，没有增量/去重/CDC', () => {
    expect(zhLocale.actions.fullZipHint).toContain('完整 ZIP');
    expect(zhLocale.actions.fullZipHint).toContain('单个对象');
    expect(zhLocale.actions.fullZipHint).toContain('没有增量传输');
    expect(zhLocale.actions.fullZipHint).toContain('去重');
    expect(zhLocale.actions.fullZipHint).toContain('CDC');
    expect(zhLocale.actions.fullZipHint).toContain('拒绝导出');
    expect(zhLocale.actions.fullZipHint).toContain('不会套用已存密码');
    expect(enLocale.actions.fullZipHint).toMatch(/full ZIP/i);
    expect(enLocale.actions.fullZipHint).toMatch(/single object/i);
    expect(enLocale.actions.fullZipHint).toMatch(/no incremental transfer/i);
    expect(enLocale.actions.fullZipHint).toMatch(/deduplication/i);
    expect(enLocale.actions.fullZipHint).toContain('CDC');
    expect(enLocale.actions.fullZipHint).toMatch(/export is refused/i);
    expect(enLocale.actions.fullZipHint).toMatch(/will not apply the stored password/i);
    expect(Object.keys(zhLocale.actions).sort()).toEqual(Object.keys(enLocale.actions).sort());
  });

  it('上传按钮旁挂载 fullZipHint，且不接线 backup-v2 / delta 积木', () => {
    expect(componentSource).toContain("t('cloudStorage:actions.fullZipHint')");
    expect(componentSource).not.toMatch(/delta_upload|publish_verified_staging|backup-v2/);
  });
});

describe('用户指南 16 不把默认云端整包写成可换机', () => {
  const guide = readFileSync(
    resolve(process.cwd(), 'docs/user-guide/16-数据管理与云同步.md'),
    'utf-8',
  );

  it('按是否配置 E2EE 密码分述云端整包，并不再说适合迁移学习数据', () => {
    expect(guide).toContain('未配置云端端到端加密密码');
    expect(guide).toContain('**不会**带备份密码');
    expect(guide).toContain('加密全保真 ZIP');
    expect(guide).toContain('校验会明确拒绝，不会覆盖当前数据');
    expect(guide).toContain('拒绝导出');
    expect(guide).toContain('不会套用已存密码');
    expect(guide).toContain('至少 **8** 个字符');
    expect(guide).toContain('Unicode 码点');
    expect(guide).toContain('拒绝保存');
    expect(guide).not.toContain('产物永远是便携归档');
    expect(guide).not.toContain('适合迁移学习数据本身');
    expect(guide).not.toContain('也可以走云端：老设备「立即备份到云端」');
  });

  it('写明坚果云中文路径与 S3 控制台 bucket 前缀域名', () => {
    expect(guide).toContain('我的坚果云');
    expect(guide).toContain('静默列空');
    expect(guide).toContain('bucket.bucket');
  });
});

// ============================================================================
// 危险操作确认源码契约
// ============================================================================

describe('CloudStorageSection 危险操作确认接线（源码契约）', () => {
  it('恢复版本必须经 warning 确认框（含覆盖警告、便携归档限制与校验后重启）', () => {
    expect(componentSource).toContain("title={t('cloudStorage:download.confirmTitle')}");
    expect(componentSource).toContain("t('cloudStorage:download.warning')");
    expect(componentSource).toContain("t('cloudStorage:download.partialArchiveNotice')");
    expect(componentSource).toContain("t('cloudStorage:download.restartNotice')");
    expect(componentSource).toContain('useStoredCloudEncryptionPassword');
    expect(componentSource).toContain('resolveCloudZipEncryptionArgs');
    expect(componentSource).toContain('DataGovernanceApi.exportZip(');
    expect(componentSource).toContain('DataGovernanceApi.importZip(');
    expect(componentSource).not.toMatch(/exportZip\(\s*backupId\s*\)/);
    expect(componentSource).not.toMatch(/importZip\(\s*downloadResult\.localPath\s*\)/);
    expect(componentSource).not.toMatch(/getCloudCredentials\(|secure_get_cloud_credentials/);
    expect(componentSource).toContain('onConfirm={handleRestore}');
    // 恢复确认框用 warning 变体
    expect(componentSource).toMatch(
      /download\.confirmTitle'\)\}[\s\S]{0,400}confirmVariant="warning"/,
    );
    expect(zhLocale.download.partialArchiveNotice).toContain('便携归档');
    expect(zhLocale.download.partialArchiveNotice).toContain('整槽恢复');
    expect(zhLocale.download.partialArchiveNotice).toContain('未配置');
    expect(zhLocale.download.partialArchiveNotice).toContain('加密全保真');
    expect(zhLocale.download.partialArchiveNotice).toContain('拒绝导出');
    expect(zhLocale.download.partialArchiveNotice).toContain('不会套用已存密码');
    expect(zhLocale.download.partialArchiveNotice).not.toContain('永远是便携归档');
    expect(zhLocale.download.description).toContain('未配置云端端到端加密密码');
    expect(zhLocale.download.warning).toContain('通过整槽恢复校验');
    expect(zhLocale.download.restartNotice).toContain('通过整槽恢复校验');
    expect(enLocale.download.partialArchiveNotice).toMatch(/portable archive/i);
    expect(enLocale.download.partialArchiveNotice).toMatch(/full-fidelity/i);
    expect(enLocale.download.partialArchiveNotice).toMatch(/export is refused/i);
    expect(enLocale.download.partialArchiveNotice).toMatch(/will not apply the stored password/i);
    expect(enLocale.download.partialArchiveNotice).not.toMatch(/always exports/i);
    expect(enLocale.download.description).toMatch(/without a cloud end-to-end encryption password/i);
    expect(enLocale.download.warning).toMatch(/only after slot-restore validation/i);
    expect(enLocale.download.restartNotice).toMatch(/slot-restore validation/i);
    expect(Object.keys(zhLocale.download).sort()).toEqual(Object.keys(enLocale.download).sort());
  });

  it('删除版本 / 清除配置 / 停用加密均为 danger 确认框', () => {
    expect(componentSource).toContain('onConfirm={handleDeleteVersion}');
    expect(componentSource).toMatch(
      /history\.deleteConfirm'\)\}[\s\S]{0,300}confirmVariant="danger"/,
    );
    expect(componentSource).toMatch(
      /clearConfirm\.title'\)\}[\s\S]{0,400}confirmVariant="danger"/,
    );
    expect(componentSource).toMatch(
      /encryption\.disableConfirm\.title'\)\}[\s\S]{0,400}confirmVariant="danger"/,
    );
    // 停用加密只走专用 API，不误伤传输凭据
    expect(componentSource).toContain('clearEncryptionPassword');
  });
});
