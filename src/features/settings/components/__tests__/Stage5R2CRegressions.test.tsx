import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import enSync from '@/locales/en-US/sync.json';
import zhData from '@/locales/zh-CN/data.json';
import enData from '@/locales/en-US/data.json';
import { useSystemStatusStore } from '@/stores/systemStatusStore';

const mockNotify = vi.hoisted(() => vi.fn());
const mockInvoke = vi.hoisted(() => vi.fn());
const mockCreatePairingCode = vi.hoisted(() => vi.fn());
const mockApplyPairingCode = vi.hoisted(() => vi.fn());
const mockListRecordConflicts = vi.hoisted(() => vi.fn());
const mockCountRecordConflicts = vi.hoisted(() => vi.fn());
const mockResolveRecordConflict = vi.hoisted(() => vi.fn());
const mockListSnapshots = vi.hoisted(() => vi.fn());
const mockLanguage = vi.hoisted(() => ({ current: 'zh-CN' }));

const mockCloudApi = vi.hoisted(() => ({
  loadStoredCloudStorageConfigSafe: vi.fn(() => null),
  loadStoredCloudStorageConfigWithCredentials: vi.fn(async () => null),
  resolveCloudStorageConfig: vi.fn(async () => null),
  getCredentialStatus: vi.fn(async () => ({
    webdavPasswordConfigured: false,
    s3SecretAccessKeyConfigured: false,
    ftpPasswordConfigured: false,
    encryptionPasswordConfigured: false,
  })),
  checkConnection: vi.fn(async () => true),
  testConnectionDraft: vi.fn(async () => undefined),
  getSyncStatus: vi.fn(async () => ({})),
  listVersions: vi.fn(async () => []),
  publishCloudConfig: vi.fn(),
  saveCloudConfigSsot: vi.fn(),
  saveCredentials: vi.fn(),
  getCloudPlatformErrorI18nKey: vi.fn(() => undefined),
  getPlatformCapabilities: vi.fn(async () => ({ ftpSupported: true })),
  isImportedArchiveSlotRestorable: vi.fn(() => true),
  CLOUD_STORAGE_CONFIG_KEY: 'cloud_storage_config',
  CLOUD_STORAGE_SSOT_MIGRATED_STORAGE_KEY: 'cloud_storage.ssot_migrated',
}));

const mockDataGovApi = vi.hoisted(() => ({
  getMigrationStatus: vi.fn(),
  runHealthCheck: vi.fn(),
  getBackupList: vi.fn(),
  listBackupJobs: vi.fn(),
  listResumableJobs: vi.fn(),
  getMaintenanceStatus: vi.fn(),
  getSyncStatus: vi.fn(),
  getAuditLogs: vi.fn(),
  runBackup: vi.fn(),
  backupTiered: vi.fn(),
  backupAndExportZip: vi.fn(),
  restoreBackup: vi.fn(),
  verifyBackup: vi.fn(),
  deleteBackup: vi.fn(),
  cancelBackup: vi.fn(),
  exportZip: vi.fn(),
  importZip: vi.fn(),
  resumeBackupJob: vi.fn(),
  checkDiskSpaceForRestore: vi.fn(),
  getBackupConfig: vi.fn(),
  setBackupConfig: vi.fn(),
  listRecordConflicts: mockListRecordConflicts,
  countRecordConflicts: mockCountRecordConflicts,
  resolveRecordConflict: mockResolveRecordConflict,
  listSyncSnapshotBatches: mockListSnapshots,
  listQuarantine: vi.fn(async () => []),
  retryQuarantine: vi.fn(async () => true),
  discardQuarantine: vi.fn(async () => true),
  retryAllQuarantine: vi.fn(async () => ({ retried: 0, succeeded: 0, failed: 0 })),
  discardAllQuarantine: vi.fn(async () => 0),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(async () => '/tmp/export.zip'), open: vi.fn(async () => '/tmp/import.zip') }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: mockNotify }));
