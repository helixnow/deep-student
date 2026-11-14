import { expect, it } from 'vitest';
import {
  cookieValue, isValidQrcodeKey, pollState, sanitizeFace,
  sessionCookieFromSetCookie, sessionCookieFromUrl, sessionWithProfile,
} from '../src/bilibili-auth.ts';
import { nativeAuthClient } from './helpers/bili-native-auth.ts';
import { startServer } from './helpers/http-fixture.ts';

it('keeps_only_session_cookies_from_set_cookie', () => {
  const headers = [
    'SESSDATA=abc%2C123; Path=/; Domain=bilibili.com; Expires=Sat, 04 Apr 2027 00:00:00 GMT; HttpOnly; Secure',
    'bili_jct=csrf123; Path=/; Domain=bilibili.com',
    'DedeUserID=42; Path=/',
    'DedeUserID__ckMd5=deadbeef; Path=/',
    'sid=tracking; Path=/',
  ];
  const cookie = sessionCookieFromSetCookie(headers)!;
  expect(cookie).toBe('SESSDATA=abc%2C123; bili_jct=csrf123; DedeUserID=42; DedeUserID__ckMd5=deadbeef');
  expect(cookieValue(cookie, 'bili_jct')).toBe('csrf123');
  expect(sessionCookieFromSetCookie(['bili_jct=x; Path=/', 'SESSDATA=; Path=/'])).toBeNull();
});

it('falls_back_to_session_fields_in_the_success_url', () => {
  const url = 'https://passport.biligame.com/x/passport-login/web/crossDomain?DedeUserID=42&DedeUserID__ckMd5=dd&Expires=1&SESSDATA=s%2C1&bili_jct=j&gourl=x';
  const cookie = sessionCookieFromUrl(url)!;
  expect(cookie.startsWith('SESSDATA=s,1; bili_jct=j; DedeUserID=42')).toBe(true);
  expect(sessionCookieFromUrl('https://example.com/?a=1')).toBeNull();
});

it('validates_qrcode_key_and_maps_poll_codes', () => {
  expect(isValidQrcodeKey('0123456789abcdef0123456789abcdef')).toBe(true);
  expect(isValidQrcodeKey('../../etc')).toBe(false);
  expect(isValidQrcodeKey('short')).toBe(false);
  expect(pollState(86101)).toBe('waiting');
  expect(pollState(86090)).toBe('scanned');
  expect(pollState(86038)).toBe('expired');
  expect(pollState(0)).toBe('success');
  expect(pollState(1)).toBeNull();
});

it('face_only_from_bilibili_image_host_over_https', () => {
  expect(sanitizeFace('http://i0.hdslb.com/bfs/face/a.jpg')).toBe('https://i0.hdslb.com/bfs/face/a.jpg');
  expect(sanitizeFace('https://evil.example.com/a.jpg')).toBeNull();
  expect(sanitizeFace('javascript:alert(1)')).toBeNull();
});

it('session_profile_falls_back_to_cookie_mid', () => {
  const session = sessionWithProfile('SESSDATA=s; DedeUserID=99', null, 1);
  expect(session.mid).toBe(99);
  expect(session.uname).toBeNull();
  expect(session.vip).toBe(false);
});

it('session_profile_prefers_nav_and_sanitizes_face', () => {
  const session = sessionWithProfile('SESSDATA=s; DedeUserID=99', {
    isLogin: true, mid: 7, uname: '  UP  ', face: 'http://i0.hdslb.com/f.jpg', vipStatus: 1,
  }, 2);
  expect(session.mid).toBe(7);
  expect(session.uname).toBe('  UP  ');
  expect(session.face).toBe('https://i0.hdslb.com/f.jpg');
  expect(session.vip).toBe(true);
  expect(session.savedAt).toBe(2);
});

it('poll_success_extracts_cookie_and_nav_marks_expired_on_101', async () => {
  const server = await startServer((request, response) => {
    if (request.url.startsWith('/x/passport-login/web/qrcode/poll')) {
      response.setHeader('content-type', 'application/json');
      response.setHeader('set-cookie', [
        'SESSDATA=sess; Path=/; HttpOnly',
        'bili_jct=jct; Path=/',
      ]);
      response.end(JSON.stringify({
        code: 0,
        message: '0',
        data: { url: '', refresh_token: 'r', timestamp: 1, code: 0, message: '' },
      }));
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      code: -101, message: '账号未登录', data: { isLogin: false },
    }));
  });
  try {
    const client = nativeAuthClient(server.url);
    const key = '0123456789abcdef0123456789abcdef';
    const polled = await client.qrPoll(key);
    expect(polled.state).toBe('success');
    expect(polled.cookie).toBe('SESSDATA=sess; bili_jct=jct');
    expect(server.requests[0]!.url).toBe(
      `/x/passport-login/web/qrcode/poll?qrcode_key=${key}`);
    expect((await client.nav('SESSDATA=sess')).kind).toBe('expired');
  } finally { await server.close(); }
});

