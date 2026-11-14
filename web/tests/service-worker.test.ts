// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const origin = 'https://study.example.com';
const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function worker() {
  const handlers = new Map<string, (event: any) => void>();
  const stores = new Map<string, Map<string, Response>>();
  const key = (request: Request | string) => typeof request === 'string' ? new URL(request, origin).href : request.url;
  const put = vi.fn(async (store: Map<string, Response>, request: Request | string, response: Response) => {
    store.set(key(request), response.clone());
  });
  const caches = {
    open: async (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return { match: async (request: Request | string) => store.get(key(request))?.clone(),
        put: (request: Request | string, response: Response) => put(store, request, response) };
    },
    keys: async () => [...stores.keys()],
    delete: vi.fn(async (name: string) => stores.delete(name)),
  };
  const fetchMock = vi.fn().mockImplementation(async () => new Response('asset', { headers: { 'Content-Type': 'text/javascript' } }));
  runInNewContext(source, {
    self: { location: { origin }, registration: { active: true }, clients: { claim: vi.fn() },
      addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler), skipWaiting: vi.fn() },
    caches, fetch: fetchMock, URL, Response, AbortController, setTimeout, clearTimeout,
  });
  function dispatch(name: string, request?: Request, preloadResponse?: Promise<Response | undefined>) {
    const pending: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    handlers.get(name)!({ request, preloadResponse, waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      respondWith: (promise: Promise<Response>) => { response = promise; } });
    return { get response() { return response; }, async done() {
      const result = await response;
      await Promise.all(pending);
      return result;
    } };
  }
  return { dispatch, stores, caches, put, fetchMock };
}

function request(path: string, options: { navigation?: boolean; headers?: Record<string, string> } = {}) {
  const req = new Request(new URL(path, origin), { headers: options.headers });
  if (options.navigation) Object.defineProperty(req, 'mode', { value: 'navigate' });
  return req;
}

describe('WebUI service worker', () => {
  it.each([
    ['/assets/media.mp4', { Range: 'bytes=0-9' }], ['/api/health', {}], ['/api', {}],
    ['/api/ws', { Upgrade: 'websocket' }], ['/src/main.tsx', {}], ['https://cdn.example.com/a.js', {}],
  ])('bypasses %s', (path, headers) => {
    const sw = worker();
    expect(sw.dispatch('fetch', request(path, { headers })).response).toBeUndefined();
    expect(sw.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [404, 'text/javascript'], [500, 'text/javascript'], [206, 'application/pdf'],
    [200, 'text/html'], [200, 'Text/HTML; charset=utf-8'],
  ])('never caches bad asset response %s %s', async (status, type) => {
    const sw = worker();
    sw.fetchMock.mockResolvedValue(new Response('bad', { status, headers: { 'Content-Type': type } }));
    await sw.dispatch('fetch', request('/assets/missing.js')).done();
    expect(sw.put).not.toHaveBeenCalled();
  });

  it('does not cache no-store shell responses or HTML masquerading as a root script', async () => {
    const sw = worker();
    sw.fetchMock.mockResolvedValue(new Response('private', { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'private, no-store' } }));
    await sw.dispatch('fetch', request('/?token=secret', { navigation: true })).done();
    sw.fetchMock.mockResolvedValue(new Response('fallback', { headers: { 'Content-Type': 'text/html' } }));
    await sw.dispatch('fetch', request('/boot-theme.js')).done();
    expect(sw.put).not.toHaveBeenCalled();
  });

  it('catches quota failures without failing a successful fetch', async () => {
    const sw = worker();
    sw.put.mockRejectedValue(new Error('quota'));
    expect((await sw.dispatch('fetch', request('/assets/entry.js')).done())?.status).toBe(200);
  });

  it('keeps static revalidation alive and replaces the stale asset', async () => {
    const sw = worker();
    const cache = await sw.caches.open('ds-webui-static-v1');
    await cache.put('/pdf.worker.min.mjs', new Response('old'));
    let release!: (response: Response) => void;
    sw.fetchMock.mockReturnValue(new Promise<Response>((resolve) => { release = resolve; }));
    const event = sw.dispatch('fetch', request('/pdf.worker.min.mjs'));
    expect(await (await event.response)?.text()).toBe('old');
    release(new Response('new'));
    await event.done();
    expect(await (await cache.match('/pdf.worker.min.mjs'))?.text()).toBe('new');
  });

  it('falls back from rejected navigation preload and supports query/hash routes offline', async () => {
    const sw = worker();
    sw.fetchMock.mockResolvedValue(new Response('shell', { headers: { 'Content-Type': 'text/html' } }));
    await sw.dispatch('fetch', request('/?shell=mobile', { navigation: true }), Promise.reject(new Error('preload offline'))).done();
    sw.fetchMock.mockRejectedValue(new Error('offline'));
    expect(await (await sw.dispatch('fetch', request('/?shortcut=chat#/note', { navigation: true })).done())?.text()).toBe('shell');
  });

  it('returns the offline page when no shell is cached', async () => {
    const sw = worker();
    sw.fetchMock.mockRejectedValue(new Error('offline'));
    expect((await sw.dispatch('fetch', request('/', { navigation: true })).done())?.status).toBe(503);
  });

  it('only removes its own old caches during activation', async () => {
    const sw = worker();
    await sw.caches.open('another-app');
    await sw.caches.open('ds-webui-shell-v1-old');
    await sw.dispatch('activate').done();
    expect(sw.stores.has('another-app')).toBe(true);
    expect(sw.stores.has('ds-webui-shell-v1-old')).toBe(false);
  });

  it('validates install responses individually instead of precaching HTML errors as scripts', async () => {
    const sw = worker();
    sw.fetchMock.mockResolvedValue(new Response('fallback', { headers: { 'Content-Type': 'text/html' } }));
    await sw.dispatch('install').done();
    expect(sw.put).toHaveBeenCalledTimes(1);
    expect(sw.put.mock.calls[0]?.[1]).toBe('/');
  });
});
