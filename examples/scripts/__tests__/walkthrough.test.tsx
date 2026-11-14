// @vitest-environment node
/**
 * 新手全程：照 examples/README.md「脚手架」一节，从零做一个 Host 半 + UI 半的插件和一个只有 Host 半的插件。
 *
 * 1. 用命令行脚手架生成（在系统临时目录里，用完删掉）；
 * 2. 原样执行生成的 README.md 里的构建与测试命令（POSIX shell）；
 * 3. 按生产路径装载：两个插件的 user.profile.json 合并后放进 `<应用数据目录>/plugins/user.profile.json` →
 *    外壳选择握手 profile（resolveHostProfile）→ Host 握手并装载（serveHost，经 main↔Host 消息）→ UI 引导清单 →
 *    外壳的 ds-plugin:// 提供构建出的 dist/ui.js → UI 内核按宿主安装的共享模块 import map 装上 UI 半 →
 *    视图经 plugin:host|call 拿到 Host 半的结果。
 *
 * 官方 profile 换成空的（examples/testing/fixtures/empty-official.profile.json），平台核心服务用替身：真实官方 profile 会装上全部官方插件和 SQLite，
 * 与社区插件的装载链路无关。
 */
import { resolveObjectURL } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useSlotEntry } from '@deepstudent/ui';
import { resolveHostProfile } from '../../../electron/shell/host-profile.ts';
import { PluginUiRegistry, servePluginUiRequest } from '../../../electron/shell/plugin-ui-protocol.ts';
import { serveHost, type HostTransport } from '../../../host/kernel/connection.ts';
import { CommunityConsentLedger } from '../../../host/kernel/community-consent.ts';
import { HOST_PROTOCOL_VERSION, type HostToMain } from '../../../host/kernel/protocol.ts';
import type { HostRuntime } from '../../../host/kernel/runtime.ts';
import { startCommunityUiPlugins, type CommunityUiBridge, type UiHostManifest } from '../../../src/ui-kernel/community';
import { pluginUrl, type UiManifestEntry } from '../../../src/ui-kernel/loader';
import { UiKernelProvider } from '../../../src/ui-kernel/react';
import { bareImports } from '../../testing/conformance';
import { APP_VERSION, createUiKernel, installDom, recordingI18n, REPO_ROOT } from '../../testing/harness';
import { SHARED_MODULES } from '../build-ui.mjs';

/** 一次嵌套的 vitest（生成插件自己的测试）要启动并转换 Host 与 UI 内核的模块图，机器忙时要几十秒。 */
const README_STEP_TIMEOUT = 180_000;
/** 装载链路要等社区加载器异步对账、Host 往返几次；waitFor 本身最多等 10 秒。 */
const LOAD_TIMEOUT = 30_000;
const OFFICIAL = fileURLToPath(new URL('../../testing/fixtures/empty-official.profile.json', import.meta.url));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w27-walkthrough-')));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const withUi = { id: 'alice.study-stats', dir: path.join(tmp, 'study-stats'), service: 'aliceStudyStats', view: 'alice.study-stats/main' };
const hostOnly = { id: 'alice.quick-notes', dir: path.join(tmp, 'quick-notes'), service: 'aliceQuickNotes' };

const readText = (file: string) => fs.readFileSync(file, 'utf8');
const bashBlocks = (readme: string) => [...readme.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]!.trim());

/** 生成的 README 里含 `needle` 的那一个 bash 代码块。 */
function readmeBlock(dir: string, needle: string): string {
  const blocks = bashBlocks(readText(path.join(dir, 'README.md'))).filter((b) => b.includes(needle));
  expect(blocks, needle).toHaveLength(1);
  return blocks[0]!;
}

/** 按 README 原样执行一个代码块（任何一行失败即停）。子进程不继承本次 vitest 的 worker 变量。 */
function runBlock(block: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
  for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key];
  const result = spawnSync('/bin/sh', ['-c', `set -e\n${block}`], { encoding: 'utf8', env });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

