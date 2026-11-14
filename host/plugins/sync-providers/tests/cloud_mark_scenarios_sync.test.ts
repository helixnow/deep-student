/** sync_scenarios_tests.rs:1078-1146, through the registered L20 deletion commands. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createLogService } from '../../../platform/log/index.ts';
import { compression } from '../../../platform/native/compression/index.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { createSecretsService } from '../../../platform/secrets/index.ts';
import settings from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import backup from '../../backup/index.ts';
import notes from '../../notes/index.ts';
import syncSupport from '../../sync-support/index.ts';
import review from '../../review/index.ts';
import { adaptTombstoneStorage, plainCodec } from '../../sync-support/api.ts';
import sync from '../../sync/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import provider from '../index.ts';
import type { RuntimeCloudStorageConfig } from '../api.ts';
import { spawnStatefulDav, type FakeDavStore } from './fake_dav_store.ts';

const cleanups: Array<() => Promise<void>> = [];
let deviceA: TestHost;
let deviceB: TestHost;
let dav: FakeDavStore;

async function createDevice(deviceId: string): Promise<TestHost> {
  const root = await mkdtemp(join(tmpdir(), 'l23-mark-scenarios-'));
  const host = await createTestHost({ app: { dataDir: root } });
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const paths = createPaths({ dataDir: root, platform: host.app.platform, env: { HOME: root, DEVICE_ID: deviceId } });
  const log = createLogService({ paths, debug: false, version: host.app.version });
  const secrets = createSecretsService({ os: paths.os, log: log.logger('secure_store'), keystore: null });
  cleanups.push(async () => {
    await host.dispose();
    storage.dispose();
    await log.close();
    await rm(root, { recursive: true, force: true });
  });
  await storage.migrations.runAll();
  host.ctx.provide('storage', storage);
  host.ctx.provide('paths', paths);
  host.ctx.provide('secrets', secrets);
  host.ctx.provide('log', log);
  host.ctx.provide('nativeCompression', compression);
  // Unexercised maintenance-state port, as in the existing realistic harness.
  // All owners used by the deletion path below are installed production plugins.
  host.ctx.provide('vfsDatabase', { isInMaintenanceMode: () => false });
  await host.install(settings);
  await host.install(backup);
  await host.install(vfsRepos);
  await host.install(notes);
  await host.install(syncSupport);
  await host.install(provider);
  await host.install(review);
  await host.install(sync);
  return host;
}

function config(): RuntimeCloudStorageConfig {
  return { provider: 'webdav', webdav: { endpoint: dav.endpoint, username: 'user', password: 'password' }, root: 'cloud' };
}

async function publishConfig(host: TestHost): Promise<void> {
  await host.ctx.cloudConfig.publish({
    config: { provider: 'webdav', webdav: { endpoint: dav.endpoint, username: 'user' }, root: 'cloud', allow_insecure: false },
    credentials: { webdavPassword: 'password' },
  });
}

async function blobManifest(host: TestHost) {
  const storage = await host.ctx.syncProvider.createStorage(config());
  return host.ctx.syncSupport.tombstones.downloadBlobTombstones(adaptTombstoneStorage(storage), plainCodec);
}

async function disposeDevices(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

afterEach(async () => {
  await dav?.close();
  await disposeDevices();
});
afterAll(disposeDevices);

describe('sync scenarios: real deletion commands and tombstone owner', () => {
  beforeEach(async () => {
    deviceA = await createDevice('device_a');
  }, 60_000);

  it('scenario_31_blob_tombstone_upload_download', async () => {
    dav = await spawnStatefulDav({ root: 'cloud' });
    await publishConfig(deviceA);
    await deviceA.invoke('data_governance_mark_blob_deleted', {
      cloudConfig: config(), hash: 'hash_abc', relativePath: 'ab/hash_abc.pdf', size: 1024,
    });
    const manifest = await blobManifest(deviceA);
    expect(Object.keys(manifest.entries)).toHaveLength(1);
    expect(Object.hasOwn(manifest.entries, 'hash_abc')).toBe(true);
    expect(manifest.entries.hash_abc!.device_id).toBe('device_a');
  });

  it('scenario_32_asset_tombstone_propagates', async () => {
    dav = await spawnStatefulDav({ root: 'cloud' });
    await publishConfig(deviceA);
    await deviceA.invoke('data_governance_mark_asset_deleted', {
      cloudConfig: config(), key: 'active/images/foo.png', size: 2048,
    });
    const storage = await deviceA.ctx.syncProvider.createStorage(config());
    const manifest = await deviceA.ctx.syncSupport.tombstones.downloadAssetTombstones(adaptTombstoneStorage(storage), plainCodec);
    expect(Object.keys(manifest.entries)).toHaveLength(1);
    expect(manifest.entries['active/images/foo.png']!.size).toBe(2048n);
  });

  it('scenario_33_tombstone_second_device_sees_deletion', async () => {
    dav = await spawnStatefulDav({ root: 'cloud' });
    await publishConfig(deviceA);
    await deviceA.invoke('data_governance_mark_blob_deleted', { cloudConfig: config(), hash: 'hash_x', size: 100 });
    // Rust's scenario has sequential A-write/B-read/B-write, not concurrent
    // application runtimes. Let the real Host lifecycle release process-global
    // owner registrations before starting B; A's separate data dir stays intact
    // until the case cleanup. No Slot mutation or replacement owner is used.
    await deviceA.dispose();
    deviceB = await createDevice('device_b');
    await publishConfig(deviceB);
    const first = await blobManifest(deviceB);
    expect(Object.hasOwn(first.entries, 'hash_x')).toBe(true);
    expect(first.entries.hash_x!.device_id).toBe('device_a');
    await deviceB.invoke('data_governance_mark_blob_deleted', { cloudConfig: config(), hash: 'hash_y', size: 200 });
    expect(Object.keys((await blobManifest(deviceB)).entries)).toHaveLength(2);
  });

  it('scenario_34_tombstone_offline_returns_error', async () => {
    dav = await spawnStatefulDav({ root: 'cloud' });
    await publishConfig(deviceA);
    await dav.close(); // Actual loopback connection failure; no replacement business implementation.
    await expect(deviceA.invoke('data_governance_mark_blob_deleted', {
      cloudConfig: config(), hash: 'hash_z', size: 100,
    })).rejects.toBeTypeOf('string');
  });
});
