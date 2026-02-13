/**
 * 数据治理 Dashboard - 恢复操作集成测试
 *
 * 覆盖场景：
 * 1. 恢复确认流程（点击恢复 → 确认对话框 → 取消/确认）
 * 2. 恢复期间按钮禁用、完成后重启提示
 * 3. 导入 ZIP 文件流程
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, act, within } from '@testing-library/react';

// ============================================================================
// Mocks
// ============================================================================

/** 捕获 useBackupJobListener 回调 */
let capturedListenerCallbacks: {
  onProgress?: (event: unknown) => void;
  onComplete?: (event: unknown) => void;
  onError?: (event: unknown) => void;
  onCancelled?: (event: unknown) => void;
} = {};

const mockStartListening = vi.hoisted(() => vi.fn());
const mockStopListening = vi.hoisted(() => vi.fn());

const mockDataGovernanceApi = vi.hoisted(() => ({
  getMigrationStatus: vi.fn(),
  runHealthCheck: vi.fn(),
  getBackupList: vi.fn(),
  listResumableJobs: vi.fn(),
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

// Mock @tauri-apps/plugin-dialog for importZip file picker
const mockOpenDialog = vi.hoisted(() => vi.fn());
const mockSaveDialog = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: mockOpenDialog,
  save: mockSaveDialog,
}));

vi.mock('@/api/dataGovernance', () => ({
  DataGovernanceApi: mockDataGovernanceApi,
  BACKUP_JOB_PROGRESS_EVENT: 'backup-job-progress',
  isBackupJobTerminal: (status: string) =>
    status === 'completed' || status === 'failed' || status === 'cancelled',
}));

const mockRestartApp = vi.hoisted(() => vi.fn());

vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: {
    restartApp: mockRestartApp,
  },
}));

vi.mock('@/hooks/useBackupJobListener', () => ({
  useBackupJobListener: (opts: Record<string, unknown>) => {
    capturedListenerCallbacks = opts as typeof capturedListenerCallbacks;
    return {
      startListening: mockStartListening,
      stopListening: mockStopListening,
    };
  },
}));

vi.mock('@/components/settings/data-governance/MigrationTab', () => ({
  MigrationTab: () => <div data-testid="schema-migration-tab">migration-tab</div>,
}));

