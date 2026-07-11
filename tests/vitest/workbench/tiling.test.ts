/**
 * P2 — core/tiling.ts 完整版几何测试
 * 覆盖：12+ 平铺形态、margin 互补不变量、ratio 边界 clamp、zoneToDisplayMode 映射
 */
import { describe, it, expect } from 'vitest';
import {
  computeTiledFrame,
  getActiveTilingPair,
  getTilingRatioForWindow,
  zoneToDisplayMode,
  clampTilingRatio,
  tilingPairKey,
  DEFAULT_TILE_MARGIN,
  MIN_TILING_RATIO,
  MAX_TILING_RATIO,
} from '@/features/workbench/core/tiling';
import type { DisplayMode, SnapZone, TilingContext } from '@/features/workbench/core/types';
import type { WorkbenchWindow } from '@/features/workbench/core/types';

const DESKTOP = { w: 1600, h: 1000 };

function ctx(margin: number, ratio?: number): TilingContext {
  return { desktopSize: DESKTOP, margin, ratio };
}

describe('computeTiledFrame — 12 种平铺形态', () => {
  const tiledModes: DisplayMode[] = [
    'tiled-left',
    'tiled-right',
    'tiled-tl',
    'tiled-tr',
    'tiled-bl',
    'tiled-br',
  ];

  describe.each([0, 8])('margin=%i', (m) => {
    it.each(tiledModes)('%s 不超界且尺寸为正', (mode) => {
      const f = computeTiledFrame(mode, ctx(m))!;
      expect(f).not.toBeNull();
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.y).toBeGreaterThanOrEqual(0);
      expect(f.w).toBeGreaterThan(0);
      expect(f.h).toBeGreaterThan(0);
      expect(f.x + f.w).toBeLessThanOrEqual(DESKTOP.w);
      expect(f.y + f.h).toBeLessThanOrEqual(DESKTOP.h);
    });

    it('左右平铺水平互补：left.x+left.w+m = right.x；right 右缘贴外缘 margin', () => {
      const left = computeTiledFrame('tiled-left', ctx(m))!;
      const right = computeTiledFrame('tiled-right', ctx(m))!;
      expect(left.x).toBe(m);
      expect(left.x + left.w + m).toBe(right.x);
      expect(right.x + right.w + m).toBe(DESKTOP.w);
      expect(left.y).toBe(m);
      expect(left.h).toBe(DESKTOP.h - m * 2);
      expect(right.h).toBe(left.h);
    });

    it('四分屏两轴互补且列与半屏对齐', () => {
      const tl = computeTiledFrame('tiled-tl', ctx(m))!;
      const tr = computeTiledFrame('tiled-tr', ctx(m))!;
      const bl = computeTiledFrame('tiled-bl', ctx(m))!;
      const br = computeTiledFrame('tiled-br', ctx(m))!;
      // 水平互补
      expect(tl.x + tl.w + m).toBe(tr.x);
      expect(tr.x + tr.w + m).toBe(DESKTOP.w);
      // 垂直互补
      expect(tl.y + tl.h + m).toBe(bl.y);
      expect(bl.y + bl.h + m).toBe(DESKTOP.h);
      // 同列/同行几何一致
      expect(bl.x).toBe(tl.x);
      expect(bl.w).toBe(tl.w);
      expect(br.x).toBe(tr.x);
      expect(br.w).toBe(tr.w);
      expect(tr.y).toBe(tl.y);
      expect(br.y).toBe(bl.y);
      // 四分屏列 = 0.5 分割的左右半屏列
      const halfLeft = computeTiledFrame('tiled-left', ctx(m, 0.5))!;
      expect(tl.x).toBe(halfLeft.x);
      expect(tl.w).toBe(halfLeft.w);
    });
  });

  it('maximized 填满整个桌面（无 margin）', () => {
    expect(computeTiledFrame('maximized', ctx(8))).toEqual({ x: 0, y: 0, w: 1600, h: 1000 });
    expect(computeTiledFrame('maximized', ctx(0))).toEqual({ x: 0, y: 0, w: 1600, h: 1000 });
  });

  it('floating 返回 null', () => {
    expect(computeTiledFrame('floating', ctx(8))).toBeNull();
  });

  it('margin=8 时的具体数值（1600×1000 基准）', () => {
    // availW = 1600 - 24 = 1576，availH = 1000 - 24 = 976
    expect(computeTiledFrame('tiled-left', ctx(8))).toEqual({ x: 8, y: 8, w: 788, h: 984 });
    expect(computeTiledFrame('tiled-right', ctx(8))).toEqual({ x: 804, y: 8, w: 788, h: 984 });
    expect(computeTiledFrame('tiled-tl', ctx(8))).toEqual({ x: 8, y: 8, w: 788, h: 488 });
    expect(computeTiledFrame('tiled-br', ctx(8))).toEqual({ x: 804, y: 504, w: 788, h: 488 });
  });
});

