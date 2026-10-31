/**
 * mindmapStore slice：查找替换、搜索导航、搜索过滤与展开到节点。
 */

import type { MindMapNode } from '../../types';
import { findNodeById } from '../../utils/node/find';
import { traverseDFS } from '../../utils/node/traverse';
import { searchMindMapNodeIds, type SearchOptions } from '../../utils/searchFilter';
import { buildNodeIndex } from '../mindmapStoreHelpers';
import type { MindMapSliceCreator } from '../mindmapStoreRuntime';

export const createReplaceSlice: MindMapSliceCreator<'replaceInMindMap'> = (set, get, rt) => {
  const { applyMutation } = rt;

  return {
    // P2：查找替换。先在当前树上规划补丁，再单次 applyMutation（一次 undo）
    replaceInMindMap: (query, replacement, options) => {
      if (!query) return 0;
      const caseSensitive = options?.caseSensitive ?? false;
      const includeNotes = options?.includeNotes ?? true;
      const scope = options?.nodeIds ? new Set(options.nodeIds) : null;

      /** 大小写不敏感时手动扫描替换（避免动态 RegExp 的转义问题） */
      const replaceAllOccurrences = (source: string): string => {
        if (caseSensitive) return source.split(query).join(replacement);
        const haystack = source.toLowerCase();
        const needle = query.toLowerCase();
        let result = '';
        let cursor = 0;
        while (cursor <= source.length - needle.length) {
          const idx = haystack.indexOf(needle, cursor);
          if (idx === -1) break;
          result += source.slice(cursor, idx) + replacement;
          cursor = idx + needle.length;
        }
        return result + source.slice(cursor);
      };

      const { document } = get();
      const plans: Array<{ id: string; text?: string; note?: string }> = [];
      traverseDFS(document.root, (node) => {
        if (scope && !scope.has(node.id)) return;
        const nextText = replaceAllOccurrences(node.text ?? '');
        const nextNote =
          includeNotes && node.note ? replaceAllOccurrences(node.note) : undefined;
        const textChanged = nextText !== (node.text ?? '');
        const noteChanged = nextNote !== undefined && nextNote !== node.note;
        if (!textChanged && !noteChanged) return;
        plans.push({
          id: node.id,
          ...(textChanged ? { text: nextText } : {}),
          ...(noteChanged ? { note: nextNote } : {}),
        });
      });
      if (plans.length === 0) return 0;

      applyMutation((state) => {
        const liveNodeById = buildNodeIndex(state.document.root).nodeById;
        for (const plan of plans) {
          const node = liveNodeById.get(plan.id);
          if (!node) continue;
          if (plan.text !== undefined) {
            node.text = plan.text;
            // 文本变更后挖空字符索引失效（与 updateNode 语义一致）
            delete node.blankedRanges;
            delete state.revealedBlanks[plan.id];
          }
          if (plan.note !== undefined) {
            node.note = plan.note;
          }
        }
      });
      return plans.length;
    },
  };
};

export const createSearchSlice: MindMapSliceCreator<
  | 'search'
  | 'nextSearchResult'
  | 'prevSearchResult'
  | 'clearSearch'
  | 'setSearchFilterMode'
  | 'expandToNode'
> = (set, get, rt) => {
  const { applyMutation, reconcileFilteredInteractionState } = rt;

  return {
    // 搜索节点
    search: (query: string, options?: SearchOptions) => {
      const searchOptions = options ?? {};
      if (!query.trim()) {
        set((state) => {
          state.searchQuery = '';
          state.searchOptions = searchOptions;
          state.searchResults = [];
          state.currentSearchIndex = -1;
        });
        return;
      }

      const { document } = get();
      const results = searchMindMapNodeIds(document.root, query, searchOptions);

      set((state) => {
        state.searchQuery = query;
        state.searchOptions = searchOptions;
        state.searchResults = results;
        state.currentSearchIndex = results.length > 0 ? 0 : -1;
        reconcileFilteredInteractionState(state);
      });

      if (results.length > 0) {
        get().expandToNode(results[0], { silent: true });
        set((state) => {
          state.focusedNodeId = results[0];
        });
      }
    },

    // 下一个搜索结果
    nextSearchResult: () => {
      const { searchResults, currentSearchIndex } = get();
      if (searchResults.length === 0) return;

      const nextIndex = (currentSearchIndex + 1) % searchResults.length;
      const nodeId = searchResults[nextIndex];

      get().expandToNode(nodeId, { silent: true });
      set((state) => {
        state.currentSearchIndex = nextIndex;
        state.focusedNodeId = nodeId;
      });
    },

    // 上一个搜索结果
    prevSearchResult: () => {
      const { searchResults, currentSearchIndex } = get();
      if (searchResults.length === 0) return;

      const prevIndex =
        currentSearchIndex <= 0 ? searchResults.length - 1 : currentSearchIndex - 1;
      const nodeId = searchResults[prevIndex];

      get().expandToNode(nodeId, { silent: true });
      set((state) => {
        state.currentSearchIndex = prevIndex;
        state.focusedNodeId = nodeId;
      });
    },

    // 清除搜索
    clearSearch: () => {
      set((state) => {
        state.searchQuery = '';
        state.searchOptions = {};
        state.searchResults = [];
        state.currentSearchIndex = -1;
      });
    },

    setSearchFilterMode: (enabled: boolean) => {
      set((state) => {
        state.searchFilterMode = enabled;
        if (enabled) reconcileFilteredInteractionState(state);
      });
    },

    // 展开到指定节点
    expandToNode: (nodeId: string, options) => {
      const { document } = get();

      const findPath = (
        node: MindMapNode,
        targetId: string,
        path: string[]
      ): string[] | null => {
        if (node.id === targetId) return path;
        for (const child of node.children) {
          const result = findPath(child, targetId, [...path, node.id]);
          if (result) return result;
        }
        return null;
      };

      const path = findPath(document.root, nodeId, []);
      if (!path) return;

      applyMutation((state) => {
        for (const id of path) {
          const node = findNodeById(state.document.root, id);
          if (node) {
            node.collapsed = false;
          }
        }
      }, {
        skipHistory: options?.silent ?? false,
        skipSave: options?.silent ?? false,
        markDirty: !(options?.silent ?? false),
      });
    },
  };
};
