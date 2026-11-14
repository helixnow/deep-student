import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { backupServiceStub } from './backup-service-stub.ts';
import { testPaths } from './sync-fixture.ts';
import {
  REPO_ROOT, SP, SYNC_MANAGER, WHOLE_ZIP_KEY, WHOLE_ZIP_PUT,
  apiWithoutReexports, filesMentioning, productionFileCount, readSource,
} from './delta-source-scan.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { deviceIdShortHash } from '../../sync-providers/api.ts';
// boundary-allow cross-plugin-impl: L22 集成测试需安装真实 L23 插件，经命令表验证整 ZIP 上传/下载
import syncProviders from '../../sync-providers/index.ts';

const backup = createBackupCrypto();

/**
 * `sync_r12_decoded_dead.rs` 与 `sync_r12_delta_{format,gc,inventory,restore,upload}.rs`
 * 的 TS 不变量：
 * - 生产云同步仍然把整包 ZIP 作为一个对象上传/下载；
 * - 没有任何 decoded 下载旁路，防降级门禁在真实 `cloud_sync_download` 命令里生效；
 * - delta / GC / inventory / restore / staging 命名空间零接线。
 *
 * 使用 L23 的真实命令 + 本地假 WebDAV 服务；L21 `backup@1` 守卫与 F4 `secrets`
 * 用测试替身（createTestHost 是唯一允许提供跨 lane 测试替身的地方）。
 */
const hosts: TestHost[] = [];
const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('p2_1_get_file_decoded_is_gone_from_src', async () => {
  const { host } = await setupCloudHost();
  const service = host.ctx.get('syncProvider') as unknown as Record<string, unknown>;

  expect(Object.keys(service).filter(key => /decoded/i.test(key))).toEqual([]);

  const contract = JSON.parse(readFileSync(new URL('../../../../contracts/ipc/L23-sync-providers.json', import.meta.url), 'utf8')) as {
    commands?: Array<{ name?: string }>;
  };
  const names = (contract.commands ?? []).map(command => command.name ?? '');
  expect(names.filter(name => /decoded/i.test(name))).toEqual([]);
});

it('p2_1_tombstone_comment_survives', async () => {
  const source = readFileSync(new URL('../../sync-providers/src/mod.ts', import.meta.url), 'utf8');

  expect(source).toContain('DSBK ciphertext always passes through to the decryption chain');
  expect(source).toContain('an explicit per-download opt-in relaxes only this gate');
  expect(source).toContain('otherwise the object is treated as a downgrade attack and rejected');
});

it('p2_1_download_file_object_keeps_antidowngrade_gate', async () => {
  const { host, dav } = await setupCloudHost();
  const config = davConfig(dav.endpoint);
  const zipPath = temporaryFile('backup.zip', Buffer.concat([Buffer.from('PK\u0003\u0004', 'latin1'), Buffer.from('payload')]));

  const uploaded = await host.invoke('cloud_sync_upload', { config, zipPath }) as { version: { id: string } };
  // 云端已登记加密标记，但下载到的对象仍是明文 ZIP：必须按降级攻击拒绝。
  dav.files.set(joinPath(dav.root, '.encryption-marker'), {
    data: Buffer.from(JSON.stringify({
      version: 2, createdByDevice: 'device', createdAt: '2026-01-01T00:00:00Z',
    }), 'utf8'),
    lastModified: new Date(),
  });

  const localDir = temporaryDir('download');
  await expect(host.invoke('cloud_sync_download', {
    config, versionId: uploaded.version.id, localDir,
  })).rejects.toThrow('E_SYNC_E2EE_DOWNGRADE_REJECTED');

  expect(readFileOrNull(join(localDir, `${uploaded.version.id}.zip`))).toBeNull();
});

it('whole_file_download_path_fails_closed_on_half_package', async () => {
  const { host, dav } = await setupCloudHost();
  const config = davConfig(dav.endpoint);
  const payload = Buffer.concat([Buffer.from('PK\u0003\u0004', 'latin1'), Buffer.alloc(64 * 1024, 0x42)]);
  const zipPath = temporaryFile('backup.zip', payload);
  const uploaded = await host.invoke('cloud_sync_upload', { config, zipPath }) as { version: { id: string } };
  const objectKey = joinPath(dav.root, `backups/${uploaded.version.id}.zip`);

  // 上传后才把云端对象换成半包：manifest 声明的 SHA256/大小仍是完整值。
  dav.files.set(objectKey, { data: payload.subarray(0, 20_000), lastModified: new Date() });
  const localDir = temporaryDir('whole-half');
  await expect(host.invoke('cloud_sync_download', {
    config, versionId: uploaded.version.id, localDir,
  })).rejects.toThrow(/SHA256|校验|下载不完整/);
  expect(readFileOrNull(join(localDir, `${uploaded.version.id}.zip`))).toBeNull();
  expect(readFileOrNull(join(localDir, `.${uploaded.version.id}.zip.part`))).toBeNull();

  // 云端恢复正常后重试成功，字节逐位一致。
  dav.files.set(objectKey, { data: payload, lastModified: new Date() });
  const downloaded = await host.invoke('cloud_sync_download', {
    config, versionId: uploaded.version.id, localDir,
  }) as { localPath: string };
  expect(readFileSync(downloaded.localPath)).toEqual(payload);
});

it('resumable_download_rejects_same_size_object_swap_via_sha256', async () => {
  const { host, dav } = await setupCloudHost();
  const config = davConfig(dav.endpoint);
  const payload = Buffer.concat([Buffer.from('PK\u0003\u0004', 'latin1'), Buffer.alloc(32 * 1024, 0x17)]);
  const zipPath = temporaryFile('backup.zip', payload);
  const uploaded = await host.invoke('cloud_sync_upload', { config, zipPath }) as { version: { id: string } };
  const objectKey = joinPath(dav.root, `backups/${uploaded.version.id}.zip`);

  const localDir = temporaryDir('resume-swap');
  const partPath = join(localDir, `.${uploaded.version.id}.zip.part`);
  writeFileSync(partPath, payload.subarray(0, 8 * 1024));
  const swapped = Buffer.from(payload);
  for (let index = 0; index < swapped.byteLength; index += 1) swapped[index] = (swapped[index] ?? 0) ^ 0xff;
  expect(swapped.byteLength).toBe(payload.byteLength);
  dav.files.set(objectKey, { data: swapped, lastModified: new Date() });

  await expect(host.invoke('cloud_sync_download', {
    config, versionId: uploaded.version.id, localDir,
  })).rejects.toThrow(/SHA256|校验/);
  expect(readFileOrNull(join(localDir, `${uploaded.version.id}.zip`))).toBeNull();
  expect(readFileOrNull(partPath)).toBeNull();
});

