import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Registry } from '@/features/chat/registry/Registry';
import { commandRegistry } from '@/command-palette/registry/commandRegistry';
import { appRegistry } from '@/features/workbench/core/appRegistry';
import { defineUiPlugin, UiKernel, type UiAdapters } from '../kernel';
import { createLegacyRegistryAdapters } from '../legacy-adapters';
import { UiKernelProvider, useRegistry, useRegistryEntry } from '../react';

function memoryBlocks() {
  const blocks = new Map<string, unknown>();
  const adapter: NonNullable<UiAdapters['chatBlocks']> = {
    register(type, renderer) {
      if (blocks.has(type)) throw new Error(`dup ${type}`);
      blocks.set(type, renderer);
      return () => void blocks.delete(type);
    },
    list: () => [...blocks.values()],
    get: (type) => blocks.get(type),
  };
  return { adapter, blocks };
}

const blockPlugin = (id: string, type: string) =>
  defineUiPlugin({ meta: { id }, apply: (ctx) => ctx.ui.chat.registerBlock(type, { type, component: () => null }) });

describe('adapter registries (subscription for legacy registries)', () => {
  it('notifies subscribers on kernel-path registration and revocation even when the registry has no native subscription', async () => {
    const { adapter } = memoryBlocks();
    const kernel = new UiKernel({ chatBlocks: adapter });
    const registry = kernel.registries.chatBlocks;
    expect(registry.available).toBe(true);
    const listener = vi.fn();
    registry.subscribe(listener);
    const before = registry.list();
    expect(registry.list()).toBe(before);

    await kernel.install(blockPlugin('community.quiz', 'quiz'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.list()).not.toBe(before);
    expect(registry.list()).toEqual([{ type: 'quiz', component: expect.any(Function) }]);
    expect(registry.get('quiz')).toMatchObject({ type: 'quiz' });

    await kernel.unload('community.quiz');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(registry.list()).toEqual([]);
    await kernel.dispose();
  });

  it('forwards native subscriptions lazily so registrations outside the kernel also notify', () => {
    const listeners = new Set<() => void>();
    const items = new Map<string, { typeId: string }>();
    const kernel = new UiKernel({
      workbenchApps: {
        register: (def) => (items.set(def.typeId, def), () => void items.delete(def.typeId)),
        subscribe: (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
        list: () => [...items.values()],
      },
    });
    const listener = vi.fn();
    expect(listeners.size).toBe(0);
    const off = kernel.registries.workbenchApps.subscribe(listener);
    expect(listeners.size).toBe(1);
    items.set('legacy', { typeId: 'legacy' });
    for (const fn of listeners) fn();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(kernel.registries.workbenchApps.list()).toEqual([{ typeId: 'legacy' }]);
    off();
    expect(listeners.size).toBe(0);
  });

  it('reports unavailable registries without throwing on reads', () => {
    const registry = new UiKernel().registries.commands;
    expect(registry.available).toBe(false);
    expect(registry.list()).toEqual([]);
    expect(registry.get('x')).toBeUndefined();
    registry.subscribe(() => {})();
  });

  it('re-renders consumers when a block type is registered late (the BlockRenderer gap)', async () => {
    const { adapter } = memoryBlocks();
    const kernel = new UiKernel({ chatBlocks: adapter });
    function Renderer() {
      const plugin = useRegistryEntry<{ type: string }>('chatBlocks', 'late');
      const all = useRegistry('chatBlocks');
      return <p>{plugin ? `has ${plugin.type}` : 'missing'} / {all.length}</p>;
    }
    render(<UiKernelProvider kernel={kernel}><Renderer /></UiKernelProvider>);
    expect(screen.getByText('missing / 0')).toBeTruthy();
    await act(() => kernel.install(blockPlugin('community.late', 'late')));
    expect(screen.getByText('has late / 1')).toBeTruthy();
    await act(() => kernel.unload('community.late'));
    expect(screen.getByText('missing / 0')).toBeTruthy();
    await kernel.dispose();
  });
});

describe('production legacy registry adapters', () => {
  it('chat blocks: conflicts throw, revocation only removes the same renderer, kernel subscribers see changes', async () => {
    const blockRegistry = new Registry<{ type: string }>('TestBlocks', { warnOnOverwrite: true });
    blockRegistry.register('official', { type: 'official' });
    const adapters = createLegacyRegistryAdapters({ commandRegistry, blockRegistry, appRegistry });
    const kernel = new UiKernel(adapters);
    await expect(kernel.install(blockPlugin('community.clash', 'official'))).rejects.toThrow('chat block type "official" is already registered; use an id of your own');

    const listener = vi.fn();
    kernel.registries.chatBlocks.subscribe(listener);
    await kernel.install(blockPlugin('community.quiz', 'quiz'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(kernel.registries.chatBlocks.get('quiz')).toMatchObject({ type: 'quiz' });
    expect(kernel.registries.chatBlocks.list().map((b) => (b as { type: string }).type)).toEqual(['official', 'quiz']);

    const replacement = { type: 'quiz-replaced' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    blockRegistry.register('quiz', replacement);
    warn.mockRestore();
    // FE-B2: the chat registry is subscribable, so registrations that bypass the kernel are seen too.
    expect(listener).toHaveBeenCalledTimes(2);
    await kernel.unload('community.quiz');
    expect(blockRegistry.get('quiz')).toBe(replacement);
    expect(listener).toHaveBeenCalledTimes(3);
    await kernel.dispose();
  });

  it('commands: conflicts throw instead of warn-and-overwrite, identity-checked revocation, native subscription', async () => {
    const adapters = createLegacyRegistryAdapters({ commandRegistry, blockRegistry: new Registry('B'), appRegistry });
    const kernel = new UiKernel(adapters);
    const official = { id: 'w17.test.official', name: 'Official', category: 'navigation', execute: () => undefined };
    const removeOfficial = commandRegistry.register(official as never);
    try {
      await expect(kernel.install(defineUiPlugin({ meta: { id: 'community.clash' }, apply: (ctx) => ctx.ui.commands.register({ ...official }) })))
        .rejects.toThrow('command "w17.test.official" is already registered; use an id of your own');
      expect(commandRegistry.getById('w17.test.official')).toBe(official);

      const listener = vi.fn();
      const off = kernel.registries.commands.subscribe(listener);
      await kernel.install(defineUiPlugin({ meta: { id: 'community.cmd' }, apply: (ctx) => ctx.ui.commands.register({ id: 'w17.test.mine', name: 'Mine', category: 'navigation', execute: () => undefined }) }));
      expect(kernel.registries.commands.get('w17.test.mine')).toMatchObject({ name: 'Mine' });
      expect(listener).toHaveBeenCalled();
      const calls = listener.mock.calls.length;
      await kernel.unload('community.cmd');
      expect(commandRegistry.getById('w17.test.mine')).toBeUndefined();
      expect(listener.mock.calls.length).toBeGreaterThan(calls);
      off();
    } finally {
      removeOfficial();
      await kernel.dispose();
    }
  });

  it('workbench apps: conflicts throw and revocation keeps an overriding definition', async () => {
    const adapters = createLegacyRegistryAdapters({ commandRegistry, blockRegistry: new Registry('B'), appRegistry });
    const kernel = new UiKernel(adapters);
    const app = (typeId: string) => ({ typeId, nameKey: typeId, icon: null, instanceMode: 'single', memoryWeight: 1 });
    try {
      await kernel.install(defineUiPlugin({ meta: { id: 'community.app' }, apply: (ctx) => ctx.ui.workbench.registerApp(app('w17-test-app')) }));
      expect(kernel.registries.workbenchApps.get('w17-test-app')).toMatchObject({ typeId: 'w17-test-app' });
      await expect(kernel.install(defineUiPlugin({ meta: { id: 'community.clash' }, apply: (ctx) => ctx.ui.workbench.registerApp(app('w17-test-app')) })))
        .rejects.toThrow('workbench app "w17-test-app" is already registered; use an id of your own');
      await kernel.unload('community.app');
      expect(appRegistry.get('w17-test-app')).toBeUndefined();
    } finally {
      appRegistry.unregister('w17-test-app');
      await kernel.dispose();
    }
  });
});
