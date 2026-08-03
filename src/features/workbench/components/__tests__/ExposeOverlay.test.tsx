/**
 * ExposeOverlay 测试：网格布局纯函数（保持宽高比 / 不放大 / 末行居中）、
 * 空状态文案与 role、缩略格标题溢出提示（title 属性）、关闭按钮 aria、
 * 选中项 aria-current、对话框 aria 契约。
 */
import React from 'react';
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
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
    exposeAppTypeId: null,
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

function openExpose(appTypeId?: string) {
  act(() => {
    useWorkbenchOverlay.getState().openExpose(appTypeId ? { appTypeId } : undefined);
  });
}

beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  appRegistry.register(makeApp('chat'));
  appRegistry.register(makeApp('note'));
});

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  vi.useRealTimers();
  document.querySelectorAll('[data-wb-window-id]').forEach((el) => el.remove());
});

function mountWindowShell(id: string, transform = ''): HTMLElement {
  const shell = document.createElement('section');
  shell.setAttribute('data-wb-window-id', id);
  shell.style.transform = transform;
  shell.getBoundingClientRect = vi.fn(() => ({
    x: 120,
    y: 90,
    left: 120,
    top: 90,
    right: 920,
    bottom: 690,
    width: 800,
    height: 600,
    toJSON: () => ({}),
  }));
  document.body.appendChild(shell);
  return shell;
}

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

  it('无窗口时显示空状态文字（主文案 + Esc 提示，role=status，无卡片包裹）', () => {
    render(<ExposeOverlay />);
    openExpose();

    const empty = document.querySelector('.wb-expose-empty-text');
    expect(empty).not.toBeNull();
    expect(empty).toHaveAttribute('role', 'status');
    expect(empty).not.toHaveClass('wb-glass');
    expect(empty!.textContent).toContain('没有打开的窗口');
    expect(empty!.textContent).toContain('按 Esc 或点击任意处返回桌面');
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

  it('窗口落位前保持 entering，完成后才开放目标框', () => {
    vi.useFakeTimers();
    const id = openWin('chat', 'entering-guard', '落位测试');
    mountWindowShell(id);
    render(<ExposeOverlay />);
    openExpose();

    const root = document.querySelector('[data-wb-expose-root]');
    const cell = document.querySelector(`[data-wb-expose-cell="${id}"]`);
    expect(root).toHaveAttribute('data-phase', 'entering');
    expect(cell).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(320);
    });
    expect(root).toHaveAttribute('data-phase', 'open');
  });
});

describe('App Exposé（应用过滤，P2）', () => {
  it('openExpose({ appTypeId }) 只俯瞰该应用的窗口', () => {
    const a = openWin('chat', 'a', '会话 A');
    const b = openWin('chat', 'b', '会话 B');
    const n = openWin('note', 'n', '笔记 N');
    render(<ExposeOverlay />);
    openExpose('chat');

    expect(document.querySelector(`[data-wb-expose-cell="${a}"]`)).not.toBeNull();
    expect(document.querySelector(`[data-wb-expose-cell="${b}"]`)).not.toBeNull();
    expect(document.querySelector(`[data-wb-expose-cell="${n}"]`)).toBeNull();
  });

  it('非目标应用的窗口壳被原位淡出（data-expose-dimmed），退出后还原', async () => {
    const a = openWin('chat', 'a', '会话 A');
    const n = openWin('note', 'n', '笔记 N');
    const chatShell = mountWindowShell(a);
    const noteShell = mountWindowShell(n);
    render(<ExposeOverlay />);
    openExpose('chat');

    expect(chatShell).toHaveAttribute('data-expose-transform', 'true');
    expect(chatShell).not.toHaveAttribute('data-expose-dimmed');
    expect(noteShell).not.toHaveAttribute('data-expose-transform');
    expect(noteShell).toHaveAttribute('data-expose-dimmed');

    act(() => {
      useWorkbenchOverlay.getState().closeExpose();
    });
    // 退出即开始淡回（closing 阶段就移除标记）
    expect(noteShell).not.toHaveAttribute('data-expose-dimmed');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    expect(chatShell).not.toHaveAttribute('data-expose-transform');
  });

  it('全局俯瞰不打淡出标记', () => {
    const a = openWin('chat', 'a', '会话 A');
    const n = openWin('note', 'n', '笔记 N');
    mountWindowShell(a);
    const noteShell = mountWindowShell(n);
    render(<ExposeOverlay />);
    openExpose();

    expect(noteShell).toHaveAttribute('data-expose-transform', 'true');
    expect(noteShell).not.toHaveAttribute('data-expose-dimmed');
  });

  it('目标应用无可俯瞰窗口时显示 App 专属空态', () => {
    openWin('chat', 'a', '会话 A');
    render(<ExposeOverlay />);
    openExpose('note');

    const empty = document.querySelector('.wb-expose-empty-text');
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain('该应用没有可俯瞰的窗口');
  });

  it('会话内目标应用新开窗即时进入网格', () => {
    openWin('chat', 'a', '会话 A');
    render(<ExposeOverlay />);
    openExpose('chat');

    let late = '';
    act(() => {
      late = openWin('chat', 'late', '会话 C');
    });
    expect(document.querySelector(`[data-wb-expose-cell="${late}"]`)).not.toBeNull();
  });
});

