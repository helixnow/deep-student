/** 移动端与桌面共用 `storage/params.ts`、`writer-slot.ts`、`database-layout.ts`：不再有本地副本，库路径与桌面逐个一致。 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATABASE_NAMES } from '../../storage/api.ts';
import { databasePath as desktopDatabasePath } from '../../storage/locations.ts';
import { MobileStorageService } from '../service.ts';
import type { SqliteRuntime } from '../sqlite-wasm.ts';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';

const REPO = join(import.meta.dirname, '../../../..');
const MOBILE_DIR = join(REPO, 'host/platform/storage-mobile');
const SHARED = ['host/platform/storage/params.ts', 'host/platform/storage/writer-slot.ts', 'host/platform/storage/database-layout.ts'];

const runtime = new Proxy({} as SqliteRuntime, {
  get(_target, key) {
    throw new Error(`runtime.${String(key)} must not be touched`);
  },
});

function mobileSources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(MOBILE_DIR)) {
    if (name.endsWith('.ts')) out.set(name, readFileSync(join(MOBILE_DIR, name), 'utf8'));
  }
  return out;
}

describe('storage-mobile shared modules', () => {
  it('the shared desktop modules are portable', () => {
    expect(checkModulesClosure(REPO, SHARED)).toEqual([]);
  });

  it('storage-mobile imports them instead of keeping copies', () => {
    const sources = mobileSources();
    expect(sources.has('param-plan.ts')).toBe(false);
    expect(sources.get('connection.ts')).toContain("from '../storage/params.ts'");
    expect(sources.get('database.ts')).toContain("from '../storage/writer-slot.ts'");
    expect(sources.get('service.ts')).toContain("from '../storage/database-layout.ts'");
    for (const [name, source] of sources) {
      expect(source, name).not.toMatch(/\bclass WriterSlot\b|\bfunction (planParams|abortError|databaseLocation)\b|case 'sync_state'/);
    }
  });

  it('every registered database resolves to the same path as the desktop layout', () => {
    const storage = new MobileStorageService({ runtime, baseDir: '/deep-student' });
    for (const name of DATABASE_NAMES) {
      expect(storage.pathOf(name), name).toBe(desktopDatabasePath(storage.locations, name));
    }
    expect(storage.pathOf('sync_state').startsWith(`${storage.locations.dataLocalDir}/`)).toBe(true);
    expect(storage.pathOf('vfs')).toBe(`${storage.locations.activeDir}/databases/vfs.db`);
  });
});
