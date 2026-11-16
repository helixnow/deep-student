import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { definePlugin } from '../../../kernel/api.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import pluginServices from '../index.ts';
import { emitStudyEvent, pluginSecretSettingsKey, type NoteSavedEvent, type PluginJobRun } from '../api.ts';
import { nextSlot, PluginScheduler, previousSlot, SCHEDULER_TICK_MS, type SchedulerStore } from '../src/schedule.ts';

function memorySettings() {
  const plain = new Map<string, string>();
  const secure = new Map<string, string>();
  return {
    plain, secure,
    get: (key: string) => plain.get(key) ?? null,
    save: (key: string, value: string) => { plain.set(key, value); },
    delete: (key: string) => plain.delete(key),
    listByPrefix: () => [],
    deleteByPrefix: () => 0,
    saveSecret: async (key: string, value: string) => { secure.set(key, value); },
    getSecret: async (key: string) => secure.get(key) ?? null,
    deleteSecret: async (key: string) => secure.delete(key),
  };
}

/** A plugin that hands its context out, like a community plugin calling the services from apply(). */
function probe(id: string, seen: Map<string, Context>) {
  return definePlugin({
    meta: { id, version: '1.0.0', platforms: ['desktop'] },
    inject: ['pluginSecrets', 'pluginNotify', 'pluginSchedule'],
    apply(ctx) { seen.set(id, ctx); },
  });
}

let host: TestHost | undefined;
afterEach(async () => {
  await host?.dispose();
  host = undefined;
});

async function boot(extra: { notify?: ReturnType<typeof vi.fn> } = {}) {
  const settings = memorySettings();
  const seen = new Map<string, Context>();
  const notify = extra.notify ?? vi.fn(async () => ({ delivered: true, suppressed: null, error: null }));
  host = await createTestHost({
    provide: { settings, systemNotification: { notify, policy: () => 'always', notificationsDisabled: () => false } },
    plugins: [pluginServices, probe('alice.one', seen), probe('alice.two', seen)],
  });
  return { settings, seen, notify, one: seen.get('alice.one')!, two: seen.get('alice.two')! };
}

describe('pluginSecrets', () => {
  it('keeps each plugin\'s secrets apart, in the secure store', async () => {
    const { settings, one, two } = await boot();
    await one.pluginSecrets.set('api_key', 'sk-one');
    await two.pluginSecrets.set('api_key', 'sk-two');
    expect(await one.pluginSecrets.get('api_key')).toBe('sk-one');
    expect(await two.pluginSecrets.get('api_key')).toBe('sk-two');
    expect(settings.secure.get(pluginSecretSettingsKey('alice.one', 'api_key'))).toBe('sk-one');
    expect(settings.plain.size).toBe(0);
    expect(await one.pluginSecrets.delete('api_key')).toBe(true);
    expect(await one.pluginSecrets.get('api_key')).toBeNull();
    expect(await two.pluginSecrets.get('api_key')).toBe('sk-two');
    await expect(one.pluginSecrets.get('../other')).rejects.toThrow('PLUGIN_SECRET_KEY_INVALID');
  });

  it('refuses callers that are not a plugin', async () => {
    await boot();
    await expect(host!.ctx.get('pluginSecrets')!.get('x')).rejects.toThrow('only available to plugins');
  });
});

describe('pluginNotify', () => {
  it('sends a system notification whose click action opens the calling plugin', async () => {
    const { one, notify } = await boot();
    expect(await one.pluginNotify.notify({ title: '今日总结', body: '写好了', view: 'alice.one/summary' })).toEqual({ delivered: true });
    expect(notify).toHaveBeenCalledWith({ title: '今日总结', body: '写好了', action: { kind: 'plugin', pluginId: 'alice.one', view: 'alice.one/summary' } });
  });

  it('reports why a notification was not delivered', async () => {
    const notify = vi.fn(async () => ({ delivered: false, suppressed: 'policy', error: null }));
    const { two } = await boot({ notify });
    expect(await two.pluginNotify.notify({ title: 't', body: 'b' })).toEqual({ delivered: false, reason: 'policy' });
    await expect(two.pluginNotify.notify({ title: ' ', body: '' })).rejects.toThrow('PLUGIN_NOTIFY_INVALID');
  });
});

