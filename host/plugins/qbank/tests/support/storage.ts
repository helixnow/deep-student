/**
 * Real migrated VFS storage for qbank tests.
 *
 * `migrations.runAll()` costs ~12s per fresh database on the build hosts, and
 * qbank fixtures create one per test.  Migrate one template once per code
 * version, then copy it for each fixture; every fixture still runs the real
 * migration chain once in the template and the real `runAll()` check on its own
 * database.  No schema or production code is stubbed.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageService } from '../../../../platform/storage/service.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const DEFINITIONS = path.join(REPO_ROOT, 'host/platform/storage/migration/definitions');

function templateKey(): string {
  const names = fs.readdirSync(DEFINITIONS).sort();
  const hash = createHash('sha1').update(REPO_ROOT);
  for (const name of names) {
    const stat = fs.statSync(path.join(DEFINITIONS, name));
    hash.update(`${name}:${stat.size}:${stat.mtimeMs}\n`);
  }
  return hash.digest('hex').slice(0, 16);
}

let template: Promise<string> | null = null;

async function ensureTemplate(): Promise<string> {
  if (template !== null) return template;
  template = (async () => {
    const dir = path.join(os.tmpdir(), `qbank-vfs-template-${templateKey()}`);
    if (fs.existsSync(dir)) return dir;
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    fs.mkdirSync(tmp, { recursive: true });
    const storage = createStorageService({ baseDir: tmp, dataLocalDir: tmp });
    try {
      const migrated = await storage.migrations.runAll();
      if (!migrated.success) throw migrated.error;
    } finally {
      storage.dispose();
    }
    try {
      fs.renameSync(tmp, dir);
    } catch {
      // Another worker created the same template first; use its copy.
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    if (!fs.existsSync(dir)) throw new Error(`VFS test template was not created: ${dir}`);
    return dir;
  })();
  return template;
}

export interface MigratedStorage {
  storage: ReturnType<typeof createStorageService>;
  base: string;
}

/** Create an isolated storage directory from the pre-migrated template. */
export async function createMigratedStorage(prefix = 'qbank-storage-'): Promise<MigratedStorage> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(await ensureTemplate(), base, { recursive: true });
  const storage = createStorageService({ baseDir: base, dataLocalDir: base });
  const migrated = await storage.migrations.runAll();
  if (!migrated.success) throw migrated.error;
  return { storage, base };
}
