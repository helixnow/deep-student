import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu';

const { list, setFavorite } = vi.hoisted(() => ({
  list: vi.fn(),
  setFavorite: vi.fn(),
}));

vi.mock('@/dstu', () => ({
  dstu: { list, setFavorite },
}));

import { useNoteFavorites } from '../hooks/useNoteFavorites';

function node(overrides: Partial<DstuNode> = {}): DstuNode {
  return {
    id: 'note_1',
    sourceId: 'note_1',
    path: '/course/note_1',
    name: 'Algebra',
    type: 'note',
    createdAt: 1,
    updatedAt: 10,
    metadata: { isFavorite: true },
    ...overrides,
  };
}

describe('useNoteFavorites', () => {
  beforeEach(() => {
    list.mockReset();
    setFavorite.mockReset();
    list.mockResolvedValue({ ok: true, value: [] });
    setFavorite.mockResolvedValue({ ok: true, value: undefined });
  });

  it('lists favorites via dstu isFavorite filter and keeps note/mindmap only', async () => {
    list.mockResolvedValueOnce({
      ok: true,
      value: [
        node(),
        node({
          id: 'mindmap_2',
          sourceId: 'mindmap_2',
          path: '/course/mindmap_2',
          name: 'Map',
          type: 'mindmap',
          updatedAt: 20,
        }),
        node({
          id: 'essay_3',
          sourceId: 'essay_3',
          path: '/course/essay_3',
          name: 'Essay',
          type: 'essay',
          updatedAt: 30,
        }),
      ],
    });

    const { result } = renderHook(() => useNoteFavorites());
    await act(async () => {
      await result.current.refresh();
    });

    expect(list).toHaveBeenCalledWith('/', { isFavorite: true });
    expect(result.current.items.map((item) => item.id)).toEqual(['mindmap_2', 'note_1']);
    expect(result.current.error).toBeNull();
  });

  it('optimistically adds on toggle and keeps state when API succeeds', async () => {
    let resolveSet!: (value: { ok: true; value: undefined }) => void;
    setFavorite.mockReturnValueOnce(new Promise((resolve) => {
      resolveSet = resolve;
    }));

    const { result } = renderHook(() => useNoteFavorites());

    let togglePromise: Promise<boolean | null>;
    await act(async () => {
      togglePromise = result.current.toggle('note_9', 'note');
    });
    expect(result.current.items.some((item) => item.id === 'note_9')).toBe(true);

    let next: boolean | null = null;
    await act(async () => {
      resolveSet({ ok: true, value: undefined });
      next = await togglePromise!;
    });

    expect(next).toBe(true);
    expect(setFavorite).toHaveBeenCalledWith('/note_9', true);
    expect(result.current.items).toHaveLength(1);
  });

  it('rolls back optimistic remove when setFavorite fails', async () => {
    list.mockResolvedValueOnce({
      ok: true,
      value: [node()],
    });
    setFavorite.mockResolvedValueOnce({
      ok: false,
      error: { toUserMessage: () => 'fail' },
    });

    const { result } = renderHook(() => useNoteFavorites());
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.items).toHaveLength(1);

    let next: boolean | null = true;
    await act(async () => {
      next = await result.current.toggle('note_1', 'note');
    });

    expect(next).toBeNull();
    expect(setFavorite).toHaveBeenCalledWith('/course/note_1', false);
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].id).toBe('note_1');
    expect(result.current.error).toBe('fail');
  });

  it('setFavorite(false) removes immediately then confirms with API', async () => {
    let resolveSet!: (value: { ok: true; value: undefined }) => void;
    setFavorite.mockReturnValueOnce(new Promise((resolve) => {
      resolveSet = resolve;
    }));
    list.mockResolvedValueOnce({
      ok: true,
      value: [node()],
    });

    const { result } = renderHook(() => useNoteFavorites());
    await act(async () => {
      await result.current.refresh();
    });

    let setPromise: Promise<boolean>;
    await act(async () => {
      setPromise = result.current.setFavorite('note_1', 'note', false);
    });
    expect(result.current.items).toHaveLength(0);

    await act(async () => {
      resolveSet({ ok: true, value: undefined });
      await expect(setPromise!).resolves.toBe(true);
    });

    expect(setFavorite).toHaveBeenCalledWith('/course/note_1', false);
  });
});
