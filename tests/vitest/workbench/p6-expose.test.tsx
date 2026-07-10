/**
 * P6 / O7 — 俯瞰测试：
 * computeExposeLayout 网格算法（宽高比/边界/不重叠/末行居中）
 * ExposeOverlay 组件（FLIP transform 注入不卸载、点击聚焦退出、Esc 退出、
 * 最小化排除、方向键导航、关闭按钮、FLIP 类挂载）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react';
import React from 'react';
import {
  ExposeOverlay,
  computeExposeLayout,
  computeExposeCols,
  type ExposeItem,
} from '@/features/workbench/components/ExposeOverlay';
import { useWindowStore } from '@/features/workbench/core/windowStore';
import { useWorkbenchOverlay } from '@/features/workbench/core/shortcuts';
import type { Frame } from '@/features/workbench/core/types';
import { makeWindow, seedWindows, resetWorkbenchState, focusedWindowId, DESKTOP } from './p6-testUtils';
import { registerTestApp } from './testUtils';

// ============================================================================
// 网格算法
// ============================================================================

const desk = { w: 1600, h: 900 };
const item = (id: string, frame: Partial<Frame> = {}): ExposeItem => ({
  id,
  frame: { x: 0, y: 0, w: 800, h: 600, ...frame },
});

describe('computeExposeLayout', () => {
  it('空输入返回空数组', () => {
    expect(computeExposeLayout([], desk)).toEqual([]);
  });

  it('保持每窗宽高比（等比缩放）', () => {
    const items = [
      item('wide', { w: 1200, h: 400 }),
      item('tall', { w: 300, h: 700 }),
      item('square', { w: 500, h: 500 }),
    ];
    for (const t of computeExposeLayout(items, desk)) {
      const src = items.find((i) => i.id === t.id)!;
      expect(t.w / t.h).toBeCloseTo(src.frame.w / src.frame.h, 5);
      expect(t.w).toBeCloseTo(src.frame.w * t.scale, 5);
      expect(t.h).toBeCloseTo(src.frame.h * t.scale, 5);
    }
  });

  it('绝不放大（scale ≤ 1）', () => {
    const targets = computeExposeLayout([item('s', { w: 100, h: 80 })], desk);
    expect(targets[0].scale).toBeLessThanOrEqual(1);
    expect(targets[0].w).toBeLessThanOrEqual(100);
  });

  it('全部落在桌面范围内（含标签高度）', () => {
    for (const n of [1, 2, 3, 5, 7, 10]) {
      const items = Array.from({ length: n }, (_, i) =>
        item(`w${i}`, { x: i * 30, y: i * 20, w: 900, h: 700 }));
      for (const t of computeExposeLayout(items, desk)) {
        expect(t.x).toBeGreaterThanOrEqual(0);
        expect(t.y).toBeGreaterThanOrEqual(0);
        expect(t.x + t.w).toBeLessThanOrEqual(desk.w);
        expect(t.y + t.h + 32).toBeLessThanOrEqual(desk.h);
      }
    }
  });

  it('两两不重叠（10 窗）', () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      item(`w${i}`, { x: (i % 4) * 350, y: Math.floor(i / 4) * 280, w: 800, h: 600 }));
    const targets = computeExposeLayout(items, desk);
    expect(targets).toHaveLength(10);
    for (let i = 0; i < targets.length; i++) {
      for (let j = i + 1; j < targets.length; j++) {
        const a = targets[i];
        const b = targets[j];
        const overlap =
          a.x < b.x + b.w && b.x < a.x + a.w &&
          a.y < b.y + b.h + 32 && b.y < a.y + a.h + 32;
        expect(overlap, `${a.id} 与 ${b.id} 重叠`).toBe(false);
      }
    }
  });

  it('空间顺序：先上后下、先左后右', () => {
    const items = [
      item('br', { x: 900, y: 500 }),
      item('tl', { x: 0, y: 0 }),
      item('tr', { x: 900, y: 0 }),
      item('bl', { x: 0, y: 500 }),
    ];
    const ids = computeExposeLayout(items, desk).map((t) => t.id);
    expect(ids).toEqual(['tl', 'tr', 'bl', 'br']);
  });

  it('末行不满时居中', () => {
    // 1600/900 → 3 窗为 3 列 1 行；5 窗为 3 列 2 行，末行 2 个
    const items = Array.from({ length: 5 }, (_, i) => item(`w${i}`, { x: i, y: 0 }));
    const targets = computeExposeLayout(items, desk);
    const lastRow = targets.slice(3);
    const firstRow = targets.slice(0, 3);
    // 末行整体中心 ≈ 桌面中心
    const lastCenter = (Math.min(...lastRow.map((t) => t.x))
      + Math.max(...lastRow.map((t) => t.x + t.w))) / 2;
    expect(lastCenter).toBeCloseTo(desk.w / 2, 0);
    // 末行首个比整行首个更靠右
    expect(Math.min(...lastRow.map((t) => t.x)))
      .toBeGreaterThan(Math.min(...firstRow.map((t) => t.x)));
  });

  it('computeExposeCols 与布局列数一致', () => {
    const items = Array.from({ length: 5 }, (_, i) => item(`w${i}`, { x: i, y: 0 }));
    const targets = computeExposeLayout(items, desk);
    const cols = computeExposeCols(5, desk);
    // 5 窗 → 3 列 2 行
    expect(cols).toBe(3);
    expect(Math.ceil(targets.length / cols)).toBe(2);
  });
});

// ============================================================================
// ExposeOverlay 组件
// ============================================================================

function mountWindowEl(id: string, frame: Frame): HTMLDivElement {
  const el = document.createElement('div');
  el.setAttribute('data-wb-window-id', id);
  el.getBoundingClientRect = () => ({
    x: frame.x, y: frame.y, left: frame.x, top: frame.y,
    width: frame.w, height: frame.h,
    right: frame.x + frame.w, bottom: frame.y + frame.h,
    toJSON: () => ({}),
  } as DOMRect);
  document.body.appendChild(el);
  return el;
}

describe('ExposeOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetWorkbenchState();
  });
  afterEach(() => {
    cleanup();
    document.querySelectorAll('[data-wb-window-id]').forEach((el) => el.remove());
    act(() => { vi.runAllTimers(); });
    vi.useRealTimers();
    resetWorkbenchState();
  });

  function setup() {
    const frames: Record<string, Frame> = {
      a: { x: 40, y: 40, w: 800, h: 600 },
      b: { x: 500, y: 200, w: 640, h: 480 },
    };
    seedWindows([
      makeWindow({ id: 'a', title: 'Alpha', lastFocusedAt: 200, frame: frames.a }),
      makeWindow({ id: 'b', title: 'Beta', lastFocusedAt: 100, frame: frames.b }),
    ]);
    const els = {
      a: mountWindowEl('a', frames.a),
      b: mountWindowEl('b', frames.b),
    };
    render(<ExposeOverlay />);
    return els;
  }

  it('关闭时不渲染任何内容', () => {
    setup();
    expect(document.querySelector('[data-wb-expose-root]')).toBeNull();
  });

  it('打开后对现有窗口 DOM 施加 transform（不卸载不截图）', () => {
    const els = setup();
    act(() => { useWorkbenchOverlay.getState().openExpose(); });

    for (const el of [els.a, els.b]) {
      expect(el.isConnected).toBe(true); // 未卸载
      expect(el.getAttribute('data-expose-transform')).toBe('true');
      expect(el.classList.contains('wb-expose-flip')).toBe(true);
      expect(el.style.transform).toMatch(/translate\(.+\) scale\(/);
      const scale = Number(el.style.getPropertyValue('--wb-expose-scale'));
      expect(scale).toBeGreaterThan(0);
      expect(scale).toBeLessThanOrEqual(1);
      expect(el.style.transformOrigin).toBe('top left');
      // FLIP 过渡引用 spring-soft token（时长 > 0 时）
      expect(el.style.transition).toMatch(/transform/);
      expect(el.style.transition).toMatch(/--wb-ease-spring-soft/);
    }
    // 背景层使用契约类
    expect(document.querySelector('.wb-expose-backdrop')).not.toBeNull();
    // 根挂载 FLIP 阶段类
    expect(document.querySelector('[data-wb-expose-root]')?.classList.contains('wb-expose-root')).toBe(true);
    // 标题标签
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Beta' })).toBeTruthy();
    // z-index 走 token 变量
    const hit = document.querySelector('.wb-expose-hitlayer') as HTMLElement;
    expect(hit.style.zIndex).toBe('var(--wb-z-overlay)');
    const backdrop = document.querySelector('.wb-expose-backdrop') as HTMLElement;
    expect(backdrop.style.zIndex).toBe('var(--wb-z-expose-backdrop)');
  });

  it('点击缩略聚焦对应窗口并退出，transform 恢复', () => {
    const els = setup();
    act(() => { useWorkbenchOverlay.getState().openExpose(); });
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }));

    expect(focusedWindowId()).toBe('b');
    expect(useWorkbenchOverlay.getState().exposeOpen).toBe(false);
    expect(els.b.style.transform).toBe('');
    expect(els.b.getAttribute('data-expose-transform')).toBeNull();
    expect(els.b.classList.contains('wb-expose-flip')).toBe(false);
    // 退出动画结束后整体卸载
    act(() => { vi.runAllTimers(); });
    expect(document.querySelector('[data-wb-expose-root]')).toBeNull();
  });

  it('点击空白退出且不改焦点', () => {
    setup();
    act(() => { useWorkbenchOverlay.getState().openExpose(); });
    fireEvent.click(document.querySelector('.wb-expose-hitlayer')!);
    expect(useWorkbenchOverlay.getState().exposeOpen).toBe(false);
    expect(focusedWindowId()).toBe('a');
  });

  it('Esc 退出', () => {
    setup();
    act(() => { useWorkbenchOverlay.getState().openExpose(); });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useWorkbenchOverlay.getState().exposeOpen).toBe(false);
  });

  it('方向键在网格内移动选择，Enter 聚焦并退出', () => {
    setup();
    act(() => { useWorkbenchOverlay.getState().openExpose(); });

    // 默认选中焦点栈顶 a
    const cellA = document.querySelector('[data-wb-expose-cell="a"]')!;
    expect(cellA.getAttribute('data-selected')).toBe('true');

    // 布局空间序：a(40,40) 在前，b(500,200) 在后 → ArrowRight 选 b
    act(() => { fireEvent.keyDown(window, { key: 'ArrowRight' }); });
    expect(document.querySelector('[data-wb-expose-cell="b"]')!.getAttribute('data-selected'))
      .toBe('true');
    expect(document.querySelector('[data-wb-expose-cell="a"]')!.getAttribute('data-selected'))
      .toBeNull();

    act(() => { fireEvent.keyDown(window, { key: 'Enter' }); });
    expect(focusedWindowId()).toBe('b');
    expect(useWorkbenchOverlay.getState().exposeOpen).toBe(false);
  });

  it('关闭按钮走 requestCloseAnimated：dissolve + 关窗且不退出俯瞰', async () => {
    const els = setup();
    act(() => { useWorkbenchOverlay.getState().openExpose(); });

    const cellB = document.querySelector('[data-wb-expose-cell="b"]') as HTMLElement;
    const closeBtn = within(cellB).getByRole('button', { name: '关闭窗口' });
    await act(async () => {
      fireEvent.click(closeBtn);
      await Promise.resolve();
    });

    // 消散标记 + closing 相位（尊重 canClose / 生命周期编排）
    expect(cellB.getAttribute('data-dissolving')).toBe('true');
    expect(useWindowStore.getState().transientPhases?.b).toBe('closing');
    expect(useWorkbenchOverlay.getState().exposeOpen).toBe(true);

    // 无 WindowBody 时 orphan 兜底收尾（closing FALLBACK ~260+80）；dissolve 220ms 清 FLIP
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(useWindowStore.getState().windows.b).toBeUndefined();
    expect(document.querySelector('[data-wb-expose-cell="b"]')).toBeNull();
    expect(useWorkbenchOverlay.getState().exposeOpen).toBe(true);
    expect(els.a.classList.contains('wb-expose-flip')).toBe(true);
    expect(document.querySelector('[data-wb-expose-cell="a"]')).not.toBeNull();
  });

  it('关闭按钮 canClose=false 时取消 dissolve 且不关窗', async () => {
    registerTestApp('test-app', { canClose: () => false });
    setup();
    act(() => { useWorkbenchOverlay.getState().openExpose(); });
    const cellB = document.querySelector('[data-wb-expose-cell="b"]') as HTMLElement;
    const closeBtn = within(cellB).getByRole('button', { name: '关闭窗口' });
    await act(async () => {
      fireEvent.click(closeBtn);
      await Promise.resolve();
    });
    expect(useWindowStore.getState().windows.b).toBeDefined();
    expect(cellB.getAttribute('data-dissolving')).toBeNull();
    expect(useWorkbenchOverlay.getState().exposeOpen).toBe(true);
  });

  it('最小化窗口不参与俯瞰', () => {
    const frames: Record<string, Frame> = {
      a: { x: 40, y: 40, w: 800, h: 600 },
      m: { x: 300, y: 300, w: 400, h: 300 },
    };
    seedWindows([
      makeWindow({ id: 'a', title: 'Alpha', frame: frames.a }),
      makeWindow({ id: 'm', title: 'Mini', frame: frames.m, minimized: true }),
    ]);
    const elA = mountWindowEl('a', frames.a);
    const elM = mountWindowEl('m', frames.m);
    render(<ExposeOverlay />);
    act(() => { useWorkbenchOverlay.getState().openExpose(); });

    expect(elA.getAttribute('data-expose-transform')).toBe('true');
    expect(elA.classList.contains('wb-expose-flip')).toBe(true);
    expect(elM.getAttribute('data-expose-transform')).toBeNull();
    expect(elM.style.transform).toBe('');
    expect(screen.queryByRole('button', { name: 'Mini' })).toBeNull();
  });

  it('无窗口时显示空态提示', () => {
    seedWindows([]);
    render(<ExposeOverlay />);
    act(() => { useWorkbenchOverlay.getState().openExpose(); });
    expect(screen.getByText('没有打开的窗口')).toBeTruthy();
  });

  it('俯瞰中窗口尺寸与桌面一致的目标不超界', () => {
    // maximized 场景：源 frame = 整个桌面
    const frame: Frame = { x: 0, y: 0, w: DESKTOP.w, h: DESKTOP.h };
    seedWindows([makeWindow({ id: 'max', title: 'Max', frame, displayMode: 'maximized' })]);
    mountWindowEl('max', frame);
    render(<ExposeOverlay />);
    act(() => { useWorkbenchOverlay.getState().openExpose(); });
    const el = document.querySelector<HTMLElement>('[data-wb-window-id="max"]')!;
    const scale = Number(el.style.getPropertyValue('--wb-expose-scale'));
    expect(scale).toBeLessThan(1);
  });
});
