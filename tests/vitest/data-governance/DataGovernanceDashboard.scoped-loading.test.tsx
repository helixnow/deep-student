import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const mockDataGovernanceApi = vi.hoisted(() => ({
  getMigrationStatus: vi.fn(),
  runHealthCheck: vi.fn(),
  getBackupList: vi.fn(),
  listResumableJobs: vi.fn(),
  getSyncStatus: vi.fn(),
  getAuditLogs: vi.fn(),
}));

const mockStartListening = vi.hoisted(() => vi.fn());
const mockStopListening = vi.hoisted(() => vi.fn());

vi.mock('@/api/dataGovernance', () => ({
  DataGovernanceApi: mockDataGovernanceApi,
  BACKUP_JOB_PROGRESS_EVENT: 'backup-job-progress',
  isBackupJobTerminal: (status: string) =>
    status === 'completed' || status === 'failed' || status === 'cancelled',
}));

vi.mock('@/hooks/useBackupJobListener', () => ({
  useBackupJobListener: () => ({
    startListening: mockStartListening,
    stopListening: mockStopListening,
  }),
}));

vi.mock('@/components/settings/data-governance/MigrationTab', () => ({
  MigrationTab: () => <div data-testid="schema-migration-tab">migration-tab</div>,
}));

vi.mock('@/components/settings/MediaCacheSection', () => ({
  MediaCacheSection: () => <div data-testid="media-cache-section">cache-section</div>,
}));

vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: {
    restartApp: vi.fn(),
  },
}));

import { DataGovernanceDashboard } from '@/components/settings/DataGovernanceDashboard';

describe('DataGovernanceDashboard scoped loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();

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
      total_databases: 3,
      initialized_count: 3,
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

    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
    mockDataGovernanceApi.getBackupList.mockResolvedValue([]);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
  });

  it('does not disable backup controls while overview health check is loading', async () => {
    const manualHealthCheckDeferred = deferred<unknown>();
    mockDataGovernanceApi.runHealthCheck
      .mockResolvedValueOnce({
        overall_healthy: true,
        total_databases: 3,
        initialized_count: 3,
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
      })
      .mockReturnValueOnce(manualHealthCheckDeferred.promise);

    render(<DataGovernanceDashboard embedded />);

    const backupTab = screen.getByRole('button', { name: /备份|data:governance\.tab_backup/i });
    fireEvent.click(backupTab);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /刷新|common:actions\.refresh/i })).toBeEnabled();
    });

    const overviewTab = screen.getByRole('button', { name: /概览|data:governance\.tab_overview/i });
    fireEvent.click(overviewTab);

    const runHealthCheckButton = await screen.findByRole('button', {
      name: /运行健康检查|data:governance\.run_health_check/i,
    });
    fireEvent.click(runHealthCheckButton);

    await waitFor(() => {
      expect(mockDataGovernanceApi.runHealthCheck).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(backupTab);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /刷新|common:actions\.refresh/i })).toBeEnabled();
    });

    manualHealthCheckDeferred.resolve({
      overall_healthy: true,
      total_databases: 3,
      initialized_count: 3,
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
  });
});
