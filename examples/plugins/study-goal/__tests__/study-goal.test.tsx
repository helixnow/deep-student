// @vitest-environment node
// Host 测试宿主按 file: URL 定位模块与 package.json，jsdom 环境下 import.meta.url 不是 file:；DOM 由第一个 import 装好。
// react-dom 由根 vitest.setup.ts 在装 DOM 之前加载，文本输入框的 onChange 在这里触发不了，所以界面只用点击交互。
/**
 * example.study-goal 端到端：Host 半经真实 profile 装载器装进测试宿主，UI 半装进真实 UI 内核。
 * 设置分区经官方设置外壳的 settingsNavigation / SectionContent 渲染；命令登记进真实的命令面板注册表，
 * 由它执行并发出通知；资源菜单行经学习资源库的 LearningHubContextMenu（连同官方 content 插件的行）渲染。
 */
import '../../../testing/with-dom';
import { act, fireEvent, render, within } from '@testing-library/react';
import i18next, { type TFunction } from 'i18next';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import React, { Suspense, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandRegistry } from '../../../../src/command-palette/registry/commandRegistry';
import type { DependencyResolver } from '../../../../src/command-palette/registry/types';
import {
  LearningHubContextMenu, type LearningHubContextMenuProps,
} from '../../../../src/features/learning-hub/components/LearningHubContextMenu';
import type { SettingsSection, SettingsSectionPropsFactories } from '../../../../src/ui-kernel/contracts/settings';
import { createLegacyRegistryAdapters } from '../../../../src/ui-kernel/legacy-adapters';
import { UiKernelProvider, useSlot } from '../../../../src/ui-kernel/react';
import { memoryStorageBackend } from '../../../../src/ui-kernel/services/storage';
import { settingsNavigation } from '../../../../src/ui-plugins/official/settings/navigation';
import { SectionContent } from '../../../../src/ui-plugins/official/settings/SectionContent';
import contentPlugin from '../../../../src/ui-plugins/official/content/index';
import { createUiKernel, examplePath, loadExample, pinLocalNoon } from '../../../testing/harness';
import { localDate } from '../day';
import { DATABASE_FILE, MAX_MINUTES_PER_DAY } from '../index.ts';
import uiHalf, { DEFAULT_GOAL, GOAL_CHOICES, GOAL_KEY, LOG_COMMAND_ID, LOG_MINUTES, MENU_ROW_ID, SECTION_ID } from '../ui';

// 学习资源库菜单在浏览器里用到的媒体查询、液态玻璃、安卓返回键、桌面快捷方式 store 换成桩，
// 与 src/ui-plugins/official/content/__tests__/community-menu-v1.test.tsx 相同。
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('@/features/workbench/core/liquidGlassLens', () => ({ useLiquidGlassLens() {}, WallpaperReplica: () => null }));
vi.mock('@/app/navigation/androidBackCoordinator', () => ({ registerBackHandler: () => () => {}, BACK_PRIORITY: { overlay: 1 } }));
vi.mock('@/features/learning-hub/stores/desktopStore', () => ({
  useDesktopStore: (select: (value: unknown) => unknown) => select({
    hasResourceShortcut: () => false, hasFolderShortcut: () => false, addResourceShortcut: () => {}, addFolderShortcut: () => {},
  }),
}));

const ID = 'example.study-goal';
const PROFILE = examplePath('study-goal', 'test.profile.json');

let cleanups: (() => Promise<void>)[] = [];
beforeEach(pinLocalNoon);
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

async function setup() {
  const { host, result } = await loadExample(PROFILE, { storage: true });
  const i18n = i18next.createInstance();
  await i18n.init({ lng: 'zh-CN', fallbackLng: 'en-US', resources: {}, interpolation: { escapeValue: false } });
  const storage = memoryStorageBackend();
  const { commands } = createLegacyRegistryAdapters({ commandRegistry, blockRegistry: {} as never, appRegistry: {} as never });
  const { kernel } = createUiKernel(host, {
    commands,
    storage,
    // 与 src/ui-kernel/bootstrap.ts 的生产适配器相同：文案写进 i18next，语言链取 i18next 的。
    i18n: {
      addBundle: (lng, ns, resources) => {
        i18n.addResourceBundle(lng, ns, resources, true, true);
        return () => i18n.removeResourceBundle(lng, ns);
      },
      languages: () => i18n.languages,
    },
  });
  cleanups.push(async () => {
    await kernel.dispose();
    await host.dispose();
  });
  return { host, result, kernel, storage, i18n, t: i18n.t.bind(i18n) as TFunction };
}

const call = (host: Awaited<ReturnType<typeof setup>>['host'], method: string, ...args: unknown[]) =>
  host.invoke('plugin:host|call', { caller: ID, service: 'exampleStudyGoal', method, args });

