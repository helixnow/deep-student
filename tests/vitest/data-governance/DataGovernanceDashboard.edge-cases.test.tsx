/**
 * 数据治理 Dashboard - 边缘情况测试
 *
 * 覆盖：
 * 1. 空数据库列表
 * 2. 超大备份列表（100 个）
 * 3. 并发操作冲突
 * 4. formatBytes 边缘情况
 * 5. 审计日志为空
 * 6. 维护模式下 UI 状态
 * 7. unmount 时清理
 * 8. Tab 切换数据加载
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
  runBackup: vi.fn(),
  restoreBackup: vi.fn(),
  verifyBackup: vi.fn(),
  deleteBackup: vi.fn(),
  checkDiskSpaceForRestore: vi.fn(),
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
import {
  formatBytes,
  getAssetTypeDisplayName,
  getDatabaseDisplayName,
  getBackupTierDisplayName,
  getBackupTierDescription,
  getSyncPhaseName,
} from '@/types/dataGovernance';
import { useSystemStatusStore } from '@/stores/systemStatusStore';

// ============================================================================
// 默认 mock 数据
// ============================================================================

const healthyMigrationStatus = {
  global_version: 10,
  all_healthy: true,
  databases: [],
  pending_migrations_total: 0,
  has_pending_migrations: false,
  last_error: null,
};

const healthyHealthCheck = {
  overall_healthy: true,
  total_databases: 4,
  initialized_count: 4,
  uninitialized_count: 0,
  dependency_check_passed: true,
  dependency_error: null,
  databases: [
    {
      id: 'vfs',
      is_healthy: true,
      dependencies_met: true,
      schema_version: 20260206,
      target_version: 20260206,
      pending_count: 0,
      issues: [],
    },
    {
      id: 'chat_v2',
      is_healthy: true,
      dependencies_met: true,
      schema_version: 20260207,
      target_version: 20260207,
      pending_count: 0,
      issues: [],
    },
  ],
  checked_at: '2026-02-07T00:00:00Z',
  pending_migrations_count: 0,
  has_pending_migrations: false,
  audit_log_healthy: true,
  audit_log_error: null,
  audit_log_error_at: null,
};

function setupDefaultMocks() {
  mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
  mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);
  mockDataGovernanceApi.getBackupList.mockResolvedValue([]);
  mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
  mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
  mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
  mockDataGovernanceApi.checkDiskSpaceForRestore.mockResolvedValue({ has_enough_space: true, available_bytes: 10737418240, required_bytes: 2147483648, backup_size: 1536000 });
}

/** 生成 N 个备份条目，按时间倒序排列（index 0 最新） */
function generateBackups(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    path: `backup_${String(i).padStart(4, '0')}`,
    created_at: new Date(2026, 1, 7, 12, 0, count - i).toISOString(),
    size: 1024000 + i * 1000,
    backup_type: 'full' as const,
    databases: ['vfs', 'chat_v2'],
  }));
}

// ============================================================================
// 测试组 1: 空数据库列表
// ============================================================================

describe('Edge case: empty databases list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('renders normally when health check returns empty databases array', async () => {
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue({
      ...healthyHealthCheck,
      databases: [],
      total_databases: 0,
      initialized_count: 0,
    });

    const { container } = render(<DataGovernanceDashboard embedded />);

    await waitFor(() => {
      expect(mockDataGovernanceApi.runHealthCheck).toHaveBeenCalled();
    });

    // 组件应正常渲染，核心 UI 元素存在
    expect(container.firstChild).not.toBeNull();
    // 刷新按钮应可用
    expect(screen.getByRole('button', { name: /刷新|common:actions\.refresh/i })).toBeInTheDocument();

    // 空数据库列表应显示"暂无数据"
    expect(screen.getByText(/暂无数据|data:governance\.no_data/i)).toBeInTheDocument();

    // Tab 按钮仍然可用
    expect(
      screen.getByRole('button', { name: /备份|data:governance\.tab_backup/i }),
    ).toBeInTheDocument();
  });

  it('shows 0/0 initialized count when databases are empty', async () => {
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue({
      ...healthyHealthCheck,
      databases: [],
      total_databases: 0,
      initialized_count: 0,
    });

    render(<DataGovernanceDashboard embedded />);

    await waitFor(() => {
      expect(mockDataGovernanceApi.runHealthCheck).toHaveBeenCalled();
    });

    // 应显示 0/0 已初始化
    expect(screen.getByText('0/0')).toBeInTheDocument();
  });
});

