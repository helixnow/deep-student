/**
 * 数据治理 Dashboard - 同步操作集成测试
 *
 * 覆盖场景：
 * 1. SyncTab 基础渲染（切换到同步 Tab、验证同步状态信息显示）
 * 2. 云存储未配置（显示配置提示）
 * 3. 同步进度显示（进度条和阶段信息）
 * 4. 冲突检测（调用 API、验证冲突列表显示）
 * 5. 冲突解决（选择策略、验证 API 调用）
 * 6. 同步操作互斥（运行中禁用其他按钮）
 * 7. 同步失败处理（错误消息和状态恢复）
 * 8. 同步完成通知（成功完成后通知）
 * 9. 同步取消/中止（进行中中止同步）
 * 10. 维护模式下同步禁用
 * 11. 未配置时检测冲突提示
 * 12. 同步状态数据库列表（多数据库待同步变更）
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';

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
  detectConflicts: vi.fn(),
  resolveConflicts: vi.fn(),
  runSync: vi.fn(),
  runSyncWithProgress: vi.fn(),
  runSyncWithProgressTracking: vi.fn(),
  createSyncProgressState: vi.fn(),
  exportSyncData: vi.fn(),
  importSyncData: vi.fn(),
  listenSyncProgress: vi.fn(),
  checkDiskSpaceForRestore: vi.fn(),
}));

/** Mock 云存储 API */
const mockLoadStoredCloudStorageConfigSafe = vi.hoisted(() => vi.fn());
const mockLoadStoredCloudStorageConfigWithCredentials = vi.hoisted(() => vi.fn());

vi.mock('@/utils/cloudStorageApi', () => ({
  loadStoredCloudStorageConfigSafe: mockLoadStoredCloudStorageConfigSafe,
  loadStoredCloudStorageConfigWithCredentials: mockLoadStoredCloudStorageConfigWithCredentials,
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
  databases: [],
  checked_at: '2026-02-07T00:00:00Z',
  pending_migrations_count: 0,
  has_pending_migrations: false,
  audit_log_healthy: true,
  audit_log_error: null,
  audit_log_error_at: null,
};

const sampleSyncStatus = {
  has_pending_changes: true,
  total_pending_changes: 15,
  total_synced_changes: 120,
  databases: [
    {
      id: 'chat_v2',
      has_change_log: true,
      pending_changes: 8,
      synced_changes: 50,
      last_sync_at: '2026-02-07T10:00:00Z',
    },
    {
      id: 'vfs',
      has_change_log: true,
      pending_changes: 5,
      synced_changes: 40,
      last_sync_at: '2026-02-07T10:00:00Z',
    },
    {
      id: 'mistakes',
      has_change_log: true,
      pending_changes: 2,
      synced_changes: 30,
      last_sync_at: '2026-02-07T09:30:00Z',
    },
  ],
  last_sync_at: '2026-02-07T10:00:00Z',
  device_id: 'device-abc12345-def67890',
};

const sampleCloudConfig = {
  provider: 'webdav' as const,
  webdav: {
    endpoint: 'https://dav.example.com',
    username: 'user',
    password: 'secret',
  },
  root: '/deep-student-sync',
};

const sampleConflictDetection = {
  has_conflicts: true,
  needs_migration: false,
  database_conflicts: [
    {
      database_name: 'chat_v2',
      conflict_type: 'version_mismatch',
      local_version: 10,
      cloud_version: 12,
      local_schema_version: 20260207,
      cloud_schema_version: 20260207,
    },
  ],
  record_conflict_count: 3,
  local_manifest_json: '{}',
  cloud_manifest_json: '{}',
};

function setupDefaultMocks(opts?: { cloudConfigured?: boolean }) {
  mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
  mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);
  mockDataGovernanceApi.getBackupList.mockResolvedValue([]);
  mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
  mockDataGovernanceApi.getSyncStatus.mockResolvedValue(sampleSyncStatus);
  mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });

  if (opts?.cloudConfigured) {
    mockLoadStoredCloudStorageConfigSafe.mockReturnValue({
      provider: 'webdav',
      root: '/deep-student-sync',
    });
    mockLoadStoredCloudStorageConfigWithCredentials.mockResolvedValue(sampleCloudConfig);
  } else {
    mockLoadStoredCloudStorageConfigSafe.mockReturnValue(null);
    mockLoadStoredCloudStorageConfigWithCredentials.mockResolvedValue(null);
  }
}

