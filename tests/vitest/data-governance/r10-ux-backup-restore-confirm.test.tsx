/**
 * BackupTab 确认框变体分级测试（R10-ux）
 *
 * 覆盖（与 r09-ux-backup-tab.test.tsx 的「确认后才回调」用例不重复）：
 * 恢复会用备份覆盖当前数据槽（重启后切换），确认框必须用 warning 变体，
 * 与云端恢复（CloudStorageSection）和库级冲突覆盖（SyncTab）的分级一致；
 * 删除保持 danger；导出不改动数据保持 primary。
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

function clickDuplicatedBackupAction(name: string) {
  const buttons = screen.getAllByRole('button', { name });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[0]!);
}

// ============================================================================
// Mocks（与 r09-ux-backup-tab.test.tsx 同构）
// ============================================================================

vi.mock('react-i18next', () => {
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

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/components/ui/app-menu', () => ({
  AppSelect: ({ value }: { value: string }) => (
    <div data-testid="app-select-stub">{value}</div>
  ),
}));

vi.mock('@/components/ui/DsDialog', () => ({
  DsAlertDialog: ({ open, title, confirmVariant }: any) =>
    open ? (
      <div role="alertdialog" data-confirm-variant={confirmVariant}>
        <div>{title}</div>
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

const fullBackup: BackupInfoResponse = {
  path: '20260824_090000',
  created_at: '2026-08-24T09:00:00Z',
  size: 1024000,
  backup_type: 'full',
  recovery_kind: 'disaster_recovery',
  restorable: true,
  databases: ['vfs', 'mistakes'],
};

function makeProps() {
  return {
    backups: [fullBackup],
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BackupTab 确认框变体分级', () => {
  it('恢复备份（覆盖当前数据槽）→ warning 确认框', () => {
    render(<BackupTab {...makeProps()} />);

    clickDuplicatedBackupAction('data:governance.restore');

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('data:governance.confirm_restore');
    expect(dialog).toHaveAttribute('data-confirm-variant', 'warning');
  });

  it('删除备份仍是 danger 确认框', () => {
    render(<BackupTab {...makeProps()} />);

    clickDuplicatedBackupAction('common:actions.delete');

    expect(screen.getByRole('alertdialog')).toHaveAttribute(
      'data-confirm-variant',
      'danger',
    );
  });

  it('导出 ZIP（不改动数据）仍是 primary 确认框', () => {
    render(<BackupTab {...makeProps()} />);

    clickDuplicatedBackupAction('data:governance.export_zip');

    expect(screen.getByRole('alertdialog')).toHaveAttribute(
      'data-confirm-variant',
      'primary',
    );
  });
});
