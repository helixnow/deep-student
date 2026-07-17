/**
 * ExposeOverlay 测试：网格布局纯函数（保持宽高比 / 不放大 / 末行居中）、
 * 空状态文案与 role、缩略格标题溢出提示（title 属性）、关闭按钮 aria、
 * 选中项 aria-current、对话框 aria 契约。
 */
import React from 'react';
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

import type { AppDefinition, AppWindowProps } from '../../core/types';
import { appRegistry } from '../../core/appRegistry';
import { useWindowStore } from '../../core/windowStore';
import { useWorkbenchOverlay } from '../../core/shortcuts';
import {
  ExposeOverlay,
  computeExposeLayout,
  computeExposeCols,
  type ExposeItem,
} from '../ExposeOverlay';

const NullApp: React.FC<AppWindowProps> = () => null;

function makeApp(typeId: string): AppDefinition {
  return {
    typeId,
    nameKey: `workbench:app.${typeId}`,
    icon: <span>{typeId[0]}</span>,
    instanceMode: 'multi',
    memoryWeight: 1,
    defaultFrame: { w: 400, h: 300 },
    minSize: { w: 200, h: 150 },
    render: React.lazy(async () => ({ default: NullApp })),
  };
}

function resetStores() {
  useWindowStore.setState({
    windows: {},
    focusStack: [],
    lifecycles: {},
    launchPayloads: {},
    tilingRatios: {},
    desktopSize: { w: 1600, h: 900 },
  });
  useWorkbenchOverlay.setState({
    exposeOpen: false,
    switcherOpen: false,
    switcherIds: [],
    switcherIndex: 0,
    cheatsheetOpen: false,
    cheatsheetSticky: false,
  });
}

function openWin(typeId: string, instanceKey: string, title = '') {
  return useWindowStore.getState().openWindow({ typeId, instanceKey, title });
}

function openExpose() {
  act(() => {
    useWorkbenchOverlay.getState().openExpose();
  });
}

beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  appRegistry.register(makeApp('chat'));
});

beforeEach(() => {
  resetStores();
});

describe('computeExposeLayout', () => {
  const desktop = { w: 1600, h: 900 };

  it('空集合返回空数组', () => {
    expect(computeExposeLayout([], desktop)).toEqual([]);
  });

  it('每个目标保持源宽高比且不放大（scale ≤ 1）', () => {
    const items: ExposeItem[] = [
      { id: 'a', frame: { x: 0, y: 0, w: 800, h: 600 } },
      { id: 'b', frame: { x: 100, y: 100, w: 400, h: 800 } },
      { id: 'c', frame: { x: 200, y: 50, w: 1200, h: 300 } },
    ];
    const targets = computeExposeLayout(items, desktop);
    expect(targets).toHaveLength(3);
    for (const tg of targets) {
      const src = items.find((i) => i.id === tg.id)!;
      expect(tg.scale).toBeLessThanOrEqual(1);
      expect(tg.scale).toBeGreaterThan(0);
      expect(tg.w / tg.h).toBeCloseTo(src.frame.w / src.frame.h, 5);
    }
  });

  it('所有目标落在留白内边界之内', () => {
    const items: ExposeItem[] = Array.from({ length: 5 }, (_, i) => ({
      id: `w${i}`,
      frame: { x: i * 50, y: i * 40, w: 900, h: 700 },
    }));
    const padding = 48;
    const targets = computeExposeLayout(items, desktop, { padding });
    for (const tg of targets) {
      expect(tg.x).toBeGreaterThanOrEqual(padding - 0.5);
      expect(tg.y).toBeGreaterThanOrEqual(padding - 0.5);
      expect(tg.x + tg.w).toBeLessThanOrEqual(desktop.w - padding + 0.5);
      expect(tg.y + tg.h).toBeLessThanOrEqual(desktop.h - padding + 0.5);
    }
  });

  it('末行不满时整体居中（左右留白对称）', () => {
    // 3 窗 2 列 → 末行 1 项应水平居中
    const square = { w: 1000, h: 1000 };
    const items: ExposeItem[] = [
      { id: 'a', frame: { x: 0, y: 0, w: 400, h: 300 } },
      { id: 'b', frame: { x: 0, y: 0, w: 400, h: 300 } },
      { id: 'c', frame: { x: 0, y: 900, w: 400, h: 300 } },
    ];
    const cols = computeExposeCols(items.length, square);
    expect(cols).toBe(2);
    const targets = computeExposeLayout(items, square);
    const last = targets[targets.length - 1];
    const centerX = last.x + last.w / 2;
    expect(centerX).toBeCloseTo(square.w / 2, 0);
  });

  it('computeExposeCols 单调不减且不超过窗口数', () => {
    let prev = 0;
    for (let n = 1; n <= 12; n++) {
      const cols = computeExposeCols(n, desktop);
      expect(cols).toBeGreaterThanOrEqual(prev);
      expect(cols).toBeLessThanOrEqual(n);
      prev = cols;
    }
  });
});

describe('渲染与 aria', () => {
  it('未打开时不渲染', () => {
    render(<ExposeOverlay />);
    expect(document.querySelector('[data-wb-expose-root]')).toBeNull();
  });

  it('无窗口时显示空状态卡（主文案 + Esc 提示，role=status）', () => {
    render(<ExposeOverlay />);
    openExpose();

    const card = document.querySelector('.wb-expose-empty-card');
    expect(card).not.toBeNull();
    expect(card).toHaveAttribute('role', 'status');
    expect(card!.textContent).toContain('没有打开的窗口');
    expect(card!.textContent).toContain('按 Esc 或点击任意处返回桌面');
  });

  it('命中层为 aria-modal 对话框并带可读名称', () => {
    render(<ExposeOverlay />);
    openExpose();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', '窗口俯瞰');
  });

  it('缩略格 pick 按钮带 aria-label 与 title（截断标题悬停可读全文）', () => {
    const a = openWin('chat', 'a', '一个非常非常长的窗口标题用于验证溢出省略');
    openWin('chat', 'b', '会话 B');
    render(<ExposeOverlay />);
    openExpose();

    const cell = document.querySelector(`[data-wb-expose-cell="${a}"]`);
    expect(cell).not.toBeNull();
    const pick = cell!.querySelector('.wb-expose-cell-pick');
    expect(pick).toHaveAttribute('aria-label', '一个非常非常长的窗口标题用于验证溢出省略');
    expect(pick).toHaveAttribute('title', '一个非常非常长的窗口标题用于验证溢出省略');
  });

  it('焦点栈顶窗口默认选中（data-selected + aria-current）', () => {
    openWin('chat', 'a', '会话 A');
    const b = openWin('chat', 'b', '会话 B');
    render(<ExposeOverlay />);
    openExpose();

    const cell = document.querySelector(`[data-wb-expose-cell="${b}"]`);
    expect(cell).toHaveAttribute('data-selected', 'true');
    expect(cell!.querySelector('.wb-expose-cell-pick')).toHaveAttribute('aria-current', 'true');
  });

  it('每格带矢量叉线关闭按钮（aria-label 关闭窗口）', () => {
    const a = openWin('chat', 'a', '会话 A');
    render(<ExposeOverlay />);
    openExpose();

    const cell = document.querySelector(`[data-wb-expose-cell="${a}"]`);
    const close = cell!.querySelector('.wb-expose-close');
    expect(close).toHaveAttribute('aria-label', '关闭窗口');
    expect(close!.querySelector('svg')).not.toBeNull();
  });
});
