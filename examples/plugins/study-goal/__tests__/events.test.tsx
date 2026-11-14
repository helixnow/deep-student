// @vitest-environment node
/**
 * example.study-goal 的事件闭环：真实 Host 半提交后经 `ctx.uiEvents.emit` 发出，UI 半的 `ctx.ui.host.on` 收到，
 * 已经挂载的设置分区随插件 store 重渲染。事件传输在测试里由外壳替身搬运真实 Host 出站事件（生产是 Tauri `listen`）。
 */
import '../../../testing/with-dom';
import { act, render, within } from '@testing-library/react';
import i18next, { type TFunction } from 'i18next';
import React, { Suspense, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandRegistry } from '../../../../src/command-palette/registry/commandRegistry';
import type { SettingsSection, SettingsSectionPropsFactories } from '../../../../src/ui-kernel/contracts/settings';
import { createLegacyRegistryAdapters } from '../../../../src/ui-kernel/legacy-adapters';
import { UiKernelProvider, useSlot } from '../../../../src/ui-kernel/react';
import { memoryStorageBackend } from '../../../../src/ui-kernel/services/storage';
import { settingsNavigation } from '../../../../src/ui-plugins/official/settings/navigation';
import { SectionContent } from '../../../../src/ui-plugins/official/settings/SectionContent';
import { createUiKernel, examplePath, loadExample, pinLocalNoon } from '../../../testing/harness';
import { localDate } from '../day';
import uiHalf, { DEFAULT_GOAL, LOG_MINUTES, SECTION_ID } from '../ui';

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

/** Test-only stand-in for the shell transport: replays the real Host outbound events into the kernel's listeners. */
function eventBridge(host: { events: { event: string; payload: unknown }[] }) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let seen = 0;
  let delivered = 0;
  const transport = {
    async listen(event: string, handler: (payload: unknown) => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => void set.delete(handler);
    },
  };
  return {
    transport,
    flush() {
      for (const sent of host.events.slice(seen)) {
        seen += 1;
        for (const handler of [...(listeners.get(sent.event) ?? [])]) { delivered++; handler(sent.payload); }
      }
    },
    count: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
    delivered: () => delivered,
  };
}

let cleanups: (() => Promise<void>)[] = [];
beforeEach(pinLocalNoon);
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

const call = (host: Awaited<ReturnType<typeof loadExample>>['host'], method: string, ...args: unknown[]) =>
  host.invoke('plugin:host|call', { caller: ID, service: 'exampleStudyGoal', method, args });

async function setup() {
  const { host } = await loadExample(PROFILE, { storage: true });
  const bridge = eventBridge(host);
  const i18n = i18next.createInstance();
  await i18n.init({ lng: 'zh-CN', fallbackLng: 'en-US', resources: {}, interpolation: { escapeValue: false } });
  const { commands } = createLegacyRegistryAdapters({ commandRegistry, blockRegistry: {} as never, appRegistry: {} as never });
  const { kernel } = createUiKernel(host, {
    commands,
    storage: memoryStorageBackend(),
    events: bridge.transport,
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
  return { host, kernel, bridge, t: i18n.t.bind(i18n) as TFunction };
}

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

describe('Host -> UI event loop', () => {
  it('a real Host log updates the already-mounted section, ignores another date, detaches on unload and reloads on reinstall', async () => {
    const { host, kernel, bridge, t } = await setup();
    expect(await kernel.install(uiHalf)).toBe(true);
    expect(bridge.count()).toBe(1);

    const view = render(<UiKernelProvider kernel={kernel}><Settings t={t} initialTab={SECTION_ID} /></UiKernelProvider>);
    const screen = within(view.container);
    const status = await screen.findByRole('status');
    expect(status.textContent).toBe(`今天已学 0 / ${DEFAULT_GOAL} 分钟`);

    await host.ctx.exampleStudyGoal.log(localDate(), LOG_MINUTES);
    await act(async () => { bridge.flush(); });
    expect(screen.getByRole('status').textContent).toBe(`今天已学 ${LOG_MINUTES} / ${DEFAULT_GOAL} 分钟`);
    expect(screen.getByRole('status')).toBe(status);

    // 另一个日期的载荷不动今天；计数器只在旧值上累加。
    await call(host, 'log', '2026-11-08', 5);
    await act(async () => { bridge.flush(); });
    expect(screen.getByRole('status').textContent).toBe(`今天已学 ${LOG_MINUTES} / ${DEFAULT_GOAL} 分钟`);

    view.unmount();
    await kernel.unload(ID);
    expect(bridge.count()).toBe(0);
    const delivered = bridge.delivered();
    await call(host, 'log', localDate(), 5);
    await act(async () => { bridge.flush(); });
    expect(bridge.delivered()).toBe(delivered);

    expect(await kernel.install(uiHalf)).toBe(true);
    expect(bridge.count()).toBe(1);
    const reads = vi.spyOn(host, 'invoke');
    const again = render(<UiKernelProvider kernel={kernel}><Settings t={t} initialTab={SECTION_ID} /></UiKernelProvider>);
    const fresh = within(again.container);
    expect((await fresh.findByRole('status')).textContent).toBe(`今天已学 ${LOG_MINUTES + 5} / ${DEFAULT_GOAL} 分钟`);
    expect(reads.mock.calls.filter(([cmd, args]) => cmd === 'plugin:host|call' && (args as { method?: string })?.method === 'day')).toHaveLength(1);
    reads.mockRestore();
    again.unmount();
  });
});
