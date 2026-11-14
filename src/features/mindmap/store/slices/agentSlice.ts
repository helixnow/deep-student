/**
 * mindmapStore slice：Agent 演出瞬态标记、引用定位与 agent 专用（skipHistory）节点操作。
 */

import { nanoid } from 'nanoid';
import i18next from 'i18next';
import type { MindMapNode } from '../../types';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { findNodeById, findParentNode, isDescendantOf } from '../../utils/node/find';
import { collectTopLevelNodeIds } from '../../utils/node/traverse';
import {
  MAX_MINDMAP_DEPTH,
  MAX_MINDMAP_NODES,
  getNodeDepth,
  countNodes,
  getSubtreeHeight,
  collectNodeAndDescendantIds,
  removeNodesById,
  afterRemoveNodes,
} from '../mindmapStoreHelpers';
import type { MindMapSliceCreator } from '../mindmapStoreRuntime';
import { reconcileSummariesWithTree } from '../../utils/summaryBraces';
import { syncMindMapAnchorEdges } from '../../utils/excerptIngest';
import { reconcileMindMapProjectedFlashcards } from '../../interop/mindmapCardProjection';

export const createAgentSlice: MindMapSliceCreator<
  | 'markAgentEntering'
  | 'clearAgentEntering'
  | 'markAgentExiting'
  | 'clearAgentExiting'
  | 'markAgentUpdated'
  | 'clearAgentUpdated'
  | 'requestAgentFitView'
  | 'locateNode'
  | 'agentAddNode'
  | 'agentAddSubtree'
  | 'agentDeleteNode'
  | 'agentMoveNode'
  | 'agentInsertSubtree'
