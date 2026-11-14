/**
 * [R4-P03/P08] Command-level guard lifecycle and anti-downgrade errors.
 *
 * Rust acquires `DataGovernanceOperationGuard` before `create_storage`, keeps it
 * alive for the whole command and releases it on both success and failure
 * (`cloud/mod.rs:419-427,560-567,720-727`). The anti-downgrade gate returns
 * `AppErrorType::Validation` at the command boundary.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BackupCrypto } from '../../../platform/secrets/api.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import {
  SYNC_E2EE_DOWNGRADE_REJECTED_CODE,
  SYNC_E2EE_PASSWORD_REQUIRED_CODE,
} from '../src/mod.ts';
import { deviceIdShortHash } from '../src/device_id.ts';
import { WebDavStorage } from '../src/webdav.ts';
import {
  OperationBusyError,
  OperationLockError,
  type DataGovernanceOperationKind,
} from '../../backup/api.ts';
import { HandlerPanic } from '../../../kernel/testing.ts';
import { spawnStatefulDav } from './fake_dav_store.ts';
import { createSyncHost, type OperationGuardLike } from './host_fixture.ts';

const DEVICE_ID = 'device-x';
const ROOT = 'deep-student-sync';
const tempDirs: string[] = [];

afterAll(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

const PAYLOAD = Buffer.concat([
  Buffer.from('PK\x03\x04', 'binary'),
  Buffer.from('deep-student backup payload for anti-downgrade command tests', 'utf8'),
]);

interface DavFixture {
  endpoint: string;
  close(): Promise<void>;
}

async function davWithManifest(markerPresent: boolean): Promise<DavFixture> {
  const manifest = {
    version: 1,
    latest: 'v1',
    updatedAt: '2026-01-01T00:00:00Z',
    versions: [{
      id: 'v1',
      timestamp: '2026-01-01T00:00:00Z',
      size: PAYLOAD.byteLength,
      checksum: sha256(PAYLOAD),
      deviceId: DEVICE_ID,
    }],
  };
  const objects: Record<string, string | Uint8Array> = {
    [`${ROOT}/manifests/${deviceIdShortHash(DEVICE_ID)}.json`]: JSON.stringify(manifest),
    [`${ROOT}/backups/v1.zip`]: PAYLOAD,
  };
  if (markerPresent) {
    objects[`${ROOT}/.encryption-marker`] = JSON.stringify({
      version: 2,
      createdByDevice: deviceIdShortHash(DEVICE_ID),
      createdAt: '2026-01-01T00:00:00+00:00',
    });
  }
  return spawnStatefulDav({ root: ROOT, objects });
}

function webdavConfig(endpoint: string, encryptionPassword: string | null = null): Record<string, unknown> {
  return {
    provider: 'webdav',
    webdav: { endpoint, username: 'student', password: 'secret' },
    encryptionPassword,
  };
}

/** Command tests need a manager; the F4 owner API is stubbed to the lane id. */
function createCommandHost(options: Parameters<typeof createSyncHost>[0] = {}) {
  return createSyncHost({
    dataSpaceDeviceId: async () => DEVICE_ID,
    ...options,
  });
}

function guardSpy(log: string[]): (kind: DataGovernanceOperationKind) => OperationGuardLike {
  return kind => {
    log.push(`acquire:${kind}`);
    return {
      snapshot: {
        operation_id: `op-${kind}`,
        kind,
        started_at: '2026-01-01T00:00:00Z',
        process_id: 1,
      },
      operationId: () => `op-${kind}`,
      release: () => { log.push(`release:${kind}`); },
    };
  };
}

