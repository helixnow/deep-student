/**
 * 启动组件健康 `reason` 的结构化解析。
 *
 * 后端（Rust `coordinator.rs` / `lib.rs`、Host `host/platform/storage/migration/*`、`service.ts`）只给出拼好的
 * 英文或中文句子，没有错误码；这里按它们的固定句式拆出数据库名、底层错误、恢复结果等字段。底层错误原文不翻译。
 * 认不出的句式返回 `unknown`，调用方原样显示。
 */

export type ComponentRecovery =
  | { kind: 'restored'; snapshot: string | null }
  | { kind: 'removed'; snapshot: string }
  | { kind: 'kept'; path: string; olderSnapshot: string | null }
  | { kind: 'restore_failed'; error: string };

export type ComponentReadStep = 'schema_aggregation' | 'schema_version' | 'migration_history';

export type ComponentStartupStep = 'recovered_old_schema' | 'unsafe_state' | 'chat_v2_init' | 'llm_usage_init' | 'audit_init';

export type ParsedComponentReason =
  | { kind: 'dependency_blocked'; dependency: string }
  | { kind: 'dependency_restore_failed'; dependency: string }
  | { kind: 'migration_failed'; database: string; error: string; recovery: ComponentRecovery | null }
  | { kind: 'remains_blocked'; database: string; migrationError: string; restoreError: string }
  | { kind: 'read_failed'; step: ComponentReadStep; error: string }
  | { kind: 'startup'; step: ComponentStartupStep; error: string }
  | { kind: 'unknown'; text: string };

const DEPENDENCY_BLOCKED = /^Skipped because dependency '?([^'\s]+?)'? is blocked\.?$/;
const DEPENDENCY_RESTORE_FAILED = /^Skipped because dependency '([^']+)' has an unresolved restore failure\.?$/;
const MIGRATION_FAILED = /^Database '([^']+)' migration failed: ([\s\S]*)$/;
const REMAINS_BLOCKED =
  /^Database '([^']+)' remains blocked: migration failed \(([\s\S]*?)\); restoring the trusted startup snapshot failed again \(([\s\S]*)\)$/;

const RESTORE_FAILED = /^([\s\S]*?)\. Restoring this database also failed: ([\s\S]*)$/;
const RESTORED = /^([\s\S]*)\. Restored this database from the startup snapshot(?: (\S+))?\.$/;
const REMOVED =
  /^([\s\S]*)\. The startup snapshot (\S+) shows this database did not exist before the migration; removed the file created by the failed migration\.$/;
const KEPT =
  /^([\s\S]*)\. No snapshot was taken before this migration run, so nothing was restored; the database file was kept in place at ([\s\S]+) \(not deleted or overwritten\)\. (?:No earlier snapshot contains this database\.|The newest earlier snapshot containing it, (\S+), was not applied automatically\.)$/;

const READ_STEPS: ReadonlyArray<[string, ComponentReadStep]> = [
  ['Schema aggregation failed: ', 'schema_aggregation'],
  ['Schema version read failed: ', 'schema_version'],
  ['Migration history read failed: ', 'migration_history'],
];

const STARTUP_STEPS: ReadonlyArray<[string, ComponentStartupStep]> = [
  ['迁移失败后已恢复旧版数据结构: ', 'recovered_old_schema'],
  ['启动迁移无法建立安全状态: ', 'unsafe_state'],
  ['Chat V2 数据库初始化失败: ', 'chat_v2_init'],
  ['LLM Usage 数据库初始化失败: ', 'llm_usage_init'],
  ['审计日志初始化失败: ', 'audit_init'],
];

function parseMigrationFailure(database: string, rest: string): ParsedComponentReason {
  let m = RESTORE_FAILED.exec(rest);
  if (m) return { kind: 'migration_failed', database, error: m[1], recovery: { kind: 'restore_failed', error: m[2] } };
  m = RESTORED.exec(rest);
  if (m) return { kind: 'migration_failed', database, error: m[1], recovery: { kind: 'restored', snapshot: m[2] ?? null } };
  m = REMOVED.exec(rest);
  if (m) return { kind: 'migration_failed', database, error: m[1], recovery: { kind: 'removed', snapshot: m[2] } };
  m = KEPT.exec(rest);
  if (m) {
    return { kind: 'migration_failed', database, error: m[1], recovery: { kind: 'kept', path: m[2], olderSnapshot: m[3] ?? null } };
  }
  return { kind: 'migration_failed', database, error: rest, recovery: null };
}

export function parseComponentReason(reason: string): ParsedComponentReason {
  let m = DEPENDENCY_BLOCKED.exec(reason);
  if (m) return { kind: 'dependency_blocked', dependency: m[1] };
  m = DEPENDENCY_RESTORE_FAILED.exec(reason);
  if (m) return { kind: 'dependency_restore_failed', dependency: m[1] };
  m = REMAINS_BLOCKED.exec(reason);
  if (m) return { kind: 'remains_blocked', database: m[1], migrationError: m[2], restoreError: m[3] };
  m = MIGRATION_FAILED.exec(reason);
  if (m) return parseMigrationFailure(m[1], m[2]);
  for (const [prefix, step] of READ_STEPS) {
    if (reason.startsWith(prefix)) return { kind: 'read_failed', step, error: reason.slice(prefix.length) };
  }
  for (const [prefix, step] of STARTUP_STEPS) {
    if (reason.startsWith(prefix)) return { kind: 'startup', step, error: reason.slice(prefix.length) };
  }
  return { kind: 'unknown', text: reason };
}
