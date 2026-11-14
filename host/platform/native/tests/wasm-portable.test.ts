// @vitest-environment jsdom
/**
 * 可移植 WASM 路径：`wasm/core.ts`（编译）、`wasm/wasi.ts`（内存版 WASI preview1）、
 * `wasm/engine.ts`、`wasm/web.ts`（按 URL fetch）以及 FSRS / 分词器 / Argon2 的 Web 入口，
 * 运行时闭包不得触达 Node。这里在 jsdom 环境下只通过 `fetch` 拿到 `.wasm` 字节，结果钉在
 * `wasm-portable-fixtures.ts` 的金值上；`wasm-portable-desktop.test.ts` 把桌面路径钉在同一组金值上。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';
import { DEFAULT_PARAMETERS, FsrsError } from '../fsrs/api.ts';
import { nextStates } from '../fsrs/model.ts';
import { createWebFsrs } from '../fsrs/web.ts';
import { webArgon2 } from '../argon2/web.ts';
import { loadWebTokenizer } from '../tokenizer/web.ts';
import { compileWasm, WasmCancelledError } from '../wasm/core.ts';
import { MemoryDirectory, MemoryWasi } from '../wasm/wasi.ts';
import { createWebWasmEngine } from '../wasm/web.ts';
import {
  ARGON2_PASSWORD, ARGON2_SALT, ARGON2_VECTORS, fsrsCards, fsrsEvaluationMatches, TOKEN_TEXT, TOKENS_CL100K, TOKENS_O200K,
} from './wasm-portable-fixtures.ts';

// jsdom replaces the global URL class, so resolve paths from the file path instead.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const F7_URL = 'https://app.invalid/assets/f7-native-wasm.wasm';
const TIKTOKEN_URL = 'https://app.invalid/assets/tiktoken_bg.wasm';
const ASSETS: Record<string, string> = {
  [F7_URL]: resolve(HERE, '../wasm/f7-native-wasm.wasm'),
  [TIKTOKEN_URL]: resolve(ROOT, 'node_modules/tiktoken/tiktoken_bg.wasm'),
};
const requested: string[] = [];

/** Browser-style asset server: the portable modules only ever see a `Response`. */
const assetFetch = async (input: string | URL): Promise<Response> => {
  const url = String(input);
  requested.push(url);
  const path = ASSETS[url];
  if (path === undefined) return new Response('not found', { status: 404 });
  return new Response(readFileSync(path), { headers: { 'content-type': 'application/wasm' } });
};

const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

const PORTABLE_WASM_ENTRIES = [
  'host/platform/native/wasm/core.ts',
  'host/platform/native/wasm/wasi.ts',
  'host/platform/native/wasm/engine.ts',
  'host/platform/native/wasm/web.ts',
  'host/platform/native/fsrs/core.ts',
  'host/platform/native/fsrs/web.ts',
  'host/platform/native/tokenizer/core.ts',
  'host/platform/native/tokenizer/web.ts',
  'host/platform/native/argon2/web.ts',
];

describe('portable WASM path (jsdom, assets via fetch only)', () => {
  it('portable entries never load Node modules at runtime', () => {
    expect(checkModulesClosure(ROOT, PORTABLE_WASM_ENTRIES)).toEqual([]);
  });

  it('compileWasm accepts bytes, ArrayBuffer, Response and Promise<Response>; HTTP errors are reported', async () => {
    const bytes = new Uint8Array(readFileSync(ASSETS[TIKTOKEN_URL]!));
    for (const source of [bytes, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), await assetFetch(TIKTOKEN_URL), assetFetch(TIKTOKEN_URL)]) {
      expect(await compileWasm(source)).toBeInstanceOf(WebAssembly.Module);
    }
    await expect(compileWasm(assetFetch('https://app.invalid/missing.wasm'))).rejects.toThrow('HTTP 404');
  });

  it('MemoryWasi runs the F7 command: argv, stderr capture and proc_exit status', async () => {
    const module = await compileWasm(assetFetch(F7_URL));
    const stderr: string[] = [];
    const wasi = new MemoryWasi({ args: ['f7-native-wasm'], preopens: { '/out': new MemoryDirectory() }, stderr: line => stderr.push(line) });
    expect(wasi.start(await WebAssembly.instantiate(module, wasi.imports()))).toBe(1);
    expect(stderr).toEqual(['usage: f7-native-wasm <request.json> <response.json>']);
  });

  it('FSRS evaluate (fsrs 6.6.2 crate) through fetch + MemoryWasi gives the desktop golden', async () => {
    const web = createWebFsrs(createWebWasmEngine({ url: F7_URL, fetch: assetFetch }));
    const evaluation = await web.evaluate(DEFAULT_PARAMETERS, fsrsCards());
    expect(fsrsEvaluationMatches(evaluation), JSON.stringify(evaluation)).toBe(true);
    const failure = await web.evaluate(DEFAULT_PARAMETERS, []).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(FsrsError);
    expect((failure as FsrsError).kind).toBe('NotEnoughData');
    expect(web.nextStates(DEFAULT_PARAMETERS, null, 0.9, 0)).toEqual(nextStates(DEFAULT_PARAMETERS, null, 0.9, 0));
    expect(requested).toContain(F7_URL);
  });

  it('engine exposes /out files and honours a pre-aborted signal', async () => {
    const engine = createWebWasmEngine({ url: F7_URL, fetch: assetFetch });
    const run = await engine.run({ engine: 'fsrs', op: 'evaluate', parameters: [...DEFAULT_PARAMETERS], items: [] }, { files: { 'note.txt': new TextEncoder().encode('kept') } });
    expect(run.response).toMatchObject({ kind: 'NotEnoughData' });
    expect(new TextDecoder().decode(run.files.get('note.txt'))).toBe('kept');
    expect(JSON.parse(new TextDecoder().decode(run.files.get('response.json')))).toEqual(run.response);
    const controller = new AbortController();
    controller.abort();
    await expect(engine.run({ engine: 'fsrs' }, { signal: controller.signal })).rejects.toBeInstanceOf(WasmCancelledError);
  });

  it('tokenizer: tiktoken/init instantiated from a fetched Response gives the desktop token ids', async () => {
    const tokenizer = await loadWebTokenizer(assetFetch(TIKTOKEN_URL));
    expect(tokenizer.encode(TOKEN_TEXT)).toEqual(TOKENS_CL100K);
    expect(tokenizer.encode(TOKEN_TEXT, 'gpt-4o')).toEqual(TOKENS_O200K);
    expect(tokenizer.estimateTokensWithModel(TOKEN_TEXT, 'gpt-4o')).toBe(TOKENS_O200K.length);
    expect(tokenizer.estimateTokensWithModel('a'.repeat(9_000), null)).toBeGreaterThan(0);
  });

  it('Argon2id v0x13: the pure-JS web implementation gives the native golden bytes', async () => {
    const encoder = new TextEncoder();
    for (const [memoryKiB, iterations, parallelism, length, expected] of ARGON2_VECTORS) {
      const key = await webArgon2.deriveKey(encoder.encode(ARGON2_PASSWORD), encoder.encode(ARGON2_SALT), memoryKiB, iterations, parallelism, length);
      expect(hex(key)).toBe(expected);
    }
  });
});
