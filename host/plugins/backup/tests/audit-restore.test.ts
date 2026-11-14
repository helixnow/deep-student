/**
 * `restore_audit_db`（mod.rs:4098-4124）用 SQLite Backup API 经目标连接写入 audit.db，
 * 目标目录里残留的 `-wal` 会先被目标连接接管，不会叠到新库上。
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { afterEach, expect, it } from 'vitest';
import { Connection } from '../../../platform/storage/connection.ts';
import { PROFILES } from '../../../platform/storage/profiles.ts';
import { newManifest, persistentDomainRegistry, updateCoverage, type BackupManifest } from '../src/manifest.ts';
import { consumeCompleteDomains } from '../src/restore-plan.ts';
import { sha256 } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function auditBackup(marker: string): { backupDir: string; manifest: BackupManifest } {
  const backupDir = temp('w08-audit-restore-backup-');
  const path = join(backupDir, 'databases', 'audit.db');
  mkdirSync(dirname(path), { recursive: true });
  const conn = new Connection(path, { label: basename(path), profile: PROFILES.plain });
  try {
    conn.exec(`CREATE TABLE audit_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO audit_probe(value) VALUES ('${marker}')`);
  } finally { conn.close(); }
  const bytes = readFileSync(path);
  const manifest = newManifest('0.0.0-test');
  manifest.backup_id = 'audit-restore';
  for (const spec of persistentDomainRegistry()) updateCoverage(manifest, spec.id, 'absent', []);
  manifest.files.push({ path: 'databases/audit.db', size: bytes.length, sha256: sha256(bytes) });
  updateCoverage(manifest, 'audit', 'complete', ['databases/audit.db']);
  return { backupDir, manifest };
}

/** 模拟崩溃后残留的 audit.db + 未检查点的 `-wal`（帧里是另一份库的页）。 */
function leaveHotWal(destination: string): void {
  const scratch = join(temp('w08-audit-restore-scratch-'), 'audit.db');
  const conn = new Connection(scratch, { label: 'scratch-audit', profile: PROFILES.plain });
  try {
    conn.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE stale_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO stale_probe(value) VALUES ('stale-live');
      CREATE TABLE audit_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO audit_probe(value) VALUES ('stale-live')`);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(scratch, destination);
    copyFileSync(`${scratch}-wal`, `${destination}-wal`);
  } finally { conn.close(); }
}

function readAudit(path: string): { integrity: string; markers: string[] } {
  const conn = new Connection(path, { label: 'restored-audit', profile: PROFILES.plain, mustExist: true });
  try {
    return {
      integrity: conn.pluck<string>('PRAGMA integrity_check') ?? '',
      markers: conn.raw.prepare('SELECT value FROM audit_probe ORDER BY id').pluck().all() as string[],
    };
  } finally { conn.close(); }
}

it('restoring audit.db over a leftover un-checkpointed WAL yields exactly the backup content', async () => {
  const { backupDir, manifest } = auditBackup('backup-audit-marker');
  const appRoot = temp('w08-audit-restore-app-');
  const destination = join(appRoot, 'databases', 'audit.db');
  leaveHotWal(destination);
  expect(existsSync(`${destination}-wal`)).toBe(true);

  const reports = await consumeCompleteDomains({} as Context, manifest, backupDir, temp('w08-audit-restore-target-'), appRoot);
  expect(reports.find(report => report.domain_id === 'audit')?.state).toBe('restored');
  expect(readAudit(destination)).toEqual({ integrity: 'ok', markers: ['backup-audit-marker'] });
});

it('restoring audit.db into an empty application data root creates it', async () => {
  const { backupDir, manifest } = auditBackup('fresh-audit-marker');
  const appRoot = temp('w08-audit-restore-app-');
  const reports = await consumeCompleteDomains({} as Context, manifest, backupDir, temp('w08-audit-restore-target-'), appRoot);
  expect(reports.find(report => report.domain_id === 'audit')?.state).toBe('restored');
  expect(readAudit(join(appRoot, 'databases', 'audit.db'))).toEqual({ integrity: 'ok', markers: ['fresh-audit-marker'] });
});
