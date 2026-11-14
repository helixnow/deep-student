/** L21 SQL/synthetic backup seeds; none claim to be A-produced artifacts. */
// boundary-allow native-import: W21 在 Rust 迁移重放出的隔离 E2E 夹具库上写入外键违规行；不写业务或用户数据库。
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildDatabase, DATABASES, dbPath } from './fixtures.ts';
import { replaySlot, writeSlotState } from './slot-seeds.ts';
import { createSeedFifo } from './seed-files.ts';

export const BACKUP_SPECIAL_SEED_NAMES = ['l21-assets-root-symlink', 'l21-assets-nested-symlink',
  'l21-assets-nested-fifo', 'l21-live-vfs-not-sqlite', 'l21-backups-symlink-escape'] as const;
export const BACKUP_SEED_NAMES = ['l21-backups-path-is-file', 'l21-backups-empty-dir', 'l21-backups-size-overflow',
  'l21-assets-tree-v1', 'l21-assets-root-is-file', 'l21-backup-jobs-is-file-v1', 'l21-persisted-jobs-v1',
  'l21-live-integrity-issues', ...BACKUP_SPECIAL_SEED_NAMES] as const;
export type BackupSeedName = typeof BACKUP_SEED_NAMES[number];

/** `default_recovery_backup_dir` (backup_config.rs:649-657) and `BACKUP_JOBS_DIR` (backup_job_manager.rs:809). */
export const BACKUPS_DIR = 'recovery/backups';
export const JOBS_DIR = 'backup_jobs';
export const SIZE_OVERFLOW_BACKUP = '20260106_000000_size_overflow';
export const MISSING_ZIP = '/nonexistent/w21-l21/missing-backup.zip';
export const SYMLINK_BACKUP = '20260107_000000_symlink_out';
export const INVALID_VFS_BYTES = 'not a SQLite database: W21 live VFS fixture\n';

function write(file: string, bytes: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * The manifest carries each copy's sha256, so the copies must be byte-identical on every build (G3 seed fingerprint):
 * the replay's `__change_log.changed_at` clock is set to the backup's own time.
 */
function pinBackupClock(file: string): void {
  const db = new Database(file);
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__change_log'").get() !== undefined) {
      db.prepare('UPDATE __change_log SET changed_at = ?').run('2026-01-06 00:00:00');
    }
  } finally { db.close(); }
}

/** One manifest whose sizes overflow u64 when summed; the literal must survive as written (no JS number round trip). */
function writeSizeOverflowBackup(app: string, slotA: string): void {
  const dir = join(app, BACKUPS_DIR, SIZE_OVERFLOW_BACKUP);
  mkdirSync(dir, { recursive: true });
  for (const db of ['mistakes', 'chat_v2'] as const) {
    copyFileSync(dbPath(slotA, db), join(dir, `${db}.db`));
    pinBackupClock(join(dir, `${db}.db`));
  }
  write(join(dir, 'manifest.json'), `{
  "version": "3.0.0",
  "app_version": "0.9.2",
  "created_at": "2026-01-06T00:00:00+00:00",
  "platform": "linux",
  "schema_versions": {},
  "files": [
    {
      "path": "mistakes.db",
      "size": 18446744073709551615,
      "sha256": "${sha256(join(dir, 'mistakes.db'))}",
      "database_id": "mistakes"
    },
    {
      "path": "chat_v2.db",
      "size": 1,
      "sha256": "${sha256(join(dir, 'chat_v2.db'))}",
      "database_id": "chat_v2"
    }
  ],
  "is_incremental": false,
  "incremental_base": null,
  "backup_id": "${SIZE_OVERFLOW_BACKUP}"
}`);
}

const bytes = (size: number, fill: number) => Buffer.alloc(size, fill);

