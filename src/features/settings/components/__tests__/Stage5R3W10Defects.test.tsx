import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import zhSync from '@/locales/zh-CN/sync.json';
import enSync from '@/locales/en-US/sync.json';
import zhData from '@/locales/zh-CN/data.json';
import enData from '@/locales/en-US/data.json';
import zhCloudStorage from '@/locales/zh-CN/cloudStorage.json';
import enCloudStorage from '@/locales/en-US/cloudStorage.json';
import zhSettings from '@/locales/zh-CN/settings.json';
import enSettings from '@/locales/en-US/settings.json';

const mockNotify = vi.hoisted(() => vi.fn());
const mockInvoke = vi.hoisted(() => vi.fn());
const mockCreatePairingCode = vi.hoisted(() => vi.fn());
const mockApplyPairingCode = vi.hoisted(() => vi.fn());
const mockRunSyncWithProgress = vi.hoisted(() => vi.fn());
const mockListRecordConflicts = vi.hoisted(() => vi.fn());
const mockCountRecordConflicts = vi.hoisted(() => vi.fn());
const mockResolveRecordConflict = vi.hoisted(() => vi.fn());
const mockListSnapshots = vi.hoisted(() => vi.fn());
const mockListQuarantine = vi.hoisted(() => vi.fn());
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
  isS3Enabled: vi.fn(async () => true),
  getDeviceId: vi.fn(async () => 'device-w10'),
  checkConnection: vi.fn(async () => true),
  testConnectionDraft: vi.fn(async () => undefined),
  getSyncStatus: vi.fn(async () => ({
    configured: true,
    connected: true,
    lastSyncTime: undefined as string | undefined,
    remoteVersionCount: 0,
  })),
  listVersions: vi.fn(async () => []),
  uploadBackup: vi.fn(async () => ({
    versionId: 'v-1',
    fileName: 'backup_v1.zip',
    uploadedAt: '2026-11-25T08:00:00Z',
    size: 4096,
  })),
  downloadBackup: vi.fn(),
  deleteVersion: vi.fn(),
  publishCloudConfig: vi.fn(),
  saveCloudConfigSsot: vi.fn(),
  saveCredentials: vi.fn(),
  clearCloudConfigSsot: vi.fn(async () => undefined),
  clearEncryptionPassword: vi.fn(async () => ({
    webdavPasswordConfigured: false,
    s3SecretAccessKeyConfigured: false,
    ftpPasswordConfigured: false,
    encryptionPasswordConfigured: false,
  })),
  requiresInsecureTransportOptIn: vi.fn(() => false),
  isPublicHttpEndpoint: vi.fn(() => false),
  getCloudPlatformErrorI18nKey: vi.fn(() => undefined),
  getPlatformCapabilities: vi.fn(async () => ({ ftpSupported: true })),
  isImportedArchiveSlotRestorable: vi.fn(() => true),
  findCloudBackupVersion: vi.fn(() => undefined),
  isKnownPortableCloudBackup: vi.fn(() => false),
}));

