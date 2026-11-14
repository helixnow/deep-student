import { describe, expect, it } from 'vitest';
import type { MindMapNode } from '../../../types';
import type { AgentOp } from '@/features/workbench/agent/types';
import {
  decomposeSuggestionBranches,
  stashMindmapSuggestion,
  __clearAllMindmapSuggestions,
} from '@/features/workbench/agent/drivers/mindmapSuggestionStore';
import {
  computeGhostCanvasProjection,
  type RenderedNodeBox,
} from '../ghostProjection';

function createSampleRoot(): MindMapNode {
  return {
    id: 'root',
    text: '高等数学导论',
    children: [
      {
        id: 'node_limit',
        text: '极限与连续',
        children: [
          { id: 'node_limit_1', text: '夹逼准则', children: [] },
          { id: 'node_limit_2', text: '洛必达法则', children: [] },
        ],
      },
      {
        id: 'node_deriv',
        text: '导数与微分',
        children: [{ id: 'node_deriv_1', text: '链式法则', children: [] }],
      },
      {
        id: 'node_legacy',
        text: '冗余草稿节点',
        children: [{ id: 'node_legacy_child', text: '旧子项', children: [] }],
      },
    ],
  };
}

describe('decomposeSuggestionBranches & computeGhostCanvasProjection', () => {
  it('decomposes mixed AgentOp[] into independent branches and projects non-overlapping Ghost Nodes, Bezier Edges, and Diff Annotations', () => {
    __clearAllMindmapSuggestions();
    const ops: AgentOp[] = [
      {
        kind: 'add_node',
        anchor: { parent_id: 'node_limit' },
        payload: {
          data: {
            id: 'prop_taylor',
            text: '泰勒展开局部近似',
            children: [
              { id: 'prop_taylor_1', text: '皮亚诺余项', children: [] },
              { id: 'prop_taylor_2', text: '拉格朗日余项', children: [] },
            ],
          },
        },
        destructive: false,
        label: '新增泰勒展开分支',
      },
      {
        kind: 'add_node',
        anchor: { parent_id: 'prop_taylor' },
        payload: {
          data: {
            id: 'prop_taylor_3',
            text: '常见麦克劳林公式',
            children: [],
          },
        },
        destructive: false,
        label: '补充麦克劳林子节点',
      },
      {
        kind: 'add_node',
        anchor: { parent_id: 'root' },
        payload: {
          data: {
            text: '多元函数微积分',
            children: [{ id: 'prop_multi_1', text: '偏导数与全微分', children: [] }],
          },
        },
        destructive: false,
        label: '新增多元微积分分支',
      },
      {
        kind: 'update_node',
        anchor: { node_id: 'node_deriv' },
        payload: { patch: { text: '一元导数与微分' } },
        destructive: false,
        label: '重命名导数章节',
      },
      {
        kind: 'update_node',
        anchor: { node_id: 'node_deriv' },
        payload: { patch: { note: '补充几何切线与线性主部解释' } },
        destructive: false,
        label: '补充导数备注',
      },
      {
        kind: 'delete_node',
        anchor: { node_id: 'node_legacy' },
        payload: {},
        destructive: true,
        label: '移除冗余草稿',
      },
      {
        kind: 'move_node',
        anchor: { node_id: 'node_limit_2', new_parent_id: 'node_deriv' },
        payload: { index: 1 },
        destructive: true,
        label: '将洛必达法则移至导数章节',
      },
    ];

    const branches = decomposeSuggestionBranches(ops, 's_test');
    expect(branches).toHaveLength(5);

    // 1) prop_taylor + nested children + chained prop_taylor_3 merged into branch 0
    expect(branches[0]).toMatchObject({
      branchId: 'gbr_s_test_0',
      kind: 'add_branch',
      anchorNodeId: 'node_limit',
      opIndices: [0, 1],
      affectedNodeCount: 4,
    });

    // 2) independent second add_branch on root
    expect(branches[1]).toMatchObject({
      branchId: 'gbr_s_test_1',
      kind: 'add_branch',
      anchorNodeId: 'root',
      opIndices: [2],
      affectedNodeCount: 2,
    });

    // 3) two update_node ops on node_deriv coalesced into single modify_node branch
    expect(branches[2]).toMatchObject({
      branchId: 'gbr_s_test_2',
      kind: 'modify_node',
      anchorNodeId: 'node_deriv',
      opIndices: [3, 4],
      affectedNodeCount: 1,
    });

    // 4) remove_subtree
    expect(branches[3]).toMatchObject({
      branchId: 'gbr_s_test_3',
      kind: 'remove_subtree',
      anchorNodeId: 'node_legacy',
      opIndices: [5],
    });

    // 5) move_branch
    expect(branches[4]).toMatchObject({
      branchId: 'gbr_s_test_4',
      kind: 'move_branch',
      anchorNodeId: 'node_limit_2',
      targetParentId: 'node_deriv',
      opIndices: [6],
    });

    const suggestion = stashMindmapSuggestion({
      runId: 'run_proj',
      mindmapId: 'mm_proj',
      windowId: null,
      ops,
      branches,
    });

    const projection = computeGhostCanvasProjection({
      root: createSampleRoot(),
      suggestion,
      layoutId: 'tree',
      layoutDirection: 'right',
    });

    // 4 ghost nodes from branch 0 + 2 ghost nodes from branch 1 = 6 ghost nodes
    expect(projection.ghostNodes).toHaveLength(6);
    const entryNodes = projection.ghostNodes.filter((n) => n.isBranchEntry);
    expect(entryNodes).toHaveLength(2);
    expect(entryNodes.map((n) => n.text)).toEqual(['泰勒展开局部近似', '多元函数微积分']);

    // Sibling ghost nodes under prop_taylor must not overlap vertically
    const taylorChildren = projection.ghostNodes.filter(
      (n) =>
        n.branchId === 'gbr_s_test_0' &&
        !n.isBranchEntry,
    );
    expect(taylorChildren).toHaveLength(3);
    for (let i = 0; i < taylorChildren.length; i++) {
      for (let j = i + 1; j < taylorChildren.length; j++) {
        const a = taylorChildren[i];
        const b = taylorChildren[j];
        const overlapsX = a.x < b.x + b.width && b.x < a.x + a.width;
        const overlapsY = a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlapsX && overlapsY).toBe(false);
      }
    }

    // 6 add_branch edges + 1 move_branch relocation arc = 7 cubic Bezier SVG paths
    expect(projection.ghostEdges).toHaveLength(7);
    for (const edge of projection.ghostEdges) {
      expect(edge.pathD).toMatch(/^M -?\d+ -?\d+ C /);
    }
    expect(projection.ghostEdges.some((e) => e.kind === 'move_branch')).toBe(true);

    // 3 annotations: modify_node, remove_subtree (count=2), move_branch
    expect(projection.annotations).toHaveLength(3);
    const modifyAnn = projection.annotations.find((a) => a.kind === 'modify_node')!;
    expect(modifyAnn.beforeText).toBe('导数与微分');
    expect(modifyAnn.afterText).toBe('一元导数与微分');
    expect(modifyAnn.noteChanged).toBe(true);

    const removeAnn = projection.annotations.find((a) => a.kind === 'remove_subtree')!;
    expect(removeAnn.removedSubtreeCount).toBe(2);

    const moveAnn = projection.annotations.find((a) => a.kind === 'move_branch')!;
    expect(moveAnn.moveTargetParentText).toBe('导数与微分');
    __clearAllMindmapSuggestions();
  });

  it('aligns Ghost Branch coordinates to realRenderedNodePositions when anchor DOM box is offset', () => {
    __clearAllMindmapSuggestions();
    const root = createSampleRoot();
    const suggestion = stashMindmapSuggestion({
      runId: 'run_align',
      mindmapId: 'mm_align',
      windowId: null,
      ops: [
        {
          kind: 'add_node',
          anchor: { parent_id: 'node_deriv' },
          payload: { data: { text: '隐函数求导法', children: [] } },
          destructive: false,
          label: '添加隐函数求导',
        },
      ],
    });

    const unaligned = computeGhostCanvasProjection({
      root,
      suggestion,
    });
    expect(unaligned.ghostNodes).toHaveLength(1);

    const realPositions = new Map<string, RenderedNodeBox>([
      ['node_deriv', { x: 420, y: 680, width: 140, height: 42 }],
    ]);

    const aligned = computeGhostCanvasProjection({
      root,
      suggestion,
      realRenderedNodePositions: realPositions,
    });

    expect(aligned.ghostNodes).toHaveLength(1);
    // Right-growing child must sit strictly to the right of realRenderedNodePositions('node_deriv')
    expect(aligned.ghostNodes[0].x).toBeGreaterThan(420 + 140);
    // Edge starts at right-center of real anchor box (x = 420 + 140 = 560, y = 680 + 21 = 701)
    expect(aligned.ghostEdges[0].pathD.startsWith('M 560 701 C ')).toBe(true);
    __clearAllMindmapSuggestions();
  });

  it('degrades gracefully when the user manually deletes or edits a pending ghost parent/target node (C6 §4)', () => {
    __clearAllMindmapSuggestions();
    const suggestion = stashMindmapSuggestion({
      runId: 'run_orphan',
      mindmapId: 'mm_orphan',
      windowId: null,
      ops: [
        {
          kind: 'add_node',
          anchor: { parent_id: 'deleted_parent_id' },
          payload: { data: { text: '孤儿新增分支', children: [] } },
          destructive: false,
          label: '孤儿新增',
        },
        {
          kind: 'update_node',
          anchor: { node_id: 'deleted_target_id' },
          payload: { patch: { text: '孤儿修改' } },
          destructive: false,
          label: '孤儿修改',
        },
        {
          kind: 'delete_node',
          anchor: { node_id: 'deleted_remove_id' },
          payload: {},
          destructive: true,
          label: '孤儿删除',
        },
        {
          kind: 'add_node',
          anchor: { parent_id: 'node_deriv' },
          payload: { data: { text: '存活分支', children: [] } },
          destructive: false,
          label: '存活新增',
        },
      ],
    });

    const mutatedRoot = createSampleRoot();
    // Simulate user manually renaming node_deriv and collapsing it while proposal is pending
    const deriv = mutatedRoot.children.find((c) => c.id === 'node_deriv')!;
    deriv.text = '用户手改后的导数标题';
    deriv.collapsed = true;

    expect(() =>
      computeGhostCanvasProjection({
        root: mutatedRoot,
        suggestion,
      }),
    ).not.toThrow();

    const projection = computeGhostCanvasProjection({
      root: mutatedRoot,
      suggestion,
    });

    // Orphaned ops skipped cleanly; surviving branch under collapsed/edited node_deriv still projects
    expect(projection.ghostNodes).toHaveLength(1);
    expect(projection.ghostNodes[0].text).toBe('存活分支');
    expect(projection.annotations).toHaveLength(0);
    __clearAllMindmapSuggestions();
  });
});