it('r12_source_lock_sync_manager_still_uploads_whole_zip', async () => {
  const { host, dav } = await setupCloudHost();
  const payload = Buffer.concat([Buffer.from('PK\u0003\u0004', 'latin1'), Buffer.from('whole-zip-payload')]);
  const zipPath = temporaryFile('backup.zip', payload);

  const uploaded = await host.invoke('cloud_sync_upload', { config: davConfig(dav.endpoint), zipPath }) as {
    version: { id: string };
  };

  const backupKey = joinPath(dav.root, `backups/${uploaded.version.id}.zip`);
  expect(Buffer.from(dav.files.get(backupKey)?.data ?? [])).toEqual(payload);
  expect([...dav.files.keys()].filter(key => key.startsWith(joinPath(dav.root, 'backups/')))).toEqual([backupKey]);
  expect([...dav.files.keys()].filter(key => key.includes('backup-v2'))).toEqual([]);

  // sync_r12_delta_format.rs:330-350 source lock, against the TS sync manager.
  const syncManager = readSource(SYNC_MANAGER);
  expect(syncManager).toContain(WHOLE_ZIP_KEY);
  expect(syncManager).toContain(WHOLE_ZIP_PUT);
  expect(syncManager).not.toContain('delta_format');
  expect(syncManager).not.toContain('backup-v2');
});

it('r12_source_lock_delta_gc_has_zero_production_wiring', async () => {
  const { host, dav } = await setupCloudHost();
  const zipPath = temporaryFile('backup.zip', Buffer.from('PK\u0003\u0004gc'));

  const uploaded = await host.invoke('cloud_sync_upload', { config: davConfig(dav.endpoint), zipPath }) as {
    version: { id: string };
  };
  await host.invoke('cloud_sync_delete_version', { config: davConfig(dav.endpoint), versionId: uploaded.version.id });

  const keys = [...dav.files.keys()];
  expect(keys.filter(key => /backup-v2|delta_gc|collect_gc_candidates|sweep_gc_candidates/.test(key))).toEqual([]);

  // sync_r12_delta_gc.rs:926-1009 source lock. TS `api.ts` re-exports stand in for Rust `pub mod`.
  const syncManager = readSource(SYNC_MANAGER);
  expect(syncManager).toContain(WHOLE_ZIP_KEY);
  expect(syncManager).toContain(WHOLE_ZIP_PUT);
  for (const needle of ['delta_gc', 'collectGcCandidates', 'sweepGcCandidates', 'backup-v2/gc']) {
    expect(syncManager).not.toContain(needle);
  }
  expect(filesMentioning('delta_gc')).toEqual([`${SP}/api.ts`, `${SP}/src/delta_gc.ts`]);
  for (const entry of ['collectGcCandidates', 'sweepGcCandidates']) {
    expect(filesMentioning(entry), entry).toEqual([`${SP}/api.ts`, `${SP}/src/delta_gc.ts`]);
    expect(apiWithoutReexports(), entry).not.toContain(entry);
  }
  expect(apiWithoutReexports()).not.toContain('delta_gc');
  const moduleSrc = readSource(`${SP}/src/delta_gc.ts`);
  expect(moduleSrc).toContain('Not wired');
  expect(moduleSrc).toContain('rather leave garbage than delete a still-referenced object');
  expect(moduleSrc).not.toContain('.putFile(');
});

it('r12_source_lock_inventory_has_no_production_callers', async () => {
  const { host, dav } = await setupCloudHost();
  const zipPath = temporaryFile('backup.zip', Buffer.from('PK\u0003\u0004inventory'));

  await host.invoke('cloud_sync_upload', { config: davConfig(dav.endpoint), zipPath });
  await host.invoke('cloud_sync_list_versions', { config: davConfig(dav.endpoint) });

  const keys = [...dav.files.keys()];
  expect(keys.filter(key => /delta_inventory|inventory|backup-v2/.test(key))).toEqual([]);

  // sync_r12_delta_inventory.rs:369-435 source lock. The L21 inventory module itself was not
  // ported (approved obsolete); only the unwired upload/restore primitives may name it.
  const syncManager = readSource(SYNC_MANAGER);
  expect(syncManager).toContain(WHOLE_ZIP_KEY);
  expect(syncManager).toContain(WHOLE_ZIP_PUT);
  expect(syncManager).not.toContain('delta_inventory');
  expect(filesMentioning('delta_inventory')).toEqual([`${SP}/src/delta_restore.ts`, `${SP}/src/delta_upload.ts`]);
  expect(filesMentioning('delta_inventory.ts')).toEqual([]);
  expect(existsSync(join(REPO_ROOT, 'host/plugins/backup/src/delta_inventory.ts'))).toBe(false);
});

