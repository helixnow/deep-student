import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { TestHost } from '../../../kernel/testing.ts';
import { Connection } from '../../../platform/storage/connection.ts';
import { PROFILES } from '../../../platform/storage/profiles.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { createSecretsService } from '../../../platform/secrets/index.ts';
import { DataSpaceManager } from '../../../platform/storage/data-space.ts';
import type { CryptoPublication } from '../../../platform/secrets/api.ts';
import {
  assertNoUnconsumedCompleteDomains, domainRestorePlan, newManifest, persistentDomainRegistry,
  markFull, updateCoverage, type BackupManifest, type DomainRestorePlan,
} from '../src/manifest.ts';
import { consumeCompleteDomains, RESTORE_PENDING_TRUST_DIR_NAME } from '../src/restore-plan.ts';
import { restoreAssetsWithProgress, type AssetRestoreError } from '../src/assets.ts';
import { createBackupHost, hostBackupRoot, installSyncService, sha256, waitForJob, writeBackup } from './helpers.ts';

const tempDirs: string[] = [];
const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const DB_MARKER = 'dsr3-matrix-db-marker-7ccb';
const AUDIT_MARKER = 'dsr3-matrix-audit-marker-7ccb';
const WEBVIEW_PAYLOAD = '{"theme":"dark","probe":"dsr3-webview-7ccb"}';
const GRADING_PAYLOAD = '{"modes":["dsr3-grading-7ccb"]}';
const AGENT_FILE = 'dsr3_reviewer_agent_7ccb.md';
const AGENT_PAYLOAD = '# dsr3 executable agent 7ccb\nrun: echo pwn-if-materialized\n';
const NOTE_FILE = 'dsr3_readme_7ccb.md';
const NOTE_PAYLOAD = 'dsr3 ordinary workspace note 7ccb\n';
const SKILL_FILE = 'dsr3_isolated_skill_7ccb.skill.md';
const SKILL_PAYLOAD = '# dsr3 executable user skill 7ccb\nrun: echo pwn-if-trusted\n';
const MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const KEY_SEED_HEX = 'aa'.repeat(32);

function createMarkerDb(path: string, marker: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const conn = new Connection(path, { label: basename(path), profile: PROFILES.plain });
  try {
    conn.exec(`CREATE TABLE restore_matrix_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO restore_matrix_probe(value) VALUES ('${marker}')`);
  } finally { conn.close(); }
}
function readMarker(path: string): string | null {
  if (!existsSync(path)) return null;
  const conn = new Connection(path, { label: basename(path), profile: PROFILES.plain, mustExist: true });
  try {
    return conn.pluck<string>('SELECT value FROM restore_matrix_probe LIMIT 1') ?? null;
  } catch { return null; }
  finally { conn.close(); }
}

function addFile(manifest: BackupManifest, backupDir: string, archivePath: string, bytes: string | Uint8Array): void {
  const absolute = join(backupDir, archivePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, bytes);
  const data = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes);
  manifest.files.push({ path: archivePath, size: data.length, sha256: sha256(data) });
}
function addAsset(manifest: BackupManifest, backupDir: string, archivePath: string, originalPath: string, bytes: string): void {
  const absolute = join(backupDir, archivePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, bytes);
  const data = Buffer.from(bytes);
  manifest.assets ??= {
    files: [], total_files: 0, total_size: 0, skipped_files: 0, skip_reasons: {},
    incomplete_asset_types: [], by_asset_type: {}, started_at: '', completed_at: '',
  };
  manifest.assets.files.push({
    asset_type: 'workspaces',
    relative_path: archivePath,
    original_path: originalPath,
    size: data.length,
    checksum: sha256(data),
    is_directory: false,
  });
  manifest.assets.total_files += 1;
  manifest.assets.total_size += data.length;
}

interface MatrixEnv {
  backupDir: string;
  appRoot: string;
  manifest: BackupManifest;
}

