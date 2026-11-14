import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { TestHost } from '../../../kernel/testing.ts';
import { Connection } from '../../../platform/storage/connection.ts';
import { PROFILES } from '../../../platform/storage/profiles.ts';
import { DataSpaceManager } from '../../../platform/storage/data-space.ts';
import { StorageError, type DatabaseName } from '../../../platform/storage/api.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import type { CryptoPublication, CryptoPublicationJournal } from '../../../platform/secrets/api.ts';
import type { BackupJobResultPayload } from '../api.ts';
import {
  checkManifestCompatibility, markFull, newManifest, persistentDomainRegistry,
  saveManifest, sha256File, updateCoverage, type BackupManifest,
} from '../src/manifest.ts';
import {
  persistRestoreActivationMarker, publishRestoreKeysAndCommitCutover,
  restoreActivationMarkerPath, finalizeRestoreActivation,
} from '../src/restore-commands.ts';
import {
  createBackupHost, hostBackupRoot, installSyncService, waitForJob, writeBackup, sha256,
} from './helpers.ts';

const hosts: TestHost[] = [];
const storages: StorageServiceImpl[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const storage of storages.splice(0)) storage.dispose();
});

function createPublication(): CryptoPublication & { journals: string[] } {
  const journals: string[] = [];
  return {
    journals,
    journalPath: root => join(root, '.crypto_restore_journal.json'),
    rollbackDir: root => join(root, '.crypto_restore_rollback'),
    async writeJournal(root: string, journal: CryptoPublicationJournal) {
      const path = join(root, '.crypto_restore_journal.json');
      writeFileSync(path, JSON.stringify(journal));
      journals.push(path);
    },
    async removeJournal(root: string) {
      const path = join(root, '.crypto_restore_journal.json');
      if (existsSync(path)) rmSync(path, { force: true });
    },
    async recover() { return 'Clean'; },
  };
}

function createDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const conn = new Connection(path, { label: 'fixture', profile: PROFILES.plain });
  conn.exec('CREATE TABLE probe(id INTEGER PRIMARY KEY)');
  conn.close();
}

function realFullManifest(backupId: string, databaseDir: string): { manifest: BackupManifest; files: Record<string, Uint8Array> } {
  const manifest = newManifest('0.0.0-test');
  manifest.backup_id = backupId;
  manifest.created_at = '2026-01-01T00:00:00.000Z';
  manifest.key_policy = 'not_present';
  const files: Record<string, Uint8Array> = {};
  for (const id of ['vfs', 'llm_usage', 'chat_v2', 'mistakes'] as const) {
    const bytes = readFileSync(join(databaseDir, `${id}.db`));
    files[`${id}.db`] = bytes;
    manifest.files.push({
      path: `${id}.db`,
      size: bytes.length,
      sha256: sha256(bytes),
      database_id: id,
    });
  }
  for (const spec of persistentDomainRegistry()) {
    if (spec.id.startsWith('database:')) {
      const id = spec.id.slice('database:'.length);
      updateCoverage(manifest, spec.id, 'complete', [`${id}.db`]);
    } else {
      updateCoverage(manifest, spec.id, 'absent', []);
    }
  }
  markFull(manifest);
  return { manifest, files };
}

function cryptoManifest(backupSubdir: string): BackupManifest {
  const paths = ['crypto/.master_key', 'crypto/.secure/.key_seed'];
  const manifest = newManifest('0.0.0-test');
  manifest.backup_id = 'snapshot';
  manifest.key_policy = 'included_local';
  for (const path of paths) {
    const full = join(backupSubdir, path);
    manifest.files.push({
      path,
      size: readFileSync(full).length,
      sha256: sha256File(full, readFileSync(full).length),
    });
  }
  for (const spec of persistentDomainRegistry()) {
    if (spec.id === 'crypto') updateCoverage(manifest, spec.id, 'complete', paths);
    else updateCoverage(manifest, spec.id, 'absent', []);
  }
  return manifest;
}