> = (set, get, rt) => {
  const { applyMutation } = rt;

  return {
    // ACR R1-11：瞬态入场标记（不进 history / 不标脏 / 不触发保存）
    markAgentEntering: (ids: string[]) => {
      if (ids.length === 0) return;
      set((state) => {
        const next = new Set(state.agentEnteringIds);
        for (const id of ids) next.add(id);
        state.agentEnteringIds = next;
      });
    },

    clearAgentEntering: (ids: string[]) => {
      if (ids.length === 0) return;
      set((state) => {
        const next = new Set(state.agentEnteringIds);
        for (const id of ids) next.delete(id);
        state.agentEnteringIds = next;
      });
    },

    // ACR 4.0 A4：瞬态退场标记（不进 history / 不标脏 / 不触发保存）
    markAgentExiting: (ids: string[]) => {
      if (ids.length === 0) return;
      set((state) => {
        const next = new Set(state.agentExitingIds);
        for (const id of ids) next.add(id);
        state.agentExitingIds = next;
      });
    },

    clearAgentExiting: (ids: string[]) => {
      if (ids.length === 0) return;
      set((state) => {
        const next = new Set(state.agentExitingIds);
        for (const id of ids) next.delete(id);
        state.agentExitingIds = next;
      });
    },

    // ACR 4.0 A4：瞬态更新高亮标记（updated=背景 flash，区分 entering=滑入）
    markAgentUpdated: (ids: string[]) => {
      if (ids.length === 0) return;
      set((state) => {
        const next = new Set(state.agentUpdatedIds);
        for (const id of ids) next.add(id);
        state.agentUpdatedIds = next;
      });
    },

    clearAgentUpdated: (ids: string[]) => {
      if (ids.length === 0) return;
      set((state) => {
        const next = new Set(state.agentUpdatedIds);
        for (const id of ids) next.delete(id);
        state.agentUpdatedIds = next;
      });
    },

    // ACR R2-02：演出结束一次 fitView 信号
    requestAgentFitView: () => {
      set((state) => {
        state.agentFitViewNonce += 1;
      });
    },

    locateNode: (nodeId: string) => {
      const before = get();
      if (!findNodeById(before.document.root, nodeId)) return false;
      // 分支专注根不包含目标节点时退出专注，否则定位后节点仍不可见
      if (before.viewRootId && before.viewRootId !== nodeId) {
        const scopeRoot = findNodeById(before.document.root, before.viewRootId);
        if (!scopeRoot || !findNodeById(scopeRoot, nodeId)) before.setViewRootId(null);
      }
      before.expandToNode(nodeId, { silent: true });
      set((state) => {
        state.focusedNodeId = nodeId;
        state.editingNodeId = null;
        state.editingNoteNodeId = null;
        state.selection = [nodeId];
        state.selectionAnchorId = nodeId;
        state.nodeLocateRequest = {
          nodeId,
          nonce: (state.nodeLocateRequest?.nonce ?? 0) + 1,
          requestedAt: Date.now(),
        };
      });
      return true;
    },

    // ACR R1-11：等价 addNode + applyMutation({ skipHistory: true })
    agentAddNode: (parentId: string, index?: number) => {
      return get().agentAddSubtree(parentId, { text: '', children: [] }, index);
    },

    // Agent 外层节点及其 children 单事务插入，避免半棵树与重复保存调度。
    agentAddSubtree: (parentId, data, index) => {
      const state = get();
      const parentDepth = getNodeDepth(state.document.root, parentId);
      if (parentDepth < 0) return '';

      const clonedData = JSON.parse(JSON.stringify(data)) as Omit<MindMapNode, 'id'>;
      let newId = `node_${nanoid(10)}`;
      while (findNodeById(state.document.root, newId)) {
        newId = `node_${nanoid(10)}`;
      }
      const newNode: MindMapNode = { ...clonedData, id: newId };

      if (parentDepth + 1 + getSubtreeHeight(newNode) >= MAX_MINDMAP_DEPTH) {
        if (parentDepth >= 0) {
          showGlobalNotification('warning', i18next.t('store.depthExceeded', { ns: 'mindmap' }));
        }
        return '';
      }
      if (countNodes(state.document.root) + countNodes(newNode) > MAX_MINDMAP_NODES) {
        showGlobalNotification('warning', i18next.t('store.nodeCountExceeded', { ns: 'mindmap' }));
        return '';
      }

      let inserted = false;
      applyMutation((s) => {
        const parent = findNodeById(s.document.root, parentId);
        if (parent) {
          // 仅在确为折叠时展开，避免写入 collapsed:false 污染树快照
          if (parent.collapsed === true) parent.collapsed = false;
          const insertIndex = Math.max(
            0,
            Math.min(index ?? parent.children.length, parent.children.length),
          );
          parent.children.splice(insertIndex, 0, newNode);
          inserted = true;
          // ACR R2-02：不在此设 focusedNodeId——由 mindmapDriver 视口节流统一控制
        }
      }, { skipHistory: true });

      return inserted ? newId : '';
    },

    agentDeleteNode: (nodeId: string) => {
      const { document } = get();
      const normalizedIds = collectTopLevelNodeIds(document.root, [nodeId], { excludeRoot: true });
      if (normalizedIds.length === 0) return;
      const removedIds = collectNodeAndDescendantIds(document.root, normalizedIds);

      let nextFocusedNodeId = document.root.id;
      for (const id of normalizedIds) {
        const parent = findParentNode(document.root, id);
        if (parent) {
          nextFocusedNodeId = parent.id;
          break;
        }
      }

      applyMutation((state) => {
        removeNodesById(state.document.root, new Set(normalizedIds));
        afterRemoveNodes(state, removedIds, nextFocusedNodeId);
      }, { skipHistory: true });
      const after = get();
      syncMindMapAnchorEdges(after.mindmapId, after.document.root, { styleId: after.styleId });
      reconcileMindMapProjectedFlashcards(after.mindmapId, after.document.root);
    },

    agentMoveNode: (nodeId: string, newParentId: string, index: number) => {
      const { document } = get();
      if (document.root.id === nodeId) return false;
      if (nodeId === newParentId) return false;
      if (isDescendantOf(document.root, nodeId, newParentId)) return false;

      const movingNode = findNodeById(document.root, nodeId);
      const currentParent = findParentNode(document.root, nodeId);
      const nextParent = findNodeById(document.root, newParentId);
      const nextParentDepth = getNodeDepth(document.root, newParentId);
      if (!movingNode || !currentParent || !nextParent || nextParentDepth < 0) return false;
      if (nextParentDepth + 1 + getSubtreeHeight(movingNode) >= MAX_MINDMAP_DEPTH) {
        showGlobalNotification('warning', i18next.t('store.depthExceeded', { ns: 'mindmap' }));
        return false;
      }

      let moved = false;
      applyMutation((state) => {
        const node = findNodeById(state.document.root, nodeId);
        const currentParent = findParentNode(state.document.root, nodeId);
        const nextParent = findNodeById(state.document.root, newParentId);
        if (!node || !currentParent || !nextParent) {
          return;
        }

        const sourceIndex = currentParent.children.findIndex((child) => child.id === nodeId);
        if (sourceIndex === -1) {
          return;
        }

        const [detachedNode] = currentParent.children.splice(sourceIndex, 1);
        if (!detachedNode) {
          return;
        }

        let targetIndex = index;
        if (currentParent.id === nextParent.id && sourceIndex < targetIndex) {
          targetIndex -= 1;
        }

        const boundedIndex = Math.max(0, Math.min(targetIndex, nextParent.children.length));
        nextParent.children.splice(boundedIndex, 0, detachedNode);
        reconcileSummariesWithTree(state.document);
        moved = true;
      }, { skipHistory: true });
      const after = get();
      syncMindMapAnchorEdges(after.mindmapId, after.document.root, { styleId: after.styleId });
      reconcileMindMapProjectedFlashcards(after.mindmapId, after.document.root);
      return moved;
    },

    agentInsertSubtree: (parentId: string, node: MindMapNode, index?: number) => {
      applyMutation((state) => {
        const parent = findNodeById(state.document.root, parentId);
        if (!parent) return;
        if (parent.collapsed) parent.collapsed = false;
        const insertIndex = index ?? parent.children.length;
        const bounded = Math.max(0, Math.min(insertIndex, parent.children.length));
        // 深拷贝，避免 immer/外部引用共享
        parent.children.splice(bounded, 0, JSON.parse(JSON.stringify(node)) as MindMapNode);
        state.focusedNodeId = node.id;
      }, { skipHistory: true });
    },
  };
};
