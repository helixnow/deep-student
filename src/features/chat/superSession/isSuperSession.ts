/**
 * Super 会话判定（SSOT）
 *
 * Super 会话 = 普通 chat_v2 会话（mode=chat）+ metadata 标记：
 *   { "super_agent": { "active": true, "version": 1, "workspace_id": "ws_…", "hidden": false } }
 *
 * 退役的旧 Super 会话（回收站恢复、分支、被替换）metadata 为
 * `{ super_agent: { active: false, retired_at } }`，按普通会话对待。
 *
 * 注意：Super 会话不是子代理会话，不能命中 isSubagentSession（输入、编辑、重发全部原生）。
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isSuperSession(metadata: unknown): boolean {
  const superAgent = asRecord(asRecord(metadata)?.super_agent);
  return superAgent?.active === true;
}

/** 读取 Super 会话 metadata 中记录的工作区 ID（非 Super 会话返回 null） */
export function getSuperSessionWorkspaceId(metadata: unknown): string | null {
  const superAgent = asRecord(asRecord(metadata)?.super_agent);
  if (superAgent?.active !== true) return null;
  const workspaceId = superAgent.workspace_id;
  return typeof workspaceId === 'string' && workspaceId.length > 0 ? workspaceId : null;
}
