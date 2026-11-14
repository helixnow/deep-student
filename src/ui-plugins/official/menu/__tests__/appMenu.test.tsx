import React, { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('@/utils/settingsApi', () => ({ getSetting: vi.fn(async () => null), saveSetting: vi.fn(async () => undefined) }));

import { defineUiPlugin, UiKernel, type UiPlugin } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import type { SlotEntry } from '@/ui-kernel/slots';
import { StatusBarBrandMenu } from '@/features/workbench/components/StatusBarBrandMenu';
import { StatusBarAppMenus } from '@/features/workbench/components/StatusBarAppMenus';
import { resetWindowStoreForTests } from '@/features/workbench/core/windowStore';
import { installOfficialUiPlugins } from '../../install';
import { memoryRegistryAdapters } from '../../../testing/registries';
import { officialAppMenuEntries } from '../workbenchMenus';
import { resolveAppMenuRows, type AppMenuContribution, type AppMenuWindow, type AppMenuWorkbench } from '../appMenu';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { useWindowStore } from '@/features/workbench/core/windowStore';

let kernel: UiKernel | undefined;
afterEach(async () => {
  cleanup();
  resetWindowStoreForTests();
  await kernel?.dispose();
  kernel = undefined;
});

async function boot() {
  kernel = new UiKernel(memoryRegistryAdapters());
  await installOfficialUiPlugins(kernel);
  return kernel;
}

async function install(k: UiKernel, plugin: UiPlugin<any>) {
  await act(async () => { await k.install(plugin); });
}

function renderBrand(k: UiKernel) {
  const onClose = vi.fn();
  const anchor = createRef<HTMLButtonElement>();
  render(<UiKernelProvider kernel={k}><button ref={anchor} type="button">brand</button><StatusBarBrandMenu open anchorRef={anchor} onClose={onClose} /></UiKernelProvider>);
  return onClose;
}

const rowIds = () => Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="separator"]'))
  .map((node) => (node.getAttribute('role') === 'separator' ? '---' : (node as HTMLElement).dataset.testid ?? node.textContent));

const describeEntries = (entries: readonly SlotEntry<unknown>[]) => entries.map(({ id, order, owner, origin }) => ({ id, order, owner, origin }));