// ============================================================================
// 测试组 2: 超大备份列表
// ============================================================================

describe('Edge case: large backup list (100 items)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('renders 100 backup items without errors', async () => {
    const largeBackupList = generateBackups(100);
    mockDataGovernanceApi.getBackupList.mockResolvedValue(largeBackupList);

    render(<DataGovernanceDashboard embedded />);

    // 导航到备份 Tab
    const backupTab = await screen.findByRole('button', {
      name: /备份|data:governance\.tab_backup/i,
    });
    fireEvent.click(backupTab);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getBackupList).toHaveBeenCalled();
    });

    // 不应该显示"暂无备份"
    expect(screen.queryByText(/暂无备份|data:governance\.no_backups/i)).not.toBeInTheDocument();

    // 验证备份条目被渲染（多条大小可能相同，使用 getAllByText）
    const firstBackupSizeElements = screen.getAllByText(formatBytes(largeBackupList[0].size));
    expect(firstBackupSizeElements.length).toBeGreaterThan(0);

    const lastBackupSizeElements = screen.getAllByText(formatBytes(largeBackupList[99].size));
    expect(lastBackupSizeElements.length).toBeGreaterThan(0);

    // 验证所有 100 条记录都被渲染（通过操作按钮计数：每行 4 个操作按钮）
    const verifyButtons = screen.getAllByTitle(/验证|data:governance\.verify/i);
    expect(verifyButtons).toHaveLength(100);
  });

  it('shows the latest backup (index 0) in the rendered list', async () => {
    const backups = generateBackups(5);
    mockDataGovernanceApi.getBackupList.mockResolvedValue(backups);

    render(<DataGovernanceDashboard embedded />);

    const backupTab = await screen.findByRole('button', {
      name: /备份|data:governance\.tab_backup/i,
    });
    fireEvent.click(backupTab);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getBackupList).toHaveBeenCalled();
    });

    // 验证所有备份条目都被渲染（通过唯一的 size 文本判断）
    for (const backup of backups) {
      expect(screen.getByText(formatBytes(backup.size))).toBeInTheDocument();
    }
  });
});

// ============================================================================
// 测试组 3: 并发操作冲突
// ============================================================================