function buildMatrix(): MatrixEnv {
  const backupDir = temp('dstu-matrix-backup-');
  const appRoot = temp('dstu-matrix-app-');
  const manifest = newManifest('0.0.0-test');
  manifest.backup_id = 'matrix-fixture';
  manifest.key_policy = 'included_local';
  for (const spec of persistentDomainRegistry()) updateCoverage(manifest, spec.id, 'absent', []);
  for (const [id, archive] of [
    ['vfs', 'vfs.db'], ['chat_v2', 'chat_v2.db'],
    ['mistakes', 'mistakes.db'], ['llm_usage', 'llm_usage.db'],
  ] as const) {
    addFile(manifest, backupDir, archive, id);
    updateCoverage(manifest, `database:${id}`, 'complete', [archive]);
  }
  addFile(manifest, backupDir, 'persistent/webview_settings.json', WEBVIEW_PAYLOAD);
  addFile(manifest, backupDir, 'persistent/custom_grading_modes.json', GRADING_PAYLOAD);
  addAsset(manifest, backupDir, `assets/workspaces/agents/${AGENT_FILE}`, `workspaces/agents/${AGENT_FILE}`, AGENT_PAYLOAD);
  addAsset(manifest, backupDir, `assets/workspaces/notes/${NOTE_FILE}`, `workspaces/notes/${NOTE_FILE}`, NOTE_PAYLOAD);
  addFile(manifest, backupDir, `persistent/user_skills/${SKILL_FILE}`, SKILL_PAYLOAD);
  const auditPath = join(backupDir, 'databases', 'audit.db');
  createMarkerDb(auditPath, AUDIT_MARKER);
  const auditBytes = readFileSync(auditPath);
  manifest.files.push({ path: 'databases/audit.db', size: auditBytes.length, sha256: sha256(auditBytes) });
  addFile(manifest, backupDir, 'crypto/.master_key', MASTER_KEY);
  addFile(manifest, backupDir, 'crypto/.secure/.key_seed', KEY_SEED_HEX);
  updateCoverage(manifest, 'webview-settings', 'complete', ['persistent/webview_settings.json']);
  updateCoverage(manifest, 'custom-grading-modes', 'complete', ['persistent/custom_grading_modes.json']);
  updateCoverage(manifest, 'agents', 'complete', [`assets/workspaces/agents/${AGENT_FILE}`]);
  updateCoverage(manifest, 'asset-root:workspaces', 'complete', [`assets/workspaces/notes/${NOTE_FILE}`]);
  updateCoverage(manifest, 'user-skills', 'complete', [`persistent/user_skills/${SKILL_FILE}`]);
  updateCoverage(manifest, 'audit', 'complete', ['databases/audit.db']);
  updateCoverage(manifest, 'crypto', 'complete', ['crypto/.master_key', 'crypto/.secure/.key_seed']);
  return { backupDir, appRoot, manifest };
}

function planOf(manifest: BackupManifest, id: string): DomainRestorePlan {
  const plan = domainRestorePlan(manifest, id);
  if (plan === null) throw new Error(`missing plan ${id}`);
  return plan;
}

function fakePublication(): CryptoPublication {
  return {
    recover: async () => 'Clean',
    journalPath: (root: string) => join(root, '.crypto_restore_journal.json'),
    rollbackDir: (root: string) => join(root, '.crypto_restore_rollback'),
    async writeJournal() {},
    async removeJournal() {},
  } as unknown as CryptoPublication;
}