it('r12_source_lock_delta_restore_has_zero_production_wiring', async () => {
  const { host, dav } = await setupCloudHost();
  const payload = Buffer.concat([Buffer.from('PK\u0003\u0004', 'latin1'), Buffer.from('restore-whole-zip')]);
  const zipPath = temporaryFile('backup.zip', payload);

  const uploaded = await host.invoke('cloud_sync_upload', { config: davConfig(dav.endpoint), zipPath }) as {
    version: { id: string };
  };
  const localDir = temporaryDir('restore');
  const downloaded = await host.invoke('cloud_sync_download', {
    config: davConfig(dav.endpoint), versionId: uploaded.version.id, localDir,
  }) as { localPath: string };

  expect(readFileSync(downloaded.localPath)).toEqual(payload);
  const keys = [...dav.files.keys()];
  expect(keys.filter(key => /delta_restore|restore_snapshot_to_staging|publish_verified_staging|backup-v2/.test(key))).toEqual([]);

  // sync_r12_delta_restore.rs:901-1009 source lock.
  const syncManager = readSource(SYNC_MANAGER);
  expect(syncManager).toContain(WHOLE_ZIP_KEY);
  expect(syncManager).toContain(WHOLE_ZIP_PUT);
  for (const needle of ['delta_restore', 'restoreSnapshotToStaging', 'publishVerifiedStaging', 'backup-v2/objects', 'backup-v2/snapshots']) {
    expect(syncManager).not.toContain(needle);
  }
  expect(filesMentioning('delta_restore')).toEqual([`${SP}/api.ts`, `${SP}/src/delta_restore.ts`]);
  expect(filesMentioning('restoreSnapshotToStaging')).toEqual([`${SP}/api.ts`, `${SP}/src/delta_restore.ts`]);
  expect(apiWithoutReexports()).not.toContain('delta_restore');
  expect(apiWithoutReexports()).not.toContain('restoreSnapshotToStaging');
  const moduleSrc = readSource(`${SP}/src/delta_restore.ts`);
  expect(moduleSrc).toContain('Not wired');
  expect(moduleSrc).toContain('does not mean incremental restore exists');
  for (const needle of ['storage.put', '.putFile(', 'storage.delete', 'ds_data', 'data_space', 'zip_export']) {
    expect(moduleSrc, needle).not.toContain(needle);
  }
});

it('r12_source_lock_delta_upload_has_zero_production_wiring', async () => {
  const { host, dav } = await setupCloudHost();
  const zipPath = temporaryFile('backup.zip', Buffer.from('PK\u0003\u0004delta'));

  await host.invoke('cloud_sync_upload', { config: davConfig(dav.endpoint), zipPath });

  const keys = [...dav.files.keys()];
  expect(keys.filter(key => /delta_upload|backup-v2\/objects|backup-v2\/snapshots|publish_verified_staging/.test(key))).toEqual([]);
  expect(keys.some(key => key.startsWith(joinPath(dav.root, 'backups/')))).toBe(true);
  expect(keys.some(key => key.startsWith(joinPath(dav.root, 'manifests/')))).toBe(true);

  // sync_r12_delta_upload.rs:817-905 source lock. TS GC/restore import upload helpers directly
  // (Rust reuses them through include! fragments that are not *.rs files); both are unwired.
  const syncManager = readSource(SYNC_MANAGER);
  expect(syncManager).toContain(WHOLE_ZIP_KEY);
  expect(syncManager).toContain(WHOLE_ZIP_PUT);
  for (const needle of ['delta_upload', 'backup-v2/objects', 'backup-v2/snapshots', 'publishVerifiedStaging']) {
    expect(syncManager).not.toContain(needle);
  }
  expect(filesMentioning('delta_upload')).toEqual([
    `${SP}/api.ts`, `${SP}/src/delta_gc.ts`, `${SP}/src/delta_restore.ts`, `${SP}/src/delta_upload.ts`,
  ]);
  expect(filesMentioning('publishVerifiedStaging')).toEqual([`${SP}/api.ts`, `${SP}/src/delta_upload.ts`]);
  expect(apiWithoutReexports()).not.toContain('delta_upload');
  expect(apiWithoutReexports()).not.toContain('publishVerifiedStaging');
});

it('source_lock_backup_lease_has_zero_production_wiring', async () => {
  const { host, dav } = await setupCloudHost();
  const zipPath = temporaryFile('backup.zip', Buffer.from('PK\u0003\u0004backup-lease'));

  await host.invoke('cloud_sync_upload', { config: davConfig(dav.endpoint), zipPath });

  const keys = [...dav.files.keys()];
  expect(keys.filter(key => key.includes('backup-v2/locks/'))).toEqual([]);
  expect(keys.filter(key => key.includes('data_governance/locks/sync-target'))).toEqual([]);
  expect(keys.some(key => key.startsWith(joinPath(dav.root, 'backups/')))).toBe(true);

  // sync_r12_backup_lease.rs:369-470 source lock over every Host production source file.
  expect(productionFileCount()).toBeGreaterThan(50);
  const lease = readSource(`${SP}/src/backup_lease.ts`);
  expect(lease).toContain("'backup-v2/locks/'");
  expect(lease).toContain('E_BACKUP_LEASE_HELD');
  expect(lease).not.toContain("'data_governance/locks/sync-target'");
  const upload = readSource(`${SP}/src/delta_upload.ts`);
  expect(upload).toContain('acquireBackupRepoLease');
  expect(upload).not.toContain("'data_governance/locks/sync-target'");
  expect(apiWithoutReexports()).not.toMatch(/backup_lease|BACKUP_LEASE_HELD|acquireBackupRepoLease/);
  // Allowed: the lease module, its shared core (lease.ts), the unwired delta primitives and api.ts.
  const allowed = new Set([
    `${SP}/api.ts`, `${SP}/src/backup_lease.ts`, `${SP}/src/lease.ts`,
    `${SP}/src/delta_gc.ts`, `${SP}/src/delta_restore.ts`, `${SP}/src/delta_upload.ts`,
  ]);
  expect(filesMentioning('backup_lease', 'BACKUP_LEASE_HELD', 'acquireBackupRepoLease').filter(file => !allowed.has(file))).toEqual([]);
});

it('new_upload_object_name_contains_no_time_or_device', async () => {
  const { host, dav } = await setupCloudHost();
  const config = davConfig(dav.endpoint);
  const zipPath = temporaryFile('backup.zip', Buffer.from('neutral-zip-bytes'));

  const uploaded = await host.invoke('cloud_sync_upload', { config, zipPath }) as { version: { id: string } };
  const versionId = uploaded.version.id;
  expect(versionId).toMatch(/^[A-Za-z0-9]{22}$/);
  expect(versionId).not.toContain('-');
  expect(versionId).not.toContain('device');

  const backupKeys = [...dav.files.keys()].filter(key => key.startsWith(joinPath(dav.root, 'backups/')));
  expect(backupKeys).toEqual([joinPath(dav.root, `backups/${versionId}.zip`)]);

  const deviceId = await host.invoke('cloud_sync_get_device_id') as string;
  const hashedManifest = joinPath(dav.root, `manifests/${deviceIdShortHash(deviceId)}.json`);
  expect(dav.files.has(hashedManifest)).toBe(true);
  expect(dav.files.has(joinPath(dav.root, `manifests/${deviceId}.json`))).toBe(false);

  const manifest = JSON.parse(Buffer.from(dav.files.get(hashedManifest)!.data).toString('utf8')) as {
    versions: Array<{ id: string; deviceId: string }>;
  };
  expect(manifest.versions[0]?.id).toBe(versionId);
  expect(manifest.versions[0]?.deviceId).toBe(deviceId);
});