describe('example.study-goal: Host half', () => {
  it('passes the community manifest screening and provides the service named after its id', async () => {
    const { host, result } = await setup();
    expect(result.degraded).toEqual([]);
    expect(result.installed.map((p) => p.id)).toEqual([ID]);
    expect(host.ctx.get('exampleStudyGoal')).toBeDefined();
  });

  it('accumulates minutes per day over plugin:host|call and rejects invalid input with the CommandError value', async () => {
    const { host } = await setup();
    await expect(call(host, 'day', '2026-11-07')).resolves.toEqual({ date: '2026-11-07', minutes: 0 });
    await expect(call(host, 'log', '2026-11-07', 25)).resolves.toEqual({ date: '2026-11-07', minutes: 25 });
    await expect(call(host, 'log', '2026-11-07', 30)).resolves.toEqual({ date: '2026-11-07', minutes: 55 });
    await expect(call(host, 'day', '2026-11-08')).resolves.toEqual({ date: '2026-11-08', minutes: 0 });

    await expect(call(host, 'log', '2026-11-07', 0)).rejects
      .toEqual({ error_type: 'Validation', message: 'minutes must be a positive integer, got 0', details: null });
    await expect(call(host, 'log', '11/07', 5)).rejects.toMatchObject({ error_type: 'Validation', message: 'date must be YYYY-MM-DD, got "11/07"' });
    await expect(call(host, 'log', '2026-11-07', MAX_MINUTES_PER_DAY)).rejects
      .toMatchObject({ error_type: 'Validation', message: `2026-11-07 would exceed ${MAX_MINUTES_PER_DAY} minutes` });
    await expect(call(host, 'day', '2026-11-07')).resolves.toEqual({ date: '2026-11-07', minutes: 55 });
    await expect(call(host, 'reset')).rejects.toMatchObject({ error_type: 'Validation' });
  });

  it('keeps the minutes in its own SQLite file under <dataDir>/plugins/<id>/, so they survive a Host restart', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'w27-study-goal-'));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const first = await loadExample(PROFILE, { storage: true, dataDir });
    await call(first.host, 'log', '2026-11-07', 25);
    await first.host.dispose();
    expect(existsSync(path.join(dataDir, 'plugins', ID, DATABASE_FILE))).toBe(true);

    const second = await loadExample(PROFILE, { storage: true, dataDir });
    cleanups.push(() => second.host.dispose());
    expect(second.result.degraded).toEqual([]);
    await expect(call(second.host, 'day', '2026-11-07')).resolves.toEqual({ date: '2026-11-07', minutes: 25 });
    await expect(call(second.host, 'log', '2026-11-07', MAX_MINUTES_PER_DAY)).rejects.toMatchObject({ error_type: 'Validation' });
    await expect(call(second.host, 'day', '2026-11-07')).resolves.toEqual({ date: '2026-11-07', minutes: 25 });
  });

  it('is degraded, not started, when no plugin provides storage', async () => {
    const { host, result } = await loadExample(PROFILE);
    cleanups.push(() => host.dispose());
    expect(result.installed).toEqual([]);
    expect(result.degraded).toEqual([{ id: ID, reason: 'SERVICE_MISSING: missing service "storage"' }]);
    expect(host.ctx.get('exampleStudyGoal')).toBeUndefined();
  });
});

