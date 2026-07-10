/**
 * 大纲拆分/合并后恢复光标位置（跨节点 remount 时由聚焦 effect 消费）
 */

let pending: { nodeId: string; offset: number } | null = null;

export function requestOutlineCaret(nodeId: string, offset: number): void {
  pending = { nodeId, offset };
}

export function takeOutlineCaret(nodeId: string): number | null {
  if (!pending || pending.nodeId !== nodeId) return null;
  const offset = pending.offset;
  pending = null;
  return offset;
}
