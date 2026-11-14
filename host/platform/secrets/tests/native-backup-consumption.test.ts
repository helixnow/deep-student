import { expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../../native/index.ts';
import { createPaths } from '../../paths/index.ts';
import log from '../../log/index.ts';
import secrets, { createSecretsService } from '../index.ts';
import { createBackupCrypto, type FileCipherSession, type PasswordVerifier } from '../api.ts';
import { KDF_MAX_M_COST_KIB, KDF_PARAMS_REJECTED_MESSAGE } from '../backup-crypto.ts';
import { DSBK_V1_DEFAULT_HEX, DSBK_V2_DEFAULT_HEX } from './dsbk-fixed-vectors.ts';

async function setup(withNative = true) {
  const host = await createTestHost({ app: { debug: false } });
  host.ctx.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: host.app.platform,
    env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } }));
  await host.install(log);
  if (withNative) await host.install(native);
  return host;
}

function observeNative(host: Awaited<ReturnType<typeof setup>>) {
  const service = host.ctx.nativeArgon2;
  const original = service.deriveKey.bind(service);
  const keys: Uint8Array[] = [], passwords: Uint8Array[] = [], encoded: Buffer[] = [];
  // Observation forwards every successful call to the real F7 N-API service.
  const spy = vi.spyOn(service, 'deriveKey').mockImplementation(async (...args) => {
    passwords.push(args[0]);
    encoded.push(Buffer.from(args[0]));
    const key = await original(...args);
    keys.push(key);
    return key;
  });
  return { spy, keys, passwords, encoded };
}

it('public secrets factory consumes the real F7 Argon2 service for its backup session', async () => {
  const host = await setup();
  // Passthrough observation only: no fake/fast KDF implementation or result.
  const observed = observeNative(host);
  try {
    const service = createSecretsService({ os: host.ctx.paths.os, log: host.ctx.log.logger('native-backup'),
      keystore: null, nativeArgon2: host.ctx.nativeArgon2 });
    const session = await service.backup.createFileCipherSession('密码\0🙂', { mCost: 8, tCost: 1, pCost: 1 });
    try {
      expect(observed.spy).toHaveBeenCalledTimes(1);
      expect(observed.spy.mock.calls[0]?.slice(2)).toEqual([8, 1, 1, 32]);
      expect(observed.encoded[0]).toEqual(Buffer.from('密码\0🙂', 'utf8'));
      expect(Buffer.from(observed.passwords[0]!)).toEqual(Buffer.alloc(Buffer.byteLength('密码\0🙂')));
    } finally { session.dispose(); }
    expect(Buffer.from(observed.keys[0]!)).toEqual(Buffer.alloc(32));
  } finally { observed.spy.mockRestore(); await host.dispose(); }
});

it('production secrets instance routes default DSBK vectors, writes, prefix trial and verifiers through real native Argon2', async () => {
  const host = await setup();
  const observed = observeNative(host);
  try {
    await host.install(secrets); // same service snapshot used by the official native-before-secrets profile
    const backup = host.ctx.secrets.backup;
    const v1 = Buffer.from(DSBK_V1_DEFAULT_HEX, 'hex'), v2 = Buffer.from(DSBK_V2_DEFAULT_HEX, 'hex');
    let ticked = false;
    const timer = setTimeout(() => { ticked = true; }, 0);
    try { expect(Buffer.from(await backup.decryptBackup(v1, 'pw-vector')).toString()).toBe('hello backup world'); }
    finally { clearTimeout(timer); }
    expect(ticked).toBe(true);
    const input = join(host.app.dataDir, 'input'), encrypted = join(host.app.dataDir, 'encrypted'), output = join(host.app.dataDir, 'output');
    await writeFile(encrypted, v2);
    await backup.decryptBackupFile(encrypted, output, 'pw-vector');
    expect(await readFile(output, 'utf8')).toBe('hello backup world');
    await backup.trialDecryptFirstChunk(v2, BigInt(v2.length), 'pw-vector');

    const payload = Buffer.from('production native DSBK bytes');
    const bytes = await backup.encryptBackup(payload, 'write-password');
    expect(Buffer.from(await backup.decryptBackup(bytes, 'write-password'))).toEqual(payload);
    await writeFile(input, payload);
    await backup.encryptBackupFile(input, encrypted, 'write-password');
    await backup.decryptBackupFile(encrypted, output, 'write-password');
    expect(await readFile(output)).toEqual(payload);
    const verifier = await backup.createPasswordVerifier('verifier-password');
    expect(await backup.checkPasswordVerifier('verifier-password', verifier)).toBe(true);

    expect(observed.spy).toHaveBeenCalledTimes(9);
    for (const call of observed.spy.mock.calls) expect(call.slice(2)).toEqual([65536, 3, 4, 32]);
    for (const password of observed.passwords) expect(password.every(byte => byte === 0)).toBe(true);
    for (const key of observed.keys) expect(Buffer.from(key)).toEqual(Buffer.alloc(32));
  } finally { observed.spy.mockRestore(); await host.dispose(); }
}, 30_000);