describe('example.study-goal: settings section', () => {
  function Settings({ t, initialTab }: { t: TFunction; initialTab: string }) {
    const entries = useSlot<SettingsSection>('settings.sections');
    const [activeTab, setActiveTab] = useState(initialTab);
    const { sidebarNavItems } = settingsNavigation(entries, t, { isMobile: false });
    const entry = entries.find((item) => item.key === activeTab);
    const getProps = new Proxy({}, { get: () => () => ({}) }) as SettingsSectionPropsFactories;
    return <>
      <nav>{sidebarNavItems.map((item) => <button key={item.value} onClick={() => setActiveTab(item.value)}>{item.label}</button>)}</nav>
      <Suspense fallback={<p>pending section</p>}>
        {entry && <SectionContent entry={entry} getProps={getProps} isMobile={false} t={t} />}
      </Suspense>
    </>;
  }

  it('appears in the settings sidebar and renders the goal from plugin storage with progress from the Host half', async () => {
    const { host, kernel, storage, t } = await setup();
    expect(await kernel.install(uiHalf)).toBe(true);
    const entry = kernel.slots.get<SettingsSection>('settings.sections', SECTION_ID);
    expect(entry).toMatchObject({ owner: ID, origin: 'community', value: { titleKey: `${ID}:title` } });
    await call(host, 'log', localDate(), 40);

    const view = render(<UiKernelProvider kernel={kernel}><Settings t={t} initialTab="none" /></UiKernelProvider>);
    const screen = within(view.container);
    fireEvent.click(screen.getByRole('button', { name: '学习目标' }));
    expect((await screen.findByRole('status')).textContent).toBe(`今天已学 40 / ${DEFAULT_GOAL} 分钟`);
    const goals = within(screen.getByRole('radiogroup', { name: '每日目标' }));
    expect(goals.getAllByRole('radio').map((radio) => [radio.textContent, radio.getAttribute('aria-checked')]))
      .toEqual(GOAL_CHOICES.map((minutes) => [`${minutes} 分钟`, String(minutes === DEFAULT_GOAL)]));

    await act(async () => fireEvent.click(goals.getByRole('radio', { name: '30 分钟' })));
    expect(storage.dump()).toEqual({ [`ds:plugin:${ID}:${GOAL_KEY}`]: '30' });
    expect(screen.getByRole('status').textContent).toBe('今天已学 40 分钟，目标完成');
    expect(goals.getByRole('radio', { name: '30 分钟' }).getAttribute('aria-checked')).toBe('true');
    view.unmount();

    await kernel.unload(ID);
    expect(kernel.slots.get('settings.sections', SECTION_ID)).toBeUndefined();
  });

  it('follows a log made outside the section without remounting the mounted section', async () => {
    const { kernel, t } = await setup();
    await kernel.install(uiHalf);
    const view = render(<UiKernelProvider kernel={kernel}><Settings t={t} initialTab={SECTION_ID} /></UiKernelProvider>);
    const screen = within(view.container);
    const status = await screen.findByRole('status');
    expect(status.textContent).toBe(`今天已学 0 / ${DEFAULT_GOAL} 分钟`);

    // 命令面板与资源菜单行走同一个 store；这里经真实命令注册表执行，不经过分区的渲染树。
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await act(async () => {
      await commandRegistry.execute(LOG_COMMAND_ID, { showNotification: vi.fn() } as unknown as DependencyResolver);
    });
    log.mockRestore();

    expect(screen.getByRole('status').textContent).toBe(`今天已学 ${LOG_MINUTES} / ${DEFAULT_GOAL} 分钟`);
    expect(screen.getByRole('status')).toBe(status);
    view.unmount();
  });

  it('keeps the settings shell alive when the Host half rejects', async () => {
    const { host, kernel, t } = await setup();
    await kernel.install(uiHalf);
    await host.unload(ID);

    const { findByRole, getByRole, unmount } = render(<UiKernelProvider kernel={kernel}><Settings t={t} initialTab={SECTION_ID} /></UiKernelProvider>);
    expect((await findByRole('alert')).textContent).toBe('unknown service "exampleStudyGoal"');
    expect(getByRole('button', { name: '学习目标' })).toBeTruthy();
    unmount();
  });
});

describe('example.study-goal: command', () => {
  it('logs a pomodoro through the Host half and reports the result through the command palette', async () => {
    const { host, kernel, storage } = await setup();
    await kernel.install(uiHalf);
    expect(commandRegistry.getById(LOG_COMMAND_ID)).toMatchObject({ name: `${ID}:log`, category: 'learning' });
    const showNotification = vi.fn();
    const deps = { showNotification } as unknown as DependencyResolver;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await commandRegistry.execute(LOG_COMMAND_ID, deps);
    expect(showNotification).toHaveBeenLastCalledWith('success', `今天已学 ${LOG_MINUTES} / ${DEFAULT_GOAL} 分钟`);
    storage.setItem(`ds:plugin:${ID}:${GOAL_KEY}`, '50');
    await commandRegistry.execute(LOG_COMMAND_ID, deps);
    expect(showNotification).toHaveBeenLastCalledWith('success', `今天已学 ${2 * LOG_MINUTES} 分钟，目标完成`);
    await expect(call(host, 'day', localDate())).resolves.toEqual({ date: localDate(), minutes: 2 * LOG_MINUTES });

    await call(host, 'log', localDate(), MAX_MINUTES_PER_DAY - 2 * LOG_MINUTES);
    await commandRegistry.execute(LOG_COMMAND_ID, deps);
    expect(showNotification).toHaveBeenLastCalledWith('error', `记录失败：${localDate()} would exceed ${MAX_MINUTES_PER_DAY} minutes`);
    log.mockRestore();

    await kernel.unload(ID);
    expect(commandRegistry.getById(LOG_COMMAND_ID)).toBeUndefined();
  });
});

