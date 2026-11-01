/**
 * mindmapStore slice：背诵模式、难点优先复习队列与挖空编辑。
 */

import type { MindMapNode, BlankRange } from '../../types';
import { findNodeById } from '../../utils/node/find';
import { mergeRanges, validateRanges } from '../../utils/node/blankRanges';
import {
  buildReviewQueue,
  commitReciteSession,
  loadReciteStats,
  saveReciteStats,
} from '../../utils/reciteStats';
import type { MindMapSliceCreator } from '../mindmapStoreRuntime';

export const createReciteSlice: MindMapSliceCreator<
  | 'setReciteMode'
  | 'startReciteReview'
  | 'stepReciteReview'
  | 'stopReciteReview'
> = (set, get) => {
  return {
    // 背诵模式
    setReciteMode: (enabled: boolean) => {
      // 退出背诵 = 一次会话结束：把会话事件日志（呈现/翻开/显示全部）
      // 提交进持久化学习记录。只有实际呈现或作答的空进入统计；
      // 零可提交样本时 commitReciteSession 原样返回引用，跳过写盘。
      if (!enabled) {
        const current = get();
        if (current.reciteMode && current.mindmapId) {
          const scopeRoot = current.viewRootId
            ? findNodeById(current.document.root, current.viewRootId) ?? current.document.root
            : current.document.root;
          const loaded = loadReciteStats(current.mindmapId);
          const committed = commitReciteSession(
            loaded,
            scopeRoot,
            current.reciteSessionLog,
          );
          if (committed !== loaded) {
            saveReciteStats(current.mindmapId, committed);
          }
        }
      }
      set((state) => {
        state.reciteMode = enabled;
        if (!enabled) {
          state.revealedBlanks = {};
          state.reciteReviewQueue = null;
          state.reciteReviewIndex = 0;
        }
        // 每次进入/退出都从空日志开始新会话
        state.reciteSessionLog = {};
        // 进入背诵模式时退出编辑状态
        if (enabled) {
          state.editingNodeId = null;
          state.editingNoteNodeId = null;
        }
      });
    },

    startReciteReview: () => {
      const current = get();
      const scopeRoot = current.viewRootId
        ? findNodeById(current.document.root, current.viewRootId) ?? current.document.root
        : current.document.root;
      const stats = current.mindmapId ? loadReciteStats(current.mindmapId) : {};
      const queue = buildReviewQueue(scopeRoot, stats);
      if (queue.length === 0) return 0;
      set((state) => {
        state.reciteReviewQueue = queue;
        state.reciteReviewIndex = 0;
        if (!state.reciteMode) {
          state.reciteMode = true;
          state.editingNodeId = null;
          state.editingNoteNodeId = null;
        }
      });
      get().expandToNode(queue[0].nodeId, { silent: true });
      get().setFocusedNodeId(queue[0].nodeId);
      return queue.length;
    },

    stepReciteReview: (delta: number) => {
      const { reciteReviewQueue, reciteReviewIndex } = get();
      if (!reciteReviewQueue || reciteReviewQueue.length === 0) return;
      const next = Math.min(
        Math.max(reciteReviewIndex + delta, 0),
        reciteReviewQueue.length - 1,
      );
      if (next === reciteReviewIndex) return;
      set((state) => {
        state.reciteReviewIndex = next;
      });
      const nodeId = reciteReviewQueue[next].nodeId;
      get().expandToNode(nodeId, { silent: true });
      get().setFocusedNodeId(nodeId);
    },

    stopReciteReview: () => {
      set((state) => {
        state.reciteReviewQueue = null;
        state.reciteReviewIndex = 0;
      });
    },
  };
};

export const createBlankSlice: MindMapSliceCreator<
  | 'revealBlank'
  | 'markBlanksPresented'
  | 'revealAllBlanks'
  | 'resetAllBlanks'
  | 'addBlankRange'
  | 'removeBlankRange'
  | 'clearNodeBlanks'
  | 'blankBranchNodes'
  | 'blankOutlineForRecite'
  | 'clearBranchBlanks'
