import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CloudStorage, FileInfo, ListOutcome } from '../api.ts';
import type { BackupCrypto } from '../../../platform/secrets/api.ts';
import { CloudStorageBase } from '../src/traits.ts';
import { deviceIdShortHash } from '../src/device_id.ts';
import {
  CloudSyncManager,
  ENCRYPTION_MARKER_FILE,
  ENCRYPTION_MARKER_VERSION_WITH_VERIFIER,
} from '../src/sync_manager.ts';
import type { EncryptionMarker } from '../src/marker.ts';
import { MemoryStorage } from './memory_storage.ts';
import { createNativeBackupHost, type NativeBackupHost } from './native_backup_host.ts';

let fixture: NativeBackupHost | undefined;
let backup: BackupCrypto;

beforeAll(async () => {
  fixture = await createNativeBackupHost();
  backup = fixture.backup;
});

afterAll(async () => {
  await fixture?.host.dispose();
});

function managerOn(storage: CloudStorage, deviceId: string): CloudSyncManager {
  return new CloudSyncManager(storage, deviceId, { backup, encryptionMemoryPath: null });
}

/**
 * The second device already read the marker before the winner wrote: its first
 * marker GET returns the stale snapshot, every later GET passes through to the
 * shared store. This pins the lost-update window deterministically.
 */
class StaleFirstMarkerRead extends CloudStorageBase {
  private staleReadsRemaining = 1;

  private readonly inner: MemoryStorage;
  private readonly staleSnapshot: Uint8Array | null;

  constructor(
    inner: MemoryStorage,
    staleSnapshot: Uint8Array | null,
  ) { super();
    this.inner = inner;
    this.staleSnapshot = staleSnapshot; }

  override providerName(): string { return 'memory-claim-race-stale-read'; }
  override async checkConnection(): Promise<void> { await this.inner.checkConnection(); }
  override async put(key: string, data: Uint8Array): Promise<void> { await this.inner.put(key, data); }

  override async get(key: string): Promise<Uint8Array | null> {
    if (key === ENCRYPTION_MARKER_FILE && this.staleReadsRemaining > 0) {
      this.staleReadsRemaining -= 1;
      return this.staleSnapshot === null ? null : new Uint8Array(this.staleSnapshot);
    }
    return this.inner.get(key);
  }

  override async list(prefix: string): Promise<FileInfo[]> { return this.inner.list(prefix); }
  override async listOutcome(prefix: string): Promise<ListOutcome> { return this.inner.listOutcome(prefix); }
  override async delete(key: string): Promise<void> { await this.inner.delete(key); }
  override async stat(key: string): Promise<FileInfo | null> { return this.inner.stat(key); }
}

function racingManagerOn(
  storage: MemoryStorage,
  deviceId: string,
  staleSnapshot: Uint8Array | null,
): CloudSyncManager {
  return new CloudSyncManager(
    new StaleFirstMarkerRead(storage, staleSnapshot),
    deviceId,
    { backup, encryptionMemoryPath: null },
  );
}

function parsedMarker(storage: MemoryStorage): EncryptionMarker | null {
  const text = storage.text(ENCRYPTION_MARKER_FILE);
  return text === null ? null : JSON.parse(text) as EncryptionMarker;
}

async function mintV1Marker(storage: MemoryStorage): Promise<{ raw: Uint8Array; marker: EncryptionMarker }> {
  const legacy = await managerOn(storage, 'device-legacy-writer').persistEncryptionMarker();
  expect(legacy.version).toBe(1);
  expect(legacy.keyVerifier ?? null).toBeNull();
  const raw = storage.bytes(ENCRYPTION_MARKER_FILE);
  expect(raw).not.toBeNull();
  return { raw: raw!, marker: legacy };
}

async function assertCloudMarkerBoundToPassword(
  storage: MemoryStorage,
  expectedPassword: string,
  rejectedPassword: string,
): Promise<void> {
  const marker = parsedMarker(storage);
  expect(marker).not.toBeNull();
  const verifier = marker!.keyVerifier;
  expect(verifier).toBeTruthy();
  expect(await backup.checkPasswordVerifier(expectedPassword, verifier!)).toBe(true);
  expect(await backup.checkPasswordVerifier(rejectedPassword, verifier!)).toBe(false);
}

async function settle(promise: Promise<unknown>): Promise<Error | null> {
  return promise.then(() => null).catch((error: Error) => error);
}

