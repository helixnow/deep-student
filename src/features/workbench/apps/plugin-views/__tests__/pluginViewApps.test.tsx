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
import { observeAgentWindow, waitForAgentCondition } from '../../../core/agentRuntime';
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
import { registerPluginManagerWorkshop } from '@/features/plugin-manager/workshop';
import type { AgentAppContext, AppWindowProps } from '../../../core/types';

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
  it('supports the existing Workbench observe and state_equals wait path for the exact mounted candidate', async () => {
    stopMirror = mirrorPluginViewApps(kernel);
    await kernel.install(recallPlugin);
    const windowId = useWindowStore.getState().openWindow({ typeId: TYPE_ID, instanceKey: null, title: 'Recall' });
    render(<div data-wb-window="" data-wb-window-id={windowId} data-window-id={windowId}>
      <PluginViewAppWindow {...windowProps} windowId={windowId} viewKey={VIEW_KEY} kernel={kernel} />
    </div>);
    const observation = await observeAgentWindow({ windowId });
    expect(observation.state).toMatchObject({ pluginId: PLUGIN_ID, version: '1.0.0', status: 'ready' });
    expect(observation.availableActions).toEqual([]);
    const result = await waitForAgentCondition({ windowId, conditions: [
      { kind: 'state_equals', path: 'pluginId', value: PLUGIN_ID },
      { kind: 'state_equals', path: 'version', value: '1.0.0' },
      { kind: 'state_equals', path: 'status', value: 'ready' },
    ], timeoutMs: 0 });
    expect(result.matched).toBe(true);
    expect(result.observation.state.text).toBe(observation.state.text);
  });

  it('observes the rendered candidate and live control state without exposing write capabilities', async () => {
    function InteractiveView() {
      const [name, setName] = React.useState('Ada');
      const [mode, setMode] = React.useState('daily');
      const [count, setCount] = React.useState(0);
      return <section>
        <label>Name<input value={name} onChange={event => setName(event.target.value)} /></label>
        <label>Mode<select value={mode} onChange={event => setMode(event.target.value)}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
        <label>Secret<input type="password" defaultValue="do-not-expose" /></label>
        <button onClick={() => setCount(value => value + 1)}>Review</button>
        <button disabled>Unavailable</button><button hidden>Hidden action</button>
        <output>{name}:{mode}:{count}</output>
      </section>;
    }
    stopMirror = mirrorPluginViewApps(kernel);
    await kernel.install(defineUiPlugin({ meta: { id: PLUGIN_ID, version: '2.0.0' }, apply(ctx) {
      ctx.ui.views.register({ id: VIEW_KEY, titleKey: 'title', component: InteractiveView });
    } }));
    const manifest = appRegistry.get(TYPE_ID)!.agentManifest!;
    const ctx: AgentAppContext = { windowId: 'w1', typeId: TYPE_ID, instanceKey: null };
    expect((await manifest.observe!(ctx)).state).toMatchObject({ status: 'missing', version: null });
    render(<div data-wb-window="" data-window-id="w1"><PluginViewAppWindow {...windowProps} viewKey={VIEW_KEY} kernel={kernel} /></div>);
    const first = await manifest.observe!(ctx);
    expect(first.state).toMatchObject({ pluginId: PLUGIN_ID, viewId: VIEW_KEY, version: '2.0.0', status: 'ready', errors: [] });
    expect(first.state?.text).toContain('Ada:daily:0');
    expect(first.affordances?.find(control => control.label === 'Name')).toMatchObject({ value: 'Ada', actions: [] });
    expect(first.affordances?.find(control => control.label === 'Secret')).not.toHaveProperty('value');
    expect(JSON.stringify(first)).not.toContain('do-not-expose');
    expect(first.affordances?.some(control => control.label === 'Hidden action')).toBe(false);
    expect(first.affordances?.find(control => control.label === 'Unavailable')?.disabled).toBe(true);
    expect(first.availableActions).toEqual([]);
    expect(manifest.capabilities).toEqual([]);
    expect(manifest.execute).toBeUndefined();
    expect((await manifest.observe!(ctx)).revision).toBe(first.revision);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Grace' } });
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'weekly' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const next = await manifest.observe!(ctx);
    expect(next.state?.text).toContain('Grace:weekly:1');
    expect(next.revision).not.toBe(first.revision);
    expect(next.affordances?.find(control => control.label === 'Name')?.ref).toBe(first.affordances?.find(control => control.label === 'Name')?.ref);
    expect((await manifest.observe!({ ...ctx, windowId: 'other-window' })).state).toMatchObject({ status: 'missing', version: null, text: '' });

    // A version marker from a prior mounted page must never certify the newly loaded candidate.
    screen.getByTestId('wb-plugin-view-window').dataset.pluginVersion = '1.0.0';
    expect((await manifest.observe!(ctx)).state).toMatchObject({ status: 'loading', version: '1.0.0', controls: [] });
  });

  it('reports a real render boundary failure instead of claiming that the candidate is ready', async () => {
    stopMirror = mirrorPluginViewApps(kernel);
    await kernel.install(defineUiPlugin({ meta: { id: PLUGIN_ID, version: '3.0.0' }, apply(ctx) {
      ctx.ui.views.register({ id: VIEW_KEY, titleKey: 'title', component: () => { throw new Error('render exploded'); } });
    } }));
    const manifest = appRegistry.get(TYPE_ID)!.agentManifest!;
    render(<div data-wb-window="" data-window-id="w1"><PluginViewAppWindow {...windowProps} viewKey={VIEW_KEY} kernel={kernel} /></div>);
    await screen.findByTestId('wb-plugin-view-failed');
    const observation = await manifest.observe!({ windowId: 'w1', typeId: TYPE_ID, instanceKey: null });
    expect(observation.state).toMatchObject({ status: 'failed', version: '3.0.0', controls: [], errors: ['render exploded'] });
    expect(observation.availableActions).toEqual([]);
  });

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

  it('ignores NAVIGATE_TO_VIEW for views that are not plugin or built-in workbench apps', () => {
    stopMirror = mirrorPluginViewApps(kernel);
    render(<WorkbenchEventBridge />);
    act(() => { window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', { detail: { view: 'data-management' } })); });
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

  it('shows workshop refine CTA for workshop-owned plugin views and calls onModify', async () => {
    const onModify = vi.fn();
    const unregister = registerPluginManagerWorkshop({
      onCreate: vi.fn(),
      onModify,
      creations: null,
    });
    try {
      await kernel.install(recallPlugin);
      render(
        <UiKernelProvider kernel={kernel}>
          <PluginViewAppWindow {...windowProps} viewKey={VIEW_KEY} kernel={kernel} />
        </UiKernelProvider>,
      );
      const refineButton = await screen.findByTestId('workshop-refine-with-ai');
      fireEvent.click(refineButton);
      expect(onModify).toHaveBeenCalledWith(PLUGIN_ID);
    } finally {
      unregister();
    }
  });

  it('S4-18: localizes the workshop refine button in en-US and zh-CN with symmetric plugin_manager locale keys', async () => {
    const i18next = (await import('i18next')).default;
    const { i18n: mockReactI18n } = await import('react-i18next');
    const zhPluginManager = (await import('@/locales/zh-CN/plugin_manager.json')).default;
    const enPluginManager = (await import('@/locales/en-US/plugin_manager.json')).default;

    const collectKeys = (obj: Record<string, unknown>, prefix = ''): string[] =>
      Object.keys(obj)
        .sort()
        .flatMap((key) => {
          const full = prefix ? `${prefix}.${key}` : key;
          const val = obj[key];
          return val && typeof val === 'object' && !Array.isArray(val)
            ? collectKeys(val as Record<string, unknown>, full)
            : [full];
        });
    expect(collectKeys(zhPluginManager)).toEqual(collectKeys(enPluginManager));

    const realI18n = i18next.createInstance();
    await realI18n.init({
      lng: 'en-US',
      fallbackLng: 'zh-CN',
      resources: {
        'zh-CN': { plugin_manager: zhPluginManager },
        'en-US': { plugin_manager: enPluginManager },
      },
      interpolation: { escapeValue: false },
    });
    expect(realI18n.t('plugin_manager:workshop.actions.refineWithAi', { lng: 'en-US' })).toBe('Refine with AI');
    expect(realI18n.t('plugin_manager:workshop.actions.refineWithAi', { lng: 'zh-CN' })).toBe('让 AI 优化');
    expect(realI18n.t('plugin_manager:workshop.quickBarAriaLabel', { lng: 'en-US' })).toBe('Plugin Workshop quick bar');
    expect(realI18n.t('plugin_manager:workshop.quickBarAriaLabel', { lng: 'zh-CN' })).toBe('插件工坊快捷栏');

    const prevLang = mockReactI18n.language;
    const unregister = registerPluginManagerWorkshop({
      onCreate: vi.fn(),
      onModify: vi.fn(),
      creations: null,
    });
    try {
      await kernel.install(recallPlugin);
      mockReactI18n.language = 'en-US';
      const { rerender } = render(
        <UiKernelProvider kernel={kernel}>
          <PluginViewAppWindow {...windowProps} viewKey={VIEW_KEY} kernel={kernel} />
        </UiKernelProvider>,
      );
      expect(await screen.findByTestId('workshop-refine-with-ai')).toHaveTextContent('Refine with AI');

      mockReactI18n.language = 'zh-CN';
      rerender(
        <UiKernelProvider kernel={kernel}>
          <PluginViewAppWindow {...windowProps} viewKey={VIEW_KEY} kernel={kernel} />
        </UiKernelProvider>,
      );
      expect(await screen.findByTestId('workshop-refine-with-ai')).toHaveTextContent('让 AI 优化');
    } finally {
      mockReactI18n.language = prevLang || 'zh-CN';
      unregister();
    }
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
