/**
 * P1 — occlusion 遮挡矩阵单测
 * true = 完全被遮挡（无可见面积）；部分可见 = false。
 *
 * O10 扩展：遮挡明细（visibleRatio）与增量重算（computeOcclusionIncremental）
 * 的正确性——增量结果必须与全量逐轮等价，且只重算受影响窗口。
 */
import { describe, expect, it } from 'vitest';
import {
  computeDesktopCoveredRatio,
  computeOcclusion,
  computeOcclusionDetail,
  computeOcclusionIncremental,
  createOcclusionCache,
  getLastOcclusionStats,
} from '../occlusion';
import { makeWin } from './testUtils';
import type { Size, WorkbenchWindow } from '../types';

const DESKTOP: Size = { w: 1600, h: 900 };

describe('computeOcclusion', () => {
  it('单窗不被遮挡', () => {
    const win = makeWin({ id: 'solo', frame: { x: 100, y: 100, w: 400, h: 300 } });
    expect(computeOcclusion([win], DESKTOP)).toEqual({ solo: false });
  });

  it('被单个上层窗口完全覆盖 → true', () => {
    const below = makeWin({ id: 'below', zIndex: 1, frame: { x: 100, y: 100, w: 200, h: 200 } });
    const above = makeWin({ id: 'above', zIndex: 2, frame: { x: 50, y: 50, w: 400, h: 400 } });
    const result = computeOcclusion([below, above], DESKTOP);
    expect(result.below).toBe(true);
    expect(result.above).toBe(false);
  });

  it('部分遮挡 = 可见（false）', () => {
    const below = makeWin({ id: 'below', zIndex: 1, frame: { x: 100, y: 100, w: 400, h: 300 } });
    const above = makeWin({ id: 'above', zIndex: 2, frame: { x: 150, y: 150, w: 400, h: 300 } });
    expect(computeOcclusion([below, above], DESKTOP).below).toBe(false);
  });

  it('单窗均不足以覆盖、但两窗并集完全覆盖 → true', () => {
    const below = makeWin({ id: 'below', zIndex: 1, frame: { x: 0, y: 0, w: 400, h: 300 } });
    const left = makeWin({ id: 'left', zIndex: 2, frame: { x: 0, y: 0, w: 200, h: 300 } });
    const right = makeWin({ id: 'right', zIndex: 3, frame: { x: 200, y: 0, w: 200, h: 300 } });
    const result = computeOcclusion([below, left, right], DESKTOP);
    expect(result.below).toBe(true);
    expect(result.left).toBe(false);
    expect(result.right).toBe(false);
  });

  it('zIndex 更低的窗口不参与遮挡上层', () => {
    const big = makeWin({ id: 'big', zIndex: 1, frame: { x: 0, y: 0, w: 800, h: 600 } });
    const small = makeWin({ id: 'small', zIndex: 2, frame: { x: 100, y: 100, w: 200, h: 150 } });
    // small 完全位于 big 内，但 small 在上层 → 可见
    expect(computeOcclusion([big, small], DESKTOP).small).toBe(false);
  });

  it('minimized 窗口本身记为 true 且不遮挡他人', () => {
    const below = makeWin({ id: 'below', zIndex: 1, frame: { x: 100, y: 100, w: 200, h: 200 } });
    const mini = makeWin({
      id: 'mini',
      zIndex: 2,
      minimized: true,
      frame: { x: 0, y: 0, w: 1600, h: 900 },
    });
    const result = computeOcclusion([below, mini], DESKTOP);
    expect(result.mini).toBe(true);
    expect(result.below).toBe(false);
  });

  it('完全移出桌面可视区 → true；部分越界仍可见', () => {
    const offscreen = makeWin({ id: 'off', frame: { x: 2000, y: 100, w: 300, h: 200 } });
    const partial = makeWin({ id: 'part', frame: { x: -100, y: 100, w: 300, h: 200 } });
    const result = computeOcclusion([offscreen, partial], DESKTOP);
    expect(result.off).toBe(true);
    expect(result.part).toBe(false);
  });

  it('maximized 上层窗口按平铺几何遮挡整个桌面', () => {
    const below = makeWin({ id: 'below', zIndex: 1, frame: { x: 500, y: 400, w: 400, h: 300 } });
    // frame 很小，但 displayMode=maximized 的实际渲染矩形是全桌面
    const max = makeWin({
      id: 'max',
      zIndex: 2,
      displayMode: 'maximized',
      frame: { x: 0, y: 0, w: 10, h: 10 },
    });
    expect(computeOcclusion([below, max], DESKTOP).below).toBe(true);
  });

  it('tiled 窗口按平铺几何参与遮挡', () => {
    const leftHalf = makeWin({
      id: 'tiledLeft',
      zIndex: 5,
      displayMode: 'tiled-left',
      frame: { x: 0, y: 0, w: 10, h: 10 },
    });
    const under = makeWin({ id: 'under', zIndex: 1, frame: { x: 100, y: 100, w: 300, h: 200 } });
    const rightSide = makeWin({
      id: 'rightSide',
      zIndex: 2,
      frame: { x: 900, y: 100, w: 300, h: 200 },
    });
    const result = computeOcclusion([leftHalf, under, rightSide], DESKTOP);
    expect(result.under).toBe(true); // 完全在左半屏内
    expect(result.rightSide).toBe(false); // 在右半屏，不受影响
  });

  it('DoD：5 窗叠放遮挡判定正确（含部分遮挡=visible）', () => {
    const w1 = makeWin({ id: 'w1', zIndex: 1, frame: { x: 0, y: 0, w: 300, h: 300 } });
    const w2 = makeWin({ id: 'w2', zIndex: 2, frame: { x: 0, y: 0, w: 300, h: 300 } }); // 与 w1 重合，被 w3+w4 并集盖住
    const w3 = makeWin({ id: 'w3', zIndex: 3, frame: { x: 0, y: 0, w: 300, h: 150 } });
    const w4 = makeWin({ id: 'w4', zIndex: 4, frame: { x: 0, y: 150, w: 300, h: 150 } });
    const w5 = makeWin({ id: 'w5', zIndex: 5, frame: { x: 100, y: 100, w: 100, h: 100 } });
    const result = computeOcclusion([w1, w2, w3, w4, w5], DESKTOP);
    expect(result).toEqual({
      w1: true, // 被 w3+w4 并集完全覆盖
      w2: true, // 同上
      w3: false, // 顶部条带只被 w5 部分遮挡
      w4: false, // 底部条带只被 w5 部分遮挡
      w5: false, // 最顶层
    });
  });
});

