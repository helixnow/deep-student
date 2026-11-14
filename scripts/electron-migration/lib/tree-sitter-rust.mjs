// tree-sitter-rust（wasm）加载器。
//
// tree-sitter-wasms@0.1.13 的 rust 语法是旧版 emscripten 产物，自定义段名为 `dylink`（旧格式：
// memorySize/memoryAlign/tableSize/tableAlign + needed 列表），而 web-tree-sitter@0.27 只认
// `dylink.0`（子段格式，WASM_DYLINK_MEM_INFO=1 / WASM_DYLINK_NEEDED=2）。两种格式承载的字段一致，
// 这里在内存中把旧段改写为新段，字节码其余部分原样保留，不改语法本身。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WTS = pathToFileURL(path.join(ROOT, 'node_modules/web-tree-sitter/web-tree-sitter.js')).href;
const RUST_WASM = path.join(ROOT, 'node_modules/tree-sitter-wasms/out/tree-sitter-rust.wasm');

function readLeb(buf, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = buf[pos++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) return [result, pos];
  }
}

function leb(n) {
  const out = [];
  do {
    let byte = n & 0x7f;
    n = Math.floor(n / 128);
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
  return out;
}

function str(s) {
  const b = Buffer.from(s, 'utf8');
  return [...leb(b.length), ...b];
}

/** 把首个自定义段 `dylink`（旧格式）改写为 `dylink.0`。已是新格式时原样返回。 */
export function upgradeDylink(bytes) {
  const buf = Buffer.from(bytes);
  if (buf[8] !== 0) throw new Error('tree-sitter-rust.wasm: dylink section is not first');
  let [size, pos] = readLeb(buf, 9);
  const sectionEnd = pos + size;
  const [nameLen, p1] = readLeb(buf, pos);
  const name = buf.subarray(p1, p1 + nameLen).toString('utf8');
  if (name === 'dylink.0') return buf;
  if (name !== 'dylink') throw new Error(`tree-sitter-rust.wasm: unexpected first custom section ${name}`);
  pos = p1 + nameLen;
  const vals = [];
  for (let i = 0; i < 4; i++) {
    let v;
    [v, pos] = readLeb(buf, pos);
    vals.push(v);
  }
  let count;
  [count, pos] = readLeb(buf, pos);
  const needed = [];
  for (let i = 0; i < count; i++) {
    let len;
    [len, pos] = readLeb(buf, pos);
    needed.push(buf.subarray(pos, pos + len).toString('utf8'));
    pos += len;
  }
  const memInfo = vals.flatMap((v) => leb(v));
  const body = [...str('dylink.0'), 1, ...leb(memInfo.length), ...memInfo];
  if (needed.length) {
    const n = [...leb(needed.length), ...needed.flatMap((s) => str(s))];
    body.push(2, ...leb(n.length), ...n);
  }
  const section = Buffer.from([0, ...leb(body.length), ...body]);
  return Buffer.concat([buf.subarray(0, 8), section, buf.subarray(sectionEnd)]);
}

let parserPromise;

/** 返回已设置 Rust 语言的 Parser（进程内单例）。 */
export function rustParser() {
  parserPromise ??= (async () => {
    const { Parser, Language } = await import(WTS);
    await Parser.init();
    const lang = await Language.load(upgradeDylink(fs.readFileSync(RUST_WASM)));
    const parser = new Parser();
    parser.setLanguage(lang);
    return parser;
  })();
  return parserPromise;
}
