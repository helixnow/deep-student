import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WindowShell,
  snapZoneToDisplayMode,
  type WindowShellPointerArgs,
  type WindowShellPointerHook,
} from '@/features/workbench/components/WindowShell';
import { useWindowStore } from '@/features/workbench/core/windowStore';
import type { Frame } from '@/features/workbench/core/types';
import {
  getActiveWorkbenchCursor,
  resetWorkbenchCursorForTests,
} from '@/features/workbench/hooks/useWorkbenchGestures';
import { openTestWindow, registerTestApp, resetWorkbenchStore } from './testUtils';

/**
 * P2 useWindowPointer 尚未交付——本地临时 stub（仅测试文件内，遵守文件归属规则）。
 * 按 types.ts 冻结契约 WindowPointerCallbacks 驱动 WindowShell 的提交/直写 DOM 路径。
 */
function makeStubPointer() {
  const captured: { args: WindowShellPointerArgs | null } = { args: null };
  const useStub: WindowShellPointerHook = (args) => {
    captured.args = args;
    return { onMovePointerDown: vi.fn(), onResizePointerDown: vi.fn() };
  };
  return { captured, useStub };
}

function renderShell(
  windowId: string,
  props: Partial<React.ComponentProps<typeof WindowShell>> = {},
) {
  return render(
    <div style={{ position: 'relative', width: 1600, height: 900 }}>
      <WindowShell windowId={windowId} {...props} />
    </div>,
  );
}

const getWinEl = (id: string) =>
  document.querySelector(`[data-wb-window][data-window-id="${id}"]`) as HTMLElement;

describe('WindowShell 隔离渲染（Storybook 式测试页 DoD）', () => {
  beforeEach(() => {
    resetWorkbenchStore();
    registerTestApp();
    resetWorkbenchCursorForTests();
  });

  afterEach(() => {
    resetWorkbenchCursorForTests();
  });

  it('独立渲染完整窗口：chrome + 内容 + 缩放柄 + 类名契约', async () => {
    const id = openTestWindow({ title: '我的窗口' });
    renderShell(id);

    const el = getWinEl(id);
    expect(el).toBeInTheDocument();
    expect(el.className).toContain('wb-window');
    expect(el.className).toContain('wb-window-focused');
    // O9 编排为唯一开窗动画源；壳侧不再挂旧 wb-anim-open
    expect(el.className).not.toContain('wb-anim-open');
    expect(screen.getByText('我的窗口')).toBeInTheDocument();
    await screen.findByTestId('app-content');
    expect(document.querySelectorAll('[data-wb-resize]')).toHaveLength(8);
    // 静止与拖拽统一：绝对定位 + left/top 落位
    expect(el.style.position).toBe('absolute');
    expect(el.style.left).toMatch(/px$/);
    expect(el.style.top).toMatch(/px$/);
    expect(el.style.transform).toBe('');
    // 缩放柄 CSS 类化（角 12px 命中区由 wb-shell-rz-* 提供）
    expect(document.querySelector('.wb-shell-rz-se')).toBeInTheDocument();
  });

  it('非焦点窗口为 wb-window-idle，pointerdown 任意处夺焦', async () => {
    const a = openTestWindow({ title: 'A' });
    const b = openTestWindow({ title: 'B' });
    render(
      <div style={{ position: 'relative' }}>
        <WindowShell windowId={a} />
        <WindowShell windowId={b} />
      </div>,
    );

    expect(getWinEl(a).className).toContain('wb-window-idle');
    expect(getWinEl(b).className).toContain('wb-window-focused');

    fireEvent.pointerDown(getWinEl(a));
    // 按下先抬 zIndex；阴影档（focused class）下一帧再切，避免与拖拽首帧叠卡
    expect(Number(getWinEl(a).style.zIndex)).toBeGreaterThan(Number(getWinEl(b).style.zIndex || 0));
    await act(async () => {
      await Promise.resolve();
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    });
    const state = useWindowStore.getState();
    expect(state.focusStack[state.focusStack.length - 1]).toBe(a);
    expect(getWinEl(a).className).toContain('wb-window-focused');
    expect(getWinEl(b).className).toContain('wb-window-idle');
  });

  it('根元素展开 getWindowA11yProps（role=dialog + data-wb-a11y-window）', () => {
    const id = openTestWindow({ title: '高数笔记' });
    renderShell(id);
    const el = getWinEl(id);
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('data-wb-a11y-window')).toBe('true');
    expect(el.getAttribute('aria-label')).toBeTruthy();
    expect(el.tabIndex).toBe(-1);
    expect(el.hasAttribute('aria-modal')).toBe(false);
  });
});

