/**
 * 数据治理 Dashboard - 备份配置功能测试
 *
 * 覆盖场景：
 * 1. 备份设置面板渲染（默认展示）
 * 2. 自动备份开关切换
 * 3. 备份间隔选择
 * 4. 最大备份数设置
 * 5. 精简备份模式切换
 * 6. 配置保存失败处理
 * 7. 配置加载失败处理
 * 8. 加载状态显示
 * 9. 保存中状态指示器
 * 10. 自动备份关闭时隐藏间隔选择器
 * 11. 最大备份数边界值处理
 * 12. 进入页面后自动加载配置
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';

// ============================================================================
// Mocks
// ============================================================================

const mockGetBackupConfig = vi.hoisted(() => vi.fn());
const mockSetBackupConfig = vi.hoisted(() => vi.fn());

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

const mockStartListening = vi.hoisted(() => vi.fn());
const mockStopListening = vi.hoisted(() => vi.fn());

vi.mock('@/api/dataGovernance', () => ({
  DataGovernanceApi: mockDataGovernanceApi,
  getBackupConfig: mockGetBackupConfig,
  setBackupConfig: mockSetBackupConfig,
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

const defaultBackupConfig = {
  backupDirectory: null,
  autoBackupEnabled: false,
  autoBackupIntervalHours: 24,
  maxBackupCount: null,
  slimBackup: false,
};

const enabledAutoBackupConfig = {
  backupDirectory: null,
  autoBackupEnabled: true,
  autoBackupIntervalHours: 12,
  maxBackupCount: 10,
  slimBackup: false,
};

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

/** 兼容旧流程：设置区改为默认展示后，此函数保留为无操作兼容 */
async function expandSettingsPanel() {
  const settingsBtn = screen.queryByRole('button', {
    name: /备份设置|data:governance\.backup_settings/i,
  });
  if (settingsBtn) {
    await act(async () => {
      fireEvent.click(settingsBtn);
    });
  }
}

// ============================================================================
// 测试组 1：备份设置面板渲染
// ============================================================================

describe('DataGovernanceDashboard backup settings panel rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBackupConfig.mockResolvedValue(defaultBackupConfig);
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);
    mockDataGovernanceApi.getBackupList.mockResolvedValue([]);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
    mockDataGovernanceApi.checkDiskSpaceForRestore.mockResolvedValue({
      has_enough_space: true,
      available_bytes: 10737418240,
      required_bytes: 2147483648,
      backup_size: 1536000,
    });
  });

  it('renders backup settings panel by default and auto-loads config', async () => {
    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    // 备份设置标题可见（非折叠按钮）
    expect(
      screen.getByText(/备份设置$|data:governance\.backup_settings$/i),
    ).toBeInTheDocument();

    // 进入页面后会自动加载配置
    await waitFor(() => {
      expect(mockGetBackupConfig).toHaveBeenCalledTimes(1);
    });
  });

  it('expands settings panel and loads config when clicked', async () => {
    mockGetBackupConfig.mockResolvedValue(defaultBackupConfig);

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    // 展开面板
    await expandSettingsPanel();

    // getBackupConfig 应被调用
    await waitFor(() => {
      expect(mockGetBackupConfig).toHaveBeenCalledTimes(1);
    });

    // 配置加载后，精简备份模式开关应可见（唯一文本，无歧义）
    await waitFor(() => {
      expect(
        screen.getByText(/精简备份模式|data:governance\.slim_backup$/i),
      ).toBeInTheDocument();
    });
  });

  it('shows loading indicator while config is being loaded', async () => {
    // 让 getBackupConfig 延迟响应
    let resolveConfig: (value: unknown) => void;
    mockGetBackupConfig.mockReturnValue(
      new Promise((resolve) => {
        resolveConfig = resolve;
      }),
    );

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    await expandSettingsPanel();

    // 加载中应该显示加载指示器
    await waitFor(() => {
      expect(
        screen.getByText(/加载中|common:status\.loading/i),
      ).toBeInTheDocument();
    });

    // 完成加载
    await act(async () => {
      resolveConfig!(defaultBackupConfig);
    });

    // 加载完成后，配置项应可见
    await waitFor(() => {
      expect(
        screen.getByText(/精简备份模式|data:governance\.slim_backup$/i),
      ).toBeInTheDocument();
    });
  });
});

// ============================================================================
// 测试组 2：自动备份开关切换
// ============================================================================

