import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import zhData from '@/locales/zh-CN/data.json';
import type { StartupComponentIssue } from '@/stores/systemStatusStore';

vi.mock('@/utils/platform', () => ({ isMobilePlatform: () => false }));
vi.mock('@/components/WindowControls', () => ({ WindowControls: () => null }));
vi.mock('../dataRecoveryApi', () => ({
  exportStartupRecoveryReport: vi.fn(async () => null),
  retryRecoveryStartup: vi.fn(),
}));

import { ComponentRecoveryShell } from '../ComponentRecoveryShell';
import { describeComponentRecovery } from '../recoveryDescription';

const ID = 'RF-W09-recovery-description-by-outcome';
const ERR = 'Database error: file is not a database';
const KEPT = `Database 'vfs' migration failed: ${ERR}. No snapshot was taken before this migration run, so nothing was restored; the database file was kept in place at /d/vfs.db (not deleted or overwritten). No earlier snapshot contains this database.`;
const RESTORED_HOST = `Database 'vfs' migration failed: ${ERR}. Restored this database from the startup snapshot migration_core_backups/startup_1.`;
const RESTORED_RUST = `Database 'vfs' migration failed: ${ERR}. Restored this database from the startup snapshot.`;
const REMOVED = `Database 'vfs' migration failed: ${ERR}. The startup snapshot migration_core_backups/startup_1 shows this database did not exist before the migration; removed the file created by the failed migration.`;
const RESTORE_FAILED = `Database 'vfs' migration failed: ${ERR}. Restoring this database also failed: IO error: denied`;
const DEP = "Skipped because dependency 'vfs' is blocked";

const issue = (component: string, reason: string | null, status: StartupComponentIssue['status'] = 'blocked'): StartupComponentIssue => ({
  component,
  status,
  reason,
  dependency: null,
});
const withDependents = (vfsReason: string | null) => [
  issue('vfs', vfsReason),
  issue('mistakes', DEP),
  issue('chat_v2', DEP),
  issue('llm_usage', null, 'healthy'),
];

describe('describeComponentRecovery', () => {
  it(`${ID}: picks the sentence only when every affected component agrees`, () => {
    expect(describeComponentRecovery(withDependents(KEPT))).toBe('kept');
    expect(describeComponentRecovery(withDependents(RESTORED_HOST))).toBe('restored');
    expect(describeComponentRecovery(withDependents(RESTORED_RUST))).toBe('restored');
    expect(describeComponentRecovery(withDependents(REMOVED))).toBe('removed');
    expect(describeComponentRecovery(withDependents(RESTORE_FAILED))).toBe('restore_failed');
    expect(describeComponentRecovery([issue('vfs', KEPT), issue('chat_v2', RESTORED_HOST)])).toBe('mixed');
  });

  it(`${ID}: unknown or missing reasons never claim the files were left in place`, () => {
    expect(describeComponentRecovery(withDependents(null))).toBe('mixed');
    expect(describeComponentRecovery(withDependents('VFS schema migration failed.'))).toBe('mixed');
    expect(describeComponentRecovery(withDependents(`Database 'vfs' migration failed: ${ERR}`))).toBe('mixed');
    expect(describeComponentRecovery([issue('vfs', '启动迁移无法建立安全状态: boom')])).toBe('mixed');
    expect(describeComponentRecovery([issue('vfs', KEPT), issue('chat_v2', 'something else')])).toBe('mixed');
  });

  it(`${ID}: Host retry/read failures and the Rust global recovery map to what happened to the file`, () => {
    expect(
      describeComponentRecovery([
        issue(
          'vfs',
          "Database 'vfs' remains blocked: migration failed (x); restoring the trusted startup snapshot failed again (Database error: No trusted snapshot is recorded for this failure; the database file was kept in place at /d/vfs.db (not deleted or overwritten))",
        ),
      ]),
    ).toBe('kept');
    expect(
      describeComponentRecovery([issue('vfs', "Database 'vfs' remains blocked: migration failed (x); restoring the trusted startup snapshot failed again (IO error: denied)")]),
    ).toBe('restore_failed');
    expect(describeComponentRecovery([issue('vfs', 'Schema aggregation failed: boom')])).toBe('kept');
    expect(describeComponentRecovery([issue('vfs', '迁移失败后已恢复旧版数据结构: boom'), issue('audit', '审计日志初始化失败: x', 'degraded')])).toBe(
      'restored',
    );
    expect(describeComponentRecovery([issue('mistakes', DEP)])).toBe('kept');
  });
});

describe('ComponentRecoveryShell description', () => {
  const description = (components: StartupComponentIssue[]) => {
    render(<ComponentRecoveryShell components={components} />);
    return screen.getByRole('heading', { level: 1 }).nextElementSibling?.textContent;
  };

  it(`${ID}: keeps the original sentence when the database file was left untouched (W12 smoke ⑪)`, () => {
    expect(description(withDependents(KEPT))).toBe(zhData.recovery.component_recovery_description);
    expect(zhData.recovery.component_recovery_description).toContain('数据文件仍在原位置，没有被当作空数据覆盖');
  });

  it(`${ID}: no longer says the files are in place after a restore, a removal or a failed restore`, () => {
    const cases: Array<[string, string]> = [
      [RESTORED_HOST, zhData.recovery.component_recovery_description_restored],
      [REMOVED, zhData.recovery.component_recovery_description_removed],
      [RESTORE_FAILED, zhData.recovery.component_recovery_description_restore_failed],
      ['VFS schema migration failed.', zhData.recovery.component_recovery_description_mixed],
    ];
    for (const [reason, expected] of cases) {
      const { unmount } = render(<ComponentRecoveryShell components={withDependents(reason)} />);
      const text = screen.getByRole('heading', { level: 1 }).nextElementSibling?.textContent;
      expect(text, reason).toBe(expected);
      expect(text, reason).not.toContain('数据文件仍在原位置，没有被当作空数据覆盖');
      unmount();
    }
  });
});