describe('e2ee_claim_race_tests.rs', () => {
  it('race_empty_root_concurrent_claim_with_two_passwords_at_most_one_succeeds', async () => {
    const storage = new MemoryStorage();
    expect(storage.bytes(ENCRYPTION_MARKER_FILE)).toBeNull();

    // B finished its state read before A wrote: it holds the Absent snapshot.
    const deviceB = racingManagerOn(storage, 'device-b', null);

    const deviceA = managerOn(storage, 'device-a');
    const claimedByA = await deviceA.verifyEncryptionPasswordBeforeUpload('pw-alpha-2026');
    expect(claimedByA.version).toBe(ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
    expect(claimedByA.createdByDevice).toBe(deviceIdShortHash('device-a'));

    const bResult = await settle(deviceB.verifyEncryptionPasswordBeforeUpload('pw-beta-2026'));
    expect(bResult, '空仓双口令并发认领必须至多一个成功').not.toBeNull();

    await assertCloudMarkerBoundToPassword(storage, 'pw-alpha-2026', 'pw-beta-2026');
    expect(parsedMarker(storage)!.createdByDevice).toBe(deviceIdShortHash('device-a'));

    await deviceA.verifyEncryptionPasswordBeforeUpload('pw-alpha-2026');
    expect(await settle(managerOn(storage, 'device-b').verifyEncryptionPasswordBeforeUpload('pw-beta-2026')))
      .not.toBeNull();
  });

  it('race_second_device_must_not_overwrite_existing_marker', async () => {
    const storage = new MemoryStorage();
    const deviceB = racingManagerOn(storage, 'device-b', null);

    const deviceA = managerOn(storage, 'device-a');
    await deviceA.verifyEncryptionPasswordBeforeUpload('pw-alpha-2026');
    const markerAfterA = storage.bytes(ENCRYPTION_MARKER_FILE);
    expect(markerAfterA).not.toBeNull();

    const bResult = await settle(deviceB.persistEncryptionMarker());

    const markerAfterB = storage.bytes(ENCRYPTION_MARKER_FILE);
    expect(markerAfterB, `B 的调用返回: ${bResult?.message ?? 'Ok'}`).not.toBeNull();
    expect(Buffer.from(markerAfterB!).equals(Buffer.from(markerAfterA!))).toBe(true);

    const finalMarker = parsedMarker(storage)!;
    expect(finalMarker.version).toBe(ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
    await assertCloudMarkerBoundToPassword(storage, 'pw-alpha-2026', 'pw-beta-2026');

    expect(await settle(managerOn(storage, 'device-c').verifyEncryptionPasswordBeforeUpload('pw-anything-else')))
      .not.toBeNull();
  });

  it('race_v1_to_v2_upgrade_must_not_let_both_devices_win', async () => {
    const storage = new MemoryStorage();
    const { raw: v1Bytes, marker: legacy } = await mintV1Marker(storage);

    const deviceB = racingManagerOn(storage, 'device-b', v1Bytes);

    const deviceA = managerOn(storage, 'device-a');
    const upgradedByA = await deviceA.verifyEncryptionPasswordBeforeUpload('pw-alpha-2026');
    expect(upgradedByA.version).toBe(ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);

    const bResult = await settle(deviceB.verifyEncryptionPasswordBeforeUpload('pw-beta-2026'));
    expect(bResult, 'v1→v2 升级不得两台设备同时成功').not.toBeNull();

    await assertCloudMarkerBoundToPassword(storage, 'pw-alpha-2026', 'pw-beta-2026');
    const finalMarker = parsedMarker(storage)!;
    expect(finalMarker.createdByDevice).toBe(deviceIdShortHash('device-legacy-writer'));
    expect(finalMarker.createdAt).toBe(legacy.createdAt);

    await deviceA.verifyEncryptionPasswordBeforeUpload('pw-alpha-2026');
    expect(await settle(managerOn(storage, 'device-b').verifyEncryptionPasswordBeforeUpload('pw-beta-2026')))
      .not.toBeNull();
  });

  it('race_v1_to_v2_upgrade_same_password_writes_marker_at_most_once', async () => {
    const storage = new MemoryStorage();
    const { raw: v1Bytes } = await mintV1Marker(storage);

    storage.putLog = [];

    const deviceB = racingManagerOn(storage, 'device-b', v1Bytes);

    const deviceA = managerOn(storage, 'device-a');
    await deviceA.verifyEncryptionPasswordBeforeUpload('shared-team-pw');

    const bResult = await settle(deviceB.verifyEncryptionPasswordBeforeUpload('shared-team-pw'));

    const markerPuts = storage.putLog.filter(key => key === ENCRYPTION_MARKER_FILE).length;
    expect(markerPuts, `B 的调用返回: ${bResult?.message ?? 'Ok'}`).toBeLessThanOrEqual(1);

    const finalMarker = parsedMarker(storage)!;
    expect(finalMarker.version).toBe(ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
    expect(await backup.checkPasswordVerifier('shared-team-pw', finalMarker.keyVerifier!)).toBe(true);
  });
});
