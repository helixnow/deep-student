import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

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
});