const mockDataGovApi = vi.hoisted(() => ({
  getMigrationStatus: vi.fn(async () => ({
    global_version: 1,
    databases: [],
    all_healthy: true,
    pending_migrations_total: 0,
    has_pending_migrations: false,
    last_error: null,
  })),
  runHealthCheck: vi.fn(async () => ({
    checked_at: '2026-11-25T06:00:00Z',
    overall_healthy: true,
    total_databases: 2,
    initialized_count: 2,
    uninitialized_count: 0,
    dependency_check_passed: true,
    dependency_error: null,
    databases: [],
    pending_migrations_count: 0,
    has_pending_migrations: false,
    audit_log_healthy: true,
    audit_log_error: null,
    audit_log_error_at: null,
  })),
  getBackupList: vi.fn(async () => []),
  listBackupJobs: vi.fn(async () => []),
  listResumableJobs: vi.fn(async () => []),
  getMaintenanceStatus: vi.fn(async () => ({ in_maintenance: false, reason: null })),
  getSyncStatus: vi.fn(async () => ({
    device_id: 'device-w10',
    last_sync_at: null as string | null,
    total_pending_changes: 0,
    total_synced_changes: 0,
    databases: [],
  })),
  getAuditLogs: vi.fn(async () => ({ logs: [], total: 0 })),
  runBackup: vi.fn(),
  backupTiered: vi.fn(async () => ({
    success: true,
    backup_path: '/tmp/tiered_backup_1',
    backup_size: 4096,
    duration_ms: 120,
    databases_backed_up: ['vfs'],
  })),
  backupAndExportZip: vi.fn(),
  restoreBackup: vi.fn(async () => 'job-restore-1'),
  verifyBackup: vi.fn(),
  deleteBackup: vi.fn(),
  cancelBackup: vi.fn(),
  exportZip: vi.fn(async () => 'job-export-1'),
  importZip: vi.fn(),
  resumeBackupJob: vi.fn(),
  getBackupJob: vi.fn(async () => ({
    job_id: 'job-export-1',
    status: 'completed',
    phase: 'done',
    progress: 100,
  })),
  checkDiskSpaceForRestore: vi.fn(async () => ({
    has_enough_space: true,
    available_bytes: 1e10,
    required_bytes: 1e6,
  })),
  getBackupConfig: vi.fn(async () => ({
    autoBackupEnabled: false,
    intervalHours: 24,
    maxBackupCount: 10,
  })),
  setBackupConfig: vi.fn(async () => undefined),
  detectPruneGap: vi.fn(async () => ({ has_gap: false })),
  detectConflicts: vi.fn(async () => ({
    has_conflicts: false,
    database_conflicts: [],
    record_conflict_count: 0,
    needs_migration: false,
  })),
  listRecordConflicts: mockListRecordConflicts,
  countRecordConflicts: mockCountRecordConflicts,
  resolveRecordConflict: mockResolveRecordConflict,
  listSyncSnapshotBatches: mockListSnapshots,
  listQuarantine: mockListQuarantine,
  retryQuarantine: vi.fn(async () => true),
  discardQuarantine: vi.fn(async () => true),
  retryAllQuarantine: vi.fn(async () => ({ retried: 0, succeeded: 0, failed: 0 })),
  discardAllQuarantine: vi.fn(async () => 0),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(async () => '/tmp/export.zip'),
  open: vi.fn(async () => '/tmp/import.zip'),
}));
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
    runSyncWithProgress: mockRunSyncWithProgress,
    getBackupConfig: mockDataGovApi.getBackupConfig,
    setBackupConfig: mockDataGovApi.setBackupConfig,
    listRecordConflicts: mockListRecordConflicts,
    countRecordConflicts: mockCountRecordConflicts,
    resolveRecordConflict: mockResolveRecordConflict,
    listSyncSnapshotBatches: mockListSnapshots,
    listQuarantine: mockListQuarantine,
  };
});
vi.mock('../../../../../host/plugins/sync/src/device-pairing', () => ({
  createPairingCode: mockCreatePairingCode,
  applyPairingCode: mockApplyPairingCode,
}));
vi.mock('@/hooks/useBackupJobListener', () => ({
  useBackupJobListener: () => ({
    startListening: vi.fn(async () => undefined),
    stopListening: vi.fn(),
  }),
}));
vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: {
    restartApp: vi.fn(async () => undefined),
    getAppVersion: vi.fn(async () => '0.20.9'),
    getAppDataDir: vi.fn(async () => '/tmp/app-data'),
    getDataSpaceInfo: vi.fn(async () => null),
  },
}));
vi.mock('@/features/settings/components/MediaCacheSection', () => ({
  MediaCacheSection: () => <div data-testid="mock-media-cache" />,
}));
vi.mock('@/features/settings/components/IndexMaintenanceSection', () => ({
  LanceOptimizationPanel: () => <div data-testid="mock-index-maintenance" />,
}));
vi.mock('@/features/settings/components/data-governance/ChatSessionArchiveTab', () => ({
  ChatSessionArchiveTab: () => <div data-testid="mock-archive-tab" />,
}));
vi.mock('@/features/data-recovery/RecoveryCenter', () => ({
  RecoveryCenter: () => <div data-testid="mock-recovery-center" />,
}));

