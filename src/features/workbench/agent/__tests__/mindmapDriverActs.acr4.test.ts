/**
 * ACR 4.0 A4 — mindmapDriver 演出增强：
 * 1. delete_node 先标记 agentExitingIds（整棵子树）→ 播 ~180ms 退场动画 → 才真正删除；
 *    abort/instant 路径不悬挂、不误删；
 * 2. update_node 走 agentUpdatedIds（内容更新高亮），与 entering（新增=滑入）语义区分；
 * 3. 拒绝式建议回执 message 为指令式诚实文案（LLM 不应等待确认回执）。
 * 使用真实定时器（jsdom 内测状态与标记集合，不测真实动画帧）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerMindMapStore,
  useMindMapStore,
} from '@/features/mindmap/store/mindmapStore';
import type { MindMapDocument } from '@/features/mindmap/types';
import { findNodeById } from '@/features/mindmap/utils/node/find';
import { runLedger } from '../ledger';
import { createPacer } from '../pacing';
import {
  AGENT_EXITING_MS,
  collectSubtreeIds,
  mindmapDriver,
  SUGGESTION_MESSAGE,
} from '../drivers/mindmapDriver';
import type { AcrRunContext, AgentOp, PacingProfileName } from '../types';

const MM_ID = 'mm_acr4_a4';
let unregisterDriverStore = () => undefined;

function createDocument(): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root',
      text: 'Root',
      children: [
        {
          id: 'node_a',
          text: 'Alpha',
          children: [{ id: 'node_a1', text: 'A1', children: [] }],
        },
        { id: 'node_b', text: 'Beta', children: [] },
      ],
    },
    meta: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

function seedStore(overrides?: { isDirty?: boolean }) {
  const save = vi.fn(async () => {
    useMindMapStore.setState({ isDirty: false, isSaving: false });
    return true;
  });
  useMindMapStore.setState({
    mindmapId: MM_ID,
    metadata: null,
    document: JSON.parse(JSON.stringify(createDocument())) as MindMapDocument,
    focusedNodeId: null,
    editingNodeId: null,
    selection: [],
    history: { past: [], future: [] },
    isDirty: overrides?.isDirty ?? false,
    isSaving: false,
    lastSavedAt: null,
    _documentVersion: 0,
    viewports: {},
    agentEnteringIds: new Set(),
    agentExitingIds: new Set(),
    agentUpdatedIds: new Set(),
    agentFitViewNonce: 0,
    save,
  });
  return save;
}

function makeRun(label: string, pacingName: PacingProfileName = 'normal'): AcrRunContext {
  const pacing = createPacer(pacingName);
  // 只保留退场等待的真实耗时，op 间节拍立即返回
  pacing.tick = vi.fn(async () => undefined);
  return {
    runId: `run_${label}_${Math.random().toString(36).slice(2, 7)}`,
    sessionId: 'sess_acr4',
    target: { typeId: 'mindmap', resourceId: MM_ID },
    windowId: 'win_mm',
    pacing,
    reportProgress: vi.fn(),
    checkPaused: vi.fn(async () => 'resume' as const),
    ledger: runLedger,
  };
}

beforeEach(() => {
  unregisterDriverStore = registerMindMapStore(
    MM_ID,
    useMindMapStore,
    `win_mm:mindmap:${MM_ID}`,
  );
  seedStore();
});

afterEach(() => {
  unregisterDriverStore();
  useMindMapStore.getState().reset();
});

describe('collectSubtreeIds', () => {
  it('返回目标节点及全部后代；缺失节点返回空', () => {
    const root = useMindMapStore.getState().document.root;
    expect(new Set(collectSubtreeIds(root, 'node_a'))).toEqual(
      new Set(['node_a', 'node_a1']),
    );
    expect(collectSubtreeIds(root, 'missing')).toEqual([]);
  });
});

describe('delete_node 退场动画（agentExitingIds）', () => {
  const deleteOp: AgentOp = {
    kind: 'delete_node',
    anchor: { node_id: 'node_a' },
    payload: {},
    destructive: true,
    label: '删除 Alpha',
  };

  it('normal 档：删除前标记整棵子树退场，删除后清除标记', async () => {
    const exitSnapshots: string[][] = [];
    const unsub = useMindMapStore.subscribe((state, prev) => {
      if (state.agentExitingIds !== prev.agentExitingIds) {
        exitSnapshots.push([...state.agentExitingIds]);
      }
    });

    const started = Date.now();
    const receipt = await mindmapDriver.apply(makeRun('exit'), [deleteOp]);
    const elapsed = Date.now() - started;
    unsub();

    expect(receipt.status).toBe('completed');
    expect(receipt.applied).toBe(1);
    // 删除已真正发生
    expect(findNodeById(useMindMapStore.getState().document.root, 'node_a')).toBeNull();
    // 动画期间曾标记 node_a + node_a1，收尾已清空
    expect(exitSnapshots.length).toBeGreaterThanOrEqual(2);
    expect(new Set(exitSnapshots[0])).toEqual(new Set(['node_a', 'node_a1']));
    expect(useMindMapStore.getState().agentExitingIds.size).toBe(0);
    // 至少 await 了一个退场动画时长
    expect(elapsed).toBeGreaterThanOrEqual(AGENT_EXITING_MS - 20);
  });

  it('退场等待期间 abort → 不删除节点、清除标记、回执 cancelled', async () => {
    const run = makeRun('exit-abort');
    setTimeout(() => {
      mindmapDriver.abort(run.runId);
    }, 40);

    const receipt = await mindmapDriver.apply(run, [deleteOp]);

    expect(receipt.status).toBe('cancelled');
    expect(receipt.applied).toBe(0);
    expect(receipt.undone).toContain('删除 Alpha');
    expect(findNodeById(useMindMapStore.getState().document.root, 'node_a')).not.toBeNull();
    expect(useMindMapStore.getState().agentExitingIds.size).toBe(0);
  });

  it('fast/instant（含 reduced-motion 强制 fast）→ 不标记、直接删除', async () => {
    const exitSnapshots: string[][] = [];
    const unsub = useMindMapStore.subscribe((state, prev) => {
      if (state.agentExitingIds !== prev.agentExitingIds) {
        exitSnapshots.push([...state.agentExitingIds]);
      }
    });

    const receipt = await mindmapDriver.apply(makeRun('exit-fast', 'fast'), [deleteOp]);
    unsub();

    expect(receipt.status).toBe('completed');
    expect(exitSnapshots).toHaveLength(0);
    expect(findNodeById(useMindMapStore.getState().document.root, 'node_a')).toBeNull();
  });
});

describe('update_node 更新高亮（agentUpdatedIds，与 entering 区分）', () => {
  it('update → 只进 agentUpdatedIds；add → 只进 agentEnteringIds', async () => {
    const receipt = await mindmapDriver.apply(makeRun('update'), [
      {
        kind: 'update_node',
        anchor: { node_id: 'node_b' },
        payload: { patch: { text: 'Beta v2' } },
        destructive: false,
        label: '更新 Beta',
      },
      {
        kind: 'add_node',
        anchor: { parent_id: 'root' },
        payload: { data: { text: 'Gamma' } },
        destructive: false,
        label: '添加 Gamma',
      },
    ]);

    expect(receipt.status).toBe('completed');
    expect(receipt.applied).toBe(2);
    const state = useMindMapStore.getState();
    expect(state.agentUpdatedIds.has('node_b')).toBe(true);
    expect(state.agentEnteringIds.has('node_b')).toBe(false);
    const addedId = receipt.entityIds.find((id) => id !== 'node_b')!;
    expect(state.agentEnteringIds.has(addedId)).toBe(true);
    expect(state.agentUpdatedIds.has(addedId)).toBe(false);
    expect(findNodeById(state.document.root, 'node_b')?.text).toBe('Beta v2');
  });
});

describe('拒绝式建议回执的诚实指令式文案', () => {
  it('dirty + delete → message 明示不会有确认回执、给出替代路径', async () => {
    seedStore({ isDirty: true });
    const receipt = await mindmapDriver.apply(makeRun('suggestion'), [
      {
        kind: 'delete_node',
        anchor: { node_id: 'node_b' },
        payload: {},
        destructive: true,
        label: '删除 Beta',
      },
    ]);

    expect(receipt.mode).toBe('suggestion');
    expect(receipt.suggestionPending).toBe(true);
    expect(receipt.message).toBe(SUGGESTION_MESSAGE);
    // 指令式要素：不发生、无回执勿等待、替代路径
    expect(receipt.message).toContain('用户未确认前这些操作不会发生');
    expect(receipt.message).toContain('不会有后续回执');
    expect(receipt.message).toContain('后端数据路径');
    // 文档未被改动
    expect(findNodeById(useMindMapStore.getState().document.root, 'node_b')).not.toBeNull();
    // dirty 屏障不播退场动画
    expect(useMindMapStore.getState().agentExitingIds.size).toBe(0);
  });
});
