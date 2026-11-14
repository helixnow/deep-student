import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

// Static HTTP is real; no Host database/runtime is needed for this fixture.
vi.mock('../server/gateway.ts', () => ({
  createWebHostGateway: () => ({ ready: Promise.resolve(), shutdown: async () => {} }),
}));

import { startWebServer, type RunningWebServer } from '../server/main.ts';

describe('B02 production static HTTP', () => {
  let root: string;
  let running: RunningWebServer;
  const token = 'b02-fixture-token';
  const source = Buffer.from('export const greeting = "公网静态资源回归测试";\n'.repeat(1200));

  function get(path: string, headers: Record<string, string> = {}, method = 'GET', body?: string) {
    return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: running.port, path, headers: { Authorization: `Bearer ${token}`, ...headers }, method }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  beforeAll(async () => {
    root = resolve(await mkdtemp(join(tmpdir(), 'b02-static-')));
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'cold-abc123.js'), source);
    await writeFile(join(root, 'index.html'), source);
    running = await startWebServer({ host: '127.0.0.1', port: 0, prod: true, distDir: root, token, log: () => {} });
  });

  afterAll(async () => {
    await running?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each(['/assets/cold-abc123.js', '/index.html'])('shares one cold read/compression across eight concurrent requests for %s', async (path) => {
    vi.mocked(readFile).mockClear();
    const responses = await Promise.all(Array.from({ length: 8 }, () => get(path, { 'Accept-Encoding': 'br' })));
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers['content-encoding']).toBe('br');
      expect(brotliDecompressSync(response.body).equals(source)).toBe(true);
    }
    const reads = () => vi.mocked(readFile).mock.calls.filter(([file]) => file === join(root, path)).length;
    expect(reads()).toBe(1);
    await get(path, { 'Accept-Encoding': 'gzip' });
    expect(reads()).toBe(1);
  });

  it.each([
    ['br;q=0, gzip;q=1', 'gzip'],
    ['br;q=0, gzip;q=0', undefined],
    ['br;q=0.1, gzip;q=0.9', 'gzip'],
    ['*;q=0.8, identity;q=0', 'br'],
    ['br;q=0.2, identity;q=1', undefined],
  ])('negotiates accepted quality values: %s', async (acceptEncoding, encoding) => {
    const response = await get('/index.html', { 'Accept-Encoding': acceptEncoding });
    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBe(encoding);
    const decoded = encoding === 'br' ? brotliDecompressSync(response.body) : encoding === 'gzip' ? gunzipSync(response.body) : response.body;
    expect(decoded.equals(source)).toBe(true);
    expect(Number(response.headers['content-length'])).toBe(response.body.length);
    expect(response.headers.vary).toBe('Accept-Encoding');
  });

  it('returns 406 when every available representation is explicitly refused', async () => {
    const response = await get('/index.html', { 'Accept-Encoding': 'br;q=0, gzip;q=0, identity;q=0' });
    expect(response.status).toBe(406);
    expect(response.body.length).toBe(0);
  });

  it('keeps HEAD and weak conditional GET bodyless with the same representation metadata', async () => {
    const full = await get('/index.html', { 'Accept-Encoding': 'gzip' });
    const head = await get('/index.html', { 'Accept-Encoding': 'gzip' }, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(full.headers['content-length']);
    expect(head.body.length).toBe(0);
    const conditional = await get('/index.html', { 'If-None-Match': String(full.headers.etag).replace(/^W\//, '') });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.etag).toBe(full.headers.etag);
    expect(conditional.body.length).toBe(0);
  });

  it('authenticates through an HTTPS loopback reverse proxy and rejects a foreign Origin', async () => {
    const headers = {
      Origin: 'https://study.example.com',
      'X-Forwarded-Host': 'study.example.com',
      'X-Forwarded-Proto': 'https',
      'Content-Type': 'application/json',
    };
    const session = await get('/api/auth/session', headers, 'POST', JSON.stringify({ token }));
    expect(session.status).toBe(200);
    const cookie = session.headers['set-cookie']![0]!;
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    const authenticated = await get('/index.html', { Authorization: '', Cookie: cookie.split(';')[0]! });
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers['cache-control']).toBe('private, no-cache');
    const foreign = await get('/api/auth/session', { ...headers, Origin: 'https://foreign.example' }, 'POST', JSON.stringify({ token }));
    expect(foreign.status).toBe(403);
  });
});
