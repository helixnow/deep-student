import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Block } from '@/features/chat/core/types/block';
import type { ChatStore } from '@/features/chat/core/types';
import { UiKernel, defineUiPlugin } from '@/ui-kernel/kernel';
import { provideAppUiKernel } from '@/ui-kernel/app-kernel';
import { commandRegistry } from '@/command-palette/registry/commandRegistry';
import { appRegistry } from '@/features/workbench/core/appRegistry';
import { OFFICIAL_CHAT_UI_PLUGIN_ID, installOfficialChatUiPlugin } from '@/features/chat/plugins';
import {
  MODULE_OWNER, Registry, blockRegistry, eventRegistry, modeRegistry, type BlockComponentProps, type EventHandler,
} from '@/features/chat/registry';
import { BlockRenderer, BlockRendererWithStore } from '@/features/chat/components/BlockRenderer';

const kernels: UiKernel[] = [];
function chatKernel(): UiKernel {
  const kernel = new UiKernel({ legacyRegistries: { commandRegistry, blockRegistry, appRegistry, eventRegistry, modeRegistry } });
  kernels.push(kernel);
  return kernel;
}

afterEach(async () => {
  cleanup();
  for (const kernel of kernels.splice(0)) await kernel.dispose();
  provideAppUiKernel(undefined);
});

describe('slot-backed Registry', () => {
  it('layers registrations per key, revokes one layer at a time and notifies subscribers', () => {
    const registry = new Registry<{ v: number }>('W17Test', { warnOnOverwrite: false });
    const listener = vi.fn();
    const off = registry.subscribe(listener);
    const base = { v: 1 };
    const over = { v: 2 };
    registry.register('k', base);
    const revoke = registry.register('k', over, 'community.plugin', 'community');
    expect(registry.get('k')).toBe(over);
    expect(registry.entries()).toEqual([{ key: 'k', value: over, owner: 'community.plugin', origin: 'community' }]);
    expect(listener).toHaveBeenCalledTimes(2);

    revoke();
    revoke();
    expect(registry.get('k')).toBe(base);
    expect(registry.entries()[0]!.owner).toBe(MODULE_OWNER);
    expect(listener).toHaveBeenCalledTimes(3);

    registry.register('k', over);
    expect(registry.unregister('k')).toBe(true);
    expect(registry.has('k')).toBe(false);
    expect(registry.unregister('k')).toBe(false);
    // two layers removed → two notifications
    expect(listener).toHaveBeenCalledTimes(6);
    off();
    registry.register('x', base);
    expect(listener).toHaveBeenCalledTimes(6);
  });

  it('keeps Map semantics for getAll / keys (overwrite keeps position) and stable entries()', () => {
    const registry = new Registry<number>('W17Order', { warnOnOverwrite: false });
    registry.register('a', 1);
    registry.register('b', 2);
    registry.register('a', 3);
    expect([...registry.getAll()]).toEqual([['a', 3], ['b', 2]]);
    expect(registry.keys()).toEqual(['a', 'b']);
    expect(registry.entries()).toBe(registry.entries());
    registry.clear();
    expect(registry.keys()).toEqual([]);
  });
});