function resolveLocaleText(key: string, opts?: string | Record<string, unknown>): string {
  if (typeof opts === 'string') return opts;
  const lang = mockLanguage.current;
  const isEn = lang.startsWith('en');
  const lookup = (nsObj: Record<string, unknown>, subKey: string): string | undefined => {
    let cur: unknown = nsObj;
    for (const part of subKey.split('.')) {
      cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined;
    }
    return typeof cur === 'string' ? cur : undefined;
  };
  let template: string | undefined;
  if (key.startsWith('sync:')) {
    template = lookup((isEn ? enSync : zhSync) as unknown as Record<string, unknown>, key.slice(5));
  } else if (key.startsWith('data:')) {
    template = lookup((isEn ? enData : zhData) as unknown as Record<string, unknown>, key.slice(5));
  } else if (key.startsWith('cloudStorage:')) {
    template = lookup(
      (isEn ? enCloudStorage : zhCloudStorage) as unknown as Record<string, unknown>,
      key.slice(13),
    );
  } else if (key.startsWith('settings:')) {
    template = lookup(
      (isEn ? enSettings : zhSettings) as unknown as Record<string, unknown>,
      key.slice(9),
    );
  } else if (key.startsWith('common:')) {
    const commonFallback: Record<string, string> = isEn
      ? { 'actions.cancel': 'Cancel', 'actions.confirm': 'Confirm', 'actions.delete': 'Delete', 'actions.retry': 'Retry', 'status.loading': 'Loading...' }
      : { 'actions.cancel': '取消', 'actions.confirm': '确认', 'actions.delete': '删除', 'actions.retry': '重试', 'status.loading': '加载中...' };
    template = commonFallback[key.slice(7)];
  }
  const base = template ?? (typeof opts?.defaultValue === 'string' ? opts.defaultValue : key);
  if (!opts) return base;
  return base.replace(/\{\{(\w+)\}\}/g, (_m, k) => (opts[k] !== undefined ? String(opts[k]) : ''));
}

const stableI18n = {
  get language() {
    return mockLanguage.current;
  },
  changeLanguage: async (lng: string) => {
    mockLanguage.current = lng;
  },
  t: resolveLocaleText,
};

vi.mock('react-i18next', async (orig) => {
  const actual = await orig<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({ t: resolveLocaleText, i18n: stableI18n }),
  };
});

import { DataGovernanceDashboard } from '@/features/settings/components/DataGovernanceDashboard';
import { CloudStorageSection } from '@/features/settings/components/CloudStorageSection';
import { SyncSettingsSection } from '@/features/settings/components/SyncSettingsSection';
import { DevicePairingSection } from '@/features/settings/components/DevicePairingSection';
import { QuickSyncNowButton } from '@/features/settings/components/QuickSyncNowButton';
import { SettingsCategoryHeader } from '@/features/settings/components/SettingsCategoryHeader';
import { SyncTab } from '@/features/settings/components/data-governance/SyncTab';
import { BackupTab } from '@/features/settings/components/data-governance/BackupTab';
import { UnsyncedItemsPanel } from '@/features/settings/components/data-governance/UnsyncedItemsPanel';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { useGlobalSyncStore } from '@/stores/syncStatusStore';
import { APP_EVENTS, dispatchAppEvent } from '@/events';

function clickRadixTab(tabEl: HTMLElement) {
  fireEvent.mouseDown(tabEl, { button: 0 });
  fireEvent.click(tabEl);
}

const SAVED_WEBDAV_CONFIG = {
  provider: 'webdav' as const,
  root: '/deep-student-sync',
  webdav: {
    endpoint: 'https://dav.example.com/remote.php/dav/files/alice',
    username: 'alice',
  },
};

