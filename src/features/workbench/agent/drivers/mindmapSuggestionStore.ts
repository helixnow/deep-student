/**
 * ACR 导图建议暂存（P2 人机双写 MVP）
 *
 * suggestion 屏障命中时（dirty/hot/并发用户编辑 + 破坏类 op），driver 不再
 * 简单拒绝，而是把剩余 ops 暂存到这里；画布上的确认条（diff 摘要，无幽灵态
 * ——风险 3 的 MVP 退化）让用户裁决：接受 → acceptMindmapSuggestion 正常
 * 演出应用 + save；拒绝 → 丢弃暂存。
 *
 * 每导图至多一条暂存（新暂存替换旧的——旧 ops 从未应用，直接丢弃安全）。
 * 模块级 Map + 订阅通知，与 artifactRegistry 同形态。
 */

import type { AgentOp } from '../types';

export interface MindmapAgentSuggestion {
  id: string;
  /** 原 ACR run id（回执关联用） */
  runId: string;
  mindmapId: string;
  windowId: string | null;
  /** 屏障处暂存的剩余 ops（从命中 op 起，含该 op） */
  ops: AgentOp[];
  createdAt: number;
}

const suggestions = new Map<string, MindmapAgentSuggestion>();

type Listener = (mindmapId: string) => void;
const listeners = new Set<Listener>();

function notify(mindmapId: string): void {
  for (const fn of listeners) fn(mindmapId);
}

export function subscribeMindmapSuggestions(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function stashMindmapSuggestion(
  entry: Omit<MindmapAgentSuggestion, 'id' | 'createdAt'>,
): MindmapAgentSuggestion {
  const suggestion: MindmapAgentSuggestion = {
    ...entry,
    id: `mms_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
  };
  suggestions.set(entry.mindmapId, suggestion);
  notify(entry.mindmapId);
  return suggestion;
}

export function getMindmapSuggestion(mindmapId: string): MindmapAgentSuggestion | null {
  return suggestions.get(mindmapId) ?? null;
}

export function clearMindmapSuggestion(mindmapId: string): void {
  if (suggestions.delete(mindmapId)) notify(mindmapId);
}

/** 测试用 */
export function __clearAllMindmapSuggestions(): void {
  const ids = [...suggestions.keys()];
  suggestions.clear();
  for (const id of ids) notify(id);
}

/** op 列表 → diff 摘要计数（确认条人读用；不模拟文档，直接按 kind 统计） */
export function summarizeSuggestionOps(ops: AgentOp[]): {
  added: number;
  removed: number;
  updated: number;
  moved: number;
} {
  let added = 0;
  let removed = 0;
  let updated = 0;
  let moved = 0;
  for (const op of ops) {
    switch (op.kind) {
      case 'add_node':
        added += 1;
        break;
      case 'delete_node':
        removed += 1;
        break;
      case 'move_node':
        moved += 1;
        break;
      default:
        // update_node 及其余（样式/备注等）归入「修改」
        updated += 1;
    }
  }
  return { added, removed, updated, moved };
}
