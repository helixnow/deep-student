import { describe, expect, it, vi } from 'vitest';
import type { BackupCrypto } from '../../../platform/secrets/api.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import {
  SYNC_E2EE_PASSWORD_REQUIRED_CODE,
  SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE,
  SYNC_E2EE_WRONG_PASSWORD_CODE,
} from '../../sync-providers/api.ts';
import { createPayloadCodec } from '../src/payload.ts';

const realBackup = createBackupCrypto();

/** 与生产同一个 DSBK 实现，仅把 Argon2 参数降到测试可接受的成本。 */
const backup: BackupCrypto = {
  ...realBackup,
  createFileCipherSession: (password, params) =>
    realBackup.createFileCipherSession(password, params ?? { mCost: 8, tCost: 1, pCost: 1 }),
};

const encoder = new TextEncoder();

describe('sync payload e2ee', () => {
  it('decode_payload_accepts_plaintext_when_encryption_disabled: Buffer inputs retain Rust to_vec ownership', async () => {
    const codec = await createPayloadCodec(undefined, null);
    try {
      const source = Buffer.from('plaintext');
      const encoded = await codec.encode(source), decoded = await codec.decode(source);
      source.fill(0);
      expect(Buffer.from(encoded).toString()).toBe('plaintext');
      expect(Buffer.from(decoded).toString()).toBe('plaintext');
    } finally { codec.dispose(); }
  });
  it('rejects DSBK without a secrets service instead of treating it as plaintext', async () => {
    const codec = await createPayloadCodec(undefined, null);
    try {
      await expect(codec.decode(Buffer.from('DSBK'))).rejects.toThrow(SYNC_E2EE_PASSWORD_REQUIRED_CODE);
    } finally {
      codec.dispose();
    }
  });

  it('lazily derives one shared cipher and releases its key on dispose', async () => {
    const create = vi.fn(async (password: string) => {
      const cipher = await backup.createFileCipherSession(password);
      vi.spyOn(cipher, 'dispose');
      return cipher;
    });
    const codec = await createPayloadCodec({ ...backup, createFileCipherSession: create }, 'pw-123');
    expect(create).not.toHaveBeenCalled();
    await expect(codec.decode(Buffer.from('plain'))).rejects.toThrow(SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE);
    expect(create).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([codec.encode(Buffer.from('a')), codec.encode(Buffer.from('b'))]);
    expect(Buffer.from(await codec.decode(a)).toString()).toBe('a');
    expect(Buffer.from(await codec.decode(b)).toString()).toBe('b');
    expect(create).toHaveBeenCalledTimes(1);
    const cipher = await create.mock.results[0]!.value;
    codec.dispose();
    expect(cipher.dispose).toHaveBeenCalledTimes(1);
    await expect(codec.encode(Buffer.from('c'))).rejects.toThrow('同步加密会话已释放');
  });
  it('decode_payload_accepts_plaintext_when_encryption_disabled', async () => {
    const plaintext = encoder.encode('{"hello":"world"}');
    const codec = await createPayloadCodec(backup, null);
    try {
      expect(codec.encrypted).toBe(false);
      expect(await codec.decode(plaintext)).toEqual(plaintext);
    } finally {
      codec.dispose();
    }

    // 空密码等价于未启用加密（with_encryption 会过滤空字符串）。
    const emptyPassword = await createPayloadCodec(backup, '');
    try {
      expect(emptyPassword.encrypted).toBe(false);
      expect(await emptyPassword.decode(plaintext)).toEqual(plaintext);
    } finally {
      emptyPassword.dispose();
    }
  });

  it('decode_payload_rejects_plaintext_when_encryption_enabled', async () => {
    const codec = await createPayloadCodec(backup, 'pw-123');
    try {
      const error = await codec.decode(encoder.encode('{"hello":"world"}')).catch(error => error as Error);
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain(SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE);
      expect(message).toContain('已启用同步加密');
      expect(message).toContain('DSBK');
      expect(message).toContain('清除加密密码');
    } finally {
      codec.dispose();
    }
  });

  it('decode_payload_roundtrips_encrypted_payload', async () => {
    const codec = await createPayloadCodec(backup, 'pw-123');
    try {
      const plaintext = encoder.encode('sync payload bytes');
      const encoded = await codec.encode(plaintext);
      expect(backup.isEncryptedBackup(encoded)).toBe(true);
      expect(Buffer.from(await codec.decode(encoded)).equals(Buffer.from(plaintext))).toBe(true);
    } finally {
      codec.dispose();
    }
  });

  it('decode_payload_rejects_encrypted_payload_without_password', async () => {
    const sender = await createPayloadCodec(backup, 'pw-123');
    let encoded: Uint8Array;
    try {
      encoded = await sender.encode(encoder.encode('secret'));
    } finally {
      sender.dispose();
    }

    const receiver = await createPayloadCodec(backup, null);
    try {
      const error = await receiver.decode(encoded).catch(error => error as Error);
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain(SYNC_E2EE_PASSWORD_REQUIRED_CODE);
      expect(message).toContain('未配置加密密码');
    } finally {
      receiver.dispose();
    }
  });

  it('decode_payload_rejects_encrypted_payload_with_wrong_password', async () => {
    const sender = await createPayloadCodec(backup, 'pw-123');
    let encoded: Uint8Array;
    try {
      encoded = await sender.encode(encoder.encode('secret'));
    } finally {
      sender.dispose();
    }

    const receiver = await createPayloadCodec(backup, 'pw-456');
    try {
      const error = await receiver.decode(encoded).catch(error => error as Error);
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain(SYNC_E2EE_WRONG_PASSWORD_CODE);
      expect(message).toContain('密码错误或数据损坏');
    } finally {
      receiver.dispose();
    }
  });
});
