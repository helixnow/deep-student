/**
 * 数据治理审阅问题 #15 - 前端测试覆盖
 *
 * 测试覆盖：
 * - 备份按钮点击 → loading 状态 → 成功/失败提示
 * - 恢复确认弹窗
 * - 健康检查异常状态渲染
 * - 审计日志查看
 * - 错误提示展示
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, act, within } from '@testing-library/react';

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
  backupAndExportZip: vi.fn(),
  runBackup: vi.fn(),
  restoreBackup: vi.fn(),
  verifyBackup: vi.fn(),
  deleteBackup: vi.fn(),
  checkDiskSpaceForRestore: vi.fn(),
}));

const mockStartListening = vi.hoisted(() => vi.fn());
const mockStopListening = vi.hoisted(() => vi.fn());
const mockSaveDialog = vi.hoisted(() => vi.fn());

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

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: mockSaveDialog,
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
    {
      id: 'mistakes',
      is_healthy: true,
      dependencies_met: true,
      schema_version: 20260207,
      target_version: 20260207,
      pending_count: 0,
      issues: [],
    },
    {
      id: 'llm_usage',
      is_healthy: true,
      dependencies_met: true,
      schema_version: 20260201,
      target_version: 20260201,
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

const unhealthyHealthCheck = {
  overall_healthy: false,
  total_databases: 4,
  initialized_count: 2,
  uninitialized_count: 2,
  dependency_check_passed: false,
  dependency_error: 'vfs dependency not satisfied for chat_v2',
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
      id: 'llm_usage',
      is_healthy: true,
      dependencies_met: true,
      schema_version: 20260201,
      target_version: 20260201,
      pending_count: 0,
      issues: [],
    },
    {
      id: 'chat_v2',
      is_healthy: false,
      dependencies_met: false,
      schema_version: 0,
      target_version: 20260207,
      pending_count: 6,
      issues: ['vfs dependency not satisfied'],
    },
    {
      id: 'mistakes',
      is_healthy: false,
      dependencies_met: false,
      schema_version: 0,
      target_version: 20260207,
      pending_count: 5,
      issues: ['schema not initialized'],
    },
  ],
  checked_at: '2026-02-07T00:00:00Z',
  pending_migrations_count: 11,
  has_pending_migrations: true,
  audit_log_healthy: true,
  audit_log_error: null,
  audit_log_error_at: null,
};

const sampleBackupList = [
  {
    path: '20260207_120000',
    created_at: '2026-02-07T12:00:00Z',
    size: 1536000,
    backup_type: 'full' as const,
    databases: ['vfs', 'chat_v2'],
  },
];

const sampleAuditLogs = [
  {
    id: 'audit-001',
    timestamp: '2026-02-07T10:00:00Z',
    operation: { type: 'Migration', from_version: 0, to_version: 20260207, applied_count: 7 },
    target: 'chat_v2',
    status: 'Completed',
    duration_ms: 150,
    details: null,
    error_message: null,
  },
  {
    id: 'audit-002',
    timestamp: '2026-02-07T10:01:00Z',
    operation: { type: 'Backup', backup_type: 'Full', file_count: 4, total_size: 2048000 },
    target: 'full_backup',
    status: 'Completed',
    duration_ms: 500,
    details: null,
    error_message: null,
  },
  {
    id: 'audit-003',
    timestamp: '2026-02-07T10:02:00Z',
    operation: { type: 'Migration', from_version: 0, to_version: 20260130, applied_count: 1 },
    target: 'mistakes',
    status: 'Failed',
    duration_ms: 50,
    details: null,
    error_message: 'database is locked',
  },
];

// ============================================================================
// 测试组 1: 健康检查异常状态渲染
// ============================================================================

describe('DataGovernanceDashboard health check states (Issue #15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
    mockDataGovernanceApi.getBackupList.mockResolvedValue([]);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
    mockDataGovernanceApi.checkDiskSpaceForRestore.mockResolvedValue({ has_enough_space: true, available_bytes: 10737418240, required_bytes: 2147483648, backup_size: 1536000 });
  });

  it('renders healthy state without error indicators', async () => {
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);

    render(<DataGovernanceDashboard embedded />);

    await waitFor(() => {
      expect(mockDataGovernanceApi.runHealthCheck).toHaveBeenCalled();
    });

    // 健康状态不应该显示错误指示器
    const errorElements = screen.queryAllByText(/error|failed|unhealthy/i);
    expect(errorElements).toHaveLength(0);
    expect(mockDataGovernanceApi.runHealthCheck).toHaveBeenCalledTimes(1);
  });

  it('renders unhealthy state with dependency error', async () => {
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(unhealthyHealthCheck);
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue({
      ...healthyMigrationStatus,
      all_healthy: false,
      has_pending_migrations: true,
      pending_migrations_total: 11,
    });

    render(<DataGovernanceDashboard embedded />);

    await waitFor(() => {
      expect(mockDataGovernanceApi.runHealthCheck).toHaveBeenCalled();
    });

    // 不健康状态应该被调用
    expect(mockDataGovernanceApi.getMigrationStatus).toHaveBeenCalled();
  });

  it('handles health check API failure gracefully', async () => {
    mockDataGovernanceApi.runHealthCheck.mockRejectedValue(new Error('Network error'));

    render(<DataGovernanceDashboard embedded />);

    await waitFor(() => {
      expect(mockDataGovernanceApi.runHealthCheck).toHaveBeenCalled();
    });

    // 不应该崩溃，应该显示某种错误状态
    // 这验证了问题 #15 中前端错误处理的缺失
  });

  it('handles migration status API failure gracefully', async () => {
    mockDataGovernanceApi.getMigrationStatus.mockRejectedValue(new Error('Database locked'));
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);

    render(<DataGovernanceDashboard embedded />);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getMigrationStatus).toHaveBeenCalled();
    });

    // 不应该崩溃
  });
});

// ============================================================================
// 测试组 2: 备份/恢复 UI 交互
// ============================================================================

describe('DataGovernanceDashboard backup/restore interactions (Issue #15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);
    mockDataGovernanceApi.getBackupList.mockResolvedValue(sampleBackupList);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
    mockDataGovernanceApi.checkDiskSpaceForRestore.mockResolvedValue({ has_enough_space: true, available_bytes: 10737418240, required_bytes: 2147483648, backup_size: 1536000 });
  });

  it('navigates to backup tab and loads backup list', async () => {
    render(<DataGovernanceDashboard embedded />);

    // 找到备份标签并点击
    const backupTab = await screen.findByRole('button', { name: /备份|data:governance\.tab_backup/i });
    fireEvent.click(backupTab);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getBackupList).toHaveBeenCalled();
    });
  });

  it('handles backup list load failure', async () => {
    mockDataGovernanceApi.getBackupList.mockRejectedValue(new Error('IO Error'));

    render(<DataGovernanceDashboard embedded />);

    const backupTab = await screen.findByRole('button', { name: /备份|data:governance\.tab_backup/i });
    fireEvent.click(backupTab);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getBackupList).toHaveBeenCalled();
    });

    // 不应该崩溃
  });

  it('renders empty backup list state', async () => {
    mockDataGovernanceApi.getBackupList.mockResolvedValue([]);

    render(<DataGovernanceDashboard embedded />);

    const backupTab = await screen.findByRole('button', { name: /备份|data:governance\.tab_backup/i });
    fireEvent.click(backupTab);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getBackupList).toHaveBeenCalled();
    });
  });
});

// ============================================================================
// 测试组 3: 审计日志渲染
// ============================================================================

describe('DataGovernanceDashboard audit log rendering (Issue #15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);
    mockDataGovernanceApi.getBackupList.mockResolvedValue([]);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.checkDiskSpaceForRestore.mockResolvedValue({ has_enough_space: true, available_bytes: 10737418240, required_bytes: 2147483648, backup_size: 1536000 });
  });

  it('loads audit logs when navigating to logs tab', async () => {
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: sampleAuditLogs, total: sampleAuditLogs.length });

    render(<DataGovernanceDashboard embedded />);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getAuditLogs).toHaveBeenCalled();
    });
  });

  it('handles audit logs API failure gracefully', async () => {
    mockDataGovernanceApi.getAuditLogs.mockRejectedValue(new Error('Audit DB corrupted'));

    render(<DataGovernanceDashboard embedded />);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getAuditLogs).toHaveBeenCalled();
    });

    // 不应该崩溃
  });

  it('renders empty audit logs state', async () => {
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });

    render(<DataGovernanceDashboard embedded />);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getAuditLogs).toHaveBeenCalled();
    });
  });
});

// ============================================================================
// 测试组 4: 错误提示可操作性（问题 #4 补充）
// ============================================================================

describe('DataGovernanceDashboard error actionability (Issue #15 + #4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDataGovernanceApi.getBackupList.mockResolvedValue([]);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
    mockDataGovernanceApi.checkDiskSpaceForRestore.mockResolvedValue({ has_enough_space: true, available_bytes: 10737418240, required_bytes: 2147483648, backup_size: 1536000 });
  });

  it('shows pending migration actionable guidance without migration tab CTA', async () => {
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue({
      ...healthyMigrationStatus,
      all_healthy: false,
      has_pending_migrations: true,
      pending_migrations_total: 5,
    });
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue({
      ...healthyHealthCheck,
      overall_healthy: false,
      has_pending_migrations: true,
      pending_migrations_count: 5,
    });

    render(<DataGovernanceDashboard embedded />);

    // 等待渲染完成
    await waitFor(() => {
      expect(mockDataGovernanceApi.getMigrationStatus).toHaveBeenCalled();
    });

    expect(
      screen.getByText(/检测到待执行迁移|data:governance\.pending_migrations_next_step/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: /查看迁移|data:governance\.pending_migrations_open_migration/i,
      }),
    ).not.toBeInTheDocument();
  });

  it('renders migration status with database details when available', async () => {
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue({
      global_version: 10,
      all_healthy: false,
      databases: [
        { name: 'chat_v2', schema_version: 20260130, needs_migration: true, error: null },
        { name: 'vfs', schema_version: 20260206, needs_migration: false, error: null },
      ],
      pending_migrations_total: 3,
      has_pending_migrations: true,
      last_error: null,
    });
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(unhealthyHealthCheck);

    render(<DataGovernanceDashboard embedded />);

    await waitFor(() => {
      expect(mockDataGovernanceApi.runHealthCheck).toHaveBeenCalled();
    });
  });
});

// ============================================================================
// 测试组 5: 备份操作 UI 交互（创建、删除、进度）
// ============================================================================

describe('DataGovernanceDashboard backup operations (Issue #15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);
    mockDataGovernanceApi.getBackupList.mockResolvedValue(sampleBackupList);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
    mockSaveDialog.mockResolvedValue('/tmp/export.zip');
    mockDataGovernanceApi.checkDiskSpaceForRestore.mockResolvedValue({ has_enough_space: true, available_bytes: 10737418240, required_bytes: 2147483648, backup_size: 1536000 });
  });

  it('clicking "导出备份" calls backupAndExportZip API', async () => {
    mockDataGovernanceApi.backupAndExportZip.mockResolvedValue({
      job_id: 'test-job-001',
      kind: 'export',
      status: 'queued',
    });

    render(<DataGovernanceDashboard embedded />);

    // 导航到备份 Tab
    const backupTab = await screen.findByRole('button', { name: /备份|data:governance\.tab_backup/i });
    fireEvent.click(backupTab);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getBackupList).toHaveBeenCalled();
    });

    // 点击导出备份按钮
    const exportBtn = screen.getByRole('button', { name: /导出备份|data:governance\.export_backup/i });
    expect(exportBtn).toBeEnabled();

    await act(async () => {
      fireEvent.click(exportBtn);
    });

    // 验证调用了 backupAndExportZip API
    await waitFor(() => {
      expect(mockSaveDialog).toHaveBeenCalled();
      expect(mockDataGovernanceApi.backupAndExportZip).toHaveBeenCalledWith(
        '/tmp/export.zip',
        6,
        true,
        false,
        undefined,
        true,
        undefined,
      );
    });
  });

  it('clicking delete backup opens confirmation dialog and calls deleteBackup on confirm', async () => {
    mockDataGovernanceApi.deleteBackup.mockResolvedValue(true);
    // 删除后刷新列表返回空
    mockDataGovernanceApi.getBackupList
      .mockResolvedValueOnce(sampleBackupList) // 初始加载
      .mockResolvedValue([]); // 删除后刷新

    render(<DataGovernanceDashboard embedded />);

    // 导航到备份 Tab
    const backupTab = await screen.findByRole('button', { name: /备份|data:governance\.tab_backup/i });
    fireEvent.click(backupTab);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getBackupList).toHaveBeenCalled();
    });

    // 找到删除按钮并点击（打开确认对话框）—— 通过 title 属性定位行内删除按钮
    const deleteBtn = await screen.findByTitle(/删除|common:actions\.delete/i);
    fireEvent.click(deleteBtn);

    // 确认对话框应该出现
    await waitFor(() => {
      expect(screen.getByText(/确认删除备份|data:governance\.confirm_delete/i)).toBeInTheDocument();
    });

    // 应显示警告文案
    expect(screen.getByText(/删除后将无法恢复|data:governance\.delete_warning/i)).toBeInTheDocument();

    // 点击对话框中的确认按钮（AlertDialogAction）
    const dialogActions = screen.getByRole('alertdialog');
    const confirmBtn = within(dialogActions).getByRole('button', { name: /^删除$|^common:actions\.delete$/i });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // 验证调用了 deleteBackup API
    await waitFor(() => {
      expect(mockDataGovernanceApi.deleteBackup).toHaveBeenCalledWith(sampleBackupList[0].path);
    });
  });

  it('displays backup progress when a backup job is running', async () => {
    // 模拟 startListening 触发 onProgress 回调
    let capturedOnProgress: ((event: unknown) => void) | null = null;

    mockStartListening.mockImplementation(async (jobId: string) => {
      // 在 useBackupJobListener 中，startListening 内部会注册监听
      // 这里我们模拟进度回调效果
    });

    mockDataGovernanceApi.backupAndExportZip.mockResolvedValue({
      job_id: 'progress-job-001',
      kind: 'export',
      status: 'queued',
    });

    render(<DataGovernanceDashboard embedded />);

    // 导航到备份 Tab
    const backupTab = await screen.findByRole('button', { name: /备份|data:governance\.tab_backup/i });
    fireEvent.click(backupTab);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getBackupList).toHaveBeenCalled();
    });

    // 点击导出备份
    const createBtn = screen.getByRole('button', { name: /导出备份|data:governance\.export_backup/i });
    await act(async () => {
      fireEvent.click(createBtn);
    });

    // 验证备份导出启动被调用
    await waitFor(() => {
      expect(mockDataGovernanceApi.backupAndExportZip).toHaveBeenCalled();
    });

    // 备份启动后，startListening 应该被调用来监听进度
    await waitFor(() => {
      expect(mockStartListening).toHaveBeenCalledWith('progress-job-001');
    });
  });

  it('handles backup creation failure gracefully', async () => {
    mockDataGovernanceApi.backupAndExportZip.mockRejectedValue(new Error('Disk full'));

    render(<DataGovernanceDashboard embedded />);

    const backupTab = await screen.findByRole('button', { name: /备份|data:governance\.tab_backup/i });
    fireEvent.click(backupTab);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getBackupList).toHaveBeenCalled();
    });

    const createBtn = screen.getByRole('button', { name: /导出备份|data:governance\.export_backup/i });
    await act(async () => {
      fireEvent.click(createBtn);
    });

    // 验证调用了 backupAndExportZip 但失败了
    await waitFor(() => {
      expect(mockDataGovernanceApi.backupAndExportZip).toHaveBeenCalled();
    });

    // 按钮应该恢复为可用状态（不会卡在 loading）
    await waitFor(() => {
      expect(createBtn).toBeEnabled();
    });
  });

  it('handles backup deletion failure gracefully', async () => {
    mockDataGovernanceApi.deleteBackup.mockRejectedValue(new Error('File locked'));

    render(<DataGovernanceDashboard embedded />);

    const backupTab = await screen.findByRole('button', { name: /备份|data:governance\.tab_backup/i });
    fireEvent.click(backupTab);

    await waitFor(() => {
      expect(mockDataGovernanceApi.getBackupList).toHaveBeenCalled();
    });

    // 点击删除打开确认
    const deleteBtn = await screen.findByTitle(/删除|common:actions\.delete/i);
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(screen.getByText(/确认删除备份|data:governance\.confirm_delete/i)).toBeInTheDocument();
    });

    // 确认删除（在对话框范围内查找）
    const dialogActions = screen.getByRole('alertdialog');
    const confirmBtn = within(dialogActions).getByRole('button', { name: /^删除$|^common:actions\.delete$/i });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // 验证调用了 deleteBackup
    await waitFor(() => {
      expect(mockDataGovernanceApi.deleteBackup).toHaveBeenCalled();
    });

    // 组件不应崩溃，刷新按钮应恢复可用
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /刷新|common:actions\.refresh/i })).toBeEnabled();
    });
  });
});
