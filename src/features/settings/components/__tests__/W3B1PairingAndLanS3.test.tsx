import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import enSync from '@/locales/en-US/sync.json';
import zhSync from '@/locales/zh-CN/sync.json';

const mockInvoke = vi.hoisted(() => vi.fn());
const mockNotify = vi.hoisted(() => vi.fn());
const mockDetectPruneGap = vi.hoisted(() => vi.fn());
const mockRunSyncWithProgress = vi.hoisted(() => vi.fn());
const mockGetSyncStatus = vi.hoisted(() => vi.fn());

let activeLang = 'en-US';

const translateKey = (key: string, opts?: Record<string, unknown>): string => {
  const dict = activeLang.startsWith('en') ? enSync : zhSync;
  if (key.startsWith('sync:')) {
    const parts = key.slice('sync:'.length).split('.');
    let cur: unknown = dict;
    for (const part of parts) {
      cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined;
    }
    if (typeof cur === 'string') {
      return cur.replace(/\{\{(\w+)\}\}/g, (_m, name) =>
        opts && name in opts ? String(opts[name]) : `{{${name}}}`,
      );
    }
  }
  return key;
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translateKey,
    i18n: {
      get language() {
        return activeLang;
      },
      changeLanguage: async (next: string) => {
        activeLang = next;
      },
    },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mockNotify,
}));

vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: {
    getAppVersion: vi.fn(async () => '0.20.9-test'),
    getAppDataDir: vi.fn(async () => '/tmp/app-data'),
    restartApp: vi.fn(async () => undefined),
  },
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));

vi.mock('@/utils/platform', () => ({
  isAndroid: vi.fn(() => false),
  isMobilePlatform: vi.fn(() => false),
}));

vi.mock('@/api/dataGovernance', () => ({
  DataGovernanceApi: {
    getSyncStatus: mockGetSyncStatus,
    detectPruneGap: mockDetectPruneGap,
    runSyncWithProgress: mockRunSyncWithProgress,
    backupTiered: vi.fn(),
    exportZip: vi.fn(),
    importZip: vi.fn(),
    restoreBackup: vi.fn(),
    checkDiskSpaceForRestore: vi.fn(),
    getBackupJob: vi.fn(),
    cancelBackup: vi.fn(),
  },
}));

vi.mock('@/utils/cloudStorageApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/cloudStorageApi')>()),
  isS3Enabled: vi.fn(async () => true),
  resolveCloudStorageConfig: vi.fn(async () => null),
  getCredentialStatus: vi.fn(async () => ({
    webdavPasswordConfigured: false,
    s3SecretAccessKeyConfigured: false,
    ftpPasswordConfigured: false,
    encryptionPasswordConfigured: false,
  })),
  getDeviceId: vi.fn(async () => 'device-test'),
  testConnectionDraft: vi.fn(),
  publishCloudConfig: vi.fn(),
  clearCloudConfigSsot: vi.fn(async () => ({ configured: false })),
  clearEncryptionPassword: vi.fn(async () => ({
    webdavPasswordConfigured: true,
    s3SecretAccessKeyConfigured: false,
    ftpPasswordConfigured: false,
    encryptionPasswordConfigured: false,
  })),
  getSyncStatus: vi.fn(async () => ({ connected: true, cloudVersionCount: 0 })),
  listVersions: vi.fn(async () => []),
  listFiles: vi.fn(async () => []),
}));

vi.mock('@/components/ui/DsDialog', () => ({
  DsAlertDialog: ({ open, title, description, confirmText, onConfirm, children }: any) =>
    open ? (
      <div role="alertdialog">
        <div>{title}</div>
        <div>{description}</div>
        {children}
        <button type="button" onClick={onConfirm}>
          {confirmText}
        </button>
      </div>
    ) : null,
}));

import { CloudStorageSection } from '../CloudStorageSection';
import { DevicePairingSection, ipcPairingSettings } from '../DevicePairingSection';
import * as cloudApi from '@/utils/cloudStorageApi';
import { useGlobalSyncStore } from '@/stores/syncStatusStore';
import { createPairingCode } from '../../../../../host/plugins/sync/src/device-pairing';

