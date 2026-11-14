/**
 * FE-A3 全栈对账：真实 Host 内核（`createTestHost`、profile 解析与隔离安装、契约校验、`plugin:ui|manifest` v2、
 * `plugin:host|status`）+ 真实 UiKernel 与全部官方 UI 插件 + 真实渲染端同步（`startCommunityUiPlugins`）。
 *
 * Host 插件按真实 profile（`host/profiles/desktop.json`，用户 profile 以 `extends: "official"` 叠加）解析出 id 与
 * 模块路径；插件体是同 id 的替身（UI 对账只读 id、来源与降级项，真实插件需要数据库等平台服务）。
 * 降级场景的 `dstu.anki` 替身照抄真实插件的 `inject: ['paths', 'storage']`，由 profile 隔离安装判为 inactive。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createElement, type ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost, definePlugin, type TestHost } from '../../../../host/kernel/testing';
import { installProfile, OFFICIAL_PROFILE_PATH, resolveProfile } from '../../../../host/kernel/profile';
import type { PluginInstall } from '../../../../host/kernel/runtime';
import { installOfficialChatUiPlugin } from '@/features/chat/plugins';
import { startCommunityUiPlugins, type CommunityUiBridge, type UiHostManifest } from '@/ui-kernel/community';
import { UiKernel } from '@/ui-kernel/kernel';
import type { ShellViewProps } from '@/ui-kernel/contracts/shell';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { installOfficialUiPlugins } from '../../official/install';
import { chatLegacyRegistries, kernelSnapshot, OFFICIAL_SLOTS_GOLDEN, removedSlotEntries } from '../slot-snapshot';

// jsdom 环境用 web 变换：Vite 把 Host 模块里的 `new URL('…', import.meta.url)` 改写成 `${location.origin}/<仓库路径>`，
// Host 再 `fileURLToPath` 就会失败。这里只把这种地址映射回仓库文件，其余调用原样转给 node:url。
vi.mock('node:url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:url')>();
  const { join } = await import('node:path');
  const fileURLToPath = (url: string | URL) => {
    const href = typeof url === 'string' ? url : url.href;
    const origin = `${globalThis.location?.origin}/`;
    return href.startsWith(origin) ? join(process.cwd(), decodeURIComponent(href.slice(origin.length).split(/[?#]/)[0]!)) : actual.fileURLToPath(url);
  };
  return { ...actual, default: { ...actual, fileURLToPath }, fileURLToPath };
});

const golden = () => JSON.parse(readFileSync(OFFICIAL_SLOTS_GOLDEN, 'utf8'));

interface Profile {
  /** 用户 profile 的条目（叠加在官方 profile 上）。 */
  user?: { id: string; disabled?: boolean; module?: string }[];
  /** 替身插件的 `inject`（按 id）。 */
  inject?: Record<string, string[]>;
}