describe('DataGovernanceDashboard auto backup toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBackupConfig.mockResolvedValue(defaultBackupConfig);
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);
    mockDataGovernanceApi.getBackupList.mockResolvedValue([]);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
    mockDataGovernanceApi.checkDiskSpaceForRestore.mockResolvedValue({
      has_enough_space: true,
      available_bytes: 10737418240,
      required_bytes: 2147483648,
      backup_size: 1536000,
    });
  });

  it('toggles auto backup switch from off to on and saves config', async () => {
    mockGetBackupConfig.mockResolvedValue(defaultBackupConfig);
    mockSetBackupConfig.mockResolvedValue(undefined);

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();
    await expandSettingsPanel();

    // 等待配置加载（通过精简备份模式文本确认）
    await waitFor(() => {
      expect(
        screen.getByText(/精简备份模式|data:governance\.slim_backup$/i),
      ).toBeInTheDocument();
    });

    // 找到自动备份开关（Switch 组件的 role 是 switch）
    const switches = screen.getAllByRole('switch');
    // 第一个 switch 是自动备份开关
    const autoBackupSwitch = switches[0];
    expect(autoBackupSwitch).not.toBeChecked();

    // 切换开关
    await act(async () => {
      fireEvent.click(autoBackupSwitch);
    });

    // setBackupConfig 应被调用，且 autoBackupEnabled 为 true
    await waitFor(() => {
      expect(mockSetBackupConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          autoBackupEnabled: true,
        }),
      );
    });
  });

  it('shows backup interval selector when auto backup is enabled', async () => {
    mockGetBackupConfig.mockResolvedValue(enabledAutoBackupConfig);
    mockSetBackupConfig.mockResolvedValue(undefined);

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();
    await expandSettingsPanel();

    // 等待配置加载
    await waitFor(() => {
      expect(
        screen.getByText(/备份间隔|data:governance\.auto_backup_interval$/i),
      ).toBeInTheDocument();
    });
  });

  it('hides backup interval selector when auto backup is disabled', async () => {
    mockGetBackupConfig.mockResolvedValue(defaultBackupConfig);

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();
    await expandSettingsPanel();

    // 等待配置加载（通过精简备份模式文本确认）
    await waitFor(() => {
      expect(
        screen.getByText(/精简备份模式|data:governance\.slim_backup$/i),
      ).toBeInTheDocument();
    });

    // 自动备份关闭时，间隔选择器不应该显示
    expect(
      screen.queryByText(/备份间隔|data:governance\.auto_backup_interval$/i),
    ).not.toBeInTheDocument();
  });
});

// ============================================================================
// 测试组 3：最大备份数设置
// ============================================================================

describe('DataGovernanceDashboard max backup count', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBackupConfig.mockResolvedValue(defaultBackupConfig);
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);
    mockDataGovernanceApi.getBackupList.mockResolvedValue([]);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
    mockDataGovernanceApi.checkDiskSpaceForRestore.mockResolvedValue({
      has_enough_space: true,
      available_bytes: 10737418240,
      required_bytes: 2147483648,
      backup_size: 1536000,
    });
  });

  it('renders max backup count input with current value', async () => {
    mockGetBackupConfig.mockResolvedValue(enabledAutoBackupConfig);

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();
    await expandSettingsPanel();

    await waitFor(() => {
      expect(
        screen.getByText(/最大备份保留数|data:governance\.max_backup_count$/i),
      ).toBeInTheDocument();
    });

    // 输入框应显示当前值 10
    const input = screen.getByRole('spinbutton');
    expect(input).toHaveValue(10);
  });

  it('updates max backup count and saves config on change', async () => {
    mockGetBackupConfig.mockResolvedValue(enabledAutoBackupConfig);
    mockSetBackupConfig.mockResolvedValue(undefined);

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();
    await expandSettingsPanel();

    await waitFor(() => {
      expect(screen.getByRole('spinbutton')).toBeInTheDocument();
    });

    const input = screen.getByRole('spinbutton');

    await act(async () => {
      fireEvent.change(input, { target: { value: '20' } });
    });

    // setBackupConfig 应被调用，且 maxBackupCount 为 20
    await waitFor(() => {
      expect(mockSetBackupConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          maxBackupCount: 20,
        }),
      );
    });
  });

  it('clamps max backup count to valid range (1-100)', async () => {
    mockGetBackupConfig.mockResolvedValue(enabledAutoBackupConfig);
    mockSetBackupConfig.mockResolvedValue(undefined);

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();
    await expandSettingsPanel();

    await waitFor(() => {
      expect(screen.getByRole('spinbutton')).toBeInTheDocument();
    });

    const input = screen.getByRole('spinbutton');

    // 输入超过 100 的值应被截断到 100
    await act(async () => {
      fireEvent.change(input, { target: { value: '200' } });
    });

    await waitFor(() => {
      expect(mockSetBackupConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          maxBackupCount: 100,
        }),
      );
    });
  });

  it('sets maxBackupCount to null when input is cleared', async () => {
    mockGetBackupConfig.mockResolvedValue(enabledAutoBackupConfig);
    mockSetBackupConfig.mockResolvedValue(undefined);

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();
    await expandSettingsPanel();

    await waitFor(() => {
      expect(screen.getByRole('spinbutton')).toBeInTheDocument();
    });

    const input = screen.getByRole('spinbutton');

    // 清空输入框表示无限制
    await act(async () => {
      fireEvent.change(input, { target: { value: '' } });
    });

    await waitFor(() => {
      expect(mockSetBackupConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          maxBackupCount: null,
        }),
      );
    });
  });
});

// ============================================================================
// 测试组 4：精简备份模式
// ============================================================================