/** `serde_json::to_string_pretty(PersistedJob)` (backup_job_manager.rs:1059): f32 progress keeps its `.0`. */
const persisted = (job: object) => JSON.stringify(job, null, 2).replace(/^(\s*"progress": )(\d+)(,?)$/gm, '$1$2.0$3');
const EXPORT_PARAMS = { backup_type: 'full', include_assets: false, compression_level: 6, include_checksums: true };
const IMPORT_PARAMS = { include_assets: false, include_checksums: false };
const checkpoint = (processed: string[]) => ({ processed_items: processed, last_updated: '2026-01-05T08:01:00Z',
  current_index: processed.length, total_items: 5 });

function writePersistedJobs(app: string): void {
  const dir = join(app, JOBS_DIR);
  const job = (file: string, body: object) => write(join(dir, file), persisted(body));
  job('job-failed-ckpt-export.json', { job_id: 'job-failed-ckpt-export', kind: 'export', status: 'failed', phase: 'failed',
    progress: 40, created_at: '2026-01-05T08:00:00Z', started_at: '2026-01-05T08:00:01Z', params: EXPORT_PARAMS,
    checkpoint: checkpoint(['chat_v2', 'mistakes']), error_message: '导出中断' });
  job('job-failed-ckpt-import-nozip.json', { job_id: 'job-failed-ckpt-import-nozip', kind: 'import', status: 'failed',
    phase: 'failed', progress: 20, created_at: '2026-01-05T09:00:00Z', started_at: '2026-01-05T09:00:01Z', params: IMPORT_PARAMS,
    checkpoint: checkpoint(['manifest']), error_message: '导入中断' });
  job('job-failed-ckpt-import-missingzip.json', { job_id: 'job-failed-ckpt-import-missingzip', kind: 'import', status: 'failed',
    phase: 'failed', progress: 20, created_at: '2026-01-05T10:00:00Z', started_at: '2026-01-05T10:00:01Z',
    params: { include_assets: false, zip_path: MISSING_ZIP, include_checksums: false },
    checkpoint: checkpoint(['manifest']), error_message: '导入中断' });
  job('job-failed-nockpt.json', { job_id: 'job-failed-nockpt', kind: 'export', status: 'failed', phase: 'failed', progress: 0,
    created_at: '2026-01-05T11:00:00Z', started_at: '2026-01-05T11:00:01Z', params: EXPORT_PARAMS, error_message: '磁盘已满' });
  job('job-running.json', { job_id: 'job-running', kind: 'export', status: 'running', phase: 'compress', progress: 60,
    created_at: '2026-01-05T12:00:00Z', started_at: '2026-01-05T12:00:01Z', params: EXPORT_PARAMS, checkpoint: checkpoint(['chat_v2']) });
  job('job-completed.json', { job_id: 'job-completed', kind: 'export', status: 'completed', phase: 'completed', progress: 100,
    created_at: '2026-01-05T13:00:00Z', started_at: '2026-01-05T13:00:01Z', params: EXPORT_PARAMS });
  job('job-cancelled.json', { job_id: 'job-cancelled', kind: 'import', status: 'cancelled', phase: 'cancelled', progress: 10,
    created_at: '2026-01-05T14:00:00Z', started_at: '2026-01-05T14:00:01Z', params: IMPORT_PARAMS });
  // serde aliases (`jobId`, `createdAt`, `startedAt`) as an older writer may have left them.
  job('job-camel-completed.json', { jobId: 'job-camel-completed', kind: 'export', status: 'completed', phase: 'completed',
    progress: 100, createdAt: '2026-01-05T15:00:00Z', startedAt: '2026-01-05T15:00:01Z', params: EXPORT_PARAMS });
  // delete_persisted_job removes `<job_id>.json`, so this file outlives cleanup.
  job('job-file-name.json', { job_id: 'job-name-mismatch', kind: 'export', status: 'completed', phase: 'completed', progress: 100,
    created_at: '2026-01-05T16:00:00Z', params: EXPORT_PARAMS });
  write(join(dir, 'job-corrupt.json'), '{"job_id": "job-corrupt", ');
  write(join(dir, 'job-temp.json.tmp'), persisted({ job_id: 'job-temp', kind: 'export', status: 'failed', phase: 'failed',
    progress: 0, created_at: '2026-01-05T17:00:00Z', params: EXPORT_PARAMS, checkpoint: checkpoint([]) }));
  write(join(dir, 'notes.txt'), 'not a job\n');
}