function setupCryptoFixture(appData: string, backupRoot: string): { manifest: BackupManifest; backupSubdir: string } {
  const backupSubdir = join(backupRoot, 'snapshot');
  const secure = join(backupSubdir, 'crypto', '.secure');
  mkdirSync(secure, { recursive: true });
  writeFileSync(join(backupSubdir, 'crypto', '.master_key'), 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  writeFileSync(join(secure, '.key_seed'), 'aa'.repeat(32));
  const manifest = cryptoManifest(backupSubdir);
  saveManifest(join(backupSubdir, 'manifest.json'), manifest);
  return { manifest, backupSubdir };
}

function writeOldKeys(appData: string): void {
  writeFileSync(join(appData, '.master_key'), 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE=');
  mkdirSync(join(appData, '.secure'), { recursive: true });
  writeFileSync(join(appData, '.secure', '.key_seed'), 'old-seed');
  writeFileSync(join(appData, '.secure', 'old.enc'), 'old-credential');
}

function makeDataSpace(appData: string, publication: CryptoPublication): DataSpaceManager {
  const manager = new DataSpaceManager(appData, publication);
  mkdirSync(manager.slotDir('slotA'), { recursive: true });
  mkdirSync(manager.slotDir('slotB'), { recursive: true });
  writeFileSync(join(manager.slotDir('slotA'), 'active.db'), 'old-slot');
  writeFileSync(join(manager.slotDir('slotB'), 'candidate.db'), 'new-slot');
  return manager;
}

describe('commands_restore.rs', () => {
  it('post_key_publication_failure_restores_old_global_keys_and_active_slot', async () => {
    for (const oldKeysExist of [true, false]) {
      const created = await createBackupHost({ secrets: true });
      hosts.push(created.host);
      const appData = created.host.app.dataDir;
      if (oldKeysExist) writeOldKeys(appData);
      const publication = createPublication();
      (created.host.ctx.secrets as unknown as { publication: CryptoPublication }).publication = publication;
      const dataSpace = makeDataSpace(appData, publication);
      created.host.ctx.provide('dataSpace', dataSpace);
      const backupRoot = join(appData, 'fixture-backups');
      const { manifest, backupSubdir } = setupCryptoFixture(appData, backupRoot);

      let failureInjected = false;
      const error = await publishRestoreKeysAndCommitCutover(
        created.host.ctx,
        manifest,
        backupSubdir,
        'slotB',
        () => {
          failureInjected = true;
          expect(readFileSync(join(appData, '.master_key'))).toEqual(Buffer.from('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='));
          expect(readFileSync(join(appData, '.secure', '.key_seed'), 'utf8')).toBe('aa'.repeat(32));
          expect(dataSpace.activeSlot()).toBe('slotA');
          expect(existsSync(publication.journalPath(appData))).toBe(true);
          throw new Error('injected post-key-publication failure');
        },
      ).then(() => null, (caught: unknown) => caught as Error);

      expect(failureInjected).toBe(true);
      expect(error!.message).toContain('已恢复旧密钥');
      expect(dataSpace.activeSlot()).toBe('slotA');
      expect(dataSpace.restoreCutoverPending()).toBeNull();
      expect(existsSync(publication.journalPath(appData))).toBe(false);
      expect(existsSync(publication.rollbackDir(appData))).toBe(false);
      if (oldKeysExist) {
        expect(readFileSync(join(appData, '.master_key'))).toEqual(Buffer.from('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE='));
        expect(readFileSync(join(appData, '.secure', '.key_seed'), 'utf8')).toBe('old-seed');
        expect(readFileSync(join(appData, '.secure', 'old.enc'), 'utf8')).toBe('old-credential');
      } else {
        expect(existsSync(join(appData, '.master_key'))).toBe(false);
        expect(existsSync(join(appData, '.secure'))).toBe(false);
      }
    }
  });

  it('pre_cutover_interruption_is_retryable_and_second_publish_commits_lease', async () => {
    const created = await createBackupHost({ secrets: true });
    hosts.push(created.host);
    const appData = created.host.app.dataDir;
    const publication = createPublication();
    (created.host.ctx.secrets as unknown as { publication: CryptoPublication }).publication = publication;
    const dataSpace = makeDataSpace(appData, publication);
    created.host.ctx.provide('dataSpace', dataSpace);
    const backupRoot = join(appData, 'fixture-backups');
    const { manifest, backupSubdir } = setupCryptoFixture(appData, backupRoot);

    const firstError = await publishRestoreKeysAndCommitCutover(
      created.host.ctx, manifest, backupSubdir, 'slotB',
      () => { throw new Error('simulated mid-restore interruption before cutover'); },
    ).then(() => null, (caught: unknown) => caught as Error);
    expect(firstError!.message).toContain('已恢复旧密钥');
    expect(dataSpace.restoreCutoverPending()).toBeNull();
    expect(dataSpace.activeSlot()).toBe('slotA');
    expect(existsSync(join(appData, '.master_key'))).toBe(false);
    expect(existsSync(join(appData, '.secure'))).toBe(false);
    expect(existsSync(publication.journalPath(appData))).toBe(false);
    expect(existsSync(publication.rollbackDir(appData))).toBe(false);

    const restored = await publishRestoreKeysAndCommitCutover(
      created.host.ctx, manifest, backupSubdir, 'slotB',
      () => dataSpace.markRestoreCutoverPending('slotB', manifest.backup_id),
    );
    expect(restored).toBe(2);
    expect(readFileSync(join(appData, '.master_key'))).toEqual(Buffer.from('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='));
    expect(readFileSync(join(appData, '.secure', '.key_seed'), 'utf8')).toBe('aa'.repeat(32));
    const lease = dataSpace.restoreCutoverPending();
    expect(lease).toMatchObject({ target_slot: 'slotB', backup_id: manifest.backup_id, activation_committed: false });
    expect(dataSpace.activeSlot()).toBe('slotA');
    expect(existsSync(publication.journalPath(appData))).toBe(false);
    expect(existsSync(publication.rollbackDir(appData))).toBe(false);
  });

  it('post_cutover_failure_audit_details_carry_cutover_committed_and_close_started_row', async () => {
    let storage!: StorageServiceImpl;
    const created = await createBackupHost({
      storageFactory: (dataDir) => {
        storage = createStorageService({ baseDir: dataDir, dataLocalDir: dataDir });
        return storage;
      },
    });
    hosts.push(created.host);
    storages.push(storage);
    const db = storage.database('audit');
    const { initAuditTable } = await import('../repository/audit.ts');
    initAuditTable(db);
    const backupId = 'backup_r7_cutover';
    const jobId = 'job-r7-resume-0540';
    const { newAuditLog, saveAuditLog, withAuditDetails, failAuditLog, queryAuditLogs } = await import('../repository/audit.ts');
    saveAuditLog(db, withAuditDetails(newAuditLog({ type: 'Restore', backup_path: backupId }, backupId), {
      job_id: jobId, restore_assets: true,
    }));
    const honestError = '域恢复计划执行失败: audit: 消费失败（切槽与加密密钥已原子提交、不可撤销：重启后将激活候选槽 slotB；本任务按失败终止，失败/未消费的域不会自动恢复，请依据审计日志中的 domains 终态处置）';
    saveAuditLog(db, withAuditDetails(failAuditLog(newAuditLog({ type: 'Restore', backup_path: backupId }, backupId), honestError), {
      job_id: jobId,
      cutover_committed: true,
      activates_slot_on_restart: 'slotB',
      domains: [{ domain_id: 'audit', state: 'failed' }],
    }));
    const logs = queryAuditLogs(db, {});
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe('Failed');
    expect(logs[0]!.details).toMatchObject({ cutover_committed: true, activates_slot_on_restart: 'slotB' });
    // Rust commands_restore.rs:1786-1791：终态域详情必须存在且非 null。
    expect(logs[0]!.details).toHaveProperty('domains', [{ domain_id: 'audit', state: 'failed' }]);
    expect(logs[0]!.error_message).toBe(honestError);
    // Rust :1795-1803：落盘布尔值可由运维 SQL 的 json_extract 直接筛选。
    expect(db.pluck<number>(
      "SELECT COUNT(*) FROM __audit_log WHERE json_extract(details, '$.cutover_committed') = 1",
    )).toBe(1);
  });

  it('terminal_restore_job_can_never_flip_to_success', async () => {
    const created = await createBackupHost();
    hosts.push(created.host);
    const successPayload = (): BackupJobResultPayload => ({
      success: true, output_path: null, resolved_path: null, message: 'attempt to flip terminal job to success',
      error: null, duration_ms: 1, stats: null, requires_restart: true, checkpoint_path: null, resumable_job_id: null,
    });
    const job = created.host.ctx.backup.jobs.createJob('import');
    job.markRunning('cleanup', 95, '正在恢复辅助域（审计/设置/待信任隔离）...', 9, 10);
    job.fail('域恢复计划执行失败（切槽与加密密钥已原子提交、不可撤销：重启后将激活候选槽 slotB）');
    let snapshot = created.host.ctx.backup.jobs.getJob(job.job_id)!;
    expect(snapshot.status).toBe('failed');
    expect(snapshot.result?.success).toBe(false);
    job.complete('bogus success', 10, 10, successPayload());
    snapshot = created.host.ctx.backup.jobs.getJob(job.job_id)!;
    expect(snapshot.status).toBe('failed');
    expect(snapshot.result?.success).toBe(false);
    // Rust :1861-1867：拒绝 complete 后仍保留已切槽、不可撤销的失败原因。
    expect(snapshot.result?.error).toContain('不可撤销');

    const cancelled = created.host.ctx.backup.jobs.createJob('import');
    cancelled.markRunning('verify', 10, null, 0, 10);
    // Rust :1872-1873：通过公开取消命令设置同一任务的 token。
    expect(await created.host.invoke('data_governance_cancel_backup', { jobId: cancelled.job_id })).toBe(true);
    expect(cancelled.isCancelled()).toBe(true);
    cancelled.cancelled('用户取消恢复（验证阶段）');
    cancelled.complete(null, 10, 10, successPayload());
    const afterCancel = created.host.ctx.backup.jobs.getJob(cancelled.job_id)!;
    expect(afterCancel.status).toBe('cancelled');
    expect(afterCancel.result?.success).toBe(false);

    // Rust :1882：重试另建任务，不继承旧任务取消标志。
    const retry = created.host.ctx.backup.jobs.createJob('import');
    expect(retry.isCancelled()).toBe(false);
  });
});

describe('data_governance_restore_backup', () => {
  it('restores a full snapshot into the inactive slot and registers a restart cutover', async ({ signal }) => {
    const created = await createBackupHost({
      secrets: true,
      storageFactory: dataDir => {
        const storage = createStorageService({ baseDir: dataDir, dataLocalDir: dataDir });
        storages.push(storage);
        return storage;
      },
    });
    hosts.push(created.host);
    const appData = created.host.app.dataDir;
    const publication = createPublication();
    (created.host.ctx.secrets as unknown as { publication: CryptoPublication }).publication = publication;
    const dataSpace = makeDataSpace(appData, publication);
    created.host.ctx.provide('dataSpace', dataSpace);
    // D7：同步基线重建由 L20 `sync@1` 拥有。
    await installSyncService(created.host);

    const fixtureDir = join(appData, 'fixture-dbs');
    for (const id of ['vfs', 'llm_usage', 'chat_v2', 'mistakes'] as const) createDb(join(fixtureDir, `${id}.db`));
    const { manifest, files } = realFullManifest('full-restore', fixtureDir);
    writeBackup(hostBackupRoot(created.host), manifest, files);

    const started = await created.host.invoke('data_governance_restore_backup', {
      backupId: 'full-restore',
    }) as { job_id: string };
    const job = await waitForJob(created.host, started.job_id, signal);
    expect(job.status, String(job.message ?? job.error ?? '')).toBe('completed');
    const inactive = join(appData, 'slots', 'slotB');
    for (const id of ['vfs', 'llm_usage', 'chat_v2', 'mistakes'] as const) {
      const path = id === 'vfs' ? join(inactive, 'databases', 'vfs.db') : join(inactive, `${id}.db`);
      expect(existsSync(path), `${id} 未恢复到候选槽`).toBe(true);
    }
    expect(existsSync(restoreActivationMarkerPath(inactive))).toBe(true);
    expect(dataSpace.restoreCutoverPending()).toMatchObject({
      target_slot: 'slotB', backup_id: 'full-restore', activation_committed: false,
    });
    expect(job.result).toMatchObject({ requires_restart: true, success: true });
  }, 60_000);

  // Rust backup/mod.rs:8011：恢复写入失败返回可操作错误而非 panic。
  // 新切槽恢复没有旧 .pre_restore 目录，故把非活跃候选槽设为只读来触发同一条 IO/权限失败路径。
  it('test_restore_handles_write_failure_gracefully', async ({ signal }) => {
    const created = await createBackupHost({
      secrets: true,
      storageFactory: dataDir => {
        const storage = createStorageService({ baseDir: dataDir, dataLocalDir: dataDir });
        storages.push(storage);
        return storage;
      },
    });
    hosts.push(created.host);
    const appData = created.host.app.dataDir;
    const publication = createPublication();
    (created.host.ctx.secrets as unknown as { publication: CryptoPublication }).publication = publication;
    const dataSpace = new DataSpaceManager(appData, publication);
    mkdirSync(dataSpace.slotDir('slotA'), { recursive: true });
    mkdirSync(dataSpace.slotDir('slotB'), { recursive: true });
    // 保证活跃槽可推断为 slotA，候选 slotB 保持空目录以便只读权限不被重建覆盖。
    writeFileSync(join(dataSpace.slotDir('slotA'), 'active.db'), 'old-slot');
    created.host.ctx.provide('dataSpace', dataSpace);

    const fixtureDir = join(appData, 'fixture-dbs');
    for (const id of ['vfs', 'llm_usage', 'chat_v2', 'mistakes'] as const) createDb(join(fixtureDir, `${id}.db`));
    const { manifest, files } = realFullManifest('write-failure', fixtureDir);
    writeBackup(hostBackupRoot(created.host), manifest, files);

    const candidate = dataSpace.slotDir('slotB');
    chmodSync(candidate, 0o555);
    try {
      const started = await created.host.invoke('data_governance_restore_backup', {
        backupId: 'write-failure',
      }) as { job_id: string };
      const job = await waitForJob(created.host, started.job_id, signal);
      expect(job.status).toBe('failed');
      expect(String(job.error ?? job.message ?? '')).toMatch(/IO|Permission|denied|permission|read-only/);
    } finally {
      chmodSync(candidate, 0o755);
    }
  }, 60_000);

  // Rust commands_restore.rs:266-354,1198-1202：切槽维护屏障走真实 F3 维护态；
  // 主库已被其他所有者冻结时拒绝，其它组件失败带组件前缀且只回滚本次取得的组件。
  it.for([
    ['none', null, null],
    ['mistakes', 'mistakes', '应用已处于维护模式，拒绝启动恢复切槽以免解除现有安全屏障'],
    ['vfs', 'vfs', 'VFS 进入恢复维护模式失败: Database vfs is already in maintenance mode'],
  ] as const)('restore cutover maintenance with external owner %s', { timeout: 60_000 }, async ([_label, held, message], { signal }) => {
    let storage!: StorageServiceImpl;
    const created = await createBackupHost({
      secrets: true,
      storageFactory: (dataDir) => {
        storage = createStorageService({ baseDir: dataDir, dataLocalDir: dataDir });
        return storage;
      },
    });
    storages.push(storage);
    hosts.push(created.host);
    const appData = created.host.app.dataDir;
    const publication = createPublication();
    (created.host.ctx.secrets as unknown as { publication: CryptoPublication }).publication = publication;
    const dataSpace = makeDataSpace(appData, publication);
    created.host.ctx.provide('dataSpace', dataSpace);
    await installSyncService(created.host);
    const fixtureDir = join(appData, 'fixture-dbs');
    for (const id of ['vfs', 'llm_usage', 'chat_v2', 'mistakes'] as const) createDb(join(fixtureDir, `${id}.db`));
    const { manifest, files } = realFullManifest('cutover-restore', fixtureDir);
    writeBackup(hostBackupRoot(created.host), manifest, files);
    const external = held === null ? null : await storage.enterMaintenance([held as DatabaseName]);

    const started = await created.host.invoke('data_governance_restore_backup', {
      backupId: 'cutover-restore',
    }) as { job_id: string };
    const job = await waitForJob(created.host, started.job_id, signal);
    const inactive = join(appData, 'slots', 'slotB');
    const blocked = (name: DatabaseName): boolean => {
      try { storage.database(name); return false; }
      catch (error) { return error instanceof StorageError && error.code === 'MAINTENANCE'; }
    };

    if (message === null) {
      expect(job.status, String(job.message ?? job.error ?? '')).toBe('completed');
      // 成功切槽后屏障保持到重启。
      for (const name of ['mistakes', 'vfs', 'chat_v2', 'llm_usage'] as const) expect(blocked(name), name).toBe(true);
      return;
    }
    expect(job.status).toBe('failed');
    expect(String(job.error ?? job.message ?? '')).toBe(message);
    expect(existsSync(restoreActivationMarkerPath(inactive))).toBe(false);
    expect(dataSpace.restoreCutoverPending()).toBeNull();
    // 外部所有者仍持有屏障，本次取得的组件已回滚。
    expect(blocked(held as DatabaseName)).toBe(true);
    for (const name of ['mistakes', 'vfs', 'chat_v2', 'llm_usage'] as const) {
      if (name !== held) expect(blocked(name), name).toBe(false);
    }
    external!.release();
  });

  it('finalize_restore_activation rotates device identity and clears the maintenance lease', async () => {
    const created = await createBackupHost({ secrets: true });
    hosts.push(created.host);
    const appData = created.host.app.dataDir;
    const publication = createPublication();
    (created.host.ctx.secrets as unknown as { publication: CryptoPublication }).publication = publication;
    const dataSpace = makeDataSpace(appData, publication);
    created.host.ctx.provide('dataSpace', dataSpace);
    const activeDir = join(appData, 'slots', 'slotB');
    mkdirSync(activeDir, { recursive: true });
    writeFileSync(join(activeDir, 'chat_v2.db'), 'candidate');
    const backupId = 'activation-backup';
    dataSpace.markRestoreCutoverPending('slotB', backupId);
    persistRestoreActivationMarker(activeDir, {
      backup_id: backupId,
      snapshot_epoch: 'epoch-1',
      created_at: '2026-01-01T00:00:00+00:00',
    });
    const state = dataSpace.readState();
    state.active = 'slotB';
    state.pending = null;
    dataSpace.writeState(state);

    const persisted: string[] = [];
    const rotations: Array<[string, string, string]> = [];
    created.host.ctx.provide('syncSupport', {
      state: {
        recordDeviceRotation(oldId: string, newId: string, reason: string) {
          rotations.push([oldId, newId, reason]);
        },
      },
    });
    created.host.ctx.provide('paths', {
      async deviceId() { return 'old-device'; },
      generateDeviceIdAfterRestore() { return 'new-device'; },
      async persistDeviceIdAfterRestore(id: string) { persisted.push(id); },
    });

    const changed = await finalizeRestoreActivation(created.host.ctx, activeDir);
    expect(changed).toBe(true);
    expect(persisted).toEqual(['new-device']);
    // B05：轮换必须由 sync_state 所有者（syncSupport.state）完成。
    expect(rotations).toEqual([['old-device', 'new-device', 'backup_restore_activation']]);
    expect(existsSync(restoreActivationMarkerPath(activeDir))).toBe(false);
    expect(dataSpace.restoreCutoverPending()).toBeNull();
  });

  // Rust commands_restore.rs:56-65,165-171：serde 必填字段缺失/类型错误在任何轮换前失败。
  it.each([
    [{ backup_id: 'b', snapshot_epoch: 'e' }, '解析恢复激活标记失败: missing field `created_at`'],
    [{ backup_id: 1, snapshot_epoch: 'e', created_at: 'c' }, '解析恢复激活标记失败: invalid type for `backup_id`: expected a string'],
    [{ backup_id: 'b', snapshot_epoch: 'e', created_at: 'c', old_device_id: 7 }, '解析恢复激活标记失败: invalid type for `old_device_id`: expected a string'],
    [{ backup_id: ' ', snapshot_epoch: 'e', created_at: 'c' }, '恢复激活标记缺少 backup_id 或 snapshot_epoch'],
  ])('finalize_restore_activation rejects malformed marker %j before rotating', async (marker, message) => {
    const created = await createBackupHost({ secrets: true });
    hosts.push(created.host);
    const activeDir = join(created.host.app.dataDir, 'slots', 'slotB');
    mkdirSync(activeDir, { recursive: true });
    writeFileSync(restoreActivationMarkerPath(activeDir), JSON.stringify(marker));
    const rotations: unknown[] = [];
    created.host.ctx.provide('syncSupport', {
      state: { recordDeviceRotation: (...args: unknown[]) => { rotations.push(args); } },
    });

    await expect(finalizeRestoreActivation(created.host.ctx, activeDir)).rejects.toThrow(message);
    expect(rotations).toEqual([]);
    expect(existsSync(restoreActivationMarkerPath(activeDir))).toBe(true);
  });
});

describe('manifest compatibility', () => {
  it('rejects an incremental manifest before coverage validation', () => {
    const manifest = newManifest('0.0.0-test');
    manifest.backup_id = 'incr';
    manifest.is_incremental = true;
    manifest.incremental_base = 'base';
    expect(() => checkManifestCompatibility(manifest)).toThrow('Incremental backup restore is no longer supported');
  });
});