async function startHost({ user = [], inject = {} }: Profile = {}): Promise<{ host: TestHost; installed: string[]; degraded: { id: string; reason: string }[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'w17-fe-a3-'));
  try {
    const path = join(dir, 'user.json');
    writeFileSync(path, JSON.stringify({ extends: 'official', plugins: user }));
    const entries = await resolveProfile(path, { official: OFFICIAL_PROFILE_PATH });
    const installs: PluginInstall[] = entries.map((entry) => ({
      plugin: definePlugin({ meta: { id: entry.id }, ...(inject[entry.id] ? { inject: inject[entry.id] } : {}), apply() {} }),
      config: entry.config,
      source: entry.specifier,
    }));
    const host = await createTestHost();
    const result = await installProfile(host.runtime, installs);
    host.runtime.emitUiManifest();
    return { host, installed: result.installed.map((p) => p.plugin.meta.id), degraded: result.degraded };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 渲染端桥：命令走 TestHost 的真实派发（含契约校验），事件由测试从 `host.events` 转发。 */
function bridgeTo(host: TestHost) {
  const listeners: { manifest?: (m: UiHostManifest) => void; status?: (d: { id: string; reason: string }[]) => void } = {};
  const bridge: CommunityUiBridge = {
    invoke: () => host.invoke('plugin:ui|manifest'),
    listen: async () => () => {},
    manifest: () => host.invoke('plugin:ui|manifest', { version: 2 }),
    listenManifest: async (fn) => { listeners.manifest = fn; return () => {}; },
    status: () => host.invoke('plugin:host|status'),
    listenStatus: async (fn) => { listeners.status = fn; return () => {}; },
  };
  const forward = () => {
    const manifests = host.eventsNamed('host://ui-manifest-v2') as UiHostManifest[];
    if (manifests.length) listeners.manifest?.(manifests[manifests.length - 1]!);
  };
  return { bridge, forward };
}

async function officialKernel(): Promise<UiKernel> {
  const kernel = new UiKernel({ legacyRegistries: chatLegacyRegistries() });
  await installOfficialUiPlugins(kernel);
  await installOfficialChatUiPlugin(kernel);
  return kernel;
}

async function reconcile(kernel: UiKernel, bridge: CommunityUiBridge): Promise<() => Promise<void>> {
  const stop = await startCommunityUiPlugins(kernel, bridge, vi.fn());
  await vi.waitFor(() => expect(kernel.hostStatus.known).toBe(true));
  await vi.waitFor(async () => {
    await kernel.settled();
    expect(kernel.pairing().every((row) => row.availability === kernel.hostStatus.availability(row.hosts))).toBe(true);
  });
  return stop;
}

function viewComponent(kernel: UiKernel, id: string): ComponentType<ShellViewProps> {
  return (kernel.slots.get('views', id)!.value as { component: ComponentType<ShellViewProps> }).component;
}

const ankiRemoved = {
  views: ['task-dashboard', 'template-management', 'flashcards'],
  nav: ['flashcards'],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSystemStatusStore.getState().setComponentHealth([]);
});

