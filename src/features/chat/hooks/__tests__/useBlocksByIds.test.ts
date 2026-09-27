/**
 * useBlocksByIds 快路径行为测试（2026-09-25 长会话性能治理）
 *
 * 固化零分配身份快路径的对外契约：
 * - 订阅集内的块对象身份全部未变 → 返回上一份数组引用（不重渲染）
 * - 任一块对象身份变化 → 返回新数组（正常触发重渲染）
 * - 缺失块被过滤，且过滤结果跨 flush 稳定
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBlocksByIds } from '../useChatStore';
import { createChatStore } from '../../core/store/createChatStore';
import type { Block } from '../../core/types';

function makeBlock(id: string, content: string): Block {
  return {
    id,
    type: 'content',
    status: 'running',
    content,
    messageId: 'msg_1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as Block;
}

function seedBlocks(store: ReturnType<typeof createChatStore>, blocks: Block[]) {
  store.setState((state) => {
    const next = new Map(state.blocks);
    for (const b of blocks) next.set(b.id, b);
    return { blocks: next } as any;
  });
}

describe('useBlocksByIds（身份快路径）', () => {
  it('返回 id 对应的块（缺失块过滤）', () => {
    const store = createChatStore('sess_ids_1');
    seedBlocks(store, [makeBlock('b1', 'a'), makeBlock('b3', 'c')]);

    const { result } = renderHook(() => useBlocksByIds(store, ['b1', 'b2', 'b3']));
    expect(result.current.map((b) => b.id)).toEqual(['b1', 'b3']);
  });

  it('无关块身份轮换不触发重渲染（长会话快路径核心契约）', () => {
    const store = createChatStore('sess_ids_2');
    seedBlocks(store, [makeBlock('b1', 'a'), makeBlock('other', 'x')]);

    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount++;
      return useBlocksByIds(store, ['b1']);
    });
    const firstRef = result.current;
    const rendersAfterSeed = renderCount;

    act(() => {
      // 另一条消息的块内容增长：Map 身份变化但 b1 对象身份不变
      const prev = store.getState().blocks.get('other')!;
      seedBlocks(store, [{ ...prev, content: prev.content + ' more' }]);
    });

    expect(result.current).toBe(firstRef);
    expect(renderCount).toBe(rendersAfterSeed);
  });

  it('订阅块身份变化时返回新数组并触发重渲染', () => {
    const store = createChatStore('sess_ids_3');
    seedBlocks(store, [makeBlock('b1', 'a')]);

    const { result } = renderHook(() => useBlocksByIds(store, ['b1']));
    const firstRef = result.current;

    act(() => {
      const prev = store.getState().blocks.get('b1')!;
      seedBlocks(store, [{ ...prev, content: prev.content + ' more', status: 'success' }]);
    });

    expect(result.current).not.toBe(firstRef);
    expect(result.current[0].status).toBe('success');
  });

  it('连续多次无关 flush 后仍保持引用稳定（比较基准前移不破坏快路径）', () => {
    const store = createChatStore('sess_ids_4');
    seedBlocks(store, [makeBlock('b1', 'a'), makeBlock('other', 'x')]);

    const { result } = renderHook(() => useBlocksByIds(store, ['b1']));
    const firstRef = result.current;

    for (let i = 0; i < 3; i++) {
      act(() => {
        const prev = store.getState().blocks.get('other')!;
        seedBlocks(store, [{ ...prev, content: prev.content + ` chunk${i}` }]);
      });
    }

    expect(result.current).toBe(firstRef);
  });
});
