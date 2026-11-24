import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import zhData from '@/locales/zh-CN/data.json';
import enData from '@/locales/en-US/data.json';
import zhSync from '@/locales/zh-CN/sync.json';
import enSync from '@/locales/en-US/sync.json';
import zhCloud from '@/locales/zh-CN/cloudStorage.json';
import enCloud from '@/locales/en-US/cloudStorage.json';

const mockNotify = vi.hoisted(() => vi.fn());
const mockCopy = vi.hoisted(() => vi.fn(async () => true));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mockNotify,
}));

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: mockCopy,
}));

vi.mock('@/utils/unifiedDialogs', () => ({
  unifiedConfirm: vi.fn(() => true),
}));

vi.mock('@/features/settings/components/data-governance/RecordConflictsPanel', () => ({
  RecordConflictsPanel: () => <div data-testid="mock-record-conflicts" />,
}));

vi.mock('@/features/settings/components/data-governance/SyncQuarantinePanel', () => ({
  SyncQuarantinePanel: () => <div data-testid="mock-sync-quarantine" />,
}));

vi.mock('@/features/settings/components/data-governance/UnsyncedItemsPanel', () => ({
  UnsyncedItemsPanel: () => <div data-testid="mock-unsynced-items" />,
}));

vi.mock('@/features/settings/components/data-governance/SyncIndicator', () => ({
  SyncIndicator: () => <span data-testid="mock-sync-indicator">No conflicts</span>,
}));

vi.mock('@/features/settings/components/DevicePairingSection', () => ({
  DevicePairingSection: () => <div data-testid="mock-device-pairing" />,
}));

vi.mock('@/features/settings/components/CloudStorageSection', () => ({
  CloudStorageSection: () => <div data-testid="mock-cloud-storage" />,
}));

vi.mock('@/stores/syncStatusStore', () => ({
  useAutoSyncStore: (selector: (s: { enabled: boolean; setEnabled: () => void; intervalMinutes: number; setIntervalMinutes: () => void }) => unknown) =>
    selector({
      enabled: false,
      setEnabled: vi.fn(),
      intervalMinutes: 15,
      setIntervalMinutes: vi.fn(),
    }),
  ensureAutoSyncSchedulerStarted: vi.fn(),
  AUTO_SYNC_INTERVAL_OPTIONS: [5, 15, 30],
}));

const stableGovT = (key: string, opts?: Record<string, unknown>) => {
  if (opts && 'error' in opts) return `${key}:${String(opts.error)}`;
  if (opts && 'name' in opts) return `${key}:${String(opts.name)}`;
  return key;
};
const stableGovI18n = { language: 'zh-CN', changeLanguage: () => Promise.resolve() };
const stableGovTranslation = { t: stableGovT, i18n: stableGovI18n };

