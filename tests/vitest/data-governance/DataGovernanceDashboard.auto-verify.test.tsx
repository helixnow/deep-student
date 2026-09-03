/**
 * 数据治理 Dashboard - 自动验证功能测试
 *
 * 覆盖场景：
 * 1. 概览页显示最近验证结果
 * 2. 点击验证按钮触发验证
 * 3. 验证成功显示绿色状态
 * 4. 验证失败显示红色状态和错误详情
 * 5. 备份列表显示验证状态指示器（verified / failed / verifying / unverified）
 * 6. 验证中显示加载状态
 * 7. 无验证结果时显示"尚未验证"
 *
 * 注意：lastAutoVerifyResult / isVerifying / onVerifyLatestBackup / verificationStatusMap
 * 是 OverviewTab 和 BackupTab 的可选 props，本文件直接渲染子组件进行测试。
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      // 如果第二个参数是字符串，当作 defaultValue
      if (typeof defaultValue === 'string') return defaultValue;
      // 如果第二个参数是对象（插值参数），返回 key
      return key;
    },
    i18n: { language: 'zh-CN', changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

// Mock getBackupConfig / setBackupConfig used internally by BackupTab
vi.mock('@/api/dataGovernance', () => ({
  getBackupConfig: vi.fn().mockResolvedValue({
    backupDirectory: null,
    autoBackupEnabled: false,
    autoBackupIntervalHours: 24,
    maxBackupCount: null,
    slimBackup: false,
  }),
  setBackupConfig: vi.fn().mockResolvedValue(undefined),
}));

const mockShowGlobalNotification = vi.hoisted(() => vi.fn());
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: (...args: unknown[]) => mockShowGlobalNotification(...args),
}));

import { OverviewTab } from '@/features/settings';
import { BackupTab } from '@/features/settings';
import type { AutoVerifyResponse, BackupInfoResponse } from '@/types/dataGovernance';
import type { BackupVerificationStatus } from '@/features/settings';

// ============================================================================
// 默认 mock 数据
// ============================================================================

const defaultMigrationStatus = {
  global_version: 10,
  all_healthy: true,
  databases: [],
  pending_migrations_total: 0,
  has_pending_migrations: false,
  last_error: null,
};

const defaultHealthCheck = {
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

const validAutoVerifyResult: AutoVerifyResponse = {
  backup_id: '20260207_120000',
  is_valid: true,
  verified_at: '2026-02-07T12:30:00Z',
  duration_ms: 1500,
  databases_verified: [
    { id: 'vfs', is_valid: true, error: null },
    { id: 'chat_v2', is_valid: true, error: null },
    { id: 'mistakes', is_valid: true, error: null },
  ],
  errors: [],
};

const failedAutoVerifyResult: AutoVerifyResponse = {
  backup_id: '20260207_120000',
  is_valid: false,
  verified_at: '2026-02-07T12:30:00Z',
  duration_ms: 2300,
  databases_verified: [
    { id: 'vfs', is_valid: true, error: null },
    { id: 'chat_v2', is_valid: false, error: 'integrity_check failed: page 42 corrupted' },
    { id: 'mistakes', is_valid: true, error: null },
  ],
  errors: ['Checksum mismatch for chat_v2.db', 'integrity_check failed: page 42 corrupted'],
};

const sampleBackups: BackupInfoResponse[] = [
  {
    path: '20260207_120000',
    created_at: '2026-02-07T12:00:00Z',
    size: 1536000,
    backup_type: 'full',
    databases: ['vfs', 'chat_v2'],
  },
  {
    path: '20260207_100000',
    created_at: '2026-02-07T10:00:00Z',
    size: 1024000,
    backup_type: 'incremental',
    databases: ['vfs'],
  },
];

const defaultBackupTabProps = {
  backups: sampleBackups,
  loading: false,
  onRefresh: vi.fn(),
  onBackupAndExportZip: vi.fn(),
  onDeleteBackup: vi.fn(),
  onVerifyBackup: vi.fn(),
  onRestoreBackup: vi.fn(),
  onExportZip: vi.fn(),
  onImportZip: vi.fn(),
};

// ============================================================================
// 测试组 1：概览页显示最近验证结果
// ============================================================================

describe('OverviewTab auto-verify result display', () => {
  it('shows "尚未验证" when no lastAutoVerifyResult is provided', () => {
    render(
      <OverviewTab
        migrationStatus={defaultMigrationStatus}
        healthCheck={defaultHealthCheck}
        loading={false}
        onRefresh={vi.fn()}
        onRunHealthCheck={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/尚未验证|data:governance\.last_verification_none/i),
    ).toBeInTheDocument();
  });

  it('shows verification result with timestamp and backup ID when available', () => {
    render(
      <OverviewTab
        migrationStatus={defaultMigrationStatus}
        healthCheck={defaultHealthCheck}
        loading={false}
        onRefresh={vi.fn()}
        onRunHealthCheck={vi.fn()}
        lastAutoVerifyResult={validAutoVerifyResult}
      />,
    );

    // 备份 ID 应显示
    expect(screen.getByText('20260207_120000')).toBeInTheDocument();

    // 验证耗时应显示
    expect(
      screen.getByText(/验证耗时|data:governance\.auto_verify_duration/i),
    ).toBeInTheDocument();
  });

  it('displays verifying state with spinner when isVerifying is true', () => {
    render(
      <OverviewTab
        migrationStatus={defaultMigrationStatus}
        healthCheck={defaultHealthCheck}
        loading={false}
        onRefresh={vi.fn()}
        onRunHealthCheck={vi.fn()}
        isVerifying={true}
      />,
    );

    // 应显示"验证中..."
    expect(
      screen.getByText(/验证中|data:governance\.verification_verifying/i),
    ).toBeInTheDocument();
  });
});

// ============================================================================
// 测试组 2：点击验证按钮触发验证
// ============================================================================

describe('OverviewTab verify button interaction', () => {
  it('renders verify latest backup button', () => {
    const onVerify = vi.fn();

    render(
      <OverviewTab
        migrationStatus={defaultMigrationStatus}
        healthCheck={defaultHealthCheck}
        loading={false}
        onRefresh={vi.fn()}
        onRunHealthCheck={vi.fn()}
        onVerifyLatestBackup={onVerify}
      />,
    );

    const verifyBtn = screen.getByRole('button', {
      name: /验证最新备份|data:governance\.verify_latest_backup/i,
    });
    expect(verifyBtn).toBeInTheDocument();
    expect(verifyBtn).toBeEnabled();
  });

  it('calls onVerifyLatestBackup when verify button is clicked', () => {
    const onVerify = vi.fn();

    render(
      <OverviewTab
        migrationStatus={defaultMigrationStatus}
        healthCheck={defaultHealthCheck}
        loading={false}
        onRefresh={vi.fn()}
        onRunHealthCheck={vi.fn()}
        onVerifyLatestBackup={onVerify}
      />,
    );

    const verifyBtn = screen.getByRole('button', {
      name: /验证最新备份|data:governance\.verify_latest_backup/i,
    });
    fireEvent.click(verifyBtn);

    expect(onVerify).toHaveBeenCalledTimes(1);
  });

  it('disables verify button when isVerifying is true', () => {
    const onVerify = vi.fn();

    render(
      <OverviewTab
        migrationStatus={defaultMigrationStatus}
        healthCheck={defaultHealthCheck}
        loading={false}
        onRefresh={vi.fn()}
        onRunHealthCheck={vi.fn()}
        onVerifyLatestBackup={onVerify}
        isVerifying={true}
      />,
    );

    const verifyBtn = screen.getByRole('button', {
      name: /验证最新备份|data:governance\.verify_latest_backup/i,
    });
    expect(verifyBtn).toBeDisabled();
  });
});

// ============================================================================
// 测试组 3：验证成功显示绿色状态
// ============================================================================

describe('OverviewTab verification success display', () => {
  it('shows green "通过" indicator when verification is valid', () => {
    render(
      <OverviewTab
        migrationStatus={defaultMigrationStatus}
        healthCheck={defaultHealthCheck}
        loading={false}
        onRefresh={vi.fn()}
        onRunHealthCheck={vi.fn()}
        lastAutoVerifyResult={validAutoVerifyResult}
      />,
    );

    // 应显示"通过"文案
    expect(
      screen.getByText(/^通过$|data:governance\.last_verification_passed/i),
    ).toBeInTheDocument();
  });

  it('does not show error details when verification passes', () => {
    render(
      <OverviewTab
        migrationStatus={defaultMigrationStatus}
        healthCheck={defaultHealthCheck}
        loading={false}
        onRefresh={vi.fn()}
        onRunHealthCheck={vi.fn()}
        lastAutoVerifyResult={validAutoVerifyResult}
      />,
    );

    // 不应显示错误详情
    expect(
      screen.queryByText(/错误详情|data:governance\.verify_errors_title/i),
    ).not.toBeInTheDocument();
  });
});

// ============================================================================
// 测试组 4：验证失败显示红色状态和错误详情
// ============================================================================

describe('OverviewTab verification failure display', () => {
  it('shows red "失败" indicator when verification fails', () => {
    render(
      <OverviewTab
        migrationStatus={defaultMigrationStatus}
        healthCheck={defaultHealthCheck}
        loading={false}
        onRefresh={vi.fn()}
        onRunHealthCheck={vi.fn()}
        lastAutoVerifyResult={failedAutoVerifyResult}
      />,
    );

    // 应显示"失败"文案
    expect(
      screen.getByText(/^失败$|data:governance\.last_verification_failed/i),
    ).toBeInTheDocument();
  });

  it('shows error details section when verification fails', () => {
    render(
      <OverviewTab
        migrationStatus={defaultMigrationStatus}
        healthCheck={defaultHealthCheck}
        loading={false}
        onRefresh={vi.fn()}
        onRunHealthCheck={vi.fn()}
        lastAutoVerifyResult={failedAutoVerifyResult}
      />,
    );

    // 应显示错误详情标题
    expect(
      screen.getByText(/错误详情|data:governance\.verify_errors_title/i),
    ).toBeInTheDocument();

    // 应显示具体错误消息
    expect(
      screen.getByText(/Checksum mismatch for chat_v2\.db/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/integrity_check failed: page 42 corrupted/),
    ).toBeInTheDocument();
  });
});

// ============================================================================
// 测试组 5：备份列表显示验证状态指示器
// ============================================================================

describe('BackupTab verification status indicators', () => {
  it('shows "已验证" badge for verified backups', () => {
    const verificationStatusMap: Record<string, BackupVerificationStatus> = {
      '20260207_120000': 'verified',
    };

    render(
      <BackupTab
        {...defaultBackupTabProps}
        verificationStatusMap={verificationStatusMap}
      />,
    );

    expect(
      screen.getAllByText(/已验证|data:governance\.verification_verified/i),
    ).toHaveLength(2);
  });

  it('shows "验证失败" badge for failed backups', () => {
    const verificationStatusMap: Record<string, BackupVerificationStatus> = {
      '20260207_120000': 'failed',
    };

    render(
      <BackupTab
        {...defaultBackupTabProps}
        verificationStatusMap={verificationStatusMap}
      />,
    );

    expect(
      screen.getAllByText(/验证失败|data:governance\.verification_failed/i),
    ).toHaveLength(2);
  });

  it('shows "验证中" badge with spinner for verifying backups', () => {
    const verificationStatusMap: Record<string, BackupVerificationStatus> = {
      '20260207_120000': 'verifying',
    };

    render(
      <BackupTab
        {...defaultBackupTabProps}
        verificationStatusMap={verificationStatusMap}
      />,
    );

    expect(
      screen.getAllByText(/验证中|data:governance\.verification_verifying/i),
    ).toHaveLength(2);
  });

  it('shows "未验证" badge for unverified backups', () => {
    // No verificationStatusMap provided, or backup not in map
    render(
      <BackupTab
        {...defaultBackupTabProps}
        verificationStatusMap={{}}
      />,
    );

    const unverifiedBadges = screen.getAllByText(
      /未验证|data:governance\.verification_unverified/i,
    );
    expect(unverifiedBadges).toHaveLength(4);
  });

  it('shows different statuses for different backups simultaneously', () => {
    const verificationStatusMap: Record<string, BackupVerificationStatus> = {
      '20260207_120000': 'verified',
      '20260207_100000': 'failed',
    };

    render(
      <BackupTab
        {...defaultBackupTabProps}
        verificationStatusMap={verificationStatusMap}
      />,
    );

    expect(
      screen.getAllByText(/已验证|data:governance\.verification_verified/i),
    ).toHaveLength(2);
    expect(
      screen.getAllByText(/验证失败|data:governance\.verification_failed/i),
    ).toHaveLength(2);
  });
});

// ============================================================================
// 测试组 6：legacy incremental 拒恢复（创建入口已下线）
// ============================================================================

describe('BackupTab legacy incremental restore rejection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('labels incremental packages and blocks restore without calling onRestoreBackup', () => {
    const onRestoreBackup = vi.fn();

    render(
      <BackupTab
        {...defaultBackupTabProps}
        onRestoreBackup={onRestoreBackup}
      />,
    );

    expect(
      screen.getAllByText('data:governance.incremental_legacy_unsupported'),
    ).toHaveLength(2);

    const backupTable = screen.getByRole('table');
    const restoreButtons = within(backupTable).getAllByRole('button', {
      name: 'data:governance.restore',
    });
    expect(restoreButtons.length).toBeGreaterThanOrEqual(2);

    // sampleBackups[1] is incremental
    fireEvent.click(restoreButtons[1]!);

    expect(mockShowGlobalNotification).toHaveBeenCalledWith(
      'warning',
      'data:governance.restore_incremental_not_supported',
    );
    expect(onRestoreBackup).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/data:governance\.confirm_restore/i),
    ).not.toBeInTheDocument();
  });
});
