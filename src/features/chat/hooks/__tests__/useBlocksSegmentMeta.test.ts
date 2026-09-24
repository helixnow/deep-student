/**
 * useBlocksSegmentMeta 行为测试
 *
 * 固化 2026-09-24 流式性能治理的核心契约：
 * - 流式块 content 增长（块对象身份轮换）**不触发**订阅方重渲染
 * - 分段结构变化（isEmpty 翻转 / 新块 / 状态翻转 / citations 落地）触发重渲染
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBlocksSegmentMeta } from '../useChatStore';
import { createChatStore } from '../../core/store/createChatStore';
import type { Block } from '../../core/types';

function makeContentBlock(id: string, content: string, status: Block['status'] = 'running'): Block {
  return {
    id,
    type: 'content',
    status,
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

describe('useBlocksSegmentMeta', () => {
  it('returns stable meta for seeded blocks', () => {
    const store = createChatStore('sess_meta_1');
    seedBlocks(store, [makeContentBlock('b1', 'hello', 'success')]);

    const { result } = renderHook(() => useBlocksSegmentMeta(store, ['b1']));
    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({
      id: 'b1',
      type: 'content',
      status: 'success',
      isEmpty: false,
    });
  });

  it('does NOT re-render when only streaming content grows (identity churn)', () => {
    const store = createChatStore('sess_meta_2');
    seedBlocks(store, [makeContentBlock('b1', 'a')]);

    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount++;
      return useBlocksSegmentMeta(store, ['b1']);
    });
    const firstRef = result.current;
    const rendersAfterSeed = renderCount;

    // 模拟流式 flush：content 追加 → 块对象身份轮换（新对象），分段结构不变
    act(() => {
      const prev = store.getState().blocks.get('b1')!;
      seedBlocks(store, [{ ...prev, content: prev.content + ' more tokens', updatedAt: Date.now() }]);
    });

    // 身份已换，但分段指纹不变 → 引用稳定、无额外重渲染
    expect(result.current).toBe(firstRef);
    expect(renderCount).toBe(rendersAfterSeed);
  });

  it('re-renders when isEmpty flips (empty -> non-empty content)', () => {
    const store = createChatStore('sess_meta_3');
    seedBlocks(store, [makeContentBlock('b1', '')]);

    const { result } = renderHook(() => useBlocksSegmentMeta(store, ['b1']));
    const firstRef = result.current;
    expect(firstRef[0].isEmpty).toBe(true);

    act(() => {
      const prev = store.getState().blocks.get('b1')!;
      seedBlocks(store, [{ ...prev, content: 'now has content' }]);
    });

    expect(result.current).not.toBe(firstRef);
    expect(result.current[0].isEmpty).toBe(false);
  });

  it('re-renders when block status flips', () => {
    const store = createChatStore('sess_meta_4');
    seedBlocks(store, [makeContentBlock('b1', 'x', 'running')]);

    const { result } = renderHook(() => useBlocksSegmentMeta(store, ['b1']));
    const firstRef = result.current;

    act(() => {
      const prev = store.getState().blocks.get('b1')!;
      seedBlocks(store, [{ ...prev, status: 'success' }]);
    });

    expect(result.current).not.toBe(firstRef);
    expect(result.current[0].status).toBe('success');
  });

  it('re-renders when citations land', () => {
    const store = createChatStore('sess_meta_5');
    seedBlocks(store, [makeContentBlock('b1', 'x', 'success')]);

    const { result } = renderHook(() => useBlocksSegmentMeta(store, ['b1']));
    const firstRef = result.current;
    expect(firstRef[0].hasCitations).toBe(false);

    act(() => {
      const prev = store.getState().blocks.get('b1')!;
      seedBlocks(store, [{ ...prev, citations: [{ id: 'c1' }] as any }]);
    });

    expect(result.current).not.toBe(firstRef);
    expect(result.current[0].hasCitations).toBe(true);
  });

  it('re-renders when the block id set changes', () => {
    const store = createChatStore('sess_meta_6');
    seedBlocks(store, [makeContentBlock('b1', 'a'), makeContentBlock('b2', 'b')]);

    const { result, rerender } = renderHook(
      ({ ids }) => useBlocksSegmentMeta(store, ids),
      { initialProps: { ids: ['b1'] } }
    );
    expect(result.current).toHaveLength(1);

    rerender({ ids: ['b1', 'b2'] });
    expect(result.current).toHaveLength(2);
  });
});
