import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommonTooltip } from '../CommonTooltip';
import { OverlayCoordinatorProvider, useOverlayCoordinator } from '../OverlayCoordinator';

describe('CommonTooltip', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the default hover intent delay before showing tooltip content', () => {
    vi.useFakeTimers();

    render(
      <CommonTooltip content="保存当前编辑">
        <button type="button">保存</button>
      </CommonTooltip>
    );

    fireEvent.mouseEnter(screen.getByRole('button', { name: '保存' }));

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('tooltip')).toHaveTextContent('保存当前编辑');
  });

  it('still supports explicit immediate tooltips', () => {
    render(
      <CommonTooltip content="立即显示" delay={0}>
        <button type="button">帮助</button>
      </CommonTooltip>
    );

    fireEvent.mouseEnter(screen.getByRole('button', { name: '帮助' }));

    expect(screen.getByRole('tooltip')).toHaveTextContent('立即显示');
  });

  it('dismisses a visible tooltip when Escape is pressed', () => {
    render(
      <CommonTooltip content="可关闭提示" delay={0}>
        <button type="button">更多</button>
      </CommonTooltip>
    );

    fireEvent.mouseEnter(screen.getByRole('button', { name: '更多' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('可关闭提示');

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('dismisses a visible tooltip when its trigger is activated', () => {
    render(
      <CommonTooltip content="更多操作" delay={0}>
        <button type="button">更多</button>
      </CommonTooltip>
    );

    const trigger = screen.getByRole('button', { name: '更多' });
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole('tooltip')).toHaveTextContent('更多操作');

    fireEvent.pointerDown(trigger);

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('suppresses tooltips while an interactive overlay is open', () => {
    function Harness() {
      const { registerInteractiveOverlay } = useOverlayCoordinator();
      const [menuOpen, setMenuOpen] = React.useState(false);

      React.useEffect(() => {
        if (!menuOpen) return;
        return registerInteractiveOverlay();
      }, [menuOpen, registerInteractiveOverlay]);

      return (
        <>
          <CommonTooltip content="菜单入口说明" delay={0}>
            <button type="button">菜单入口</button>
          </CommonTooltip>
          <button type="button" onClick={() => setMenuOpen(true)}>
            打开菜单
          </button>
          <button type="button" onClick={() => setMenuOpen(false)}>
            关闭菜单
          </button>
          {menuOpen && <div role="menu">菜单内容</div>}
        </>
      );
    }

    render(
      <OverlayCoordinatorProvider>
        <Harness />
      </OverlayCoordinatorProvider>
    );

    const trigger = screen.getByRole('button', { name: '菜单入口' });
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole('tooltip')).toHaveTextContent('菜单入口说明');

    fireEvent.click(screen.getByRole('button', { name: '打开菜单' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.mouseEnter(trigger);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '关闭菜单' }));
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole('tooltip')).toHaveTextContent('菜单入口说明');
  });
});
