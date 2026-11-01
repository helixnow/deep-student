/**
 * mindmapStore slice：行级拆分/合并与批量完成状态切换。
 */

import { nanoid } from 'nanoid';
import i18next from 'i18next';
import type { MindMapNode, BlankRange } from '../../types';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { findNodeById, findParentNode, isDescendantOf } from '../../utils/node/find';
import { flattenVisibleNodes } from '../../utils/node/traverse';
import {
  MAX_MINDMAP_NODES,
  countNodes,
  buildNodeIndex,
  pruneAssociationsForRemovedNodes,
  resolveDraftBlankRanges,
  shiftBlankRanges,
} from '../mindmapStoreHelpers';
import type { MindMapSliceCreator } from '../mindmapStoreRuntime';

export const createSplitMergeSlice: MindMapSliceCreator<
  | 'splitNode'
  | 'mergeWithPrevious'
  | 'mergeNextIntoCurrent'
  | 'toggleCompleted'
> = (set, get, rt) => {
  const { applyMutation } = rt;

  return {
    splitNode: (nodeId: string, cursorOffset: number, textOverride?: string) => {
      const { document } = get();
      const node = findNodeById(document.root, nodeId);
      if (!node) return null;

      const parent = findParentNode(document.root, nodeId);
      // 根节点：拆成「根保留前半 + 新子节点后半」不合适；根无同级，拆为根下第一个子
      const text = textOverride ?? node.text ?? '';
      const offset = Math.max(0, Math.min(Math.floor(cursorOffset), text.length));
      const before = text.slice(0, offset);
      const after = text.slice(offset);

      // 节点数限制
      if (countNodes(document.root) >= MAX_MINDMAP_NODES) {
        showGlobalNotification('warning', i18next.t('store.nodeCountExceeded', { ns: 'mindmap' }));
        return null;
      }

      const newId = `node_${nanoid(10)}`;
      const newNode: MindMapNode = {
        id: newId,
        text: after,
        children: [],
      };

      applyMutation((state) => {
        const current = findNodeById(state.document.root, nodeId);
        if (!current) return;
        // C：挖空区间随拆分边界切分而非整体清除——先重映射到拆分基文本，
        // 再按 offset 分给左右两半（跨界区间被切成两段）。
        const draftRanges = resolveDraftBlankRanges(current, text);
        const leftRanges: BlankRange[] = [];
        const rightRanges: BlankRange[] = [];
        for (const range of draftRanges) {
          if (range.end <= offset) {
            leftRanges.push({ ...range });
          } else if (range.start >= offset) {
            rightRanges.push({ start: range.start - offset, end: range.end - offset });
          } else {
            if (range.start < offset) leftRanges.push({ start: range.start, end: offset });
            rightRanges.push({ start: 0, end: range.end - offset });
          }
        }
        current.text = before;
        if (leftRanges.length > 0) {
          current.blankedRanges = leftRanges;
        } else {
          delete current.blankedRanges;
        }
        if (rightRanges.length > 0) {
          newNode.blankedRanges = rightRanges;
        }
        delete state.revealedBlanks[nodeId];

        if (!parent) {
          // 根：后半成为第一个子节点（行业折中；根通常不拆为同级）
          current.children.unshift(newNode);
        } else {
          const liveParent = findParentNode(state.document.root, nodeId);
          if (!liveParent) return;
          const idx = liveParent.children.findIndex((c) => c.id === nodeId);
          if (idx === -1) return;
          liveParent.children.splice(idx + 1, 0, newNode);
        }

        const focusOriginal = offset === 0 && text.length > 0;
        const focusId = focusOriginal ? nodeId : newId;
        state.focusedNodeId = focusId;
        if (state.document.meta) {
          state.document.meta.lastFocusId = focusId;
        }
      });

      return newId;
    },

    mergeWithPrevious: (nodeId: string, textOverride?: string, scopeRootId?: string, prevVisibleNodeId?: string | null) => {
      const { document } = get();
      if (document.root.id === nodeId) return null;

      const parent = findParentNode(document.root, nodeId);
      if (!parent) return null;

      const idx = parent.children.findIndex((c) => c.id === nodeId);
      if (idx === -1) return null;

      let mergeTarget: MindMapNode | null = null;

      // C：大纲传入其可见列表中的上一行（尊重 hideCompleted / 搜索过滤 /
      // 折叠），行首 Backspace 合并到「视觉上方的那一行」，而不是可能被
      // 隐藏的上一同级。null = 视图内无上一行 → 拒绝合并。
      if (prevVisibleNodeId !== undefined) {
        if (prevVisibleNodeId === null) return null;
        const candidate = findNodeById(document.root, prevVisibleNodeId);
        if (
          candidate &&
          candidate.id !== nodeId &&
          !isDescendantOf(document.root, nodeId, candidate.id)
        ) {
          mergeTarget = candidate;
        }
      }

      if (!mergeTarget && idx > 0) {
        mergeTarget = parent.children[idx - 1];
      } else if (!mergeTarget) {
        // 无上一同级：取可见列表中的上一节点（通常是父）。
        // E01 B7：分支专注时传入 scopeRootId，以专注子树为界解析「上一可见」，
        // 避免行首 Backspace 合并到专注范围外（UI 不可见）的节点。
        const scopeRoot =
          (scopeRootId ? findNodeById(document.root, scopeRootId) : null) ??
          document.root;
        const visible = flattenVisibleNodes(scopeRoot);
        const visIdx = visible.findIndex((n) => n.node.id === nodeId);
        if (visIdx > 0) {
          mergeTarget = visible[visIdx - 1].node;
        }
      }

      if (!mergeTarget || mergeTarget.id === nodeId) return null;

      const current = findNodeById(document.root, nodeId);
      if (!current) return null;

      const cursorOffset = (mergeTarget.text ?? '').length;
      const mergedIntoId = mergeTarget.id;
      const appendedText = textOverride ?? current.text ?? '';

      applyMutation((state) => {
        const liveParent = findParentNode(state.document.root, nodeId);
        const liveCurrent = findNodeById(state.document.root, nodeId);
        const target = findNodeById(state.document.root, mergedIntoId);
        if (!liveParent || !liveCurrent || !target) return;

        const liveIdx = liveParent.children.findIndex((c) => c.id === nodeId);
        if (liveIdx === -1) return;

        // C：挖空区间不再随合并整体清除——目标文本基未变，其区间原样保留；
        // 被合并节点的区间重映射到草稿文本后平移拼接。揭示状态因索引可能
        // 变化而重置（背诵中重新点开即可，挖空本身不丢）。
        const targetTextBefore = target.text ?? '';
        const mergedBlankRanges = [
          ...resolveDraftBlankRanges(target, targetTextBefore),
          ...shiftBlankRanges(
            resolveDraftBlankRanges(liveCurrent, appendedText),
            targetTextBefore.length,
          ),
        ];
        target.text = targetTextBefore + appendedText;
        if (mergedBlankRanges.length > 0) {
          target.blankedRanges = mergedBlankRanges;
        } else {
          delete target.blankedRanges;
        }
        delete state.revealedBlanks[mergedIntoId];
        delete state.revealedBlanks[nodeId];

        // 合并元数据：备注拼接；样式/refs 仅目标缺失时继承
        if (liveCurrent.note) {
          target.note = target.note
            ? `${target.note}\n${liveCurrent.note}`
            : liveCurrent.note;
        }
        if (!target.style && liveCurrent.style) {
          target.style = { ...liveCurrent.style };
        }
        if (liveCurrent.refs?.length) {
          const existing = new Set((target.refs ?? []).map((r) => r.sourceId));
          const incoming = liveCurrent.refs.filter((r) => !existing.has(r.sourceId));
          if (incoming.length) {
            target.refs = [...(target.refs ?? []), ...incoming];
          }
        }
        if (liveCurrent.completed && !target.completed) {
          target.completed = true;
        }

        const movingChildren = [...liveCurrent.children];
        liveCurrent.children = [];

        if (target.id === liveParent.id) {
          // 并入父：子树占据原节点槽位（与 splitMerge util 一致）
          liveParent.children.splice(liveIdx, 1, ...movingChildren);
        } else {
          // 并入上一同级：子树接到目标末尾，再删当前
          target.children.push(...movingChildren);
          liveParent.children.splice(liveIdx, 1);
        }
        // 被合并节点已从树中移除，清理指向它的关联线（与 mergeNextIntoCurrent 对称）
        pruneAssociationsForRemovedNodes(state.document, new Set([nodeId]));
        // 专注根被合并时专注点跟随合并目标（目标为文档根则退出专注）
        if (state.viewRootId === nodeId) {
          state.viewRootId =
            mergedIntoId === state.document.root.id ? null : mergedIntoId;
        }

        state.focusedNodeId = mergedIntoId;
        if (state.document.meta) {
          state.document.meta.lastFocusId = mergedIntoId;
        }
        if (state.editingNodeId === nodeId) {
          state.editingNodeId = mergedIntoId;
        }
        if (state.editingNoteNodeId === nodeId) {
          state.editingNoteNodeId = null;
        }
        // U7：被合并节点在选中集内时改指向 merged 节点（旧实现先 filter 再 map，映射永不生效）
        const mappedSelection = state.selection.map((id) =>
          id === nodeId ? mergedIntoId : id,
        );
        state.selection = Array.from(new Set(mappedSelection));
      });

      return { mergedIntoId, cursorOffset };
    },

    mergeNextIntoCurrent: (nodeId: string, textOverride?: string, nextVisibleNodeId?: string | null) => {
      const { document } = get();
      const current = findNodeById(document.root, nodeId);
      if (!current) return null;

      const visible = flattenVisibleNodes(document.root);
      const currentIndex = visible.findIndex((entry) => entry.node.id === nodeId);
      const source = nextVisibleNodeId === undefined
        ? (currentIndex >= 0 ? visible[currentIndex + 1]?.node : null)
        : (nextVisibleNodeId ? findNodeById(document.root, nextVisibleNodeId) : null);
      if (!source || source.id === nodeId || !findParentNode(document.root, source.id)) return null;

      const cursorOffset = (textOverride ?? current.text ?? '').length;
      const sourceId = source.id;

      applyMutation((state) => {
        const target = findNodeById(state.document.root, nodeId);
        const liveSource = findNodeById(state.document.root, sourceId);
        const liveSourceParent = findParentNode(state.document.root, sourceId);
        if (!target || !liveSource || !liveSourceParent) return;

        const sourceIndex = liveSourceParent.children.findIndex((child) => child.id === sourceId);
        if (sourceIndex === -1) return;

        // C：与 mergeWithPrevious 对称——目标区间重映射到草稿文本，
        // 来源区间平移拼接；揭示状态重置但挖空本身保留。
        const targetDraft = textOverride ?? target.text ?? '';
        const sourceText = liveSource.text ?? '';
        const mergedBlankRanges = [
          ...resolveDraftBlankRanges(target, targetDraft),
          ...shiftBlankRanges(
            resolveDraftBlankRanges(liveSource, sourceText),
            targetDraft.length,
          ),
        ];
        target.text = targetDraft + sourceText;
        if (mergedBlankRanges.length > 0) {
          target.blankedRanges = mergedBlankRanges;
        } else {
          delete target.blankedRanges;
        }
        delete state.revealedBlanks[nodeId];
        delete state.revealedBlanks[sourceId];

        if (liveSource.note) {
          target.note = target.note ? `${target.note}\n${liveSource.note}` : liveSource.note;
        }
        if (!target.style && liveSource.style) target.style = { ...liveSource.style };
        if (liveSource.refs?.length) {
          const existing = new Set((target.refs ?? []).map((ref) => ref.sourceId));
          const incoming = liveSource.refs.filter((ref) => !existing.has(ref.sourceId));
          if (incoming.length) target.refs = [...(target.refs ?? []), ...incoming];
        }
        if (liveSource.completed && !target.completed) target.completed = true;

        const movingChildren = [...liveSource.children];
        liveSource.children = [];
        if (target.id === liveSourceParent.id) {
          liveSourceParent.children.splice(sourceIndex, 1, ...movingChildren);
        } else {
          target.children.push(...movingChildren);
          liveSourceParent.children.splice(sourceIndex, 1);
        }
        pruneAssociationsForRemovedNodes(state.document, new Set([sourceId]));
        // 专注根被合并进当前节点时专注点跟随目标（目标为文档根则退出专注）
        if (state.viewRootId === sourceId) {
          state.viewRootId = nodeId === state.document.root.id ? null : nodeId;
        }

        state.focusedNodeId = nodeId;
        if (state.document.meta) state.document.meta.lastFocusId = nodeId;
        if (state.editingNodeId === sourceId) state.editingNodeId = nodeId;
        if (state.editingNoteNodeId === sourceId) state.editingNoteNodeId = null;
        state.selection = state.selection.filter((id) => id !== sourceId);
      });

      return { mergedIntoId: nodeId, cursorOffset };
    },

    toggleCompleted: (nodeIds: string[]) => {
      const { document } = get();
      const nodeIndex = buildNodeIndex(document.root);
      const uniqueIds = Array.from(new Set(nodeIds)).filter((id) => nodeIndex.nodeById.has(id));
      if (uniqueIds.length === 0) return;
      const markCompleted = !uniqueIds.every(
        (id) => nodeIndex.nodeById.get(id)?.completed === true,
      );

      applyMutation((state) => {
        const liveNodeById = buildNodeIndex(state.document.root).nodeById;
        for (const id of uniqueIds) {
          const node = liveNodeById.get(id);
          if (node) {
            node.completed = markCompleted;
          }
        }
      });
    },
  };
};
