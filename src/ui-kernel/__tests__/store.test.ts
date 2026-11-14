import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { defineUiPlugin, UiKernel } from '../kernel';
import { memoryStorageBackend } from '../services/storage';

async function pluginCtx(kernel: UiKernel, id = 'p'): Promise<Context> {
  let ctx: Context | undefined;
  await kernel.install(defineUiPlugin({ meta: { id }, apply: (c) => { ctx = c; } }));
  return ctx!;
}

describe('plugin store (createPluginStore)', () => {
  it('creates a zustand store from an initial state or a state creator', async () => {
    const kernel = new UiKernel();
    const ctx = await pluginCtx(kernel);
    const plain = ctx.ui.createStore({ count: 0, label: 'a' });
    plain.setState({ count: 1 });
    plain.setState((s) => ({ count: s.count + 1 }));
    expect(plain.getState()).toEqual({ count: 2, label: 'a' });
    expect(plain.getInitialState()).toEqual({ count: 0, label: 'a' });

    const counter = ctx.ui.createStore<{ count: number; inc(): void }>((set, get) => ({ count: 0, inc: () => set({ count: get().count + 1 }) }));
    counter.getState().inc();
    counter.getState().inc();
    expect(counter.getState().count).toBe(2);
    await kernel.dispose();
  });

  it('resets state and drops subscribers when the owning plugin unloads, then ignores late writes', async () => {
    const kernel = new UiKernel();
    const ctx = await pluginCtx(kernel);
    const store = ctx.ui.createStore({ count: 0 });
    const listener = vi.fn();
    store.subscribe(listener);
    store.setState({ count: 5 });
    expect(listener).toHaveBeenCalledTimes(1);

    await kernel.unload('p');
    expect(store.disposed).toBe(true);
    expect(store.getState()).toEqual({ count: 0 });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1]![0]).toEqual({ count: 0 });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.setState({ count: 9 });
    expect(store.getState()).toEqual({ count: 0 });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    await kernel.dispose();
  });

  it('persists selected state through ctx.ui.storage and survives the reset on unload', async () => {
    const backend = memoryStorageBackend({ 'ds:plugin:p:settings': '{"days":14}' });
    const kernel = new UiKernel({ storage: backend });
    const ctx = await pluginCtx(kernel);
    const store = ctx.ui.createStore({ days: 7, draft: '', bump() {} }, { persist: { key: 'settings', pick: (s) => ({ days: s.days }) } });
    expect(store.getState().days).toBe(14);
    expect(typeof store.getState().bump).toBe('function');
    store.setState({ days: 30, draft: 'not persisted' });
    expect(backend.dump()['ds:plugin:p:settings']).toBe('{"days":30}');

    await kernel.unload('p');
    expect(store.getState().days).toBe(7);
    expect(backend.dump()['ds:plugin:p:settings']).toBe('{"days":30}');

    const again = await pluginCtx(kernel);
    expect(again.ui.createStore({ days: 7 }, { persist: { key: 'settings' } }).getState()).toEqual({ days: 30 });
    await kernel.dispose();
  });

  it('is plugin-owned: the root context cannot create stores', () => {
    expect(() => new UiKernel().ui().createStore({})).toThrow('ctx.ui.createStore is only available inside a UI plugin');
  });
});
