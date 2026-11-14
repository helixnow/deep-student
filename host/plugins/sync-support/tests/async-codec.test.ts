import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import type { FileCipherSession } from '../../../platform/secrets/api.ts';
import type { AsyncPayloadCodec, PayloadCodec, SyncPayloadCodec } from '../api.ts';
import { plainCodec } from '../api.ts';
import { MemoryStorage } from './memory-storage.ts';
import { serviceHost } from './service-host.ts';

const ports = [
  { kind: 'blob', upload: 'uploadBlobTombstones', download: 'downloadBlobTombstones', after: 'downloadBlobTombstonesAfter', device: 'downloadBlobTombstonesForDevice', key: 'blobDeviceTombstoneKey', legacy: 'blobDeviceTombstoneLegacyKey', global: 'LEGACY_BLOB_TOMBSTONE_KEY' },
  { kind: 'asset', upload: 'uploadAssetTombstones', download: 'downloadAssetTombstones', after: 'downloadAssetTombstonesAfter', device: 'downloadAssetTombstonesForDevice', key: 'assetDeviceTombstoneKey', legacy: 'assetDeviceTombstoneLegacyKey', global: 'LEGACY_ASSET_TOMBSTONE_KEY' },
  { kind: 'workspace', upload: 'uploadWorkspaceTombstones', download: 'downloadWorkspaceTombstones', after: 'downloadWorkspaceTombstonesAfter', device: 'downloadWorkspaceTombstonesForDevice', key: 'workspaceDeviceTombstoneKey', legacy: 'workspaceDeviceTombstoneLegacyKey', global: 'LEGACY_WS_TOMBSTONE_KEY' },
] as const;
const manifest = { entries: { object: { device_id: 'device-a', deleted_at: '2026-08-01T00:00:00Z' } }, updated_at: '' };
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const backup = createBackupCrypto();
let cipher: FileCipherSession;
let wrongCipher: FileCipherSession;
beforeAll(async () => {
  cipher = await backup.createFileCipherSession('sync-support-encrypted-tombstones');
  wrongCipher = await backup.createFileCipherSession('incorrect-password');
}, 30_000);
afterAll(() => { cipher?.dispose(); wrongCipher?.dispose(); });

/** Delegates every successful operation to the real F4 Promise-based DSBK session. */
function encryptedCodec(trace: string[], rejectAt?: string, failure = new Error('codec failure')): AsyncPayloadCodec {
  return {
    async encode(data) {
      const label = JSON.parse(Buffer.from(data).toString()).payload_hash ? 'event' : 'manifest';
      trace.push(`encode:${label}`);
      await Promise.resolve();
      if (rejectAt === `encode:${label}`) throw failure;
      const result = await cipher.encryptBytes(data);
      trace.push(`encoded:${label}`);
      return result;
    },
    async decode(data) {
      trace.push('decode');
      await Promise.resolve();
      if (rejectAt === 'decode') throw failure;
      const result = await cipher.decryptBytes(data);
      trace.push('decoded');
      return result;
    },
  };
}

class EncryptedStorage extends MemoryStorage {
  readonly trace: string[];
  constructor(trace: string[]) { super(); this.trace = trace; }
  override async put(key: string, data: Uint8Array) {
    expect(data).toBeInstanceOf(Uint8Array);
    expect(backup.isEncryptedBackup(data)).toBe(true);
    this.trace.push(`put:${key}`);
    return super.put(key, data);
  }
  override async get(key: string) { this.trace.push(`get:${key}`); return super.get(key); }
  override async delete(key: string) { this.trace.push(`delete:${key}`); return super.delete(key); }
}

