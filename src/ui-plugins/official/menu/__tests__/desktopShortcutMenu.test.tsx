import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ launch: vi.fn((): string | null => 'win') }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('@/utils/settingsApi', () => ({ getSetting: vi.fn(async () => null), saveSetting: vi.fn(async () => undefined) }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/features/workbench/apps/files/desktopDragBridge', () => ({
  launchResourceFromDragData: mocks.launch,
  registerDesktopResourceDropHandler: () => () => undefined,
}));

import { defineUiPlugin, UiKernel, type UiPlugin } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import type { SlotEntry } from '@/ui-kernel/slots';
import { DesktopShortcutsLayer } from '@/features/workbench/components/DesktopShortcuts';
import { useDesktopStore, type DesktopShortcut } from '@/features/learning-hub/stores/desktopStore';
import { installOfficialUiPlugins } from '../../install';
import { memoryRegistryAdapters } from '../../../testing/registries';
import { officialDesktopShortcutMenuEntries } from '../desktopShortcutMenu';

const EXIT_MS = 180;
const CREATED = '2026-01-01T00:00:00.000Z';
const SHORTCUTS: DesktopShortcut[] = [
  { id: 's_note', name: '线代笔记', type: 'resource', target: { resourceId: 'note_1', resourceType: 'note' }, position: 0, createdAt: CREATED },
  { id: 's_folder', name: '资料夹', type: 'folder', target: { folderId: 'folder_1' }, position: 1, createdAt: CREATED },
];