describe('WindowShell 三键 / 双击 / 平铺菜单', () => {
  beforeEach(() => {
    resetWorkbenchStore();
    registerTestApp();
    resetWorkbenchCursorForTests();
  });

  afterEach(() => {
    resetWorkbenchCursorForTests();
  });

  it('缩放键 maximize toggle，恢复语义（restoreFrame 往返）', () => {
    const id = openTestWindow();
    const original = { ...useWindowStore.getState().windows[id].frame };
    renderShell(id);

    fireEvent.click(screen.getByRole('button', { name: '缩放窗口' }));
    let win = useWindowStore.getState().windows[id];
    expect(win.displayMode).toBe('maximized');
    expect(win.restoreFrame).toEqual(original);
    // maximized 时缩放柄禁用
    expect(document.querySelectorAll('[data-wb-resize]')).toHaveLength(0);
    // maximized 占满桌面（margin 0）
    const el = getWinEl(id);
    expect(el.style.width).toBe('1600px');
    expect(el.style.height).toBe('900px');
    expect(el.style.left).toBe('0px');
    expect(el.style.top).toBe('0px');

    fireEvent.click(screen.getByRole('button', { name: '缩放窗口' }));
    win = useWindowStore.getState().windows[id];
    expect(win.displayMode).toBe('floating');
    expect(win.frame).toEqual(original);
    expect(win.restoreFrame).toBeNull();
  });

  it('双击标题栏 = maximize toggle', () => {
    const id = openTestWindow();
    const { container } = renderShell(id);
    const bar = container.querySelector('[data-wb-titlebar]')!;
    fireEvent.doubleClick(bar);
    expect(useWindowStore.getState().windows[id].displayMode).toBe('maximized');
    fireEvent.doubleClick(bar);
    expect(useWindowStore.getState().windows[id].displayMode).toBe('floating');
  });

  it('最小化键：经 requestMinimizeAnimated → genie 结束后壳隐藏', async () => {
    const id = openTestWindow();
    renderShell(id);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '最小化窗口' }));
    });
    expect(useWindowStore.getState().windows[id].minimized).toBe(false);
    expect(useWindowStore.getState().transientPhases?.[id]).toBe('minimizing');
    const el = getWinEl(id);
    await act(async () => {
      fireEvent.animationEnd(el);
    });
    expect(useWindowStore.getState().windows[id].minimized).toBe(true);
    expect(el.style.visibility).toBe('hidden');
    // O9 genie 为唯一最小化动画源；壳侧不再挂旧 wb-anim-minimize
    expect(el.className).not.toContain('wb-anim-minimize');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });

  it('关闭键走 requestCloseAnimated：canClose=false 拦截', async () => {
    registerTestApp('test-app-block', { canClose: () => false });
    const id = openTestWindow({ typeId: 'test-app-block' });
    renderShell(id);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
    });
    expect(useWindowStore.getState().windows[id]).toBeDefined();
    expect(getWinEl(id)).toBeInTheDocument();
  });

  it('关闭键：canClose 通过后经 pop-out 收尾销毁', async () => {
    registerTestApp('test-app-ok', { canClose: () => true });
    const id = openTestWindow({ typeId: 'test-app-ok' });
    renderShell(id);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
    });
    expect(useWindowStore.getState().windows[id]).toBeDefined();
    expect(useWindowStore.getState().transientPhases?.[id]).toBe('closing');
    const el = getWinEl(id);
    await act(async () => {
      fireEvent.animationEnd(el);
    });
    expect(useWindowStore.getState().windows[id]).toBeUndefined();
    expect(getWinEl(id)).toBeNull();
  });

  it('平铺菜单选择左半屏 → computeTiledFrame 几何（1600×900, margin 8）', () => {
    const id = openTestWindow();
    renderShell(id);
    // 键盘打开菜单（缩放键 ArrowDown）
    fireEvent.keyDown(screen.getByRole('button', { name: '缩放窗口' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: '平铺到左半屏' }));

    expect(useWindowStore.getState().windows[id].displayMode).toBe('tiled-left');
    const el = getWinEl(id);
    // halfW=800 → w=800-12=788, h=900-16=884, x=y=8；静止 left/top
    expect(el.style.left).toBe('8px');
    expect(el.style.top).toBe('8px');
    expect(el.style.width).toBe('788px');
    expect(el.style.height).toBe('884px');
    expect(el.style.transform).toBe('');
    expect(el.dataset.displayMode).toBe('tiled-left');
  });

  it('平铺菜单「居中」保持尺寸居中摆放', () => {
    const id = openTestWindow();
    renderShell(id);
    fireEvent.keyDown(screen.getByRole('button', { name: '缩放窗口' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: '居中' }));

    const win = useWindowStore.getState().windows[id];
    expect(win.displayMode).toBe('floating');
    expect(win.frame).toEqual({ x: 480, y: 210, w: 640, h: 480 });
  });

  it('平铺菜单「恢复」回到 floating 原尺寸', () => {
    const id = openTestWindow();
    const original = { ...useWindowStore.getState().windows[id].frame };
    renderShell(id);
    fireEvent.keyDown(screen.getByRole('button', { name: '缩放窗口' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: '平铺到右下角' }));
    expect(useWindowStore.getState().windows[id].displayMode).toBe('tiled-br');

    fireEvent.keyDown(screen.getByRole('button', { name: '缩放窗口' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: '恢复原尺寸' }));
    const win = useWindowStore.getState().windows[id];
    expect(win.displayMode).toBe('floating');
    expect(win.frame).toEqual(original);
  });
});

