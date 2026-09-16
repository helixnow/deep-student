import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/features/mindmap/api/mindmapApi';
import { createMindMapStore, type MindMapStoreApi } from '@/features/mindmap/store/mindmapStore';
import type { VfsMindMap } from '@/features/mindmap/types';

vi.mock('@/features/mindmap/api/mindmapApi', () => ({
  getMindMap: vi.fn(),
  getMindMapContent: vi.fn(),
  createMindMap: vi.fn(),
  updateMindMap: vi.fn(),
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function metadata(id: string): VfsMindMap {
  return {
    id, resourceId: `resource_${id}`, title: id, isFavorite: false,
    defaultView: 'mindmap', createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

let store: MindMapStoreApi;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  store = createMindMapStore();
  vi.mocked(api.getMindMap).mockImplementation(async id => metadata(id));
  vi.mocked(api.getMindMapContent).mockResolvedValue(null);
});
afterEach(() => {
  store.getState().destroy();
  vi.useRealTimers();
});

describe('mindmap asynchronous ownership', () => {
  it.each(['reset', 'destroy'] as const)('invalidates pending loads on %s', async action => {
    const response = deferred<VfsMindMap | null>();
    vi.mocked(api.getMindMap).mockReturnValueOnce(response.promise);
    const load = store.getState().loadMindMap('old');
    store.getState()[action]();
    response.resolve(metadata('old'));
    await load;
    expect(store.getState().mindmapId).toBeNull();
  });

  it('does not reuse a load sequence after reset', async () => {
    const response = deferred<VfsMindMap | null>();
    vi.mocked(api.getMindMap).mockReturnValueOnce(response.promise);
    const oldLoad = store.getState().loadMindMap('old');
    store.getState().reset();
    await store.getState().loadMindMap('new');
    response.resolve(metadata('old'));
    await oldLoad;
    expect(store.getState().mindmapId).toBe('new');
  });

  it('ignores an obsolete load failure', async () => {
    const response = deferred<VfsMindMap | null>();
    vi.mocked(api.getMindMap).mockReturnValueOnce(response.promise);
    const load = store.getState().loadMindMap('old');
    await store.getState().loadMindMap('new');
    response.reject(new Error('old request failed'));
    await expect(load).resolves.toBeUndefined();
    expect(store.getState().mindmapId).toBe('new');
  });

  it('does not publish a creation after a newer load', async () => {
    const response = deferred<VfsMindMap>();
    vi.mocked(api.createMindMap).mockReturnValueOnce(response.promise);
    const creation = store.getState().createNewMindMap('created');
    await store.getState().loadMindMap('new');
    response.resolve(metadata('created'));
    await expect(creation).resolves.toBe('created');
    expect(store.getState().mindmapId).toBe('new');
  });

  it('does not let a pending load replace a newly created document', async () => {
    const response = deferred<VfsMindMap | null>();
    vi.mocked(api.getMindMap).mockReturnValueOnce(response.promise);
    const load = store.getState().loadMindMap('old');
    vi.mocked(api.createMindMap).mockResolvedValueOnce(metadata('created'));
    await store.getState().createNewMindMap('created');
    response.resolve(metadata('old'));
    await load;
    expect(store.getState().mindmapId).toBe('created');
  });

  it.each(['resolve', 'reject'] as const)('does not change a reloaded document when an old save %ss', async outcome => {
    await store.getState().loadMindMap('same');
    store.setState({ isDirty: true, _documentVersion: 1 });
    const response = deferred<VfsMindMap>();
    vi.mocked(api.updateMindMap).mockReturnValueOnce(response.promise);
    const save = store.getState().save();
    await store.getState().loadMindMap('same');
    store.setState({ isDirty: true, isSaving: true, _documentVersion: 1 });
    const currentMetadata = store.getState().metadata;
    if (outcome === 'resolve') response.resolve({ ...metadata('same'), title: 'obsolete' });
    else response.reject(new Error('MINDMAP_UPDATE_CONFLICT'));
    await save;
    expect(store.getState().isDirty).toBe(true);
    expect(store.getState().isSaving).toBe(true);
    expect(store.getState().lastSavedAt).toBeNull();
    expect(store.getState().metadata).toBe(currentMetadata);
    expect(api.getMindMap).toHaveBeenCalledTimes(2);
  });
});
