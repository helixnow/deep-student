/**
 * 示例插件测试的共用装配：真实 Host 测试宿主 + 真实 profile 装载（含社区插件清单筛查）+ 真实 UI 内核。
 * 只在 `// @vitest-environment node` 的测试里用：Host 内核按 `file:` URL 定位 profile、模块与 package.json。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { vi } from 'vitest';
import { loadProfile, type ProfileLoadResult } from '../../host/kernel/profile.ts';
import { createTestHost, type TestHost, type TestHostOptions } from '../../host/kernel/testing.ts';
import { defineUiPlugin, UiKernel, type RemoteHost, type UiAdapters, type UiPlugin } from '../../src/ui-kernel/kernel';
import { UiKernelProvider, useSlotEntry } from '../../src/ui-kernel/react';
import { memoryRegistryAdapters } from '../../src/ui-plugins/testing/registries';
import { installDom } from './dom';

export { installDom };

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const EXAMPLES_DIR = path.join(REPO_ROOT, 'examples', 'plugins');

/** 应用版本（根 package.json#version）：示例的 engines.deepStudent 必须包含它。测试宿主默认的 `0.0.0-test` 是预发布版本，不满足任何范围。 */
export const APP_VERSION: string = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;

export interface ExampleManifest {
  name: string;
  version: string;
  engines: { deepStudent: string };
  deepStudent: { manifestVersion: 1; id: string; platforms: string[]; host?: string; ui?: string; permissions?: string[]; requires?: Record<string, string> };
}

export interface ExamplePackage {
  /** examples/plugins 下的目录名。 */
  dirName: string;
  dir: string;
  pkg: ExampleManifest;
}

/** examples/plugins 下的每个插件目录（与 plugin-manifest 门禁的对象相同）。 */
export function examplePackages(): ExamplePackage[] {
  return readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((dirName) => {
      const dir = path.join(EXAMPLES_DIR, dirName);
      return { dirName, dir, pkg: JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as ExampleManifest };
    });
}

export function examplePath(dirName: string, ...segments: string[]): string {
  return path.join(EXAMPLES_DIR, dirName, ...segments);
}

export interface LoadExampleOptions extends Pick<TestHostOptions, 'provide'> {
  /** profile 里 `extends: "official"` 解析到的文件（默认是真实的官方 profile）。 */
  official?: string;
  /** 提供真实的 `storage` 服务（应用的 SQLite 存储，根目录是测试宿主的数据目录），插件 `inject: ['storage']` 时用。 */
  storage?: boolean;
  /** 测试宿主的数据目录（`ctx.app.dataDir`）。默认每个宿主新建一个、dispose 时删除；给出时由调用方清理，可以让两个宿主先后用同一份数据。 */
  dataDir?: string;
}

/** 以真实应用版本建测试宿主，再按生产路径（profile.ts::loadProfile，桌面平台）装载 profile。 */
export async function loadExample(profile: string, options: LoadExampleOptions = {}): Promise<{ host: TestHost; result: ProfileLoadResult }> {
  const storage = options.storage ? (await import('../../host/platform/storage/service.ts')).StorageCordisService : undefined;
  const provide = { ...(storage ? { storage } : {}), ...options.provide };
  const host = await createTestHost({ app: { version: APP_VERSION, ...(options.dataDir ? { dataDir: options.dataDir } : {}) }, provide });
  try {
    const result = await loadProfile(host.runtime, profile, { platform: 'desktop', ...(options.official ? { official: options.official } : {}) });
    return { host, result };
  } catch (error) {
    await host.dispose();
    throw error;
  }
}

/** 官方命名空间的代表（生产中是 i18next 的 `options.ns`）。 */
export const OFFICIAL_NAMESPACES: readonly string[] = ['common', 'settings', 'sidebar'];