it('new_client_downloads_legacy_timestamp_object', async () => {
  const { host, dav } = await setupCloudHost();
  const config = davConfig(dav.endpoint);
  const deviceId = await host.invoke('cloud_sync_get_device_id') as string;
  const versionId = '20260115-120000-123-device-abcd1234';
  const payload = Buffer.from('legacy-zip');

  dav.files.set(joinPath(dav.root, `backups/${versionId}.zip`), { data: payload, lastModified: new Date() });
  dav.files.set(joinPath(dav.root, `manifests/${deviceId}.json`), {
    data: Buffer.from(JSON.stringify({
      version: 1,
      latest: versionId,
      updatedAt: '2026-01-15T12:00:00Z',
      versions: [{
        id: versionId,
        timestamp: '2026-01-15T12:00:00Z',
        size: payload.byteLength,
        checksum: sha256Hex(payload),
        deviceId,
      }],
    })),
    lastModified: new Date(),
  });

  const versions = await host.invoke('cloud_sync_list_versions', { config }) as Array<{ id: string }>;
  // sync_r12_neutral_names.rs:205-206：只合并出这一个旧版本。
  expect(versions).toHaveLength(1);
  expect(versions[0]!.id).toBe(versionId);

  const localDir = temporaryDir('legacy-download');
  const downloaded = await host.invoke('cloud_sync_download', { config, versionId, localDir }) as {
    localPath: string; version: { id: string };
  };
  // :213-215
  expect(downloaded.version.id).toBe(versionId);
  expect(readFileSync(downloaded.localPath)).toEqual(payload);
});

it('legacy_style_reader_can_fetch_new_object_by_manifest_id', async () => {
  const { host, dav } = await setupCloudHost();
  const config = davConfig(dav.endpoint);
  const payload = Buffer.from('new-neutral-zip');
  const zipPath = temporaryFile('backup.zip', payload);

  const uploaded = await host.invoke('cloud_sync_upload', { config, zipPath }) as { version: { id: string } };
  const versionId = uploaded.version.id;
  const versions = await host.invoke('cloud_sync_list_versions', { config }) as Array<{ id: string }>;
  expect(versions[0]?.id).toBe(versionId);

  const object = dav.files.get(joinPath(dav.root, `backups/${versionId}.zip`));
  expect(Buffer.from(object?.data ?? [])).toEqual(payload);

  const localDir = temporaryDir('neutral-download');
  const downloaded = await host.invoke('cloud_sync_download', { config, versionId, localDir }) as { localPath: string };
  expect(readFileSync(downloaded.localPath)).toEqual(payload);
});

it('legacy_device_manifest_migrates_on_save', async () => {
  const { host, dav } = await setupCloudHost();
  const config = davConfig(dav.endpoint);
  const deviceId = await host.invoke('cloud_sync_get_device_id') as string;
  const versionId = '20260115-120000-123-device-abcd1234';
  const payload = Buffer.from('migrate-me');
  dav.files.set(joinPath(dav.root, `backups/${versionId}.zip`), { data: payload, lastModified: new Date() });
  dav.files.set(joinPath(dav.root, `manifests/${deviceId}.json`), {
    data: Buffer.from(JSON.stringify({
      version: 1,
      latest: versionId,
      updatedAt: '2026-01-15T12:00:00Z',
      versions: [{
        id: versionId,
        timestamp: '2026-01-15T12:00:00Z',
        size: payload.byteLength,
        checksum: sha256Hex(payload),
        deviceId,
      }],
    })),
    lastModified: new Date(),
  });

  const status = await host.invoke('cloud_sync_get_status', { config }) as { lastSyncTime?: string | null };
  expect(status.lastSyncTime).toBeTruthy();

  const zipPath = temporaryFile('backup.zip', Buffer.from('after-migrate'));
  const uploaded = await host.invoke('cloud_sync_upload', { config, zipPath }) as { version: { id: string } };

  expect(dav.files.has(joinPath(dav.root, `manifests/${deviceId}.json`))).toBe(false);
  const migratedKey = joinPath(dav.root, `manifests/${deviceIdShortHash(deviceId)}.json`);
  const migrated = dav.files.get(migratedKey);
  expect(migrated).toBeDefined();
  const parsed = JSON.parse(Buffer.from(migrated!.data).toString('utf8')) as { versions: Array<{ id: string }> };
  const ids = parsed.versions.map(version => version.id);
  expect(ids).toContain(versionId);
  expect(ids).toContain(uploaded.version.id);
});

it('new_marker_created_by_device_is_short_hash', async () => {
  const password = 'R12-neutral-passphrase';
  const { host, dav } = await setupCloudHost(password);
  const config = { ...davConfig(dav.endpoint), encryptionPassword: password };
  const deviceId = await host.invoke('cloud_sync_get_device_id') as string;
  const zipPath = temporaryFile('backup.zip', Buffer.from('encrypted-neutral'));

  await host.invoke('cloud_sync_upload', { config, zipPath });

  const marker = dav.files.get(joinPath(dav.root, '.encryption-marker'));
  expect(marker).toBeDefined();
  const parsed = JSON.parse(Buffer.from(marker!.data).toString('utf8')) as { createdByDevice: string };
  expect(parsed.createdByDevice).toBe(deviceIdShortHash(deviceId));
  expect(parsed.createdByDevice).not.toBe(deviceId);
});

