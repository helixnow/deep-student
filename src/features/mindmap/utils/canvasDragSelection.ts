import type { MindMapNode } from '../types';
import { collectTopLevelNodeIds } from './node/traverse';

/** Resolve the roots that should travel with a canvas drag gesture. */
export function resolveCanvasDragNodeIds(
  root: MindMapNode,
  selection: readonly string[],
  draggedNodeId: string,
): string[] {
  if (!selection.includes(draggedNodeId)) return [draggedNodeId];
  const roots = collectTopLevelNodeIds(root, selection, { excludeRoot: true });
  return roots.length > 0 ? roots : [draggedNodeId];
}

/** Includes each drag root and all descendants, for layout previews and drop exclusion. */
export function collectCanvasDragSubtreeIds(root: MindMapNode, dragRootIds: readonly string[]): Set<string> {
  const requested = new Set(dragRootIds);
  const result = new Set<string>();
  const visit = (node: MindMapNode, insideDraggedTree: boolean) => {
    const included = insideDraggedTree || requested.has(node.id);
    if (included) result.add(node.id);
    for (const child of node.children) visit(child, included);
  };
  visit(root, false);
  return result;
}
