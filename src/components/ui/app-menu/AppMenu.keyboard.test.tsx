import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  AppMenu,
  AppMenuContent,
  AppMenuItem,
  AppMenuSub,
  AppMenuSubContent,
  AppMenuSubTrigger,
  AppMenuTrigger,
} from './AppMenu';

function renderSubmenu(openOnClick = false) {
  render(
    <AppMenu open>
      <AppMenuTrigger asChild>
        <button type="button">Root trigger</button>
      </AppMenuTrigger>
      <AppMenuContent>
        <AppMenuItem>Before</AppMenuItem>
        <AppMenuSub openOnClick={openOnClick}>
          <AppMenuSubTrigger>More</AppMenuSubTrigger>
          <AppMenuSubContent>
            <AppMenuItem>Alpha</AppMenuItem>
            <AppMenuItem>Beta</AppMenuItem>
          </AppMenuSubContent>
        </AppMenuSub>
        <AppMenuItem>After</AppMenuItem>
      </AppMenuContent>
    </AppMenu>,
  );

  return screen.getByRole('menuitem', { name: 'More' });
}

describe('AppMenu submenu keyboard contract', () => {
  it.each(['{Enter}', ' '])('%s opens a native dropdown trigger without the synthesized click closing it', async (key) => {
    const user = userEvent.setup();
    const Harness = () => {
      const [open, setOpen] = React.useState(false);
      return (
        <AppMenu open={open} onOpenChange={setOpen}>
          <AppMenuTrigger asChild>
            <button type="button">Actions</button>
          </AppMenuTrigger>
          <AppMenuContent>
            <AppMenuItem>First action</AppMenuItem>
          </AppMenuContent>
        </AppMenu>
      );
    };
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Actions' });
    trigger.focus();

    await user.keyboard(key);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'First action' })).toHaveFocus());
  });

  it.each(['Enter', ' ', 'ArrowRight'])('%s opens the default hover submenu and focuses its first item', async (key) => {
    const trigger = renderSubmenu();
    trigger.focus();

    fireEvent.keyDown(trigger, { key });

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus());
  });

  it('does not reset root menu focus when a controlled parent rerenders', async () => {
    const renderMenu = (version: number) => (
      <AppMenu open className={`version-${version}`}>
        <AppMenuTrigger asChild>
          <button type="button">Actions</button>
        </AppMenuTrigger>
        <AppMenuContent>
          <AppMenuItem>First action</AppMenuItem>
          <AppMenuItem>Second action</AppMenuItem>
        </AppMenuContent>
      </AppMenu>
    );
    const view = render(renderMenu(1));
    const first = await screen.findByRole('menuitem', { name: 'First action' });
    const second = screen.getByRole('menuitem', { name: 'Second action' });
    first.focus();
    await waitFor(() => expect(first).toHaveFocus());
    second.focus();

    view.rerender(renderMenu(2));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });

    expect(second).toHaveFocus();
  });

  it('does not reset submenu focus when its parent rerenders', async () => {
    const renderMenu = (version: number) => (
      <div data-version={version}>
        <AppMenu open>
          <AppMenuTrigger asChild>
            <button type="button">Root trigger</button>
          </AppMenuTrigger>
          <AppMenuContent>
            <AppMenuSub>
              <AppMenuSubTrigger>More</AppMenuSubTrigger>
              <AppMenuSubContent>
                <AppMenuItem>Alpha</AppMenuItem>
                <AppMenuItem>Beta</AppMenuItem>
              </AppMenuSubContent>
            </AppMenuSub>
          </AppMenuContent>
        </AppMenu>
      </div>
    );
    const view = render(renderMenu(1));
    const trigger = screen.getByRole('menuitem', { name: 'More' });
    fireEvent.keyDown(trigger, { key: 'ArrowRight' });
    const alpha = await screen.findByRole('menuitem', { name: 'Alpha' });
    const beta = screen.getByRole('menuitem', { name: 'Beta' });
    await waitFor(() => expect(alpha).toHaveFocus());
    beta.focus();

    view.rerender(renderMenu(2));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });

    expect(beta).toHaveFocus();
  });

  it('supports roving focus and returns to the trigger with ArrowLeft or Escape', async () => {
    const trigger = renderSubmenu();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowRight' });

    const alpha = await screen.findByRole('menuitem', { name: 'Alpha' });
    const submenu = alpha.closest('[role="menu"]');
    expect(submenu).not.toBeNull();
    const beta = within(submenu as HTMLElement).getByRole('menuitem', { name: 'Beta' });
    await waitFor(() => expect(alpha).toHaveFocus());

    fireEvent.keyDown(alpha, { key: 'ArrowDown' });
    expect(beta).toHaveFocus();
    fireEvent.keyDown(beta, { key: 'Home' });
    expect(alpha).toHaveFocus();
    fireEvent.keyDown(alpha, { key: 'End' });
    expect(beta).toHaveFocus();
    fireEvent.keyDown(beta, { key: 'ArrowUp' });
    expect(alpha).toHaveFocus();

    fireEvent.keyDown(alpha, { key: 'ArrowLeft' });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menuitem', { name: 'Alpha' })).not.toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: 'Enter' });
    const reopenedAlpha = await screen.findByRole('menuitem', { name: 'Alpha' });
    await waitFor(() => expect(reopenedAlpha).toHaveFocus());
    fireEvent.keyDown(reopenedAlpha, { key: 'Escape' });

    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByRole('menu')).toHaveLength(1);
  });

  it('keeps keyboard entry available for click-open submenus', async () => {
    const trigger = renderSubmenu(true);
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowRight' });

    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus());
  });

  it('cancels a pending focus handoff when the submenu closes immediately', async () => {
    const trigger = renderSubmenu();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowRight' });
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('menuitem', { name: 'Alpha' })).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
  });
});