it('upgrade_preserves_raw_legacy_created_by_device', async () => {
  const password = 'R12-neutral-passphrase';
  const { host, dav } = await setupCloudHost(password);
  const config = { ...davConfig(dav.endpoint), encryptionPassword: password };
  dav.files.set(joinPath(dav.root, '.encryption-marker'), {
    data: Buffer.from(JSON.stringify({
      version: 1,
      createdByDevice: 'device-legacy-writer',
      createdAt: '2026-01-01T00:00:00Z',
    })),
    lastModified: new Date(),
  });
  const zipPath = temporaryFile('backup.zip', Buffer.from('upgrade-neutral'));

  await host.invoke('cloud_sync_upload', { config, zipPath });

  const marker = dav.files.get(joinPath(dav.root, '.encryption-marker'));
  const parsed = JSON.parse(Buffer.from(marker!.data).toString('utf8')) as {
    version: number;
    createdByDevice: string;
    createdAt: string;
  };
  expect(parsed.version).toBe(2);
  expect(parsed.createdByDevice).toBe('device-legacy-writer');
  expect(parsed.createdAt).toBe('2026-01-01T00:00:00Z');
});

it('upload_precheck_oversized_params_fails_closed_without_write', async () => {
  const { host, dav, credentials } = await setupCloudHost('any-pw');
  const config = davConfig(dav.endpoint);
  dav.files.set(joinPath(dav.root, '.encryption-marker'), {
    data: Buffer.from(JSON.stringify({
      version: 2,
      createdByDevice: 'attacker-or-corruption',
      createdAt: new Date().toISOString(),
      keyVerifier: {
        kdf: 'argon2id',
        mCost: 0xffff_ffff,
        tCost: 1,
        pCost: 1,
        salt: '00112233445566778899aabbccddeeff',
        digest: '22'.repeat(32),
      },
    })),
    lastModified: new Date(),
  });
  const snapshot = (): Array<[string, string]> => [...dav.files.entries()]
    .map(([key, file]): [string, string] => [key, Buffer.from(file.data).toString('hex')])
    .sort(([left], [right]) => left.localeCompare(right));
  const before = snapshot();
  const zipPath = temporaryFile('backup.zip', Buffer.from('oversized-params'));

  // sync_r10_verifier.rs:303-315：带密码时在派生前拒绝，文案含“加密参数异常”。
  const started = Date.now();
  await expect(host.invoke('cloud_sync_upload', { config, zipPath }))
    .rejects.toThrow(/加密参数异常/);
  expect(Date.now() - started).toBeLessThan(500);

  // :317-320：明文（无密码）在标记存在时同样拒绝。
  credentials.encryptionPassword = null;
  await expect(host.invoke('cloud_sync_upload', { config, zipPath })).rejects.toThrow(/端到端加密/);

  // :322-326：两路拒绝后云端对象逐字节不变（零写入）。
  expect(snapshot()).toEqual(before);
});

it('deleted_marker_does_not_allow_plaintext_upload_from_this_machine', async () => {
  const password = 'r10-deleted-marker-passphrase';
  const { host, dav, credentials } = await setupCloudHost(password);
  const config = davConfig(dav.endpoint);
  const encryptedZip = temporaryFile('encrypted.zip', Buffer.from('PK\u0003\u0004 encrypted'));
  await host.invoke('cloud_sync_upload', { config, zipPath: encryptedZip });

  const memoryPath = join(host.app.dataDir, '.cloud-encrypted-roots.json');
  expect(existsSync(memoryPath)).toBe(true);

  dav.files.delete(joinPath(dav.root, '.encryption-marker'));
  credentials.encryptionPassword = null;
  const plainZip = temporaryFile('plain.zip', Buffer.from('PK\u0003\u0004 plaintext'));

  const error = await host.invoke('cloud_sync_upload', { config, zipPath: plainZip })
    .then(() => { throw new Error('标记被删后本机明文上传必须仍被拒绝'); }, (reason: unknown) => errorMessage(reason));
  expect(error).toContain('曾启用端到端加密');
  expect(error).toContain('加密密码');

  // 本机加密上传不受影响：标记缺失时用本机密码重新登记。
  credentials.encryptionPassword = password;
  await host.invoke('cloud_sync_upload', { config, zipPath: encryptedZip });
  expect(dav.files.has(joinPath(dav.root, '.encryption-marker'))).toBe(true);
});

it('memory_is_scoped_per_cloud_root', async () => {
  const password = 'r10-scoped-memory-passphrase';
  const { host, dav, credentials } = await setupCloudHost(password);
  const configA = davConfig(dav.endpoint);
  const encryptedZip = temporaryFile('encrypted.zip', Buffer.from('PK\u0003\u0004 scoped'));
  await host.invoke('cloud_sync_upload', { config: configA, zipPath: encryptedZip });

  dav.files.delete(joinPath(dav.root, '.encryption-marker'));
  credentials.encryptionPassword = null;
  const plainZip = temporaryFile('plain.zip', Buffer.from('PK\u0003\u0004 plain'));

  await expect(host.invoke('cloud_sync_upload', { config: configA, zipPath: plainZip }))
    .rejects.toThrow(/曾启用端到端加密/);

  // 同一台机器、不同云端目录：不受目录 A 的本机记忆影响。
  const configB = { ...davConfig(dav.endpoint), root: 'other-cloud-root' };
  await host.invoke('cloud_sync_upload', { config: configB, zipPath: plainZip });
  expect(dav.files.has(joinPath('/dav/other-cloud-root', '.encryption-marker'))).toBe(false);
  expect([...dav.files.keys()].some(key => key.startsWith('/dav/other-cloud-root/backups/'))).toBe(true);
});

