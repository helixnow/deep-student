import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';

function settings() {
  return { get: () => null, save: () => undefined };
}

it('media_bilibili_bridge_pair starts the loopback server and returns the pairing page', async () => {
  const host = await createTestHost({ plugins: [media], provide: { storage: unusedStorage(), settings: settings(), paths: { appDataDir: process.cwd() } } });
  try {
    const view = await host.invoke('media_bilibili_bridge_pair') as {
      url: string; scriptUrl: string;
    };
    expect(view.url).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/deepstudent-bili-bridge\/v1\/#[a-f0-9]{64}$/);
    expect(view.scriptUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/deepstudent-bili-bridge\/v1\/deepstudent-bili-bridge\.user\.js$/);
    const status = await host.invoke('media_bilibili_transport_status') as {
      bridge: { state: string };
    };
    expect(status.bridge.state).toBe('pairing');
  } finally { await host.dispose(); }
});

it('media_bilibili_bridge_approve rejects unknown connection ids as BiliError JSON', async () => {
  const host = await createTestHost({ plugins: [media], provide: { storage: unusedStorage(), settings: settings(), paths: { appDataDir: process.cwd() } } });
  try {
    let rejected: unknown;
    try { await host.invoke('media_bilibili_bridge_approve', { connectionId: 'missing' }); }
    catch (error) { rejected = error; }
    expect(typeof rejected).toBe('string');
    expect(JSON.parse(rejected as string)).toEqual({
      code: 'bilibili-bridge-auth',
      message: '配对请求已失效',
      stage: 'transport',
      requestId: 0,
      attemptId: '',
      route: 'native',
      retryable: false,
      httpStatus: null,
      businessCode: null,
    });
    const status = await host.invoke('media_bilibili_transport_status') as {
      bridge: { state: string; generation: number };
    };
    expect(status.bridge).toMatchObject({ state: 'unavailable', generation: 0 });
  } finally { await host.dispose(); }
});

it('media_bilibili_bridge_disconnect revokes the hub and bumps the generation', async () => {
  const host = await createTestHost({ plugins: [media], provide: { storage: unusedStorage(), settings: settings(), paths: { appDataDir: process.cwd() } } });
  try {
    expect(await host.invoke('media_bilibili_bridge_disconnect')).toBeNull();
    const status = await host.invoke('media_bilibili_transport_status') as {
      bridge: {
        state: string; connectionId: string | null; account: unknown;
        parsing: boolean; media: boolean; generation: number;
      };
    };
    expect(status.bridge).toEqual({
      state: 'offline',
      connectionId: null,
      scriptVersion: null,
      parsing: false,
      media: false,
      account: null,
      generation: 1,
      lastError: null,
    });
    // 再次断开是幂等的，但 Rust revoke 仍会递增 generation。
    expect(await host.invoke('media_bilibili_bridge_disconnect')).toBeNull();
    const again = await host.invoke('media_bilibili_transport_status') as {
      bridge: { generation: number };
    };
    expect(again.bridge.generation).toBe(2);
  } finally { await host.dispose(); }
});
