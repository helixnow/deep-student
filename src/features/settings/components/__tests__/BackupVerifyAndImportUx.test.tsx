import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import zhData from '@/locales/zh-CN/data.json';
import enData from '@/locales/en-US/data.json';
import type { BackupInfoResponse } from '@/types/dataGovernance';

const mockNotify = vi.hoisted(() => vi.fn());
const mockLanguage = vi.hoisted(() => ({ current: 'en-US' }));
const mockForceFallback = vi.hoisted(() => ({ active: false }));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mockNotify,
}));

vi.mock('@/api/dataGovernance', async (orig) => {
  const actual = await orig<typeof import('@/api/dataGovernance')>();
  return {
    ...actual,
    getBackupConfig: vi.fn(async () => ({
      autoBackupEnabled: false,
      autoBackupIntervalHours: 24,
      maxBackupCount: 10,
    })),
    setBackupConfig: vi.fn(async () => undefined),
  };
});

function lookupLocale(
  obj: Record<string, unknown>,
  subKey: string,
): string | undefined {
  let cur: unknown = obj;
  for (const part of subKey.split('.')) {
    cur =
      cur && typeof cur === 'object'
        ? (cur as Record<string, unknown>)[part]
        : undefined;
  }
  return typeof cur === 'string' ? cur : undefined;
}

function mockT(key: string, opts?: string | Record<string, unknown>): string {
  if (typeof opts === 'string') return opts;
  if (!mockForceFallback.active && key.startsWith('data:')) {
    const dict = mockLanguage.current.startsWith('en') ? enData : zhData;
    const hit = lookupLocale(
      dict as unknown as Record<string, unknown>,
      key.slice('data:'.length),
    );
    if (hit) {
      if (!opts) return hit;
      return hit.replace(/\{\{(\w+)\}\}/g, (_m, k) =>
        opts[k] !== undefined ? String(opts[k]) : '',
      );
    }
  }
  if (opts && typeof opts.defaultValue === 'string') {
    return opts.defaultValue.replace(/\{\{(\w+)\}\}/g, (_m, k) =>
      opts[k] !== undefined ? String(opts[k]) : '',
    );
  }
  return key;
}

const mockI18n = {
  get language() {
    return mockLanguage.current;
  },
  changeLanguage: async (lng: string) => {
    mockLanguage.current = lng;
  },
};

vi.mock('react-i18next', async (orig) => {
  const actual = await orig<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({ t: mockT, i18n: mockI18n }),
  };
});

import {
  BackupTab,
  type BackupJobOperation,
} from '@/features/settings/components/data-governance/BackupTab';
import {
  BackupImportDialog,
  classifyBackupImportError,
  formatBackupImportError,
} from '@/features/settings/components/data-governance/BackupImportDialog';

const PRE_RESTORE_BACKUP: BackupInfoResponse = {
  path: '20261125_080000_pre_restore',
  created_at: '2026-11-25T08:00:00Z',
  size: 4096,
  backup_type: 'full',
  restorable: true,
  databases: ['vfs', 'chat_v2'],
};

function renderBackupTab(
  overrides: Partial<React.ComponentProps<typeof BackupTab>> = {},
) {
  return render(
    <BackupTab
      backups={[PRE_RESTORE_BACKUP]}
      loading={false}
      onCreateLocalBackup={vi.fn()}
      onBackupAndExportZip={vi.fn()}
      onDeleteBackup={vi.fn()}
      onVerifyBackup={vi.fn()}
      onRestoreBackup={vi.fn()}
      onExportZip={vi.fn()}
      onImportZip={vi.fn()}
      {...overrides}
    />,
  );
}

