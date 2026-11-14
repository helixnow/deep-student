import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { backupServiceStub } from './backup-service-stub.ts';
import { testPaths } from './sync-fixture.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
// boundary-allow cross-plugin-impl: L22 集成测试需安装真实 L23 插件，经 syncProvider 验证 WebDAV 下载契约
import syncProviders from '../../sync-providers/index.ts';

/**
 * `sync_r10_provider_contract.rs` 的 TS 行为级移植：WebDAV 非续传 get_file
 * 的字节数核对契约。
 *
 * PROPFIND 声明的对象大小与 GET 实际字节数不一致时（对象在 stat 与 GET
 * 之间被换包），生产 `WebDavStorage.getFile` 必须 fail-closed 且不落盘；
 * 一致时成功并返回正确 SHA256。
 */
const hosts: TestHost[] = [];
const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Shape {
  statSize: number;
  getBody: Buffer;
  declaredContentLength: number;
}

async function startServer(shape: Shape): Promise<string> {
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://dav.local').pathname);
    if (request.method === 'PROPFIND') {
      const xml = '<?xml version="1.0" encoding="utf-8"?>'
        + '<d:multistatus xmlns:d="DAV:"><d:response>'
        + `<d:href>${pathname}</d:href>`
        + '<d:propstat><d:prop><d:resourcetype/>'
        + `<d:getcontentlength>${shape.statSize}</d:getcontentlength>`
        + '<d:getlastmodified>Tue, 01 Jul 2025 12:00:00 GMT</d:getlastmodified>'
        + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>'
        + '</d:response></d:multistatus>';
      response.writeHead(207, {
        'content-type': 'application/xml; charset=utf-8',
        'content-length': String(Buffer.byteLength(xml)),
      }).end(xml);
      return;
    }
    if (request.method === 'GET') {
      response.writeHead(200, {
        'content-length': String(shape.declaredContentLength),
        'content-type': 'application/octet-stream',
      });
      response.write(shape.getBody);
      // Content-Length 大于实际发送字节：发完即断开，模拟传输中断。
      if (shape.declaredContentLength > shape.getBody.byteLength) response.destroy();
      else response.end();
      return;
    }
    response.writeHead(405).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/dav/`;
}

function payload(length: number): Buffer {
  const data = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) data[index] = index % 251;
  return data;
}

async function storageFor(endpoint: string) {
  const host = await createTestHost({
    plugins: [syncProviders],
    provide: {
      secrets: {
        backup: createBackupCrypto(),
        openStore() {
          return { async getCloudCredentials() { return { webdavPassword: 'secret' }; } };
        },
      },
      backup: backupServiceStub(() => ({ webdavPassword: 'secret' })),
      paths: testPaths(tempDir(), 'l22-webdav-device'),
    },
  });
  hosts.push(host);
  const service = host.ctx.get('syncProvider');
  if (service === undefined) throw new Error('syncProvider 未注册');
  return service.createStorage({
    provider: 'webdav',
    webdav: { endpoint, username: 'tester', password: 'secret' },
    root: 'sync-root',
    encryptionPassword: null,
  });
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'l22-webdav-'));
  roots.push(dir);
  return dir;
}

it('swapped_smaller_object_between_stat_and_get_fails_closed', async () => {
  const declared = 32 * 1024;
  const stored = payload(declared);
  const smaller = stored.subarray(0, declared - 1024);
  const endpoint = await startServer({
    statSize: declared,
    getBody: smaller,
    declaredContentLength: smaller.byteLength,
  });
  const storage = await storageFor(endpoint);
  const dest = join(tempDir(), 'smaller.zip');

  await expect(storage.getFile('backups/contract.zip', dest, null, null))
    .rejects.toThrow(/下载不完整或对象已变更/);
  expect(() => readFileSync(dest)).toThrow();
});

it('swapped_larger_object_between_stat_and_get_fails_closed', async () => {
  const declared = 8 * 1024;
  const stored = payload(declared);
  const larger = Buffer.concat([stored, payload(4 * 1024)]);
  const endpoint = await startServer({
    statSize: declared,
    getBody: larger,
    declaredContentLength: larger.byteLength,
  });
  const storage = await storageFor(endpoint);
  const dest = join(tempDir(), 'larger.zip');

  await expect(storage.getFile('backups/contract.zip', dest, null, null))
    .rejects.toThrow(/下载不完整或对象已变更/);
  expect(() => readFileSync(dest)).toThrow();
});

it('truncated_stream_is_an_error_not_a_success', async () => {
  const declared = 16 * 1024;
  const stored = payload(declared);
  const endpoint = await startServer({
    statSize: declared,
    getBody: stored.subarray(0, declared / 2),
    declaredContentLength: declared,
  });
  const storage = await storageFor(endpoint);
  const dest = join(tempDir(), 'truncated.zip');

  await expect(storage.getFile('backups/contract.zip', dest, null, null)).rejects.toThrow();
  expect(() => readFileSync(dest)).toThrow();
});

it('consistent_download_succeeds_with_correct_bytes_and_checksum', async () => {
  const declared = 12 * 1024;
  const stored = payload(declared);
  const endpoint = await startServer({
    statSize: declared,
    getBody: stored,
    declaredContentLength: declared,
  });
  const storage = await storageFor(endpoint);
  const dest = join(tempDir(), 'consistent.zip');

  const checksum = await storage.getFile('backups/contract.zip', dest, null, null);
  expect(checksum).toBe(createHash('sha256').update(stored).digest('hex'));
  expect(readFileSync(dest)).toEqual(stored);
});
