import './local-fs-fixture.ts';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebDavStorage } from '../src/webdav.ts';
import { clearCancelToken, setCancelToken } from '../src/traits.ts';
import { filePropfindXml } from './fake_dav.ts';

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  clearCancelToken();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup(handler: (method: string, res: ServerResponse) => void): Promise<WebDavStorage> {
  const server = createServer((req, res) => { req.resume(); handler(req.method!, res); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return new WebDavStorage({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, username: 'local', password: 'test' }, '', { rateLimitEnv: '0' });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('operation did not stop promptly')), 1000);
    })]);
  } finally { clearTimeout(timer!); }
}

describe('B16 WebDAV interruption and rejected bodies', () => {
  it.each(['upload', 'prefix'] as const)('cancels a pending %s request', async operation => {
    const requested = deferred<void>();
    const storage = await setup((_method, _res) => requested.resolve());
    const directory = await mkdtemp('/tmp/opencode/b16-dav-');
    directories.push(directory);
    const source = join(directory, 'upload.zip');
    await writeFile(source, 'abcdef');
    const cancel = new AbortController();
    setCancelToken(cancel.signal);
    const pending: Promise<unknown> = operation === 'upload'
      ? storage.putFile('backup.zip', source)
      : storage.getPrefix('backup.zip', 3);
    const result = pending.catch(error => error as Error);
    await requested.promise;
    cancel.abort();
    const error = await promptly(result);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('云同步已取消');
  });

  it('cancels an in-flight PROPFIND instead of waiting for the header timeout', async () => {
    const requested = deferred<void>();
    const storage = await setup(() => requested.resolve());
    const cancel = new AbortController();
    setCancelToken(cancel.signal);
    const result = storage.stat('backup.zip').catch(error => error as Error);
    await requested.promise;
    cancel.abort();
    const error = await promptly(result);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('云同步已取消');
  });

  it('cancels a resumable body, preserves its exact prefix and resumes successfully', async () => {
    const requested = deferred<void>();
    let first = true;
    const storage = await setup((method, res) => {
      if (method === 'PROPFIND') { res.writeHead(207); res.end(filePropfindXml('/backup.zip', 6)); return; }
      if (first) {
        first = false;
        res.writeHead(200, { 'content-length': '6' });
        res.write('abc');
        requested.resolve();
      } else {
        res.writeHead(206, { 'content-length': '3', 'content-range': 'bytes 3-5/6' });
        res.end('def');
      }
    });
    const directory = await mkdtemp('/tmp/opencode/b16-dav-');
    directories.push(directory);
    const dest = join(directory, 'backup.part');
    const written = deferred<void>();
    const cancel = new AbortController();
    setCancelToken(cancel.signal);
    const result = storage.getFileResumable('backup.zip', dest, 0, done => {
      if (done === 3) written.resolve();
    }).catch(error => error as Error);
    await requested.promise;
    await written.promise;
    cancel.abort();
    const error = await promptly(result);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('云同步已取消');
    expect((await readFile(dest)).toString()).toBe('abc');
    clearCancelToken();
    expect(await storage.getFileResumable('backup.zip', dest, 3)).toBe(3);
    expect((await readFile(dest)).toString()).toBe('abcdef');
  });

  it.each([true, false])('closes an over-budget download connection (declared length: %s)', async declared => {
    const closed = deferred<void>();
    const storage = await setup((_method, res) => {
      res.on('close', () => closed.resolve());
      res.writeHead(200, declared ? { 'content-length': '1000000' } : {});
      res.write('too large');
    });
    await expect(storage.getBounded('manifest.json', 4)).rejects.toThrow('内存预算');
    await promptly(closed.promise);
  });
});
