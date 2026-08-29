/**
 * BackupTab - ZIP E2EE 备份密码 UI 测试（R04-zip-password-ui）
 *
 * 覆盖场景：
 * 1. 导出完整换机包时输入 E2EE 密码 → onBackupAndExportZip 收到 encryptionPassword
 * 2. 密码留空 → encryptionPassword 为 undefined（未加密便携包）
 * 3. 密码过短（<8 字符）→ 阻止导出并提示警告
 * 4. 备份列表单项导出 → 确认后 onExportZip 透传密码
 * 5. 导入前弹出密码对话框 → 确认后 onImportZip 收到密码
 * 6. 导入密码留空 → onImportZip(undefined)
 * 7. 导入密码过短 → 阻止并提示警告
 * 8. 密封 ZIP 续传必须重新输入密码；便携 ZIP 不强制
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string | Record<string, unknown>) => {
      if (typeof defaultValue === 'string') return defaultValue;
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

import { BackupTab } from '@/features/settings/components/data-governance/BackupTab';
import type { BackupInfoResponse } from '@/types/dataGovernance';

// ============================================================================
// 默认 mock 数据
// ============================================================================

const sampleBackups: BackupInfoResponse[] = [
  {
    path: '20260207_120000',
    created_at: '2026-02-07T12:00:00Z',
    size: 1536000,
    backup_type: 'full',
    databases: ['vfs', 'chat_v2'],
  },
];

const VALID_PASSWORD = 'correct horse battery';

function makeProps() {
  return {
    backups: sampleBackups,
    loading: false,
    onRefresh: vi.fn(),
    onBackupAndExportZip: vi.fn(),
    onDeleteBackup: vi.fn(),
    onVerifyBackup: vi.fn(),
    onRestoreBackup: vi.fn(),
    onExportZip: vi.fn(),
    onImportZip: vi.fn(),
    onResumeJob: vi.fn(),
  };
}

const passwordInputLabel = 'data:governance.e2ee_password_label';
const exportButtonName = 'data:governance.export_backup';
const importButtonName = 'data:governance.import_button';

describe('BackupTab E2EE export password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes encryptionPassword to onBackupAndExportZip when a valid password is set', () => {
    const props = makeProps();
    render(<BackupTab {...props} />);

    fireEvent.change(screen.getByLabelText(passwordInputLabel), {
      target: { value: VALID_PASSWORD },
    });
    fireEvent.click(screen.getByRole('button', { name: exportButtonName }));

    expect(props.onBackupAndExportZip).toHaveBeenCalledTimes(1);
    expect(props.onBackupAndExportZip.mock.calls[0][0]).toMatchObject({
      encryptionPassword: VALID_PASSWORD,
    });
  });

  it('passes undefined encryptionPassword when password field is empty', () => {
    const props = makeProps();
    render(<BackupTab {...props} />);

    fireEvent.click(screen.getByRole('button', { name: exportButtonName }));

    expect(props.onBackupAndExportZip).toHaveBeenCalledTimes(1);
    expect(props.onBackupAndExportZip.mock.calls[0][0].encryptionPassword).toBeUndefined();
  });

  it('blocks export and warns when password is shorter than 8 characters', () => {
    const props = makeProps();
    render(<BackupTab {...props} />);

    fireEvent.change(screen.getByLabelText(passwordInputLabel), {
      target: { value: 'short' },
    });
    fireEvent.click(screen.getByRole('button', { name: exportButtonName }));

    expect(props.onBackupAndExportZip).not.toHaveBeenCalled();
    expect(mockShowGlobalNotification).toHaveBeenCalledWith(
      'warning',
      'data:governance.e2ee_password_too_short'
    );
  });

  it('blocks export when 4 emoji look like 8 UTF-16 units but are only 4 code points', () => {
    const props = makeProps();
    render(<BackupTab {...props} />);

    fireEvent.change(screen.getByLabelText(passwordInputLabel), {
      target: { value: '😀😀😀😀' },
    });
    fireEvent.click(screen.getByRole('button', { name: exportButtonName }));

    expect(props.onBackupAndExportZip).not.toHaveBeenCalled();
    expect(mockShowGlobalNotification).toHaveBeenCalledWith(
      'warning',
      'data:governance.e2ee_password_too_short'
    );
  });

  it('blocks per-backup export when the password is too short', async () => {
    const props = makeProps();
    render(<BackupTab {...props} />);

    fireEvent.change(screen.getByLabelText(passwordInputLabel), {
      target: { value: 'short' },
    });
    fireEvent.click(
      screen.getAllByRole('button', { name: 'data:governance.export_zip' })[0]
    );
    fireEvent.click(screen.getByRole('button', { name: 'data:governance.export' }));

    await waitFor(() => {
      expect(props.onExportZip).not.toHaveBeenCalled();
    });
    expect(mockShowGlobalNotification).toHaveBeenCalledWith(
      'warning',
      'data:governance.e2ee_password_too_short'
    );
  });

  it('blocks export when password is only whitespace', () => {
    const props = makeProps();
    render(<BackupTab {...props} />);

    fireEvent.change(screen.getByLabelText(passwordInputLabel), {
      target: { value: '        ' },
    });
    fireEvent.click(screen.getByRole('button', { name: exportButtonName }));

    expect(props.onBackupAndExportZip).not.toHaveBeenCalled();
  });

  it('passes encryptionPassword to onExportZip for per-backup export after confirmation', async () => {
    const props = makeProps();
    render(<BackupTab {...props} />);

    fireEvent.change(screen.getByLabelText(passwordInputLabel), {
      target: { value: VALID_PASSWORD },
    });

    // 打开单个备份的导出确认对话框
    fireEvent.click(
      screen.getAllByRole('button', { name: 'data:governance.export_zip' })[0]
    );

    // 加密导出时应展示加密确认文案（危险操作确认）
    expect(
      screen.getByText('data:governance.export_warning_encrypted')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'data:governance.export' }));

    await waitFor(() => {
      expect(props.onExportZip).toHaveBeenCalledWith(
        '20260207_120000',
        6,
        VALID_PASSWORD
      );
    });
  });
});

describe('BackupTab ZIP import password dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the password dialog instead of importing immediately', () => {
    const props = makeProps();
    render(<BackupTab {...props} />);

    fireEvent.click(screen.getByRole('button', { name: importButtonName }));

    expect(props.onImportZip).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByText('data:governance.import_password_title')
    ).toBeInTheDocument();
  });

  it('passes the entered password to onImportZip on confirm', () => {
    const props = makeProps();
    render(<BackupTab {...props} />);

    fireEvent.click(screen.getByRole('button', { name: importButtonName }));

    const dialog = screen.getByRole('dialog');
    fireEvent.change(
      within(dialog).getByLabelText('data:governance.import_password_label'),
      { target: { value: VALID_PASSWORD } }
    );
    fireEvent.click(within(dialog).getByRole('button', { name: importButtonName }));

    expect(props.onImportZip).toHaveBeenCalledTimes(1);
    expect(props.onImportZip).toHaveBeenCalledWith(VALID_PASSWORD);
  });

  it('passes undefined when the import password is left empty (unencrypted package)', () => {
    const props = makeProps();
    render(<BackupTab {...props} />);

    fireEvent.click(screen.getByRole('button', { name: importButtonName }));

    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: importButtonName }));

    expect(props.onImportZip).toHaveBeenCalledTimes(1);
    expect(props.onImportZip).toHaveBeenCalledWith(undefined);
  });

  it('passes legacy short passwords through on import (decrypt path is not length-gated)', () => {
    // v0.9.44 备份密码没有 8 字符下限：换机/重装必须能用存量短口令解开旧密文。
    // 口令错误由后端解封层 fail-closed，前端不做最小长度门禁。
    const props = makeProps();
    render(<BackupTab {...props} />);

    fireEvent.click(screen.getByRole('button', { name: importButtonName }));

    const dialog = screen.getByRole('dialog');
    fireEvent.change(
      within(dialog).getByLabelText('data:governance.import_password_label'),
      { target: { value: 'short' } }
    );
    fireEvent.click(within(dialog).getByRole('button', { name: importButtonName }));

    expect(props.onImportZip).toHaveBeenCalledTimes(1);
    expect(props.onImportZip).toHaveBeenCalledWith('short');
    expect(mockShowGlobalNotification).not.toHaveBeenCalledWith(
      'warning',
      'data:governance.e2ee_password_too_short'
    );
  });

  it('cancelling the dialog does not import', () => {
    const props = makeProps();
    render(<BackupTab {...props} />);

    fireEvent.click(screen.getByRole('button', { name: importButtonName }));

    const dialog = screen.getByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'common:actions.cancel' })
    );

    expect(props.onImportZip).not.toHaveBeenCalled();
  });
});

describe('BackupTab resumable ZIP password contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires and passes a password when resuming an import with sealed sensitive material', () => {
    const props = makeProps();
    render(
      <BackupTab
        {...props}
        resumableJobs={[{
          job_id: 'sealed-import-job',
          kind: 'import',
          phase: 'extract',
          progress: 40,
          created_at: '2026-08-24T12:00:00Z',
          requires_password: true,
        }]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'data:governance.resume' }));

    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText('data:governance.resume_import_password_title')
    ).toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'data:governance.resume' })
    );
    expect(props.onResumeJob).not.toHaveBeenCalled();
    expect(mockShowGlobalNotification).toHaveBeenCalledWith(
      'warning',
      'data:governance.import_sealed_password_required'
    );

    fireEvent.change(
      within(dialog).getByLabelText('data:governance.import_password_label'),
      { target: { value: VALID_PASSWORD } }
    );
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'data:governance.resume' })
    );

    expect(props.onResumeJob).toHaveBeenCalledWith(
      'sealed-import-job',
      VALID_PASSWORD
    );
  });

  it('resumes a portable import immediately without forcing a password dialog', () => {
    const props = makeProps();
    render(
      <BackupTab
        {...props}
        resumableJobs={[{
          job_id: 'portable-import-job',
          kind: 'import',
          phase: 'extract',
          progress: 40,
          created_at: '2026-08-24T12:00:00Z',
          requires_password: false,
        }]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'data:governance.resume' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(props.onResumeJob).toHaveBeenCalledWith('portable-import-job');
  });
});
