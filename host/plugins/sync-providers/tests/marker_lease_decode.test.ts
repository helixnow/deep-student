/**
 * [R4-P04] `.encryption-marker` and its claim lease are decoded like
 * `serde_json::from_slice::<EncryptionMarker>` / `::<EncryptionClaimLease>`
 * (sync_manager.rs:162-174, 878-925; e2ee_claim.rs:137-181, 336-338;
 * backup_crypto.rs:908-923), not by `JSON.parse` + cast.
 *
 * Every case goes through a production entry: `CloudSyncManager` marker reads,
 * `claimEncryptionMarker`'s lease gate, and the repository check.
 */

import './local-fs-fixture.ts';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { claimEncryptionMarker, ENCRYPTION_MARKER_LEASE_SUFFIX, SYNC_E2EE_CLAIM_CONFLICT_CODE } from '../src/e2ee_claim.ts';
import { setDefaultLogSink, type LogSink } from '../src/logging.ts';
import { runRepoCheck } from '../src/repo_check.ts';
import { SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE } from '../src/mod.ts';
import { CloudSyncManager, ENCRYPTION_MARKER_FILE } from '../src/sync_manager.ts';
import { chronoAutoSiZ } from '../src/time.ts';
import { MemoryStorage } from './memory_storage.ts';

const backup = createBackupCrypto();
const LEASE_KEY = `${ENCRYPTION_MARKER_FILE}${ENCRYPTION_MARKER_LEASE_SUFFIX}`;
const VERIFIER = '{"kdf":"argon2id","mCost":19456,"tCost":2,"pCost":1,"salt":"00","digest":"11"}';

const noop = (): void => undefined;
afterEach(() => { setDefaultLogSink({ error: noop, warn: noop, info: noop, debug: noop }); });

function recordWarnings(): string[] {
  const warnings: string[] = [];
  const sink: LogSink = { error: noop, info: noop, debug: noop, warn: message => { warnings.push(message); } };
  setDefaultLogSink(sink);
  return warnings;
}

async function managerWithMarker(text: string | Uint8Array): Promise<CloudSyncManager> {
  const storage = new MemoryStorage();
  await storage.put(ENCRYPTION_MARKER_FILE, typeof text === 'string' ? Buffer.from(text, 'utf8') : text);
  return new CloudSyncManager(storage, 'device-a', { backup, encryptionMemoryPath: null });
}

/** `read_encryption_marker` maps Corrupted to `version: 0, created_by_device: "unknown"`. */
async function readMarker(text: string | Uint8Array) {
  return (await managerWithMarker(text)).readEncryptionMarker();
}

