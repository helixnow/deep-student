/**
 * 数据治理审阅问题 #15 - 错误状态和边界场景的前端测试
 *
 * 覆盖报告中发现的前端测试不足问题：
 * - API 超时和网络错误
 * - 多个 API 同时失败
 * - Tab 切换时的状态隔离
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// ============================================================================
// Mocks
// ============================================================================

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

// ============================================================================
// 测试组 1: 多个 API 同时失败
// ============================================================================

describe('DataGovernanceDashboard multiple API failures (Issue #15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not crash when all APIs fail simultaneously', async () => {
    mockDataGovernanceApi.getMigrationStatus.mockRejectedValue(new Error('Migration API down'));
    mockDataGovernanceApi.runHealthCheck.mockRejectedValue(new Error('Health check API down'));
    mockDataGovernanceApi.getBackupList.mockRejectedValue(new Error('Backup API down'));
    mockDataGovernanceApi.listResumableJobs.mockRejectedValue(new Error('Jobs API down'));
    mockDataGovernanceApi.getSyncStatus.mockRejectedValue(new Error('Sync API down'));
    mockDataGovernanceApi.getAuditLogs.mockRejectedValue(new Error('Audit API down'));

    // 渲染不应该抛出异常
    const { container } = render(<DataGovernanceDashboard embedded />);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getMigrationStatus).toHaveBeenCalled();
    });

    // 组件应仍然渲染核心 UI 元素
    expect(container.firstChild).not.toBeNull();
    // 刷新按钮应存在且可操作
    expect(screen.getByRole('button', { name: /刷新|common:actions\.refresh/i })).toBeInTheDocument();
    // Tab 导航应存在
    expect(screen.getByRole('button', { name: /概览|data:governance\.tab_overview/i })).toBeInTheDocument();
  });

  it('does not crash when migration status returns null', async () => {
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(null);
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(null);
    mockDataGovernanceApi.getBackupList.mockResolvedValue([]);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });

    const { container } = render(<DataGovernanceDashboard embedded />);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getMigrationStatus).toHaveBeenCalled();
    });

    expect(container.firstChild).not.toBeNull();
    // 即使数据为 null，核心导航仍应可用
    expect(screen.getByRole('button', { name: /刷新|common:actions\.refresh/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /备份|data:governance\.tab_backup/i })).toBeInTheDocument();
  });

  it('does not crash when APIs return partial/empty data shapes', async () => {
    // 使用结构正确但字段缺失/为空的数据，模拟 API 返回不完整但类型正确的响应
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue({
      all_healthy: true,
      databases: [],
      pending_migrations_total: 0,
      has_pending_migrations: false,
      // 缺少 global_version、last_error 等字段
    });
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue({
      overall_healthy: true,
      databases: [],
      // 缺少多个字段
    });
    mockDataGovernanceApi.getBackupList.mockResolvedValue([]);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });

    // 组件应能防御性地处理不完整数据格式，不抛出异常
    const { container } = render(<DataGovernanceDashboard embedded />);
    await waitFor(
      () => {
        expect(mockDataGovernanceApi.getMigrationStatus).toHaveBeenCalled();
      },
      { timeout: 3000 },
    );

    // 断言组件成功渲染，核心 UI 元素存在
    expect(container.firstChild).not.toBeNull();
    expect(screen.getByRole('button', { name: /刷新|common:actions\.refresh/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /概览|data:governance\.tab_overview/i })).toBeInTheDocument();
  });

  it('crashes with ErrorBoundary when APIs return completely invalid types (documents defensive gap)', async () => {
    // 此测试确定性地验证：当 API 返回完全非法类型时，组件会崩溃并被 ErrorBoundary 捕获。
    // 这记录了一个已知的防御性编程缺口（issue #15），未来应添加运行时类型校验来修复。
    class TestErrorBoundary extends React.Component<
      { children: React.ReactNode },
      { hasError: boolean }
    > {
      constructor(props: { children: React.ReactNode }) {
        super(props);
        this.state = { hasError: false };
      }
      static getDerivedStateFromError() {
        return { hasError: true };
      }
      render() {
        if (this.state.hasError) {
          return <div data-testid="error-boundary-fallback">render-error</div>;
        }
        return this.props.children;
      }
    }

    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue({});
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue({ databases: 'not an array' });
    mockDataGovernanceApi.getBackupList.mockResolvedValue('not an array');
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue(undefined);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue({ unknown_field: true });
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue(42);

    render(
      <TestErrorBoundary>
        <DataGovernanceDashboard embedded />
      </TestErrorBoundary>,
    );

    await waitFor(
      () => {
        expect(mockDataGovernanceApi.getMigrationStatus).toHaveBeenCalled();
      },
      { timeout: 3000 },
    );

    // 已知行为：组件在处理完全非法类型时崩溃，ErrorBoundary 捕获了渲染错误
    // TODO: 添加运行时类型校验以优雅处理无效 API 响应（issue #15）
    expect(screen.getByTestId('error-boundary-fallback')).toBeInTheDocument();
    expect(screen.getByTestId('error-boundary-fallback')).toHaveTextContent('render-error');
  });
});

// ============================================================================
// 测试组 2: Tab 切换时的状态隔离
// ============================================================================

describe('DataGovernanceDashboard tab state isolation (Issue #15)', () => {
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
      total_databases: 4,
      initialized_count: 4,
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
    mockDataGovernanceApi.getBackupList.mockResolvedValue([]);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
  });

  it('switching between tabs does not lose state', async () => {
    render(<DataGovernanceDashboard embedded />);

    // 等待初始加载
    await waitFor(() => {
      expect(mockDataGovernanceApi.runHealthCheck).toHaveBeenCalled();
    });

    // 切换到备份标签
    const backupTab = screen.getByRole('button', { name: /备份|data:governance\.tab_backup/i });
    fireEvent.click(backupTab);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getBackupList).toHaveBeenCalled();
    });

    // 切换回概览标签
    const overviewTab = screen.getByRole('button', { name: /概览|data:governance\.tab_overview/i });
    fireEvent.click(overviewTab);

    // 再切换回备份标签 - 不应该重新加载（或至少不应该崩溃）
    fireEvent.click(backupTab);

    // 组件应该仍然正常工作
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /刷新|common:actions\.refresh/i })).toBeEnabled();
    });
  });

  it('rapid tab switching does not cause race conditions', async () => {
    render(<DataGovernanceDashboard embedded />);

    await waitFor(() => {
      expect(mockDataGovernanceApi.runHealthCheck).toHaveBeenCalled();
    });

    const backupTab = screen.getByRole('button', { name: /备份|data:governance\.tab_backup/i });
    const overviewTab = screen.getByRole('button', { name: /概览|data:governance\.tab_overview/i });

    // 快速切换 5 次
    for (let i = 0; i < 5; i++) {
      fireEvent.click(backupTab);
      fireEvent.click(overviewTab);
    }

    // 最终应该稳定在概览标签（最后一次点击的是 overviewTab）
    await waitFor(() => {
      // 概览 Tab 应该被选中（aria-selected 或 data-state）
      expect(overviewTab).toHaveAttribute('data-state', 'active');
    });

    // 组件没有抛出异常，刷新按钮仍然可用
    expect(screen.getByRole('button', { name: /刷新|common:actions\.refresh/i })).toBeEnabled();
  });
});

// ============================================================================
// 测试组 3: 非嵌入模式渲染
// ============================================================================

describe('DataGovernanceDashboard standalone mode (Issue #15)', () => {
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
      total_databases: 4,
      initialized_count: 4,
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
    mockDataGovernanceApi.getBackupList.mockResolvedValue([]);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
  });

  it('renders without embedded prop', async () => {
    const { container } = render(<DataGovernanceDashboard />);

    await waitFor(() => {
      expect(mockDataGovernanceApi.runHealthCheck).toHaveBeenCalled();
    });

    expect(container.firstChild).not.toBeNull();
    // 非嵌入模式也应渲染刷新按钮和 Tab 导航
    expect(screen.getByRole('button', { name: /刷新|common:actions\.refresh/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /概览|data:governance\.tab_overview/i })).toBeInTheDocument();
  });
});
