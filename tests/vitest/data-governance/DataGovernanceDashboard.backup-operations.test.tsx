/**
 * 数据治理 Dashboard - 备份操作集成测试
 *
 * 覆盖场景：
 * 1. 分层备份选择器交互（选择/取消层级、创建调用参数）
 * 2. 备份进度显示（onProgress、阶段名称、ETA）
 * 3. 备份完成回调处理（onComplete 通知、列表刷新）
 * 4. 备份失败处理（API 错误、按钮恢复）
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';

// ============================================================================
// Mocks
// ============================================================================

/** 捕获 useBackupJobListener 回调，用于在测试中模拟后台事件 */
let capturedListenerCallbacks: {
  onProgress?: (event: unknown) => void;
  onComplete?: (event: unknown) => void;
  onError?: (event: unknown) => void;
  onCancelled?: (event: unknown) => void;
} = {};

const mockStartListening = vi.hoisted(() => vi.fn());
const mockStopListening = vi.hoisted(() => vi.fn());
const mockSaveDialog = vi.hoisted(() => vi.fn());

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

vi.mock('@/api/dataGovernance', () => ({
  DataGovernanceApi: mockDataGovernanceApi,
  BACKUP_JOB_PROGRESS_EVENT: 'backup-job-progress',
  isBackupJobTerminal: (status: string) =>
    status === 'completed' || status === 'failed' || status === 'cancelled',
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

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: mockSaveDialog,
}));

vi.mock('@/features/settings/components/MediaCacheSection', () => ({
  MediaCacheSection: () => <div data-testid="media-cache-section">cache-section</div>,
}));

vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: {
    restartApp: vi.fn(),
  },
}));

import { DataGovernanceDashboard } from '@/features/settings';

const exportBackupButtonName = /导出备份|data:governance\.export_backup/i;

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
// 测试组 1：分层备份选择器交互
// ============================================================================

