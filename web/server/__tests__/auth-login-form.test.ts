import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isSameOriginRequest, SESSION_COOKIE_NAME } from '../auth.ts';
import { startWebServer, type RunningWebServer } from '../main.ts';

describe('WebUI interactive form-POST login gate (A1-A4)', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dstu-webui-a4-'));
  const distDir = join(tempRoot, 'dist');
  const appDataDir = join(tempRoot, 'appdata');
  const token = 'a4-login-secret-token-2026';

  let running: RunningWebServer;
  let baseOrigin = '';

  beforeAll(async () => {
    mkdirSync(distDir, { recursive: true });
    mkdirSync(appDataDir, { recursive: true });
    writeFileSync(
      join(distDir, 'index.html'),
      '<!doctype html><html><head><title>Deep Student App</title></head><body><div id="root">AUTHENTICATED_APP_READY</div></body></html>',
    );

    running = await startWebServer({
      host: '127.0.0.1',
      port: 0,
      prod: true,
      distDir,
      appDataDir,
      token,
      safeMode: true,
      log: () => undefined,
    });
    baseOrigin = `http://127.0.0.1:${running.port}`;
  }, 60_000);

  afterAll(async () => {
    if (running) {
      await running.close();
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }, 30_000);

  it('A1: serves uncached 401 login gate HTML with #ds-web-token-form and rejects unauthenticated API calls', async () => {
    const htmlRes = await fetch(`${baseOrigin}/`, {
      headers: { Accept: 'text/html' },
    });
    expect(htmlRes.status).toBe(401);
    expect(htmlRes.headers.get('cache-control')).toBe('no-store');
    expect(htmlRes.headers.get('referrer-policy')).toBe('same-origin');
    expect(htmlRes.headers.get('vary')).toContain('Cookie');
    const html = await htmlRes.text();
    expect(html).toContain('id="ds-web-token-form"');
    expect(html).toContain('id="ds-token-input"');
    expect(html).toContain('id="ds-web-token-submit"');
    expect(html).toContain('<meta name="referrer" content="same-origin" />');

    const apiRes = await fetch(`${baseOrigin}/api/health`);
    expect(apiRes.status).toBe(401);
    expect(apiRes.headers.get('cache-control')).toBe('no-store');
  });

  it('A2: rejects wrong token form-POST with 401 no-store and sets no session cookie', async () => {
    const res = await fetch(`${baseOrigin}/api/auth/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Origin: baseOrigin,
      },
      body: new URLSearchParams({ token: 'wrong-token' }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
    const html = await res.text();
    expect(html).toContain('id="ds-web-token-form"');
    expect(html).toContain('访问令牌无效');
  });

  it('A4: full form-POST /api/auth/session sets HttpOnly session cookie (no Secure on HTTP 127.0.0.1), redirects 303 -> / with no-store, and loads authenticated / cleanly', async () => {
    const loginRes = await fetch(`${baseOrigin}/api/auth/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Origin: baseOrigin,
        Referer: `${baseOrigin}/`,
        'Sec-Fetch-Site': 'same-origin',
      },
      body: new URLSearchParams({ token }).toString(),
      redirect: 'manual',
    });

    expect(loginRes.status).toBe(303);
    expect(loginRes.headers.get('location')).toBe('/');
    expect(loginRes.headers.get('cache-control')).toBe('no-store');

    const setCookie = loginRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).not.toContain('Secure');

    const cookiePair = setCookie.split(';')[0]!;
    const redirectedHome = await fetch(`${baseOrigin}${loginRes.headers.get('location')}`, {
      headers: {
        Accept: 'text/html',
        Cookie: cookiePair,
      },
    });
    expect(redirectedHome.status).toBe(200);
    expect(redirectedHome.headers.get('cache-control')).toBe('private, no-cache');
    const appHtml = await redirectedHome.text();
    expect(appHtml).toContain('AUTHENTICATED_APP_READY');
    expect(appHtml).not.toContain('id="ds-web-token-form"');

    const authedHealth = await fetch(`${baseOrigin}/api/health`, {
      headers: { Cookie: cookiePair },
    });
    expect(authedHealth.status).toBe(200);
    expect(await authedHealth.json()).toMatchObject({ ok: true, ready: true });
  });

  it('A4: allows Chromium same-origin form-POST with Origin: null when Sec-Fetch-Site is same-origin, while blocking forged/cross-site Origin: null', async () => {
    // Chromium same-origin login form POST emitting Origin: null + Sec-Fetch-Site: same-origin
    const chromiumSameOrigin = await fetch(`${baseOrigin}/api/auth/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'null',
        Referer: `${baseOrigin}/`,
        'Sec-Fetch-Site': 'same-origin',
      },
      body: new URLSearchParams({ token, shortcut: 'chat' }).toString(),
      redirect: 'manual',
    });
    expect(chromiumSameOrigin.status).toBe(303);
    expect(chromiumSameOrigin.headers.get('location')).toBe('/?shortcut=chat');
    expect(chromiumSameOrigin.headers.get('cache-control')).toBe('no-store');
    expect(chromiumSameOrigin.headers.get('set-cookie') ?? '').toContain(`${SESSION_COOKIE_NAME}=`);

    // Cross-site / sandboxed iframe with Origin: null + Sec-Fetch-Site: cross-site MUST be 403
    const crossSiteNull = await fetch(`${baseOrigin}/api/auth/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'null',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: new URLSearchParams({ token }).toString(),
      redirect: 'manual',
    });
    expect(crossSiteNull.status).toBe(403);
    expect(crossSiteNull.headers.get('cache-control')).toBe('no-store');

    // Bare Origin: null without Fetch Metadata or same-origin Referer MUST be 403
    const bareNull = await fetch(`${baseOrigin}/api/auth/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'null',
      },
      body: new URLSearchParams({ token }).toString(),
      redirect: 'manual',
    });
    expect(bareNull.status).toBe(403);

    // Cross-origin Referer conflicting with Sec-Fetch-Site: same-origin MUST be 403
    const fakeRequest = (headers: Record<string, string>) =>
      ({ headers, socket: { remoteAddress: '127.0.0.1' } }) as unknown as Parameters<typeof isSameOriginRequest>[0];
    expect(
      isSameOriginRequest(
        fakeRequest({
          origin: 'null',
          host: `127.0.0.1:${running.port}`,
          'sec-fetch-site': 'same-origin',
          referer: 'http://evil.example/phish',
        }),
      ),
    ).toBe(false);
    expect(
      isSameOriginRequest(
        fakeRequest({
          origin: 'null',
          host: `127.0.0.1:${running.port}`,
          'sec-fetch-site': 'same-origin',
        }),
      ),
    ).toBe(true);
  });

  it('handles case-insensitive Application/JSON session exchange with no-store', async () => {
    const jsonRes = await fetch(`${baseOrigin}/api/auth/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'Application/JSON; charset=utf-8',
        Origin: baseOrigin,
      },
      body: JSON.stringify({ token }),
    });
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers.get('cache-control')).toBe('no-store');
    expect(jsonRes.headers.get('set-cookie') ?? '').toContain(`${SESSION_COOKIE_NAME}=`);
    expect(await jsonRes.json()).toEqual({ ok: true });
  });
});
