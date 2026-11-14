import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';
import {
  SESSION_SECRET_KEY, accountStatus, deleteSession, loadSession, loginQrPoll, logout, saveSession,
  startLoginQr, type AccountAuthClient, type AccountSecretStore,
} from '../src/bilibili-account.ts';
import type { NavResult, StoredSession } from '../src/bilibili-auth.ts';
import { nativeAuthClient } from './helpers/bili-native-auth.ts';
import { startServer } from './helpers/http-fixture.ts';

function memoryStore(raw?: string) {
  const values = new Map<string, string>();
  if (raw !== undefined) values.set(SESSION_SECRET_KEY, raw);
  let saves = 0;
  let deletes = 0;
  const store: AccountSecretStore = {
    getSecret: async key => values.get(key) ?? null,
    saveSecret: async (key, value) => { saves += 1; values.set(key, value); },
    deleteSecret: async key => { deletes += 1; values.delete(key); },
  };
  return { values, store, saves: () => saves, deletes: () => deletes };
}

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    cookie: 'SESSDATA=s; DedeUserID=42',
    mid: 42,
    uname: 'UP',
    face: 'https://i0.hdslb.com/f.jpg',
    vip: false,
    savedAt: 111,
    ...overrides,
  };
}

function client(nav: NavResult | (() => Promise<NavResult>), onExit?: (cookie: string) => void): AccountAuthClient {
  return {
    nav: typeof nav === 'function' ? nav : async () => nav,
    exit: async cookie => { onExit?.(cookie); },
  };
}

it('loadSession ignores secure-store and JSON failures and requires SESSDATA', async () => {
  expect(await loadSession(memoryStore().store)).toBeNull();
  expect(await loadSession({
    getSecret: async () => { throw new Error('keychain'); },
    saveSecret: async () => undefined,
    deleteSecret: async () => undefined,
  })).toBeNull();

  const invalid = [
    '{',
    'null',
    '[]',
    JSON.stringify({ savedAt: 1 }),
    JSON.stringify({ cookie: 7, savedAt: 1 }),
    JSON.stringify({ cookie: 'SESSDATA=s', savedAt: 1.5 }),
    JSON.stringify({ cookie: 'SESSDATA=s' }),
    JSON.stringify({ cookie: 'SESSDATA=s', savedAt: 1, mid: -1 }),
    JSON.stringify({ cookie: 'SESSDATA=s', savedAt: 1, mid: '1' }),
    JSON.stringify({ cookie: 'SESSDATA=s', savedAt: 1, vip: 'yes' }),
    JSON.stringify({ cookie: 'bili_jct=x', savedAt: 1 }),
  ];
  for (const raw of invalid) expect(await loadSession(memoryStore(raw).store), raw).toBeNull();

  const parsed = await loadSession(memoryStore(JSON.stringify({
    cookie: 'SESSDATA=s', savedAt: 1,
  })).store);
  expect(parsed).toEqual({
    cookie: 'SESSDATA=s', mid: null, uname: null, face: null, vip: false, savedAt: 1,
  });
  expect(await loadSession(memoryStore(JSON.stringify(session())).store)).toEqual(session());
});

it('accountStatus reports logged out when no session exists', async () => {
  let navCalls = 0;
  const status = await accountStatus(memoryStore().store, client(async () => {
    navCalls += 1;
    return { kind: 'expired' };
  }));
  expect(status).toEqual({
    loggedIn: false, mid: null, uname: null, face: null, vip: false, verified: true, expired: false,
  });
  expect(navCalls).toBe(0);
});

it('accountStatus refreshes the profile but preserves savedAt', async () => {
  const store = memoryStore(JSON.stringify(session({ mid: 1, uname: 'old', face: null, vip: false })));
  const status = await accountStatus(store.store, client({
    kind: 'logged_in',
    data: {
      isLogin: true,
      mid: 7,
      uname: ' UP ',
      face: 'http://i0.hdslb.com/f.jpg',
      vipStatus: 1,
    },
  }));
  expect(status).toEqual({
    loggedIn: true, mid: 7, uname: ' UP ', face: 'https://i0.hdslb.com/f.jpg',
    vip: true, verified: true, expired: false,
  });
  expect(JSON.parse(store.values.get(SESSION_SECRET_KEY)!)).toEqual({
    cookie: 'SESSDATA=s; DedeUserID=42',
    mid: 7,
    uname: ' UP ',
    face: 'https://i0.hdslb.com/f.jpg',
    vip: true,
    savedAt: 111,
  });
  expect(store.saves()).toBe(1);
});

it('accountStatus skips the save when the profile did not change', async () => {
  const store = memoryStore(JSON.stringify(session()));
  const status = await accountStatus(store.store, client({
    kind: 'logged_in',
    data: {
      isLogin: true, mid: 42, uname: 'UP', face: 'https://i0.hdslb.com/f.jpg', vipStatus: 0,
    },
  }));
  expect(status.loggedIn).toBe(true);
  expect(store.saves()).toBe(0);
});