it('plaintext_rejection_backfills_local_memory', async () => {
  const password = 'r10-backfill-passphrase';
  const { host, dav, credentials } = await setupCloudHost(password);
  const config = davConfig(dav.endpoint);
  const encryptedZip = temporaryFile('encrypted.zip', Buffer.from('PK\u0003\u0004 backfill'));
  await host.invoke('cloud_sync_upload', { config, zipPath: encryptedZip });

  // 模拟从旧版本升级：云端标记仍在，但本机尚无记忆。
  const memoryPath = join(host.app.dataDir, '.cloud-encrypted-roots.json');
  rmSync(memoryPath, { force: true });
  expect(existsSync(memoryPath)).toBe(false);

  credentials.encryptionPassword = null;
  const plainZip = temporaryFile('plain.zip', Buffer.from('PK\u0003\u0004 plain'));
  await expect(host.invoke('cloud_sync_upload', { config, zipPath: plainZip }))
    .rejects.toThrow(/端到端加密/);

  // 拦截时应补写本机记忆。
  expect(existsSync(memoryPath)).toBe(true);
});

it('r12_empty_root_v1_marker_still_upgrades_with_first_password', async () => {
  const password = 'first-pw-2026';
  const { host, dav, credentials } = await setupCloudHost(password);
  const config = davConfig(dav.endpoint);
  seedV1Marker(dav);
  const zipPath = temporaryFile('backup.zip', Buffer.from('PK\u0003\u0004 first-password'));
  // sync_r12_v1_marker_trust.rs:215-218 前置条件：该 root 没有任何备份对象。
  expect([...dav.files.keys()].filter(key => key.startsWith(joinPath(dav.root, 'backups/')))).toEqual([]);

  await host.invoke('cloud_sync_upload', { config, zipPath });

  const marker = markerJson(dav);
  expect(marker.version).toBe(2);
  expect(marker.createdByDevice).toBe(deviceIdShortHash('device-legacy-writer'));
  expect(marker.createdAt).toBe('2026-01-01T00:00:00Z');
  expect(marker.keyVerifier).toBeDefined();

  // 升级后：同密码放行、错密码被拦。
  await host.invoke('cloud_sync_upload', { config, zipPath });
  credentials.encryptionPassword = 'other-pw';
  await expect(host.invoke('cloud_sync_upload', { config, zipPath }))
    .rejects.toThrow(/E_SYNC_E2EE_WRONG_PASSWORD/);
});

it('r12_correct_password_upgrades_after_trial_decrypt_of_existing_backup', async () => {
  const password = 'team-pw-2026';
  const { host, dav, credentials } = await setupCloudHost(password);
  const config = davConfig(dav.endpoint);
  seedV1Marker(dav);
  seedCloudVersion(dav, 'device-seeder', 'seeded-encrypted-1', await backup.encryptBackup(
    Buffer.from('zip bytes protected by the team password'), password,
  ));
  const zipPath = temporaryFile('backup.zip', Buffer.from('PK\u0003\u0004 after-upgrade'));

  await host.invoke('cloud_sync_upload', { config, zipPath });

  const marker = markerJson(dav);
  expect(marker.version).toBe(2);
  expect(marker.createdByDevice).toBe(deviceIdShortHash('device-legacy-writer'));
  expect(marker.createdAt).toBe('2026-01-01T00:00:00Z');
  expect(marker.keyVerifier).toBeDefined();

  await host.invoke('cloud_sync_upload', { config, zipPath });
  credentials.encryptionPassword = 'wrong-pw';
  await expect(host.invoke('cloud_sync_upload', { config, zipPath }))
    .rejects.toThrow(/E_SYNC_E2EE_WRONG_PASSWORD/);
});

it('r12_wrong_password_cannot_claim_root_with_existing_backups', async () => {
  const { host, dav, credentials } = await setupCloudHost('wrong-pw-2026');
  const config = davConfig(dav.endpoint);
  seedV1Marker(dav);
  const versionId = 'seeded-encrypted-trial';
  seedCloudVersion(dav, 'device-seeder', versionId, await backup.encryptBackup(
    Buffer.from('existing encrypted backup'), 'team-pw-2026',
  ));
  const zipPath = temporaryFile('backup.zip', Buffer.from('PK\u0003\u0004 trial'));

  const error = await host.invoke('cloud_sync_upload', { config, zipPath })
    .then(() => { throw new Error('错密码不得通过既有备份的试解'); }, (reason: unknown) => errorMessage(reason));
  expect(error).toContain('试解');
  expect(error).toContain('未通过');
  expect(error).toContain(versionId);
  expect(error).toContain('核对加密密码');
  expect(markerJson(dav).version).toBe(1);
  expect(markerJson(dav).keyVerifier).toBeUndefined();

  // 持有正确密码的设备之后仍能完成升级。
  credentials.encryptionPassword = 'team-pw-2026';
  await host.invoke('cloud_sync_upload', { config, zipPath });
  expect(markerJson(dav).version).toBe(2);
  expect(markerJson(dav).createdByDevice).toBe(deviceIdShortHash('device-legacy-writer'));

  // 此后错密码设备被校验子拦截。
  credentials.encryptionPassword = 'wrong-pw-2026';
  await expect(host.invoke('cloud_sync_upload', { config, zipPath }))
    .rejects.toThrow(/E_SYNC_E2EE_WRONG_PASSWORD/);
});

it('r12_truncated_backup_object_blocks_upgrade', async () => {
  const password = 'team-pw-2026';
  const { host, dav } = await setupCloudHost(password);
  const config = davConfig(dav.endpoint);
  seedV1Marker(dav);
  const versionId = 'seeded-encrypted-truncated';
  const object = await backup.encryptBackup(Buffer.from('payload that will be truncated in the cloud'), password);
  seedCloudVersion(dav, 'device-seeder', versionId, object);
  const objectKey = joinPath(dav.root, `backups/${versionId}.zip`);
  const original = Buffer.from(dav.files.get(objectKey)!.data);
  dav.files.set(objectKey, { data: original.subarray(0, original.byteLength - 8), lastModified: new Date() });
  const zipPath = temporaryFile('backup.zip', Buffer.from('PK\u0003\u0004 truncated'));

  const error = await host.invoke('cloud_sync_upload', { config, zipPath })
    .then(() => { throw new Error('被截断的备份对象不得通过试解'); }, (reason: unknown) => errorMessage(reason));
  expect(error).toContain('本次未改动加密标记');
  expect(markerJson(dav).version).toBe(1);
  expect(markerJson(dav).keyVerifier).toBeUndefined();
});

