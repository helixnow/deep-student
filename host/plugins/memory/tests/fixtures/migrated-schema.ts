import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { MigrationReport } from '../../../../platform/storage/api.ts';
import { createStorageService } from '../../../../platform/storage/service.ts';

interface MemoryTestSchema {
  dir: string;
  report: Pick<MigrationReport, 'success' | 'error'>;
}

// Forks are replaced per test file. Share only a completed, closed, empty schema
// on disk; this Promise also deduplicates helper imports inside a single fork.
const schemaKey = Symbol.for('deep-student.memory.tests.migrated-schema');
const worker = process as typeof process & { [schemaKey]?: Promise<MemoryTestSchema> };

function cacheDirectory(): string {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  // This digest replaces repeated full migrations, and invalidates the seed when
  // their SQL, migrator, fixture publication or installed dependencies change.
  const digest = createHash('sha256').update(root);
  const add = (file: string): void => {
    digest.update(path.relative(root, file)).update('\0').update(fs.readFileSync(file));
  };
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'tests') walk(file);
      else if (entry.isFile() && /\.(ts|sql)$/u.test(entry.name)) add(file);
    }
  };
  walk(path.join(root, 'host/platform/storage'));
  walk(path.join(root, 'resources/app/migrations'));
  add(path.join(root, 'package-lock.json'));
  add(fileURLToPath(import.meta.url));
  return path.join(tmpdir(), 'memory-migrated-schemas', digest.digest('hex'));
}

async function prepareSchema(): Promise<MemoryTestSchema> {
  const cache = cacheDirectory();
  const ready = path.join(cache, 'ready.json');
  const owner = path.join(cache, 'builder.pid');
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  for (;;) {
    if (fs.existsSync(ready)) {
      const report: unknown = JSON.parse(fs.readFileSync(ready, 'utf8'));
      if (typeof report !== 'object' || report === null || !('success' in report)
        || report.success !== true || !('error' in report) || report.error !== null) {
        throw new Error(`Invalid memory schema migration report: ${ready}`);
      }
      return { dir: path.join(cache, 'data'), report: { success: report.success, error: report.error } };
    }
    let builder = false;
    try { fs.mkdirSync(cache); builder = true; }
    catch (error) {
      // EEXIST means another fork is publishing this exact immutable schema.
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
    if (builder) {
      try {
        fs.writeFileSync(owner, String(process.pid));
        const dir = path.join(cache, 'data');
        const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
        let report: MigrationReport;
        try { report = await storage.migrations.runAll(); }
        finally { storage.dispose(); }
        if (!report.success) throw new Error(report.error ?? 'Memory test schema migration failed');
        fs.writeFileSync(path.join(cache, 'ready.tmp'), JSON.stringify({ success: report.success, error: report.error }));
        // Publication happens only after WAL checkpoint and all seed handles close.
        fs.renameSync(path.join(cache, 'ready.tmp'), ready);
        return { dir, report: { success: report.success, error: report.error } };
      } catch (error) {
        fs.rmSync(cache, { recursive: true, force: true });
        throw error;
      }
    }
    if (fs.existsSync(owner)) {
      const pid = Number(fs.readFileSync(owner, 'utf8'));
      try { process.kill(pid, 0); }
      catch (error) { throw new Error(`Memory schema builder ${pid} exited before publication: ${cache}`, { cause: error }); }
    }
    // Let Vitest RPC and the publishing fork progress; never spin synchronously.
    await delay(20);
  }
}

export function prepareMemoryTestSchema(): Promise<MemoryTestSchema> {
  return worker[schemaKey] ??= prepareSchema();
}

export async function createMigratedMemoryStorage(prefix = 'memory-lane-') {
  const template = await prepareMemoryTestSchema();
  const dir = fs.mkdtempSync(path.join(tmpdir(), prefix));
  fs.cpSync(template.dir, dir, { recursive: true });
  const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  return { dir, storage, report: template.report };
}