vi.mock('react-i18next', () => ({
  useTranslation: () => stableGovTranslation,
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { SyncTab, resolveLatestSyncTimestamp } from '@/features/settings/components/data-governance/SyncTab';
import { OverviewTab } from '@/features/settings/components/data-governance/OverviewTab';
import { BackupTab } from '@/features/settings/components/data-governance/BackupTab';
import { isSyncCancelledMessage, sanitizeAclErrorMessage } from '@/features/settings/components/DataGovernanceDashboard';
import { useSettingsNavigation } from '@/features/settings/components/useSettingsNavigation';
import type { SyncStatusResponse, BackupInfoResponse } from '@/types/dataGovernance';

describe('Stage 5 Data Governance UI & Locale contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { __DS_WEBUI__?: boolean }).__DS_WEBUI__;
  });

  it('SyncTab shows neutral Not checked badge, disables detectConflicts, and shows single CTA when cloud not configured', () => {
    const syncStatus: SyncStatusResponse = {
      device_id: 'device-1234567890-abcdef',
      last_sync_at: null,
      total_pending_changes: 2,
      total_synced_changes: 0,
      databases: [
        {
          id: 'notes',
          has_change_log: true,
          pending_changes: 2,
          synced_changes: 5,
          last_sync_at: '2026-11-24T10:15:00Z',
        },
      ],
    };

    render(
      <SyncTab
        syncStatus={syncStatus}
        conflicts={null}
        loading={false}
        onRefresh={vi.fn()}
        onDetectConflicts={vi.fn()}
        onResolveConflicts={vi.fn()}
        cloudSyncConfigured={false}
        cloudSyncSummary={null}
        syncRunning={false}
        syncProgress={null}
        syncStrategy="keep_latest"
        onSyncStrategyChange={vi.fn()}
        showCloudSettingsEditor={false}
        onToggleCloudSettingsEditor={vi.fn()}
        onSetCloudSettingsEditorOpen={vi.fn()}
        onCloudConfigChanged={vi.fn()}
        onRunSync={vi.fn()}
      />,
    );

    // Neutral badge replaces SyncIndicator when unconfigured
    expect(screen.getByTestId('sync-conflicts-not-checked')).toHaveTextContent('sync:indicator.notChecked');
    expect(screen.queryByTestId('mock-sync-indicator')).not.toBeInTheDocument();

    // Detect conflicts button is disabled with tooltip
    const detectBtn = screen.getByRole('button', { name: 'data:governance.detect_conflicts' });
    expect(detectBtn).toBeDisabled();
    expect(detectBtn).toHaveAttribute('title', 'sync:indicator.configureCloudFirstTooltip');

    // Only single CTA button (configure_now), no duplicate open_cloud_settings
    expect(screen.getByRole('button', { name: 'data:governance.cloud_sync_configure_now' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'data:governance.open_cloud_settings' })).not.toBeInTheDocument();

    // Full deviceId rendered & copyable
    expect(screen.getByTestId('sync-device-id')).toHaveTextContent('device-1234567890-abcdef');
    fireEvent.click(screen.getByRole('button', { name: 'sync:copyDeviceId' }));
    expect(mockCopy).toHaveBeenCalledWith('device-1234567890-abcdef');

    // Computed last_sync_at falls back to newest valid DB timestamp
    expect(resolveLatestSyncTimestamp(syncStatus)).toBe('2026-11-24T10:15:00Z');
    expect(screen.getByTestId('sync-last-sync-at')).not.toHaveTextContent('-');
  });

  it('SyncTab renders explicit Sync Now button when configured and sanitizes ACL errors', () => {
    const onRunSync = vi.fn();
    render(
      <SyncTab
        syncStatus={null}
        conflicts={null}
        loading={false}
        onRefresh={vi.fn()}
        onDetectConflicts={vi.fn()}
        onResolveConflicts={vi.fn()}
        cloudSyncConfigured={true}
        cloudSyncSummary={{ provider: 'webdav', root: '/sync' }}
        syncRunning={false}
        syncProgress={{
          phase: 'failed',
          current: 0,
          total: 0,
          speed_bytes_per_sec: 0,
          eta_seconds: 0,
          error: 'Command sync_quarantine_list not allowed by ACL',
        }}
        syncStrategy="keep_latest"
        onSyncStrategyChange={vi.fn()}
        showCloudSettingsEditor={false}
        onToggleCloudSettingsEditor={vi.fn()}
        onSetCloudSettingsEditorOpen={vi.fn()}
        onCloudConfigChanged={vi.fn()}
        onRunSync={onRunSync}
      />,
    );

    const syncNowBtn = screen.getByRole('button', { name: /sync:syncNow/i });
    fireEvent.click(syncNowBtn);
    expect(onRunSync).toHaveBeenCalledWith('bidirectional', 'keep_latest');

    expect(screen.queryByText(/sync_quarantine_list/)).not.toBeInTheDocument();
    expect(screen.getByText('data:governance.acl_permission_denied')).toBeInTheDocument();
  });

  it('OverviewTab shows storage/backup usage summary and disables verify button when backups empty', () => {
    const sampleBackups: BackupInfoResponse[] = [
      {
        id: 'b1',
        path: '/tmp/b1.zip',
        size: 2048,
        created_at: '2026-11-24T12:00:00Z',
        backup_type: 'full',
        databases: ['chat_v2'],
        tiers: ['P0'],
        include_assets: true,
        is_restorable: true,
      } as unknown as BackupInfoResponse,
    ];

    const { rerender } = render(
      <OverviewTab
        migrationStatus={null}
        healthCheck={null}
        loading={false}
        onRunHealthCheck={vi.fn()}
        backups={[]}
        onVerifyLatestBackup={vi.fn()}
      />,
    );

    expect(screen.getByTestId('overview-storage-backup-summary')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'data:governance.verify_latest_backup' })).toBeDisabled();

    rerender(
      <OverviewTab
        migrationStatus={null}
        healthCheck={null}
        loading={false}
        onRunHealthCheck={vi.fn()}
        backups={sampleBackups}
        onVerifyLatestBackup={vi.fn()}
      />,
    );
    expect(screen.getByTestId('overview-storage-backup-summary')).toHaveTextContent('2 KB');
    expect(screen.getByRole('button', { name: 'data:governance.verify_latest_backup' })).toBeEnabled();
  });

  it('BackupTab renders visible Restore text label and WebUI staged file upload + empty path validation', async () => {
    (globalThis as { __DS_WEBUI__?: boolean }).__DS_WEBUI__ = true;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ path: '/tmp/staged/backup.zip', name: 'backup.zip', size: 100 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const onImportZip = vi.fn();

    try {
      render(
        <BackupTab
          backups={[
            {
              id: 'b1',
              path: '/tmp/b1.zip',
              size: 1024,
              size_bytes: 1024,
              created_at: '2026-11-24T12:00:00Z',
              backup_type: 'full',
              databases: ['chat_v2'],
              tiers: ['P0'],
              include_assets: true,
              is_restorable: true,
            } as unknown as BackupInfoResponse,
          ]}
          loading={false}
          onCreateBackup={vi.fn()}
          onBackupAndExportZip={vi.fn()}
          onDeleteBackup={vi.fn()}
          onVerifyBackup={vi.fn()}
          onRestoreBackup={vi.fn()}
          onExportZip={vi.fn()}
          onImportZip={onImportZip}
        />,
      );

      // Restore button has visible text label
      const restoreButtons = screen.getAllByRole('button', { name: 'data:governance.restore' });
      expect(restoreButtons.some((btn) => btn.textContent?.includes('data:governance.restore'))).toBe(true);

      // Open import dialog
      fireEvent.click(screen.getByRole('button', { name: 'data:governance.import_button' }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      // Empty path confirm click keeps dialog open and shows validation error
      fireEvent.click(screen.getAllByRole('button', { name: 'data:governance.import_button' }).pop()!);
      expect(screen.getByRole('alert')).toHaveTextContent('data:governance.import_file_required');
      expect(onImportZip).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      // Enter keydown with empty path also keeps dialog open and validates
      const pathInput = screen.getByPlaceholderText('data:governance.import_file_path_placeholder');
      fireEvent.keyDown(pathInput, { key: 'Enter' });
      expect(onImportZip).not.toHaveBeenCalled();

      // Upload via <input type="file"> stages bytes to /api/files/stage and auto-fills path
      const fileInput = screen.getByLabelText('data:governance.import_file_label') as HTMLInputElement;
      const fakeFile = new File([new Uint8Array([1, 2, 3])], 'backup.zip', { type: 'application/zip' });
      fireEvent.change(fileInput, { target: { files: [fakeFile] } });

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/files/stage?name=backup.zip',
          expect.objectContaining({ method: 'POST', body: fakeFile }),
        );
        expect((pathInput as HTMLInputElement).value).toBe('/tmp/staged/backup.zip');
      });

      fireEvent.click(screen.getAllByRole('button', { name: 'data:governance.import_button' }).pop()!);
      expect(onImportZip).toHaveBeenCalledWith(undefined, '/tmp/staged/backup.zip');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('DataGovernance helpers sanitize ACL errors, detect cancellations, locales stay accurate, and search keywords cover governance features', () => {
    expect(isSyncCancelledMessage('同步已取消')).toBe(true);
    expect(isSyncCancelledMessage('Sync cancelled by user')).toBe(true);
    expect(isSyncCancelledMessage('Network timeout')).toBe(false);

    expect(
      sanitizeAclErrorMessage('Command secret_cmd not allowed by ACL', (k) => k),
    ).toBe('data:governance.acl_permission_denied');

    // Updated AES-256-GCM copy without violating contract prohibition
    expect(zhData.governance.e2ee_export_note).toContain('AES-256-GCM');
    expect(zhData.governance.e2ee_export_note).toContain('portable_secrets.dsbk');
    expect(zhData.governance.e2ee_export_note).not.toContain('端到端加密');
    expect(enData.governance.e2ee_export_note).toContain('AES-256-GCM');
    expect(enData.governance.e2ee_export_note).toContain('portable_secrets.dsbk');
    expect(enData.governance.e2ee_export_note).not.toMatch(/end-to-end encrypt/i);

    // Sync & cloudStorage en-US pairing/validation keys exist cleanly
    expect(enSync.pairing.tabSend).toBe('Generate QR on this device');
    expect(zhSync.pairing.tabSend).toBe('本机生成二维码');
    expect(enCloud.validation.embeddedCredentials.length).toBeGreaterThan(0);
    expect(zhCloud.validation.rootPathTraversal.length).toBeGreaterThan(0);

    const { result } = renderHook(() => useSettingsNavigation({}));
    const govKeywords = result.current.settingsSearchIndex
      .filter((item) => item.tab === 'data-governance')
      .flatMap((item) => item.keywords);
    expect(govKeywords).toEqual(
      expect.arrayContaining([
        'webdav', 's3', 'ftp', 'sync', '同步', 'pairing', '配对',
        'quarantine', '隔离', 'conflict', '冲突', 'cloud storage', '云存储', 'e2ee',
      ]),
    );
  });
});