it('r12_backup_download_failure_keeps_v1_marker_untouched', async () => {
  const password = 'team-pw-2026';
  const { host, dav } = await setupCloudHost(password);
  const config = davConfig(dav.endpoint);
  seedV1Marker(dav);
  const versionId = 'seeded-encrypted-outage';
  seedCloudVersion(dav, 'device-seeder', versionId, await backup.encryptBackup(
    Buffer.from('backup unreachable during outage'), password,
  ));
  dav.failGetKeys.add(joinPath(dav.root, `backups/${versionId}.zip`));
  const zipPath = temporaryFile('backup.zip', Buffer.from('PK\u0003\u0004 outage'));

  const error = await host.invoke('cloud_sync_upload', { config, zipPath })
    .then(() => { throw new Error('备份对象读取失败时不得升级标记'); }, (reason: unknown) => errorMessage(reason));
  expect(error).toContain('读取备份');
  expect(error).toContain('本次未改动加密标记');
  expect(markerJson(dav).version).toBe(1);
  expect(markerJson(dav).keyVerifier).toBeUndefined();

  // 故障恢复后，同一密码可正常完成升级。
  dav.failGetKeys.delete(joinPath(dav.root, `backups/${versionId}.zip`));
  await host.invoke('cloud_sync_upload', { config, zipPath });
  expect(markerJson(dav).version).toBe(2);
  expect(markerJson(dav).keyVerifier).toBeDefined();
});

it('r12_plaintext_legacy_backup_blocks_upgrade', async () => {
  const { host, dav } = await setupCloudHost('any-pw-2026');
  const config = davConfig(dav.endpoint);
  seedV1Marker(dav);
  seedCloudVersion(dav, 'device-seeder', 'seeded-plaintext-legacy', Buffer.from('PK plain zip bytes without dsbk header'));
  const zipPath = temporaryFile('backup.zip', Buffer.from('PK\u0003\u0004 plaintext-trial'));

  const error = await host.invoke('cloud_sync_upload', { config, zipPath })
    .then(() => { throw new Error('非 DSBK 备份不得通过试解'); }, (reason: unknown) => errorMessage(reason));
  expect(error).toContain('试解');
  expect(error).toContain('未通过');
  expect(error).toContain('人工检查');
  expect(markerJson(dav).version).toBe(1);
  expect(markerJson(dav).keyVerifier).toBeUndefined();
});

it('r12_wrong_password_cannot_claim_markerless_v0944_encrypted_root', async () => {
  const { host, dav, credentials } = await setupCloudHost('mistyped-password');
  const config = davConfig(dav.endpoint);
  const versionId = 'seeded-v0944-encrypted';
  seedCloudVersion(dav, 'device-seeder', versionId, await backup.encryptBackup(
    Buffer.from('encrypted before marker support existed'), 'v0944-team-password',
  ));
  const zipPath = temporaryFile('backup.zip', Buffer.from('PK\u0003\u0004 markerless'));

  const error = await host.invoke('cloud_sync_upload', { config, zipPath })
    .then(() => { throw new Error('错密码不得抢占无 marker 的旧加密仓库'); }, (reason: unknown) => errorMessage(reason));
  expect(error).toContain('尚无加密标记');
  expect(error).toContain('试解');
  expect(error).toContain(versionId);
  expect(dav.files.has(joinPath(dav.root, '.encryption-marker'))).toBe(false);

  credentials.encryptionPassword = 'v0944-team-password';
  await host.invoke('cloud_sync_upload', { config, zipPath });
  const marker = markerJson(dav);
  expect(marker.version).toBe(2);
  expect(marker.keyVerifier).toBeDefined();
});

it('r12_markerless_plain_zip_can_start_new_encrypted_chain', async () => {
  const password = 'new-e2ee-password';
  const { host, dav } = await setupCloudHost(password);
  const config = davConfig(dav.endpoint);
  seedCloudVersion(dav, 'device-seeder', 'seeded-v0944-plain', Buffer.from('PK\u0003\u0004 legacy plaintext zip payload'));
  const zipPath = temporaryFile('backup.zip', Buffer.from('PK\u0003\u0004 new-chain'));

  await host.invoke('cloud_sync_upload', { config, zipPath });

  const marker = markerJson(dav);
  expect(marker.version).toBe(2);
  expect(marker.keyVerifier).toBeDefined();
  expect(dav.files.has(joinPath(dav.root, '.encryption-marker'))).toBe(true);
});

// ------------------------------------------------------------------ helpers

interface DavFile { data: Buffer; lastModified: Date }
interface FakeDav { endpoint: string; root: string; files: Map<string, DavFile>; failGetKeys: Set<string> }

interface TestCredentials {
  webdavPassword: string | null;
  encryptionPassword: string | null;
}

async function setupCloudHost(encryptionPassword: string | null = null): Promise<{
  host: TestHost;
  dav: FakeDav;
  credentials: TestCredentials;
}> {
  const dav = await startDav();
  const backupCrypto = createBackupCrypto();
  const credentials: TestCredentials = { webdavPassword: 'secret', encryptionPassword };
  const host = await createTestHost({
    plugins: [syncProviders],
    provide: {
      secrets: {
        backup: backupCrypto,
        openStore() {
          return { async getCloudCredentials() { return { ...credentials }; } };
        },
      },
      backup: backupServiceStub(() => credentials),
      paths: testPaths(temporaryDir('device-id'), 'l22-cloud-device'),
    },
  });
  hosts.push(host);
  return { host, dav, credentials };
}

function davConfig(endpoint: string) {
  return {
    provider: 'webdav' as const,
    webdav: { endpoint, username: 'tester', password: 'secret' },
    root: 'deep-student-sync',
    encryptionPassword: null,
  };
}

function temporaryDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `l22-${prefix}-`));
  roots.push(dir);
  return dir;
}

function temporaryFile(name: string, data: Buffer): string {
  const path = join(temporaryDir('file'), name);
  writeFileSync(path, data);
  return path;
}

