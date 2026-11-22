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

const FAST_SEP = '\u0000';
const MAX_PARSED_CACHE = 2000;

const indexCache = new WeakMap<MindMapNode, Map<string, string>>();
const nodeDecoCache = new WeakMap<MindMapNode, { key: string; value: NodeDecorations } | null>();
const parsedCache = new Map<string, NodeDecorations>();

function cacheParsed(key: string, value: NodeDecorations): void {
  if (parsedCache.size >= MAX_PARSED_CACHE) parsedCache.clear();
  parsedCache.set(key, value);
}

function getOrCreateNodeDeco(node: MindMapNode): { key: string; value: NodeDecorations } | null {
  const cached = nodeDecoCache.get(node);
  if (cached !== undefined) return cached;
  if (node.priority == null && node.progress == null && node.href == null) {
    nodeDecoCache.set(node, null);
    return null;
  }
  const value: NodeDecorations = Object.freeze({
    ...(node.priority != null ? { priority: node.priority } : {}),
    ...(node.progress != null ? { progress: node.progress } : {}),
    ...(node.href != null ? { href: node.href } : {}),
  });
  const canUseFastKey = !node.href || !node.href.includes(FAST_SEP);
  const key = canUseFastKey
    ? `${node.priority ?? ''}${FAST_SEP}${node.progress ?? ''}${FAST_SEP}${node.href ?? ''}`
    : JSON.stringify(value);
  const entry = { key, value };
  nodeDecoCache.set(node, entry);
  cacheParsed(key, value);
  return entry;
}

function buildIndex(root: MindMapNode): Map<string, string> {
  const index = new Map<string, string>();
  const stack: MindMapNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.priority != null || node.progress != null || node.href != null) {
      const entry = getOrCreateNodeDeco(node);
      if (entry) index.set(node.id, entry.key);
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

/** 将选择器返回的 key 解析为冻结装饰对象（引用稳定）；'' → null */
export function parseNodeDecorations(key: string): NodeDecorations | null {
  if (!key) return null;
  const cached = parsedCache.get(key);
  if (cached) return cached;
  let parsed: NodeDecorations;
  if (key.startsWith('{')) {
    try {
      parsed = Object.freeze(JSON.parse(key) as NodeDecorations);
    } catch {
      return null;
    }
  } else {
    const [pStr, progStr, ...hrefParts] = key.split(FAST_SEP);
    const href = hrefParts.length > 0 ? hrefParts.join(FAST_SEP) : '';
    const priority = pStr !== '' ? Number(pStr) : undefined;
    const progress = progStr !== '' ? Number(progStr) : undefined;
    parsed = Object.freeze({
      ...(priority !== undefined && Number.isFinite(priority) ? { priority } : {}),
      ...(progress !== undefined && Number.isFinite(progress) ? { progress } : {}),
      ...(href ? { href } : {}),
    });
  }
  cacheParsed(key, parsed);
  return parsed;
}
