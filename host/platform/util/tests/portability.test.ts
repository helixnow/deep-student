/**
 * `platform/util/portable.ts`、`index.ts`、`api.ts` 与 `platform/errors/api.ts` 是可移植入口：运行时闭包
 * 不得触达 Node 专有依赖（`node:*`、`Buffer`、`process` 等；`import type` 不计）。ZIP、QR（`node:zlib`）与
 * 返回 `Buffer` 的 base64 解码器只从桌面入口 `util/node.ts` 导出。
 */
import { STATUS_CODES } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';
import * as portable from '../portable.ts';
import * as barrel from '../index.ts';
import * as desktop from '../node.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

describe('platform/util portable entry', () => {
  it('portable.ts, the util barrels and errors/api.ts never load Node modules at runtime', () => {
    expect(checkModulesClosure(ROOT, [
      'host/platform/util/portable.ts',
      'host/platform/util/index.ts',
      'host/platform/util/api.ts',
      'host/platform/errors/api.ts',
    ])).toEqual([]);
  });

  it('desktop-only submodules are the ones that still use node:zlib (scanner sanity check)', () => {
    const keys = (file: string) => checkModulesClosure(ROOT, [file]).map((violation) => violation.key);
    expect(keys('host/platform/util/zip.ts')).toContain('node-builtin:zlib');
    expect(keys('host/platform/util/qr.ts')).toContain('node-builtin:zlib');
    expect(keys('host/platform/util/node.ts')).toContain('node-builtin:zlib');
  });

  it('util/index.ts re-exports every portable value unchanged and nothing else', () => {
    const names = Object.keys(portable);
    expect(names.length).toBeGreaterThan(40);
    expect(Object.keys(barrel).sort()).toEqual([...names].sort());
    for (const name of names) {
      expect((barrel as Record<string, unknown>)[name], name).toBe((portable as Record<string, unknown>)[name]);
    }
    expect(typeof desktop.writeZip).toBe('function');
    expect(typeof desktop.readZip).toBe('function');
  });

  it('keeps the Rust http canonical reason for 501 identical to node:http', () => {
    expect(portable.canonicalReason(501)).toBe(STATUS_CODES[501]);
    expect(portable.statusLine(501)).toBe(`501 ${STATUS_CODES[501]}`);
  });

  it('counts UTF-8 bytes like Buffer.byteLength, including lone surrogates', () => {
    for (const value of ['', 'abc', 'é', '中文', '😀', '\ud800', 'a\udc00b', '\ud83d\ude00\ud83d']) {
      expect(portable.utf8ByteLength(value), JSON.stringify(value)).toBe(Buffer.byteLength(value, 'utf8'));
    }
  });

  it('orders strings by UTF-8 bytes exactly like Buffer.compare (Rust String Ord)', () => {
    const samples = ['', 'a', 'ab', 'b', 'Z', 'é', '中', '\uffff', '😀', '\ud800', '\udfff', '\ue000', 'a\ud800', 'a\ufffd'];
    for (const left of samples) {
      for (const right of samples) {
        const expected = Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
        expect(portable.compareUtf8(left, right), `${JSON.stringify(left)} vs ${JSON.stringify(right)}`).toBe(expected);
      }
    }
  });

  it('keeps a leading BOM when decoding or truncating, like Buffer#toString', () => {
    const bom = Uint8Array.of(0xef, 0xbb, 0xbf, 0x61);
    expect(portable.decodeUtf8Strict(bom)).toBe('\ufeffa');
    expect(portable.truncateUtf8('\ufeffab', 4)).toBe('\ufeffa');
    expect(portable.truncateUtf8Exact('\ufeffab', 3)).toBe('\ufeff');
  });

  it('decodes base64 to plain Uint8Array on the portable entries and to Buffer on the desktop entry', () => {
    const web = portable.decodeBase64Standard('aGk=');
    expect(web.bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(web.bytes)).toBe(false);
    expect([...web.bytes!]).toEqual([0x68, 0x69]);
    expect(Buffer.isBuffer(barrel.decodeBase64Standard('aGk=').bytes)).toBe(false);
    const node = desktop.decodeBase64Standard('aGk=');
    expect(Buffer.isBuffer(node.bytes)).toBe(true);
    expect(node.bytes!.toString('utf8')).toBe('hi');
    expect(desktop.decodeBase64Standard('a').error).toBe(portable.decodeBase64Standard('a').error);
    expect(Buffer.isBuffer(desktop.decodeBase64Standard('').bytes)).toBe(true);
  });
});
