/**
 * FE-B9 evidence: the Dock item menu and the desktop right-click menu before their rows move to `app.menu`.
 *
 * Dock, per state: the trigger and panel DOM, the rows, and for every enabled row what clicking it does and whether
 * the menu closes; plus a keyboard walk. Desktop, per state: the backdrop + panel DOM, each submenu's DOM, and for every
 * enabled row (main panel and submenus) what clicking it does, `onClose` / `onShowDesktop` included in call order; plus
 * pointer and keyboard walks across the submenus. Window ids are replaced by their creation order, the Dock menu's React
 * id by `<menu>`. Labels come from the evidence zh-CN i18n double (key first, then the default value). Recorded without
 * and with a UI kernel holding the official plugins; both must equal the golden. Captured before the migration; the
 * golden is never rewritten.
 */
import React from 'react';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({ log: [] as unknown[][] }));

vi.mock('react-i18next', () => import('@/ui-plugins/testing/__tests__/evidence/i18nMock'));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (...args: unknown[]) => { effects.log.push(['invoke', ...args]); return null; }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('@/features/workbench/core/materialTier', async (load) => ({
  ...(await load<object>()),
  setMaterialTier: (tier: string) => { effects.log.push(['setMaterialTier', tier]); },
}));
vi.mock('@/features/workbench/components/DockPinnedStore', async (load) => ({
  ...(await load<object>()),
  toggleDockPinned: (typeId: string) => { effects.log.push(['toggleDockPinned', typeId]); },
}));
vi.mock('@/features/workbench/hooks/useWindowLifecycleAnim', async (load) => ({
  ...(await load<object>()),
  requestCloseAnimated: (id: string) => { effects.log.push(['requestCloseAnimated', id]); return Promise.resolve(true); },
  requestCloseAppWindowsAnimated: (id: string) => { effects.log.push(['requestCloseAppWindowsAnimated', id]); return Promise.resolve(); },
}));
vi.mock('@/features/workbench/components/appsPanelStore', async (load) => ({
  ...(await load<object>()),
  openAppsPanel: () => { effects.log.push(['openAppsPanel']); },
}));

import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { appRegistry } from '@/features/workbench/core/appRegistry';
import { useWorkbenchOverlay } from '@/features/workbench/core/shortcuts';
import { resetWindowStoreForTests, useWindowStore } from '@/features/workbench/core/windowStore';
import { setDockPinned } from '@/features/workbench/components/DockPinnedStore';
import type { AppDefinition } from '@/features/workbench/core/types';
import type { WallpaperConfig } from '@/features/workbench/components/WallpaperLayer';
import { DockContextMenu } from '@/features/workbench/components/DockContextMenu';
import { DesktopContextMenu } from '@/features/workbench/components/DesktopContextMenu';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { installOfficialUiPlugins } from '@/ui-plugins/official/install';
import { memoryRegistryAdapters } from '@/ui-plugins/testing/registries';

const GOLDEN = 'src/ui-plugins/official/menu/__tests__/__golden__/workbench-context-menus.json';
const MULTI_APP = 'fe-b9-multi';
const SINGLE_APP = 'fe-b9-single';
const GHOST_APP = 'fe-b9-ghost';

let windowIds: string[] = [];
let menuIds: string[] = [];
const restore: Array<() => void> = [];
let kernel: UiKernel | null = null;
const wrap = (node: React.ReactElement) => (kernel ? <UiKernelProvider kernel={kernel}>{node}</UiKernelProvider> : node);

const anonymize = (text: string) => {
  const named = windowIds.reduce((value, id, index) => value.split(id).join(`<win:${index + 1}>`), text);
  return menuIds.reduce((value, id) => value.split(id).join('<menu>'), named);
};
const anonymized = (value: unknown) => JSON.parse(anonymize(JSON.stringify(value)));