describe('cloud sync write command guard lifecycle', () => {
  it('maps the provider OperationBusyError to Rust Validation without parsing its message', async () => {
    const fixture = await createCommandHost({
      env: { DEVICE_ID },
      guard: () => { throw new OperationBusyError('已有数据治理操作正在运行（当前 backup，operation_id=op-1）'); },
    });
    try {
      await expect(fixture.host.invoke('cloud_sync_upload', {
        config: {}, zipPath: '/nonexistent/backup.zip',
      })).rejects.toEqual({
        error_type: 'Validation',
        message: '已有数据治理操作正在运行（当前 backup，operation_id=op-1）',
        details: null,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('maps the provider OperationLockError to FileSystem without string guessing', async () => {
    const fixture = await createCommandHost({
      env: { DEVICE_ID },
      guard: () => { throw new OperationLockError('创建数据治理跨进程锁目录失败 "/x": EACCES'); },
    });
    try {
      await expect(fixture.host.invoke('cloud_sync_upload', {
        config: {}, zipPath: '/nonexistent/backup.zip',
      })).rejects.toEqual({
        error_type: 'FileSystem',
        message: '创建数据治理跨进程锁目录失败 "/x": EACCES',
        details: null,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps the primary error when the guard release throws', async () => {
    const fixture = await createCommandHost({
      env: { DEVICE_ID },
      guard: kind => ({
        snapshot: {
          operation_id: `op-${kind}`, kind, started_at: '2026-01-01T00:00:00Z', process_id: 1,
        },
        operationId: () => `op-${kind}`,
        release: () => { throw new Error('release failed'); },
      }),
    });
    try {
      await expect(fixture.host.invoke('cloud_sync_upload', {
        config: {}, zipPath: '/nonexistent/backup.zip',
      })).rejects.toEqual({ error_type: 'Validation', message: '缺少 WebDAV 配置', details: null });
    } finally {
      await fixture.dispose();
    }
  });

  it('acquires before createStorage and releases on config failure', async () => {
    const log: string[] = [];
    const fixture = await createCommandHost({ env: { DEVICE_ID }, guard: guardSpy(log) });
    try {
      await expect(fixture.host.invoke('cloud_sync_upload', {
        config: {}, zipPath: '/nonexistent/backup.zip',
      })).rejects.toEqual({ error_type: 'Validation', message: '缺少 WebDAV 配置', details: null });
      expect(log).toEqual(['acquire:backup', 'release:backup']);

      log.length = 0;
      await expect(fixture.host.invoke('cloud_sync_download', {
        config: {}, localDir: '/nonexistent/download',
      })).rejects.toEqual({ error_type: 'Validation', message: '缺少 WebDAV 配置', details: null });
      expect(log).toEqual(['acquire:restore', 'release:restore']);

      log.length = 0;
      await expect(fixture.host.invoke('cloud_sync_delete_version', {
        config: {}, versionId: 'v1',
      })).rejects.toEqual({ error_type: 'Validation', message: '缺少 WebDAV 配置', details: null });
      expect(log).toEqual(['acquire:prune', 'release:prune']);
    } finally {
      await fixture.dispose();
    }
  });

  it('releases after a successful download and emits progress with the guard operation id', async () => {
    const server = await davWithManifest(false);
    const log: string[] = [];
    const fixture = await createCommandHost({ env: { DEVICE_ID }, guard: guardSpy(log) });
    const localDir = await tempDir('download-success-');
    try {
      const result = await fixture.host.invoke<{ localPath: string; version: { id: string } }>('cloud_sync_download', {
        config: webdavConfig(server.endpoint),
        localDir,
      });
      expect(result.version.id).toBe('v1');
      expect((await readFile(result.localPath)).equals(PAYLOAD)).toBe(true);
      expect(log).toEqual(['acquire:restore', 'release:restore']);
      const events = fixture.host.eventsNamed('cloud-sync-progress') as Array<Record<string, unknown>>;
      expect(events[0]).toMatchObject({ operationId: 'op-restore', operation: 'download', stage: 'transferring' });
      expect(events.at(-1)).toMatchObject({ operationId: 'op-restore', operation: 'download', stage: 'done' });
      expect(events.every(event => event.operationId === 'op-restore')).toBe(true);
    } finally {
      await fixture.dispose();
      await server.close();
    }
  });

  it('keeps unknown provider TypeErrors as kernel panics, not Unknown AppErrors', async () => {
    const fixture = await createCommandHost({
      env: { DEVICE_ID },
      guard: () => { throw new TypeError('unexpected provider bug'); },
    });
    try {
      await expect(fixture.host.invoke('cloud_sync_upload', {
        config: {}, zipPath: '/nonexistent/backup.zip',
      })).rejects.toBeInstanceOf(HandlerPanic);
    } finally {
      await fixture.dispose();
    }
  });

  it('does not report a successful download when release() throws a programming error', async () => {
    const server = await davWithManifest(false);
    const fixture = await createCommandHost({
      env: { DEVICE_ID },
      guard: kind => ({
        snapshot: {
          operation_id: `op-${kind}`, kind, started_at: '2026-01-01T00:00:00Z', process_id: 1,
        },
        operationId: () => `op-${kind}`,
        release: () => { throw new TypeError('release crashed'); },
      }),
    });
    const localDir = await tempDir('download-release-typeerror-');
    try {
      await expect(fixture.host.invoke('cloud_sync_download', {
        config: webdavConfig(server.endpoint),
        localDir,
      })).rejects.toBeInstanceOf(HandlerPanic);
    } finally {
      await fixture.dispose();
      await server.close();
    }
  });

  it('tolerates an expected release IO guard error after a successful download', async () => {
    const server = await davWithManifest(false);
    const fixture = await createCommandHost({
      env: { DEVICE_ID },
      guard: kind => ({
        snapshot: {
          operation_id: `op-${kind}`, kind, started_at: '2026-01-01T00:00:00Z', process_id: 1,
        },
        operationId: () => `op-${kind}`,
        release: () => { throw new OperationLockError('释放数据治理跨进程锁失败'); },
      }),
    });
    const localDir = await tempDir('download-release-io-');
    try {
      const result = await fixture.host.invoke<{ version: { id: string } }>('cloud_sync_download', {
        config: webdavConfig(server.endpoint),
        localDir,
      });
      expect(result.version.id).toBe('v1');
    } finally {
      await fixture.dispose();
      await server.close();
    }
  });

  it('returns Validation when the marker is present but the object is plaintext', async () => {
    const server = await davWithManifest(true);
    const log: string[] = [];
    const fixture = await createCommandHost({ env: { DEVICE_ID }, guard: guardSpy(log) });
    const localDir = await tempDir('download-downgrade-marker-');
    try {
      let thrown: unknown;
      try {
        await fixture.host.invoke('cloud_sync_download', {
          config: webdavConfig(server.endpoint),
          localDir,
        });
      } catch (error) { thrown = error; }
      expect(thrown).toMatchObject({ error_type: 'Validation' });
      expect((thrown as { message: string }).message.startsWith(`[${SYNC_E2EE_DOWNGRADE_REJECTED_CODE}]`)).toBe(true);
      await expect(readFile(join(localDir, 'v1.zip'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(log).toEqual(['acquire:restore', 'release:restore']);
    } finally {
      await fixture.dispose();
      await server.close();
    }
  });

  it('returns Validation when the marker was deleted but the device remembers encryption', async () => {
    const server = await davWithManifest(false);
    const log: string[] = [];
    const backup: BackupCrypto = createBackupCrypto();
    const fixture = await createCommandHost({ env: { DEVICE_ID }, guard: guardSpy(log), backup });
    const localDir = await tempDir('download-downgrade-memory-');
    try {
      const hint = new WebDavStorage(
        { endpoint: server.endpoint, username: 'student', password: 'secret' },
        ROOT,
      ).instanceBindingHint();
      await backup.encryptedRootMemory(join(fixture.host.app.dataDir, '.cloud-encrypted-roots.json'))
        .remember(backup.encryptedRootFingerprint(hint));

      let thrown: unknown;
      try {
        await fixture.host.invoke('cloud_sync_download', {
          config: webdavConfig(server.endpoint),
          localDir,
        });
      } catch (error) { thrown = error; }
      expect(thrown).toMatchObject({ error_type: 'Validation' });
      expect((thrown as { message: string }).message.startsWith(`[${SYNC_E2EE_DOWNGRADE_REJECTED_CODE}]`)).toBe(true);
      expect(log).toEqual(['acquire:restore', 'release:restore']);
    } finally {
      await fixture.dispose();
      await server.close();
    }
  });

  it('returns Configuration with the password-required code when an encrypted object has no password', async () => {
    const backup = createBackupCrypto();
    const encrypted = Buffer.from(await backup.encryptBackup(PAYLOAD, 'right-password'));
    const manifest = {
      version: 1,
      latest: 'v1',
      updatedAt: '2026-01-01T00:00:00Z',
      versions: [{
        id: 'v1',
        timestamp: '2026-01-01T00:00:00Z',
        size: encrypted.byteLength,
        checksum: sha256(encrypted),
        deviceId: DEVICE_ID,
      }],
    };
    const server = await spawnStatefulDav({
      root: ROOT,
      objects: {
        [`${ROOT}/manifests/${deviceIdShortHash(DEVICE_ID)}.json`]: JSON.stringify(manifest),
        [`${ROOT}/backups/v1.zip`]: encrypted,
      },
    });
    const fixture = await createCommandHost({ env: { DEVICE_ID }, guard: guardSpy([]), backup });
    const localDir = await tempDir('download-password-required-');
    try {
      let thrown: unknown;
      try {
        await fixture.host.invoke('cloud_sync_download', {
          config: webdavConfig(server.endpoint),
          localDir,
        });
      } catch (error) { thrown = error; }
      expect(thrown).toMatchObject({ error_type: 'Configuration' });
      expect((thrown as { message: string }).message)
        .toContain(SYNC_E2EE_PASSWORD_REQUIRED_CODE);
    } finally {
      await fixture.dispose();
      await server.close();
    }
  });
});
