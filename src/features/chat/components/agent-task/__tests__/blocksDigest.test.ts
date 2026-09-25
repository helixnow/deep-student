/**
 * blocksDigest 行为测试
 *
 * 固化 2026-09-25 长会话性能治理的契约：
 * - 同一 blocks Map 实例（同一次 flush）只计算一遍，各消费者共享同一 digest
 * - runtimeActivity / terminalToolCount 语义与旧的全量扫描实现一致
 * - todoBlocks 引用折叠：todo 块未变时跨 flush 保持同一数组引用，
 *   extractSteps 等下游 memo 不会因纯正文流式而重跑
 */

import { describe, it, expect } from 'vitest';

import { getBlocksDigest } from '../blocksDigest';
import type { Block } from '../../../core/types';

function toolBlock(overrides: Partial<Block>): Block {
  return {
    id: overrides.id ?? 'b1',
    messageId: 'm1',
    type: 'mcp_tool',
    status: 'running',
    createdAt: 0,
    ...overrides,
  } as Block;
}

function contentBlock(id: string, content: string): Block {
  return {
    id,
    messageId: 'm1',
    type: 'content',
    status: 'running',
    content,
    createdAt: 0,
  } as Block;
}

function toMap(blocks: Block[]): Map<string, Block> {
  return new Map(blocks.map((b) => [b.id, b] as const));
}

describe('getBlocksDigest', () => {
  it('undefined/null/空 Map 返回空摘要', () => {
    expect(getBlocksDigest(undefined)).toEqual({
      size: 0,
      runtimeActivity: false,
      terminalToolCount: 0,
      todoBlocks: [],
    });
    expect(getBlocksDigest(null).size).toBe(0);
    expect(getBlocksDigest(new Map()).runtimeActivity).toBe(false);
  });

  it('缓存按 Map 身份生效：同一 Map 返回同一 digest 对象', () => {
    const blocks = toMap([contentBlock('b1', 'hello')]);
    expect(getBlocksDigest(blocks)).toBe(getBlocksDigest(blocks));
  });

  it('runtimeActivity：runtime 工具 / browser_downloads（normalize 后）/ mcp_ 前缀命中', () => {
    const runtime = getBlocksDigest(toMap([
      contentBlock('b1', 'text'),
      toolBlock({ id: 'b2', toolName: 'builtin-workspace_file_write', status: 'running' }),
    ]));
    expect(runtime.runtimeActivity).toBe(true);

    const browser = getBlocksDigest(toMap([
      toolBlock({ id: 'b3', toolName: 'mcp_browser_downloads' }),
    ]));
    expect(browser.runtimeActivity).toBe(true);

    const none = getBlocksDigest(toMap([
      toolBlock({ id: 'b4', toolName: 'web_search' }),
      contentBlock('b5', 'x'),
    ]));
    expect(none.runtimeActivity).toBe(false);
  });

  it('terminalToolCount：只统计带 toolName 且 status 为 success/error 的块', () => {
    const digest = getBlocksDigest(toMap([
      toolBlock({ id: 'b1', toolName: 'file_write', status: 'success' }),
      toolBlock({ id: 'b2', toolName: 'web_search', status: 'error' }),
      toolBlock({ id: 'b3', toolName: 'web_search', status: 'running' }),
      contentBlock('b4', '正文'),
    ]));
    expect(digest.terminalToolCount).toBe(2);
  });

  it('todoBlocks：收集 todo 工具块，纯正文增长不换引用', () => {
    const todoA = toolBlock({ id: 't1', toolName: 'todo_init' });
    const todoB = toolBlock({ id: 't2', toolName: 'builtin-todo_update' });
    const body1 = contentBlock('c1', '第一段');
    const map1 = toMap([todoA, body1, todoB]);
    const digest1 = getBlocksDigest(map1);
    expect(digest1.todoBlocks).toEqual([todoA, todoB]);

    // 模拟下一次 flush：正文块身份轮换（immer 新对象），todo 块身份不变
    const body2 = contentBlock('c1', '第一段第二段');
    const digest2 = getBlocksDigest(toMap([todoA, body2, todoB]));
    expect(digest2.todoBlocks).toBe(digest1.todoBlocks);

    // todo 块变化（toolOutput 更新 → 新块对象）→ 引用更新
    const todoB2 = toolBlock({ id: 't2', toolName: 'builtin-todo_update', toolOutput: { steps: [] } });
    const digest3 = getBlocksDigest(toMap([todoA, body2, todoB2]));
    expect(digest3.todoBlocks).not.toBe(digest2.todoBlocks);
    expect(digest3.todoBlocks).toEqual([todoA, todoB2]);
  });

  it('todoBlocks 清空后回到共享空数组引用', () => {
    const todoA = toolBlock({ id: 't1', toolName: 'todo_init' });
    const withTodo = getBlocksDigest(toMap([todoA]));
    expect(withTodo.todoBlocks).toHaveLength(1);

    const withoutTodo = getBlocksDigest(toMap([contentBlock('c1', 'x')]));
    expect(withoutTodo.todoBlocks).toHaveLength(0);
    expect(getBlocksDigest(toMap([contentBlock('c2', 'y')])).todoBlocks).toBe(withoutTodo.todoBlocks);
  });

  it('size 取自 Map.size', () => {
    const digest = getBlocksDigest(toMap([
      contentBlock('b1', 'a'),
      contentBlock('b2', 'b'),
    ]));
    expect(digest.size).toBe(2);
  });
});
