/**
 * V09 P1-3：启动 finalizer 可注销、晚注册按插件意图跳过或立即执行。
 * 插件经 `ctx.storage.registerFinalizer` 调用；包装层（service.ts）丢弃返回值时，
 * `signal` 选项仍能注销，`late` 选项原样穿过包装层。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { createTestHost, definePlugin, type TestHost } from '../../../kernel/testing.ts';
import { StartupFinalizerError } from '../api.ts';
import { StorageCordisService } from '../service.ts';
import { StartupFinalizerRegistry, type StartupFinalizerRegistration } from '../startup-finalizers.ts';

describe('V09-P1-3 StartupFinalizerRegistry disposer and late registration (R4)', () => {
  it('V09-P1-3: registering after run with late skip does not throw and does not run', async () => {
    const registry = new StartupFinalizerRegistry();
    registry.register('plugin.startup', () => {});
    await registry.run();
    let ran = 0;
    expect(() => registry.register('plugin.startup', () => { ran += 1; }, { late: 'skip' })).not.toThrow();
    expect(() => registry.register('plugin.other', () => { ran += 1; }, { late: 'skip' })).not.toThrow();
    expect(ran).toBe(0);
  });

  it('V09-P1-3: registering after run with late run executes the hook immediately, once', async () => {
    const registry = new StartupFinalizerRegistry();
    registry.register('plugin.startup', () => {});
    await registry.run();
    const ran: string[] = [];
    const dispose = registry.register('plugin.startup', () => { ran.push('again'); }, { late: 'run' });
    expect(ran).toEqual(['again']);
    expect(typeof dispose).toBe('function');
    dispose();
    expect(await registry.run()).toEqual({ completed: ['plugin.startup'], skipped: [] });
    expect(ran).toEqual(['again']);
  });

  it('V09-P1-3: default late policy still throws FINALIZER_LATE_REGISTRATION', async () => {
    const registry = new StartupFinalizerRegistry();
    await registry.run();
    expect(() => registry.register('late', () => {})).toThrow(expect.objectContaining({ code: 'FINALIZER_LATE_REGISTRATION' }));
    expect(() => registry.register('late', () => {}, { late: 'throw' }))
      .toThrow(expect.objectContaining({ code: 'FINALIZER_LATE_REGISTRATION' }));
  });

  it('V09-P1-3: the disposer removes a pending entry so the name can be registered again', async () => {
    const registry = new StartupFinalizerRegistry();
    const ran: string[] = [];
    const dispose = registry.register('plugin.startup', () => { ran.push('first'); });
    expect(registry.names()).toEqual(['plugin.startup']);
    dispose();
    dispose();
    expect(registry.names()).toEqual([]);
    registry.register('plugin.startup', () => { ran.push('second'); });
    expect(await registry.run()).toEqual({ completed: ['plugin.startup'], skipped: [] });
    expect(ran).toEqual(['second']);
  });

  it('V09-P1-3: a stale disposer does not remove a newer registration of the same name', async () => {
    const registry = new StartupFinalizerRegistry();
    const ran: string[] = [];
    const disposeFirst = registry.register('plugin.startup', () => { ran.push('first'); });
    disposeFirst();
    registry.register('plugin.startup', () => { ran.push('second'); });
    disposeFirst();
    expect(registry.names()).toEqual(['plugin.startup']);
    await registry.run();
    expect(ran).toEqual(['second']);
  });

  it('V09-P1-3: aborting the signal unregisters like the disposer; an aborted signal registers nothing', async () => {
    const registry = new StartupFinalizerRegistry();
    const ran: string[] = [];
    const controller = new AbortController();
    registry.register('plugin.startup', () => { ran.push('first'); }, { signal: controller.signal });
    controller.abort();
    expect(registry.names()).toEqual([]);
    registry.register('plugin.startup', () => { ran.push('second'); });
    registry.register('plugin.aborted', () => { ran.push('aborted'); }, { signal: controller.signal });
    expect(registry.names()).toEqual(['plugin.startup']);
    await registry.run();
    expect(ran).toEqual(['second']);
  });

  it('V09-P1-3: a late run registered while finalizers are running runs in the same run; disposing it first skips it', async () => {
    const registry = new StartupFinalizerRegistry();
    const ran: string[] = [];
    let disposeSkipped = (): void => {};
    registry.register('boot', () => {
      ran.push('boot');
      registry.register('late.run', () => { ran.push('late.run'); }, { late: 'run', after: ['boot'] });
      disposeSkipped = registry.register('late.disposed', () => { ran.push('late.disposed'); }, { late: 'run' });
      registry.register('late.skip', () => { ran.push('late.skip'); }, { late: 'skip' });
    });
    registry.register('next', () => {
      ran.push('next');
      disposeSkipped();
    });
    expect(await registry.run()).toEqual({ completed: ['boot', 'next', 'late.run'], skipped: [] });
    expect(ran).toEqual(['boot', 'next', 'late.run']);
  });

  it('V09-P1-3: a hook re-registered with late run while its old instance is still awaiting runs once in the same run', async () => {
    const registry = new StartupFinalizerRegistry();
    const ran: string[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    registry.register('plugin.startup', async () => { ran.push('old:start'); await held; ran.push('old:end'); },
      { signal: controller.signal });
    const running = registry.run();
    await Promise.resolve();
    expect(ran).toEqual(['old:start']);
    controller.abort();
    registry.register('plugin.startup', () => { ran.push('new'); }, { late: 'run' });
    release();
    expect(await running).toEqual({ completed: ['plugin.startup'], skipped: [] });
    expect(ran).toEqual(['old:start', 'old:end', 'new']);
  });

  it('V09-P1-3: an old instance that rejects after being replaced does not fail the run; the new instance runs', async () => {
    const lateErrors: StartupFinalizerError[] = [];
    const registry = new StartupFinalizerRegistry({ onLateError: (error) => { lateErrors.push(error); } });
    const ran: string[] = [];
    let fail: (error: Error) => void = () => {};
    const held = new Promise<void>((_resolve, reject) => { fail = reject; });
    const controller = new AbortController();
    registry.register('plugin.startup', async () => { ran.push('old:start'); await held; },
      { signal: controller.signal });
    registry.register('plugin.next', () => { ran.push('next'); });
    const running = registry.run();
    await Promise.resolve();
    controller.abort();
    registry.register('plugin.startup', () => { ran.push('new'); }, { late: 'run' });
    const closed = new Error('connection closed after unload');
    fail(closed);
    expect(await running).toEqual({ completed: ['plugin.next', 'plugin.startup'], skipped: [] });
    expect(ran).toEqual(['old:start', 'next', 'new']);
    expect(lateErrors).toHaveLength(1);
    expect(lateErrors[0]!.finalizer).toBe('plugin.startup');
    expect(lateErrors[0]!.cause).toBe(closed);
  });

  it('V09-P1-3: a late run that throws synchronously surfaces a StartupFinalizerError and registers nothing', async () => {
    const registry = new StartupFinalizerRegistry();
    await registry.run();
    const original = new Error('late boom');
    let caught: unknown;
    try {
      registry.register('late.fail', () => { throw original; }, { late: 'run' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StartupFinalizerError);
    expect((caught as StartupFinalizerError).finalizer).toBe('late.fail');
    expect((caught as StartupFinalizerError).cause).toBe(original);
    expect(registry.names()).toEqual([]);
  });

  it('V09-P1-3: a late run whose promise rejects reaches onLateError', async () => {
    const failures: StartupFinalizerError[] = [];
    const registry = new StartupFinalizerRegistry({ onLateError: (error) => { failures.push(error); } });
    await registry.run();
    const original = new Error('async late boom');
    registry.register('late.async', async () => { throw original; }, { late: 'run' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(StartupFinalizerError);
    expect(failures[0]!.finalizer).toBe('late.async');
    expect(failures[0]!.cause).toBe(original);
  });

  it('V09-P1-3: after a failed run, late run waits for the retry and late skip is a no-op', async () => {
    const registry = new StartupFinalizerRegistry();
    const ran: string[] = [];
    let fail = true;
    const disposeMigrate = registry.register('migrate', () => { ran.push('migrate'); });
    registry.register('restore', () => {
      ran.push('restore');
      if (fail) throw new Error('restore failed');
    }, { after: ['migrate'] });
    await expect(registry.run()).rejects.toBeInstanceOf(StartupFinalizerError);

    // The completed hook's owner unloads: retry must not report its name as an unknown dependency.
    disposeMigrate();
    registry.register('gate', () => { ran.push('gate'); }, { late: 'run', after: ['restore'] });
    registry.register('cleanup', () => { ran.push('cleanup'); }, { late: 'skip' });
    // The slot of `migrate` already passed: a re-registered late run executes immediately.
    registry.register('migrate', () => { ran.push('migrate.again'); }, { late: 'run' });
    expect(ran).toEqual(['migrate', 'restore', 'migrate.again']);

    fail = false;
    expect(await registry.run()).toEqual({ completed: ['migrate', 'restore', 'gate'], skipped: [] });
    expect(ran).toEqual(['migrate', 'restore', 'migrate.again', 'restore', 'gate']);
  });

  it('V09-P1-3: rejects an unknown late policy and an unknown late-run dependency', async () => {
    const registry = new StartupFinalizerRegistry();
    expect(() => registry.register('x', () => {}, { late: 'later' as never }))
      .toThrow(expect.objectContaining({ code: 'FINALIZER_INVALID' }));
    await registry.run();
    let ran = false;
    expect(() => registry.register('x', () => { ran = true; }, { late: 'run', after: ['missing'] }))
      .toThrow(expect.objectContaining({ code: 'FINALIZER_UNKNOWN_DEPENDENCY' }));
    expect(ran).toBe(false);
  });
});

class TestStorage extends StorageCordisService {
  constructor(ctx: Context) {
    super(ctx, { dataLocalDir: ctx.app.dataDir });
  }
}

interface FinalizerStorage {
  registerFinalizer(name: string, fn: () => void, options?: StartupFinalizerRegistration): unknown;
  runStartupFinalizers(): Promise<{ completed: readonly string[] }>;
  finalizerNames(): readonly string[];
}

function reloadablePlugin(id: string, late: 'skip' | 'run', ran: string[]) {
  let generation = 0;
  return definePlugin({
    meta: { id },
    inject: ['storage'],
    apply(ctx) {
      generation += 1;
      const mine = generation;
      const storage = ctx.get('storage') as FinalizerStorage;
      const controller = new AbortController();
      const options: StartupFinalizerRegistration = { late, signal: controller.signal };
      storage.registerFinalizer(`${id}.startup`, () => { ran.push(`gen${mine}`); }, options);
      ctx.effect(() => () => controller.abort());
    },
  });
}

describe('V09-P1-3 plugin install, run, unload and reinstall through ctx.storage', () => {
  const hosts: TestHost[] = [];
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.dispose();
  });

  async function host(): Promise<{ host: TestHost; storage: FinalizerStorage }> {
    const created = await createTestHost({ provide: { storage: TestStorage } });
    hosts.push(created);
    return { host: created, storage: created.ctx.get('storage') as FinalizerStorage };
  }

  it('V09-P1-3: install -> runStartupFinalizers -> unload -> reinstall succeeds and a late run executes', async () => {
    const ran: string[] = [];
    const plugin = reloadablePlugin('fixture.finalizer-reload', 'run', ran);
    const { host: h, storage } = await host();
    await h.install(plugin);
    expect((await storage.runStartupFinalizers()).completed).toEqual(['fixture.finalizer-reload.startup']);
    expect(ran).toEqual(['gen1']);
    await h.unload('fixture.finalizer-reload');
    await h.install(plugin);
    expect(h.plugins.map((p) => p.id)).toContain('fixture.finalizer-reload');
    expect(ran).toEqual(['gen1', 'gen2']);
  });

  it('V09-P1-3: reinstall with late skip after startup succeeds without running the hook again', async () => {
    const ran: string[] = [];
    const plugin = reloadablePlugin('fixture.finalizer-skip', 'skip', ran);
    const { host: h, storage } = await host();
    await h.install(plugin);
    await storage.runStartupFinalizers();
    await h.unload('fixture.finalizer-skip');
    await h.install(plugin);
    expect(h.plugins.map((p) => p.id)).toContain('fixture.finalizer-skip');
    expect(ran).toEqual(['gen1']);
  });

  it('V09-P1-3: unload before startup drops the stale closure; only the reinstalled hook runs', async () => {
    const ran: string[] = [];
    const plugin = reloadablePlugin('fixture.finalizer-early', 'skip', ran);
    const { host: h, storage } = await host();
    await h.install(plugin);
    await h.unload('fixture.finalizer-early');
    expect(storage.finalizerNames()).toEqual([]);
    await h.install(plugin);
    expect(storage.finalizerNames()).toEqual(['fixture.finalizer-early.startup']);
    expect((await storage.runStartupFinalizers()).completed).toEqual(['fixture.finalizer-early.startup']);
    expect(ran).toEqual(['gen2']);
  });
});