describe('Edge case: concurrent operation conflict', () => {
  const singleBackup = {
    path: 'backup_concurrent_test',
    created_at: '2026-02-07T12:00:00Z',
    size: 1536000,
    backup_type: 'full' as const,
    databases: ['vfs', 'chat_v2'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
    mockDataGovernanceApi.getBackupList.mockResolvedValue([singleBackup]);
    // 重置维护模式
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  afterEach(() => {
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  it('disables restore/delete/export buttons when a backup is already running', async () => {
    mockDataGovernanceApi.runBackup.mockResolvedValue({
      job_id: 'concurrent-job-001',
      kind: 'export',
      status: 'queued',
      message: 'Job started',
    });

    render(<DataGovernanceDashboard embedded />);

    // 导航到备份 Tab
    const backupTab = await screen.findByRole('button', {
      name: /备份|data:governance\.tab_backup/i,
    });
    fireEvent.click(backupTab);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getBackupList).toHaveBeenCalled();
    });

    // 操作按钮在备份开始前应可用
    const restoreBtn = screen.getByTitle(/恢复|data:governance\.restore/i);
    const deleteBtn = screen.getByTitle(/删除|common:actions\.delete/i);
    expect(restoreBtn).toBeEnabled();
    expect(deleteBtn).toBeEnabled();

    // 启动备份
    const createBtn = screen.getByRole('button', {
      name: /完整备份|data:governance\.create_full_backup/i,
    });
    await act(async () => {
      fireEvent.click(createBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.runBackup).toHaveBeenCalled();
    });

    // 备份运行中，其他操作按钮应被禁用
    expect(restoreBtn).toBeDisabled();
    expect(deleteBtn).toBeDisabled();

    // 创建备份按钮自身也应被禁用
    expect(createBtn).toBeDisabled();
  });

  it('blocks second backup attempt when one is already running', async () => {
    mockDataGovernanceApi.runBackup.mockResolvedValue({
      job_id: 'concurrent-job-002',
      kind: 'export',
      status: 'queued',
      message: 'Job started',
    });

    render(<DataGovernanceDashboard embedded />);

    const backupTab = await screen.findByRole('button', {
      name: /备份|data:governance\.tab_backup/i,
    });
    fireEvent.click(backupTab);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getBackupList).toHaveBeenCalled();
    });

    // 启动第一次备份
    const createBtn = screen.getByRole('button', {
      name: /完整备份|data:governance\.create_full_backup/i,
    });
    await act(async () => {
      fireEvent.click(createBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.runBackup).toHaveBeenCalledTimes(1);
    });

    // 第二次点击 —— 按钮已被禁用，click 不应触发第二次 API 调用
    await act(async () => {
      fireEvent.click(createBtn);
    });

    // runBackup 应仍然只被调用 1 次
    expect(mockDataGovernanceApi.runBackup).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// 测试组 4: formatBytes 边缘情况
// ============================================================================

describe('Edge case: formatBytes utility', () => {
  it('returns "0 B" for zero bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('returns absolute value for negative numbers', () => {
    expect(() => formatBytes(-1)).not.toThrow();
    expect(formatBytes(-1)).toBe('1 B');
    expect(formatBytes(-1024)).toBe('1 KB');
  });

  it('formats 1 TB correctly with TB unit', () => {
    expect(() => formatBytes(1099511627776)).not.toThrow();
    expect(formatBytes(1099511627776)).toBe('1 TB');
  });

  it('formats PB-scale values without crashing', () => {
    // 1 PB = 1024^5 = 1125899906842624
    expect(() => formatBytes(1125899906842624)).not.toThrow();
    expect(formatBytes(1125899906842624)).toBe('1 PB');
  });

  it('clamps index for values exceeding PB', () => {
    // Very large value that exceeds PB — should still show PB unit
    const exabyteish = 1125899906842624 * 1024; // ~1 EB
    expect(() => formatBytes(exabyteish)).not.toThrow();
    const result = formatBytes(exabyteish);
    expect(result).toContain('PB');
  });

  it('returns "0 B" for NaN', () => {
    expect(() => formatBytes(NaN)).not.toThrow();
    expect(formatBytes(NaN)).toBe('0 B');
  });

  it('returns "0 B" for Infinity', () => {
    expect(() => formatBytes(Infinity)).not.toThrow();
    expect(formatBytes(Infinity)).toBe('0 B');
    expect(formatBytes(-Infinity)).toBe('0 B');
  });

  it('formats standard byte values correctly', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1048576)).toBe('1 MB');
    expect(formatBytes(1073741824)).toBe('1 GB');
  });

  it('formats fractional values with up to 2 decimal places', () => {
    // 1.5 KB = 1536 bytes
    expect(formatBytes(1536)).toBe('1.5 KB');
    // 2.5 MB = 2621440 bytes
    expect(formatBytes(2621440)).toBe('2.5 MB');
  });
});

