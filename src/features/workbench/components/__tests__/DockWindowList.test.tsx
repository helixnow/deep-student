/**
 * O6 — DockWindowList：缩略预览回退、键盘、关闭按钮、aria、退场
 */
import React from 'react';
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import type { AppDefinition, AppWindowProps, WorkbenchWindow } from '../../core/types';
import { appRegistry } from '../../core/appRegistry';
import { useWindowStore } from '../../core/windowStore';
import { workbenchBus } from '../../core/workbenchBus';
import { DockWindowList } from '../DockWindowList';

const NullApp: React.FC<AppWindowProps> = () => null;

function makeApp(typeId: string): AppDefinition {
  return {
    typeId,
    nameKey: `workbench:app.${typeId}`,
    icon: <span data-testid={`icon-${typeId}`}>{typeId[0]}</span>,
    instanceMode: 'multi',
    memoryWeight: 1,
    defaultFrame: { w: 400, h: 300 },
    minSize: { w: 200, h: 150 },
    render: React.lazy(async () => ({ default: NullApp })),
  };
}

function makeWin(over: Partial<WorkbenchWindow> & Pick<WorkbenchWindow, 'id' | 'typeId'>): WorkbenchWindow {
  return {
    instanceKey: over.id,
    title: '',
    frame: { x: 0, y: 0, w: 400, h: 300 },
    restoreFrame: null,
    displayMode: 'floating',
    minimized: false,
    zIndex: 1,
    createdAt: Date.now(),
    lastFocusedAt: Date.now(),
    ...over,
  };
}

beforeAll(() => {
  workbenchBus.setEnabled(true);
  appRegistry.register(makeApp('chat'));
});

beforeEach(() => {
  useWindowStore.setState({
    windows: {},
    focusStack: [],
    lifecycles: {},
    launchPayloads: {},
    tilingRatios: {},
    desktopSize: { w: 1600, h: 900 },
  });
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-wb-material');
});

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.removeAttribute('data-wb-material');
});

