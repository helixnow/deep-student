import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { NativeSqliteBusy } from './api.ts';

interface Binding {
  arm(handler: ((priorInvocations: number) => boolean) | null): void;
  disarm(): void;
}

const ENTRY_POINT = 'sqlite3_f7busy_init';
/**
 * Test-only prebuilds (equivalence tests against rusqlite's busy_handler). Production code uses
 * `busy_timeout`; packaged apps exclude `prebuilds/` (electron/electron-builder.config.cjs).
 */
const PLATFORMS = new Set(['linux-x64', 'darwin-arm64']);

let loaded: { binding: Binding; file: string } | undefined;

function load(): { binding: Binding; file: string } {
  if (loaded) return loaded;
  const platform = `${process.platform}-${process.arch}`;
  if (!PLATFORMS.has(platform)) {
    throw new Error(`nativeSqliteBusy: no prebuilt f7-sqlite-busy binding for ${platform} (test-only module; production uses busy_timeout)`);
  }
  const file = fileURLToPath(new URL(`./prebuilds/f7-sqlite-busy.${platform}.node`, import.meta.url));
  loaded = { binding: createRequire(import.meta.url)(file) as Binding, file };
  return loaded;
}

export const sqliteBusy: NativeSqliteBusy = {
  setBusyHandler(db, handler) {
    if (handler !== null && typeof handler !== 'function') {
      throw new TypeError('Expected a function or null');
    }
    const { binding, file } = load();
    binding.arm(handler);
    try {
      db.loadExtension(file, ENTRY_POINT);
    } finally {
      binding.disarm();
    }
  },
};