describe('EncryptionMarker serde decode through CloudSyncManager.readEncryptionMarker', () => {
  it('decodes every field and normalizes created_at like chrono DateTime<Utc>', async () => {
    const marker = await readMarker(
      `{"version":2,"createdByDevice":"dev","createdAt":"2026-01-01T08:00:00.5+08:00","keyVerifier":${VERIFIER}}`);
    expect(marker).toEqual({
      version: 2,
      createdByDevice: 'dev',
      createdAt: '2026-01-01T00:00:00.500Z',
      keyVerifier: { kdf: 'argon2id', mCost: 19456, tCost: 2, pCost: 1, salt: '00', digest: '11' },
    });
  });

  it('treats an absent or null key_verifier as None (#[serde(default)] Option)', async () => {
    const absent = await readMarker('{"version":1,"createdByDevice":"dev","createdAt":"2026-01-01T00:00:00Z"}');
    expect(absent).toEqual({ version: 1, createdByDevice: 'dev', createdAt: '2026-01-01T00:00:00Z', keyVerifier: null });
    const explicitNull = await readMarker(
      '{"version":1,"createdByDevice":"dev","createdAt":"2026-01-01T00:00:00Z","keyVerifier":null}');
    expect(explicitNull?.keyVerifier).toBeNull();
    expect(explicitNull?.version).toBe(1);
  });

  it('ignores unknown fields, including __proto__ and duplicated unknown keys', async () => {
    const marker = await readMarker(
      '{"__proto__":{"version":9},"extra":1,"extra":2,"version":1,"createdByDevice":"dev","createdAt":"2026-01-01T00:00:00Z"}');
    expect(marker).toEqual({ version: 1, createdByDevice: 'dev', createdAt: '2026-01-01T00:00:00Z', keyVerifier: null });
  });

  it('accepts the serde seq form in declaration order, defaulting the trailing key_verifier', async () => {
    const marker = await readMarker('[1,"dev","2026-01-01T00:00:00Z"]');
    expect(marker).toEqual({ version: 1, createdByDevice: 'dev', createdAt: '2026-01-01T00:00:00Z', keyVerifier: null });
  });

  it.each([
    ['u32 written as 1.0', '{"version":1.0,"createdByDevice":"dev","createdAt":"2026-01-01T00:00:00Z"}', 'invalid type: floating point `1.0`, expected u32'],
    ['u32 out of range', '{"version":4294967296,"createdByDevice":"dev","createdAt":"2026-01-01T00:00:00Z"}', 'invalid value: integer `4294967296`, expected u32'],
    ['negative u32', '{"version":-1,"createdByDevice":"dev","createdAt":"2026-01-01T00:00:00Z"}', 'expected u32'],
    ['duplicate known field', '{"version":1,"version":1,"createdByDevice":"dev","createdAt":"2026-01-01T00:00:00Z"}', 'duplicate field `version`'],
    ['missing created_by_device', '{"version":1,"createdAt":"2026-01-01T00:00:00Z"}', 'missing field `createdByDevice`'],
    ['created_at is not RFC 3339', '{"version":1,"createdByDevice":"dev","createdAt":"2026-01-01"}', 'createdAt'],
    ['created_by_device is a number', '{"version":1,"createdByDevice":7,"createdAt":"2026-01-01T00:00:00Z"}', 'invalid type: integer `7`, expected a string'],
    ['verifier misses a field', '{"version":2,"createdByDevice":"dev","createdAt":"2026-01-01T00:00:00Z","keyVerifier":{"kdf":"argon2id","mCost":1,"tCost":1,"pCost":1,"salt":"00"}}', 'missing field `digest`'],
    ['verifier m_cost is a float', '{"version":2,"createdByDevice":"dev","createdAt":"2026-01-01T00:00:00Z","keyVerifier":{"kdf":"argon2id","mCost":1.5,"tCost":1,"pCost":1,"salt":"00","digest":"11"}}', 'expected u32'],
    ['verifier is a string', '{"version":2,"createdByDevice":"dev","createdAt":"2026-01-01T00:00:00Z","keyVerifier":"x"}', 'expected struct PasswordVerifier'],
    ['root is a string', '"marker"', 'expected struct EncryptionMarker'],
    ['seq form too short', '[1,"dev"]', 'invalid length 2, expected struct EncryptionMarker with 4 elements'],
    ['trailing characters', '{"version":1,"createdByDevice":"dev","createdAt":"2026-01-01T00:00:00Z"} x', 'trailing characters'],
  ])('%s is Corrupted (fail-closed) and logs the serde error', async (_name, text, detail) => {
    const warnings = recordWarnings();
    const marker = await readMarker(text);
    expect(marker?.version).toBe(0);
    expect(marker?.createdByDevice).toBe('unknown');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`云端加密标记 ${ENCRYPTION_MARKER_FILE} 内容无法解析，按存在处理: `);
    expect(warnings[0]).toContain(detail);
  });

  it('rejects a UTF-8 BOM and invalid UTF-8 like serde_json::from_slice', async () => {
    const body = Buffer.from('{"version":1,"createdByDevice":"dev","createdAt":"2026-01-01T00:00:00Z"}', 'utf8');
    expect((await readMarker(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])))?.version).toBe(0);
    expect((await readMarker(Buffer.from([0x7b, 0xff, 0x7d])))?.version).toBe(0);
  });

  it('blocks plaintext upload for a corrupted marker exactly as for a valid one', async () => {
    const manager = await managerWithMarker('{"version":1.0,"createdByDevice":"dev","createdAt":"2026-01-01T00:00:00Z"}');
    const error = await manager.ensurePlaintextUploadAllowed().then(() => null, (caught: unknown) => caught as Error);
    expect(error?.message).toContain(SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE);
  });
});

describe('EncryptionMarker serde decode in the repository check (repo_check.rs:394)', () => {
  it('reports corruptEncryptionMarker for a 1.0 version but not for an unknown extra field', async () => {
    const corrupt = new MemoryStorage();
    await corrupt.put(ENCRYPTION_MARKER_FILE,
      Buffer.from('{"version":1.0,"createdByDevice":"dev","createdAt":"2026-01-01T00:00:00Z"}'));
    const corruptReport = await runRepoCheck(corrupt);
    expect(corruptReport.problems.map(problem => problem.kind)).toContain('corruptEncryptionMarker');

    const valid = new MemoryStorage();
    await valid.put(ENCRYPTION_MARKER_FILE,
      Buffer.from('{"version":1,"createdByDevice":"dev","createdAt":"2026-01-01T00:00:00Z","extra":true}'));
    const validReport = await runRepoCheck(valid);
    expect(validReport.problems.map(problem => problem.kind)).not.toContain('corruptEncryptionMarker');
  });
});

function leaseText(fields: Record<string, unknown>): string {
  return JSON.stringify({
    format_version: 1,
    device_id: 'holder',
    nonce: randomUUID(),
    created_at: chronoAutoSiZ(Date.now()),
    expires_at: chronoAutoSiZ(Date.now() + 60_000),
    ...fields,
  });
}