// ============================================================================
// 测试组 5: 审计日志为空
// ============================================================================

describe('Edge case: empty audit logs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
  });

  it('displays empty state message when switching to audit tab with no logs', async () => {
    render(<DataGovernanceDashboard embedded />);

    // 切换到审计 Tab
    const auditTab = await screen.findByRole('button', {
      name: /审计|data:governance\.tab_audit/i,
    });
    fireEvent.click(auditTab);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getAuditLogs).toHaveBeenCalled();
    });

    // 应显示"暂无日志"空状态消息
    expect(screen.getByText(/暂无日志|data:governance\.no_logs/i)).toBeInTheDocument();
  });

  it('does not show any log table rows when audit logs are empty', async () => {
    render(<DataGovernanceDashboard embedded />);

    const auditTab = await screen.findByRole('button', {
      name: /审计|data:governance\.tab_audit/i,
    });
    fireEvent.click(auditTab);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getAuditLogs).toHaveBeenCalled();
    });

    // 不应该有任何审计状态标签（已完成/失败/进行中）
    expect(screen.queryByText(/已完成|data:governance\.status_completed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/失败|data:governance\.status_failed/i)).not.toBeInTheDocument();
  });
});

// ============================================================================
// 测试组 6: 维护模式下 UI 状态
// ============================================================================

describe('Edge case: maintenance mode UI state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  afterEach(() => {
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  it('enters maintenance mode when backup operation starts', async () => {
    mockDataGovernanceApi.runBackup.mockResolvedValue({
      job_id: 'maintenance-job-001',
      kind: 'export',
      status: 'queued',
      message: 'Job started',
    });

    render(<DataGovernanceDashboard embedded />);

    const backupTab = await screen.findByRole('button', {
      name: /备份|data:governance\.tab_backup/i,
    });
    fireEvent.click(backupTab);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getBackupList).toHaveBeenCalled();
    });

    // 备份前：不在维护模式
    expect(useSystemStatusStore.getState().maintenanceMode).toBe(false);
    expect(useSystemStatusStore.getState().maintenanceReason).toBeNull();

    // 启动备份
    const createBtn = screen.getByRole('button', {
      name: /完整备份|data:governance\.create_full_backup/i,
    });
    await act(async () => {
      fireEvent.click(createBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.runBackup).toHaveBeenCalled();
    });

    // 备份后：应进入维护模式
    expect(useSystemStatusStore.getState().maintenanceMode).toBe(true);
    expect(useSystemStatusStore.getState().maintenanceReason).toBeTruthy();
  });

  it('setting maintenanceMode externally does not crash the dashboard', async () => {
    // 先进入维护模式
    useSystemStatusStore.getState().enterMaintenanceMode('外部维护操作');

    // 渲染组件不应崩溃
    const { container } = render(<DataGovernanceDashboard embedded />);

    await waitFor(() => {
      expect(mockDataGovernanceApi.runHealthCheck).toHaveBeenCalled();
    });

    expect(container.firstChild).not.toBeNull();
    // 刷新按钮和 Tab 导航应存在
    expect(screen.getByRole('button', { name: /刷新|common:actions\.refresh/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /概览|data:governance\.tab_overview/i })).toBeInTheDocument();
    // 维护模式状态应保持
    expect(useSystemStatusStore.getState().maintenanceMode).toBe(true);
  });

  it('disables all backup action buttons while isBackupRunning is true', async () => {
    mockDataGovernanceApi.runBackup.mockResolvedValue({
      job_id: 'maintenance-job-002',
      kind: 'export',
      status: 'queued',
      message: 'Job started',
    });

    render(<DataGovernanceDashboard embedded />);

    const backupTab = await screen.findByRole('button', {
      name: /备份|data:governance\.tab_backup/i,
    });
    fireEvent.click(backupTab);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getBackupList).toHaveBeenCalled();
    });

    // 启动备份 → 进入维护模式 + isBackupRunning
    const createBtn = screen.getByRole('button', {
      name: /完整备份|data:governance\.create_full_backup/i,
    });
    await act(async () => {
      fireEvent.click(createBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.runBackup).toHaveBeenCalled();
    });

    // 完整备份按钮被禁用
    expect(createBtn).toBeDisabled();

    // 增量备份按钮被禁用
    const incrementalBtn = screen.getByRole('button', {
      name: /增量备份|data:governance\.create_incremental_backup/i,
    });
    expect(incrementalBtn).toBeDisabled();
  });
});