describe('Stage 5 Round 3 W10 Defects (S5-01, S5-02, S5-07, S5-08, S5-15, S5-17, S5-18)', () => {
  const originalInnerWidth = window.innerWidth;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLanguage.current = 'zh-CN';
    localStorage.clear();
    useSystemStatusStore.setState({
      maintenanceMode: false,
      maintenanceReason: null,
      maintenanceRequiresRestart: false,
    });
    useGlobalSyncStore.setState({
      isSyncing: false,
      progress: null,
      cancelRequested: false,
    });
    mockCloudApi.loadStoredCloudStorageConfigSafe.mockReturnValue(null);
    mockCloudApi.loadStoredCloudStorageConfigWithCredentials.mockResolvedValue(null);
    mockCloudApi.resolveCloudStorageConfig.mockResolvedValue(null);
    mockCloudApi.getCredentialStatus.mockResolvedValue({
      webdavPasswordConfigured: false,
      s3SecretAccessKeyConfigured: false,
      ftpPasswordConfigured: false,
      encryptionPasswordConfigured: false,
    });
    mockCloudApi.getSyncStatus.mockResolvedValue({
      configured: true,
      connected: true,
      lastSyncTime: undefined,
      remoteVersionCount: 0,
    });
    mockListRecordConflicts.mockResolvedValue([]);
    mockCountRecordConflicts.mockResolvedValue({ total_groups: 0, total_rows: 0, per_database: {} });
    mockListSnapshots.mockResolvedValue([]);
    mockListQuarantine.mockResolvedValue([]);
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'data_governance_get_pending_breakdown') {
        return {
          total_pending_changes: 0,
          databases: [],
        };
      }
      if (cmd === 'get_setting') {
        return null;
      }
      return undefined;
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: originalInnerWidth,
    });
  });

  it('S5-15: Restore confirmation dialog renders rich bilingual translations instead of raw governance.confirm_restore_* keys', async () => {
    mockDataGovApi.getBackupList.mockResolvedValue([
      {
        path: '/backups/snapshot_20261125_morning',
        created_at: '2026-11-25T07:30:00Z',
        size: 1024 * 512,
        backup_type: 'full',
        restorable: true,
        databases: ['vfs', 'flashcard'],
      },
    ]);

    const { unmount } = render(<DataGovernanceDashboard />);
    await waitFor(() => expect(mockDataGovApi.getBackupList).toHaveBeenCalled());

    clickRadixTab(screen.getByRole('tab', { name: '恢复' }));

    const restoreBtn = await screen.findByRole('button', { name: /恢复 .* 快照/ });
    fireEvent.click(restoreBtn);

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).not.toContain('governance.confirm_restore_title');
    expect(dialog.textContent).not.toContain('governance.confirm_restore_desc');
    expect(dialog.textContent).toContain('确认从本地快照恢复数据？');
    expect(dialog.textContent).toContain('snapshot_20261125_morning');
    expect(dialog.textContent).toContain('覆盖数据库：');
    expect(dialog.textContent).toContain('恢复前安全快照');
    expect(dialog.textContent).toContain('重启或重新加载');
    unmount();

    // Verify en-US symmetry in BackupTab as well
    mockLanguage.current = 'en-US';
    render(
      <BackupTab
        backups={[
          {
            path: '/backups/snapshot_en_check',
            created_at: '2026-11-25T07:30:00Z',
            size: 2048,
            backup_type: 'full',
            restorable: true,
            databases: ['vfs'],
          },
        ]}
        loading={false}
        onBackupAndExportZip={vi.fn()}
        onDeleteBackup={vi.fn()}
        onVerifyBackup={vi.fn()}
        onRestoreBackup={vi.fn()}
        onExportZip={vi.fn()}
        onImportZip={vi.fn()}
      />,
    );

    const enRestoreButtons = screen.getAllByRole('button', { name: /snapshot/i });
    const targetRestoreBtn = enRestoreButtons.find((btn) =>
      btn.getAttribute('aria-label')?.toLowerCase().includes('restore'),
    );
    expect(targetRestoreBtn).toBeDefined();
    fireEvent.click(targetRestoreBtn!);

    const enDialog = await screen.findByRole('alertdialog');
    expect(enDialog.textContent).not.toContain('governance.confirm_restore_title');
    expect(enDialog.textContent).toContain('Confirm Data Restore from Snapshot?');
    expect(enDialog.textContent).toContain('Target snapshot: snapshot_en_check');
    expect(enDialog.textContent).toContain('Covered databases:');
    expect(enDialog.textContent).toContain('Safety backup:');
    expect(enDialog.textContent).toContain('App reload notice:');
  });

  it('S5-18: Full Cloud Backup requires explicit confirmation before entering Maintenance Mode or uploading', async () => {
    mockCloudApi.resolveCloudStorageConfig.mockResolvedValue(SAVED_WEBDAV_CONFIG);
    mockCloudApi.getCredentialStatus.mockResolvedValue({
      webdavPasswordConfigured: true,
      s3SecretAccessKeyConfigured: false,
      ftpPasswordConfigured: false,
      encryptionPasswordConfigured: true,
    });

    render(<CloudStorageSection isDialog />);

    const testConnBtn = await screen.findByRole('button', { name: /测试连接/ });
    await waitFor(() => expect(testConnBtn).not.toBeDisabled());
    fireEvent.click(testConnBtn);

    const uploadBtn = await screen.findByTestId('cloud-backup-upload-now-btn');
    await waitFor(() => expect(uploadBtn).not.toBeDisabled());

    // 1st click opens confirmation dialog — must NOT trigger backup or maintenance mode!
    fireEvent.click(uploadBtn);

    const confirmDialog = await screen.findByRole('alertdialog');
    expect(confirmDialog.textContent).toContain('确认执行整包云端备份并上传？');
    expect(mockDataGovApi.backupTiered).not.toHaveBeenCalled();
    expect(mockCloudApi.uploadBackup).not.toHaveBeenCalled();
    expect(useSystemStatusStore.getState().maintenanceMode).toBe(false);

    // Cancel aborts cleanly
    fireEvent.click(within(confirmDialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mockDataGovApi.backupTiered).not.toHaveBeenCalled();

    // Confirm proceeds with tiered backup + cloud upload
    fireEvent.click(uploadBtn);
    const confirmDialog2 = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirmDialog2).getByRole('button', { name: '确认备份并上传' }));

    await waitFor(() => {
      expect(mockDataGovApi.backupTiered).toHaveBeenCalledTimes(1);
    });
  });

  it('S5-01: CloudStorageSection and SyncSettingsSection fall back to incremental sync timestamp and never show contradictory "从未同步"', async () => {
    mockCloudApi.resolveCloudStorageConfig.mockResolvedValue(SAVED_WEBDAV_CONFIG);
    mockCloudApi.loadStoredCloudStorageConfigSafe.mockReturnValue(SAVED_WEBDAV_CONFIG);
    mockCloudApi.getCredentialStatus.mockResolvedValue({
      webdavPasswordConfigured: true,
      s3SecretAccessKeyConfigured: false,
      ftpPasswordConfigured: false,
      encryptionPasswordConfigured: true,
    });
    // Full cloud archive backup has NEVER run:
    mockCloudApi.getSyncStatus.mockResolvedValue({
      configured: true,
      connected: true,
      lastSyncTime: undefined,
      remoteVersionCount: 0,
    });
    // Incremental cloud sync HAS succeeded:
    mockDataGovApi.getSyncStatus.mockResolvedValue({
      device_id: 'device-w10',
      last_sync_at: null,
      total_pending_changes: 0,
      total_synced_changes: 12,
      databases: [
        {
          id: 'vfs',
          has_change_log: true,
          pending_changes: 0,
          synced_changes: 12,
          last_sync_at: '2026-11-25 07:40:10',
        },
      ],
    });

    render(<CloudStorageSection isDialog />);

    const testConnBtn = await screen.findByRole('button', { name: /测试连接/ });
    await waitFor(() => expect(testConnBtn).not.toBeDisabled());
    fireEvent.click(testConnBtn);

    const deviceSyncRow = await screen.findByTestId('cloud-device-last-sync');
    await waitFor(() => {
      expect(deviceSyncRow.textContent).not.toContain('从未同步');
      expect(deviceSyncRow.textContent).toMatch(/2026/);
    });

    const archiveRow = screen.getByTestId('cloud-last-archive-backup');
    expect(archiveRow.textContent).toContain('最近整包云备份');
    expect(archiveRow.textContent).toContain('暂无整包备份');

    // SyncSettingsSection also resolves per-DB incremental last_sync_at
    render(<SyncSettingsSection />);
    await waitFor(() => {
      expect(mockDataGovApi.getSyncStatus).toHaveBeenCalled();
    });
  });

  it('S5-02 & S5-17: DevicePairingSection re-fetches stored cloud config on save events and suppresses stale unconfigured warning', async () => {
    mockCreatePairingCode.mockResolvedValue({
      pairingCode: 'DSPAIR1:TESTCODE',
      summary: {
        cloudProvider: 'webdav',
        llmProviders: 0,
        includeSkills: false,
        includePlugins: false,
      },
    });

    render(<DevicePairingSection cloudConfigured={false} />);

    // Initially unconfigured -> warning is shown
    expect(screen.getByText(/当前尚未保存云存储配置/)).toBeInTheDocument();

    // User saves WebDAV config -> resolveCloudStorageConfig returns saved config & event fires
    mockCloudApi.resolveCloudStorageConfig.mockResolvedValue(SAVED_WEBDAV_CONFIG);
    mockCloudApi.loadStoredCloudStorageConfigSafe.mockReturnValue(SAVED_WEBDAV_CONFIG);

    act(() => {
      window.dispatchEvent(new Event('data-governance:cloud-config-changed'));
    });

    await waitFor(() => {
      expect(screen.queryByText(/当前尚未保存云存储配置/)).not.toBeInTheDocument();
    });

    // Generating a pairing code passes SSOT-backed cloud_storage.config.safe_v1 to createPairingCode
    const pinInput = screen.getByPlaceholderText(/6 位数字 PIN/);
    fireEvent.change(pinInput, { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('generate-pairing-qr-btn'));

    await waitFor(() => expect(mockCreatePairingCode).toHaveBeenCalledTimes(1));
    const passedSettingsStore = mockCreatePairingCode.mock.calls[0][0];
    const resolvedSafeJson = await passedSettingsStore.get('cloud_storage.config.safe_v1');
    expect(JSON.parse(resolvedSafeJson)).toMatchObject({ provider: 'webdav' });
  });

  it('S5-17: Mobile 360px DataGovernanceDashboard wraps all 7+ tabs cleanly with auto height and never blocks clicking "概览"', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 360,
    });

    const { rerender } = render(
      <DataGovernanceDashboard tabTarget={{ tab: 'sync', requestId: 1 }} />,
    );

    const tabList = within(screen.getByTestId('governance-tabs-strip')).getByRole('tablist');
    expect(tabList.className).toContain('!flex');
    expect(tabList.className).toContain('!h-auto');
    expect(tabList.className).toContain('flex-nowrap');
    expect(tabList.className).toContain('overflow-x-auto');
    expect(tabList.style.height).toBe('auto');

    const syncTab = screen.getByRole('tab', { name: '同步' });
    await waitFor(() => expect(syncTab).toHaveAttribute('aria-selected', 'true'));

    // Click through every governance tab on 360px viewport, ending back on "概览"
    for (const tabLabel of ['恢复', '归档', '备份', '审计', '缓存', '概览']) {
      const trigger = screen.getByRole('tab', { name: tabLabel });
      clickRadixTab(trigger);
      expect(trigger).toHaveAttribute('aria-selected', 'true');
    }

    // Re-rendering with a new object reference carrying the SAME requestId must NOT snap away from "概览"
    rerender(<DataGovernanceDashboard tabTarget={{ tab: 'sync', requestId: 1 }} />);
    expect(screen.getByRole('tab', { name: '概览' })).toHaveAttribute('aria-selected', 'true');
  });

  it('S5-08 & S5-07: Maintenance "查看详情" opens & scrolls to active Sync panel, unsynced table counts expand, and top-level "立即同步" runs sync', async () => {
    const scrollSpy = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollSpy,
    });

    mockCloudApi.resolveCloudStorageConfig.mockResolvedValue(SAVED_WEBDAV_CONFIG);
    mockCloudApi.loadStoredCloudStorageConfigSafe.mockReturnValue(SAVED_WEBDAV_CONFIG);
    mockCloudApi.loadStoredCloudStorageConfigWithCredentials.mockResolvedValue({
      ...SAVED_WEBDAV_CONFIG,
      webdav: { ...SAVED_WEBDAV_CONFIG.webdav, password: 'secret' },
      encryptionPassword: 'password123',
    });
    mockDataGovApi.getSyncStatus.mockResolvedValue({
      device_id: 'device-w10',
      last_sync_at: '2026-11-25T07:40:10Z',
      total_pending_changes: 23,
      total_synced_changes: 50,
      databases: [
        {
          id: 'vfs',
          has_change_log: true,
          pending_changes: 23,
          synced_changes: 50,
          last_sync_at: '2026-11-25T07:40:10Z',
        },
      ],
    });
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'data_governance_get_pending_breakdown') {
        return {
          total_pending_changes: 23,
          databases: [
            {
              id: 'vfs',
              pending_changes: 23,
              tables: [
                {
                  table_name: 'notes',
                  count: 23,
                  operations: { insert: 10, update: 13 },
                  sample_record_ids: ['note-1', 'note-2'],
                },
              ],
            },
          ],
        };
      }
      if (cmd === 'data_governance_list_unsynced_items') {
        return {
          items: [],
          itemsTruncated: false,
          totalUnsynced: 0,
          blobEntriesTotal: 0,
          assetEntriesTotal: 0,
          encryptionEnabled: true,
          generatedAt: '2026-11-25T08:00:00Z',
        };
      }
      return null;
    });

    // 1. Active Maintenance Mode + Sync in progress -> clicking "查看详情" opens Sync tab & scrolls to active progress panel
    useSystemStatusStore.getState().enterMaintenanceMode('正在执行云端同步...');
    useGlobalSyncStore.setState({
      isSyncing: true,
      progress: {
        phase: 'uploading',
        current: 10,
        total: 23,
        percent: 43,
        current_item: 'notes',
        speed_bytes_per_sec: 2048,
        eta_seconds: 2,
      },
    });

    const { unmount } = render(<DataGovernanceDashboard />);
    expect(screen.getByRole('tab', { name: '概览' })).toHaveAttribute('aria-selected', 'true');

    const viewDetailsBtn = screen.getByTestId('governance-maintenance-view-details');
    fireEvent.click(viewDetailsBtn);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '同步' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByTestId('active-sync-progress-panel')).toBeInTheDocument();
      expect(scrollSpy).toHaveBeenCalled();
    });

    // Also test global SETTINGS_NAVIGATE_TAB without subTab when user switched back to overview
    clickRadixTab(screen.getByRole('tab', { name: '概览' }));
    expect(screen.getByRole('tab', { name: '概览' })).toHaveAttribute('aria-selected', 'true');
    act(() => {
      dispatchAppEvent(APP_EVENTS.SETTINGS_NAVIGATE_TAB, { tab: 'data-governance' });
    });
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '同步' })).toHaveAttribute('aria-selected', 'true');
    });

    // 2. Expandable DB breakdown in SyncTab ("23 条") and per-table breakdown in UnsyncedItemsPanel ("notes (23)")
    fireEvent.click(screen.getByTestId('sync-pending-breakdown-toggle'));
    const dbToggle = await screen.findByTestId('sync-db-breakdown-toggle-vfs');
    expect(dbToggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(dbToggle);
    expect(dbToggle).toHaveAttribute('aria-expanded', 'true');
    const dbDetail = await screen.findByTestId('sync-db-breakdown-detail-vfs');
    expect(dbDetail.textContent).toContain('notes');
    expect(dbDetail.textContent).toContain('23 条');

    const tableToggle = await screen.findByTestId('pending-table-toggle-vfs-notes');
    expect(tableToggle.textContent).toContain('notes (23)');
    expect(tableToggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(tableToggle);
    expect(tableToggle).toHaveAttribute('aria-expanded', 'true');

    const tableDetail = await screen.findByTestId('pending-table-detail-vfs-notes');
    expect(tableDetail.textContent).toContain('新增 10');
    expect(tableDetail.textContent).toContain('修改 13');
    expect(tableDetail.textContent).toContain('note-1, note-2');
    unmount();

    // 3. Top-level QuickSyncNowButton in Settings Data & System header triggers bidirectional sync
    useGlobalSyncStore.setState({ isSyncing: false, progress: null });
    useSystemStatusStore.setState({
      maintenanceMode: false,
      maintenanceReason: null,
      maintenanceRequiresRestart: false,
    });
    mockRunSyncWithProgress.mockResolvedValue({
      success: true,
      uploaded_changes: 5,
      downloaded_changes: 2,
      conflicts_detected: 0,
      error_message: null,
    });

    render(
      <SettingsCategoryHeader
        category={{
          value: 'data',
          label: '数据与系统',
          icon: (() => null) as unknown as any,
          items: [{ value: 'data-governance', label: '数据治理', icon: (() => null) as unknown as any }],
        }}
        activeTab="data-governance"
        onTabChange={vi.fn()}
        idPrefix="settings-test"
        actions={<QuickSyncNowButton />}
      />,
    );

    const quickSyncBtn = await screen.findByTestId('settings-quick-sync-now-btn');
    expect(quickSyncBtn.textContent).toContain('立即同步');
    fireEvent.click(quickSyncBtn);

    await waitFor(() => {
      expect(mockRunSyncWithProgress).toHaveBeenCalledTimes(1);
    });
    expect(mockRunSyncWithProgress.mock.calls[0][0]).toBe('bidirectional');
  });
});