/** 生成插件的测试全部通过：恰好一个测试文件，模板里的用例一个不少，没有失败。 */
function expectPluginTestsPassed(output: string, testFile: string, tests: number) {
  expect(output).toContain(testFile);
  expect(output).toMatch(/Test Files\s+1 passed \(1\)/);
  expect(output).toMatch(new RegExp(`Tests\\s+${tests} passed \\(${tests}\\)`));
}

describe.skipIf(process.platform === 'win32')('newcomer walkthrough: generate, build, test (README commands, POSIX shell)', () => {
  it('generates both plugins with the CLI exactly as examples/README.md shows', () => {
    for (const [plugin, flags] of [[withUi, []], [hostOnly, ['--host-only']]] as const) {
      const cli = spawnSync(process.execPath, ['examples/scripts/create-plugin.mjs', plugin.id, '--out', plugin.dir, ...flags], { cwd: REPO_ROOT, encoding: 'utf8' });
      expect(cli.status, cli.stderr).toBe(0);
      expect(cli.stdout).toContain(`created ${plugin.dir}`);
    }
    expect(fs.existsSync(path.join(withUi.dir, 'ui.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(hostOnly.dir, 'ui.tsx'))).toBe(false);
  });

  it('builds the UI half with the README command (outside the repository, without node_modules or esbuild on PATH)', () => {
    expect(fs.existsSync(path.join(withUi.dir, 'node_modules'))).toBe(false);
    const { status, output } = runBlock(readmeBlock(withUi.dir, 'npm run build:ui'));
    expect(status, output).toBe(0);
    const bundle = readText(path.join(withUi.dir, 'dist', 'ui.js'));
    expect(bareImports(bundle).every((s) => SHARED_MODULES.includes(s)), bareImports(bundle).join(', ')).toBe(true);
    expect(bundle).not.toContain('react/jsx-runtime');
    expect(readText(path.join(hostOnly.dir, 'README.md'))).not.toContain('build:ui');
  });

  it('passes its generated tests with the README command (UI + Host plugin)', () => {
    const { status, output } = runBlock(readmeBlock(withUi.dir, 'npx vitest run'));
    expect(status, output).toBe(0);
    expectPluginTestsPassed(output, 'study-stats/__tests__/study-stats.test.tsx', 4);
  }, README_STEP_TIMEOUT);

  it('passes its generated tests with the README command (Host-only plugin)', () => {
    const { status, output } = runBlock(readmeBlock(hostOnly.dir, 'npx vitest run'));
    expect(status, output).toBe(0);
    expectPluginTestsPassed(output, 'quick-notes/__tests__/quick-notes.test.ts', 2);
  }, README_STEP_TIMEOUT);

  it('points the README try-out command at the generated user profile, which the shell then hands to the Host', () => {
    const block = readmeBlock(withUi.dir, 'npm run dev:electron');
    const override = block.match(/DS_HOST_PROFILE=(\S+) npm run dev:electron/)?.[1];
    expect(override).toBe(path.join(withUi.dir, 'user.profile.json'));
    expect(resolveHostProfile({ override, appDataDir: path.join(tmp, 'unused'), hostEntry: path.join(REPO_ROOT, 'host/kernel/main.ts'), exists: fs.existsSync }))
      .toBe(path.join(withUi.dir, 'user.profile.json'));
  });
});

/** Electron main 一侧：经 Host 协议消息发 invoke、收结果与后端事件（与 electron/main.ts 转发前端调用的消息相同）。 */
class MainSide implements HostTransport {
  private listener: (message: unknown) => void = () => undefined;
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();
  private readonly events = new Map<string, Set<(payload: unknown) => void>>();
  private next = 0;

  send(message: HostToMain): void {
    if (message.kind === 'result') {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.ok) waiter?.resolve(message.value);
      else waiter?.reject(message.error);
    } else if (message.kind === 'event') {
      for (const callback of this.events.get(message.event) ?? []) callback(message.payload);
    }
  }
  onMessage(listener: (message: unknown) => void): void {
    this.listener = listener;
  }
  onClose(): void {}
  close(): void {}
  deliver(message: unknown): void {
    this.listener(message);
  }

  /** 主窗口的前端 `invoke(cmd, args)`。 */
  invoke<T>(cmd: string, args: unknown = {}): Promise<T> {
    const id = `walkthrough-${++this.next}`;
    const result = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject }));
    this.deliver({ kind: 'invoke', id, cmd, args, source: { window: 'main', webview: 'main' } });
    return result;
  }

  listen<T>(event: string, callback: (payload: T) => void): () => void {
    const callbacks = this.events.get(event) ?? new Set();
    this.events.set(event, callbacks);
    const entry = callback as (payload: unknown) => void;
    callbacks.add(entry);
    return () => void callbacks.delete(entry);
  }
}

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;
const dataUrl = (code: string) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;