// ============================================================================
// 测试组 7: unmount 时清理
// ============================================================================

describe('Edge case: unmount cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  afterEach(() => {
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  it('calls stopListening on component unmount', async () => {
    const { unmount } = render(<DataGovernanceDashboard embedded />);

    await waitFor(() => {
      expect(mockDataGovernanceApi.runHealthCheck).toHaveBeenCalled();
    });

    // 卸载组件
    unmount();

    // useEffect cleanup 应调用 stopListening
    expect(mockStopListening).toHaveBeenCalled();
  });

  it('does not produce memory leak warnings after unmount with active backup', async () => {
    // 监听 React 内部警告（"state update on unmounted component" 在 React 18 已移除，
    // 但仍验证不会有其他未预期的错误输出）
    const consoleErrorSpy = vi.spyOn(globalThis.console, 'error').mockImplementation(() => {});

    mockDataGovernanceApi.runBackup.mockResolvedValue({
      job_id: 'unmount-job-001',
      kind: 'export',
      status: 'queued',
      message: 'Job started',
    });

    const { unmount } = render(<DataGovernanceDashboard embedded />);

    // 导航到备份 Tab
    const backupTab = await screen.findByRole('button', {
      name: /备份|data:governance\.tab_backup/i,
    });
    fireEvent.click(backupTab);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getBackupList).toHaveBeenCalled();
    });

    // 启动备份
    const createBtn = screen.getByRole('button', {
      name: /完整备份|data:governance\.create_full_backup/i,
    });
    await act(async () => {
      fireEvent.click(createBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.runBackup).toHaveBeenCalled();
    });

    // 在备份进行中卸载组件
    unmount();

    // stopListening 应被调用（清理事件监听）
    expect(mockStopListening).toHaveBeenCalled();

    // 验证没有 "state update on unmounted component" 类型的警告
    const leakWarnings = consoleErrorSpy.mock.calls.filter((call) =>
      call.some(
        (arg) =>
          typeof arg === 'string' &&
          (arg.includes('unmounted') || arg.includes('memory leak') || arg.includes('Can\'t perform')),
      ),
    );
    expect(leakWarnings).toHaveLength(0);

    consoleErrorSpy.mockRestore();
  });
});

// ============================================================================
// 测试组 8: Tab 切换数据加载
// ============================================================================

