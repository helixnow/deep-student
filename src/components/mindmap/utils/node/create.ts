/**
 * 节点创建工具
 */

import { nanoid } from 'nanoid';
import type { MindMapNode, CreateNodeParams } from '../../types';

/** 生成节点 ID */
export function generateNodeId(): string {
  return `node_${nanoid(10)}`;
}

/** 创建新节点 */
export function createNode(params: CreateNodeParams = {}): MindMapNode {
  return {
    id: generateNodeId(),
    text: params.text || '',
    note: params.note,
    children: [],
    collapsed: false,
    completed: false,
    style: params.style,
  };
}

/** 创建根节点 */
export function createRootNode(text: string = '中心主题'): MindMapNode {
  return {
    id: generateNodeId(),
    text,
    children: [],
    collapsed: false,
  };
}

/** 深度克隆节点（生成新 ID） */
export function cloneNode(node: MindMapNode, deep: boolean = true): MindMapNode {
  const cloned: MindMapNode = {
    ...node,
    id: generateNodeId(),
    children: deep 
      ? node.children.map(child => cloneNode(child, true))
      : [],
  };
  return cloned;
}

