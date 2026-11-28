import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import zhSync from '@/locales/zh-CN/sync.json';
import enSync from '@/locales/en-US/sync.json';
import zhData from '@/locales/zh-CN/data.json';
import enData from '@/locales/en-US/data.json';
import type { BackupInfoResponse, SyncStatusResponse } from '@/types/dataGovernance';

const mockNotify = vi.hoisted(() => vi.fn());
const mockInvoke = vi.hoisted(() => vi.fn());
const mockCreatePairingCode = vi.hoisted(() => vi.fn());
const mockApplyPairingCode = vi.hoisted(() => vi.fn());
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
  getMigrationStatus: vi.fn(async () => ({
    databases: [],
    all_healthy: true,
    pending_migrations_count: 0,
  })),
  runHealthCheck: vi.fn(async () => ({
    checked_at: '2026-11-25T06:00:00Z',
    all_healthy: true,
    databases: [],
  })),
  getBackupList: vi.fn(async () => []),
  listBackupJobs: vi.fn(async () => []),
  listResumableJobs: vi.fn(async () => []),
  getMaintenanceStatus: vi.fn(async () => ({ in_maintenance: false, reason: null })),
  getSyncStatus: vi.fn(async () => ({
    device_id: 'device-a',
    last_sync_at: null,
    total_pending_changes: 0,
    total_synced_changes: 0,
    databases: [],
  })),
  getAuditLogs: vi.fn(async () => ({ logs: [], total: 0 })),
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
  checkDiskSpaceForRestore: vi.fn(async () => ({ has_enough_space: true, available_bytes: 1e10, required_bytes: 1e6 })),
  getBackupConfig: vi.fn(async () => ({ autoBackupEnabled: false, intervalHours: 24, maxBackupCount: 10 })),
  setBackupConfig: vi.fn(async () => undefined),
  detectPruneGap: vi.fn(async () => ({ has_gap: false })),
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
    listQuarantine: mockListQuarantine,
  };
});
vi.mock('../../../../../host/plugins/sync/src/device-pairing', () => ({
  createPairingCode: mockCreatePairingCode,
  applyPairingCode: mockApplyPairingCode,
}));
vi.mock('@/hooks/useBackupJobListener', () => ({
  useBackupJobListener: () => ({ startListening: vi.fn(async () => undefined), stopListening: vi.fn() }),
}));
vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: {
    restartApp: vi.fn(async () => undefined),
    getAppVersion: vi.fn(async () => '0.20.9'),
    getDataSpaceInfo: vi.fn(async () => null),
  },
}));
vi.mock('@/features/settings/components/MediaCacheSection', () => ({ MediaCacheSection: () => <div /> }));
vi.mock('@/features/settings/components/IndexMaintenanceSection', () => ({ LanceOptimizationPanel: () => <div /> }));
vi.mock('@/features/settings/components/data-governance/ChatSessionArchiveTab', () => ({ ChatSessionArchiveTab: () => <div /> }));
vi.mock('@/features/data-recovery/RecoveryCenter', () => ({ RecoveryCenter: () => <div data-testid="mock-recovery-center" /> }));

function resolveLocaleText(key: string, opts?: string | Record<string, unknown>): string {
  if (typeof opts === 'string') return opts;
  const lang = mockLanguage.current;
  const lookup = (nsObj: Record<string, unknown>, subKey: string): string | undefined => {
    let cur: unknown = nsObj;
    for (const part of subKey.split('.')) {
      cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined;
    }
    return typeof cur === 'string' ? cur : undefined;
  };
  let template: string | undefined;
  if (key.startsWith('sync:')) {
    template = lookup((lang.startsWith('en') ? enSync : zhSync) as unknown as Record<string, unknown>, key.slice(5));
  } else if (key.startsWith('data:')) {
    template = lookup((lang.startsWith('en') ? enData : zhData) as unknown as Record<string, unknown>, key.slice(5));
  }
  const base = template ?? (typeof opts?.defaultValue === 'string' ? opts.defaultValue : key);
  if (!opts) return base;
  return base.replace(/\{\{(\w+)\}\}/g, (_m, k) => (opts[k] !== undefined ? String(opts[k]) : ''));
}

