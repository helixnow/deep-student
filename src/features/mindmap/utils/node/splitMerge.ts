/**
 * 大纲行内拆分 / 与上一节点合并（不可变更新）
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
 * 将当前节点合并到上一同级；若无上一同级则合并到父节点。
 * 当前节点的子树接到合并目标末尾。
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
