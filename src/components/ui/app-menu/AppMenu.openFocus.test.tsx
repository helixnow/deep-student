import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppMenu,
  AppMenuContent,
  AppMenuItem,
  AppMenuSub,
  AppMenuSubContent,
  AppMenuSubTrigger,
  AppMenuTrigger,
} from './AppMenu';

/**
 * The root menu's open focus waits for its enter transition (two animation frames). Frames are held here and
 * released on demand, so the order of "focus moved into the menu" and "transition finished" is fixed.
 */
let frames: FrameRequestCallback[] = [];

async function releaseFrames() {
  for (let round = 0; round < 5 && frames.length; round++) {
    const due = frames;
    frames = [];
    await act(async () => { for (const callback of due) callback(performance.now()); });
  }
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 10)); });
}

beforeEach(() => {
  frames = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback));
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function Menu({ children }: { children?: React.ReactNode }) {
  return (
    <>
      <AppMenu open>
        <AppMenuTrigger asChild>
          <button type="button">Root trigger</button>
        </AppMenuTrigger>
        <AppMenuContent>
          <AppMenuItem>Before</AppMenuItem>
          <AppMenuSub>
            <AppMenuSubTrigger>More</AppMenuSubTrigger>
            <AppMenuSubContent>
              <AppMenuItem>Alpha</AppMenuItem>
              <AppMenuItem>Beta</AppMenuItem>
            </AppMenuSubContent>
          </AppMenuSub>
        </AppMenuContent>
      </AppMenu>
      {children}
    </>
  );
}

const rootMenu = () => screen.getAllByRole('menu').find((menu) => !menu.hasAttribute('data-app-menu-sub-content'))!;

describe('AppMenu open focus', () => {
  it('RF-W18-app-menu-open-focus-race: a submenu item focused before the enter transition ends keeps focus', async () => {
    render(<Menu />);
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'More' }), { key: 'ArrowRight' });
    const alpha = await screen.findByRole('menuitem', { name: 'Alpha' });
    await waitFor(() => expect(alpha).toHaveFocus());
    const beta = screen.getByRole('menuitem', { name: 'Beta' });
    beta.focus();
    expect(frames.length).toBeGreaterThan(0);

    await releaseFrames();

    expect(rootMenu()).toHaveClass('app-menu-open');
    expect(beta).toHaveFocus();
  });

  it('a root item focused before the enter transition ends keeps focus', async () => {
    render(<Menu />);
    const before = screen.getByRole('menuitem', { name: 'Before' });
    before.focus();

    await releaseFrames();

    expect(rootMenu()).toHaveClass('app-menu-open');
    expect(before).toHaveFocus();
  });

  it('focus outside the menu still moves to the menu container once the transition ends', async () => {
    render(<Menu><button type="button">Elsewhere</button></Menu>);
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 10)); });
    expect(elsewhere).toHaveFocus();

    await releaseFrames();

    expect(rootMenu()).toHaveFocus();
  });

  it("another menu's item does not count as focus inside this menu", async () => {
    render(
      <Menu>
        <AppMenu open>
          <AppMenuTrigger asChild>
            <button type="button">Other trigger</button>
          </AppMenuTrigger>
          <AppMenuContent aria-label="Other menu">
            <AppMenuItem>Other item</AppMenuItem>
          </AppMenuContent>
        </AppMenu>
      </Menu>,
    );
    screen.getByRole('menuitem', { name: 'Other item' }).focus();

    await releaseFrames();

    const ownMenu = screen.getAllByRole('menu').find((menu) => menu.getAttribute('aria-label') !== 'Other menu' && !menu.hasAttribute('data-app-menu-sub-content'));
    expect([ownMenu, screen.getByRole('menu', { name: 'Other menu' })]).toContain(document.activeElement);
  });
});
