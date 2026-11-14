/**
 * FE-B9 evidence: the desktop shortcut icon's right-click menu before its rows move to `app.menu`.
 *
 * Per shortcut kind (resource, resource without a type, folder, quick access, app, textbook app): the icon and the
 * menu DOM, the rows, and for every row what clicking it does (workbench / drag-bridge / notification calls, the
 * store's shortcuts, the rename field), the menu right after the click and once its exit timer ran. Then the ways it
 * closes or moves: Escape (before and after its listeners attach), pointer down outside and inside, right-click on the
 * menu, right-click on another icon and on the same icon while it closes. Labels come from the evidence zh-CN i18n
 * double. Recorded without and with a UI kernel holding the official plugins; both must equal the golden. Captured
 * before the migration; the golden is never rewritten.
 */
import React from 'react';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({ log: [] as unknown[][], found: true }));

vi.mock('react-i18next', () => import('@/ui-plugins/testing/__tests__/evidence/i18nMock'));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (...args: unknown[]) => { effects.log.push(['invoke', ...args]); return null; }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: (...args: unknown[]) => { effects.log.push(['showGlobalNotification', ...args]); },
}));
vi.mock('@/features/workbench/apps/files/desktopDragBridge', () => ({
  launchResourceFromDragData: (data: unknown) => { effects.log.push(['launchResourceFromDragData', data]); return effects.found ? 'win' : null; },
  registerDesktopResourceDropHandler: () => () => undefined,
}));

import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { DesktopShortcutsLayer } from '@/features/workbench/components/DesktopShortcuts';
import { useDesktopStore, type DesktopShortcut } from '@/features/learning-hub/stores/desktopStore';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { installOfficialUiPlugins } from '@/ui-plugins/official/install';
import { memoryRegistryAdapters } from '@/ui-plugins/testing/registries';

const GOLDEN = 'src/ui-plugins/official/menu/__tests__/__golden__/desktop-shortcut-menu.json';
const EXIT_MS = 180;

const restore: Array<() => void> = [];
let kernel: UiKernel | null = null;
const wrap = (node: React.ReactElement) => (kernel ? <UiKernelProvider kernel={kernel}>{node}</UiKernelProvider> : node);

const CREATED = '2026-01-01T00:00:00.000Z';
const SHORTCUTS: DesktopShortcut[] = [
  { id: 's_note', name: '线代笔记', type: 'resource', target: { resourceId: 'note_1', resourceType: 'note' }, position: 0, createdAt: CREATED },
  { id: 's_untyped', name: '无类型资源', type: 'resource', target: { resourceId: 'res_2' }, position: 1, createdAt: CREATED },
  { id: 's_folder', name: '资料夹', type: 'folder', target: { folderId: 'folder_1' }, position: 2, createdAt: CREATED },
  { id: 's_quick', name: '收藏', type: 'quickAccess', target: { quickAccessType: 'favorites' }, position: 3, createdAt: CREATED },
  { id: 's_exam', name: '题目集', type: 'app', target: { appType: 'exam', action: 'list' }, position: 4, createdAt: CREATED },
  { id: 's_textbook', name: '教材', type: 'app', target: { appType: 'textbook', action: 'list' }, position: 5, createdAt: CREATED },
];

