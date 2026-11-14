import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { commandRegistry } from '@/command-palette/registry/commandRegistry';
import { appRegistry } from '@/features/workbench/core/appRegistry';
import { blockRegistry } from '@/features/chat/registry/blockRegistry';
import { defineUiPlugin, UiKernel, type UiCommand, type UiWorkbenchApp } from '../kernel';
import { memoryRegistryAdapters } from '../../ui-plugins/testing/registries';

const command = (id: string, name = id): UiCommand => ({ id, name, category: 'global', execute: () => undefined });
const app = (typeId: string) => ({
  typeId, nameKey: typeId, icon: null, instanceMode: 'single', memoryWeight: 1,
  defaultFrame: { width: 100, height: 100 }, minSize: { width: 10, height: 10 }, render: null,
}) as unknown as UiWorkbenchApp;

let kernel: UiKernel | undefined;
afterEach(async () => {
  await kernel?.dispose();
  kernel = undefined;
});

async function plugin(k: UiKernel, id: string): Promise<Context> {
  let ctx: Context | undefined;
  await k.install(defineUiPlugin({ meta: { id }, apply: (c) => { ctx = c; } }));
  return ctx!;
}

describe('registration handles (W18 kernel gap 1)', () => {
  it('commands.register returns a handle that revokes only that command, before the plugin unloads', async () => {
    kernel = new UiKernel(memoryRegistryAdapters());
    const ctx = await plugin(kernel, 'community.cmds');
    const offA = ctx.ui.commands.register(command('w17.a'));
    ctx.ui.commands.register(command('w17.b'));
    const listener = vi.fn();
    kernel.registries.commands.subscribe(listener);

    offA();
    expect(kernel.registries.commands.list().map((c) => c.id)).toEqual(['w17.b']);
    expect(listener).toHaveBeenCalledTimes(1);
    offA();
    expect(listener).toHaveBeenCalledTimes(1);

    // Replacing a command: revoke, then register a new object under the same id.
    ctx.ui.commands.register(command('w17.a', 'Renamed'));
    expect(kernel.registries.commands.get('w17.a')).toMatchObject({ name: 'Renamed' });

    await kernel.unload('community.cmds');
    expect(kernel.registries.commands.list()).toEqual([]);
    expect(() => offA()).not.toThrow();
  });

  it('keeps the kernel conflict semantics: a duplicate command id throws instead of overriding', async () => {
    kernel = new UiKernel({ legacyRegistries: { commandRegistry, blockRegistry, appRegistry } });
    const ctx = await plugin(kernel, 'community.first');
    const off = ctx.ui.commands.register(command('w17.conflict', 'First'));
    const other = await plugin(kernel, 'community.second');
    expect(() => other.ui.commands.register(command('w17.conflict', 'Second'))).toThrow('command "w17.conflict" is already registered');
    expect(commandRegistry.getById('w17.conflict')).toMatchObject({ name: 'First' });
    off();
    expect(commandRegistry.getById('w17.conflict')).toBeUndefined();
    other.ui.commands.register(command('w17.conflict', 'Second'));
    expect(commandRegistry.getById('w17.conflict')).toMatchObject({ name: 'Second' });
    await kernel.dispose();
    expect(commandRegistry.getById('w17.conflict')).toBeUndefined();
  });

  it('workbench.registerApp returns a handle that removes only that app', async () => {
    kernel = new UiKernel(memoryRegistryAdapters());
    const ctx = await plugin(kernel, 'community.apps');
    const off = ctx.ui.workbench.registerApp(app('w17-timer'));
    ctx.ui.workbench.registerApp(app('w17-notes'));
    off();
    expect(kernel.registries.workbenchApps.list().map((a) => a.typeId)).toEqual(['w17-notes']);
    await kernel.unload('community.apps');
    expect(kernel.registries.workbenchApps.list()).toEqual([]);
  });

  it('chat.registerBlock and slot contributions return handles too', async () => {
    kernel = new UiKernel(memoryRegistryAdapters());
    const ctx = await plugin(kernel, 'community.blocks');
    const offBlock = ctx.ui.chat.registerBlock('w17-quiz', { type: 'w17-quiz', component: () => null });
    const offNav = ctx.ui.nav.register({ id: 'w17-nav', viewId: 'w17', labelKey: 'nav' });
    const offTool = ctx.ui.chat.registerToolResult('w17_tool', () => null);
    expect(kernel.registries.chatBlocks.get('w17-quiz')).toBeDefined();
    expect(kernel.slots.list('nav').map((e) => e.id)).toEqual(['w17-nav']);

    offBlock();
    offNav();
    offTool();
    expect(kernel.registries.chatBlocks.get('w17-quiz')).toBeUndefined();
    expect(kernel.slots.list('nav')).toEqual([]);
    expect(kernel.slots.list('chat.toolResults')).toEqual([]);
    // Revoked registrations are gone from the fiber: unloading does not revoke them a second time.
    await expect(kernel.unload('community.blocks')).resolves.toBe(true);
  });
});
