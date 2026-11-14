/**
 * 会话 / webContents 安全策略：决策矩阵（纯函数）与处理器装配（假的 Session / WebContents / App）。
 * 真实 Electron 下的端到端验证见 web-security-host.test.ts。
 */
import { EventEmitter } from 'node:events';
import type { App, Session, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { OpenerUrlEntry } from '../shell/capabilities.ts';
import {
  browserNavigationAllowed,
  decideNavigation,
  decidePermission,
  describeUrl,
  guardWebContents,
  installSessionPermissionGuards,
  installWebSecurity,
  originOf,
  windowOpenGoesExternal,
  type ContentsRole,
  type WebSecurityPolicy,
} from '../shell/web-security.ts';

/** `src-tauri/capabilities/default.json` 的 `opener:default` + `opener:allow-default-urls`。 */
const OPENER: OpenerUrlEntry[] = [
  { url: 'mailto:*', app: null },
  { url: 'tel:*', app: null },
  { url: 'http://*', app: null },
  { url: 'https://*', app: null },
];
const APP = 'tauri://localhost';
const nav = (role: ContentsRole | null, url: string, kind: 'navigate' | 'redirect' = 'navigate', currentUrl = 'tauri://localhost/index.html') =>
  decideNavigation(role, url, kind, { appOrigin: APP, openerUrlAllow: OPENER, currentUrl });

describe('origin helpers', () => {
  it('originOf handles custom standard schemes and rejects host-less URLs', () => {
    expect(originOf('tauri://localhost/index.html?window=main')).toBe('tauri://localhost');
    expect(originOf('http://tauri.localhost/x')).toBe('http://tauri.localhost');
    expect(originOf('http://LOCALHOST:1422/a')).toBe('http://localhost:1422');
    for (const url of ['mailto:a@b.c', 'about:blank', 'file:///etc/passwd', 'blob:tauri://localhost/uuid', 'data:text/html,x', 'javascript:alert(1)', 'not a url']) {
      expect(originOf(url)).toBeNull();
    }
  });

  it('describeUrl never logs path or query', () => {
    expect(describeUrl('https://auth.example.com/cb?code=SECRET')).toBe('https://auth.example.com');
    expect(describeUrl('mailto:someone@example.com')).toBe('mailto:…');
    expect(describeUrl('')).toBe('(invalid url)');
  });
});

describe('top-level navigation policy', () => {
  it('app windows stay on the app origin; user-followed links go to the system browser via opener scope', () => {
    expect(nav('app', 'tauri://localhost/index.html?window=pomodoro-mini')).toEqual({ allow: true });
    expect(nav('app', 'https://example.com/docs')).toEqual({ allow: false, openExternal: true });
    expect(nav('app', 'mailto:someone@example.com')).toEqual({ allow: false, openExternal: true });
    expect(nav('app', 'file:///etc/passwd')).toEqual({ allow: false, openExternal: false });
    expect(nav('app', 'javascript:alert(1)')).toEqual({ allow: false, openExternal: false });
    expect(nav('app', 'tauri://evil/index.html')).toEqual({ allow: false, openExternal: false });
    expect(nav('app', 'asset://localhost/%2Fetc%2Fpasswd')).toEqual({ allow: false, openExternal: false });
  });

  it('app windows never follow or externally open a server redirect', () => {
    expect(nav('app', 'tauri://localhost/other', 'redirect')).toEqual({ allow: true });
    expect(nav('app', 'https://example.com/', 'redirect')).toEqual({ allow: false, openExternal: false });
  });

  it('browser-content allows http(s) with a host only (dstu-browser policy without the agent guard)', () => {
    for (const url of ['https://example.com/a', 'http://example.com/', 'http://127.0.0.1:8080/x']) {
      expect(browserNavigationAllowed(url)).toBe(true);
      expect(nav('browser', url)).toEqual({ allow: true });
      expect(nav('browser', url, 'redirect')).toEqual({ allow: true });
    }
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'blob:https://example.com/uuid', 'tauri://localhost', 'asset://localhost/foo', 'ipc://localhost', 'about:blank', 'chrome://gpu', 'https://']) {
      expect(browserNavigationAllowed(url)).toBe(false);
      expect(nav('browser', url)).toEqual({ allow: false, openExternal: false });
      expect(nav('browser', url, 'redirect')).toEqual({ allow: false, openExternal: false });
    }
  });

  it('unmanaged webContents may only stay on their current origin', () => {
    expect(nav(null, 'devtools://devtools/bundled/x.html', 'navigate', 'devtools://devtools/bundled/inspector.html')).toEqual({ allow: true });
    expect(nav(null, 'https://example.com/', 'navigate', 'devtools://devtools/bundled/inspector.html')).toEqual({ allow: false, openExternal: false });
    expect(nav(null, 'https://example.com/', 'navigate', '')).toEqual({ allow: false, openExternal: false });
  });

  it('new windows go external only from app windows and only inside the opener scope', () => {
    expect(windowOpenGoesExternal('app', 'https://example.com/', OPENER)).toBe(true);
    expect(windowOpenGoesExternal('app', 'mailto:a@b.c', OPENER)).toBe(true);
    expect(windowOpenGoesExternal('app', 'blob:tauri://localhost/uuid', OPENER)).toBe(false);
    expect(windowOpenGoesExternal('app', 'file:///etc/passwd', OPENER)).toBe(false);
    expect(windowOpenGoesExternal('app', 'javascript:alert(1)', OPENER)).toBe(false);
    expect(windowOpenGoesExternal('app', 'https://example.com/', [])).toBe(false);
    expect(windowOpenGoesExternal('browser', 'https://example.com/', OPENER)).toBe(false);
    expect(windowOpenGoesExternal(null, 'https://example.com/', OPENER)).toBe(false);
  });
});

