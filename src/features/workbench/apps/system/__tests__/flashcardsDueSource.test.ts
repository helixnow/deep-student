/**
 * flashcardsDueSource — fsrs_get_due 轮询与 badge 行为
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn(async () => null as unknown) }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import {
  FLASHCARDS_DUE_INSTANCE_KEY,
  flashcardsDueBadgeSource,
  flashcardsDueProjectionSource,
  getFlashcardsDueCount,
  refreshFlashcardsDueCount,
  startFlashcardsDueWatcher,
  stopFlashcardsDueWatcher,
  subscribeFlashcardsDueCount,
} from '../flashcardsDueSource';

describe('flashcardsDueSource', () => {
  beforeEach(async () => {
    stopFlashcardsDueWatcher();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    await refreshFlashcardsDueCount();
  });

  afterEach(() => {
    stopFlashcardsDueWatcher();
  });

  it('dueCount = fsrs_get_due 数组长度；badge 为 count；归零后 badge 消失', async () => {
    invokeMock.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    await refreshFlashcardsDueCount();
    expect(invokeMock).toHaveBeenCalledWith('fsrs_get_due', { limit: 50 });
    expect(getFlashcardsDueCount()).toBe(3);
    expect(flashcardsDueBadgeSource()).toEqual({ kind: 'count', value: 3 });

    invokeMock.mockResolvedValue([]);
    await refreshFlashcardsDueCount();
    expect(getFlashcardsDueCount()).toBe(0);
    expect(flashcardsDueBadgeSource()).toBeNull();
  });

  it('invoke 失败不抛错，保持上次计数', async () => {
    invokeMock.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    await refreshFlashcardsDueCount();
    expect(getFlashcardsDueCount()).toBe(2);

    invokeMock.mockRejectedValue(new Error('no backend'));
    await expect(refreshFlashcardsDueCount()).resolves.toBeUndefined();
    expect(getFlashcardsDueCount()).toBe(2);
  });

  it('非数组返回保持上次计数', async () => {
    invokeMock.mockResolvedValue([{ id: 'a' }]);
    await refreshFlashcardsDueCount();
    expect(getFlashcardsDueCount()).toBe(1);

    invokeMock.mockResolvedValue(null);
    await refreshFlashcardsDueCount();
    expect(getFlashcardsDueCount()).toBe(1);
  });

  it('projection source 为 badge-only：subscribe 启动 watcher 并按计数产出 0/1 个实例', async () => {
    expect(flashcardsDueProjectionSource.projectWindows).toBe(false);

    invokeMock.mockResolvedValue([{ id: 'a' }]);
    const notify = vi.fn();
    const unsubscribe = flashcardsDueProjectionSource.subscribe(notify);
    expect(notify).toHaveBeenCalledWith([]);

    await refreshFlashcardsDueCount();
    expect(notify).toHaveBeenLastCalledWith([
      expect.objectContaining({ instanceKey: FLASHCARDS_DUE_INSTANCE_KEY }),
    ]);

    invokeMock.mockResolvedValue([]);
    await refreshFlashcardsDueCount();
    expect(notify).toHaveBeenLastCalledWith([]);

    unsubscribe();
  });

  it('无订阅者时 stop；有订阅者时 start 幂等且立即刷新', async () => {
    invokeMock.mockResolvedValue([{ id: 'x' }]);
    const unsub = subscribeFlashcardsDueCount(() => {});
    await refreshFlashcardsDueCount();
    expect(getFlashcardsDueCount()).toBe(1);

    // 幂等 start 不重复开多个 interval（再调一次不应抛错）
    startFlashcardsDueWatcher();
    startFlashcardsDueWatcher();

    unsub();
    // 退订后 stop；再次 refresh 仍可用（手动）
    invokeMock.mockResolvedValue([{ id: 'y' }, { id: 'z' }]);
    await refreshFlashcardsDueCount();
    expect(getFlashcardsDueCount()).toBe(2);
  });
});
