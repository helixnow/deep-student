/**
 * Debug 页签只在开发构建暴露 + 图标页签的读屏可访问名。
 *
 * 生产构建里 Debug 页签的控件全部 `disabled`，页签本身却照常渲染；
 * 移动端（<640px）页签文字被 `hidden sm:inline` 收掉，只剩一个虫子图标，
 * 读屏读出来就是一个无名按钮。这里同时锁住这两条契约。
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const mockDataGovernanceApi = vi.hoisted(() => ({
  getMigrationStatus: vi.fn(),
  runHealthCheck: vi.fn(),
  getBackupList: vi.fn(),
  listResumableJobs: vi.fn(),
  getSyncStatus: vi.fn(),
  getAuditLogs: vi.fn(),
}));

vi.mock('@/api/dataGovernance', () => ({
  DataGovernanceApi: mockDataGovernanceApi,
  BACKUP_JOB_PROGRESS_EVENT: 'backup-job-progress',
  isBackupJobTerminal: (status: string) =>
    status === 'completed' || status === 'failed' || status === 'cancelled',
}));

vi.mock('@/hooks/useBackupJobListener', () => ({
  useBackupJobListener: () => ({
    startListening: vi.fn(),
    stopListening: vi.fn(),
  }),
}));

vi.mock('@/features/settings/components/MediaCacheSection', () => ({
  MediaCacheSection: () => <div data-testid="media-cache-section">cache-section</div>,
}));

vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: { restartApp: vi.fn() },
}));

import { DataGovernanceDashboard } from '@/features/settings';

const TAB_NAMES = [
  /概览|data:governance\.tab_overview/i,
  /恢复|data:governance\.tab_recovery/i,
  /归档|data:governance\.tab_archive/i,
  /备份|data:governance\.tab_backup/i,
  /同步|data:governance\.tab_sync/i,
  /审计|data:governance\.tab_audit/i,
  /缓存|data:governance\.tab_cache/i,
];

const DEBUG_TAB_NAME = /^调试$|data:governance\.debug_tab_title/i;

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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('数据治理页签可访问名', () => {
  it('每个页签都有可访问名（文字在窄屏被隐藏时靠 aria-label 兜底）', () => {
    render(<DataGovernanceDashboard embedded />);

    for (const name of TAB_NAMES) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }

    // 可访问名必须来自 aria-label，而不是只存在于 `hidden sm:inline` 的文字里
    for (const name of TAB_NAMES) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-label');
    }
  });

  it('页签容器带导航可访问名', () => {
    render(<DataGovernanceDashboard embedded />);

    const overviewTab = screen.getByRole('button', { name: TAB_NAMES[0] });
    expect(overviewTab.parentElement).toHaveAttribute('aria-label');
  });
});

describe('Debug 页签的 DEV 门槛', () => {
  it('开发构建下渲染 Debug 页签', () => {
    vi.stubEnv('DEV', true);

    render(<DataGovernanceDashboard embedded />);

    expect(screen.getByRole('button', { name: DEBUG_TAB_NAME })).toBeInTheDocument();
  });

  it('非 DEV（生产构建）不渲染 Debug 页签', () => {
    vi.stubEnv('DEV', false);

    render(<DataGovernanceDashboard embedded />);

    // 其他页签照常在，只有 Debug 消失
    expect(screen.getByRole('button', { name: TAB_NAMES[0] })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: DEBUG_TAB_NAME })).not.toBeInTheDocument();
  });

  it('非 DEV 时外部深链也切不到 debug 页签', async () => {
    vi.stubEnv('DEV', false);

    render(<DataGovernanceDashboard embedded tabTarget={{ tab: 'debug', requestId: 1 }} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: TAB_NAMES[0] })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: DEBUG_TAB_NAME })).not.toBeInTheDocument();
    expect(screen.queryByTestId('slot-c-empty-db-test-button')).not.toBeInTheDocument();
  });
});
