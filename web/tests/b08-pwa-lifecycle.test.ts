// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

const banners = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('../../electron/preload/bridge.ts', () => ({ installTauriBridge: vi.fn() }));
vi.mock('../client/connectionBanner.ts', () => ({
  showSwUpdateAvailable: banners.update,
  showPwaInstallOption: vi.fn(), hidePwaInstallOption: vi.fn(),
  showOfflineBootOverlay: vi.fn(), hideOfflineBootOverlay: vi.fn(),
  showReconnected: vi.fn(), showReconnecting: vi.fn(),
}));

import { ensureAuthenticated, installPwaSupport, stripUrlAuthToken } from '../client/bootstrap.ts';
import { hidePwaInstallOption, showPwaInstallOption } from '../client/connectionBanner.ts';

class Worker extends EventTarget {
  state = 'installing';
  postMessage = vi.fn();
  installed() {
    this.state = 'installed';
    this.dispatchEvent(new Event('statechange'));
  }
}

function pwaEnvironment(controlled = true) {
  const registration = Object.assign(new EventTarget(), {
    waiting: null as Worker | null,
    installing: null as Worker | null,
    update: vi.fn().mockResolvedValue(undefined),
  });
  const serviceWorker = Object.assign(new EventTarget(), {
    controller: controlled ? new Worker() : null,
    register: vi.fn().mockResolvedValue(registration),
  });
  const reload = vi.fn();
  const win = Object.assign(new EventTarget(), {
    location: { search: '?pwa=1', reload },
    localStorage: { getItem: () => null },
  });
  vi.stubGlobal('window', win);
  vi.stubGlobal('navigator', { serviceWorker });
  return { win, serviceWorker, registration, reload };
}

async function registerPwa(win: EventTarget) {
  installPwaSupport();
  win.dispatchEvent(new Event('load'));
  await Promise.resolve();
}

const visibilityListeners: EventListenerOrEventListenerObject[] = [];
const originalAddEventListener = document.addEventListener.bind(document);
vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
  if (type === 'visibilitychange') visibilityListeners.push(listener);
  originalAddEventListener(type, listener, options);
});

afterEach(() => {
  for (const listener of visibilityListeners.splice(0)) document.removeEventListener('visibilitychange', listener);
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('keeps update detection after the first uncontrolled install claims the page', async () => {
  const { win, serviceWorker, registration } = pwaEnvironment(false);
  await registerPwa(win);
  serviceWorker.controller = new Worker();
  serviceWorker.dispatchEvent(new Event('controllerchange'));
  const next = new Worker();
  registration.installing = next;
  registration.dispatchEvent(new Event('updatefound'));
  registration.waiting = next;
  next.installed();
  expect(banners.update).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
  expect(registration.update).toHaveBeenCalledTimes(1);
});

it('observes a worker already installing when register resolves', async () => {
  const { win, registration } = pwaEnvironment();
  const next = new Worker();
  registration.installing = next;
  await registerPwa(win);
  registration.waiting = next;
  next.installed();
  expect(banners.update).toHaveBeenCalledTimes(1);
});

it('refreshes only once when another tab has already activated the offered update', async () => {
  const { win, serviceWorker, registration, reload } = pwaEnvironment();
  const next = new Worker();
  next.state = 'installed';
  registration.waiting = next;
  await registerPwa(win);
  const refresh = banners.update.mock.calls[0]![0] as () => void;
  registration.waiting = null;
  next.state = 'activated';
  serviceWorker.controller = next;
  serviceWorker.dispatchEvent(new Event('controllerchange'));
  expect(reload).not.toHaveBeenCalled(); // No disruptive automatic refresh.
  refresh();
  refresh();
  expect(reload).toHaveBeenCalledTimes(1);
});

it('waits for the user-requested controller change and does not refresh on initial claim', async () => {
  const { win, serviceWorker, registration, reload } = pwaEnvironment();
  const next = new Worker();
  registration.waiting = next;
  await registerPwa(win);
  serviceWorker.dispatchEvent(new Event('controllerchange'));
  expect(reload).not.toHaveBeenCalled();
  (banners.update.mock.calls[0]![0] as () => void)();
  expect(next.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  expect(reload).not.toHaveBeenCalled();
  serviceWorker.dispatchEvent(new Event('controllerchange'));
  serviceWorker.dispatchEvent(new Event('controllerchange'));
  expect(reload).toHaveBeenCalledTimes(1);
});

it('removes all query tokens while preserving the standalone launch route, hash and history state', () => {
  const replaceState = vi.fn();
  const state = { route: 'library' };
  vi.stubGlobal('window', {
    location: { href: 'https://example.test/?token=secret&shortcut=library&token=duplicate#resource' },
    history: { state, replaceState },
  });
  stripUrlAuthToken();
  expect(replaceState).toHaveBeenCalledWith(state, '', '/?shortcut=library#resource');
});

it('suppresses the install pill in standalone and consumes the browser install event only once', async () => {
  const { win } = pwaEnvironment();
  Object.assign(win, { matchMedia: () => ({ matches: true }) });
  installPwaSupport();
  const prompt = vi.fn().mockResolvedValue(undefined);
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt, userChoice: Promise.resolve({ outcome: 'accepted' }),
  });
  win.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(showPwaInstallOption).not.toHaveBeenCalled();
  expect(window.__DS_PWA__!.canInstall()).toBe(true);
  expect(await window.__DS_PWA__!.promptInstall()).toBe(true);
  expect(await window.__DS_PWA__!.promptInstall()).toBe(false);
  expect(prompt).toHaveBeenCalledTimes(1);
  win.dispatchEvent(new Event('appinstalled'));
  expect(hidePwaInstallOption).toHaveBeenCalled();
  expect(window.__DS_PWA__!.canInstall()).toBe(false);
});

it('lets a failed offline health request reach the existing recoverable connection gate, not a token form', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  await ensureAuthenticated();
  expect(document.getElementById('ds-web-token-form')).toBeNull();
});

it('keeps the login gate pending through slow health and session responses and permits a failed-login retry', async () => {
  let health!: (response: { status: number }) => void;
  let session!: (response: { ok: boolean }) => void;
  const fetchMock = vi.fn()
    .mockImplementationOnce(() => new Promise((resolve) => { health = resolve; }))
    .mockResolvedValueOnce({ ok: false })
    .mockImplementationOnce(() => new Promise((resolve) => { session = resolve; }));
  vi.stubGlobal('fetch', fetchMock);
  let authenticated = false;
  const pending = ensureAuthenticated().then(() => { authenticated = true; });
  expect(authenticated).toBe(false);
  health({ status: 401 });
  await vi.waitFor(() => expect(document.getElementById('ds-web-token-form')).not.toBeNull());
  const form = document.getElementById('ds-web-token-form')!;
  const input = document.getElementById('ds-web-token-input') as HTMLInputElement;
  input.value = 'wrong';
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(input.disabled).toBe(false));
  expect(authenticated).toBe(false);
  input.value = 'right';
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(input.disabled).toBe(true);
  expect(authenticated).toBe(false);
  session({ ok: true });
  await pending;
  expect(form.isConnected).toBe(false);
});
