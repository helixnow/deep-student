/** FSRS on mobile / Web: the same service as `index.ts`, run through the in-memory F7 engine. */
import type { NativeFsrs } from './api.ts';
import { createFsrs } from './core.ts';
import type { MemoryWasmEngine } from '../wasm/engine.ts';

export function createWebFsrs(engine: MemoryWasmEngine): NativeFsrs {
  return createFsrs(async (request, signal) => (await engine.run(request, { signal })).response);
}