async function flush(rounds = 4) {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function sampleApp(typeId: string, nameKey: string, instanceMode: 'single' | 'multi'): AppDefinition {
  return {
    typeId, nameKey, icon: null, instanceMode, memoryWeight: 1, defaultFrame: { w: 640, h: 480 }, minSize: { w: 320, h: 240 },
  } as unknown as AppDefinition;
}

beforeAll(() => {
  workbenchBus.setEnabled(true);
  const launch = vi.spyOn(workbenchBus, 'launch').mockImplementation((request) => {
    effects.log.push(['workbenchBus.launch', request]);
    return null;
  });
  restore.push(() => launch.mockRestore());
  const { openCheatsheet, toggleExpose } = useWorkbenchOverlay.getState();
  useWorkbenchOverlay.setState({
    openCheatsheet: (options) => { effects.log.push(['openCheatsheet', options ?? null]); },
    toggleExpose: () => { effects.log.push(['toggleExpose']); },
  });
  restore.push(() => useWorkbenchOverlay.setState({ openCheatsheet, toggleExpose }));
  const dispatch = window.dispatchEvent.bind(window);
  const dispatchSpy = vi.spyOn(window, 'dispatchEvent').mockImplementation((event: Event) => {
    if (event instanceof CustomEvent) effects.log.push(['window.dispatchEvent', event.type, event.detail ?? null]);
    return dispatch(event);
  });
  restore.push(() => dispatchSpy.mockRestore());
  const setItem = localStorage.setItem.bind(localStorage);
  const removeItem = localStorage.removeItem.bind(localStorage);
  const setSpy = vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
    effects.log.push(['localStorage.setItem', key, value]);
    setItem(key, value);
  });
  const removeSpy = vi.spyOn(localStorage, 'removeItem').mockImplementation((key: string) => {
    effects.log.push(['localStorage.removeItem', key]);
    removeItem(key);
  });
  restore.push(() => { setSpy.mockRestore(); removeSpy.mockRestore(); });
  const info = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => { effects.log.push(['console.info', ...args]); });
  restore.push(() => info.mockRestore());
  appRegistry.register(sampleApp(MULTI_APP, 'workbench:apps.chat', 'multi'));
  appRegistry.register(sampleApp(SINGLE_APP, 'workbench:apps.files', 'single'));
  restore.push(() => { appRegistry.unregister(MULTI_APP); appRegistry.unregister(SINGLE_APP); });
});
afterEach(() => {
  cleanup();
  resetWindowStoreForTests();
  setDockPinned([]);
  localStorage.clear();
  effects.log = [];
});
afterAll(() => {
  for (const undo of restore.reverse()) undo();
  workbenchBus.setEnabled(false);
});

function interceptWindowActions() {
  const { focusWindow, setDisplayMode, moveWindow, batchSetDisplayModes } = useWindowStore.getState();
  useWindowStore.setState({
    focusWindow: (id: string) => { effects.log.push(['windowStore.focusWindow', id]); },
    setDisplayMode: (id: string, mode: unknown) => { effects.log.push(['windowStore.setDisplayMode', id, mode]); },
    moveWindow: (id: string, frame: unknown) => { effects.log.push(['windowStore.moveWindow', id, frame]); },
    batchSetDisplayModes: (entries: unknown) => { effects.log.push(['windowStore.batchSetDisplayModes', entries]); },
  } as never);
  return () => useWindowStore.setState({ focusWindow, setDisplayMode, moveWindow, batchSetDisplayModes } as never);
}

interface WindowSpec { typeId: string; title?: string; minimized?: boolean }

/** Opens the windows in order (fixed creation / focus times), minimizes the marked ones, then focuses `focus`. */
function openWindows(specs: WindowSpec[], focus: number | null) {
  act(() => {
    const store = useWindowStore.getState();
    windowIds = specs.map((spec) => store.openWindow({ typeId: spec.typeId, ...(spec.title ? { title: spec.title } : {}) }));
    useWindowStore.setState((state) => ({
      windows: Object.fromEntries(Object.entries(state.windows).map(([id, win]) => {
        const index = windowIds.indexOf(id);
        return [id, { ...win, createdAt: 1_000 + index, lastFocusedAt: 2_000 + index }];
      })),
    }));
    if (focus !== null) useWindowStore.getState().focusWindow(windowIds[focus]);
    specs.forEach((spec, index) => { if (spec.minimized) useWindowStore.getState().minimizeWindow(windowIds[index]); });
  });
}

function describeRows(panel: Element) {
  return Array.from(panel.querySelectorAll('[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="separator"],.app-menu-group-label'))
    .filter((node) => node.closest('[role="menu"]') === panel)
    .map((node) => {
      if (node.getAttribute('role') === 'separator') return { separator: true };
      if (node.classList.contains('app-menu-group-label')) return { groupLabel: node.textContent };
      const button = node as HTMLButtonElement;
      const label = button.querySelector('.wb-desk-menu-item-label, .app-menu-item-content')?.textContent ?? '';
      const suffix = button.querySelector('.app-menu-item-suffix')?.textContent;
      const shortcut = button.querySelector('.wb-desk-menu-item-shortcut, .app-menu-item-shortcut')?.textContent;
      return {
        role: button.getAttribute('role'),
        label: anonymize(label),
        ...(button.dataset.testid ? { testId: button.dataset.testid } : {}),
        ...(suffix ? { suffix } : {}),
        ...(shortcut ? { shortcut } : {}),
        ...(button.disabled ? { disabled: true } : {}),
        ...(button.hasAttribute('aria-checked') ? { checked: button.getAttribute('aria-checked') } : {}),
        ...(button.classList.contains('app-menu-item-checked') ? { checkedClass: true } : {}),
        ...(/danger|destructive/.test(button.className) ? { danger: button.className } : {}),
        ...(button.dataset.wbDeskSub ? { submenu: button.dataset.wbDeskSub } : {}),
        ...(button.dataset.wbDeskOption ? { option: button.dataset.wbDeskOption } : {}),
      };
    });
}