describe('DataGovernanceDashboard slim backup mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBackupConfig.mockResolvedValue(defaultBackupConfig);
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);
    mockDataGovernanceApi.getBackupList.mockResolvedValue([]);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
    mockDataGovernanceApi.checkDiskSpaceForRestore.mockResolvedValue({
      has_enough_space: true,
      available_bytes: 10737418240,
      required_bytes: 2147483648,
      backup_size: 1536000,
    });
  });

  it('toggles slim backup mode and saves config', async () => {
    mockGetBackupConfig.mockResolvedValue(defaultBackupConfig);
    mockSetBackupConfig.mockResolvedValue(undefined);

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();
    await expandSettingsPanel();

    // 等待配置加载（通过精简备份模式文本确认）
    await waitFor(() => {
      expect(
        screen.getByText(/精简备份模式|data:governance\.slim_backup$/i),
      ).toBeInTheDocument();
    });

    // 在设置面板中找到 switch 元素
    // 当 autoBackupEnabled 为 false 时，有 auto_backup 和 slim_backup 两个 switch
    // 还可能有分层备份区域的 includeAssets switch，所以使用最后一个 in settings panel
    const switches = screen.getAllByRole('switch');
    // slim_backup 是设置面板中最后一个 switch（第二个）
    const slimSwitch = switches[1];
    expect(slimSwitch).not.toBeChecked();

    await act(async () => {
      fireEvent.click(slimSwitch);
    });

    // setBackupConfig 应被调用，且 slimBackup 为 true
    await waitFor(() => {
      expect(mockSetBackupConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          slimBackup: true,
        }),
      );
    });
  });
});

// ============================================================================
// 测试组 5：配置保存/加载失败处理
// ============================================================================

describe('DataGovernanceDashboard backup config error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBackupConfig.mockResolvedValue(defaultBackupConfig);
    mockDataGovernanceApi.getMigrationStatus.mockResolvedValue(healthyMigrationStatus);
    mockDataGovernanceApi.runHealthCheck.mockResolvedValue(healthyHealthCheck);
    mockDataGovernanceApi.getBackupList.mockResolvedValue([]);
    mockDataGovernanceApi.listResumableJobs.mockResolvedValue([]);
    mockDataGovernanceApi.getSyncStatus.mockResolvedValue(null);
    mockDataGovernanceApi.getAuditLogs.mockResolvedValue({ logs: [], total: 0 });
    mockDataGovernanceApi.checkDiskSpaceForRestore.mockResolvedValue({
      has_enough_space: true,
      available_bytes: 10737418240,
      required_bytes: 2147483648,
      backup_size: 1536000,
    });
  });

  it('handles config load failure gracefully without crashing', async () => {
    // 第一次调用失败，之后恢复正常（useEffect 会在失败后重试）
    mockGetBackupConfig
      .mockRejectedValueOnce(new Error('Config file corrupted'))
      .mockResolvedValue(defaultBackupConfig);

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();
    await expandSettingsPanel();

    // getBackupConfig 应被调用（至少一次失败 + 一次成功重试）
    await waitFor(() => {
      expect(mockGetBackupConfig).toHaveBeenCalled();
    });

    // 组件不应崩溃，备份设置标题仍可见
    expect(
      screen.getByText(/备份设置$|data:governance\.backup_settings$/i),
    ).toBeInTheDocument();

    // 重试成功后配置项应可见
    await waitFor(() => {
      expect(
        screen.getByText(/精简备份模式|data:governance\.slim_backup$/i),
      ).toBeInTheDocument();
    });
  });

  it('handles config save failure gracefully', async () => {
    mockGetBackupConfig.mockResolvedValue(defaultBackupConfig);
    mockSetBackupConfig.mockRejectedValue(new Error('Permission denied: cannot write config'));

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();
    await expandSettingsPanel();

    // 等待配置加载（通过精简备份模式文本确认）
    await waitFor(() => {
      expect(
        screen.getByText(/精简备份模式|data:governance\.slim_backup$/i),
      ).toBeInTheDocument();
    });

    // 切换自动备份开关触发保存
    const switches = screen.getAllByRole('switch');
    const autoBackupSwitch = switches[0];

    await act(async () => {
      fireEvent.click(autoBackupSwitch);
    });

    // setBackupConfig 应被调用
    await waitFor(() => {
      expect(mockSetBackupConfig).toHaveBeenCalled();
    });

    // 组件不应崩溃，面板应保持显示
    expect(
      screen.getByText(/精简备份模式|data:governance\.slim_backup$/i),
    ).toBeInTheDocument();
  });

  it('does not call getBackupConfig again if already loaded', async () => {
    mockGetBackupConfig.mockResolvedValue(defaultBackupConfig);

    render(<DataGovernanceDashboard embedded />);
    await navigateToBackupTab();

    // 进入页面后首次加载
    await waitFor(() => {
      expect(mockGetBackupConfig).toHaveBeenCalledTimes(1);
    });

    // 后续重渲染不应重复加载（配置已缓存）
    expect(mockGetBackupConfig).toHaveBeenCalledTimes(1);
  });
});
