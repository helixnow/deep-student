/**
 * automations.rs:4139–4166 — 心跳空转预检的只读 VFS 查询。
 *
 * 与默认心跳 prompt 的前两项检查对齐：
 * - 今日到期或已逾期的待办（`due_date <= today`，未删除）；
 * - 到期复习计划（`next_review_date <= today`，非 suspended）。
 *
 * SQL 属于 VFS 表，但 Rust 在同一函数里直接查询，不经过仓储层；
 * 这里仍放在本 lane 的 repository/ 下，满足 host 的 SQL 归属边界。
 */
import type { SqlExecutor, SqlParam } from '../../../platform/storage/api.ts';

function count(executor: SqlExecutor, sql: string, params: readonly SqlParam[], context: string): number {
  let value: unknown;
  try {
    value = executor.pluck<unknown>(sql, params);
  } catch (error) {
    throw new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return typeof value === 'number' ? value : Number(value ?? 0);
}

/** `Local::now().format("%Y-%m-%d")`。 */
export function localDateString(nowMs: number = Date.now()): string {
  const date = new Date(nowMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 返回 true 表示有待处理内容，应照常拉起 headless turn。 */
export function heartbeatHasPendingWork(
  vfsDb: SqlExecutor, nowMs: number = Date.now(),
): boolean {
  const today = localDateString(nowMs);
  const dueTodos = count(vfsDb,
    "SELECT COUNT(*) FROM todo_items WHERE status = 'pending' AND due_date <= ?1 AND deleted_at IS NULL",
    [today], 'count due todos failed');
  if (dueTodos > 0) return true;

  const dueReviews = count(vfsDb,
    "SELECT COUNT(*) FROM review_plans WHERE next_review_date <= ?1 AND status != 'suspended'",
    [today], 'count due reviews failed');
  return dueReviews > 0;
}
