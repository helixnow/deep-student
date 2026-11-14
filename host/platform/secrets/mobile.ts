/**
 * OPFS SecureStore: AES-GCM ciphertext and a file-only seed, not OS-keychain protection.
 * API-key CryptoService uses portable AES-GCM; desktop backup/publication remain unavailable.
 */
import { definePlugin } from '../../kernel/core.ts';
import type { FilesService } from '../files/api.ts';
import type { CryptoService as Crypto } from '../crypto/api.ts';
import { toHex, utf8Decode } from '../crypto/encoding.ts';
import { sha256Sync, sha256HexSync } from '../crypto/sync.ts';
import { posix } from '../util/path.ts';
import type { SecretsService, SecureStore } from './api.ts';
import { isSensitiveKey } from './sensitive-key.ts';
import { isEncryptedFormat, openMobileCrypto } from './crypto.ts';

function unsupported(): never {
  throw new Error('UNSUPPORTED_ON_PLATFORM: secrets.desktopCrypto is not available on mobile');
}

export function createMobileSecrets(files: FilesService, crypto: Crypto, base: string): SecretsService {
  const cryptoServices = new Map<string, ReturnType<typeof openMobileCrypto>>();
  const openCrypto: SecretsService['openCrypto'] = dir => {
    let service = cryptoServices.get(dir);
    if (!service) {
      service = openMobileCrypto(files, crypto, dir).catch(error => { cryptoServices.delete(dir); throw error; });
      cryptoServices.set(dir, service);
    }
    return service;
  };
  const keys = new Map<string, Promise<Uint8Array>>();
  function keyFor(dir: string): Promise<Uint8Array> {
    let key = keys.get(dir);
    if (!key) {
      key = (async () => {
        await files.mkdir(dir, { recursive: true });
        const path = posix.join(dir, '.key_seed');
        let seed: string;
        if (await files.exists(path)) seed = (await files.readText(path)).trim();
        else { seed = toHex(crypto.randomBytes(32)); await files.writeAtomic(path, seed); }
        if (!/^[a-fA-F0-9]{64}$/.test(seed)) throw new Error('Mobile SecureStore requires a file-only 64-hex seed');
        return sha256Sync(seed + 'deep-student-secure-salt-v3');
      })().catch(error => { keys.delete(dir); throw error; });
      keys.set(dir, key);
    }
    return key;
  }
  const openStore: SecretsService['openStore'] = (root, options = {}) => {
    const dir = posix.join(root, '.secure');
    const pathOf = (key: string) => posix.join(dir, `${key.replace(/[/\\]/g, '_')}.enc`);
    const ensureEnabled = () => { if (options.enabled === false) throw new Error('SecureStore is disabled'); };
    const store: SecureStore = {
      secureDir: dir, enabled: options.enabled !== false,
      async saveSecret(key, value) {
        ensureEnabled();
        const master = await keyFor(dir);
        const iv = crypto.randomBytes(12);
        const encrypted = await crypto.aesGcmEncrypt({ key: master, iv, plaintext: value });
        const bytes = new Uint8Array(iv.length + encrypted.length);
        bytes.set(iv); bytes.set(encrypted, iv.length);
        await files.writeAtomic(pathOf(key), bytes);
      },
      async getSecret(key) {
        ensureEnabled();
        if (!await files.exists(pathOf(key))) return null;
        const bytes = await files.readBytes(pathOf(key));
        return utf8Decode(await crypto.aesGcmDecrypt({ key: await keyFor(dir), iv: bytes.subarray(0, 12), ciphertext: bytes.subarray(12) }), { fatal: true });
      },
      async deleteSecret(key) { await files.rm(pathOf(key), { force: true }); },
      async listSensitiveKeys() {
        if (!await files.exists(dir)) return new Set();
        return new Set((await files.readDir(dir)).filter(entry => entry.name.endsWith('.enc')).map(entry => entry.name.slice(0, -4)));
      },
      async isAvailable() { try { ensureEnabled(); await keyFor(dir); return true; } catch { return false; } },
      async keystoreProtectionStatus() { return { supported: false, enabled: false, seedInKeystore: false }; },
      async setKeystoreProtection(enabled) { if (enabled) unsupported(); },
      saveCloudCredentials: unsupported, getCloudCredentials: unsupported, updateCloudCredentials: unsupported,
      cloudCredentialStatus: unsupported, clearCloudEncryptionPassword: unsupported, deleteCloudCredentials: unsupported,
      cloudCredentialsActiveGeneration: unsupported, writeStagedCloudCredentials: unsupported,
      commitStagedCloudCredentials: unsupported, abortStagedCloudCredentials: unsupported, deleteCloudCredentialsTransactional: unsupported,
    };
    return store;
  };
  return {
    openStore, openFallbackStore: options => openStore(base, options), isSensitiveKey, keystoreSupported: () => false,
    validateBackupSeedFile: unsupported, resolveSeedFilePlaintext: unsupported, resealSeedFileForCurrentPlatform: unsupported,
    seedFingerprint: seed => sha256HexSync('deep-student.key_seed.fingerprint.v1' + seed),
    openCrypto, isEncryptedFormat, deriveStaticKey: sha256Sync,
    cloudEncryptionPasswordTooShort: unsupported, cloudEncryptionPasswordTooWeak: unsupported,
    backup: {
      encryptBackup: unsupported, decryptBackup: unsupported, encryptBackupFile: unsupported, decryptBackupFile: unsupported,
      encryptBackupStream: unsupported, decryptBackupStream: unsupported, isEncryptedBackup: unsupported,
      dsbkFirstChunkSpeculativePrefixLen: unsupported, planFirstChunkTrial: unsupported, trialDecryptFirstChunk: unsupported,
      createFileCipherSession: unsupported, createPasswordVerifier: unsupported, checkPasswordVerifier: unsupported,
      encryptedRootMemory: unsupported, encryptedRootFingerprint: unsupported,
    },
    publication: { journalPath: unsupported, rollbackDir: unsupported, writeJournal: unsupported, removeJournal: unsupported, recover: unsupported },
  };
}

export default definePlugin({
  meta: { id: 'dstu.platform.secrets', provides: ['secrets'], platforms: ['mobile'] },
  inject: ['files', 'crypto', 'paths'],
  apply(ctx) { ctx.reflect.provide('secrets', createMobileSecrets(ctx.files, ctx.crypto, ctx.paths.appDataDir)); },
});
