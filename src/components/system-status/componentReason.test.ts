import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseComponentReason } from './componentReason';

const ROOT = path.resolve(__dirname, '../../..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const VFS_ERROR = 'Database error: file is not a database';
const VFS_PATH = '/Users/x/Library/Application Support/deep-student/slots/slotA/databases/vfs.db';

describe('parseComponentReason', () => {
  it('reads dependency skips (Rust/Host wording and the debug preview wording)', () => {
    expect(parseComponentReason("Skipped because dependency 'vfs' is blocked")).toEqual({ kind: 'dependency_blocked', dependency: 'vfs' });
    expect(parseComponentReason('Skipped because dependency vfs is blocked.')).toEqual({ kind: 'dependency_blocked', dependency: 'vfs' });
    expect(parseComponentReason("Skipped because dependency 'vfs' has an unresolved restore failure")).toEqual({
      kind: 'dependency_restore_failed',
      dependency: 'vfs',
    });
  });

  it('reads the Rust single-database failure sentences', () => {
    expect(parseComponentReason(`Database 'vfs' migration failed: ${VFS_ERROR}. Restored this database from the startup snapshot.`)).toEqual({
      kind: 'migration_failed',
      database: 'vfs',
      error: VFS_ERROR,
      recovery: { kind: 'restored', snapshot: null },
    });
    expect(
      parseComponentReason(`Database 'chat_v2' migration failed: Migration error: v3 failed. Restoring this database also failed: IO error: disk full. Retry later.`),
    ).toEqual({
      kind: 'migration_failed',
      database: 'chat_v2',
      error: 'Migration error: v3 failed',
      recovery: { kind: 'restore_failed', error: 'IO error: disk full. Retry later.' },
    });
    expect(
      parseComponentReason(
        "Database 'vfs' remains blocked: migration failed (Database error: x (y)); restoring the trusted startup snapshot failed again (IO error: denied)",
      ),
    ).toEqual({ kind: 'remains_blocked', database: 'vfs', migrationError: 'Database error: x (y)', restoreError: 'IO error: denied' });
  });

  it('reads the Host restore outcomes (RF-W20-restore-stale-snapshot-deletes-db wording)', () => {
    expect(
      parseComponentReason(
        `Database 'vfs' migration failed: ${VFS_ERROR}. Restored this database from the startup snapshot migration_core_backups/startup_20261107T010203.`,
      ),
    ).toMatchObject({ recovery: { kind: 'restored', snapshot: 'migration_core_backups/startup_20261107T010203' } });
    expect(
      parseComponentReason(
        `Database 'vfs' migration failed: ${VFS_ERROR}. The startup snapshot migration_core_backups/startup_1 shows this database did not exist before the migration; removed the file created by the failed migration.`,
      ),
    ).toMatchObject({ error: VFS_ERROR, recovery: { kind: 'removed', snapshot: 'migration_core_backups/startup_1' } });
    expect(
      parseComponentReason(
        `Database 'vfs' migration failed: ${VFS_ERROR}. No snapshot was taken before this migration run, so nothing was restored; the database file was kept in place at ${VFS_PATH} (not deleted or overwritten). No earlier snapshot contains this database.`,
      ),
    ).toEqual({ kind: 'migration_failed', database: 'vfs', error: VFS_ERROR, recovery: { kind: 'kept', path: VFS_PATH, olderSnapshot: null } });
    expect(
      parseComponentReason(
        `Database 'vfs' migration failed: ${VFS_ERROR}. No snapshot was taken before this migration run, so nothing was restored; the database file was kept in place at ${VFS_PATH} (not deleted or overwritten). The newest earlier snapshot containing it, migration_core_backups/startup_0, was not applied automatically.`,
      ),
    ).toMatchObject({ recovery: { kind: 'kept', path: VFS_PATH, olderSnapshot: 'migration_core_backups/startup_0' } });
  });

  it('reads schema read failures and the startup-level Chinese reasons', () => {
    expect(parseComponentReason('Schema aggregation failed: Database error: vfs: boom')).toEqual({
      kind: 'read_failed',
      step: 'schema_aggregation',
      error: 'Database error: vfs: boom',
    });
    expect(parseComponentReason('Schema version read failed: x')).toMatchObject({ step: 'schema_version' });
    expect(parseComponentReason('Migration history read failed: x')).toMatchObject({ step: 'migration_history' });
    expect(parseComponentReason('启动迁移无法建立安全状态: Migration error: boom')).toEqual({
      kind: 'startup',
      step: 'unsafe_state',
      error: 'Migration error: boom',
    });
    expect(parseComponentReason('迁移失败后已恢复旧版数据结构: e')).toMatchObject({ step: 'recovered_old_schema' });
    expect(parseComponentReason('Chat V2 数据库初始化失败: e')).toMatchObject({ step: 'chat_v2_init' });
    expect(parseComponentReason('LLM Usage 数据库初始化失败: e')).toMatchObject({ step: 'llm_usage_init' });
    expect(parseComponentReason('审计日志初始化失败: e')).toMatchObject({ step: 'audit_init' });
  });

  it('keeps unknown sentences and unrecognised restore tails verbatim', () => {
    expect(parseComponentReason('VFS schema migration failed.')).toEqual({ kind: 'unknown', text: 'VFS schema migration failed.' });
    expect(parseComponentReason("Database 'vfs' migration failed: boom. Something new.")).toEqual({
      kind: 'migration_failed',
      database: 'vfs',
      error: 'boom. Something new.',
      recovery: null,
    });
  });

  it('every sentence it parses is still produced by the Host sources', () => {
    const host =
      read('host/platform/storage/migration/coordinator.ts') +
      read('host/platform/storage/migration/backup.ts') +
      read('host/platform/storage/migration/schema-registry.ts') +
      read('host/platform/storage/service.ts');
    for (const phrase of [
      "Skipped because dependency '${dependency}' is blocked",
      "Skipped because dependency '${dependency}' has an unresolved restore failure",
      "Database '${id}' migration failed: ${errorText(error)}. ${describeSingleRestore(outcome)}",
      "Database '${id}' migration failed: ${errorText(error)}. Restoring this database also failed: ${errorText(restoreError)}",
      "Database '${database}' remains blocked: migration failed (${failure.migration_error}); restoring the trusted startup snapshot failed again (${failure.restore_error})",
      'Restored this database from the startup snapshot ${CORE_BACKUP_ROOT_DIR_NAME}/${outcome.snapshot}.',
      'The startup snapshot ${CORE_BACKUP_ROOT_DIR_NAME}/${outcome.snapshot} shows this database did not exist before the migration; removed the file created by the failed migration.',
      'No snapshot was taken before this migration run, so nothing was restored; the database file was kept in place at ${outcome.path} (not deleted or overwritten). ',
      "'No earlier snapshot contains this database.'",
      'The newest earlier snapshot containing it, ${CORE_BACKUP_ROOT_DIR_NAME}/${outcome.olderSnapshot}, was not applied automatically.',
      "fail('Schema aggregation failed'",
      "fail('Schema version read failed'",
      "fail('Migration history read failed'",
      '迁移失败后已恢复旧版数据结构: ${failure.error}',
      '启动迁移无法建立安全状态: ${failure.error}',
    ]) {
      expect(host, phrase).toContain(phrase);
    }
  });
});
