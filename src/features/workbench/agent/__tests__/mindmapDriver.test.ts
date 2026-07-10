/**
 * R1-11 / R2-02 — mindmapDriver：真实 mindmapStore ops、ledger、视口节流、双窗防御
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMindMapStore } from '@/features/mindmap/store/mindmapStore';
import type { MindMapDocument, MindMapNode } from '@/features/mindmap/types';
import { findNodeById } from '@/features/mindmap/utils/node/find';
import { runLedger } from '../ledger';
import { createPacer } from '../pacing';
import { mindmapDriver, VIEWPORT_FOLLOW_EVERY } from '../drivers/mindmapDriver';
import type { AcrRunContext, AgentOp, PacingProfileName } from '../types';

const MM_ID = 'mm_test_r1_11';
const MM_OTHER = 'mm_other_window';

function createDocument(): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root_test',
      text: 'Root',
      children: [
        {
          id: 'node_a',
          text: 'Alpha',
          children: [
            {
              id: 'node_a1',
              text: 'A1',
              children: [{ id: 'node_a1a', text: 'A1a', children: [] }],
            },
          ],
        },
        {
          id: 'node_b',
          text: 'Beta',
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

function seedStore(
  document: MindMapDocument,
  overrides?: { isDirty?: boolean; editingNodeId?: string | null; mindmapId?: string },
): void {
  useMindMapStore.setState({
    mindmapId: overrides?.mindmapId ?? MM_ID,
    metadata: null,
    document: JSON.parse(JSON.stringify(document)) as MindMapDocument,
    focusedNodeId: 'node_a',
    editingNodeId: overrides?.editingNodeId ?? null,
    selection: [],
    history: { past: [], future: [] },
    clipboard: null,
    isDirty: overrides?.isDirty ?? false,
    isSaving: false,
    lastSavedAt: null,
    _documentVersion: 0,
    hideCompleted: false,
    searchFilterMode: false,
    viewports: {},
    agentEnteringIds: new Set(),
    agentFitViewNonce: 0,
  });
}

/** 结构快照：忽略 expandToNode / agentAddNode 写入的 collapsed:false 噪声 */
function treeSnapshot(root: MindMapNode): string {
  const normalize = (n: MindMapNode): unknown => ({
    id: n.id,
    text: n.text,
    note: n.note,
    completed: n.completed,
    style: n.style,
    children: n.children.map(normalize),
  });
  return JSON.stringify(normalize(root));
}

