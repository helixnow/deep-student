// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { URL as NodeURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../electron/preload/bridge.ts', () => ({ installTauriBridge: vi.fn() }));

import {
  bootstrapWebClient,
  ensureAuthenticated,
  parseWebPwaShortcut,
  PENDING_PWA_SHORTCUT_KEY,
  restorePendingPwaShortcut,
  stripUrlAuthToken,
} from '../client/bootstrap.ts';
import {
  hideConnectionBanner,
  hideOfflineBootOverlay,
  showOfflineBootOverlay,
  showOfflineWaiting,
  showReconnecting,
} from '../client/connectionBanner.ts';

const swSource = readFileSync(resolve(process.cwd(), 'web/public/sw.js'), 'utf8');

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static instances: FakeSocket[] = [];
  readyState = 0;
  constructor(_url: string) {
    super();
    FakeSocket.instances.push(this);
  }
  send() {}
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
  error() {
    this.dispatchEvent(new Event('error'));
  }
}

afterEach(() => {
  hideConnectionBanner();
  hideOfflineBootOverlay();
  document.body.innerHTML = '';
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PWA shortcut preservation across WebUI auth and reconnect', () => {
  it('validates chat/library/review shortcuts and rejects unknown values', () => {
    expect(parseWebPwaShortcut('?shortcut=chat')).toBe('chat');
    expect(parseWebPwaShortcut('https://study.test/?token=abc&shortcut=LIBRARY#top')).toBe('library');
    expect(parseWebPwaShortcut(new URLSearchParams('shortcut=review'))).toBe('review');
    expect(parseWebPwaShortcut('?shortcut=unknown')).toBeNull();
    expect(parseWebPwaShortcut('')).toBeNull();
  });

  it('strips sensitive token params while keeping valid shortcut and hash intact', () => {
    window.history.replaceState({ from: 'pwa' }, '', '/?token=sec-1&shortcut=review&shell=mobile#deck');
    stripUrlAuthToken();
    expect(window.location.search).toBe('?shortcut=review&shell=mobile');
    expect(window.location.hash).toBe('#deck');
    expect(window.history.state).toEqual({ from: 'pwa' });
  });

  it('restores a pending shortcut once after a 303 redirect to / and clears sessionStorage', () => {
    window.sessionStorage.setItem(PENDING_PWA_SHORTCUT_KEY, 'chat');
    window.history.replaceState(null, '', '/');

    expect(restorePendingPwaShortcut()).toBe('chat');
    expect(window.location.search).toBe('?shortcut=chat');
    expect(window.sessionStorage.getItem(PENDING_PWA_SHORTCUT_KEY)).toBeNull();

    // Once consumed by the app, a subsequent normal refresh of / does not re-inject it.
    window.history.replaceState(null, '', '/');
    expect(restorePendingPwaShortcut()).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('preserves ?shortcut=library through 401 token form login even if URL was mutated mid-gate', async () => {
    window.history.replaceState(null, '', '/?shortcut=library');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 401 })
      .mockResolvedValueOnce({ status: 200, ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const pending = ensureAuthenticated();
    await vi.waitFor(() => expect(document.getElementById('ds-web-token-form')).not.toBeNull());
    expect(window.sessionStorage.getItem(PENDING_PWA_SHORTCUT_KEY)).toBe('library');

    // Simulate a redirect or URL cleanup losing ?shortcut before form submission completes.
    window.history.replaceState(null, '', '/');

    const input = document.getElementById('ds-web-token-input') as HTMLInputElement;
    input.value = 'valid-token';
    document.getElementById('ds-web-token-form')!.dispatchEvent(new Event('submit', { cancelable: true }));

    await pending;
    expect(window.location.search).toBe('?shortcut=library');
    expect(window.sessionStorage.getItem(PENDING_PWA_SHORTCUT_KEY)).toBeNull();
  });

  it('retains boot shortcut across initial offline recovery and reconnect without re-adding after session open', async () => {
    const windowEvents = vi.spyOn(window, 'addEventListener');
    const documentEvents = vi.spyOn(document, 'addEventListener');
    window.history.replaceState(null, '', '/?token=tok&shortcut=review');
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    FakeSocket.instances = [];

    try {
      const client = bootstrapWebClient();
      expect(window.location.search).toBe('?shortcut=review');
      await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));

      // Initial socket fails while offline, then recovers on online event.
      FakeSocket.instances[0]!.error();
      FakeSocket.instances[0]!.close();
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new Event('online'));
      expect(FakeSocket.instances).toHaveLength(2);
      FakeSocket.instances[1]!.open();
      await client.connected;
      expect(window.location.search).toBe('?shortcut=review');

      // WorkbenchEventBridge consumes and strips ?shortcut; later reconnects must not resurrect it.
      window.history.replaceState(null, '', '/');
      FakeSocket.instances[1]!.close();
      vi.advanceTimersByTime(600);
      FakeSocket.instances[2]!.open();
      expect(window.location.search).toBe('');
    } finally {
      for (const [name, listener, options] of windowEvents.mock.calls) {
        window.removeEventListener(name, listener, options);
      }
      for (const [name, listener, options] of documentEvents.mock.calls) {
        document.removeEventListener(name, listener, options);
      }
      windowEvents.mockRestore();
      documentEvents.mockRestore();
    }
  });
});

