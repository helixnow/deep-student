/**
 * mindmapStore slice：节点编辑：更新/新增/复制/删除/移动、折叠展开、缩进反缩进。
 */

import { nanoid } from 'nanoid';
import i18next from 'i18next';
import type { MindMapNode, UpdateNodeParams } from '../../types';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { findNodeById, findParentNode } from '../../utils/node/find';
import {
  mergeRanges,
  validateRanges,
  remapRangesAfterTextEdit,
} from '../../utils/node/blankRanges';
import { collectTopLevelNodeIds, traverseDFS } from '../../utils/node/traverse';
import {
  MAX_MINDMAP_DEPTH,
  MAX_MINDMAP_NODES,
  getNodeDepth,
  countNodes,
  getSubtreeHeight,
  buildNodeIndex,
  collectNodeAndDescendantIds,
  removeNodesById,
  afterRemoveNodes,
} from '../mindmapStoreHelpers';
import type { MindMapSliceCreator } from '../mindmapStoreRuntime';

export const createNodeEditSlice: MindMapSliceCreator<
  | 'updateNode'
  | 'addNode'
  | 'duplicateNodes'
  | 'deleteNode'
  | 'deleteNodes'
  | 'moveNode'
  | 'moveNodes'
  | 'toggleCollapse'
  | 'collapseAll'
  | 'expandAll'
  | 'collapseSubtree'
  | 'expandSubtree'
  | 'collapseToDepth'
  | 'indentNode'
  | 'indentNodes'
  | 'outdentNode'
  | 'outdentNodes'