const rowLabel = (node: Element | null) => {
  if (!node) return null;
  if (node.getAttribute('role') === 'menu') return `menu:${node.getAttribute('aria-label') ?? node.getAttribute('data-testid')}`;
  return anonymize((node.querySelector('.wb-desk-menu-item-label, .app-menu-item-content')?.textContent ?? node.getAttribute('aria-label') ?? node.tagName).trim());
};

// ---------------------------------------------------------------------------------------------------------------------
// Dock

function renderDock(typeId: string) {
  const view = render(wrap(<DockContextMenu typeId={typeId}><button type="button" data-testid="dock-trigger">{typeId}</button></DockContextMenu>));
  const trigger = screen.getByTestId('dock-trigger');
  menuIds = [trigger.id.replace(/-trigger$/, '')];
  return { view, trigger };
}

const dockPanel = () => screen.getByTestId('wb-dock-context-menu');
const dockItems = () => Array.from(dockPanel().querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));

/** The panel's enter transition ends on a later animation frame (`app-menu-open`); wait for it. */
async function settleDock() {
  for (let i = 0; i < 50 && !document.querySelector('[data-testid="wb-dock-context-menu"].app-menu-open'); i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  expect(dockPanel().classList.contains('app-menu-open')).toBe(true);
  await flush();
}

async function recordDock(typeId: string) {
  let { trigger } = renderDock(typeId);
  fireEvent.contextMenu(trigger, { clientX: 40, clientY: 600 });
  await settleDock();
  const panel = dockPanel();
  const result: Record<string, unknown> = {
    trigger: anonymize(trigger.outerHTML),
    panel: { rows: describeRows(panel), html: anonymize(panel.outerHTML) },
  };
  const enabled = dockItems().map((item, index) => ({ index, label: rowLabel(item), disabled: item.disabled })).filter((item) => !item.disabled);
  const clicks: Record<string, unknown> = {};
  for (const { index, label } of enabled) {
    cleanup();
    ({ trigger } = renderDock(typeId));
    fireEvent.contextMenu(trigger, { clientX: 40, clientY: 600 });
    await settleDock();
    effects.log = [];
    fireEvent.click(dockItems()[index]);
    await flush();
    clicks[`${index}:${label}`] = { effects: anonymized(effects.log), closes: trigger.getAttribute('aria-expanded') === 'false' };
  }
  result.clicks = clicks;
  cleanup();

  // Keyboard: open with the ContextMenu key, then walk the items.
  ({ trigger } = renderDock(typeId));
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ContextMenu' });
  await settleDock();
  const walk: unknown[] = [['open', rowLabel(document.activeElement)]];
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'Home', 'End', 'ArrowUp']) {
    fireEvent.keyDown(document.activeElement!, { key });
    walk.push([key, rowLabel(document.activeElement)]);
  }
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  await flush();
  walk.push(['Escape', document.activeElement === trigger ? 'trigger' : rowLabel(document.activeElement), trigger.getAttribute('aria-expanded')]);
  result.keyboard = walk;
  cleanup();
  return result;
}

async function recordDockStates() {
  const states: Record<string, unknown> = {};
  const undo = interceptWindowActions();
  try {
    const cases: Array<[string, string, WindowSpec[], number | null, string[]]> = [
      ['multi-idle-unpinned', MULTI_APP, [], null, []],
      ['multi-running-pinned', MULTI_APP, [
        { typeId: MULTI_APP, title: 'Alpha' }, { typeId: SINGLE_APP, title: 'Other' }, { typeId: MULTI_APP, minimized: true },
        { typeId: MULTI_APP, title: 'Gamma' },
      ], 3, [MULTI_APP]],
      ['multi-foreground-minimized', MULTI_APP, [{ typeId: MULTI_APP, title: 'Alpha' }, { typeId: MULTI_APP, title: 'Beta', minimized: true }], 1, []],
      ['single-running', SINGLE_APP, [{ typeId: SINGLE_APP }], 0, []],
      ['single-idle-pinned', SINGLE_APP, [], null, [SINGLE_APP, MULTI_APP]],
      ['unregistered-running', GHOST_APP, [{ typeId: GHOST_APP }], 0, []],
    ];
    for (const [name, typeId, windows, focus, pins] of cases) {
      undo();
      resetWindowStoreForTests();
      windowIds = [];
      setDockPinned(pins);
      openWindows(windows, focus);
      interceptWindowActions();
      states[name] = await recordDock(typeId);
    }
  } finally {
    undo();
    resetWindowStoreForTests();
    setDockPinned([]);
  }
  return states;
}

