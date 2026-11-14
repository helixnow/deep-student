import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const origin = 'https://web.test';

function worker(network: typeof fetch) {
  const listeners = new Map<string, (event: any) => void>();
  const entries = new Map<string, Response>();
  const key = (request: string | { url: string }) => new URL(typeof request === 'string' ? request : request.url, origin).href;
  const cache = {
    match: vi.fn(async (request: string | { url: string }) => entries.get(key(request))?.clone()),
    put: vi.fn(async (request: string | { url: string }, response: Response) => { entries.set(key(request), response); }),
    // Cache.addAll is atomic: one non-2xx response rejects the entire batch.
    addAll: vi.fn(async (urls: string[]) => {
      const responses = await Promise.all(urls.map((url) => network(url)));
      if (responses.some((response) => !response.ok)) throw new TypeError('Failed to fetch');
      await Promise.all(urls.map((url, index) => cache.put(url, responses[index]!)));
    }),
  };
  runInNewContext(source, {
    URL, Response, AbortController, setTimeout, clearTimeout, fetch: network,
    caches: { open: vi.fn(async () => cache) },
    self: {
      location: { origin }, registration: { active: {} },
      addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
    },
  });
  function dispatch(name: string, path = '/', navigate = true) {
    const lifetimes: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    listeners.get(name)!({
      request: { url: `${origin}${path}`, method: 'GET', mode: navigate ? 'navigate' : 'cors', headers: new Headers() },
      waitUntil: (promise: Promise<unknown>) => lifetimes.push(promise),
      respondWith: (promise: Promise<Response>) => { response = promise; },
    });
    return { response, lifetimes };
  }
  return { cache, entries, dispatch };
}

afterEach(() => vi.useRealTimers());

it('bounds a stalled navigation and aborts its request before returning the cached shell', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const network = vi.fn((_request, options) => {
    signal = options?.signal as AbortSignal;
    return new Promise<Response>(() => {}); // Captive/blackholed connection: no headers or rejection.
  }) as unknown as typeof fetch;
  const sw = worker(network);
  sw.entries.set(`${origin}/`, new Response('cached shell'));
  const event = sw.dispatch('fetch', '/workspace');
  let result: Response | undefined;
  void event.response!.then((response) => { result = response; });
  await vi.advanceTimersByTimeAsync(4999);
  expect(result).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(await result?.text()).toBe('cached shell');
  expect(signal?.aborted).toBe(true);
});

it('bounds a cold stalled navigation with the existing offline page rather than hanging forever', async () => {
  vi.useFakeTimers();
  const sw = worker(vi.fn(() => new Promise<Response>(() => {})) as typeof fetch);
  const event = sw.dispatch('fetch');
  let result: Response | undefined;
  void event.response!.then((response) => { result = response; });
  await vi.advanceTimersByTimeAsync(5000);
  expect(result?.status).toBe(503);
  expect(await result?.text()).toContain('当前无法连接 Deep Student 宿主服务');
});

it('keeps successfully precached shell resources when one optional icon returns 404', async () => {
  const network = vi.fn(async (request) => new Response(request === '/icon-512.png' ? 'missing' : `body:${request}`, {
    status: request === '/icon-512.png' ? 404 : 200,
    headers: { 'content-type': request === '/' ? 'text/html' : 'application/octet-stream' },
  })) as typeof fetch;
  const sw = worker(network);
  await Promise.all(sw.dispatch('install').lifetimes);
  expect(await (await sw.cache.match('/'))?.text()).toBe('body:/');
  expect(await sw.cache.match('/boot.css')).toBeDefined();
  expect(await sw.cache.match('/icon-512.png')).toBeUndefined();
});

it('does not precache a session-expired login response and still caches public icons', async () => {
  const network = vi.fn(async (request) => new Response(request === '/' ? 'login gate' : 'icon', {
    status: request === '/' ? 401 : 200,
  })) as typeof fetch;
  const sw = worker(network);
  await Promise.all(sw.dispatch('install').lifetimes);
  expect(await sw.cache.match('/')).toBeUndefined();
  expect(await sw.cache.match('/icon-192.png')).toBeDefined();
});

it('clears the navigation deadline when a normal network response succeeds', async () => {
  vi.useFakeTimers();
  const sw = worker(vi.fn(async () => new Response('online shell')) as typeof fetch);
  const event = sw.dispatch('fetch');
  expect(await (await event.response)!.text()).toBe('online shell');
  await Promise.all(event.lifetimes);
  expect(vi.getTimerCount()).toBe(0);
});

it('serves the actual 401 login page without replacing the cached shell', async () => {
  const sw = worker(vi.fn(async () => new Response('login gate', {
    status: 401, headers: { 'content-type': 'text/html', 'cache-control': 'no-store' },
  })) as typeof fetch);
  sw.entries.set(`${origin}/`, new Response('cached shell'));
  const event = sw.dispatch('fetch');
  expect((await event.response)?.status).toBe(401);
  await Promise.all(event.lifetimes);
  expect(await (await sw.cache.match('/'))?.text()).toBe('cached shell');
});

it('serves cached static assets on offline revalidation without issuing a retry', async () => {
  const network = vi.fn(async () => { throw new TypeError('offline'); }) as typeof fetch;
  const sw = worker(network);
  sw.entries.set(`${origin}/fonts/app.woff2`, new Response('cached font'));
  const event = sw.dispatch('fetch', '/fonts/app.woff2', false);
  expect(await (await event.response)!.text()).toBe('cached font');
  await Promise.all(event.lifetimes);
  expect(network).toHaveBeenCalledOnce();
});

it.each(['/fonts/app.woff2', '/assets/app-hash.js'])('returns a successful %s download even when cache quota is exhausted', async (path) => {
  const sw = worker(vi.fn(async () => new Response('network asset')) as typeof fetch);
  sw.cache.put.mockRejectedValueOnce(new DOMException('Quota exceeded', 'QuotaExceededError'));
  const event = sw.dispatch('fetch', path, false);
  expect(await (await event.response)!.text()).toBe('network asset');
  await Promise.all(event.lifetimes);
});
