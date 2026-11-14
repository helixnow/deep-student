/** P04: the two production lease protocols must use their Rust serde structs. */
import { describe, expect, it, vi } from 'vitest';
import {
  BACKUP_REPO_LEASE_PREFIX,
  SYNC_TARGET_LEASE_PREFIX,
  acquireBackupRepoLeaseWithTtl,
  acquireSyncTargetLeaseWithTtl,
} from '../api.ts';
import { chronoAutoSiUtc } from '../src/time.ts';
import { MemoryStorage } from './memory_storage.ts';

const TTL = 600_000;
const OPERATION_ID = '00000000-0000-4000-8000-000000000004';
const protocols = [
  { label: 'SyncTargetLease', prefix: SYNC_TARGET_LEASE_PREFIX, target: 'data_governance', acquire: acquireSyncTargetLeaseWithTtl,
    verifyPrefix: '回验同步租约内容失败', releasePrefix: '释放同步租约前解析失败', renewPrefix: '同步租约在持有期间损坏' },
  { label: 'BackupRepoLease', prefix: BACKUP_REPO_LEASE_PREFIX, target: 'backup-v2', acquire: acquireBackupRepoLeaseWithTtl,
    verifyPrefix: '回验备份仓库租约内容失败', releasePrefix: '释放备份仓库租约前解析失败', renewPrefix: '备份仓库租约在持有期间损坏' },
];

function expiredRecord(target: string, now: number) {
  return {
    format_version: 1,
    target,
    holder_device_id: 'device-old',
    operation_id: OPERATION_ID,
    created_at: chronoAutoSiUtc(now - 3 * TTL),
    expires_at: chronoAutoSiUtc(now - 2 * TTL),
    activation_committed: true,
  };
}

const invalidInputs = [
  { label: 'u32 float token', bytes: (raw: string) => Buffer.from(raw.replace('"format_version":1', '"format_version":1.0')) },
  { label: 'u32 exponent token', bytes: (raw: string) => Buffer.from(raw.replace('"format_version":1', '"format_version":1e0')) },
  { label: 'duplicate known field', bytes: (raw: string) => Buffer.from(raw.replace('"format_version":1', '"format_version":1,"format_version":1')) },
  { label: 'null is not a missing default bool', bytes: (raw: string) => Buffer.from(raw.replace('"activation_committed":true', '"activation_committed":null')) },
  { label: 'invalid UTF-8 in a known string', bytes: (raw: string) => {
    const bytes = Buffer.from(raw);
    bytes[bytes.indexOf('device-old')] = 0xff;
    return bytes;
  } },
];

