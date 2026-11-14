import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null), convertFileSrc: (path: string) => path }));

// Evaluated before any kernel exists, like the chat app module the entry already reaches.
import { CHAT_APP_TYPE_ID } from '@/features/workbench/apps/chat/register';
import { appRegistry } from '@/features/workbench/core/appRegistry';
import { workbenchAppContributions } from '@/features/workbench/core/appContributions';
import { createAppUiKernel } from '@/ui-kernel/bootstrap';
import { defineUiPlugin, type UiKernel } from '@/ui-kernel/kernel';
import { createLazyContributionPoint } from '@/ui-kernel/lazy';

const typeIds = (list: readonly { typeId: string }[]) => list.map((def) => def.typeId);

describe('createLazyContributionPoint', () => {
  it('uses the fallback until an owner attaches, then moves earlier values into the owner in order', () => {
    const direct: string[] = [];
    const point = createLazyContributionPoint<string>('test', (value) => {
      direct.push(value);
      return () => direct.splice(direct.indexOf(value), 1);
    });
    point.announce('a');
    point.announce('b');
    expect(direct).toEqual(['a', 'b']);
    const owned: string[] = [];
    const detach = point.attach((value) => owned.push(value));
    expect(direct).toEqual([]);
    point.announce('c');
    expect(owned).toEqual(['a', 'b', 'c']);
    detach();
    point.announce('d');
    expect(owned).toEqual(['a', 'b', 'c']);
    expect(direct).toEqual([]);
    expect(point.values()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('isolates a rejected contribution instead of failing the announcing chunk', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const point = createLazyContributionPoint<string>('test');
    const owned: string[] = [];
    point.attach((value) => {
      if (value === 'bad') throw new Error('conflict');
      owned.push(value);
    });
    point.announce('bad');
    point.announce('good');
    expect(owned).toEqual(['good']);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});

describe('dstu.ui.workbench', () => {
  let kernel: UiKernel | undefined;
  afterAll(async () => { await kernel?.dispose(); });

  it('adopts apps registered before the kernel, contributes the lazily loaded rest, and removes them all on unload', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(typeIds(appRegistry.list())).toEqual([CHAT_APP_TYPE_ID, 'chat-session']);

    kernel = await createAppUiKernel();
    expect(typeIds(kernel.registries.workbenchApps.list())).toEqual([CHAT_APP_TYPE_ID, 'chat-session']);

    const { DEFAULT_DOCK_PINNED } = await import('@/features/workbench/apps/registerAll');
    expect(DEFAULT_DOCK_PINNED).toEqual(['chat', 'files', 'settings', 'todo']);
    expect(typeIds(appRegistry.list())).toEqual(typeIds(workbenchAppContributions.values()));
    expect(appRegistry.list()).toHaveLength(22);

    await kernel.install(defineUiPlugin({ meta: { id: 'community.timer' }, apply(ctx) {
      ctx.ui.workbench.registerApp({ ...appRegistry.get('pomodoro')!, typeId: 'community-timer' });
    } }));
    expect(appRegistry.get('community-timer')).toBeDefined();
    await expect(kernel.install(defineUiPlugin({ meta: { id: 'community.chat' }, apply(ctx) {
      ctx.ui.workbench.registerApp({ ...appRegistry.get('chat')! });
    } }))).rejects.toThrow('workbench app "chat" is already registered');

    await kernel.unload('dstu.ui.workbench');
    expect(typeIds(appRegistry.list())).toEqual(['community-timer']);
    await kernel.unload('community.timer');
    expect(appRegistry.list()).toEqual([]);
  }, 60_000);
});