describe('重内容暂停', () => {
  it('打开后暂停重内容宿主；退出动画收尾后恢复', async () => {
    const heavyHost = document.createElement('div');
    heavyHost.setAttribute('data-wb-content-host', '');
    document.body.appendChild(heavyHost);
    const id = openWin('chat', 'heavy-pause', '暂停测试');
    mountWindowShell(id);
    render(<ExposeOverlay />);
    openExpose();

    // per-host flush 双 rAF 延后，不与打开同栈
    await vi.waitFor(() => {
      expect(heavyHost.hasAttribute('data-wb-render-paused')).toBe(true);
    });

    act(() => {
      useWorkbenchOverlay.getState().closeExpose();
    });
    // 退出 FLIP 飞回途中仍保持暂停
    expect(heavyHost.hasAttribute('data-wb-render-paused')).toBe(true);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    expect(heavyHost.hasAttribute('data-wb-render-paused')).toBe(false);

    heavyHost.remove();
  });
});

describe('退出恢复', () => {
  it('卸载遮罩前强制清理由中断更新遗留的缩略 transform', async () => {
    const id = openWin('chat', 'restore-orphan', '恢复测试');
    const shell = mountWindowShell(id);
    render(<ExposeOverlay />);
    openExpose();

    expect(shell).toHaveAttribute('data-expose-transform', 'true');

    act(() => {
      useWorkbenchOverlay.getState().closeExpose();
    });
    // 模拟退出过渡期间 WebView/窗口壳更新重新写入了旧的缩略帧。
    shell.setAttribute('data-expose-transform', 'true');
    shell.classList.add('wb-expose-flip');
    shell.style.transform = 'translate(240px, 160px) scale(0.5)';

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });

    expect(document.querySelector('[data-wb-expose-root]')).toBeNull();
    expect(shell).not.toHaveAttribute('data-expose-transform');
    expect(shell.style.transform).toBe('');
    expect(shell.classList.contains('wb-expose-flip')).toBe(false);
  });

  it('退出动画中重新打开仍保留首次进入前的原始 transform', async () => {
    const id = openWin('chat', 'rapid-toggle', '快速切换');
    const originalTransform = 'translate3d(6px, 8px, 0px)';
    const shell = mountWindowShell(id, originalTransform);
    render(<ExposeOverlay />);
    openExpose();

    act(() => {
      useWorkbenchOverlay.getState().closeExpose();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    act(() => {
      useWorkbenchOverlay.getState().openExpose();
    });
    expect(shell).toHaveAttribute('data-expose-transform', 'true');

    act(() => {
      useWorkbenchOverlay.getState().closeExpose();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });

    expect(shell.style.transform).toBe(originalTransform);
    expect(shell).not.toHaveAttribute('data-expose-transform');
  });
});
