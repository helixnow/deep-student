/**
 * Wave-3B Slice W3B-2 Regression Suite (BUG-3, BUG-4, BUG-7):
 * - BUG-3: Zero dead-end batch-resolve calls (`data_governance_resolve_conflicts`)
 * - BUG-4: Persistent global `unresolvedConflictCount` (reload + QuickSyncNowButton + banners),
 *          real `keep_both` button & cloud-only disable guard, real note title lookup for `resources`,
 *          zero CJK leaks in `en-US` (incl. multi-cloud candidates & friendly field/table labels),
 *          360px responsive diff cards (zero `<table>`), explicit DsAlertDialog rollback confirmation.
 * - BUG-7: Multi-dataset pre-sync summary, first-connect merge notice, and stale foreign-lease
 *          live countdown + ready-to-retry guidance in zh-CN & en-US.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import enData from '@/locales/en-US/data.json';
import enSync from '@/locales/en-US/sync.json';
import zhData from '@/locales/zh-CN/data.json';
import zhSync from '@/locales/zh-CN/sync.json';

const mockInvoke = vi.hoisted(() => vi.fn());
const mockListRecordConflicts = vi.hoisted(() => vi.fn());
const mockCountRecordConflicts = vi.hoisted(() => vi.fn());
const mockResolveRecordConflict = vi.hoisted(() => vi.fn());
const mockPurgeResolvedConflicts = vi.hoisted(() => vi.fn());
const mockListSyncSnapshotBatches = vi.hoisted(() => vi.fn());
const mockRollbackSyncSnapshotBatch = vi.hoisted(() => vi.fn());
const mockListQuarantine = vi.hoisted(() => vi.fn());
const mockDetectConflicts = vi.hoisted(() => vi.fn());
const mockResolveConflicts = vi.hoisted(() => vi.fn());
const mockGetSyncStatus = vi.hoisted(() => vi.fn());
const mockDetectPruneGap = vi.hoisted(() => vi.fn());
const mockRunSyncWithProgress = vi.hoisted(() => vi.fn());
const mockShowGlobalNotification = vi.hoisted(() => vi.fn());
const mockLoadStoredSafe = vi.hoisted(() => vi.fn());
const mockLoadStoredWithCreds = vi.hoisted(() => vi.fn());
const mockResolveCloudStorageConfig = vi.hoisted(() => vi.fn());

let activeLocale: 'en-US' | 'zh-CN' = 'en-US';

function lookupNested(obj: Record<string, unknown>, path: string): string | undefined {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function realTranslate(key: string, opts?: Record<string, unknown>): string {
  const [ns, rest] = key.includes(':') ? key.split(':', 2) : ['sync', key];
  const bundles =
    activeLocale === 'en-US'
      ? { data: enData as Record<string, unknown>, sync: enSync as Record<string, unknown> }
      : { data: zhData as Record<string, unknown>, sync: zhSync as Record<string, unknown> };
  const bundle = bundles[ns as 'data' | 'sync'];
  let value = (bundle ? lookupNested(bundle, rest) : undefined) ?? (typeof opts?.defaultValue === 'string' ? opts.defaultValue : key);
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      if (k === 'defaultValue') continue;
      value = value.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), String(v));
    }
  }
  return value;
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

vi.mock('@/api/dataGovernance', () => ({
  listRecordConflicts: mockListRecordConflicts,
  countRecordConflicts: mockCountRecordConflicts,
  resolveRecordConflict: mockResolveRecordConflict,
  purgeResolvedConflicts: mockPurgeResolvedConflicts,
  listSyncSnapshotBatches: mockListSyncSnapshotBatches,
  rollbackSyncSnapshotBatch: mockRollbackSyncSnapshotBatch,
  listQuarantine: mockListQuarantine,
  detectConflicts: mockDetectConflicts,
  resolveConflicts: mockResolveConflicts,
  getSyncStatus: mockGetSyncStatus,
  detectPruneGap: mockDetectPruneGap,
  runSyncWithProgress: mockRunSyncWithProgress,
  DataGovernanceApi: {
    listRecordConflicts: mockListRecordConflicts,
    countRecordConflicts: mockCountRecordConflicts,
    resolveRecordConflict: mockResolveRecordConflict,
    purgeResolvedConflicts: mockPurgeResolvedConflicts,
    listSyncSnapshotBatches: mockListSyncSnapshotBatches,
    rollbackSyncSnapshotBatch: mockRollbackSyncSnapshotBatch,
    listQuarantine: mockListQuarantine,
    detectConflicts: mockDetectConflicts,
    resolveConflicts: mockResolveConflicts,
    getSyncStatus: mockGetSyncStatus,
    detectPruneGap: mockDetectPruneGap,
    runSyncWithProgress: mockRunSyncWithProgress,
  },
}));

vi.mock('@/utils/cloudStorageApi', () => ({
  loadStoredCloudStorageConfigSafe: mockLoadStoredSafe,
  loadStoredCloudStorageConfigWithCredentials: mockLoadStoredWithCreds,
  resolveCloudStorageConfig: mockResolveCloudStorageConfig,
  getCloudStorageErrorCode: () => undefined,
  getCloudEncryptionErrorI18nKey: () => undefined,
  getCloudPlatformErrorI18nKey: () => undefined,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mockShowGlobalNotification,
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: realTranslate,
    i18n: { language: activeLocale, changeLanguage: () => Promise.resolve() },
  }),
}));

vi.mock('@/features/settings/components/CloudStorageSection', () => ({
  CloudStorageSection: () => <div data-testid="cloud-storage-mock" />,
}));

vi.mock('@/features/settings/components/DevicePairingSection', () => ({
  DevicePairingSection: () => <div data-testid="device-pairing-mock" />,
}));

vi.mock('@/features/settings/components/data-governance/SyncQuarantinePanel', () => ({
  SyncQuarantinePanel: () => <div data-testid="quarantine-mock" />,
}));

vi.mock('@/features/settings/components/data-governance/UnsyncedItemsPanel', () => ({
  UnsyncedItemsPanel: () => <div data-testid="unsynced-mock" />,
}));

import RecordConflictsPanel from '@/features/settings/components/data-governance/RecordConflictsPanel';
import { SyncTab } from '@/features/settings/components/data-governance/SyncTab';
import { QuickSyncNowButton } from '@/features/settings/components/QuickSyncNowButton';
import { ConflictResolutionDialog } from '@/components/ConflictResolutionDialog';
import { formatFriendlySyncError } from '@/features/settings/components/data-governance/localizeCloudError';
import { useGlobalSyncStore } from '@/stores/syncStatusStore';
import { useSettingsShellStore } from '@/stores/settingsShellStore';
import type { RecordConflictRow } from '@/api/dataGovernance';

beforeEach(() => {
  vi.clearAllMocks();
  activeLocale = 'en-US';
  window.localStorage.clear();
  useGlobalSyncStore.getState().setUnresolvedConflictCount(0);
  useSettingsShellStore.setState({ activeTab: 'apis', dataGovernanceTabTarget: null });
  mockInvoke.mockResolvedValue(null);
  mockListRecordConflicts.mockResolvedValue([]);
  mockCountRecordConflicts.mockResolvedValue({ per_database: {}, total_groups: 0, total_rows: 0 });
  mockResolveRecordConflict.mockResolvedValue(undefined);
  mockPurgeResolvedConflicts.mockResolvedValue(0);
  mockListSyncSnapshotBatches.mockResolvedValue([]);
  mockRollbackSyncSnapshotBatch.mockResolvedValue({
    batch_id: 'b1',
    restored: 1,
    deleted: 0,
    skipped: 0,
    undo_batch_id: 'u1',
  });
  mockListQuarantine.mockResolvedValue([]);
  mockLoadStoredSafe.mockReturnValue({ provider: 'webdav', root: 'sync' });
  mockLoadStoredWithCreds.mockResolvedValue({ provider: 'webdav', root: 'sync' });
  mockResolveCloudStorageConfig.mockResolvedValue({ provider: 'webdav', root: 'sync' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('W3B-2 BUG-3: Dead-end batch-resolve eliminated', () => {
  it('ConflictResolutionDialog renders record-level content and NEVER shows dead apply_strategy controls', () => {
    render(
      <ConflictResolutionDialog
        open
        onClose={vi.fn()}
        conflicts={{
          has_conflicts: true,
          needs_migration: false,
          database_conflicts: [{ database_name: 'vfs', conflict_type: 'DataConflict' }],
          record_conflicts: [],
          record_conflict_count: 1,
        }}
        recordConflictsContent={<div data-testid="embedded-record-panel">Record Panel</div>}
      />,
    );

    expect(screen.getByTestId('embedded-record-panel')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply strategy|应用策略/i })).not.toBeInTheDocument();
    expect(mockResolveConflicts).not.toHaveBeenCalled();
  });
});

describe('W3B-2 BUG-4: Keep Both, persistent reminders, resources note titles, en-US zero CJK leaks, 360px cards, explicit rollback dialog', () => {
  it('persists unresolvedConflictCount in localStorage and renders clickable QuickSyncNowButton conflict badge navigating to sync conflicts', async () => {
    mockCountRecordConflicts.mockResolvedValue({
      per_database: { vfs: { groups: 2, rows: 4 } },
      total_groups: 2,
      total_rows: 4,
    });

    await useGlobalSyncStore.getState().refreshUnresolvedConflictCount();
    expect(useGlobalSyncStore.getState().unresolvedConflictCount).toBe(2);
    expect(window.localStorage.getItem('dstu-unresolved-conflicts-v1')).toBe('2');

    render(<QuickSyncNowButton cloudConfiguredOverride />);

    const badge = await screen.findByTestId('quick-sync-conflict-badge');
    expect(badge).toHaveTextContent('2 conflict(s)');

    fireEvent.click(badge);
    expect(useSettingsShellStore.getState().activeTab).toBe('data-governance');
    expect(useSettingsShellStore.getState().dataGovernanceTabTarget?.tab).toBe('sync');
  });

  it('RecordConflictsPanel: Keep Both resolves via keep_both, resolves real note title for resources conflicts, leaks ZERO CJK in en-US (multi-cloud), uses zero <table> in manual merge, and confirms rollback via DsAlertDialog', async () => {
    activeLocale = 'en-US';
    const user = userEvent.setup();
    const resourceConflictRows: RecordConflictRow[] = [
      {
        id: 101,
        database_name: 'vfs',
        table_name: 'resources',
        record_id: 'res-uuid-abc12345',
        side: 'local',
        data_json: JSON.stringify({
          id: 'res-uuid-abc12345',
          type: 'note',
          source_id: 'note-uuid-999',
          source_table: 'notes',
          data: 'Local study summary on quantum mechanics',
          updated_at: 1700000001000,
        }),
        winning_device_id: 'device-local-abcdef12',
        losing_device_id: null,
        detected_at: '2026-10-01 09:00:00',
        resolved_at: null,
        resolution: null,
      },
      {
        id: 102,
        database_name: 'vfs',
        table_name: 'resources',
        record_id: 'res-uuid-abc12345',
        side: 'cloud',
        data_json: JSON.stringify({
          id: 'res-uuid-abc12345',
          type: 'note',
          source_id: 'note-uuid-999',
          source_table: 'notes',
          data: 'Older cloud summary',
          updated_at: 1700000002000,
        }),
        winning_device_id: 'device-cloud-11112222',
        losing_device_id: null,
        detected_at: '2026-10-01 09:05:00',
        resolved_at: null,
        resolution: null,
      },
      {
        id: 103,
        database_name: 'vfs',
        table_name: 'resources',
        record_id: 'res-uuid-abc12345',
        side: 'cloud',
        data_json: JSON.stringify({
          id: 'res-uuid-abc12345',
          type: 'note',
          source_id: 'note-uuid-999',
          source_table: 'notes',
          data: 'Latest cloud study summary on quantum mechanics',
          updated_at: 1700000003000,
        }),
        winning_device_id: 'device-cloud-99998888',
        losing_device_id: null,
        detected_at: '2026-10-01 09:10:00',
        resolved_at: null,
        resolution: null,
      },
    ];
    mockListRecordConflicts.mockResolvedValue(resourceConflictRows);
    mockCountRecordConflicts.mockResolvedValue({
      per_database: { vfs: { groups: 1, rows: 3 } },
      total_groups: 1,
      total_rows: 3,
    });
    mockListSyncSnapshotBatches.mockResolvedValue([
      {
        database_name: 'vfs',
        batch_id: 'batch-roll-1',
        reason: 'conflict_resolve',
        created_at: '2026-10-01 09:15:00',
        record_count: 2,
        rolled_back_at: null,
      },
    ]);
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'vfs_get_note') {
        return { id: 'note-uuid-999', title: 'Quantum Mechanics Lecture 5', resourceId: 'res-uuid-abc12345' };
      }
      if (cmd === 'vfs_get_note_content') {
        return 'Local study summary on quantum mechanics';
      }
      return null;
    });

    const { container } = render(<RecordConflictsPanel />);

    // Real note title resolved for `resources` table conflict!
    await waitFor(() => {
      expect(screen.getAllByText('Quantum Mechanics Lecture 5').length).toBeGreaterThanOrEqual(1);
    });

    // Multi-cloud Use Cloud button uses English suffix — ZERO Chinese characters anywhere in en-US!
    expect(screen.getByRole('button', { name: 'Use Cloud (latest/2)' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    expect(container.textContent).not.toContain('（');

    // Manual merge uses responsive diff cards (ZERO <table> for 360px mobile safety) and hides raw column name in editor label
    await user.click(screen.getByRole('button', { name: /Manual Merge/i }));
    const diffContainer = screen.getByTestId('conflict-field-diff-table');
    expect(diffContainer.querySelector('table')).toBeNull();
    expect(screen.getByTestId('conflict-field-diff-cards')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    await user.click(screen.getByRole('button', { name: /Cancel/i }));

    // Keep Both calls resolveRecordConflict with 'keep_both' and all 3 conflict IDs
    const keepBothBtn = screen.getByTestId('conflict-keep-both-button');
    expect(keepBothBtn).toBeEnabled();
    await user.click(keepBothBtn);
    await waitFor(() => {
      expect(mockResolveRecordConflict).toHaveBeenCalledWith(
        'vfs',
        'resources',
        'res-uuid-abc12345',
        'keep_both',
        [101, 102, 103],
        undefined,
        'Conflict copy',
      );
    });

    // Rollback snapshot batch uses explicit DsAlertDialog before executing
    await user.click(screen.getByRole('button', { name: /Roll Back This Batch/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(mockRollbackSyncSnapshotBatch).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: /Confirm Rollback/i }));
    await waitFor(() => {
      expect(mockRollbackSyncSnapshotBatch).toHaveBeenCalledWith('vfs', 'batch-roll-1');
    });
  });

  it('disables Keep Both button on cloud-only delete conflicts (null payload)', async () => {
    mockListRecordConflicts.mockResolvedValue([
      {
        id: 201,
        database_name: 'vfs',
        table_name: 'notes',
        record_id: 'note-del-1',
        side: 'cloud',
        data_json: 'null',
        winning_device_id: null,
        losing_device_id: 'dev-other',
        detected_at: '2026-10-01 10:00:00',
        resolved_at: null,
        resolution: null,
      },
    ]);
    mockCountRecordConflicts.mockResolvedValue({
      per_database: { vfs: { groups: 1, rows: 1 } },
      total_groups: 1,
      total_rows: 1,
    });

    render(<RecordConflictsPanel />);

    const keepBothBtn = await screen.findByTestId('conflict-keep-both-button');
    expect(keepBothBtn).toBeDisabled();
  });
});

describe('W3B-2 BUG-7: Multi-dataset pre-sync summary & foreign lease countdown/retry guidance', () => {
  it('SyncTab displays multi-dataset pre-sync summary, first-connect notice, persistent conflict banner, and live foreign-lease countdown transitioning to ready-to-retry', () => {
    vi.useFakeTimers();
    const baseNow = new Date('2026-10-06T06:00:00.000Z');
    vi.setSystemTime(baseNow);
    const expiresIso = new Date(baseNow.getTime() + 2000).toISOString();
    const foreignLeaseErr = `[E_SYNC_LEASE_HELD] 同步目标租约被其他设备持有：DEV-MACBOOK-99887766（预计 ${expiresIso} 到期）。请等待另一台设备完成同步，或等待租约过期后重试；不要手工覆盖云端同步文件。`;

    activeLocale = 'en-US';
    const onRetrySync = vi.fn();

    render(
      <SyncTab
        syncStatus={{
          has_pending_changes: true,
          total_pending_changes: 4,
          total_synced_changes: 0,
          databases: [
            { id: 'vfs', has_change_log: true, pending_changes: 3, synced_changes: 0, last_sync_at: null },
            { id: 'mistakes', has_change_log: true, pending_changes: 1, synced_changes: 0, last_sync_at: null },
          ],
          last_sync_at: null,
          device_id: 'dev-local-001',
        }}
        conflicts={null}
        loading={false}
        onRefresh={vi.fn()}
        onDetectConflicts={vi.fn()}
        unresolvedConflictCount={2}
        cloudSyncConfigured
        cloudSyncSummary={{ provider: 'webdav', root: 'sync' }}
        syncRunning={false}
        syncProgress={{
          phase: 'failed',
          percent: 0,
          current: 0,
          total: 0,
          current_item: null,
          speed_bytes_per_sec: null,
          eta_seconds: null,
          error: foreignLeaseErr,
        }}
        syncStrategy="keep_latest"
        onSyncStrategyChange={vi.fn()}
        showCloudSettingsEditor={false}
        onToggleCloudSettingsEditor={vi.fn()}
        onSetCloudSettingsEditorOpen={vi.fn()}
        onCloudConfigChanged={vi.fn()}
        onRunSync={vi.fn()}
        onRetrySync={onRetrySync}
      />,
    );

    // Persistent conflict banner in SyncTab
    expect(screen.getByTestId('sync-tab-unresolved-conflicts-banner')).toBeInTheDocument();

    // Multi-dataset pre-sync summary & first-connect notice
    expect(screen.getByTestId('sync-presync-summary')).toBeInTheDocument();
    expect(screen.getByTestId('sync-first-connect-merge-notice')).toBeInTheDocument();

    // Live foreign-lease countdown panel shows holder & remaining seconds
    const countdownPanel = screen.getByTestId('sync-lease-countdown-panel');
    expect(countdownPanel).toHaveTextContent('DEV-MACB...');
    expect(countdownPanel).toHaveTextContent(/2s/);

    // Advance clock past expiry -> transitions automatically to ready-to-retry CTA
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId('sync-lease-countdown-panel')).toHaveTextContent(/passed its expected expiry/i);
    const retryBtn = screen.getByTestId('sync-terminal-retry-btn');
    expect(retryBtn).toHaveTextContent(/Lock Expired/i);
    fireEvent.click(retryBtn);
    expect(onRetrySync).toHaveBeenCalledTimes(1);

    // formatFriendlySyncError localizes foreign lease cleanly with zero CJK leaks in en-US
    const enMsg = formatFriendlySyncError(foreignLeaseErr, realTranslate, 'en-US');
    expect(enMsg).toContain('DEV-MACB...');
    expect(enMsg).not.toMatch(/[\u4e00-\u9fff]/);

    activeLocale = 'zh-CN';
    const zhMsg = formatFriendlySyncError(foreignLeaseErr, realTranslate, 'zh-CN');
    expect(zhMsg).toContain('DEV-MACB...');
    expect(zhMsg).toContain('同步保护锁');
  });
});
