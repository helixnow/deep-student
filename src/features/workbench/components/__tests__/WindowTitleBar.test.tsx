/**
 * WindowTitleBar 打磨轮测试：三键 aria 标签（含 ⌥ 批量语义切换）/
 * 绿灯沉浸模式 + ⌥ 传统 zoom / ⌥+红黄灯批量关闭最小化 /
 * 未保存脏点渲染 / 长标题溢出 tooltip / 双击标题栏按设置分发。
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  it('按住 ⌥ 时三键提示切换为批量 / 传统 zoom 语义，绿灯实时切换为 + 符号，松开与失焦恢复', () => {
    const { container } = renderBar({ displayMode: 'maximized' });
    expect(container.querySelector('[data-wb-zoom-glyph="restore"]')).toBeTruthy();
    expect(container.querySelector('[data-wb-zoom-glyph="plus"]')).toBeNull();

    fireEvent.keyDown(window, { key: 'Alt' });
    expect(screen.getByRole('button', { name: '关闭该应用全部窗口' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '最小化该应用全部窗口' })).toBeTruthy();
    // ⌥ 语义下绿灯回到传统 zoom：managed 态 = 还原窗口，符号切为经典 macOS +
    expect(screen.getByRole('button', { name: '还原窗口' })).toBeTruthy();
    expect(container.querySelector('[data-wb-zoom-glyph="plus"]')).toBeTruthy();
    expect(container.querySelector('[data-wb-zoom-glyph="restore"]')).toBeNull();

    fireEvent.keyUp(window, { key: 'Alt' });
    expect(screen.getByRole('button', { name: '关闭窗口' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '进入沉浸模式' })).toBeTruthy();
    expect(container.querySelector('[data-wb-zoom-glyph="plus"]')).toBeNull();
    expect(container.querySelector('[data-wb-zoom-glyph="restore"]')).toBeTruthy();

    // 窗口失焦兜底还原
    fireEvent.keyDown(window, { key: 'Alt' });
    expect(container.querySelector('[data-wb-zoom-glyph="plus"]')).toBeTruthy();
    fireEvent.blur(window);
    expect(container.querySelector('[data-wb-zoom-glyph="plus"]')).toBeNull();
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

  it.each(['chat', 'chat-session'])('%s keeps the window controls without a visible centered title', (appTypeId) => {
    const { container } = renderBar({ appTypeId, title: '新对话' });

    expect(container.querySelector('[data-wb-title-draggable]')).toHaveAttribute('data-wb-title-seamless');
    expect(container.querySelector('.wb-traffic-close')).toBeInTheDocument();
    expect(container.querySelector('[data-wb-window-title]')).toBeNull();
    expect(Boolean(container.querySelector('[data-wb-titlebar-slot]'))).toBe(appTypeId === 'chat');
  });

  it.each(['exam', 'translation', 'essay'])(
    '%s exposes a titlebar slot for its resource list toggle and keeps the centered title',
    (appTypeId) => {
      const { container } = renderBar({ appTypeId, title: '作文批改' });

      expect(container.querySelector('[data-wb-titlebar-slot]')).not.toBeNull();
      expect(container.querySelector('[data-wb-window-title]')?.textContent).toBe('作文批改');
    },
  );
});

describe('双击标题栏（按设置分发）', () => {
  it('默认 zoom：双击空白区触发 zoom 且不生成 Material 涟漪', () => {
    const { container, props } = renderBar();
    const bar = container.querySelector('[data-wb-titlebar]') as HTMLElement;
    fireEvent.doubleClick(bar, { clientX: 60, clientY: 12 });
    expect(props.onZoom).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.wb-title-ripple')).toBeNull();
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

describe('移动端 / 触屏三键真实命中框（360px 回归）', () => {
  it('WindowTitleBar.css 在 coarse / <= 640px 下将标题栏增至 44px、扩大真实 button 命中框至 44×44px 并保持居中 12px 圆点与 140px 避让', () => {
    const css = readFileSync(
      resolve(__dirname, '../WindowTitleBar.css'),
      'utf8',
    );
    const mediaIdx = css.indexOf('@media (pointer: coarse), (max-width: 640px)');
    expect(mediaIdx).toBeGreaterThan(-1);
    const mobileBlock = css.slice(mediaIdx);
    expect(mobileBlock).toContain('.wb-titlebar.wb-title-bar {');
    expect(mobileBlock).toContain('min-width: 44px;');
    expect(mobileBlock).toContain('min-height: 44px;');
    expect(mobileBlock).toContain('width: 44px;');
    expect(mobileBlock).toContain('height: 44px;');
    expect(mobileBlock).toContain('width: var(--wb-traffic-size, 12px);');
    expect(mobileBlock).toContain('height: var(--wb-traffic-size, 12px);');
    expect(mobileBlock).toContain('.wb-titlebar.wb-title-bar .wb-traffic-zoom-wrap');
    expect(mobileBlock).toContain('left: 140px;');
  });
});

describe('子应用 Portal 进标题栏槽位时的拖拽与双击冒泡', () => {
  it('兄弟组件通过 createPortal 挂载到 [data-wb-titlebar-slot] 的非交互区域可正常起拖与双击，交互按钮/可拖拽标签仍放行', () => {
    const onMovePointerDown = vi.fn();
    const onZoom = vi.fn();
    const Harness: React.FC = () => {
      const [slot, setSlot] = React.useState<HTMLElement | null>(null);
      React.useLayoutEffect(() => {
        setSlot(document.querySelector('[data-wb-titlebar-slot]'));
      }, []);
      return (
        <div>
          <WindowTitleBar
            windowId="win-portal"
            appTypeId="todo"
            title="待办"
            focused
            displayMode="floating"
            onClose={vi.fn()}
            onMinimize={vi.fn()}
            onZoom={onZoom}
            onTileAction={vi.fn()}
            onMovePointerDown={onMovePointerDown}
          />
          {slot
            ? createPortal(
                <div className="pointer-events-auto flex items-center gap-2" data-testid="portal-row">
                  <span data-testid="portal-title">今天</span>
                  <button type="button" data-testid="portal-btn">新建</button>
                  <div draggable data-testid="portal-draggable-tab">标签</div>
                </div>,
                slot,
              )
            : null}
        </div>
      );
    };

    const { getByTestId } = render(<Harness />);
    // 1. 点击 portal 内非交互标题文字 → 经原生 DOM 冒泡到标题栏，触发起拖
    fireEvent.pointerDown(getByTestId('portal-title'), { button: 0, pointerId: 1, clientX: 120, clientY: 16 });
    expect(onMovePointerDown).toHaveBeenCalledTimes(1);

    // 2. 双击 portal 内非交互区域 → 正常触发 zoom
    fireEvent.doubleClick(getByTestId('portal-title'), { clientX: 120, clientY: 16 });
    expect(onZoom).toHaveBeenCalledTimes(1);

    // 3. 点击 portal 内按钮与 draggable 标签 → 不触发起拖也不触发 zoom
    fireEvent.pointerDown(getByTestId('portal-btn'), { button: 0, pointerId: 2, clientX: 200, clientY: 16 });
    fireEvent.pointerDown(getByTestId('portal-draggable-tab'), { button: 0, pointerId: 3, clientX: 240, clientY: 16 });
    fireEvent.doubleClick(getByTestId('portal-btn'), { clientX: 200, clientY: 16 });
    expect(onMovePointerDown).toHaveBeenCalledTimes(1);
    expect(onZoom).toHaveBeenCalledTimes(1);
  });
});