describe('computeTiledFrame — ratio', () => {
  it('ratio 作用于左右平铺对且互补', () => {
    const left = computeTiledFrame('tiled-left', ctx(8, 0.7))!;
    const right = computeTiledFrame('tiled-right', ctx(8, 0.7))!;
    // availW = 1576，leftW = round(1576*0.7) = 1103
    expect(left.w).toBe(1103);
    expect(right.w).toBe(1576 - 1103);
    expect(left.x + left.w + 8).toBe(right.x);
    expect(right.x + right.w + 8).toBe(1600);
  });

  it('ratio 越界 clamp 到 0.2–0.8', () => {
    const narrow = computeTiledFrame('tiled-left', ctx(0, 0.05))!;
    expect(narrow.w).toBe(Math.round(1600 * MIN_TILING_RATIO));
    const wide = computeTiledFrame('tiled-left', ctx(0, 0.95))!;
    expect(wide.w).toBe(Math.round(1600 * MAX_TILING_RATIO));
  });

  it('ratio 不影响四分屏（固定 0.5 分列）', () => {
    const tl05 = computeTiledFrame('tiled-tl', ctx(8, 0.5))!;
    const tl08 = computeTiledFrame('tiled-tl', ctx(8, 0.8))!;
    expect(tl08).toEqual(tl05);
  });

  it('极小桌面不产生负尺寸', () => {
    const f = computeTiledFrame('tiled-left', { desktopSize: { w: 10, h: 10 }, margin: 8 })!;
    expect(f.w).toBeGreaterThanOrEqual(0);
    expect(f.h).toBeGreaterThanOrEqual(0);
  });
});

describe('clampTilingRatio', () => {
  it('区间内原样返回', () => {
    expect(clampTilingRatio(0.5)).toBe(0.5);
    expect(clampTilingRatio(MIN_TILING_RATIO)).toBe(0.2);
    expect(clampTilingRatio(MAX_TILING_RATIO)).toBe(0.8);
  });
  it('越界 clamp', () => {
    expect(clampTilingRatio(0)).toBe(0.2);
    expect(clampTilingRatio(1)).toBe(0.8);
    expect(clampTilingRatio(-3)).toBe(0.2);
  });
  it('非法值回退 0.5', () => {
    expect(clampTilingRatio(NaN)).toBe(0.5);
    expect(clampTilingRatio(Infinity)).toBe(0.5);
  });
});

describe('zoneToDisplayMode', () => {
  const cases: Array<[SnapZone, DisplayMode | null]> = [
    ['left', 'tiled-left'],
    ['right', 'tiled-right'],
    ['tl', 'tiled-tl'],
    ['tr', 'tiled-tr'],
    ['bl', 'tiled-bl'],
    ['br', 'tiled-br'],
    ['top-maximize', 'maximized'],
    [null, null],
  ];
  it.each(cases)('%s → %s', (zone, mode) => {
    expect(zoneToDisplayMode(zone)).toBe(mode);
  });
});

describe('tilingPairKey / 常量', () => {
  it('key 与快照格式一致', () => {
    expect(tilingPairKey('a', 'b')).toBe('a:b');
  });
  it('默认 margin 为 8', () => {
    expect(DEFAULT_TILE_MARGIN).toBe(8);
  });
});

describe('active tiling pair', () => {
  const win = (id: string, mode: DisplayMode, zIndex: number): WorkbenchWindow => ({
    id,
    typeId: 'test',
    instanceKey: null,
    title: id,
    frame: { x: 0, y: 0, w: 100, h: 100 },
    restoreFrame: null,
    displayMode: mode,
    minimized: false,
    zIndex,
    createdAt: zIndex,
    lastFocusedAt: zIndex,
  });

  it('同侧多窗时只选择左右各自顶层窗口，并按新 pair key 取比例', () => {
    const oldLeft = win('old-left', 'tiled-left', 10);
    const activeLeft = win('active-left', 'tiled-left', 30);
    const right = win('right', 'tiled-right', 20);
    const windows = { [oldLeft.id]: oldLeft, [activeLeft.id]: activeLeft, [right.id]: right };
    const pair = getActiveTilingPair(windows);
    expect(pair?.key).toBe('active-left:right');
    expect(getTilingRatioForWindow(windows, {
      'old-left:right': 0.7,
      'active-left:right': 0.6,
    }, activeLeft.id)).toBe(0.6);
    expect(getTilingRatioForWindow(windows, { 'old-left:right': 0.7 }, right.id)).toBe(0.5);
    expect(getTilingRatioForWindow(windows, { 'old-left:right': 0.7 }, oldLeft.id)).toBeUndefined();
  });
});
