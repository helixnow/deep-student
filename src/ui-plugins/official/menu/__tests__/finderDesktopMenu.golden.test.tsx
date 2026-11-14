/**
 * FE-B9 evidence: the resource library desktop view's right-click menus (a shortcut card's and the blank area's)
 * before their rows move to `app.menu`.
 *
 * Per shortcut kind (resource, resource without a type, folder, quick access, app, textbook app) and for the blank
 * area (default and configured desktop root): the menu DOM and rows, and for every row what clicking it does (the view's
 * navigation callbacks, the store, the rename field, the add-shortcut dialog, the root folder picker) and the menu
 * after. Touch layout (bottom sheet, the card's "more" button, the add tile), and the ways the menu closes or moves:
 * Escape (before and after its listeners attach), pointer down inside and outside, touch outside, scroll inside and
 * outside, Android back, right-click on the menu, right-click on another card and on the blank area while open.
 * Labels come from the evidence zh-CN i18n double. Recorded without and with a UI kernel holding the official plugins;
 * both must equal the golden. Captured before the migration; the golden is never rewritten.
 */
import React from 'react';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({ log: [] as unknown[][] }));

vi.mock('react-i18next', () => import('@/ui-plugins/testing/__tests__/evidence/i18nMock'));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (...args: unknown[]) => { effects.log.push(['invoke', ...args]); return null; }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('@/features/learning-hub/components/finder/FolderPickerDialog', () => ({
  FolderPickerDialog: ({ open, title, inline }: { open: boolean; title?: string; inline?: boolean }) => (
    open ? <div data-testid="folder-picker" data-inline={String(inline)}>{title}</div> : null
  ),
}));

import { DesktopView } from '@/features/learning-hub/components/finder/DesktopView';
import { useDesktopStore, type DesktopRootConfig, type DesktopShortcut } from '@/features/learning-hub/stores/desktopStore';
import { handleAndroidBack } from '@/app/navigation/androidBackCoordinator';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { installOfficialUiPlugins } from '@/ui-plugins/official/install';
import { memoryRegistryAdapters } from '@/ui-plugins/testing/registries';

const GOLDEN = 'src/ui-plugins/official/menu/__tests__/__golden__/finder-desktop-menu.json';

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
const DEFAULT_ROOT: DesktopRootConfig = { folderId: null, folderName: null, folderPath: null };
const CUSTOM_ROOT: DesktopRootConfig = { folderId: 'folder_9', folderName: '我的桌面', folderPath: '/我的桌面' };