// ---------------------------------------------------------------------------------------------------------------------
// Desktop

const ANCHOR = { x: 200, y: 160 };

function renderDesktop(wallpaper: WallpaperConfig) {
  const onClose = () => { effects.log.push(['onClose']); };
  const onShowDesktop = () => { effects.log.push(['onShowDesktop']); };
  return render(wrap(<DesktopContextMenu anchor={ANCHOR} wallpaper={wallpaper} onClose={onClose} onShowDesktop={onShowDesktop} />));
}

const desktopPanel = () => document.querySelector<HTMLElement>('[data-wb-desk-menu]')!;
const desktopSub = () => document.querySelector<HTMLElement>('.wb-desk-menu-sub');
const mainItems = () => Array.from(desktopPanel().querySelectorAll<HTMLButtonElement>('button[data-wb-desk-item]'));
const subItems = () => Array.from(desktopSub()?.querySelectorAll<HTMLButtonElement>('button[data-wb-desk-item]') ?? []);
const subParent = (id: string) => desktopPanel().querySelector<HTMLButtonElement>(`[data-wb-desk-sub="${id}"]`)!;

async function openDesktop(wallpaper: WallpaperConfig) {
  const view = renderDesktop(wallpaper);
  await flush();
  return view;
}

function subState() {
  const sub = desktopSub();
  return sub ? { label: sub.getAttribute('aria-label'), className: sub.className } : null;
}

async function recordDesktop(wallpaper: WallpaperConfig) {
  const view = await openDesktop(wallpaper);
  const result: Record<string, unknown> = {
    html: anonymize(view.container.innerHTML),
    rows: describeRows(desktopPanel()),
  };
  const submenus: Record<string, unknown> = {};
  const subIds = mainItems().map((item) => item.dataset.wbDeskSub).filter((id): id is string => !!id);
  for (const id of subIds) {
    cleanup();
    await openDesktop(wallpaper);
    fireEvent.click(subParent(id));
    await flush();
    const sub = desktopSub()!;
    submenus[id] = { parent: anonymize(subParent(id).outerHTML), rows: describeRows(sub), html: anonymize(sub.outerHTML) };
  }
  result.submenus = submenus;

  const clicks: Record<string, unknown> = {};
  const mains = mainItems().map((item, index) => ({ index, label: rowLabel(item), disabled: item.disabled, sub: item.dataset.wbDeskSub }));
  for (const { index, label, disabled, sub } of mains) {
    if (disabled || sub) continue;
    cleanup();
    await openDesktop(wallpaper);
    effects.log = [];
    fireEvent.click(mainItems()[index]);
    await flush();
    clicks[`${index}:${label}`] = anonymized(effects.log);
  }
  for (const id of subIds) {
    cleanup();
    await openDesktop(wallpaper);
    fireEvent.click(subParent(id));
    await flush();
    const rows = subItems().map((item, index) => ({ index, label: rowLabel(item) }));
    for (const { index, label } of rows) {
      cleanup();
      await openDesktop(wallpaper);
      fireEvent.click(subParent(id));
      await flush();
      effects.log = [];
      fireEvent.click(subItems()[index]);
      await flush();
      clicks[`${id}/${index}:${label}`] = anonymized(effects.log);
    }
  }
  result.clicks = clicks;
  cleanup();
  return result;
}

