/**
 * FE-B9 evidence: the resource library tab bar's right-click menu before its rows move to `app.menu`.
 *
 * Two hosts (LearningHubPage passes split view callbacks on desktop and leaves them out on small screens) and per tab
 * state (active, pinned, shown on the right of a split, last, only pinned tabs to its right, the only tab): the menu DOM
 * and rows, and for every row what clicking it does (the host callbacks, in order) and whether the menu is still open
 * after. Touch layout (the tab's "more" button) and the ways the menu closes: Escape and other keys, a click inside and
 * outside, right-click elsewhere and on another tab while open, touch inside and outside, scroll, Android back.
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

import { TabBar, type TabBarProps } from '@/features/learning-hub/components/TabBar';
import type { OpenTab } from '@/features/learning-hub/types/tabs';
import { handleAndroidBack } from '@/app/navigation/androidBackCoordinator';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { installOfficialUiPlugins } from '@/ui-plugins/official/install';
import { memoryRegistryAdapters } from '@/ui-plugins/testing/registries';

const GOLDEN = 'src/ui-plugins/official/menu/__tests__/__golden__/tab-bar-menu.json';

let kernel: UiKernel | null = null;
const wrap = (node: React.ReactElement) => (kernel ? <UiKernelProvider kernel={kernel}>{node}</UiKernelProvider> : node);

const TABS: OpenTab[] = [
  { tabId: 't_note', type: 'note', resourceId: 'note_1', dstuPath: '/note_1', title: '线代笔记', openedAt: 1 },
  { tabId: 't_mindmap', type: 'mindmap', resourceId: 'mm_1', dstuPath: '/mm_1', title: '导图', openedAt: 2 },
  { tabId: 't_textbook', type: 'textbook', resourceId: 'tb_1', dstuPath: '/tb_1', title: '教材', openedAt: 3 },
  { tabId: 't_exam', type: 'exam', resourceId: 'exam_1', dstuPath: '/exam_1', title: '题目集', isPinned: true, openedAt: 4 },
];

type Host = 'desktop' | 'mobile';
interface Scenario { host: Host; tabs: OpenTab[]; split: boolean }
const FULL: Record<Host, Scenario> = {
  desktop: { host: 'desktop', tabs: TABS, split: true },
  mobile: { host: 'mobile', tabs: TABS, split: false },
};
const SINGLE: Scenario = { host: 'desktop', tabs: [TABS[0]], split: false };

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

beforeAll(() => {
  setTouch(false);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  effects.log = [];
  setTouch(false);
});
afterAll(() => {
  window.matchMedia = originalMatchMedia;
  vi.unstubAllGlobals();
});

const log = (name: string) => (...args: unknown[]) => { effects.log.push([name, ...args]); };

function hostProps({ host, tabs, split }: Scenario): TabBarProps {
  const common: TabBarProps = {
    tabs: tabs.map((tab) => ({ ...tab })),
    activeTabId: 't_note',
    onSwitch: log('onSwitch'),
    onClose: log('onClose'),
    setTabs: log('setTabs') as TabBarProps['setTabs'],
    onTogglePin: log('onTogglePin'),
    onCloseOthers: log('onCloseOthers'),
    onCloseRight: log('onCloseRight'),
  };
  if (host === 'mobile') return common;
  return {
    ...common,
    splitView: split ? { rightTabId: 't_mindmap' } : null,
    onSplitView: log('onSplitView'),
    onCloseSplitView: log('onCloseSplitView'),
    actionsSlotRef: () => undefined,
  };
}

async function renderBar(scenario: Scenario, touch = false) {
  setTouch(touch);
  render(wrap(<TabBar {...hostProps(scenario)} />));
  await flush();
}

const tab = (title: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'))
  .find((node) => node.querySelector('span.truncate')?.textContent === title)!;
const menus = () => Array.from(document.querySelectorAll<HTMLElement>('body > [role="menu"]'));
const menu = () => menus()[0] ?? null;
const menuItems = () => Array.from(menu()?.querySelectorAll<HTMLButtonElement>('button') ?? []);

function describeRows(panel: Element) {
  return Array.from(panel.children).map((node) => {
    if (node.getAttribute('role') === 'separator') return { separator: true, className: node.className };
    const button = node as HTMLButtonElement;
    return {
      role: button.getAttribute('role'),
      label: button.textContent ?? '',
      className: button.className,
      ...(button.disabled ? { disabled: true } : {}),
    };
  });
}

function menuState() {
  const all = menus();
  if (!all.length) return null;
  return {
    count: all.length,
    style: all[0].getAttribute('style'),
    rows: describeRows(all[0]),
  };
}

const focusState = () => {
  const el = document.activeElement;
  if (!el || el === document.body) return 'body';
  return `${el.tagName}[${el.getAttribute('role') ?? ''}]${el.textContent ? `:${el.textContent}` : ''}`;
};

type Opener = () => void;
const openOn = (title: string): Opener => () => { fireEvent.contextMenu(tab(title), { clientX: 120, clientY: 40 }); };

async function recordMenu(scenario: Scenario, title: string) {
  await renderBar(scenario);
  effects.log = [];
  openOn(title)();
  await flush();
  const result: Record<string, unknown> = {
    html: menu()?.outerHTML ?? null,
    menu: menuState(),
    openEffects: [...effects.log],
    focus: focusState(),
  };
  const labels = menuItems().map((item) => item.textContent ?? '');
  const clicks: Record<string, unknown> = {};
  for (const [index, label] of labels.entries()) {
    cleanup();
    await renderBar(scenario);
    openOn(title)();
    await flush();
    effects.log = [];
    fireEvent.click(menuItems()[index]);
    const sync = [...effects.log];
    const openRightAfter = menuState() !== null;
    await flush();
    clicks[`${index}:${label}`] = { effects: effects.log, syncEffects: sync.length, openRightAfter, menu: menuState(), focus: focusState() };
  }
  result.clicks = clicks;
  cleanup();
  return result;
}

async function recordTouch() {
  await renderBar(FULL.mobile, true);
  const target = tab('线代笔记');
  const more = target.querySelector<HTMLElement>('span[role="button"][aria-label]')!;
  const moreHtml = more.outerHTML;
  effects.log = [];
  fireEvent.pointerDown(more);
  fireEvent.click(more);
  await flush();
  const opened = { moreHtml, html: menu()?.outerHTML ?? null, menu: menuState(), effects: [...effects.log] };
  const steps: unknown[] = [];
  fireEvent.touchStart(menuItems()[0]);
  steps.push(['touch inside', menuState() !== null]);
  fireEvent.touchStart(document.body);
  await flush();
  steps.push(['touch outside', menuState() !== null]);
  fireEvent.click(more);
  await flush();
  effects.log = [];
  fireEvent.click(menuItems()[0]);
  await flush();
  steps.push(['first row', menuState() !== null, [...effects.log]]);
  cleanup();
  return { opened, steps };
}

async function recordDismissal() {
  const steps: unknown[] = [];
  const step = (name: string, extra?: unknown) => steps.push(extra === undefined ? [name, menuState()?.count ?? 0] : [name, menuState()?.count ?? 0, extra]);

  await renderBar(FULL.desktop);
  openOn('教材')();
  await flush();
  step('open');
  fireEvent.keyDown(document, { key: 'Enter' });
  step('other key');
  fireEvent.keyDown(document, { key: 'Escape' });
  await flush();
  step('escape');

  openOn('教材')();
  await flush();
  fireEvent.click(menu()!.querySelector('[role="separator"]')!);
  await flush();
  step('click inside on the separator');

  openOn('教材')();
  await flush();
  fireEvent.click(document.body);
  await flush();
  step('click outside');

  openOn('教材')();
  await flush();
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  await flush();
  step('right-click elsewhere', event.defaultPrevented);

  openOn('教材')();
  await flush();
  effects.log = [];
  openOn('题目集')();
  await flush();
  step('right-click another tab while open', { rows: menuState()?.rows.map((row) => ('label' in row ? row.label : '—')), effects: [...effects.log] });
  fireEvent.keyDown(document, { key: 'Escape' });
  await flush();
  step('escape closes it');

  openOn('教材')();
  await flush();
  fireEvent.touchStart(document.body);
  await flush();
  step('touch outside');

  openOn('教材')();
  await flush();
  fireEvent.scroll(window);
  await flush();
  step('scroll');

  openOn('教材')();
  await flush();
  const consumed = handleAndroidBack();
  await flush();
  step('android back', consumed);

  openOn('教材')();
  await flush();
  effects.log = [];
  fireEvent.click(tab('线代笔记'));
  await flush();
  step('click another tab while open', [...effects.log]);
  cleanup();
  return steps;
}

async function recordAll() {
  const result: Record<string, unknown> = {};
  for (const host of ['desktop', 'mobile'] as const) {
    const perTab: Record<string, unknown> = {};
    for (const title of ['线代笔记', '导图', '教材', '题目集']) perTab[title] = await recordMenu(FULL[host], title);
    result[host] = perTab;
  }
  result.single = await recordMenu(SINGLE, '线代笔记');
  result.touch = await recordTouch();
  result.dismissal = await recordDismissal();
  return result;
}

it('records the resource library tab bar menu for both hosts and every tab state, without and with a UI kernel', async () => {
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
