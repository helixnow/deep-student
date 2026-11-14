/**
 * `asset://` 响应（tauri-2.11.5 `src/protocol/asset.rs` `get_response`）：403/404 分支、整文件流式读取、
 * Range 单段上限与多段段数上限。
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSET_STREAM_CHUNK,
  assetResponse,
  MAX_LEN,
  MAX_RANGES,
  type AssetResponse,
} from '../shell/asset-protocol.ts';
import { FsScope } from '../shell/scope.ts';
import type { ShellPlatform } from '../shell/tauri-config.ts';

const platform: ShellPlatform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
const origin = 'tauri://localhost';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dstu-asset-')));
  const allowed = join(root, 'allowed');
  const outside = join(root, 'outside');
  mkdirSync(allowed);
  mkdirSync(outside);
  const scope = new FsScope({ platform });
  scope.allowDirectory(allowed, true);
  return { root, allowed, outside, scope };
}

function assetUrl(path: string): string {
  return `asset://localhost/${encodeURIComponent(path)}`;
}

async function bodyBytes(response: AssetResponse): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  if (response.body instanceof Uint8Array) return response.body;
  return new Uint8Array(await new Response(response.body).arrayBuffer());
}

function patterned(size: number): Buffer {
  const data = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) data[i] = (i * 31 + 7) & 0xff;
  return data;
}

describe('asset protocol 403 branches (SafePathBuf / scope.is_allowed)', () => {
  it('rejects a path with a `..` component before consulting the scope or the filesystem', async () => {
    const { allowed, scope } = fixture();
    writeFileSync(join(allowed, 'a.txt'), 'secret');
    // 词法上 `<allowed>/sub/../a.txt` 指向作用域内的真实文件，但含 `..` 必须先被拒绝。
    const traversal = `${allowed}/sub/../a.txt`;
    const response = await assetResponse({ url: assetUrl(traversal), method: 'GET', headers: {} }, scope, origin, platform);
    expect(response.status).toBe(403);
    expect(response.headers).toEqual({ 'Access-Control-Allow-Origin': origin });
    expect(await bodyBytes(response)).toEqual(new Uint8Array());
  });

  it('rejects an existing file outside the asset scope', async () => {
    const { outside, scope } = fixture();
    const file = join(outside, 'b.txt');
    writeFileSync(file, 'outside');
    const response = await assetResponse({ url: assetUrl(file), method: 'GET', headers: {} }, scope, origin, platform);
    expect(response.status).toBe(403);
    expect(response.headers).toEqual({ 'Access-Control-Allow-Origin': origin });
    expect(await bodyBytes(response)).toEqual(new Uint8Array());
  });

  it('returns 404 for a missing in-scope file', async () => {
    const { allowed, scope } = fixture();
    const response = await assetResponse({ url: assetUrl(join(allowed, 'missing.bin')), method: 'GET', headers: {} }, scope, origin, platform);
    expect(response.status).toBe(404);
  });
});

describe('asset protocol streaming', () => {
  it('streams a whole large file asynchronously in bounded chunks', async () => {
    const { allowed, scope } = fixture();
    const file = join(allowed, 'big.bin');
    const data = patterned(ASSET_STREAM_CHUNK * 3 + 1234);
    writeFileSync(file, data);
    const pending = assetResponse({ url: assetUrl(file), method: 'GET', headers: {} }, scope, origin, platform);
    expect(pending).toBeInstanceOf(Promise);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers['Content-Length']).toBe(String(data.length));
    expect(response.body).toBeInstanceOf(ReadableStream);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      expect(value.byteLength).toBeLessThanOrEqual(ASSET_STREAM_CHUNK);
      chunks.push(value);
    }
    expect(chunks.length).toBeGreaterThan(1);
    expect(Buffer.concat(chunks).equals(data)).toBe(true);
  });

  it('a cancelled stream releases the file without erroring', async () => {
    const { allowed, scope } = fixture();
    const file = join(allowed, 'cancel.bin');
    writeFileSync(file, patterned(ASSET_STREAM_CHUNK * 4));
    const response = await assetResponse({ url: assetUrl(file), method: 'GET', headers: {} }, scope, origin, platform);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await expect(reader.cancel()).resolves.toBeUndefined();
  });

  it('small files keep the sniffed MIME and inline bytes; HEAD has no body', async () => {
    const { allowed, scope } = fixture();
    const file = join(allowed, 'p.bin');
    writeFileSync(file, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]));
    const get = await assetResponse({ url: assetUrl(file), method: 'GET', headers: {} }, scope, origin, platform);
    expect(get.headers['Content-Type']).toBe('application/pdf');
    expect(Buffer.from(await bodyBytes(get)).toString('latin1')).toBe('%PDF-');
    const head = await assetResponse({ url: assetUrl(file), method: 'HEAD', headers: {} }, scope, origin, platform);
    expect(head.status).toBe(200);
    expect(head.headers['Content-Length']).toBe('5');
    expect(head.body).toBeNull();
  });
});

describe('asset protocol Range', () => {
  it('a single range is capped at MAX_LEN (206)', async () => {
    const { allowed, scope } = fixture();
    const file = join(allowed, 'video.mp4');
    const data = patterned(MAX_LEN + 5000);
    writeFileSync(file, data);
    const response = await assetResponse({ url: assetUrl(file), method: 'GET', headers: { Range: 'bytes=10-' } }, scope, origin, platform);
    expect(response.status).toBe(206);
    expect(response.headers['Content-Range']).toBe(`bytes 10-${10 + MAX_LEN - 1}/${data.length}`);
    expect(response.headers['Content-Length']).toBe(String(MAX_LEN));
    expect(Buffer.from(await bodyBytes(response)).equals(data.subarray(10, 10 + MAX_LEN))).toBe(true);
  });

  it('multipart byteranges keep the Tauri layout', async () => {
    const { allowed, scope } = fixture();
    const file = join(allowed, 'doc.txt');
    writeFileSync(file, 'abcdefghijklmnopqrstuvwxyz');
    const response = await assetResponse({ url: assetUrl(file), method: 'GET', headers: { range: 'bytes=0-2, 5-6' } }, scope, origin, platform);
    expect(response.status).toBe(200);
    const boundary = /^multipart\/byteranges; boundary=([0-9a-f]+)$/.exec(response.headers['Content-Type'] ?? '')?.[1];
    expect(boundary).toBeDefined();
    const sep = `\r\n--${boundary}\r\n`;
    expect(Buffer.from(await bodyBytes(response)).toString('latin1')).toBe(
      `${sep}content-type: text/plain\r\ncontent-range: bytes 0-2/26\r\n\r\nabc`
      + `${sep}content-type: text/plain\r\ncontent-range: bytes 5-6/26\r\n\r\nfg${sep}`,
    );
  });

  it(`rejects more than MAX_RANGES (${MAX_RANGES}) ranges with 416`, async () => {
    const { allowed, scope } = fixture();
    const file = join(allowed, 'many.bin');
    writeFileSync(file, patterned(4096));
    const many = Array.from({ length: MAX_RANGES + 1 }, () => '0-4095').join(',');
    const response = await assetResponse({ url: assetUrl(file), method: 'GET', headers: { range: `bytes=${many}` } }, scope, origin, platform);
    expect(response.status).toBe(416);
    expect(response.headers['Content-Range']).toBe('bytes */4096');
    const atLimit = Array.from({ length: MAX_RANGES }, (_, i) => `${i}-${i}`).join(',');
    const ok = await assetResponse({ url: assetUrl(file), method: 'GET', headers: { range: `bytes=${atLimit}` } }, scope, origin, platform);
    expect(ok.status).toBe(200);
  });
});