describe('app.menu (FE-B9)', () => {
  it('holds the official menu bar rows, owned by dstu.ui.menu', async () => {
    const k = await boot();
    const byId = (entries: readonly SlotEntry<unknown>[]) => describeEntries(entries).sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(k.slots.list('app.menu'))).toEqual(byId(officialAppMenuEntries));
    expect(k.slots.list('app.menu').map((entry) => [entry.value.menu, entry.id, entry.order])).toEqual([
      ['workbench.app', 'app:windows', 10],
      ['workbench.brand', 'brand:desktop', 10],
      ['workbench.window', 'window:list', 10],
      ['workbench.brand', 'brand:system', 20],
      ['workbench.window', 'window:tile', 20],
      ['workbench.brand', 'brand:exit', 30],
    ]);
    expect(k.slots.list('app.menu').every((entry) => entry.owner === 'dstu.ui.menu' && entry.origin === 'builtin')).toBe(true);
  });

  it('places a community row by order, runs it and closes the menu unless closeOnRun is false; unload removes it', async () => {
    const k = await boot();
    const run = vi.fn();
    const keep = vi.fn();
    await install(k, defineUiPlugin({ meta: { id: 'example.menu' }, apply(ctx) {
      ctx.ui.contribute('app.menu', { id: 'sync', order: 25, value: { menu: 'workbench.brand', items: ({ t }) => [
        { kind: 'separator', id: 'sync' },
        { id: 'sync-now', label: `sync ${t('menubar.appName')}`, testId: 'example-sync', shortcut: '⌘S', run },
        { id: 'peek', label: 'peek', testId: 'example-peek', run: keep, closeOnRun: false },
      ] } });
    } }));
    const onClose = renderBrand(k);
    expect(rowIds()).toEqual([
      'wb-menubar-brand-rename', '---', 'wb-menubar-brand-apps', 'wb-menubar-brand-shortcuts', 'wb-menubar-brand-settings',
      '---', 'example-sync', 'example-peek', '---', 'wb-menubar-brand-exit',
    ]);
    const sync = screen.getByTestId('example-sync');
    expect(sync.className).toBe('wb-desk-menu-item');
    expect(sync.querySelector('.wb-desk-menu-item-label')?.textContent).toBe('sync 学习桌面');
    expect(sync.querySelector('.wb-desk-menu-item-shortcut')?.textContent).toBe('⌘S');
    fireEvent.click(sync);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('example-peek'));
    expect(keep).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => { await k.unload('example.menu'); });
    expect(screen.queryByTestId('example-sync')).toBeNull();
    expect(rowIds()).toEqual([
      'wb-menubar-brand-rename', '---', 'wb-menubar-brand-apps', 'wb-menubar-brand-shortcuts', 'wb-menubar-brand-settings',
      '---', 'wb-menubar-brand-exit',
    ]);
  });

  it('gives community rows the focused app context', async () => {
    const k = await boot();
    const seen: unknown[] = [];
    await install(k, defineUiPlugin({ meta: { id: 'example.app-menu' }, apply(ctx) {
      ctx.ui.contribute('app.menu', { id: 'about', order: 5, value: { menu: 'workbench.app', items: ({ focusedTypeId, focusedWindowId }) => {
        seen.push({ focusedTypeId, focusedWindowId });
        return [{ id: 'about', label: 'About', testId: 'example-about' }];
      } } });
    } }));
    render(<UiKernelProvider kernel={k}><StatusBarAppMenus /></UiKernelProvider>);
    fireEvent.click(screen.getByTestId('wb-menubar-appmenu'));
    expect(Array.from(screen.getByTestId('wb-menubar-appmenu-panel').querySelectorAll('[role="menuitem"]')).map((node) => (node as HTMLElement).dataset.testid))
      .toEqual(['example-about', 'wb-menubar-app-all-apps']);
    expect(seen.at(-1)).toEqual({ focusedTypeId: null, focusedWindowId: null });
  });

  it('skips a community contribution whose rows throw and reports a throwing run; the official rows stay', async () => {
    const k = await boot();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await install(k, defineUiPlugin({ meta: { id: 'example.broken-rows' }, apply(ctx) {
      ctx.ui.contribute('app.menu', { id: 'broken', order: 15, value: { menu: 'workbench.brand', items: () => { throw new Error('rows'); } } });
    } }));
    await install(k, defineUiPlugin({ meta: { id: 'example.broken-run' }, apply(ctx) {
      ctx.ui.contribute('app.menu', { id: 'throws', order: 40, value: { menu: 'workbench.brand', items: () => [
        { id: 'throws', label: 'throws', testId: 'example-throws', run: () => { throw new Error('run'); } },
      ] } });
    } }));
    const onClose = renderBrand(k);
    expect(rowIds()).toEqual([
      'wb-menubar-brand-rename', '---', 'wb-menubar-brand-apps', 'wb-menubar-brand-shortcuts', 'wb-menubar-brand-settings',
      '---', 'wb-menubar-brand-exit', 'example-throws',
    ]);
    expect(k.errors.list('example.broken-rows')[0]).toMatchObject({ slot: 'app.menu', entryId: 'broken', phase: 'render' });
    fireEvent.click(screen.getByTestId('example-throws'));
    expect(k.errors.list('example.broken-run')[0]).toMatchObject({ slot: 'app.menu', entryId: 'throws', phase: 'report' });
    expect(onClose).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('keys every row uniquely, even when a contribution repeats row ids', () => {
    const entry: SlotEntry<AppMenuContribution> = { id: 'dup', order: 0, owner: 'example.dup', origin: 'community', value: { menu: 'workbench.brand', items: () => [
      { kind: 'separator', id: 'x' }, { id: 'x', label: 'x' }, { id: 'x', label: 'again' },
    ] } };
    const workbench: AppMenuWorkbench = {
      launchApp: vi.fn(), openAppsPanel: vi.fn(), openCheatsheet: vi.fn(), cheatsheetShortcut: undefined, closeWindow: vi.fn(),
      closeAppWindows: vi.fn(), focusWindow: vi.fn(), setDisplayMode: vi.fn(), launchAppFrom: vi.fn(), toggleDockPinned: vi.fn(),
      closeWindowsOfApp: vi.fn(),
    };
    const rows = resolveAppMenuRows([...officialAppMenuEntries, entry], 'workbench.brand', { t: (key: string) => key, workbench, beginRename: () => {} }, vi.fn());
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it('runs community rows through the menu bar workbench actions and lists windows in menu order with labels', async () => {
    const k = await boot();
    const launch = vi.spyOn(workbenchBus, 'launch').mockReturnValue(null);
    const seen: (readonly AppMenuWindow[])[] = [];
    await install(k, defineUiPlugin({ meta: { id: 'example.window-menu' }, apply(ctx) {
      ctx.ui.contribute('app.menu', { id: 'open-notes', order: 30, value: { menu: 'workbench.window', items: ({ windows, workbench }) => {
        seen.push(windows);
        return [{ id: 'open-notes', label: 'notes', testId: 'example-open-notes', run: () => workbench.launchApp('notes') }];
      } } });
    } }));
    act(() => {
      useWindowStore.setState((state) => ({
        windows: {
          a: { id: 'a', typeId: 'unregistered-a', title: 'Alpha', minimized: false, createdAt: 2 } as never,
          b: { id: 'b', typeId: 'unregistered-b', title: '', minimized: true, createdAt: 1 } as never,
        },
        focusStack: [...state.focusStack],
      }));
    });
    render(<UiKernelProvider kernel={k}><StatusBarAppMenus /></UiKernelProvider>);
    fireEvent.click(screen.getByTestId('wb-menubar-windowmenu'));
    expect(seen.at(-1)).toEqual([
      { id: 'b', label: 'unregistered-b · 已最小化', minimized: true },
      { id: 'a', label: 'Alpha', minimized: false },
    ]);
    fireEvent.click(screen.getByTestId('example-open-notes'));
    expect(launch).toHaveBeenCalledWith({ typeId: 'notes', reason: 'api' });
    launch.mockRestore();
  });

  it('removes the official rows with dstu.ui.menu', async () => {
    const k = await boot();
    await k.unload('dstu.ui.menu');
    expect(k.slots.list('app.menu')).toEqual([]);
  });
});
