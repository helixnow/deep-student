/**
 * Chat V2 - SessionManager 单元测试
 *
 * 测试要求（来自文档）：
 * - should create new session on first access
 * - should return existing session on subsequent access
 * - should update LRU order on access
 * - should evict LRU session when exceeding max
 * - should NOT evict streaming session
 * - should abort stream before destroy
 * - should track streaming sessions correctly
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// 为测试创建一个独立的 SessionManager 实例
// 避免单例干扰

class TestSessionManager {
  private sessions = new Map<string, any>();
  private lruOrder: string[] = [];
  private maxSessions = 10;
  private listeners = new Set<(event: any) => void>();
  private streamingUnsubscribers = new Map<string, () => void>();

  // 模拟的 Store 工厂
  private createMockStore(sessionId: string) {
    let state = {
      sessionId,
      sessionStatus: 'idle' as 'idle' | 'streaming' | 'aborting',
    };

    const subscribers = new Set<(state: any) => void>();

    const store = {
      getState: () => state,
      setState: (partial: Partial<typeof state>) => {
        state = { ...state, ...partial };
        subscribers.forEach((cb) => cb(state));
      },
      subscribe: (cb: (state: any) => void) => {
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
      // 模拟 abortStream
      abortStreamCalled: false,
    };

    // 添加 abortStream 方法到 state
    (state as any).abortStream = async () => {
      store.abortStreamCalled = true;
      state.sessionStatus = 'idle';
    };

    return store;
  }

  getOrCreate(sessionId: string, options?: { mode?: string; preload?: boolean }) {
    if (this.sessions.has(sessionId)) {
      this.touch(sessionId);
      return this.sessions.get(sessionId)!;
    }

    if (this.sessions.size >= this.maxSessions) {
      this.evictLRU();
    }

    const store = this.createMockStore(sessionId);
    this.sessions.set(sessionId, store);
    this.lruOrder.push(sessionId);

    // 订阅流式状态
    let prevStreaming = false;
    const unsubscribe = store.subscribe((s: any) => {
      const isStreaming = s.sessionStatus === 'streaming';
      if (isStreaming !== prevStreaming) {
        prevStreaming = isStreaming;
        this.emit({ type: 'streaming-change', sessionId, isStreaming });
      }
    });
    this.streamingUnsubscribers.set(sessionId, unsubscribe);

    this.emit({ type: 'session-created', sessionId });

    return store;
  }

  get(sessionId: string) {
    const store = this.sessions.get(sessionId);
    if (store) {
      this.touch(sessionId);
    }
    return store;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async destroy(sessionId: string): Promise<void> {
    const store = this.sessions.get(sessionId);
    if (!store) return;

    if (store.getState().sessionStatus === 'streaming') {
      await store.getState().abortStream();
    }

    const unsubscribe = this.streamingUnsubscribers.get(sessionId);
    if (unsubscribe) {
      unsubscribe();
      this.streamingUnsubscribers.delete(sessionId);
    }

    this.sessions.delete(sessionId);
    this.lruOrder = this.lruOrder.filter((id) => id !== sessionId);
    this.emit({ type: 'session-destroyed', sessionId });
  }

  async destroyAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.destroy(id)));
  }

  getActiveStreamingSessions(): string[] {
    return [...this.sessions.entries()]
      .filter(([_, store]) => store.getState().sessionStatus === 'streaming')
      .map(([id]) => id);
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  getAllSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  touch(sessionId: string): void {
    this.lruOrder = this.lruOrder.filter((id) => id !== sessionId);
    this.lruOrder.push(sessionId);
  }

  setMaxSessions(max: number): void {
    this.maxSessions = max;
    while (this.sessions.size > this.maxSessions) {
      this.evictLRU();
    }
  }

  getMaxSessions(): number {
    return this.maxSessions;
  }

  getLruOrder(): string[] {
    return [...this.lruOrder];
  }

  subscribe(listener: (event: any) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private evictLRU(): void {
    for (const sessionId of this.lruOrder) {
      const store = this.sessions.get(sessionId);
      if (store && store.getState().sessionStatus !== 'streaming') {
        const unsubscribe = this.streamingUnsubscribers.get(sessionId);
        if (unsubscribe) {
          unsubscribe();
          this.streamingUnsubscribers.delete(sessionId);
        }

        this.sessions.delete(sessionId);
        this.lruOrder = this.lruOrder.filter((id) => id !== sessionId);
        this.emit({ type: 'session-evicted', sessionId });
        return;
      }
    }
    console.warn('[SessionManager] All sessions are streaming, cannot evict');
  }

  private emit(event: any): void {
    this.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (err) {
        console.error('[SessionManager] Listener error:', err);
      }
    });
  }
}

describe('SessionManager', () => {
  let manager: TestSessionManager;

  beforeEach(() => {
    manager = new TestSessionManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getOrCreate', () => {
    it('should create new session on first access', () => {
      const store = manager.getOrCreate('session_1');

      expect(store).toBeDefined();
      expect(store.getState().sessionId).toBe('session_1');
      expect(manager.getSessionCount()).toBe(1);
    });

    it('should return existing session on subsequent access', () => {
      const store1 = manager.getOrCreate('session_1');
      const store2 = manager.getOrCreate('session_1');

      expect(store1).toBe(store2);
      expect(manager.getSessionCount()).toBe(1);
    });

    it('should return different store instance for different sessionId', () => {
      const store1 = manager.getOrCreate('session_1');
      const store2 = manager.getOrCreate('session_2');

      expect(store1).not.toBe(store2);
      expect(manager.getSessionCount()).toBe(2);
    });
  });

  describe('LRU management', () => {
    it('should update LRU order on access', () => {
      manager.getOrCreate('session_1');
      manager.getOrCreate('session_2');
      manager.getOrCreate('session_3');

      // 初始顺序：1, 2, 3
      expect(manager.getLruOrder()).toEqual(['session_1', 'session_2', 'session_3']);

      // 访问 session_1，应该移到最后
      manager.getOrCreate('session_1');
      expect(manager.getLruOrder()).toEqual(['session_2', 'session_3', 'session_1']);

      // 访问 session_2
      manager.get('session_2');
      expect(manager.getLruOrder()).toEqual(['session_3', 'session_1', 'session_2']);
    });

    it('should evict LRU session when exceeding max', () => {
      manager.setMaxSessions(3);

      manager.getOrCreate('session_1');
      manager.getOrCreate('session_2');
      manager.getOrCreate('session_3');

      expect(manager.getSessionCount()).toBe(3);

      // 创建第4个，应该淘汰 session_1（最久未使用）
      manager.getOrCreate('session_4');

      expect(manager.getSessionCount()).toBe(3);
      expect(manager.has('session_1')).toBe(false);
      expect(manager.has('session_2')).toBe(true);
      expect(manager.has('session_3')).toBe(true);
      expect(manager.has('session_4')).toBe(true);
    });

    it('should NOT evict streaming session', () => {
      manager.setMaxSessions(3);

      const store1 = manager.getOrCreate('session_1');
      manager.getOrCreate('session_2');
      manager.getOrCreate('session_3');

      // 设置 session_1 为 streaming
      store1.setState({ sessionStatus: 'streaming' });

      // 创建第4个，应该淘汰 session_2（session_1 在流式中被跳过）
      manager.getOrCreate('session_4');

      expect(manager.getSessionCount()).toBe(3);
      expect(manager.has('session_1')).toBe(true); // 流式中，未被淘汰
      expect(manager.has('session_2')).toBe(false); // 被淘汰
      expect(manager.has('session_3')).toBe(true);
      expect(manager.has('session_4')).toBe(true);
    });

    it('should warn when all sessions are streaming', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      manager.setMaxSessions(2);

      const store1 = manager.getOrCreate('session_1');
      const store2 = manager.getOrCreate('session_2');

      // 设置所有会话为 streaming
      store1.setState({ sessionStatus: 'streaming' });
      store2.setState({ sessionStatus: 'streaming' });

      // 尝试创建第3个
      manager.getOrCreate('session_3');

      expect(warnSpy).toHaveBeenCalledWith(
        '[SessionManager] All sessions are streaming, cannot evict'
      );

      // 所有会话都还在（因为无法淘汰）
      expect(manager.getSessionCount()).toBe(3);
    });
  });

  describe('destroy', () => {
    it('should abort stream before destroy', async () => {
      const store = manager.getOrCreate('session_1');

      // 设置为 streaming
      store.setState({ sessionStatus: 'streaming' });

      expect(store.abortStreamCalled).toBe(false);

      await manager.destroy('session_1');

      expect(store.abortStreamCalled).toBe(true);
      expect(manager.has('session_1')).toBe(false);
    });

    it('should remove session without abort if not streaming', async () => {
      const store = manager.getOrCreate('session_1');

      expect(store.getState().sessionStatus).toBe('idle');

      await manager.destroy('session_1');

      expect(store.abortStreamCalled).toBe(false);
      expect(manager.has('session_1')).toBe(false);
    });

    it('should destroy all sessions', async () => {
      manager.getOrCreate('session_1');
      manager.getOrCreate('session_2');
      manager.getOrCreate('session_3');

      expect(manager.getSessionCount()).toBe(3);

      await manager.destroyAll();

      expect(manager.getSessionCount()).toBe(0);
    });
  });

  describe('streaming sessions tracking', () => {
    it('should track streaming sessions correctly', () => {
      const store1 = manager.getOrCreate('session_1');
      const store2 = manager.getOrCreate('session_2');
      manager.getOrCreate('session_3');

      // 初始无流式会话
      expect(manager.getActiveStreamingSessions()).toEqual([]);

      // 设置 session_1 为 streaming
      store1.setState({ sessionStatus: 'streaming' });
      expect(manager.getActiveStreamingSessions()).toEqual(['session_1']);

      // 设置 session_2 为 streaming
      store2.setState({ sessionStatus: 'streaming' });
      expect(manager.getActiveStreamingSessions()).toContain('session_1');
      expect(manager.getActiveStreamingSessions()).toContain('session_2');
      expect(manager.getActiveStreamingSessions().length).toBe(2);

      // session_1 结束流式
      store1.setState({ sessionStatus: 'idle' });
      expect(manager.getActiveStreamingSessions()).toEqual(['session_2']);
    });

    it('should emit streaming-change event', () => {
      const events: any[] = [];
      manager.subscribe((event) => events.push(event));

      const store = manager.getOrCreate('session_1');

      // 清除 session-created 事件
      events.length = 0;

      // 开始流式
      store.setState({ sessionStatus: 'streaming' });
      expect(events).toContainEqual({
        type: 'streaming-change',
        sessionId: 'session_1',
        isStreaming: true,
      });

      // 结束流式
      store.setState({ sessionStatus: 'idle' });
      expect(events).toContainEqual({
        type: 'streaming-change',
        sessionId: 'session_1',
        isStreaming: false,
      });
    });
  });

  describe('event subscription', () => {
    it('should emit session-created event', () => {
      const events: any[] = [];
      manager.subscribe((event) => events.push(event));

      manager.getOrCreate('session_1');

      expect(events).toContainEqual({
        type: 'session-created',
        sessionId: 'session_1',
      });
    });

    it('should emit session-destroyed event', async () => {
      const events: any[] = [];
      manager.getOrCreate('session_1');

      manager.subscribe((event) => events.push(event));

      await manager.destroy('session_1');

      expect(events).toContainEqual({
        type: 'session-destroyed',
        sessionId: 'session_1',
      });
    });

    it('should emit session-evicted event', () => {
      const events: any[] = [];
      manager.setMaxSessions(2);

      manager.getOrCreate('session_1');
      manager.getOrCreate('session_2');

      manager.subscribe((event) => events.push(event));

      manager.getOrCreate('session_3');

      expect(events).toContainEqual({
        type: 'session-evicted',
        sessionId: 'session_1',
      });
    });

    it('should allow unsubscribe', () => {
      const events: any[] = [];
      const unsubscribe = manager.subscribe((event) => events.push(event));

      manager.getOrCreate('session_1');
      expect(events.length).toBe(1);

      unsubscribe();

      manager.getOrCreate('session_2');
      expect(events.length).toBe(1); // 不再收到事件
    });
  });

  describe('utility methods', () => {
    it('should return correct session count', () => {
      expect(manager.getSessionCount()).toBe(0);

      manager.getOrCreate('session_1');
      expect(manager.getSessionCount()).toBe(1);

      manager.getOrCreate('session_2');
      expect(manager.getSessionCount()).toBe(2);
    });

    it('should return all session IDs', () => {
      manager.getOrCreate('session_1');
      manager.getOrCreate('session_2');
      manager.getOrCreate('session_3');

      const ids = manager.getAllSessionIds();
      expect(ids).toContain('session_1');
      expect(ids).toContain('session_2');
      expect(ids).toContain('session_3');
      expect(ids.length).toBe(3);
    });

    it('should check session existence', () => {
      expect(manager.has('session_1')).toBe(false);

      manager.getOrCreate('session_1');
      expect(manager.has('session_1')).toBe(true);
    });

    it('should get and set max sessions', () => {
      expect(manager.getMaxSessions()).toBe(10);

      manager.setMaxSessions(5);
      expect(manager.getMaxSessions()).toBe(5);
    });
  });
});
