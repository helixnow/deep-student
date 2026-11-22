/**
 * dockMagnification & dockMagnificationStore 单元测试
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  DEFAULT_MAG_MAX_SCALE,
  DEFAULT_MAG_RADIUS_PX,
  MAX_MAG_MAX_SCALE,
  MIN_MAG_MAX_SCALE,
  clampMagnificationScale,
  computeDockCursorPercent,
  computeDockMagnification,
  computeMagnificationWeight,
} from '../dockMagnification';
import {
  DOCK_MAGNIFICATION_STORAGE_KEY,
  getDockMagnificationPreferences,
  resetDockMagnificationForTests,
  setDockMagnificationEnabled,
  setDockMagnificationScale,
  useDockMagnificationEffective,
  useDockMagnificationStore,
} from '../../core/dockMagnificationStore';
import { resetMaterialTierForTests, setMaterialTier } from '../../core/materialTier';

describe('dockMagnification 纯物理计算', () => {
  it('升余弦权重在中心为 1、半程约 0.5、边界及以外平滑归零', () => {
    expect(computeMagnificationWeight(0, 136)).toBeCloseTo(1, 6);
    expect(computeMagnificationWeight(68, 136)).toBeCloseTo(0.5, 6);
    expect(computeMagnificationWeight(-68, 136)).toBeCloseTo(0.5, 6);
    expect(computeMagnificationWeight(136, 136)).toBe(0);
    expect(computeMagnificationWeight(220, 136)).toBe(0);
    expect(computeMagnificationWeight(10, 0)).toBe(0);
  });

  it('指针为 null 或 maxScale=1 时全部返回静止态', () => {
    const centers = [100, 150, 200];
    for (const item of computeDockMagnification(null, centers)) {
      expect(item).toEqual({ scale: 1, liftY: 0, offsetX: 0, weight: 0, topLiftPx: 0 });
    }
    for (const item of computeDockMagnification(150, centers, { maxScale: 1 })) {
      expect(item).toEqual({ scale: 1, liftY: 0, offsetX: 0, weight: 0, topLiftPx: 0 });
    }
  });

  it('中心图标达峰最大倍率与最大抬升，左右对称放大并反向水平推开，远端归零', () => {
    const centers = [100, 150, 200, 250, 300, 600];
    const results = computeDockMagnification(200, centers, {
      radius: DEFAULT_MAG_RADIUS_PX,
      maxScale: DEFAULT_MAG_MAX_SCALE,
      iconSize: 44,
    });

    // 中心（200）：最大缩放、零水平偏移、向上抬升
    expect(results[2].scale).toBeCloseTo(DEFAULT_MAG_MAX_SCALE, 5);
    expect(results[2].weight).toBeCloseTo(1, 5);
    expect(results[2].offsetX).toBe(0);
    expect(results[2].liftY).toBeLessThan(0);
    expect(results[2].topLiftPx).toBeGreaterThan((DEFAULT_MAG_MAX_SCALE - 1) * 44);

    // 对称邻近项（150 与 250）：缩放、抬升相等，水平推开方向相反
    expect(results[1].scale).toBeCloseTo(results[3].scale, 5);
    expect(results[1].scale).toBeGreaterThan(1);
    expect(results[1].scale).toBeLessThan(results[2].scale);
    expect(results[1].liftY).toBeCloseTo(results[3].liftY, 5);
    expect(results[1].offsetX).toBeLessThan(0);
    expect(results[3].offsetX).toBeGreaterThan(0);
    expect(results[1].offsetX).toBeCloseTo(-results[3].offsetX, 5);

    // 远端（600，远超推开半径）：完全静止
    expect(results[5]).toEqual({ scale: 1, liftY: 0, offsetX: 0, weight: 0, topLiftPx: 0 });
  });

  it('clampMagnificationScale 钳位非法与越界倍率', () => {
    expect(clampMagnificationScale(0.5)).toBe(MIN_MAG_MAX_SCALE);
    expect(clampMagnificationScale(3.2)).toBe(MAX_MAG_MAX_SCALE);
    expect(clampMagnificationScale(Number.NaN)).toBe(DEFAULT_MAG_MAX_SCALE);
    expect(clampMagnificationScale(1.45)).toBe(1.45);
  });

  it('computeDockCursorPercent 将视口 X 归一化到 0..100 区间', () => {
    expect(computeDockCursorPercent(250, 200, 200)).toBeCloseTo(25, 5);
    expect(computeDockCursorPercent(100, 200, 200)).toBe(0);
    expect(computeDockCursorPercent(500, 200, 200)).toBe(100);
    expect(computeDockCursorPercent(null, 200, 200)).toBeNull();
    expect(computeDockCursorPercent(250, 200, 0)).toBeNull();
  });
});

describe('dockMagnificationStore 持久化与环境降级', () => {
  beforeEach(() => {
    resetDockMagnificationForTests();
    resetMaterialTierForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDockMagnificationForTests();
    resetMaterialTierForTests();
  });

  it('默认关闭（纯静态 macOS Dock），变更自动持久化到 localStorage', () => {
    expect(getDockMagnificationPreferences()).toEqual({
      enabled: false,
      maxScale: DEFAULT_MAG_MAX_SCALE,
    });

    setDockMagnificationScale(1.52);
    setDockMagnificationEnabled(true);

    const saved = JSON.parse(localStorage.getItem(DOCK_MAGNIFICATION_STORAGE_KEY) || '{}');
    expect(saved).toEqual({ enabled: true, maxScale: 1.52 });

    useDockMagnificationStore.getState().toggleEnabled();
    expect(getDockMagnificationPreferences().enabled).toBe(false);
  });

  it('开启放大时，prefers-reduced-motion、粗指针或 minimal 档位下自动禁用', () => {
    setDockMagnificationEnabled(true);
    let reducedMatches = false;
    let coarseMatches = false;
    const listeners = new Map<string, Set<() => void>>();

    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
      if (!listeners.has(query)) listeners.set(query, new Set());
      return {
        matches:
          query === '(prefers-reduced-motion: reduce)'
            ? reducedMatches
            : query === '(pointer: coarse)'
              ? coarseMatches
              : false,
        media: query,
        addEventListener: (_: string, cb: () => void) => listeners.get(query)!.add(cb),
        removeEventListener: (_: string, cb: () => void) => listeners.get(query)!.delete(cb),
      } as unknown as MediaQueryList;
    });

    setMaterialTier('full');
    const { result, rerender } = renderHook(() => useDockMagnificationEffective());
    expect(result.current.effectiveEnabled).toBe(true);

    // prefers-reduced-motion 开启 → 自动禁用
    act(() => {
      reducedMatches = true;
      listeners.get('(prefers-reduced-motion: reduce)')?.forEach((cb) => cb());
    });
    expect(result.current.effectiveEnabled).toBe(false);

    // 恢复 reduced-motion，开启粗指针 → 自动禁用
    act(() => {
      reducedMatches = false;
      coarseMatches = true;
      listeners.get('(prefers-reduced-motion: reduce)')?.forEach((cb) => cb());
      listeners.get('(pointer: coarse)')?.forEach((cb) => cb());
    });
    expect(result.current.effectiveEnabled).toBe(false);

    // 恢复精指针，切 minimal 档 → 自动禁用
    act(() => {
      coarseMatches = false;
      listeners.get('(pointer: coarse)')?.forEach((cb) => cb());
      setMaterialTier('minimal');
    });
    rerender();
    expect(result.current.effectiveEnabled).toBe(false);
  });
});