describe('restore_domain_plan_tests.rs', () => {
  it('matrix_registry_locks_domain_terminal_contract', () => {
    const expected = [
      ['crypto', '.', 'application_data', 'explicit', false],
      ['audit', 'databases/audit.db', 'application_data', 'explicit', false],
      ['webview-settings', 'webview_settings.json', 'active_data_space', 'data', false],
      ['custom-grading-modes', 'custom_grading_modes.json', 'active_data_space', 'data', false],
      ['agents', 'workspaces/agents', 'active_data_space', 'untrusted_executable', true],
      ['user-skills', '~/.deep-student/skills', 'user_home', 'untrusted_executable', true],
    ] as const;
    const registry = persistentDomainRegistry();
    for (const [id, target, scope, trust, executable] of expected) {
      const spec = registry.find(candidate => candidate.id === id)!;
      expect(spec.restore_target, id).toBe(target);
      expect(spec.restore_scope, id).toBe(scope);
      expect(spec.restore_trust, id).toBe(trust);
      expect(spec.executable, id).toBe(executable);
      expect(spec.restore_trust === 'untrusted_executable', id).toBe(spec.executable);
    }
  });

  it('full_snapshot_marks_all_matrix_domains_complete', () => {
    const { manifest } = buildMatrix();
    for (const domain of ['crypto', 'audit', 'webview-settings', 'custom-grading-modes', 'agents', 'user-skills']) {
      const plan = planOf(manifest, domain);
      expect(plan.status, domain).toBe('complete');
      expect(plan.files.length, domain).toBeGreaterThan(0);
      expect(plan.files.every(file => file.sha256 !== null && file.sha256.length === 64), domain).toBe(true);
    }
  });

  it('audit_complete_domain_restores_via_manifest_plan_consumer', async () => {
    const { backupDir, appRoot, manifest } = buildMatrix();
    const auditPath = join(appRoot, 'databases', 'audit.db');
    rmSync(auditPath, { force: true });
    // Rust restore_domain_plan_tests.rs:382：目标必须不存在，不能靠残留marker让恢复测试假绿。
    expect(existsSync(auditPath)).toBe(false);
    const reports = await consumeCompleteDomains({} as Context, manifest, backupDir, temp('dstu-matrix-target-'), appRoot);
    const audit = reports.find(report => report.domain_id === 'audit')!;
    expect(audit.state).toBe('restored');
    expect(readMarker(auditPath)).toBe(AUDIT_MARKER);
  });

  it('candidate_restore_lands_data_trust_domains_in_restore_target', async () => {
    const { backupDir, appRoot, manifest } = buildMatrix();
    const candidate = temp('dstu-matrix-candidate-');
    for (const [id, relative] of [['vfs', 'databases/vfs.db'], ['chat_v2', 'chat_v2.db'], ['mistakes', 'mistakes.db'], ['llm_usage', 'llm_usage.db']] as const) {
      createMarkerDb(join(candidate, relative), DB_MARKER);
    }
    await restoreAssetsWithProgress(backupDir, candidate, manifest.assets!.files, () => true);
    const reports = await consumeCompleteDomains({} as Context, manifest, backupDir, candidate, appRoot);
    expect(reports.filter(report => report.state === 'failed'), JSON.stringify(reports)).toEqual([]);
    expect(readFileSync(join(candidate, 'webview_settings.json'), 'utf8')).toBe(WEBVIEW_PAYLOAD);
    expect(readFileSync(join(candidate, 'custom_grading_modes.json'), 'utf8')).toBe(GRADING_PAYLOAD);
    expect(readFileSync(join(candidate, 'workspaces', 'notes', NOTE_FILE), 'utf8')).toBe(NOTE_PAYLOAD);
    expect(readMarker(join(candidate, 'databases', 'vfs.db'))).toBe(DB_MARKER);
  });

  it('candidate_restore_isolates_executable_domains_pending_trust', async () => {
    const { backupDir, appRoot, manifest } = buildMatrix();
    const candidate = temp('dstu-matrix-isolate-');
    await restoreAssetsWithProgress(backupDir, candidate, manifest.assets!.files, () => true);
    const reports = await consumeCompleteDomains({} as Context, manifest, backupDir, candidate, appRoot);
    expect(reports.find(report => report.domain_id === 'agents')!.state).toBe('isolated_pending_trust');
    expect(reports.find(report => report.domain_id === 'user-skills')!.state).toBe('isolated_pending_trust');
    expect(existsSync(join(candidate, 'workspaces', 'agents', AGENT_FILE))).toBe(false);
    expect(existsSync(join(appRoot, '.deep-student', 'skills', SKILL_FILE))).toBe(false);
    expect(readFileSync(join(candidate, RESTORE_PENDING_TRUST_DIR_NAME, 'agents', `assets/workspaces/agents/${AGENT_FILE}`), 'utf8')).toBe(AGENT_PAYLOAD);
    expect(readFileSync(join(candidate, RESTORE_PENDING_TRUST_DIR_NAME, 'user-skills', `persistent/user_skills/${SKILL_FILE}`), 'utf8')).toBe(SKILL_PAYLOAD);
  });

  it('restore_assets_with_progress_never_materializes_agent_executables', async () => {
    const { backupDir, manifest } = buildMatrix();
    const target = temp('dstu-matrix-assets-');
    const assets = manifest.assets!.files.filter(asset => asset.original_path.startsWith('workspaces/'));
    expect(assets.some(asset => asset.original_path.startsWith('workspaces/agents/'))).toBe(true);
    const restored = await restoreAssetsWithProgress(backupDir, target, assets, () => true);
    expect(restored).toBe(1);
    expect(existsSync(join(target, 'workspaces', 'agents', AGENT_FILE))).toBe(false);
    expect(readFileSync(join(target, 'workspaces', 'notes', NOTE_FILE), 'utf8')).toBe(NOTE_PAYLOAD);
  });

  it('unconsumed_audit_domain_rejected_in_slot_restore', async () => {
    const { backupDir, appRoot, manifest } = buildMatrix();
    rmSync(join(appRoot, 'databases', 'audit.db'), { force: true });
    mkdirSync(join(appRoot, 'databases', 'audit.db'), { recursive: true });
    const reports = await consumeCompleteDomains({} as Context, manifest, backupDir, temp('dstu-matrix-audit-target-'), appRoot);
    const audit = reports.find(report => report.domain_id === 'audit')!;
    expect(audit.state).toBe('failed');
    let message = '';
    try {
      assertNoUnconsumedCompleteDomains(manifest, reports.filter(report => report.state !== 'failed').map(report => report.domain_id));
    } catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain('audit');
  });

  it('unconsumed_webview_settings_domain_rejected_in_candidate_restore', async () => {
    const { backupDir, appRoot, manifest } = buildMatrix();
    const candidate = temp('dstu-matrix-webview-');
    mkdirSync(join(candidate, 'webview_settings.json'), { recursive: true });
    const reports = await consumeCompleteDomains({} as Context, manifest, backupDir, candidate, appRoot);
    const webview = reports.find(report => report.domain_id === 'webview-settings')!;
    expect(webview.state).toBe('failed');
    expect(webview.code).toBe('E_RESTORE_DOMAIN_FAILED');
    expect(webview.detail).toContain('webview-settings');
  });

  it('crypto_complete_domain_restores_key_material_end_state', async () => {
    const backupDir = temp('dstu-matrix-crypto-backup-');
    const appRoot = temp('dstu-matrix-crypto-app-');
    const manifest = newManifest('0.0.0-test');
    manifest.backup_id = 'crypto-fixture';
    manifest.key_policy = 'included_local';
    for (const spec of persistentDomainRegistry()) updateCoverage(manifest, spec.id, 'absent', []);
    addFile(manifest, backupDir, 'crypto/.master_key', MASTER_KEY);
    addFile(manifest, backupDir, 'crypto/.secure/.key_seed', KEY_SEED_HEX);
    updateCoverage(manifest, 'crypto', 'complete', ['crypto/.master_key', 'crypto/.secure/.key_seed']);
    const { publishRestoreKeysAndCommitCutover } = await import('../src/restore-commands.ts');
    const publication = fakePublication();
    const dataSpace = new DataSpaceManager(appRoot, publication);
    dataSpace.ensureLayout();
    writeFileSync(join(dataSpace.slotDir('slotB'), 'candidate.db'), 'candidate');
    const restored = await publishRestoreKeysAndCommitCutover(
      { secrets: {
          publication,
          openStore: () => ({
            async getSecret() { return null; },
          }),
          async validateBackupSeedFile() {},
          async resealSeedFileForCurrentPlatform() { return false; },
        },
        app: { dataDir: appRoot }, logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) } as unknown as Context,
      manifest, backupDir, 'slotB', () => dataSpace.markRestoreCutoverPending('slotB', manifest.backup_id),
    );
    expect(restored).toBe(2);
    expect(readFileSync(join(appRoot, '.master_key'), 'utf8')).toBe(MASTER_KEY);
    expect(readFileSync(join(appRoot, '.secure', '.key_seed'), 'utf8')).toBe(KEY_SEED_HEX);
  });

  it('r7_cancelled_restore_before_cutover_leaves_no_lease_and_full_retry_succeeds', async ({ signal }) => {
    const { backupDir, manifest } = buildMatrix();
    let storage!: ReturnType<typeof createStorageService>;
    const { host } = await createBackupHost({ storageFactory: dataDir => {
      storage = createStorageService({ baseDir: dataDir, dataLocalDir: dataDir });
      return storage;
    } });
    hosts.push(host);
    host.ctx.effect(() => () => storage.dispose());
    const base = host.app.dataDir;
    const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
    const env = { HOME: join(base, 'home'), USERPROFILE: join(base, 'home'), LOCALAPPDATA: base,
      APPDATA: join(base, 'config'), XDG_DATA_HOME: base, XDG_CONFIG_HOME: join(base, 'config'), XDG_CACHE_HOME: join(base, 'cache') };
    const paths = createPaths({ dataDir: base, platform, env });
    const logger = host.ctx.logger('r7-real-restore');
    const secrets = createSecretsService({ os: paths.os, env, keystore: null, log: {
      target: 'r7-real-restore', error: logger.error.bind(logger), warn: logger.warn.bind(logger),
      info: logger.info.bind(logger), debug: logger.debug.bind(logger), trace: logger.debug.bind(logger),
    } });
    Object.assign(host.ctx.secrets, secrets);
    host.ctx.provide('paths', paths);
    const dataSpace = new DataSpaceManager(base, secrets.publication);
    dataSpace.ensureLayout();
    host.ctx.provide('dataSpace', dataSpace);
    await installSyncService(host);

    // 完整重试需真实SQLite备份，不能沿用矩阵其它消费者测试中的core占位字节或伪造版本历史。
    for (const id of ['vfs', 'chat_v2', 'mistakes', 'llm_usage'] as const) {
      const file = manifest.files.find(candidate => candidate.path === `${id}.db`)!;
      const path = join(backupDir, file.path);
      rmSync(path);
      createMarkerDb(path, DB_MARKER);
      const bytes = readFileSync(path);
      file.size = bytes.length;
      file.sha256 = sha256(bytes);
      file.database_id = id;
      updateCoverage(manifest, `database:${id}`, 'complete', [file.path]);
    }
    markFull(manifest);
    const files: Record<string, Uint8Array> = {};
    for (const file of manifest.files) files[file.path] = readFileSync(join(backupDir, file.path));
    for (const asset of manifest.assets!.files) files[asset.relative_path] = readFileSync(join(backupDir, asset.relative_path));
    writeBackup(hostBackupRoot(host), manifest, files);

    const candidate = dataSpace.slotDir('slotB');
    const notes = manifest.assets!.files.filter(asset => asset.original_path.startsWith('workspaces/notes/'));
    expect(notes.length).toBeGreaterThan(0);
    let error: AssetRestoreError | null = null;
    try { await restoreAssetsWithProgress(backupDir, candidate, notes, () => false); }
    catch (caught) { error = caught as AssetRestoreError; }
    expect(error?.cancelled).toBe(true);
    expect(dataSpace.restoreCutoverPending()).toBeNull();
    expect(dataSpace.activeSlot()).toBe('slotA');
    expect(existsSync(candidate) && readFileSync(join(candidate, 'workspaces', 'notes', NOTE_FILE), 'utf8') === NOTE_PAYLOAD).toBe(true);
    dataSpace.clearSlotForRestore('slotB');
    expect(readdirSync(candidate)).toEqual([]);
    // 与生产恢复入口相同：完整重试包含四库/迁移/资产/Data域，租约由实际切槽提交登记，不由测试冒充。
    const started = await host.invoke<{ job_id: string }>('data_governance_restore_backup', { backupId: manifest.backup_id });
    const job = await waitForJob(host, started.job_id, signal);
    expect(job.status, String(job.message ?? '')).toBe('completed');
    expect(job.result).toMatchObject({ success: true, requires_restart: true,
      stats: { database_count: 4, restored_assets: 1 } });
    expect(readMarker(join(candidate, 'chat_v2.db'))).toBe(DB_MARKER);
    expect(readFileSync(join(candidate, 'workspaces', 'notes', NOTE_FILE), 'utf8')).toBe(NOTE_PAYLOAD);
    expect(readFileSync(join(candidate, 'webview_settings.json'), 'utf8')).toBe(WEBVIEW_PAYLOAD);
    const lease = dataSpace.restoreCutoverPending()!;
    expect(lease.target_slot).toBe('slotB');
    expect(lease.backup_id).toBe(manifest.backup_id);
    expect(lease.activation_committed).toBe(false);
  });

  it('r7_failed_restore_before_cutover_is_retryable_after_clearing_slot', async () => {
    const { backupDir, manifest } = buildMatrix();
    const base = temp('dstu-r7-failed-');
    const dataSpace = new DataSpaceManager(base, fakePublication());
    dataSpace.ensureLayout();
    const candidate = dataSpace.slotDir('slotB');
    mkdirSync(join(candidate, 'webview_settings.json'), { recursive: true });
    const reports = await consumeCompleteDomains({} as Context, manifest, backupDir, candidate, base);
    expect(reports.find(report => report.domain_id === 'webview-settings')!.state).toBe('failed');
    expect(dataSpace.restoreCutoverPending()).toBeNull();
    expect(dataSpace.activeSlot()).toBe('slotA');
    dataSpace.clearSlotForRestore('slotB');
    expect(existsSync(join(candidate, 'webview_settings.json'))).toBe(false);
    const retried = await consumeCompleteDomains({} as Context, manifest, backupDir, candidate, base);
    expect(retried.find(report => report.domain_id === 'webview-settings')!.state).toBe('restored');
    expect(readFileSync(join(candidate, 'webview_settings.json'), 'utf8')).toBe(WEBVIEW_PAYLOAD);
  });

  it('r7_committed_cutover_allows_same_backup_retry_but_rejects_different_backup', () => {
    const base = temp('dstu-r7-retry-');
    const dataSpace = new DataSpaceManager(base, fakePublication());
    dataSpace.ensureLayout();
    writeFileSync(join(dataSpace.slotDir('slotB'), 'candidate.db'), 'restored-r7');
    dataSpace.markRestoreCutoverPending('slotB', 'backup-r7-first');
    expect(() => dataSpace.markRestoreCutoverPending('slotB', 'backup-r7-first')).not.toThrow();
    let message = '';
    try { dataSpace.markRestoreCutoverPending('slotB', 'backup-r7-second'); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain('backup-r7-first');
    const lease = dataSpace.restoreCutoverPending()!;
    expect(lease.backup_id).toBe('backup-r7-first');
    expect(lease.target_slot).toBe('slotB');
  });

  it('r7_committed_cutover_lease_is_forward_only_until_activation', () => {
    const base = temp('dstu-r7-forward-');
    const dataSpace = new DataSpaceManager(base, fakePublication());
    dataSpace.ensureLayout();
    const candidate = dataSpace.slotDir('slotB');
    writeFileSync(join(candidate, 'candidate.db'), 'restored-r7');
    dataSpace.markRestoreCutoverPending('slotB', 'backup-r7-committed');
    expect(() => dataSpace.completeRestoreCutover(candidate)).toThrow();
    expect(() => dataSpace.markRestoreActivationCommitted(candidate, 'backup-r7-committed')).toThrow();
    const lease = dataSpace.restoreCutoverPending()!;
    expect(lease.backup_id).toBe('backup-r7-committed');
    expect(lease.activation_committed).toBe(false);
    expect(dataSpace.activeSlot()).toBe('slotA');
  });
});
