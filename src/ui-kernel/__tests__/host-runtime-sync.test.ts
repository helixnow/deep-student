// @vitest-environment node
/**
 * FE-A3 真实链路：真实 `createTestHost` 回答 `plugin:ui|manifest { version: 2 }` 与 `plugin:host|status`，
 * 渲染端 `startCommunityUiPlugins` 把它们写进真实 `UiKernel` 的 `hostStatus`。
 *
 * 只替换传输（测试宿主没有渲染端的 listen 桥），Host 内核、命令契约与降级记录都是真的。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../host/kernel/testing';
import type { HostPlugin } from '../../../host/kernel/core';
import { UiKernel } from '../kernel';
import { startCommunityUiPlugins, type CommunityUiBridge, type UiHostManifest } from '../community';

vi.mock('../../ui-sdk', () => ({ defineUiPlugin: () => {} }));
vi.mock('../shared', () => ({ installSharedModules: () => {} }));

const greeter: HostPlugin = {
  name: 'test.greeter',
  meta: { id: 'test.greeter', version: '1.2.3' },
  apply() {},
};

/** Bridge over the real Host commands; events are delivered by the test through the captured handlers. */
function hostBridge(host: TestHost) {
  const handlers: {
    manifest?: (manifest: UiHostManifest) => void;
    status?: (degraded: { id: string; reason: string }[]) => void;
  } = {};
  const bridge: Required<CommunityUiBridge> = {
    invoke: () => host.invoke('plugin:ui|manifest'),
    listen: async () => () => {},
    manifest: () => host.invoke('plugin:ui|manifest', { version: 2 }),
    listenManifest: async (handler) => {
      handlers.manifest = handler;
      return () => {};
    },
    status: () => host.invoke('plugin:host|status'),
    listenStatus: async (handler) => {
      handlers.status = handler;
      return () => {};
    },
  };
  return { bridge, handlers };
}

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('real Host → UiKernel host status', () => {
  it('records the real v2 inventory (builtin origin, versions) and treats unknown ids as missing', async () => {
    vi.stubGlobal('window', {});
    const host = await createTestHost({ plugins: [greeter] });
    const kernel = new UiKernel();
    const { bridge } = hostBridge(host);
    const load = vi.fn();
    const stop = await startCommunityUiPlugins(kernel, bridge, load);
    await vi.waitFor(() => expect(kernel.hostStatus.known).toBe(true));

    const manifest = await host.invoke<UiHostManifest>('plugin:ui|manifest', { version: 2 });
    expect(manifest.version).toBe(2);
    expect(manifest.plugins).toContainEqual({ id: 'test.greeter', origin: 'builtin', platforms: ['desktop'], version: '1.2.3' });
    expect(kernel.hostStatus.state('test.greeter')).toBe('online');
    expect(kernel.hostStatus.state('dstu.anki')).toBe('missing');
    expect(kernel.hostStatus.safeMode).toBe(false);
    expect(load).not.toHaveBeenCalled();

    await stop();
    await kernel.dispose();
    await host.dispose();
  });

  it('exposes a real degraded record, including the CONSENT_REQUIRED code W32/W01 will emit', async () => {
    vi.stubGlobal('window', {});
    const host = await createTestHost({ plugins: [greeter] });
    const kernel = new UiKernel();
    const { bridge, handlers } = hostBridge(host);
    const stop = await startCommunityUiPlugins(kernel, bridge, vi.fn());
    await vi.waitFor(() => expect(kernel.hostStatus.known).toBe(true));

    expect(await host.invoke('plugin:host|status')).toEqual([]);
    host.runtime.recordDegraded([{ id: 'acme.notes', reason: 'CONSENT_REQUIRED: consent record missing' }]);
    expect(host.runtime.degradedPlugins()).toEqual([{ id: 'acme.notes', reason: 'CONSENT_REQUIRED: consent record missing' }]);
    // The degraded event carries the real Host list.
    handlers.status!(host.runtime.degradedPlugins());
    await flush();

    expect(kernel.hostStatus.state('acme.notes')).toBe('degraded');
    expect(kernel.hostStatus.reason('acme.notes')).toBe('CONSENT_REQUIRED: consent record missing');
    expect(kernel.hostStatus.consentRequired('acme.notes')).toBe(true);
    expect(kernel.hostStatus.degraded('acme.notes')).toEqual({ code: 'CONSENT_REQUIRED', detail: 'consent record missing', consentRequired: true });
    expect(kernel.hostStatus.availability(['test.greeter'])).toBe('available');

    await stop();
    await kernel.dispose();
    await host.dispose();
  });
});