/** 内存 i18n 适配器：记录内核转给 i18next 的每个语言包（`<lng>/<ns>`），撤销时删除。 */
export function recordingI18n(languages: readonly string[] = ['zh-CN', 'zh', 'en-US']) {
  const bundles = new Map<string, Record<string, unknown>>();
  const written: string[] = [];
  const adapter: NonNullable<UiAdapters['i18n']> = {
    addBundle: (lng, ns, resources) => {
      written.push(ns);
      bundles.set(`${lng}/${ns}`, resources);
      return () => void bundles.delete(`${lng}/${ns}`);
    },
    languages: () => languages,
    isReservedNamespace: (ns) => OFFICIAL_NAMESPACES.includes(ns),
  };
  return { adapter, bundles, written };
}

/**
 * 内存 Host→UI 事件传输（`ctx.ui.host.on` 的 `UiAdapters.events`）：外壳的 Tauri `listen` 不在测试里时用它。
 * `emit` 把载荷交给当前监听者，`count` 可用来验证插件卸载后退订。
 */
export function memoryHostEvents() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    transport: {
      async listen(event: string, handler: (payload: unknown) => void) {
        const set = listeners.get(event) ?? new Set();
        set.add(handler);
        listeners.set(event, set);
        return () => void set.delete(handler);
      },
    },
    emit(event: string, payload?: unknown) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
    },
    count: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
  };
}

/**
 * UI 内核：命令走与生产同契约的内存注册表；给出 Host（测试宿主，或任何前端 `invoke` 的等价物）时经 `plugin:host|call` 连到它。
 * 事件传输缺省用内存实现（`events`），需要看真实 Host 发出的载荷时用 `adapters.events` 换掉，或读返回的 `events`。
 */
export function createUiKernel(host?: Pick<TestHost, 'invoke'>, adapters: UiAdapters = {}) {
  const registries = memoryRegistryAdapters();
  const events = memoryHostEvents();
  const kernel = new UiKernel({
    ...registries,
    events: events.transport,
    ...(host ? { invoke: (cmd: string, args?: unknown) => host.invoke(cmd, args) } : {}),
    ...adapters,
  });
  const { list, get } = registries.commands;
  return { kernel, commands: { list: () => list?.() ?? [], get: (id: string) => get?.(id) }, events };
}

/**
 * 安装 UI 半，并交出它在 `apply` 里拿到的 `ctx.ui.host`：调用带上插件 id（`caller`），Host 只放行该插件自己 Host 半的服务。
 * 插件之外的 `kernel.ui().host` 没有调用方，调用被拒绝。
 */
export async function installUiHalf(kernel: UiKernel, plugin: UiPlugin): Promise<{ installed: boolean; host: RemoteHost }> {
  let host: RemoteHost | undefined;
  const installed = await kernel.install(defineUiPlugin({
    ...plugin,
    apply: (ctx, config) => {
      host = ctx.ui.host;
      return plugin.apply(ctx, config);
    },
  }));
  if (!host) throw new Error(`${plugin.meta.id}: apply did not run`);
  return { installed, host };
}

/**
 * 把 `Date` 放到本地时间某天的中午，之后随真实时间前进（计时器不替换）。插件和测试各自按本地时间取“今天”，
 * 用例跨过本地午夜时两边会取到不同的日期；撤销用 `vi.useRealTimers()`。
 */
export function pinLocalNoon(): void {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true, now: new Date(2026, 10, 7, 12) });
}

/**
 * 按外壳的方式渲染 `views` 槽位里的一个视图（按 id 取组件，不经 `<SlotOutlet>`），返回 testing-library 的查询和 `unmount`。
 * 仓库外的插件目录没有 `node_modules`，不能自己导入 `@testing-library/react`，用这个。
 */
export async function renderView(kernel: UiKernel, viewId: string) {
  installDom();
  const { render, within } = await import('@testing-library/react');
  function Shell() {
    const View = useSlotEntry('views', viewId)?.value.component;
    return View ? createElement(View) : null;
  }
  const view = render(createElement(UiKernelProvider, { kernel }, createElement(Shell)));
  return { ...within(view.container), unmount: view.unmount };
}
