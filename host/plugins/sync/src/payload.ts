/**
 * 同步 payload 的 E2EE 编解码（`SyncManager::encode_payload` / `decode_payload`）。
 *
 * 使用 F4 `secrets.backup` 的 DSBK 会话，不在本 lane 复制加密算法。
 */
import type { BackupCrypto, FileCipherSession } from '../../../platform/secrets/api.ts';
import { isEncryptedBackup } from '../../../platform/secrets/dsbk-stream.ts';
import { SyncError } from './errors.ts';
import {
  SYNC_E2EE_PASSWORD_REQUIRED_CODE,
  SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE,
  SYNC_E2EE_WRONG_PASSWORD_CODE,
} from '../../sync-providers/portable.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function syncE2eeError(code: string, detail: string): SyncError {
  return new SyncError(`Database error: [${code}] ${detail}`);
}

export interface PayloadCodec {
  readonly encrypted: boolean;
  encode(plaintext: Uint8Array): Promise<Uint8Array>;
  decode(data: Uint8Array): Promise<Uint8Array>;
  /** 释放会话密钥材料（Rust 中随 `SyncManager` 的 `Arc` 释放）。 */
  dispose(): void;
}

/** File and record transfers share the same lazily derived key (mod.rs:893). */
export interface FilePayloadCodec extends PayloadCodec {
  fileCipher(): Promise<FileCipherSession | null>;
}

export async function createPayloadCodec(
  backup: BackupCrypto | undefined,
  password: string | null | undefined,
): Promise<FilePayloadCodec> {
  const enabled = typeof password === 'string' && password !== '';
  let session: Promise<FileCipherSession> | null = null;
  let activeCipher: FileCipherSession | null = null;
  let disposed = false;
  function assertOpen(): void {
    if (disposed) throw new SyncError('Database error: 同步加密会话已释放');
  }
  async function fileCipher(): Promise<FileCipherSession | null> {
    assertOpen();
    if (!enabled) return null;
    if (backup === undefined) {
      throw syncE2eeError(SYNC_E2EE_PASSWORD_REQUIRED_CODE, '检测到同步加密密码但本端缺少加密服务，无法初始化同步加密会话。');
    }
    if (session === null) {
      session = backup.createFileCipherSession(password!).then(cipher => {
        if (disposed) cipher.dispose();
        else activeCipher = cipher;
        return cipher;
      }).catch(error => {
        session = null;
        throw new SyncError(`Database error: 初始化同步加密会话失败: ${message(error)}`);
      });
    }
    const cipher = await session;
    assertOpen();
    return cipher;
  }
  return {
    encrypted: enabled,
    fileCipher,
    async encode(plaintext) {
      const cipher = await fileCipher();
      if (cipher === null) return Uint8Array.from(plaintext);
      try {
        return await cipher.encryptBytes(plaintext);
      } catch (error) {
        throw new SyncError(`Database error: 加密 sync payload 失败: ${message(error)}`);
      }
    },
    async decode(data) {
      assertOpen();
      if (isEncryptedBackup(data)) {
        const cipher = await fileCipher();
        if (cipher === null) {
          throw syncE2eeError(
            SYNC_E2EE_PASSWORD_REQUIRED_CODE,
            '检测到加密的 sync payload 但本端未配置加密密码。请在云同步设置里填入正确的密码后重试。',
          );
        }
        try {
          return await cipher.decryptBytes(data);
        } catch (error) {
          throw syncE2eeError(
            SYNC_E2EE_WRONG_PASSWORD_CODE,
            `解密 sync payload 失败（密码错误或数据损坏）: ${message(error)}`,
          );
        }
      }
      if (enabled) {
        throw syncE2eeError(
          SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE,
          '本机已启用同步加密，但云端 payload 缺少 DSBK 加密头（明文数据）。' +
            '为防止端到端加密被静默降级，已拒绝读取该数据。' +
            '若这是启用加密前遗留的旧明文数据：请先在云同步设置里暂时清除加密密码，' +
            '完成一次下载同步把云端数据合并到本地，再清空该云端目录（或改用新目录）' +
            '并重新配置密码后执行完整上传；若确认不需要加密，请清除加密密码后重试。',
        );
      }
      return Uint8Array.from(data);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // 初始化中的会话由 fileCipher 的 then 释放。
      activeCipher?.dispose();
    },
  };
}