// ============================================================================
// O10 — 遮挡明细（visibleRatio）
// ============================================================================

describe('computeOcclusionDetail — 可见比例', () => {
  it('无遮挡单窗 ratio=1', () => {
    const win = makeWin({ id: 'solo', frame: { x: 100, y: 100, w: 400, h: 300 } });
    const detail = computeOcclusionDetail([win], DESKTOP);
    expect(detail.solo).toEqual({ occluded: false, visibleRatio: 1 });
  });

  it('右半被上层覆盖 ratio=0.5', () => {
    const below = makeWin({ id: 'below', zIndex: 1, frame: { x: 100, y: 100, w: 400, h: 300 } });
    const above = makeWin({ id: 'above', zIndex: 2, frame: { x: 300, y: 100, w: 400, h: 300 } });
    const detail = computeOcclusionDetail([below, above], DESKTOP);
    expect(detail.below.occluded).toBe(false);
    expect(detail.below.visibleRatio).toBeCloseTo(0.5, 6);
    expect(detail.above.visibleRatio).toBe(1);
  });

  it('完全遮挡 → occluded=true 且 ratio=0', () => {
    const below = makeWin({ id: 'below', zIndex: 1, frame: { x: 100, y: 100, w: 200, h: 200 } });
    const above = makeWin({ id: 'above', zIndex: 2, frame: { x: 50, y: 50, w: 400, h: 400 } });
    expect(computeOcclusionDetail([below, above], DESKTOP).below).toEqual({
      occluded: true,
      visibleRatio: 0,
    });
  });

  it('部分越界：桌面裁剪计入 ratio（左半在屏外 → 0.5）', () => {
    const win = makeWin({ id: 'edge', frame: { x: -150, y: 100, w: 300, h: 200 } });
    const detail = computeOcclusionDetail([win], DESKTOP);
    expect(detail.edge.occluded).toBe(false);
    expect(detail.edge.visibleRatio).toBeCloseTo(0.5, 6);
  });

  it('minimized → ratio=0', () => {
    const mini = makeWin({ id: 'mini', minimized: true });
    expect(computeOcclusionDetail([mini], DESKTOP).mini).toEqual({
      occluded: true,
      visibleRatio: 0,
    });
  });
});