const stableI18n = {
  get language() { return mockLanguage.current; },
  changeLanguage: async (lng: string) => { mockLanguage.current = lng; },
};

vi.mock('react-i18next', async (orig) => {
  const actual = await orig<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({ t: resolveLocaleText, i18n: stableI18n }),
  };
});

import { DataGovernanceDashboard } from '@/features/settings/components/DataGovernanceDashboard';
import { SyncTab } from '@/features/settings/components/data-governance/SyncTab';
import { DevicePairingSection } from '@/features/settings/components/DevicePairingSection';
import { RecordConflictsPanel } from '@/features/settings/components/data-governance/RecordConflictsPanel';
import { UnsyncedItemsPanel } from '@/features/settings/components/data-governance/UnsyncedItemsPanel';
import { BackupTab } from '@/features/settings/components/data-governance/BackupTab';
import { localizeBackendErrorText } from '@/features/settings/components/data-governance/localizeCloudError';

describe('Stage 5 R3-E UI Regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLanguage.current = 'zh-CN';
    localStorage.clear();
    delete (globalThis as { __DS_WEBUI__?: boolean }).__DS_WEBUI__;
    mockCloudApi.loadStoredCloudStorageConfigSafe.mockReturnValue(null);
    mockCloudApi.loadStoredCloudStorageConfigWithCredentials.mockResolvedValue(null);
    mockCloudApi.resolveCloudStorageConfig.mockResolvedValue(null);
    mockListRecordConflicts.mockResolvedValue([]);
    mockCountRecordConflicts.mockResolvedValue({ total_groups: 0, total_rows: 0, per_database: {} });
    mockListSnapshots.mockResolvedValue([]);
    mockListQuarantine.mockResolvedValue([]);
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'data_governance_get_pending_breakdown') {
        return {
          total_pending_changes: 3,
          databases: [{ id: 'vfs', pending_changes: 3, tables: [{ table_name: 'notes', count: 3 }] }],
        };
      }
      return undefined;
    });
  });

  afterEach(() => {
    delete (globalThis as { __DS_WEBUI__?: boolean }).__DS_WEBUI__;
  });

  it('S5-17: DataGovernanceDashboard hydrates local backups & sync status immediately on Overview cold mount', async () => {
    mockDataGovApi.getBackupList.mockResolvedValue([
      {
        path: 'backup_20261125_pre_restore',
        created_at: '2026-11-25T06:02:54Z',
        size: 2048,
        backup_type: 'full',
        restorable: true,
        databases: ['vfs'],
      },
    ]);
    mockDataGovApi.getSyncStatus.mockResolvedValue({
      device_id: 'dev-overview',
      last_sync_at: '2026-11-25T05:00:00Z',
      total_pending_changes: 2,
      total_synced_changes: 9,
      databases: [],
    });

    render(<DataGovernanceDashboard />);

    await waitFor(() => {
      expect(mockDataGovApi.getBackupList).toHaveBeenCalledTimes(1);
      expect(mockDataGovApi.getSyncStatus).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText('2 KB')).toBeInTheDocument();
  });

  it('S5-01/S5-07/S5-02: SyncTab keeps CloudStorageSection mounted across collapse toggles, exposes accessible sync buttons, and warns on unresolved quarantine', async () => {
    mockListQuarantine.mockResolvedValue([
      {
        id: 1,
        database_name: 'vfs',
        table_name: 'notes',
        record_id: 'n1',
        operation: 'Update',
        payload_json: '{}',
        error_message: 'Constraint',
        source_device_id: 'dev-b',
        quarantined_at: '2026-11-25T06:00:00Z',
        retry_count: 1,
        last_error_at: null,
        resolved_at: null,
      },
    ]);
    const onToggle = vi.fn();
    const onRunSync = vi.fn(async () => true);

    const { rerender } = render(
      <SyncTab
        syncStatus={{
          device_id: 'dev-a-12345678',
          last_sync_at: '2026-11-25T06:00:00Z',
          total_pending_changes: 0,
          total_synced_changes: 5,
          databases: [],
        }}
        conflicts={null}
        loading={false}
        onRefresh={vi.fn()}
        onDetectConflicts={vi.fn()}
        onResolveConflicts={vi.fn()}
        cloudSyncConfigured={true}
        cloudSyncSummary={{ provider: 'webdav', root: 'notes' }}
        syncRunning={false}
        syncProgress={null}
        syncCancelRequested={false}
        onCancelSync={vi.fn()}
        syncStrategy="keep_latest"
        onSyncStrategyChange={vi.fn()}
        showCloudSettingsEditor={true}
        onToggleCloudSettingsEditor={onToggle}
        onSetCloudSettingsEditorOpen={vi.fn()}
        onCloudConfigChanged={vi.fn()}
        onRunSync={onRunSync}
        onRetrySync={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('sync-quarantine-partial-banner')).toHaveTextContent('1 条变更应用失败');
    });

    const toggleBtn = screen.getByRole('button', { name: '收起云存储设置' });
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');

    // Genuine accessible <button> controls for sync
    fireEvent.click(screen.getByRole('button', { name: '立即同步' }));
    expect(onRunSync).toHaveBeenCalledWith('bidirectional', 'keep_latest');
    fireEvent.click(screen.getByRole('button', { name: '双向同步' }));
    expect(onRunSync).toHaveBeenCalledTimes(2);

    // Collapsing switches label to 展开云存储设置 while keeping CloudStorageSection mounted (hidden)
    rerender(
      <SyncTab
        syncStatus={{
          device_id: 'dev-a-12345678',
          last_sync_at: '2026-11-25T06:00:00Z',
          total_pending_changes: 0,
          total_synced_changes: 5,
          databases: [],
        }}
        conflicts={null}
        loading={false}
        onRefresh={vi.fn()}
        onDetectConflicts={vi.fn()}
        onResolveConflicts={vi.fn()}
        cloudSyncConfigured={true}
        cloudSyncSummary={{ provider: 'webdav', root: 'notes' }}
        syncRunning={false}
        syncProgress={null}
        syncCancelRequested={false}
        onCancelSync={vi.fn()}
        syncStrategy="keep_latest"
        onSyncStrategyChange={vi.fn()}
        showCloudSettingsEditor={false}
        onToggleCloudSettingsEditor={onToggle}
        onSetCloudSettingsEditorOpen={vi.fn()}
        onCloudConfigChanged={vi.fn()}
        onRunSync={onRunSync}
        onRetrySync={vi.fn()}
      />,
    );

    const expandBtn = screen.getByRole('button', { name: '展开云存储设置' });
    expect(expandBtn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('cloud-settings-inline-panel')).toHaveAttribute('hidden');
  });

  it('S5-02: DevicePairingSection pushes full snapshot cleanly and pulls on receive', async () => {
    mockCloudApi.loadStoredCloudStorageConfigSafe.mockReturnValue({
      provider: 'webdav',
      root: 'notes',
      webdav: { endpoint: 'https://dav.test/root', username: 'u' },
    } as never);
    mockCreatePairingCode.mockResolvedValue({
      pairingCode: 'DSPAIR1:testpayload',
      summary: { cloudProvider: 'webdav', llmProviders: 0, includeSkills: true, includePlugins: true },
    });
    mockApplyPairingCode.mockResolvedValue({
      applied: { cloud: true, llmProviders: 0, syncPrefs: true },
      summary: { cloudProvider: 'webdav', llmProviders: 0, includeSkills: true, includePlugins: true },
    });
    const onRunSync = vi.fn(async () => true);

    render(<DevicePairingSection onRunSync={onRunSync} cloudConfigured={true} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /生成并立即推送本机最新快照/ })).toBeInTheDocument());

    const pinInput = screen.getByLabelText('生成 PIN（6 位数字）');
    fireEvent.change(pinInput, { target: { value: '123456' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /生成并立即推送本机最新快照/ }));
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('save_setting', {
        key: 'data_governance.pending_full_snapshot_push',
        value: expect.stringMatching(/^\d+$/),
      });
      expect(onRunSync).toHaveBeenCalledWith('upload');
      expect(screen.getByText(/已生成配对码并推送最新快照/)).toBeInTheDocument();
    });

    // Switch to B-side receive tab and click apply + pull
    fireEvent.click(screen.getByRole('tab', { name: /新设备扫码/ }));
    fireEvent.change(screen.getByLabelText(/粘贴 DSPAIR1/), { target: { value: 'DSPAIR1:testpayload' } });
    fireEvent.change(screen.getByLabelText(/配对 PIN/), { target: { value: '123456' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '接入并立即拉取云端数据' }));
    });

    await waitFor(() => {
      expect(onRunSync).toHaveBeenCalledWith('download');
      expect(screen.getByText(/配置已接入并已完成云端数据拉取/)).toBeInTheDocument();
    });
  });

  it('S5-05/S5-07: RecordConflictsPanel displays cloud note body and soft-delete labels and exposes editable body merge textarea', async () => {
    mockListRecordConflicts.mockResolvedValue([
      {
        id: 101,
        table_name: 'notes',
        record_id: 'note-1',
        side: 'local',
        data_json: JSON.stringify({ id: 'note-1', title: 'Local Title', content_md: 'Local Body Text', updated_at: '2026-11-25T05:00:00Z' }),
        winning_device_id: 'dev-b',
        losing_device_id: null,
        detected_at: '2026-11-25T05:05:00Z',
        resolved_at: null,
        resolution: null,
      },
      {
        id: 102,
        table_name: 'notes',
        record_id: 'note-1',
        side: 'cloud',
        data_json: JSON.stringify({ id: 'note-1', title: 'Cloud Title', content_md: 'Cloud Body Text', deleted_at: '2026-11-25T06:00:00Z', updated_at: '2026-11-25T06:00:00Z' }),
        winning_device_id: 'dev-b',
        losing_device_id: 'dev-a',
        detected_at: '2026-11-25T05:05:00Z',
        resolved_at: null,
        resolution: null,
      },
    ]);
    mockCountRecordConflicts.mockResolvedValue({ total: 2, by_table: { notes: 2 } });

    render(<RecordConflictsPanel database="vfs" />);

    const diffSummary = await screen.findByTestId('conflict-content-diff-summary');
    expect(within(diffSummary).getByText('Local Body Text')).toBeInTheDocument();
    expect(within(diffSummary).getByText('Cloud Body Text')).toBeInTheDocument();
    expect(screen.getByText('本地保留编辑')).toBeInTheDocument();
    expect(screen.getByText('对端已移至回收站')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '手动合并' }));
    const editor = await screen.findByTestId('conflict-manual-body-editor');
    expect((editor as HTMLTextAreaElement).value).toBe('Cloud Body Text');
    fireEvent.change(editor, { target: { value: 'Custom Merged Body' } });
    expect((editor as HTMLTextAreaElement).value).toBe('Custom Merged Body');
  });

  it('S5-08/S5-18: UnsyncedItemsPanel displays pending offline uploads and localizeBackendErrorText localizes network & progress strings', async () => {
    render(<UnsyncedItemsPanel showPendingUploads />);

    await waitFor(() => {
      const queue = screen.getByTestId('pending-upload-queue');
      expect(queue).toHaveTextContent('待上传变更 (3)');
      expect(queue).toHaveTextContent('notes (3)');
    });

    expect(localizeBackendErrorText('上传变更失败: socket hang up', 'zh-CN')).toContain(
      '网络连接中断，请检查服务器或网络后重试',
    );
    expect(localizeBackendErrorText('sync:fileSync.complete', 'en-US')).toBe('File sync completed');
    expect(localizeBackendErrorText('sync:fileSync.complete', 'zh-CN')).toBe('文件级同步完成');
  });

  it('S5-13/S5-15: Recovery tab exposes ZIP import & local snapshot restore, and BackupTab renders [恢复前安全快照] badge & unique row aria-labels', async () => {
    const backups: BackupInfoResponse[] = [
      {
        path: 'backup_20261125_pre_restore',
        created_at: '2026-11-25T06:02:54Z',
        size: 4096,
        backup_type: 'full',
        restorable: true,
        databases: ['vfs'],
      },
      {
        path: 'backup_20261125_manual',
        created_at: '2026-11-25T07:10:00Z',
        size: 8192,
        backup_type: 'full',
        restorable: true,
        databases: ['vfs'],
      },
    ];
    mockDataGovApi.getBackupList.mockResolvedValue(backups);

    render(<DataGovernanceDashboard />);
    fireEvent.click(screen.getByRole('tab', { name: '恢复' }));

    const quick = await screen.findByTestId('recovery-quick-actions');
    expect(within(quick).getByRole('button', { name: '导入加密备份 (.zip)' })).toBeInTheDocument();
    expect(within(quick).getByText('从本地快照恢复')).toBeInTheDocument();
    expect(within(quick).getByText('[恢复前安全快照]')).toBeInTheDocument();

    render(
      <BackupTab
        backups={backups}
        loading={false}
        onBackupAndExportZip={vi.fn()}
        onDeleteBackup={vi.fn()}
        onVerifyBackup={vi.fn()}
        onRestoreBackup={vi.fn()}
        onExportZip={vi.fn()}
        onImportZip={vi.fn()}
      />,
    );

    const restoreBtns = screen
      .getAllByRole('button', { name: /恢复 .* 快照/ })
      .map((btn) => btn.getAttribute('aria-label'));
    expect(new Set(restoreBtns).size).toBeGreaterThanOrEqual(2);
  });

  it('S5-05: RecordConflictsPanel uses persistent inline confirm bar for cloud-only keep_local instead of ephemeral 8s window', async () => {
    mockListRecordConflicts.mockResolvedValue([
      {
        id: 'conf-cloud-only-1',
        database_name: 'vfs',
        table_name: 'resources',
        record_id: 'res_cloud_only_1',
        side: 'cloud',
        version: 2,
        data_json: JSON.stringify({ id: 'res_cloud_only_1', title: 'Cloud Only Item', updated_at: 200 }),
        detected_at: '2026-11-25 06:00:00',
        resolved: 0,
        resolution: null,
        resolved_at: null,
      },
    ]);
    mockCountRecordConflicts.mockResolvedValue({ total: 1, unresolved: 1 });
    mockResolveRecordConflict.mockResolvedValue(true);

    render(<RecordConflictsPanel />);

    const keepLocalBtn = await screen.findByRole('button', { name: '保留本地' });
    fireEvent.click(keepLocalBtn);

    expect(mockResolveRecordConflict).not.toHaveBeenCalled();
    const confirmBar = await screen.findByTestId('conflict-keep-local-confirm-bar');
    expect(confirmBar).toBeInTheDocument();

    const confirmBtn = within(confirmBar).getByTestId('conflict-keep-local-confirm-button');
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockResolveRecordConflict).toHaveBeenCalledWith(
        'vfs',
        'resources',
        'res_cloud_only_1',
        'keep_local',
        ['conf-cloud-only-1'],
        undefined,
      );
    });
  });
});
