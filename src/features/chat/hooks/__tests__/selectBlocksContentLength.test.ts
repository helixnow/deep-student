/**
 * selectBlocksContentLength 行为测试（2026-09-25 长会话性能治理）
 *
 * 契约：按 Map 身份缓存——同一 flush（同一 Map 实例）只求和一次；
 * 内容总量含全部块的 content（thinking 块正文也在 content 字段）。
 */

import { describe, expect, it } from 'vitest';

import {
  createBlocksContentLengthSelector,
  selectBlocksContentLength,
} from '../useChatStore';
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

describe('selectBlocksContentLength', () => {
  it('undefined/null/空 Map 返回 0', () => {
    expect(selectBlocksContentLength(undefined)).toBe(0);
    expect(selectBlocksContentLength(null)).toBe(0);
    expect(selectBlocksContentLength(new Map())).toBe(0);
  });

  it('求和全部块的 content 长度（含缺失 content 的块按 0 计）', () => {
    const blocks = new Map<string, Block>([
      ['b1', makeBlock('b1', '12345')],
      ['b2', makeBlock('b2', '1234567890')],
      ['b3', ({ id: 'b3', type: 'tool_call', status: 'running' } as unknown as Block)],
    ]);
    expect(selectBlocksContentLength(blocks)).toBe(15);
  });

  it('同一 Map 实例重复调用返回缓存值（同一 flush 只求和一次）', () => {
    const blocks = new Map<string, Block>([
      ['b1', makeBlock('b1', 'abc')],
    ]);
    expect(selectBlocksContentLength(blocks)).toBe(3);
    expect(selectBlocksContentLength(blocks)).toBe(3);
    // 新 Map（新 flush）重新求和
    const next = new Map<string, Block>([
      ['b1', makeBlock('b1', 'abcdefgh')],
    ]);
    expect(selectBlocksContentLength(next)).toBe(8);
  });
});

describe('createBlocksContentLengthSelector', () => {
  it('流式新 Map 只读取发生身份变化的 active block', () => {
    let historicalReads = 0;
    const historical = makeBlock('history', '12345');
    Object.defineProperty(historical, 'content', {
      configurable: true,
      get() {
        historicalReads += 1;
        return '12345';
      },
    });
    const active1 = makeBlock('active', 'abc');
    const selector = createBlocksContentLengthSelector();
    const activeBlockIds = new Set(['active']);
    const first = new Map<string, Block>([
      ['history', historical],
      ['active', active1],
    ]);

    expect(selector({ blocks: first, sessionStatus: 'streaming', activeBlockIds })).toBe(8);
    expect(historicalReads).toBe(1);

    const active2 = makeBlock('active', 'abcdefgh');
    const next = new Map(first);
    next.set('active', active2);
    expect(selector({ blocks: next, sessionStatus: 'streaming', activeBlockIds })).toBe(13);
    expect(historicalReads).toBe(1);
  });

  it('Map 结构变化无法由 activeBlockIds 解释时安全回退全扫', () => {
    const selector = createBlocksContentLengthSelector();
    const activeBlockIds = new Set(['active']);
    const active = makeBlock('active', 'abc');
    const first = new Map<string, Block>([
      ['history', makeBlock('history', '12345')],
      ['active', active],
    ]);
    expect(selector({ blocks: first, sessionStatus: 'streaming', activeBlockIds })).toBe(8);

    const next = new Map(first);
    next.set('new-history', makeBlock('new-history', '1234567'));
    expect(selector({ blocks: next, sessionStatus: 'streaming', activeBlockIds })).toBe(15);
  });

  it('超过准入阈值后锁存，后续 Map 不再读取 block content', () => {
    const selector = createBlocksContentLengthSelector(10);
    const first = new Map<string, Block>([
      ['b1', makeBlock('b1', '123456')],
      ['b2', makeBlock('b2', '123456')],
    ]);
    expect(selector({ blocks: first, sessionStatus: 'idle', activeBlockIds: new Set() })).toBe(11);

    let reads = 0;
    const later = makeBlock('later', 'x');
    Object.defineProperty(later, 'content', {
      configurable: true,
      get() {
        reads += 1;
        return 'x';
      },
    });
    expect(selector({
      blocks: new Map([['later', later]]),
      sessionStatus: 'idle',
      activeBlockIds: new Set(),
    })).toBe(11);
    expect(reads).toBe(0);
  });

  it('流式结束后对新 Map 全扫，修正非活跃块变化', () => {
    const selector = createBlocksContentLengthSelector();
    const activeBlockIds = new Set(['active']);
    const first = new Map<string, Block>([
      ['history', makeBlock('history', '12345')],
      ['active', makeBlock('active', 'abc')],
    ]);
    expect(selector({ blocks: first, sessionStatus: 'streaming', activeBlockIds })).toBe(8);

    const idle = new Map(first);
    idle.set('history', makeBlock('history', '1234567890'));
    expect(selector({ blocks: idle, sessionStatus: 'idle', activeBlockIds: new Set() })).toBe(13);
  });
});