/**
 * 渲染进程加载 ds-plugin:// 模块的等价物：裸模块名按宿主插入页面的 import map（src/ui-kernel/shared.ts installSharedModules）解析到
 * 它的 blob 模块，再整体作为 ESM 导入。import map 里没有的裸模块名在浏览器里同样解析失败。
 */
async function importWithHostImportMap(code: string): Promise<{ default?: unknown }> {
  const maps = [...document.querySelectorAll('script[type="importmap"]')];
  expect(maps).toHaveLength(1);
  const imports = JSON.parse(maps[0]!.textContent!).imports as Record<string, string>;
  expect(Object.keys(imports).sort()).toEqual([...SHARED_MODULES].sort());
  const modules = new Map<string, string>();
  for (const [name, blobUrl] of Object.entries(imports)) modules.set(name, dataUrl(await resolveObjectURL(blobUrl)!.text()));
  const linked = code.replace(SPECIFIER, (_all, head: string, quote: string, specifier: string) => {
    const target = modules.get(specifier);
    if (target === undefined) throw new Error(`"${specifier}" is not in the host import map; a community UI bundle can only import ${SHARED_MODULES.join(', ')}`);
    return `${head}${quote}${target}${quote}`;
  });
  return import(/* @vite-ignore */ dataUrl(linked));
}

