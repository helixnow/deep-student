/** l22-temp-sessions-w0: L22's pinned seed SQL applied to SQL-replayed (never app-run) slot DBs; not an A artifact. */
// boundary-allow native-import: X3 按 L22 种子规格原样执行其 SQL 到 Rust 迁移重放出的 mistakes.db；仅隔离 E2E 夹具，不写用户或业务库。
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDatabase, DATABASES, dbPath, ROOT } from './fixtures.ts';

/** Read-only consumption of the L22 corpus; the blob id pins its exact bytes. */
export const TEMP_SESSIONS_SEED_SQL = {
  path: 'host/plugins/integration/equivalence/pending-seed/l22-temp-sessions-w0.sql',
  commit: 'cf9e3e01528c0e9bf54bbb36b6f75ff842eecf20',
  blob: '3f666bc674993b724e8c4a82bfbb8e2cbb4d95a9',
} as const;

export function gitBlobId(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Worktree copy if present (after L22 reaches main), else the pinned commit; either must match the blob id. */
export function readTempSessionsSql(root: string = ROOT): { sql: string; from: 'worktree' | 'commit' } {
  const file = join(root, TEMP_SESSIONS_SEED_SQL.path);
  const from = existsSync(file) ? 'worktree' : 'commit';
  const bytes = from === 'worktree' ? readFileSync(file)
    : execFileSync('git', ['-C', root, 'show', `${TEMP_SESSIONS_SEED_SQL.commit}:${TEMP_SESSIONS_SEED_SQL.path}`],
      { maxBuffer: 16 * 1024 * 1024 });
  const blob = gitBlobId(bytes);
  if (blob !== TEMP_SESSIONS_SEED_SQL.blob) {
    throw new Error(`l22-temp-sessions-w0 SQL (${from}) blob ${blob} != pinned ${TEMP_SESSIONS_SEED_SQL.blob}`);
  }
  return { sql: bytes.toString('utf8'), from };
}

/** All five refinery DBs at the current migrations with no business rows, then the L22 SQL verbatim on mistakes.db. */
export function writeTempSessionsSeed(dataDir: string): void {
  const { sql } = readTempSessionsSql();
  const active = join(dataDir, 'slots', 'slotA');
  for (const db of DATABASES) buildDatabase(active, db, false, {});
  const conn = new Database(dbPath(active, 'mistakes'));
  try {
    conn.transaction(() => conn.exec(sql))();
    if (conn.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('l22-temp-sessions-w0: integrity invalid');
  } finally { conn.close(); }
}
