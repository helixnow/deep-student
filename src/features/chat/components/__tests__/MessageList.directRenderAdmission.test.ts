/**
 * shouldDirectRender 直渲染准入判定测试（2026-09-25 长会话性能治理）
 *
 * 三条件准入：消息数 / 总块数 / 总正文字节。任何一项超限都应落入虚拟化
 * 路径——尤其是"消息不多但单条巨长"的会话形状（按消息数/块数都会漏过）。
 */

import { describe, expect, it } from 'vitest';

import { shouldDirectRender } from '../MessageList';

describe('shouldDirectRender', () => {
  it('小型会话：三项都在限内 → 直渲染', () => {
    expect(shouldDirectRender(10, 40, 50_000)).toBe(true);
    expect(shouldDirectRender(0, 0, 0)).toBe(true);
  });

  it('消息数超限（>16）→ 虚拟化', () => {
    expect(shouldDirectRender(17, 40, 50_000)).toBe(false);
  });

  it('块数超限（>600，agent 任务会话形状）→ 虚拟化', () => {
    expect(shouldDirectRender(10, 601, 50_000)).toBe(false);
  });

  it('内容总量超限（>200KB，消息少但单条巨长）→ 虚拟化', () => {
    expect(shouldDirectRender(10, 40, 200_001)).toBe(false);
    expect(shouldDirectRender(3, 12, 500_000)).toBe(false);
  });

  it('边界值恰好等于上限 → 仍直渲染', () => {
    expect(shouldDirectRender(16, 600, 200_000)).toBe(true);
  });
});
