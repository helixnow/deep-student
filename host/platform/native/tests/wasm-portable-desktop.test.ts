/**
 * Desktop half of the portable WASM check: the `node:wasi` worker loader, CJS
 * `tiktoken` and `@node-rs/argon2` give the same goldens as the web path in
 * `wasm-portable.test.ts`, and the in-memory engine matches the worker on Node too.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';
import { argon2 } from '../argon2/index.ts';
import { DEFAULT_PARAMETERS } from '../fsrs/api.ts';
import { fsrs } from '../fsrs/index.ts';
import { createWebFsrs } from '../fsrs/web.ts';
import { tokenizer } from '../tokenizer/index.ts';
import * as core from '../wasm/core.ts';
import { createMemoryWasmEngine } from '../wasm/engine.ts';
import * as loader from '../wasm/loader.ts';
import { argon2Missing, tiktokenMissing } from './pending-dependency.ts';
import {
  ARGON2_PASSWORD, ARGON2_SALT, ARGON2_VECTORS, fsrsCards, fsrsEvaluationMatches, TOKEN_TEXT, TOKENS_CL100K, TOKENS_O200K,
} from './wasm-portable-fixtures.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

describe('portable WASM path: desktop adapters', () => {
  it('desktop adapters stay on node:wasi / worker_threads / native bindings (scanner sanity check)', () => {
    const keys = (file: string) => checkModulesClosure(ROOT, [file]).map(violation => violation.key);
    // WASI runs only inside the spawned worker (sync calls included), so the loader itself never imports node:wasi.
    expect(keys('host/platform/native/wasm/loader.ts')).toContain('node-builtin:worker_threads');
    expect(keys('host/platform/native/wasm/worker.mjs')).toEqual(expect.arrayContaining(['node-builtin:wasi', 'node-builtin:worker_threads']));
    expect(keys('host/platform/native/tokenizer/index.ts')).toContain('node-builtin:module');
    expect(keys('host/platform/native/argon2/index.ts')).toContain('node-builtin:module');
  });

  it('loader re-exports the shared cancellation error and log sink', () => {
    expect(loader.WasmCancelledError).toBe(core.WasmCancelledError);
    expect(loader.setWasmLogSink).toBe(core.setWasmLogSink);
  });

  it('FSRS evaluate: node:wasi worker and in-memory WASI both give the golden', async () => {
    const worker = await fsrs.evaluate(DEFAULT_PARAMETERS, fsrsCards());
    expect(fsrsEvaluationMatches(worker), JSON.stringify(worker)).toBe(true);
    const bytes = await readFile(new URL('../wasm/f7-native-wasm.wasm', import.meta.url));
    const memory = createWebFsrs(createMemoryWasmEngine(core.cachedModule(() => core.compileWasm(bytes))));
    const inMemory = await memory.evaluate(DEFAULT_PARAMETERS, fsrsCards());
    expect(fsrsEvaluationMatches(inMemory), JSON.stringify(inMemory)).toBe(true);
  });

  it.skipIf(tiktokenMissing)('tokenizer: CJS tiktoken gives the golden token ids', () => {
    expect(tokenizer.encode(TOKEN_TEXT)).toEqual(TOKENS_CL100K);
    expect(tokenizer.encode(TOKEN_TEXT, 'gpt-4o')).toEqual(TOKENS_O200K);
  });

  it.skipIf(argon2Missing)('Argon2id: @node-rs/argon2 gives the golden bytes', async () => {
    const encoder = new TextEncoder();
    for (const [memoryKiB, iterations, parallelism, length, expected] of ARGON2_VECTORS) {
      const key = await argon2.deriveKey(encoder.encode(ARGON2_PASSWORD), encoder.encode(ARGON2_SALT), memoryKiB, iterations, parallelism, length);
      expect(Buffer.from(key).toString('hex')).toBe(expected);
    }
  });
});
