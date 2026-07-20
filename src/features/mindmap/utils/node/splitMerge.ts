/**
 * 大纲行内拆分 / 与上一节点合并（不可变更新）
 *
 * D3 注意：运行时主路径是 store/mindmapStore.ts 内联实现的
 * splitNode / mergeWithPrevious（额外处理焦点、选中、编辑态、revealedBlanks、
 * 关联线清理等 store 状态）。本文件是等价的纯函数版本，供测试与无 store
 * 场景使用；修改任一侧的树结构/元数据合并语义时必须同步另一侧。
 */

import type { MindMapNode, NodeId } from '../../types';
import { createNode } from './create';
import { findNodeWithParent } from './find';
import { insertNode } from './move';

export interface SplitNodeResult {
  tree: MindMapNode;
  /** 新拆出的右半节点 */
  newNodeId: NodeId;
  /** 拆分后应聚焦的节点 */
  focusNodeId: NodeId;
  /** 聚焦节点内的光标位置 */
  caretOffset: number;
}

export interface MergeWithPreviousResult {
  tree: MindMapNode;
  /** 合并后存活的目标节点 */
  focusNodeId: NodeId;
  /** 合并点光标（原目标文本末尾） */
  caretOffset: number;
}

/**
 * 在 offset 处拆分节点：左半留在原节点，右半成为其后同级新节点。
 * 子树留在原节点。offset === 0 时原节点变空、焦点留在原节点（上方空行手感）。
 * 根节点无同级：右半作为第一个子节点插入。
 */
export function splitNode(
  root: MindMapNode,
  nodeId: NodeId,
  offset: number,
  textOverride?: string
): SplitNodeResult | null {
  const info = findNodeWithParent(root, nodeId);
  if (!info) return null;

  const sourceText = textOverride ?? info.node.text ?? '';
  const clamped = Math.max(0, Math.min(offset, sourceText.length));
  const left = sourceText.slice(0, clamped);
  const right = sourceText.slice(clamped);

  const newNode = createNode({ text: right });
  // 文本变更后挖空索引失效
  const updatedCurrent: MindMapNode = {
    ...info.node,
    text: left,
    blankedRanges: undefined,
  };

  let tree: MindMapNode;
  if (!info.parent) {
    // 根：右半插入为第一个子节点
    tree = {
      ...updatedCurrent,
      children: [newNode, ...updatedCurrent.children],
    };
  } else {
    const parentId = info.parent.id;
    const siblings = info.parent.children.map((child) =>
      child.id === nodeId ? updatedCurrent : child
    );
    const withUpdated = replaceChildren(root, parentId, siblings);
    tree = insertNode(withUpdated, parentId, newNode, info.index + 1);
  }

  // 行首拆分：空行留在原位并保持焦点；其余情况焦点到新节点开头
  const focusOriginal = clamped === 0 && sourceText.length > 0;

  return {
    tree,
    newNodeId: newNode.id,
    focusNodeId: focusOriginal ? nodeId : newNode.id,
    caretOffset: 0,
  };
}

/**
 * 合并目标继承被合并节点的元数据（与 store.mergeWithPrevious 对齐）：
 * 备注拼接；样式/refs 仅目标缺失时继承；completed 取或。
 */
function mergeNodeMeta(target: MindMapNode, source: MindMapNode): Partial<MindMapNode> {
  const patch: Partial<MindMapNode> = {};
  if (source.note) {
    patch.note = target.note ? `${target.note}\n${source.note}` : source.note;
  }
  if (!target.style && source.style) {
    patch.style = { ...source.style };
  }
  if (source.refs?.length) {
    const existing = new Set((target.refs ?? []).map((ref) => ref.sourceId));
    const incoming = source.refs.filter((ref) => !existing.has(ref.sourceId));
    if (incoming.length) {
      patch.refs = [...(target.refs ?? []), ...incoming];
    }
  }
  if (source.completed && !target.completed) {
    patch.completed = true;
  }
  return patch;
}

/**
 * 将当前节点合并到上一同级；若无上一同级则合并到父节点。
 * 上一同级：子树接到目标末尾；并入父：子树占据原节点槽位（与 store 实现一致）。
 */
export function mergeWithPrevious(
  root: MindMapNode,
  nodeId: NodeId,
  textOverride?: string
): MergeWithPreviousResult | null {
  const info = findNodeWithParent(root, nodeId);
  if (!info || !info.parent) return null;

  const currentText = textOverride ?? info.node.text ?? '';
  const currentChildren = info.node.children;

  // 上一同级
  if (info.index > 0) {
    const prev = info.parent.children[info.index - 1];
    const caretOffset = (prev.text ?? '').length;
    const mergedPrev: MindMapNode = {
      ...prev,
      ...mergeNodeMeta(prev, info.node),
      text: (prev.text ?? '') + currentText,
      blankedRanges: undefined,
      children: [...prev.children, ...currentChildren],
    };

    const nextSiblings = info.parent.children
      .filter((child) => child.id !== nodeId)
      .map((child) => (child.id === prev.id ? mergedPrev : child));

    return {
      tree: replaceChildren(root, info.parent.id, nextSiblings),
      focusNodeId: prev.id,
      caretOffset,
    };
  }

  // 无上一同级：合并进父节点（父不能是「虚拟」——已有 parent）
  const parent = info.parent;
  // 若父是根且我们仍允许合并文本进根
  const caretOffset = (parent.text ?? '').length;
  const mergedParentChildren = [
    ...parent.children.slice(0, info.index),
    ...currentChildren,
    ...parent.children.slice(info.index + 1),
  ];

  const tree = updateNodeById(root, parent.id, {
    ...mergeNodeMeta(parent, info.node),
    text: (parent.text ?? '') + currentText,
    blankedRanges: undefined,
    children: mergedParentChildren,
  });

  return {
    tree,
    focusNodeId: parent.id,
    caretOffset,
  };
}

function replaceChildren(
  root: MindMapNode,
  parentId: NodeId,
  children: MindMapNode[]
): MindMapNode {
  if (root.id === parentId) {
    return { ...root, children };
  }
  return {
    ...root,
    children: root.children.map((child) => replaceChildren(child, parentId, children)),
  };
}

function updateNodeById(
  root: MindMapNode,
  nodeId: NodeId,
  patch: Partial<MindMapNode>
): MindMapNode {
  if (root.id === nodeId) {
    return { ...root, ...patch };
  }
  return {
    ...root,
    children: root.children.map((child) => updateNodeById(child, nodeId, patch)),
  };
}
