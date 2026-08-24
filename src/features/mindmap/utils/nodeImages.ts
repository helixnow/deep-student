/**
 * 节点内嵌图片查询索引。
 *
 * 布局引擎产出的 RF node.data 不拷贝 images（data URL 体积大，且逐引擎改动侵入），
 * 节点组件通过本索引直接从 store 文档树读取（与 nodeDecorations 同一模式）。
 *
 * 性能契约：
 * - 索引按 document.root 引用 WeakMap 缓存，每次文档变更仅重建一次（O(n)）。
 * - 选择器返回 images 数组本体引用：immer 只改动变更路径上的引用，
 *   无关变更下同一数组引用稳定（Object.is），不触发重渲染；
 *   无图片节点恒返回同一 EMPTY 引用。
 */

import type { MindMapImage, MindMapNode } from '../types';

const EMPTY: MindMapImage[] = [];

const indexCache = new WeakMap<MindMapNode, Map<string, MindMapImage[]>>();

function buildIndex(root: MindMapNode): Map<string, MindMapImage[]> {
  const index = new Map<string, MindMapImage[]>();
  const stack: MindMapNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.images && node.images.length > 0) {
      index.set(node.id, node.images);
    }
    const children = node.children ?? [];
    for (const child of children) stack.push(child);
  }
  return index;
}

/** zustand 选择器：返回节点内嵌图片数组（引用稳定）；无图片返回共享空数组 */
export function selectNodeImages(root: MindMapNode, nodeId: string): MindMapImage[] {
  let index = indexCache.get(root);
  if (!index) {
    index = buildIndex(root);
    indexCache.set(root, index);
  }
  return index.get(nodeId) ?? EMPTY;
}