> = (set, get, rt) => {
  const { applyMutation } = rt;

  return {
    // 更新节点（patch 中显式 undefined 的键会 delete，便于移除任务 completed 等可选字段）
    updateNode: (nodeId: string, patch: UpdateNodeParams, options) => {
      // U5：文本/备注/样式补丁默认按「节点+字段集」合并 history，
      // 连续打字/连点样式不再逐击键占用 undo 步；结构性字段（collapsed 等）不合并
      const patchKeys = Object.keys(patch).sort();
      const autoCoalescible =
        patchKeys.length > 0 &&
        patchKeys.every((key) => key === 'text' || key === 'note' || key === 'style');
      const coalesceKey =
        options?.coalesceKey !== undefined
          ? options.coalesceKey
          : autoCoalescible
            ? `update:${nodeId}:${patchKeys.join(',')}`
            : null;
      applyMutation((state) => {
        const node = findNodeById(state.document.root, nodeId);
        if (node) {
          // 文本变更时对挖空区间做编辑重映射（替代旧「一改就全清」）；
          // 无法映射（区间文本被改写/删除）的区间被丢弃，全部失效才清除。
          // 挖空前 commit 文本走 preserveBlankedRanges 原样保留。
          if (
            patch.text !== undefined &&
            patch.text !== node.text &&
            !options?.preserveBlankedRanges
          ) {
            if (node.blankedRanges?.length) {
              const prevRanges = mergeRanges(
                validateRanges(node.blankedRanges, node.text.length),
              );
              const remapped = remapRangesAfterTextEdit(
                node.text,
                patch.text,
                prevRanges,
              );
              if (remapped.length === 0) {
                delete node.blankedRanges;
                delete state.revealedBlanks[nodeId];
              } else {
                node.blankedRanges = remapped;
                // 区间数变化时索引不再可靠，丢弃揭示状态；数目不变则保留
                if (remapped.length !== prevRanges.length) {
                  delete state.revealedBlanks[nodeId];
                }
              }
            }
          }
          for (const key of Object.keys(patch) as Array<keyof UpdateNodeParams>) {
            const value = patch[key];
            const record = node as unknown as Record<string, unknown>;
            if (value === undefined) {
              delete record[key];
            } else {
              record[key] = value;
            }
          }
        }
      }, { ...options, coalesceKey });
    },

    // 添加节点（M-070: 前端深度/节点数限制）
    addNode: (parentId: string, index?: number) => {
      const state = get();

      // M-070: 深度限制
      const parentDepth = getNodeDepth(state.document.root, parentId);
      if (parentDepth < 0 || parentDepth >= MAX_MINDMAP_DEPTH - 1) {
        if (parentDepth >= 0) {
          showGlobalNotification('warning', i18next.t('store.depthExceeded', { ns: 'mindmap' }));
        }
        return '';
      }

      // M-070: 节点数限制
      const totalNodes = countNodes(state.document.root);
      if (totalNodes >= MAX_MINDMAP_NODES) {
        showGlobalNotification('warning', i18next.t('store.nodeCountExceeded', { ns: 'mindmap' }));
        return '';
      }

      const newId = `node_${nanoid(10)}`;
      const newNode: MindMapNode = {
        id: newId,
        text: '',
        children: [],
      };
      applyMutation((s) => {
        const parent = findNodeById(s.document.root, parentId);
        if (parent) {
          // 折叠父下新建时自动展开，避免节点存在但不可见
          if (parent.collapsed) parent.collapsed = false;
          const insertIndex = index ?? parent.children.length;
          parent.children.splice(insertIndex, 0, newNode);
          s.focusedNodeId = newId;
        }
      });

      return newId;
    },

    // 复制节点（在原位置后插入深拷贝；全部重新生成 id；单 history 步）
    duplicateNodes: (nodeIds: string[]) => {
      const { document } = get();
      const normalizedIds = collectTopLevelNodeIds(document.root, nodeIds, {
        excludeRoot: true,
      });
      if (normalizedIds.length === 0) return null;

      const treeIndex = buildNodeIndex(document.root);
      const sources = normalizedIds
        .map((id) => treeIndex.nodeById.get(id))
        .filter((node): node is MindMapNode => Boolean(node));
      if (sources.length !== normalizedIds.length) return null;

      const pendingCount = sources.reduce((sum, node) => sum + countNodes(node), 0);
      if (countNodes(document.root) + pendingCount > MAX_MINDMAP_NODES) {
        showGlobalNotification('warning', i18next.t('store.nodeCountExceeded', { ns: 'mindmap' }));
        return null;
      }

      const usedIds = new Set(treeIndex.nodeById.keys());
      const nextNodeId = () => {
        let id = `node_${nanoid(10)}`;
        while (usedIds.has(id)) id = `node_${nanoid(10)}`;
        usedIds.add(id);
        return id;
      };
      // JSON 克隆深拷贝 style/refs/blankedRanges 等嵌套对象，再全量重生成 id
      const regenerateIds = (node: MindMapNode): MindMapNode => ({
        ...node,
        id: nextNodeId(),
        children: node.children.map(regenerateIds),
      });
      const plans = normalizedIds.map((sourceId, index) => ({
        sourceId,
        clone: regenerateIds(JSON.parse(JSON.stringify(sources[index])) as MindMapNode),
      }));

      const newIds: string[] = [];
      applyMutation((state) => {
        for (const plan of plans) {
          const liveParent = findParentNode(state.document.root, plan.sourceId);
          if (!liveParent) continue;
          const sourceIndex = liveParent.children.findIndex(
            (child) => child.id === plan.sourceId,
          );
          if (sourceIndex === -1) continue;
          liveParent.children.splice(sourceIndex + 1, 0, plan.clone);
          newIds.push(plan.clone.id);
        }
        if (newIds.length > 0) {
          state.focusedNodeId = newIds[0];
          state.selection = [...newIds];
          state.selectionAnchorId = newIds[0];
        }
      });

      return newIds.length > 0 ? newIds : null;
    },

    // 删除节点
    deleteNode: (nodeId: string) => {
      get().deleteNodes([nodeId]);
    },

    deleteNodes: (nodeIds: string[]) => {
      const { document } = get();
      const normalizedIds = collectTopLevelNodeIds(document.root, nodeIds, { excludeRoot: true });
      if (normalizedIds.length === 0) return;
      const removedIds = collectNodeAndDescendantIds(document.root, normalizedIds);

      let nextFocusedNodeId = document.root.id;
      for (const nodeId of normalizedIds) {
        const parent = findParentNode(document.root, nodeId);
        if (parent) {
          nextFocusedNodeId = parent.id;
          break;
        }
      }

      applyMutation((state) => {
        removeNodesById(state.document.root, new Set(normalizedIds));
        afterRemoveNodes(state, removedIds, nextFocusedNodeId);
      });
    },

    // 移动节点
    moveNode: (nodeId: string, newParentId: string, index: number) => {
      get().moveNodes([nodeId], newParentId, index);
    },

    moveNodes: (nodeIds: string[], newParentId: string, index: number) => {
      const { document } = get();
      const normalizedIds = collectTopLevelNodeIds(document.root, nodeIds, {
        excludeRoot: true,
      });
      if (normalizedIds.length === 0) return false;

      const treeIndex = buildNodeIndex(document.root);
      const nextParent = treeIndex.nodeById.get(newParentId);
      const nextParentDepth = treeIndex.depthById.get(newParentId);
      if (!nextParent || nextParentDepth === undefined) return false;

      for (const nodeId of normalizedIds) {
        let currentId: string | null = newParentId;
        while (currentId) {
          if (currentId === nodeId) return false;
          currentId = treeIndex.parentById.get(currentId)?.id ?? null;
        }
        const node = treeIndex.nodeById.get(nodeId);
        if (!node || nextParentDepth + 1 + getSubtreeHeight(node) >= MAX_MINDMAP_DEPTH) {
          showGlobalNotification('warning', i18next.t('store.depthExceeded', { ns: 'mindmap' }));
          return false;
        }
      }

      const requestedIndex = Math.max(0, Math.floor(index));
      let removedBeforeTarget = 0;
      for (const nodeId of normalizedIds) {
        const parent = treeIndex.parentById.get(nodeId);
        if (parent?.id !== newParentId) continue;
        const sourceIndex = parent.children.findIndex((child) => child.id === nodeId);
        if (sourceIndex >= 0 && sourceIndex < requestedIndex) removedBeforeTarget += 1;
      }
      const adjustedIndex = requestedIndex - removedBeforeTarget;

      let moved = false;
      applyMutation((state) => {
        const liveIndex = buildNodeIndex(state.document.root);
        const movingNodes = normalizedIds.flatMap((nodeId) => {
          const node = liveIndex.nodeById.get(nodeId);
          return node ? [node] : [];
        });
        if (movingNodes.length !== normalizedIds.length) return;

        const movingIdSet = new Set(normalizedIds);
        const touchedParents = new Set<MindMapNode>();
        for (const nodeId of normalizedIds) {
          const parent = liveIndex.parentById.get(nodeId);
          if (parent) touchedParents.add(parent);
        }
        for (const parent of touchedParents) {
          parent.children = parent.children.filter((child) => !movingIdSet.has(child.id));
        }

        const liveNextParent = liveIndex.nodeById.get(newParentId);
        if (!liveNextParent) return;
        const boundedIndex = Math.max(
          0,
          Math.min(adjustedIndex, liveNextParent.children.length),
        );
        liveNextParent.children.splice(boundedIndex, 0, ...movingNodes);
        if (liveNextParent.collapsed === true) liveNextParent.collapsed = false;
        moved = true;
      });

      return moved;
    },

    // 切换折叠
    toggleCollapse: (nodeId: string, options) => {
      applyMutation((state) => {
        const node = findNodeById(state.document.root, nodeId);
        if (node) {
          node.collapsed = !node.collapsed;
        }
      }, options);
    },

    collapseAll: () => {
      applyMutation((state) => {
        traverseDFS(state.document.root, (node, parent) => {
          // 根不折叠；有子节点的非根节点全部折叠
          node.collapsed = parent !== null && node.children.length > 0;
        });
      });
    },

    expandAll: () => {
      applyMutation((state) => {
        traverseDFS(state.document.root, (node) => {
          node.collapsed = false;
        });
      });
    },

    // 折叠整个子树（单 history 步；替代 UI 层 forEach toggleCollapse + skipHistory 拼事务）
    collapseSubtree: (nodeId: string) => {
      const { document } = get();
      if (!findNodeById(document.root, nodeId)) return;
      applyMutation((state) => {
        const target = findNodeById(state.document.root, nodeId);
        if (!target) return;
        const isDocRoot = nodeId === state.document.root.id;
        traverseDFS(target, (node) => {
          // 文档根保持展开；叶子不写 collapsed，避免污染树快照
          if (isDocRoot && node.id === nodeId) return;
          if (node.children.length > 0) node.collapsed = true;
        });
      });
    },

    // 展开整个子树（单 history 步）
    expandSubtree: (nodeId: string) => {
      const { document } = get();
      if (!findNodeById(document.root, nodeId)) return;
      applyMutation((state) => {
        const target = findNodeById(state.document.root, nodeId);
        if (!target) return;
        traverseDFS(target, (node) => {
          // 仅在确为折叠时展开，不给未折叠节点写入 collapsed:false
          if (node.collapsed === true) node.collapsed = false;
        });
      });
    },

    collapseToDepth: (depth: number) => {
      const targetDepth = Math.max(0, Math.floor(depth));
      applyMutation((state) => {
        traverseDFS(state.document.root, (node, _parent, _index, currentDepth) => {
          node.collapsed = currentDepth >= targetDepth && node.children.length > 0;
        });
      });
    },

    // 缩进节点
    indentNode: (nodeId: string) => {
      get().indentNodes([nodeId]);
    },

    indentNodes: (nodeIds: string[]) => {
      const { document } = get();
      const normalizedIds = collectTopLevelNodeIds(document.root, nodeIds, {
        excludeRoot: true,
      });
      if (normalizedIds.length === 0) return;

      const selectedIds = new Set(normalizedIds);
      const treeIndex = buildNodeIndex(document.root);

      const plans: Array<{ parentId: string; targetId: string; nodeIds: string[] }> = [];
      let exceedsDepth = false;
      traverseDFS(document.root, (parent) => {
        let index = 0;
        while (index < parent.children.length) {
          if (!selectedIds.has(parent.children[index].id)) {
            index += 1;
            continue;
          }
          const start = index;
          const blockIds: string[] = [];
          while (index < parent.children.length && selectedIds.has(parent.children[index].id)) {
            blockIds.push(parent.children[index].id);
            index += 1;
          }
          if (start === 0) continue;

          const target = parent.children[start - 1];
          const targetDepth = treeIndex.depthById.get(target.id) ?? -1;
          const blockFits = blockIds.every((id) => {
            const node = treeIndex.nodeById.get(id);
            return node && targetDepth + 1 + getSubtreeHeight(node) < MAX_MINDMAP_DEPTH;
          });
          if (!blockFits) {
            exceedsDepth = true;
            continue;
          }
          plans.push({ parentId: parent.id, targetId: target.id, nodeIds: blockIds });
        }
      });

      if (exceedsDepth) {
        showGlobalNotification('warning', i18next.t('store.depthExceeded', { ns: 'mindmap' }));
        return;
      }
      if (plans.length === 0) return;

      applyMutation((state) => {
        const liveNodeById = buildNodeIndex(state.document.root).nodeById;
        for (const plan of plans) {
          const parent = liveNodeById.get(plan.parentId);
          const target = liveNodeById.get(plan.targetId);
          if (!parent || !target) continue;
          const movingIds = new Set(plan.nodeIds);
          const movingNodes = parent.children.filter((child) => movingIds.has(child.id));
          if (movingNodes.length === 0) continue;
          parent.children = parent.children.filter((child) => !movingIds.has(child.id));
          target.children.push(...movingNodes);
          if (target.collapsed === true) target.collapsed = false;
        }
      });
    },

    // 反缩进节点
    outdentNode: (nodeId: string) => {
      get().outdentNodes([nodeId]);
    },

    outdentNodes: (nodeIds: string[]) => {
      const { document } = get();
      const normalizedIds = collectTopLevelNodeIds(document.root, nodeIds, {
        excludeRoot: true,
      });
      if (normalizedIds.length === 0) return;

      const selectedIds = new Set(normalizedIds);
      const plans: Array<{
        parentId: string;
        grandParentId: string;
        nodeIds: string[];
        /** 反缩进语义：原后续同级被最后一个反缩进节点收养为子树 */
        adoptIds: string[];
      }> = [];
      const visit = (parent: MindMapNode, grandParent: MindMapNode | null) => {
        if (grandParent) {
          const movingIds = parent.children
            .filter((child) => selectedIds.has(child.id))
            .map((child) => child.id);
          if (movingIds.length > 0) {
            let lastSelectedIndex = -1;
            parent.children.forEach((child, index) => {
              if (selectedIds.has(child.id)) lastSelectedIndex = index;
            });
            const adoptIds = parent.children
              .slice(lastSelectedIndex + 1)
              .filter((child) => !selectedIds.has(child.id))
              .map((child) => child.id);
            plans.push({
              parentId: parent.id,
              grandParentId: grandParent.id,
              nodeIds: movingIds,
              adoptIds,
            });
          }
        }
        for (const child of parent.children) visit(child, parent);
      };
      visit(document.root, null);
      if (plans.length === 0) return;

      applyMutation((state) => {
        const liveNodeById = buildNodeIndex(state.document.root).nodeById;
        for (const plan of plans) {
          const parent = liveNodeById.get(plan.parentId);
          const grandParent = liveNodeById.get(plan.grandParentId);
          if (!parent || !grandParent) continue;
          const movingIds = new Set(plan.nodeIds);
          const movingNodes = parent.children.filter((child) => movingIds.has(child.id));
          if (movingNodes.length === 0) continue;

          // 收养后续同级：深度不变（parent+1 → grandParent+2），无需重查深度限制
          const adoptIdSet = new Set(plan.adoptIds);
          const adoptedNodes = parent.children.filter((child) => adoptIdSet.has(child.id));

          parent.children = parent.children.filter(
            (child) => !movingIds.has(child.id) && !adoptIdSet.has(child.id),
          );
          const parentIndex = grandParent.children.findIndex((child) => child.id === parent.id);
          if (parentIndex < 0) {
            // 目标位置丢失时回滚本计划的收养，避免节点凭空消失
            parent.children.push(...adoptedNodes);
            continue;
          }
          grandParent.children.splice(parentIndex + 1, 0, ...movingNodes);

          if (adoptedNodes.length > 0) {
            const adopter = movingNodes[movingNodes.length - 1];
            adopter.children.push(...adoptedNodes);
            if (adopter.collapsed === true) adopter.collapsed = false;
          }
        }
      });
    },
  };
};
