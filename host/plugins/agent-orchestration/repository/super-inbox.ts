/**
 * super_session/inbox.rs:509–542 —— 自动回合计数的只读查询。
 *
 * Rust 直接查 `chat_v2_messages`（同一 chat_v2 库）：自上一条人类消息以来，按
 * `timestamp DESC, rowid DESC` 取最近 `MAX_AUTO_TURNS + 1` 条 user 消息，逐条看
 * `meta_json.inboundOrigin` 是否存在，遇到第一条非 inbound 即停止。
 */

import type { SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import { MAX_AUTO_TURNS } from '../src/super-session.ts';

/** meta_json 无法解析 / 缺少 inboundOrigin 都算“不是 inbound”（与 Rust 的 Option 链一致）。 */
function isInboundMeta(raw: SqlValue | undefined): boolean {
  if (typeof raw !== 'string') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const origin = (parsed as Record<string, unknown>).inboundOrigin;
  return origin !== undefined && origin !== null;
}

/** inbox.rs:509–542。 */
export function countConsecutiveInbound(executor: SqlExecutor, sessionId: string): number {
  const rows = executor.all<{ meta_json: SqlValue }>(
    `SELECT meta_json FROM chat_v2_messages
     WHERE session_id = ?1 AND role = 'user'
     ORDER BY timestamp DESC, rowid DESC
     LIMIT ?2`,
    [sessionId, MAX_AUTO_TURNS + 1],
  );
  let count = 0;
  for (const row of rows) {
    if (!isInboundMeta(row.meta_json)) break;
    count += 1;
  }
  return count;
}
