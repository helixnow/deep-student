/**
 * 备份创建与恢复消费路径上，随文件大小增长的读写、复制、哈希不得用同步 I/O 占住 Host 唯一的事件循环
 * （与 zip-streaming.test.ts 的 ZIP 热路径同一标准）：用户技能目录、待信任隔离的 agents 与 user-skills。
 */
import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { afterEach, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { Connection } from '../../../platform/storage/connection.ts';
import { PROFILES } from '../../../platform/storage/profiles.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import { createBackup } from '../src/backup-manager.ts';
import { newManifest, persistentDomainRegistry, updateCoverage, type BackupManifest } from '../src/manifest.ts';
import { consumeCompleteDomains, RESTORE_PENDING_TRUST_DIR_NAME } from '../src/restore-plan.ts';
import { createBackupHost, createDatabaseFile, hostBackupRoot, sha256 } from './helpers.ts';

const hosts: TestHost[] = [];
const storages: StorageServiceImpl[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const storage of storages.splice(0)) storage.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = fs.mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const LARGE = 4 * 1024 * 1024;
function largePayload(seed: number): Buffer {
  const bytes = Buffer.alloc(LARGE);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = ((i + seed) * 2654435761) >>> 24;
  return bytes;
}

/** 统计 `run` 期间经同步 fs 接口读写的字节数。 */
async function syncBytesDuring(run: () => Promise<unknown>): Promise<number> {
  type FsFn = (...args: unknown[]) => unknown;
  const cjs = createRequire(import.meta.url)('node:fs') as Record<string, FsFn>;
  const names = ['readFileSync', 'readSync', 'writeFileSync', 'writeSync', 'copyFileSync', 'cpSync'] as const;
  const originals = Object.fromEntries(names.map(name => [name, cjs[name]!])) as Record<(typeof names)[number], FsFn>;
  let bytes = 0;
  const sized = (value: unknown): number => (typeof value === 'number' ? value
    : typeof value === 'string' ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.byteLength : 0);
  const treeSize = (path: string): number => {
    const stat = fs.lstatSync(path);
    if (!stat.isDirectory()) return stat.size;
    return fs.readdirSync(path).reduce((sum, name) => sum + treeSize(join(path, name)), 0);
  };
  cjs.readFileSync = (...args) => { const out = originals.readFileSync(...args); bytes += sized(out); return out; };
  cjs.readSync = (...args) => { const out = originals.readSync(...args); bytes += sized(out); return out; };
  cjs.writeFileSync = (...args) => { bytes += sized(args[1]); return originals.writeFileSync(...args); };
  cjs.writeSync = (...args) => { const out = originals.writeSync(...args); bytes += sized(out); return out; };
  cjs.copyFileSync = (...args) => { bytes += fs.statSync(args[0] as string).size; return originals.copyFileSync(...args); };
  cjs.cpSync = (...args) => { bytes += treeSize(args[0] as string); return originals.cpSync(...args); };
  syncBuiltinESMExports();
  try { await run(); }
  finally {
    Object.assign(cjs, originals);
    syncBuiltinESMExports();
  }
  return bytes;
}

it('backup of a user skill directory with a 4 MiB file does < 256 KiB of synchronous I/O', async () => {
  const { host } = await createBackupHost({
    storageFactory: dataDir => {
      const storage = createStorageService({ baseDir: dataDir, dataLocalDir: dataDir });
      storages.push(storage);
      return storage;
    },
  });
  hosts.push(host);
  const appRoot = host.app.dataDir;
  const activeDir = join(appRoot, 'slots', 'slotA');
  createDatabaseFile(join(activeDir, 'databases', 'vfs.db'));
  createDatabaseFile(join(activeDir, 'mistakes.db'));
  createDatabaseFile(join(activeDir, 'llm_usage.db'));
  createDatabaseFile(join(activeDir, 'chat_v2.db'));
  const skillDir = join(activeDir, '.deep-student', 'skills', 'big-skill');
  fs.mkdirSync(join(skillDir, 'assets'), { recursive: true });
  fs.writeFileSync(join(skillDir, 'SKILL.md'), '# big skill');
  const payload = largePayload(1);
  fs.writeFileSync(join(skillDir, 'assets', 'model.bin'), payload);

  let manifest: BackupManifest | undefined;
  const bytes = await syncBytesDuring(async () => {
    manifest = await createBackup(
      { ctx: host.ctx, backupRoot: hostBackupRoot(host), activeDir, baseDir: appRoot },
      { includeAssets: false, backupIdSuffix: 'sync-io' },
    );
  });
  const entry = manifest!.files.find(file => file.path === 'persistent/user_skills/big-skill/assets/model.bin');
  expect(entry).toEqual({ path: 'persistent/user_skills/big-skill/assets/model.bin', size: LARGE, sha256: sha256(payload) });
  expect(bytes).toBeLessThan(256 * 1024);
});

function addArchiveFile(manifest: BackupManifest, backupDir: string, archivePath: string, bytes: Uint8Array): void {
  const absolute = join(backupDir, archivePath);
  fs.mkdirSync(dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, bytes);
  manifest.files.push({ path: archivePath, size: bytes.length, sha256: sha256(Buffer.from(bytes)) });
}

it('restore isolates 4 MiB agent and user-skill files pending trust with < 256 KiB of synchronous I/O', async () => {
  const backupDir = temp('w08-sync-io-restore-backup-');
  const candidate = temp('w08-sync-io-restore-candidate-');
  const appRoot = temp('w08-sync-io-restore-app-');
  const manifest = newManifest('0.0.0-test');
  manifest.backup_id = 'sync-io-restore';
  for (const spec of persistentDomainRegistry()) updateCoverage(manifest, spec.id, 'absent', []);
  const agent = largePayload(2);
  const skill = largePayload(3);
  const agentPath = 'assets/workspaces/agents/big-agent.bin';
  const skillPath = 'persistent/user_skills/big-skill/model.bin';
  addArchiveFile(manifest, backupDir, agentPath, agent);
  addArchiveFile(manifest, backupDir, skillPath, skill);
  addArchiveFile(manifest, backupDir, 'persistent/webview_settings.json', Buffer.from('{"theme":"dark"}'));
  updateCoverage(manifest, 'agents', 'complete', [agentPath]);
  updateCoverage(manifest, 'user-skills', 'complete', [skillPath]);
  updateCoverage(manifest, 'webview-settings', 'complete', ['persistent/webview_settings.json']);

  let reports: Awaited<ReturnType<typeof consumeCompleteDomains>> = [];
  const bytes = await syncBytesDuring(async () => {
    reports = await consumeCompleteDomains({} as Context, manifest, backupDir, candidate, appRoot);
  });
  expect(reports.filter(report => report.state === 'failed'), JSON.stringify(reports)).toEqual([]);
  expect(reports.find(report => report.domain_id === 'agents')!.state).toBe('isolated_pending_trust');
  expect(reports.find(report => report.domain_id === 'user-skills')!.state).toBe('isolated_pending_trust');
  expect(sha256(fs.readFileSync(join(candidate, RESTORE_PENDING_TRUST_DIR_NAME, 'agents', agentPath)))).toBe(sha256(agent));
  expect(sha256(fs.readFileSync(join(candidate, RESTORE_PENDING_TRUST_DIR_NAME, 'user-skills', skillPath)))).toBe(sha256(skill));
  expect(fs.readFileSync(join(candidate, 'webview_settings.json'), 'utf8')).toBe('{"theme":"dark"}');
  expect(bytes).toBeLessThan(256 * 1024);
});

it('restore still rejects a pending-trust file whose SHA-256 differs from the manifest', async () => {
  const backupDir = temp('w08-sync-io-restore-backup-');
  const candidate = temp('w08-sync-io-restore-candidate-');
  const manifest = newManifest('0.0.0-test');
  for (const spec of persistentDomainRegistry()) updateCoverage(manifest, spec.id, 'absent', []);
  const skillPath = 'persistent/user_skills/tampered/model.bin';
  addArchiveFile(manifest, backupDir, skillPath, largePayload(4));
  updateCoverage(manifest, 'user-skills', 'complete', [skillPath]);
  const tampered = largePayload(4);
  tampered[LARGE - 1] = tampered[LARGE - 1]! ^ 0xff;
  fs.writeFileSync(join(backupDir, skillPath), tampered);

  const reports = await consumeCompleteDomains({} as Context, manifest, backupDir, candidate, temp('w08-sync-io-app-'));
  const report = reports.find(entry => entry.domain_id === 'user-skills')!;
  expect(report.state).toBe('failed');
  expect(report.detail).toContain(`域 user-skills 文件恢复后 SHA-256 不匹配: ${skillPath}`);
});

it('restoring a 4 MiB audit.db does < 256 KiB of synchronous I/O', async () => {
  const backupDir = temp('w08-sync-io-audit-backup-');
  const appRoot = temp('w08-sync-io-audit-app-');
  const source = join(backupDir, 'databases', 'audit.db');
  fs.mkdirSync(dirname(source), { recursive: true });
  const conn = new Connection(source, { label: 'big-audit', profile: PROFILES.plain });
  try { conn.exec(`CREATE TABLE audit_blob (data BLOB NOT NULL); INSERT INTO audit_blob VALUES (zeroblob(${LARGE}))`); }
  finally { conn.close(); }
  const manifest = newManifest('0.0.0-test');
  for (const spec of persistentDomainRegistry()) updateCoverage(manifest, spec.id, 'absent', []);
  const stat = fs.statSync(source);
  manifest.files.push({ path: 'databases/audit.db', size: stat.size, sha256: sha256(fs.readFileSync(source)) });
  updateCoverage(manifest, 'audit', 'complete', ['databases/audit.db']);

  let state: string | undefined;
  const bytes = await syncBytesDuring(async () => {
    const reports = await consumeCompleteDomains({} as Context, manifest, backupDir, temp('w08-sync-io-audit-target-'), appRoot);
    state = reports.find(entry => entry.domain_id === 'audit')?.state;
  });
  expect(state).toBe('restored');
  expect(fs.statSync(join(appRoot, 'databases', 'audit.db')).size).toBe(stat.size);
  expect(bytes).toBeLessThan(256 * 1024);
});
