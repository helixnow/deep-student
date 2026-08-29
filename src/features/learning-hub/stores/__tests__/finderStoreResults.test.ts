import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu/types';

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  search: vi.fn(),
}));

vi.mock('@/dstu', () => ({
  folderApi: { getBreadcrumbs: vi.fn(async () => ({ ok: true, value: [] })) },
  trashApi: { listTrash: vi.fn(async () => ({ ok: true, value: [] })) },
}));

vi.mock('@/dstu/api', () => ({
  dstu: {
    list: apiMocks.list,
    search: apiMocks.search,
    searchInFolder: vi.fn(),
    listDeleted: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock('@/shared/result', () => ({ reportError: vi.fn() }));
vi.mock('@/i18n', () => ({ default: { language: 'en-US' } }));

import { useFinderStore } from '../finderStore';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function node(id: string, size: number): DstuNode {
  return {
    id,
    path: `/${id}`,
    name: id,
    type: 'file',
    size,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('finderStore result handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFinderStore.getState().reset();
    useFinderStore.setState({
      sortBy: 'updatedAt',
      sortOrder: 'desc',
      isLoading: false,
      error: null,
    });
  });

  it('applies Finder front-end sorting to search results', async () => {
    apiMocks.search.mockResolvedValue({
      ok: true,
      value: [node('large', 300), node('small', 10), node('medium', 80)],
    });
    useFinderStore.setState({
      searchQuery: 'file',
      isSearching: true,
      sortBy: 'size',
      sortOrder: 'asc',
    });

    await useFinderStore.getState().executeSearch();

    expect(apiMocks.search).toHaveBeenCalledWith(
      'file',
      expect.objectContaining({ sortBy: 'name', sortOrder: 'asc' }),
    );
    expect(useFinderStore.getState().items.map((item) => item.id)).toEqual([
      'small',
      'medium',
      'large',
    ]);
  });

  it('ignores a stale load failure after a newer load has started', async () => {
    const staleLoad = deferred<{ ok: false; error: { message: string } }>();
    const currentLoad = deferred<{ ok: true; value: DstuNode[] }>();
    apiMocks.list
      .mockReturnValueOnce(staleLoad.promise)
      .mockReturnValueOnce(currentLoad.promise);

    const preserved = node('preserved', 1);
    useFinderStore.setState({ items: [preserved] });

    const stalePromise = useFinderStore.getState().loadItems();
    const currentPromise = useFinderStore.getState().loadItems();

    staleLoad.resolve({ ok: false, error: { message: 'stale failure' } });
    await stalePromise;

    expect(useFinderStore.getState()).toMatchObject({
      items: [preserved],
      error: null,
      isLoading: true,
    });

    const fresh = node('fresh', 2);
    currentLoad.resolve({ ok: true, value: [fresh] });
    await currentPromise;

    expect(useFinderStore.getState()).toMatchObject({
      items: [fresh],
      error: null,
      isLoading: false,
    });
  });
});
