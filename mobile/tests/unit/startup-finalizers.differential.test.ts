/**
 * 启动 finalizer（V09 P1-3，W10 `startup-finalizers.ts`）与桌面逐步对拍：同一段脚本分别跑在桌面 `StorageServiceImpl`
 * 和移动端 `MobileStorageService` 上，每一步的返回值或错误形状、钩子执行顺序都必须相同。
 *
 * - `late` / `signal` 在桌面运行时原样穿过包装层，移动端必须同样生效；
 * - 桌面包装层暂时丢弃 `register()` 的 disposer（W07 补丁未落地），disposer 语义对拍桌面 registry 本身；
 * - `late: 'run'` 异步失败：桌面没传 `onLateError`（未处理拒绝写 stderr），移动端 Worker 里的未处理拒绝到不了外壳，改记 error 日志。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { createTestHost, definePlugin, type TestHost } from '../../../host/kernel/testing.ts';
import type { StartupFinalizerReport } from '../../../host/platform/storage/api.ts';
import { StartupFinalizerError, StorageError } from '../../../host/platform/storage/errors.ts';
import { createStorageService } from '../../../host/platform/storage/service.ts';
import { StartupFinalizerRegistry, type StartupFinalizerRegistration } from '../../../host/platform/storage/startup-finalizers.ts';
import mobileStorage, { MobileStorageService } from '../../../host/platform/storage-mobile/index.ts';
import { nodeRuntime, nodeSqlite } from './support/sqlite-node.ts';

type Trace = [label: string, outcome: 'ok' | 'err', value: unknown][];
type Hook = () => void | Promise<void>;

interface Finalizers {
  registerFinalizer(name: string, fn: Hook, options?: StartupFinalizerRegistration): unknown;
  finalizerNames(): readonly string[];
  runStartupFinalizers(): Promise<StartupFinalizerReport>;
}

const temps: string[] = [];
const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function desktopService() {
  const base = mkdtempSync(join(tmpdir(), 'w31-finalizer-diff-'));
  temps.push(base);
  return createStorageService({ baseDir: base, dataLocalDir: base });
}

async function mobileService(log?: (level: string, message: string) => void) {
  return new MobileStorageService({ runtime: nodeRuntime(await nodeSqlite()), baseDir: '/data', log });
}

function shape(error: unknown): unknown {
  if (error instanceof StorageError) return { code: error.code, message: error.message };
  if (error instanceof StartupFinalizerError) {
    return { name: error.name, message: error.message, finalizer: error.finalizer, completed: error.completed, cause: String((error.cause as Error)?.message ?? error.cause) };
  }
  return { message: String((error as Error)?.message ?? error) };
}

function step(t: Trace, label: string, fn: () => unknown): void {
  try {
    t.push([label, 'ok', fn()]);
  } catch (error) {
    t.push([label, 'err', shape(error)]);
  }
}

async function stepAsync(t: Trace, label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    t.push([label, 'ok', await fn()]);
  } catch (error) {
    t.push([label, 'err', shape(error)]);
  }
}

const opts = (options: StartupFinalizerRegistration): StartupFinalizerRegistration => options;

async function lifecycleScript(s: Finalizers): Promise<Trace> {
  const t: Trace = [];
  const ran: string[] = [];
  const hook = (name: string): Hook => () => { ran.push(name); };
  // 桌面包装层还不返回 disposer（见文件头），这里只比较注册是否抛错；disposer 由第三个用例对拍。
  const register = (name: string, fn: Hook, options?: StartupFinalizerRegistration) => () => { s.registerFinalizer(name, fn, options); };
  let failOnce = true;

  step(t, 'empty name', register('', hook('x')));
  step(t, 'not a function', register('x', 'nope' as unknown as Hook));
  step(t, 'invalid late policy', register('x', hook('x'), opts({ late: 'later' as 'run' })));
  step(t, 'invalid after entry', register('x', hook('x'), opts({ after: [''] })));
  step(t, 'register a', register('a', hook('a')));
  step(t, 'register b after a', register('b', hook('b'), opts({ after: ['a'] })));
  step(t, 'duplicate a', register('a', hook('a2')));
  const controller = new AbortController();
  step(t, 'register c with a signal', register('c', hook('c'), opts({ signal: controller.signal })));
  step(t, 'names before abort', () => s.finalizerNames());
  controller.abort();
  step(t, 'abort unregisters c', () => s.finalizerNames());
  step(t, 'c can be registered again after abort', register('c', hook('c-again')));
  step(t, 'an already aborted signal registers nothing', register('d', hook('d'), opts({ signal: controller.signal })));
  step(t, 'names', () => s.finalizerNames());
  step(t, 'register flaky after b', register('flaky', async () => {
    ran.push('flaky');
    if (failOnce) { failOnce = false; throw new Error('flaky boom'); }
  }, opts({ after: ['b'] })));

  await stepAsync(t, 'first run fails at flaky', () => s.runStartupFinalizers());
  step(t, 'late default after a failed run', register('late-throw', hook('late-throw')));
  step(t, 'late skip after a failed run', register('late-skip', hook('late-skip'), opts({ late: 'skip' })));
  step(t, 'late run of a completed name runs now', register('a', hook('a-late'), opts({ late: 'run' })));
  step(t, 'late run of a new name waits for the retry', register('pending', hook('pending'), opts({ late: 'run', after: ['flaky'] })));
  step(t, 'names after the failed run', () => s.finalizerNames());
  await stepAsync(t, 'retry completes', () => s.runStartupFinalizers());
  await stepAsync(t, 'run after done', () => s.runStartupFinalizers());
  step(t, 'late default after done', register('late-throw', hook('late-throw')));
  step(t, 'late skip after done', register('late-skip', hook('late-skip'), opts({ late: 'skip' })));
  step(t, 'late run after done runs now', register('late-run', hook('late-run'), opts({ late: 'run', after: ['a'] })));
  step(t, 'late run after done with an unknown dependency', register('late-dep', hook('late-dep'), opts({ late: 'run', after: ['missing'] })));
  step(t, 'late run after done that throws synchronously', register('late-sync', () => { throw new Error('sync boom'); }, opts({ late: 'run' })));
  step(t, 'late run with an aborted signal', register('late-aborted', hook('late-aborted'), opts({ late: 'run', signal: controller.signal })));
  step(t, 'names after done', () => s.finalizerNames());
  t.push(['hooks ran', 'ok', ran]);
  return t;
}

async function graphScript(make: () => Promise<Finalizers>): Promise<Trace> {
  const t: Trace = [];
  const cycle = await make();
  cycle.registerFinalizer('x', () => {}, opts({ after: ['y'] }));
  cycle.registerFinalizer('y', () => {}, opts({ after: ['x'] }));
  await stepAsync(t, 'cycle', () => cycle.runStartupFinalizers());
  step(t, 'registration after a cycle failure', () => cycle.registerFinalizer('z', () => {}));

  const unknown = await make();
  const ran: string[] = [];
  unknown.registerFinalizer('first', () => { ran.push('first'); });
  unknown.registerFinalizer('needs-missing', () => { ran.push('needs-missing'); }, opts({ after: ['missing'] }));
  await stepAsync(t, 'unknown dependency', () => unknown.runStartupFinalizers());
  t.push(['nothing ran before the dependency check', 'ok', ran]);
  return t;
}

async function disposerScript(register: (name: string, fn: Hook, options?: StartupFinalizerRegistration) => () => void, names: () => readonly string[], run: () => Promise<StartupFinalizerReport>): Promise<Trace> {
  const t: Trace = [];
  const ran: string[] = [];
  const first = register('p', () => { ran.push('first'); });
  step(t, 'disposer is a function', () => typeof first);
  first();
  first();
  step(t, 'the disposer removes the pending entry (idempotent)', () => names());
  register('p', () => { ran.push('second'); });
  first();
  step(t, 'a stale disposer leaves the newer registration', () => names());
  const done = register('q', () => { ran.push('q'); });
  await stepAsync(t, 'run', () => run());
  done();
  step(t, 'disposing a completed entry removes it', () => names());
  const late = register('q', () => { ran.push('q-late'); }, { late: 'run' });
  step(t, 'late run returns a no-op disposer', () => (late(), names()));
  t.push(['hooks ran', 'ok', ran]);
  return t;
}

describe('startup finalizers: mobile matches desktop step by step', () => {
  it('registration, signal, failure and retry, late policies, run after done', async () => {
    const desktop = desktopService();
    const mobile = await mobileService();
    try {
      const expected = await lifecycleScript(desktop);
      expect(await lifecycleScript(mobile)).toEqual(expected);
      expect(expected.find(([label]) => label === 'run after done')).toEqual(['run after done', 'ok', { completed: ['a', 'b', 'c', 'flaky', 'pending'], skipped: [] }]);
      expect(expected.at(-1)).toEqual(['hooks ran', 'ok', ['a', 'b', 'c-again', 'flaky', 'a-late', 'flaky', 'pending', 'late-run']]);
    } finally {
      desktop.shutdown();
      mobile.shutdown();
    }
  });

  it('cycles and unknown dependencies fail before any hook runs', async () => {
    const desktops: ReturnType<typeof desktopService>[] = [];
    const mobiles: MobileStorageService[] = [];
    try {
      const expected = await graphScript(async () => { const s = desktopService(); desktops.push(s); return s; });
      expect(await graphScript(async () => { const s = await mobileService(); mobiles.push(s); return s; })).toEqual(expected);
      expect(expected[0]).toEqual(['cycle', 'err', { code: 'FINALIZER_CYCLE', message: 'startup finalizer dependency cycle: x -> y -> x' }]);
    } finally {
      for (const s of [...desktops, ...mobiles]) s.shutdown();
    }
  });

  it('the disposer returned by mobile registerFinalizer behaves like the desktop registry disposer', async () => {
    const registry = new StartupFinalizerRegistry();
    const expected = await disposerScript((n, f, o) => registry.register(n, f, o), () => registry.names(), () => registry.run());
    const mobile = await mobileService();
    try {
      expect(await disposerScript((n, f, o) => mobile.registerFinalizer(n, f, o), () => mobile.finalizerNames(), () => mobile.runStartupFinalizers())).toEqual(expected);
    } finally {
      mobile.shutdown();
    }
  });
});

describe('mobile startup finalizers', () => {
  it('a late-run hook that rejects is logged as an error, not left as an unhandled rejection in the Worker', async () => {
    const logs: [string, string][] = [];
    const mobile = await mobileService((level, message) => logs.push([level, message]));
    try {
      await mobile.runStartupFinalizers();
      mobile.registerFinalizer('late-async', async () => { throw new Error('async boom'); }, { late: 'run' });
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(logs).toEqual([['error', 'startup finalizer failed: late-async: async boom']]);
    } finally {
      mobile.shutdown();
    }
  });

  it('a plugin that registers with a signal tied to ctx.effect: unload drops its hook, reinstall after the run does not throw', async () => {
    const host = await createTestHost({ provide: { sqliteRuntime: nodeRuntime(await nodeSqlite()) } });
    hosts.push(host);
    await host.install(mobileStorage);
    const ran: string[] = [];
    let generation = 0;
    const plugin = definePlugin({
      meta: { id: 'w31.finalizer-probe' },
      inject: ['storage'],
      apply(ctx: Context) {
        const current = ++generation;
        const finalizers = new AbortController();
        ctx.effect(() => () => finalizers.abort());
        const once: StartupFinalizerRegistration = { late: 'skip', signal: finalizers.signal };
        ctx.storage.registerFinalizer('w31.probe', () => { ran.push(`probe-${current}`); }, once);
      },
    });

    await host.install(plugin);
    await host.unload('w31.finalizer-probe');
    expect(host.ctx.storage.finalizerNames()).not.toContain('w31.probe');
    await host.install(plugin);
    expect((await host.ctx.storage.runStartupFinalizers()).completed).toContain('w31.probe');
    await host.unload('w31.finalizer-probe');
    await host.install(plugin);

    expect(host.plugins.map(p => p.id)).toContain('w31.finalizer-probe');
    expect(ran).toEqual(['probe-2']);
    expect(host.ctx.storage.finalizerNames()).not.toContain('w31.probe');
  });
});
