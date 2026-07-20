/**
 * useSessionSearch —— 会话元信息搜索 Hook 单元测试
 *
 * 覆盖：
 * - enabled=false / 空查询时不发请求
 * - 去抖后携带 trim 过的 query 与 limit=100 调用 chat_v2_search_sessions
 * - 查询清空时重置 results 并作废 in-flight 请求
 * - 请求代数：过期响应不得覆盖新查询的结果
 * - 请求失败时静默降级为空结果
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/features/chat/api/sessionBrowserApi', () => ({
  searchChatSessions: vi.fn(),
}));

import { searchChatSessions } from '@/features/chat/api/sessionBrowserApi';
import { useSessionSearch } from '@/features/chat/components/session-browser/useSessionSearch';
import type { ChatSession } from '@/features/chat/types/session';

const mockedSearch = vi.mocked(searchChatSessions);

const makeSession = (id: string, title: string): ChatSession => ({
  id,
  mode: 'chat',
  title,
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
} as ChatSession);

/** 可手动 resolve 的 deferred，用于模拟慢请求 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// debounceMs=0：去抖仍走 setTimeout(0)，用 waitFor 等待真实计时器触发
const DEBOUNCE = 0;

describe('useSessionSearch', () => {
  beforeEach(() => {
    mockedSearch.mockReset();
  });

  it('does not search when disabled', async () => {
    renderHook(() => useSessionSearch('hello', false, DEBOUNCE));
    // 等一轮宏任务，确认去抖后也没有请求
    await new Promise((r) => setTimeout(r, 20));
    expect(mockedSearch).not.toHaveBeenCalled();
  });

  it('does not search for empty or whitespace-only query', async () => {
    const { result, rerender } = renderHook(
      ({ query }) => useSessionSearch(query, true, DEBOUNCE),
      { initialProps: { query: '' } }
    );
    rerender({ query: '   ' });
    await new Promise((r) => setTimeout(r, 20));
    expect(mockedSearch).not.toHaveBeenCalled();
    expect(result.current.results).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('searches with trimmed query and limit 100, then exposes results', async () => {
    const hits = [makeSession('s1', 'Rust 学习'), makeSession('s2', 'Rust 笔记')];
    mockedSearch.mockResolvedValue(hits);

    const { result } = renderHook(() => useSessionSearch('  rust  ', true, DEBOUNCE));

    await waitFor(() => {
      expect(result.current.results).toEqual(hits);
    });
    expect(mockedSearch).toHaveBeenCalledWith({ query: 'rust', limit: 100 });
    expect(result.current.loading).toBe(false);
  });

  it('clears results when the query is cleared', async () => {
    mockedSearch.mockResolvedValue([makeSession('s1', 'hit')]);

    const { result, rerender } = renderHook(
      ({ query }) => useSessionSearch(query, true, DEBOUNCE),
      { initialProps: { query: 'hit' } }
    );
    await waitFor(() => expect(result.current.results).toHaveLength(1));

    rerender({ query: '' });
    await waitFor(() => {
      expect(result.current.results).toEqual([]);
      expect(result.current.loading).toBe(false);
    });
  });

  it('ignores stale responses when a newer query is issued', async () => {
    const slow = deferred<ChatSession[]>();
    const fastHits = [makeSession('s2', 'new query hit')];

    mockedSearch
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValueOnce(fastHits);

    const { result, rerender } = renderHook(
      ({ query }) => useSessionSearch(query, true, DEBOUNCE),
      { initialProps: { query: 'old' } }
    );
    // 等第一个（慢）请求发出
    await waitFor(() => expect(mockedSearch).toHaveBeenCalledTimes(1));

    // 切换查询 → 第二个请求发出并先返回
    rerender({ query: 'new' });
    await waitFor(() => expect(result.current.results).toEqual(fastHits));

    // 旧请求这时才姗姗来迟 → 结果必须被丢弃
    slow.resolve([makeSession('s1', 'stale hit')]);
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.results).toEqual(fastHits);
  });

  it('degrades to empty results on request failure', async () => {
    mockedSearch.mockRejectedValue(new Error('backend down'));

    const { result } = renderHook(() => useSessionSearch('boom', true, DEBOUNCE));

    await waitFor(() => {
      expect(mockedSearch).toHaveBeenCalled();
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.results).toEqual([]);
  });
});
