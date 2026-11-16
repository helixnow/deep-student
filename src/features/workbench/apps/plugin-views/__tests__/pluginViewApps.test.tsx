/**
 * 社区插件视图 → 学习桌面应用：镜像进 appRegistry、出现在「全部应用」、
 * `kernel.navigation.navigate(viewKey)` 经 WorkbenchEventBridge 打开窗口、窗口内渲染插件组件。
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));
vi.mock('@/features/chat/core/session/sessionManager', () => ({ sessionManager: { getCurrentSessionId: () => null } }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/command-palette/CommandPaletteProvider', () => ({ useCommandPaletteSafe: () => null }));

import { defineUiPlugin, UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider, useT } from '@/ui-kernel/react';
import { appRegistry } from '../../../core/appRegistry';
import { useWindowStore } from '../../../core/windowStore';
import { workbenchBus } from '../../../core/workbenchBus';
import { AppsPanel } from '../../../components/AppsPanel';
import { closeAppsPanel, openAppsPanel } from '../../../components/appsPanelStore';
import WorkbenchEventBridge from '../../../components/WorkbenchEventBridge';
import {
  mirrorPluginViewApps,
  pluginViewAppTypeId,
  pluginViewNameKey,
  resolvePluginViewAppTypeId,
} from '../register';
import { PluginViewAppWindow } from '../PluginViewAppWindow';
import type { AppWindowProps } from '../../../core/types';

const PLUGIN_ID = 'workshop.plugin-recall';
const VIEW_KEY = 'recall';
const TYPE_ID = pluginViewAppTypeId(VIEW_KEY);

function RecallView() {
  const t = useT();
  return <section data-testid="recall-view">{t('title')}</section>;
}

const recallPlugin = defineUiPlugin({
  meta: { id: PLUGIN_ID, version: '1.0.0' },
  apply(ctx) {
    ctx.ui.i18n.addBundles({ 'zh-CN': { title: '每日回忆' }, 'en-US': { title: 'Daily recall' } });
    ctx.ui.views.register({ id: VIEW_KEY, titleKey: 'title', component: RecallView });
  },
});

function makeKernel() {
  return new UiKernel({
    navigate: ({ view, params }) => {
      window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', { detail: { ...params, view } }));
    },
    i18n: { addBundle: () => () => undefined },
  });
}

function windowsOf(typeId: string) {
  return Object.values(useWindowStore.getState().windows).filter((w) => w.typeId === typeId);
}

const windowProps: AppWindowProps = {
  windowId: 'w1',
  instanceKey: null,
  launchPayload: undefined,
  isActive: true,
  isVisible: true,
  onTitleChange: () => {},
  requestClose: () => {},
};

let kernel: UiKernel;
let stopMirror: (() => void) | undefined;

beforeAll(() => {
  workbenchBus.setEnabled(true);
});

beforeEach(() => {
  useWindowStore.setState({
    windows: {},
    focusStack: [],
    lifecycles: {},
    launchPayloads: {},
    tilingRatios: {},
    desktopSize: { w: 1600, h: 900 },
  });
  closeAppsPanel();
  kernel = makeKernel();
});

afterEach(async () => {
  cleanup();
  stopMirror?.();
  stopMirror = undefined;
  await kernel.dispose();
});

describe('plugin view apps (learning desktop)', () => {
  it('mirrors community views into the app registry and drops them when the plugin unloads', async () => {
    stopMirror = mirrorPluginViewApps(kernel);
    expect(appRegistry.get(TYPE_ID)).toBeUndefined();

    await kernel.install(recallPlugin);
    const def = appRegistry.get(TYPE_ID);
    expect(def).toMatchObject({ typeId: 'plugin-view.recall', nameKey: `${PLUGIN_ID}:title`, instanceMode: 'single' });
    expect(def?.showInLauncher).not.toBe(false);
    expect(resolvePluginViewAppTypeId(VIEW_KEY)).toBe(TYPE_ID);

    await kernel.unload(PLUGIN_ID);
    expect(appRegistry.get(TYPE_ID)).toBeUndefined();
    expect(resolvePluginViewAppTypeId(VIEW_KEY)).toBeNull();
  });

  it('does not mirror builtin views', async () => {
    stopMirror = mirrorPluginViewApps(kernel);
    await kernel.install(defineUiPlugin({
      meta: { id: 'dstu.official-view' },
      apply: (ctx) => { ctx.ui.views.register({ id: 'official-view', titleKey: 't', component: () => null }); },
    }), { origin: 'builtin' });
    expect(appRegistry.get(pluginViewAppTypeId('official-view'))).toBeUndefined();
  });

  it('derives the title key from the plugin namespace unless already qualified', () => {
    expect(pluginViewNameKey({ owner: 'a:b', value: { id: 'v', titleKey: 'title', component: () => null } })).toBe('a_b:title');
    expect(pluginViewNameKey({ owner: 'x', value: { id: 'v', titleKey: 'ns:k', component: () => null } })).toBe('ns:k');
  });

  it('opens the plugin app window when kernel.navigation.navigate(viewKey) runs in the workbench', async () => {
    stopMirror = mirrorPluginViewApps(kernel);
    await kernel.install(recallPlugin);
    render(<WorkbenchEventBridge />);

    act(() => { kernel.navigation.navigate('dstu.plugin-manager', VIEW_KEY); });
    expect(windowsOf(TYPE_ID)).toHaveLength(1);

    // single 实例：再次打开聚焦已有窗口而不是新开
    act(() => { kernel.navigation.navigate('dstu.plugin-manager', VIEW_KEY); });
    expect(windowsOf(TYPE_ID)).toHaveLength(1);
  });

  it('ignores NAVIGATE_TO_VIEW for views that are not plugin apps', () => {
    stopMirror = mirrorPluginViewApps(kernel);
    render(<WorkbenchEventBridge />);
    act(() => { window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', { detail: { view: 'settings' } })); });
    expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(0);
  });

  it('lists the plugin app in 全部应用 and launches it from there', async () => {
    stopMirror = mirrorPluginViewApps(kernel);
    await kernel.install(recallPlugin);
    render(<AppsPanel />);
    act(() => openAppsPanel());

    const item = await screen.findByTestId(`wb-apps-item-${TYPE_ID}`);
    expect(item.querySelector('[data-testid="wb-plugin-view-icon"]')).not.toBeNull();
    fireEvent.click(item);
    expect(windowsOf(TYPE_ID)).toHaveLength(1);
  });

  it('renders the plugin view inside the window with its plugin scope, and a notice once it is gone', async () => {
    await kernel.install(recallPlugin);
    render(
      <UiKernelProvider kernel={kernel}>
        <PluginViewAppWindow {...windowProps} viewKey={VIEW_KEY} kernel={kernel} />
      </UiKernelProvider>,
    );
    const host = await screen.findByTestId('wb-plugin-view-window');
    expect(host.getAttribute('data-plugin-owner')).toBe(PLUGIN_ID);
    expect(await screen.findByTestId('recall-view')).toBeTruthy();

    await act(async () => { await kernel.unload(PLUGIN_ID); });
    expect(screen.getByTestId('wb-plugin-view-missing')).toBeTruthy();
  });
});

describe('OPEN_NOTES in the learning desktop', () => {
  it('launches the notes workspace', () => {
    const launch = vi.spyOn(workbenchBus, 'launch').mockReturnValue(null);
    try {
      render(<WorkbenchEventBridge />);
      act(() => { window.dispatchEvent(new CustomEvent('OPEN_NOTES')); });
      expect(launch).toHaveBeenCalledWith(expect.objectContaining({ typeId: 'notes' }));
    } finally {
      launch.mockRestore();
    }
  });
});
