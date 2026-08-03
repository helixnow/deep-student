import type { MindMapNode } from '../types';

export interface ReciteBlankTarget {
  nodeId: string;
  rangeIndex: number;
}

/** Finds the next hidden cloze, starting at the focused node and wrapping once. */
export function findNextUnrevealedBlank(
  visibleNodes: readonly MindMapNode[],
  focusedNodeId: string | null,
  revealed: Readonly<Record<string, Readonly<Record<number, boolean>>>>,
): ReciteBlankTarget | null {
  if (visibleNodes.length === 0) return null;
  const focusedIndex = visibleNodes.findIndex((node) => node.id === focusedNodeId);
  const startIndex = focusedIndex >= 0 ? focusedIndex : 0;
  for (let offset = 0; offset < visibleNodes.length; offset += 1) {
    const node = visibleNodes[(startIndex + offset) % visibleNodes.length];
    const nextRangeIndex = (node.blankedRanges ?? []).findIndex(
      (_, index) => !revealed[node.id]?.[index],
    );
    if (nextRangeIndex >= 0) return { nodeId: node.id, rangeIndex: nextRangeIndex };
  }
  return null;
}