describe('official chat UI plugin', () => {
  it('adopts every built-in block, event and mode and contributes the tool result table', async () => {
    const kernel = chatKernel();
    const moduleBlocks = blockRegistry.entries().filter((e) => e.owner === MODULE_OWNER).map((e) => e.key);
    const moduleEvents = eventRegistry.entries().filter((e) => e.owner === MODULE_OWNER).map((e) => e.key);
    const moduleModes = modeRegistry.entries().filter((e) => e.owner === MODULE_OWNER).map((e) => e.key);
    const before = blockRegistry.getAll();

    expect(await installOfficialChatUiPlugin(kernel)).toBe(true);
    const ownedBy = (registry: Registry<unknown>) => registry.entries().filter((e) => e.owner === OFFICIAL_CHAT_UI_PLUGIN_ID).map((e) => e.key);
    expect(ownedBy(blockRegistry as Registry<unknown>)).toEqual(moduleBlocks);
    expect(ownedBy(eventRegistry as Registry<unknown>)).toEqual(moduleEvents);
    expect(ownedBy(modeRegistry as Registry<unknown>)).toEqual(moduleModes);
    expect(moduleBlocks.length).toBe(27);
    expect(blockRegistry.getAll()).toEqual(before);
    expect(kernel.registries.chatBlocks.list()).toHaveLength(blockRegistry.keys().length);
    expect(kernel.slots.list('chat.toolResults').length).toBe(33);
    expect(kernel.slots.list('chat.toolResults').every((e) => e.owner === OFFICIAL_CHAT_UI_PLUGIN_ID && e.origin === 'builtin')).toBe(true);

    // A community plugin cannot take over a built-in block type through the kernel.
    await expect(kernel.install(defineUiPlugin({
      meta: { id: 'community.content' },
      apply(ctx) { ctx.ui.chat.registerBlock('content', { type: 'content', component: () => null }); },
    }))).rejects.toThrow(/chat block type "content" is already registered/);

    // Unloading drops the kernel layer; the module layer keeps chat rendering.
    await kernel.unload(OFFICIAL_CHAT_UI_PLUGIN_ID);
    expect(ownedBy(blockRegistry as Registry<unknown>)).toEqual([]);
    expect(blockRegistry.getAll()).toEqual(before);
    expect(kernel.slots.list('chat.toolResults')).toEqual([]);
  });

  it('adopts module registrations that arrive after it was installed', async () => {
    const kernel = chatKernel();
    await installOfficialChatUiPlugin(kernel);
    const late = { type: 'w17_late_module', component: () => null };
    const off = blockRegistry.register('w17_late_module', late);
    try {
      expect(blockRegistry.entries().find((e) => e.key === 'w17_late_module')?.owner).toBe(OFFICIAL_CHAT_UI_PLUGIN_ID);
      expect(kernel.registries.chatBlocks.get('w17_late_module')).toBe(late);
    } finally {
      off();
      blockRegistry.unregister('w17_late_module');
    }
  });

  it('installs into the app kernel once bootstrap publishes it', async () => {
    const kernel = chatKernel();
    provideAppUiKernel(kernel);
    await vi.waitFor(() => expect(kernel.list()).toContain(OFFICIAL_CHAT_UI_PLUGIN_ID));
  });
});

describe('community chat contributions through the kernel', () => {
  const CommunityCard: React.FC<BlockComponentProps> = ({ block }) => <div data-testid="community-card">{block.content}</div>;
  const block = { id: 'c1', type: 'w17_community_card', status: 'success', messageId: 'm', content: 'hello from a plugin' } as Block;
  const communityPlugin = defineUiPlugin({
    meta: { id: 'community.card' },
    apply(ctx) {
      ctx.ui.chat.registerBlock('w17_community_card', { type: 'w17_community_card', component: CommunityCard });
    },
  });

  it('a late-registered community block renders in already mounted messages and goes away on unload', async () => {
    const kernel = chatKernel();
    const store = createStore(() => ({ blocks: new Map([[block.id, block]]), activeBlockIds: new Set<string>() })) as unknown as StoreApi<ChatStore>;
    render(
      <>
        <BlockRenderer block={block} />
        <BlockRendererWithStore store={store} blockId={block.id} />
      </>,
    );
    expect(screen.queryAllByTestId('community-card')).toHaveLength(0);

    await act(async () => { await kernel.install(communityPlugin); });
    expect(screen.getAllByTestId('community-card').map((el) => el.textContent)).toEqual(['hello from a plugin', 'hello from a plugin']);
    expect(blockRegistry.entries().find((e) => e.key === 'w17_community_card')).toMatchObject({ owner: 'community.card', origin: 'community' });

    await act(async () => { await kernel.unload('community.card'); });
    expect(screen.queryAllByTestId('community-card')).toHaveLength(0);
    expect(blockRegistry.has('w17_community_card')).toBe(false);
  });

  it('event handlers and modes are contributed and revoked through the kernel', async () => {
    const kernel = chatKernel();
    const handler: EventHandler = { onStart: () => 'b' };
    await kernel.install(defineUiPlugin({
      meta: { id: 'community.events' },
      apply(ctx) {
        ctx.ui.chat.registerEvent('w17_event', handler);
        ctx.ui.chat.registerMode('w17_mode', { name: 'w17_mode', extends: 'chat', config: { requiresOcr: false, autoStartFirstMessage: false } });
      },
    }));
    expect(eventRegistry.get('w17_event')).toBe(handler);
    expect(modeRegistry.getResolved('w17_mode')?.name).toBe('w17_mode');
    expect(kernel.registries.chatEvents.get('w17_event')).toBe(handler);
    await kernel.unload('community.events');
    expect(eventRegistry.has('w17_event')).toBe(false);
    expect(modeRegistry.has('w17_mode')).toBe(false);
  });
});