async function flush(rounds = 4) {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function wait(ms: number) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

beforeAll(() => {
  workbenchBus.setEnabled(true);
  const launch = vi.spyOn(workbenchBus, 'launch').mockImplementation((request) => {
    effects.log.push(['workbenchBus.launch', request]);
    return null;
  });
  const activate = vi.spyOn(workbenchBus, 'activate').mockImplementation(async (request) => {
    effects.log.push(['workbenchBus.activate', request]);
    return true;
  });
  restore.push(() => { launch.mockRestore(); activate.mockRestore(); });
});
afterEach(() => {
  cleanup();
  useDesktopStore.setState({ shortcuts: [] });
  effects.log = [];
  effects.found = true;
});
afterAll(() => {
  for (const undo of restore.reverse()) undo();
  workbenchBus.setEnabled(false);
});

function renderLayer() {
  useDesktopStore.setState({ shortcuts: SHORTCUTS.map((shortcut) => ({ ...shortcut, target: { ...shortcut.target } })) });
  return render(wrap(<DesktopShortcutsLayer />));
}

const icon = (id: string) => document.querySelector<HTMLElement>(`[data-wb-desk-shortcut="${id}"]`)!;
const menu = () => document.querySelector<HTMLElement>('.wb-desk-menu');
const menuItems = () => Array.from(menu()?.querySelectorAll<HTMLButtonElement>('button') ?? []);

function describeRows(panel: Element) {
  return Array.from(panel.querySelectorAll('[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="separator"]')).map((node) => {
    if (node.getAttribute('role') === 'separator') return { separator: true, className: node.className };
    const button = node as HTMLButtonElement;
    return {
      role: button.getAttribute('role'),
      label: button.querySelector('.wb-desk-menu-item-label')?.textContent ?? '',
      className: button.className,
      ...(button.dataset.testid ? { testId: button.dataset.testid } : {}),
      ...(button.disabled ? { disabled: true } : {}),
    };
  });
}

function menuState() {
  const panel = menu();
  return panel ? { phase: panel.dataset.phase, style: panel.getAttribute('style') } : null;
}

function layerState() {
  const ids = useDesktopStore.getState().shortcuts.map((shortcut) => `${shortcut.id}:${shortcut.name}`);
  const input = document.querySelector<HTMLInputElement>('.wb-desk-icon__input');
  const open = Array.from(document.querySelectorAll<HTMLElement>('[data-wb-desk-shortcut][data-menu-open]')).map((node) => node.dataset.wbDeskShortcut);
  return {
    shortcuts: ids,
    menuOpenIcons: open,
    renaming: input ? { shortcut: input.closest<HTMLElement>('[data-wb-desk-shortcut]')?.dataset.wbDeskShortcut, value: input.value, focused: document.activeElement === input } : null,
  };
}

async function openMenu(id: string) {
  fireEvent.contextMenu(icon(id), { clientX: 120, clientY: 140 });
  await flush();
}

async function recordShortcut(shortcut: DesktopShortcut) {
  renderLayer();
  await openMenu(shortcut.id);
  const result: Record<string, unknown> = {
    icon: icon(shortcut.id).outerHTML,
    menu: { html: menu()!.outerHTML, rows: describeRows(menu()!) },
  };
  const labels = menuItems().map((item) => item.querySelector('.wb-desk-menu-item-label')?.textContent ?? '');
  const clicks: Record<string, unknown> = {};
  for (const [index, label] of labels.entries()) {
    cleanup();
    renderLayer();
    await openMenu(shortcut.id);
    effects.log = [];
    fireEvent.click(menuItems()[index]);
    const sync = [...effects.log];
    await flush();
    const afterClick = { menu: menuState(), ...layerState() };
    await wait(EXIT_MS + 40);
    clicks[`${index}:${label}`] = { effects: effects.log, syncEffects: sync.length, afterClick, afterExit: { menu: menuState(), ...layerState() } };
  }
  result.clicks = clicks;
  cleanup();
  return result;
}

async function recordNotFound() {
  effects.found = false;
  renderLayer();
  await openMenu('s_note');
  effects.log = [];
  fireEvent.click(menuItems()[0]);
  await flush();
  const result = effects.log;
  cleanup();
  effects.found = true;
  return result;
}

async function recordDismissal() {
  const steps: unknown[] = [];
  const step = (name: string) => steps.push([name, menuState(), layerState().menuOpenIcons]);

  renderLayer();
  fireEvent.contextMenu(icon('s_folder'), { clientX: 2000, clientY: 2000 });
  fireEvent.keyDown(document, { key: 'Escape' });
  step('escape before listeners attach');
  await flush();
  step('after flush');
  fireEvent.keyDown(document, { key: 'Enter' });
  step('other key');
  fireEvent.mouseDown(menuItems()[0]);
  step('pointer down inside');
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  menu()!.dispatchEvent(event);
  steps.push(['contextmenu on menu', event.defaultPrevented]);
  fireEvent.contextMenu(icon('s_exam'), { clientX: 300, clientY: 20 });
  await flush();
  step('right-click another icon');
  fireEvent.keyDown(document, { key: 'Escape' });
  step('escape');
  fireEvent.contextMenu(icon('s_exam'), { clientX: 310, clientY: 30 });
  step('right-click same icon while closing');
  await wait(EXIT_MS + 40);
  step('after exit time');
  fireEvent.mouseDown(document.body);
  step('pointer down outside');
  await wait(EXIT_MS + 40);
  step('after exit time');
  cleanup();
  return steps;
}

async function recordAll() {
  const shortcuts: Record<string, unknown> = {};
  for (const shortcut of SHORTCUTS) shortcuts[shortcut.id] = await recordShortcut(shortcut);
  return { shortcuts, notFound: await recordNotFound(), dismissal: await recordDismissal() };
}

it('records the desktop shortcut icon menu for every shortcut kind, without and with a UI kernel', async () => {
  const result = await recordAll();
  kernel = new UiKernel(memoryRegistryAdapters());
  await installOfficialUiPlugins(kernel);
  try {
    expect(kernel.list()).toContain('dstu.ui.menu');
    const withKernel = await recordAll();
    if (process.env.FE_B9_CAPTURE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    expect(withKernel).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  } finally {
    await kernel.dispose();
    kernel = null;
  }
  expect(result).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
}, 120_000);
