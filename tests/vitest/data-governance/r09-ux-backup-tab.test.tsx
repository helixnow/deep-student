/**
 * BackupTab E2EE 诚实文案与危险操作确认测试（R09-ux）
 *
 * 覆盖（与既有 BackupTab.zip-password.test.tsx 的密码透传用例不重复）：
 * 1. E2EE 诚实提示：无密码时展示便携归档限制说明，设密码后切换为
 *    敏感材料保护说明（明确业务归档未加密及丢失密码后的真实影响）；
 * 2. 删除备份是危险操作：必须先弹确认框（danger），确认后才回调；
 * 3. 恢复备份必须先弹确认框；部分归档（restorable=false）直接阻止并人话警告；
 * 4. 导出确认描述按是否设密码切换（export_warning_encrypted / export_warning）。
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('react-i18next', () => {
  // 与真实 i18next 一致：t(key, 'fallback') 与 t(key, { defaultValue }) 均返回缺省文案
  const t = (key: string, options?: string | Record<string, unknown>) => {
    if (typeof options === 'string') return options;
    if (options && typeof options.defaultValue === 'string') {
      return options.defaultValue;
    }
    return key;
  };
  const translation = {
    t,
    i18n: { language: 'zh-CN', changeLanguage: () => Promise.resolve(), t },
  };
  return {
    useTranslation: () => translation,
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

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
  showGlobalNotification: mockShowGlobalNotification,
}));

vi.mock('@/components/ui/app-menu', () => ({
  AppSelect: ({ value }: { value: string }) => (
    <div data-testid="app-select-stub">{value}</div>
  ),
}));

// 轻量 Dialog 桩：验证「打开才渲染 + 确认才回调 + 变体正确」
vi.mock('@/components/ui/DsDialog', () => ({
  DsAlertDialog: ({
    open,
    title,
    description,
    confirmText,
    confirmVariant,
    onConfirm,
    children,
  }: any) =>
    open ? (
      <div role="alertdialog" data-confirm-variant={confirmVariant}>
        <div>{title}</div>
        <div>{description}</div>
        {children}
        <button type="button" onClick={onConfirm}>
          {confirmText}
        </button>
      </div>
    ) : null,
  DsDialog: ({ open, children }: any) =>
    open ? <div role="dialog">{children}</div> : null,
  DsDialogHeader: ({ children }: any) => <div>{children}</div>,
  DsDialogTitle: ({ children }: any) => <div>{children}</div>,
  DsDialogDescription: ({ children }: any) => <div>{children}</div>,
  DsDialogBody: ({ children }: any) => <div>{children}</div>,
  DsDialogFooter: ({ children }: any) => <div>{children}</div>,
}));

import { BackupTab } from '@/features/settings/components/data-governance/BackupTab';
import type { BackupInfoResponse } from '@/types/dataGovernance';

// ============================================================================
// 测试数据
// ============================================================================

const fullBackup: BackupInfoResponse = {
  path: '20260824_090000',
  created_at: '2026-08-24T09:00:00Z',
  size: 1024000,
  backup_type: 'full',
  recovery_kind: 'disaster_recovery',
  restorable: true,
  databases: ['vfs', 'mistakes'],
};

const partialArchive: BackupInfoResponse = {
  path: '20260824_100000',
  created_at: '2026-08-24T10:00:00Z',
  size: 2048,
  backup_type: 'full',
  recovery_kind: 'partial_archive',
  restorable: false,
  databases: ['mistakes'],
};

function makeProps(backups: BackupInfoResponse[] = [fullBackup]) {
  return {
    backups,
    loading: false,
    onRefresh: vi.fn(),
    onBackupAndExportZip: vi.fn(),
    onDeleteBackup: vi.fn(),
    onVerifyBackup: vi.fn(),
    onRestoreBackup: vi.fn(),
    onExportZip: vi.fn(),
    onImportZip: vi.fn(),
  };
}

const VALID_PASSWORD = 'correct horse battery';
const passwordInputLabel = 'data:governance.e2ee_password_label';

function clickDuplicatedBackupAction(name: string) {
  const buttons = screen.getAllByRole('button', { name });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[0]!);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// E2EE 诚实提示
// ============================================================================

describe('BackupTab E2EE 诚实提示', () => {
  it('未设密码：展示便携归档限制说明，不展示加密说明', () => {
    render(<BackupTab {...makeProps()} />);

    expect(
      screen.getByText(/不包含本地加密密钥|portable_zip_honest_note/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/敏感材料会被加密保护|e2ee_export_note/),
    ).not.toBeInTheDocument();
  });

  it('设置密码后：明确只有敏感材料受保护，业务归档仍为明文', () => {
    render(<BackupTab {...makeProps()} />);

    fireEvent.change(screen.getByLabelText(passwordInputLabel), {
      target: { value: VALID_PASSWORD },
    });

    expect(
      screen.getByText(/敏感材料会被加密保护|e2ee_export_note/),
    ).toBeInTheDocument();
    expect(screen.getByText(/归档内容本身未加密/)).toBeInTheDocument();
    expect(screen.getByText(/丢失密码后业务数据仍可读取/)).toBeInTheDocument();
    expect(screen.queryByText(/端到端加密/)).not.toBeInTheDocument();
    expect(screen.queryByText(/密码丢失将无法解密/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/不包含本地加密密钥|portable_zip_honest_note/),
    ).not.toBeInTheDocument();
  });
});

// ============================================================================
// 删除确认
// ============================================================================

describe('BackupTab 删除备份确认', () => {
  it('点击删除只打开 danger 确认框，确认后才回调', () => {
    const props = makeProps();
    render(<BackupTab {...props} />);

    clickDuplicatedBackupAction('common:actions.delete');
    expect(props.onDeleteBackup).not.toHaveBeenCalled();

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('data:governance.confirm_delete');
    expect(dialog).toHaveTextContent('data:governance.delete_warning');
    expect(dialog).toHaveAttribute('data-confirm-variant', 'danger');

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'common:actions.delete' }),
    );
    expect(props.onDeleteBackup).toHaveBeenCalledTimes(1);
    expect(props.onDeleteBackup).toHaveBeenCalledWith(fullBackup.path);
  });
});

// ============================================================================
// 恢复确认与部分归档阻止
// ============================================================================

describe('BackupTab 恢复备份确认', () => {
  it('完整备份：点击恢复先弹确认框（含覆盖警告），确认后才回调', () => {
    const props = makeProps();
    render(<BackupTab {...props} />);

    clickDuplicatedBackupAction('data:governance.restore');
    expect(props.onRestoreBackup).not.toHaveBeenCalled();

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('data:governance.confirm_restore');
    expect(dialog).toHaveTextContent('data:governance.restore_warning');

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'data:governance.restore' }),
    );
    expect(props.onRestoreBackup).toHaveBeenCalledTimes(1);
    expect(props.onRestoreBackup).toHaveBeenCalledWith(fullBackup.path);
  });

  it('部分归档（restorable=false）：阻止恢复并给出人话警告，不弹确认框', () => {
    const props = makeProps([partialArchive]);
    render(<BackupTab {...props} />);

    clickDuplicatedBackupAction('data:governance.restore');

    expect(mockShowGlobalNotification).toHaveBeenCalledWith(
      'warning',
      'data:governance.restore_non_full_not_supported',
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(props.onRestoreBackup).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 导出确认描述按加密状态切换
// ============================================================================

describe('BackupTab 单项导出确认', () => {
  it('未设密码：导出确认描述为普通 export_warning', () => {
    render(<BackupTab {...makeProps()} />);

    clickDuplicatedBackupAction('data:governance.export_zip');

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('data:governance.export_warning');
    expect(dialog).not.toHaveTextContent('data:governance.export_warning_encrypted');
  });

  it('设密码后：导出确认描述切换为 export_warning_encrypted', () => {
    render(<BackupTab {...makeProps()} />);

    fireEvent.change(screen.getByLabelText(passwordInputLabel), {
      target: { value: VALID_PASSWORD },
    });
    clickDuplicatedBackupAction('data:governance.export_zip');

    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'data:governance.export_warning_encrypted',
    );
  });
});
