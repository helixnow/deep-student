import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('@/utils/settingsApi', () => ({ getSetting: vi.fn(async () => null), saveSetting: vi.fn(async () => undefined) }));

import { defineUiPlugin, UiKernel, type UiPlugin } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import type { SlotEntry } from '@/ui-kernel/slots';
import { DockContextMenu } from '@/features/workbench/components/DockContextMenu';
import { DesktopContextMenu } from '@/features/workbench/components/DesktopContextMenu';
import { resetWindowStoreForTests, useWindowStore } from '@/features/workbench/core/windowStore';
import { installOfficialUiPlugins } from '../../install';
import { memoryRegistryAdapters } from '../../../testing/registries';
import { officialDockMenuEntries } from '../dockMenu';
import { officialDesktopMenuEntries } from '../desktopMenu';
import type { AppMenuDock } from '../appMenu';

const TYPE_ID = 'example-dock-app';

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

const describeEntries = (entries: readonly SlotEntry<unknown>[]) => entries.map(({ id, order, owner, origin }) => ({ id, order, owner, origin }));

function openDock(k: UiKernel) {
  render(<UiKernelProvider kernel={k}><DockContextMenu typeId={TYPE_ID}><button type="button">dock item</button></DockContextMenu></UiKernelProvider>);
  const trigger = screen.getByText('dock item');
  fireEvent.contextMenu(trigger);
  return trigger;
}

const dockPanel = () => screen.getByTestId('wb-dock-context-menu');
const dockRows = () => Array.from(dockPanel().querySelectorAll('[role^="menuitem"], [role="separator"]'))
  .map((node) => (node.getAttribute('role') === 'separator' ? '---' : (node as HTMLElement).dataset.testid ?? node.textContent));

async function openDesktop(k: UiKernel, onClose = vi.fn()) {
  render(
    <UiKernelProvider kernel={k}>
      <DesktopContextMenu anchor={{ x: 20, y: 20 }} wallpaper={{ kind: 'theme', value: 'aurora' }} onClose={onClose} onShowDesktop={vi.fn()} />
    </UiKernelProvider>,
  );
  await waitFor(() => expect(document.querySelector('[data-wb-desk-menu]')).not.toBeNull());
  await act(async () => {});
  return onClose;
}

const deskPanel = () => document.querySelector<HTMLElement>('[data-wb-desk-menu]')!;
const deskSubPanel = () => document.querySelector<HTMLElement>('.wb-desk-menu-sub');
const deskLabels = (scope: HTMLElement) => Array.from(scope.querySelectorAll('button[data-wb-desk-item], [role="separator"]'))
  .map((node) => (node.getAttribute('role') === 'separator' ? '---' : node.querySelector('.wb-desk-menu-item-label')?.textContent));

