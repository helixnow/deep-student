/**
 * FE-B9 evidence: the workbench menu bar menus (brand, focused app, window) before they move to `app.menu`.
 *
 * For every state: the trigger, the panel DOM, the rows (label, shortcut, disabled, checked, danger, separators) and,
 * for every enabled row, what clicking it does and whether the menu closes. Window ids are replaced by their creation
 * order. Labels come from the zh-CN react-i18next test double (vitest alias), which returns the default value of
 * `t(key, default)` as is. Recorded without and with a UI kernel holding the official plugins; both must equal the
 * golden. Captured before FE-B9; the golden is never rewritten.
 */
import React, { createRef } from 'react';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({ log: [] as unknown[][] }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('@/utils/settingsApi', () => ({ getSetting: vi.fn(async () => null), saveSetting: vi.fn(async () => undefined) }));
vi.mock('@/ui-plugins/official/settings/api', async (load) => ({
  ...(await load<object>()),
  workbenchMode: { setEnabled: (value: boolean) => { effects.log.push(['persistWorkbenchModeEnabled', value]); return Promise.resolve(true); } },
}));
vi.mock('@/features/workbench/components/desktopNameStore', async (load) => ({
  ...(await load<object>()),
  persistDesktopName: (value: string) => { effects.log.push(['persistDesktopName', value]); return Promise.resolve(); },
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
import { useDesktopNameStore } from '@/features/workbench/components/desktopNameStore';
import type { AppDefinition } from '@/features/workbench/core/types';
import { StatusBarAppMenus } from '@/features/workbench/components/StatusBarAppMenus';
import { StatusBarBrandMenu } from '@/features/workbench/components/StatusBarBrandMenu';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { installOfficialUiPlugins } from '@/ui-plugins/official/install';
import { memoryRegistryAdapters } from '@/ui-plugins/testing/registries';

const GOLDEN = 'src/ui-plugins/official/menu/__tests__/__golden__/menubar-menus.json';
const SAMPLE_APP = 'fe-b9-sample';

let windowIds: string[] = [];
const restore: Array<() => void> = [];
let kernel: UiKernel | null = null;
const wrap = (node: React.ReactElement) => (kernel ? <UiKernelProvider kernel={kernel}>{node}</UiKernelProvider> : node);

beforeAll(() => {
  const launch = vi.spyOn(workbenchBus, 'launch').mockImplementation((request) => {
    effects.log.push(['workbenchBus.launch', request]);
    return null;
  });
  restore.push(() => launch.mockRestore());
  const overlay = useWorkbenchOverlay.getState().openCheatsheet;
  useWorkbenchOverlay.setState({ openCheatsheet: (options) => { effects.log.push(['openCheatsheet', options ?? null]); } });
  restore.push(() => useWorkbenchOverlay.setState({ openCheatsheet: overlay }));
  appRegistry.register({
    typeId: SAMPLE_APP, nameKey: 'menubar.appName', icon: null, instanceMode: 'multi', memoryWeight: 1,
    defaultFrame: { w: 640, h: 480 }, minSize: { w: 320, h: 240 },
  } as unknown as AppDefinition);
  restore.push(() => { appRegistry.unregister(SAMPLE_APP); });
});
afterEach(() => {
  cleanup();
  resetWindowStoreForTests();
  useDesktopNameStore.setState({ name: null });
  effects.log = [];
});
afterAll(() => {
  for (const undo of restore.reverse()) undo();
});

const anonymize = (text: string) => windowIds.reduce((value, id, index) => value.split(id).join(`<win:${index + 1}>`), text);

function interceptWindowActions() {
  const { focusWindow, setDisplayMode } = useWindowStore.getState();
  useWindowStore.setState({
    focusWindow: (id: string) => { effects.log.push(['windowStore.focusWindow', id]); },
    setDisplayMode: (id: string, mode: unknown) => { effects.log.push(['windowStore.setDisplayMode', id, mode]); },
  } as never);
  return () => useWindowStore.setState({ focusWindow, setDisplayMode } as never);
}

function openWindows(specs: Array<{ typeId: string; title?: string; minimized?: boolean }>, focus: number) {
  act(() => {
    windowIds = specs.map((spec) => useWindowStore.getState().openWindow({ typeId: spec.typeId, ...(spec.title ? { title: spec.title } : {}) }));
    specs.forEach((spec, index) => { if (spec.minimized) useWindowStore.getState().minimizeWindow(windowIds[index]); });
    useWindowStore.getState().focusWindow(windowIds[focus]);
  });
}

function describeRows(panel: Element) {
  return Array.from(panel.querySelectorAll('[role="menuitem"],[role="menuitemcheckbox"],[role="separator"],.wb-desk-menu-header,form')).map((node) => {
    if (node.getAttribute('role') === 'separator') return { separator: true };
    if (node.tagName === 'FORM') return { form: anonymize(node.getAttribute('data-testid') ?? '') };
    if (node.classList.contains('wb-desk-menu-header')) return { header: node.textContent };
    const button = node as HTMLButtonElement;
    return {
      testId: anonymize(button.dataset.testid ?? ''),
      role: button.getAttribute('role'),
      label: anonymize(button.querySelector('.wb-desk-menu-item-label')?.textContent ?? ''),
      ...(button.querySelector('.wb-desk-menu-item-shortcut') ? { shortcut: button.querySelector('.wb-desk-menu-item-shortcut')!.textContent } : {}),
      ...(button.disabled ? { disabled: true } : {}),
      ...(button.hasAttribute('aria-checked') ? { checked: button.getAttribute('aria-checked') } : {}),
      ...(button.classList.contains('wb-desk-menu-item--danger') ? { danger: true } : {}),
    };
  });
}

function describePanel(panel: Element) {
  return { label: panel.getAttribute('aria-label'), rows: describeRows(panel), html: anonymize(panel.innerHTML) };
}

const enabledItems = (panel: Element) =>
  Array.from(panel.querySelectorAll<HTMLButtonElement>('[role="menuitem"],[role="menuitemcheckbox"]')).filter((item) => !item.disabled).map((item) => item.dataset.testid!);

/** Focused app and window menus: open each, record the panel, then click every enabled row on a fresh open. */
function recordAppMenus() {
  const result: Record<string, unknown> = {};
  render(wrap(<StatusBarAppMenus />));
  for (const [menu, trigger, panelId] of [['app', 'wb-menubar-appmenu', 'wb-menubar-appmenu-panel'], ['window', 'wb-menubar-windowmenu', 'wb-menubar-windowmenu-panel']] as const) {
    const button = screen.getByTestId(trigger);
    fireEvent.click(button);
    const panel = screen.getByTestId(panelId);
    const clicks: Record<string, unknown> = {};
    for (const testId of enabledItems(panel)) {
      if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button);
      effects.log = [];
      fireEvent.click(screen.getByTestId(testId));
      clicks[anonymize(testId)] = { effects: JSON.parse(anonymize(JSON.stringify(effects.log))), closes: button.getAttribute('aria-expanded') === 'false' };
    }
    result[menu] = { trigger: anonymize(button.outerHTML), panel: describePanel(panel), clicks };
    if (button.getAttribute('aria-expanded') === 'true') fireEvent.click(button);
  }
  cleanup();
  return result;
}

function recordBrandMenu() {
  const onClose = vi.fn();
  const anchor = createRef<HTMLButtonElement>();
  const view = render(wrap(<><button ref={anchor} type="button">brand</button><StatusBarBrandMenu open anchorRef={anchor} onClose={onClose} /></>));
  const panel = () => document.querySelector('[role="menu"]')!;
  const closed = describePanel(panel());
  const clicks: Record<string, unknown> = {};
  for (const testId of enabledItems(panel())) {
    effects.log = [];
    onClose.mockClear();
    fireEvent.click(screen.getByTestId(testId));
    clicks[testId] = { effects: effects.log, closes: onClose.mock.calls.length > 0, ...(testId === 'wb-menubar-brand-rename' ? { panel: describePanel(panel()) } : {}) };
    view.rerender(wrap(<><button ref={anchor} type="button">brand</button><StatusBarBrandMenu open={false} anchorRef={anchor} onClose={onClose} /></>));
    view.rerender(wrap(<><button ref={anchor} type="button">brand</button><StatusBarBrandMenu open anchorRef={anchor} onClose={onClose} /></>));
  }
  fireEvent.click(screen.getByTestId('wb-menubar-brand-rename'));
  effects.log = [];
  onClose.mockClear();
  const input = screen.getByTestId('wb-menubar-brand-rename-input') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'Renamed' } });
  fireEvent.submit(screen.getByTestId('wb-menubar-brand-rename-form'));
  const submit = { effects: effects.log, closes: onClose.mock.calls.length > 0 };
  cleanup();
  return { panel: closed, clicks, renameSubmit: submit };
}

