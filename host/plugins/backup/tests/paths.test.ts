import { expect, it } from 'vitest';
import {
  backupDir, checkedRestoreDiskBudget, inferDatabaseFromTable, resolveTargetAndPending,
  validateBackupId,
} from '../src/paths.ts';
import { latestVersion, pendingCount } from '../src/migrations.ts';

it('validate_backup_id_allows_safe_id', () => {
  expect(validateBackupId('backup-20260206_120000')).toBe('backup-20260206_120000');
  expect(validateBackupId('  backup-1  ')).toBe('backup-1');
});

it('validate_backup_id_rejects_parent_traversal', () => {
  expect(() => validateBackupId('../escape')).toThrow('backup_id 包含非法路径片段');
  expect(() => validateBackupId('safe/../../escape')).toThrow('backup_id 包含非法路径片段');
});

it('validate_backup_id_rejects_absolute_path', () => {
  expect(() => validateBackupId('/tmp/escape')).toThrow('backup_id 包含非法路径片段');
  expect(() => validateBackupId('\\tmp\\escape')).toThrow('backup_id 包含非法路径片段');
});

it('validate_backup_id_rejects_encoded_bypass', () => {
  expect(() => validateBackupId('%2e%2e%2fescape')).toThrow('backup_id 不允许包含 URL 编码');
  expect(() => validateBackupId('%2Ftmp%2Fescape')).toThrow('backup_id 不允许包含 URL 编码');
});

it('validate_backup_id_rejects_empty_dot_and_illegal_characters', () => {
  expect(() => validateBackupId('   ')).toThrow('backup_id 不能为空');
  expect(() => validateBackupId('.hidden')).toThrow('backup_id 包含非法路径片段');
  expect(() => validateBackupId('backup id')).toThrow('backup_id 包含非法字符');
  expect(() => validateBackupId('a'.repeat(129))).toThrow('backup_id 长度超限（最大 128）');
});

it('restore_disk_budget_uses_checked_arithmetic', () => {
  expect(checkedRestoreDiskBudget([10, 20], 5)).toEqual({ backupSize: 35n, requiredBytes: 70n });
  expect(() => checkedRestoreDiskBudget([(1n << 64n) - 1n], 1n)).toThrow(
    '[E_RESTORE_DISK_BUDGET_OVERFLOW] 恢复备份总大小统计溢出，已拒绝继续',
  );
  expect(() => checkedRestoreDiskBudget([(1n << 64n) / 2n + 1n], 0)).toThrow(
    '[E_RESTORE_DISK_BUDGET_OVERFLOW] 恢复磁盘预算计算溢出，已拒绝继续',
  );
});

it('governance_backup_directory_is_outside_slots', () => {
  expect(backupDir('/tmp/deep-student')).toBe('/tmp/deep-student/recovery/backups');
  expect(backupDir('/tmp/deep-student/slots/slotA')).toBe('/tmp/deep-student/recovery/backups');
  expect(backupDir('/tmp/deep-student/slots/slotB')).toBe('/tmp/deep-student/recovery/backups');
});

it('resolve_target_and_pending_uses_migration_set_when_status_missing', () => {
  const result = resolveTargetAndPending('mistakes', 20260130, undefined);
  expect(result.targetVersion).toBe(latestVersion('mistakes'));
  expect(result.pendingCount).toBe(pendingCount('mistakes', 20260130));
  expect(result.pendingCount).toBe(22);
});

it('resolve_target_and_pending_returns_zero_when_latest_reached', () => {
  const latest = latestVersion('mistakes');
  expect(resolveTargetAndPending('mistakes', latest, undefined)).toEqual({
    targetVersion: latest, pendingCount: 0,
  });
});

it('resolve_target_and_pending_prefers_status_target_version', () => {
  const expectedPending = pendingCount('mistakes', 20260130);
  expect(resolveTargetAndPending('mistakes', 20260130, { max_compatible_version: 20260299 })).toEqual({
    targetVersion: 20260299, pendingCount: expectedPending,
  });
});

it('test_infer_database_chat_v2_prefix', () => {
  expect(inferDatabaseFromTable('chat_v2_sessions')).toBe('chat_v2');
  expect(inferDatabaseFromTable('chat_v2_messages')).toBe('chat_v2');
  expect(inferDatabaseFromTable('chat_v2_blocks')).toBe('chat_v2');
});

it('test_infer_database_chat_v2_known_tables', () => {
  expect(inferDatabaseFromTable('workspace_index')).toBe('chat_v2');
  expect(inferDatabaseFromTable('sleep_block')).toBe('chat_v2');
  expect(inferDatabaseFromTable('subagent_task')).toBe('chat_v2');
});

it('test_infer_database_resources_ambiguous_returns_none', () => {
  expect(inferDatabaseFromTable('resources')).toBeNull();
});

it('test_infer_database_mistakes', () => {
  for (const table of ['mistakes', 'anki_cards', 'document_tasks', 'settings', 'review_analyses', 'exam_sheet_sessions']) {
    expect(inferDatabaseFromTable(table)).toBe('mistakes');
  }
});

it('test_infer_database_vfs', () => {
  for (const table of ['notes', 'files', 'folders', 'blobs', 'questions', 'mindmaps', 'essays']) {
    expect(inferDatabaseFromTable(table)).toBe('vfs');
  }
});

it('test_infer_database_llm_usage', () => {
  expect(inferDatabaseFromTable('llm_usage_logs')).toBe('llm_usage');
  expect(inferDatabaseFromTable('llm_usage_daily')).toBe('llm_usage');
});

it('test_infer_database_unknown_returns_none', () => {
  expect(inferDatabaseFromTable('unknown_table_xyz')).toBeNull();
  expect(inferDatabaseFromTable('__change_log')).toBeNull();
});

it('test_infer_database_no_cross_routing', () => {
  expect(inferDatabaseFromTable('anki_cards')).not.toBe('chat_v2');
  expect(inferDatabaseFromTable('notes')).not.toBe('mistakes');
});
