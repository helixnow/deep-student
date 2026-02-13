/**
 * contextActions 数据竞争测试
 *
 * 验证 addContextRef 的原子性去重逻辑是否能防止竞态条件
 */

import { describe, test, expect, vi } from 'vitest';
import { createContextActions } from '@/chat-v2/core/store/contextActions';
import type { ContextRef } from '@/chat-v2/context/types';
import type { ChatStoreState } from '@/chat-v2/core/store/types';

describe('contextActions - 数据竞争测试', () => {
  /**
   * 模拟并发调用场景，验证原子性
   */
  test('并发添加相同引用时应正确去重', async () => {
    // 模拟状态
    let state: Pick<ChatStoreState, 'pendingContextRefs'> = {
      pendingContextRefs: [],
    };

    // 模拟 set 函数（同步执行回调，确保原子性）
    const set = vi.fn((updater) => {
      if (typeof updater === 'function') {
        const updates = updater(state);
        state = { ...state, ...updates };
      } else {
        state = { ...state, ...updater };
      }
    });

    // 模拟 get 函数
    const get = vi.fn(() => state);

    // 创建 actions
    const actions = createContextActions(set, get);

    // 创建相同的引用（相同 resourceId 和 hash）
    const ref1: ContextRef = {
      resourceId: 'test-resource-1',
      typeId: 'test-type',
      hash: 'abc123',
    };

    const ref2: ContextRef = {
      resourceId: 'test-resource-1',
      typeId: 'test-type',
      hash: 'abc123',
    };

    // 【关键测试】模拟并发调用（快速连续调用）
    actions.addContextRef(ref1);
    actions.addContextRef(ref2);

    // 验证：应该只添加一次（去重成功）
    expect(state.pendingContextRefs).toHaveLength(1);
    expect(state.pendingContextRefs[0].resourceId).toBe('test-resource-1');
  });

  test('并发添加相同 resourceId 但不同 hash 时应更新', async () => {
    let state: Pick<ChatStoreState, 'pendingContextRefs'> = {
      pendingContextRefs: [],
    };

    const set = vi.fn((updater) => {
      if (typeof updater === 'function') {
        const updates = updater(state);
        state = { ...state, ...updates };
      } else {
        state = { ...state, ...updater };
      }
    });

    const get = vi.fn(() => state);
    const actions = createContextActions(set, get);

    const ref1: ContextRef = {
      resourceId: 'test-resource-1',
      typeId: 'test-type',
      hash: 'abc123',
    };

    const ref2: ContextRef = {
      resourceId: 'test-resource-1',
      typeId: 'test-type',
      hash: 'def456', // 不同的 hash
    };

    // 添加第一个引用
    actions.addContextRef(ref1);
    expect(state.pendingContextRefs).toHaveLength(1);
    expect(state.pendingContextRefs[0].hash).toBe('abc123');

    // 添加第二个引用（相同 resourceId，不同 hash）
    actions.addContextRef(ref2);

    // 验证：应该只有一个引用，但 hash 已更新
    expect(state.pendingContextRefs).toHaveLength(1);
    expect(state.pendingContextRefs[0].hash).toBe('def456');
  });

  test('添加不同 resourceId 的引用应都保留', async () => {
    let state: Pick<ChatStoreState, 'pendingContextRefs'> = {
      pendingContextRefs: [],
    };

    const set = vi.fn((updater) => {
      if (typeof updater === 'function') {
        const updates = updater(state);
        state = { ...state, ...updates };
      } else {
        state = { ...state, ...updater };
      }
    });

    const get = vi.fn(() => state);
    const actions = createContextActions(set, get);

    const ref1: ContextRef = {
      resourceId: 'test-resource-1',
      typeId: 'test-type',
      hash: 'abc123',
    };

    const ref2: ContextRef = {
      resourceId: 'test-resource-2',
      typeId: 'test-type',
      hash: 'def456',
    };

    // 添加两个不同的引用
    actions.addContextRef(ref1);
    actions.addContextRef(ref2);

    // 验证：应该保留两个引用
    expect(state.pendingContextRefs).toHaveLength(2);
    expect(state.pendingContextRefs[0].resourceId).toBe('test-resource-1');
    expect(state.pendingContextRefs[1].resourceId).toBe('test-resource-2');
  });

  test('相同引用重复添加时不应触发不必要的状态更新', async () => {
    let state: Pick<ChatStoreState, 'pendingContextRefs'> = {
      pendingContextRefs: [
        {
          resourceId: 'existing-resource',
          typeId: 'test-type',
          hash: 'abc123',
        },
      ],
    };

    const set = vi.fn((updater) => {
      if (typeof updater === 'function') {
        const updates = updater(state);
        // 只有在返回非空对象时才更新状态
        if (Object.keys(updates).length > 0) {
          state = { ...state, ...updates };
        }
      } else {
        state = { ...state, ...updater };
      }
    });

    const get = vi.fn(() => state);
    const actions = createContextActions(set, get);

    const duplicateRef: ContextRef = {
      resourceId: 'existing-resource',
      typeId: 'test-type',
      hash: 'abc123',
    };

    // 添加相同的引用
    actions.addContextRef(duplicateRef);

    // 验证：状态应该保持不变（没有触发更新）
    expect(state.pendingContextRefs).toHaveLength(1);
    expect(state.pendingContextRefs[0].hash).toBe('abc123');
  });
});
