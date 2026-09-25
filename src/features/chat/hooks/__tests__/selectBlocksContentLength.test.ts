/**
 * selectBlocksContentLength 行为测试（2026-09-25 长会话性能治理）
 *
 * 契约：按 Map 身份缓存——同一 flush（同一 Map 实例）只求和一次；
 * 内容总量含全部块的 content（thinking 块正文也在 content 字段）。
 */

import { describe, expect, it } from 'vitest';

import { selectBlocksContentLength } from '../useChatStore';
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
