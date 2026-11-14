/**
 * mindmapStore slice：复制/剪切/粘贴（节点、多行文本、Markdown 列表）。
 */

import { nanoid } from 'nanoid';
import i18next from 'i18next';
import type { MindMapNode } from '../../types';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { findNodeById, findParentNode } from '../../utils/node/find';
import { collectTopLevelNodeIds } from '../../utils/node/traverse';
import { markdownListToNodes } from '../../utils/pasteMarkdown';
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
  deepCloneNode,
} from '../mindmapStoreHelpers';
import { syncMindMapAnchorEdges } from '../../utils/excerptIngest';
import type { MindMapSliceCreator } from '../mindmapStoreRuntime';

export const createClipboardSlice: MindMapSliceCreator<
  | 'copyNodes'
  | 'cutNodes'
  | 'pasteNodes'
  | 'pasteTextChildren'
  | 'pasteMarkdownChildren'
> = (set, get, rt) => {
  const { applyMutation } = rt;

  return {
    copyNodes: (nodeIds: string[]) => {
      const { document } = get();
      const normalizedIds = collectTopLevelNodeIds(document.root, nodeIds);
      const nodeById = buildNodeIndex(document.root).nodeById;
      const copiedNodes: MindMapNode[] = [];

      for (const nodeId of normalizedIds) {
        const node = nodeById.get(nodeId);
        if (node) {
          copiedNodes.push(deepCloneNode(node));
        }
      }

      if (copiedNodes.length > 0) {
        set((state) => {
          state.clipboard = {
            nodes: copiedNodes,
            sourceOperation: 'copy',
            copiedAt: Date.now(),
          };
        });
      }
    },

    cutNodes: (nodeIds: string[]) => {
      const { document } = get();
      const normalizedIds = collectTopLevelNodeIds(document.root, nodeIds, { excludeRoot: true });
      if (normalizedIds.length === 0) return;
      const treeIndex = buildNodeIndex(document.root);
      const removedIds = collectNodeAndDescendantIds(document.root, normalizedIds);

      const copiedNodes: MindMapNode[] = [];
      for (const nodeId of normalizedIds) {
        const node = treeIndex.nodeById.get(nodeId);
        if (node) {
          copiedNodes.push(deepCloneNode(node));
        }
      }

      if (copiedNodes.length === 0) return;

      let nextFocusedNodeId = document.root.id;
      for (const nodeId of normalizedIds) {
        const parent = treeIndex.parentById.get(nodeId);
        if (parent) {
          nextFocusedNodeId = parent.id;
          break;
        }
      }

      applyMutation((state) => {
        state.clipboard = {
          nodes: copiedNodes,
          sourceOperation: 'cut',
          copiedAt: Date.now(),
        };

        removeNodesById(state.document.root, new Set(normalizedIds));
        afterRemoveNodes(state, removedIds, nextFocusedNodeId);
      });

      const after = get();
      syncMindMapAnchorEdges(after.mindmapId, after.document.root);
    },

    pasteNodes: (targetId: string, mode: 'child' | 'sibling-after' = 'child') => {
      const { clipboard, document } = get();
      if (!clipboard || clipboard.nodes.length === 0) return;

      // C4：sibling-after 贴到 target 的父节点内、target 之后；target 为根时回退为 child
      const siblingParent =
        mode === 'sibling-after' ? findParentNode(document.root, targetId) : null;
      const effectiveMode: 'child' | 'sibling-after' =
        mode === 'sibling-after' && siblingParent ? 'sibling-after' : 'child';
      const insertParentId = effectiveMode === 'sibling-after' ? siblingParent!.id : targetId;

      const parentDepth = getNodeDepth(document.root, insertParentId);
      if (parentDepth < 0) return;
      const pendingCount = clipboard.nodes.reduce((sum, node) => sum + countNodes(node), 0);
      if (countNodes(document.root) + pendingCount > MAX_MINDMAP_NODES) {
        showGlobalNotification('warning', i18next.t('store.nodeCountExceeded', { ns: 'mindmap' }));
        return;
      }
      const pendingHeight = Math.max(...clipboard.nodes.map(getSubtreeHeight));
      if (parentDepth + 1 + pendingHeight >= MAX_MINDMAP_DEPTH) {
        showGlobalNotification('warning', i18next.t('store.depthExceeded', { ns: 'mindmap' }));
        return;
      }

      const usedIds = new Set(buildNodeIndex(document.root).nodeById.keys());
      const nextNodeId = () => {
        let id = `node_${nanoid(10)}`;
        while (usedIds.has(id)) id = `node_${nanoid(10)}`;
        usedIds.add(id);
        return id;
      };
      function regenerateIds(node: MindMapNode): MindMapNode {
        return {
          ...node,
          id: nextNodeId(),
          children: node.children.map(child => regenerateIds(child)),
        };
      }
      const sourceForest = clipboard.nodes.map(deepCloneNode);
      const forest = sourceForest.map(regenerateIds);
      const clearClipboard = clipboard.sourceOperation === 'cut';

      applyMutation((state) => {
        const parentNode = findNodeById(state.document.root, insertParentId);
        if (!parentNode) return;
        if (effectiveMode === 'sibling-after') {
          const targetIndex = parentNode.children.findIndex((child) => child.id === targetId);
          const insertAt = targetIndex >= 0 ? targetIndex + 1 : parentNode.children.length;
          parentNode.children.splice(insertAt, 0, ...forest);
        } else {
          // 与 addNode 一致：折叠父下粘贴时自动展开，避免节点存在但不可见
          if (parentNode.collapsed === true) parentNode.collapsed = false;
          parentNode.children.push(...forest);
        }
        state.focusedNodeId = forest[0].id;
        if (clearClipboard) state.clipboard = null;
      });

      const after = get();
      syncMindMapAnchorEdges(after.mindmapId, after.document.root);
    },

    pasteTextChildren: (targetId: string, lines: string[]) => {
      const texts = lines.map((line) => line.trim()).filter(Boolean);
      if (texts.length === 0) return;

      const { document } = get();
      const parentDepth = getNodeDepth(document.root, targetId);
      if (parentDepth < 0) return;
      if (parentDepth + 1 >= MAX_MINDMAP_DEPTH) {
        showGlobalNotification('warning', i18next.t('store.depthExceeded', { ns: 'mindmap' }));
        return;
      }
      if (countNodes(document.root) + texts.length > MAX_MINDMAP_NODES) {
        showGlobalNotification('warning', i18next.t('store.nodeCountExceeded', { ns: 'mindmap' }));
        return;
      }

      const usedIds = new Set(buildNodeIndex(document.root).nodeById.keys());
      const nodes = texts.map((text) => {
        let id = `node_${nanoid(10)}`;
        while (usedIds.has(id)) id = `node_${nanoid(10)}`;
        usedIds.add(id);
        return { id, text, children: [] } satisfies MindMapNode;
      });

      applyMutation((state) => {
        const parentNode = findNodeById(state.document.root, targetId);
        if (!parentNode) return;
        // 与 addNode 一致：折叠父下粘贴时自动展开
        if (parentNode.collapsed === true) parentNode.collapsed = false;
        parentNode.children.push(...nodes);
        state.focusedNodeId = nodes[0].id;
      });
    },

    pasteMarkdownChildren: (
      targetId: string,
      markdown: string,
      options?: { currentText?: string; position?: 'child' | 'sibling-after' },
    ) => {
      let forest: MindMapNode[];
      try {
        forest = markdownListToNodes(markdown);
      } catch (error) {
        console.error('[MindMapStore] pasteMarkdownChildren parse failed:', error);
        return;
      }
      if (forest.length === 0) return;

      const { document } = get();
      // C0.2：'sibling-after' 把森林插到 targetId 之后同级；target 为根时回退为 child
      const siblingParent =
        options?.position === 'sibling-after'
          ? findParentNode(document.root, targetId)
          : null;
      const effectivePosition: 'child' | 'sibling-after' =
        options?.position === 'sibling-after' && siblingParent
          ? 'sibling-after'
          : 'child';
      const insertParentId =
        effectivePosition === 'sibling-after' ? siblingParent!.id : targetId;
      const parentDepth = getNodeDepth(document.root, insertParentId);
      if (parentDepth < 0) return;

      const totalNodes = countNodes(document.root);
      const pendingCount = forest.reduce((sum, n) => sum + countNodes(n), 0);

      if (totalNodes + pendingCount > MAX_MINDMAP_NODES) {
        showGlobalNotification('warning', i18next.t('store.nodeCountExceeded', { ns: 'mindmap' }));
        return;
      }

      const maxExtraDepth = (nodes: MindMapNode[], depth = 1): number => {
        let max = depth;
        for (const n of nodes) {
          if (n.children.length > 0) {
            max = Math.max(max, maxExtraDepth(n.children, depth + 1));
          } else {
            max = Math.max(max, depth);
          }
        }
        return max;
      };
      if (parentDepth + maxExtraDepth(forest) >= MAX_MINDMAP_DEPTH) {
        showGlobalNotification('warning', i18next.t('store.depthExceeded', { ns: 'mindmap' }));
        return;
      }

      applyMutation((state) => {
        const targetNode = findNodeById(state.document.root, targetId);
        if (!targetNode) return;

        if (options && Object.prototype.hasOwnProperty.call(options, 'currentText')) {
          const nextText = options.currentText ?? '';
          if (nextText !== targetNode.text) {
            targetNode.text = nextText;
            // Text offsets are no longer valid after an actual title edit.
            delete targetNode.blankedRanges;
            delete state.revealedBlanks[targetId];
          }
        }

        if (effectivePosition === 'sibling-after') {
          const liveParent = findParentNode(state.document.root, targetId);
          if (!liveParent) return;
          const targetIndex = liveParent.children.findIndex(
            (child) => child.id === targetId,
          );
          const insertAt =
            targetIndex >= 0 ? targetIndex + 1 : liveParent.children.length;
          liveParent.children.splice(insertAt, 0, ...forest);
        } else {
          // 与 addNode 一致：折叠父下粘贴时自动展开
          if (targetNode.collapsed === true) targetNode.collapsed = false;
          targetNode.children.push(...forest);
        }
        if (forest[0]) {
          state.focusedNodeId = forest[0].id;
        }
      });
    },
  };
};