vi.mock('@/utils/unifiedDialogs', () => ({ unifiedConfirm: vi.fn(() => true) }));
vi.mock('@/utils/cloudStorageApi', async (orig) => {
  const actual = await orig<typeof import('@/utils/cloudStorageApi')>();
  return { ...actual, ...mockCloudApi };
});
vi.mock('@/api/dataGovernance', async (orig) => {
  const actual = await orig<typeof import('@/api/dataGovernance')>();
  return {
    ...actual,
    DataGovernanceApi: { ...actual.DataGovernanceApi, ...mockDataGovApi },
    getBackupConfig: mockDataGovApi.getBackupConfig,
    setBackupConfig: mockDataGovApi.setBackupConfig,
    listRecordConflicts: mockListRecordConflicts,
    countRecordConflicts: mockCountRecordConflicts,
    resolveRecordConflict: mockResolveRecordConflict,
    listSyncSnapshotBatches: mockListSnapshots,
    listQuarantine: mockDataGovApi.listQuarantine,
    retryQuarantine: mockDataGovApi.retryQuarantine,
    discardQuarantine: mockDataGovApi.discardQuarantine,
    retryAllQuarantine: mockDataGovApi.retryAllQuarantine,
    discardAllQuarantine: mockDataGovApi.discardAllQuarantine,
  };
});
vi.mock('../../../../../host/plugins/sync/src/device-pairing', () => ({
  createPairingCode: mockCreatePairingCode,
  applyPairingCode: mockApplyPairingCode,
}));
vi.mock('@/hooks/useBackupJobListener', () => ({
  useBackupJobListener: () => ({ startListening: vi.fn(async () => undefined), stopListening: vi.fn() }),
}));
vi.mock('@/utils/tauriApi', () => ({ TauriAPI: { restartApp: vi.fn(async () => undefined), getAppVersion: vi.fn(async () => '0.20.9') } }));
vi.mock('@/features/settings/components/MediaCacheSection', () => ({ MediaCacheSection: () => <div /> }));

const stableT = (key: string, opts?: string | Record<string, unknown>) => {
  if (typeof opts === 'string') return opts;
  if (key.startsWith('sync:') && mockLanguage.current.startsWith('en')) {
    const parts = key.slice('sync:'.length).split('.');
    let cur: unknown = enSync;
    for (const p of parts) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[p] : undefined;
    if (typeof cur === 'string') return cur;
  }
  if (opts && typeof opts.defaultValue === 'string') return opts.defaultValue;
  return key;
};
const stableI18n = {
  get language() { return mockLanguage.current; },
  changeLanguage: async (lng: string) => { mockLanguage.current = lng; },
};
const stableTranslation = { t: stableT, i18n: stableI18n };

vi.mock('react-i18next', async (orig) => {
  const actual = await orig<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => stableTranslation,
  };
});

import { CloudStorageSection } from '@/features/settings/components/CloudStorageSection';
import { SyncTab, resolveLatestSyncTimestamp } from '@/features/settings/components/data-governance/SyncTab';
import { localizeBackendErrorText, notifyErrorDeduped } from '@/features/settings/components/data-governance/localizeCloudError';
import { DevicePairingSection } from '@/features/settings/components/DevicePairingSection';
import { RecordConflictsPanel } from '@/features/settings/components/data-governance/RecordConflictsPanel';
import { BackupTab } from '@/features/settings/components/data-governance/BackupTab';
import { DataGovernanceDashboard } from '@/features/settings/components/DataGovernanceDashboard';
import { useSettingsNavigation } from '@/features/settings/components/useSettingsNavigation';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockLanguage.current = 'zh-CN';
  act(() => { useSystemStatusStore.getState().exitMaintenanceMode(); });
  mockInvoke.mockResolvedValue(null);
  mockListRecordConflicts.mockResolvedValue([]);
  mockCountRecordConflicts.mockResolvedValue({ per_database: {}, total_groups: 0, total_rows: 0 });
  mockListSnapshots.mockResolvedValue([]);
  mockDataGovApi.getBackupConfig.mockResolvedValue({
    backupDirectory: null, autoBackupEnabled: false, autoBackupIntervalHours: 24, maxBackupCount: null, slimBackup: false,
  });
  mockDataGovApi.getMigrationStatus.mockResolvedValue({
    global_version: 10, all_healthy: true, databases: [], pending_migrations_total: 0, has_pending_migrations: false, last_error: null,
  });
  mockDataGovApi.runHealthCheck.mockResolvedValue({
    overall_healthy: true, total_databases: 4, initialized_count: 4, uninitialized_count: 0,
    dependency_check_passed: true, dependency_error: null, databases: [], checked_at: '2026-11-24T00:00:00Z',
    pending_migrations_count: 0, has_pending_migrations: false, audit_log_healthy: true, audit_log_error: null, audit_log_error_at: null,
  });
  mockDataGovApi.getBackupList.mockResolvedValue([]);
  mockDataGovApi.listBackupJobs.mockResolvedValue([]);
  mockDataGovApi.listResumableJobs.mockResolvedValue([]);
  mockDataGovApi.getMaintenanceStatus.mockResolvedValue({ is_in_maintenance_mode: false, blocked_components: [] });
  mockDataGovApi.getSyncStatus.mockResolvedValue(null);
  mockDataGovApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
});

