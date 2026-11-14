/**
 * FE-B9 evidence: the study-desktop (workbench) menus inside the app's UI kernel, with the real app registry.
 * `workbench-menus.json`: desktop right-click menu (with its submenus), Dock item menus, the menu-bar
 * app / window menus and the brand menu; rows in order with label, test id, shortcut, disabled, checked,
 * danger and submenu, in two window states (empty desktop; a focused notes window plus a minimized chat window).
 */
import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootAppUi, expectGolden, type AppUi } from './harness';

vi.mock('react-i18next', () => import('./i18nMock'));

interface Row { label: string; testId: string | null; shortcut: string | null; disabled: boolean; checked: string | null; danger: boolean; submenu: boolean }

function readRows(menu: Element): (Row | '—')[] {
  return Array.from(menu.querySelectorAll(':scope [role=menuitem], :scope [role=menuitemcheckbox], :scope [role=menuitemradio], :scope [role=separator]'))
    .filter((row) => row.closest('[role=menu]') === menu)
    .map((row) => {
      if (row.getAttribute('role') === 'separator') return '—';
      const button = row as HTMLButtonElement;
      const shortcut = row.querySelector('[class*="shortcut"], kbd');
      const label = row.querySelector('[class*="label"]')?.textContent ?? button.textContent ?? '';
      return {
        label: label.replace(/\s+/g, ' ').trim(),
        testId: row.getAttribute('data-testid'),
        shortcut: shortcut?.textContent?.trim() || row.getAttribute('aria-keyshortcuts'),
        disabled: button.disabled || row.getAttribute('aria-disabled') === 'true',
        checked: row.getAttribute('aria-checked'),
        danger: /danger|destructive/.test(button.className),
        submenu: row.getAttribute('aria-haspopup') === 'menu',
      };
    });
}