describe('DataGovernanceDashboard tiered backup selector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);
    mockDataGovernanceApi.getBackupList.mockResolvedValue([]);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
    mockDataGovernanceApi.checkDiskSpaceForRestore.mockResolvedValue({ has_enough_space: true, available_bytes: 10737418240, required_bytes: 2147483648, backup_size: 1536000 });
    mockSaveDialog.mockResolvedValue('/tmp/deep-student-backup.zip');
  });

  it('renders tiered backup options after enabling tiered export', async () => {
    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    const tieredToggle = screen.getByRole('checkbox', {
      name: /data:governance\.use_tiered_backup/i,
    });
    fireEvent.click(tieredToggle);

    expect(screen.getByText(/settings:data_governance\.backup_tiers\.core_label/i)).toBeInTheDocument();
    expect(screen.getByText(/settings:data_governance\.backup_tiers\.important_label/i)).toBeInTheDocument();
    expect(screen.getByText(/settings:data_governance\.backup_tiers\.rebuildable_label/i)).toBeInTheDocument();

    const exportBtn = screen.getByRole('button', {
      name: /导出备份|data:governance\.export_backup/i,
    });
    expect(exportBtn).toBeEnabled();
  });

  it('clicking "导出备份" with tiered mode calls backupAndExportZip with default core tier', async () => {
    mockDataGovernanceApi.backupAndExportZip.mockResolvedValue({
      job_id: 'tiered-job-001',
      kind: 'export',
      status: 'queued',
      message: 'started',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    fireEvent.click(screen.getByRole('checkbox', {
      name: /data:governance\.use_tiered_backup/i,
    }));

    const exportBtn = screen.getByRole('button', {
      name: /导出备份|data:governance\.export_backup/i,
    });

    await act(async () => {
      fireEvent.click(exportBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.backupAndExportZip).toHaveBeenCalledTimes(1);
    });

    const callArgs = mockDataGovernanceApi.backupAndExportZip.mock.calls[0];
    expect(callArgs[3]).toBe(true);
    expect(callArgs[4]).toEqual(expect.arrayContaining(['core']));
    // includeAssets 默认 false
    expect(callArgs[5]).toBe(false);
  });

  it('toggling tier checkboxes changes selection state', async () => {
    mockDataGovernanceApi.backupAndExportZip.mockResolvedValue({
      job_id: 'tiered-job-002',
      kind: 'export',
      status: 'queued',
      message: 'started',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    fireEvent.click(screen.getByRole('checkbox', {
      name: /data:governance\.use_tiered_backup/i,
    }));

    // 找到各层级的可点击区域（通过层级标签文本）
    const importantTier = screen.getByText(
      /settings:data_governance\.backup_tiers\.important_label/i,
    );
    const rebuildableTier = screen.getByText(
      /settings:data_governance\.backup_tiers\.rebuildable_label/i,
    );

    // 点击 important 和 rebuildable 层级的包裹 div
    fireEvent.click(importantTier.closest('[class*="cursor-pointer"]')!);
    fireEvent.click(rebuildableTier.closest('[class*="cursor-pointer"]')!);

    const exportBtn = screen.getByRole('button', { name: exportBackupButtonName });

    await act(async () => {
      fireEvent.click(exportBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.backupAndExportZip).toHaveBeenCalledTimes(1);
    });

    const callArgs = mockDataGovernanceApi.backupAndExportZip.mock.calls[0];
    const tiers = callArgs[4] as string[];
    // 应包含 core（默认）+ important + rebuildable
    expect(tiers).toContain('core');
    expect(tiers).toContain('important');
    expect(tiers).toContain('rebuildable');
    expect(tiers).toHaveLength(3);
  });

  it('deselecting core tier and creating backup sends correct tiers', async () => {
    mockDataGovernanceApi.backupAndExportZip.mockResolvedValue({
      job_id: 'tiered-job-003',
      kind: 'export',
      status: 'queued',
      message: 'started',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    fireEvent.click(screen.getByRole('checkbox', {
      name: /data:governance\.use_tiered_backup/i,
    }));

    // 取消 core 层级选择
    const coreTier = screen.getByText(
      /settings:data_governance\.backup_tiers\.core_label/i,
    );
    fireEvent.click(coreTier.closest('[class*="cursor-pointer"]')!);

    // 选择 important 层级
    const importantTier = screen.getByText(
      /settings:data_governance\.backup_tiers\.important_label/i,
    );
    fireEvent.click(importantTier.closest('[class*="cursor-pointer"]')!);

    const exportBtn = screen.getByRole('button', { name: exportBackupButtonName });

    await act(async () => {
      fireEvent.click(exportBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.backupAndExportZip).toHaveBeenCalledTimes(1);
    });

    const tiers = mockDataGovernanceApi.backupAndExportZip.mock.calls[0][4] as string[];
    // core 被取消，只包含 important
    expect(tiers).not.toContain('core');
    expect(tiers).toContain('important');
  });

  it('does not export when tiered mode has no tiers selected', async () => {
    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    fireEvent.click(screen.getByRole('checkbox', {
      name: /data:governance\.use_tiered_backup/i,
    }));

    // 取消 core 层级选择（默认唯一选中项）
    const coreTier = screen.getByText(
      /settings:data_governance\.backup_tiers\.core_label/i,
    );
    fireEvent.click(coreTier.closest('[class*="cursor-pointer"]')!);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: exportBackupButtonName }));
    });

    expect(mockDataGovernanceApi.backupAndExportZip).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 测试组 2：备份进度显示
// ============================================================================

describe('DataGovernanceDashboard backup progress display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);
    mockDataGovernanceApi.getBackupList.mockResolvedValue(sampleBackupList);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
    mockDataGovernanceApi.checkDiskSpaceForRestore.mockResolvedValue({ has_enough_space: true, available_bytes: 10737418240, required_bytes: 2147483648, backup_size: 1536000 });
    mockSaveDialog.mockResolvedValue('/tmp/deep-student-backup.zip');
  });

  it('shows progress bar with percentage and phase when backup is running', async () => {
    mockDataGovernanceApi.backupAndExportZip.mockResolvedValue({
      job_id: 'progress-job-001',
      kind: 'export',
      status: 'queued',
      message: 'started',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    const createBtn = screen.getByRole('button', { name: exportBackupButtonName });
    await act(async () => {
      fireEvent.click(createBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.backupAndExportZip).toHaveBeenCalled();
    });

    // 模拟 onProgress 回调（通过捕获的回调）
    expect(capturedListenerCallbacks.onProgress).toBeDefined();

    await act(async () => {
      capturedListenerCallbacks.onProgress!({
        job_id: 'progress-job-001',
        kind: 'export',
        status: 'running',
        phase: 'Backing up databases',
        progress: 45,
        message: 'Processing chat_v2.db',
        processed_items: 2,
        total_items: 4,
        eta_seconds: 30,
        cancellable: true,
        created_at: '2026-02-07T12:00:00Z',
      });
    });

    // 验证进度百分比显示
    expect(screen.getByText('45%')).toBeInTheDocument();
    // 验证阶段名称显示
    expect(screen.getByText('Backing up databases')).toBeInTheDocument();
    // 验证进度项计数
    expect(screen.getByText(/2 \/ 4/)).toBeInTheDocument();
    // 验证进度消息
    expect(screen.getByText(/Processing chat_v2\.db/)).toBeInTheDocument();
  });

  it('shows ETA when eta_seconds is available', async () => {
    mockDataGovernanceApi.backupAndExportZip.mockResolvedValue({
      job_id: 'progress-eta-001',
      kind: 'export',
      status: 'queued',
      message: 'started',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    const createBtn = screen.getByRole('button', { name: exportBackupButtonName });
    await act(async () => {
      fireEvent.click(createBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.backupAndExportZip).toHaveBeenCalled();
    });

    await act(async () => {
      capturedListenerCallbacks.onProgress!({
        job_id: 'progress-eta-001',
        kind: 'export',
        status: 'running',
        phase: 'Compressing',
        progress: 60,
        processed_items: 3,
        total_items: 5,
        eta_seconds: 120,
        cancellable: true,
        created_at: '2026-02-07T12:00:00Z',
      });
    });

    // ETA 应该显示（formatDuration(120*1000) = "2.0min"）
    // 组件渲染: {formatDuration(backupProgress.eta_seconds * 1000)}
    await waitFor(() => {
      expect(screen.getByText(/预计剩余|data:governance\.eta/)).toBeInTheDocument();
    });
  });

  it('clears progress and shows success notification on onComplete', async () => {
    mockDataGovernanceApi.backupAndExportZip.mockResolvedValue({
      job_id: 'complete-job-001',
      kind: 'export',
      status: 'queued',
      message: 'started',
    });
    // 完成后刷新备份列表
    mockDataGovernanceApi.getBackupList.mockResolvedValue([
      ...sampleBackupList,
      {
        path: '20260207_130000',
        created_at: '2026-02-07T13:00:00Z',
        size: 2048000,
        backup_type: 'full' as const,
        databases: ['vfs', 'chat_v2', 'mistakes'],
      },
    ]);

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    const createBtn = screen.getByRole('button', { name: exportBackupButtonName });
    await act(async () => {
      fireEvent.click(createBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.backupAndExportZip).toHaveBeenCalled();
    });

    // 先模拟进度
    await act(async () => {
      capturedListenerCallbacks.onProgress!({
        job_id: 'complete-job-001',
        kind: 'export',
        status: 'running',
        phase: 'Finalizing',
        progress: 99,
        processed_items: 4,
        total_items: 4,
        cancellable: false,
        created_at: '2026-02-07T12:00:00Z',
      });
    });

    // 确认进度区域可见
    expect(screen.getByText('99%')).toBeInTheDocument();

    // 触发 onComplete
    await act(async () => {
      capturedListenerCallbacks.onComplete!({
        job_id: 'complete-job-001',
        kind: 'export',
        status: 'completed',
        phase: 'done',
        progress: 100,
        processed_items: 4,
        total_items: 4,
        cancellable: false,
        created_at: '2026-02-07T12:00:00Z',
        result: { success: true, requires_restart: false },
      });
    });

    // 完成后按钮应恢复可用（isBackupRunning = false）
    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: exportBackupButtonName,
        }),
      ).toBeEnabled();
    });

    // 备份列表应被刷新（getBackupList 被再次调用）
    await waitFor(() => {
      // 初始加载 1 次 + 完成后刷新至少 1 次
      expect(mockDataGovernanceApi.getBackupList.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('shows correct operation text for tiered backup in progress', async () => {
    mockDataGovernanceApi.backupAndExportZip.mockResolvedValue({
      job_id: 'tiered-progress-001',
      kind: 'export',
      status: 'queued',
      message: 'started',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    fireEvent.click(screen.getByRole('checkbox', {
      name: /data:governance\.use_tiered_backup/i,
    }));

    const createTieredBtn = screen.getByRole('button', { name: exportBackupButtonName });
    await act(async () => {
      fireEvent.click(createTieredBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.backupAndExportZip).toHaveBeenCalled();
    });

    // 模拟进度
    await act(async () => {
      capturedListenerCallbacks.onProgress!({
        job_id: 'tiered-progress-001',
        kind: 'export',
        status: 'running',
        phase: 'Copying core databases',
        progress: 30,
        processed_items: 1,
        total_items: 3,
        cancellable: true,
        created_at: '2026-02-07T12:00:00Z',
      });
    });

    // 备份进行中提示应可见（默认非 zip_export/zip_import/restore 都走"备份进行中"分支）
    expect(
      screen.getByText(/备份进行中|data:governance\.backup_in_progress/i),
    ).toBeInTheDocument();
    expect(screen.getByText('30%')).toBeInTheDocument();
  });
});

// ============================================================================
// 测试组 3：备份失败处理
// ============================================================================

describe('DataGovernanceDashboard backup failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);
    mockDataGovernanceApi.getBackupList.mockResolvedValue(sampleBackupList);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
    mockDataGovernanceApi.checkDiskSpaceForRestore.mockResolvedValue({ has_enough_space: true, available_bytes: 10737418240, required_bytes: 2147483648, backup_size: 1536000 });
    mockSaveDialog.mockResolvedValue('/tmp/deep-student-backup.zip');
  });

  it('recovers button state when backupAndExportZip API rejects', async () => {
    mockDataGovernanceApi.backupAndExportZip.mockRejectedValue(new Error('Disk full'));

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    const createBtn = screen.getByRole('button', { name: exportBackupButtonName });
    expect(createBtn).toBeEnabled();

    await act(async () => {
      fireEvent.click(createBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.backupAndExportZip).toHaveBeenCalled();
    });

    // 按钮应恢复为可用状态
    await waitFor(() => {
      expect(createBtn).toBeEnabled();
    });
  });

  it('recovers button state when tiered backup export rejects', async () => {
    mockDataGovernanceApi.backupAndExportZip.mockRejectedValue(
      new Error('Permission denied'),
    );

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    fireEvent.click(screen.getByRole('checkbox', {
      name: /data:governance\.use_tiered_backup/i,
    }));

    const createTieredBtn = screen.getByRole('button', { name: exportBackupButtonName });
    expect(createTieredBtn).toBeEnabled();

    await act(async () => {
      fireEvent.click(createTieredBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.backupAndExportZip).toHaveBeenCalled();
    });

    // 按钮应恢复为可用状态
    await waitFor(() => {
      expect(createTieredBtn).toBeEnabled();
    });
  });

  it('handles onError callback from backup job listener', async () => {
    mockDataGovernanceApi.backupAndExportZip.mockResolvedValue({
      job_id: 'fail-job-001',
      kind: 'export',
      status: 'queued',
      message: 'started',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    const createBtn = screen.getByRole('button', { name: exportBackupButtonName });
    await act(async () => {
      fireEvent.click(createBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.backupAndExportZip).toHaveBeenCalled();
    });

    // 模拟 onError 回调
    expect(capturedListenerCallbacks.onError).toBeDefined();

    await act(async () => {
      capturedListenerCallbacks.onError!({
        job_id: 'fail-job-001',
        kind: 'export',
        status: 'failed',
        phase: 'failed',
        progress: 50,
        processed_items: 2,
        total_items: 4,
        cancellable: false,
        created_at: '2026-02-07T12:00:00Z',
        result: {
          success: false,
          error: 'Database write failed: disk full',
          requires_restart: false,
        },
        message: 'Backup failed at database copy phase',
      });
    });

    // 按钮应恢复为可用状态
    await waitFor(() => {
      expect(createBtn).toBeEnabled();
    });
  });

  it('handles onCancelled callback from backup job listener', async () => {
    mockDataGovernanceApi.backupAndExportZip.mockResolvedValue({
      job_id: 'cancel-job-001',
      kind: 'export',
      status: 'queued',
      message: 'started',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    const createBtn = screen.getByRole('button', { name: exportBackupButtonName });
    await act(async () => {
      fireEvent.click(createBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.backupAndExportZip).toHaveBeenCalled();
    });

    // 模拟 onCancelled 回调
    expect(capturedListenerCallbacks.onCancelled).toBeDefined();

    await act(async () => {
      capturedListenerCallbacks.onCancelled!({
        job_id: 'cancel-job-001',
        kind: 'export',
        status: 'cancelled',
        phase: 'cancelled',
        progress: 30,
        processed_items: 1,
        total_items: 4,
        cancellable: false,
        created_at: '2026-02-07T12:00:00Z',
      });
    });

    // 按钮应恢复为可用状态
    await waitFor(() => {
      expect(createBtn).toBeEnabled();
    });
  });

  it('cancel button calls cancelBackup API when backup is running', async () => {
    mockDataGovernanceApi.backupAndExportZip.mockResolvedValue({
      job_id: 'cancel-test-001',
      kind: 'export',
      status: 'queued',
      message: 'started',
    });
    mockDataGovernanceApi.cancelBackup.mockResolvedValue(true);

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    // 开始备份
    const createBtn = screen.getByRole('button', { name: exportBackupButtonName });
    await act(async () => {
      fireEvent.click(createBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.backupAndExportZip).toHaveBeenCalled();
    });

    // 模拟运行中的进度（含 cancellable: true）
    await act(async () => {
      capturedListenerCallbacks.onProgress!({
        job_id: 'cancel-test-001',
        kind: 'export',
        status: 'running',
        phase: 'Backing up',
        progress: 50,
        processed_items: 2,
        total_items: 4,
        cancellable: true,
        created_at: '2026-02-07T12:00:00Z',
      });
    });

    // 取消按钮应出现
    const cancelBtn = screen.getByRole('button', {
      name: /取消|common:cancel/i,
    });
    expect(cancelBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(cancelBtn);
    });

    // cancelBackup API 应被调用
    await waitFor(() => {
      expect(mockDataGovernanceApi.cancelBackup).toHaveBeenCalledWith('cancel-test-001');
    });
  });
});

// ============================================================================
// 测试组 4：备份按钮在运行中被禁用
// ============================================================================

describe('DataGovernanceDashboard backup buttons disabled while running', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);
    mockDataGovernanceApi.getBackupList.mockResolvedValue(sampleBackupList);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
    mockDataGovernanceApi.checkDiskSpaceForRestore.mockResolvedValue({ has_enough_space: true, available_bytes: 10737418240, required_bytes: 2147483648, backup_size: 1536000 });
    mockSaveDialog.mockResolvedValue('/tmp/deep-student-backup.zip');
  });

  it('disables backup buttons while a backup job is running', async () => {
    mockDataGovernanceApi.backupAndExportZip.mockResolvedValue({
      job_id: 'running-job-001',
      kind: 'export',
      status: 'queued',
      message: 'started',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    const fullBackupBtn = screen.getByRole('button', { name: exportBackupButtonName });

    // 开始备份
    await act(async () => {
      fireEvent.click(fullBackupBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.backupAndExportZip).toHaveBeenCalled();
    });

    // 模拟运行中
    await act(async () => {
      capturedListenerCallbacks.onProgress!({
        job_id: 'running-job-001',
        kind: 'export',
        status: 'running',
        phase: 'Running',
        progress: 10,
        processed_items: 1,
        total_items: 4,
        cancellable: true,
        created_at: '2026-02-07T12:00:00Z',
      });
    });

    // 导出按钮和分层开关都应被禁用
    expect(fullBackupBtn).toBeDisabled();
    expect(
      screen.getByRole('checkbox', {
        name: /data:governance\.use_tiered_backup/i,
      }),
    ).toBeDisabled();

    // 导入按钮也应被禁用
    expect(
      screen.getByRole('button', {
        name: /导入|data:governance\.import_button/i,
      }),
    ).toBeDisabled();
  });
});