it('poll_waiting_returns_no_cookie', async () => {
  const server = await startServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      code: 0,
      message: '0',
      data: { url: '', code: 86090, message: '二维码已扫码未确认' },
    }));
  });
  try {
    const client = nativeAuthClient(server.url);
    const polled = await client.qrPoll('0123456789abcdef0123456789abcdef');
    expect(polled.state).toBe('scanned');
    expect(polled.cookie).toBeNull();
  } finally { await server.close(); }
});

it('qr_generate_returns_key_and_rejects_invalid_keys', async () => {
  const key = '0123456789abcdef0123456789abcdef';
  const server = await startServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url.startsWith('/x/passport-login/web/qrcode/generate')) {
      response.end(JSON.stringify({
        code: 0,
        message: '0',
        data: { url: 'https://www.bilibili.com/h5/login?qrcode_key=' + key, qrcode_key: key },
      }));
      return;
    }
    response.end(JSON.stringify({ code: 0, message: '0', data: null }));
  });
  try {
    const client = nativeAuthClient(server.url);
    expect(await client.qrGenerate()).toEqual({
      qrcodeKey: key,
      url: 'https://www.bilibili.com/h5/login?qrcode_key=' + key,
    });
    expect(server.requests[0]!.url).toBe(
      '/x/passport-login/web/qrcode/generate?source=main-fe-header');
  } finally { await server.close(); }

  const invalid = await startServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      code: 0, message: '0', data: { url: 'https://x', qrcode_key: '../../etc' },
    }));
  });
  try {
    await expect(nativeAuthClient(invalid.url).qrGenerate())
      .rejects.toThrow('获取登录二维码失败（0：0）');
  } finally { await invalid.close(); }

  const badCode = await startServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ code: -400, message: '请求错误', data: null }));
  });
  try {
    await expect(nativeAuthClient(badCode.url).qrGenerate())
      .rejects.toThrow('获取登录二维码失败（-400：请求错误）');
  } finally { await badCode.close(); }

  const malformed = await startServer((_request, response) => { response.end('{bad'); });
  try {
    expect(await nativeAuthClient(malformed.url)
      .qrGenerate().catch(error => (error as Error).message)).toBe('B 站账号响应格式无效');
  } finally { await malformed.close(); }
});

it('auth requests go through BiliAttempt::native: browser headers, cookie only on nav, Rust error texts', async () => {
  const key = '0123456789abcdef0123456789abcdef';
  let status = 200;
  let body: Uint8Array | string = JSON.stringify({ code: 0, message: '0', data: { url: 'https://x', qrcode_key: key } });
  const server = await startServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body);
  });
  try {
    const client = nativeAuthClient(server.url);
    await client.qrGenerate();
    body = JSON.stringify({ code: -101, message: '账号未登录', data: null });
    await client.nav('SESSDATA=sess');
    const [generate, nav] = server.requests;
    expect(generate!.headers.referer).toBe('https://www.bilibili.com/');
    expect(generate!.headers['user-agent']).toMatch(/^Mozilla\/5\.0 /);
    expect(generate!.headers.cookie).toBeUndefined();
    expect(nav!.headers.cookie).toBe('SESSDATA=sess');

    // bilibili_auth.rs:328-330 `AuthClient::send`
    status = 503;
    await expect(client.qrGenerate()).rejects.toThrow(/^B 站账号接口返回 HTTP 503$/);
    status = 200;

    // serde_json::from_slice rejects a BOM and invalid UTF-8 (bilibili_auth.rs:349-350).
    body = `\uFEFF${JSON.stringify({ code: 0, message: '0', data: { url: 'https://x', qrcode_key: key } })}`;
    await expect(client.qrGenerate()).rejects.toThrow(/^B 站账号响应格式无效$/);
    body = new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]);
    await expect(client.qrGenerate()).rejects.toThrow(/^B 站账号响应格式无效$/);

    // BiliRequest::get(.., API_LIMIT): the native transport caps the body at 2 MiB.
    body = ' '.repeat(2 * 1024 * 1024 + 1);
    await expect(client.qrGenerate()).rejects.toThrow(/^B 站响应超过大小限制$/);
  } finally { await server.close(); }

  await expect(nativeAuthClient('http://127.0.0.1:1').qrGenerate())
    .rejects.toThrow(/^连接 B 站失败，请检查网络或切换出口$/);
});
