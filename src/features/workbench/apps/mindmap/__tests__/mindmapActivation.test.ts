import { afterEach, describe, expect, it } from 'vitest';

import {
  __resetMindMapStoreRegistry,
  createMindMapStore,
  registerMindMapStore,
  type MindMapStoreApi,
} from '@/features/mindmap/store/mindmapStore';
import type { MindMapDocument } from '@/features/mindmap/types';
import { handleMindmapActivation } from '../register';

const stores: MindMapStoreApi[] = [];
const cleanup: Array<() => void> = [];

function document(label: string): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: `root_${label}`,
      text: label,
      children: [{ id: `node_${label}`, text: `${label} node`, children: [] }],
    },
    meta: { createdAt: '2026-01-01T00:00:00.000Z' },
  };
}

function mountStore(windowId: string, resourceId: string, label: string, ready = true) {
  const store = createMindMapStore();
  store.setState({
    mindmapId: ready ? resourceId : null,
    document: document(label),
    focusedNodeId: null,
    currentView: 'mindmap',
  });
  stores.push(store);
  cleanup.push(registerMindMapStore(resourceId, store, windowId));
  return store;
}

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
  for (const store of stores.splice(0)) store.getState().reset();
  __resetMindMapStoreRegistry();
});

describe('mindmap workbench activation', () => {
  it('routes commands by windowId when the same resource has two hosts', async () => {
    const first = mountStore('win_first', 'mm_same', 'first');
    const second = mountStore('win_second', 'mm_same', 'second');

    const result = await handleMindmapActivation({
      windowId: 'win_first',
      instanceKey: 'mm_same',
      action: 'focusNode',
      payload: { nodeId: 'node_first' },
    });
    expect(result).toEqual({ handled: true, acknowledged: true });
    expect(first.getState().focusedNodeId).toBe('node_first');
    expect(second.getState().focusedNodeId).toBeNull();
  });

  it('waits for the target instance to load and returns the real result', async () => {
    const store = mountStore('win_wait', 'mm_wait', 'wait', false);
    const pending = handleMindmapActivation({
      windowId: 'win_wait',
      instanceKey: 'mm_wait',
      action: 'setView',
      payload: { view: 'outline' },
    });
    store.setState({ mindmapId: 'mm_wait' });
    await expect(pending).resolves.toEqual({ handled: true, acknowledged: true });
    expect(store.getState().currentView).toBe('outline');
  });

  it('rejects a missing node without mutating focus', async () => {
    const store = mountStore('win_missing', 'mm_missing', 'missing');
    const result = await handleMindmapActivation({
      windowId: 'win_missing',
      instanceKey: 'mm_missing',
      action: 'focusNode',
      payload: { nodeId: 'does_not_exist' },
    });
    expect(result.handled).toBe(false);
    expect(result.code).toBe('NODE_NOT_FOUND');
    expect(store.getState().focusedNodeId).toBeNull();
  });
});