describe('W3B-1 regressions (BUG-2, BUG-5, BUG-6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    activeLang = 'en-US';
    useGlobalSyncStore.getState().endSync();
    mockGetSyncStatus.mockResolvedValue({
      partial: false,
      errors: [],
      has_pending_changes: false,
      total_pending_changes: 0,
      total_synced_changes: 0,
      databases: [],
      last_sync_at: null,
      device_id: 'device-test',
    });
    mockDetectPruneGap.mockResolvedValue({
      has_gap: false,
      since_version: 0,
      min_available_version: null,
      gap_details: null,
    });
    mockRunSyncWithProgress.mockResolvedValue({
      success: true,
      uploaded_changes: 1,
      downloaded_changes: 0,
      conflicts_detected: 0,
      conflicts_resolved: 0,
      skipped_changes: 0,
      error_message: null,
    });
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_setting') return null;
      if (cmd === 'get_settings_by_prefix') return [];
      if (cmd === 'data_governance_pairing_get_cloud_credentials') return null;
      if (cmd === 'data_governance_pairing_save_cloud_credentials') return true;
      if (cmd === 'delete_setting') return true;
      return null;
    });
  });

  afterEach(() => {
    useGlobalSyncStore.getState().endSync();
  });

  it('BUG-2: ipcPairingSettings reads authoritative pairing command first and never leaks stale get_setting credentials when empty', async () => {
    mockInvoke.mockImplementation(async (cmd: string, args?: { key?: string }) => {
      if (cmd === 'data_governance_pairing_get_cloud_credentials') return null;
      if (cmd === 'get_setting' && args?.key === 'cloud_storage_credentials') {
        return JSON.stringify({ webdavPassword: 'stale-leaked-password' });
      }
      return null;
    });

    const secret = await ipcPairingSettings.getSecret('cloud_storage_credentials');
    expect(secret).toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith('data_governance_pairing_get_cloud_credentials');
    expect(mockInvoke).not.toHaveBeenCalledWith('get_setting', { key: 'cloud_storage_credentials' });
  });

  it('BUG-2: ipcPairingSettings.saveSecret writes authoritative command and purges slotA mirror instead of calling save_setting', async () => {
    await ipcPairingSettings.saveSecret(
      'cloud_storage_credentials',
      JSON.stringify({ webdavPassword: 'new-dav-password', encryptionPassword: 'new-e2ee-password' }),
    );
    expect(mockInvoke).toHaveBeenCalledWith('data_governance_pairing_save_cloud_credentials', {
      credentials: {
        webdavPassword: 'new-dav-password',
        encryptionPassword: 'new-e2ee-password',
      },
    });
    expect(mockInvoke).toHaveBeenCalledWith('delete_setting', { key: 'cloud_storage_credentials' });
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'save_setting',
      expect.objectContaining({ key: 'cloud_storage_credentials' }),
    );
  });

  it('BUG-2: CloudStorageSection clearConfig and disableEncryption purge cloud_storage_credentials via delete_setting', async () => {
    vi.mocked(cloudApi.resolveCloudStorageConfig).mockResolvedValue({
      provider: 'webdav',
      webdav: { endpoint: 'https://dav.example.test', username: 'student', password: '' },
      root: 'deep-student-sync',
      allowInsecure: false,
    });
    vi.mocked(cloudApi.getCredentialStatus).mockResolvedValue({
      webdavPasswordConfigured: true,
      s3SecretAccessKeyConfigured: false,
      ftpPasswordConfigured: false,
      encryptionPasswordConfigured: true,
    });

    render(<CloudStorageSection />);

    // Disable encryption -> must purge legacy cloud_storage_credentials
    const disableBtn = await screen.findByRole('button', { name: 'cloudStorage:encryption.disableAction' });
    fireEvent.click(disableBtn);
    fireEvent.click(await screen.findByRole('button', { name: 'cloudStorage:encryption.disableConfirm.confirm' }));

    await waitFor(() => {
      expect(cloudApi.clearEncryptionPassword).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledWith('delete_setting', { key: 'cloud_storage_credentials' });
    });

    mockInvoke.mockClear();

    // Clear config -> must also purge legacy cloud_storage_credentials
    fireEvent.click(screen.getByRole('button', { name: 'cloudStorage:actions.clearConfig' }));
    fireEvent.click(await screen.findByRole('button', { name: 'cloudStorage:clearConfirm.confirm' }));

    await waitFor(() => {
      expect(cloudApi.clearCloudConfigSsot).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledWith('delete_setting', { key: 'cloud_storage_credentials' });
    });
  });

  it('BUG-5: DevicePairingSection shows expiry hint, localizes expired DSPAIR1 cleanly in en-US (0 CJK) and zh-CN, and wraps post-pairing sync in work()', async () => {
    const expiredCode = (
      await createPairingCode(
        {
          get: () => null,
          save: () => undefined,
          listByPrefix: () => [],
          getSecret: async () => null,
          saveSecret: async () => undefined,
        },
        {
          pin: '123456',
          includeCloudConfig: false,
          includeLlmKeys: false,
          includeSyncPrefs: true,
          now: Date.now() - 30 * 60 * 1000,
          ttlMs: 15 * 60 * 1000,
        },
      )
    ).pairingCode;

    const validCode = (
      await createPairingCode(
        {
          get: () => null,
          save: () => undefined,
          listByPrefix: () => [],
          getSecret: async () => null,
          saveSecret: async () => undefined,
        },
        {
          pin: '654321',
          includeCloudConfig: false,
          includeLlmKeys: false,
          includeSyncPrefs: true,
        },
      )
    ).pairingCode;

    const onRunSync = vi.fn<
      (direction: 'upload' | 'download' | 'bidirectional') => Promise<boolean>
    >();
    onRunSync.mockRejectedValueOnce(new Error('HTTP 503 Service Unavailable'));

    render(<DevicePairingSection cloudConfigured onRunSync={onRunSync} />);

    // Send mode: generating QR shows 15-min expiry hint
    fireEvent.change(screen.getByPlaceholderText(enSync.pairing.pinPlaceholder), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByTestId('generate-pairing-qr-btn'));
    expect(await screen.findByTestId('device-pairing-expiry-hint')).toBeInTheDocument();

    // Receive mode: expired code rejected with English message and ZERO CJK characters
    fireEvent.click(screen.getByRole('tab', { name: enSync.pairing.tabReceive }));
    fireEvent.change(screen.getByTestId('pairing-code-paste-input'), {
      target: { value: expiredCode },
    });
    fireEvent.change(screen.getByPlaceholderText(enSync.pairing.receivePinPlaceholder), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByTestId('apply-pairing-code-btn'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('expired');
    expect(alert.textContent).not.toMatch(/[\u4e00-\u9fff]/);

    // Apply valid code, then click post-pairing bidirectional sync CTA -> wrapped in work(), surfaces error cleanly
    fireEvent.change(screen.getByTestId('pairing-code-paste-input'), {
      target: { value: validCode },
    });
    fireEvent.change(screen.getByPlaceholderText(enSync.pairing.receivePinPlaceholder), {
      target: { value: '654321' },
    });
    fireEvent.click(screen.getByTestId('apply-pairing-code-btn'));

    const biSyncBtn = await screen.findByTestId('pairing-run-bisync-btn');
    fireEvent.click(biSyncBtn);

    await waitFor(() => {
      expect(onRunSync).toHaveBeenCalledWith('bidirectional');
    });
    const syncAlert = await screen.findByRole('alert');
    expect(syncAlert.textContent).toContain('503');
    expect(syncAlert.textContent).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('BUG-5: CloudStorageSection handlePairingRunSync enforces useGlobalSyncStore, fail-closed detectPruneGap, and dispatches data-governance:local-change', async () => {
    vi.mocked(cloudApi.resolveCloudStorageConfig).mockResolvedValue({
      provider: 'webdav',
      webdav: { endpoint: 'https://dav.example.test', username: 'student', password: '' },
      root: 'deep-student-sync',
      allowInsecure: false,
    });
    const validCode = (
      await createPairingCode(
        {
          get: () => null,
          save: () => undefined,
          listByPrefix: () => [],
          getSecret: async () => null,
          saveSecret: async () => undefined,
        },
        {
          pin: '112233',
          includeCloudConfig: false,
          includeLlmKeys: false,
          includeSyncPrefs: true,
        },
      )
    ).pairingCode;

    // 1. Fail-closed on prune gap
    mockDetectPruneGap.mockResolvedValueOnce({
      has_gap: true,
      since_version: 2,
      min_available_version: 10,
      gap_details: 'Cloud change log gap detected (since=2 < min=10)',
    });

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    render(<CloudStorageSection />);
    fireEvent.click(screen.getByRole('tab', { name: enSync.pairing.tabReceive }));
    fireEvent.change(screen.getByTestId('pairing-code-paste-input'), {
      target: { value: validCode },
    });
    fireEvent.change(screen.getByPlaceholderText(enSync.pairing.receivePinPlaceholder), {
      target: { value: '112233' },
    });
    fireEvent.click(screen.getByTestId('apply-pairing-code-btn'));

    const biSyncBtn = await screen.findByTestId('pairing-run-bisync-btn');
    fireEvent.click(biSyncBtn);

    await waitFor(() => {
      expect(mockDetectPruneGap).toHaveBeenCalledTimes(1);
    });
    expect(mockRunSyncWithProgress).not.toHaveBeenCalled();
    expect(useGlobalSyncStore.getState().isSyncing).toBe(false);
    expect(useGlobalSyncStore.getState().progress?.phase).toBe('failed');

    // 2. Retry with no prune gap -> runs sync, releases global lock, dispatches data-governance:local-change
    mockDetectPruneGap.mockResolvedValueOnce({
      has_gap: false,
      since_version: 10,
      min_available_version: 10,
      gap_details: null,
    });
    fireEvent.click(biSyncBtn);

    await waitFor(() => {
      expect(mockRunSyncWithProgress).toHaveBeenCalledWith(
        'bidirectional',
        expect.objectContaining({ provider: 'webdav' }),
        'keep_latest',
      );
    });
    await waitFor(() => {
      expect(
        dispatchSpy.mock.calls.some(([ev]) => ev instanceof Event && ev.type === 'data-governance:local-change'),
      ).toBe(true);
    });
    expect(useGlobalSyncStore.getState().isSyncing).toBe(false);
    dispatchSpy.mockRestore();
  });

  it('BUG-6: DevicePairingSection shows non-blocking LAN IP warning without blocking QR generation', async () => {
    localStorage.setItem(
      cloudApi.CLOUD_STORAGE_CONFIG_V2_STORAGE_KEY,
      JSON.stringify({
        provider: 's3',
        s3: {
          endpoint: 'http://192.168.1.25:9000',
          bucket: 'notes',
          accessKeyId: 'minioadmin',
          pathStyle: true,
        },
        allow_insecure: true,
      }),
    );

    render(<DevicePairingSection cloudConfigured />);

    const lanWarning = await screen.findByTestId('pairing-lan-endpoint-warning');
    expect(lanWarning.textContent).toContain('192.168.1.25');
    expect(lanWarning.textContent).not.toMatch(/[\u4e00-\u9fff]/);

    // Still non-blocking: user can generate QR code immediately
    fireEvent.change(screen.getByPlaceholderText(enSync.pairing.pinPlaceholder), {
      target: { value: '987654' },
    });
    fireEvent.click(screen.getByTestId('generate-pairing-qr-btn'));
    expect(await screen.findByTestId('device-pairing-qr-panel')).toBeInTheDocument();
  });

  it('BUG-6: CloudStorageSection displays first-connect remote-dataset notice when non-empty local workspace connects to existing remote repo', async () => {
    vi.mocked(cloudApi.resolveCloudStorageConfig).mockResolvedValue({
      provider: 's3',
      s3: {
        endpoint: 'http://192.168.1.25:9000',
        bucket: 'study-sync',
        accessKeyId: 'minioadmin',
        secretAccessKey: '',
        pathStyle: true,
      },
      root: 'deep-student-sync',
      allowInsecure: true,
    });
    vi.mocked(cloudApi.getCredentialStatus).mockResolvedValue({
      webdavPasswordConfigured: false,
      s3SecretAccessKeyConfigured: true,
      ftpPasswordConfigured: false,
      encryptionPasswordConfigured: false,
    });
    vi.mocked(cloudApi.listFiles).mockResolvedValue([
      {
        key: 'data_governance/manifest.json',
        size: 1024,
        lastModified: '2026-06-01T10:00:00Z',
      },
    ]);
    mockGetSyncStatus.mockResolvedValue({
      partial: false,
      errors: [],
      has_pending_changes: true,
      total_pending_changes: 7,
      total_synced_changes: 0,
      databases: [],
      last_sync_at: null,
      device_id: 'device-test',
    });

    render(<CloudStorageSection />);

    const notice = await screen.findByTestId('cloud-first-connect-remote-notice');
    expect(notice.textContent).toContain(enSync.firstConnect.remoteDatasetNoticeTitle);
    expect(notice.textContent).toContain('7');
    expect(notice.textContent).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
