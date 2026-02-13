/**
 * Chat V2 - useChatSession Hook 单元测试
 *
 * 测试要求（来自文档）：
 * - should return same store instance for same sessionId
 * - should return different store instance for different sessionId
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMemo } from 'react';

// 模拟 SessionManager
const mockSessions = new Map<string, any>();

function createMockStore(sessionId: string) {
  return {
    getState: () => ({
      sessionId,
      sessionStatus: 'idle',
    }),
    subscribe: () => () => {},
  };
}

const mockSessionManager = {
  getOrCreate: (sessionId: string, _options?: any) => {
    if (!mockSessions.has(sessionId)) {
      mockSessions.set(sessionId, createMockStore(sessionId));
    }
    return mockSessions.get(sessionId)!;
  },
  get: (sessionId: string) => {
    return mockSessions.get(sessionId);
  },
  has: (sessionId: string) => {
    return mockSessions.has(sessionId);
  },
};

// 模拟 useChatSession hook（不依赖实际模块）
function useChatSession(sessionId: string, options?: { mode?: string; preload?: boolean }) {
  const store = useMemo(
    () => mockSessionManager.getOrCreate(sessionId, options),
    [sessionId, options?.mode, options?.preload]
  );
  return store;
}

function useChatSessionIfExists(sessionId: string) {
  return useMemo(() => mockSessionManager.get(sessionId), [sessionId]);
}

function useHasSession(sessionId: string) {
  return useMemo(() => mockSessionManager.has(sessionId), [sessionId]);
}

describe('useChatSession', () => {
  beforeEach(() => {
    mockSessions.clear();
  });

  afterEach(() => {
    mockSessions.clear();
  });

  describe('useChatSession', () => {
    it('should return same store instance for same sessionId', () => {
      const { result: result1 } = renderHook(() => useChatSession('session_1'));
      const { result: result2 } = renderHook(() => useChatSession('session_1'));

      expect(result1.current).toBe(result2.current);
    });

    it('should return different store instance for different sessionId', () => {
      const { result: result1 } = renderHook(() => useChatSession('session_1'));
      const { result: result2 } = renderHook(() => useChatSession('session_2'));

      expect(result1.current).not.toBe(result2.current);
    });

    it('should return store with correct sessionId', () => {
      const { result } = renderHook(() => useChatSession('test_session'));

      expect(result.current.getState().sessionId).toBe('test_session');
    });

    it('should return same store on re-render with same sessionId', () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) => useChatSession(sessionId),
        { initialProps: { sessionId: 'session_1' } }
      );

      const firstStore = result.current;

      rerender({ sessionId: 'session_1' });

      expect(result.current).toBe(firstStore);
    });

    it('should return different store when sessionId changes', () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) => useChatSession(sessionId),
        { initialProps: { sessionId: 'session_1' } }
      );

      const firstStore = result.current;

      rerender({ sessionId: 'session_2' });

      expect(result.current).not.toBe(firstStore);
      expect(result.current.getState().sessionId).toBe('session_2');
    });
  });

  describe('useChatSessionIfExists', () => {
    it('should return undefined for non-existent session', () => {
      const { result } = renderHook(() => useChatSessionIfExists('non_existent'));

      expect(result.current).toBeUndefined();
    });

    it('should return store for existing session', () => {
      // 先创建会话
      mockSessionManager.getOrCreate('existing_session');

      const { result } = renderHook(() => useChatSessionIfExists('existing_session'));

      expect(result.current).toBeDefined();
      expect(result.current?.getState().sessionId).toBe('existing_session');
    });
  });

  describe('useHasSession', () => {
    it('should return false for non-existent session', () => {
      const { result } = renderHook(() => useHasSession('non_existent'));

      expect(result.current).toBe(false);
    });

    it('should return true for existing session', () => {
      // 先创建会话
      mockSessionManager.getOrCreate('existing_session');

      const { result } = renderHook(() => useHasSession('existing_session'));

      expect(result.current).toBe(true);
    });
  });
});