describe('permission policy (default deny)', () => {
  const allow = (role: ContentsRole | null, permission: string, requester: string | undefined = 'tauri://localhost/index.html', mediaTypes: string[] = []) =>
    decidePermission({ role, permission, requester, mediaTypes }, APP);

  it('app-origin frames get exactly the permissions the frontend uses', () => {
    for (const permission of ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'notifications', 'screen-wake-lock']) {
      expect(allow('app', permission)).toBe(true);
    }
    expect(allow('app', 'media', 'tauri://localhost/index.html', ['audio'])).toBe(true);
    expect(allow('app', 'media', 'tauri://localhost', ['audio'])).toBe(true);
    expect(allow('app', 'media', 'tauri://localhost/index.html', ['video'])).toBe(false);
    expect(allow('app', 'media', 'tauri://localhost/index.html', ['audio', 'video'])).toBe(false);
    expect(allow('app', 'media', 'tauri://localhost/index.html', [])).toBe(false);
    expect(allow('app', 'media', 'tauri://localhost/index.html', ['unknown'])).toBe(false);
    for (const permission of ['geolocation', 'openExternal', 'display-capture', 'midi', 'midiSysex', 'hid', 'usb', 'serial', 'pointerLock', 'keyboardLock', 'idle-detection', 'fileSystem', 'window-management', 'unknown']) {
      expect(allow('app', permission)).toBe(false);
    }
  });

  it('third-party frames inside app windows only get fullscreen; a missing requester is untrusted', () => {
    expect(allow('app', 'fullscreen', 'https://player.bilibili.com/player.html')).toBe(true);
    for (const permission of ['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'screen-wake-lock']) {
      expect(allow('app', permission, 'https://player.bilibili.com/player.html')).toBe(false);
    }
    expect(allow('app', 'media', 'https://player.bilibili.com/player.html', ['audio'])).toBe(false);
    expect(decidePermission({ role: 'app', permission: 'clipboard-read', requester: undefined, mediaTypes: [] }, APP)).toBe(false);
    expect(allow('app', 'clipboard-read', 'tauri://evil/')).toBe(false);
  });

  it('browser-content pages get fullscreen and clipboard write only, even when they load an app-looking origin', () => {
    expect(allow('browser', 'fullscreen', 'https://www.youtube.com/watch')).toBe(true);
    expect(allow('browser', 'clipboard-sanitized-write', 'https://docs.example.com/')).toBe(true);
    for (const permission of ['clipboard-read', 'notifications', 'geolocation', 'media', 'screen-wake-lock', 'openExternal']) {
      expect(allow('browser', permission, 'https://example.com/', ['audio'])).toBe(false);
      expect(allow('browser', permission, 'tauri://localhost/index.html', ['audio'])).toBe(false);
    }
  });

  it('unmanaged webContents get nothing', () => {
    expect(allow(null, 'fullscreen')).toBe(false);
    expect(allow(null, 'clipboard-read')).toBe(false);
  });
});