describe('async PayloadCodec through the installed tombstone service', () => {
  it('keeps synchronous decoding available and accepts F4 Promise codec types', async () => {
    expectTypeOf(plainCodec).toExtend<SyncPayloadCodec>();
    expectTypeOf<AsyncPayloadCodec>().toExtend<PayloadCodec>();
    const h = await serviceHost();
    try {
      const sync = h.service.tombstones.decodeTombstoneFile(plainCodec, bytes(manifest), 'blob');
      expectTypeOf(sync).toEqualTypeOf<unknown>();
      expect(sync).toEqual(manifest);
      const encoded = await cipher.encryptBytes(bytes(manifest));
      const decoded = h.service.tombstones.decodeTombstoneFile(encryptedCodec([]), encoded, 'blob');
      await expect(decoded).resolves.toEqual(manifest);
    } finally { await h.dispose(); }
  });

  for (const p of ports) {
    it(`${p.kind}: DSBK event → verification → manifest → readback → legacy deletion, all read ports`, async () => {
      const h = await serviceHost();
      const trace: string[] = [];
      const storage = new EncryptedStorage(trace);
      const codec = encryptedCodec(trace);
      const t = h.service.tombstones;
      const key = t[p.key]('device-a');
      const legacy = t[p.legacy]('device-a');
      storage.files.set(legacy, await cipher.encryptBytes(bytes(manifest)));
      try {
        await t[p.upload](storage, codec, 'device-a', manifest);
        const eventKey = storage.puts[0]!;
        expect(eventKey).toContain('/tombstone-events/');
        expect(storage.puts).toEqual([eventKey, key]);
        expect(trace).toEqual([
          `get:${eventKey}`, 'encode:event', 'encoded:event', `put:${eventKey}`, `get:${eventKey}`,
          'decode', 'decoded', 'encode:manifest', 'encoded:manifest', `put:${key}`, `get:${key}`, `delete:${legacy}`,
        ]);
        expect(storage.files.has(legacy)).toBe(false);
        await expect(t[p.device](storage, codec, 'device-a')).resolves.toMatchObject({ entries: manifest.entries });
        await expect(t[p.download](storage, codec)).resolves.toMatchObject({ entries: manifest.entries });
        const [downloaded, advances] = await t[p.after](storage, codec, () => 0n);
        expect(downloaded.entries).toMatchObject(manifest.entries);
        expect(advances).toContainEqual({ source_device_id: 'event:device-a', last_applied_offset: 1n });
        await t[p.upload](storage, codec, 'device-a', manifest);
        expect(storage.puts.filter(k => k === eventKey)).toHaveLength(1);

        // Encrypted legacy per-device fallback and global manifest reads.
        const encryptedManifest = storage.files.get(key)!;
        storage.files.delete(key);
        storage.files.set(legacy, encryptedManifest);
        await expect(t[p.device](storage, codec, 'device-a')).resolves.toMatchObject({ entries: manifest.entries });
        storage.files.clear();
        storage.files.set(t[p.global], encryptedManifest);
        await expect(t[p.download](storage, codec)).resolves.toMatchObject({ entries: manifest.entries });
        const [old, oldAdvances] = await t[p.after](storage, codec, () => 0n);
        expect(old.entries).toMatchObject(manifest.entries);
        expect(oldAdvances[0]?.source_device_id).toBe('legacy');
      } finally { await h.dispose(); }
    });

    for (const stage of ['encode:event', 'decode', 'encode:manifest'] as const) {
      it(`${p.kind}: rejected ${stage} aborts subsequent publication and keeps legacy`, async () => {
        const h = await serviceHost();
        const trace: string[] = [];
        const storage = new EncryptedStorage(trace);
        const failure = new Error(`rejected ${stage}`);
        const t = h.service.tombstones;
        const legacy = t[p.legacy]('device-a');
        storage.files.set(legacy, await cipher.encryptBytes(bytes(manifest)));
        try {
          await expect(t[p.upload](storage, encryptedCodec(trace, stage, failure), 'device-a', manifest)).rejects.toBe(failure);
          expect(storage.puts).toHaveLength(stage === 'encode:event' ? 0 : 1);
          expect(storage.files.has(t[p.key]('device-a'))).toBe(false);
          expect(storage.files.has(legacy)).toBe(true);
          if (stage === 'decode') expect(trace).not.toContain('encode:manifest');
        } finally { await h.dispose(); }
      });
    }

    it(`${p.kind}: existing-event verification and event downloads propagate decoder rejection`, async () => {
      const h = await serviceHost();
      const storage = new EncryptedStorage([]);
      const t = h.service.tombstones;
      const failure = new Error('event decryption failed');
      try {
        await t[p.upload](storage, encryptedCodec([]), 'device-a', manifest);
        storage.files.delete(t[p.key]('device-a'));
        const putsBefore = [...storage.puts];
        await expect(t[p.upload](storage, encryptedCodec([], 'decode', failure), 'device-a', manifest)).rejects.toBe(failure);
        expect(storage.puts).toEqual(putsBefore);
        await expect(t[p.after](storage, encryptedCodec([], 'decode', failure), () => 0n)).rejects.toBe(failure);
        await expect(t[p.download](storage, encryptedCodec([], 'decode', failure))).rejects.toBe(failure);
      } finally { await h.dispose(); }
    });

    it(`${p.kind}: encrypted manifest readback mismatch still fails before deleting legacy`, async () => {
      const h = await serviceHost();
      const storage = new EncryptedStorage([]);
      const t = h.service.tombstones;
      const legacy = t[p.legacy]('device-a');
      storage.files.set(legacy, await cipher.encryptBytes(bytes(manifest)));
      storage.behavior = 'corrupt-manifest';
      try {
        await expect(t[p.upload](storage, encryptedCodec([]), 'device-a', manifest)).rejects.toThrow('上传后回读不一致');
        expect(storage.files.has(legacy)).toBe(true);
      } finally { await h.dispose(); }
    });

    it(`${p.kind}: real DSBK wrong password is a manifest decryption failure, never an empty result`, async () => {
      const h = await serviceHost();
      const storage = new MemoryStorage();
      const t = h.service.tombstones;
      const codec: AsyncPayloadCodec = {
        encode: data => wrongCipher.encryptBytes(data), decode: data => wrongCipher.decryptBytes(data),
      };
      storage.files.set(t[p.global], await cipher.encryptBytes(bytes(manifest)));
      try {
        await expect(t[p.after](storage, codec, () => 0n)).rejects.toThrow(
          `Database error: legacy ${p.kind} tombstone 清单无法解密，已停止同步（请检查加密密码）:`,
        );
        expect(storage.puts).toEqual([]);
      } finally { await h.dispose(); }
    });
  }

  it('asynchronously decrypted invalid JSON retains the corruption context, not the decryption context', async () => {
    const h = await serviceHost();
    try {
      const encoded = await cipher.encryptBytes(Buffer.from('{invalid'));
      await expect(h.service.tombstones.decodeTombstoneFile(encryptedCodec([]), encoded, 'blob'))
        .rejects.toThrow('Database error: blob tombstone 清单损坏，已停止同步且未推进水位:');
    } finally { await h.dispose(); }
  });
});
