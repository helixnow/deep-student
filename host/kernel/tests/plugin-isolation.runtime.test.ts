/**
 * 插件隔离与乱序装载（运行时一侧；静态导入环门禁由 W09 负责）：
 * - 每个 `api.ts` 与官方 profile 的每个插件模块，各自作为一张全新模块图的入口导入（独立 worker 线程，
 *   Node 原生 ESM 加载器，与生产 Host 相同），求值不得抛错——导入环会在这里以 TDZ `ReferenceError` 暴露；
 * - 每个官方插件只与它 `inject` 闭包内的提供方一起装载时，要么启动，要么以明确原因失败；
 *   访问未声明服务导致的 `TypeError`（`Cannot read properties of undefined` 等）不算明确原因；
 * - `desktop.json` / `mobile.json` 按多个随机种子打乱条目顺序装配，服务图与命令表与官方顺序一致。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { definePlugin } from '../api.ts';
import { ContractSet } from '../contracts.ts';
import { importProfile, installProfile, OFFICIAL_PROFILE_PATH, resolveProfile, type ProfileLoadResult } from '../profile.ts';
import { HostRuntime, type PluginInstall } from '../runtime.ts';

const HOST_DIR = fileURLToPath(new URL('../../', import.meta.url));
const MOBILE_PROFILE_PATH = join(HOST_DIR, 'profiles', 'mobile.json');
const PROBE = new URL('../__fixtures__/isolated-import.worker.mjs', import.meta.url);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createRuntime(contracts: ContractSet): HostRuntime {
  const dataDir = mkdtempSync(join(tmpdir(), 'dstu-plugin-isolation-'));
  dirs.push(dataDir);
  return new HostRuntime({
    app: { dataDir, version: '0.0.0-test', platform: 'linux', debug: true },
    contracts,
    outbound: { send: () => undefined },
  });
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  }));
  return results;
}

interface ImportReply { ok: boolean; name?: string; message?: string; stack?: string }

function importIsolated(specifier: string): Promise<ImportReply> {
  return new Promise((resolve) => {
    const worker = new Worker(PROBE, { workerData: { specifier }, stdout: true, stderr: true });
    let reply: ImportReply | null = null;
    worker.on('message', (message: ImportReply) => { reply = message; });
    worker.on('error', (error) => { reply = { ok: false, name: error.name, message: error.message, stack: error.stack }; });
    worker.on('exit', (code) => resolve(reply ?? { ok: false, message: `probe worker exited with code ${code} without a reply` }));
  });
}

async function expectIsolatedImports(specifiers: readonly string[]): Promise<void> {
  const replies = await mapLimit(specifiers, 4, importIsolated);
  const failures = replies.flatMap((reply, index) => reply.ok ? [] : [`${specifiers[index]}\n  ${reply.name}: ${reply.message}\n${reply.stack ?? ''}`]);
  expect(failures, failures.join('\n\n')).toEqual([]);
}

async function apiModules(): Promise<string[]> {
  const files = [join(HOST_DIR, 'kernel', 'api.ts')];
  for (const group of ['platform', 'plugins']) {
    const entries = await readdir(join(HOST_DIR, group), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(HOST_DIR, group, entry.name, 'api.ts');
      if (entry.isDirectory() && existsSync(file)) files.push(file);
    }
  }
  return files.map((file) => pathToFileURL(file).href);
}

function dependenciesOf(entry: PluginInstall): string[] {
  const inject = entry.plugin.inject;
  return Array.isArray(inject) ? [...inject] : Object.keys(inject ?? {});
}

/** `entry` 与它 `inject` 闭包内（本 profile 中）的全部提供方，profile 顺序。 */
function injectClosure(entry: PluginInstall, all: readonly PluginInstall[]): PluginInstall[] {
  const providers = new Map<string, PluginInstall>();
  for (const candidate of all) for (const name of candidate.plugin.meta.provides ?? []) providers.set(name, candidate);
  const chosen = new Set<PluginInstall>([entry]);
  const pending = [entry];
  while (pending.length) {
    for (const name of dependenciesOf(pending.pop()!)) {
      const provider = providers.get(name);
      if (provider !== undefined && !chosen.has(provider)) {
        chosen.add(provider);
        pending.push(provider);
      }
    }
  }
  return all.filter((candidate) => chosen.has(candidate));
}

/** 访问未声明（未注入）服务的典型症状：失败原因说明不了缺什么。 */
const UNCLEAR_FAILURE = /Cannot read propert(?:y|ies) of (?:undefined|null)|is not a function|is not defined|before initialization|undefined is not/;

/** mulberry32：种子相同则顺序相同，失败信息里的种子可以直接复现。 */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const SEEDS = (process.env.DSTU_SHUFFLE_SEEDS ?? '1,7,42,1337,20261107').split(',').map(Number);

/** 装配结果中与安装顺序无关的部分：已安装插件、服务 → 提供方、命令 → 所属插件、未安装插件及原因。 */
function assembly(runtime: HostRuntime, result: ProfileLoadResult) {
  const store = runtime.ctx.reflect.store;
  const services = Reflect.ownKeys(store).flatMap((key) => {
    const impl = store[key as symbol];
    if (!impl) return [];
    return [`${impl.name} <- ${runtime.kernel.ownerOf(impl.fiber)?.id ?? '(kernel)'}`];
  });
  const commands = runtime.commands._entries().map((entry) => `${entry.name} <- ${runtime.kernel.ownerOf(entry.fiber)?.id ?? '(kernel)'}`);
  return {
    installed: result.installed.map((entry) => entry.id).sort(),
    services: services.sort(),
    commands: commands.sort(),
    degraded: result.degraded.map((item) => `${item.id}: ${item.reason}`).sort(),
  };
}