// ============================================================================
// 桌面（壁纸）覆盖比例
// ============================================================================

describe('computeDesktopCoveredRatio — 桌面覆盖比例', () => {
  it('无窗口 / 全 minimized → 0', () => {
    expect(computeDesktopCoveredRatio([], DESKTOP)).toBe(0);
    const mini = makeWin({ id: 'dm', minimized: true, frame: { x: 0, y: 0, w: 1600, h: 900 } });
    expect(computeDesktopCoveredRatio([mini], DESKTOP)).toBe(0);
  });

  it('桌面面积非法（0）→ 0', () => {
    const win = makeWin({ id: 'dz', frame: { x: 0, y: 0, w: 400, h: 300 } });
    expect(computeDesktopCoveredRatio([win], { w: 0, h: 0 })).toBe(0);
  });

  it('单窗覆盖半个桌面 → 0.5', () => {
    const win = makeWin({ id: 'dh', frame: { x: 0, y: 0, w: 800, h: 900 } });
    expect(computeDesktopCoveredRatio([win], DESKTOP)).toBeCloseTo(0.5, 6);
  });

  it('并集去重：两窗重叠不会重复计入', () => {
    // 两窗各 1000 宽、重叠 400 → 并集 1600 宽盖满桌面
    const a = makeWin({ id: 'da', zIndex: 1, frame: { x: 0, y: 0, w: 1000, h: 900 } });
    const b = makeWin({ id: 'db', zIndex: 2, frame: { x: 600, y: 0, w: 1000, h: 900 } });
    expect(computeDesktopCoveredRatio([a, b], DESKTOP)).toBe(1);
  });

  it('多窗拼合：中间留缝时比例 < 1 且精确', () => {
    // 左右两窗中间留 20px 竖缝 → 1 - 20*900/(1600*900) = 0.9875
    const left = makeWin({ id: 'dl', zIndex: 1, frame: { x: 0, y: 0, w: 790, h: 900 } });
    const right = makeWin({ id: 'dr', zIndex: 2, frame: { x: 810, y: 0, w: 790, h: 900 } });
    expect(computeDesktopCoveredRatio([left, right], DESKTOP)).toBeCloseTo(0.9875, 6);
  });

  it('越界部分不计入（先裁剪到桌面可视区）', () => {
    // 左半在屏外：有效覆盖 400x900
    const win = makeWin({ id: 'do', frame: { x: -400, y: 0, w: 800, h: 900 } });
    expect(computeDesktopCoveredRatio([win], DESKTOP)).toBeCloseTo(0.25, 6);
    // 完全离屏 → 0
    const off = makeWin({ id: 'df', frame: { x: 2000, y: 0, w: 800, h: 900 } });
    expect(computeDesktopCoveredRatio([off], DESKTOP)).toBe(0);
  });

  it('maximized / tiled 按平铺派生几何计入', () => {
    const max = makeWin({
      id: 'dx',
      displayMode: 'maximized',
      frame: { x: 0, y: 0, w: 10, h: 10 },
    });
    expect(computeDesktopCoveredRatio([max], DESKTOP)).toBe(1);
    const tiledLeft = makeWin({
      id: 'dt',
      displayMode: 'tiled-left',
      frame: { x: 0, y: 0, w: 10, h: 10 },
    });
    expect(computeDesktopCoveredRatio([tiledLeft], DESKTOP)).toBeCloseTo(0.5, 6);
  });
});

// ============================================================================
// O10 — 增量重算
// ============================================================================

