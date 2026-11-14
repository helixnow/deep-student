// 移植自 dstu-security/src/crypto/tests.rs
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../log/api.ts';
import { CryptoServiceImpl, isEncryptedFormat, parseEncryptedData, serializeEncryptedData } from './crypto-service.ts';

const silent: Logger = { target: 't', error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const opts = { log: silent, platform: process.platform, env: process.env };
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'f4-crypto-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('crypto::tests', () => {
  it('test_crypto_service_creation', async () => {
    const dir = temp();
    const crypto = await CryptoServiceImpl.open(dir, opts);
    expect(crypto.verifyKeyIntegrity()).toBe(true);
    if (process.platform !== 'win32') expect(statSync(join(dir, '.master_key')).mode & 0o777).toBe(0o600);
  });
  it('test_encrypt_decrypt_cycle', async () => {
    const crypto = await CryptoServiceImpl.open(temp(), opts);
    const enc = crypto.encryptApiKey('sk-test-api-key-12345');
    expect(enc.ciphertext).not.toBe('');
    expect(enc.nonce).not.toBe('');
    expect(crypto.decryptApiKey(enc)).toBe('sk-test-api-key-12345');
  });
  it('test_encrypted_format_detection', async () => {
    const crypto = await CryptoServiceImpl.open(temp(), opts);
    expect(isEncryptedFormat('plain-text-key')).toBe(false);
    expect(isEncryptedFormat('sk-1234567890')).toBe(false);
    expect(isEncryptedFormat(serializeEncryptedData(crypto.encryptApiKey('test-key')))).toBe(true);
  });
  it('test_migrate_plaintext_key', async () => {
    const crypto = await CryptoServiceImpl.open(temp(), opts);
    const json = crypto.migratePlaintextKey('sk-original-plaintext-key');
    expect(isEncryptedFormat(json)).toBe(true);
    expect(crypto.decryptApiKey(parseEncryptedData(json)!)).toBe('sk-original-plaintext-key');
  });
  it('test_key_rotation', async () => {
    const dir = temp();
    const original = await CryptoServiceImpl.open(dir, opts);
    const enc = original.encryptApiKey('sensitive-data-before-rotation');
    const rotated = await original.rotateMasterKey(dir);
    expect(rotated.verifyKeyIntegrity()).toBe(true);
    expect(() => rotated.decryptApiKey(enc)).toThrow();
  });
  it('test_empty_and_invalid_data', async () => {
    const crypto = await CryptoServiceImpl.open(temp(), opts);
    expect(crypto.decryptApiKey(crypto.encryptApiKey(''))).toBe('');
    expect(() => crypto.decryptApiKey({ ciphertext: 'invalid-base64-data!@#', nonce: 'invalid-nonce-data!@#', version: 2 })).toThrow();
  });
  it('test_encrypted_data_serialization', () => {
    const json = serializeEncryptedData({ ciphertext: 'dGVzdC1jaXBoZXJ0ZXh0', nonce: 'dGVzdC1ub25jZQ==', version: 2 });
    expect(json).toContain('ciphertext');
    expect(json).toContain('nonce');
    expect(parseEncryptedData(json)).toEqual({ ciphertext: 'dGVzdC1jaXBoZXJ0ZXh0', nonce: 'dGVzdC1ub25jZQ==', version: 2 });
  });
  it('同目录再次打开读回同一主密钥', async () => {
    const dir = temp();
    const a = await CryptoServiceImpl.open(dir, opts);
    const b = await CryptoServiceImpl.open(dir, opts);
    expect(b.keyFingerprint).toBe(a.keyFingerprint);
    expect(b.decryptApiKey(a.encryptApiKey('x'))).toBe('x');
  });

  it('preserves base64/utf8/io Display text in error messages', async () => {
    const invalidSymbol = temp();
    writeFileSync(join(invalidSymbol, '.master_key'), '!!!!');
    await expect(CryptoServiceImpl.open(invalidSymbol, opts))
      .rejects.toThrow('主密钥Base64解码失败: Invalid symbol 33, offset 0.');

    const invalidLength = temp();
    writeFileSync(join(invalidLength, '.master_key'), 'A');
    await expect(CryptoServiceImpl.open(invalidLength, opts))
      .rejects.toThrow('主密钥Base64解码失败: Invalid input length: 1');

    const invalidLength32 = temp();
    writeFileSync(join(invalidLength32, '.master_key'), 'AAAA');
    await expect(CryptoServiceImpl.open(invalidLength32, opts))
      .rejects.toThrow('主密钥长度无效，预期32字节，实际3');

    const invalidUtf8 = temp();
    writeFileSync(join(invalidUtf8, '.master_key'), Buffer.from([0xff, 0xfe]));
    await expect(CryptoServiceImpl.open(invalidUtf8, opts))
      .rejects.toThrow('stream did not contain valid UTF-8');

    const crypto = await CryptoServiceImpl.open(temp(), opts);
    expect(() => crypto.decryptApiKey({ ciphertext: '/w==', nonce: '', version: null }))
      .toThrow('invalid utf-8 sequence of 1 bytes from index 0');
    expect(() => crypto.decryptApiKey({ ciphertext: 'AAAA', nonce: 'A', version: 2 }))
      .toThrow('解码 nonce 失败: Invalid input length: 1');
    expect(() => crypto.decryptApiKey({ ciphertext: 'A', nonce: 'AAAAAAAAAAAAAAAA', version: 2 }))
      .toThrow('解码密文失败: Invalid input length: 1');
    expect(() => crypto.decryptApiKey({ ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==', nonce: 'AAAAAAAAAAAAAAAA', version: 2 }))
      .toThrow('AES-GCM 解密失败: aead::Error');

    const unreadable = temp();
    mkdirSync(join(unreadable, '.master_key'));
    await expect(CryptoServiceImpl.open(unreadable, opts))
      .rejects.toThrow(/^无法打开主密钥文件: .*Is a directory \(os error 21\)$/);
  });
});
