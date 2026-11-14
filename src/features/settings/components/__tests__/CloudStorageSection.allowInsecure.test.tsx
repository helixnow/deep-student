/**
 * 发布成功后，表单按后端 DTO 的 `allow_insecure` 恢复“已允许明文传输”的状态，
 * 并显示持久化风险提示（RF-W09-cloud-config-allow-insecure-wire-key）。
 * 判定函数（requiresInsecureTransportOptIn 等）用真实实现，只替换 IPC 包装。
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

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

const noCredentials = {
  webdavPasswordConfigured: false,
  s3SecretAccessKeyConfigured: false,
  ftpPasswordConfigured: false,
  encryptionPasswordConfigured: false,
};

vi.mock('@/utils/cloudStorageApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/cloudStorageApi')>()),
  isS3Enabled: vi.fn(async () => true),
  resolveCloudStorageConfig: vi.fn(async () => null),
  getCredentialStatus: vi.fn(async () => noCredentials),
  getDeviceId: vi.fn(async () => 'device-test'),
  testConnectionDraft: vi.fn(),
  publishCloudConfig: vi.fn(),
  getSyncStatus: vi.fn(async () => { throw new Error('offline'); }),
  listVersions: vi.fn(async () => []),
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

const LAN_ENDPOINT = 'http://192.168.1.10/dav';

describe('CloudStorageSection insecure-transport opt-in round trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  test('RF-W09-cloud-config-allow-insecure-wire-key: after publish the persisted allow_insecure keeps the risk banner on', async () => {
    vi.mocked(cloudApi.publishCloudConfig).mockResolvedValue({
      ok: true,
      generation: 1,
      provider: 'webdav',
      config: {
        provider: 'webdav',
        webdav: { endpoint: LAN_ENDPOINT, username: 'student' },
        allow_insecure: true,
      },
    });

    render(<CloudStorageSection />);
    fireEvent.change(
      await screen.findByPlaceholderText('cloudStorage:webdav.endpointPlaceholder'),
      { target: { value: LAN_ENDPOINT } },
    );
    fireEvent.change(
      screen.getByPlaceholderText('cloudStorage:webdav.usernamePlaceholder'),
      { target: { value: 'student' } },
    );
    fireEvent.change(
      screen.getByPlaceholderText('cloudStorage:webdav.passwordPlaceholder'),
      { target: { value: 'webdav-secret' } },
    );

    fireEvent.click(screen.getByRole('button', { name: 'cloudStorage:actions.save' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(
      Array.from(dialog.querySelectorAll('button'))
        .find(button => button.textContent === 'cloudStorage:webdav.insecureWarning.confirm')!,
    );

    await waitFor(() => expect(cloudApi.publishCloudConfig).toHaveBeenCalledTimes(1));
    expect(vi.mocked(cloudApi.publishCloudConfig).mock.calls[0][0]).toMatchObject({
      provider: 'webdav',
      allowInsecure: true,
    });
    await waitFor(() => {
      const banners = screen.queryAllByRole('alert')
        .filter(el => el.textContent?.includes('cloudStorage:webdav.insecureWarning.description'));
      expect(banners).toHaveLength(1);
    });
    expect(JSON.parse(localStorage.getItem('cloud_storage_config_v2')!)).toMatchObject({
      allow_insecure: true,
    });
  });
});