describe('FE-A3 full stack: Host profile → v2 manifest/status → UiKernel reconciliation', () => {
  it('default desktop profile: zero difference from the official slot golden, and no slot change on reconcile', async () => {
    const { host, installed, degraded } = await startHost();
    expect(installed).toContain('dstu.anki');
    expect(degraded).toEqual([]);
    const kernel = await officialKernel();
    try {
      const optimistic = kernelSnapshot(kernel);
      expect(optimistic).toEqual(golden());
      const changes = vi.fn();
      kernel.slots.subscribe(changes);
      const stop = await reconcile(kernel, bridgeTo(host).bridge);
      expect(kernelSnapshot(kernel)).toEqual(golden());
      expect(changes).not.toHaveBeenCalled();
      expect(kernel.pairing()).toEqual([
        { id: 'dstu.anki', kind: 'half', parent: 'dstu.ui.shell', hosts: ['dstu.anki'], availability: 'available', active: true },
        { id: 'dstu.plugin-workshop', kind: 'plugin', hosts: ['dstu.plugin-workshop'], availability: 'available', active: true },
      ]);
      expect(await host.invoke('plugin:ui|manifest')).toEqual([]);
      render(createElement(viewComponent(kernel, 'flashcards'), { content: 'cards page' }));
      expect(screen.getByText('cards page')).toBeTruthy();
      await stop();
    } finally {
      await kernel.dispose();
      await host.dispose();
    }
  }, 60_000);

  it('dstu.anki disabled in the user profile: its UI half is not installed and only its slot entries are missing', async () => {
    const { host, installed } = await startHost({ user: [{ id: 'dstu.anki', disabled: true }] });
    expect(installed).not.toContain('dstu.anki');
    const kernel = await officialKernel();
    try {
      const stop = await reconcile(kernel, bridgeTo(host).bridge);
      const after = kernelSnapshot(kernel);
      const removed = removedSlotEntries(golden().slots, after.slots);
      expect(Object.fromEntries(Object.entries(removed).map(([slot, entries]) => [slot, entries.map((e) => e.id)]))).toEqual(ankiRemoved);
      expect(Object.values(removed).flat().every((e) => e.owner === 'dstu.ui.shell')).toBe(true);
      expect(removedSlotEntries(after.slots, golden().slots)).toEqual({});
      expect(after.chat).toEqual(golden().chat);
      expect(kernel.pairing()).toEqual([
        { id: 'dstu.anki', kind: 'half', parent: 'dstu.ui.shell', hosts: ['dstu.anki'], availability: 'missing', active: false },
        { id: 'dstu.plugin-workshop', kind: 'plugin', hosts: ['dstu.plugin-workshop'], availability: 'available', active: true },
      ]);

      // 首帧前已知缺失：重新装配官方插件时这一半直接不装。
      const fresh = new UiKernel({ legacyRegistries: chatLegacyRegistries() });
      fresh.hostStatus.update(await host.invoke<UiHostManifest>('plugin:ui|manifest', { version: 2 }));
      await installOfficialUiPlugins(fresh);
      await installOfficialChatUiPlugin(fresh);
      expect(removedSlotEntries(golden().slots, kernelSnapshot(fresh).slots)).toEqual(removed);
      await fresh.dispose();
      await stop();
    } finally {
      await kernel.dispose();
      await host.dispose();
    }
  }, 60_000);

  it('degraded dstu.anki (missing platform services): the cards hub views render FeatureUnavailablePanel', async () => {
    const { host, degraded } = await startHost({ inject: { 'dstu.anki': ['paths', 'storage'] } });
    expect(degraded).toEqual([{ id: 'dstu.anki', reason: 'SERVICE_MISSING: missing service "paths", missing service "storage"' }]);
    expect(await host.invoke('plugin:host|status')).toEqual(degraded);
    const kernel = await officialKernel();
    try {
      const stop = await reconcile(kernel, bridgeTo(host).bridge);
      const after = kernelSnapshot(kernel);
      expect(after).toEqual(golden());
      expect(kernel.pairing()[0]).toMatchObject({ id: 'dstu.anki', availability: 'degraded', active: true });

      render(createElement(viewComponent(kernel, 'flashcards'), { content: 'cards page' }));
      expect(await screen.findByText('SERVICE_MISSING: missing service "paths", missing service "storage"')).toBeTruthy();
      expect(screen.queryByText('cards page')).toBeNull();
      // 标题是该视图的 titleKey（`sidebar:navigation.flashcards`，测试 i18n 解析为中文）。
      expect(screen.getByRole('heading', { name: '闪卡' })).toBeTruthy();
      expect(useSystemStatusStore.getState().componentHealth).toEqual([
        { component: 'host:dstu.anki', status: 'degraded', reason: 'SERVICE_MISSING: missing service "paths", missing service "storage"', dependency: null },
      ]);
      // 启动同步整体覆盖 componentHealth 后，降级项被并回，面板不消失。
      act(() => useSystemStatusStore.getState().setComponentHealth([]));
      expect(screen.getByText('SERVICE_MISSING: missing service "paths", missing service "storage"')).toBeTruthy();

      // 其他视图不受影响。
      cleanup();
      render(createElement(viewComponent(kernel, 'todo'), { content: 'todo page' }));
      expect(screen.getByText('todo page')).toBeTruthy();
      cleanup();
      expect(useSystemStatusStore.getState().componentHealth).toEqual([]);
      await stop();
    } finally {
      await kernel.dispose();
      await host.dispose();
    }
  }, 60_000);

  it('follows Host changes at runtime through host://ui-manifest-v2 (unload → half removed, reinstall → back)', async () => {
    const { host } = await startHost();
    const kernel = await officialKernel();
    try {
      const { bridge, forward } = bridgeTo(host);
      const stop = await reconcile(kernel, bridge);
      await host.unload('dstu.anki');
      forward();
      await vi.waitFor(async () => {
        await kernel.settled();
        expect(kernel.slots.get('views', 'flashcards')).toBeUndefined();
      });
      await host.install(definePlugin({ meta: { id: 'dstu.anki' }, apply() {} }));
      forward();
      await vi.waitFor(async () => {
        await kernel.settled();
        expect(kernelSnapshot(kernel)).toEqual(golden());
      });
      await stop();
    } finally {
      await kernel.dispose();
      await host.dispose();
    }
  }, 60_000);
});
