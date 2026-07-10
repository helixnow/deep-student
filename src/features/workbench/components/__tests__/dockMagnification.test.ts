/**
 * dockMagnification 纯函数：连续左侧扩张量（防跨图标跳变）
 */
import { describe, it, expect } from 'vitest';
import { dockMagLeftExpansion } from '../dockMagnification';

describe('dockMagLeftExpansion', () => {
  const centers = [22, 70, 118];
  const widths = [44, 44, 44];

  it('指针在图标中心时等于离散锚点 prefix + extra/2', () => {
    const extras = [10, 20, 10];
    // 第二颗中心：应计入全部 extra0 + 一半 extra1
    expect(dockMagLeftExpansion(70, centers, widths, extras)).toBeCloseTo(10 + 10, 5);
  });

  it('跨两图标中点时连续（无半个 extra 跳变）', () => {
    const extras = [12, 12, 4];
    // 中点在 46（22+24）；离散锚点会在此从 extra0/2 跳到 extra0+extra1/2
    const justLeft = dockMagLeftExpansion(45.9, centers, widths, extras);
    const justRight = dockMagLeftExpansion(46.1, centers, widths, extras);
    expect(Math.abs(justRight - justLeft)).toBeLessThan(0.5);
  });

  it('在图标宽度内随穿过比例线性增加', () => {
    const extras = [0, 20, 0];
    const leftEdge = 70 - 22;
    const mid = dockMagLeftExpansion(70, centers, widths, extras);
    const quarter = dockMagLeftExpansion(leftEdge + 11, centers, widths, extras);
    expect(mid).toBeCloseTo(10, 5);
    expect(quarter).toBeCloseTo(5, 5);
  });

  it('指针在全部图标左侧为 0，右侧为 total', () => {
    const extras = [8, 10, 6];
    expect(dockMagLeftExpansion(0, centers, widths, extras)).toBe(0);
    expect(dockMagLeftExpansion(200, centers, widths, extras)).toBe(24);
  });
});