describe('Edge case: tab switching data loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('loads only overview data on initial render', async () => {
    render(<DataGovernanceDashboard embedded />);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getMigrationStatus).toHaveBeenCalledTimes(1);
      expect(mockDataGovernanceApi.runHealthCheck).toHaveBeenCalledTimes(1);
    });

    // 审计日志也被预加载（组件的独立 useEffect）
    await waitFor(() => {
      expect(mockDataGovernanceApi.getAuditLogs).toHaveBeenCalled();
    });

    // 备份列表不应在初始时加载（activeTab 默认为 overview）
    // 注意：getBackupList 只在切换到 backup tab 时触发
  });

  it('loads backup data only when switching to backup tab', async () => {
    render(<DataGovernanceDashboard embedded />);

    await waitFor(() => {
      expect(mockDataGovernanceApi.runHealthCheck).toHaveBeenCalled();
    });

    const backupCallsBefore = mockDataGovernanceApi.getBackupList.mock.calls.length;
    const resumableCallsBefore = mockDataGovernanceApi.listResumableJobs.mock.calls.length;

    // 切换到备份 Tab
    const backupTab = screen.getByRole('button', {
      name: /备份|data:governance\.tab_backup/i,
    });
    fireEvent.click(backupTab);

    await waitFor(() => {
      // 切换后应加载备份列表和可恢复任务
      expect(mockDataGovernanceApi.getBackupList).toHaveBeenCalledTimes(backupCallsBefore + 1);
      expect(mockDataGovernanceApi.listResumableJobs).toHaveBeenCalledTimes(
        resumableCallsBefore + 1,
      );
    });
  });

  it('loads sync status only when switching to sync tab', async () => {
    render(<DataGovernanceDashboard embedded />);

    await waitFor(() => {
      expect(mockDataGovernanceApi.runHealthCheck).toHaveBeenCalled();
    });

    const syncCallsBefore = mockDataGovernanceApi.getSyncStatus.mock.calls.length;

    // 切换到同步 Tab
    const syncTab = screen.getByRole('button', {
      name: /同步|data:governance\.tab_sync/i,
    });
    fireEvent.click(syncTab);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getSyncStatus).toHaveBeenCalledTimes(syncCallsBefore + 1);
    });

    // 切换到同步 Tab 不应触发备份数据的重新加载
    const backupCallsAfterSync = mockDataGovernanceApi.getBackupList.mock.calls.length;
    expect(backupCallsAfterSync).toBe(0); // 从未切换到 backup tab
  });

  it('reloads overview data when switching back to overview tab', async () => {
    render(<DataGovernanceDashboard embedded />);

    await waitFor(() => {
      expect(mockDataGovernanceApi.runHealthCheck).toHaveBeenCalled();
    });

    const initialHealthCalls = mockDataGovernanceApi.runHealthCheck.mock.calls.length;

    // 切换到备份 Tab
    const backupTab = screen.getByRole('button', {
      name: /备份|data:governance\.tab_backup/i,
    });
    fireEvent.click(backupTab);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getBackupList).toHaveBeenCalled();
    });

    // 切换回概览 Tab
    const overviewTab = screen.getByRole('button', {
      name: /概览|data:governance\.tab_overview/i,
    });
    fireEvent.click(overviewTab);

    // 当前实现：切换回 tab 时会重新加载数据
    await waitFor(() => {
      expect(mockDataGovernanceApi.runHealthCheck).toHaveBeenCalledTimes(initialHealthCalls + 1);
    });
  });

  it('pre-fetches audit logs on mount regardless of active tab', async () => {
    render(<DataGovernanceDashboard embedded />);

    // 审计日志在组件挂载时预加载（独立的 useEffect，非依赖 activeTab）
    await waitFor(() => {
      expect(mockDataGovernanceApi.getAuditLogs).toHaveBeenCalled();
    });

    // 此时 activeTab 仍为 overview
    expect(mockDataGovernanceApi.getMigrationStatus).toHaveBeenCalled();
  });
});

// ============================================================================
// 测试组 9: getXxxDisplayName() 函数单元测试
// ============================================================================

describe('getAssetTypeDisplayName()', () => {
  // 模拟 t 函数：直接返回 key（测试仅验证正确的 key 被传入）
  const mockT = (key: string) => key;

  it('returns correct i18n key for all known asset types', () => {
    expect(getAssetTypeDisplayName('images', mockT)).toBe('data:governance.asset_type.images');
    expect(getAssetTypeDisplayName('notes_assets', mockT)).toBe('data:governance.asset_type.notes_assets');
    expect(getAssetTypeDisplayName('documents', mockT)).toBe('data:governance.asset_type.documents');
    expect(getAssetTypeDisplayName('vfs_blobs', mockT)).toBe('data:governance.asset_type.vfs_blobs');
    expect(getAssetTypeDisplayName('subjects', mockT)).toBe('data:governance.asset_type.subjects');
    expect(getAssetTypeDisplayName('workspaces', mockT)).toBe('data:governance.asset_type.workspaces');
    expect(getAssetTypeDisplayName('audio', mockT)).toBe('data:governance.asset_type.audio');
    expect(getAssetTypeDisplayName('videos', mockT)).toBe('data:governance.asset_type.videos');
  });

  it('returns the raw type string for unknown asset types', () => {
    expect(getAssetTypeDisplayName('unknown_type', mockT)).toBe('unknown_type');
    expect(getAssetTypeDisplayName('', mockT)).toBe('');
  });
});

