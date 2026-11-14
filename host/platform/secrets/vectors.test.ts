/**
 * 兼容性向量。来源（不运行 Rust）：
 * - 常量取自 Rust 源码：salt `deep-student-secure-salt-v3`/`-v2`（secure_store.rs:1205,1240）、
 *   指纹域 `deep-student.key_seed.fingerprint.v1`（:452）、文件布局 nonce‖ct‖tag（:1264）、
 *   EncryptedData 形状（crypto/mod.rs:23-29,160-164）。
 * - 期望值由**独立实现**计算：SHA-256 用 Python `hashlib`，AES-256-GCM 用纯 JS 的 `@noble/ciphers@1.3.0`
 *   （不经 OpenSSL/BoringSSL），并辅以 NIST GCM 规范 Test Case 16。
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../log/api.ts';
import { resolveOsDirs } from '../paths/index.ts';
import { CryptoServiceImpl, deriveStaticKey, isEncryptedFormat, parseEncryptedData, serializeEncryptedData } from './crypto-service.ts';
import { createSecretsService } from './index.ts';
import { decryptWithKey, deriveKey, encryptWithKey, SECURE_SALT_V2, SECURE_SALT_V3, seedFingerprint, type SecureStoreImpl } from './secure-store.ts';
import { createCipheriv } from 'node:crypto';

const silent: Logger = { target: 't', error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const hex = (s: string) => Buffer.from(s, 'hex');
const SEED = 'ab'.repeat(32);
const NONCE = hex('000102030405060708090a0b');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('SecureStore 密钥派生与文件格式', () => {
  it('v3 设备密钥 = SHA-256(seed ‖ salt_v3)', () => {
    expect(deriveKey(SEED, SECURE_SALT_V3).toString('hex')).toBe('ad99b4156610eb00bc946cd02c198682f4339884e61b1af1fa9ef6c537d86ae4');
  });
  it('legacy v2 密钥 = SHA-256(home ‖ dataLocal ‖ hostname ‖ user ‖ salt_v2)', () => {
    const info = '/Users/u' + '/Users/u/Library/Application Support' + 'host.local' + 'u';
    expect(deriveKey(info, SECURE_SALT_V2).toString('hex')).toBe('712f1b02583cc919ba985c7bfa139bb9b2f22db02096e982c64afc37d0877913');
  });
  it('种子指纹', () => {
    expect(seedFingerprint(SEED)).toBe('6aa671d95b05cdd08384845f559fe13be9a9b8402aec952ca4240f8cd2e8bb5a');
  });
  it('.enc 字节：nonce ‖ AES-256-GCM(utf8) ‖ tag', () => {
    const key = deriveKey(SEED, SECURE_SALT_V3);
    const expected = '000102030405060708090a0b9f870e11e858940c8c90a12532d8566f494046effe43d0bfc7d9379222ef5a429703';
    expect(encryptWithKey(key, 'sk-test-secret-值', NONCE).toString('hex')).toBe(expected);
    expect(decryptWithKey(key, hex(expected))).toBe('sk-test-secret-值');
  });
  it('端到端：已有 .key_seed + 预置 .enc 文件可被 SecureStore 读出（模拟 Rust 写出的用户数据）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f4-vec-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.secure'));
    writeFileSync(join(dir, '.secure/.key_seed'), SEED);
    writeFileSync(join(dir, '.secure/builtin-openai.api_key.enc'), hex('000102030405060708090a0b9f870e11e858940c8c90a12532d8566f494046effe43d0bfc7d9379222ef5a429703'));
    const os = resolveOsDirs(process.platform === 'darwin' ? 'darwin' : 'linux', process.env);
    const store = createSecretsService({ os, log: silent, keystore: null }).openStore(dir) as SecureStoreImpl;
    expect(await store.getSecret('builtin-openai.api_key')).toBe('sk-test-secret-值');
  });
  it('NIST GCM Test Case 16（AES-256，96 位 IV，含 AAD）校验底层原语', () => {
    const key = hex('feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308');
    const iv = hex('cafebabefacedbaddecaf888');
    const pt = hex('d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39');
    const aad = hex('feedfacedeadbeeffeedfacedeadbeefabaddad2');
    const c = createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(aad);
    const ct = Buffer.concat([c.update(pt), c.final()]);
    expect(ct.toString('hex')).toBe('522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662');
    expect(c.getAuthTag().toString('hex')).toBe('76fc6ece0f4e1768cddf8853bb2d551b');
  });
});

describe('CryptoService（.master_key）', () => {
  const key = Uint8Array.from({ length: 32 }, (_, i) => i);
  const svc = CryptoServiceImpl.fromKey('/x/.master_key', key, { log: silent, platform: process.platform, env: {} });
  it('EncryptedData 向量', () => {
    const enc = svc.encryptApiKey('sk-test-api-key-12345', NONCE);
    expect(enc).toEqual({ ciphertext: 'NGn7b6CWtjbsMf6m2owBQLLktADF5P1edSxR7Gi6YKcPlKdXfQ==', nonce: 'AAECAwQFBgcICQoL', version: 2 });
    expect(serializeEncryptedData(enc)).toBe('{"ciphertext":"NGn7b6CWtjbsMf6m2owBQLLktADF5P1edSxR7Gi6YKcPlKdXfQ==","nonce":"AAECAwQFBgcICQoL","version":2}');
    expect(svc.decryptApiKey(enc)).toBe('sk-test-api-key-12345');
  });
  it('.master_key 文件 = base64(32 字节)，指纹 = SHA-256 前 4 字节', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f4-mk-'));
    dirs.push(dir);
    writeFileSync(join(dir, '.master_key'), 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=\n');
    const loaded = await CryptoServiceImpl.open(dir, { log: silent, platform: process.platform, env: {} });
    expect(loaded.keyFingerprint).toBe(createHash('sha256').update(key).digest('hex').slice(0, 8));
    expect(loaded.decryptApiKey({ ciphertext: 'NGn7b6CWtjbsMf6m2owBQLLktADF5P1edSxR7Gi6YKcPlKdXfQ==', nonce: 'AAECAwQFBgcICQoL', version: 2 })).toBe('sk-test-api-key-12345');
  });
  it('旧版（version != 2）= base64 明文', () => {
    expect(svc.decryptApiKey({ ciphertext: Buffer.from('legacy').toString('base64'), nonce: '', version: null })).toBe('legacy');
  });
  it('is_encrypted_format 与 serde 反序列化一致（对象/数组形式、version u8）', () => {
    expect(isEncryptedFormat('{"ciphertext":"a","nonce":"b"}')).toBe(true);
    expect(isEncryptedFormat('{"ciphertext":"a","nonce":"b","version":null,"extra":1}')).toBe(true);
    expect(isEncryptedFormat('["a","b"]')).toBe(true);
    expect(isEncryptedFormat('["a","b",2]')).toBe(true);
    expect(isEncryptedFormat('{"ciphertext":"a","nonce":"b","version":256}')).toBe(false);
    expect(isEncryptedFormat('{"ciphertext":"a"}')).toBe(false);
    expect(isEncryptedFormat('sk-1234567890')).toBe(false);
    expect(parseEncryptedData('{"nonce":"n","ciphertext":"c","version":2}')).toEqual({ ciphertext: 'c', nonce: 'n', version: 2 });
  });
  it('derive_static_key = SHA-256(seed)', () => {
    expect(Buffer.from(deriveStaticKey('builtin-seed')).toString('hex')).toBe('33fd6c29c00b63739e7cdbf88abb3e22ed824390ee7516bd196c1164ef2fc134');
  });
});
