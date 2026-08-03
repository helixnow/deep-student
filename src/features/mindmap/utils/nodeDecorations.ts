/**
 * 节点装饰字段（priority / progress / href）查询索引。
 *
 * 布局引擎产出的 RF node.data 未包含这些新增可选字段（各引擎逐字段拷贝），
 * 节点组件通过本索引直接从 store 文档树读取，避免动布局引擎（他人文件）。
 *
 * 性能契约：
 * - 索引按 document.root 引用 WeakMap 缓存，每次文档变更仅重建一次（O(n)）。
 * - zustand 选择器返回字符串 key（Object.is 值比较），无装饰的节点恒返回 ''，
 *   不会因为无关变更触发重渲染。
 */

import type { MindMapNode } from '../types';

export interface NodeDecorations {
  priority?: number;
  progress?: number;
  href?: string;
}

const indexCache = new WeakMap<MindMapNode, Map<string, string>>();

function buildIndex(root: MindMapNode): Map<string, string> {
  const index = new Map<string, string>();
  const stack: MindMapNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.priority != null || node.progress != null || node.href != null) {
      index.set(
        node.id,
        JSON.stringify({
          priority: node.priority,
          progress: node.progress,
          href: node.href,
        }),
      );
    }
    const children = node.children ?? [];
    for (const child of children) stack.push(child);
  }
  return index;
}

/** zustand 选择器：返回节点装饰的序列化 key；无装饰返回 ''（值稳定） */
export function selectNodeDecorationKey(root: MindMapNode, nodeId: string): string {
  let index = indexCache.get(root);
  if (!index) {
    index = buildIndex(root);
    indexCache.set(root, index);
  }
  return index.get(nodeId) ?? '';
}

/** 将选择器返回的 key 解析为装饰对象；'' → null */
export function parseNodeDecorations(key: string): NodeDecorations | null {
  if (!key) return null;
  try {
    return JSON.parse(key) as NodeDecorations;
  } catch {
    return null;
  }
}
