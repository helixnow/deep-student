import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WindowTitleBar } from '@/features/workbench/components/WindowTitleBar';

const titlebarCss = readFileSync(
  resolve(process.cwd(), 'src/features/workbench/components/WindowTitleBar.css'),
  'utf8',
);
const workbenchTokensCss = readFileSync(
  resolve(process.cwd(), 'src/features/workbench/styles/workbench.tokens.css'),
  'utf8',
);

describe('WindowTitleBar hit target contract', () => {
  it('expands each traffic-light hit target without changing visual geometry', () => {
    expect(workbenchTokensCss).toMatch(/--wb-traffic-size:\s*12px;/);
    expect(workbenchTokensCss).toMatch(/--wb-traffic-gap:\s*8px;/);

    const hitTargetRule = titlebarCss.match(/\.wb-title-key::after\s*\{(?<body>[^}]*)\}/)
      ?.groups?.body;
    expect(hitTargetRule).toBeDefined();
    expect(hitTargetRule).toMatch(/content:\s*'';/);
    expect(hitTargetRule).toMatch(/inset:\s*-7px -4px;/);
    expect(hitTargetRule).toMatch(/background:\s*transparent;/);
    expect(hitTargetRule).toMatch(/pointer-events:\s*auto;/);
  });
});

function renderBar(overrides: Partial<React.ComponentProps<typeof WindowTitleBar>> = {}) {
  const props = {
    windowId: 'w1',
    title: '测试窗口',
    focused: true,
    displayMode: 'floating' as const,
    onClose: vi.fn(),
    onMinimize: vi.fn(),
    onZoom: vi.fn(),
    onTileAction: vi.fn(),
    ...overrides,
  };
  const utils = render(<WindowTitleBar {...props} />);
  return { ...utils, props };
}

describe('WindowTitleBar 三键与双击', () => {
  it('为 Notes 应用提供标签栏插槽并隐藏重复窗口标题', () => {
    const { container } = renderBar({ appTypeId: 'notes', title: '笔记' });
    expect(container.querySelector('[data-wb-titlebar-slot][data-window-id="w1"]')).not.toBeNull();
    expect(container.querySelector('[data-wb-window-title]')).toBeNull();
  });

  it('渲染三键与居中标题', () => {
    renderBar();
    expect(screen.getByRole('button', { name: '关闭窗口' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '最小化窗口' })).toBeInTheDocument();
    // 绿灯默认语义 = 沉浸模式 toggle（⌥ 才是传统 zoom）
    expect(screen.getByRole('button', { name: '进入沉浸模式' })).toBeInTheDocument();
    const title = screen.getByText('测试窗口');
    expect(title).toHaveAttribute('data-wb-window-title');
  });

  it('关闭键触发 onClose（requestClose 流程入口）', () => {
    const { props } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onZoom).not.toHaveBeenCalled();
  });

  it('最小化键触发 onMinimize', () => {
    const { props } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: '最小化窗口' }));
    expect(props.onMinimize).toHaveBeenCalledTimes(1);
  });

  it('⌥+绿灯 = 传统 zoom（maximize toggle）回调', () => {
    const { props } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: '进入沉浸模式' }), { altKey: true });
    expect(props.onZoom).toHaveBeenCalledTimes(1);
    expect(props.onZoom).toHaveBeenCalledWith({ alt: true });
  });

  it('双击标题栏空白区 = maximize toggle', () => {
    const { props, container } = renderBar();
    const bar = container.querySelector('[data-wb-titlebar]')!;
    fireEvent.doubleClick(bar);
    expect(props.onZoom).toHaveBeenCalledTimes(1);
  });

  it('双击三键不冒泡为标题栏双击', () => {
    const { props } = renderBar();
    fireEvent.doubleClick(screen.getByRole('button', { name: '关闭窗口' }));
    expect(props.onZoom).not.toHaveBeenCalled();
  });

  it('标题栏按下把 pointerdown 交给移动拖拽入口', () => {
    const onMovePointerDown = vi.fn();
    const { container } = renderBar({ onMovePointerDown });
    const bar = container.querySelector('[data-wb-titlebar]')!;
    // jsdom 无 PointerEvent 构造器时 fireEvent.pointerDown 的 fallback Event 不带 button，
    // 用 MouseEvent 构造保证 button=0（主键）语义
    fireEvent(bar, new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    expect(onMovePointerDown).toHaveBeenCalledTimes(1);
  });

  it('单击/触控板微抖（<3px）不置 dragging 视觉态；过 3px 阈值才挂 wb-title-dragging', () => {
    const { container } = renderBar();
    const bar = container.querySelector('[data-wb-titlebar]')!;
    fireEvent(bar, new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 100, clientY: 10 }));
    expect(bar.className).not.toContain('wb-title-dragging');
    // 2px 微抖（双击常见）不武装拖拽态，双击 zoom 不被吞
    fireEvent(window, new MouseEvent('pointermove', { bubbles: true, clientX: 102, clientY: 10 }));
    expect(bar.className).not.toContain('wb-title-dragging');
    fireEvent(window, new MouseEvent('pointermove', { bubbles: true, clientX: 104, clientY: 10 }));
    expect(bar.className).toContain('wb-title-dragging');
    fireEvent(window, new MouseEvent('pointerup', { bubbles: true }));
    expect(bar.className).not.toContain('wb-title-dragging');
  });

  it('挂载 O3 类契约：wb-title-bar / wb-title-key / glyph / draggable', () => {
    const { container } = renderBar();
    const bar = container.querySelector('[data-wb-titlebar]')!;
    expect(bar.className).toContain('wb-title-bar');
    expect(bar).toHaveAttribute('data-wb-title-draggable');
    expect(container.querySelectorAll('.wb-title-key')).toHaveLength(3);
    expect(container.querySelectorAll('.wb-title-glyph')).toHaveLength(3);
  });

  it('双击标题栏产生涟漪并在 animationend 后移除', () => {
    const { container } = renderBar();
    const bar = container.querySelector('[data-wb-titlebar]')!;
    fireEvent.doubleClick(bar);
    const ripple = container.querySelector('.wb-title-ripple');
    expect(ripple).toBeInTheDocument();
    fireEvent.animationEnd(ripple!);
    expect(container.querySelector('.wb-title-ripple')).toBeNull();
  });

  it('zoom 符号随 displayMode 切换（maximized 为还原态）', () => {
    const { rerender, container, props } = renderBar({ displayMode: 'floating' });
    const floatingPath = container.querySelector('.wb-traffic-zoom .wb-title-glyph path')?.getAttribute('d');
    rerender(
      <WindowTitleBar
        {...props}
        displayMode="maximized"
      />,
    );
    const restorePath = container.querySelector('.wb-traffic-zoom .wb-title-glyph path')?.getAttribute('d');
    expect(floatingPath).toBeTruthy();
    expect(restorePath).toBeTruthy();
    expect(restorePath).not.toBe(floatingPath);
  });
});
