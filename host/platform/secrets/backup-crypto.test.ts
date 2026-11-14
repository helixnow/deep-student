/**
 * 移植自 `dstu-security/src/crypto/backup_crypto.rs::tests`，外加独立实现计算的字节向量：
 * Argon2id 用 OpenSSL（Node 26 `crypto.argon2Sync`），AES-256-GCM 用纯 JS `@noble/ciphers`，
 * 头部布局来自 Rust 源码常量。本实现在 Electron 下走 `@noble/hashes` 的 Argon2，因此这些向量同时
 * 证明两套 Argon2 实现一致；另含 RFC 9106 §5.3 Argon2id 官方向量。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argon2id } from '@noble/hashes/argon2.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createBackupCrypto,
  DEFAULT_M_COST,
  DEFAULT_P_COST,
  DEFAULT_T_COST,
  deriveKey,
  DSBK_GCM_TAG_LEN,
  DSBK_MAX_PLAINTEXT_CHUNK,
  DSBK_V1_HEADER_LEN,
  DSBK_V2_CHUNK_OFFSET,
  DSBK_V2_HEADER_LEN,
  KDF_MAX_M_COST_KIB,
  KDF_MAX_P_COST,
  KDF_MAX_T_COST,
  kdfMaxMCostForNewPassword,
  STREAM_PLAINTEXT_CHUNK,
} from './backup-crypto.ts';
import { DSBK_V1_DEFAULT_HEX, DSBK_V2_DEFAULT_HEX } from './tests/dsbk-fixed-vectors.ts';

const bc = createBackupCrypto();
const HEAVY = 300_000;
const hex = (s: string) => Buffer.from(s, 'hex');
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'f4-dsbk-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const pattern = (n: number, mod: number) => Buffer.from(Array.from({ length: n }, (_, i) => i % mod));
const cheap = (pw: string) => bc.createFileCipherSession(pw, { mCost: 8, tCost: 1, pCost: 1 });
async function cheapV2(pw: string, len: number): Promise<Buffer> {
  const d = temp();
  writeFileSync(join(d, 'in'), pattern(len, 251));
  await (await cheap(pw)).encryptFile(join(d, 'in'), join(d, 'enc'));
  return readFileSync(join(d, 'enc'));
}
async function rejects(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: Error) => e,
  );
}

describe('兼容向量', () => {
  it('RFC 9106 §5.3 Argon2id（@noble/hashes）', () => {
    const tag = argon2id(new Uint8Array(32).fill(1), new Uint8Array(16).fill(2), { t: 3, m: 32, p: 4, dkLen: 32, key: new Uint8Array(8).fill(3), personalization: new Uint8Array(12).fill(4) });
    expect(Buffer.from(tag).toString('hex')).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  });
  it('derive_key（cheap 与默认参数）', async () => {
    expect((await deriveKey('pw-vector', Buffer.alloc(16, 7), 8, 1, 1)).toString('hex')).toBe('5a9549fbd0db54c2bbd5bfc6e74a2dc9f2ab05650cfed2a1abd850b7d2d33588');
    expect((await deriveKey('pw-vector', Buffer.alloc(16, 7), DEFAULT_M_COST, DEFAULT_T_COST, DEFAULT_P_COST)).toString('hex')).toBe(
      '0f07e66622142880669e0d25846b6fe260b051ee4e48eaae911e1fd8e6732af1',
    );
  }, HEAVY);
  it('DSBK v1 / v2 固定字节可解（默认参数）', async () => {
    const v1 = hex(DSBK_V1_DEFAULT_HEX);
    expect(Buffer.from(await bc.decryptBackup(v1, 'pw-vector')).toString()).toBe('hello backup world');
    const d = temp();
    writeFileSync(join(d, 'v2'), hex(DSBK_V2_DEFAULT_HEX));
    await bc.decryptBackupFile(join(d, 'v2'), join(d, 'out'), 'pw-vector');
    expect(readFileSync(join(d, 'out'), 'utf8')).toBe('hello backup world');
  }, HEAVY);
  it('DSBK v1 / v2 固定字节（cheap 参数）与密码校验子摘要', async () => {
    const v1 = hex('4453424b0108000000010000000100000007070707070707070707070707070707000102030405060708090a0bbe4d70e908a49ffe756754ba8295b972cd65d2c190abc6b1da5874b0c2890acb7c8f');
    expect(Buffer.from(await bc.decryptBackup(v1, 'pw-vector')).toString()).toBe('hello backup world');
    const v2 = hex('4453424b0208000000010000000100000007070707070707070707070707070707aaaaaaaaaaaaaa00001000840a6fd86a2d08e1112b70602f6e348a3be138b9687590853c4bc70855e04c307448');
    await bc.trialDecryptFirstChunk(v2, v2.length, 'pw-vector');
    const verifier = { kdf: 'argon2id', mCost: 8, tCost: 1, pCost: 1, salt: '07'.repeat(16), digest: 'e377c7f213d3d3e86ede96b7190429471051e80c26864a1b635d392852ce5984' };
    expect(await bc.checkPasswordVerifier('pw-vector', verifier)).toBe(true);
    expect(await bc.checkPasswordVerifier('other', verifier)).toBe(false);
    expect(bc.encryptedRootFingerprint('webdav|endpoint=https://a|root=x')).toBe('30b98cf0c2b309f9f82d2fec1294f0778ca17357aeb0e4469300b8f1f56566cb');
  });
});

describe('backup_crypto::tests', () => {
  it('roundtrip_encrypt_decrypt', async () => {
    const pt = Buffer.from('hello backup world! 123 456');
    const enc = await bc.encryptBackup(pt, 'test-password-2026');
    expect(bc.isEncryptedBackup(enc)).toBe(true);
    expect(Buffer.from(enc.subarray(DSBK_V1_HEADER_LEN)).equals(pt)).toBe(false);
    expect(Buffer.from(await bc.decryptBackup(enc, 'test-password-2026')).equals(pt)).toBe(true);
  }, HEAVY);
  it('wrong_password_fails', async () => {
    const enc = await bc.encryptBackup(Buffer.from('secret data'), 'correct');
    await rejects(bc.decryptBackup(enc, 'wrong'));
  }, HEAVY);
  it('tampered_data_fails', async () => {
    const enc = Buffer.from(await bc.encryptBackup(Buffer.from('data'), 'pw'));
    enc[enc.length - 1]! ^= 0xff;
    await rejects(bc.decryptBackup(enc, 'pw'));
  }, HEAVY);
  it('non_encrypted_file_detected', () => {
    expect(bc.isEncryptedBackup(Buffer.from('PK\x03\x04some zip data', 'latin1'))).toBe(false);
    expect(bc.isEncryptedBackup(Buffer.alloc(0))).toBe(false);
  });
  it('stream_roundtrip_various_sizes', async () => {
    const d = temp();
    for (const size of [0, 100, STREAM_PLAINTEXT_CHUNK, STREAM_PLAINTEXT_CHUNK + 1, STREAM_PLAINTEXT_CHUNK * 2 + 123]) {
      const plain = pattern(size, 251);
      writeFileSync(join(d, `in-${size}`), plain);
      await bc.encryptBackupFile(join(d, `in-${size}`), join(d, `enc-${size}`), 'stream-pw-2026');
      const head = readFileSync(join(d, `enc-${size}`));
      expect(bc.isEncryptedBackup(head)).toBe(true);
      expect(head[4]).toBe(2);
      await bc.decryptBackupFile(join(d, `enc-${size}`), join(d, `dec-${size}`), 'stream-pw-2026');
      expect(readFileSync(join(d, `dec-${size}`)).equals(plain)).toBe(true);
    }
  }, HEAVY);
  it('stream_wrong_password_fails', async () => {
    const d = temp();
    writeFileSync(join(d, 'in'), Buffer.alloc(4096, 7));
    await bc.encryptBackupFile(join(d, 'in'), join(d, 'enc'), 'correct');
    await rejects(bc.decryptBackupFile(join(d, 'enc'), join(d, 'dec'), 'wrong'));
  }, HEAVY);
  it('stream_truncation_is_detected', async () => {
    const d = temp();
    writeFileSync(join(d, 'in'), Buffer.alloc(STREAM_PLAINTEXT_CHUNK + 1024, 3));
    await bc.encryptBackupFile(join(d, 'in'), join(d, 'enc'), 'pw');
    const bytes = readFileSync(join(d, 'enc'));
    writeFileSync(join(d, 'enc'), bytes.subarray(0, bytes.length - (1024 + 16)));
    await rejects(bc.decryptBackupFile(join(d, 'enc'), join(d, 'dec'), 'pw'));
  }, HEAVY);
  it('password_verifier_roundtrip_and_wrong_password', async () => {
    const v = await bc.createPasswordVerifier('correct horse battery staple');
    expect(v.kdf).toBe('argon2id');
    expect(v.salt).toHaveLength(32);
    expect(v.digest).toHaveLength(64);
    expect(await bc.checkPasswordVerifier('correct horse battery staple', v)).toBe(true);
    expect(await bc.checkPasswordVerifier('wrong password', v)).toBe(false);
  }, HEAVY);
  it('password_verifier_digest_does_not_leak_key', async () => {
    const v = await bc.createPasswordVerifier('pw-2026');
    const key = await deriveKey('pw-2026', hex(v.salt), v.mCost, v.tCost, v.pCost);
    expect(key.toString('hex')).not.toBe(v.digest);
  }, HEAVY);
  it('password_verifier_unknown_kdf_fails_closed', async () => {
    const v = await bc.createPasswordVerifier('pw');
    await rejects(bc.checkPasswordVerifier('pw', { ...v, kdf: 'quantum-kdf-9000' }));
  }, HEAVY);
  it('password_verifier_corrupted_fields_fail_closed', async () => {
    const good = await bc.createPasswordVerifier('pw');
    await rejects(bc.checkPasswordVerifier('pw', { ...good, salt: 'not-hex!!' }));
    await rejects(bc.checkPasswordVerifier('pw', { ...good, digest: 'deadbeef' }));
    const d = hex(good.digest);
    d[0]! ^= 0xff;
    expect(await bc.checkPasswordVerifier('pw', { ...good, digest: d.toString('hex') })).toBe(false);
  }, HEAVY);
  it('session_bytes_roundtrip_and_wrong_password', async () => {
    const s = await cheap('session-pw');
    const a = Buffer.from(await s.encryptBytes(Buffer.from('payload-a')));
    const b = Buffer.from(await s.encryptBytes(Buffer.from('payload-b')));
    expect(bc.isEncryptedBackup(a)).toBe(true);
    expect(a.subarray(5, 33).equals(b.subarray(5, 33))).toBe(true);
    expect(a.subarray(33, 45).equals(b.subarray(33, 45))).toBe(false);
    expect(Buffer.from(await s.decryptBytes(a)).toString()).toBe('payload-a');
    expect(Buffer.from(await s.decryptBytes(b)).toString()).toBe('payload-b');
    await rejects((await cheap('wrong-pw')).decryptBytes(a));
  });
  it('session_file_roundtrip_across_sessions', async () => {
    const d = temp();
    const plain = pattern(70_000, 253);
    writeFileSync(join(d, 'in'), plain);
    const a = await cheap('shared-pw');
    await a.encryptFile(join(d, 'in'), join(d, 'enc'));
    expect(readFileSync(join(d, 'enc'))[4]).toBe(2);
    const b = await cheap('shared-pw');
    await b.decryptFile(join(d, 'enc'), join(d, 'dec'));
    expect(readFileSync(join(d, 'dec')).equals(plain)).toBe(true);
    await a.encryptFile(join(d, 'in'), join(d, 'enc2'));
    await b.decryptFile(join(d, 'enc2'), join(d, 'dec2'));
    expect(readFileSync(join(d, 'dec2')).equals(plain)).toBe(true);
    await rejects((await cheap('wrong-pw')).decryptFile(join(d, 'enc'), join(d, 'dec3')));
  });
  it('session_output_interoperates_with_password_api', async () => {
    const d = temp();
    writeFileSync(join(d, 'in'), 'interop payload');
    const s = await cheap('pw-interop');
    await s.encryptFile(join(d, 'in'), join(d, 'enc'));
    await bc.decryptBackupFile(join(d, 'enc'), join(d, 'dec'), 'pw-interop');
    expect(readFileSync(join(d, 'dec'), 'utf8')).toBe('interop payload');
    const v1 = await bc.encryptBackup(Buffer.from('legacy payload'), 'pw-interop');
    expect(Buffer.from(await s.decryptBytes(v1)).toString()).toBe('legacy payload');
  }, HEAVY);
  it('session_rejects_empty_password', async () => {
    await rejects(bc.createFileCipherSession('', { mCost: 8, tCost: 1, pCost: 1 }));
  });
  it('kdf_limits_cover_default_write_surface', async () => {
    expect(DEFAULT_M_COST <= KDF_MAX_M_COST_KIB && DEFAULT_T_COST <= KDF_MAX_T_COST && DEFAULT_P_COST <= KDF_MAX_P_COST).toBe(true);
    await deriveKey('pw', Buffer.alloc(16, 7), DEFAULT_M_COST, DEFAULT_T_COST, DEFAULT_P_COST);
  }, HEAVY);
  it('kdf_oversized_params_rejected_before_derivation', async () => {
    for (const [m, t, p] of [
      [KDF_MAX_M_COST_KIB + 1, 1, 1],
      [0xffffffff, 1, 1],
      [8, KDF_MAX_T_COST + 1, 1],
      [8, 1, KDF_MAX_P_COST + 1],
    ] as const) {
      const start = Date.now();
      const e = await rejects(deriveKey('pw', Buffer.alloc(16, 7), m, t, p));
      expect(Date.now() - start).toBeLessThan(200);
      expect(e.message).toContain('加密参数异常');
    }
  });
  it('verifier_oversized_params_fail_closed_as_err', async () => {
    const v = await bc.createPasswordVerifier('pw');
    await rejects(bc.checkPasswordVerifier('pw', { ...v, mCost: 0xffffffff }));
  }, HEAVY);
  it('dsbk_headers_with_oversized_params_rejected', async () => {
    const v1 = Buffer.from(await bc.encryptBackup(Buffer.from('payload'), 'pw'));
    v1.writeUInt32LE(0xffffffff, 5);
    expect((await rejects(bc.decryptBackup(v1, 'pw'))).message).toContain('加密参数异常');
    const d = temp();
    writeFileSync(join(d, 'in'), Buffer.alloc(4096, 5));
    await bc.encryptBackupFile(join(d, 'in'), join(d, 'enc'), 'pw');
    const bytes = readFileSync(join(d, 'enc'));
    bytes.writeUInt32LE(0xffffffff, 5);
    writeFileSync(join(d, 'enc'), bytes);
    expect((await rejects(bc.decryptBackupFile(join(d, 'enc'), join(d, 'dec'), 'pw'))).message).toContain('加密参数异常');
    expect(existsSync(join(d, 'dec'))).toBe(false);
  }, HEAVY);
  it('new_password_cap_matches_platform_and_never_loosens_global_cap', () => {
    expect(kdfMaxMCostForNewPassword()).toBe(KDF_MAX_M_COST_KIB);
  });
  it('new_password_cap_covers_default_write_surface_on_every_platform', async () => {
    expect(DEFAULT_M_COST <= 256 * 1024).toBe(true);
    (await cheap('pw')).dispose();
  });
  it('session_with_params_rejects_m_cost_above_new_password_cap', async () => {
    const start = Date.now();
    const e = await rejects(bc.createFileCipherSession('pw', { mCost: kdfMaxMCostForNewPassword() + 1, tCost: 1, pCost: 1 }));
    expect(Date.now() - start).toBeLessThan(200);
    expect(e.message.includes('超出本设备可安全承受') || e.message.includes('加密参数异常')).toBe(true);
  });
  it('decrypt_and_legacy_verifier_paths_are_not_tightened_by_new_password_cap', async () => {
    // 桌面：256 MiB+1 的存量参数在解密侧与新写入侧都放行（此处只验证预检，不做 256 MiB 派生）。
    const legacyM = 256 * 1024 + 1;
    expect(legacyM <= KDF_MAX_M_COST_KIB).toBe(true);
    expect(legacyM <= kdfMaxMCostForNewPassword()).toBe(true);
  });
  it('encrypted_root_memory_roundtrip_and_isolation', async () => {
    const d = temp();
    const mem = bc.encryptedRootMemory(join(d, 'nested', 'roots.json'));
    const a = bc.encryptedRootFingerprint('webdav|endpoint=https://a|root=x');
    const b = bc.encryptedRootFingerprint('webdav|endpoint=https://b|root=y');
    expect(await mem.wasEncrypted(a)).toBe(false);
    await mem.remember(a);
    await mem.remember(a);
    expect(await mem.wasEncrypted(a)).toBe(true);
    expect(await mem.wasEncrypted(b)).toBe(false);
    const raw = readFileSync(join(d, 'nested', 'roots.json'), 'utf8');
    expect(raw).not.toContain('https://a');
    expect(raw).toContain(a);
    expect(JSON.parse(raw).roots[a]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
  it('encrypted_root_memory_corrupted_file_fails_closed', async () => {
    const d = temp();
    writeFileSync(join(d, 'roots.json'), 'not json {{{');
    const mem = bc.encryptedRootMemory(join(d, 'roots.json'));
    const fp = bc.encryptedRootFingerprint('any');
    expect(await mem.wasEncrypted(fp)).toBe(true);
    await mem.remember(fp);
    expect(await mem.wasEncrypted(fp)).toBe(true);
    expect(await mem.wasEncrypted(bc.encryptedRootFingerprint('other'))).toBe(false);
  });
  it('dsbk_layout_constants_match_real_containers', async () => {
    const v1 = await bc.encryptBackup(Buffer.alloc(0), 'layout-pin-pw');
    expect(v1.length).toBe(DSBK_V1_HEADER_LEN + DSBK_GCM_TAG_LEN);
    expect(v1[4]).toBe(1);
    const d = temp();
    writeFileSync(join(d, 'empty'), '');
    await bc.encryptBackupFile(join(d, 'empty'), join(d, 'enc'), 'layout-pin-pw');
    const v2 = readFileSync(join(d, 'enc'));
    expect(v2.length).toBe(DSBK_V2_HEADER_LEN + DSBK_GCM_TAG_LEN);
    expect(v2[4]).toBe(2);
    expect(v2.readUInt32LE(DSBK_V2_CHUNK_OFFSET)).toBe(STREAM_PLAINTEXT_CHUNK);
  }, HEAVY);
  it('stream_decrypts_legacy_v1_file', async () => {
    const d = temp();
    writeFileSync(join(d, 'legacy'), await bc.encryptBackup(Buffer.from('legacy v1 backup payload'), 'pw'));
    await bc.decryptBackupFile(join(d, 'legacy'), join(d, 'out'), 'pw');
    expect(readFileSync(join(d, 'out'), 'utf8')).toBe('legacy v1 backup payload');
  }, HEAVY);
  it('first_chunk_trial_proves_password_with_prefix_only', async () => {
    const object = await cheapV2('prove-pw', STREAM_PLAINTEXT_CHUNK * 2 + 123);
    const plan = bc.planFirstChunkTrial(object, object.length);
    if (plan.kind !== 'StreamV2') throw new Error('v2 expected');
    expect(plan.prefixLen).toBe(DSBK_V2_HEADER_LEN + STREAM_PLAINTEXT_CHUNK + DSBK_GCM_TAG_LEN);
    expect(plan.prefixLen).toBeLessThan(object.length);
    const prefix = object.subarray(0, plan.prefixLen);
    await bc.trialDecryptFirstChunk(prefix, object.length, 'prove-pw');
    await rejects(bc.trialDecryptFirstChunk(prefix, object.length, 'wrong-pw'));
  });
  it('first_chunk_trial_final_flag_matches_object_size', async () => {
    for (const len of [0, 100, STREAM_PLAINTEXT_CHUNK]) {
      const object = await cheapV2('final-pw', len);
      const plan = bc.planFirstChunkTrial(object, object.length);
      expect(plan).toEqual({ kind: 'StreamV2', prefixLen: object.length });
      await bc.trialDecryptFirstChunk(object, object.length, 'final-pw');
    }
    const object = await cheapV2('final-pw', STREAM_PLAINTEXT_CHUNK + 1024);
    const plan = bc.planFirstChunkTrial(object, object.length);
    if (plan.kind !== 'StreamV2') throw new Error('v2 expected');
    await rejects(bc.trialDecryptFirstChunk(object.subarray(0, plan.prefixLen), plan.prefixLen, 'final-pw'));
  });
  it('first_chunk_trial_tampered_first_block_fails', async () => {
    const object = await cheapV2('tamper-pw', 4096);
    object[DSBK_V2_HEADER_LEN + 1]! ^= 0xff;
    await rejects(bc.trialDecryptFirstChunk(object, object.length, 'tamper-pw'));
  });
  it('first_chunk_plan_v1_requires_whole_file', async () => {
    const v1 = await bc.encryptBackup(Buffer.from('legacy payload'), 'pw');
    expect(bc.planFirstChunkTrial(v1, v1.length)).toEqual({ kind: 'LegacyV1WholeFile' });
    expect((await rejects(bc.trialDecryptFirstChunk(v1, v1.length, 'pw'))).message).toContain('整文件');
    expect(Buffer.from(await bc.decryptBackup(v1, 'pw')).toString()).toBe('legacy payload');
  }, HEAVY);
  it('first_chunk_plan_rejects_bad_headers', async () => {
    expect(() => bc.planFirstChunkTrial(Buffer.from('PK\x03\x04zip!', 'latin1'), 100)).toThrow();
    expect(() => bc.planFirstChunkTrial(Buffer.from('DSB'), 100)).toThrow();
    const unknown = await cheapV2('pw', 128);
    unknown[4] = 9;
    expect(() => bc.planFirstChunkTrial(unknown, unknown.length)).toThrow();
    const good = await cheapV2('pw', 128);
    for (const badChunk of [0, DSBK_MAX_PLAINTEXT_CHUNK + 1]) {
      const bad = Buffer.from(good);
      bad.writeUInt32LE(badChunk, DSBK_V2_CHUNK_OFFSET);
      expect(() => bc.planFirstChunkTrial(bad, bad.length)).toThrow('分块大小非法');
    }
    expect(() => bc.planFirstChunkTrial(good, DSBK_V2_HEADER_LEN + DSBK_GCM_TAG_LEN - 1)).toThrow('缺少数据块');
  });
  it('first_chunk_trial_truncated_prefix_rejected', async () => {
    const object = await cheapV2('prefix-pw', 4096);
    expect((await rejects(bc.trialDecryptFirstChunk(object.subarray(0, object.length - 1), object.length, 'prefix-pw'))).message).toContain('前缀不足');
  });
  it('first_chunk_trial_oversized_kdf_params_rejected_fast', async () => {
    const object = await cheapV2('kdf-pw', 4096);
    object.writeUInt32LE(0xffffffff, 5);
    const start = Date.now();
    const e = await rejects(bc.trialDecryptFirstChunk(object, object.length, 'kdf-pw'));
    expect(Date.now() - start).toBeLessThan(200);
    expect(e.message).toContain('加密参数异常');
  });
  it('speculative_prefix_len_covers_own_write_surface', async () => {
    for (const len of [0, 100, STREAM_PLAINTEXT_CHUNK, STREAM_PLAINTEXT_CHUNK * 2 + 7]) {
      const object = await cheapV2('spec-pw', len);
      const plan = bc.planFirstChunkTrial(object, object.length);
      if (plan.kind !== 'StreamV2') throw new Error('v2 expected');
      const spec = bc.dsbkFirstChunkSpeculativePrefixLen(object.length);
      expect(spec).toBeGreaterThanOrEqual(plan.prefixLen);
      expect(spec).toBeLessThanOrEqual(object.length);
    }
    const foreign = await cheapV2('spec-pw', 128);
    foreign.writeUInt32LE(4 * 1024 * 1024, DSBK_V2_CHUNK_OFFSET);
    const pretended = DSBK_V2_HEADER_LEN + 8 * 1024 * 1024;
    const plan = bc.planFirstChunkTrial(foreign, pretended);
    if (plan.kind !== 'StreamV2') throw new Error('v2 expected');
    expect(plan.prefixLen).toBeGreaterThan(bc.dsbkFirstChunkSpeculativePrefixLen(pretended));
  });
});