describe('BUG-10: BackupTab & BackupImportDialog UX regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLanguage.current = 'en-US';
    mockForceFallback.active = false;
    delete (globalThis as { __DS_WEBUI__?: boolean }).__DS_WEBUI__;
  });

  it('BackupTab pre-restore badge uses clean English defaultValue fallback and matches en-US / zh-CN locales', () => {
    // When locale lookup misses and falls back to defaultValue, no Chinese leaks
    mockForceFallback.active = true;
    const { unmount } = renderBackupTab();
    const badges = screen.getAllByText('[Pre-restore safety snapshot]');
    expect(badges.length).toBeGreaterThanOrEqual(1);
    for (const badge of badges) {
      expect(badge.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    }
    unmount();

    // en-US locale
    mockForceFallback.active = false;
    mockLanguage.current = 'en-US';
    const enView = renderBackupTab();
    expect(
      screen.getAllByText('[Pre-restore safety snapshot]').length,
    ).toBeGreaterThanOrEqual(1);
    enView.unmount();

    // zh-CN locale
    mockLanguage.current = 'zh-CN';
    renderBackupTab();
    expect(
      screen.getAllByText('[恢复前安全快照]').length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('BackupTab Export Backup button spins strictly for zip_export and never for backup/tiered_backup/restore/zip_import/null', () => {
    const nonExportOps: ReadonlyArray<BackupJobOperation | null | undefined> = [
      'backup',
      'tiered_backup',
      'restore',
      'zip_import',
      null,
      undefined,
    ];

    for (const op of nonExportOps) {
      const { unmount } = renderBackupTab({
        isBackupRunning: true,
        currentJobOperation: op,
      });
      const exportBtn = screen.getByRole('button', { name: 'Export Backup' });
      expect(exportBtn).toBeDisabled();
      expect(exportBtn.querySelector('.animate-spin')).toBeNull();

      const createBtn = screen.getByRole('button', {
        name: 'Create Restore Point',
      });
      if (op === 'backup') {
        expect(createBtn.querySelector('.animate-spin')).not.toBeNull();
      } else {
        expect(createBtn.querySelector('.animate-spin')).toBeNull();
      }
      unmount();
    }

    // Export job spins Export Backup button, NOT Create Restore Point button
    renderBackupTab({
      isBackupRunning: true,
      currentJobOperation: 'zip_export',
    });
    const exportBtn = screen.getByRole('button', { name: 'Export Backup' });
    const createBtn = screen.getByRole('button', {
      name: 'Create Restore Point',
    });
    expect(exportBtn.querySelector('.animate-spin')).not.toBeNull();
    expect(createBtn.querySelector('.animate-spin')).toBeNull();
  });

  it('classifies corrupt, truncated, path-traversal, invalid-manifest, and empty ZIP errors distinctly from decryption failures', () => {
    expect(
      classifyBackupImportError(
        '无法读取 ZIP 文件: ZIP error: Could not find central directory end',
      ),
    ).toBe('corrupt_or_truncated_zip');
    expect(
      classifyBackupImportError('ZIP 导入失败: Truncated raw deflate stream'),
    ).toBe('corrupt_or_truncated_zip');
    expect(
      classifyBackupImportError('ZIP 导入失败: IO error: Invalid checksum'),
    ).toBe('corrupt_or_truncated_zip');
    expect(
      classifyBackupImportError(
        'ZIP 导入失败: ZIP 条目实际大小与中央目录不一致: /tmp/a.db expected=100, actual=42',
      ),
    ).toBe('corrupt_or_truncated_zip');
    expect(
      classifyBackupImportError(
        'ZIP 导入失败: ZIP 包含越界或空路径: ../escape.db',
      ),
    ).toBe('path_traversal');
    expect(
      classifyBackupImportError('ZIP 导入失败: ZIP 包含不安全路径: a/../b'),
    ).toBe('path_traversal');
    expect(
      classifyBackupImportError(
        'ZIP 导入失败: 解析清单失败: version 必须是字符串',
      ),
    ).toBe('invalid_manifest');
    expect(classifyBackupImportError('ZIP 导入失败: 清单文件不存在')).toBe(
      'invalid_manifest',
    );
    expect(
      classifyBackupImportError(
        'ZIP 导入失败: ZIP 包含清单未声明的文件: extra.txt',
      ),
    ).toBe('invalid_manifest');
    expect(
      classifyBackupImportError(
        'ZIP 导入失败: [E_BACKUP_SEALED_DECRYPT_FAILED] 解封加密备份失败（备份密码错误或载荷损坏）: bad tag',
      ),
    ).toBe('decrypt_failed');
    expect(
      classifyBackupImportError(
        'ZIP 导入失败: [E_BACKUP_SEALED_PASSWORD_REQUIRED] 这是加密全保真备份 ZIP：请提供导出时设置的备份密码后重试导入',
      ),
    ).toBe('password_required');
    expect(classifyBackupImportError('')).toBe('generic');
    expect(classifyBackupImportError(undefined)).toBe('generic');

    // English formatting never leaks CJK and never mislabels as decryption failure
    for (const [raw, expectedCat, mustMatch] of [
      [
        '无法读取 ZIP 文件: ZIP error: Invalid zip header',
        'corrupt_or_truncated_zip',
        /corrupted or truncated/i,
      ],
      [
        'ZIP 导入失败: Truncated raw deflate stream',
        'corrupt_or_truncated_zip',
        /corrupted or truncated/i,
      ],
      [
        'ZIP 导入失败: ZIP 包含越界或空路径: ../evil.txt',
        'path_traversal',
        /path-traversal|unsafe/i,
      ],
      [
        'ZIP 导入失败: 解析清单失败: version 必须是字符串',
        'invalid_manifest',
        /manifest/i,
      ],
      ['', 'generic', /failed to import backup/i],
    ] as const) {
      const formatted = formatBackupImportError(raw, mockT, 'en-US');
      expect(formatted.category).toBe(expectedCat);
      expect(formatted.message).toMatch(mustMatch);
      expect(formatted.message).not.toMatch(/password|decrypt/i);
      expect(formatted.message).not.toMatch(/[\u4e00-\u9fff]/);
    }

    // Chinese formatting is localized cleanly and never mislabels as 密码错误
    mockLanguage.current = 'zh-CN';
    const zhCorrupt = formatBackupImportError(
      '无法读取 ZIP 文件: ZIP error: Could not find central directory end',
      mockT,
      'zh-CN',
    );
    expect(zhCorrupt.category).toBe('corrupt_or_truncated_zip');
    expect(zhCorrupt.message).toContain('损坏');
    expect(zhCorrupt.message).not.toContain('密码');

    const zhTraversal = formatBackupImportError(
      'ZIP 导入失败: ZIP 包含越界或空路径: ../evil.txt',
      mockT,
      'zh-CN',
    );
    expect(zhTraversal.category).toBe('path_traversal');
    expect(zhTraversal.message).toContain('目录遍历');
    expect(zhTraversal.message).not.toContain('密码');

    const zhManifest = formatBackupImportError(
      'ZIP 导入失败: 解析清单失败: version 必须是字符串',
      mockT,
      'zh-CN',
    );
    expect(zhManifest.category).toBe('invalid_manifest');
    expect(zhManifest.message).toContain('清单');
    expect(zhManifest.message).not.toContain('密码');

    const zhEmpty = formatBackupImportError(undefined, mockT, 'zh-CN');
    expect(zhEmpty.category).toBe('generic');
    expect(zhEmpty.message).toBe('导入备份失败');
    expect(zhEmpty.message).not.toContain('密码');
  });

  it('BackupImportDialog surfaces accurate classified alerts for corrupt, path-traversal, invalid-manifest, empty, and thrown errors', async () => {
    (globalThis as { __DS_WEBUI__?: boolean }).__DS_WEBUI__ = true;
    mockLanguage.current = 'en-US';

    const cases: Array<{
      name: string;
      handler: () => Promise<{ success: boolean; error?: string }>;
      expectedCategory: string;
      expectedPattern: RegExp;
      forbiddenPattern?: RegExp;
    }> = [
      {
        name: 'corrupt ZIP outcome',
        handler: async () => ({
          success: false,
          error:
            '无法读取 ZIP 文件: ZIP error: Could not find central directory end',
        }),
        expectedCategory: 'corrupt_or_truncated_zip',
        expectedPattern: /corrupted or truncated/i,
        forbiddenPattern: /password|decrypt/i,
      },
      {
        name: 'path-traversal ZIP outcome',
        handler: async () => ({
          success: false,
          error: 'ZIP 导入失败: ZIP 包含越界或空路径: ../etc/passwd',
        }),
        expectedCategory: 'path_traversal',
        expectedPattern: /path-traversal/i,
        forbiddenPattern: /password|decrypt/i,
      },
      {
        name: 'invalid manifest ZIP outcome',
        handler: async () => ({
          success: false,
          error: 'ZIP 导入失败: 解析清单失败: version 必须是字符串',
        }),
        expectedCategory: 'invalid_manifest',
        expectedPattern: /manifest/i,
        forbiddenPattern: /password|decrypt/i,
      },
      {
        name: 'empty outcome error does not default to decryption failed',
        handler: async () => ({ success: false }),
        expectedCategory: 'generic',
        expectedPattern: /failed to import backup/i,
        forbiddenPattern: /password|decrypt/i,
      },
      {
        name: 'thrown truncated ZIP error',
        handler: async () => {
          throw new Error('ZIP 导入失败: Truncated raw deflate stream');
        },
        expectedCategory: 'corrupt_or_truncated_zip',
        expectedPattern: /corrupted or truncated/i,
        forbiddenPattern: /password|decrypt/i,
      },
      {
        name: 'genuine decryption failure',
        handler: async () => ({
          success: false,
          error:
            'ZIP 导入失败: [E_BACKUP_SEALED_DECRYPT_FAILED] 解封加密备份失败（备份密码错误或载荷损坏）: AEAD tag mismatch',
        }),
        expectedCategory: 'decrypt_failed',
        expectedPattern: /incorrect backup password/i,
      },
    ];

    for (const testCase of cases) {
      const onImportZip = vi.fn(testCase.handler);
      const onOpenChange = vi.fn();
      const { unmount } = render(
        <BackupImportDialog
          open
          onOpenChange={onOpenChange}
          onImportZip={onImportZip}
        />,
      );

      const dialog = screen.getByRole('dialog');
      const pathInput = within(dialog).getByPlaceholderText(
        enData.governance.import_file_path_placeholder,
      );
      fireEvent.change(pathInput, { target: { value: '/tmp/test.zip' } });

      fireEvent.click(
        within(dialog).getByRole('button', {
          name: enData.governance.import_button,
        }),
      );

      await waitFor(() => {
        const alert = within(dialog).getByRole('alert');
        expect(alert).toHaveAttribute(
          'data-error-category',
          testCase.expectedCategory,
        );
        expect(alert.textContent).toMatch(testCase.expectedPattern);
        if (testCase.forbiddenPattern) {
          expect(alert.textContent).not.toMatch(testCase.forbiddenPattern);
        }
      });

      // Dialog stays open for correction and clears error when user edits path
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
      fireEvent.change(pathInput, { target: { value: '/tmp/other.zip' } });
      expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();

      unmount();
    }
  });
});