describe('DockWindowList', () => {
  it('无 DOM 时缩略回退占位卡', () => {
    const ownerRef = { current: document.createElement('div') };
    document.body.appendChild(ownerRef.current);
    const wins = [
      makeWin({ id: 'w1', typeId: 'chat', title: '会话 A' }),
      makeWin({ id: 'w2', typeId: 'chat', title: '会话 B' }),
    ];
    render(
      <DockWindowList
        appLabel="chat"
        typeId="chat"
        windows={wins}
        ownerRef={ownerRef}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const thumb = screen.getByTestId('wb-docklist-thumb-w1');
    expect(thumb).toHaveAttribute('data-mode', 'placeholder');
    expect(within(thumb).getByText('会话 A')).toBeInTheDocument();
  });

  it('有轻量 DOM 时克隆预览', () => {
    const source = document.createElement('div');
    source.setAttribute('data-wb-window-id', 'w1');
    source.style.width = '400px';
    source.style.height = '300px';
    source.textContent = 'window body';
    document.body.appendChild(source);

    const ownerRef = { current: document.createElement('div') };
    document.body.appendChild(ownerRef.current);

    render(
      <DockWindowList
        appLabel="chat"
        typeId="chat"
        windows={[makeWin({ id: 'w1', typeId: 'chat', title: '会话 A' })]}
        ownerRef={ownerRef}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const thumb = screen.getByTestId('wb-docklist-thumb-w1');
    expect(thumb).toHaveAttribute('data-mode', 'preview');
    expect(thumb.querySelector('.wb-docklist-thumb-host')?.childElementCount).toBe(1);
  });

  it('←/→/Delete/Esc 键盘行为', () => {
    // minimal 档：退场瞬时，Esc 立即 onDismiss
    document.documentElement.setAttribute('data-wb-material', 'minimal');
    const ownerRef = { current: document.createElement('div') };
    document.body.appendChild(ownerRef.current);
    const onSelect = vi.fn();
    const onDismiss = vi.fn();
    const onCloseWindow = vi.fn();
    const wins = [
      makeWin({ id: 'w1', typeId: 'chat', title: '会话 A' }),
      makeWin({ id: 'w2', typeId: 'chat', title: '会话 B' }),
    ];
    render(
      <DockWindowList
        appLabel="chat"
        windows={wins}
        ownerRef={ownerRef}
        onSelect={onSelect}
        onDismiss={onDismiss}
        onCloseWindow={onCloseWindow}
      />,
    );
    const list = screen.getByTestId('wb-dock-window-list');
    const items = within(list).getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(list, { key: 'Delete' });
    expect(onCloseWindow).toHaveBeenCalledWith('w1');

    fireEvent.keyDown(list, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalled();
  });

  it('Esc 退场：先 data-phase=closing，animationend 后再 onDismiss', () => {
    const ownerRef = { current: document.createElement('div') };
    document.body.appendChild(ownerRef.current);
    const onDismiss = vi.fn();
    render(
      <DockWindowList
        appLabel="chat"
        windows={[
          makeWin({ id: 'w1', typeId: 'chat', title: 'A' }),
          makeWin({ id: 'w2', typeId: 'chat', title: 'B' }),
        ]}
        ownerRef={ownerRef}
        onSelect={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    const list = screen.getByTestId('wb-dock-window-list');
    fireEvent.keyDown(list, { key: 'Escape' });
    expect(list).toHaveAttribute('data-phase', 'closing');
    expect(onDismiss).not.toHaveBeenCalled();

    const surface = list.querySelector('.wb-docklist-surface');
    expect(surface).toBeTruthy();
    fireEvent.animationEnd(surface!);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('Esc 退场：超时兜底也会 onDismiss', () => {
    vi.useFakeTimers();
    const ownerRef = { current: document.createElement('div') };
    document.body.appendChild(ownerRef.current);
    const onDismiss = vi.fn();
    render(
      <DockWindowList
        appLabel="chat"
        windows={[
          makeWin({ id: 'w1', typeId: 'chat', title: 'A' }),
          makeWin({ id: 'w2', typeId: 'chat', title: 'B' }),
        ]}
        ownerRef={ownerRef}
        onSelect={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.keyDown(screen.getByTestId('wb-dock-window-list'), { key: 'Escape' });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(220);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('关闭按钮调用 onCloseWindow', () => {
    const ownerRef = { current: document.createElement('div') };
    document.body.appendChild(ownerRef.current);
    const onCloseWindow = vi.fn();
    render(
      <DockWindowList
        appLabel="chat"
        windows={[makeWin({ id: 'w1', typeId: 'chat', title: '会话 A' })]}
        ownerRef={ownerRef}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
        onCloseWindow={onCloseWindow}
      />,
    );
    fireEvent.click(screen.getByTestId('wb-docklist-close-w1'));
    expect(onCloseWindow).toHaveBeenCalledWith('w1');
  });

  it.each([
    ['返回 false', () => Promise.resolve(false)],
    ['抛出异常', () => Promise.reject(new Error('close rejected'))],
  ])('关闭被拒绝（%s）后，标题更新不会抢回列表焦点', async (_case, closeImpl) => {
    const ownerRef = { current: document.createElement('button') };
    document.body.appendChild(ownerRef.current);
    const onCloseWindow = vi.fn(closeImpl);
    const original = makeWin({ id: 'w1', typeId: 'chat', title: '会话 A' });
    const { rerender } = render(
      <DockWindowList
        appLabel="chat"
        windows={[original]}
        ownerRef={ownerRef}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
        onCloseWindow={onCloseWindow}
      />,
    );

    fireEvent.click(screen.getByTestId('wb-docklist-close-w1'));
    await act(async () => {
      await Promise.resolve();
    });
    ownerRef.current.focus();

    rerender(
      <DockWindowList
        appLabel="chat"
        windows={[{ ...original, title: '会话 A（已更新）' }]}
        ownerRef={ownerRef}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
        onCloseWindow={onCloseWindow}
      />,
    );

    // 不能断言"rAF 未被调用"：OverlayScrollbars 等库内部也会在重渲染时排队 rAF。
    // 行为口径：等一帧让已排队回调（含潜在的 refocus rAF）执行完，焦点不应被列表抢回。
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
    expect(document.activeElement).toBe(ownerRef.current);
  });

  it('role=menu 与 aria-label', () => {
    const ownerRef = { current: document.createElement('div') };
    document.body.appendChild(ownerRef.current);
    render(
      <DockWindowList
        appLabel="我的聊天"
        windows={[makeWin({ id: 'w1', typeId: 'chat', title: 'A' })]}
        ownerRef={ownerRef}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole('menu', { name: '我的聊天' })).toBeInTheDocument();
  });
});
