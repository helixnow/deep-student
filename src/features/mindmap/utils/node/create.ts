/**
 * 节点创建工具
 */

import { nanoid } from 'nanoid';
import type { MindMapNode, CreateNodeParams } from '../../types';
import i18n from '@/i18n';

/** 生成节点 ID */
export function generateNodeId(): string {
  return `node_${nanoid(10)}`;
}

/**
 * 创建新节点（默认非任务：不写 completed，大纲才不会立刻出现 checkbox）。
 * D4：collapsed 同样省略——与 store.addNode 的序列化形态一致，
 * 避免新节点把 `collapsed:false` 写进树快照污染 diff/持久化。
 */
export function createNode(params: CreateNodeParams = {}): MindMapNode {
  const node: MindMapNode = {
    id: generateNodeId(),
    text: params.text || '',
    children: [],
  };
  if (params.note !== undefined) node.note = params.note;
  if (params.style !== undefined) node.style = params.style;
  return node;
}

/** 创建根节点（同上：省略 collapsed 等可选字段） */
export function createRootNode(text: string = i18n.t('mindmap:placeholder.root')): MindMapNode {
  return {
    id: generateNodeId(),
    text,
    children: [],
  };
}

/**
 * 深度克隆节点（生成新 ID）。
 * B10：style/refs/blankedRanges 等嵌套对象一并深拷贝，
 * 避免克隆体与原节点共享引用（immer frozen 树上原地改写会抛错）。
 */
export function cloneNode(node: MindMapNode, deep: boolean = true): MindMapNode {
  const cloned: MindMapNode = {
    ...node,
    id: generateNodeId(),
    children: deep 
      ? node.children.map(child => cloneNode(child, true))
      : [],
  };
  if (node.style) cloned.style = { ...node.style };
  if (node.refs) cloned.refs = node.refs.map((ref) => ({ ...ref }));
  if (node.blankedRanges) {
    cloned.blankedRanges = node.blankedRanges.map((range) => ({ ...range }));
  }
  return cloned;
}
