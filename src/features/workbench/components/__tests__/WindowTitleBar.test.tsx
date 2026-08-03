/**
 * WindowTitleBar 打磨轮测试：三键 aria 标签（含 ⌥ 批量语义切换）/
 * 绿灯沉浸模式 + ⌥ 传统 zoom / ⌥+红黄灯批量关闭最小化 /
 * 未保存脏点渲染 / 长标题溢出 tooltip / 双击标题栏按设置分发。
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

import { WindowTitleBar } from '../WindowTitleBar';
import type { DisplayMode } from '../../core/types';
import { appRegistry } from '../../core/appRegistry';
import { resetWindowStoreForTests, useWindowStore } from '../../core/windowStore';
import {
  setWindowDirty,
  __resetWindowDirtyForTests,
} from '../../core/windowCloseGuard';
import {
  isWindowImmersive,
  resetImmersiveModeForTests,
} from '../../core/immersiveMode';
import {
  resetMenuBarAutohideForTests,
  useMenuBarAutohideStore,
} from '../menuBarAutohideStore';
import {
  resetTitleBarBehaviorForTests,
  useTitleBarBehaviorStore,
} from '../titleBarBehaviorStore';
import type { AppDefinition } from '../../core/types';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}));

const GUARDED_TYPE_ID = 'titlebar-guarded-test';
let canCloseImpl: (instanceKey: string | null) => boolean | Promise<boolean> = () => true;

appRegistry.register({
  typeId: GUARDED_TYPE_ID,
  nameKey: 'workbench:test.titlebar',
  icon: null,
  instanceMode: 'multi',
  memoryWeight: 1,
  defaultFrame: { w: 400, h: 300 },
  minSize: { w: 200, h: 150 },
  render: null as unknown as AppDefinition['render'],
  canClose: (instanceKey) => canCloseImpl(instanceKey),
});

function renderBar(overrides: Partial<React.ComponentProps<typeof WindowTitleBar>> = {}) {
  const props = {
    windowId: 'w1',
    title: '测试窗口',
    focused: true,
    displayMode: 'floating' as DisplayMode,
    onClose: vi.fn(),
    onMinimize: vi.fn(),
    onZoom: vi.fn(),
    onTileAction: vi.fn(),
    ...overrides,
  };
  const utils = render(<WindowTitleBar {...props} />);
  return { ...utils, props };
}

beforeEach(() => {
  resetWindowStoreForTests({ w: 1400, h: 900 });
  canCloseImpl = () => true;
});

afterEach(() => {
  cleanup();
  __resetWindowDirtyForTests();
  resetImmersiveModeForTests();
  resetMenuBarAutohideForTests();
  resetTitleBarBehaviorForTests();
});

describe('三键 aria 标签', () => {
  it('关闭 / 最小化键有可读 aria-label；绿灯默认为沉浸语义', () => {
    renderBar();
    expect(screen.getByRole('button', { name: '关闭窗口' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '最小化窗口' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '进入沉浸模式' })).toBeTruthy();
  });

  it('按住 ⌥ 时三键提示切换为批量 / 传统 zoom 语义，松开恢复', () => {
    renderBar({ displayMode: 'maximized' });
    fireEvent.keyDown(window, { key: 'Alt' });
    expect(screen.getByRole('button', { name: '关闭该应用全部窗口' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '最小化该应用全部窗口' })).toBeTruthy();
    // ⌥ 语义下绿灯回到传统 zoom：managed 态 = 还原窗口
    expect(screen.getByRole('button', { name: '还原窗口' })).toBeTruthy();
    fireEvent.keyUp(window, { key: 'Alt' });
    expect(screen.getByRole('button', { name: '关闭窗口' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '进入沉浸模式' })).toBeTruthy();
  });

  it('三键点击各自回调且不触发 zoom（stopPropagation）', () => {
    const { props } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
    fireEvent.click(screen.getByRole('button', { name: '最小化窗口' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onMinimize).toHaveBeenCalledTimes(1);
    expect(props.onZoom).not.toHaveBeenCalled();
  });
});

describe('⌥+黄灯 / ⌥+红灯批量语义', () => {
  it('⌥+黄灯最小化同应用全部窗口（含当前，逐窗 genie 相位）', () => {
    const store = useWindowStore.getState();
    const id1 = store.openWindow({ typeId: 'batch-min-app', instanceKey: 'a' });
    const id2 = store.openWindow({ typeId: 'batch-min-app', instanceKey: 'b' });
    const other = store.openWindow({ typeId: 'other-app', instanceKey: 'c' });
    const { props } = renderBar({ windowId: id1 });

    fireEvent.click(screen.getByRole('button', { name: '最小化窗口' }), { altKey: true });

    const phases = useWindowStore.getState().transientPhases ?? {};
    expect(phases[id1]).toBe('minimizing');
    expect(phases[id2]).toBe('minimizing');
    expect(phases[other]).not.toBe('minimizing');
    // 批量路径不走单窗 onMinimize 回调
    expect(props.onMinimize).not.toHaveBeenCalled();
  });

  it('⌥+红灯关闭同应用全部窗口，被 closeGuard 拦下的窗口留下', async () => {
    canCloseImpl = (instanceKey) => instanceKey !== 'blocked';
    const store = useWindowStore.getState();
    const id1 = store.openWindow({ typeId: GUARDED_TYPE_ID, instanceKey: 'ok' });
    const id2 = store.openWindow({ typeId: GUARDED_TYPE_ID, instanceKey: 'blocked' });
    const other = store.openWindow({ typeId: 'other-app', instanceKey: 'c' });
    const { props } = renderBar({ windowId: id1 });

    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }), { altKey: true });

    await waitFor(() => {
      expect(useWindowStore.getState().windows[id1]).toBeUndefined();
    });
    expect(useWindowStore.getState().windows[id2]).toBeDefined();
    expect(useWindowStore.getState().windows[other]).toBeDefined();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

describe('未保存脏点', () => {
  it('setWindowDirty 后红灯挂 data-dirty 并渲染中心圆点，清除后移除', () => {
    renderBar({ windowId: 'dirty-win' });
    const close = screen.getByRole('button', { name: '关闭窗口' });
    expect(close.hasAttribute('data-dirty')).toBe(false);

    act(() => setWindowDirty('dirty-win', true));
    expect(close.hasAttribute('data-dirty')).toBe(true);
    expect(close.querySelector('.wb-title-dirty-dot')).toBeTruthy();

    act(() => setWindowDirty('dirty-win', false));
    expect(close.hasAttribute('data-dirty')).toBe(false);
  });
});

describe('绿灯沉浸模式', () => {
  it('点击绿灯进入沉浸（maximize + 菜单栏强制 autohide），再点退出并还原 frame', () => {
    const store = useWindowStore.getState();
    const id = store.openWindow({
      typeId: 'immersive-app',
      instanceKey: 'x',
      initialFrame: { x: 30, y: 40, w: 500, h: 360 },
    });
    const { props } = renderBar({ windowId: id });
    const zoomBtn = screen.getByRole('button', { name: '进入沉浸模式' });

    fireEvent.click(zoomBtn);
    expect(isWindowImmersive(id)).toBe(true);
    expect(useWindowStore.getState().windows[id]?.displayMode).toBe('maximized');
    expect(useMenuBarAutohideStore.getState().forceAutohide).toBe(true);
    expect(props.onZoom).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '退出沉浸模式' }));
    expect(isWindowImmersive(id)).toBe(false);
    const win = useWindowStore.getState().windows[id];
    expect(win?.displayMode).toBe('floating');
    expect(win?.frame).toMatchObject({ x: 30, y: 40, w: 500, h: 360 });
    expect(useMenuBarAutohideStore.getState().forceAutohide).toBe(false);
  });

  it('⌥+绿灯走传统 zoom 回调，不进入沉浸', () => {
    const store = useWindowStore.getState();
    const id = store.openWindow({ typeId: 'immersive-app', instanceKey: 'y' });
    const { props } = renderBar({ windowId: id });

    fireEvent.click(screen.getByRole('button', { name: '进入沉浸模式' }), { altKey: true });
    expect(props.onZoom).toHaveBeenCalledWith({ alt: true });
    expect(isWindowImmersive(id)).toBe(false);
    expect(useMenuBarAutohideStore.getState().forceAutohide).toBe(false);
  });
});

describe('长标题溢出', () => {
  const defineSize = (scrollWidth: number, clientWidth: number) => {
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get: () => scrollWidth,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => clientWidth,
    });
  };
  const restoreSize = () => {
    delete (HTMLElement.prototype as any).scrollWidth;
    delete (HTMLElement.prototype as any).clientWidth;
  };

  it('溢出时标题打 data-wb-title-overflow 标记，标题栏带完整标题 tooltip', () => {
    defineSize(400, 120);
    try {
      const { container } = renderBar({ title: '一个非常非常非常长的窗口标题' });
      const text = container.querySelector('[data-wb-window-title]') as HTMLElement;
      expect(text.hasAttribute('data-wb-title-overflow')).toBe(true);
      const bar = container.querySelector('[data-wb-titlebar]') as HTMLElement;
      expect(bar.getAttribute('title')).toBe('一个非常非常非常长的窗口标题');
    } finally {
      restoreSize();
    }
  });

  it('未溢出时不打标记、无 tooltip', () => {
    defineSize(80, 120);
    try {
      const { container } = renderBar();
      const text = container.querySelector('[data-wb-window-title]') as HTMLElement;
      expect(text.hasAttribute('data-wb-title-overflow')).toBe(false);
      const bar = container.querySelector('[data-wb-titlebar]') as HTMLElement;
      expect(bar.hasAttribute('title')).toBe(false);
    } finally {
      restoreSize();
    }
  });

  it('chat exposes a titlebar control slot without replacing its centered title', () => {
    const { container } = renderBar({ appTypeId: 'chat', title: '新对话' });

    expect(container.querySelector('[data-wb-titlebar-slot]')).not.toBeNull();
    expect(container.querySelector('[data-wb-window-title]')?.textContent).toBe('新对话');
  });
});

describe('双击标题栏（按设置分发）', () => {
  it('默认 zoom：双击空白区触发 zoom 并生成涟漪', () => {
    const { container, props } = renderBar();
    const bar = container.querySelector('[data-wb-titlebar]') as HTMLElement;
    fireEvent.doubleClick(bar, { clientX: 60, clientY: 12 });
    expect(props.onZoom).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.wb-title-ripple')).toBeTruthy();
  });

  it('设置为 minimize：双击触发最小化而非 zoom', () => {
    act(() => {
      useTitleBarBehaviorStore.getState().setDoubleClickAction('minimize');
    });
    const { container, props } = renderBar();
    const bar = container.querySelector('[data-wb-titlebar]') as HTMLElement;
    fireEvent.doubleClick(bar, { clientX: 60, clientY: 12 });
    expect(props.onMinimize).toHaveBeenCalledTimes(1);
    expect(props.onZoom).not.toHaveBeenCalled();
  });

  it('设置为 none：双击不做任何事（无涟漪）', () => {
    act(() => {
      useTitleBarBehaviorStore.getState().setDoubleClickAction('none');
    });
    const { container, props } = renderBar();
    const bar = container.querySelector('[data-wb-titlebar]') as HTMLElement;
    fireEvent.doubleClick(bar, { clientX: 60, clientY: 12 });
    expect(props.onZoom).not.toHaveBeenCalled();
    expect(props.onMinimize).not.toHaveBeenCalled();
    expect(container.querySelector('.wb-title-ripple')).toBeNull();
  });

  it('workbench:settings-changed 热更新双击行为', () => {
    const { container, props } = renderBar();
    act(() => {
      window.dispatchEvent(
        new CustomEvent('workbench:settings-changed', {
          detail: { key: 'desktop.workbenchTitleBarDoubleClick', value: 'none' },
        }),
      );
    });
    const bar = container.querySelector('[data-wb-titlebar]') as HTMLElement;
    fireEvent.doubleClick(bar, { clientX: 60, clientY: 12 });
    expect(props.onZoom).not.toHaveBeenCalled();
  });
});
