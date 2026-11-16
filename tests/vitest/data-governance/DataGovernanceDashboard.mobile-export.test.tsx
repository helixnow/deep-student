/**
 * 数据治理 Dashboard - 移动端导出与兼容守卫测试
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockStartListening = vi.hoisted(() => vi.fn());
const mockStopListening = vi.hoisted(() => vi.fn());
const mockSaveDialog = vi.hoisted(() => vi.fn());
const mockIsMobilePlatform = vi.hoisted(() => vi.fn(() => true));
const mockShowGlobalNotification = vi.hoisted(() => vi.fn());
const mockOverviewProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

const mockDataGovernanceApi = vi.hoisted(() => ({
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
  scanAssets: vi.fn(),
  checkDiskSpaceForRestore: vi.fn(),
}));
const mockGetBackupConfig = vi.hoisted(() => vi.fn());
const mockSetBackupConfig = vi.hoisted(() => vi.fn());
const mockTranslate = vi.hoisted(() => (key: string) => key);

vi.mock('@/api/dataGovernance', () => ({
  DataGovernanceApi: mockDataGovernanceApi,
  getBackupConfig: mockGetBackupConfig,
  setBackupConfig: mockSetBackupConfig,
  BACKUP_JOB_PROGRESS_EVENT: 'backup-job-progress',
  isBackupJobTerminal: (status: string) =>
    status === 'completed' || status === 'failed' || status === 'cancelled',
}));

vi.mock('@/utils/platform', () => ({
  isMobilePlatform: mockIsMobilePlatform,
  isAndroid: () => mockIsMobilePlatform(),
  isIOS: () => false,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mockShowGlobalNotification,
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: mockTranslate }),
}));

vi.mock('@/hooks/useBackupJobListener', () => ({
  useBackupJobListener: () => ({
    startListening: mockStartListening,
    stopListening: mockStopListening,
  }),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: mockSaveDialog,
}));

vi.mock('@/features/settings/components/MediaCacheSection', () => ({
  MediaCacheSection: () => <div data-testid="media-cache-section" />,
}));

vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: {
    restartApp: vi.fn(),
  },
}));

vi.mock('@/utils/cloudStorageApi', () => ({
  loadStoredCloudStorageConfigSafe: () => null,
  loadStoredCloudStorageConfigWithCredentials: vi.fn().mockResolvedValue(null),
  getCloudPlatformErrorI18nKey: () => undefined,
}));

vi.mock('@/features/settings/components/data-governance/OverviewTab', () => ({
  OverviewTab: (props: Record<string, unknown>) => {
    mockOverviewProps.current = props;
    return <div data-testid="overview-tab" />;
  },
}));
vi.mock('@/features/settings/components/data-governance/SyncTab', () => ({
  SyncTab: () => <div data-testid="sync-tab" />,
}));
vi.mock('@/features/settings/components/data-governance/AuditTab', () => ({
  AuditTab: () => <div data-testid="audit-tab" />,
}));
vi.mock('@/features/settings/components/data-governance/ChatSessionArchiveTab', () => ({
  ChatSessionArchiveTab: () => <div data-testid="archive-tab" />,
}));

import { DataGovernanceDashboard } from '@/features/settings/components/DataGovernanceDashboard';

const sampleBackupList = [
  {
    path: '20260207_120000',
    created_at: '2026-02-07T12:00:00Z',
    size: 1536000,
    backup_type: 'full' as const,
    databases: ['vfs', 'chat_v2'],
  },
];

async function navigateToBackupTab() {
  const backupTab = await screen.findByRole('tab', {
    name: /^(?:备份|data:governance\.tab_backup)$/i,
  });
  fireEvent.click(backupTab);
  await waitFor(() => {
    expect(mockDataGovernanceApi.getBackupList).toHaveBeenCalled();
  });
}

describe('DataGovernanceDashboard mobile export and guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOverviewProps.current = null;
    mockIsMobilePlatform.mockReturnValue(true);
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue({
      global_version: 10,
      all_healthy: true,
      databases: [],
      pending_migrations_total: 0,
      has_pending_migrations: false,
      last_error: null,
    });
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue({
      overall_healthy: true,
      total_databases: 2,
      initialized_count: 2,
      uninitialized_count: 0,
      dependency_check_passed: true,
      dependency_error: null,
      databases: [],
      checked_at: '2026-02-07T00:00:00Z',
      pending_migrations_count: 0,
      has_pending_migrations: false,
      audit_log_healthy: true,
      audit_log_error: null,
      audit_log_error_at: null,
    });
    mockDataGovernanceApi.getBackupList.mockResolvedValue(sampleBackupList);
    mockDataGovernanceApi.listBackupJobs.mockResolvedValue([]);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getMaintenanceStatus.mockResolvedValue({
      is_in_maintenance_mode: false,
      operation: null,
    });
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
    mockDataGovernanceApi.backupAndExportZip.mockResolvedValue({
      job_id: 'mobile-backup-export-1',
      kind: 'export',
      status: 'queued',
      message: 'started',
    });
    mockDataGovernanceApi.exportZip.mockResolvedValue({
      job_id: 'mobile-export-1',
      kind: 'export',
      status: 'queued',
      message: 'started',
    });
    mockGetBackupConfig.mockResolvedValue({
      backupDirectory: null,
      autoBackupEnabled: false,
      autoBackupIntervalHours: 24,
      maxBackupCount: null,
    });
    mockSaveDialog.mockResolvedValue('/tmp/desktop-export.zip');
  });

  it('skips save() and passes empty outputPath for backupAndExportZip on mobile', async () => {
    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    const exportBtn = screen.getByRole('button', {
      name: /导出备份|data:governance\.export_backup/i,
    });
    await act(async () => {
      fireEvent.click(exportBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.backupAndExportZip).toHaveBeenCalledTimes(1);
    });
    expect(mockSaveDialog).not.toHaveBeenCalled();
    expect(mockDataGovernanceApi.backupAndExportZip.mock.calls[0][0]).toBe('');
  });

  it('skips save() and passes empty outputPath for exportZip on mobile', async () => {
    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    const exportZipButtons = screen.getAllByRole('button', {
      name: /data:governance\.export_zip/i,
    });
    fireEvent.click(exportZipButtons[0]);

    const confirmBtn = await screen.findByRole('button', {
      name: 'data:governance.export',
    });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.exportZip).toHaveBeenCalledTimes(1);
    });
    expect(mockSaveDialog).not.toHaveBeenCalled();
    expect(mockDataGovernanceApi.exportZip).toHaveBeenCalledWith(
      '20260207_120000',
      '',
      expect.any(Number),
      true,
      undefined,
    );
  });

  it('exposes verify, delete, and resumable job controls on mobile now that storage-mobile implements them', async () => {
    render(<DataGovernanceDashboard embedded />);

    await waitFor(() => {
      expect(mockOverviewProps.current).not.toBeNull();
    });
    expect(typeof mockOverviewProps.current?.onVerifyLatestBackup).toBe('function');

    await navigateToBackupTab();

    expect(mockDataGovernanceApi.listResumableJobs).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('button', { name: 'data:governance.verify' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'common:actions.delete' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'data:governance.export_zip' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'data:governance.restore' }).length).toBeGreaterThan(0);
  });

  it('keeps desktop save() dialog and verify/delete actions intact when not on mobile', async () => {
    mockIsMobilePlatform.mockReturnValue(false);

    render(<DataGovernanceDashboard embedded />);

    await waitFor(() => {
      expect(mockOverviewProps.current).not.toBeNull();
    });
    expect(typeof mockOverviewProps.current?.onVerifyLatestBackup).toBe('function');

    await navigateToBackupTab();

    expect(mockDataGovernanceApi.listResumableJobs).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('button', { name: 'data:governance.verify' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'common:actions.delete' }).length).toBeGreaterThan(0);

    const exportBtn = screen.getByRole('button', {
      name: /导出备份|data:governance\.export_backup/i,
    });
    await act(async () => {
      fireEvent.click(exportBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.backupAndExportZip).toHaveBeenCalledTimes(1);
    });
    expect(mockSaveDialog).toHaveBeenCalledTimes(1);
    expect(mockDataGovernanceApi.backupAndExportZip.mock.calls[0][0]).toBe('/tmp/desktop-export.zip');
  });
});
