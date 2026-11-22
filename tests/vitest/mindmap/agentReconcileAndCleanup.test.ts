/**
 * M1 回归测试：
 * 1. afterRemoveNodes 同步清理 measuredNodeHeights（消除长会话内存滞留）
 * 2. agentAddSubtree / agentInsertSubtree 成功变更后触发 anchor 边与闪卡投影对账
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MindMapDocument, MindMapNode } from '@/features/mindmap/types';
import { createMindMapStore } from '@/features/mindmap/store/mindmapStore';
import { registerMindMapAnchorEdgeSink } from '@/features/mindmap/utils/excerptIngest';
import {
  buildMindMapFlashcardId,
  registerMindMapCardProjectionSink,
  type MindMapProjectedFlashcardPayload,
} from '@/features/mindmap/interop/mindmapCardProjection';

function makeDoc(): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root',
      text: 'Root Topic',
      children: [
        {
          id: 'branch_1',
          text: 'Branch 1',
          children: [
            { id: 'leaf_1a', text: 'Leaf 1A', children: [] },
            { id: 'leaf_1b', text: 'Leaf 1B', children: [] },
          ],
        },
        {
          id: 'branch_2',
          text: 'Branch 2',
          children: [],
        },
      ],
    },
    meta: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

describe('afterRemoveNodes measuredNodeHeights cleanup', () => {
  it('prunes deleted node and descendant ids from measuredNodeHeights on deleteNodes / cutNodes / agentDeleteNode', () => {
    const store = createMindMapStore();
    store.setState({
      mindmapId: 'mm_mem_cleanup',
      document: makeDoc(),
      measuredNodeHeights: {
        root: 52,
        branch_1: 42,
        leaf_1a: 68,
        leaf_1b: 74,
        branch_2: 38,
      },
    });

    // deleteNodes 删除 branch_1（含其后代 leaf_1a, leaf_1b）
    store.getState().deleteNodes(['branch_1']);
    expect(store.getState().measuredNodeHeights).toEqual({
      root: 52,
      branch_2: 38,
    });

    // 重新填充并测试 agentDeleteNode
    store.setState({
      document: makeDoc(),
      measuredNodeHeights: {
        root: 52,
        branch_1: 42,
        leaf_1a: 68,
        leaf_1b: 74,
        branch_2: 38,
      },
    });
    store.getState().agentDeleteNode('branch_1');
    expect(store.getState().measuredNodeHeights).toEqual({
      root: 52,
      branch_2: 38,
    });

    // 重新填充并测试 cutNodes
    store.setState({
      document: makeDoc(),
      measuredNodeHeights: {
        root: 52,
        branch_1: 42,
        leaf_1a: 68,
        leaf_1b: 74,
        branch_2: 38,
      },
    });
    store.getState().cutNodes(['leaf_1a']);
    expect(store.getState().measuredNodeHeights).toEqual({
      root: 52,
      branch_1: 42,
      leaf_1b: 74,
      branch_2: 38,
    });
  });
});

describe('agentSlice reconciliation for agentAddSubtree and agentInsertSubtree', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    vi.restoreAllMocks();
  });

  it('triggers syncMindMapAnchorEdges and reconcileMindMapProjectedFlashcards after agentAddSubtree', () => {
    const upsertedEdges = vi.fn();
    const prunedEdges = vi.fn();
    cleanups.push(
      registerMindMapAnchorEdgeSink({
        upsertAnchorEdges: upsertedEdges,
        pruneAnchorEdgesBySource: prunedEdges,
      }),
    );

    const projected: MindMapProjectedFlashcardPayload[] = [];
    cleanups.push(
      registerMindMapCardProjectionSink({
        upsertProjectedCard: (payload) => {
          projected.push(payload);
        },
        removeProjectedCard: () => undefined,
      }),
    );

    const store = createMindMapStore();
    store.setState({
      mindmapId: 'mm_agent_add_reconcile',
      document: makeDoc(),
      styleId: 'default',
    });

    // 父节点不存在时不触发对账
    const missingId = store.getState().agentAddSubtree('non_existent', {
      text: 'Should not insert',
      children: [],
      isFlashcard: true,
    });
    expect(missingId).toBe('');
    expect(upsertedEdges).not.toHaveBeenCalled();
    expect(projected).toHaveLength(0);

    // 插入带锚点与闪卡标记的子树 -> 同步触发双对账
    const insertedId = store.getState().agentAddSubtree('branch_1', {
      text: 'AI Added Concept',
      isFlashcard: true,
      anchors: [
        {
          kind: 'pdf',
          resourceId: 'pdf_1',
          page: 7,
          quote: 'Theorem 1',
        },
      ],
      children: [],
    });

    expect(insertedId).toBeTruthy();
    expect(upsertedEdges).toHaveBeenCalled();
    expect(projected).toHaveLength(1);
    expect(projected[0].id).toBe(buildMindMapFlashcardId('mm_agent_add_reconcile', insertedId));
  });

  it('triggers syncMindMapAnchorEdges and reconcileMindMapProjectedFlashcards after agentInsertSubtree', () => {
    const upsertedEdges = vi.fn();
    const prunedEdges = vi.fn();
    cleanups.push(
      registerMindMapAnchorEdgeSink({
        upsertAnchorEdges: upsertedEdges,
        pruneAnchorEdgesBySource: prunedEdges,
      }),
    );

    const projected: MindMapProjectedFlashcardPayload[] = [];
    cleanups.push(
      registerMindMapCardProjectionSink({
        upsertProjectedCard: (payload) => {
          projected.push(payload);
        },
        removeProjectedCard: () => undefined,
      }),
    );

    const store = createMindMapStore();
    store.setState({
      mindmapId: 'mm_agent_insert_reconcile',
      document: makeDoc(),
      styleId: 'default',
    });

    const explicitSubtree: MindMapNode = {
      id: 'node_explicit_ai',
      text: 'Explicit AI Subtree',
      isFlashcard: true,
      anchors: [
        {
          kind: 'pdf',
          resourceId: 'pdf_2',
          page: 12,
          quote: 'Corollary 2',
        },
      ],
      children: [],
    };

    // 父节点不存在时不触发对账
    store.getState().agentInsertSubtree('missing_parent', explicitSubtree);
    expect(upsertedEdges).not.toHaveBeenCalled();
    expect(projected).toHaveLength(0);

    // 正常插入后同步触发双对账
    store.getState().agentInsertSubtree('branch_2', explicitSubtree, 0);
    expect(upsertedEdges).toHaveBeenCalled();
    expect(projected).toHaveLength(1);
    expect(projected[0].id).toBe(
      buildMindMapFlashcardId('mm_agent_insert_reconcile', 'node_explicit_ai'),
    );
  });
});
