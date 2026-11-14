/**
 * reqwest-compatible redirect semantics (http.ts).
 *
 * webdav.rs builds `reqwest::Client` without a redirect policy, so the default
 * `redirect::Policy::limited(10)` applies: 301/302/303 drop the body and turn
 * non-GET/HEAD into GET, 307/308 keep a re-sendable body, and sensitive headers
 * are removed on cross-host hops. These tests exercise the transport directly and
 * through WebDavStorage so the policy cannot silently regress.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CloudStorageError } from '../src/errors.ts';
import { MAX_REDIRECTS, bufferedResponse, send } from '../src/http.ts';
import { WebDavStorage } from '../src/webdav.ts';
import { multistatusXml, spawnFakeDav } from './fake_dav.ts';

interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

interface FakeHttp {
  endpoint: string;
  log: RecordedRequest[];
  close(): Promise<void>;
}

const servers: FakeHttp[] = [];
const davServers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
  while (davServers.length > 0) await davServers.pop()!.close();
});

async function spawnHttp(handler: (request: RecordedRequest, index: number) => Reply): Promise<FakeHttp> {
  const log: RecordedRequest[] = [];
  let index = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    req.on('end', () => {
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
      }
      const request: RecordedRequest = {
        method: req.method ?? 'GET',
        path: (req.url ?? '/').split('?')[0] ?? '/',
        headers,
        body: Buffer.concat(chunks),
      };
      log.push(request);
      const reply = handler(request, index++);
      const payload = reply.body === undefined
        ? Buffer.alloc(0)
        : typeof reply.body === 'string' ? Buffer.from(reply.body, 'utf8') : Buffer.from(reply.body);
      res.writeHead(reply.status, { ...reply.headers, 'Content-Length': String(payload.byteLength) });
      res.end(payload);
    });
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address() as AddressInfo;
  const fake: FakeHttp = {
    endpoint: `http://127.0.0.1:${address.port}`,
    log,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); }),
  };
  servers.push(fake);
  return fake;
}

function webdavFor(endpoint: string, root = 'root'): WebDavStorage {
  return new WebDavStorage(
    { endpoint, username: 'user', password: 'pass' },
    root,
    { rateLimitEnv: '0', requestWindowKey: `${endpoint}|${root}|${Math.random()}` },
  );
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try { await promise; }
  catch (error) { return error as Error; }
  throw new Error('expected the operation to fail');
}

describe('http.ts redirects', () => {
  it('follows a 302 for GET', async () => {
    const server = await spawnHttp((_request, index) => (index === 0
      ? { status: 302, headers: { Location: '/moved' } }
      : { status: 200, body: 'payload' }));
    const response = await send({ method: 'GET', url: new URL(`${server.endpoint}/start`) });
    expect(await response.text()).toBe('payload');
    expect(server.log.map(request => `${request.method} ${request.path}`))
      .toEqual(['GET /start', 'GET /moved']);
  });

  it('follows a 301 for PROPFIND as GET and drops the request body and entity headers', async () => {
    const xml = multistatusXml('/canonical/', 1);
    const server = await spawnHttp((_request, index) => (index === 0
      ? { status: 301, headers: { Location: '/canonical/' } }
      : { status: 207, body: xml }));
    const response = await send({
      method: 'PROPFIND',
      url: new URL(`${server.endpoint}/root/`),
      headers: { 'content-type': 'application/xml', depth: '1' },
      body: Buffer.from('<propfind/>'),
    });
    expect(response.status).toBe(207);
    expect(await response.text()).toBe(xml);

    const followed = server.log[1]!;
    expect(followed.method).toBe('GET');
    expect(followed.body).toHaveLength(0);
    expect(followed.headers['content-type']).toBeUndefined();
    expect(followed.headers.depth).toBe('1');
  });

  it('follows a 307 for a re-sendable buffer body and preserves method and body', async () => {
    const server = await spawnHttp((_request, index) => (index === 0
      ? { status: 307, headers: { Location: '/again' } }
      : { status: 200, body: 'ok' }));
    const response = await send({
      method: 'PUT',
      url: new URL(`${server.endpoint}/upload`),
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('hello'),
    });
    expect(await response.text()).toBe('ok');
    const followed = server.log[1]!;
    expect(followed.method).toBe('PUT');
    expect(followed.body.toString()).toBe('hello');
    expect(followed.headers['content-type']).toBe('text/plain');
  });

  it('returns a 307 unchanged for a streaming body', async () => {
    const server = await spawnHttp(() => ({ status: 307, headers: { Location: '/again' } }));
    const response = await send({
      method: 'PUT',
      url: new URL(`${server.endpoint}/upload`),
      bodyFactory: () => new Blob(['stream']).stream(),
      bodyLength: 6,
    });
    expect(response.status).toBe(307);
    expect(server.log).toHaveLength(1);
    response.discard();
  });

  it('stops at the reqwest limit of 10 redirect responses', async () => {
    const server = await spawnHttp(() => ({ status: 302, headers: { Location: '/loop' } }));
    const error = await failure(send({ method: 'GET', url: new URL(`${server.endpoint}/loop`) }));
    expect(MAX_REDIRECTS).toBe(10);
    expect(error).toBeInstanceOf(CloudStorageError);
    expect(error.message).toContain('too many redirects');
    expect(server.log).toHaveLength(10);
  });

  it('follows nine redirects and succeeds on the tenth request', async () => {
    const server = await spawnHttp((_request, index) => (index < 9
      ? { status: 302, headers: { Location: `/step-${index + 1}` } }
      : { status: 200, body: 'done' }));
    const response = await send({ method: 'GET', url: new URL(`${server.endpoint}/step-0`) });
    expect(await response.text()).toBe('done');
    expect(server.log).toHaveLength(10);
  });

  it('strips sensitive headers on a cross-host redirect and keeps custom headers', async () => {
    const target = await spawnHttp(() => ({ status: 200, body: 'ok' }));
    const source = await spawnHttp(() => ({
      status: 302,
      headers: { Location: `${target.endpoint}/target` },
    }));
    const response = await send({
      method: 'GET',
      url: new URL(`${source.endpoint}/start`),
      headers: {
        authorization: 'Bearer secret',
        cookie: 'session=1',
        'proxy-authorization': 'Basic x',
        'www-authenticate': 'Basic realm="x"',
        'x-custom': 'kept',
      },
    });
    expect(await response.text()).toBe('ok');
    const followed = target.log[0]!;
    expect(followed.headers.authorization).toBeUndefined();
    expect(followed.headers.cookie).toBeUndefined();
    expect(followed.headers['proxy-authorization']).toBeUndefined();
    expect(followed.headers['www-authenticate']).toBeUndefined();
    expect(followed.headers['x-custom']).toBe('kept');
  });

  it('keeps credentials on a same-host redirect', async () => {
    const server = await spawnHttp((_request, index) => (index === 0
      ? { status: 302, headers: { Location: '/same' } }
      : { status: 200, body: 'ok' }));
    const response = await send({
      method: 'GET',
      url: new URL(`${server.endpoint}/start`),
      headers: { authorization: 'Bearer secret' },
    });
    expect(await response.text()).toBe('ok');
    expect(server.log[1]!.headers.authorization).toBe('Bearer secret');
  });

  it('does not follow an invalid Location', async () => {
    const server = await spawnHttp(() => ({ status: 302, headers: { Location: 'http://[::1' } }));
    const response = await send({ method: 'GET', url: new URL(`${server.endpoint}/start`) });
    expect(response.status).toBe(302);
    expect(server.log).toHaveLength(1);
    response.discard();
  });

  it('replays a buffered response with its status, headers and body', async () => {
    const server = await spawnHttp(() => ({
      status: 400,
      headers: { 'x-amz-request-id': 'req-1' },
      body: 'boom',
    }));
    const raw = await send({ method: 'GET', url: new URL(`${server.endpoint}/bad`) });
    const buffered = bufferedResponse(raw, await raw.bytes());
    expect(buffered.status).toBe(400);
    expect(buffered.headers['x-amz-request-id']).toBe('req-1');
    expect(await buffered.text()).toBe('boom');
    expect(Buffer.from(await buffered.bytes()).toString()).toBe('boom');
  });
});

describe('webdav.rs redirects', () => {
  it('follows a GET redirect before reading the object', async () => {
    const server = await spawnFakeDav((_method, _path, index) => (index === 0
      ? { status: 302, headers: { Location: '/canonical/obj.bin' } }
      : { status: 200, body: 'payload' }));
    davServers.push(server);
    const storage = webdavFor(server.endpoint);
    expect(Buffer.from((await storage.get('obj.bin'))!).toString()).toBe('payload');
    expect(server.log.map(([method, path]) => `${method} ${path}`))
      .toEqual(['GET /root/obj.bin', 'GET /canonical/obj.bin']);
  });

  it('follows a PROPFIND redirect as GET and still parses the multistatus body', async () => {
    const xml = multistatusXml('/root/', 2);
    const server = await spawnFakeDav((_method, _path, index) => (index === 0
      ? { status: 301, headers: { Location: '/root/' } }
      : { status: 207, body: xml }));
    davServers.push(server);
    const storage = webdavFor(server.endpoint);
    const files = await storage.list('');
    expect(files.map(file => file.key)).toEqual(['file-0.txt', 'file-1.txt']);
    expect(server.log.map(([method]) => method)).toEqual(['PROPFIND', 'GET']);
  });
});
