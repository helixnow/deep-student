/**
 * 大纲行结构操作（缩进 / 反缩进 / 上移 / 下移）与多选切换的共享实现。
 *
 * 键盘快捷键（Tab / Shift+Tab / Mod+↑ / Mod+↓）与触屏「⋯」菜单走同一套
 * store 调用，保证 undo/history 粒度与约束（根不可移动、首个同级不可缩进、
 * 顶层不可反缩进等）完全一致。
 */

import type { MindMapNode } from '../../types';
import type { MindMapStoreState } from '../../store/mindmapStore';
import { findParentNode } from '../../utils/node/find';

export type OutlineStructureAction = 'indent' | 'outdent' | 'moveUp' | 'moveDown';

export interface OutlineStructureTarget {
  nodeId: string;
  parentId: string | null;
  indexInParent: number;
}

type StructureStore = Pick<MindMapStoreState, 'indentNode' | 'outdentNode' | 'moveNode'>;

/**
 * 执行结构操作。与 SortableOutlineNode 的键盘处理保持同一调用：
 * moveNodes 会按「已移除的原位置」回调 index，同父下移需传 +2（E08 B1）。
 */
export function runOutlineStructureAction(
  store: StructureStore,
  action: OutlineStructureAction,
  { nodeId, parentId, indexInParent }: OutlineStructureTarget,
): void {
  switch (action) {
    case 'indent':
      store.indentNode(nodeId);
      return;
    case 'outdent':
      store.outdentNode(nodeId);
      return;
    case 'moveUp':
      if (parentId) store.moveNode(nodeId, parentId, Math.max(0, indexInParent - 1));
      return;
    case 'moveDown':
      if (parentId) store.moveNode(nodeId, parentId, indexInParent + 2);
      return;
  }
}

export const OUTLINE_STRUCTURE_FLAG = {
  indent: 1,
  outdent: 2,
  moveUp: 4,
  moveDown: 8,
} as const satisfies Record<OutlineStructureAction, number>;

/**
 * 按实时文档树计算可用的结构操作（位掩码，便于作为 zustand selector 的
 * 原始值返回、避免每次生成新对象）。规则与 store 的 no-op 条件一致：
 * - 根：全部不可用；
 * - 缩进：需要上一个同级作为新父；
 * - 反缩进：父节点不是文档根；
 * - 上移/下移：不在同级首/尾。
 */
export function getOutlineStructureFlags(root: MindMapNode, nodeId: string): number {
  if (nodeId === root.id) return 0;
  const parent = findParentNode(root, nodeId);
  if (!parent) return 0;
  const index = parent.children.findIndex((child) => child.id === nodeId);
  if (index < 0) return 0;
  let flags = 0;
  if (index > 0) flags |= OUTLINE_STRUCTURE_FLAG.indent | OUTLINE_STRUCTURE_FLAG.moveUp;
  if (parent.id !== root.id) flags |= OUTLINE_STRUCTURE_FLAG.outdent;
  if (index < parent.children.length - 1) flags |= OUTLINE_STRUCTURE_FLAG.moveDown;
  return flags;
}

/** Mod+单击 / 触屏多选模式单击：切换某行的选中态（根行不参与多选） */
export function toggleOutlineSelection(
  selection: readonly string[],
  nodeId: string,
  rootId: string,
): string[] {
  return selection.includes(nodeId)
    ? selection.filter((id) => id !== nodeId)
    : [...selection.filter((id) => id !== rootId), nodeId];
}