describe('app.menu: Dock item and desktop right-click menus (FE-B9)', () => {
  it('holds the official Dock and desktop rows, owned by dstu.ui.menu, once the menus are loaded', async () => {
    const k = await boot();
    const of = (menu: string) => describeEntries(k.slots.list('app.menu').filter((entry) => entry.value.menu === menu));
    expect(of('workbench.dock')).toEqual(describeEntries(officialDockMenuEntries));
    expect(of('workbench.desktop')).toEqual(describeEntries(officialDesktopMenuEntries));
    expect(officialDockMenuEntries.map((entry) => entry.id)).toEqual(['dock:open', 'dock:windows', 'dock:pin']);
    expect(officialDesktopMenuEntries.map((entry) => entry.id)).toEqual(['desktop:launch', 'desktop:layout', 'desktop:appearance', 'desktop:help']);
    expect([...officialDockMenuEntries, ...officialDesktopMenuEntries].every((entry) => entry.owner === 'dstu.ui.menu' && entry.origin === 'builtin')).toBe(true);
  });

  it('places a community Dock row group by order: titled group, tag suffix, radio, submenu shown in place; unload removes it', async () => {
    const k = await boot();
    const tagged = vi.fn();
    const pick = vi.fn();
    const nested = vi.fn();
    const seen: Omit<AppMenuDock, 'instanceMode'>[] = [];
    await install(k, defineUiPlugin({ meta: { id: 'example.dock-menu' }, apply(ctx) {
      ctx.ui.contribute('app.menu', { id: 'dock-extra', order: 25, value: { menu: 'workbench.dock', items: ({ typeId, appLabel, windows, foregroundWindowId, pinned }) => {
        seen.push({ typeId, appLabel, windows, foregroundWindowId, pinned });
        return [
          { kind: 'separator', id: 'extra', label: 'Example' },
          { id: 'tagged', label: 'Tagged', suffix: 'beta', testId: 'example-tagged', run: tagged },
          { id: 'pick', label: 'Pick', radio: true, checked: true, testId: 'example-pick', run: pick, closeOnRun: false },
          { id: 'more', label: 'More', submenu: [{ id: 'nested', label: 'Nested', testId: 'example-nested', run: nested }] },
        ];
      } } });
    } }));
    let alpha = '';
    let beta = '';
    act(() => {
      alpha = useWindowStore.getState().openWindow({ typeId: TYPE_ID, instanceKey: 'a', title: 'Alpha' });
      beta = useWindowStore.getState().openWindow({ typeId: TYPE_ID, instanceKey: 'b', title: '' });
      useWindowStore.getState().minimizeWindow(beta);
    });

    const trigger = openDock(k);
    expect(seen.at(-1)).toEqual({
      typeId: TYPE_ID,
      appLabel: TYPE_ID,
      windows: [{ id: alpha, label: 'Alpha', minimized: false }, { id: beta, label: TYPE_ID, minimized: true }],
      foregroundWindowId: alpha,
      pinned: false,
    });
    expect(dockRows()).toHaveLength(11);
    expect(dockRows().slice(4, 8)).toEqual(['---', 'example-tagged', 'example-pick', 'example-nested']);
    expect(Array.from(dockPanel().querySelectorAll('.app-menu-group-label')).map((node) => node.textContent).at(-1)).toBe('Example');
    const taggedRow = screen.getByTestId('example-tagged');
    expect(taggedRow.querySelector('.app-menu-item-content .truncate')?.textContent).toBe('Tagged');
    expect(taggedRow.querySelector('.app-menu-item-suffix .wb-dockmenu-min-tag')?.textContent).toBe('beta');
    const pickRow = screen.getByTestId('example-pick');
    expect(pickRow.getAttribute('role')).toBe('menuitemradio');
    expect(pickRow.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText('More')).toBeNull();

    fireEvent.click(pickRow);
    expect(pick).toHaveBeenCalledTimes(1);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByTestId('example-nested'));
    expect(nested).toHaveBeenCalledTimes(1);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    await act(async () => { await k.unload('example.dock-menu'); });
    cleanup();
    openDock(k);
    expect(screen.queryByTestId('example-tagged')).toBeNull();
    expect(dockRows()).toHaveLength(7);
  });

  it('places community desktop rows by order; a submenu opens by pointer, click and arrow keys, even when its id repeats an official one', async () => {
    const k = await boot();
    const byName = vi.fn();
    const other = vi.fn();
    const note = vi.fn();
    await install(k, defineUiPlugin({ meta: { id: 'example.desktop-menu' }, apply(ctx) {
      ctx.ui.contribute('app.menu', { id: 'desktop-extra', order: 35, value: { menu: 'workbench.desktop', items: ({ widgetsVisible }) => [
        { kind: 'separator', id: 'extra' },
        { id: 'sort', label: 'Sort', testId: 'example-sort', submenu: [
          { id: 'by-name', label: 'By name', radio: true, checked: widgetsVisible, run: byName },
          { id: 'by-date', label: 'By date', radio: true, checked: false, disabled: true },
        ] },
        { id: 'wallpaper', label: 'Other wallpaper', testId: 'example-wallpaper', submenu: [{ id: 'other', label: 'Other', testId: 'example-other', run: other }] },
        { id: 'note', label: 'Note', suffix: 'new', testId: 'example-note', run: note },
      ] } });
    } }));
    const onClose = await openDesktop(k);

    const labels = deskLabels(deskPanel());
    expect(labels).toHaveLength(20);
    expect(labels.slice(12, 17)).toEqual(['---', 'Sort', 'Other wallpaper', 'Note · new', '---']);
    const sort = screen.getByTestId('example-sort');
    expect(sort.parentElement?.className).toBe('wb-desk-menu-subwrap');
    expect(sort.dataset.wbDeskSub).toBe('sort');
    expect(sort.getAttribute('aria-haspopup')).toBe('menu');

    fireEvent.click(sort);
    expect(deskSubPanel()?.getAttribute('aria-label')).toBe('Sort');
    expect(deskLabels(deskSubPanel()!)).toEqual(['By name', 'By date']);
    expect(deskSubPanel()!.querySelector('[data-wb-desk-option="by-name"]')?.getAttribute('aria-checked')).toBe('true');
    expect(sort.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(sort);
    expect(deskSubPanel()).toBeNull();

    const officialWallpaper = Array.from(deskPanel().querySelectorAll<HTMLElement>('[data-wb-desk-sub="wallpaper"]')).find((node) => !node.dataset.testid)!;
    fireEvent.pointerEnter(screen.getByTestId('example-wallpaper'));
    expect(deskSubPanel()?.getAttribute('aria-label')).toBe('Other wallpaper');
    expect(screen.getByTestId('example-wallpaper').getAttribute('aria-expanded')).toBe('true');
    expect(officialWallpaper.getAttribute('aria-expanded')).toBe('false');
    fireEvent.pointerEnter(officialWallpaper);
    expect(deskSubPanel()?.querySelector('[data-wb-desk-option="aurora"]')).not.toBeNull();
    expect(screen.queryByTestId('example-other')).toBeNull();
    fireEvent.pointerEnter(screen.getByTestId('example-note'));
    expect(deskSubPanel()).toBeNull();

    act(() => sort.focus());
    fireEvent.keyDown(sort, { key: 'ArrowRight' });
    await act(async () => {});
    expect(deskSubPanel()?.getAttribute('aria-label')).toBe('Sort');
    expect(document.activeElement?.getAttribute('data-wb-desk-option')).toBe('by-name');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(deskSubPanel()).toBeNull();
    expect(document.activeElement).toBe(sort);

    fireEvent.click(screen.getByTestId('example-note'));
    expect(note).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(sort);
    fireEvent.click(deskSubPanel()!.querySelector('[data-wb-desk-option="by-name"]')!);
    expect(byName).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('skips community Dock and desktop rows that throw and reports throwing runs, submenu rows included; the official rows stay', async () => {
    const k = await boot();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await install(k, defineUiPlugin({ meta: { id: 'example.broken-dock-rows' }, apply(ctx) {
      ctx.ui.contribute('app.menu', { id: 'dock-broken', order: 15, value: { menu: 'workbench.dock', items: () => { throw new Error('rows'); } } });
    } }));
    await install(k, defineUiPlugin({ meta: { id: 'example.broken-desktop-rows' }, apply(ctx) {
      ctx.ui.contribute('app.menu', { id: 'desktop-broken', order: 15, value: { menu: 'workbench.desktop', items: () => { throw new Error('rows'); } } });
    } }));
    await install(k, defineUiPlugin({ meta: { id: 'example.broken-run' }, apply(ctx) {
      ctx.ui.contribute('app.menu', { id: 'dock-throws', order: 40, value: { menu: 'workbench.dock', items: () => [
        { id: 'throws', label: 'throws', testId: 'example-dock-throws', run: () => { throw new Error('run'); } },
      ] } });
      ctx.ui.contribute('app.menu', { id: 'desktop-throws', order: 50, value: { menu: 'workbench.desktop', items: () => [
        { id: 'throws', label: 'throws', testId: 'example-desk-throws', submenu: [
          { id: 'nested', label: 'nested', testId: 'example-desk-nested-throws', run: () => { throw new Error('nested run'); } },
        ] },
      ] } });
    } }));

    const trigger = openDock(k);
    expect(dockRows()).toHaveLength(4);
    expect(dockRows().slice(1)).toEqual(['---', expect.any(String), 'example-dock-throws']);
    expect(k.errors.list('example.broken-dock-rows').map((report) => [report.entryId, report.phase])).toContainEqual(['dock-broken', 'render']);
    fireEvent.click(screen.getByTestId('example-dock-throws'));
    expect(k.errors.list('example.broken-run').map((report) => [report.entryId, report.phase])).toEqual([['dock-throws', 'report']]);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    cleanup();

    const onClose = await openDesktop(k);
    expect(deskLabels(deskPanel())).toHaveLength(17);
    expect(k.errors.list('example.broken-desktop-rows').map((report) => [report.entryId, report.phase])).toContainEqual(['desktop-broken', 'render']);
    fireEvent.click(screen.getByTestId('example-desk-throws'));
    fireEvent.click(screen.getByTestId('example-desk-nested-throws'));
    expect(k.errors.list('example.broken-run').map((report) => [report.entryId, report.phase])).toEqual([
      ['dock-throws', 'report'],
      ['desktop-throws', 'report'],
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