it('accountStatus deletes expired sessions and keeps offline sessions', async () => {
  const expired = memoryStore(JSON.stringify(session()));
  expect(await accountStatus(expired.store, client({ kind: 'expired' }))).toEqual({
    loggedIn: false, mid: null, uname: null, face: null, vip: false, verified: true, expired: true,
  });
  expect(expired.values.has(SESSION_SECRET_KEY)).toBe(false);
  expect(expired.deletes()).toBe(1);

  const offline = memoryStore(JSON.stringify(session()));
  const infos: string[] = [];
  const status = await accountStatus(offline.store, client(async () => {
    throw new Error('network down');
  }), undefined, message => infos.push(message));
  expect(status).toEqual({
    loggedIn: true, mid: 42, uname: 'UP', face: 'https://i0.hdslb.com/f.jpg',
    vip: false, verified: false, expired: false,
  });
  expect(infos).toEqual(['[media::bilibili_auth] status not verified: network down']);
  expect(offline.values.has(SESSION_SECRET_KEY)).toBe(true);
  expect(offline.deletes()).toBe(0);

  // 刷新后的保存失败不影响本次响应（Rust `let _ = save_session(...)`）。
  const failing: AccountSecretStore = {
    getSecret: async () => JSON.stringify(session({ mid: 1, uname: 'old' })),
    saveSecret: async () => { throw new Error('secure store'); },
    deleteSecret: async () => undefined,
  };
  const refreshed = await accountStatus(failing, client({
    kind: 'logged_in',
    data: { isLogin: true, mid: 2, uname: 'new', face: null, vipStatus: 0 },
  }));
  expect(refreshed).toMatchObject({ mid: 2, uname: 'new', verified: true });
});

it('logout exits the server session best-effort and always deletes locally', async () => {
  const withSession = memoryStore(JSON.stringify(session()));
  const exited: string[] = [];
  await logout(withSession.store, client({ kind: 'expired' }, cookie => exited.push(cookie)));
  expect(exited).toEqual(['SESSDATA=s; DedeUserID=42']);
  expect(withSession.values.has(SESSION_SECRET_KEY)).toBe(false);

  const withoutSession = memoryStore();
  await logout(withoutSession.store, client({ kind: 'expired' }, cookie => exited.push(cookie)));
  expect(exited).toHaveLength(1);
  expect(withoutSession.deletes()).toBe(1);

  const failingExit = memoryStore(JSON.stringify(session()));
  await logout(failingExit.store, {
    nav: async () => ({ kind: 'expired' }),
    exit: async () => { throw new Error('network'); },
  });
  expect(failingExit.values.has(SESSION_SECRET_KEY)).toBe(false);

  const warns: string[] = [];
  const failingDelete: AccountSecretStore = {
    getSecret: async () => null,
    saveSecret: async () => undefined,
    deleteSecret: async () => { throw new Error('keychain'); },
  };
  await logout(failingDelete, client({ kind: 'expired' }), message => warns.push(message));
  expect(warns).toEqual(['[media::bilibili_auth] delete session failed: keychain']);
});

it('saveSession maps secure-store failures to the Rust logout message', async () => {
  await expect(saveSession({
    getSecret: async () => null,
    saveSecret: async () => { throw new Error('locked'); },
    deleteSecret: async () => undefined,
  }, session())).rejects.toThrowError('保存 B 站登录状态失败');

  const store = memoryStore();
  await deleteSession({
    getSecret: async () => null,
    saveSecret: async () => undefined,
    deleteSecret: async () => { throw new Error('locked'); },
  });
  await saveSession(store.store, session());
  expect(JSON.parse(store.values.get(SESSION_SECRET_KEY)!)).toEqual(session());
});

it('AuthClient.exit posts the CSRF form only when bili_jct exists', async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"code":0}');
  });
  try {
    const auth = nativeAuthClient(server.url);
    await auth.exit('SESSDATA=s; bili_jct=a+b');
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: 'POST',
      url: '/login/exit/v2',
      body: 'biliCSRF=a%2Bb',
    });
    expect(server.requests[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(server.requests[0]!.headers.cookie).toBe('SESSDATA=s; bili_jct=a+b');

    await auth.exit('SESSDATA=s');
    expect(server.requests).toHaveLength(1);

    const down = nativeAuthClient('http://127.0.0.1:1');
    await expect(down.exit('SESSDATA=s; bili_jct=x')).resolves.toBeUndefined();
  } finally { await server.close(); }
});

it('registers auth status/logout with the platform secure store', async () => {
  const { values, store } = memoryStore();
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(),
      settings: { get: () => null, save: () => undefined },
      secrets: { openStore: () => store },
      paths: { appDataDir: process.cwd() },
    },
  });
  try {
    expect(await host.invoke('media_bilibili_auth_status')).toEqual({
      loggedIn: false, mid: null, uname: null, face: null, vip: false, verified: true, expired: false,
    });
    values.set(SESSION_SECRET_KEY, JSON.stringify(session({ cookie: 'SESSDATA=s' })));
    expect(await host.invoke('media_bilibili_logout')).toBeNull();
    expect(values.has(SESSION_SECRET_KEY)).toBe(false);
  } finally { await host.dispose(); }

  const missing = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(), settings: { get: () => null, save: () => undefined }, paths: { appDataDir: process.cwd() } },
  });
  try {
    await expect(missing.invoke('media_bilibili_auth_status')).rejects.toBe('B 站账号存储不可用');
    await expect(missing.invoke('media_bilibili_logout')).rejects.toBe('B 站账号存储不可用');
  } finally { await missing.dispose(); }
});

