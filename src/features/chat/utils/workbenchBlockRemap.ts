/**
 * ACR R2-05 — workbench 工具块类型 remap / runId 解析
 *
 * 背景：
 * - 流式路径：toolCall.ts 已把 workbench_* → workbench_ops
 * - 持久化路径：旧会话可能仍以 mcp_tool 落库；恢复时需按 toolName 纠正
 * - runId：桥当前注入 ctx.block_id（= block.id）；DESIGN 要求 runId===toolCallId，
 *   前端撤销优先认账本里实际存在的 id（toolCallId 或 block.id）
 *
 * 见 docs/dev/acr/DESIGN.md §3；docs/dev/acr/STANDARDS.md §4。
 *
 * ACR 4.0（A8）核对：本轮新增面无需扩展映射——
 * - desktop 虚拟目标仍走 workbench_act/observe（workbench_* 前缀已覆盖），
 *   target.typeId='desktop' 由工具卡 extractTarget 原样呈现；
 * - 'reviewing' 状态与 placementHint 属 presence 层字段，经 presenceStore
 *   订阅进入工具卡 data-presence-status，不经过块类型 remap；
 * - 未新增会产出前端平面 AcrReceipt 的域委托工具（ACR_FRONTEND_DELEGATED_TOOLS 不变）。
 */

import type { BlockType } from '@/features/chat/core/types/block';

const MAX_RESTORED_WORKBENCH_BLOCK_IDS = 1000;
const restoredWorkbenchBlockIds = new Set<string>();

/** 去掉 builtin-/mcp.tools./命名空间前缀，得到短工具名 */
export function stripToolNamePrefix(toolName: string | undefined | null): string {
  if (!toolName) return '';
  return toolName
    .replace(/^builtin-/, '')
    .replace(/^mcp\.tools\./, '')
    .replace(/^.*\./, '');
}

/** stripped 名是否为 workbench_* 桌面操控工具 */
export function isWorkbenchToolName(toolName: string | undefined | null): boolean {
  return stripToolNamePrefix(toolName).startsWith('workbench_');
}

/**
 * R3-01 / S-REV-01：会产出前端平面 AcrReceipt 的域委托工具。
 * 流式/恢复时 remap 为 workbench_ops，才能露出撤销 chrome（账本仍按 runId）。
 */
const ACR_FRONTEND_DELEGATED_TOOLS = new Set([
  'note_append',
  'note_replace',
  'note_set',
  'mindmap_edit_nodes',
]);

/** 是否应渲染为 workbench_ops（导航 workbench_* 或域委托写工具） */
export function isWorkbenchOpsToolName(toolName: string | undefined | null): boolean {
  const stripped = stripToolNamePrefix(toolName);
  if (!stripped) return false;
  return (
    stripped.startsWith('workbench_') || ACR_FRONTEND_DELEGATED_TOOLS.has(stripped)
  );
}

/**
 * 恢复/加载时纠正块类型：mcp_tool + workbench_* / 域委托写 → workbench_ops。
 * 已是 workbench_ops 或非相关工具则原样返回。
 */
export function remapWorkbenchBlockType(
  type: string,
  toolName?: string | null
): BlockType | string {
  if (type === 'workbench_ops') return type;
  if (type === 'mcp_tool' && isWorkbenchOpsToolName(toolName)) {
    return 'workbench_ops';
  }
  return type;
}

/**
 * 标记从持久化会话恢复的 ACR block。
 *
 * Run Ledger 只存在于当前前端生命周期。标记按 blockId 保存，避免 toolOutput 在恢复、
 * store 更新或 selector 中被克隆后丢失身份；集合有界，防止长生命周期页面无限增长。
 */
export function markWorkbenchBlockRestored(blockId: string): void {
  if (!blockId) return;
  restoredWorkbenchBlockIds.delete(blockId);
  restoredWorkbenchBlockIds.add(blockId);
  while (restoredWorkbenchBlockIds.size > MAX_RESTORED_WORKBENCH_BLOCK_IDS) {
    const oldest = restoredWorkbenchBlockIds.values().next().value;
    if (typeof oldest !== 'string') break;
    restoredWorkbenchBlockIds.delete(oldest);
  }
}

/** 是否为从持久化会话恢复的 ACR block。 */
export function isWorkbenchBlockRestored(blockId: string): boolean {
  return restoredWorkbenchBlockIds.has(blockId);
}

/**
 * 解析 ACR runId（撤销 / presence 联动）。
 *
 * 优先顺序：
 * 1. 调用方传入的 hasRun 探测（账本仍持有的 id）
 * 2. toolCallId（DESIGN 权威，待 R2-01 桥侧对齐后生效）
 * 3. blockId（当前桥注入 = ctx.block_id）
 */
export function resolveWorkbenchRunId(
  block: { id: string; toolCallId?: string },
  hasRun?: (runId: string) => boolean
): string | undefined {
  const candidates = [block.toolCallId, block.id].filter(
    (id): id is string => typeof id === 'string' && id.length > 0
  );
  if (candidates.length === 0) return undefined;
  if (hasRun) {
    for (const id of candidates) {
      if (hasRun(id)) return id;
    }
  }
  return candidates[0];
}
