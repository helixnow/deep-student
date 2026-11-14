import './local-fs-fixture.ts';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { WebDavStorage } from '../src/webdav.ts';
import { S3Storage } from '../src/s3.ts';
import { FtpStorage, FTP_RANGE_MAX_OBJECT_BYTES } from '../src/ftp.ts';
import { getFileWithOptionalResume } from '../src/resume.ts';
import { filePropfindXml, spawnFakeDav } from './fake_dav.ts';
import { s3ErrorXml, spawnFakeS3 } from './fake_s3.ts';
import { MemoryStorage } from './memory_storage.ts';
import { spawnFakeFtp } from './fake_ftp.ts';

const data = Uint8Array.from({ length: 256 * 1024 }, (_, i) => i % 251);
const davStorage = (endpoint: string) => new WebDavStorage({ endpoint, username: 'user', password: 'pass' }, 'root', { rateLimitEnv: '0' });
const s3Storage = (endpoint: string) => new S3Storage({ endpoint, bucket: 'bucket', accessKeyId: 'key', secretAccessKey: 'secret', region: 'us-east-1', pathStyle: true }, 'root');

describe('定长 Range 读取契约', () => {
  it('WebDAV 发送真实 Range，服务端返回 206 与精确 Content-Range', async () => {
    const server = await spawnFakeDav(() => ({ status: 200, body: data }), 0, { ranges: true });
    try {
      const storage = davStorage(server.endpoint);
      expect(await storage.getRange('obj', 71, 512)).toEqual(data.slice(71, 583));
      expect(server.rangeRequests).toEqual([{ path: '/root/obj', range: 'bytes=71-582' }]);
      expect(server.requests[0]?.headers.authorization).toMatch(/^Basic /);
      const response = await fetch(`${server.endpoint}root/obj`, { headers: { Range: 'bytes=11-22' } });
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(`bytes 11-22/${data.length}`);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(data.slice(11, 23));
      await expect(storage.getRange('obj', data.length, 1)).rejects.toMatchObject({ value: { error_type: 'Configuration' } });
      await expect(storage.getRange('obj', data.length - 1, 2)).rejects.toThrow('416');
    } finally { await server.close(); }
  });

  it('S3 GetObject 使用真实 Range 与严格长度校验', async () => {
    const server = await spawnFakeS3(() => ({ status: 200, body: data }), 0, { ranges: true });
    try {
      const storage = s3Storage(server.endpoint);
      expect(await storage.getRange('obj', 321, 1024)).toEqual(data.slice(321, 1345));
      expect(server.log[0]?.headers.range).toBe('bytes=321-1344');
      expect(server.log[0]?.path).toBe('/bucket/root/obj');
      const response = await fetch(`${server.endpoint}/bucket/root/obj`, { headers: { Range: 'bytes=9-31' } });
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(`bytes 9-31/${data.length}`);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(data.slice(9, 32));
      await expect(storage.getRange('obj', data.length, 1)).rejects.toThrow('416');
      await expect(storage.getRange('obj', data.length - 1, 2)).rejects.toThrow('416');
    } finally { await server.close(); }
  });

  it('各后端拒绝无效整数与溢出，零长度不触发网络或查找', async () => {
    const storages = [
      davStorage('http://127.0.0.1:1/'), s3Storage('http://127.0.0.1:1/'), new MemoryStorage(),
      new FtpStorage({ host: '127.0.0.1', port: 1, useTls: false, username: 'user', password: 'pass' }, 'root'),
    ];
    for (const storage of storages) {
      for (const [offset, length] of [[-1, 1], [0, -1], [0.5, 1], [0, 0.5], [NaN, 1], [0, Infinity], [Number.MAX_SAFE_INTEGER, 1]]) {
        await expect(storage.getRange('missing', offset!, length!)).rejects.toThrow('安全整数');
      }
      expect(await storage.getRange('missing', 0, 0)).toEqual(new Uint8Array(0));
    }
  });

  it('WebDAV 与 S3 的 404 映射 NotFound', async () => {
    const dav = await spawnFakeDav(() => ({ status: 404 }));
    const s3 = await spawnFakeS3(() => ({ status: 404, body: s3ErrorXml('NoSuchKey') }));
    try {
      await expect(davStorage(dav.endpoint).getRange('missing', 0, 1)).rejects.toMatchObject({ value: { error_type: 'NotFound' } });
      await expect(s3Storage(s3.endpoint).getRange('missing', 0, 1)).rejects.toMatchObject({ value: { error_type: 'NotFound' } });
    } finally { await dav.close(); await s3.close(); }
  });

  it('WebDAV 200 回退仅允许足长对象，206 拒绝错位与短响应', async () => {
    const server = await spawnFakeDav((_method, path) => {
      if (path.endsWith('/wrong')) return { status: 206, headers: { 'Content-Range': 'bytes 0-3/100' }, body: data.slice(0, 4) };
      if (path.endsWith('/short')) return { status: 206, headers: { 'Content-Range': 'bytes 3-6/100' }, body: data.slice(0, 2) };
      return { status: 200, body: data.slice(0, 32) };
    });
    try {
      const storage = davStorage(server.endpoint);
      expect(await storage.getRange('fallback', 5, 9)).toEqual(data.slice(5, 14));
      await expect(storage.getRange('fallback', 30, 3)).rejects.toThrow('越界');
      await expect(storage.getRange('wrong', 3, 4)).rejects.toThrow('区间不匹配');
      await expect(storage.getRange('short', 3, 4)).rejects.toThrow('长度不匹配');
    } finally { await server.close(); }
  });

  it('S3 拒绝短响应和忽略 Range 后返回的超长整对象', async () => {
    const server = await spawnFakeS3(request => ({ status: 206, headers: { 'Content-Range': 'bytes 3-6/100' }, body: data.slice(0, request.path.endsWith('/short') ? 2 : 10) }));
    try {
      const storage = s3Storage(server.endpoint);
      await expect(storage.getRange('short', 3, 4)).rejects.toThrow('长度不匹配');
      await expect(storage.getRange('long', 3, 4)).rejects.toThrow('预算');
    } finally { await server.close(); }
  });

  it('S3 206 缺失 ContentRange 即使等长也拒绝，200 整包严格按偏移切片', async () => {
    const server = await spawnFakeS3(request => ({
      status: request.path.endsWith('/missing') ? 206 : 200,
      body: data.slice(0, request.path.endsWith('/full') ? 10 : 4),
    }));
    try {
      const storage = s3Storage(server.endpoint);
      await expect(storage.getRange('missing', 3, 4)).rejects.toMatchObject({ value: { error_type: 'Network' } });
      await expect(storage.getRange('short-full', 3, 4)).rejects.toThrow('越界');
      expect(await storage.getRange('full', 3, 4)).toEqual(data.slice(3, 7));
    } finally { await server.close(); }
  });

  it('拒绝 WebDAV 206 缺失或非法 Content-Range 及 S3 错位 ContentRange', async () => {
    const dav = await spawnFakeDav((_method, path) => {
      const headers: Record<string, string> = path.endsWith('/malformed') ? { 'Content-Range': 'bytes nonsense' } : {};
      return { status: 206, body: data.slice(3, 7), headers };
    });
    const s3 = await spawnFakeS3(() => ({ status: 206, body: data.slice(3, 7), headers: { 'Content-Range': 'bytes 4-7/100' } }));
    try {
      for (const key of ['missing', 'malformed']) await expect(davStorage(dav.endpoint).getRange(key, 3, 4)).rejects.toMatchObject({ value: { error_type: 'Network' } });
      await expect(s3Storage(s3.endpoint).getRange('wrong', 3, 4)).rejects.toMatchObject({ value: { error_type: 'Network' } });
    } finally { await dav.close(); await s3.close(); }
  });

  it('内存 Range 返回独立拷贝、记录请求并拒绝越界', async () => {
    const storage = new MemoryStorage();
    await storage.put('obj', data);
    const bytes = await storage.getRange('obj', 12, 40);
    expect(bytes).toEqual(data.slice(12, 52));
    bytes[0] = 255;
    expect(storage.bytes('obj')?.[12]).toBe(data[12]);
    expect(storage.rangeRequests).toEqual([{ path: 'obj', offset: 12, length: 40 }]);
    await expect(storage.getRange('obj', data.length, 1)).rejects.toThrow('越界');
    await expect(storage.getRange('missing', 0, 1)).rejects.toMatchObject({ value: { error_type: 'NotFound' } });
  });

  it('FTP 对超出小对象阈值的区间在联网前拒绝', async () => {
    const storage = new FtpStorage({ host: '127.0.0.1', port: 1, useTls: false, username: 'user', password: 'pass' }, 'root');
    await expect(storage.getRange('obj', FTP_RANGE_MAX_OBJECT_BYTES, 1)).rejects.toThrow('安全阈值');
  });

  it('FTP 小对象切片，超大对象在 SIZE 后、RETR 前拒绝', async () => {
    const server = await spawnFakeFtp({ files: { '/root/obj': data }, intercept: command => command === 'SIZE huge'
      ? { code: 213, text: String(FTP_RANGE_MAX_OBJECT_BYTES + 1) } : null });
    try {
      const storage = new FtpStorage({ host: server.host, port: server.port, useTls: false, username: 'user', password: 'pass' }, 'root');
      expect(await storage.getRange('obj', 10, 20)).toEqual(data.slice(10, 30));
      await expect(storage.getRange('obj', data.length, 1)).rejects.toThrow('越界');
      await expect(storage.getRange('huge', 0, 1)).rejects.toThrow('预算');
      expect(server.server.commands).not.toContain('RETR huge');
    } finally { await server.server.close(); }
  });

  it('真实断流保留 64 KiB 文件，续传从该位置发送 Range 并完成校验', async () => {
    const dir = await mkdtemp(join(process.cwd(), '.range-contract-'));
    const dest = join(dir, 'download');
    let cutDest: string | undefined = dest;
    const rangeRequests: Array<{ path: string; range: string }> = [];
    // Disconnect only after the client persists the prefix, not after a fixed
    // 20 ms timer that can race Electron startup under concurrent CPU load.
    const http = createServer((req, res) => {
      if (req.method === 'PROPFIND') {
        res.writeHead(207); res.end(filePropfindXml(req.url!, data.length)); return;
      }
      const range = req.headers.range;
      if (range) {
        rangeRequests.push({ path: req.url!, range });
        const offset = Number(/^bytes=(\d+)-/.exec(range)![1]);
        res.writeHead(206, { 'Content-Length': data.length - offset, 'Content-Range': `bytes ${offset}-${data.length - 1}/${data.length}` });
        res.end(data.subarray(offset)); return;
      }
      res.writeHead(200, { 'Content-Length': data.length });
      const interruptedFile = cutDest;
      if (!interruptedFile) { res.end(data); return; }
      cutDest = undefined;
      res.flushHeaders(); res.write(data.subarray(0, 65536));
      const cut = async () => {
        if (res.destroyed) return;
        if (await stat(interruptedFile).then(s => s.size, () => 0) === 65536) res.socket?.destroy();
        else setTimeout(() => { void cut(); }, 5);
      };
      void cut();
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(http.address() as { port: number }).port}/`;
    const checksum = createHash('sha256').update(data).digest('hex');
    try {
      const storage = davStorage(endpoint);
      await expect(storage.getFileResumable('obj', dest, 0)).rejects.toThrow();
      expect((await stat(dest)).size).toBe(64 * 1024);
      expect(new Uint8Array(await readFile(dest))).toEqual(data.slice(0, 64 * 1024));
      expect(await getFileWithOptionalResume(storage, 'obj', dest, checksum)).toBe(checksum);
      expect(new Uint8Array(await readFile(dest))).toEqual(data);
      expect(rangeRequests).toEqual([{ path: '/root/obj', range: 'bytes=65536-' }]);

      // Also prove the production retry loop itself bridges a fresh interrupted GET.
      const retried = join(dir, 'retried');
      cutDest = retried;
      expect(await getFileWithOptionalResume(storage, 'obj', retried, checksum)).toBe(checksum);
      expect(new Uint8Array(await readFile(retried))).toEqual(data);
      expect(rangeRequests).toHaveLength(2);
      expect(rangeRequests[1]?.range).toBe('bytes=65536-');
    } finally {
      http.closeAllConnections();
      await new Promise<void>(resolve => http.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