// 根测试配置把 react-i18next 换成只认官方中文语言包的桩（tests/ct/mocks/react-i18next.tsx），菜单里插件命名空间的键原样显示。
// 生产里菜单的 t 与社区文案是同一个 i18next 实例（src/ui-kernel/bootstrap.ts），文案经本测试按同样方式写入的实例核对。
describe('example.study-goal: resource menu', () => {
  type Target = LearningHubContextMenuProps['target'];
  const note = { id: 'note-1', title: 'Chapter 1', type: 'note', path: '/chapter-1' };
  const onNote = { type: 'resource', resource: note } as Target;
  const ROW_TEXT = '学完了，记一个番茄钟';

  async function menuSetup() {
    const env = await setup();
    await env.kernel.install(contentPlugin, { origin: 'builtin' });
    expect(await env.kernel.install(uiHalf)).toBe(true);
    const onOpenChange = vi.fn();
    /** 菜单经 portal 渲染到 document.body。 */
    const open = (target: Target, isTrashView = false) => {
      const view = render(
        <UiKernelProvider kernel={env.kernel}>
          <LearningHubContextMenu open position={{ x: 0, y: 0 }} target={target} dataView="resource"
            isTrashView={isTrashView} onOpenChange={onOpenChange} />
        </UiKernelProvider>,
      );
      const body = within(document.body);
      const rows = () => body.queryAllByRole('menuitem');
      return { view, body, rows, row: () => rows().find((item) => item.textContent?.startsWith(`${ID}:menu_log`)) };
    };
    /** 本插件那一行此刻的标签：菜单每次打开时对 labelKey / labelParams 求值。 */
    const label = () => {
      const row = env.kernel.slots.list('resource.contextMenu').find((item) => item.id === MENU_ROW_ID)!.value;
      const key = typeof row.labelKey === 'function' ? row.labelKey(undefined as never) : row.labelKey!;
      return { key, text: env.i18n.t(key, row.labelParams?.(undefined as never) ?? {}) };
    };
    return { ...env, onOpenChange, open, label };
  }

  it('adds a row on resources of the learning hub that closes the menu, logs a pomodoro through the Host half and then shows today\'s minutes', async () => {
    const { host, kernel, onOpenChange, open, label } = await menuSetup();
    expect(kernel.slots.list('resource.contextMenu').filter((entry) => entry.origin === 'community')
      .map((entry) => [entry.id, entry.owner])).toEqual([[MENU_ROW_ID, ID]]);

    let menu = open(onNote);
    expect(menu.rows().length).toBeGreaterThan(1);
    expect(label()).toEqual({ key: `${ID}:menu_log`, text: ROW_TEXT });
    expect(menu.row()?.textContent).toBe(`${ID}:menu_log`);
    fireEvent.click(menu.row()!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await vi.waitFor(() => expect(label()).toEqual({ key: `${ID}:menu_log_today`, text: `${ROW_TEXT}（今天已学 ${LOG_MINUTES} 分钟）` }));
    await expect(call(host, 'day', localDate())).resolves.toEqual({ date: localDate(), minutes: LOG_MINUTES });
    menu.view.unmount();

    menu = open(onNote);
    expect(menu.row()?.textContent).toBe(`${ID}:menu_log_today`);
    menu.view.unmount();

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await commandRegistry.execute(LOG_COMMAND_ID, { showNotification: vi.fn() } as unknown as DependencyResolver);
    log.mockRestore();
    expect(label().text).toBe(`${ROW_TEXT}（今天已学 ${2 * LOG_MINUTES} 分钟）`);
    expect(kernel.errors.count(ID)).toBe(0);
  });

  it('stays off folders, folder resources, empty space and the trash; reports a Host rejection; goes away on unload', async () => {
    const { host, kernel, onOpenChange, open } = await menuSetup();
    const folder = { id: 'folder-1', title: 'Folder' };
    const others: [Target, boolean][] = [
      [{ type: 'folder', folder: { folder } } as Target, false],
      [{ type: 'resource', resource: { ...note, id: 'folder-2', type: 'folder' } } as Target, false],
      [{ type: 'empty' }, false],
      [onNote, true],
    ];
    for (const [target, isTrashView] of others) {
      const menu = open(target, isTrashView);
      expect(menu.body.getByRole('menu')).toBeTruthy();
      expect(menu.row()).toBeUndefined();
      menu.view.unmount();
    }

    await host.unload(ID);
    let menu = open(onNote);
    fireEvent.click(menu.row()!);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    await vi.waitFor(() => expect(kernel.errors.count(ID)).toBe(1));
    expect(kernel.errors.list(ID)).toMatchObject([
      { phase: 'report', slot: 'resource.contextMenu', entryId: MENU_ROW_ID, message: 'unknown service "exampleStudyGoal"' },
    ]);
    menu.view.unmount();

    await kernel.unload(ID);
    expect(kernel.slots.list('resource.contextMenu').filter((entry) => entry.origin === 'community')).toEqual([]);
    menu = open(onNote);
    expect(menu.rows().length).toBeGreaterThan(0);
    expect(menu.row()).toBeUndefined();
    menu.view.unmount();
  });
});
