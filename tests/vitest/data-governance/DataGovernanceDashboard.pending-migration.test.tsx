import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

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

describe('DataGovernanceDashboard pending migration CTA', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue({
      global_version: 10,
      all_healthy: false,
      databases: [],
      pending_migrations_total: 2,
      has_pending_migrations: true,
      last_error: null,
    });

    mockDataGovernanceApi.runHealthCheck.mockResolvedValue({
      overall_healthy: false,
      total_databases: 3,
      initialized_count: 3,
      uninitialized_count: 0,
      dependency_check_passed: true,
      dependency_error: null,
      databases: [],
      checked_at: '2026-02-07T00:00:00Z',
      pending_migrations_count: 2,
      has_pending_migrations: true,
      audit_log_healthy: true,
      audit_log_error: null,
      audit_log_error_at: null,
    });

    mockDataGovernanceApi.getBackupList.mockResolvedValue([]);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
  });

  it('renders pending migration guidance in overview without migration tab CTA', async () => {
    render(<DataGovernanceDashboard embedded />);

    expect(
      await screen.findByText(/检测到待执行迁移|data:governance\.pending_migrations_next_step/i)
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(mockDataGovernanceApi.getMigrationStatus).toHaveBeenCalled();
    });

    expect(
      screen.queryByRole('button', {
        name: /查看迁移|data:governance\.pending_migrations_open_migration/i,
      })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: /迁移|data:governance\.tab_migration/i,
      })
    ).not.toBeInTheDocument();
  });
});