describe.skipIf(process.platform === 'win32')('newcomer walkthrough: load like the app does', () => {
  const dataDir = path.join(tmp, 'app-data');
  const userProfile = path.join(dataDir, 'plugins', 'user.profile.json');
  const main = new MainSide();
  const cleanups: (() => Promise<void>)[] = [];
  let runtime: HostRuntime | null = null;

  // 首次导入 SDK 与社区加载器要转换整个 UI 内核的模块图（机器忙时数秒），是共享准备。
  beforeAll(() => Promise.all([import('@deepstudent/ui'), import('../../../src/ui-kernel/shared'), import('@testing-library/react')]));
  afterAll(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it('the shell picks <app data dir>/plugins/user.profile.json, and the Host installs both plugins from it', async () => {
    const entries = [withUi, hostOnly].flatMap((p) => (JSON.parse(readText(path.join(p.dir, 'user.profile.json'))) as { extends: string; plugins: unknown[] }).plugins);
    fs.mkdirSync(path.dirname(userProfile), { recursive: true });
    fs.writeFileSync(userProfile, JSON.stringify({ extends: 'official', plugins: entries }, null, 2));
    const profile = resolveHostProfile({ override: undefined, appDataDir: dataDir, hostEntry: path.join(REPO_ROOT, 'host/kernel/main.ts'), exists: fs.existsSync });
    expect(profile).toBe(userProfile);

    // Test fixture represents the user's prior approval; production boot enforces K3.
    const ledger = new CommunityConsentLedger(dataDir);
    for (const plugin of [withUi, hostOnly]) {
      const pkg = JSON.parse(readText(path.join(plugin.dir, 'package.json')));
      await ledger.grant({ id: pkg.deepStudent.id, version: pkg.version, permissions: pkg.deepStudent.permissions ?? [] });
    }

    const session = serveHost(main, {
      officialProfile: OFFICIAL,
      onRuntime(created) {
        for (const name of ['storage', 'paths', 'log']) created.ctx.provide(name, {});
      },
    });
    cleanups.push(() => session.shutdown());
    main.deliver({
      kind: 'handshake', protocol: HOST_PROTOCOL_VERSION, appDataDir: dataDir, appVersion: APP_VERSION,
      platform: process.platform === 'darwin' ? 'darwin' : 'linux', debug: true, profile,
    });
    runtime = await session.ready;
    expect(runtime).not.toBeNull();
    expect(runtime!.plugins().map((p) => p.id)).toEqual(expect.arrayContaining([withUi.id, hostOnly.id]));
    await expect(main.invoke('plugin:host|status')).resolves.toEqual([]);
    expect((runtime!.ctx.get(hostOnly.service) as { greet(name: string): string }).greet('Ada')).toBe('Hello, Ada');
  });

  it('lists only the UI half in the UI manifest, and the shell serves the built dist/ui.js over ds-plugin://', async () => {
    const manifest = await main.invoke<UiManifestEntry[]>('plugin:ui|manifest', {});
    expect(manifest).toEqual([{ id: withUi.id, file: path.join(withUi.dir, 'dist', 'ui.js'), version: '0.1.0' }]);
    const v2 = await main.invoke<UiHostManifest>('plugin:ui|manifest', { version: 2 });
    expect(v2.plugins.filter((p) => p.origin === 'community').map((p) => [p.id, p.file])).toEqual([[withUi.id, manifest[0]!.file], [hostOnly.id, undefined]]);

    const response = await servePluginUiRequest(new Request(pluginUrl(manifest[0]!)), new PluginUiRegistry(), () => main.invoke('plugin:ui|manifest', {}));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript');
    expect(await response.text()).toBe(readText(manifest[0]!.file));
  });

  it('the UI kernel loads the bundle through the host import map, and its view shows what the Host half returns', async () => {
    installDom();
    const navigate = vi.fn();
    const i18n = recordingI18n();
    const { kernel, commands } = createUiKernel(main, { i18n: i18n.adapter, navigate });
    cleanups.push(() => kernel.dispose());
    const registry = new PluginUiRegistry();
    const bridge: CommunityUiBridge = {
      invoke: () => main.invoke('plugin:ui|manifest'),
      listen: async (callback) => main.listen('host://ui-manifest', callback),
      manifest: () => main.invoke('plugin:ui|manifest', { version: 2 }),
      listenManifest: async (callback) => main.listen('host://ui-manifest-v2', callback),
      status: () => main.invoke('plugin:host|status'),
      listenStatus: async (callback) => main.listen('host://plugins-degraded', callback),
    };
    const loadErrors = vi.spyOn(console, 'error');
    cleanups.push(async () => loadErrors.mockRestore());
    const stop = await startCommunityUiPlugins(kernel, bridge, async (url) => {
      const response = await servePluginUiRequest(new Request(url), registry, () => main.invoke('plugin:ui|manifest', {}));
      if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`);
      return importWithHostImportMap(await response.text());
    });
    cleanups.push(stop);

    await vi.waitFor(() => expect(kernel.slots.list('views').map((e) => [e.key, e.owner, e.origin])).toEqual([[withUi.view, withUi.id, 'community']]), { timeout: 10_000 });
    expect(loadErrors).not.toHaveBeenCalled();
    expect(kernel.plugins().find((p) => p.id === withUi.id)).toMatchObject({ origin: 'community', hostPlugins: [withUi.id] });
    expect([...i18n.bundles.keys()].sort()).toEqual([`en-US/${withUi.id}`, `zh-CN/${withUi.id}`]);

    const { render, within } = await import('@testing-library/react');
    function Shell() {
      const View = useSlotEntry('views', withUi.view)?.value.component;
      return View ? <View /> : null;
    }
    const { container, unmount } = render(<UiKernelProvider kernel={kernel}><Shell /></UiKernelProvider>);
    expect(await within(container).findByText('Hello, Deep Student')).toBeTruthy();
    unmount();

    await (commands.get(`${withUi.id}.open`)!.execute as () => void)();
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ view: withUi.view, source: withUi.id }));
  }, LOAD_TIMEOUT);
});
