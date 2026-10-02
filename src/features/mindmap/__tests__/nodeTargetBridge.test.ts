import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetMindMapStoreRegistry,
  createMindMapStore,
  registerMindMapStore,
  type MindMapStoreApi,
} from '../store/mindmapStore';
import type { MindMapDocument } from '../types';
import {
  __resetMindmapNodeTargetsForTests,
  MINDMAP_NODE_TARGET_FLASH_MS,
  MINDMAP_NODE_TARGET_TIMEOUT_MS,
  publishMindmapNodeTarget,
} from '../nodeTargetBridge';

const stores: MindMapStoreApi[] = [];
const cleanup: Array<() => void> = [];

function doc(): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root',
      text: '数据并行训练',
      children: [
        {
          id: 'b1',
          text: '数据并行',
          collapsed: true,
          children: [{ id: 'b1a', text: '梯度同步 All-Reduce', children: [] }],
        },
        { id: 'b2', text: '模型并行', children: [] },
      ],
    },
    meta: { createdAt: '2026-01-01T00:00:00.000Z' },
  };
}

function mountStore(resourceId: string, ready = true) {
  const store = createMindMapStore();
  store.setState({
    mindmapId: ready ? resourceId : null,
    document: doc(),
    focusedNodeId: null,
    selection: [],
    currentView: 'mindmap',
  });
  stores.push(store);
  cleanup.push(registerMindMapStore(resourceId, store));
  return store;
}

/** 让动态 import 的 then 回调跑完 */
async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await vi.dynamicImportSettled?.();
}

afterEach(() => {
  __resetMindmapNodeTargetsForTests();
  while (cleanup.length > 0) cleanup.pop()?.();
  for (const store of stores.splice(0)) store.getState().reset();
  __resetMindMapStoreRegistry();
  vi.useRealTimers();
});

describe('publishMindmapNodeTarget', () => {
  it('locates immediately when the mindmap is already loaded: expand, focus, select, flash', async () => {
    vi.useFakeTimers();
    const store = mountStore('mm_ready');
    publishMindmapNodeTarget({ mindmapId: 'mm_ready', text: '梯度同步 All-Reduce' });
    await flush();

    const state = store.getState();
    expect(state.focusedNodeId).toBe('b1a');
    expect(state.selection).toEqual(['b1a']);
    expect(state.document.root.children[0].collapsed).toBe(false);
    expect(state.nodeLocateRequest).toMatchObject({ nodeId: 'b1a', nonce: 1 });
    expect(state.agentUpdatedIds.has('b1a')).toBe(true);

    vi.advanceTimersByTime(MINDMAP_NODE_TARGET_FLASH_MS);
    expect(store.getState().agentUpdatedIds.has('b1a')).toBe(false);
  });

  it('waits for the instance to finish loading, then locates via chunk text', async () => {
    const store = mountStore('mm_wait', false);
    publishMindmapNodeTarget({ mindmapId: 'mm_wait', chunkText: '  模型并行' });
    await flush();
    expect(store.getState().focusedNodeId).toBeNull();

    store.setState({ mindmapId: 'mm_wait' });
    expect(store.getState().focusedNodeId).toBe('b2');
  });

  it('just opens (no focus change) when the node cannot be found', async () => {
    const store = mountStore('mm_none');
    publishMindmapNodeTarget({ mindmapId: 'mm_none', text: '量子纠缠' });
    await flush();
    expect(store.getState().focusedNodeId).toBeNull();
    expect(store.getState().nodeLocateRequest).toBeNull();
  });

  it('a newer request for the same mindmap supersedes a pending one', async () => {
    const store = mountStore('mm_dup', false);
    publishMindmapNodeTarget({ mindmapId: 'mm_dup', text: '数据并行' });
    await flush();
    publishMindmapNodeTarget({ mindmapId: 'mm_dup', text: '模型并行' });
    await flush();
    store.setState({ mindmapId: 'mm_dup' });
    expect(store.getState().focusedNodeId).toBe('b2');
    expect(store.getState().nodeLocateRequest?.nonce).toBe(1);
  });

  it('gives up after the timeout', async () => {
    vi.useFakeTimers();
    const store = mountStore('mm_slow', false);
    publishMindmapNodeTarget({ mindmapId: 'mm_slow', text: '模型并行' });
    await flush();
    vi.advanceTimersByTime(MINDMAP_NODE_TARGET_TIMEOUT_MS + 1);
    store.setState({ mindmapId: 'mm_slow' });
    expect(store.getState().focusedNodeId).toBeNull();
  });

  it('ignores requests without any hint', async () => {
    const store = mountStore('mm_empty');
    publishMindmapNodeTarget({ mindmapId: 'mm_empty', text: '  ' });
    await flush();
    expect(store.getState().nodeLocateRequest).toBeNull();
  });
});
