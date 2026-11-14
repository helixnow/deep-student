// @vitest-environment node
/**
 * FE-C4 / W27：`ctx.ui.host.on` —— 只订阅本插件命名空间（`host/kernel/plugin-id.ts` 派生），
 * 外来/近似前缀与非法字符在注册前抛错，插件卸载（含尚未 resolve 的注册）自动退订，
 * handler 异常与传输失败进本插件错误预算。
 */
import { describe, expect, it, vi } from 'vitest';
import { defineUiPlugin, UiKernel } from '../kernel';
import { pluginHostEventName, subscribeHostEvent, type UiEventTransport } from '../services/events';

/** In-memory transport: records listeners per event, returns a disposer that removes them. */
function memoryTransport() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const listen = vi.fn(async (event: string, handler: (payload: unknown) => void) => {
    const set = listeners.get(event) ?? new Set();
    set.add(handler);
    listeners.set(event, set);
    return () => void set.delete(handler);
  });
  const emit = (event: string, payload?: unknown) => {
    for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
  };
  const count = () => [...listeners.values()].reduce((total, set) => total + set.size, 0);
  return { listen, emit, count, listeners };
}

describe('pluginHostEventName', () => {
  it('derives a full name from a bare one and keeps a name already in this namespace', () => {
    expect(pluginHostEventName('example.word-of-day', 'changed')).toBe('example/word-of-day:changed');
    expect(pluginHostEventName('example.word-of-day', 'example/word-of-day:changed')).toBe('example/word-of-day:changed');
    expect(pluginHostEventName('acme.study-stats', 'sync-done')).toBe('acme/study-stats:sync-done');
  });

  it('RF-W17-host-event-own-prefix: rejects foreign, near-prefix, malformed and empty names before anything is registered', () => {
    expect(() => pluginHostEventName('example.word-of-day', 'dstu/ui.shell:changed')).toThrow(/outside this plugin's event namespace/);
    expect(() => pluginHostEventName('example.word-of-day', 'example/word-of-day-other:changed')).toThrow(/outside this plugin's event namespace/);
    expect(() => pluginHostEventName('example.word-of-day', 'other/clash:changed')).toThrow(/outside this plugin's event namespace/);
    expect(() => pluginHostEventName('example.word-of-day', 'a:b')).toThrow(/outside this plugin's event namespace/);
    expect(() => pluginHostEventName('example.word-of-day', '')).toThrow(/non-empty/);
    expect(() => pluginHostEventName('example.word-of-day', 'bad name')).toThrow(/only alphanumeric/);
    expect(() => pluginHostEventName('example.word-of-day', 'example/word-of-day:')).toThrow(/only alphanumeric/);
  });
});

describe('subscribeHostEvent', () => {
  it('rejects an invalid name or a missing transport without calling listen', () => {
    const transport = memoryTransport();
    const options = { pluginId: 'acme.notes', isActive: () => true, report: vi.fn() };
    expect(() => subscribeHostEvent(transport, options, 'other/plugin:changed', vi.fn())).toThrow(/outside this plugin's event namespace/);
    expect(transport.listen).not.toHaveBeenCalled();
    expect(() => subscribeHostEvent(undefined, options, 'changed', vi.fn())).toThrow(/event transport is not available/);
  });

  it('delivers the payload, stops on the disposer, and reports handler errors instead of throwing them', async () => {
    const transport = memoryTransport();
    const report = vi.fn();
    const received: unknown[] = [];
    const stop = subscribeHostEvent(transport, { pluginId: 'acme.notes', isActive: () => true, report }, 'changed', (payload) => {
      received.push(payload);
      throw new Error('handler boom');
    });
    await vi.waitFor(() => expect(transport.count()).toBe(1));
    transport.emit('acme/notes:changed', { minutes: 25 });
    expect(received).toEqual([{ minutes: 25 }]);
    expect(report).toHaveBeenCalledTimes(1);
    expect((report.mock.calls[0]![0] as Error).message).toBe('handler boom');
    stop();
    transport.emit('acme/notes:changed', { minutes: 30 });
    expect(received).toHaveLength(1);
    expect(transport.count()).toBe(0);
  });

  it('unsubscribes immediately when the transport acknowledges after the disposer ran', async () => {
    let resolveListen!: (off: () => void) => void;
    const off = vi.fn();
    const transport: UiEventTransport = { listen: () => new Promise((resolve) => { resolveListen = resolve; }) };
    const stop = subscribeHostEvent(transport, { pluginId: 'acme.notes', isActive: () => true, report: vi.fn() }, 'changed', vi.fn());
    stop();
    resolveListen(off);
    await vi.waitFor(() => expect(off).toHaveBeenCalledOnce());
  });

  it('drops events and late acknowledgements once the owning plugin is inactive', async () => {
    let active = true;
    let resolveListen!: (off: () => void) => void;
    const off = vi.fn();
    const handler = vi.fn();
    const transport: UiEventTransport = { listen: () => new Promise((resolve) => { resolveListen = resolve; }) };
    subscribeHostEvent(transport, { pluginId: 'acme.notes', isActive: () => active, report: vi.fn() }, 'changed', handler);
    active = false;
    resolveListen(off);
    await vi.waitFor(() => expect(off).toHaveBeenCalledOnce());
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('ctx.ui.host.on', () => {
  it('subscribes inside a plugin, unsubscribes with the fiber, and rejects the root context', async () => {
    const transport = memoryTransport();
    const kernel = new UiKernel({ events: transport });
    const received: unknown[] = [];
    let disposer: (() => void) | undefined;
    await kernel.install(defineUiPlugin({
      meta: { id: 'acme.notes' },
      apply(ctx) {
        disposer = ctx.ui.host.on<{ minutes: number }>('changed', (payload) => received.push(payload));
      },
    }));
    await vi.waitFor(() => expect(transport.listen).toHaveBeenCalledWith('acme/notes:changed', expect.any(Function)));
    transport.emit('acme/notes:changed', { minutes: 25 });
    expect(received).toEqual([{ minutes: 25 }]);

    expect(() => kernel.ui().host.on('acme/notes:changed', () => {})).toThrow(/only available inside a UI plugin/);
    expect(disposer).toBeTypeOf('function');

    await kernel.unload('acme.notes');
    await vi.waitFor(() => expect(transport.count()).toBe(0));
    transport.emit('acme/notes:changed', { minutes: 30 });
    expect(received).toHaveLength(1);
    await kernel.dispose();
  });

  it('reports handler errors against the plugin error budget', async () => {
    const transport = memoryTransport();
    const kernel = new UiKernel({ events: transport }, { errorBudget: { community: 10 } });
    await kernel.install(defineUiPlugin({
      meta: { id: 'acme.notes' },
      apply(ctx) {
        ctx.ui.host.on('changed', () => {
          throw new Error('listener failed');
        });
      },
    }));
    await vi.waitFor(() => expect(transport.count()).toBe(1));
    transport.emit('acme/notes:changed', {});
    expect(kernel.errors.count('acme.notes')).toBe(1);
    expect(kernel.errors.list('acme.notes')[0]).toMatchObject({ phase: 'report', slot: 'host.on:changed' });
    await kernel.dispose();
  });

  it('keeps Host services working next to the event subscription', async () => {
    const invoke = vi.fn(async () => 'pong');
    const kernel = new UiKernel({ events: memoryTransport(), invoke });
    let call: Promise<unknown> | undefined;
    await kernel.install(defineUiPlugin({
      meta: { id: 'acme.notes', host: true },
      apply(ctx) {
        call = ctx.ui.host.acmeNotes.ping('hi');
      },
    }));
    await expect(call).resolves.toBe('pong');
    expect(invoke).toHaveBeenCalledWith('plugin:host|call', {
      caller: 'acme.notes', service: 'acmeNotes', method: 'ping', args: ['hi'],
    });
    await kernel.dispose();
  });
});
