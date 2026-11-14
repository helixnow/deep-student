import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { Connection } from '../../../platform/storage/connection.ts';
import { PROFILES } from '../../../platform/storage/profiles.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import type { TestHost } from '../../../kernel/testing.ts';
import {
  backupAuditDb, backupCryptoKeys, createBackup, restoreSingleDatabaseToDir, verifyWithAssets,
  finalizeVfsIndexRestore, prepareVfsIndexRestore,
} from '../src/backup-manager.ts';
import { restoreCryptoKeys } from '../src/crypto-restore.ts';
import { checkManifestCompatibility, domainRestorePlan, newManifest, type BackupManifest } from '../src/manifest.ts';
import type {} from '../api.ts';
import {
  createBackupHost, createDatabaseFile, createRealStorage, hostBackupRoot, sha256, installVfsRestoreOwner,
} from './helpers.ts';
import { createSecretsService } from '../../../platform/secrets/index.ts';
import { resolveOsDirs } from '../../../platform/paths/index.ts';
import type { Logger } from '../../../platform/log/api.ts';

const hosts: TestHost[] = [];
const storages: StorageServiceImpl[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const storage of storages.splice(0)) storage.dispose();
});

interface Env {
  host: TestHost;
  appRoot: string;
  activeDir: string;
  backupRoot: string;
}

async function setupEnv(withChatSchema = false): Promise<Env> {
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
  createDatabaseFile(join(activeDir, 'databases', 'vfs.db'), 'CREATE TABLE probe(id INTEGER PRIMARY KEY, value TEXT)');
  createDatabaseFile(join(activeDir, 'mistakes.db'));
  createDatabaseFile(join(activeDir, 'llm_usage.db'));
  if (withChatSchema) {
    createDatabaseFile(join(activeDir, 'chat_v2.db'),
      `CREATE TABLE refinery_schema_history (version INTEGER PRIMARY KEY, name TEXT, applied_on TEXT, checksum TEXT);
       CREATE TABLE current_schema_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
       INSERT INTO current_schema_probe(value) VALUES ('before-backup');
       INSERT INTO refinery_schema_history(version, name, applied_on, checksum)
       VALUES (20260528, 'resources_type_check_rebuild', '2026-05-28T00:00:00Z', 'test')`);
  } else {
    createDatabaseFile(join(activeDir, 'chat_v2.db'));
  }
  return { host, appRoot, activeDir, backupRoot: hostBackupRoot(host) };
}

async function backup(env: Env): Promise<BackupManifest> {
  return createBackup(
    { ctx: env.host.ctx, backupRoot: env.backupRoot, activeDir: env.activeDir, baseDir: env.appRoot },
    { includeAssets: false, backupIdSuffix: 'test' },
  );
}

function backupSubdir(env: Env, manifest: BackupManifest): string {
  return join(env.backupRoot, manifest.backup_id);
}

function dbQuery(path: string, sql: string): unknown {
  const conn = new Connection(path, { label: 'probe', profile: PROFILES.plain, mustExist: true });
  try { return conn.pluck(sql); } finally { conn.close(); }
}

