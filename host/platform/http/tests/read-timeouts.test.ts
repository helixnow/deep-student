/**
 * reqwest 只有总超时（`.timeout()`），没有响应头 / 响应体读超时；undici 的 `headersTimeout` / `bodyTimeout` 默认各 300 s。
 * undici 的这两个计时器走它自己的 fast timer 时钟，`tick` 把这个时钟推过 300 s：直连（`any`、`public`）、HTTP 代理、
 * `public-pinned` 四条路径都不能因此断开，`timeoutMs: null` 时只剩调用方的 `signal`。
 */
import { createServer, type ServerResponse, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpRequestInit } from '../api.ts';
import { createDesktopHttp } from '../index.ts';

const undiciTimers = createRequire(import.meta.url)('undici/lib/util/timers.js') as { tick(delay?: number): void };

/** Activates timers armed since the last tick, then moves undici's clock 301 s on (one second past its defaults). */
function passUndiciTime(): void {
  undiciTimers.tick(0);
  undiciTimers.tick(301_000);
}

interface Arrival { url: string; response: ServerResponse }

const servers: Server[] = [];
const clients: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

/** A server that hands every request to the test and answers only when told to. */
async function holdingServer(): Promise<{ port: number; next(): Promise<Arrival> }> {
  const arrivals: Arrival[] = [];
  const waiting: Array<(arrival: Arrival) => void> = [];
  const server = createServer((request, response) => {
    const arrival = { url: request.url ?? '', response };
    const waiter = waiting.shift();
    if (waiter) waiter(arrival); else arrivals.push(arrival);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    next: () => {
      const ready = arrivals.shift();
      return ready ? Promise.resolve(ready) : new Promise((resolve) => waiting.push(resolve));
    },
  };
}

function desktop(options: Parameters<typeof createDesktopHttp>[0]) {
  const client = createDesktopHttp({ platformProxy: async () => null, logger: { info: () => {}, warn: () => {} }, ...options });
  clients.push(client);
  return client;
}

type Route = (port: number, path: string, timeoutMs: number | null) => { send(): Promise<Response>; arrivesAs: string };

const direct = (destination: 'any' | 'public'): Route => (port, path, timeoutMs) => ({
  send: () => desktop({ env: {} }).fetch(`http://127.0.0.1:${port}${path}`, { destination, timeoutMs } satisfies HttpRequestInit),
  arrivesAs: path,
});

const viaHttpProxy: Route = (port, path, timeoutMs) => ({
  send: () => desktop({ env: { HTTP_PROXY: `http://127.0.0.1:${port}` } }).fetch(`http://upstream.test${path}`, { timeoutMs }),
  arrivesAs: `http://upstream.test${path}`,
});

const pinned: Route = (port, path, timeoutMs) => ({
  send: () => desktop({ env: {}, pinned: { resolve: async () => [{ address: '127.0.0.1' }] } })
    .fetch(`http://pinned.test:${port}${path}`, { destination: 'public-pinned', allowLoopback: true, timeoutMs }),
  arrivesAs: path,
});

const ROUTES: ReadonlyArray<readonly [string, Route, number | null]> = [
  ['any, timeoutMs: null', direct('any'), null],
  ['public, timeoutMs: null', direct('public'), null],
  ['HTTP proxy, timeoutMs: null', viaHttpProxy, null],
  ['public-pinned, timeoutMs: null', pinned, null],
  ['any, timeoutMs above 300 s', direct('any'), 600_000],
  ['public-pinned, timeoutMs above 300 s', pinned, 600_000],
];

describe('ctx.http has no response header or body read timeout (reqwest has none)', () => {
  it.each(ROUTES)('%s: response headers that arrive after 300 s are still received', async (_name, route, timeoutMs) => {
    const server = await holdingServer();
    const request = route(server.port, '/slow-headers', timeoutMs);
    const pending = request.send();
    const arrival = await server.next();
    expect(arrival.url).toBe(request.arrivesAs);

    passUndiciTime();
    arrival.response.end('late headers');
    const response = await pending;
    expect([response.status, await response.text()]).toEqual([200, 'late headers']);
  });

  it.each(ROUTES)('%s: a 300 s pause between body chunks does not cut the body', async (_name, route, timeoutMs) => {
    const server = await holdingServer();
    const request = route(server.port, '/slow-body', timeoutMs);
    const pending = request.send();
    const arrival = await server.next();
    arrival.response.writeHead(200);
    arrival.response.write('first ');
    const reader = (await pending).body!.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value, { stream: true });
    expect(text).toBe('first ');

    passUndiciTime();
    arrival.response.end('second');
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) text += decoder.decode(chunk.value, { stream: true });
    expect(text).toBe('first second');
  });
});
