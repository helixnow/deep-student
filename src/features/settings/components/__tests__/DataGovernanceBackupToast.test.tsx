import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupJobEvent } from '@/api/dataGovernance';
import { useUnifiedNotification } from '@/hooks/useUnifiedNotification';

const capturedListener = vi.hoisted(() => ({
  onComplete: null as ((event: BackupJobEvent) => void) | null,
  onError: null as ((event: BackupJobEvent) => void) | null,
  onCancelled: null as ((event?: BackupJobEvent) => void) | null,
  startListening: vi.fn(async () => undefined),
  stopListening: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  getMigrationStatus: vi.fn(async () => ({ current_version: 1, pending: 0, healthy: true })),
  runHealthCheck: vi.fn(async () => ({ overall_healthy: true, checks: [] })),
  getBackupList: vi.fn(async () => []),
  listBackupJobs: vi.fn(async () => []),
  listResumableJobs: vi.fn(async () => []),
  getMaintenanceStatus: vi.fn(async () => ({ is_in_maintenance_mode: false, component_issues: [] })),
  getSyncStatus: vi.fn(async () => null),
  getAuditLogs: vi.fn(async () => ({ logs: [], total: 0 })),
  runBackup: vi.fn(async () => ({ job_id: 'job-fast-1' })),
}));

vi.mock('@/hooks/useBackupJobListener', () => ({
  useBackupJobListener: (callbacks: {
    onComplete?: (event: BackupJobEvent) => void;
    onError?: (event: BackupJobEvent) => void;
    onCancelled?: (event?: BackupJobEvent) => void;
  }) => {
    capturedListener.onComplete = callbacks.onComplete ?? null;
    capturedListener.onError = callbacks.onError ?? null;
    capturedListener.onCancelled = callbacks.onCancelled ?? null;
    return {
      startListening: capturedListener.startListening,
      stopListening: capturedListener.stopListening,
    };
  },
}));

vi.mock('@/api/dataGovernance', () => ({
  DataGovernanceApi: apiMocks,
}));

vi.mock('@/features/settings/components/data-governance/OverviewTab', () => ({
  OverviewTab: () => <div data-testid="mock-overview-tab" />,
}));

vi.mock('@/features/settings/components/data-governance/BackupTab', () => ({
  BackupTab: ({ onCreateLocalBackup }: { onCreateLocalBackup: () => void }) => (
    <button type="button" data-testid="trigger-local-backup" onClick={onCreateLocalBackup}>
      Create Backup
    </button>
  ),
}));

vi.mock('@/features/settings/components/data-governance/SyncTab', () => ({
  SyncTab: () => <div data-testid="mock-sync-tab" />,
}));

vi.mock('@/features/settings/components/data-governance/AuditTab', () => ({
  AuditTab: () => <div data-testid="mock-audit-tab" />,
}));

vi.mock('@/features/settings/components/data-governance/ChatSessionArchiveTab', () => ({
  ChatSessionArchiveTab: () => <div data-testid="mock-archive-tab" />,
}));

vi.mock('@/features/settings/components/data-governance/DataMaintenanceSection', () => ({
  DataMaintenanceSection: () => <div data-testid="mock-maintenance" />,
}));

vi.mock('@/features/data-recovery/RecoveryCenter', () => ({
  RecoveryCenter: () => <div data-testid="mock-recovery-center" />,
}));

vi.mock('@/features/settings/components/MediaCacheSection', () => ({
  MediaCacheSection: () => <div data-testid="mock-media-cache" />,
}));

vi.mock('@/features/settings/components/IndexMaintenanceSection', () => ({
  LanceOptimizationPanel: () => <div data-testid="mock-lance-opt" />,
}));

import { DataGovernanceDashboard } from '../DataGovernanceDashboard';

describe('G11c DataGovernanceDashboard atomic backup toast replacement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListener.onComplete = null;
    capturedListener.onError = null;
    capturedListener.onCancelled = null;
  });

  it('replaces the in-progress backup info toast atomically with the completion success toast instead of stacking both', async () => {
    const { result: toastState } = renderHook(() => useUnifiedNotification());

    render(<DataGovernanceDashboard tabTarget={{ tab: 'backup', seq: 1 }} />);

    const backupBtn = await screen.findByTestId('trigger-local-backup');
    fireEvent.click(backupBtn);

    await waitFor(() => {
      expect(apiMocks.runBackup).toHaveBeenCalledTimes(1);
      expect(toastState.current.notifications).toHaveLength(1);
    });
    expect(toastState.current.notifications[0]?.type).toBe('info');
    expect(toastState.current.notifications[0]?.replaceKey).toBe('data-governance:backup-job');

    // Simulate fast backup completing while the started info toast is still visible
    act(() => {
      capturedListener.onComplete?.({
        job_id: 'job-fast-1',
        stage: 'completed',
        progress: 100,
        message: 'done',
        result: { success: true },
      } as BackupJobEvent);
    });

    await waitFor(() => {
      expect(toastState.current.notifications).toHaveLength(1);
      expect(toastState.current.notifications[0]?.type).toBe('success');
    });
    // Zero lingering "in progress" toast alongside the "success" toast
    expect(toastState.current.notifications.filter((n) => n.type === 'info')).toHaveLength(0);
  });
});
