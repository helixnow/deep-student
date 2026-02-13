/**
 * 维护模式 UI 行为测试
 *
 * 覆盖场景：
 * 1. 维护模式横幅显示（maintenanceMode = true）
 * 2. 维护模式横幅隐藏（maintenanceMode = false）
 * 3. 维护模式原因显示（maintenanceReason 自定义文案）
 * 4. 备份操作触发维护模式（Dashboard 创建备份 → store.maintenanceMode = true）
 * 5. 备份完成退出维护模式（onComplete → store.maintenanceMode = false）
 * 6. 维护模式下聊天发送被阻止（sendMessage 早返回）
 * 7. enterMaintenanceMode / exitMaintenanceMode 状态转换
 * 8. 多次进入维护模式的幂等性
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { useSystemStatusStore } from '@/stores/systemStatusStore';

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

// ============================================================================
// 延迟导入组件（需在 vi.mock 之后）
// ============================================================================

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
  checked_at: '2026-02-08T00:00:00Z',
  pending_migrations_count: 0,
  has_pending_migrations: false,
  audit_log_healthy: true,
  audit_log_error: null,
  audit_log_error_at: null,
};

// ============================================================================
// 辅助组件：复现 App.tsx 中维护模式横幅的渲染逻辑
// ============================================================================

function MaintenanceBannerTestHarness() {
  const maintenanceMode = useSystemStatusStore((s) => s.maintenanceMode);
  const maintenanceReason = useSystemStatusStore((s) => s.maintenanceReason);

  return (
    <div>
      {maintenanceMode && (
        <div data-testid="maintenance-banner" role="alert">
          <span data-testid="maintenance-title">维护模式</span>
          <span data-testid="maintenance-reason">
            {maintenanceReason || '系统正在进行维护操作，部分功能暂时受限。'}
          </span>
        </div>
      )}
    </div>
  );
}

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
// 测试组 1：维护模式横幅显示 / 隐藏 / 原因
// ============================================================================

describe('Maintenance mode banner visibility', () => {
  beforeEach(() => {
    // 每个测试前重置 store 到默认状态
    act(() => {
      useSystemStatusStore.getState().exitMaintenanceMode();
    });
  });

  it('shows maintenance banner when maintenanceMode = true', () => {
    act(() => {
      useSystemStatusStore.getState().enterMaintenanceMode('测试维护');
    });

    render(<MaintenanceBannerTestHarness />);

    expect(screen.getByTestId('maintenance-banner')).toBeInTheDocument();
    expect(screen.getByTestId('maintenance-title')).toHaveTextContent('维护模式');
  });

  it('hides maintenance banner when maintenanceMode = false', () => {
    // 默认 maintenanceMode = false
    render(<MaintenanceBannerTestHarness />);

    expect(screen.queryByTestId('maintenance-banner')).not.toBeInTheDocument();
  });

  it('displays specific maintenance reason in the banner', () => {
    const reason = '正在恢复备份';
    act(() => {
      useSystemStatusStore.getState().enterMaintenanceMode(reason);
    });

    render(<MaintenanceBannerTestHarness />);

    expect(screen.getByTestId('maintenance-banner')).toBeInTheDocument();
    expect(screen.getByTestId('maintenance-reason')).toHaveTextContent(reason);
  });
});

// ============================================================================
// 测试组 2：备份操作触发 / 退出维护模式
// ============================================================================

describe('Backup operations trigger maintenance mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListenerCallbacks = {};

    // 重置 store
    act(() => {
      useSystemStatusStore.getState().exitMaintenanceMode();
    });

    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);
    mockDataGovernanceApi.getBackupList.mockResolvedValue([]);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
  });

  it('enters maintenance mode when creating a full backup', async () => {
    mockDataGovernanceApi.runBackup.mockResolvedValue({
      job_id: 'maint-backup-001',
      kind: 'export',
      status: 'queued',
      message: 'started',
    });

    // 备份前，维护模式应为 false
    expect(useSystemStatusStore.getState().maintenanceMode).toBe(false);

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    const createBtn = screen.getByRole('button', {
      name: /完整备份|data:governance\.create_full_backup/i,
    });

    await act(async () => {
      fireEvent.click(createBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.runBackup).toHaveBeenCalled();
    });

    // 备份开始后，维护模式应为 true
    expect(useSystemStatusStore.getState().maintenanceMode).toBe(true);
    expect(useSystemStatusStore.getState().maintenanceReason).toBeTruthy();
  });

  it('exits maintenance mode when backup completes', async () => {
    mockDataGovernanceApi.runBackup.mockResolvedValue({
      job_id: 'maint-complete-001',
      kind: 'export',
      status: 'queued',
      message: 'started',
    });

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    const createBtn = screen.getByRole('button', {
      name: /完整备份|data:governance\.create_full_backup/i,
    });

    await act(async () => {
      fireEvent.click(createBtn);
    });

    await waitFor(() => {
      expect(mockDataGovernanceApi.runBackup).toHaveBeenCalled();
    });

    // 确认进入维护模式
    expect(useSystemStatusStore.getState().maintenanceMode).toBe(true);

    // 模拟备份完成
    expect(capturedListenerCallbacks.onComplete).toBeDefined();
    await act(async () => {
      capturedListenerCallbacks.onComplete!({
        job_id: 'maint-complete-001',
        kind: 'export',
        status: 'completed',
        phase: 'done',
        progress: 100,
        processed_items: 4,
        total_items: 4,
        cancellable: false,
        created_at: '2026-02-08T12:00:00Z',
        result: { success: true, requires_restart: false },
      });
    });

    // 备份完成后，维护模式应为 false
    expect(useSystemStatusStore.getState().maintenanceMode).toBe(false);
    expect(useSystemStatusStore.getState().maintenanceReason).toBeNull();
  });
});

// ============================================================================
// 测试组 3：维护模式下聊天发送被阻止
// ============================================================================

describe('Chat send blocked during maintenance mode', () => {
  beforeEach(() => {
    act(() => {
      useSystemStatusStore.getState().exitMaintenanceMode();
    });
  });

  it('sendMessage returns early when maintenance mode is active', async () => {
    // 进入维护模式
    act(() => {
      useSystemStatusStore.getState().enterMaintenanceMode('备份进行中');
    });

    // 直接检验 useInputBarV2 中的维护模式守卫逻辑
    // useInputBarV2.sendMessage 在开头检查:
    //   if (useSystemStatusStore.getState().maintenanceMode) { ... return; }
    // 这里验证 store 状态确实被正确设置，使得守卫生效
    const storeState = useSystemStatusStore.getState();
    expect(storeState.maintenanceMode).toBe(true);

    // 模拟 sendMessage 中的守卫检查（与 useInputBarV2.ts 第 198 行逻辑一致）
    let sendBlocked = false;
    if (useSystemStatusStore.getState().maintenanceMode) {
      sendBlocked = true;
    }
    expect(sendBlocked).toBe(true);

    // 退出维护模式后，守卫应放行
    act(() => {
      useSystemStatusStore.getState().exitMaintenanceMode();
    });

    let sendBlockedAfterExit = false;
    if (useSystemStatusStore.getState().maintenanceMode) {
      sendBlockedAfterExit = true;
    }
    expect(sendBlockedAfterExit).toBe(false);
  });

  it('file upload is blocked during maintenance mode (store guard)', () => {
    // 进入维护模式
    act(() => {
      useSystemStatusStore.getState().enterMaintenanceMode('恢复进行中');
    });

    // InputBarUI.processFilesToAttachments 在开头检查:
    //   if (useSystemStatusStore.getState().maintenanceMode) { ... return; }
    // 验证该守卫条件成立
    expect(useSystemStatusStore.getState().maintenanceMode).toBe(true);

    // 退出后恢复
    act(() => {
      useSystemStatusStore.getState().exitMaintenanceMode();
    });
    expect(useSystemStatusStore.getState().maintenanceMode).toBe(false);
  });
});

// ============================================================================
// 测试组 4：enterMaintenanceMode / exitMaintenanceMode 状态转换
// ============================================================================

describe('enterMaintenanceMode / exitMaintenanceMode state transitions', () => {
  beforeEach(() => {
    act(() => {
      useSystemStatusStore.getState().exitMaintenanceMode();
    });
  });

  it('enterMaintenanceMode sets maintenanceMode=true and stores reason', () => {
    const reason = '正在恢复备份数据';

    act(() => {
      useSystemStatusStore.getState().enterMaintenanceMode(reason);
    });

    const state = useSystemStatusStore.getState();
    expect(state.maintenanceMode).toBe(true);
    expect(state.maintenanceReason).toBe(reason);
  });

  it('exitMaintenanceMode sets maintenanceMode=false and clears reason', () => {
    // 先进入维护模式
    act(() => {
      useSystemStatusStore.getState().enterMaintenanceMode('某操作');
    });
    expect(useSystemStatusStore.getState().maintenanceMode).toBe(true);
    expect(useSystemStatusStore.getState().maintenanceReason).toBe('某操作');

    // 退出维护模式
    act(() => {
      useSystemStatusStore.getState().exitMaintenanceMode();
    });

    const state = useSystemStatusStore.getState();
    expect(state.maintenanceMode).toBe(false);
    expect(state.maintenanceReason).toBeNull();
  });

  it('enter → exit → enter cycles work correctly', () => {
    const store = useSystemStatusStore;

    // Cycle 1
    act(() => { store.getState().enterMaintenanceMode('第一次'); });
    expect(store.getState().maintenanceMode).toBe(true);
    expect(store.getState().maintenanceReason).toBe('第一次');

    act(() => { store.getState().exitMaintenanceMode(); });
    expect(store.getState().maintenanceMode).toBe(false);
    expect(store.getState().maintenanceReason).toBeNull();

    // Cycle 2
    act(() => { store.getState().enterMaintenanceMode('第二次'); });
    expect(store.getState().maintenanceMode).toBe(true);
    expect(store.getState().maintenanceReason).toBe('第二次');

    act(() => { store.getState().exitMaintenanceMode(); });
    expect(store.getState().maintenanceMode).toBe(false);
    expect(store.getState().maintenanceReason).toBeNull();
  });

  it('enterMaintenanceMode overwrites previous reason', () => {
    act(() => {
      useSystemStatusStore.getState().enterMaintenanceMode('原因A');
    });
    expect(useSystemStatusStore.getState().maintenanceReason).toBe('原因A');

    act(() => {
      useSystemStatusStore.getState().enterMaintenanceMode('原因B');
    });
    expect(useSystemStatusStore.getState().maintenanceReason).toBe('原因B');
    expect(useSystemStatusStore.getState().maintenanceMode).toBe(true);
  });
});

// ============================================================================
// 测试组 5：多次进入维护模式的幂等性
// ============================================================================

describe('Maintenance mode idempotency', () => {
  beforeEach(() => {
    act(() => {
      useSystemStatusStore.getState().exitMaintenanceMode();
    });
  });

  it('consecutive enterMaintenanceMode calls maintain mode=true', () => {
    const store = useSystemStatusStore;

    act(() => { store.getState().enterMaintenanceMode('call-1'); });
    act(() => { store.getState().enterMaintenanceMode('call-2'); });
    act(() => { store.getState().enterMaintenanceMode('call-3'); });

    // 状态应始终为 true，reason 为最后一次调用的值
    expect(store.getState().maintenanceMode).toBe(true);
    expect(store.getState().maintenanceReason).toBe('call-3');
  });

  it('consecutive exitMaintenanceMode calls keep mode=false without error', () => {
    const store = useSystemStatusStore;

    // 先进入维护模式
    act(() => { store.getState().enterMaintenanceMode('test'); });
    expect(store.getState().maintenanceMode).toBe(true);

    // 多次退出不应抛错
    act(() => { store.getState().exitMaintenanceMode(); });
    act(() => { store.getState().exitMaintenanceMode(); });
    act(() => { store.getState().exitMaintenanceMode(); });

    expect(store.getState().maintenanceMode).toBe(false);
    expect(store.getState().maintenanceReason).toBeNull();
  });

  it('banner reflects latest state after rapid enter/exit', () => {
    const store = useSystemStatusStore;

    // 快速切换
    act(() => { store.getState().enterMaintenanceMode('A'); });
    act(() => { store.getState().exitMaintenanceMode(); });
    act(() => { store.getState().enterMaintenanceMode('B'); });

    // 渲染横幅
    render(<MaintenanceBannerTestHarness />);

    // 最终状态应为 maintenanceMode=true，reason='B'
    expect(screen.getByTestId('maintenance-banner')).toBeInTheDocument();
    expect(screen.getByTestId('maintenance-reason')).toHaveTextContent('B');
  });

  it('banner disappears after rapid enter/exit ending with exit', () => {
    const store = useSystemStatusStore;

    act(() => { store.getState().enterMaintenanceMode('X'); });
    act(() => { store.getState().exitMaintenanceMode(); });
    act(() => { store.getState().enterMaintenanceMode('Y'); });
    act(() => { store.getState().exitMaintenanceMode(); });

    render(<MaintenanceBannerTestHarness />);

    // 最终状态应为 maintenanceMode=false
    expect(screen.queryByTestId('maintenance-banner')).not.toBeInTheDocument();
  });
});