describe('backup/mod.rs', () => {
  it('backup_crypto_keys_excludes_codex_oauth_session', async () => {
    const env = await setupEnv();
    const secure = join(env.appRoot, '.secure');
    mkdirSync(secure, { recursive: true });
    writeFileSync(join(secure, '.key_seed'), 'seed');
    writeFileSync(join(secure, 'internal.oauth.openai_codex.session.enc'), 'device-local-refresh-token');
    writeFileSync(join(secure, 'regular.api_key.enc'), 'portable-secret');
    const output = join(env.appRoot, 'backup-output');
    mkdirSync(output, { recursive: true });
    const manifest = newManifest('0.0.0-test');
    // Rust mod.rs:6628：.key_seed + regular.api_key.enc，跳过 OAuth 会话。
    expect(backupCryptoKeys(env.host.ctx, output, manifest)).toBe(2);
    const cryptoDir = join(output, 'crypto', '.secure');
    expect(existsSync(join(cryptoDir, '.key_seed'))).toBe(true);
    expect(existsSync(join(cryptoDir, 'regular.api_key.enc'))).toBe(true);
    expect(existsSync(join(cryptoDir, 'internal.oauth.openai_codex.session.enc'))).toBe(false);
  });

  it('root_crypto_and_audit_are_found_when_manager_receives_active_slot', async () => {
    const env = await setupEnv();
    mkdirSync(join(env.appRoot, '.secure'), { recursive: true });
    writeFileSync(join(env.appRoot, '.secure', '.key_seed'), 'seed');
    createDatabaseFile(join(env.appRoot, 'databases', 'audit.db'), 'CREATE TABLE audit_probe (id INTEGER PRIMARY KEY)');
    const output = join(env.appRoot, 'backup-output');
    mkdirSync(output, { recursive: true });
    const manifest = newManifest('0.0.0-test');
    // Rust mod.rs:6659-6660。
    expect(backupCryptoKeys(env.host.ctx, output, manifest)).toBe(1);
    expect(await backupAuditDb(env.host.ctx, output, manifest)).toBe(true);
    expect(existsSync(join(output, 'crypto', '.secure', '.key_seed'))).toBe(true);
    expect(existsSync(join(output, 'databases', 'audit.db'))).toBe(true);
  });

  it('test_new_manager', async () => {
    const env = await setupEnv();
    expect(hostBackupRoot(env.host)).toBe(join(env.appRoot, 'recovery', 'backups'));
  });

  it('test_backup_and_restore_single_database', async () => {
    const env = await setupEnv();
    await installVfsRestoreOwner(env.host);
    const vfs = join(env.activeDir, 'databases', 'vfs.db');
    const conn = new Connection(vfs, { label: 'vfs', profile: PROFILES.plain });
    conn.exec("INSERT INTO probe(value) VALUES ('one'), ('two')");
    conn.close();
    const manifest = await backup(env);
    expect(manifest.files.some(file => file.path === 'vfs.db')).toBe(true);
    expect((await verifyWithAssets(env.host.ctx, env.backupRoot, manifest)).isValid).toBe(true);
    rmSync(vfs);
    const target = join(env.appRoot, 'restore-target');
    const lanceDir = join(target, 'databases', 'lance', 'vfs');
    const staleTable = join(lanceDir, 'stale_table.lance');
    mkdirSync(staleTable, { recursive: true });
    writeFileSync(join(staleTable, 'stale.bin'), 'stale');
    // Rust mod.rs:7093-7107；候选槽使用生产恢复相同的数据库→prepare→finalize顺序，
    // 不把只复制SQLite的单库helper冒充整个database-only恢复。
    await restoreSingleDatabaseToDir(env.host.ctx, 'vfs', backupSubdir(env, manifest), target);
    await prepareVfsIndexRestore(env.host.ctx, manifest, target, false);
    finalizeVfsIndexRestore(env.host.ctx, manifest, target, false);
    const restored = join(target, 'databases', 'vfs.db');
    expect(existsSync(restored)).toBe(true);
    expect(existsSync(lanceDir)).toBe(false);
    expect(dbQuery(restored, 'SELECT COUNT(*) FROM probe')).toBe(2);
  });

  it('test_current_chat_v2_schema_self_backup_and_restore', async () => {
    const env = await setupEnv(true);
    const manifest = await backup(env);
    expect(manifest.schema_versions.chat_v2).toBe(20260528);
    expect(() => checkManifestCompatibility(manifest)).not.toThrow();
    const chatPath = join(env.activeDir, 'chat_v2.db');
    const conn = new Connection(chatPath, { label: 'chat', profile: PROFILES.plain });
    conn.exec("UPDATE current_schema_probe SET value = 'after-backup' WHERE id = 1");
    conn.close();
    const target = join(env.appRoot, 'restore-target-chat');
    await restoreSingleDatabaseToDir(env.host.ctx, 'chat_v2', backupSubdir(env, manifest), target);
    expect(dbQuery(join(target, 'chat_v2.db'), 'SELECT value FROM current_schema_probe WHERE id = 1')).toBe('before-backup');
  });

  // B05：真实 L11 插件提供恢复重置，L21 只做完整组件分支编排。
  it('incomplete_vfs_lance_restore_removes_partial_files_and_resets_local_manifest', async () => {
    const env = await setupEnv();
    await installVfsRestoreOwner(env.host);
    const vfs = join(env.activeDir, 'databases', 'vfs.db');
    const conn = new Connection(vfs, { label: 'vfs', profile: PROFILES.plain });
    conn.exec(`CREATE TABLE resources (id TEXT PRIMARY KEY, index_state TEXT, index_hash TEXT,
      index_error TEXT, indexed_at INTEGER, index_retry_count INTEGER, index_next_retry_at INTEGER,
      index_generation INTEGER, mm_index_state TEXT, mm_index_error TEXT, mm_index_retry_count INTEGER,
      mm_index_next_retry_at INTEGER, mm_embedding_dim INTEGER, mm_indexing_mode TEXT,
      mm_indexed_at INTEGER, mm_index_generation INTEGER);
      CREATE TABLE vfs_index_units (id TEXT PRIMARY KEY, text_state TEXT, text_profile_id TEXT,
      text_generation INTEGER, mm_state TEXT, mm_profile_id TEXT, mm_generation INTEGER);
      CREATE TABLE vfs_index_segments (id TEXT PRIMARY KEY);
      CREATE TABLE __lance_orphan_queue (lance_row_id TEXT);
      CREATE TABLE vfs_embedding_dims (dimension INTEGER, modality TEXT, record_count INTEGER,
      active_generation INTEGER, ann_metric TEXT, ann_index_version INTEGER, active_profile_id TEXT);
      CREATE TABLE vfs_index_profiles (id TEXT PRIMARY KEY, state TEXT, active_generation INTEGER,
      ann_metric TEXT, ann_index_version INTEGER);
      INSERT INTO resources VALUES ('res_restore_index', 'indexed', 'old-hash', 'old-error', 10, 9, 99,
      7, NULL, 'old-mm-error', 8, 88, 64, 'old-mode', 11, 6);
      INSERT INTO vfs_index_units VALUES ('unit_restore_index', 'indexed', 'profile_text_old', 7,
      'disabled', 'profile_mm_old', 6);
      INSERT INTO vfs_index_segments VALUES ('segment_restore_index');
      INSERT INTO __lance_orphan_queue VALUES ('orphan_restore_index');
      INSERT INTO vfs_embedding_dims VALUES (128, 'text', 9, 4, 'cosine', 1, 'profile_text_old');
      INSERT INTO vfs_index_profiles VALUES ('profile_text_old', 'queryable', 4, 'cosine', 1);
      CREATE TABLE files (id TEXT, mm_index_state TEXT, mm_index_error TEXT, mm_indexed_pages_json TEXT);
      INSERT INTO files VALUES ('file_restore_index', 'indexed', 'old-file-error', '[{"page":1}]');
      CREATE TABLE exam_sheets (id TEXT, mm_index_state TEXT, mm_index_error TEXT, mm_indexed_pages_json TEXT,
        mm_embedding_dim INTEGER, mm_indexing_mode TEXT, mm_indexed_at INTEGER);
      INSERT INTO exam_sheets VALUES ('exam_restore_index', 'indexed', 'old-exam-error', '[{"page":1}]', 128, 'old-mode', 12)`);
    conn.close();
    const lanceDir = join(env.activeDir, 'databases', 'lance', 'vfs', 'partial_table.lance');
    mkdirSync(lanceDir, { recursive: true });
    writeFileSync(join(lanceDir, 'partial.bin'), 'partial');
    const manifest = newManifest('0.0.0-test');
    finalizeVfsIndexRestore(env.host.ctx, manifest, env.activeDir, true);
    expect(existsSync(join(env.activeDir, 'databases', 'lance', 'vfs'))).toBe(false);
    expect(dbQuery(vfs, "SELECT index_state FROM resources WHERE id = 'res_restore_index'")).toBe('pending');
    expect(dbQuery(vfs, 'SELECT COUNT(*) FROM vfs_index_segments')).toBe(0);
    expect(dbQuery(vfs, 'SELECT COUNT(*) FROM __lance_orphan_queue')).toBe(0);
    const restored = new Connection(vfs, { label: 'assert-restored-index', profile: PROFILES.plain });
    try {
      const resource = restored.get<Record<string, unknown>>('SELECT * FROM resources')!;
      expect(resource.index_hash).toBeNull();
      expect([resource.index_retry_count, resource.index_next_retry_at, resource.index_generation]).toEqual([0, 0, 0]);
      expect(resource.mm_index_state).toBeNull();
      expect(resource.mm_index_error).toBeNull();
      expect(resource.mm_embedding_dim).toBeNull();
      expect(resource.mm_indexing_mode).toBeNull();
      expect([resource.mm_index_retry_count, resource.mm_index_next_retry_at, resource.mm_index_generation]).toEqual([0, 0, 0]);
      expect(restored.get('SELECT text_state, text_profile_id, text_generation, mm_state, mm_profile_id, mm_generation FROM vfs_index_units')).toEqual({
        text_state: 'pending', text_profile_id: null, text_generation: 0,
        mm_state: 'disabled', mm_profile_id: null, mm_generation: 0,
      });
      expect(restored.get('SELECT record_count, active_generation, ann_metric, ann_index_version FROM vfs_embedding_dims')).toEqual({
        record_count: 0, active_generation: 0, ann_metric: 'exact', ann_index_version: 0,
      });
      expect(restored.get('SELECT state, active_generation, ann_metric, ann_index_version FROM vfs_index_profiles')).toEqual({
        state: 'active', active_generation: 0, ann_metric: 'exact', ann_index_version: 0,
      });
      expect(restored.get('SELECT mm_index_state, mm_index_error, mm_indexed_pages_json FROM files')).toEqual({
        mm_index_state: 'pending', mm_index_error: null, mm_indexed_pages_json: null,
      });
      expect(restored.get('SELECT mm_index_state, mm_index_error, mm_indexed_pages_json, mm_embedding_dim, mm_indexing_mode, mm_indexed_at FROM exam_sheets')).toEqual({
        mm_index_state: 'pending', mm_index_error: null, mm_indexed_pages_json: null,
        mm_embedding_dim: null, mm_indexing_mode: null, mm_indexed_at: null,
      });
    } finally { restored.close(); }
  });

  it('vfs_lance_restore_contract_handles_legacy_schema_and_preserves_complete_component', async () => {
    const env = await setupEnv();
    await installVfsRestoreOwner(env.host);
    const legacyDb = join(env.activeDir, 'databases', 'vfs.db');
    const conn = new Connection(legacyDb, { label: 'legacy', profile: PROFILES.plain });
    conn.exec("CREATE TABLE legacy_payload (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO legacy_payload(value) VALUES ('kept')");
    conn.close();
    const partial = join(env.activeDir, 'databases', 'lance', 'vfs', 'partial.lance');
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, 'partial.bin'), 'partial');
    finalizeVfsIndexRestore(env.host.ctx, newManifest('legacy'), env.activeDir, true);
    expect(existsSync(join(env.activeDir, 'databases', 'lance', 'vfs'))).toBe(false);
    expect(dbQuery(legacyDb, 'SELECT value FROM legacy_payload')).toBe('kept');

    const completeDir = join(env.appRoot, 'complete-slot');
    const complete = join(completeDir, 'databases', 'lance', 'vfs', 'table.lance');
    mkdirSync(complete, { recursive: true });
    writeFileSync(join(complete, 'data.bin'), 'complete');
    const manifest = newManifest('complete');
    manifest.included_components.push('rebuildable-root:databases/lance/vfs');
    finalizeVfsIndexRestore(env.host.ctx, manifest, completeDir, true);
    expect(existsSync(join(complete, 'data.bin'))).toBe(true);
  });

  it('crypto_tamper_fails_even_if_manifest_hash_is_rewritten', async () => {
    const silent: Logger = { target: 'test', error() {}, warn() {}, info() {}, debug() {}, trace() {} };
    const realSecrets = createSecretsService({
      os: resolveOsDirs(process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux', process.env),
      log: silent,
      keystore: null,
    });
    const { host } = await createBackupHost({
      secretsService: realSecrets,
      storageFactory: (dataDir, activeDir) => createRealStorage(activeDir, dataDir),
    });
    hosts.push(host);
    const appRoot = host.app.dataDir;
    const activeDir = join(appRoot, 'slots', 'slotA');
    createDatabaseFile(join(activeDir, 'databases', 'vfs.db'));
    createDatabaseFile(join(activeDir, 'mistakes.db'));
    createDatabaseFile(join(activeDir, 'llm_usage.db'));
    createDatabaseFile(join(activeDir, 'chat_v2.db'));
    const env: Env = { host, appRoot, activeDir, backupRoot: hostBackupRoot(host) };
    await realSecrets.openStore(appRoot).saveSecret('backup-integrity-sentinel', 'sentinel-value');
    const manifest = await backup(env);
    // Rust backup/mod.rs:7664-7670：先证明备份生成了加密密钥域及完整文件证据，再做 AEAD 篡改。
    const cryptoPlan = domainRestorePlan(manifest, 'crypto')!;
    expect(cryptoPlan).toMatchObject({ encrypted: true, restore_scope: 'application_data' });
    expect(cryptoPlan.files.every(file => file.sha256?.length === 64)).toBe(true);
    const relative = 'crypto/.secure/backup-integrity-sentinel.enc';
    const encrypted = join(backupSubdir(env, manifest), relative);
    const bytes = readFileSync(encrypted);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0x80;
    writeFileSync(encrypted, bytes);
    const file = manifest.files.find(candidate => candidate.path === relative)!;
    file.sha256 = sha256(bytes);
    const result = await verifyWithAssets(env.host.ctx, env.backupRoot, manifest);
    expect(result.isValid).toBe(false);
    expect(result.databaseErrors.join('\n')).toContain('无法实际解密');
  });

  it('corrupted_audit_database_fails_integrity_after_hash_rewrite', async () => {
    const env = await setupEnv();
    createDatabaseFile(join(env.appRoot, 'databases', 'audit.db'),
      "CREATE TABLE audit_probe (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO audit_probe(value) VALUES ('valid')");
    const manifest = await backup(env);
    // Rust mod.rs:7708-7712：先锁定实际生成的audit计划，再改写文件和hash测试SQLite完整性。
    const auditPlan = domainRestorePlan(manifest, 'audit')!;
    expect(auditPlan.files).toHaveLength(1);
    expect(auditPlan.file_count).toBe(1);
    expect(auditPlan.restore_scope).toBe('application_data');
    expect(auditPlan.files[0]!.path).toBe('databases/audit.db');
    expect(auditPlan.files[0]!.sha256).toHaveLength(64);
    const archived = join(backupSubdir(env, manifest), 'databases', 'audit.db');
    const size = readFileSync(archived).length;
    writeFileSync(archived, Buffer.alloc(size));
    const file = manifest.files.find(candidate => candidate.path === 'databases/audit.db')!;
    file.sha256 = sha256(readFileSync(archived));
    const result = await verifyWithAssets(env.host.ctx, env.backupRoot, manifest);
    expect(result.isValid).toBe(false);
    expect(result.databaseErrors.join('\n')).toContain('databases/audit.db');
  });

  it('test_restore_schema_version_matches_backup_metadata', async () => {
    const env = await setupEnv();
    const vfs = join(env.activeDir, 'databases', 'vfs.db');
    const conn = new Connection(vfs, { label: 'vfs', profile: PROFILES.plain });
    conn.exec(`CREATE TABLE refinery_schema_history (version INTEGER PRIMARY KEY, name TEXT, applied_on TEXT, checksum TEXT);
      CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO test_table(name) VALUES ('versioned_data');
      INSERT INTO refinery_schema_history VALUES (20260130, 'init', '2026-01-30T00:00:00Z', 'abc123');
      INSERT INTO refinery_schema_history VALUES (20260201, 'add_indexes', '2026-02-01T00:00:00Z', 'def456');
      INSERT INTO refinery_schema_history VALUES (20260207, 'add_sync_support', '2026-02-07T00:00:00Z', 'ghi789')`);
    conn.close();
    const manifest = await backup(env);
    expect(manifest.schema_versions.vfs).toBe(20260207);
    // Rust mod.rs:8104-8107：原数据库删除后，仍须从快照恢复数据与历史。
    rmSync(vfs);
    rmSync(`${vfs}-wal`, { force: true });
    rmSync(`${vfs}-shm`, { force: true });
    const target = join(env.appRoot, 'restore-target-version');
    await restoreSingleDatabaseToDir(env.host.ctx, 'vfs', backupSubdir(env, manifest), target);
    const restored = join(target, 'databases', 'vfs.db');
    expect(dbQuery(restored, 'SELECT MAX(version) FROM refinery_schema_history')).toBe(manifest.schema_versions.vfs);
    expect(dbQuery(restored, 'SELECT COUNT(*) FROM refinery_schema_history')).toBe(3);
    // Rust mod.rs:8144-8147：版本记录完整不代表用户数据已恢复。
    expect(dbQuery(restored, 'SELECT name FROM test_table')).toBe('versioned_data');
  });

  it('test_restore_rejects_corrupted_backup_db', async () => {
    const env = await setupEnv();
    const manifest = await backup(env);
    const backupDb = join(backupSubdir(env, manifest), 'vfs.db');
    const data = readFileSync(backupDb);
    for (let index = 100; index < Math.min(200, data.length); index++) data[index] = 0xff;
    writeFileSync(backupDb, data);
    const file = manifest.files.find(candidate => candidate.path === 'vfs.db')!;
    file.sha256 = sha256(data);
    file.size = data.length;
    const result = await verifyWithAssets(env.host.ctx, env.backupRoot, manifest);
    expect(result.isValid).toBe(false);
    expect(result.databaseErrors.join('\n')).toMatch(/integrity|not a database|完整性|验证失败|损坏/);
  });

  it('test_restore_reverts_data_to_backup_state', async () => {
    const env = await setupEnv();
    const vfs = join(env.activeDir, 'databases', 'vfs.db');
    const conn = new Connection(vfs, { label: 'vfs', profile: PROFILES.plain });
    conn.exec("INSERT INTO probe(value) VALUES ('original_row1'), ('original_row2')");
    conn.close();
    const manifest = await backup(env);
    const target = join(env.appRoot, 'restore-target-revert');
    const restored = join(target, 'databases', 'vfs.db');

    // Rust mod.rs:7759-7787：备份后删除、新增、更新，再确认修改确已发生。
    // Electron 恢复入口使用候选槽：先将已修改状态放入候选，避免复活停用的原地恢复命令。
    const changed = new Connection(vfs, { label: 'modified-vfs', profile: PROFILES.plain });
    try {
      changed.exec(`DELETE FROM probe WHERE value = 'original_row1';
        INSERT INTO probe(value) VALUES ('new_row3');
        UPDATE probe SET value = 'modified_row2' WHERE value = 'original_row2'`);
      mkdirSync(dirname(restored), { recursive: true });
      await changed.backupTo(restored);
    } finally { changed.close(); }
    expect(dbQuery(restored, 'SELECT COUNT(*) FROM probe')).toBe(2);
    expect(dbQuery(restored, "SELECT EXISTS(SELECT 1 FROM probe WHERE value = 'new_row3')")).toBe(1);

    await restoreSingleDatabaseToDir(env.host.ctx, 'vfs', backupSubdir(env, manifest), target);
    expect(dbQuery(restored, 'SELECT COUNT(*) FROM probe')).toBe(2);
    expect(dbQuery(restored, "SELECT COUNT(*) FROM probe WHERE value = 'original_row1'")).toBe(1);
    const check = new Connection(restored, { label: 'assert-reverted-vfs', profile: PROFILES.plain });
    try {
      // Rust mod.rs:7807-7810、7821、7834。
      expect(check.all<{ value: string }>('SELECT value FROM probe ORDER BY value').map(row => row.value))
        .toEqual(['original_row1', 'original_row2']);
      expect(check.pluck("SELECT EXISTS(SELECT 1 FROM probe WHERE value = 'new_row3')")).toBe(0);
      expect(check.pluck("SELECT EXISTS(SELECT 1 FROM probe WHERE value = 'original_row2')")).toBe(1);
    } finally { check.close(); }
  });

  it('test_restore_integrity_check_passes_on_restored_db', async () => {
    const env = await setupEnv();
    const vfs = join(env.activeDir, 'databases', 'vfs.db');
    const conn = new Connection(vfs, { label: 'vfs', profile: PROFILES.plain });
    conn.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tags (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), tag TEXT NOT NULL);
      CREATE INDEX idx_tags_item ON tags(item_id);
      CREATE INDEX idx_items_value ON items(value);
      INSERT INTO items VALUES (1, 'item_alpha'), (2, 'item_beta'), (3, 'item_gamma');
      INSERT INTO tags VALUES (1, 1, 'rust'), (2, 1, 'systems'), (3, 2, 'python'), (4, 3, 'sql')`);
    conn.close();
    const manifest = await backup(env);
    const target = join(env.appRoot, 'restore-target-integrity');
    await restoreSingleDatabaseToDir(env.host.ctx, 'vfs', backupSubdir(env, manifest), target);
    const restored = join(target, 'databases', 'vfs.db');
    expect(dbQuery(restored, 'PRAGMA integrity_check')).toBe('ok');
    expect(dbQuery(restored, "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")).toBe(2);
    expect(dbQuery(restored, 'SELECT COUNT(*) FROM items')).toBe(3);
    expect(dbQuery(restored, 'SELECT COUNT(*) FROM tags')).toBe(4);
    // Rust mod.rs:7934-7938：foreign_key_check 无违规行。
    const check = new Connection(restored, { label: 'assert-fk', profile: PROFILES.plain });
    try { expect(check.all('PRAGMA foreign_key_check')).toEqual([]); }
    finally { check.close(); }
  });
});


describe('backup/mod.rs crypto restore', () => {
  const silent: Logger = { target: 'test', error() {}, warn() {}, info() {}, debug() {}, trace() {} };

  async function setupCryptoEnv(): Promise<{ host: TestHost; appRoot: string; backupRoot: string; secrets: ReturnType<typeof createSecretsService> }> {
    const realSecrets = createSecretsService({
      os: resolveOsDirs(process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux', process.env),
      log: silent,
      keystore: null,
    });
    const { host } = await createBackupHost({
      secretsService: realSecrets,
      storageFactory: (dataDir, activeDir) => createRealStorage(activeDir, dataDir),
    });
    hosts.push(host);
    return { host, appRoot: host.app.dataDir, backupRoot: hostBackupRoot(host), secrets: realSecrets };
  }

  it('test_restore_crypto_keys_rejects_incompatible_dpapi_seed_before_overwrite', async () => {
    const { host, appRoot, backupRoot } = await setupCryptoEnv();
    const backupSubdir = join(backupRoot, 'foreign_dpapi_backup');
    const backupSecure = join(backupSubdir, 'crypto', '.secure');
    mkdirSync(backupSecure, { recursive: true });
    writeFileSync(join(backupSecure, '.key_seed'), 'DPAPI1:Zm9yZWlnbi1kcGFwaS1ibG9i');
    writeFileSync(join(backupSecure, 'credential.enc'), Buffer.alloc(28, 7));
    writeFileSync(join(backupSubdir, 'crypto', '.master_key'), 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');

    const targetSecure = join(appRoot, '.secure');
    mkdirSync(targetSecure, { recursive: true });
    writeFileSync(join(targetSecure, '.key_seed'), 'existing-seed');
    writeFileSync(join(appRoot, '.master_key'), 'existing-master');

    await expect(restoreCryptoKeys(host.ctx, backupSubdir)).rejects.toThrow('目标密钥保持不变');
    expect(readFileSync(join(targetSecure, '.key_seed'), 'utf8')).toBe('existing-seed');
    expect(readFileSync(join(appRoot, '.master_key'), 'utf8')).toBe('existing-master');
    expect(existsSync(join(backupRoot, '.pre_restore'))).toBe(false);
  });

  it('test_restore_crypto_keys_rejects_symlinked_secure_dir_before_overwrite', async () => {
    const { host, appRoot, backupRoot } = await setupCryptoEnv();
    const backupSubdir = join(backupRoot, 'symlinked_crypto_backup');
    mkdirSync(join(backupSubdir, 'crypto'), { recursive: true });
    writeFileSync(join(backupSubdir, 'crypto', '.master_key'), 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    const externalSecure = join(appRoot, 'external-secure');
    mkdirSync(externalSecure, { recursive: true });
    writeFileSync(join(externalSecure, '.key_seed'), 'aa'.repeat(32));
    symlinkSync(externalSecure, join(backupSubdir, 'crypto', '.secure'));

    const targetSecure = join(appRoot, '.secure');
    mkdirSync(targetSecure, { recursive: true });
    writeFileSync(join(targetSecure, '.key_seed'), 'existing-seed');
    writeFileSync(join(appRoot, '.master_key'), 'existing-master');

    await expect(restoreCryptoKeys(host.ctx, backupSubdir)).rejects.toThrow('目标密钥保持不变');
    expect(readFileSync(join(targetSecure, '.key_seed'), 'utf8')).toBe('existing-seed');
    expect(readFileSync(join(appRoot, '.master_key'), 'utf8')).toBe('existing-master');
    expect(existsSync(join(backupRoot, '.pre_restore'))).toBe(false);
  });

  it('test_restore_crypto_keys_rejects_encrypted_files_without_seed_before_overwrite', async () => {
    const { host, appRoot, backupRoot } = await setupCryptoEnv();
    const backupSubdir = join(backupRoot, 'missing_seed_backup');
    const backupSecure = join(backupSubdir, 'crypto', '.secure');
    mkdirSync(backupSecure, { recursive: true });
    writeFileSync(join(backupSecure, 'credential.enc'), Buffer.alloc(28, 3));

    const targetSecure = join(appRoot, '.secure');
    mkdirSync(targetSecure, { recursive: true });
    writeFileSync(join(targetSecure, '.key_seed'), 'existing-seed');
    writeFileSync(join(targetSecure, 'existing.enc'), 'existing-credential');

    await expect(restoreCryptoKeys(host.ctx, backupSubdir)).rejects.toThrow('缺少 .key_seed');
    expect(readFileSync(join(targetSecure, '.key_seed'), 'utf8')).toBe('existing-seed');
    expect(readFileSync(join(targetSecure, 'existing.enc'), 'utf8')).toBe('existing-credential');
    expect(existsSync(join(backupRoot, '.pre_restore'))).toBe(false);
  });

  it('test_restore_crypto_keys_replaces_secure_directory_without_mixing_old_credentials', async () => {
    const { host, appRoot, backupRoot } = await setupCryptoEnv();
    const backupSubdir = join(backupRoot, 'seed_only_backup');
    const backupSecure = join(backupSubdir, 'crypto', '.secure');
    mkdirSync(backupSecure, { recursive: true });
    const newSeed = 'aa'.repeat(32);
    writeFileSync(join(backupSecure, '.key_seed'), newSeed);

    const targetSecure = join(appRoot, '.secure');
    mkdirSync(targetSecure, { recursive: true });
    writeFileSync(join(targetSecure, '.key_seed'), 'old-seed');
    writeFileSync(join(targetSecure, 'old.enc'), 'old-credential');

    const restored = await restoreCryptoKeys(host.ctx, backupSubdir);
    expect(restored).toBe(1);
    expect(readFileSync(join(targetSecure, '.key_seed'), 'utf8')).toBe(newSeed);
    expect(existsSync(join(targetSecure, 'old.enc'))).toBe(false);
  });

  it('test_restore_crypto_keys_aborts_when_snapshot_cannot_be_created', async () => {
    const { host, appRoot, backupRoot } = await setupCryptoEnv();
    const backupSubdir = join(backupRoot, 'snapshot_failure_backup');
    const backupSecure = join(backupSubdir, 'crypto', '.secure');
    mkdirSync(backupSecure, { recursive: true });
    writeFileSync(join(backupSecure, '.key_seed'), 'aa'.repeat(32));

    const targetSecure = join(appRoot, '.secure');
    mkdirSync(targetSecure, { recursive: true });
    writeFileSync(join(targetSecure, '.key_seed'), 'existing-seed');
    writeFileSync(join(backupRoot, '.pre_restore'), 'not-a-directory');

    await expect(restoreCryptoKeys(host.ctx, backupSubdir)).rejects.toThrow('目标密钥保持不变');
    expect(readFileSync(join(targetSecure, '.key_seed'), 'utf8')).toBe('existing-seed');
  });
});

describe('backup/mod.rs list and cleanup', () => {
  it('test_list_and_cleanup_backups', async () => {
    const env = await setupEnv();
    for (let index = 0; index < 3; index += 1) {
      const manifest = await createBackup(
        { ctx: env.host.ctx, backupRoot: env.backupRoot, activeDir: env.activeDir, baseDir: env.appRoot },
        { includeAssets: true, backupIdSuffix: `cleanup-${index}` },
      );
      expect(manifest.snapshot_kind).toBe('full');
    }
    const backups = (await import('../src/backup-manager.ts')).listBackups(env.backupRoot);
    expect(backups.length).toBeGreaterThanOrEqual(2);
    const deleted = await env.host.ctx.backup.cleanupOldBackups(1);
    expect(deleted.length).toBeGreaterThanOrEqual(backups.length - 1);
    const remaining = (await import('../src/backup-manager.ts')).listBackups(env.backupRoot);
    expect(remaining.length).toBeLessThanOrEqual(1);
  });
});
