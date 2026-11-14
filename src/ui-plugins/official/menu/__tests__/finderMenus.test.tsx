import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => import('@/ui-plugins/testing/__tests__/evidence/i18nMock'));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('@/features/learning-hub/components/finder/FolderPickerDialog', () => ({
  FolderPickerDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="folder-picker" /> : null),
}));

import { defineUiPlugin, UiKernel, type UiPlugin } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import type { SlotEntry } from '@/ui-kernel/slots';
import type { AppMenuContribution } from '@/ui-sdk';
import { DesktopView } from '@/features/learning-hub/components/finder/DesktopView';
import { TabBar, type TabBarProps } from '@/features/learning-hub/components/TabBar';
import type { OpenTab } from '@/features/learning-hub/types/tabs';
import { useDesktopStore, type DesktopShortcut } from '@/features/learning-hub/stores/desktopStore';
import { installOfficialUiPlugins } from '../../install';
import { memoryRegistryAdapters } from '../../../testing/registries';
import { officialFinderDesktopMenuEntries } from '../finderDesktopMenu';
import { officialTabBarMenuEntries } from '../tabBarMenu';

const CREATED = '2026-01-01T00:00:00.000Z';
const SHORTCUTS: DesktopShortcut[] = [
  { id: 's_note', name: '线代笔记', type: 'resource', target: { resourceId: 'note_1', resourceType: 'note' }, position: 0, createdAt: CREATED },
  { id: 's_folder', name: '资料夹', type: 'folder', target: { folderId: 'folder_1' }, position: 1, createdAt: CREATED },
];
const ROOT = { folderId: 'folder_9', folderName: '我的桌面', folderPath: '/我的桌面' };
const TABS: OpenTab[] = [
  { tabId: 't_note', type: 'note', resourceId: 'note_1', dstuPath: '/note_1', title: '线代笔记', openedAt: 1 },
  { tabId: 't_mindmap', type: 'mindmap', resourceId: 'mm_1', dstuPath: '/mm_1', title: '导图', openedAt: 2 },
  { tabId: 't_exam', type: 'exam', resourceId: 'exam_1', dstuPath: '/exam_1', title: '题目集', isPinned: true, openedAt: 3 },
];

let kernel: UiKernel | undefined;
const originalMatchMedia = window.matchMedia;
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(async () => {
  cleanup();
  useDesktopStore.setState({ shortcuts: [], desktopRoot: { folderId: null, folderName: null, folderPath: null } });
  await kernel?.dispose();
  kernel = undefined;
});
afterAll(() => {
  window.matchMedia = originalMatchMedia;
  vi.unstubAllGlobals();
});

async function boot() {
  kernel = new UiKernel(memoryRegistryAdapters());
  await installOfficialUiPlugins(kernel);
  return kernel;
}

async function install(k: UiKernel, plugin: UiPlugin<any>) {
  await act(async () => { await k.install(plugin); });
}