describe('getDatabaseDisplayName()', () => {
  const mockT = (key: string) => key;

  it('returns correct i18n key for all known database IDs', () => {
    expect(getDatabaseDisplayName('vfs', mockT)).toBe('data:governance.database_name.vfs');
    expect(getDatabaseDisplayName('chat_v2', mockT)).toBe('data:governance.database_name.chat_v2');
    expect(getDatabaseDisplayName('mistakes', mockT)).toBe('data:governance.database_name.mistakes');
    expect(getDatabaseDisplayName('llm_usage', mockT)).toBe('data:governance.database_name.llm_usage');
  });

  it('returns the raw id string for unknown database IDs', () => {
    expect(getDatabaseDisplayName('unknown_db', mockT)).toBe('unknown_db');
    expect(getDatabaseDisplayName('', mockT)).toBe('');
  });
});

describe('getBackupTierDisplayName()', () => {
  const mockT = (key: string) => key;

  it('returns correct i18n key for all backup tiers', () => {
    expect(getBackupTierDisplayName('core', mockT)).toBe('data:governance.backup_tier_name.core');
    expect(getBackupTierDisplayName('important', mockT)).toBe('data:governance.backup_tier_name.important');
    expect(getBackupTierDisplayName('rebuildable', mockT)).toBe('data:governance.backup_tier_name.rebuildable');
    expect(getBackupTierDisplayName('large_assets', mockT)).toBe('data:governance.backup_tier_name.large_assets');
  });
});

describe('getBackupTierDescription()', () => {
  const mockT = (key: string) => key;

  it('returns correct i18n key for all backup tier descriptions', () => {
    expect(getBackupTierDescription('core', mockT)).toBe('data:governance.backup_tier_desc.core');
    expect(getBackupTierDescription('important', mockT)).toBe('data:governance.backup_tier_desc.important');
    expect(getBackupTierDescription('rebuildable', mockT)).toBe('data:governance.backup_tier_desc.rebuildable');
    expect(getBackupTierDescription('large_assets', mockT)).toBe('data:governance.backup_tier_desc.large_assets');
  });
});

describe('getSyncPhaseName()', () => {
  const mockT = (key: string) => key;

  it('returns correct i18n key for all known sync phases', () => {
    expect(getSyncPhaseName('preparing', mockT)).toBe('data:governance.sync_phase.preparing');
    expect(getSyncPhaseName('detecting_changes', mockT)).toBe('data:governance.sync_phase.detecting_changes');
    expect(getSyncPhaseName('uploading', mockT)).toBe('data:governance.sync_phase.uploading');
    expect(getSyncPhaseName('downloading', mockT)).toBe('data:governance.sync_phase.downloading');
    expect(getSyncPhaseName('applying', mockT)).toBe('data:governance.sync_phase.applying');
    expect(getSyncPhaseName('completed', mockT)).toBe('data:governance.sync_phase.completed');
    expect(getSyncPhaseName('failed', mockT)).toBe('data:governance.sync_phase.failed');
  });

  it('returns the raw phase string for unknown sync phases', () => {
    expect(getSyncPhaseName('unknown_phase', mockT)).toBe('unknown_phase');
    expect(getSyncPhaseName('', mockT)).toBe('');
  });
});