describe('isolated module evaluation (fresh module graph per entry, native Node ESM)', () => {
  it('every api.ts evaluates without throwing when it is the first module imported', async () => {
    const modules = await apiModules();
    expect(modules.length).toBeGreaterThan(30);
    await expectIsolatedImports(modules);
  }, 180_000);

  it('every desktop and mobile profile module evaluates without throwing when it is the first module imported', async () => {
    const entries = [...await resolveProfile(OFFICIAL_PROFILE_PATH), ...await resolveProfile(MOBILE_PROFILE_PATH)];
    await expectIsolatedImports([...new Set(entries.map((entry) => entry.specifier))]);
  }, 180_000);
});

describe('inject-only startup (each official plugin with just its inject closure)', () => {
  it('every desktop plugin starts, or fails with a reason that names what is missing', async () => {
    const contracts = ContractSet.fromDirectory();
    const all = await importProfile(await resolveProfile(OFFICIAL_PROFILE_PATH));
    const unclear: string[] = [];
    const outcomes: string[] = [];
    for (const entry of all) {
      const id = entry.plugin.meta.id;
      const runtime = createRuntime(contracts);
      try {
        const result = await installProfile(runtime, injectClosure(entry, all));
        const degraded = result.degraded.find((item) => item.id === id);
        outcomes.push(degraded === undefined ? `${id}: started` : `${id}: ${degraded.reason}`);
        for (const item of result.degraded) {
          if (UNCLEAR_FAILURE.test(item.reason)) unclear.push(`${id} (closure member ${item.id}): ${item.reason}`);
        }
      } finally {
        await runtime.dispose();
      }
    }
    expect(outcomes).toHaveLength(all.length);
    expect([...new Set(unclear)], `${unclear.join('\n')}\n\nall outcomes:\n${outcomes.join('\n')}`).toEqual([]);
  }, 600_000);
});

describe('shuffled profile assembly', () => {
  async function assemble(installs: readonly PluginInstall[], contracts: ContractSet) {
    const runtime = createRuntime(contracts);
    try {
      return assembly(runtime, await installProfile(runtime, installs));
    } finally {
      await runtime.dispose();
    }
  }

  it.each(SEEDS)('desktop.json in shuffled order (seed %i) yields the same service graph and command table', async (seed) => {
    const contracts = ContractSet.fromDirectory();
    const installs = await importProfile(await resolveProfile(OFFICIAL_PROFILE_PATH));
    const reference = await assemble(installs, contracts);
    expect(reference.installed.length, 'the official order must install most plugins').toBeGreaterThan(installs.length / 2);
    const order = shuffled(installs, seed);
    expect(await assemble(order, contracts), `seed ${seed}; order: ${order.map((entry) => entry.plugin.meta.id).join(', ')}`).toEqual(reference);
  }, 240_000);

  it.each(SEEDS)('mobile.json in shuffled order (seed %i) yields the same service graph and command table', async (seed) => {
    const contracts = ContractSet.empty();
    // Node 里没有 SQLite WASM：替身与移动端外壳一样先于 profile 提供 `sqliteRuntime`，打开库时明确失败。
    const shell = definePlugin({
      meta: { id: 'dstu.mobile.shell', lane: 'W01-test', provides: ['sqliteRuntime'], platforms: ['mobile'] },
      apply(ctx) {
        ctx.provide('sqliteRuntime', {
          sqlite3: {} as never,
          open: () => { throw new Error('SQLite WASM is not available in the Node test host'); },
          exists: () => false,
          unlink: () => undefined,
          exportFile: () => new Uint8Array(),
          migrations: { vfs: {}, chat_v2: {}, mistakes: {}, llm_usage: {} },
        });
      },
    });
    const installs: PluginInstall[] = [{ plugin: shell, source: 'test:mobile-shell' }, ...await importProfile(await resolveProfile(MOBILE_PROFILE_PATH))];
    const reference = await assemble(installs, contracts);
    expect(reference.installed).toContain('dstu.platform.crypto');
    const order = shuffled(installs, seed);
    expect(await assemble(order, contracts), `seed ${seed}; order: ${order.map((entry) => entry.plugin.meta.id).join(', ')}`).toEqual(reference);
  }, 120_000);

  it('the generator pins dstu.sync-startup before storage, which reads storageStartupSync without injecting it', async () => {
    // storage 的启动重置经 `ctx.get('storageStartupSync')` 读取提供方而不声明 inject，拓扑排序约束不到它；
    // 乱序时 storage 可能先装，带 purge 标记的启动会走恢复态。在 storage 声明该依赖之前，由官方 profile 的固定位置保证。
    const ids = (await resolveProfile(OFFICIAL_PROFILE_PATH)).map((entry) => entry.id);
    expect(ids.indexOf('dstu.sync-startup')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('dstu.sync-startup')).toBeLessThan(ids.indexOf('dstu.platform.storage'));
  });
});