async function flush(rounds = 6) {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

/** Rows of every open menu, plus each submenu reached by hovering its parent row. */
async function readOpenMenus(): Promise<Record<string, unknown>> {
  const menus = Array.from(document.querySelectorAll('[role=menu]'));
  const out: Record<string, unknown> = {};
  for (const [index, menu] of menus.entries()) {
    const label = menu.getAttribute('aria-label') ?? menu.getAttribute('data-testid') ?? `menu${index}`;
    const rows = readRows(menu);
    const submenus: Record<string, unknown> = {};
    for (const row of Array.from(menu.querySelectorAll<HTMLElement>('[aria-haspopup=menu]')).filter((node) => node.closest('[role=menu]') === menu)) {
      const before = new Set(document.querySelectorAll('[role=menu]'));
      fireEvent.pointerEnter(row);
      fireEvent.mouseEnter(row);
      await flush();
      let opened = Array.from(document.querySelectorAll('[role=menu]')).filter((node) => !before.has(node));
      if (!opened.length) {
        fireEvent.click(row);
        await flush();
        opened = Array.from(document.querySelectorAll('[role=menu]')).filter((node) => !before.has(node));
      }
      submenus[row.textContent?.replace(/\s+/g, ' ').trim() ?? ''] = opened.map((node) => readRows(node));
    }
    out[label] = Object.keys(submenus).length ? { rows, submenus } : { rows };
  }
  return out;
}

let app: AppUi;

describe('FE-B9 evidence: workbench menus', () => {
  beforeAll(async () => {
    localStorage.clear();
    app = await bootAppUi();
    await import('@/features/workbench/apps/registerAll');
  });
  afterEach(() => { cleanup(); });
  afterAll(async () => { await app.dispose(); });

  it('keeps every workbench menu the same', async () => {
    const [{ useWindowStore }, { DesktopContextMenu }, { DockContextMenu }, { StatusBarAppMenus }, { StatusBarBrandMenu }, { appRegistry }] = await Promise.all([
      import('@/features/workbench/core/windowStore'),
      import('@/features/workbench/components/DesktopContextMenu'),
      import('@/features/workbench/components/DockContextMenu'),
      import('@/features/workbench/components/StatusBarAppMenus'),
      import('@/features/workbench/components/StatusBarBrandMenu'),
      import('@/features/workbench/core/appRegistry'),
    ]);
    const initial = useWindowStore.getState();
    const states: Record<string, () => void> = {
      empty: () => useWindowStore.setState(initial, true),
      windows: () => {
        useWindowStore.setState(initial, true);
        const store = useWindowStore.getState();
        const chat = store.openWindow({ typeId: 'chat', reason: 'api' } as Parameters<typeof store.openWindow>[0]);
        store.openWindow({ typeId: 'notes', reason: 'api' } as Parameters<typeof store.openWindow>[0]);
        useWindowStore.getState().minimizeWindow(chat, true);
      },
    };
    const evidence: Record<string, unknown> = {
      registry: appRegistry.list().map((def: { typeId: string; instanceMode?: string }) => `${def.typeId}:${def.instanceMode ?? ''}`),
    };
    for (const [stateName, apply] of Object.entries(states)) {
      apply();
      const result: Record<string, unknown> = {};

      let view = render(app.wrap(
        <DesktopContextMenu anchor={{ x: 200, y: 160 }} wallpaper={{ kind: 'theme', value: 'default' }} onClose={() => {}} onShowDesktop={() => {}} />,
      ));
      await flush();
      result.desktop = await readOpenMenus();
      view.unmount();

      const dock: Record<string, unknown> = {};
      for (const typeId of ['chat', 'notes', 'files', 'settings']) {
        view = render(app.wrap(<DockContextMenu typeId={typeId}><button type="button" data-evidence="dock-item">{typeId}</button></DockContextMenu>));
        fireEvent.contextMenu(view.container.querySelector('[data-evidence=dock-item]')!);
        await flush();
        dock[typeId] = await readOpenMenus();
        view.unmount();
        cleanup();
      }
      result.dock = dock;

      view = render(app.wrap(<StatusBarAppMenus />));
      const menubar: Record<string, unknown> = {
        buttons: Array.from(view.container.querySelectorAll('button')).map((button) => button.getAttribute('aria-label') ?? button.textContent),
      };
      for (const testId of ['wb-menubar-appmenu', 'wb-menubar-windowmenu']) {
        fireEvent.click(view.container.querySelector(`[data-testid=${testId}]`)!);
        await flush();
        menubar[testId] = await readOpenMenus();
        fireEvent.click(view.container.querySelector(`[data-testid=${testId}]`)!);
        await flush();
      }
      result.menubar = menubar;
      view.unmount();

      const anchor = document.createElement('button');
      document.body.append(anchor);
      view = render(app.wrap(<StatusBarBrandMenu open anchorRef={{ current: anchor }} onClose={() => {}} />));
      await flush();
      result.brand = await readOpenMenus();
      view.unmount();
      anchor.remove();
      cleanup();

      // Window ids are random per open; name them by app.
      let text = JSON.stringify(result);
      for (const win of Object.values(useWindowStore.getState().windows)) text = text.split(win.id).join(`win:${win.typeId}`);
      evidence[stateName] = JSON.parse(text);
    }
    useWindowStore.setState(initial, true);

    // The Dock starts with DEFAULT_DOCK_PINNED (WorkbenchDesktop applies it on snapshot restore); the states
    // above have no pins, so their Dock menus all offer 固定到 Dock.
    const [{ setDockPinned, getDockPinned }, { DEFAULT_DOCK_PINNED }] = await Promise.all([
      import('@/features/workbench/components/DockPinnedStore'),
      import('@/features/workbench/apps/registerAll'),
    ]);
    const pinsBefore = getDockPinned();
    setDockPinned([...DEFAULT_DOCK_PINNED]);
    const pinnedDock: Record<string, unknown> = { pinned: [...DEFAULT_DOCK_PINNED] };
    for (const typeId of ['chat', 'notes', 'files', 'settings', 'todo']) {
      const view = render(app.wrap(<DockContextMenu typeId={typeId}><button type="button" data-evidence="dock-item">{typeId}</button></DockContextMenu>));
      fireEvent.contextMenu(view.container.querySelector('[data-evidence=dock-item]')!);
      await flush();
      pinnedDock[typeId] = await readOpenMenus();
      view.unmount();
      cleanup();
    }
    setDockPinned(pinsBefore);
    evidence.dockWithDefaultPins = pinnedDock;

    expect(Object.keys((evidence.empty as Record<string, unknown>).desktop as object).length).toBeGreaterThan(0);
    expectGolden('workbench-menus.json', evidence);
  }, 120_000);
});