function makeRun(opsLabel = 'run', pacingName: PacingProfileName = 'fast'): AcrRunContext {
  const pacing = createPacer(pacingName);
  return {
    runId: `run_${opsLabel}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    sessionId: 'sess_test',
    target: { typeId: 'mindmap', resourceId: MM_ID },
    windowId: 'win_mm',
    pacing,
    reportProgress: vi.fn(),
    checkPaused: vi.fn(async () => 'resume' as const),
    ledger: runLedger,
  };
}

function opAdd(parentId: string, text: string, index?: number): AgentOp {
  return {
    kind: 'add_node',
    anchor: { parent_id: parentId },
    payload: { data: { text }, ...(index !== undefined ? { index } : {}) },
    destructive: false,
    label: `添加节点「${text}」`,
  };
}

function opDelete(nodeId: string): AgentOp {
  return {
    kind: 'delete_node',
    anchor: { node_id: nodeId },
    payload: {},
    destructive: true,
    label: `删除节点 ${nodeId}`,
  };
}

function opUpdate(nodeId: string, text: string): AgentOp {
  return {
    kind: 'update_node',
    anchor: { node_id: nodeId },
    payload: { patch: { text } },
    destructive: false,
    label: `更新节点「${text}」`,
  };
}

function opMove(nodeId: string, newParentId: string, index: number): AgentOp {
  return {
    kind: 'move_node',
    anchor: { node_id: nodeId, new_parent_id: newParentId },
    payload: { index },
    destructive: true,
    label: `移动节点 ${nodeId}`,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  useMindMapStore.getState().reset();
  vi.useRealTimers();
});

describe('mindmapDriver probe', () => {
  it('mindmapId≠resourceId → closed', () => {
    seedStore(createDocument());
    expect(mindmapDriver.probe({ typeId: 'mindmap', resourceId: 'mm_other' })).toBe('closed');
  });

  it('isDirty → dirty；editingNodeId → hot；否则 clean', () => {
    seedStore(createDocument(), { isDirty: true });
    expect(mindmapDriver.probe({ typeId: 'mindmap', resourceId: MM_ID })).toBe('dirty');

    seedStore(createDocument(), { editingNodeId: 'node_a' });
    expect(mindmapDriver.probe({ typeId: 'mindmap', resourceId: MM_ID })).toBe('hot');

    seedStore(createDocument());
    expect(mindmapDriver.probe({ typeId: 'mindmap', resourceId: MM_ID })).toBe('clean');
  });
});

describe('mindmapDriver apply + ledger round-trip', () => {
  it('add_node → revert 后树还原', async () => {
    const doc = createDocument();
    seedStore(doc);
    const before = treeSnapshot(useMindMapStore.getState().document.root);
    const run = makeRun('add');
    const receipt = await mindmapDriver.apply(run, [opAdd('node_a', 'NewChild')]);

    expect(receipt.status).toBe('completed');
    expect(receipt.applied).toBe(1);
    expect(receipt.entityIds).toHaveLength(1);
    expect(receipt.done).toEqual(['添加节点「NewChild」']);

    const newId = receipt.entityIds[0];
    const added = findNodeById(useMindMapStore.getState().document.root, newId);
    expect(added?.text).toBe('NewChild');
    expect(useMindMapStore.getState().history.past).toHaveLength(0);

    const ok = await run.ledger.revertRun(run.runId);
    expect(ok).toBe(true);
    expect(treeSnapshot(useMindMapStore.getState().document.root)).toBe(before);
  });

  it('delete_node → revert 子树还原', async () => {
    const doc = createDocument();
    seedStore(doc);
    const before = treeSnapshot(useMindMapStore.getState().document.root);
    const run = makeRun('del');
    const receipt = await mindmapDriver.apply(run, [opDelete('node_a')]);

    expect(receipt.status).toBe('completed');
    expect(receipt.applied).toBe(1);
    expect(findNodeById(useMindMapStore.getState().document.root, 'node_a')).toBeNull();
    expect(findNodeById(useMindMapStore.getState().document.root, 'node_a1')).toBeNull();

    const ok = await run.ledger.revertRun(run.runId);
    expect(ok).toBe(true);
    expect(treeSnapshot(useMindMapStore.getState().document.root)).toBe(before);
    expect(findNodeById(useMindMapStore.getState().document.root, 'node_a1a')?.text).toBe('A1a');
  });

  it('update_node + move_node 可应用；缺失锚点进 undone', async () => {
    seedStore(createDocument());
    const run = makeRun('mix');
    const receipt = await mindmapDriver.apply(run, [
      opUpdate('node_b', 'Beta2'),
      opMove('node_b', 'node_a', 0),
      opDelete('missing_node'),
    ]);

    expect(receipt.applied).toBe(2);
    expect(receipt.status).toBe('partial');
    expect(receipt.undone.some((u) => u.includes('missing_node') || u.includes('不存在'))).toBe(
      true,
    );
    expect(findNodeById(useMindMapStore.getState().document.root, 'node_b')?.text).toBe('Beta2');
    const parent = findNodeById(useMindMapStore.getState().document.root, 'node_a');
    expect(parent?.children.some((c) => c.id === 'node_b')).toBe(true);
  });

  it('destructive + dirty → suggestionPending，不改文档（R2-02 维持拒绝式）', async () => {
    const doc = createDocument();
    seedStore(doc, { isDirty: true });
    const before = treeSnapshot(useMindMapStore.getState().document.root);
    const run = makeRun('sug');
    const receipt = await mindmapDriver.apply(run, [opDelete('node_b')]);

    expect(receipt.suggestionPending).toBe(true);
    expect(receipt.mode).toBe('suggestion');
    expect(receipt.applied).toBe(0);
    expect(receipt.message).toMatch(/拒绝式|未保存编辑/);
    expect(treeSnapshot(useMindMapStore.getState().document.root)).toBe(before);
  });

  it('destructive + hot（编辑目标节点）→ suggestionPending', async () => {
    seedStore(createDocument(), { editingNodeId: 'node_a' });
    const before = treeSnapshot(useMindMapStore.getState().document.root);
    const run = makeRun('hot');
    const receipt = await mindmapDriver.apply(run, [opDelete('node_a')]);

    expect(receipt.suggestionPending).toBe(true);
    expect(receipt.applied).toBe(0);
    expect(treeSnapshot(useMindMapStore.getState().document.root)).toBe(before);
  });

  it('abort 旗标使循环退出并返回 partial', async () => {
    seedStore(createDocument());
    const run = makeRun('abort');
    let calls = 0;
    run.checkPaused = vi.fn(async () => {
      calls += 1;
      if (calls >= 2) {
        mindmapDriver.abort(run.runId);
        return 'abort' as const;
      }
      return 'resume' as const;
    });

    const receipt = await mindmapDriver.apply(run, [
      opAdd('root_test', 'One'),
      opAdd('root_test', 'Two'),
      opAdd('root_test', 'Three'),
    ]);

    expect(receipt.applied).toBeLessThan(3);
    expect(['partial', 'cancelled']).toContain(receipt.status);
    expect(receipt.undone.length).toBeGreaterThan(0);
  });
});

describe('R2-02 viewport throttle + entering + fitView', () => {
  it('normal pacing：setFocusedNodeId 按 VIEWPORT_FOLLOW_EVERY 节流；结束 requestAgentFitView', async () => {
    seedStore(createDocument());
    const setFocusedSpy = vi.spyOn(useMindMapStore.getState(), 'setFocusedNodeId');
    // spy 绑在旧 state 上；改用订阅计数
    setFocusedSpy.mockRestore();

    const focusedCalls: string[] = [];
    const unsub = useMindMapStore.subscribe((state, prev) => {
      if (state.focusedNodeId !== prev.focusedNodeId && state.focusedNodeId) {
        focusedCalls.push(state.focusedNodeId);
      }
    });

    const run = makeRun('throttle', 'normal');
    // 跳过真实等待：把 tick 换成立即 resolve，仍保留 profile.instant=false
    run.pacing.tick = vi.fn(async () => undefined);

    const ops = Array.from({ length: 5 }, (_, i) => opAdd('root_test', `N${i}`));
    const receipt = await mindmapDriver.apply(run, ops);
    unsub();

    expect(receipt.applied).toBe(5);
    expect(receipt.status).toBe('completed');

    // 节流：第 1、4 次成功 + 收尾最后实体（若未在节流点）
    // applied 1 → follow；2,3 skip；4 → follow；5 → 收尾 follow（若 last≠lastFollowed）
    expect(focusedCalls.length).toBeLessThanOrEqual(3);
    expect(focusedCalls.length).toBeGreaterThanOrEqual(2);
    // 至少包含第 1 次与第 VIEWPORT_FOLLOW_EVERY 次
    expect(focusedCalls[0]).toBe(receipt.entityIds[0]);
    if (VIEWPORT_FOLLOW_EVERY <= 5) {
      expect(focusedCalls).toContain(receipt.entityIds[VIEWPORT_FOLLOW_EVERY - 1]);
    }
    // 收尾焦点 = 最后实体
    expect(useMindMapStore.getState().focusedNodeId).toBe(
      receipt.entityIds[receipt.entityIds.length - 1],
    );
    expect(useMindMapStore.getState().agentFitViewNonce).toBe(1);

    // entering 标记存在
    for (const id of receipt.entityIds) {
      expect(useMindMapStore.getState().agentEnteringIds.has(id)).toBe(true);
    }
  });

  it('fast/instant：循环内不节流跟随；收尾一次焦点；不 requestAgentFitView', async () => {
    seedStore(createDocument());
    const focusedCalls: string[] = [];
    const unsub = useMindMapStore.subscribe((state, prev) => {
      if (state.focusedNodeId !== prev.focusedNodeId && state.focusedNodeId) {
        focusedCalls.push(state.focusedNodeId);
      }
    });

    const run = makeRun('fast thr', 'fast');
    const ops = Array.from({ length: 5 }, (_, i) => opAdd('root_test', `F${i}`));
    const receipt = await mindmapDriver.apply(run, ops);
    unsub();

    expect(receipt.applied).toBe(5);
    // instant：循环内 shouldFollow=false，仅收尾一次
    expect(focusedCalls.length).toBe(1);
    expect(focusedCalls[0]).toBe(receipt.entityIds[4]);
    expect(useMindMapStore.getState().agentFitViewNonce).toBe(0);
  });
});

describe('R2-02 singleton store dual-window defense', () => {
  it('store 加载 M_other 时对 M1 probe=closed 且 apply failed 不改树', async () => {
    const doc = createDocument();
    seedStore(doc, { mindmapId: MM_OTHER });
    const before = treeSnapshot(useMindMapStore.getState().document.root);

    expect(mindmapDriver.probe({ typeId: 'mindmap', resourceId: MM_ID })).toBe('closed');
    expect(mindmapDriver.probe({ typeId: 'mindmap', resourceId: MM_OTHER })).toBe('clean');

    const run = makeRun('dual');
    run.target = { typeId: 'mindmap', resourceId: MM_ID };
    const receipt = await mindmapDriver.apply(run, [
      opAdd('root_test', 'ShouldNotAppear'),
      opDelete('node_b'),
    ]);

    expect(receipt.status).toBe('failed');
    expect(receipt.applied).toBe(0);
    expect(receipt.undone).toHaveLength(2);
    expect(receipt.message).toMatch(/mindmapId≠resourceId|回落后端/);
    expect(treeSnapshot(useMindMapStore.getState().document.root)).toBe(before);
    expect(useMindMapStore.getState().history.past).toHaveLength(0);
  });

  it('切换 store 到目标 id 后可正常 apply', async () => {
    seedStore(createDocument(), { mindmapId: MM_OTHER });
    expect(mindmapDriver.probe({ typeId: 'mindmap', resourceId: MM_ID })).toBe('closed');

    // 模拟用户切到目标导图窗（单例 store 换载）
    seedStore(createDocument(), { mindmapId: MM_ID });
    expect(mindmapDriver.probe({ typeId: 'mindmap', resourceId: MM_ID })).toBe('clean');

    const run = makeRun('after-switch');
    const receipt = await mindmapDriver.apply(run, [opAdd('root_test', 'After')]);
    expect(receipt.status).toBe('completed');
    expect(receipt.applied).toBe(1);
  });
});
