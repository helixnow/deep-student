/**
 * Read-only SQL over the app's databases with the system `sqlite3` CLI (better-sqlite3 in node_modules is
 * built for the Electron ABI). The database and its WAL are copied first, so a running app is never touched
 * and uncheckpointed writes are still visible.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export function activeSlotDir(dataDir: string): string {
  const state = JSON.parse(readFileSync(join(dataDir, 'slots', 'state.json'), 'utf8')) as { active: string };
  return join(dataDir, 'slots', state.active);
}

/**
 * Write to a database in place, e.g. to leave the state an interrupted run would have left. Only while the app
 * is closed: the app holds its databases open while it runs.
 */
export function execute(dbFile: string, sql: string): void {
  if (!existsSync(dbFile)) throw new Error(`database not found: ${dbFile}`);
  execFileSync('sqlite3', [dbFile, sql], { encoding: 'utf8' });
}

export function query<T = Record<string, unknown>>(dbFile: string, sql: string): T[] {
  if (!existsSync(dbFile)) throw new Error(`database not found: ${dbFile}`);
  const dir = mkdtempSync(join(dbFile, '..', '.smoke-query-'));
  try {
    const copy = join(dir, 'copy.db');
    copyFileSync(dbFile, copy);
    if (existsSync(`${dbFile}-wal`)) copyFileSync(`${dbFile}-wal`, `${copy}-wal`);
    const out = execFileSync('sqlite3', ['-json', copy, sql], { encoding: 'utf8' }).trim();
    return out === '' ? [] : (JSON.parse(out) as T[]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