vi.mock('@/components/settings/MediaCacheSection', () => ({
  MediaCacheSection: () => <div data-testid="media-cache-section">cache-section</div>,
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
  databases: [],
  checked_at: '2026-02-07T00:00:00Z',
  pending_migrations_count: 0,
  has_pending_migrations: false,
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
  {
    path: '20260207_100000',
    created_at: '2026-02-07T10:00:00Z',
    size: 1024000,
    backup_type: 'incremental' as const,
    databases: ['vfs'],
  },
];

/** 导航到备份 Tab 的辅助函数 */
async function navigateToBackupTab() {
  const backupTab = await screen.findByRole('button', {
    name: /备份|data:governance\.tab_backup/i,
  });
  fireEvent.click(backupTab);
  await waitFor(() => {
    expect(mockDataGovernanceApi.getBackupList).toHaveBeenCalled();
  });
}

// ============================================================================
// 测试组 1：恢复确认流程
// ============================================================================

describe('DataGovernanceDashboard restore confirmation flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);
    mockDataGovernanceApi.getBackupList.mockResolvedValue(sampleBackupList);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
    mockDataGovernanceApi.checkDiskSpaceForRestore.mockResolvedValue({
      has_enough_space: true,
      available_bytes: 10 * 1024 * 1024 * 1024,
      required_bytes: 2 * 1024 * 1024 * 1024,
      backup_size: 1536000,
    });
  });

  it('clicking restore button opens confirmation dialog', async () => {
    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    // 找到恢复按钮（通过 title 属性，与删除类似）
    const restoreButtons = await screen.findAllByTitle(/恢复|data:governance\.restore/i);
    expect(restoreButtons.length).toBeGreaterThan(0);

    // 点击第一个恢复按钮
    fireEvent.click(restoreButtons[0]);

    // 确认对话框应出现
    await waitFor(() => {
      expect(
        screen.getByText(/确认恢复备份|data:governance\.confirm_restore/i),
      ).toBeInTheDocument();
    });

    // 应显示恢复警告文案
    expect(
      screen.getByText(/恢复将替换当前数据|data:governance\.restore_warning/i),
    ).toBeInTheDocument();
  });

  it('canceling restore confirmation does NOT call restoreBackup API', async () => {
    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    // 打开恢复确认对话框
    const restoreButtons = await screen.findAllByTitle(/恢复|data:governance\.restore/i);
    fireEvent.click(restoreButtons[0]);

    await waitFor(() => {
      expect(
        screen.getByText(/确认恢复备份|data:governance\.confirm_restore/i),
      ).toBeInTheDocument();
    });

    // 点击取消按钮
    const dialog = screen.getByRole('alertdialog');
    const cancelBtn = within(dialog).getByRole('button', {
      name: /取消|common:actions\.cancel/i,
    });
    fireEvent.click(cancelBtn);

    // 对话框应关闭
    await waitFor(() => {
      expect(
        screen.queryByText(/确认恢复备份|data:governance\.confirm_restore/i),
      ).not.toBeInTheDocument();
    });

    // restoreBackup API 不应被调用
    expect(mockDataGovernanceApi.restoreBackup).not.toHaveBeenCalled();
  });

  it('confirming restore calls restoreBackup API with correct backup ID', async () => {
    mockDataGovernanceApi.restoreBackup.mockResolvedValue({
      job_id: 'restore-job-001',
      kind: 'import',
      status: 'queued',
      message: 'started',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    // 打开恢复确认对话框（第一个备份）
    const restoreButtons = await screen.findAllByTitle(/恢复|data:governance\.restore/i);
    fireEvent.click(restoreButtons[0]);

    await waitFor(() => {
      expect(
        screen.getByText(/确认恢复备份|data:governance\.confirm_restore/i),
      ).toBeInTheDocument();
    });

    // 点击确认恢复按钮
    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = within(dialog).getByRole('button', {
      name: /^恢复$|^data:governance\.restore$/i,
    });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // restoreBackup API 应被调用
    await waitFor(() => {
      expect(mockDataGovernanceApi.restoreBackup).toHaveBeenCalledWith(
        sampleBackupList[0].path,
      );
    });

    // startListening 应被调用来监听恢复进度
    await waitFor(() => {
      expect(mockStartListening).toHaveBeenCalledWith('restore-job-001');
    });
  });

  it('handles restoreBackup API failure gracefully', async () => {
    mockDataGovernanceApi.restoreBackup.mockRejectedValue(
      new Error('Backup file corrupted'),
    );

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    // 打开恢复确认对话框
    const restoreButtons = await screen.findAllByTitle(/恢复|data:governance\.restore/i);
    fireEvent.click(restoreButtons[0]);

    await waitFor(() => {
      expect(
        screen.getByText(/确认恢复备份|data:governance\.confirm_restore/i),
      ).toBeInTheDocument();
    });

    // 确认恢复
    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = within(dialog).getByRole('button', {
      name: /^恢复$|^data:governance\.restore$/i,
    });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // 验证 API 被调用
    await waitFor(() => {
      expect(mockDataGovernanceApi.restoreBackup).toHaveBeenCalled();
    });

    // 按钮应恢复为可用状态
    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: /完整备份|data:governance\.create_full_backup/i,
        }),
      ).toBeEnabled();
    });
  });
});

// ============================================================================
// 测试组 2：恢复期间按钮禁用和完成后重启提示
// ============================================================================