/** Pointer: hovering a submenu parent opens it, another parent switches, a plain row closes it; clicking a parent toggles. */
async function recordDesktopPointer(wallpaper: WallpaperConfig) {
  await openDesktop(wallpaper);
  const steps: unknown[] = [];
  const step = async (name: string, action: () => void) => {
    action();
    await flush();
    steps.push([name, subState(), subParent('wallpaper').getAttribute('aria-expanded'), subParent('tier').getAttribute('aria-expanded')]);
  };
  await step('enter wallpaper', () => fireEvent.pointerEnter(subParent('wallpaper')));
  await step('enter tier', () => fireEvent.pointerEnter(subParent('tier')));
  await step('enter first row', () => fireEvent.pointerEnter(mainItems()[0]));
  await step('click tier', () => fireEvent.click(subParent('tier')));
  await step('click tier again', () => fireEvent.click(subParent('tier')));
  await step('click wallpaper', () => fireEvent.click(subParent('wallpaper')));
  await step('enter widgets row', () => fireEvent.pointerEnter(screen.getByTestId('wb-desk-menu-widgets')));
  effects.log = [];
  fireEvent.pointerDown(document.querySelector('[data-wb-desk-menu-backdrop]')!);
  steps.push(['backdrop pointerdown', anonymized(effects.log)]);
  effects.log = [];
  fireEvent.contextMenu(document.querySelector('[data-wb-desk-menu-backdrop]')!);
  steps.push(['backdrop contextmenu', anonymized(effects.log)]);
  cleanup();
  return steps;
}

/** Keyboard: the panel takes focus; arrows, Home / End, → into a submenu, ← and Esc back out, Esc and Tab close. */
async function recordDesktopKeyboard(wallpaper: WallpaperConfig) {
  await openDesktop(wallpaper);
  const walk: unknown[] = [['open', rowLabel(document.activeElement)]];
  const press = async (key: string, extra: Record<string, unknown> = {}) => {
    effects.log = [];
    fireEvent.keyDown(document.activeElement!, { key, ...extra });
    await flush();
    walk.push([key, rowLabel(document.activeElement), subState()?.label ?? null, ...(effects.log.length ? [anonymized(effects.log)] : [])]);
  };
  for (let i = 0; i < mainItems().length + 1; i++) await press('ArrowDown');
  await press('Home');
  await press('End');
  await press('ArrowUp');
  await press('Home');
  while (!document.activeElement?.hasAttribute('data-wb-desk-sub')) await press('ArrowDown');
  await press('ArrowRight');
  await press('ArrowDown');
  await press('End');
  await press('ArrowLeft');
  await press('ArrowDown');
  await press('ArrowRight');
  await press('Escape');
  await press('ArrowRight');
  await press('ArrowRight');
  await press('Escape');
  await press('Escape');
  cleanup();
  await openDesktop(wallpaper);
  await press('ArrowDown');
  await press('Tab');
  cleanup();
  return walk;
}

async function recordDesktopStates() {
  const states: Record<string, unknown> = {};
  const undo = interceptWindowActions();
  try {
    const cases: Array<[string, WindowSpec[], number | null, Record<string, string>, WallpaperConfig]> = [
      ['empty', [], null, {}, { kind: 'theme', value: 'mountain-mist' }],
      ['windows-custom-settings', [
        { typeId: MULTI_APP, title: 'Alpha' }, { typeId: SINGLE_APP, minimized: true }, { typeId: GHOST_APP, title: 'Gamma' },
      ], 0, { 'desktop.workbenchDesktopWidgets': 'false', 'desktop.workbenchMaterialTier': 'reduced' }, { kind: 'theme', value: 'sakura' }],
      ['all-minimized-image', [{ typeId: MULTI_APP, minimized: true }], 0, { 'desktop.workbenchMaterialTier': 'full' }, { kind: 'image', value: 'asset://wallpaper.png' }],
      ['four-windows-unknown-wallpaper', [
        { typeId: MULTI_APP }, { typeId: MULTI_APP }, { typeId: SINGLE_APP }, { typeId: GHOST_APP }, { typeId: GHOST_APP, minimized: true },
      ], 2, { 'desktop.workbenchMaterialTier': 'bogus', 'desktop.workbenchDesktopWidgets': 'true' }, { kind: 'theme', value: 'no-such-preset' }],
    ];
    for (const [name, windows, focus, settings, wallpaper] of cases) {
      undo();
      resetWindowStoreForTests({ w: 1280, h: 800 });
      windowIds = [];
      menuIds = [];
      localStorage.clear();
      for (const [key, value] of Object.entries(settings)) localStorage.setItem(key, value);
      openWindows(windows, focus);
      interceptWindowActions();
      const state: Record<string, unknown> = await recordDesktop(wallpaper);
      if (name === 'empty' || name === 'windows-custom-settings') {
        state.pointer = await recordDesktopPointer(wallpaper);
        state.keyboard = await recordDesktopKeyboard(wallpaper);
      }
      states[name] = state;
    }
  } finally {
    undo();
    resetWindowStoreForTests();
    localStorage.clear();
  }
  return states;
}

async function recordAll() {
  return { dock: await recordDockStates(), desktop: await recordDesktopStates() };
}

it('records the Dock item menu and the desktop right-click menu across states, without and with a UI kernel', async () => {
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