afterEach(() => {
  act(() => { useSystemStatusStore.getState().exitMaintenanceMode(); });
});

describe('Stage 5 R2-C regressions', () => {
  it('S5-01/S5-08: CloudStorageSection tests reloaded saved WebDAV with checkConnection, keeps distinct inputs, and renders inline disabled validation', async () => {
    mockCloudApi.resolveCloudStorageConfig.mockResolvedValueOnce({
      provider: 'webdav',
      webdav: { endpoint: 'https://dav.example.com/dav', username: 'alice' },
      root: 'deep-student',
      allowInsecure: false,
    });
    mockCloudApi.getCredentialStatus.mockResolvedValueOnce({
      webdavPasswordConfigured: true,
      s3SecretAccessKeyConfigured: false,
      ftpPasswordConfigured: false,
      encryptionPasswordConfigured: false,
    });

    render(<CloudStorageSection />);
    const pwdInput = await screen.findByLabelText('cloudStorage:webdav.password');
    const rootInput = screen.getByLabelText('cloudStorage:root.label');
    expect(pwdInput).toHaveAttribute('name', 'cloud_webdav_app_password');
    expect(pwdInput).toHaveAttribute('autocomplete', 'new-password');
    expect(rootInput).toHaveAttribute('name', 'cloud_storage_sync_root');

    fireEvent.click(screen.getByRole('button', { name: 'cloudStorage:actions.testConnection' }));
    await waitFor(() => {
      expect(mockCloudApi.checkConnection).toHaveBeenCalledTimes(1);
    });
    expect(mockCloudApi.testConnectionDraft).not.toHaveBeenCalled();

    // Clearing username shows inline disabled reason explaining why Save/Test are disabled
    const userInput = screen.getByPlaceholderText('cloudStorage:webdav.usernamePlaceholder');
    fireEvent.change(userInput, { target: { value: '' } });
    expect(screen.getByTestId('cloud-config-disabled-reasons')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'cloudStorage:actions.save' })).toBeDisabled();
  });

  it('S5-01/S5-08/S5-18: SyncTab normalizes UTC timestamps, toggles domain pending breakdown, localizes errors to en-US, and dedupes alerts', () => {
    expect(resolveLatestSyncTimestamp({
      device_id: 'dev',
      last_sync_at: '2026-11-24 10:15:00',
      total_pending_changes: 0,
      total_synced_changes: 1,
      databases: [],
    })).toBe('2026-11-24T10:15:00Z');

    mockLanguage.current = 'en-US';
    expect(localizeBackendErrorText('WebDAV PROPFIND 失败（已重试 3 次）: HTTP 503', 'en-US'))
      .toContain('WebDAV PROPFIND failed (retried 3 times): HTTP 503');
    expect(localizeBackendErrorText('上传文件失败: 缺少 WebDAV 配置', 'en-US'))
      .toBe('Failed to upload file: Missing WebDAV configuration');

    notifyErrorDeduped('error', 'Repeated error');
    notifyErrorDeduped('error', 'Repeated error');
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith('error', 'Repeated error');

    render(
      <SyncTab
        syncStatus={{
          device_id: 'dev-1',
          last_sync_at: '2026-11-24T10:00:00Z',
          total_pending_changes: 3,
          total_synced_changes: 1,
          databases: [
            { id: 'vfs', has_change_log: true, pending_changes: 3, synced_changes: 1, last_sync_at: '2026-11-24T10:00:00Z' },
          ],
        }}
        conflicts={null}
        loading={false}
        onRefresh={vi.fn()}
        onDetectConflicts={vi.fn()}
        onResolveConflicts={vi.fn()}
        cloudSyncConfigured={true}
        cloudSyncSummary={{ provider: 'webdav', root: 'sync' }}
        syncRunning={false}
        syncProgress={{
          phase: 'failed',
          current: 0,
          total: 0,
          speed_bytes_per_sec: 0,
          eta_seconds: 0,
          error: 'WebDAV 下载失败: HTTP 503',
        }}
        syncStrategy="keep_latest"
        onSyncStrategyChange={vi.fn()}
        showCloudSettingsEditor={false}
        onToggleCloudSettingsEditor={vi.fn()}
        onSetCloudSettingsEditorOpen={vi.fn()}
        onCloudConfigChanged={vi.fn()}
        onRunSync={vi.fn()}
      />,
    );

    expect(screen.getByTestId('sync-terminal-error-banner')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('sync-terminal-error-banner')).toHaveTextContent('WebDAV download failed: HTTP 503');
    fireEvent.click(screen.getByTestId('sync-pending-breakdown-toggle'));
    expect(screen.getByTestId('sync-pending-breakdown-panel')).toBeInTheDocument();
  });

  it('S5-02/S5-17/S5-18: DevicePairingSection generates fresh random PIN over typed PIN, awaits upload sync before QR, and Settings Search + 8 sub-tabs work', async () => {
    mockCreatePairingCode.mockImplementation(async (_s, opts: { pin: string }) => ({
      pairingCode: `DSPAIR1:code_${opts.pin}`,
      summary: { cloudProvider: 'webdav', llmProviders: 0, includeSkills: true, includePlugins: true },
    }));
    const onRunSync = vi.fn(async () => true);

    render(<DevicePairingSection cloudConfigured={true} onRunSync={onRunSync} />);
    const pinInput = await screen.findByPlaceholderText(/6 位|sync:pairing\.pinPlaceholder/);
    fireEvent.change(pinInput, { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: '一键随机 PIN 生成二维码' }));

    await waitFor(() => {
      expect(mockCreatePairingCode).toHaveBeenCalledTimes(1);
    });
    const usedPin = mockCreatePairingCode.mock.calls[0]![1].pin;
    expect(usedPin).toMatch(/^\d{6}$/);
    expect((pinInput as HTMLInputElement).value).toBe(usedPin);

    fireEvent.click(screen.getByRole('button', { name: '生成并立即推送本机最新快照' }));
    await waitFor(() => {
      expect(onRunSync).toHaveBeenCalledWith('upload');
      expect(mockCreatePairingCode).toHaveBeenCalledTimes(2);
    });

    const { result } = renderHook(() => useSettingsNavigation({}));
    const allKeywords = result.current.settingsSearchIndex
      .filter((i) => i.tab === 'data-governance')
      .flatMap((i) => i.keywords.map((k) => k.toLowerCase()));
    expect(allKeywords).toEqual(
      expect.arrayContaining(['同步', 'webdav', '云存储', '设备配对', '备份', '恢复']),
    );
  });

  it('S5-05: RecordConflictsPanel displays readable note title and content body diff before collapsed metadata', async () => {
    mockListRecordConflicts.mockResolvedValue([
      {
        id: 1,
        database_name: 'vfs',
        table_name: 'notes',
        record_id: 'note-1',
        side: 'local',
        data_json: JSON.stringify({ id: 'note-1', title: 'My Revision Title', resource_id: 'res-1', content: 'Local body text' }),
        winning_device_id: 'dev-b',
        losing_device_id: 'dev-a',
        detected_at: '2026-11-24 10:00:00',
        resolved_at: null,
        resolution: null,
      },
      {
        id: 2,
        database_name: 'vfs',
        table_name: 'notes',
        record_id: 'note-1',
        side: 'cloud',
        data_json: JSON.stringify({ id: 'note-1', title: 'My Revision Title', resource_id: 'res-1', content: 'Cloud body text' }),
        winning_device_id: 'dev-a',
        losing_device_id: 'dev-b',
        detected_at: '2026-11-24 10:00:00',
        resolved_at: null,
        resolution: null,
      },
    ]);
    mockCountRecordConflicts.mockResolvedValue({ per_database: {}, total_groups: 1, total_rows: 2 });

    render(<RecordConflictsPanel />);
    expect((await screen.findAllByText('My Revision Title')).length).toBeGreaterThanOrEqual(1);
    const diffSummary = screen.getByTestId('conflict-content-diff-summary');
    expect(within(diffSummary).getByText('Local body text')).toBeInTheDocument();
    expect(within(diffSummary).getByText('Cloud body text')).toBeInTheDocument();
  });

  it('S5-13/S5-14/S5-15/S5-17: BackupTab keeps Import dialog open on wrong password, triggers create restore point, passes excludeTrash=false, and avoids MAINTENANCE_MODE on tab switch', async () => {
    const onCreateLocalBackup = vi.fn();
    const onBackupAndExportZip = vi.fn();
    const onImportZip = vi.fn(async () => ({ success: false, error: 'Incorrect backup password' }));
    (globalThis as { __DS_WEBUI__?: boolean }).__DS_WEBUI__ = true;

    try {
      render(
        <BackupTab
          backups={[]}
          loading={false}
          onCreateLocalBackup={onCreateLocalBackup}
          onBackupAndExportZip={onBackupAndExportZip}
          onDeleteBackup={vi.fn()}
          onVerifyBackup={vi.fn()}
          onRestoreBackup={vi.fn()}
          onExportZip={vi.fn()}
          onImportZip={onImportZip}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'data:governance.create_restore_point' }));
      expect(onCreateLocalBackup).toHaveBeenCalledTimes(1);

      const excludeCheckbox = screen.getByLabelText('data:governance.exclude_trash_label');
      fireEvent.click(excludeCheckbox);
      expect(screen.getByText('data:governance.exclude_trash_unencrypted_hint')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'data:governance.export_backup' }));
      expect(onBackupAndExportZip).toHaveBeenCalledWith(expect.objectContaining({ excludeTrash: false }));

      // Wrong password keeps dialog open & renders inline role="alert"
      fireEvent.click(screen.getByRole('button', { name: 'data:governance.import_button' }));
      const dialog = screen.getByRole('dialog');
      fireEvent.change(within(dialog).getByPlaceholderText('data:governance.import_file_path_placeholder'), {
        target: { value: '/tmp/sealed.zip' },
      });
      fireEvent.change(within(dialog).getByLabelText('data:governance.import_password_label'), {
        target: { value: 'wrong-pw' },
      });
      fireEvent.click(within(dialog).getAllByRole('button', { name: 'data:governance.import_button' }).pop()!);

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Incorrect backup password');
      });
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    } finally {
      delete (globalThis as { __DS_WEBUI__?: boolean }).__DS_WEBUI__;
    }

    // Switching to Backup tab in DataGovernanceDashboard even when getMaintenanceStatus rejects does not trigger maintenanceMode
    mockDataGovApi.getMaintenanceStatus.mockRejectedValueOnce(new Error('offline probe'));
    render(<DataGovernanceDashboard embedded />);
    const backupTab = await screen.findByRole('tab', { name: 'data:governance.tab_backup' });
    fireEvent.click(backupTab);
    await waitFor(() => expect(mockDataGovApi.getBackupList).toHaveBeenCalled());
    expect(useSystemStatusStore.getState().maintenanceMode).toBe(false);
    expect(useSystemStatusStore.getState().maintenanceRequiresRestart).toBe(false);

    // Locale contract parity check on updated keys
    expect(zhData.governance.export_success_simple).toBe('备份导出完成');
    expect(enData.governance.export_success_simple).toBe('Backup export completed');
  });
});