describe('pluginSchedule service', () => {
  it('runs startup jobs, lists them per plugin and cancels them when the plugin unloads', async () => {
    const { one, two } = await boot();
    const runs: PluginJobRun[] = [];
    one.pluginSchedule.onStartup('warm-up', (run) => { runs.push(run); });
    one.pluginSchedule.daily('nightly', '22:00', () => {});
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]).toMatchObject({ id: 'warm-up', catchUp: false, lastRunAt: null });
    expect(one.pluginSchedule.list().map((job) => job.id).sort()).toEqual(['nightly', 'warm-up']);
    expect(two.pluginSchedule.list()).toEqual([]);
    await one.pluginSchedule.runNow('warm-up');
    expect(runs).toHaveLength(2);
    await host!.unload('alice.one');
    expect(runs[1]!.signal.aborted).toBe(true);
    expect(() => one.pluginSchedule.daily('bad', '25:00', () => {})).toThrow();
  });
});

describe('PluginScheduler', () => {
  const at = (iso: string) => new Date(iso).getTime();

  function harness(start: number, state = new Map<string, string>()) {
    let now = start;
    const store: SchedulerStore = {
      read: (p, j) => (state.has(`${p}/${j}`) ? JSON.parse(state.get(`${p}/${j}`)!) : null),
      write: (p, j, record) => { state.set(`${p}/${j}`, JSON.stringify(record)); },
    };
    const scheduler = new PluginScheduler(store, { now: () => now, setInterval: () => 1, clearInterval: () => {} }, { warn: () => {} });
    return { scheduler, state, advance: (ms: number) => { now += ms; scheduler.tick(); }, set: (t: number) => { now = t; } };
  }

  it('computes daily and weekly slots in local time', () => {
    const now = at('2026-11-15T23:00:00');
    expect(previousSlot({ kind: 'daily', time: '22:00' }, now, 0)).toBe(at('2026-11-15T22:00:00'));
    expect(nextSlot({ kind: 'daily', time: '22:00' }, now, 0)).toBe(at('2026-11-16T22:00:00'));
    // 2026-11-15 is a Sunday (0); the last Monday 08:00 slot is 2026-11-09.
    expect(previousSlot({ kind: 'weekly', weekday: 1, time: '08:00' }, now, 0)).toBe(at('2026-11-09T08:00:00'));
    expect(nextSlot({ kind: 'weekly', weekday: 1, time: '08:00' }, now, 0)).toBe(at('2026-11-16T08:00:00'));
  });

  it('runs a daily job at its time, once, and catches up a slot missed while the app was closed', async () => {
    const first = harness(at('2026-11-15T21:00:00'));
    const runs: PluginJobRun[] = [];
    first.scheduler.register('alice.one', 'nightly', { kind: 'daily', time: '22:00' }, (run) => { runs.push(run); });
    await Promise.resolve();
    expect(runs).toHaveLength(0);
    first.advance(60 * 60_000 + 1000);
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]).toMatchObject({ scheduledAt: at('2026-11-15T22:00:00'), catchUp: false });
    first.advance(SCHEDULER_TICK_MS);
    await Promise.resolve();
    expect(runs).toHaveLength(1);
    first.scheduler.dispose();

    // Next start is two days later: the missed slots run once, flagged as a catch-up.
    const second = harness(at('2026-11-18T09:00:00'), first.state);
    second.scheduler.register('alice.one', 'nightly', { kind: 'daily', time: '22:00' }, (run) => { runs.push(run); });
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[1]).toMatchObject({ scheduledAt: at('2026-11-17T22:00:00'), catchUp: true, lastRunAt: expect.any(Number) });
  });

  it('keeps running after a job throws and never overlaps a job with itself', async () => {
    const h = harness(at('2026-11-15T10:00:00'));
    let calls = 0;
    let release!: () => void;
    h.scheduler.register('alice.one', 'poll', { kind: 'interval', minutes: 1 }, () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return new Promise<void>((resolve) => { release = resolve; });
    });
    h.advance(61_000);
    await vi.waitFor(() => expect(calls).toBe(1));
    h.advance(61_000);
    await vi.waitFor(() => expect(calls).toBe(2));
    h.advance(61_000);
    await Promise.resolve();
    expect(calls).toBe(2);
    release();
  });
});

describe('study events', () => {
  it('reach plugin listeners asynchronously and survive a throwing listener', async () => {
    const { one } = await boot();
    const got: NoteSavedEvent[] = [];
    one.on('study/note-saved', () => { throw new Error('listener bug'); });
    one.on('study/note-saved', (event) => { got.push(event); });
    emitStudyEvent(host!.ctx, 'study/note-saved', { noteId: 'n1', title: 'T', created: true });
    expect(got).toEqual([]);
    await vi.waitFor(() => expect(got).toEqual([{ noteId: 'n1', title: 'T', created: true }]));
  });
});