/** `app` is the app data root both G3 sides open; every seed starts from a slotA that has been started once. */
export function writeBackupSeed(name: BackupSeedName, app: string): void {
  const slotA = join(app, 'slots/slotA');
  if (name === 'l21-live-integrity-issues') {
    // llm_usage misses its last refinery migration; mistakes.db has a chat message whose mistake does not exist.
    for (const db of DATABASES) buildDatabase(slotA, db, db === 'llm_usage', {});
    const conn = new Database(dbPath(slotA, 'mistakes'));
    try {
      conn.pragma('foreign_keys = OFF');
      conn.prepare(`INSERT INTO chat_messages (mistake_id, role, content, timestamp, stable_id)
        VALUES ('mst_w21_missing', 'user', '孤儿消息', '2026-01-05T08:00:00Z', 'stable_w21_orphan')`).run();
    } finally { conn.close(); }
  } else {
    replaySlot(slotA);
  }
  writeSlotState(app, { legacyMigrationComplete: true });
  switch (name) {
    case 'l21-backups-path-is-file': return write(join(app, BACKUPS_DIR), 'not a directory\n');
    case 'l21-backups-empty-dir': return void mkdirSync(join(app, BACKUPS_DIR), { recursive: true });
    case 'l21-backups-size-overflow': return writeSizeOverflowBackup(app, slotA);
    case 'l21-assets-tree-v1':
      write(join(slotA, 'images/a.png'), bytes(100, 0x61));
      write(join(slotA, 'images/sub/b.png'), bytes(200, 0x62));
      mkdirSync(join(slotA, 'images/empty'), { recursive: true });
      write(join(slotA, 'documents/c.pdf'), bytes(0, 0));
      write(join(slotA, 'documents/.env'), 'A=1\n\n');
      write(join(slotA, 'audio/d.mp3'), bytes(1, 0x64));
      return;
    case 'l21-assets-root-is-file':
      write(join(slotA, 'images'), 'not a directory\n');
      mkdirSync(join(slotA, 'documents'), { recursive: true });
      return;
    case 'l21-backup-jobs-is-file-v1': return write(join(app, JOBS_DIR), 'not a directory\n');
    case 'l21-persisted-jobs-v1': return writePersistedJobs(app);
    case 'l21-live-integrity-issues': return;
    case 'l21-assets-root-symlink':
      write(join(slotA, 'asset-target/sentinel.txt'), 'not scanned\n');
      return symlinkSync('asset-target', join(slotA, 'images'), 'dir');
    case 'l21-assets-nested-symlink':
      write(join(slotA, 'asset-target/sentinel.txt'), 'not scanned\n');
      mkdirSync(join(slotA, 'images'), { recursive: true });
      return symlinkSync('../asset-target', join(slotA, 'images/link'), 'dir');
    case 'l21-assets-nested-fifo':
      mkdirSync(join(slotA, 'images'), { recursive: true });
      return createSeedFifo(join(slotA, 'images/pipe'));
    case 'l21-live-vfs-not-sqlite': return write(dbPath(slotA, 'vfs'), INVALID_VFS_BYTES);
    case 'l21-backups-symlink-escape': {
      // Outside the backup root, but inside this disposable seed. Relative text survives A/B copies.
      const outside = join(app, 'recovery/outside-backup');
      write(join(outside, 'manifest.json'), JSON.stringify({ version: '3.0.0', app_version: '0.9.2',
        created_at: '2026-01-07T00:00:00+00:00', platform: 'linux', schema_versions: {}, files: [],
        is_incremental: false, incremental_base: null, backup_id: SYMLINK_BACKUP }, null, 2));
      mkdirSync(join(app, BACKUPS_DIR), { recursive: true });
      return symlinkSync('../outside-backup', join(app, BACKUPS_DIR, SYMLINK_BACKUP), 'dir');
    }
    default: throw new Error(`Unhandled backup seed: ${name satisfies never}`);
  }
}