let kernel: UiKernel | undefined;
afterEach(async () => {
  cleanup();
  useDesktopStore.setState({ shortcuts: [] });
  mocks.launch.mockClear();
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

async function wait(ms: number) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

function renderLayer(k: UiKernel) {
  useDesktopStore.setState({ shortcuts: SHORTCUTS.map((shortcut) => ({ ...shortcut, target: { ...shortcut.target } })) });
  render(<UiKernelProvider kernel={k}><DesktopShortcutsLayer /></UiKernelProvider>);
}

async function openMenu(id: string) {
  fireEvent.contextMenu(document.querySelector(`[data-wb-desk-shortcut="${id}"]`)!, { clientX: 120, clientY: 140 });
  await wait(0);
}

const describeEntries = (entries: readonly SlotEntry<unknown>[]) => entries.map(({ id, order, owner, origin }) => ({ id, order, owner, origin }));
const menu = () => document.querySelector<HTMLElement>('.wb-desk-menu');
const rows = () => Array.from(menu()!.querySelectorAll('[role^="menuitem"], [role="separator"]'))
  .map((node) => (node.getAttribute('role') === 'separator' ? '---' : (node as HTMLElement).dataset.testid ?? node.querySelector('.wb-desk-menu-item-label')?.textContent));
const shortcutIds = () => useDesktopStore.getState().shortcuts.map((shortcut) => shortcut.id);
const menuOpenIcons = () => Array.from(document.querySelectorAll<HTMLElement>('[data-wb-desk-shortcut][data-menu-open]')).map((node) => node.dataset.wbDeskShortcut);

describe('app.menu: desktop shortcut icon menu (FE-B9)', () => {
  it('holds the official shortcut rows, owned by dstu.ui.menu, once the menus are loaded', async () => {
    const k = await boot();
    const entries = k.slots.list('app.menu').filter((entry) => entry.value.menu === 'workbench.desktopShortcut');
    expect(describeEntries(entries)).toEqual(describeEntries(officialDesktopShortcutMenuEntries));
    expect(officialDesktopShortcutMenuEntries.map((entry) => entry.id)).toEqual(['desktopShortcut:open', 'desktopShortcut:manage']);
    expect(officialDesktopShortcutMenuEntries.every((entry) => entry.owner === 'dstu.ui.menu' && entry.origin === 'builtin')).toBe(true);
  });

  it('places community rows by order with the shortcut on the context, per shortcut kind; rows that close themselves act after; unload removes them', async () => {
    const k = await boot();
    const reveal = vi.fn();
    const seen: unknown[] = [];
    await install(k, defineUiPlugin({ meta: { id: 'example.shortcut-menu' }, apply(ctx) {
      ctx.ui.contribute('app.menu', { id: 'shortcut-extra', order: 15, value: { menu: 'workbench.desktopShortcut', items: ({ shortcutId, shortcutType, name, target, closeMenu, remove }) => {
        seen.push({ shortcutId, shortcutType, name, target });
        if (shortcutType !== 'resource') return [];
        return [
          { id: 'reveal', label: 'Reveal', testId: 'example-reveal', run: () => reveal(target.resourceId) },
          { id: 'drop', label: 'Drop', testId: 'example-drop', closeOnRun: false, run: () => { closeMenu(); remove(); } },
        ];
      } } });
    } }));
    renderLayer(k);

    await openMenu('s_note');
    expect(seen.at(-1)).toEqual({ shortcutId: 's_note', shortcutType: 'resource', name: '线代笔记', target: { resourceId: 'note_1', resourceType: 'note' } });
    expect(rows()).toEqual(['打开', 'example-reveal', 'example-drop', '---', '重命名', '从桌面移除']);
    fireEvent.click(screen.getByTestId('example-reveal'));
    expect(reveal).toHaveBeenCalledWith('note_1');
    expect(menu()?.dataset.phase).toBe('closing');
    await wait(EXIT_MS + 40);
    expect(menu()).toBeNull();

    await openMenu('s_folder');
    expect(seen.at(-1)).toEqual({ shortcutId: 's_folder', shortcutType: 'folder', name: '资料夹', target: { folderId: 'folder_1' } });
    expect(rows()).toEqual(['打开', '---', '重命名', '从桌面移除']);
    fireEvent.keyDown(document, { key: 'Escape' });
    await wait(EXIT_MS + 40);

    await openMenu('s_note');
    fireEvent.click(screen.getByTestId('example-drop'));
    expect(menu()?.dataset.phase).toBe('closing');
    expect(shortcutIds()).toEqual(['s_folder']);
    await wait(EXIT_MS + 40);
    expect(menu()).toBeNull();

    await act(async () => { await k.unload('example.shortcut-menu'); });
    cleanup();
    renderLayer(k);
    const calls = seen.length;
    await openMenu('s_note');
    expect(rows()).toEqual(['打开', '---', '重命名', '从桌面移除']);
    expect(seen).toHaveLength(calls);
    fireEvent.click(screen.getByText('打开'));
    expect(mocks.launch).toHaveBeenCalledWith({ resourceId: 'note_1', resourceType: 'note', title: '线代笔记' });
  });

  it('a community row that closes the menu itself and keeps the default close does not cut short the next menu', async () => {
    const k = await boot();
    await install(k, defineUiPlugin({ meta: { id: 'example.shortcut-close-twice' }, apply(ctx) {
      ctx.ui.contribute('app.menu', { id: 'shortcut-twice', order: 30, value: { menu: 'workbench.desktopShortcut', items: ({ closeMenu }) => [
        { id: 'twice', label: 'Twice', testId: 'example-twice', run: () => closeMenu() },
      ] } });
    } }));
    renderLayer(k);

    await openMenu('s_note');
    fireEvent.click(screen.getByTestId('example-twice'));
    expect(menu()?.dataset.phase).toBe('closing');
    await openMenu('s_folder');
    expect(menu()?.dataset.phase).toBe('open');
    await wait(EXIT_MS + 40);
    expect(menu()?.dataset.phase).toBe('open');
    expect(menuOpenIcons()).toEqual(['s_folder']);
  });

  it('skips community rows that throw and reports throwing runs; the official rows stay', async () => {
    const k = await boot();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await install(k, defineUiPlugin({ meta: { id: 'example.broken-shortcut-rows' }, apply(ctx) {
      ctx.ui.contribute('app.menu', { id: 'shortcut-broken', order: 15, value: { menu: 'workbench.desktopShortcut', items: () => { throw new Error('rows'); } } });
    } }));
    await install(k, defineUiPlugin({ meta: { id: 'example.broken-shortcut-run' }, apply(ctx) {
      ctx.ui.contribute('app.menu', { id: 'shortcut-throws', order: 30, value: { menu: 'workbench.desktopShortcut', items: () => [
        { id: 'throws', label: 'throws', testId: 'example-shortcut-throws', run: () => { throw new Error('run'); } },
      ] } });
    } }));
    renderLayer(k);

    await openMenu('s_note');
    expect(rows()).toEqual(['打开', '---', '重命名', '从桌面移除', 'example-shortcut-throws']);
    expect(k.errors.list('example.broken-shortcut-rows').map((report) => [report.entryId, report.phase])).toContainEqual(['shortcut-broken', 'render']);
    fireEvent.click(screen.getByTestId('example-shortcut-throws'));
    expect(k.errors.list('example.broken-shortcut-run').map((report) => [report.entryId, report.phase])).toEqual([['shortcut-throws', 'report']]);
    expect(menu()?.dataset.phase).toBe('closing');
    await wait(EXIT_MS + 40);

    await openMenu('s_note');
    fireEvent.click(screen.getByText('重命名'));
    await wait(0);
    expect(document.querySelector<HTMLInputElement>('[data-wb-desk-shortcut="s_note"] .wb-desk-icon__input')?.value).toBe('线代笔记');
    error.mockRestore();
  });
});