describe('DataGovernanceDashboard restore maintenance mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);
    mockDataGovernanceApi.getBackupList.mockResolvedValue(sampleBackupList);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
    mockDataGovernanceApi.checkDiskSpaceForRestore.mockResolvedValue({
      has_enough_space: true,
      available_bytes: 10 * 1024 * 1024 * 1024,
      required_bytes: 2 * 1024 * 1024 * 1024,
      backup_size: 1536000,
    });
  });

  it('disables all backup/restore buttons during restore operation', async () => {
    mockDataGovernanceApi.restoreBackup.mockResolvedValue({
      job_id: 'restore-maint-001',
      kind: 'import',
      status: 'queued',
      message: 'started',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    // 开始恢复
    const restoreButtons = await screen.findAllByTitle(/恢复|data:governance\.restore/i);
    fireEvent.click(restoreButtons[0]);

    await waitFor(() => {
      expect(
        screen.getByText(/确认恢复备份|data:governance\.confirm_restore/i),
      ).toBeInTheDocument();
    });

    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = within(dialog).getByRole('button', {
      name: /^恢复$|^data:governance\.restore$/i,
    });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.restoreBackup).toHaveBeenCalled();
    });

    // 模拟恢复进度
    await act(async () => {
      capturedListenerCallbacks.onProgress!({
        job_id: 'restore-maint-001',
        kind: 'import',
        status: 'running',
        phase: 'Restoring databases',
        progress: 40,
        processed_items: 1,
        total_items: 2,
        cancellable: false,
        created_at: '2026-02-07T12:00:00Z',
      });
    });

    // 进度区域应显示恢复进行中
    expect(
      screen.getByText(/恢复进行中|data:governance\.restore_in_progress/i),
    ).toBeInTheDocument();

    // 完整备份按钮应被禁用
    expect(
      screen.getByRole('button', {
        name: /完整备份|data:governance\.create_full_backup/i,
      }),
    ).toBeDisabled();

    // 分层备份按钮应被禁用
    expect(
      screen.getByRole('button', {
        name: /创建分层备份|data:governance\.create_tiered_backup/i,
      }),
    ).toBeDisabled();

    // 导入按钮应被禁用
    expect(
      screen.getByRole('button', {
        name: /导入|data:governance\.import_button/i,
      }),
    ).toBeDisabled();
  });

  it('enables buttons and refreshes lists after restore completes', async () => {
    mockDataGovernanceApi.restoreBackup.mockResolvedValue({
      job_id: 'restore-done-001',
      kind: 'import',
      status: 'queued',
      message: 'started',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    // 开始恢复
    const restoreButtons = await screen.findAllByTitle(/恢复|data:governance\.restore/i);
    fireEvent.click(restoreButtons[0]);

    await waitFor(() => {
      expect(
        screen.getByText(/确认恢复备份|data:governance\.confirm_restore/i),
      ).toBeInTheDocument();
    });

    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = within(dialog).getByRole('button', {
      name: /^恢复$|^data:governance\.restore$/i,
    });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.restoreBackup).toHaveBeenCalled();
    });

    // 触发 onComplete，模拟恢复完成（需要重启）
    await act(async () => {
      capturedListenerCallbacks.onComplete!({
        job_id: 'restore-done-001',
        kind: 'import',
        status: 'completed',
        phase: 'done',
        progress: 100,
        processed_items: 2,
        total_items: 2,
        cancellable: false,
        created_at: '2026-02-07T12:00:00Z',
        result: {
          success: true,
          requires_restart: true,
        },
      });
    });

    // 按钮应恢复为可用状态
    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: /完整备份|data:governance\.create_full_backup/i,
        }),
      ).toBeEnabled();
    });

    // 备份列表和概览数据应被刷新
    await waitFor(() => {
      // getBackupList: 初始 + 恢复后刷新
      expect(mockDataGovernanceApi.getBackupList.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('handles restore onError and recovers button state', async () => {
    mockDataGovernanceApi.restoreBackup.mockResolvedValue({
      job_id: 'restore-fail-001',
      kind: 'import',
      status: 'queued',
      message: 'started',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    // 开始恢复
    const restoreButtons = await screen.findAllByTitle(/恢复|data:governance\.restore/i);
    fireEvent.click(restoreButtons[0]);

    await waitFor(() => {
      expect(
        screen.getByText(/确认恢复备份|data:governance\.confirm_restore/i),
      ).toBeInTheDocument();
    });

    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = within(dialog).getByRole('button', {
      name: /^恢复$|^data:governance\.restore$/i,
    });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.restoreBackup).toHaveBeenCalled();
    });

    // 触发 onError
    await act(async () => {
      capturedListenerCallbacks.onError!({
        job_id: 'restore-fail-001',
        kind: 'import',
        status: 'failed',
        phase: 'failed',
        progress: 20,
        processed_items: 0,
        total_items: 2,
        cancellable: false,
        created_at: '2026-02-07T12:00:00Z',
        result: {
          success: false,
          error: 'Checksum mismatch on vfs.db',
          requires_restart: false,
        },
      });
    });

    // 按钮应恢复为可用状态
    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: /完整备份|data:governance\.create_full_backup/i,
        }),
      ).toBeEnabled();
    });
  });
});