async function flush() {
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const describeEntries = (entries: readonly SlotEntry<unknown>[]) => entries.map(({ id, order, owner, origin }) => ({ id, order, owner, origin }));
const finderEntries = (k: UiKernel, menu: string) => k.slots.list<AppMenuContribution>('app.menu').filter((entry) => entry.value.menu === menu);

describe('app.menu: resource library menus (FE-B9)', () => {
  it('holds the official desktop view and tab rows, owned by dstu.ui.menu', async () => {
    const k = await boot();
    const official = [...officialFinderDesktopMenuEntries, ...officialTabBarMenuEntries];
    expect(official.every((entry) => entry.owner === 'dstu.ui.menu' && entry.origin === 'builtin')).toBe(true);
    expect(describeEntries(finderEntries(k, 'finder.desktop'))).toEqual(describeEntries(officialFinderDesktopMenuEntries.filter((entry) => entry.value.menu === 'finder.desktop')));
    expect(finderEntries(k, 'finder.desktop').map((entry) => entry.id)).toEqual(['finderDesktop:add', 'finderDesktop:root']);
    expect(finderEntries(k, 'finder.desktopShortcut').map((entry) => entry.id)).toEqual(['finderDesktopShortcut:open', 'finderDesktopShortcut:rename', 'finderDesktopShortcut:remove']);
    expect(describeEntries(finderEntries(k, 'finder.tab'))).toEqual(describeEntries(officialTabBarMenuEntries));
    expect(officialTabBarMenuEntries.map((entry) => entry.id)).toEqual(['tab:split', 'tab:pin', 'tab:close']);
  });
});

describe('app.menu: resource library desktop view menus (FE-B9)', () => {
  const menu = () => document.querySelector<HTMLElement>('.wb-desk-menu');
  const rows = () => Array.from(menu()?.children ?? []).flatMap((node) => {
    if (node.getAttribute('role') === 'separator') return ['---'];
    if (node.tagName !== 'BUTTON') return node.classList.contains('wb-glass-replica') ? [] : [`(${node.textContent})`];
    const button = node as HTMLButtonElement;
    return [`${button.dataset.testid ?? button.querySelector('.wb-desk-menu-item-label')?.textContent}${button.disabled ? ' [disabled]' : ''}`];
  });
  const openShortcut = async (name: string) => {
    fireEvent.contextMenu(document.querySelector(`div[role="button"][aria-label="${name}"]`)!, { clientX: 120, clientY: 140 });
    await flush();
  };
  const openBlank = async () => {
    fireEvent.contextMenu(document.querySelector('.min-h-full.p-4')!, { clientX: 200, clientY: 260 });
    await flush();
  };
  const navigate = vi.fn();

  async function renderView(k: UiKernel) {
    useDesktopStore.setState({ shortcuts: SHORTCUTS.map((shortcut) => ({ ...shortcut, target: { ...shortcut.target } })), desktopRoot: { ...ROOT } });
    render(<UiKernelProvider kernel={k}><DesktopView onNavigateQuickAccess={navigate} onOpenResource={navigate} onOpenFolder={navigate} /></UiKernelProvider>);
    await flush();
  }

  it('RF-W18-finder-menu-contributions: places community rows by order with the view state on the context (no workbench); rows run, then the menu closes; unload removes them', async () => {
    const k = await boot();
    const reveal = vi.fn();
    const seen: Record<string, unknown>[] = [];
    await install(k, defineUiPlugin({ meta: { id: 'example.finder-desktop' }, apply(ctx) {
      ctx.ui.contribute('app.menu', { id: 'shortcut-extra', order: 15, value: { menu: 'finder.desktopShortcut', items: (context) => {
        seen.push({ ...context });
        return context.shortcutType === 'resource'
          ? [{ id: 'reveal', label: 'Reveal', testId: 'example-reveal', run: () => reveal(context.target.resourceId) }]
          : [];
      } } });
      ctx.ui.contribute('app.menu', { id: 'blank-extra', order: 30, value: { menu: 'finder.desktop', items: (context) => {
        seen.push({ ...context });
        return [
          { kind: 'separator', id: 'extra-separator' },
          { id: 'stay', label: 'Stay', testId: 'example-stay', closeOnRun: false, run: () => reveal('stay') },
          { id: 'off', label: 'Off', testId: 'example-off', disabled: true, run: () => reveal('off') },
          { id: 'flag', label: 'Flag', testId: 'example-flag', checked: true, run: () => reveal('flag') },
        ];
      } } });
    } }));
    await renderView(k);

    await openShortcut('线代笔记');
    expect(rows()).toEqual(['打开', 'example-reveal', '---', '重命名', '---', '从桌面移除']);
    expect(seen.at(-1)).toMatchObject({ shortcutId: 's_note', shortcutType: 'resource', name: '线代笔记', target: { resourceId: 'note_1', resourceType: 'note' } });
    expect(seen.at(-1)).not.toHaveProperty('workbench');
    expect(Object.keys(seen.at(-1)!).sort()).toEqual(['beginRename', 'name', 'open', 'remove', 'shortcutId', 'shortcutType', 't', 'target']);
    fireEvent.click(screen.getByTestId('example-reveal'));
    expect(reveal).toHaveBeenCalledWith('note_1');
    expect(menu()).toBeNull();

    await openShortcut('资料夹');
    expect(rows()).toEqual(['打开', '---', '重命名', '---', '从桌面移除']);
    fireEvent.keyDown(document, { key: 'Escape' });
    await flush();

    await openBlank();
    // 当前根目录那一行是宿主的，排在所有行之后
    expect(rows()).toEqual(['添加快捷方式', '---', '设置桌面根目录', '---', 'example-stay', 'example-off [disabled]', 'example-flag', '(我的桌面)']);
    expect(seen.at(-1)).toMatchObject({ desktopRoot: ROOT });
    expect(seen.at(-1)).not.toHaveProperty('workbench');
    const flag = screen.getByTestId('example-flag');
    expect([flag.getAttribute('role'), flag.getAttribute('aria-checked'), Boolean(flag.querySelector('.wb-desk-menu-item-check svg'))]).toEqual(['menuitemcheckbox', 'true', true]);
    fireEvent.click(screen.getByTestId('example-off'));
    expect(reveal).not.toHaveBeenCalledWith('off');
    fireEvent.click(screen.getByTestId('example-stay'));
    expect(reveal).toHaveBeenCalledWith('stay');
    expect(menu()).not.toBeNull();
    fireEvent.click(screen.getByText('设置桌面根目录'));
    await flush();
    expect(menu()).toBeNull();
    expect(screen.getByTestId('folder-picker')).toBeTruthy();

    await act(async () => { await k.unload('example.finder-desktop'); });
    const calls = seen.length;
    await openShortcut('线代笔记');
    expect(rows()).toEqual(['打开', '---', '重命名', '---', '从桌面移除']);
    fireEvent.click(screen.getByText('从桌面移除'));
    await flush();
    expect(useDesktopStore.getState().shortcuts.map((shortcut) => shortcut.id)).toEqual(['s_folder']);
    expect(seen).toHaveLength(calls);
  });

  it('skips community rows that throw and reports throwing runs; the official rows stay', async () => {
    const k = await boot();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await install(k, defineUiPlugin({ meta: { id: 'example.broken-finder-rows' }, apply(ctx) {
      ctx.ui.contribute('app.menu', { id: 'finder-broken', order: 15, value: { menu: 'finder.desktopShortcut', items: () => { throw new Error('rows'); } } });
    } }));
    await install(k, defineUiPlugin({ meta: { id: 'example.broken-finder-run' }, apply(ctx) {
      ctx.ui.contribute('app.menu', { id: 'finder-throws', order: 40, value: { menu: 'finder.desktopShortcut', items: () => [
        { id: 'throws', label: 'throws', testId: 'example-finder-throws', run: () => { throw new Error('run'); } },
      ] } });
    } }));
    await renderView(k);

    await openShortcut('线代笔记');
    expect(rows()).toEqual(['打开', '---', '重命名', '---', '从桌面移除', 'example-finder-throws']);
    expect(k.errors.list('example.broken-finder-rows').map((report) => [report.entryId, report.phase, report.slot])).toContainEqual(['finder-broken', 'render', 'app.menu']);
    fireEvent.click(screen.getByTestId('example-finder-throws'));
    expect(k.errors.list('example.broken-finder-run').map((report) => [report.entryId, report.phase])).toEqual([['finder-throws', 'report']]);
    expect(menu()).toBeNull();

    await openShortcut('线代笔记');
    fireEvent.click(screen.getByText('重命名'));
    await flush();
    expect(document.querySelector<HTMLInputElement>('div[role="button"][aria-label="线代笔记"] input')?.value).toBe('线代笔记');
    error.mockRestore();
  });
});

describe('app.menu: resource library tab menu (FE-B9)', () => {
  const menu = () => document.querySelector<HTMLElement>('body > [role="menu"]');
  const rows = () => Array.from(menu()?.children ?? []).map((node) => {
    if (node.getAttribute('role') === 'separator') return '---';
    const button = node as HTMLButtonElement;
    return `${button.dataset.testid ?? button.textContent}${button.disabled ? ' [disabled]' : ''}`;
  });
  const tab = (title: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'))
    .find((node) => node.querySelector('span.truncate')?.textContent === title)!;
  const openOn = async (title: string) => {
    fireEvent.contextMenu(tab(title), { clientX: 120, clientY: 40 });
    await flush();
  };
  const calls: unknown[][] = [];
  const log = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };

  async function renderBar(k: UiKernel, split: boolean) {
    const props: TabBarProps = {
      tabs: TABS.map((item) => ({ ...item })),
      activeTabId: 't_note',
      onSwitch: log('switch'),
      onClose: log('close'),
      onTogglePin: log('togglePin'),
      onCloseOthers: log('closeOthers'),
      onCloseRight: log('closeRight'),
      ...(split ? { splitView: { rightTabId: 't_mindmap' }, onSplitView: log('split'), onCloseSplitView: log('closeSplit') } : {}),
    };
    render(<UiKernelProvider kernel={k}><TabBar {...props} /></UiKernelProvider>);
    await flush();
  }

  it('RF-W18-finder-menu-contributions: places community rows by order with the tab on the context (no workbench); rows run, then the menu closes; unload removes them', async () => {
    const k = await boot();
    const seen: Record<string, unknown>[] = [];
    await install(k, defineUiPlugin({ meta: { id: 'example.tab-menu' }, apply(ctx) {
      ctx.ui.contribute('app.menu', { id: 'tab-extra', order: 25, value: { menu: 'finder.tab', items: (context) => {
        seen.push({ ...context });
        return [
          { id: 'copy-path', label: 'Copy path', testId: 'example-copy-path', run: () => calls.push(['copyPath', context.dstuPath]) },
          ...(context.pinned ? [] : [{ id: 'later', label: 'Later', testId: 'example-later', disabled: !context.hasClosableToRight, run: () => calls.push(['later']) }]),
        ];
      } } });
    } }));
    await renderBar(k, true);

    await openOn('线代笔记');
    expect(rows()).toEqual(['在右侧打开', '固定标签页', 'example-copy-path', 'example-later', '---', '关闭', '关闭其他标签页', '关闭右侧标签页']);
    expect(seen.at(-1)).toMatchObject({
      tabId: 't_note', resourceType: 'note', resourceId: 'note_1', title: '线代笔记', dstuPath: '/note_1',
      active: true, pinned: false, splitRight: false, canSplit: true, hasClosableToRight: true,
    });
    expect(seen.at(-1)).not.toHaveProperty('workbench');
    calls.length = 0;
    fireEvent.click(screen.getByTestId('example-copy-path'));
    await flush();
    expect(calls).toEqual([['copyPath', '/note_1']]);
    expect(menu()).toBeNull();

    await openOn('导图');
    expect(rows()).toEqual(['关闭分屏', '固定标签页', 'example-copy-path', 'example-later [disabled]', '---', '关闭', '关闭其他标签页', '关闭右侧标签页 [disabled]']);
    expect(seen.at(-1)).toMatchObject({ tabId: 't_mindmap', active: false, splitRight: true, hasClosableToRight: false });
    calls.length = 0;
    fireEvent.click(screen.getByTestId('example-later'));
    await flush();
    expect(calls).toEqual([]);
    expect(menu()).toBeNull();

    await openOn('题目集');
    expect(rows()).toEqual(['在右侧打开', '取消固定', 'example-copy-path', '---', '关闭', '关闭其他标签页', '关闭右侧标签页 [disabled]']);
    fireEvent.keyDown(document, { key: 'Escape' });
    await flush();

    await act(async () => { await k.unload('example.tab-menu'); });
    const before = seen.length;
    await openOn('线代笔记');
    expect(rows()).toEqual(['在右侧打开', '固定标签页', '---', '关闭', '关闭其他标签页', '关闭右侧标签页']);
    calls.length = 0;
    fireEvent.click(screen.getByText('固定标签页'));
    await flush();
    expect(calls).toEqual([['togglePin', 't_note']]);
    expect(seen).toHaveLength(before);
  });

  it('gives no split actions where the host has no split view', async () => {
    const k = await boot();
    const seen: Record<string, unknown>[] = [];
    await install(k, defineUiPlugin({ meta: { id: 'example.tab-menu-small' }, apply(ctx) {
      ctx.ui.contribute('app.menu', { id: 'tab-probe', order: 5, value: { menu: 'finder.tab', items: (context) => {
        seen.push({ ...context });
        return [];
      } } });
    } }));
    await renderBar(k, false);
    await openOn('导图');
    expect(rows()).toEqual(['固定标签页', '---', '关闭', '关闭其他标签页', '关闭右侧标签页 [disabled]']);
    expect(seen.at(-1)).toMatchObject({ splitRight: false, canSplit: true, openSplitView: undefined, closeSplitView: undefined });
  });

  it('skips community rows that throw and reports throwing runs; the official rows stay', async () => {
    const k = await boot();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await install(k, defineUiPlugin({ meta: { id: 'example.broken-tab-rows' }, apply(ctx) {
      ctx.ui.contribute('app.menu', { id: 'tab-broken', order: 15, value: { menu: 'finder.tab', items: () => { throw new Error('rows'); } } });
    } }));
    await install(k, defineUiPlugin({ meta: { id: 'example.broken-tab-run' }, apply(ctx) {
      ctx.ui.contribute('app.menu', { id: 'tab-throws', order: 40, value: { menu: 'finder.tab', items: () => [
        { id: 'throws', label: 'throws', testId: 'example-tab-throws', run: () => { throw new Error('run'); } },
      ] } });
    } }));
    await renderBar(k, true);

    await openOn('线代笔记');
    expect(rows()).toEqual(['在右侧打开', '固定标签页', '---', '关闭', '关闭其他标签页', '关闭右侧标签页', 'example-tab-throws']);
    expect(k.errors.list('example.broken-tab-rows').map((report) => [report.entryId, report.phase, report.slot])).toContainEqual(['tab-broken', 'render', 'app.menu']);
    fireEvent.click(screen.getByTestId('example-tab-throws'));
    await flush();
    expect(k.errors.list('example.broken-tab-run').map((report) => [report.entryId, report.phase])).toEqual([['tab-throws', 'report']]);
    expect(menu()).toBeNull();

    await openOn('线代笔记');
    calls.length = 0;
    fireEvent.click(screen.getByText('关闭'));
    await flush();
    expect(calls).toEqual([['close', 't_note']]);
    error.mockRestore();
  });
});
