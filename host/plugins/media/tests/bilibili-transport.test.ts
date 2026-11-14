import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';
import { BridgeHub } from '../src/bilibili-bridge-hub.ts';
import { BiliRequestError } from '../src/bilibili-policy.ts';
import {
  BiliTransportState, DEFAULT_TRANSPORT_SETTINGS, TRANSPORT_SETTINGS_KEY,
  decodeRouteMode, decodeTransportSettings, transportStatus, validateProxyUrl,
  type RequestDiagnostic,
} from '../src/bilibili-transport.ts';

function settings(initial: Record<string, string> = {}, failSave = false) {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    values,
    store: {
      get: (key: string) => values.get(key) ?? null,
      save: (key: string, value: string) => {
        if (failSave) throw new Error('db failure');
        values.set(key, value);
      },
    },
  };
}

function diagnostic(requestId: number): RequestDiagnostic {
  return {
    requestId,
    attemptId: `attempt-${requestId}`,
    route: 'native',
    stage: 'api',
    host: 'api.bilibili.com',
    elapsedMs: 12,
    status: 200,
    errorCode: null,
    bytes: 34,
  };
}

it('transport settings default and parse with Rust serde fallbacks', () => {
  const empty = new BiliTransportState(settings().store);
  expect(empty.settings()).toEqual(DEFAULT_TRANSPORT_SETTINGS);

  const stored = new BiliTransportState(settings({
    [TRANSPORT_SETTINGS_KEY]: JSON.stringify({
      mode: 'browser_bridge', proxyUrl: 'http://127.0.0.1:7890', proxyInAuto: true,
    }),
  }).store);
  expect(stored.settings()).toEqual({
    mode: 'browser_bridge', proxyUrl: 'http://127.0.0.1:7890', proxyInAuto: true,
  });

  const tagged = new BiliTransportState(settings({
    [TRANSPORT_SETTINGS_KEY]: JSON.stringify({ mode: { proxy: null }, proxyInAuto: false }),
  }).store);
  expect(tagged.settings().mode).toBe('proxy');

  for (const raw of [
    '{', 'null', '[]',
    JSON.stringify({ mode: 'nope', proxyInAuto: false }),
    JSON.stringify({ mode: 'auto' }),
    JSON.stringify({ mode: 'auto', proxyInAuto: 'yes' }),
    JSON.stringify({ mode: 'auto', proxyInAuto: false, proxyUrl: 7 }),
  ]) {
    expect(new BiliTransportState(settings({ [TRANSPORT_SETTINGS_KEY]: raw }).store).settings(),
      raw).toEqual(DEFAULT_TRANSPORT_SETTINGS);
  }

  const failing = new BiliTransportState({
    get() { throw new Error('db'); }, save() {},
  });
  expect(failing.settings()).toEqual(DEFAULT_TRANSPORT_SETTINGS);
});

it('decodes string and externally tagged route modes', () => {
  expect(decodeRouteMode('auto')).toBe('auto');
  expect(decodeRouteMode('browser_bridge')).toBe('browser_bridge');
  expect(decodeRouteMode({ proxy: null })).toBe('proxy');
  expect(decodeRouteMode({ auto: undefined })).toBeNull();
  expect(decodeRouteMode({ auto: null, native: null })).toBeNull();
  expect(decodeRouteMode('AUTO')).toBeNull();
  expect(decodeRouteMode(null)).toBeNull();

  expect(decodeTransportSettings({ mode: 'native', proxyUrl: null, proxyInAuto: true }))
    .toEqual({ mode: 'native', proxyUrl: null, proxyInAuto: true });
  expect(decodeTransportSettings({ mode: { auto: null }, proxyInAuto: false }))
    .toEqual({ mode: 'auto', proxyUrl: null, proxyInAuto: false });
  expect(() => decodeTransportSettings({ mode: 'bad', proxyInAuto: false }))
    .toThrowError('代理配置无效');
  expect(() => decodeTransportSettings({ mode: 'auto', proxyInAuto: false, proxyUrl: 7 }))
    .toThrowError('代理配置无效');
});

it('validates proxies like NativeTransport::new', () => {
  expect(() => validateProxyUrl('http://127.0.0.1:7890')).not.toThrow();
  expect(() => validateProxyUrl('https://proxy.example.com')).not.toThrow();
  for (const [url, message] of [
    ['not a url', '代理地址无效'],
    ['ftp://proxy.example.com', '代理需使用无内嵌凭据的 HTTP / HTTPS 地址'],
    ['http://user:pass@proxy.example.com', '代理需使用无内嵌凭据的 HTTP / HTTPS 地址'],
    ['http://proxy.example.com/path', '代理需使用无内嵌凭据的 HTTP / HTTPS 地址'],
    ['http://proxy.example.com/?q=1', '代理需使用无内嵌凭据的 HTTP / HTTPS 地址'],
    ['http://proxy.example.com/#fragment', '代理需使用无内嵌凭据的 HTTP / HTTPS 地址'],
  ] as const) {
    expect(() => validateProxyUrl(url), url).toThrowError(message);
  }
});

