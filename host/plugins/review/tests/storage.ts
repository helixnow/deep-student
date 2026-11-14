import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createStorageService } from '../../../platform/storage/service.ts';

export function storageFixture() {
  const root = mkdtempSync(join(tmpdir(), 'review-tests-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  return { storage, db: storage.database('vfs'), dispose() { storage.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

// Replaying the full mistakes migration chain costs ~3s per database; under a
// loaded gate that blocks the Vitest worker long enough to time out its RPC.
// Migrate once per test file, then give each test its own copy of the file.
let mistakesTemplate: string | undefined;

function migratedMistakesTemplate(): string {
  if (mistakesTemplate !== undefined) return mistakesTemplate;
  const root = mkdtempSync(join(tmpdir(), 'review-mistakes-template-'));
  process.once('exit', () => rmSync(root, { recursive: true, force: true }));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const db = storage.database('mistakes');
  const migrationDir = 'resources/app/migrations/mistakes';
  for (const file of readdirSync(migrationDir).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(migrationDir, file), 'utf8'));
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const file = storage.pathOf('mistakes');
  storage.dispose();
  return mistakesTemplate = file;
}

export function mistakesFixture() {
  const template = migratedMistakesTemplate();
  const root = mkdtempSync(join(tmpdir(), 'review-mistakes-tests-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const target = storage.pathOf('mistakes');
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(template, target);
  const db = storage.database('mistakes');
  return {
    storage,
    db,
    dispose() {
      storage.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