function readFileOrNull(path: string): Buffer | null {
  try { return readFileSync(path); }
  catch { return null; }
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function seedV1Marker(
  dav: FakeDav,
  createdByDevice = deviceIdShortHash('device-legacy-writer'),
  createdAt = '2026-01-01T00:00:00Z',
): void {
  dav.files.set(joinPath(dav.root, '.encryption-marker'), {
    data: Buffer.from(JSON.stringify({ version: 1, createdByDevice, createdAt })),
    lastModified: new Date(createdAt),
  });
}

/** 写入一个真实的云端版本（对象 + 设备清单），模拟旧设备上传的既有备份。 */
function seedCloudVersion(
  dav: FakeDav,
  deviceId: string,
  versionId: string,
  data: Uint8Array,
  timestamp = '2026-01-15T12:00:00Z',
): void {
  dav.files.set(joinPath(dav.root, `backups/${versionId}.zip`), {
    data: Buffer.from(data),
    lastModified: new Date(timestamp),
  });
  dav.files.set(joinPath(dav.root, `manifests/${deviceIdShortHash(deviceId)}.json`), {
    data: Buffer.from(JSON.stringify({
      version: 1,
      latest: versionId,
      updatedAt: timestamp,
      versions: [{
        id: versionId,
        timestamp,
        size: data.byteLength,
        checksum: sha256Hex(data),
        deviceId,
      }],
    })),
    lastModified: new Date(timestamp),
  });
}

function markerJson(dav: FakeDav): Record<string, unknown> {
  const marker = dav.files.get(joinPath(dav.root, '.encryption-marker'));
  if (marker === undefined) throw new Error('云端加密标记不存在');
  return JSON.parse(Buffer.from(marker.data).toString('utf8')) as Record<string, unknown>;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'object' && reason !== null && 'message' in reason) {
    return String((reason as { message: unknown }).message);
  }
  return String(reason);
}

function joinPath(root: string, child: string): string {
  return `${root.replace(/\/+$/, '')}/${child.replace(/^\/+/, '')}`;
}

async function startDav(): Promise<FakeDav> {
  const files = new Map<string, DavFile>();
  const dirs = new Set<string>(['/']);
  const failGetKeys = new Set<string>();
  const root = '/dav/deep-student-sync';

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const method = request.method ?? 'GET';
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://dav.local').pathname);
      const key = pathname.replace(/\/+$/, '') || '/';
      const body = Buffer.concat(chunks);

      if (method === 'MKCOL') {
        addDirectory(key);
        response.writeHead(201).end();
        return;
      }
      if (method === 'PUT') {
        addDirectory(parentOf(key));
        files.set(key, { data: body, lastModified: new Date() });
        response.writeHead(201).end();
        return;
      }
      if (method === 'GET') {
        if (failGetKeys.has(key)) {
          response.writeHead(500).end();
          return;
        }
        const file = files.get(key);
        if (file !== undefined) {
          const range = request.headers.range;
          if (typeof range === 'string') {
            const match = /^bytes=(\d+)-(\d*)$/.exec(range);
            if (match !== null) {
              const start = Number(match[1]);
              const end = match[2] === '' ? file.data.byteLength - 1 : Math.min(Number(match[2]), file.data.byteLength - 1);
              if (start >= file.data.byteLength || start > end) {
                response.writeHead(416, { 'content-range': `bytes */${file.data.byteLength}` }).end();
                return;
              }
              const slice = file.data.subarray(start, end + 1);
              response.writeHead(206, {
                'content-length': String(slice.byteLength),
                'content-range': `bytes ${start}-${end}/${file.data.byteLength}`,
                'content-type': 'application/octet-stream',
              }).end(slice);
              return;
            }
          }
          response.writeHead(200, {
            'content-length': String(file.data.byteLength),
            'content-type': 'application/octet-stream',
          }).end(file.data);
          return;
        }
        if (dirs.has(key)) {
          response.writeHead(200, { 'content-length': '0' }).end();
          return;
        }
        response.writeHead(404).end();
        return;
      }
      if (method === 'DELETE') {
        files.delete(key);
        response.writeHead(204).end();
        return;
      }
      if (method === 'PROPFIND') {
        const rawDepth = request.headers.depth;
        const xml = propfindXml(key, Array.isArray(rawDepth) ? rawDepth[0] ?? '0' : rawDepth ?? '0');
        if (xml === null) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(207, {
          'content-type': 'application/xml; charset=utf-8',
          'content-length': String(Buffer.byteLength(xml)),
        }).end(xml);
        return;
      }
      response.writeHead(405).end();
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${address.port}/dav/`, root, files, failGetKeys };

  function addDirectory(path: string): void {
    if (!path || path === '/') { dirs.add('/'); return; }
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = `${current}/${part}`;
      dirs.add(current);
    }
  }

  function propfindXml(path: string, depth: string): string | null {
    const file = files.get(path);
    if (file !== undefined) {
      return collectionXml([fileResponse(path, file)]);
    }
    const childPrefix = path.endsWith('/') ? path : `${path}/`;
    const hasChildren = [...files.keys()].some(child => child.startsWith(childPrefix));
    if (!dirs.has(path) && !hasChildren) return null;
    if (depth === '0') return collectionXml([directoryResponse(path)]);
    const children: string[] = [directoryResponse(path)];
    for (const [childPath, child] of files) {
      if (parentOf(childPath) === path) children.push(fileResponse(childPath, child));
    }
    for (const dir of dirs) {
      if (dir !== path && parentOf(dir) === path) children.push(directoryResponse(dir));
    }
    return collectionXml(children);
  }
}

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  if (index <= 0) return '/';
  return trimmed.slice(0, index);
}

function collectionXml(entries: string[]): string {
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entries.join('')}</d:multistatus>`;
}

function directoryResponse(path: string): string {
  const href = path === '/' ? '/' : `${path}/`;
  return '<d:response>'
    + `<d:href>${escapeXml(href)}</d:href>`
    + '<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>'
    + '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
}

function fileResponse(path: string, file: DavFile): string {
  return '<d:response>'
    + `<d:href>${escapeXml(path)}</d:href>`
    + '<d:propstat><d:prop><d:resourcetype/>'
    + `<d:getcontentlength>${file.data.byteLength}</d:getcontentlength>`
    + `<d:getlastmodified>${file.lastModified.toUTCString()}</d:getlastmodified>`
    + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