describe('WindowShell 指针契约（stub 驱动 WindowPointerCallbacks）', () => {
  beforeEach(() => {
    resetWorkbenchStore();
    registerTestApp();
    resetWorkbenchCursorForTests();
  });

  afterEach(() => {
    resetWorkbenchCursorForTests();
  });

  it('onFrameChange 直接写 DOM，不进 store（60fps 纪律）', () => {
    const { captured, useStub } = makeStubPointer();
    const id = openTestWindow();
    const before = { ...useWindowStore.getState().windows[id].frame };
    renderShell(id, { usePointer: useStub });

    // 无手势会话：按静止契约写 left/top
    act(() => {
      captured.args!.callbacks.onFrameChange({ x: 5, y: 6, w: 400, h: 300 });
    });
    const el = getWinEl(id);
    expect(el.style.left).toBe('5px');
    expect(el.style.top).toBe('6px');
    expect(el.style.width).toBe('400px');
    expect(el.style.transform).toBe('');
    // store 未被拖动过程污染
    expect(useWindowStore.getState().windows[id].frame).toEqual(before);
  });

  it('拖拽会话：wb-shell-dragging + 锚点 left/top + translate3d 跟手；结束折回 left/top，store 落位', () => {
    const { captured, useStub } = makeStubPointer();
    const id = openTestWindow();
    const start = { ...useWindowStore.getState().windows[id].frame };
    renderShell(id, { usePointer: useStub });
    const el = getWinEl(id);

    act(() => {
      captured.args!.onDragStateChange!(true);
    });
    expect(el.classList.contains('wb-shell-dragging')).toBe(true);
    expect(getActiveWorkbenchCursor()).toBe('grabbing');

    act(() => {
      captured.args!.callbacks.onFrameChange({ x: 40, y: 50, w: start.w, h: start.h });
    });
    // move：锚定起始 left/top，位移走 translate3d（合成层跟手）
    expect(el.style.left).toBe(`${start.x}px`);
    expect(el.style.top).toBe(`${start.y}px`);
    expect(el.style.transform).toBe(
      `translate3d(${40 - start.x}px, ${50 - start.y}px, 0)`,
    );
    // store 仍未污染
    expect(useWindowStore.getState().windows[id].frame).toEqual(start);

    act(() => {
      captured.args!.onDragStateChange!(false);
      captured.args!.callbacks.onCommit({ x: 40, y: 50, w: start.w, h: start.h }, null);
    });
    expect(el.classList.contains('wb-shell-dragging')).toBe(false);
    expect(el.style.left).toBe('40px');
    expect(el.style.top).toBe('50px');
    expect(el.style.transform).toBe('');
    expect(getActiveWorkbenchCursor()).toBeNull();
    expect(useWindowStore.getState().windows[id].frame).toEqual({
      x: 40,
      y: 50,
      w: start.w,
      h: start.h,
    });
  });

  it('onCommit(frame, null) 提交浮动位置到 store', () => {
    const { captured, useStub } = makeStubPointer();
    const id = openTestWindow();
    renderShell(id, { usePointer: useStub });

    const target: Frame = { x: 100, y: 110, w: 420, h: 320 };
    act(() => {
      captured.args!.callbacks.onCommit(target, null);
    });
    expect(useWindowStore.getState().windows[id].frame).toEqual(target);
    expect(useWindowStore.getState().windows[id].displayMode).toBe('floating');
  });

  it('onCommit 命中吸附区 → setDisplayMode（zone 映射）', () => {
    const { captured, useStub } = makeStubPointer();
    const id = openTestWindow();
    renderShell(id, { usePointer: useStub });

    act(() => {
      captured.args!.callbacks.onCommit({ x: 0, y: 0, w: 1, h: 1 }, 'left');
    });
    expect(useWindowStore.getState().windows[id].displayMode).toBe('tiled-left');
  });

  it('onSnapZoneChange 上抛给 Desktop 层（SnapPreview 接线点）', () => {
    const { captured, useStub } = makeStubPointer();
    const onSnapZoneChange = vi.fn();
    const id = openTestWindow();
    renderShell(id, { usePointer: useStub, onSnapZoneChange });

    act(() => {
      captured.args!.callbacks.onSnapZoneChange('tr');
    });
    expect(onSnapZoneChange).toHaveBeenCalledWith(id, 'tr');
  });

  it('拖动会话中内容层 pointer-events:none（DOM 直写，0 React state）', () => {
    const { captured, useStub } = makeStubPointer();
    const id = openTestWindow();
    const { container } = renderShell(id, { usePointer: useStub });
    const content = container.querySelector('[data-wb-window-content]') as HTMLElement;

    expect(content.style.pointerEvents).toBe('');
    act(() => {
      captured.args!.onDragStateChange!(true);
    });
    expect(content.style.pointerEvents).toBe('none');
    act(() => {
      captured.args!.onDragStateChange!(false);
    });
    expect(content.style.pointerEvents).toBe('');
  });

  it('snapZoneToDisplayMode 映射表完整', () => {
    expect(snapZoneToDisplayMode('left')).toBe('tiled-left');
    expect(snapZoneToDisplayMode('right')).toBe('tiled-right');
    expect(snapZoneToDisplayMode('tl')).toBe('tiled-tl');
    expect(snapZoneToDisplayMode('tr')).toBe('tiled-tr');
    expect(snapZoneToDisplayMode('bl')).toBe('tiled-bl');
    expect(snapZoneToDisplayMode('br')).toBe('tiled-br');
    expect(snapZoneToDisplayMode('top-maximize')).toBe('maximized');
  });
});
