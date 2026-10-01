/**
 * ChunkBuffer 行为测试
 *
 * 覆盖与本仓库性能调优直接相关的语义：
 * - 时间窗口合批：窗口内多个 chunk 合并为一次 store 更新
 * - 容量上限立即冲刷（不等窗口）
 * - 多会话隔离：chunk 按 sessionId 分流，不串流
 * - flushAndCleanupSession：终态冲刷并清理
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createChunkBuffer } from '../chunkBuffer';
import { CHUNK_BUFFER_WINDOW_MS, CHUNK_MAX_BUFFER_SIZE } from '../../constants';

interface FakeStore {
  sessionId: string;
  updateBlockContent: ReturnType<typeof vi.fn>;
  batchUpdateBlockContent: ReturnType<typeof vi.fn>;
}

function makeStore(sessionId: string): FakeStore {
  return {
    sessionId,
    updateBlockContent: vi.fn(),
    batchUpdateBlockContent: vi.fn(),
  };
}

describe('chunkBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces multiple chunks in one window into a single batched store update', () => {
    const buffer = createChunkBuffer();
    const store = makeStore('s1');
    buffer.setStore(store as any);

    buffer.push('b1', 'Hello ', 's1');
    buffer.push('b1', 'world', 's1');
    buffer.push('b2', 'thinking...', 's1');

    // 窗口未到：尚无更新
    expect(store.batchUpdateBlockContent).not.toHaveBeenCalled();

    vi.advanceTimersByTime(CHUNK_BUFFER_WINDOW_MS + 1);

    expect(store.batchUpdateBlockContent).toHaveBeenCalledTimes(1);
    const updates = store.batchUpdateBlockContent.mock.calls[0][0];
    expect(updates).toEqual([
      { blockId: 'b1', content: 'Hello world' },
      { blockId: 'b2', content: 'thinking...' },
    ]);
    expect(store.updateBlockContent).not.toHaveBeenCalled();
  });

  it('window is 120ms after the streaming-rate tuning', () => {
    // 固化调优值：防止后续改动无意把窗口调回高频
    expect(CHUNK_BUFFER_WINDOW_MS).toBe(120);
  });

  it('flushes immediately when the buffer reaches the size cap', () => {
    const buffer = createChunkBuffer();
    const store = makeStore('s1');
    buffer.setStore(store as any);

    const big = 'x'.repeat(CHUNK_MAX_BUFFER_SIZE);
    buffer.push('b1', big, 's1');

    // 不需要推进定时器：达到容量立即走 flushBlock
    expect(store.updateBlockContent).toHaveBeenCalledTimes(1);
    expect(store.updateBlockContent).toHaveBeenCalledWith('b1', big);
    expect(store.batchUpdateBlockContent).not.toHaveBeenCalled();
  });

  it('keeps sessions isolated', () => {
    const buffer = createChunkBuffer();
    const storeA = makeStore('sa');
    const storeB = makeStore('sb');
    buffer.setStore(storeA as any);
    buffer.setStore(storeB as any);

    buffer.push('b1', 'for-a', 'sa');
    buffer.push('b1', 'for-b', 'sb');

    vi.advanceTimersByTime(CHUNK_BUFFER_WINDOW_MS + 1);

    expect(storeA.batchUpdateBlockContent).toHaveBeenCalledWith([
      { blockId: 'b1', content: 'for-a' },
    ]);
    expect(storeB.batchUpdateBlockContent).toHaveBeenCalledWith([
      { blockId: 'b1', content: 'for-b' },
    ]);
  });

  it('flushAndCleanupSession flushes pending content and removes the session', () => {
    const buffer = createChunkBuffer();
    const store = makeStore('s1');
    buffer.setStore(store as any);

    buffer.push('b1', 'tail', 's1');
    buffer.flushAndCleanupSession('s1');

    expect(store.batchUpdateBlockContent).toHaveBeenCalledWith([
      { blockId: 'b1', content: 'tail' },
    ]);

    // 会话已清理：后续 push 落到未知会话，告警且不写 store
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    store.batchUpdateBlockContent.mockClear();
    buffer.push('b1', 'late', 's1');
    vi.advanceTimersByTime(CHUNK_BUFFER_WINDOW_MS * 2);
    expect(store.batchUpdateBlockContent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back to per-block updateBlockContent when batch action is unavailable', () => {
    const buffer = createChunkBuffer();
    const store = makeStore('s1');
    store.batchUpdateBlockContent = undefined as any;
    buffer.setStore(store as any);

    buffer.push('b1', 'a', 's1');
    buffer.push('b2', 'b', 's1');

    vi.advanceTimersByTime(CHUNK_BUFFER_WINDOW_MS + 1);

    expect(store.updateBlockContent).toHaveBeenCalledTimes(2);
    expect(store.updateBlockContent).toHaveBeenNthCalledWith(1, 'b1', 'a');
    expect(store.updateBlockContent).toHaveBeenNthCalledWith(2, 'b2', 'b');
  });
});
