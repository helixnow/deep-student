/**
 * wikilinkNotesCache 生命周期单测（B3/B4）：
 * - 分页拉取突破单页 2000 上限
 * - dstu.watch 事件驱动的重命名 / 删除同步
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/dstu/adapters/notesDstuAdapter', () => ({
  notesDstuAdapter: {
    listNotes: vi.fn(),
  },
}));

vi.mock('@/dstu', () => ({
  dstu: {
    watch: vi.fn(() => () => {}),
  },
}));

import { notesDstuAdapter } from '@/dstu/adapters/notesDstuAdapter';
import { dstu } from '@/dstu';
import type { DstuWatchEvent } from '@/dstu/types';
import {
  getWikilinkNotesCache,
  isWikilinkNotesCacheTruncated,
  refreshWikilinkNotesCache,
  removeWikilinkNoteFromCache,
  resolveWikilinkTarget,
} from '../wikilinkNotesCache';

const PAGE_SIZE = 1000;

function makePage(offset: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `note_${offset + i}`,
    name: `Note ${offset + i}`,
    path: `/folder/note_${offset + i}`,
    type: 'note',
    updatedAt: offset + i,
  }));
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe('refreshWikilinkNotesCache pagination', () => {
  beforeEach(() => {
    vi.mocked(notesDstuAdapter.listNotes).mockReset();
  });

  it('pages through listNotes until a partial page arrives (beyond 2000)', async () => {
    vi.mocked(notesDstuAdapter.listNotes).mockImplementation(async (options) => {
      const offset = options?.offset ?? 0;
      const count = offset < PAGE_SIZE * 2 ? PAGE_SIZE : 500;
      return { ok: true, value: makePage(offset, count) } as never;
    });

    await refreshWikilinkNotesCache();

    expect(notesDstuAdapter.listNotes).toHaveBeenCalledTimes(3);
    expect(notesDstuAdapter.listNotes).toHaveBeenNthCalledWith(1, { limit: PAGE_SIZE, offset: 0 });
    expect(notesDstuAdapter.listNotes).toHaveBeenNthCalledWith(2, { limit: PAGE_SIZE, offset: PAGE_SIZE });
    expect(notesDstuAdapter.listNotes).toHaveBeenNthCalledWith(3, { limit: PAGE_SIZE, offset: PAGE_SIZE * 2 });
    expect(getWikilinkNotesCache()).toHaveLength(2500);
    expect(isWikilinkNotesCacheTruncated()).toBe(false);
    // 第 2001+ 篇也可解析（旧实现固定 limit 2000 会漏掉）
    expect(resolveWikilinkTarget('Note 2400')).toEqual({
      resolved: true,
      noteId: 'note_2400',
    });
  });

  it('keeps the previous cache when the first page fails', async () => {
    vi.mocked(notesDstuAdapter.listNotes).mockResolvedValue({
      ok: false,
      error: { toUserMessage: () => 'boom' },
    } as never);

    const before = getWikilinkNotesCache();
    await refreshWikilinkNotesCache();
    expect(getWikilinkNotesCache()).toBe(before);
  });
});

describe('dstu.watch driven lifecycle', () => {
  function getWatchHandler(): (event: DstuWatchEvent) => void {
    const call = vi.mocked(dstu.watch).mock.calls[0];
    expect(call?.[0]).toBe('*');
    return call![1] as (event: DstuWatchEvent) => void;
  }

  it('starts a single global watcher on first refresh', async () => {
    vi.mocked(notesDstuAdapter.listNotes).mockResolvedValue({ ok: true, value: [] } as never);
    await refreshWikilinkNotesCache();
    await flushMicrotasks();
    await refreshWikilinkNotesCache();
    await flushMicrotasks();
    expect(vi.mocked(dstu.watch)).toHaveBeenCalledTimes(1);
  });

  it('upserts on rename (updated) events and removes on delete', async () => {
    vi.mocked(notesDstuAdapter.listNotes).mockResolvedValue({
      ok: true,
      value: [{ id: 'n1', name: 'Old title', path: '/n1', type: 'note', updatedAt: 1 }],
    } as never);
    await refreshWikilinkNotesCache();
    await flushMicrotasks();
    expect(resolveWikilinkTarget('Old title').noteId).toBe('n1');

    const handler = getWatchHandler();

    // 重命名：updated 事件携带新 name → 旧标题失效、新标题可解析
    handler({
      type: 'updated',
      path: '/n1',
      node: { id: 'n1', name: 'New title', path: '/n1', type: 'note', updatedAt: 2 } as never,
    });
    expect(resolveWikilinkTarget('New title').noteId).toBe('n1');
    expect(resolveWikilinkTarget('Old title').resolved).toBe(false);

    // 非笔记资源事件不进缓存
    handler({
      type: 'created',
      path: '/m1',
      node: { id: 'm1', name: 'Mindmap', path: '/m1', type: 'mindmap', updatedAt: 3 } as never,
    });
    expect(resolveWikilinkTarget('Mindmap').resolved).toBe(false);

    // 删除：按路径末段移除
    handler({ type: 'deleted', path: '/n1' });
    expect(resolveWikilinkTarget('New title').resolved).toBe(false);
  });

  it('removeWikilinkNoteFromCache is a no-op for unknown ids', () => {
    const before = getWikilinkNotesCache();
    removeWikilinkNoteFromCache('missing-id');
    expect(getWikilinkNotesCache()).toBe(before);
  });
});