describe('computeOcclusionIncremental — 增量重算', () => {
  it('首轮为全量，结果与 computeOcclusionDetail 等价', () => {
    const cache = createOcclusionCache();
    const wins = [
      makeWin({ id: 'ia', zIndex: 1, frame: { x: 0, y: 0, w: 300, h: 300 } }),
      makeWin({ id: 'ib', zIndex: 2, frame: { x: 100, y: 100, w: 300, h: 300 } }),
      makeWin({ id: 'ic', zIndex: 3, minimized: true }),
    ];
    const result = computeOcclusionIncremental(cache, wins, DESKTOP);
    expect(result).toEqual(computeOcclusionDetail(wins, DESKTOP));
    expect(getLastOcclusionStats(cache)?.mode).toBe('full');
  });

  it('移动孤立窗口：只重算该窗口（dirtyCount=1），他窗结果复用', () => {
    const cache = createOcclusionCache();
    const a = makeWin({ id: 'ma', zIndex: 1, frame: { x: 0, y: 0, w: 300, h: 300 } });
    const b = makeWin({ id: 'mb', zIndex: 2, frame: { x: 1000, y: 0, w: 300, h: 300 } });
    const c = makeWin({ id: 'mc', zIndex: 3, frame: { x: 500, y: 500, w: 200, h: 200 } });
    computeOcclusionIncremental(cache, [a, b, c], DESKTOP);

    const bMoved = { ...b, frame: { x: 1000, y: 50, w: 300, h: 300 } };
    const result = computeOcclusionIncremental(cache, [a, bMoved, c], DESKTOP);
    const stats = getLastOcclusionStats(cache);
    expect(stats?.mode).toBe('incremental');
    expect(stats?.dirtyCount).toBe(1);
    expect(result).toEqual(computeOcclusionDetail([a, bMoved, c], DESKTOP));
  });

  it('窗口移入覆盖他窗：下层被标脏并正确判定为遮挡', () => {
    const cache = createOcclusionCache();
    const below = makeWin({ id: 'nb', zIndex: 1, frame: { x: 100, y: 100, w: 200, h: 200 } });
    const mover = makeWin({ id: 'nm', zIndex: 2, frame: { x: 900, y: 100, w: 400, h: 400 } });
    computeOcclusionIncremental(cache, [below, mover], DESKTOP);
    expect(computeOcclusionDetail([below, mover], DESKTOP).nb.occluded).toBe(false);

    const moved = { ...mover, frame: { x: 50, y: 50, w: 400, h: 400 } };
    const result = computeOcclusionIncremental(cache, [below, moved], DESKTOP);
    expect(result.nb.occluded).toBe(true);
    expect(result).toEqual(computeOcclusionDetail([below, moved], DESKTOP));
  });

  it('关闭上层窗口：被释放的下层恢复可见', () => {
    const cache = createOcclusionCache();
    const below = makeWin({ id: 'cb', zIndex: 1, frame: { x: 100, y: 100, w: 200, h: 200 } });
    const cover = makeWin({ id: 'cc', zIndex: 2, frame: { x: 50, y: 50, w: 400, h: 400 } });
    const first = computeOcclusionIncremental(cache, [below, cover], DESKTOP);
    expect(first.cb.occluded).toBe(true);

    const result = computeOcclusionIncremental(cache, [below], DESKTOP);
    expect(result.cb).toEqual({ occluded: false, visibleRatio: 1 });
    expect(result).toEqual(computeOcclusionDetail([below], DESKTOP));
  });

  it('minimized 切换与 zIndex 提升（聚焦）：与全量一致', () => {
    const cache = createOcclusionCache();
    const a = makeWin({ id: 'za', zIndex: 1, frame: { x: 100, y: 100, w: 300, h: 300 } });
    const b = makeWin({ id: 'zb', zIndex: 2, frame: { x: 100, y: 100, w: 300, h: 300 } });
    computeOcclusionIncremental(cache, [a, b], DESKTOP);

    // 聚焦 a：zIndex 提到最高 → b 反被遮挡
    const aTop = { ...a, zIndex: 3 };
    const afterFocus = computeOcclusionIncremental(cache, [aTop, b], DESKTOP);
    expect(afterFocus).toEqual(computeOcclusionDetail([aTop, b], DESKTOP));
    expect(afterFocus.zb.occluded).toBe(true);

    // 最小化 a → b 恢复可见，a 记 hidden
    const aMin = { ...aTop, minimized: true };
    const afterMin = computeOcclusionIncremental(cache, [aMin, b], DESKTOP);
    expect(afterMin).toEqual(computeOcclusionDetail([aMin, b], DESKTOP));
    expect(afterMin.za).toEqual({ occluded: true, visibleRatio: 0 });
    expect(afterMin.zb.occluded).toBe(false);

    // 反最小化 → 回到聚焦后布局
    const restored = computeOcclusionIncremental(cache, [aTop, b], DESKTOP);
    expect(restored).toEqual(computeOcclusionDetail([aTop, b], DESKTOP));
  });

  it('桌面尺寸变化：退化为全量重算（tiled 派生矩形失效）', () => {
    const cache = createOcclusionCache();
    const tiled = makeWin({
      id: 'ta',
      zIndex: 2,
      displayMode: 'tiled-left',
      frame: { x: 0, y: 0, w: 10, h: 10 },
    });
    const under = makeWin({ id: 'tu', zIndex: 1, frame: { x: 100, y: 100, w: 300, h: 200 } });
    computeOcclusionIncremental(cache, [tiled, under], DESKTOP);

    const smaller: Size = { w: 900, h: 600 };
    const result = computeOcclusionIncremental(cache, [tiled, under], smaller);
    expect(getLastOcclusionStats(cache)?.mode).toBe('full');
    expect(result).toEqual(computeOcclusionDetail([tiled, under], smaller));
  });

  it('随机操作序列：增量与全量逐轮等价（100 步）', () => {
    // 可复现的 LCG 伪随机
    let seed = 20260708;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const randInt = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;

    const cache = createOcclusionCache();
    let zTop = 100;
    let nextId = 0;
    const modes = ['floating', 'floating', 'floating', 'maximized', 'tiled-left', 'tiled-right'] as const;
    const spawn = (): WorkbenchWindow =>
      makeWin({
        id: `rnd_${nextId++}`,
        zIndex: ++zTop,
        displayMode: modes[randInt(0, modes.length - 1)],
        frame: {
          x: randInt(-200, 1500),
          y: randInt(-100, 800),
          w: randInt(100, 700),
          h: randInt(100, 500),
        },
      });

    let wins: WorkbenchWindow[] = Array.from({ length: 6 }, spawn);
    computeOcclusionIncremental(cache, wins, DESKTOP);

    for (let step = 0; step < 100; step++) {
      const op = randInt(0, 5);
      if (op === 0 && wins.length > 0) {
        // 移动
        const i = randInt(0, wins.length - 1);
        wins = wins.map((w, idx) =>
          idx === i
            ? { ...w, frame: { ...w.frame, x: randInt(-200, 1500), y: randInt(-100, 800) } }
            : w,
        );
      } else if (op === 1 && wins.length > 0) {
        // 缩放
        const i = randInt(0, wins.length - 1);
        wins = wins.map((w, idx) =>
          idx === i ? { ...w, frame: { ...w.frame, w: randInt(100, 700), h: randInt(100, 500) } } : w,
        );
      } else if (op === 2 && wins.length > 0) {
        // 聚焦（zIndex 提升）
        const i = randInt(0, wins.length - 1);
        wins = wins.map((w, idx) => (idx === i ? { ...w, zIndex: ++zTop } : w));
      } else if (op === 3 && wins.length > 0) {
        // 最小化切换
        const i = randInt(0, wins.length - 1);
        wins = wins.map((w, idx) => (idx === i ? { ...w, minimized: !w.minimized } : w));
      } else if (op === 4 && wins.length > 2) {
        // 关闭
        const removeIdx = randInt(0, wins.length - 1);
        wins = wins.filter((_, idx) => idx !== removeIdx);
      } else if (wins.length < 10) {
        // 新开
        wins = [...wins, spawn()];
      }
      const incremental = computeOcclusionIncremental(cache, wins, DESKTOP);
      expect(incremental).toEqual(computeOcclusionDetail(wins, DESKTOP));
      expect(getLastOcclusionStats(cache)?.mode).toBe('incremental');
    }
  });
});
