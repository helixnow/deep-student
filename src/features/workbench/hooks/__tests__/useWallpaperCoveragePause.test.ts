/**
 * useWallpaperCoveragePause — 壁纸覆盖暂停判定
 *
 * - 纯判定 isDesktopCoveredByWindows：强遮挡（maximized / 左右满铺）、
 *   单窗 0.72 近似、并集 0.98 近全遮三条路径；
 * - hook：窗口提交后（rAF 合并）挂/摘 data-wb-wallpaper-covered，卸载清理。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { resetWindowStoreForTests, useWindowStore } from '../../core/windowStore';
import { resetWindowListCacheForTests } from '../../core/windowListCache';
import { makeWin } from '../../core/__tests__/testUtils';
import type { WorkbenchWindow } from '../../core/types';
import {
  isDesktopCoveredByWindows,
  useWallpaperCoveragePause,
} from '../useWallpaperCoveragePause';

const ATTR = 'data-wb-wallpaper-covered';
const DESKTOP = { w: 1600, h: 900 };

beforeEach(() => {
  resetWindowStoreForTests(DESKTOP);
  resetWindowListCacheForTests();
  document.documentElement.removeAttribute(ATTR);
});

afterEach(() => {
  document.documentElement.removeAttribute(ATTR);
});

describe('isDesktopCoveredByWindows — 纯判定', () => {
  it('强遮挡：非最小化 maximized → true；最小化则不算', () => {
    const max = makeWin({ id: 'cm', displayMode: 'maximized' });
    expect(isDesktopCoveredByWindows([max], DESKTOP)).toBe(true);
    expect(isDesktopCoveredByWindows([{ ...max, minimized: true }], DESKTOP)).toBe(false);
  });

  it('强遮挡：tiled-left + tiled-right 满铺对 → true；只有单侧不算', () => {
    const left = makeWin({ id: 'cl', displayMode: 'tiled-left' });
    const right = makeWin({ id: 'cr', displayMode: 'tiled-right' });
    expect(isDesktopCoveredByWindows([left, right], DESKTOP)).toBe(true);
    expect(isDesktopCoveredByWindows([left], DESKTOP)).toBe(false);
  });

  it('单窗近似：最大浮动窗面积 ≥ 0.72 桌面面积 → true', () => {
    // 1200x900 / 1600x900 = 0.75
    const big = makeWin({ id: 'cb', frame: { x: 0, y: 0, w: 1200, h: 900 } });
    expect(isDesktopCoveredByWindows([big], DESKTOP)).toBe(true);
    // 1000x900 = 0.625 < 0.72，且并集 0.625 < 0.98
    const mid = makeWin({ id: 'cd', frame: { x: 0, y: 0, w: 1000, h: 900 } });
    expect(isDesktopCoveredByWindows([mid], DESKTOP)).toBe(false);
  });

  it('并集遮挡：单窗均不足 0.72、并集近全遮（≥0.98）→ true', () => {
    // 各 790x900 ≈ 0.494，中缝 20px → 并集 0.9875 ≥ 0.98
    const left = makeWin({ id: 'ua', zIndex: 1, frame: { x: 0, y: 0, w: 790, h: 900 } });
    const right = makeWin({ id: 'ub', zIndex: 2, frame: { x: 810, y: 0, w: 790, h: 900 } });
    expect(isDesktopCoveredByWindows([left, right], DESKTOP)).toBe(true);
  });

  it('并集遮挡：覆盖不足 0.98 → false（中央留缝时壁纸仍应流动）', () => {
    // 各 700x900 ≈ 0.4375，并集 1400x900 = 0.875 < 0.98
    const left = makeWin({ id: 'na', zIndex: 1, frame: { x: 0, y: 0, w: 700, h: 900 } });
    const right = makeWin({ id: 'nb', zIndex: 2, frame: { x: 900, y: 0, w: 700, h: 900 } });
    expect(isDesktopCoveredByWindows([left, right], DESKTOP)).toBe(false);
  });

  it('并集遮挡：越界窗口按裁剪后的可视部分计', () => {
    // 两窗都大幅越界（单窗未裁剪面积 0.625 < 0.72），桌面内并集仅一半 → false
    const a = makeWin({ id: 'oa', zIndex: 1, frame: { x: -600, y: 0, w: 1000, h: 900 } });
    const b = makeWin({ id: 'ob', zIndex: 2, frame: { x: 1200, y: 0, w: 1000, h: 900 } });
    expect(isDesktopCoveredByWindows([a, b], DESKTOP)).toBe(false);
    // 四窗四分屏拼满 → true
    const quads: WorkbenchWindow[] = [
      makeWin({ id: 'q1', frame: { x: 0, y: 0, w: 800, h: 450 } }),
      makeWin({ id: 'q2', frame: { x: 800, y: 0, w: 800, h: 450 } }),
      makeWin({ id: 'q3', frame: { x: 0, y: 450, w: 800, h: 450 } }),
      makeWin({ id: 'q4', frame: { x: 800, y: 450, w: 800, h: 450 } }),
    ];
    expect(isDesktopCoveredByWindows(quads, DESKTOP)).toBe(true);
  });

  it('minimized 窗口不参与任何路径', () => {
    const wins = [
      makeWin({ id: 'ml', minimized: true, frame: { x: 0, y: 0, w: 790, h: 900 } }),
      makeWin({ id: 'mr', minimized: true, frame: { x: 810, y: 0, w: 790, h: 900 } }),
    ];
    expect(isDesktopCoveredByWindows(wins, DESKTOP)).toBe(false);
  });
});

describe('useWallpaperCoveragePause — attr 挂/摘', () => {
  function setWindows(wins: WorkbenchWindow[]): void {
    act(() => {
      useWindowStore.setState({
        windows: Object.fromEntries(wins.map((w) => [w.id, w])),
      });
    });
  }

  it('并集盖满 → 提交后挂 covered；移开 → 摘除；卸载兜底清理', async () => {
    const { unmount } = renderHook(() => useWallpaperCoveragePause());
    expect(document.documentElement.hasAttribute(ATTR)).toBe(false);

    setWindows([
      makeWin({ id: 'ha', zIndex: 1, frame: { x: 0, y: 0, w: 790, h: 900 } }),
      makeWin({ id: 'hb', zIndex: 2, frame: { x: 810, y: 0, w: 790, h: 900 } }),
    ]);
    // 订阅走 rAF 合并，等一帧提交
    await vi.waitFor(() => {
      expect(document.documentElement.hasAttribute(ATTR)).toBe(true);
    });

    setWindows([
      makeWin({ id: 'ha', zIndex: 1, frame: { x: 0, y: 0, w: 400, h: 300 } }),
    ]);
    await vi.waitFor(() => {
      expect(document.documentElement.hasAttribute(ATTR)).toBe(false);
    });

    setWindows([makeWin({ id: 'hc', displayMode: 'maximized' })]);
    await vi.waitFor(() => {
      expect(document.documentElement.hasAttribute(ATTR)).toBe(true);
    });

    unmount();
    expect(document.documentElement.hasAttribute(ATTR)).toBe(false);
  });

  it('挂载时按当前状态同步一次（无需等订阅）', () => {
    useWindowStore.setState({
      windows: { init: makeWin({ id: 'init', displayMode: 'maximized' }) },
    });
    const { unmount } = renderHook(() => useWallpaperCoveragePause());
    expect(document.documentElement.hasAttribute(ATTR)).toBe(true);
    unmount();
  });
});
