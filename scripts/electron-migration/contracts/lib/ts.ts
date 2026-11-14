// 加载 web-tree-sitter 与 tree-sitter-wasms 的 Rust 语法。
//
// tree-sitter-wasms@0.1.13 的 wasm 由 tree-sitter-cli 0.20 / 旧版 emscripten 构建，首段是旧式
// `dylink` 自定义段（mem_size, mem_align, table_size, table_align, needed_dynlibs）；
// web-tree-sitter 0.27 的加载器只认 `dylink.0`（子段 1 = MEM_INFO、2 = NEEDED）。这里在内存里
// 把旧段等价改写为新格式（字段一一对应，代码段不动），不修改 node_modules。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';

function leb(n: number): number[] {
  const o: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    o.push(b);
  } while (n);
  return o;
}

export function upgradeLegacyDylink(buf: Uint8Array): Uint8Array {
  if (buf[8] !== 0) return buf;
  let off = 9;
  const rd = (): number => {
    let r = 0;
    let s = 0;
    let b: number;
    do { b = buf[off++]!; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
    return r >>> 0;
  };
  const size = rd();
  const end = off + size;
  const nl = rd();
  const name = Buffer.from(buf.subarray(off, off + nl)).toString();
  off += nl;
  if (name !== 'dylink') return buf;
  const memSize = rd(), memAlign = rd(), tableSize = rd(), tableAlign = rd();
  const cnt = rd();
  const libs: Uint8Array[] = [];
  for (let i = 0; i < cnt; i++) { const l = rd(); libs.push(buf.subarray(off, off + l)); off += l; }
  const mem = [...leb(memSize), ...leb(memAlign), ...leb(tableSize), ...leb(tableAlign)];
  const body = [...leb(8), ...Buffer.from('dylink.0'), 1, ...leb(mem.length), ...mem];
  if (cnt) {
    const s = [...leb(cnt)];
    for (const l of libs) s.push(...leb(l.length), ...l);
    body.push(2, ...leb(s.length), ...s);
  }
  return new Uint8Array([...buf.subarray(0, 8), 0, ...leb(body.length), ...body, ...buf.subarray(end)]);
}

let cached: Promise<Parser> | null = null;

export function rustWasmPath(): string {
  const req = createRequire(import.meta.url);
  return path.join(path.dirname(req.resolve('tree-sitter-wasms/package.json')), 'out/tree-sitter-rust.wasm');
}

export function loadRustParser(): Promise<Parser> {
  cached ??= (async () => {
    await Parser.init();
    const bytes = upgradeLegacyDylink(new Uint8Array(fs.readFileSync(rustWasmPath())));
    const lang = await Language.load(bytes);
    const p = new Parser();
    p.setLanguage(lang);
    return p;
  })();
  return cached;
}
