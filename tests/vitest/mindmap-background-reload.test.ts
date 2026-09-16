import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/features/mindmap/api/mindmapApi';
import { createMindMapStore, type MindMapStoreApi } from '@/features/mindmap/store/mindmapStore';
import type { VfsMindMap, MindMapDocument } from '@/features/mindmap/types';

vi.mock('@/features/mindmap/api/mindmapApi', () => ({
  getMindMap: vi.fn(), getMindMapContent: vi.fn(),
  createMindMap: vi.fn(), updateMindMap: vi.fn(),
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

function metadata(): VfsMindMap {
  return {
    id: 'map', resourceId: 'resource_map', title: 'Map', isFavorite: false,
    defaultView: 'mindmap', createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

let store: MindMapStoreApi;
let document: MindMapDocument;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  store = createMindMapStore();
  const initial = store.getState().document;
  document = {
    ...initial,
    root: { ...initial.root, id: 'root', text: 'Server', children: [
      { ...initial.root, id: 'child', text: 'Child', children: [] },
    ] },
  };
  vi.mocked(api.getMindMap).mockResolvedValue(metadata());
  vi.mocked(api.getMindMapContent).mockResolvedValue(JSON.stringify(document));
  await store.getState().loadMindMap('map');
});
afterEach(() => {
  store.getState().destroy();
  vi.useRealTimers();
});

function reload() {
  let resolve!: (value: VfsMindMap | null) => void;
  const response = new Promise<VfsMindMap | null>(done => { resolve = done; });
  vi.mocked(api.getMindMap).mockReturnValueOnce(response);
  const load = store.getState().loadMindMap('map', {
    preserveViewports: true, preserveLocalChanges: true,
  });
  return { load, finish: () => resolve(metadata()) };
}

describe('mindmap background reload', () => {
  it('preserves edits made while an external reload is pending', async () => {
    const pending = reload();
    store.getState().setDocument({ ...document, root: { ...document.root, text: 'Local edit' } });
    const edited = store.getState().document;
    pending.finish();
    await pending.load;
    expect(store.getState().document).toBe(edited);
    expect(store.getState().isDirty).toBe(true);
    expect(store.getState().history.past.length).toBeGreaterThan(0);
  });

  it.each(['text', 'note'] as const)('keeps an uncommitted %s editor open during reload', async editor => {
    const pending = reload();
    if (editor === 'text') store.getState().setEditingNodeId('root');
    else store.getState().setEditingNoteNodeId('root');
    const original = store.getState().document;
    pending.finish();
    await pending.load;
    expect(store.getState().document).toBe(original);
    if (editor === 'text') expect(store.getState().editingNodeId).toBe('root');
    else expect(store.getState().editingNoteNodeId).toBe('root');
  });

  it('does not start a background fetch for an already dirty document', async () => {
    store.getState().setDocument({ ...document, root: { ...document.root, text: 'Local edit' } });
    await store.getState().loadMindMap('map', { preserveLocalChanges: true });
    expect(api.getMindMap).toHaveBeenCalledTimes(1);
    expect(store.getState().document.root.text).toBe('Local edit');
    expect(store.getState().isDirty).toBe(true);
  });

  it('preserves view and focus selected while a reload is pending', async () => {
    const pending = reload();
    store.getState().setCurrentView('outline');
    store.getState().setFocusedNodeId('child');
    pending.finish();
    await pending.load;
    expect(store.getState().currentView).toBe('outline');
    expect(store.getState().focusedNodeId).toBe('child');
    expect(store.getState().isDirty).toBe(false);
  });

  it('clears a preserved focus when its node was deleted remotely', async () => {
    store.getState().setFocusedNodeId('child');
    vi.mocked(api.getMindMapContent).mockResolvedValueOnce(JSON.stringify({
      ...document, root: { ...document.root, children: [] },
    }));
    const pending = reload();
    pending.finish();
    await pending.load;
    expect(store.getState().document.root.children).toEqual([]);
    expect(store.getState().focusedNodeId).toBeNull();
  });
});
