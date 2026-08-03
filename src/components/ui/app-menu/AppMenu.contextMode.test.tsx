import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CommonTooltip } from '../../shared/CommonTooltip';
import { OverlayCoordinatorProvider } from '../../shared/OverlayCoordinator';
import { AppMenu, AppMenuContent, AppMenuGroup, AppMenuItem, AppMenuTrigger } from './AppMenu';

describe('AppMenu context mode', () => {
  it('opens only on right click, not on left click', () => {
    render(
      <AppMenu mode="context">
        <AppMenuTrigger asChild>
          <div>Trigger</div>
        </AppMenuTrigger>
        <AppMenuContent>
          <AppMenuGroup>
            <AppMenuItem>Rename</AppMenuItem>
          </AppMenuGroup>
        </AppMenuContent>
      </AppMenu>
    );

    fireEvent.click(screen.getByText('Trigger'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByText('Trigger'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByText('Rename')).toBeInTheDocument();
  });

  it('uses the click as bottom-left anchor when the menu cannot expand downward', () => {
    render(
      <AppMenu mode="context">
        <AppMenuTrigger asChild>
          <div>Bottom trigger</div>
        </AppMenuTrigger>
        <AppMenuContent>
          <AppMenuItem>Open</AppMenuItem>
        </AppMenuContent>
      </AppMenu>
    );

    const clickY = window.innerHeight - 20;
    fireEvent.contextMenu(screen.getByText('Bottom trigger'), {
      clientX: 320,
      clientY: clickY,
    });
    const menu = screen.getByRole('menu');
    Object.defineProperties(menu, {
      offsetWidth: { configurable: true, value: 180 },
      offsetHeight: { configurable: true, value: 200 },
    });
    fireEvent.resize(window);

    expect(menu).toHaveStyle({ left: '320px', top: `${clickY - 200}px` });
    expect(menu).toHaveClass('app-menu-origin-bottom');
  });

  it('suppresses trigger tooltips while the menu is open', () => {
    render(
      <OverlayCoordinatorProvider>
        <AppMenu>
          <CommonTooltip content="更多菜单" delay={0}>
            <AppMenuTrigger asChild>
              <button type="button">更多</button>
            </AppMenuTrigger>
          </CommonTooltip>
          <AppMenuContent>
            <AppMenuGroup>
              <AppMenuItem>Rename</AppMenuItem>
            </AppMenuGroup>
          </AppMenuContent>
        </AppMenu>
      </OverlayCoordinatorProvider>
    );

    const trigger = screen.getByRole('button', { name: '更多' });
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole('tooltip')).toHaveTextContent('更多菜单');

    fireEvent.click(trigger);

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.mouseEnter(trigger);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});
