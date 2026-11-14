import type { NativeFsrs } from './api.ts';
import { createFsrs } from './core.ts';
import { removeRun, runWasm } from '../wasm/loader.ts';

/** Crate-level FSRS-6 engine; scheduling is owned by L15. */
export const fsrs: NativeFsrs = createFsrs(async (request, signal) => {
  const run = await runWasm(request, { signal });
  try {
    return run.response;
  } finally {
    await removeRun(run);
  }
});