// ============================================================================
// 测试组 3：导入 ZIP 文件流程
// ============================================================================

describe('DataGovernanceDashboard import ZIP flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);
    mockDataGovernanceApi.getBackupList.mockResolvedValue(sampleBackupList);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
    mockDataGovernanceApi.checkDiskSpaceForRestore.mockResolvedValue({
      has_enough_space: true,
      available_bytes: 10 * 1024 * 1024 * 1024,
      required_bytes: 2 * 1024 * 1024 * 1024,
      backup_size: 1536000,
    });
  });

  it('renders a visible import entry button in ZIP management area', async () => {
    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    const importBtn = screen.getByRole('button', {
      name: /导入|data:governance\.import_button/i,
    });

    // 入口需要是可见的填充样式，避免 ghost 按钮在深色主题下不明显
    expect(importBtn.className).toContain('bg-muted/50');
  });

  it('clicking import button calls open dialog, then importZip API', async () => {
    // 模拟用户选择了一个 ZIP 文件
    mockOpenDialog.mockResolvedValue('/path/to/backup.zip');
    mockDataGovernanceApi.importZip.mockResolvedValue({
      job_id: 'import-job-001',
      kind: 'import',
      status: 'queued',
      message: 'started',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    const importBtn = screen.getByRole('button', {
      name: /导入|data:governance\.import_button/i,
    });

    await act(async () => {
      fireEvent.click(importBtn);
    });

    // open dialog 应被调用
    await waitFor(() => {
      expect(mockOpenDialog).toHaveBeenCalled();
    });

    // importZip API 应被调用
    await waitFor(() => {
      expect(mockDataGovernanceApi.importZip).toHaveBeenCalledWith('/path/to/backup.zip');
    });

    // startListening 应被调用来监听导入进度
    await waitFor(() => {
      expect(mockStartListening).toHaveBeenCalledWith('import-job-001');
    });
  });

  it('does not call importZip when user cancels file dialog', async () => {
    // 模拟用户取消了文件选择
    mockOpenDialog.mockResolvedValue(null);

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    const importBtn = screen.getByRole('button', {
      name: /导入|data:governance\.import_button/i,
    });

    await act(async () => {
      fireEvent.click(importBtn);
    });

    await waitFor(() => {
      expect(mockOpenDialog).toHaveBeenCalled();
    });

    // importZip 不应被调用
    expect(mockDataGovernanceApi.importZip).not.toHaveBeenCalled();

    // 按钮应保持可用
    expect(importBtn).toBeEnabled();
  });

  it('does not call importZip when file dialog returns empty array', async () => {
    // 模拟文件选择返回空数组
    mockOpenDialog.mockResolvedValue([]);

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    const importBtn = screen.getByRole('button', {
      name: /导入|data:governance\.import_button/i,
    });

    await act(async () => {
      fireEvent.click(importBtn);
    });

    await waitFor(() => {
      expect(mockOpenDialog).toHaveBeenCalled();
    });

    // importZip 不应被调用
    expect(mockDataGovernanceApi.importZip).not.toHaveBeenCalled();
  });

  it('refreshes backup list after successful ZIP import', async () => {
    mockOpenDialog.mockResolvedValue('/path/to/backup.zip');
    mockDataGovernanceApi.importZip.mockResolvedValue({
      job_id: 'import-done-001',
      kind: 'import',
      status: 'queued',
      message: 'started',
    });

    const updatedBackupList = [
      ...sampleBackupList,
      {
        path: '20260208_import_001',
        created_at: '2026-02-08T14:00:00Z',
        size: 3072000,
        backup_type: 'full' as const,
        databases: ['vfs', 'chat_v2', 'mistakes'],
      },
    ];
    // 导入完成后刷新返回新列表
    mockDataGovernanceApi.getBackupList.mockResolvedValue(updatedBackupList);

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    const importBtn = screen.getByRole('button', {
      name: /导入|data:governance\.import_button/i,
    });

    await act(async () => {
      fireEvent.click(importBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.importZip).toHaveBeenCalled();
    });

    // 触发 onComplete（模拟导入成功）
    await act(async () => {
      capturedListenerCallbacks.onComplete!({
        job_id: 'import-done-001',
        kind: 'import',
        status: 'completed',
        phase: 'done',
        progress: 100,
        processed_items: 10,
        total_items: 10,
        cancellable: false,
        created_at: '2026-02-07T14:00:00Z',
        result: { success: true, requires_restart: false },
      });
    });

    // 按钮应恢复为可用状态
    await waitFor(() => {
      expect(importBtn).toBeEnabled();
    });

    // 备份列表应被刷新
    await waitFor(() => {
      expect(mockDataGovernanceApi.getBackupList.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('shows import progress with correct operation text', async () => {
    mockOpenDialog.mockResolvedValue('/path/to/backup.zip');
    mockDataGovernanceApi.importZip.mockResolvedValue({
      job_id: 'import-progress-001',
      kind: 'import',
      status: 'queued',
      message: 'started',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    const importBtn = screen.getByRole('button', {
      name: /导入|data:governance\.import_button/i,
    });

    await act(async () => {
      fireEvent.click(importBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.importZip).toHaveBeenCalled();
    });

    // 模拟导入进度
    await act(async () => {
      capturedListenerCallbacks.onProgress!({
        job_id: 'import-progress-001',
        kind: 'import',
        status: 'running',
        phase: 'Extracting ZIP',
        progress: 55,
        processed_items: 5,
        total_items: 10,
        cancellable: false,
        created_at: '2026-02-07T14:00:00Z',
      });
    });

    // 应显示"导入进行中"
    expect(
      screen.getByText(/导入进行中|data:governance\.import_in_progress/i),
    ).toBeInTheDocument();
    expect(screen.getByText('55%')).toBeInTheDocument();
    expect(screen.getByText('Extracting ZIP')).toBeInTheDocument();
  });

  it('handles importZip API failure gracefully', async () => {
    mockOpenDialog.mockResolvedValue('/path/to/corrupted.zip');
    mockDataGovernanceApi.importZip.mockRejectedValue(
      new Error('Invalid ZIP format'),
    );

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    const importBtn = screen.getByRole('button', {
      name: /导入|data:governance\.import_button/i,
    });

    await act(async () => {
      fireEvent.click(importBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.importZip).toHaveBeenCalled();
    });

    // 按钮应恢复为可用状态
    await waitFor(() => {
      expect(importBtn).toBeEnabled();
    });
  });
});

// ============================================================================
// 测试组 4：导出 ZIP 文件流程
// ============================================================================

describe('DataGovernanceDashboard export ZIP flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);
    mockDataGovernanceApi.getBackupList.mockResolvedValue(sampleBackupList);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
    mockDataGovernanceApi.checkDiskSpaceForRestore.mockResolvedValue({
      has_enough_space: true,
      available_bytes: 10 * 1024 * 1024 * 1024,
      required_bytes: 2 * 1024 * 1024 * 1024,
      backup_size: 1536000,
    });
  });

  it('clicking export button opens confirmation then calls exportZip API', async () => {
    mockSaveDialog.mockResolvedValue('/path/to/output.zip');
    mockDataGovernanceApi.exportZip.mockResolvedValue({
      job_id: 'export-job-001',
      kind: 'export',
      status: 'queued',
      message: 'started',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    // 找到导出按钮（通过 title 属性）
    const exportButtons = await screen.findAllByTitle(
      /导出为 ZIP|data:governance\.export_zip/i,
    );
    expect(exportButtons.length).toBeGreaterThan(0);

    // 点击导出按钮 → 打开确认对话框
    fireEvent.click(exportButtons[0]);

    await waitFor(() => {
      expect(
        screen.getByText(/确认导出为 ZIP|data:governance\.confirm_export/i),
      ).toBeInTheDocument();
    });

    // 确认导出
    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = within(dialog).getByRole('button', {
      name: /^导出$|^data:governance\.export$/i,
    });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // save dialog 应被调用（选择保存路径）
    await waitFor(() => {
      expect(mockSaveDialog).toHaveBeenCalled();
    });

    // exportZip API 应被调用
    await waitFor(() => {
      expect(mockDataGovernanceApi.exportZip).toHaveBeenCalledWith(
        sampleBackupList[0].path,
        '/path/to/output.zip',
        6, // 默认压缩级别
        true, // includeChecksums
      );
    });
  });

  it('does not call exportZip when user cancels save dialog', async () => {
    mockSaveDialog.mockResolvedValue(null);

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    // 点击导出按钮
    const exportButtons = await screen.findAllByTitle(
      /导出为 ZIP|data:governance\.export_zip/i,
    );
    fireEvent.click(exportButtons[0]);

    await waitFor(() => {
      expect(
        screen.getByText(/确认导出为 ZIP|data:governance\.confirm_export/i),
      ).toBeInTheDocument();
    });

    // 确认导出
    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = within(dialog).getByRole('button', {
      name: /^导出$|^data:governance\.export$/i,
    });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(mockSaveDialog).toHaveBeenCalled();
    });

    // exportZip 不应被调用（用户取消了保存路径选择）
    expect(mockDataGovernanceApi.exportZip).not.toHaveBeenCalled();
  });

  it('shows export progress with correct operation text', async () => {
    mockSaveDialog.mockResolvedValue('/path/to/export.zip');
    mockDataGovernanceApi.exportZip.mockResolvedValue({
      job_id: 'export-progress-001',
      kind: 'export',
      status: 'queued',
      message: 'started',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    const exportButtons = await screen.findAllByTitle(
      /导出为 ZIP|data:governance\.export_zip/i,
    );
    fireEvent.click(exportButtons[0]);

    await waitFor(() => {
      expect(
        screen.getByText(/确认导出为 ZIP|data:governance\.confirm_export/i),
      ).toBeInTheDocument();
    });

    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = within(dialog).getByRole('button', {
      name: /^导出$|^data:governance\.export$/i,
    });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.exportZip).toHaveBeenCalled();
    });

    // 模拟导出进度
    await act(async () => {
      capturedListenerCallbacks.onProgress!({
        job_id: 'export-progress-001',
        kind: 'export',
        status: 'running',
        phase: 'Compressing files',
        progress: 70,
        processed_items: 7,
        total_items: 10,
        cancellable: true,
        created_at: '2026-02-07T12:00:00Z',
      });
    });

    // 应显示"导出进行中"
    expect(
      screen.getByText(/导出进行中|data:governance\.export_in_progress/i),
    ).toBeInTheDocument();
    expect(screen.getByText('70%')).toBeInTheDocument();
  });
});

// ============================================================================
// 测试组 5：磁盘空间不足场景
// ============================================================================

describe('DataGovernanceDashboard disk space check for restore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);
    mockDataGovernanceApi.getBackupList.mockResolvedValue(sampleBackupList);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
  });

  it('blocks restore when disk space is insufficient', async () => {
    // 磁盘空间不足
    mockDataGovernanceApi.checkDiskSpaceForRestore.mockResolvedValue({
      has_enough_space: false,
      available_bytes: 500 * 1024 * 1024, // 500 MB
      required_bytes: 2 * 1024 * 1024 * 1024, // 2 GB
      backup_size: 1536000,
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    // 点击恢复按钮
    const restoreButtons = await screen.findAllByTitle(/恢复|data:governance\.restore/i);
    fireEvent.click(restoreButtons[0]);

    // 确认对话框应出现
    await waitFor(() => {
      expect(
        screen.getByText(/确认恢复备份|data:governance\.confirm_restore/i),
      ).toBeInTheDocument();
    });

    // 确认恢复
    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = within(dialog).getByRole('button', {
      name: /^恢复$|^data:governance\.restore$/i,
    });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // checkDiskSpaceForRestore 应被调用
    await waitFor(() => {
      expect(mockDataGovernanceApi.checkDiskSpaceForRestore).toHaveBeenCalledWith(
        sampleBackupList[0].path,
      );
    });

    // restoreBackup 不应被调用（被磁盘空间检查阻止）
    expect(mockDataGovernanceApi.restoreBackup).not.toHaveBeenCalled();

    // 按钮应恢复为可用状态（因为恢复被阻止，不会进入维护模式）
    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: /完整备份|data:governance\.create_full_backup/i,
        }),
      ).toBeEnabled();
    });
  });

  it('continues restore when disk space check API fails (graceful degradation)', async () => {
    // 磁盘空间检查 API 失败
    mockDataGovernanceApi.checkDiskSpaceForRestore.mockRejectedValue(
      new Error('Disk space check service unavailable'),
    );
    mockDataGovernanceApi.restoreBackup.mockResolvedValue({
      job_id: 'restore-degraded-001',
      kind: 'import',
      status: 'queued',
      message: 'started',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    // 点击恢复按钮
    const restoreButtons = await screen.findAllByTitle(/恢复|data:governance\.restore/i);
    fireEvent.click(restoreButtons[0]);

    await waitFor(() => {
      expect(
        screen.getByText(/确认恢复备份|data:governance\.confirm_restore/i),
      ).toBeInTheDocument();
    });

    // 确认恢复
    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = within(dialog).getByRole('button', {
      name: /^恢复$|^data:governance\.restore$/i,
    });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // checkDiskSpaceForRestore 应被调用（虽然失败）
    await waitFor(() => {
      expect(mockDataGovernanceApi.checkDiskSpaceForRestore).toHaveBeenCalled();
    });

    // 尽管磁盘空间检查失败，restoreBackup 应仍然被调用（graceful degradation）
    await waitFor(() => {
      expect(mockDataGovernanceApi.restoreBackup).toHaveBeenCalledWith(
        sampleBackupList[0].path,
      );
    });

    // startListening 应被调用
    await waitFor(() => {
      expect(mockStartListening).toHaveBeenCalledWith('restore-degraded-001');
    });
  });
});

