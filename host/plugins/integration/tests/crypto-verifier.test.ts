import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import secrets from '../../../platform/secrets/index.ts';
import type { BackupCrypto, PasswordVerifier } from '../../../platform/secrets/api.ts';

// Rust constants from crypto/backup_crypto.rs; do not import implementation constants as expectations.
const MAX_M = 1024 * 1024;
const MAX_T = 16;
const MAX_P = 8;
const oversized = [[MAX_M + 1, 1, 1], [0xffff_ffff, 1, 1], [8, MAX_T + 1, 1], [8, 1, MAX_P + 1]] as const;
const verifier = (mCost: number, tCost: number, pCost: number, digestByte = '11'): PasswordVerifier => ({
  kdf: 'argon2id', mCost, tCost, pCost,
  salt: '00112233445566778899aabbccddeeff', digest: digestByte.repeat(32),
});

let host: TestHost;
let crypto: BackupCrypto;
beforeAll(async () => {
  // The tested crypto service is real; only the unused paths/logger dependencies are supplied.
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  host = await createTestHost({
    plugins: [secrets],
    provide: { paths: { os: {} }, log: { logger: () => logger } },
  });
  crypto = host.ctx.secrets.backup;
});
afterAll(async () => { await host?.dispose(); });

describe('sync_r10_protocol_locks.rs', () => {
  it('p2_2_structurally_invalid_kdf_params_fail_closed', async () => {
    for (const [m, t, p] of [[0, 3, 4], [65536, 0, 4], [65536, 3, 0]]) {
      await expect(crypto.checkPasswordVerifier('any-password', verifier(m!, t!, p!, '00'))).rejects.toThrow();
    }
  });

  it('p2_2_marker_kdf_params_are_honored_not_clamped_to_default', async () => {
    await expect(crypto.checkPasswordVerifier('any-password', verifier(131072, 1, 1, '00'))).resolves.toBe(false);
  });

  it('p2_2_kdf_cost_upper_bound_now_enforced', async () => {
    for (const [m, t, p] of oversized) {
      await expect(crypto.checkPasswordVerifier('any-password', verifier(m, t, p, '00'))).rejects.toThrow();
    }
    const value = await crypto.createPasswordVerifier('pw');
    expect(value.mCost).toBeLessThanOrEqual(MAX_M);
    expect(value.tCost).toBeLessThanOrEqual(MAX_T);
    expect(value.pCost).toBeLessThanOrEqual(MAX_P);
    await expect(crypto.checkPasswordVerifier('pw', value)).resolves.toBe(true);
  });
});

describe('sync_r10_verifier.rs', () => {
  it('legal_default_params_still_pass', async () => {
    const value = await crypto.createPasswordVerifier('r10-correct-pw');
    await expect(crypto.checkPasswordVerifier('r10-correct-pw', value)).resolves.toBe(true);
    await expect(crypto.checkPasswordVerifier('r10-wrong-pw', value)).resolves.toBe(false);
    const encrypted = await crypto.encryptBackup(Buffer.from('r10 payload'), 'r10-correct-pw');
    expect(Buffer.from(await crypto.decryptBackup(encrypted, 'r10-correct-pw'))).toEqual(Buffer.from('r10 payload'));
  });

  it('legal_legacy_params_still_execute', async () => {
    await expect(crypto.checkPasswordVerifier('any-password', verifier(131072, 1, 1))).resolves.toBe(false);
  });

  it('limits_cover_default_write_surface', async () => {
    const value = await crypto.createPasswordVerifier('pw');
    expect(value.mCost).toBeLessThanOrEqual(MAX_M);
    expect(value.tCost).toBeLessThanOrEqual(MAX_T);
    expect(value.pCost).toBeLessThanOrEqual(MAX_P);
  });

  it('oversized_params_rejected_before_derivation', async () => {
    for (const [m, t, p] of [...oversized, [0xffff_ffff, 0xffff_ffff, 0xffff_ffff] as const]) {
      const start = performance.now();
      const error = await crypto.checkPasswordVerifier('any-password', verifier(m, t, p)).then(
        () => { throw new Error('Expected KDF rejection, not a password mismatch'); },
        (reason: unknown) => reason,
      );
      expect(performance.now() - start).toBeLessThan(500);
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain('加密参数异常');
      for (const internal of ['feature', '编译', 'Argon2', 'argon2']) expect(message).not.toContain(internal);
    }
  });

  it('dsbk_decrypt_rejects_oversized_kdf_params_before_derivation', async () => {
    const v1 = Buffer.from(await crypto.encryptBackup(Buffer.from('payload'), 'pw'));
    v1.writeUInt32LE(0xffff_ffff, 5);
    let start = performance.now();
    await expect(crypto.decryptBackup(v1, 'pw')).rejects.toThrow('加密参数异常');
    expect(performance.now() - start).toBeLessThan(500);

    const input = join(host.app.dataDir, 'in.bin');
    const encrypted = join(host.app.dataDir, 'enc.dsbk');
    const decrypted = join(host.app.dataDir, 'dec.bin');
    writeFileSync(input, Buffer.alloc(8192, 9));
    await crypto.encryptBackupFile(input, encrypted, 'pw');
    const bytes = readFileSync(encrypted);
    bytes.writeUInt32LE(0xffff_ffff, 5);
    writeFileSync(encrypted, bytes);
    start = performance.now();
    await expect(crypto.decryptBackupFile(encrypted, decrypted, 'pw')).rejects.toThrow('加密参数异常');
    expect(performance.now() - start).toBeLessThan(500);
    expect(existsSync(decrypted)).toBe(false);
  });
});
