// boundary-allow native-import: L21 备份种子验收只读隔离临时目录里的夹具库；不写业务或用户数据库。
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, dbPath, sqlMigrations, tempDir } from './__fixtures__/fixtures.ts';
import { BACKUP_SEED_NAMES, BACKUP_SPECIAL_SEED_NAMES, MISSING_ZIP, SIZE_OVERFLOW_BACKUP } from './__fixtures__/backup-seeds.ts';
import { appDataRoot, copySeed, createSeed, resolveSeed, SEED_NAMES, type SeedDirectory } from './__fixtures__/scenario-seeds.ts';

const SLOT_DBS = ['browser.db', 'chat_v2.db', 'databases/vfs.db', 'llm_usage.db', 'mistakes.db'].map(f => `slots/slotA/${f}`);
const BASE = [...SLOT_DBS, 'slots/.legacy_migration_complete', 'slots/state.json'];

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function files(directory: string, prefix = ''): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? [`${path}/`, ...files(directory, path)] : [path];
  }).sort();
}
const digest = (directory: string) => Object.fromEntries(files(directory).filter(f => !f.endsWith('/'))
  .map(f => [f, sha256(readFileSync(join(directory, f)))]));
const extra = (app: string) => files(app).filter(f => !BASE.includes(f) && !['slots/', 'slots/slotA/', 'slots/slotA/databases/'].includes(f));

let root: string, catalog: string;
const seeds = new Map<string, SeedDirectory>();
const app = (name: string) => appDataRoot(seeds.get(name)!);
beforeAll(() => {
  root = tempDir();
  catalog = join(root, 'catalog');
  // Special-entry seeds have lstat/readlink-only assertions in g3-backup-special-seeds.test.ts.
  for (const name of BACKUP_SEED_NAMES.filter(n => !(BACKUP_SPECIAL_SEED_NAMES as readonly string[]).includes(n))) seeds.set(name, createSeed(name, catalog));
}, 240_000);
afterAll(() => { if (root) cleanup(root); });

