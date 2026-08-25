/**
 * 大纲窗口化渲染（outlineVirtual）纯函数测试：
 * - 阈值开关；
 * - 窗口块序列（spacer/rows）覆盖全区间、高度守恒；
 * - overscan 与视口边界；
 * - pinned 行（聚焦/编辑行）窗口外单独挂载；
 * - 滚动定位估算。
 */
import { describe, expect, it } from 'vitest';

import {
  OUTLINE_ESTIMATED_ROW_HEIGHT,
  OUTLINE_OVERSCAN_ROWS,
  OUTLINE_VIRTUALIZATION_THRESHOLD,
  computeOutlineWindow,
  estimateScrollTopForIndex,
  shouldVirtualizeOutline,
  type OutlineWindowBlock,
} from '@/features/mindmap/views/outline/outlineVirtual';

const ROW = OUTLINE_ESTIMATED_ROW_HEIGHT;

/** blocks 必须无缝覆盖 [0, totalCount)：行数 + spacer 高度换算行数守恒 */
function coveredRows(blocks: OutlineWindowBlock[]): number {
  return blocks.reduce((sum, block) => {
    if (block.type === 'rows') return sum + (block.endIndex - block.startIndex);
    return sum + block.height / ROW;
  }, 0);
}

function mountedIndexes(blocks: OutlineWindowBlock[]): number[] {
  const result: number[] = [];
  for (const block of blocks) {
    if (block.type !== 'rows') continue;
    for (let i = block.startIndex; i < block.endIndex; i++) result.push(i);
  }
  return result;
}

describe('shouldVirtualizeOutline', () => {
  it('enables only at/above the threshold', () => {
    expect(shouldVirtualizeOutline(OUTLINE_VIRTUALIZATION_THRESHOLD - 1)).toBe(false);
    expect(shouldVirtualizeOutline(OUTLINE_VIRTUALIZATION_THRESHOLD)).toBe(true);
    expect(shouldVirtualizeOutline(10_000)).toBe(true);
  });
});

describe('computeOutlineWindow', () => {
  it('returns empty blocks for empty lists', () => {
    const result = computeOutlineWindow({ totalCount: 0, scrollTop: 0, viewportHeight: 600 });
    expect(result.blocks).toEqual([]);
    expect(result.startIndex).toBe(0);
    expect(result.endIndex).toBe(0);
  });

  it('covers the full range with rows + spacers at any scroll position', () => {
    const total = 2000;
    for (const scrollTop of [0, 500, ROW * 1000 + 7, ROW * total]) {
      const result = computeOutlineWindow({
        totalCount: total,
        scrollTop,
        viewportHeight: 600,
      });
      expect(coveredRows(result.blocks)).toBe(total);
      // 主窗口行必须真实挂载
      const mounted = new Set(mountedIndexes(result.blocks));
      for (let i = result.startIndex; i < result.endIndex; i++) {
        expect(mounted.has(i)).toBe(true);
      }
    }
  });

  it('starts at index 0 without a leading spacer when scrolled to top', () => {
    const result = computeOutlineWindow({ totalCount: 1000, scrollTop: 0, viewportHeight: 600 });
    expect(result.startIndex).toBe(0);
    expect(result.blocks[0].type).toBe('rows');
    // 视口行数 + overscan（顶部无上溢）
    const expectedEnd = Math.ceil(600 / ROW) + 1 + OUTLINE_OVERSCAN_ROWS;
    expect(result.endIndex).toBe(expectedEnd);
  });

  it('applies overscan on both sides mid-scroll', () => {
    const firstVisible = 300;
    const result = computeOutlineWindow({
      totalCount: 1000,
      scrollTop: firstVisible * ROW,
      viewportHeight: 600,
    });
    expect(result.startIndex).toBe(firstVisible - OUTLINE_OVERSCAN_ROWS);
    expect(result.endIndex).toBe(firstVisible + Math.ceil(600 / ROW) + 1 + OUTLINE_OVERSCAN_ROWS);
    expect(result.blocks.map((b) => b.type)).toEqual(['spacer', 'rows', 'spacer']);
  });

  it('clamps the window at the tail without trailing spacer', () => {
    const total = 1000;
    const result = computeOutlineWindow({
      totalCount: total,
      scrollTop: total * ROW, // 超出末尾也不越界
      viewportHeight: 600,
    });
    expect(result.endIndex).toBe(total);
    expect(result.blocks.at(-1)?.type).toBe('rows');
    expect(coveredRows(result.blocks)).toBe(total);
  });

  it('keeps a pinned row mounted outside the window with split spacers', () => {
    const result = computeOutlineWindow({
      totalCount: 2000,
      scrollTop: 0,
      viewportHeight: 600,
      pinnedIndex: 1500,
    });
    const mounted = mountedIndexes(result.blocks);
    expect(mounted).toContain(1500);
    // pinned 行拆出独立 rows 块：spacer / 主窗口 / spacer / pinned / spacer 结构
    expect(result.blocks.map((b) => b.type))
      .toEqual(['rows', 'spacer', 'rows', 'spacer']);
    expect(coveredRows(result.blocks)).toBe(2000);
  });

  it('does not duplicate a pinned row already inside the window', () => {
    const result = computeOutlineWindow({
      totalCount: 2000,
      scrollTop: 0,
      viewportHeight: 600,
      pinnedIndex: 3,
    });
    const mounted = mountedIndexes(result.blocks);
    expect(mounted.filter((i) => i === 3)).toHaveLength(1);
    expect(coveredRows(result.blocks)).toBe(2000);
  });

  it('ignores out-of-range pinned indexes', () => {
    const result = computeOutlineWindow({
      totalCount: 100,
      scrollTop: 0,
      viewportHeight: 600,
      pinnedIndex: 5000,
    });
    expect(coveredRows(result.blocks)).toBe(100);
    expect(Math.max(...mountedIndexes(result.blocks))).toBeLessThan(100);
  });
});

describe('estimateScrollTopForIndex', () => {
  it('centers the target row in the viewport', () => {
    const index = 100;
    const viewport = 600;
    const top = estimateScrollTopForIndex(index, viewport);
    expect(top).toBe(index * ROW - viewport / 2 + ROW / 2);
  });

  it('clamps to zero near the top', () => {
    expect(estimateScrollTopForIndex(0, 600)).toBe(0);
    expect(estimateScrollTopForIndex(2, 600)).toBe(0);
  });
});
