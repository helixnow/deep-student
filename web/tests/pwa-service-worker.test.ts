import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function serviceWorker(cached?: Response) {
  let onFetch!: (event: unknown) => void;
  const network = deferred<Response>();
  const write = deferred<void>();
  const cache = { match: vi.fn().mockResolvedValue(cached), put: vi.fn(() => write.promise) };
  const fetch = vi.fn(() => network.promise);
  runInNewContext(source, {
    URL, Response, AbortController, setTimeout, clearTimeout, fetch,
    caches: { open: vi.fn().mockResolvedValue(cache) },
    self: {
      location: { origin: 'https://web.test' },
      addEventListener: (name: string, listener: typeof onFetch) => {
        if (name === 'fetch') onFetch = listener;
      },
    },
  });
  const dispatch = (path: string, options: { navigate?: boolean; range?: boolean } = {}) => {
    let response: Promise<Response> | undefined;
    const lifetimes: Promise<unknown>[] = [];
    onFetch({
      request: { url: `https://web.test${path}`, method: 'GET', mode: options.navigate ? 'navigate' : 'cors',
        headers: new Headers(options.range ? { range: 'bytes=0-10' } : {}) },
      respondWith: (value: Promise<Response>) => { response = value; },
      waitUntil: (value: Promise<unknown>) => { lifetimes.push(value); },
    });
    return { get response() { return response; }, lifetimes };
  };
  return { dispatch, cache, fetch, network, write };
}

it('keeps stale-while-revalidate alive through the network response and cache write', async () => {
  const cached = new Response('old font');
  const worker = serviceWorker(cached);
  const event = worker.dispatch('/fonts/app.woff2');
  expect(await event.response).toBe(cached); // Cache hits must not block on the network.
  expect(event.lifetimes).toHaveLength(1);
  worker.network.resolve(new Response('new font'));
  await vi.waitFor(() => expect(worker.cache.put).toHaveBeenCalledOnce());
  let completed = false;
  const lifetime = Promise.all(event.lifetimes).then(() => { completed = true; });
  await Promise.resolve();
  expect(completed).toBe(false);
  worker.write.resolve();
  await lifetime;
  expect(completed).toBe(true);
});

it.each(['/assets/app-hash.js', '/'])('keeps the %s offline-cache write alive', async (path) => {
  const worker = serviceWorker();
  const event = worker.dispatch(path, { navigate: path === '/' });
  worker.network.resolve(new Response('app shell', { headers: { 'content-type': 'text/javascript' } }));
  await event.response;
  expect(event.lifetimes).toHaveLength(1);
  let completed = false;
  const lifetime = Promise.all(event.lifetimes).then(() => { completed = true; });
  await Promise.resolve();
  expect(completed).toBe(false);
  worker.write.resolve();
  await lifetime;
});

it('leaves authenticated API and range requests to the network', () => {
  const worker = serviceWorker();
  expect(worker.dispatch('/api/health').response).toBeUndefined();
  expect(worker.dispatch('/assets/video-hash.mp4', { range: true }).response).toBeUndefined();
  expect(worker.fetch).not.toHaveBeenCalled();
});