const originalMatchMedia = window.matchMedia;
function setTouch(touch: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: touch && query === '(pointer: coarse)',
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

async function flush(rounds = 4) {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

beforeAll(() => { setTouch(false); });
afterEach(() => {
  cleanup();
  useDesktopStore.setState({ shortcuts: [], desktopRoot: { ...DEFAULT_ROOT } });
  effects.log = [];
  setTouch(false);
});
afterAll(() => { window.matchMedia = originalMatchMedia; });

const props = {
  onNavigateQuickAccess: (type: unknown) => { effects.log.push(['onNavigateQuickAccess', type]); },
  onOpenResource: (id: unknown, type: unknown) => { effects.log.push(['onOpenResource', id, type]); },
  onOpenFolder: (id: unknown) => { effects.log.push(['onOpenFolder', id]); },
  onCreateInDesktopRoot: (type: unknown, root: unknown) => { effects.log.push(['onCreateInDesktopRoot', type, root]); },
};

async function renderView({ touch = false, root = DEFAULT_ROOT }: { touch?: boolean; root?: DesktopRootConfig } = {}) {
  setTouch(touch);
  useDesktopStore.setState({
    shortcuts: SHORTCUTS.map((shortcut) => ({ ...shortcut, target: { ...shortcut.target } })),
    desktopRoot: { ...root },
  });
  render(wrap(<DesktopView {...props} />));
  await flush();
}

const card = (name: string) => document.querySelector<HTMLElement>(`div[role="button"][aria-label="${name}"]`)!;
const blankArea = () => document.querySelector<HTMLElement>('.min-h-full.p-4')!;
const menu = () => document.querySelector<HTMLElement>('.wb-desk-menu');
const menuItems = () => Array.from(menu()?.querySelectorAll<HTMLButtonElement>('button') ?? []);

function describeRows(panel: Element) {
  return Array.from(panel.children).map((node) => {
    if (node.getAttribute('role') === 'separator') return { separator: true, className: node.className };
    if (node.tagName !== 'BUTTON') return { other: node.className, text: node.textContent };
    const button = node as HTMLButtonElement;
    return {
      role: button.getAttribute('role'),
      label: button.querySelector('.wb-desk-menu-item-label')?.textContent ?? '',
      className: button.className,
      ...(button.disabled ? { disabled: true } : {}),
    };
  });
}

function menuState() {
  const panel = menu();
  return panel ? { className: panel.className, style: panel.getAttribute('style'), rows: describeRows(panel) } : null;
}

function viewState() {
  const store = useDesktopStore.getState();
  const input = document.querySelector<HTMLInputElement>('div[role="button"] input');
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  const titleId = dialog?.getAttribute('aria-labelledby');
  const picker = document.querySelector<HTMLElement>('[data-testid="folder-picker"]');
  return {
    shortcuts: store.shortcuts.map((shortcut) => `${shortcut.id}:${shortcut.name}`),
    desktopRoot: store.desktopRoot,
    renaming: input ? { card: input.closest('div[role="button"]')?.getAttribute('aria-label'), value: input.value, focused: document.activeElement === input } : null,
    dialog: dialog ? (titleId ? document.getElementById(titleId)?.textContent : dialog.textContent) ?? null : null,
    folderPicker: picker ? { title: picker.textContent, inline: picker.dataset.inline } : null,
  };
}

type Opener = () => void;
const openShortcut = (name: string): Opener => () => { fireEvent.contextMenu(card(name), { clientX: 120, clientY: 140 }); };
const openBlank: Opener = () => { fireEvent.contextMenu(blankArea(), { clientX: 200, clientY: 260 }); };

async function recordMenu(open: Opener, options: { touch?: boolean; root?: DesktopRootConfig } = {}) {
  await renderView(options);
  open();
  await flush();
  const result: Record<string, unknown> = { html: menu()?.outerHTML ?? null, menu: menuState() };
  const labels = menuItems().map((item) => item.querySelector('.wb-desk-menu-item-label')?.textContent ?? '');
  const clicks: Record<string, unknown> = {};
  for (const [index, label] of labels.entries()) {
    cleanup();
    await renderView(options);
    open();
    await flush();
    effects.log = [];
    fireEvent.click(menuItems()[index]);
    const sync = [...effects.log];
    await flush();
    clicks[`${index}:${label}`] = { effects: effects.log, syncEffects: sync.length, menu: menuState(), view: viewState() };
  }
  result.clicks = clicks;
  cleanup();
  return result;
}

async function recordTouch() {
  await renderView({ touch: true });
  const more = card('线代笔记').querySelector<HTMLElement>('button')!;
  const moreLabel = more.getAttribute('aria-label');
  fireEvent.click(more, { clientX: 300, clientY: 200 });
  await flush();
  const shortcut = { moreLabel, html: menu()?.outerHTML ?? null, menu: menuState(), effects: [...effects.log] };
  fireEvent.click(menuItems()[1]);
  await flush();
  const afterRename = { menu: menuState(), view: viewState() };
  cleanup();

  await renderView({ touch: true, root: CUSTOM_ROOT });
  const addTile = document.querySelector<HTMLElement>('button[aria-haspopup="menu"]')!;
  fireEvent.click(addTile);
  await flush();
  const blank = { tile: addTile.outerHTML, html: menu()?.outerHTML ?? null, menu: menuState() };
  const steps: unknown[] = [];
  fireEvent.touchStart(menuItems()[0]);
  steps.push(['touch inside', menuState() !== null]);
  fireEvent.touchStart(document.body);
  steps.push(['touch outside', menuState() !== null]);
  fireEvent.click(addTile);
  await flush();
  fireEvent.click(menuItems()[0]);
  await flush();
  steps.push(['add shortcut', menuState() !== null, viewState().dialog]);
  cleanup();
  return { shortcut, afterRename, blank, steps };
}

async function recordDismissal() {
  const steps: unknown[] = [];
  const open = () => menuState() !== null;
  const step = (name: string, extra?: unknown) => steps.push(extra === undefined ? [name, open()] : [name, open(), extra]);

  await renderView();
  openShortcut('资料夹')();
  fireEvent.keyDown(document, { key: 'Escape' });
  step('escape before listeners attach');
  await flush();
  step('after flush');
  fireEvent.keyDown(document, { key: 'Enter' });
  step('other key');
  fireEvent.mouseDown(menuItems()[0]);
  step('pointer down inside');
  fireEvent.scroll(menu()!);
  step('scroll inside');
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  menu()!.dispatchEvent(event);
  step('contextmenu on menu', event.defaultPrevented);
  fireEvent.contextMenu(card('题目集'), { clientX: 300, clientY: 20 });
  await flush();
  step('right-click another card', menuState());
  openBlank();
  await flush();
  step('right-click blank area while open', menuState());
  fireEvent.keyDown(document, { key: 'Escape' });
  step('escape');

  openShortcut('资料夹')();
  await flush();
  fireEvent.mouseDown(document.body);
  step('pointer down outside');

  openShortcut('资料夹')();
  await flush();
  fireEvent.scroll(blankArea());
  step('scroll outside');

  openShortcut('资料夹')();
  await flush();
  fireEvent.touchStart(document.body);
  step('touch outside');

  openShortcut('资料夹')();
  await flush();
  const consumed = handleAndroidBack();
  await flush();
  step('android back', consumed);
  cleanup();
  return steps;
}

async function recordAll() {
  const shortcuts: Record<string, unknown> = {};
  for (const shortcut of SHORTCUTS) shortcuts[shortcut.id] = await recordMenu(openShortcut(shortcut.name));
  return {
    shortcuts,
    blank: await recordMenu(openBlank),
    blankCustomRoot: await recordMenu(openBlank, { root: CUSTOM_ROOT }),
    touch: await recordTouch(),
    dismissal: await recordDismissal(),
  };
}

it('records the resource library desktop view menus for every shortcut kind and the blank area, without and with a UI kernel', async () => {
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