class FakeContents extends EventEmitter {
  windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null;
  constructor(readonly url: string) {
    super();
  }
  isDestroyed() { return false; }
  getURL() { return this.url; }
  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) { this.windowOpenHandler = handler; }
}

function fakePolicy(role: ContentsRole | null) {
  const opened: string[] = [];
  const logs: string[] = [];
  const policy: WebSecurityPolicy = {
    appOrigin: APP,
    roleOf: () => role,
    openerUrlAllow: OPENER,
    openExternal: async (url) => { opened.push(url); },
    log: (message) => logs.push(message),
  };
  return { policy, opened, logs };
}

function navigationEvent(url: string, extra: Partial<{ isMainFrame: boolean; isSameDocument: boolean }> = {}) {
  return { url, isMainFrame: true, isSameDocument: false, ...extra, preventDefault: vi.fn() };
}

describe('handler wiring', () => {
  it('app window: popups are denied and opened externally, navigation off-origin is prevented, <webview> is refused', async () => {
    const contents = new FakeContents('tauri://localhost/index.html');
    const { policy, opened } = fakePolicy('app');
    guardWebContents(contents as unknown as WebContents, policy);

    expect(contents.windowOpenHandler?.({ url: 'https://example.com/popup' })).toEqual({ action: 'deny' });
    expect(contents.windowOpenHandler?.({ url: 'blob:tauri://localhost/x' })).toEqual({ action: 'deny' });

    const external = navigationEvent('https://example.org/');
    contents.emit('will-navigate', external);
    expect(external.preventDefault).toHaveBeenCalledOnce();
    const local = navigationEvent('tauri://localhost/index.html#/settings');
    contents.emit('will-navigate', local);
    expect(local.preventDefault).not.toHaveBeenCalled();
    const subframe = navigationEvent('https://player.bilibili.com/x', { isMainFrame: false });
    contents.emit('will-navigate', subframe);
    expect(subframe.preventDefault).not.toHaveBeenCalled();
    const redirect = navigationEvent('https://example.net/');
    contents.emit('will-redirect', redirect);
    expect(redirect.preventDefault).toHaveBeenCalledOnce();

    const webview = { preventDefault: vi.fn() };
    contents.emit('will-attach-webview', webview, {}, {});
    expect(webview.preventDefault).toHaveBeenCalledOnce();

    await Promise.resolve();
    expect(opened).toEqual(['https://example.com/popup', 'https://example.org/']);
  });

  it('browser-content: popups are dropped without opening anything; non-http navigation is prevented', async () => {
    const contents = new FakeContents('https://example.com/');
    const { policy, opened } = fakePolicy('browser');
    guardWebContents(contents as unknown as WebContents, policy);
    expect(contents.windowOpenHandler?.({ url: 'https://accounts.example.com/oauth' })).toEqual({ action: 'deny' });
    const fileNav = navigationEvent('file:///etc/passwd');
    contents.emit('will-navigate', fileNav);
    expect(fileNav.preventDefault).toHaveBeenCalledOnce();
    const ok = navigationEvent('https://example.com/next');
    contents.emit('will-navigate', ok);
    expect(ok.preventDefault).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(opened).toEqual([]);
  });

  it('an openExternal failure is logged, not thrown', async () => {
    const contents = new FakeContents('tauri://localhost/');
    const { policy, logs } = fakePolicy('app');
    policy.openExternal = async () => { throw new Error('no handler'); };
    guardWebContents(contents as unknown as WebContents, policy);
    contents.windowOpenHandler?.({ url: 'https://example.com/' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logs.some((line) => line.includes('openExternal failed') && line.includes('no handler'))).toBe(true);
  });

  it('session handlers decide by the requesting webContents role', () => {
    const handlers: { request?: Function; check?: Function } = {};
    const ses = {
      setPermissionRequestHandler: (handler: Function) => { handlers.request = handler; },
      setPermissionCheckHandler: (handler: Function) => { handlers.check = handler; },
    };
    const appContents = new FakeContents('tauri://localhost/');
    const browserContents = new FakeContents('https://example.com/');
    const policy: WebSecurityPolicy = {
      ...fakePolicy(null).policy,
      roleOf: (contents) => (contents === (appContents as unknown) ? 'app' : contents === (browserContents as unknown) ? 'browser' : null),
    };
    installSessionPermissionGuards(ses as unknown as Session, policy);
    const request = (contents: unknown, permission: string, details: Record<string, unknown>) => {
      let granted: boolean | undefined;
      handlers.request?.(contents, permission, (value: boolean) => { granted = value; }, { isMainFrame: true, ...details });
      return granted;
    };
    expect(request(appContents, 'media', { requestingUrl: 'tauri://localhost/index.html', mediaTypes: ['audio'] })).toBe(true);
    expect(request(appContents, 'media', { requestingUrl: 'tauri://localhost/index.html', mediaTypes: ['video'] })).toBe(false);
    expect(request(appContents, 'geolocation', { requestingUrl: 'tauri://localhost/index.html' })).toBe(false);
    expect(request(browserContents, 'media', { requestingUrl: 'https://example.com/', mediaTypes: ['audio'] })).toBe(false);
    expect(request(browserContents, 'fullscreen', { requestingUrl: 'https://example.com/' })).toBe(true);

    expect(handlers.check?.(appContents, 'media', 'tauri://localhost', { isMainFrame: true, mediaType: 'audio' })).toBe(true);
    expect(handlers.check?.(appContents, 'notifications', 'tauri://localhost', { isMainFrame: true })).toBe(true);
    expect(handlers.check?.(appContents, 'geolocation', 'tauri://localhost', { isMainFrame: true })).toBe(false);
    expect(handlers.check?.(null, 'notifications', 'tauri://localhost', { isMainFrame: true })).toBe(false);
  });

  it('installWebSecurity covers the default session, later sessions and every webContents', () => {
    const app = new EventEmitter();
    const sessions: unknown[] = [];
    const fakeSession = () => ({
      setPermissionRequestHandler: () => { sessions.push(fakeSessionRef); },
      setPermissionCheckHandler: () => undefined,
    });
    const defaultSession = fakeSession();
    let fakeSessionRef: unknown = defaultSession;
    installWebSecurity(app as unknown as App, defaultSession as unknown as Session, fakePolicy('app').policy);
    expect(sessions).toEqual([defaultSession]);
    const later = fakeSession();
    fakeSessionRef = later;
    app.emit('session-created', later);
    expect(sessions).toEqual([defaultSession, later]);
    const contents = new FakeContents('tauri://localhost/');
    app.emit('web-contents-created', {}, contents);
    expect(contents.windowOpenHandler).not.toBeNull();
    expect(contents.listenerCount('will-navigate')).toBe(1);
    expect(contents.listenerCount('will-redirect')).toBe(1);
    expect(contents.listenerCount('will-attach-webview')).toBe(1);
  });
});