function recordAll() {
  const result: Record<string, unknown> = {};
  {
    const states: Record<string, unknown> = {};
    const undo = interceptWindowActions();
    try {
      windowIds = [];
      states['no-windows'] = recordAppMenus();
      undo();
      openWindows([{ typeId: 'todo' }, { typeId: 'todo' }], 1);
      interceptWindowActions();
      states['unregistered-app-focused'] = recordAppMenus();
      undo();
      resetWindowStoreForTests();
      openWindows([{ typeId: SAMPLE_APP }, { typeId: 'todo', title: 'Todo B', minimized: true }, { typeId: SAMPLE_APP, title: 'Gamma' }], 2);
      interceptWindowActions();
      states['registered-app-focused-with-minimized'] = recordAppMenus();
      undo();
      resetWindowStoreForTests();
      openWindows([{ typeId: SAMPLE_APP, title: 'Alpha' }, { typeId: 'todo', title: 'Todo B' }], 1);
      act(() => { useWindowStore.getState().minimizeWindow(windowIds[1]); });
      interceptWindowActions();
      states['focused-window-minimized'] = recordAppMenus();
    } finally {
      undo();
      resetWindowStoreForTests();
    }
    windowIds = [];
    const brand: Record<string, unknown> = { unnamed: recordBrandMenu() };
    act(() => { useDesktopNameStore.setState({ name: 'Study Room' }); });
    brand.named = recordBrandMenu();
    act(() => { useDesktopNameStore.setState({ name: null }); });
    Object.assign(result, { appMenus: states, brand });
  }
  return result;
}

it('records the workbench menu bar menus (brand, focused app, window) across states, without and with a UI kernel', async () => {
  const result = recordAll();
  kernel = new UiKernel(memoryRegistryAdapters());
  await installOfficialUiPlugins(kernel);
  try {
    expect(kernel.list()).toContain('dstu.ui.menu');
    expect(recordAll()).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  } finally {
    await kernel.dispose();
    kernel = null;
  }
  if (process.env.FE_B9_CAPTURE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  expect(result).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
}, 60_000);