it('loginQrPoll validates the key and only saves a session on success', async () => {
  const { values, store, saves } = memoryStore();
  const qrClient = (state: string, cookie: string | null, nav?: NavResult) => ({
    qrPoll: async (key: string) => {
      expect(key).toBe('0123456789abcdef0123456789abcdef');
      return { state, cookie };
    },
    nav: async () => nav ?? { kind: 'expired' as const },
  });

  await expect(loginQrPoll(store, qrClient('waiting', null), '../../etc', 5))
    .rejects.toThrow('登录二维码无效，请刷新后重新扫码');
  expect(saves()).toBe(0);

  expect(await loginQrPoll(store, qrClient('waiting', null), '0123456789abcdef0123456789abcdef', 5))
    .toEqual({ state: 'waiting', status: null });
  expect(await loginQrPoll(store, qrClient('scanned', null), '0123456789abcdef0123456789abcdef', 5))
    .toEqual({ state: 'scanned', status: null });
  expect(saves()).toBe(0);
  expect(values.has(SESSION_SECRET_KEY)).toBe(false);

  const success = await loginQrPoll(
    store,
    qrClient('success', 'SESSDATA=s%2C1; DedeUserID=7', {
      kind: 'logged_in',
      data: { isLogin: true, mid: 7, uname: 'UP', face: 'https://i0.hdslb.com/f.jpg', vipStatus: 1 },
    }),
    '0123456789abcdef0123456789abcdef',
    999,
  );
  expect(success.state).toBe('success');
  expect(success.status).toMatchObject({
    loggedIn: true, mid: 7, uname: 'UP', face: 'https://i0.hdslb.com/f.jpg', vip: true,
    verified: true, expired: false,
  });
  expect(await loadSession(store)).toEqual({
    cookie: 'SESSDATA=s%2C1; DedeUserID=7', mid: 7, uname: 'UP',
    face: 'https://i0.hdslb.com/f.jpg', vip: true, savedAt: 999,
  });
});

it('loginQrPoll keeps the cookie session when nav fails and propagates save errors', async () => {
  const { store } = memoryStore();
  const navDown = {
    qrPoll: async () => ({ state: 'success', cookie: 'SESSDATA=s; DedeUserID=42' }),
    nav: async (): Promise<NavResult> => { throw new Error('offline'); },
  };
  const result = await loginQrPoll(store, navDown, '0123456789abcdef0123456789abcdef', 7);
  expect(result.status).toMatchObject({ loggedIn: true, mid: 42, verified: true });
  expect((await loadSession(store))!.mid).toBe(42);

  const failing: AccountSecretStore = {
    getSecret: async () => null,
    saveSecret: async () => { throw new Error('keychain'); },
    deleteSecret: async () => undefined,
  };
  await expect(loginQrPoll(
    failing,
    {
      qrPoll: async () => ({ state: 'success', cookie: 'SESSDATA=s' }),
      nav: async () => ({ kind: 'expired' }),
    },
    '0123456789abcdef0123456789abcdef',
    8,
  )).rejects.toThrow('保存 B 站登录状态失败');
});

it('registers media_bilibili_login_qr_poll and rejects malformed keys before network', async () => {
  const { store } = memoryStore();
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(),
      settings: { get: () => null, save: () => undefined },
      secrets: { openStore: () => store },
      paths: { appDataDir: process.cwd() },
    },
  });
  try {
    await expect(host.invoke('media_bilibili_login_qr_poll', { qrcodeKey: 'short' }))
      .rejects.toBe('登录二维码无效，请刷新后重新扫码');
  } finally { await host.dispose(); }
});

it('startLoginQr renders a PNG data URL with a 180 second TTL', async () => {
  const key = '0123456789abcdef0123456789abcdef';
  const result = await startLoginQr({
    qrGenerate: async () => ({
      qrcodeKey: key,
      url: 'https://www.bilibili.com/h5/login?qrcode_key=' + key,
    }),
  });
  expect(result.qrcodeKey).toBe(key);
  expect(result.expiresInSecs).toBe(180);
  expect(result.qrPng.startsWith('data:image/png;base64,')).toBe(true);
  const png = Buffer.from(result.qrPng.slice('data:image/png;base64,'.length), 'base64');
  expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
});

it('startLoginQr propagates network and render failures as strings', async () => {
  await expect(startLoginQr({
    qrGenerate: async () => { throw new Error('B 站请求失败: offline'); },
  })).rejects.toThrow('B 站请求失败: offline');
});
