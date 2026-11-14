/**
 * settings 表仓储（F4 自有；Rust `dstu-storage/src/database/mod.rs` `Database::*_setting`）。
 * 只接收调用方传入的 `SqlExecutor`，因此同时服务普通连接与 D1 `*WithConn` 事务连接。
 */
import type { SqlExecutor } from '../../storage/api.ts';
import type { SettingRow } from '../api.ts';

// boundary-allow sql-outside-repository: settings 表是 F4 平台服务自有的仓储（Rust Database::*_setting），只经 ctx.storage 执行
const SAVE_SQL = `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET
               value = excluded.value,
               updated_at = excluded.updated_at
             WHERE settings.value IS NOT excluded.value`;
// boundary-allow sql-outside-repository: settings 表是 F4 平台服务自有的仓储（Rust Database::*_setting），只经 ctx.storage 执行
const GET_SQL = 'SELECT value FROM settings WHERE key = ?1';
// boundary-allow sql-outside-repository: settings 表是 F4 平台服务自有的仓储（Rust Database::*_setting），只经 ctx.storage 执行
const DELETE_SQL = 'DELETE FROM settings WHERE key = ?1';
// boundary-allow sql-outside-repository: settings 表是 F4 平台服务自有的仓储（Rust Database::*_setting），只经 ctx.storage 执行
const BY_PREFIX_SQL = 'SELECT key, value, updated_at FROM settings WHERE key LIKE ?1 ORDER BY updated_at DESC';
// boundary-allow sql-outside-repository: settings 表是 F4 平台服务自有的仓储（Rust Database::*_setting），只经 ctx.storage 执行
const DELETE_BY_PREFIX_SQL = 'DELETE FROM settings WHERE key LIKE ?1';

export function saveSettingRow(exec: SqlExecutor, key: string, value: string, updatedAt: string): void {
  exec.run(SAVE_SQL, [key, value, updatedAt]);
}

export function getSettingRow(exec: SqlExecutor, key: string): string | null {
  const v = exec.pluck<string>(GET_SQL, [key]);
  return v === undefined ? null : v;
}

export function deleteSettingRow(exec: SqlExecutor, key: string): boolean {
  return exec.run(DELETE_SQL, [key]).changes > 0;
}

export function listSettingRowsByPrefix(exec: SqlExecutor, prefix: string): SettingRow[] {
  return exec
    .all<{ key: string; value: string; updated_at: string }>(BY_PREFIX_SQL, [`${prefix}%`])
    .map((r): SettingRow => ({ key: r.key, value: r.value, updatedAt: r.updated_at }));
}

export function deleteSettingRowsByPrefix(exec: SqlExecutor, prefix: string): number {
  return exec.run(DELETE_BY_PREFIX_SQL, [`${prefix}%`]).changes;
}
