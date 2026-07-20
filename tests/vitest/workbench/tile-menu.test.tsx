import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TileMenuPopover,
  TILE_MENU_GRID,
  TILE_MENU_EXIT_FALLBACK_MS,
} from '@/features/workbench/components/TileMenuPopover';
import {
  WindowTitleBar,
  TILE_MENU_HOVER_DELAY,
  TILE_MENU_CLOSE_GRACE,
  TILE_MENU_LONGPRESS_DELAY,
} from '@/features/workbench/components/WindowTitleBar';

afterEach(() => {
  vi.useRealTimers();
});

function renderPopover(overrides: Partial<React.ComponentProps<typeof TileMenuPopover>> = {}) {
  const props = {
    open: true,
    currentMode: 'floating' as const,
    onSelect: vi.fn(),
    onRequestClose: vi.fn(),
    ...overrides,
  };
  const utils = render(<TileMenuPopover {...props} />);
  return { ...utils, props };
}

/** 退场：animationend 快路径，或超时兜底 */
function flushTileMenuExit(menu: Element) {
  fireEvent.animationEnd(menu);
}

describe('TileMenuPopover 九宫格', () => {
  it('渲染 3×3 全部平铺选项 + 沉浸模式整行项', () => {
    renderPopover();
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(TILE_MENU_GRID.flat().length + 1);
    for (const action of TILE_MENU_GRID.flat()) {
      expect(
        document.querySelector(`[data-wb-tile-action="${action}"]`),
      ).toBeInTheDocument();
    }
    expect(
      document.querySelector('[data-wb-tile-action="immersive"]'),
    ).toBeInTheDocument();
  });

  it('点击「进入沉浸模式」项回调 immersive', () => {
    const { props } = renderPopover();
    fireEvent.click(screen.getByRole('menuitem', { name: '进入沉浸模式' }));
    expect(props.onSelect).toHaveBeenCalledWith('immersive');
  });

  it('打开后焦点进入网格中心，方向键可在网格内移动（含回卷）', async () => {
    renderPopover();
    const menu = screen.getByRole('menu');
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute('data-wb-tile-action', 'center'),
    );

    fireEvent.keyDown(menu, { key: 'ArrowLeft' });
    expect(document.activeElement).toHaveAttribute('data-wb-tile-action', 'tiled-left');

    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toHaveAttribute('data-wb-tile-action', 'tiled-tl');

    // 列回卷：col 0 再向左 → col 2
    fireEvent.keyDown(menu, { key: 'ArrowLeft' });
    expect(document.activeElement).toHaveAttribute('data-wb-tile-action', 'tiled-tr');

    // 行回卷：row 0 再向上 → 沉浸整行 → 再向上回到网格末行（列保持）
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toHaveAttribute('data-wb-tile-action', 'immersive');
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toHaveAttribute('data-wb-tile-action', 'tiled-br');
  });

  it('Enter 选择当前项，Esc 请求关闭', async () => {
    const { props } = renderPopover();
    const menu = screen.getByRole('menu');
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute('data-wb-tile-action', 'center'),
    );
    fireEvent.keyDown(menu, { key: 'ArrowRight' });
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(props.onSelect).toHaveBeenCalledWith('tiled-right');

    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(props.onRequestClose).toHaveBeenCalledTimes(1);
  });

  it('点击任意项直接选择', () => {
    const { props } = renderPopover();
    fireEvent.click(screen.getByRole('menuitem', { name: '填满' }));
    expect(props.onSelect).toHaveBeenCalledWith('maximized');
  });

  it('open=false 不渲染', () => {
    renderPopover({ open: false });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('面板带 wb-glass / wb-tilemenu，入场 data-phase=open', () => {
    renderPopover();
    const menu = screen.getByRole('menu');
    expect(menu).toHaveClass('wb-tilemenu');
    expect(menu).toHaveClass('wb-glass');
    expect(menu).toHaveAttribute('data-phase', 'open');
    expect(menu).toHaveAttribute('data-wb-tile-menu');
  });

  it('微缩桌面 glyph：平铺项含高亮块与淡块，恢复项为图标', () => {
    renderPopover();
    const left = document.querySelector('[data-wb-tile-action="tiled-left"]');
    expect(left?.querySelector('.wb-tilemenu-glyph-cell.is-active')).toBeTruthy();
    expect(left?.querySelector('.wb-tilemenu-glyph-cell.is-dim')).toBeTruthy();

    const restore = document.querySelector('[data-wb-tile-action="restore"]');
    expect(restore?.querySelector('.wb-tilemenu-restore')).toBeTruthy();
    expect(restore?.querySelector('.wb-tilemenu-glyph')).toBeNull();
  });

  it('open→false 进入 closing，animationend 后卸载', () => {
    const { rerender, props } = renderPopover();
    const menu = screen.getByRole('menu');
    expect(menu).toHaveAttribute('data-phase', 'open');

    rerender(
      <TileMenuPopover
        open={false}
        currentMode={props.currentMode}
        onSelect={props.onSelect}
        onRequestClose={props.onRequestClose}
      />,
    );
    expect(screen.getByRole('menu')).toHaveAttribute('data-phase', 'closing');

    flushTileMenuExit(screen.getByRole('menu'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('⌥ Option 按住时 Fill ⇄ Center 互换，松开还原', () => {
    renderPopover();
    const menu = screen.getByRole('menu');
    // 初始：顶行中格为 Fill(maximized)，中心格为 Center
    let items = screen.getAllByRole('menuitem');
    expect(items[1]).toHaveAttribute('data-wb-tile-action', 'maximized');
    expect(items[4]).toHaveAttribute('data-wb-tile-action', 'center');

    fireEvent.keyDown(window, { key: 'Alt' });
    expect(menu).toHaveAttribute('data-wb-tile-alt', 'true');
    items = screen.getAllByRole('menuitem');
    expect(items[1]).toHaveAttribute('data-wb-tile-action', 'center');
    expect(items[4]).toHaveAttribute('data-wb-tile-action', 'maximized');

    fireEvent.keyUp(window, { key: 'Alt' });
    items = screen.getAllByRole('menuitem');
    expect(items[1]).toHaveAttribute('data-wb-tile-action', 'maximized');
    expect(menu).not.toHaveAttribute('data-wb-tile-alt');
  });

  it('迟到的退场 animationend 不卸载已重新打开的菜单（phase 竞态加固）', () => {
    const { rerender, props } = renderPopover();
    const common = {
      currentMode: props.currentMode,
      onSelect: props.onSelect,
      onRequestClose: props.onRequestClose,
    };
    rerender(<TileMenuPopover open={false} {...common} />);
    expect(screen.getByRole('menu')).toHaveAttribute('data-phase', 'closing');
    // 快速重开：closing → open
    rerender(<TileMenuPopover open {...common} />);
    expect(screen.getByRole('menu')).toHaveAttribute('data-phase', 'open');
    // 上一段退场动画的 animationend 迟到派发 → 不得卸载
    fireEvent.animationEnd(screen.getByRole('menu'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menu')).toHaveAttribute('data-phase', 'open');
  });

  it('open→false 时超时兜底也可卸载', () => {
    vi.useFakeTimers();
    const { rerender, props } = renderPopover();
    rerender(
      <TileMenuPopover
        open={false}
        currentMode={props.currentMode}
        onSelect={props.onSelect}
        onRequestClose={props.onRequestClose}
      />,
    );
    expect(screen.getByRole('menu')).toHaveAttribute('data-phase', 'closing');

    act(() => {
      vi.advanceTimersByTime(TILE_MENU_EXIT_FALLBACK_MS + 10);
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('缩放键 hover 350ms 弹出', () => {
  function renderBar() {
    const props = {
      windowId: 'w1',
      title: 't',
      focused: true,
      displayMode: 'floating' as const,
      onClose: vi.fn(),
      onMinimize: vi.fn(),
      onZoom: vi.fn(),
      onTileAction: vi.fn(),
    };
    const utils = render(<WindowTitleBar {...props} />);
    return { ...utils, props };
  }

  it('悬停不足 350ms 不弹出，满 350ms 弹出，离开后宽限期关闭', () => {
    vi.useFakeTimers();
    renderBar();
    // 绿灯默认 aria-label = 沉浸模式（⌥ 语义才是「缩放窗口」）
    const zoom = screen.getByRole('button', { name: '进入沉浸模式' });

    fireEvent.pointerEnter(zoom);
    act(() => {
      vi.advanceTimersByTime(TILE_MENU_HOVER_DELAY - 50);
    });
    expect(screen.queryByRole('menu')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.pointerLeave(zoom);
    act(() => {
      vi.advanceTimersByTime(TILE_MENU_CLOSE_GRACE + 20);
    });
    // 宽限期后进入 closing；再走退场兜底才真正卸载
    expect(screen.getByRole('menu')).toHaveAttribute('data-phase', 'closing');
    act(() => {
      vi.advanceTimersByTime(TILE_MENU_EXIT_FALLBACK_MS + 10);
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('hover 打开不窃取缩放键焦点', () => {
    vi.useFakeTimers();
    renderBar();
    const zoom = screen.getByRole('button', { name: '进入沉浸模式' });
    zoom.focus();
    fireEvent.pointerEnter(zoom);
    act(() => vi.advanceTimersByTime(TILE_MENU_HOVER_DELAY + 10));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(zoom).toHaveFocus();
  });

  it('离开缩放键但进入菜单本体时保持打开', () => {
    vi.useFakeTimers();
    renderBar();
    const zoom = screen.getByRole('button', { name: '进入沉浸模式' });

    fireEvent.pointerEnter(zoom);
    act(() => {
      vi.advanceTimersByTime(TILE_MENU_HOVER_DELAY + 10);
    });
    const menu = screen.getByRole('menu');

    fireEvent.pointerLeave(zoom);
    fireEvent.pointerEnter(menu);
    act(() => {
      vi.advanceTimersByTime(TILE_MENU_CLOSE_GRACE + 100);
    });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menu')).toHaveAttribute('data-phase', 'open');
  });

  it('键盘 ArrowDown 立即打开菜单；选择后关闭并回调 onTileAction', () => {
    vi.useFakeTimers();
    const { props } = renderBar();
    const zoom = screen.getByRole('button', { name: '进入沉浸模式' });
    fireEvent.keyDown(zoom, { key: 'ArrowDown' });
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: '平铺到左半屏' }));
    expect(props.onTileAction).toHaveBeenCalledWith('tiled-left');
    // 选择后 TitleBar 立刻把 open 置 false → closing，再兜底卸载
    expect(screen.getByRole('menu')).toHaveAttribute('data-phase', 'closing');
    act(() => {
      vi.advanceTimersByTime(TILE_MENU_EXIT_FALLBACK_MS + 10);
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('键盘菜单 Tab 关闭时不强制把焦点抢回缩放键', () => {
    vi.useFakeTimers();
    renderBar();
    const zoom = screen.getByRole('button', { name: '进入沉浸模式' });
    fireEvent.keyDown(zoom, { key: 'ArrowDown' });
    act(() => vi.runOnlyPendingTimers());
    const item = screen.getByRole('menuitem', { name: '居中' });
    expect(item).toHaveFocus();
    fireEvent.keyDown(item, { key: 'Tab' });
    expect(screen.getByRole('menu')).toHaveAttribute('data-phase', 'closing');
  });

  it('长按绿灯 400ms 直接打开菜单，松手 click 不触发 zoom', () => {
    vi.useFakeTimers();
    const { props } = renderBar();
    const zoom = screen.getByRole('button', { name: '进入沉浸模式' });

    fireEvent(zoom, new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    act(() => {
      vi.advanceTimersByTime(TILE_MENU_LONGPRESS_DELAY - 50);
    });
    expect(screen.queryByRole('menu')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(screen.getByRole('menu')).toBeInTheDocument();

    // 长按松手产生的 click 被抑制：不 zoom、菜单保持打开
    fireEvent(zoom, new MouseEvent('pointerup', { bubbles: true }));
    fireEvent.click(zoom);
    expect(props.onZoom).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('短按（未满长按阈值）松手仍是普通点击（⌥ = 传统 zoom）', () => {
    vi.useFakeTimers();
    const { props } = renderBar();
    const zoom = screen.getByRole('button', { name: '进入沉浸模式' });
    fireEvent(zoom, new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent(zoom, new MouseEvent('pointerup', { bubbles: true }));
    fireEvent.click(zoom, { altKey: true });
    expect(props.onZoom).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('⌥+绿灯点击 = onZoom 且不弹菜单；默认点击不走 onZoom', () => {
    const { props } = renderBar();
    const zoom = screen.getByRole('button', { name: '进入沉浸模式' });
    // 默认点击 = 沉浸模式 toggle（不在 windowStore 的测试窗为 no-op），不回调 onZoom
    fireEvent.click(zoom);
    expect(props.onZoom).not.toHaveBeenCalled();
    fireEvent.click(zoom, { altKey: true });
    expect(props.onZoom).toHaveBeenCalledTimes(1);
    expect(props.onZoom).toHaveBeenCalledWith({ alt: true });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('缩放键使用 macOS 对角双三角，并按窗口状态切换方向', () => {
    const { rerender, props } = renderBar();
    const zoom = screen.getByRole('button', { name: '进入沉浸模式' });
    const expand = zoom.querySelector('[data-wb-zoom-glyph="expand"]');
    expect(expand).toBeInTheDocument();
    expect(expand).toHaveAttribute('viewBox', '0 0 16 16');
    expect(expand?.querySelector('path')).toHaveAttribute('d', 'M2 11V2h9zM14 5v9H5z');

    rerender(<WindowTitleBar {...props} displayMode="maximized" />);
    // maximized 下 glyph 切换为还原方向（aria-label 仍是沉浸语义，⌥ 才切「还原窗口」）
    const restore = screen
      .getByRole('button', { name: '进入沉浸模式' })
      .querySelector('[data-wb-zoom-glyph="restore"]');
    expect(restore).toBeInTheDocument();
    expect(restore).toHaveAttribute('viewBox', '0 0 16 16');
    expect(restore?.querySelector('path')).toHaveAttribute(
      'd',
      'M0 8h6.8L8 6.8V0zM16 8H9.2L8 9.2V16z',
    );
  });
});