> = (set, get, rt) => {
  const { applyMutation } = rt;

  return {
    revealBlank: (nodeId: string, rangeIndex: number) => {
      set((state) => {
        if (!state.revealedBlanks[nodeId]) {
          state.revealedBlanks[nodeId] = {};
        }
        state.revealedBlanks[nodeId][rangeIndex] = true;
        // 会话事件：单独翻开 = 没背出来（粘性；之后重新遮盖不清除）
        if (state.reciteMode) {
          const log = (state.reciteSessionLog[nodeId] ??= {});
          const events = (log[rangeIndex] ??= {});
          events.presented = true;
          events.missed = true;
        }
      });
    },

    markBlanksPresented: (nodeId: string, rangeIndices: number[]) => {
      const current = get();
      if (!current.reciteMode || rangeIndices.length === 0) return;
      // 滚动中反复可见很常见：全部已标记时跳过 set，避免无意义的状态更新
      const existing = current.reciteSessionLog[nodeId];
      if (existing && rangeIndices.every((index) => existing[index]?.presented)) return;
      set((state) => {
        const log = (state.reciteSessionLog[nodeId] ??= {});
        for (const index of rangeIndices) {
          const events = (log[index] ??= {});
          events.presented = true;
        }
      });
    },

    revealAllBlanks: () => {
      set((state) => {
        const allBlanks: Record<string, Record<number, boolean>> = {};
        const collect = (node: MindMapNode) => {
          if (node.blankedRanges && node.blankedRanges.length > 0) {
            const merged = mergeRanges(validateRanges(node.blankedRanges, node.text.length));
            const revealed: Record<number, boolean> = {};
            for (let i = 0; i < merged.length; i++) {
              revealed[i] = true;
            }
            allBlanks[node.id] = revealed;
          }
          node.children.forEach(collect);
        };
        collect(state.document.root);
        state.revealedBlanks = allBlanks;
        // 「显示全部」是核对动作而非逐空作答：被亮出的空标记 bulkRevealed，
        // 提交时既不算 miss 也不算成功样本（此前单独翻开过的 miss 保留）
        if (state.reciteMode) {
          for (const [nodeId, revealed] of Object.entries(allBlanks)) {
            const log = (state.reciteSessionLog[nodeId] ??= {});
            for (const key of Object.keys(revealed)) {
              const events = (log[Number(key)] ??= {});
              events.bulkRevealed = true;
            }
          }
        }
      });
    },

    resetAllBlanks: () => {
      set((state) => {
        // 只重置遮盖 UI；会话事件日志是粘性的，已产生的 miss 不因重盖消失
        state.revealedBlanks = {};
      });
    },

    addBlankRange: (nodeId: string, range: BlankRange) => {
      applyMutation((state) => {
        const node = findNodeById(state.document.root, nodeId);
        if (!node) return;
        const existing = node.blankedRanges || [];
        node.blankedRanges = mergeRanges(validateRanges([...existing, range], node.text.length));
      });
    },

    removeBlankRange: (nodeId: string, rangeIndex: number) => {
      applyMutation((state) => {
        const node = findNodeById(state.document.root, nodeId);
        if (!node || !node.blankedRanges) return;
        const merged = mergeRanges(validateRanges(node.blankedRanges, node.text.length));
        merged.splice(rangeIndex, 1);
        node.blankedRanges = merged.length > 0 ? merged : undefined;
        // 重建 revealed 索引映射：splice 后索引整体前移
        const oldRevealed = state.revealedBlanks[nodeId];
        if (oldRevealed) {
          if (merged.length === 0) {
            delete state.revealedBlanks[nodeId];
          } else {
            const newRevealed: Record<number, boolean> = {};
            for (const [key, val] of Object.entries(oldRevealed)) {
              const oldIdx = Number(key);
              if (oldIdx < rangeIndex) {
                newRevealed[oldIdx] = val;
              } else if (oldIdx > rangeIndex) {
                newRevealed[oldIdx - 1] = val;
              }
              // oldIdx === rangeIndex 的条目被删除，不保留
            }
            if (Object.keys(newRevealed).length > 0) {
              state.revealedBlanks[nodeId] = newRevealed;
            } else {
              delete state.revealedBlanks[nodeId];
            }
          }
        }
        // 会话事件日志按同一规则迁移索引（背诵中允许经弹层取消挖空）
        const oldLog = state.reciteSessionLog[nodeId];
        if (oldLog) {
          if (merged.length === 0) {
            delete state.reciteSessionLog[nodeId];
          } else {
            const newLog: (typeof state.reciteSessionLog)[string] = {};
            for (const [key, events] of Object.entries(oldLog)) {
              const oldIdx = Number(key);
              if (oldIdx < rangeIndex) {
                newLog[oldIdx] = events;
              } else if (oldIdx > rangeIndex) {
                newLog[oldIdx - 1] = events;
              }
            }
            if (Object.keys(newLog).length > 0) {
              state.reciteSessionLog[nodeId] = newLog;
            } else {
              delete state.reciteSessionLog[nodeId];
            }
          }
        }
      });
    },

    clearNodeBlanks: (nodeId: string) => {
      applyMutation((state) => {
        const node = findNodeById(state.document.root, nodeId);
        if (node) {
          delete node.blankedRanges;
        }
        delete state.revealedBlanks[nodeId];
        delete state.reciteSessionLog[nodeId];
      });
    },

    // 按分支批量挖空（背诵）：子树内所有非空文本节点整行挖空，单次 undo 还原
    blankBranchNodes: (nodeId: string) => {
      // 前置校验：目标不存在或子树全为空文本时不进 mutation（不产生历史/脏位）
      const target = findNodeById(get().document.root, nodeId);
      if (!target) return 0;
      const hasText = (node: MindMapNode): boolean =>
        node.text.length > 0 || node.children.some(hasText);
      if (!hasText(target)) return 0;

      let affected = 0;
      applyMutation((state) => {
        const branchRoot = findNodeById(state.document.root, nodeId);
        if (!branchRoot) return;
        const visit = (node: MindMapNode) => {
          const textLength = node.text.length;
          if (textLength > 0) {
            const merged = mergeRanges(validateRanges(
              [...(node.blankedRanges || []), { start: 0, end: textLength }],
              textLength,
            ));
            node.blankedRanges = merged;
            // 新遮挡的内容重置揭示状态，避免刚挖空就已「揭示」
            delete state.revealedBlanks[node.id];
            affected += 1;
          }
          node.children.forEach(visit);
        };
        visit(branchRoot);
      });
      return affected;
    },

    blankOutlineForRecite: () => {
      const depthOf = (node: MindMapNode): number =>
        node.children.length === 0 ? 0 : 1 + Math.max(...node.children.map(depthOf));
      const minDepth = depthOf(get().document.root) >= 2 ? 2 : 1;
      const hasTarget = (node: MindMapNode, depth: number): boolean =>
        (depth >= minDepth && node.text.length > 0) || node.children.some((c) => hasTarget(c, depth + 1));
      if (!hasTarget(get().document.root, 0)) return 0;

      let affected = 0;
      applyMutation((state) => {
        const visit = (node: MindMapNode, depth: number) => {
          const textLength = node.text.length;
          if (depth >= minDepth && textLength > 0) {
            node.blankedRanges = mergeRanges(validateRanges(
              [...(node.blankedRanges || []), { start: 0, end: textLength }],
              textLength,
            ));
            delete state.revealedBlanks[node.id];
            affected += 1;
          }
          node.children.forEach((child) => visit(child, depth + 1));
        };
        visit(state.document.root, 0);
      });
      return affected;
    },

    clearBranchBlanks: (nodeId: string) => {
      // 前置校验：目标不存在或子树没有任何挖空时不进 mutation
      const target = findNodeById(get().document.root, nodeId);
      if (!target) return 0;
      const hasBlanks = (node: MindMapNode): boolean =>
        (node.blankedRanges?.length ?? 0) > 0 || node.children.some(hasBlanks);
      if (!hasBlanks(target)) return 0;

      let affected = 0;
      applyMutation((state) => {
        const branchRoot = findNodeById(state.document.root, nodeId);
        if (!branchRoot) return;
        const visit = (node: MindMapNode) => {
          if (node.blankedRanges && node.blankedRanges.length > 0) {
            delete node.blankedRanges;
            affected += 1;
          }
          delete state.revealedBlanks[node.id];
          node.children.forEach(visit);
        };
        visit(branchRoot);
      });
      return affected;
    },
  };
};