describe('L21 backup seeds', () => {
  it('are registered, start from a once-started slotA, and copy byte-identically to A/B', () => {
    for (const [name, source] of seeds) {
      expect(SEED_NAMES).toContain(name);
      expect(resolveSeed(name, catalog)).toEqual(source);
      expect(readdirSync(source.dataLocalDir)).toEqual([]);
      for (const file of BASE) expect(files(app(name)), `${name} ${file}`).toContain(file);
      expect(readFileSync(join(app(name), 'slots/state.json'), 'utf8')).toBe('{\n  "active": "slotA",\n  "pending": null\n}');
      const copy = copySeed(name, catalog, join(root, 'copy', name));
      expect(digest(copy.directory)).toEqual(digest(source.directory));
    }
  });

  it('backup root and jobs dir variants', () => {
    expect(extra(app('l21-backups-path-is-file'))).toEqual(['recovery/', 'recovery/backups']);
    expect(statSync(join(app('l21-backups-path-is-file'), 'recovery/backups')).isFile()).toBe(true);
    expect(extra(app('l21-backups-empty-dir'))).toEqual(['recovery/', 'recovery/backups/']);
    expect(extra(app('l21-backup-jobs-is-file-v1'))).toEqual(['backup_jobs']);
    expect(statSync(join(app('l21-backup-jobs-is-file-v1'), 'backup_jobs')).isFile()).toBe(true);
  });

  it('size-overflow: one manifest whose u64 sizes overflow, literal kept, real SQLite files with matching sha256', () => {
    const dir = join(app('l21-backups-size-overflow'), 'recovery/backups', SIZE_OVERFLOW_BACKUP);
    expect(extra(app('l21-backups-size-overflow'))).toEqual(['recovery/', 'recovery/backups/', `recovery/backups/${SIZE_OVERFLOW_BACKUP}/`,
      ...['chat_v2.db', 'manifest.json', 'mistakes.db'].map(f => `recovery/backups/${SIZE_OVERFLOW_BACKUP}/${f}`)]);
    const raw = readFileSync(join(dir, 'manifest.json'), 'utf8');
    expect(raw).toContain('"size": 18446744073709551615,');
    const manifest = JSON.parse(raw.replace('18446744073709551615', '"18446744073709551615"'));
    expect(manifest).toMatchObject({ version: '3.0.0', backup_id: SIZE_OVERFLOW_BACKUP, is_incremental: false, incremental_base: null });
    expect(manifest.files.map((f: { path: string; size: unknown }) => [f.path, f.size])).toEqual([['mistakes.db', '18446744073709551615'], ['chat_v2.db', 1]]);
    for (const file of manifest.files) {
      const bytes = readFileSync(join(dir, file.path));
      expect(file.sha256).toBe(sha256(bytes));
      expect(bytes.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0');
    }
  });

  it('size-overflow: backup files, and so the manifest sha256 values, do not depend on the build clock', async () => {
    const backup = (appRoot: string) => join(appRoot, 'recovery/backups', SIZE_OVERFLOW_BACKUP);
    const db = new Database(join(backup(app('l21-backups-size-overflow')), 'mistakes.db'), { readonly: true });
    try { expect(db.prepare('SELECT DISTINCT changed_at FROM __change_log').pluck().all()).toEqual(['2026-01-06 00:00:00']); }
    finally { db.close(); }
    await new Promise(resolve => { setTimeout(resolve, 1_100); });
    const again = createSeed('l21-backups-size-overflow', join(root, 'catalog-again'));
    expect(digest(backup(appDataRoot(again)))).toEqual(digest(backup(app('l21-backups-size-overflow'))));
  });

  it('asset trees under the active slot', () => {
    const tree = app('l21-assets-tree-v1');
    expect(extra(tree)).toEqual(['slots/slotA/audio/', 'slots/slotA/audio/d.mp3', 'slots/slotA/documents/', 'slots/slotA/documents/.env',
      'slots/slotA/documents/c.pdf', 'slots/slotA/images/', 'slots/slotA/images/a.png', 'slots/slotA/images/empty/',
      'slots/slotA/images/sub/', 'slots/slotA/images/sub/b.png']);
    const size = (f: string) => statSync(join(tree, 'slots/slotA', f)).size;
    expect(['images/a.png', 'images/sub/b.png', 'documents/c.pdf', 'documents/.env', 'audio/d.mp3'].map(size)).toEqual([100, 200, 0, 5, 1]);
    const isFile = app('l21-assets-root-is-file');
    expect(extra(isFile)).toEqual(['slots/slotA/documents/', 'slots/slotA/images']);
    expect(statSync(join(isFile, 'slots/slotA/images')).isFile()).toBe(true);
  });

  it('persisted jobs: PersistedJob pretty JSON plus alias, name-mismatch, corrupt, .tmp and .txt entries', () => {
    const dir = join(app('l21-persisted-jobs-v1'), 'backup_jobs');
    expect(readdirSync(dir).sort()).toEqual(['job-camel-completed.json', 'job-cancelled.json', 'job-completed.json', 'job-corrupt.json',
      'job-failed-ckpt-export.json', 'job-failed-ckpt-import-missingzip.json', 'job-failed-ckpt-import-nozip.json',
      'job-failed-nockpt.json', 'job-file-name.json', 'job-running.json', 'job-temp.json.tmp', 'notes.txt']);
    const read = (f: string) => readFileSync(join(dir, f), 'utf8');
    expect(() => JSON.parse(read('job-corrupt.json'))).toThrow();
    const jobs = Object.fromEntries(readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'job-corrupt.json').map(f => [f, JSON.parse(read(f))]));
    for (const [file, job] of Object.entries(jobs)) {
      const id = job.job_id ?? job.jobId;
      if (file !== 'job-file-name.json') expect(`${id}.json`).toBe(file);
      expect(read(file)).toMatch(/"progress": \d+\.\d+,\n/);
      expect(['export', 'import']).toContain(job.kind);
    }
    expect(jobs['job-file-name.json'].job_id).toBe('job-name-mismatch');
    expect(Object.keys(jobs['job-camel-completed.json']).slice(0, 1)).toEqual(['jobId']);
    expect(jobs['job-camel-completed.json'].createdAt).toBe('2026-01-05T15:00:00Z');
    const resumable = Object.values(jobs).filter(j => j.status === 'failed' && j.checkpoint).map(j => j.job_id).sort();
    expect(resumable).toEqual(['job-failed-ckpt-export', 'job-failed-ckpt-import-missingzip', 'job-failed-ckpt-import-nozip']);
    expect(jobs['job-failed-ckpt-import-nozip.json'].params).not.toHaveProperty('zip_path');
    expect(jobs['job-failed-ckpt-import-missingzip.json'].params.zip_path).toBe(MISSING_ZIP);
    expect(jobs['job-failed-nockpt.json']).not.toHaveProperty('checkpoint');
  });

  it('live integrity issues: one foreign-key orphan in mistakes.db and llm_usage one refinery migration behind', () => {
    const slot = join(app('l21-live-integrity-issues'), 'slots/slotA');
    const mistakes = new Database(dbPath(slot, 'mistakes'), { readonly: true });
    try {
      expect(mistakes.prepare('PRAGMA foreign_key_check').all()).toEqual([{ table: 'chat_messages', rowid: expect.any(Number), parent: 'mistakes', fkid: 0 }]);
      expect(mistakes.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally { mistakes.close(); }
    const usage = new Database(dbPath(slot, 'llm_usage'), { readonly: true });
    try {
      const applied = (usage.prepare('SELECT version FROM refinery_schema_history ORDER BY version').all() as { version: number }[]).map(r => r.version);
      expect(applied).toEqual(sqlMigrations('llm_usage').slice(0, -1).map(m => m.version));
    } finally { usage.close(); }
    expect(extra(app('l21-live-integrity-issues'))).toEqual([]);
  });
});
