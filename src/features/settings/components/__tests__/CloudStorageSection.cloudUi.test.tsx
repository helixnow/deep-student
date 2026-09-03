/**
 * CloudStorageSection 云同步 UI 契约测试（R02-cloud-ui）
 *
 * 覆盖：
 * 1. 「清除配置」必须经 danger 确认框确认后才执行；
 * 2. Android/移动端不展示可用的 FTP 选项（复用 S3 禁用卡片模式）；
 * 3. 源码契约：失败重试按钮、「关闭」走 i18n、恢复重启预告文案。
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// 全局 react-i18next mock 每次渲染都会创建新的 t 函数，而 CloudStorageSection 的
// 加载 useEffect 依赖 t，会造成无限重渲染。这里用稳定身份的 t 覆盖，行为等价于
// 真实 react-i18next（t 引用跨渲染稳定），断言使用原始 key。
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

const platformState = { mobile: false };
vi.mock('@/utils/platform', () => ({
  isAndroid: vi.fn(() => platformState.mobile),
  isMobilePlatform: vi.fn(() => platformState.mobile),
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
  clearEncryptionPassword: vi.fn(async () => ({
    webdavPasswordConfigured: false,
    s3SecretAccessKeyConfigured: false,
    ftpPasswordConfigured: false,
    encryptionPasswordConfigured: false,
  })),
  saveCredentials: vi.fn(),
  saveCloudConfigSsot: vi.fn(),
  testConnectionDraft: vi.fn(),
  publishCloudConfig: vi.fn(),
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
  findCloudBackupVersion: () => undefined,
  isKnownPortableCloudBackup: () => false,
}));

// 轻量 DsAlertDialog 桩：只验证「打开才渲染 + 确认才回调」的行为契约
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

describe('CloudStorageSection cloud UI guarantees', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platformState.mobile = false;
    localStorage.clear();
  });

  test('clearing the configuration requires explicit confirmation in a danger dialog', async () => {
    render(<CloudStorageSection />);

    const clearButton = await screen.findByRole('button', {
      name: 'cloudStorage:actions.clearConfig',
    });
    fireEvent.click(clearButton);

    // 第一次点击只打开确认框，绝不直接清除
    expect(cloudApi.clearCloudConfigSsot).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('cloudStorage:clearConfirm.title');
    expect(dialog).toHaveTextContent('cloudStorage:clearConfirm.description');
    expect(dialog).toHaveTextContent('cloudStorage:clearConfirm.encryptionWarning');
    expect(dialog).toHaveTextContent('cloudStorage:clearConfirm.cloudFilesKept');

    fireEvent.click(
      screen.getByRole('button', { name: 'cloudStorage:clearConfirm.confirm' }),
    );

    await waitFor(() => {
      expect(cloudApi.clearCloudConfigSsot).toHaveBeenCalledTimes(1);
    });
  });

  test('encryption status is surfaced and the disable action is hidden when not configured', async () => {
    render(<CloudStorageSection />);

    // 默认（未加密）：展示未加密徽标，不提供停用入口
    expect(
      await screen.findByText('cloudStorage:encryption.statusNotConfigured'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('cloudStorage:encryption.statusConfigured'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'cloudStorage:encryption.disableAction' }),
    ).not.toBeInTheDocument();
    // placeholder 与真实语义一致：未配置时提示输入以启用
    expect(
      screen.getByPlaceholderText('cloudStorage:encryption.placeholderUnset'),
    ).toBeInTheDocument();
  });

  test('disabling e2ee requires explicit confirmation and only clears the encryption password', async () => {
    vi.mocked(cloudApi.getCredentialStatus).mockResolvedValue({
      webdavPasswordConfigured: true,
      s3SecretAccessKeyConfigured: false,
      ftpPasswordConfigured: false,
      encryptionPasswordConfigured: true,
    });
    render(<CloudStorageSection />);

    // 已配置：展示已配置徽标 + 「留空保持不变」的 placeholder
    expect(
      await screen.findByText('cloudStorage:encryption.statusConfigured'),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('cloudStorage:encryption.placeholderConfigured'),
    ).toBeInTheDocument();

    const disableButton = screen.getByRole('button', {
      name: 'cloudStorage:encryption.disableAction',
    });
    fireEvent.click(disableButton);

    // 第一次点击只打开确认框，绝不直接删除加密密码
    expect(cloudApi.clearEncryptionPassword).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('cloudStorage:encryption.disableConfirm.title');
    expect(dialog).toHaveTextContent(
      'cloudStorage:encryption.disableConfirm.existingBackupsWarning',
    );
    expect(dialog).toHaveTextContent(
      'cloudStorage:encryption.disableConfirm.futureUploadsPlaintext',
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'cloudStorage:encryption.disableConfirm.confirm' }),
    );

    await waitFor(() => {
      expect(cloudApi.clearEncryptionPassword).toHaveBeenCalledTimes(1);
    });
    // 停用走专用 API，绝不通过「清除全部配置」误伤传输凭据
    expect(cloudApi.clearCloudConfigSsot).not.toHaveBeenCalled();

    // 状态回落为未加密，停用按钮消失
    await waitFor(() => {
      expect(
        screen.getByText('cloudStorage:encryption.statusNotConfigured'),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('button', { name: 'cloudStorage:encryption.disableAction' }),
    ).not.toBeInTheDocument();
  });

  test('encryption placeholder copy matches the merge-save semantics', () => {
    // 已配置态必须说明「留空 = 保留现有密码」，未配置态说明「输入以启用」；
    // 旧的单一 placeholder（"留空则不加密"）在已配置态下是错误语义，禁止回归。
    expect(componentSource).not.toContain("t('cloudStorage:encryption.placeholder')");
    expect(componentSource).toContain('encryptionPasswordConfigured');
    for (const locale of [zhLocale, enLocale]) {
      expect(String(locale.encryption.placeholderConfigured).length).toBeGreaterThan(0);
      expect(String(locale.encryption.placeholderUnset).length).toBeGreaterThan(0);
      expect(locale.encryption.placeholder).toBeUndefined();
    }
    expect(zhLocale.encryption.placeholderConfigured).toContain('留空保持');
    expect(zhLocale.encryption.placeholderUnset).toContain('启用');
    expect(zhLocale.encryption.disableConfirm.existingBackupsWarning).toContain('无法解密');
    expect(zhLocale.encryption.disableConfirm.description).toContain('不受影响');
    expect(enLocale.encryption.placeholderConfigured).toMatch(/keep/i);
    expect(enLocale.encryption.disableConfirm.existingBackupsWarning).toMatch(/undecryptable|cannot/i);
  });

  test('mobile platforms do not expose a usable FTP provider option', async () => {
    platformState.mobile = true;
    render(<CloudStorageSection />);

    const ftpCard = await screen.findByRole('button', {
      name: /cloudStorage:provider\.ftpDisabledMobile/,
    });
    expect(ftpCard).toBeDisabled();
    // 禁用态展示移动端说明，而非实验性描述
    expect(
      screen.queryByText('cloudStorage:provider.ftpDescExperimental'),
    ).not.toBeInTheDocument();
  });

  test('desktop platforms keep the FTP option selectable', async () => {
    render(<CloudStorageSection />);

    const ftpCard = await screen.findByRole('button', {
      name: /cloudStorage:provider\.ftpDescExperimental/,
    });
    expect(ftpCard).toBeEnabled();
    expect(
      screen.queryByText('cloudStorage:provider.ftpDisabledMobile'),
    ).not.toBeInTheDocument();
  });

  test('failure panel offers retry and uses i18n for the close action', () => {
    // 硬编码「关闭」按钮已替换为 i18n；错误面板必须提供重试入口
    expect(componentSource).toContain("t('common:actions.retry')");
    expect(componentSource).toContain("t('common:actions.close')");
    expect(componentSource).not.toMatch(/>\s*关闭\s*</);
    expect(componentSource).toContain('retryFailedOperation');
    expect(componentSource).toContain('lastRestoreVersionIdRef');
  });

  test('restore flow announces the automatic restart before and after confirmation', () => {
    expect(componentSource).toContain("t('cloudStorage:download.restartNotice')");
    expect(componentSource).toContain("t('cloudStorage:download.successRestart')");
    for (const locale of [zhLocale, enLocale]) {
      expect(String(locale.download.restartNotice).length).toBeGreaterThan(0);
      expect(String(locale.download.successRestart)).toMatch(/重启|restart/i);
    }
    expect(zhLocale.download.restartNotice).toContain('重启');
    expect(zhLocale.download.successRestart).toContain('重启');
  });

  test('a short encryption password asks for preexisting confirmation instead of hard-blocking the save', async () => {
    // clearAllMocks 不会还原 mockResolvedValue 的实现，显式回到未配置态
    vi.mocked(cloudApi.getCredentialStatus).mockResolvedValue({
      webdavPasswordConfigured: false,
      s3SecretAccessKeyConfigured: false,
      ftpPasswordConfigured: false,
      encryptionPasswordConfigured: false,
    });
    // [R2 配置事务边界] 保存改走 cloud_config_publish 单逻辑提交；
    // 返回形状与后端 CloudConfigPublishResponse 对齐（无 secret、无旗标，
    // 凭据存在旗标由前端另行只读刷新）。
    vi.mocked(cloudApi.publishCloudConfig).mockResolvedValue({
      ok: true,
      generation: 1,
      provider: 'webdav',
      config: {
        provider: 'webdav',
        webdav: { endpoint: 'https://dav.example.test', username: 'student' },
      },
    } as never);
    // 发布成功后的状态/版本刷新
    vi.mocked(cloudApi.getSyncStatus).mockResolvedValue({
      connected: true,
      cloudVersionCount: 0,
    } as never);
    vi.mocked(cloudApi.listVersions).mockResolvedValue([] as never);
    render(<CloudStorageSection />);

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
    // v0.9.44 时代的 6 位存量口令
    fireEvent.change(
      screen.getByPlaceholderText('cloudStorage:encryption.placeholderUnset'),
      { target: { value: 'short6' } },
    );

    fireEvent.click(screen.getByRole('button', { name: 'cloudStorage:actions.save' }));

    // 不再硬拒绝：先弹「这是旧口令吗」确认框，且尚未提交任何凭据/发布
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('cloudStorage:encryption.preexistingShortConfirm.title');
    expect(cloudApi.publishCloudConfig).not.toHaveBeenCalled();
    expect(cloudApi.saveCredentials).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'cloudStorage:encryption.preexistingShortConfirm.confirm',
      }),
    );

    // 确认后按「存量口令」发布，绕过新设口令的最小长度准入。
    // 发布是 cloud_config_publish 单逻辑提交：配置+凭据+preexisting 旗标
    // 一次上送，不再经过旧的两段写（saveCredentials → saveCloudConfigSsot）。
    await waitFor(() => {
      expect(cloudApi.publishCloudConfig).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'webdav', encryptionPassword: 'short6' }),
        expect.objectContaining({
          webdavPassword: 'webdav-secret',
          encryptionPassword: 'short6',
        }),
        { encryptionPasswordIsPreexisting: true },
      );
    });
    expect(cloudApi.saveCredentials).not.toHaveBeenCalled();
    expect(cloudApi.saveCloudConfigSsot).not.toHaveBeenCalled();
  });

  test('testing a connection goes through the draft command and never persists, even on failure', async () => {
    vi.mocked(cloudApi.getCredentialStatus).mockResolvedValue({
      webdavPasswordConfigured: false,
      s3SecretAccessKeyConfigured: false,
      ftpPasswordConfigured: false,
      encryptionPasswordConfigured: false,
    });
    // 草稿试连被后端拒绝（如凭据错误 / 服务器不可达）
    vi.mocked(cloudApi.testConnectionDraft).mockRejectedValue(new Error('draft refused'));
    render(<CloudStorageSection />);

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

    fireEvent.click(
      screen.getByRole('button', { name: 'cloudStorage:actions.testConnection' }),
    );

    await waitFor(() => {
      expect(cloudApi.testConnectionDraft).toHaveBeenCalledTimes(1);
    });
    expect(cloudApi.testConnectionDraft).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'webdav' }),
      expect.objectContaining({ webdavPassword: 'webdav-secret' }),
      { encryptionPasswordIsPreexisting: false },
    );

    // 测试失败必须保持「草稿」：不写安全存储、不发布 SSOT、不走旧的
    // 已发布凭据 hydrate 路径，也不把失败配置写进本地 SSOT 缓存/迁移标记
    expect(cloudApi.saveCredentials).not.toHaveBeenCalled();
    expect(cloudApi.saveCloudConfigSsot).not.toHaveBeenCalled();
    expect(cloudApi.publishCloudConfig).not.toHaveBeenCalled();
    expect(cloudApi.checkConnection).not.toHaveBeenCalled();
    expect(localStorage.getItem('cloud_storage_config_v2')).toBeNull();
    expect(localStorage.getItem('cloud_storage_ssot_migrated')).toBeNull();

    // 表单草稿原样保留，可继续修改后重试
    expect(
      screen.getByPlaceholderText('cloudStorage:webdav.endpointPlaceholder'),
    ).toHaveValue('https://dav.example.test');
    // 三态徽标进入「草稿测试失败」态，明示已发布配置未受影响
    expect(screen.getByTestId('cloud-config-phase')).toHaveTextContent(
      'cloudStorage:phase.draftTestFailed',
    );
  });

  test('restore decrypt path no longer gates legacy short passwords', () => {
    // 恢复是对既有密文的解密：v0.9.44 从未限制口令长度，最小长度校验
    // 只能管「新设」口令。此契约防止换机/重装恢复再次被锁死。
    const restoreStart = componentSource.indexOf('const performRestore = useCallback');
    const restoreEnd = componentSource.indexOf('const handleRestore = useCallback', restoreStart);
    expect(restoreStart).toBeGreaterThan(-1);
    expect(restoreEnd).toBeGreaterThan(restoreStart);
    const restoreBlock = componentSource.slice(restoreStart, restoreEnd);
    expect(restoreBlock).not.toContain('isExplicitCloudEncryptionPasswordTooShort');
    expect(restoreBlock).not.toContain('encryption.tooShort');
    // 云下载已经用 secure-store SSOT 解掉外层 DSBK。导入阶段不得再次透传
    // 输入框里的显式短口令：v0.9.44 解密后是无 portable_secrets.dsbk 的旧 ZIP，
    // 显式口令会被该 ZIP 正确判为“不适用”并导致恢复失败。stored 开关则只在
    // 0824 密封 ZIP 上生效，旧 ZIP 会忽略。
    expect(restoreBlock).not.toContain('const zipArgs = resolveCloudZipEncryptionArgs()');
    expect(restoreBlock).toContain('credentialStatus.encryptionPasswordConfigured || undefined');

    // 上传（新设密文）仍保留最小长度门
    const uploadStart = componentSource.indexOf('const handleBackupAndUpload = useCallback');
    const uploadEnd = componentSource.indexOf('const openRestoreConfirm', uploadStart);
    const uploadBlock = componentSource.slice(uploadStart, uploadEnd);
    expect(uploadBlock).toContain('isExplicitCloudEncryptionPasswordTooShort');

    // 本地加密 ZIP 导入入口同样放行（解密由解封层 fail-closed）
    const backupTabSource = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/data-governance/BackupTab.tsx'),
      'utf-8',
    );
    const importStart = backupTabSource.indexOf('const handleImportConfirm');
    const importEnd = backupTabSource.indexOf('return (', importStart);
    const importBlock = backupTabSource.slice(importStart, importEnd);
    expect(importStart).toBeGreaterThan(-1);
    expect(importBlock).not.toContain('validateOptionalPassword');
    // 导出（新设密文）仍保留校验
    expect(backupTabSource).toContain('validateOptionalPassword(encryptionPassword)');
  });

  test('locale copy explains clear consequences and avoids compile-feature jargon', () => {
    // 清除确认文案必须写明：服务器地址/账号密码/加密密码会删、备份不可解密、云端文件保留
    expect(zhLocale.clearConfirm.description).toContain('服务器地址');
    expect(zhLocale.clearConfirm.description).toContain('密码');
    expect(zhLocale.clearConfirm.encryptionWarning).toContain('无法解密');
    expect(zhLocale.clearConfirm.cloudFilesKept).toContain('不会被删除');
    // s3Disabled 文案面向用户：给出 WebDAV / 桌面 ZIP 导出替代方案，不提「编译 feature」
    expect(zhLocale.provider.s3Disabled).toContain('WebDAV');
    expect(zhLocale.provider.s3Disabled).toContain('ZIP');
    expect(zhLocale.provider.s3Disabled).not.toContain('编译');
    expect(zhLocale.provider.s3Disabled).not.toContain('feature');
    expect(enLocale.provider.s3Disabled).not.toMatch(/compile|feature/i);
    // 移动端 FTP 禁用文案存在且给出 WebDAV 替代
    expect(zhLocale.provider.ftpDisabledMobile).toContain('WebDAV');
    expect(String(enLocale.provider.ftpDisabledMobile)).toContain('WebDAV');
  });
});