describe('WebUI offline / disconnect resilience & troubleshooting guidance', () => {
  it('renders student-facing troubleshooting tips, immediate retry button, and online auto-probe on boot overlay', () => {
    const onRetry = vi.fn();
    showOfflineBootOverlay(onRetry);

    const overlay = document.getElementById('ds-webui-offline-overlay')!;
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('Deep Student 桌面服务');
    expect(overlay.textContent).toContain('Wi-Fi');

    const retryBtn = overlay.querySelector<HTMLButtonElement>('[data-testid="ds-webui-offline-retry"]')!;
    expect(retryBtn.textContent).toBe('立即重试');
    retryBtn.click();
    expect(onRetry).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('online'));
    expect(onRetry).toHaveBeenCalledTimes(2);

    hideOfflineBootOverlay();
    window.dispatchEvent(new Event('online'));
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('shows immediate retry action and LAN/host guidance in top connection banners', () => {
    const onRetry = vi.fn();
    showReconnecting(2, 1800, onRetry);
    const pill = document.getElementById('ds-webui-connection-pill')!;
    expect(pill.textContent).toContain('Wi-Fi');
    expect(pill.querySelector('button')?.textContent).toBe('立即重试');
    pill.querySelector('button')?.click();
    expect(onRetry).toHaveBeenCalledTimes(1);

    showOfflineWaiting(onRetry);
    expect(pill.textContent).toContain('网络已断开');
    expect(pill.textContent).toContain('Wi-Fi');
    expect(pill.querySelector('button')?.textContent).toBe('立即重试');
  });

  it('serves enhanced SW offline fallback and preserves shortcut on 401 HTML login gate', async () => {
    const origin = 'https://study.example.com';
    const listeners = new Map<string, (event: any) => void>();
    const fetchMock = vi.fn();
    runInNewContext(swSource, {
      URL: NodeURL,
      Response,
      AbortController,
      setTimeout,
      clearTimeout,
      fetch: fetchMock,
      caches: {
        open: async () => ({
          match: async () => undefined,
          put: async () => undefined,
        }),
      },
      self: {
        location: { origin },
        registration: { active: true },
        addEventListener: (name: string, fn: (event: any) => void) => listeners.set(name, fn),
      },
    });

    const navigate = async (path: string) => {
      let responsePromise!: Promise<Response>;
      listeners.get('fetch')!({
        request: {
          url: `${origin}${path}`,
          method: 'GET',
          mode: 'navigate',
          headers: new Headers(),
        },
        waitUntil: () => undefined,
        respondWith: (p: Promise<Response>) => {
          responsePromise = p;
        },
      });
      return responsePromise;
    };

    // 1) Cold offline navigation returns 503 fallback with immediate retry, online listener & host/Wi-Fi tips
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const offlineRes = await navigate('/?shortcut=chat');
    expect(offlineRes.status).toBe(503);
    const offlineHtml = await offlineRes.text();
    expect(offlineHtml).toContain('当前无法连接 Deep Student 宿主服务');
    expect(offlineHtml).toContain('立即重试');
    expect(offlineHtml).toContain('Wi-Fi');
    expect(offlineHtml).toContain("addEventListener('online'");
    expect(offlineHtml).toContain(PENDING_PWA_SHORTCUT_KEY);

    // 2) 401 HTML login gate for ?shortcut=review injects shortcut preservation without caching
    fetchMock.mockResolvedValueOnce(
      new Response('<!doctype html><html><body><form id="ds-web-token-form"></form></body></html>', {
        status: 401,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      }),
    );
    const loginRes = await navigate('/?shortcut=review');
    expect(loginRes.status).toBe(401);
    const loginHtml = await loginRes.text();
    expect(loginHtml).toContain(PENDING_PWA_SHORTCUT_KEY);
    expect(loginHtml).toContain('"review"');
  });
});