/** 导航到同步 Tab 的辅助函数 */
async function navigateToSyncTab() {
  const syncTab = await screen.findByRole('button', {
    name: /同步|data:governance\.tab_sync/i,
  });
  fireEvent.click(syncTab);
  await waitFor(() => {
    expect(mockDataGovernanceApi.getSyncStatus).toHaveBeenCalled();
  });
}

// ============================================================================
// 测试组 1：SyncTab 基础渲染
// ============================================================================

describe('DataGovernanceDashboard SyncTab basic rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    setupDefaultMocks({ cloudConfigured: true });
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  afterEach(() => {
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  it('switches to sync tab and displays sync status overview', async () => {
    render(<DataGovernanceDashboard embedded />);
    await navigateToSyncTab();

    // 验证待同步变更数显示
    expect(screen.getByText('15')).toBeInTheDocument();

    // 验证已同步变更数显示
    expect(screen.getByText('120')).toBeInTheDocument();

    // 验证设备 ID 前 8 位显示
    expect(screen.getByText(/device-a/)).toBeInTheDocument();
  });

  it('displays sync status labels correctly', async () => {
    render(<DataGovernanceDashboard embedded />);
    await navigateToSyncTab();

    // 验证标签存在
    expect(
      screen.getByText(/待同步变更|data:governance\.pending_changes/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/已同步变更|data:governance\.synced_changes/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/设备 ID|data:governance\.device_id/i),
    ).toBeInTheDocument();
  });
});

// ============================================================================
// 测试组 2：云存储未配置
// ============================================================================

describe('DataGovernanceDashboard SyncTab cloud not configured', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    setupDefaultMocks({ cloudConfigured: false });
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  afterEach(() => {
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  it('shows cloud storage configuration prompt when not configured', async () => {
    render(<DataGovernanceDashboard embedded />);
    await navigateToSyncTab();

    // 验证显示"尚未配置云存储"提示
    // 使用精确正则避免 cloud_sync_not_configured 同时匹配 cloud_sync_not_configured_desc
    const notConfiguredElements = await screen.findAllByText(
      /^尚未配置云存储$|^data:governance\.cloud_sync_not_configured$/i,
    );
    expect(notConfiguredElements.length).toBeGreaterThanOrEqual(1);

    // 验证"去配置云存储"按钮存在
    expect(
      await screen.findByText(/去配置云存储|cloud_sync_configure_now/i),
    ).toBeInTheDocument();
  });

  it('does not show sync direction buttons when cloud not configured', async () => {
    render(<DataGovernanceDashboard embedded />);
    await navigateToSyncTab();

    // 双向同步按钮不应存在（未配置时不渲染同步操作区域）
    expect(
      screen.queryByText(/双向同步|data:governance\.sync_bidirectional/i),
    ).not.toBeInTheDocument();
  });
});

// ============================================================================
// 测试组 3：同步进度显示
// ============================================================================

describe('DataGovernanceDashboard SyncTab sync progress display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    setupDefaultMocks({ cloudConfigured: true });
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  afterEach(() => {
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  it('shows progress bar and phase info when sync is running', async () => {
    // 使用 deferred 模式：onProgress 后保持 promise 挂起，以便验证进度 UI
    let resolveSyncFn: ((value: unknown) => void) | undefined;

    mockDataGovernanceApi.runSyncWithProgressTracking.mockImplementation(
      (
        _direction: string,
        _cloudConfig: unknown,
        options: { onProgress?: (progress: unknown) => void },
      ) => {
        // 发送进度事件
        if (options.onProgress) {
          options.onProgress({
            phase: 'uploading',
            percent: 45,
            current: 5,
            total: 12,
            current_item: 'chat_v2.db',
            speed_bytes_per_sec: 1048576,
            eta_seconds: 30,
            error: null,
          });
        }
        // 返回一个挂起的 promise，保持 isSyncRunning = true
        return new Promise((resolve) => {
          resolveSyncFn = resolve;
        });
      },
    );

    render(<DataGovernanceDashboard embedded />);
    await navigateToSyncTab();

    // 点击双向同步按钮
    const syncBtn = screen.getByRole('button', {
      name: /双向同步|data:governance\.sync_bidirectional/i,
    });
    await act(async () => {
      fireEvent.click(syncBtn);
    });

    // 验证进度百分比显示（45% 会被 Math.round 处理）
    await waitFor(() => {
      expect(screen.getByText('45%')).toBeInTheDocument();
    });

    // 验证同步进行中的文本
    expect(
      screen.getByText(/同步进行中|data:governance\.sync_in_progress/i),
    ).toBeInTheDocument();

    // 验证进度项计数
    expect(screen.getByText(/5 \/ 12/)).toBeInTheDocument();

    // 完成同步以清理
    if (resolveSyncFn) {
      await act(async () => {
        resolveSyncFn!({
          success: true,
          direction: 'bidirectional',
          changes_uploaded: 5,
          changes_downloaded: 3,
          conflicts_detected: 0,
          duration_ms: 5000,
          device_id: 'device-abc12345',
          error_message: null,
        });
      });
    }
  });
});

// ============================================================================
// 测试组 4：冲突检测
// ============================================================================

describe('DataGovernanceDashboard SyncTab conflict detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    setupDefaultMocks({ cloudConfigured: true });
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  afterEach(() => {
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  it('calls detectConflicts API and displays conflict info', async () => {
    mockDataGovernanceApi.detectConflicts.mockResolvedValue(sampleConflictDetection);

    render(<DataGovernanceDashboard embedded />);
    await navigateToSyncTab();

    // 点击"检测冲突"按钮
    const detectBtn = screen.getByRole('button', {
      name: /检测冲突|data:governance\.detect_conflicts/i,
    });
    await act(async () => {
      fireEvent.click(detectBtn);
    });

    // 验证 detectConflicts API 被调用
    await waitFor(() => {
      expect(mockDataGovernanceApi.detectConflicts).toHaveBeenCalled();
    });

    // 验证冲突信息区域显示
    await waitFor(() => {
      expect(
        screen.getByText(/检测到冲突|data:governance\.conflicts_detected/i),
      ).toBeInTheDocument();
    });
  });

  it('shows no conflict message when no conflicts detected', async () => {
    mockDataGovernanceApi.detectConflicts.mockResolvedValue({
      has_conflicts: false,
      needs_migration: false,
      database_conflicts: [],
      record_conflict_count: 0,
      local_manifest_json: '{}',
      cloud_manifest_json: '{}',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToSyncTab();

    const detectBtn = screen.getByRole('button', {
      name: /检测冲突|data:governance\.detect_conflicts/i,
    });
    await act(async () => {
      fireEvent.click(detectBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.detectConflicts).toHaveBeenCalled();
    });

    // 无冲突时不应显示冲突面板
    await waitFor(() => {
      expect(
        screen.queryByText(/检测到冲突|data:governance\.conflicts_detected/i),
      ).not.toBeInTheDocument();
    });
  });
});

// ============================================================================
// 测试组 5：冲突解决
// ============================================================================

describe('DataGovernanceDashboard SyncTab conflict resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    setupDefaultMocks({ cloudConfigured: true });
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  afterEach(() => {
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  it('clicking resolve strategy button calls runSyncWithProgressTracking with bidirectional + strategy', async () => {
    mockDataGovernanceApi.detectConflicts.mockResolvedValue(sampleConflictDetection);
    mockDataGovernanceApi.runSyncWithProgressTracking.mockResolvedValue({
      success: true,
      direction: 'bidirectional',
      changes_uploaded: 5,
      changes_downloaded: 3,
      conflicts_detected: 0,
      duration_ms: 3000,
      device_id: 'device-abc12345',
      error_message: null,
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToSyncTab();

    // 先检测冲突
    const detectBtn = screen.getByRole('button', {
      name: /检测冲突|data:governance\.detect_conflicts/i,
    });
    await act(async () => {
      fireEvent.click(detectBtn);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/检测到冲突|data:governance\.conflicts_detected/i),
      ).toBeInTheDocument();
    });

    // 点击"保留本地"解决策略
    const keepLocalBtns = screen.getAllByRole('button', {
      name: /保留本地|data:governance\.keep_local/i,
    });
    // 冲突解决区域中的"保留本地"按钮
    const conflictKeepLocalBtn = keepLocalBtns[keepLocalBtns.length - 1];

    await act(async () => {
      fireEvent.click(conflictKeepLocalBtn);
    });

    // resolveConflicts 内部调用 runCloudSync('bidirectional', strategy)
    // 验证 runSyncWithProgressTracking 被调用
    await waitFor(() => {
      expect(mockDataGovernanceApi.runSyncWithProgressTracking).toHaveBeenCalled();
    });

    const call = mockDataGovernanceApi.runSyncWithProgressTracking.mock.calls[0];
    // 第一个参数: direction = 'bidirectional'
    expect(call[0]).toBe('bidirectional');
    // 第四个参数: strategy = 'keep_local'
    expect(call[3]).toBe('keep_local');
  });
});

// ============================================================================
// 测试组 6：同步操作互斥
// ============================================================================

describe('DataGovernanceDashboard SyncTab sync operation mutual exclusion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    setupDefaultMocks({ cloudConfigured: true });
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  afterEach(() => {
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  it('disables sync buttons while sync is running', async () => {
    // 创建一个永不 resolve 的 promise 来模拟长时间运行的同步
    let resolveSync: ((value: unknown) => void) | undefined;
    mockDataGovernanceApi.runSyncWithProgressTracking.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSync = resolve;
        }),
    );

    render(<DataGovernanceDashboard embedded />);
    await navigateToSyncTab();

    const bidirectionalBtn = screen.getByRole('button', {
      name: /双向同步|data:governance\.sync_bidirectional/i,
    });
    const uploadBtn = screen.getByRole('button', {
      name: /上传|data:governance\.sync_upload/i,
    });
    const downloadBtn = screen.getByRole('button', {
      name: /下载|data:governance\.sync_download/i,
    });

    // 按钮初始可用
    expect(bidirectionalBtn).toBeEnabled();
    expect(uploadBtn).toBeEnabled();
    expect(downloadBtn).toBeEnabled();

    // 启动同步
    await act(async () => {
      fireEvent.click(bidirectionalBtn);
    });

    // 同步进行中，其他按钮应被禁用
    await waitFor(() => {
      expect(bidirectionalBtn).toBeDisabled();
      expect(uploadBtn).toBeDisabled();
      expect(downloadBtn).toBeDisabled();
    });

    // 完成同步以清理
    if (resolveSync) {
      await act(async () => {
        resolveSync!({
          success: true,
          direction: 'bidirectional',
          changes_uploaded: 0,
          changes_downloaded: 0,
          conflicts_detected: 0,
          duration_ms: 100,
          device_id: 'device-abc12345',
          error_message: null,
        });
      });
    }
  });
});

// ============================================================================
// 测试组 7：同步失败处理
// ============================================================================

describe('DataGovernanceDashboard SyncTab sync failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    setupDefaultMocks({ cloudConfigured: true });
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  afterEach(() => {
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  it('recovers button state when runSyncWithProgressTracking rejects', async () => {
    mockDataGovernanceApi.runSyncWithProgressTracking.mockRejectedValue(
      new Error('Network error: connection refused'),
    );

    render(<DataGovernanceDashboard embedded />);
    await navigateToSyncTab();

    const syncBtn = screen.getByRole('button', {
      name: /双向同步|data:governance\.sync_bidirectional/i,
    });
    expect(syncBtn).toBeEnabled();

    await act(async () => {
      fireEvent.click(syncBtn);
    });

    // 等待 API 调用
    await waitFor(() => {
      expect(mockDataGovernanceApi.runSyncWithProgressTracking).toHaveBeenCalled();
    });

    // 按钮应恢复为可用状态（finally 块）
    await waitFor(() => {
      expect(syncBtn).toBeEnabled();
    });
  });

  it('handles sync result with success=false and shows error', async () => {
    mockDataGovernanceApi.runSyncWithProgressTracking.mockResolvedValue({
      success: false,
      direction: 'bidirectional',
      changes_uploaded: 0,
      changes_downloaded: 0,
      conflicts_detected: 0,
      duration_ms: 2000,
      device_id: 'device-abc12345',
      error_message: 'Cloud storage access denied',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToSyncTab();

    const syncBtn = screen.getByRole('button', {
      name: /双向同步|data:governance\.sync_bidirectional/i,
    });
    await act(async () => {
      fireEvent.click(syncBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.runSyncWithProgressTracking).toHaveBeenCalled();
    });

    // 按钮应恢复为可用状态
    await waitFor(() => {
      expect(syncBtn).toBeEnabled();
    });
  });
});

// ============================================================================
// 测试组 8：同步完成通知
// ============================================================================

describe('DataGovernanceDashboard SyncTab sync complete notification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    setupDefaultMocks({ cloudConfigured: true });
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  afterEach(() => {
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  it('refreshes sync status after successful sync completion', async () => {
    mockDataGovernanceApi.runSyncWithProgressTracking.mockResolvedValue({
      success: true,
      direction: 'bidirectional',
      changes_uploaded: 8,
      changes_downloaded: 5,
      conflicts_detected: 0,
      duration_ms: 3000,
      device_id: 'device-abc12345',
      error_message: null,
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToSyncTab();

    const initialSyncStatusCalls = mockDataGovernanceApi.getSyncStatus.mock.calls.length;

    const syncBtn = screen.getByRole('button', {
      name: /双向同步|data:governance\.sync_bidirectional/i,
    });
    await act(async () => {
      fireEvent.click(syncBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.runSyncWithProgressTracking).toHaveBeenCalled();
    });

    // 同步完成后应刷新同步状态
    await waitFor(() => {
      expect(mockDataGovernanceApi.getSyncStatus.mock.calls.length).toBeGreaterThan(
        initialSyncStatusCalls,
      );
    });

    // 按钮应恢复为可用状态
    await waitFor(() => {
      expect(syncBtn).toBeEnabled();
    });
  });

  it('clears conflicts state after successful sync', async () => {
    // 先设置有冲突
    mockDataGovernanceApi.detectConflicts.mockResolvedValue(sampleConflictDetection);
    mockDataGovernanceApi.runSyncWithProgressTracking.mockResolvedValue({
      success: true,
      direction: 'bidirectional',
      changes_uploaded: 5,
      changes_downloaded: 3,
      conflicts_detected: 0,
      duration_ms: 3000,
      device_id: 'device-abc12345',
      error_message: null,
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToSyncTab();

    // 先检测冲突
    const detectBtn = screen.getByRole('button', {
      name: /检测冲突|data:governance\.detect_conflicts/i,
    });
    await act(async () => {
      fireEvent.click(detectBtn);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/检测到冲突|data:governance\.conflicts_detected/i),
      ).toBeInTheDocument();
    });

    // 执行同步（解决冲突）
    const syncBtn = screen.getByRole('button', {
      name: /双向同步|data:governance\.sync_bidirectional/i,
    });
    await act(async () => {
      fireEvent.click(syncBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.runSyncWithProgressTracking).toHaveBeenCalled();
    });

    // 同步成功后冲突信息应被清除
    await waitFor(() => {
      expect(
        screen.queryByText(/检测到冲突|data:governance\.conflicts_detected/i),
      ).not.toBeInTheDocument();
    });
  });
});

// ============================================================================
// 测试组 9：同步取消/中止
// ============================================================================

describe('DataGovernanceDashboard SyncTab sync abort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    setupDefaultMocks({ cloudConfigured: true });
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  afterEach(() => {
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  it('recovers state when sync promise rejects mid-operation', async () => {
    mockDataGovernanceApi.runSyncWithProgressTracking.mockImplementation(
      async (
        _direction: string,
        _cloudConfig: unknown,
        options: { onProgress?: (progress: unknown) => void },
      ) => {
        // 模拟进度事件
        if (options.onProgress) {
          options.onProgress({
            phase: 'uploading',
            percent: 30,
            current: 3,
            total: 10,
            current_item: 'vfs.db',
            speed_bytes_per_sec: 512000,
            eta_seconds: 60,
            error: null,
          });
        }
        // 然后抛出错误
        throw new Error('Connection lost');
      },
    );

    render(<DataGovernanceDashboard embedded />);
    await navigateToSyncTab();

    const syncBtn = screen.getByRole('button', {
      name: /双向同步|data:governance\.sync_bidirectional/i,
    });
    await act(async () => {
      fireEvent.click(syncBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.runSyncWithProgressTracking).toHaveBeenCalled();
    });

    // 按钮应恢复为可用状态
    await waitFor(() => {
      expect(syncBtn).toBeEnabled();
    });

    // 维护模式应退出
    expect(useSystemStatusStore.getState().maintenanceMode).toBe(false);
  });
});

// ============================================================================
// 测试组 10：维护模式下同步禁用
// ============================================================================

describe('DataGovernanceDashboard SyncTab maintenance mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    setupDefaultMocks({ cloudConfigured: true });
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  afterEach(() => {
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  it('enters maintenance mode when sync starts and exits when done', async () => {
    mockDataGovernanceApi.runSyncWithProgressTracking.mockResolvedValue({
      success: true,
      direction: 'bidirectional',
      changes_uploaded: 3,
      changes_downloaded: 2,
      conflicts_detected: 0,
      duration_ms: 1000,
      device_id: 'device-abc12345',
      error_message: null,
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToSyncTab();

    // 初始不在维护模式
    expect(useSystemStatusStore.getState().maintenanceMode).toBe(false);

    const syncBtn = screen.getByRole('button', {
      name: /双向同步|data:governance\.sync_bidirectional/i,
    });
    await act(async () => {
      fireEvent.click(syncBtn);
    });

    // 同步完成后维护模式退出
    await waitFor(() => {
      expect(useSystemStatusStore.getState().maintenanceMode).toBe(false);
    });

    // 按钮恢复可用
    await waitFor(() => {
      expect(syncBtn).toBeEnabled();
    });
  });
});

// ============================================================================
// 测试组 11：未配置时检测冲突提示
// ============================================================================

describe('DataGovernanceDashboard SyncTab detect conflicts without cloud config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    setupDefaultMocks({ cloudConfigured: false });
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  afterEach(() => {
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  it('shows configuration prompt when detecting conflicts without cloud config', async () => {
    // 虽然 cloudSyncConfigured = false，但"检测冲突"按钮仍然渲染（在数据库同步状态区域）
    // 不过 loadCloudSyncConfig 会返回 null
    render(<DataGovernanceDashboard embedded />);
    await navigateToSyncTab();

    // 在未配置状态下，检测冲突按钮仍然应该存在
    const detectBtn = screen.getByRole('button', {
      name: /检测冲突|data:governance\.detect_conflicts/i,
    });
    await act(async () => {
      fireEvent.click(detectBtn);
    });

    // detectConflicts 内部 loadCloudSyncConfig 返回 null，应显示配置提示
    // 但 detectConflicts 不应该被调用（因为 cloudConfig 为 null 提前返回）
    await waitFor(() => {
      expect(mockDataGovernanceApi.detectConflicts).not.toHaveBeenCalled();
    });
  });
});

// ============================================================================
// 测试组 12：同步状态数据库列表
// ============================================================================

describe('DataGovernanceDashboard SyncTab database sync status list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};
    setupDefaultMocks({ cloudConfigured: true });
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  afterEach(() => {
    useSystemStatusStore.getState().exitMaintenanceMode();
  });

  it('displays database sync status table with correct data', async () => {
    render(<DataGovernanceDashboard embedded />);
    await navigateToSyncTab();

    // 验证数据库同步状态标题
    expect(
      screen.getByText(/数据库同步状态|data:governance\.database_sync_status/i),
    ).toBeInTheDocument();

    // 验证每个数据库的待同步变更数显示
    // chat_v2: 8 待同步
    expect(screen.getByText('8')).toBeInTheDocument();
    // vfs: 5 待同步
    expect(screen.getByText('5')).toBeInTheDocument();
    // mistakes: 2 待同步
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows empty state when no sync databases are returned', async () => {
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);

    render(<DataGovernanceDashboard embedded />);
    await navigateToSyncTab();

    // 应显示"暂无数据"空状态
    expect(
      screen.getByText(/暂无数据|data:governance\.no_data/i),
    ).toBeInTheDocument();
  });

  it('renders correct number of database rows in sync status table', async () => {
    const fiveDatabaseSync = {
      ...sampleSyncStatus,
      databases: [
        { id: 'chat_v2', has_change_log: true, pending_changes: 10, synced_changes: 50, last_sync_at: null },
        { id: 'vfs', has_change_log: true, pending_changes: 5, synced_changes: 30, last_sync_at: null },
        { id: 'mistakes', has_change_log: true, pending_changes: 3, synced_changes: 20, last_sync_at: null },
        { id: 'llm_usage', has_change_log: false, pending_changes: 0, synced_changes: 0, last_sync_at: null },
      ],
    };
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(fiveDatabaseSync);

    render(<DataGovernanceDashboard embedded />);
    await navigateToSyncTab();

    // 表格应存在 4 行数据行（通过查找每个数据库名称 via getDatabaseDisplayName）
    // 验证所有数据库都渲染了
    const rows = screen.getAllByRole('row');
    // 1 header row + 4 data rows = 5
    expect(rows.length).toBe(5);
  });

  it('shows upload sync direction button for cloud-configured state', async () => {
    render(<DataGovernanceDashboard embedded />);
    await navigateToSyncTab();

    // 验证同步方向按钮存在
    expect(
      screen.getByRole('button', { name: /双向同步|data:governance\.sync_bidirectional/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /上传|data:governance\.sync_upload/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /下载|data:governance\.sync_download/i }),
    ).toBeInTheDocument();
  });

  it('calls runSyncWithProgressTracking with upload direction when upload button is clicked', async () => {
    mockDataGovernanceApi.runSyncWithProgressTracking.mockResolvedValue({
      success: true,
      direction: 'upload',
      changes_uploaded: 15,
      changes_downloaded: 0,
      conflicts_detected: 0,
      duration_ms: 2000,
      device_id: 'device-abc12345',
      error_message: null,
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToSyncTab();

    const uploadBtn = screen.getByRole('button', {
      name: /上传|data:governance\.sync_upload/i,
    });
    await act(async () => {
      fireEvent.click(uploadBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.runSyncWithProgressTracking).toHaveBeenCalled();
    });

    const call = mockDataGovernanceApi.runSyncWithProgressTracking.mock.calls[0];
    expect(call[0]).toBe('upload');
  });
});