it('public backup factory owns its native session cache while a no-provider instance retains legacy selection', async () => {
  const host = await setup();
  const observed = observeNative(host);
  const sessions: FileCipherSession[] = [];
  try {
    const backup = createBackupCrypto({ nativeArgon2: host.ctx.nativeArgon2 });
    const params = { mCost: 8, tCost: 1, pCost: 1 };
    const first = await backup.createFileCipherSession('cache-password', params);
    const second = await backup.createFileCipherSession('cache-password', params);
    sessions.push(first, second);
    const encoded = await second.encryptBytes(Buffer.from('foreign salt'));
    expect(Buffer.from(await first.decryptBytes(encoded)).toString()).toBe('foreign salt');
    expect(Buffer.from(await first.decryptBytes(encoded)).toString()).toBe('foreign salt');
    expect(observed.spy).toHaveBeenCalledTimes(3); // initial keys + one cached foreign derivation
    const legacy = await createBackupCrypto().createFileCipherSession('legacy', params);
    sessions.push(legacy);
    expect(observed.spy).toHaveBeenCalledTimes(3); // real native is present but was not passed to this instance
  } finally {
    for (const session of sessions) session.dispose();
    observed.spy.mockRestore();
    await host.dispose();
  }
  for (const key of observed.keys) expect(Buffer.from(key)).toEqual(Buffer.alloc(32));
});

it('native consumption retains F4 validation precedence, error wrapping and password wiping without fallback', async () => {
  const host = await setup();
  const observed = observeNative(host);
  try {
    const backup = createBackupCrypto({ nativeArgon2: host.ctx.nativeArgon2 });
    await expect(backup.createFileCipherSession('', { mCost: KDF_MAX_M_COST_KIB + 1, tCost: 1, pCost: 1 })).rejects.toThrow('加密密码不能为空');
    await expect(backup.createFileCipherSession('password', { mCost: KDF_MAX_M_COST_KIB + 1, tCost: 0, pCost: 0 }))
      .rejects.toThrow(KDF_PARAMS_REJECTED_MESSAGE);
    const invalid = Buffer.from(DSBK_V1_DEFAULT_HEX, 'hex');
    invalid.writeUInt32LE(1, 5);
    invalid.writeUInt32LE(0, 9);
    invalid.writeUInt32LE(0, 13);
    await expect(backup.decryptBackup(invalid, 'password')).rejects.toThrow('Argon2 参数无效: memory cost is too small');
    const verifier: PasswordVerifier = { kdf: 'argon2id', mCost: 8, tCost: 1, pCost: 1, salt: '07', digest: '00'.repeat(32) };
    await expect(backup.checkPasswordVerifier('password', verifier)).rejects.toThrow('Argon2id 密钥派生失败: salt is too short');
    expect(observed.spy).not.toHaveBeenCalled();
    let failedPassword: Uint8Array | undefined;
    // One explicit negative service-failure injection, not a fast success backend.
    observed.spy.mockImplementationOnce(async password => { failedPassword = password; throw new Error('native service failure'); });
    await expect(backup.createFileCipherSession('密码\0🙂', { mCost: 8, tCost: 1, pCost: 1 }))
      .rejects.toThrow('Argon2id 密钥派生失败: native service failure');
    expect(observed.spy).toHaveBeenCalledTimes(1);
    expect(failedPassword!.every(byte => byte === 0)).toBe(true);
  } finally { observed.spy.mockRestore(); await host.dispose(); }
});

it('legacy secrets profiles without nativeArgon2 still initialize and retain the old cheap-session path', async () => {
  const host = await setup(false);
  try {
    expect(host.ctx.reflect.get('nativeArgon2', false)).toBeUndefined();
    await host.install(secrets);
    const session = await host.ctx.secrets.backup.createFileCipherSession('legacy', { mCost: 8, tCost: 1, pCost: 1 });
    try {
      const data = await session.encryptBytes(Buffer.from('legacy profile'));
      expect(Buffer.from(await session.decryptBytes(data)).toString()).toBe('legacy profile');
    } finally { session.dispose(); }
  } finally { await host.dispose(); }
});