async function claimWithLease(lease: string): Promise<{ storage: MemoryStorage; error: Error | null }> {
  const storage = new MemoryStorage();
  await storage.put(LEASE_KEY, Buffer.from(lease, 'utf8'));
  try {
    await claimEncryptionMarker(storage, {
      markerKey: ENCRYPTION_MARKER_FILE,
      deviceIdShort: 'claimer',
      ttlMs: 60_000,
      expectation: 'Absent',
      buildMarker: () => Buffer.from('{"version":1,"createdByDevice":"claimer","createdAt":"2026-01-01T00:00:00Z"}'),
    });
    return { storage, error: null };
  } catch (error) {
    return { storage, error: error as Error };
  }
}

describe('EncryptionClaimLease serde decode through claimEncryptionMarker (e2ee_claim.rs:336-338)', () => {
  it('a valid live lease names its holder', async () => {
    const { error } = await claimWithLease(leaseText({}));
    expect(error?.message).toContain(SYNC_E2EE_CLAIM_CONFLICT_CODE);
    expect(error?.message).toContain('云端加密标记正被其他设备认领：holder（');
  });

  it('accepts every uuid::Uuid::parse_str nonce form and unknown fields', async () => {
    const plain = randomUUID();
    for (const nonce of [plain.replaceAll('-', ''), `{${plain}}`, `urn:uuid:${plain}`]) {
      const { error } = await claimWithLease(leaseText({ nonce, unknown_field: [1, 2] }));
      expect(error?.message).toContain('正被其他设备认领：holder（');
    }
  });

  it.each([
    ['format_version written as 1.0', (base: string) => base.replace('"format_version":1', '"format_version":1.0')],
    ['duplicate device_id', (base: string) => base.replace('"device_id":"holder"', '"device_id":"holder","device_id":"holder"')],
    ['missing nonce', (base: string) => base.replace(/"nonce":"[^"]+",/, '')],
    ['format_version is a string', (base: string) => base.replace('"format_version":1', '"format_version":"1"')],
    ['created_at is not RFC 3339', (base: string) => base.replace(/"created_at":"[^"]+"/, '"created_at":"2026-01-01"')],
    ['wrong format_version', (base: string) => base.replace('"format_version":1', '"format_version":2')],
  ])('%s makes the lease unreadable; it stays live until last_modified + ttl', async (_name, mutate) => {
    const { error } = await claimWithLease(mutate(leaseText({})));
    expect(error?.message).toContain('正被其他设备认领：未知设备（租约内容损坏）（');
  });

  it('a seq-form lease that already expired is reclaimed and the claim proceeds', async () => {
    const past = Date.now() - 120_000;
    const lease = JSON.stringify([1, 'holder', randomUUID(), chronoAutoSiZ(past), chronoAutoSiZ(past + 60_000)]);
    const { storage, error } = await claimWithLease(lease);
    expect(error).toBeNull();
    expect(await storage.get(ENCRYPTION_MARKER_FILE)).not.toBeNull();
  });

  it('an expired map-form lease with an unknown field is reclaimed as well', async () => {
    const past = Date.now() - 120_000;
    const { error } = await claimWithLease(leaseText({
      created_at: chronoAutoSiZ(past), expires_at: chronoAutoSiZ(past + 60_000), extra: { nested: true },
    }));
    expect(error).toBeNull();
  });
});

describe('PasswordVerifier public decoder (api.ts, same decoder as the marker field)', () => {
  it('decodes raw bytes with serde struct semantics and encodes in declaration order', async () => {
    const { decodePasswordVerifierBytes, encodePasswordVerifier, SerdeJsonError } = await import('../api.ts');
    const verifier = decodePasswordVerifierBytes(Buffer.from(`{"extra":1,${VERIFIER.slice(1)}`));
    expect(verifier).toEqual({ kdf: 'argon2id', mCost: 19456, tCost: 2, pCost: 1, salt: '00', digest: '11' });
    expect(Buffer.from(encodePasswordVerifier(verifier)).toString('utf8')).toBe(VERIFIER);

    // Positions are relative to the verifier bytes themselves, not to a wrapping marker.
    const missing = (() => {
      try { decodePasswordVerifierBytes(Buffer.from('{"kdf":"argon2id"}')); return null; }
      catch (error) { return error; }
    })();
    expect(missing).toBeInstanceOf(SerdeJsonError);
    expect((missing as Error).message).toBe('missing field `mCost` at line 1 column 18');
    expect(() => decodePasswordVerifierBytes(Buffer.from('{"kdf":"a","mCost":-0}')))
      .toThrow('invalid type: floating point `-0.0`, expected u32 at line 1 column 21');
  });
});
