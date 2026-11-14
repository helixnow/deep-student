import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { defineUiPlugin, UiKernel } from '../kernel';
import { UiPluginDisposedError } from '../scope';
import { memoryStorageBackend, pluginStoragePrefix, type PluginStorage } from '../services/storage';

async function storageOf(kernel: UiKernel, id: string): Promise<{ ctx: Context; storage: PluginStorage }> {
  let ctx: Context | undefined;
  await kernel.install(defineUiPlugin({ meta: { id }, apply: (c) => { ctx = c; } }));
  return { ctx: ctx!, storage: ctx!.ui.storage };
}

describe('storage service', () => {
  it('namespaces every key under ds:plugin:<id>: and isolates plugins from each other', async () => {
    const backend = memoryStorageBackend({ 'unrelated': 'keep' });
    const kernel = new UiKernel({ storage: backend });
    const a = await storageOf(kernel, 'community.a');
    const b = await storageOf(kernel, 'community.b');
    a.storage.set('settings', { days: 7 });
    a.storage.set('count', 3);
    expect(backend.dump()).toEqual({
      unrelated: 'keep',
      'ds:plugin:community.a:settings': '{"days":7}',
      'ds:plugin:community.a:count': '3',
    });
    expect(a.storage.get('settings')).toEqual({ days: 7 });
    expect(a.storage.keys()).toEqual(['count', 'settings']);
    expect(b.storage.get('settings')).toBeUndefined();
    expect(b.storage.get('settings', { days: 30 })).toEqual({ days: 30 });
    expect(b.storage.keys()).toEqual([]);
    b.storage.clear();
    expect(a.storage.keys()).toEqual(['count', 'settings']);
    a.storage.clear();
    expect(backend.dump()).toEqual({ unrelated: 'keep' });
    await kernel.dispose();
  });

  it('escapes plugin ids so prefixes cannot collide', async () => {
    expect(pluginStoragePrefix('community.word-of-day')).toBe('ds:plugin:community.word-of-day:');
    const backend = memoryStorageBackend();
    const kernel = new UiKernel({ storage: backend });
    (await storageOf(kernel, 'a:b')).storage.set('c', 1);
    (await storageOf(kernel, 'a')).storage.set('b:c', 2);
    expect(Object.keys(backend.dump()).sort()).toEqual(['ds:plugin:a%3Ab:c', 'ds:plugin:a:b:c']);
    expect((await storageOf(kernel, 'a')).storage.get('b:c')).toBe(2);
    await kernel.dispose();
  });

  it('removes keys on set(undefined), tolerates corrupt values and rejects unserializable ones', async () => {
    const backend = memoryStorageBackend({ 'ds:plugin:p:broken': '{not json' });
    const kernel = new UiKernel({ storage: backend });
    const { storage } = await storageOf(kernel, 'p');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(storage.get('broken', 'fallback')).toBe('fallback');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    storage.set('x', 1);
    storage.set('x', undefined);
    expect(storage.keys()).toEqual(['broken']);
    expect(() => storage.set('big', 10n)).toThrow(TypeError);
    expect(() => storage.set('', 1)).toThrow('ctx.ui.storage: key must be a non-empty string');
    await kernel.dispose();
  });

  it('offers a typed JSON cell with change notifications', async () => {
    const kernel = new UiKernel({ storage: memoryStorageBackend() });
    const { storage } = await storageOf(kernel, 'p');
    const cell = storage.json('settings', { days: 7, compact: false });
    const seen: unknown[] = [];
    cell.subscribe((value) => seen.push(value));
    expect(cell.get()).toEqual({ days: 7, compact: false });
    cell.set({ days: 14, compact: false });
    cell.set((prev) => ({ ...prev, compact: true }));
    expect(storage.get('settings')).toEqual({ days: 14, compact: true });
    cell.reset();
    expect(cell.get()).toEqual({ days: 7, compact: false });
    expect(storage.keys()).toEqual([]);
    expect(seen).toEqual([{ days: 14, compact: false }, { days: 14, compact: true }, { days: 7, compact: false }]);
    await kernel.dispose();
  });

  it('notifies subscribers of the same plugin only', async () => {
    const kernel = new UiKernel({ storage: memoryStorageBackend() });
    const a = await storageOf(kernel, 'a');
    const b = await storageOf(kernel, 'b');
    const onA = vi.fn();
    const onB = vi.fn();
    a.storage.subscribe('k', onA);
    b.storage.subscribe('k', onB);
    a.ctx.ui.storage.set('k', 1);
    a.storage.remove('k');
    expect(onA.mock.calls).toEqual([[1], [undefined]]);
    expect(onB).not.toHaveBeenCalled();
    await kernel.dispose();
  });

  it('revokes subscriptions and handles on unload but keeps the data until the plugin is cleared', async () => {
    const backend = memoryStorageBackend();
    const kernel = new UiKernel({ storage: backend });
    const first = await storageOf(kernel, 'p');
    const listener = vi.fn();
    first.storage.subscribe('k', listener);
    first.storage.set('k', 'v1');
    expect(listener).toHaveBeenCalledTimes(1);

    await kernel.unload('p');
    expect(() => first.storage.set('k', 'stale')).toThrow(UiPluginDisposedError);
    expect(() => first.storage.get('k')).toThrow(UiPluginDisposedError);

    const second = await storageOf(kernel, 'p');
    expect(second.storage.get('k')).toBe('v1');
    second.storage.set('k', 'v2');
    expect(listener).toHaveBeenCalledTimes(1);

    await kernel.unload('p');
    expect(kernel.storage.clear('p')).toBe(1);
    expect(backend.dump()).toEqual({});
    await kernel.dispose();
  });

  it('is plugin-private: the root context has no storage', () => {
    const kernel = new UiKernel({ storage: memoryStorageBackend() });
    expect(() => kernel.ui().storage).toThrow('ctx.ui.storage is only available inside a UI plugin');
  });

  it('falls back to window.localStorage when no backend is injected', async () => {
    window.localStorage.removeItem('ds:plugin:default:k');
    const kernel = new UiKernel();
    (await storageOf(kernel, 'default')).storage.set('k', [1]);
    expect(window.localStorage.getItem('ds:plugin:default:k')).toBe('[1]');
    window.localStorage.removeItem('ds:plugin:default:k');
    await kernel.dispose();
  });
});
