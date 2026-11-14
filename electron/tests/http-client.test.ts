import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { bypassProxy, HttpClient } from '../shell/http-client.ts';

const servers: Server[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve, reject) => { s.closeAllConnections(); s.close((e) => e ? reject(e) : resolve()); })));
});
const init = () => ({ method: 'GET', headers: new Headers(), signal: new AbortController().signal });
const noAutomaticProxy = () => { for (const key of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY']) vi.stubEnv(key, ''); };

it('shared jar stores cookies on redirects, observes path and Secure, and expires cookies', async () => {
  noAutomaticProxy();
  const base = await listen(createServer((req, res) => {
    if (req.url === '/set') { res.writeHead(302, { location: '/only/read', 'set-cookie': ['a=1; Path=/only', 'b=2; Secure', 'old=; Max-Age=0'] }); res.end(); }
    else res.end(req.headers.cookie ?? '');
  }));
  const client = new HttpClient();
  expect(await (await client.send(new URL(base + '/set'), init(), {})).text()).toBe('a=1');
  expect(await (await client.send(new URL(base + '/elsewhere'), init(), {})).text()).toBe('');
});

it('reqwest default redirect policy permits ten redirects; zero returns first response', async () => {
  noAutomaticProxy();
  const base = await listen(createServer((req, res) => {
    const n = Number(req.url?.slice(1));
    if (n > 0) res.writeHead(302, { location: '/' + (n - 1) });
    res.end('end');
  }));
  const client = new HttpClient();
  expect(await (await client.send(new URL(base + '/10'), init(), {})).text()).toBe('end');
  await expect(client.send(new URL(base + '/11'), init(), {})).rejects.toThrow('too many redirects');
  const stopped = await client.send(new URL(base + '/10'), init(), { maxRedirections: 0 });
  expect(stopped.status).toBe(302); await stopped.text();
});
it('explicit maxRedirections counts followed redirects like Policy::limited', async () => {
  noAutomaticProxy();
  const base = await listen(createServer((req, res) => {
    const n = Number(req.url?.slice(1));
    if (n > 0) res.writeHead(302, { location: '/' + (n - 1) });
    res.end('end');
  }));
  const client = new HttpClient();
  expect(await (await client.send(new URL(base + '/1'), init(), { maxRedirections: 1 })).text()).toBe('end');
  await expect(client.send(new URL(base + '/2'), init(), { maxRedirections: 1 })).rejects.toThrow('too many redirects');
});

it('redirects set Referer like reqwest and strip authorization across origins', async () => {
  noAutomaticProxy();
  let seenReferer: string | undefined, seenAuth: string | undefined;
  const target = await listen(createServer((req, res) => { seenReferer = req.headers.referer; seenAuth = req.headers.authorization; res.end('ok'); }));
  const source = await listen(createServer((_req, res) => { res.writeHead(302, { location: `${target}/next` }); res.end(); }));
  const headers = new Headers({ authorization: 'secret', referer: 'https://old.example/' });
  const response = await new HttpClient().send(new URL(`${source}/start`), { method: 'GET', headers, signal: new AbortController().signal }, {});
  expect(await response.text()).toBe('ok');
  expect(seenAuth).toBeUndefined();
  expect(seenReferer).toBe(`${source}/start`);
});

it('noProxy matches IP networks, IP literals and domains like hyper-util', () => {
  expect(bypassProxy('192.168.1.42', 'google.com, 192.168.1.0/24')).toBe(true);
  expect(bypassProxy('192.168.2.42', '192.168.1.0/24')).toBe(false);
  expect(bypassProxy('10.1.2.3', '10.1.2.3')).toBe(true);
  expect(bypassProxy('10.1.2.4', '10.1.2.3')).toBe(false);
  expect(bypassProxy('[::1]', '::1')).toBe(true);
  expect(bypassProxy('[2001:db8::5]', '2001:db8::/32')).toBe(true);
  expect(bypassProxy('[2001:db9::5]', '2001:db8::/32')).toBe(false);
  expect(bypassProxy('www.google.com', '.google.com')).toBe(true);
  expect(bypassProxy('google.com', '.google.com')).toBe(true);
  expect(bypassProxy('notgoogle.com', 'google.com')).toBe(false);
  expect(bypassProxy('anything.example', '*')).toBe(true);
  expect(bypassProxy('192.168.1.42', 'example.com')).toBe(false);
  expect(bypassProxy('example.com', '192.168.1.0/24')).toBe(false);
  expect(bypassProxy('example.com', ' , ')).toBe(false);
});

it('explicit proxy basicAuth, noProxy and OS resolver are applied', async () => {
  noAutomaticProxy();
  const base = await listen(createServer((_req, res) => res.end('ok')));
  let auth: string | undefined, requests = 0;
  const proxy = createServer();
  proxy.on('connect', (req, socket, head) => {
    requests++; auth = req.headers['proxy-authorization'];
    const target = new URL(`http://${req.url}`);
    const upstream = connect(Number(target.port), target.hostname, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  const proxyUrl = await listen(proxy);
  const client = new HttpClient();
  expect(await (await client.send(new URL(base), init(), { proxy: { all: { url: proxyUrl, basicAuth: { username: 'u', password: 'p' } } } })).text()).toBe('ok');
  expect(auth).toBe('Basic dTpw'); expect(requests).toBe(1);
  await (await client.send(new URL(base), init(), { proxy: { all: { url: proxyUrl, noProxy: '127.0.0.1' } } })).text();
  expect(requests).toBe(1);
  const resolver = vi.fn(async () => `PROXY ${new URL(proxyUrl).host}`);
  await (await new HttpClient(resolver).send(new URL(base), init(), {})).text();
  expect(requests).toBe(2); expect(resolver).toHaveBeenCalledWith(new URL(base).href);
});
