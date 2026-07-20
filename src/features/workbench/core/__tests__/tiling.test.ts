/**
 * P2 — getActiveTilingPair 语义与单槽缓存单测。
 * 缓存不变量：store 从不原地改 windows，引用相等 ⇒ 内容相等，
 * 同一引用重复调用必须直接命中（每窗 selector × 每次 set 的 O(N²) 消除点）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getActiveTilingPair,
  getTilingRatioForWindow,
  hasDockObstructedWindow,
  resetActiveTilingPairCacheForTests,
  tilingPairKey,
} from '../tiling';
import { makeWin } from './testUtils';
import type { WorkbenchWindow } from '../types';

function toMap(wins: WorkbenchWindow[]): Record<string, WorkbenchWindow> {
  return Object.fromEntries(wins.map((w) => [w.id, w]));
}

describe('tiling — getActiveTilingPair 语义', () => {
  beforeEach(() => resetActiveTilingPairCacheForTests());

  it('左右各取 zIndex 最高且未最小化的窗口组成 active pair', () => {
    const leftBack = makeWin({ displayMode: 'tiled-left', zIndex: 10 });
    const leftTop = makeWin({ displayMode: 'tiled-left', zIndex: 30 });
    const right = makeWin({ displayMode: 'tiled-right', zIndex: 20 });
    const floating = makeWin({ displayMode: 'floating', zIndex: 99 });
    const pair = getActiveTilingPair(toMap([leftBack, leftTop, right, floating]));
    expect(pair?.left.id).toBe(leftTop.id);
    expect(pair?.right.id).toBe(right.id);
    expect(pair?.key).toBe(tilingPairKey(leftTop.id, right.id));
  });

  it('最小化窗口不参与配对；缺一侧时返回 null', () => {
    const left = makeWin({ displayMode: 'tiled-left' });
    const right = makeWin({ displayMode: 'tiled-right', minimized: true });
    expect(getActiveTilingPair(toMap([left, right]))).toBeNull();
    expect(getActiveTilingPair(toMap([left]))).toBeNull();
  });

  it('数组入参与 map 入参语义一致', () => {
    const left = makeWin({ displayMode: 'tiled-left' });
    const right = makeWin({ displayMode: 'tiled-right' });
    const fromArray = getActiveTilingPair([left, right]);
    const fromMap = getActiveTilingPair(toMap([left, right]));
    expect(fromArray?.key).toBe(fromMap?.key);
  });
});

describe('tiling — active pair 单槽缓存', () => {
  beforeEach(() => resetActiveTilingPairCacheForTests());

  it('同一 windows 引用重复调用返回同一结果对象（缓存命中，不重复遍历）', () => {
    const windows = toMap([
      makeWin({ displayMode: 'tiled-left' }),
      makeWin({ displayMode: 'tiled-right' }),
    ]);
    const first = getActiveTilingPair(windows);
    expect(first).not.toBeNull();
    expect(getActiveTilingPair(windows)).toBe(first);

    // 原地篡改内容也仍命中缓存 —— 证明确实没有重新遍历
    //（store 从不原地改 windows，此场景现实中不存在）
    for (const win of Object.values(windows)) {
      (win as { minimized: boolean }).minimized = true;
    }
    expect(getActiveTilingPair(windows)).toBe(first);
  });

  it('新引用触发重算（换 pair 后不返回旧缓存）', () => {
    const left = makeWin({ displayMode: 'tiled-left', zIndex: 10 });
    const right = makeWin({ displayMode: 'tiled-right', zIndex: 20 });
    const before = getActiveTilingPair(toMap([left, right]));
    expect(before?.left.id).toBe(left.id);

    const newLeft = makeWin({ displayMode: 'tiled-left', zIndex: 30 });
    const after = getActiveTilingPair(toMap([left, right, newLeft]));
    expect(after?.left.id).toBe(newLeft.id);
    expect(after?.key).toBe(tilingPairKey(newLeft.id, right.id));
  });

  it('缓存 null 结果同样按引用命中', () => {
    const windows = toMap([makeWin({ displayMode: 'floating' })]);
    expect(getActiveTilingPair(windows)).toBeNull();
    expect(getActiveTilingPair(windows)).toBeNull();

    const withPair = toMap([
      makeWin({ displayMode: 'tiled-left' }),
      makeWin({ displayMode: 'tiled-right' }),
    ]);
    expect(getActiveTilingPair(withPair)).not.toBeNull();
  });

  it('getTilingRatioForWindow 经缓存后语义不变', () => {
    const left = makeWin({ displayMode: 'tiled-left' });
    const right = makeWin({ displayMode: 'tiled-right' });
    const other = makeWin({ displayMode: 'floating' });
    const windows = toMap([left, right, other]);
    const ratios = { [tilingPairKey(left.id, right.id)]: 0.7 };

    expect(getTilingRatioForWindow(windows, ratios, left.id)).toBe(0.7);
    expect(getTilingRatioForWindow(windows, ratios, right.id)).toBe(0.7);
    expect(getTilingRatioForWindow(windows, ratios, other.id)).toBeUndefined();
  });
});

describe('tiling — hasDockObstructedWindow（Dock 强制自动隐藏判定）', () => {
  it('触底受管模式（maximized / 左右平铺 / 下半四分屏）触发', () => {
    for (const mode of ['maximized', 'tiled-left', 'tiled-right', 'tiled-bl', 'tiled-br'] as const) {
      expect(hasDockObstructedWindow([makeWin({ displayMode: mode })])).toBe(true);
    }
  });

  it('不触底模式（floating / 上半四分屏）不触发', () => {
    for (const mode of ['floating', 'tiled-tl', 'tiled-tr'] as const) {
      expect(hasDockObstructedWindow([makeWin({ displayMode: mode })])).toBe(false);
    }
  });

  it('最小化窗口不触发；map 入参语义一致', () => {
    const win = makeWin({ displayMode: 'tiled-left', minimized: true });
    expect(hasDockObstructedWindow([win])).toBe(false);
    expect(hasDockObstructedWindow({ [win.id]: win })).toBe(false);
    const visible = makeWin({ displayMode: 'maximized' });
    expect(hasDockObstructedWindow({ [visible.id]: visible })).toBe(true);
  });
});
