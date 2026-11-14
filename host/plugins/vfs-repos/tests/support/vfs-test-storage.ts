/**
 * Shared migrated-schema fixture for L11 repository tests.
 *
 * Running the full vfs migration suite in every `beforeEach` costs several
 * seconds per test and starves the Vitest worker RPC channel. Build one
 * migrated data directory, then copy it for each test. Every test still gets
 * its own isolated database file; only schema creation is shared.
 */
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorageService } from '../../../../platform/storage/service.ts';

let templatePromise: Promise<string> | undefined;

async function schemaTemplate(): Promise<string> {
  templatePromise ??= (async () => {
    const root = mkdtempSync(join(tmpdir(), 'l11-schema-'));
    const storage = createStorageService({ baseDir: root, dataLocalDir: root });
    try {
      const report = await storage.migrations.runAll();
      if (!report.success) throw new Error(`vfs schema migration failed: ${JSON.stringify(report)}`);
    } finally {
      storage.dispose();
    }
    return root;
  })();
  return templatePromise;
}

export async function createVfsTestStorage(prefix: string): Promise<{
  root: string;
  storage: ReturnType<typeof createStorageService>;
}> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cpSync(await schemaTemplate(), root, { recursive: true });
  return {
    root,
    storage: createStorageService({ baseDir: root, dataLocalDir: root }),
  };
}