describe.each(protocols)('$label serde through the public lease protocol', protocol => {
  it.each(invalidInputs)('keeps a fresh corrupted contender: $label', async input => {
    const now = Date.now();
    const storage = new MemoryStorage();
    const key = `${protocol.prefix.replace(/\/$/, '')}/${OPERATION_ID}.json`;
    storage.putAt(key, input.bytes(JSON.stringify(expiredRecord(protocol.target, now))), now - 1000);

    // Rust scan_active_leases: from_slice.ok().filter(structurally_valid).
    // These invalid bytes have no trustworthy expiry; the fresh provider mtime
    // must keep them active, not allow their embedded expired time to reclaim.
    const outcome = await protocol.acquire(storage, 'device-new', TTL).then(
      async guard => { await guard.release(); return null; },
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({
      message: expect.stringContaining('未知设备（租约内容损坏）'),
      value: { error_type: 'Conflict' },
    });
    expect(storage.files.has(key)).toBe(true);
    expect(storage.deleted).not.toContain(key);
  });

  it('defaults a missing activation_committed to false and ignores repeated unknown fields', async () => {
    const now = Date.now();
    const record = expiredRecord(protocol.target, now);
    const raw = JSON.stringify(record).replace(',"activation_committed":true', '');
    const bytes = Buffer.from(`${raw.slice(0, -1)},"extra":1,"extra":2}`);
    const storage = new MemoryStorage();
    const key = `${protocol.prefix.replace(/\/$/, '')}/${OPERATION_ID}.json`;
    storage.putAt(key, bytes, now - 1000);
    const guard = await protocol.acquire(storage, 'device-new', TTL);
    try { expect(storage.files.has(key)).toBe(false); }
    finally { await guard.release(); }
  });

  it('accepts the derive struct sequence form', async () => {
    const now = Date.now();
    const storage = new MemoryStorage();
    const key = `${protocol.prefix.replace(/\/$/, '')}/${OPERATION_ID}.json`;
    storage.putAt(key, Buffer.from(JSON.stringify(Object.values(expiredRecord(protocol.target, now)))), now - 1000);
    const guard = await protocol.acquire(storage, 'device-new', TTL);
    try { expect(storage.files.has(key)).toBe(false); }
    finally { await guard.release(); }
  });

  it('ignores invalid UTF-8 inside an unknown IgnoredAny string', async () => {
    const now = Date.now();
    const raw = JSON.stringify({ ...expiredRecord(protocol.target, now), extension: 'opaque' });
    const bytes = Buffer.from(raw);
    bytes[bytes.indexOf('opaque')] = 0xff;
    const storage = new MemoryStorage();
    const key = `${protocol.prefix.replace(/\/$/, '')}/${OPERATION_ID}.json`;
    storage.putAt(key, bytes, now - 1000);
    const guard = await protocol.acquire(storage, 'device-new', TTL);
    try { expect(storage.files.has(key)).toBe(false); }
    finally { await guard.release(); }
  });

  it('reports the Rust bool error and position when write readback is corrupted', async () => {
    class NullBoolReadbackStorage extends MemoryStorage {
      override async get(key: string): Promise<Uint8Array | null> {
        const bytes = await super.get(key);
        return bytes === null ? null : Buffer.from(Buffer.from(bytes).toString('utf8')
          .replace('"activation_committed": false', '"activation_committed": null'));
      }
    }
    const storage = new NullBoolReadbackStorage();
    const outcome = await protocol.acquire(storage, 'device-new', TTL).then(
      async guard => { await guard.release(); return null; },
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({
      message: `${protocol.verifyPrefix}: invalid type: null, expected a boolean at line 8 column 30`,
      value: { error_type: 'Network' },
    });
  });

  it('does not release a lease whose bool field became corrupt', async () => {
    const storage = new MemoryStorage();
    const guard = await protocol.acquire(storage, 'device-new', TTL);
    const original = storage.bytes(guard.key)!;
    try {
      await storage.put(guard.key, Buffer.from(Buffer.from(original).toString('utf8')
        .replace('"activation_committed": true', '"activation_committed": null')));
      await expect(guard.release()).rejects.toMatchObject({
        message: `${protocol.releasePrefix}: invalid type: null, expected a boolean at line 8 column 30`,
        value: { error_type: 'Network' },
      });
      expect(storage.files.has(guard.key)).toBe(true);
    } finally {
      await storage.put(guard.key, original);
      await guard.release();
    }
  });

  it('records the serde parse error when heartbeat readback becomes corrupt', async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const guard = await protocol.acquire(storage, 'device-new', 900);
      const original = storage.bytes(guard.key)!;
      try {
        await storage.put(guard.key, Buffer.from(Buffer.from(original).toString('utf8')
          .replace('"activation_committed": true', '"activation_committed": null')));
        await vi.advanceTimersByTimeAsync(300);
        expect(guard.heartbeatFailure()).toMatchObject({
          message: `${protocol.renewPrefix}: invalid type: null, expected a boolean at line 8 column 30`,
          value: { error_type: 'Conflict' },
        });
      } finally {
        await storage.put(guard.key, original);
        await guard.release();
      }
    } finally { vi.useRealTimers(); }
  });
});