// ============================================================================
// 测试组 6：恢复完成后重启对话框
// ============================================================================

describe('DataGovernanceDashboard restart dialog after restore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);
    mockDataGovernanceApi.getBackupList.mockResolvedValue(sampleBackupList);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
    mockDataGovernanceApi.checkDiskSpaceForRestore.mockResolvedValue({
      has_enough_space: true,
      available_bytes: 10 * 1024 * 1024 * 1024,
      required_bytes: 2 * 1024 * 1024 * 1024,
      backup_size: 1536000,
    });
  });

  /** 辅助函数：执行完整的恢复流程直到 onComplete */
  async function startRestoreAndComplete(requiresRestart: boolean) {
    mockDataGovernanceApi.restoreBackup.mockResolvedValue({
      job_id: 'restore-restart-001',
      kind: 'import',
      status: 'queued',
      message: 'started',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    // 点击恢复按钮
    const restoreButtons = await screen.findAllByTitle(/恢复|data:governance\.restore/i);
    fireEvent.click(restoreButtons[0]);

    await waitFor(() => {
      expect(
        screen.getByText(/确认恢复备份|data:governance\.confirm_restore/i),
      ).toBeInTheDocument();
    });

    // 确认恢复
    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = within(dialog).getByRole('button', {
      name: /^恢复$|^data:governance\.restore$/i,
    });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.restoreBackup).toHaveBeenCalled();
    });

    // 触发 onComplete
    await act(async () => {
      capturedListenerCallbacks.onComplete!({
        job_id: 'restore-restart-001',
        kind: 'import',
        status: 'completed',
        phase: 'done',
        progress: 100,
        processed_items: 2,
        total_items: 2,
        cancellable: false,
        created_at: '2026-02-07T12:00:00Z',
        result: {
          success: true,
          requires_restart: requiresRestart,
        },
      });
    });
  }

  it('shows restart dialog when restore completes with requires_restart=true', async () => {
    await startRestoreAndComplete(true);

    // 重启对话框应显示
    await waitFor(() => {
      expect(
        screen.getByText(/恢复完成|data:governance\.restore_complete_title/i),
      ).toBeInTheDocument();
    });

    // 应有"立即重启"和"稍后重启"按钮
    expect(
      screen.getByRole('button', { name: /立即重启|data:governance\.restart_now/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /稍后重启|data:governance\.restart_later/i }),
    ).toBeInTheDocument();
  });

  it('does not show restart dialog when restore completes with requires_restart=false', async () => {
    await startRestoreAndComplete(false);

    // 重启对话框不应显示
    expect(
      screen.queryByText(/恢复完成|data:governance\.restore_complete_title/i),
    ).not.toBeInTheDocument();
  });

  it('calls restartApp when clicking "restart now"', async () => {
    await startRestoreAndComplete(true);

    // 等待重启对话框显示
    await waitFor(() => {
      expect(
        screen.getByText(/恢复完成|data:governance\.restore_complete_title/i),
      ).toBeInTheDocument();
    });

    // 点击"立即重启"
    const restartNowBtn = screen.getByRole('button', {
      name: /立即重启|data:governance\.restart_now/i,
    });
    await act(async () => {
      fireEvent.click(restartNowBtn);
    });

    // restartApp 应被调用
    await waitFor(() => {
      expect(mockRestartApp).toHaveBeenCalled();
    });

    // 对话框应关闭
    await waitFor(() => {
      expect(
        screen.queryByText(/恢复完成|data:governance\.restore_complete_title/i),
      ).not.toBeInTheDocument();
    });
  });

  it('closes dialog without restarting when clicking "restart later"', async () => {
    await startRestoreAndComplete(true);

    // 等待重启对话框显示
    await waitFor(() => {
      expect(
        screen.getByText(/恢复完成|data:governance\.restore_complete_title/i),
      ).toBeInTheDocument();
    });

    // 点击"稍后重启"
    const restartLaterBtn = screen.getByRole('button', {
      name: /稍后重启|data:governance\.restart_later/i,
    });
    await act(async () => {
      fireEvent.click(restartLaterBtn);
    });

    // 对话框应关闭
    await waitFor(() => {
      expect(
        screen.queryByText(/恢复完成|data:governance\.restore_complete_title/i),
      ).not.toBeInTheDocument();
    });

    // restartApp 不应被调用
    expect(mockRestartApp).not.toHaveBeenCalled();
  });
});