it('configure validates, persists and bumps the generation', () => {
  const { values, store } = settings();
  const state = new BiliTransportState(store);
  expect(state.generation()).toBe(1);

  state.configure({ mode: 'native', proxyUrl: 'http://127.0.0.1:7890', proxyInAuto: true });
  expect(state.generation()).toBe(2);
  expect(JSON.parse(values.get(TRANSPORT_SETTINGS_KEY)!)).toEqual({
    mode: 'native', proxyUrl: 'http://127.0.0.1:7890', proxyInAuto: true,
  });
  expect(state.settings()).toEqual({
    mode: 'native', proxyUrl: 'http://127.0.0.1:7890', proxyInAuto: true,
  });

  state.configure({ mode: 'auto', proxyUrl: '', proxyInAuto: false });
  expect(JSON.parse(values.get(TRANSPORT_SETTINGS_KEY)!)).toEqual({
    mode: 'auto', proxyUrl: '', proxyInAuto: false,
  });

  for (const [value, message] of [
    [{ mode: 'auto', proxyUrl: 'ftp://proxy', proxyInAuto: false } as const, '代理需使用无内嵌凭据的 HTTP / HTTPS 地址'],
    [{ mode: 'proxy', proxyUrl: null, proxyInAuto: false } as const, '请先配置可信代理地址'],
    [{ mode: 'proxy', proxyUrl: '', proxyInAuto: false } as const, '请先配置可信代理地址'],
  ] as const) {
    let error: unknown;
    try { state.configure(value); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(BiliRequestError);
    expect((error as BiliRequestError).payload.code).toBe('bilibili-proxy-config');
    expect((error as BiliRequestError).message).toBe(message);
  }
  expect(state.generation()).toBe(3);

  const failing = new BiliTransportState(settings({}, true).store);
  try { failing.configure({ mode: 'auto', proxyUrl: null, proxyInAuto: false }); }
  catch (error) {
    expect(error).toBeInstanceOf(BiliRequestError);
    expect((error as BiliRequestError).payload.code).toBe('bilibili-settings');
    expect((error as BiliRequestError).message).toBe('保存 B 站出口设置失败');
  }
  expect(failing.settings()).toEqual(DEFAULT_TRANSPORT_SETTINGS);
  expect(failing.generation()).toBe(1);
});

it('diagnostics keep the newest 32 entries and status snapshots the hub', () => {
  const state = new BiliTransportState(settings().store);
  const hub = new BridgeHub();
  expect(transportStatus(state, hub)).toEqual({
    settings: DEFAULT_TRANSPORT_SETTINGS,
    bridge: {
      state: 'unavailable',
      connectionId: null,
      scriptVersion: null,
      parsing: false,
      media: false,
      account: null,
      generation: 0,
      lastError: null,
    },
    diagnostics: [],
  });

  for (let id = 1; id <= 33; id += 1) state.recordDiagnostic(diagnostic(id));
  expect(state.diagnostics()).toHaveLength(32);
  expect(state.diagnostics()[0]!.requestId).toBe(2);
  expect(state.diagnostics()[31]!.requestId).toBe(33);
  state.diagnostics()[0]!.bytes = 0;
  expect(state.diagnostics()[0]!.bytes).toBe(34);
});

it('registers transport status/configure with Rust string errors', async () => {
  const { values, store } = settings();
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(), settings: store, paths: { appDataDir: process.cwd() } },
  });
  try {
    expect(await host.invoke('media_bilibili_transport_status')).toEqual({
      settings: DEFAULT_TRANSPORT_SETTINGS,
      bridge: {
        state: 'unavailable',
        connectionId: null,
        scriptVersion: null,
        parsing: false,
        media: false,
        account: null,
        generation: 0,
        lastError: null,
      },
      diagnostics: [],
    });

    expect(await host.invoke('media_bilibili_transport_configure', {
      config: { mode: 'native', proxyInAuto: true },
    })).toBeNull();
    expect(JSON.parse(values.get(TRANSPORT_SETTINGS_KEY)!)).toEqual({
      mode: 'native', proxyUrl: null, proxyInAuto: true,
    });
    expect((await host.invoke('media_bilibili_transport_status') as {
      settings: typeof DEFAULT_TRANSPORT_SETTINGS;
    }).settings).toEqual({ mode: 'native', proxyUrl: null, proxyInAuto: true });

    let rejected: unknown;
    try {
      await host.invoke('media_bilibili_transport_configure', {
        config: { mode: 'proxy', proxyInAuto: false },
      });
    } catch (error) { rejected = error; }
    expect(typeof rejected).toBe('string');
    expect(JSON.parse(rejected as string)).toMatchObject({
      code: 'bilibili-proxy-config',
      message: '请先配置可信代理地址',
      stage: 'transport',
      requestId: 0,
      attemptId: '',
      route: 'native',
      retryable: false,
      httpStatus: null,
      businessCode: null,
    });

    let invalidProxy: unknown;
    try {
      await host.invoke('media_bilibili_transport_configure', {
        config: { mode: 'auto', proxyUrl: 'ftp://proxy', proxyInAuto: false },
      });
    } catch (error) { invalidProxy = error; }
    expect(JSON.parse(invalidProxy as string)).toMatchObject({
      code: 'bilibili-proxy-config',
      message: '代理需使用无内嵌凭据的 HTTP / HTTPS 地址',
    });
  } finally { await host.dispose(); }
});
