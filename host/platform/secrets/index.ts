/**
 * `ctx.secrets` 实现。格式与兼容性说明见 ./api.ts 与 ../API.md。
 */
import { mkdirSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import { definePlugin } from '../../kernel/api.ts';
import { ioMessage } from '../paths/compat.ts';
import type { Logger } from '../log/api.ts';
import type { OsDirs } from '../paths/api.ts';
import type { OpenSecureStoreOptions, SecretsService, SecureStore, SeedKeystore } from './api.ts';
import { CryptoServiceImpl, deriveStaticKey, isEncryptedFormat } from './crypto-service.ts';
import { platformSeedKeystore } from './keystore.ts';
import { createBackupCrypto } from './backup-crypto.ts';
import { createCryptoPublication } from './crypto-publication.ts';
import {
  cloudEncryptionPasswordTooShort,
  cloudEncryptionPasswordTooWeak,
  isSensitiveKey,
  resealSeedFileForCurrentPlatform,
  resolveSeedFilePlaintext,
  SecureStoreImpl,
  seedFingerprint,
  validateBackupSeedFile,
  type SecureStoreInternals,
} from './secure-store.ts';
import { keystoreDisabledByEnv } from './keystore.ts';
import { registerCommands } from './commands.ts';
import type { NativeArgon2 } from '../native/api.ts';

export type * from './api.ts';
export { BackupCryptoError } from './backup-crypto.ts';
export { CryptoServiceError } from './crypto-service.ts';
export { CryptoPublicationError } from './crypto-publication.ts';
export { SecureStoreError, CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE, CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE, CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK_CODE } from './api.ts';

export interface SecretsServiceOptions {
  os: OsDirs;
  log: Logger;
  platform?: NodeJS.Platform;
  env?: Readonly<Record<string, string | undefined>>;
  /** 默认平台密钥库；缺省 = `platformSeedKeystore(platform, env)`。 */
  keystore?: SeedKeystore | null;
  /** Optional real raw Argon2id provider for this service's backup factory. */
  nativeArgon2?: NativeArgon2;
}

export function createSecretsService(options: SecretsServiceOptions): SecretsService {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const defaultKeystore = options.keystore !== undefined ? options.keystore : platformSeedKeystore(platform, env);
  const resolveKeystore = (o?: OpenSecureStoreOptions): SeedKeystore | null => {
    const ks = o?.keystore !== undefined ? o.keystore : defaultKeystore;
    return keystoreDisabledByEnv(env) ? null : ks;
  };
  const internals = (secureDir: string | null, o?: OpenSecureStoreOptions): SecureStoreInternals => ({
    secureDir,
    enabled: o?.enabled ?? true,
    keystore: resolveKeystore(o),
    platform,
    env,
    os: options.os,
    log: options.log,
  });
  const store = (secureDir: string | null, o?: OpenSecureStoreOptions): SecureStore => {
    // Rust `SecureStore::new_with_dir`（531）：构造期尽力创建 `.secure`，失败仅告警。
    if (secureDir !== null) {
      try {
        mkdirSync(secureDir, { recursive: true });
      } catch (error) {
        options.log.warn(`创建安全存储目录失败: ${ioMessage(error)}`);
      }
    }
    options.log.info(secureDir === null ? '✅ 安全存储已启用 (平台: Encrypted File Storage)' : `✅ 安全存储已启用 (目录: ${JSON.stringify(secureDir)})`);
    return new SecureStoreImpl(internals(secureDir, o));
  };
  const sep = platform === 'win32' ? '\\' : '/';

  return {
    openStore: (appDataDir, o) => store(`${appDataDir}${appDataDir.endsWith(sep) ? '' : sep}.secure`, o),
    openFallbackStore: (o) => store(null, o),
    isSensitiveKey,
    keystoreSupported: () => resolveKeystore() !== null,
    validateBackupSeedFile: (seedFile, o) => validateBackupSeedFile(seedFile, resolveKeystore(o), platform),
    resolveSeedFilePlaintext: (seedFile, o) => resolveSeedFilePlaintext(seedFile, resolveKeystore(o), platform),
    resealSeedFileForCurrentPlatform: (seedFile) => resealSeedFileForCurrentPlatform(seedFile, internals(null)),
    seedFingerprint,
    openCrypto: (dir) => CryptoServiceImpl.open(dir, { log: options.log, platform, env }),
    isEncryptedFormat,
    deriveStaticKey,
    cloudEncryptionPasswordTooShort,
    cloudEncryptionPasswordTooWeak,
    backup: createBackupCrypto({ nativeArgon2: options.nativeArgon2 }),
    publication: createCryptoPublication(options.log),
  };
}

/** Cordis 插件：`ctx.secrets`。 */
export default definePlugin({
  meta: { id: 'dstu.platform.secrets', lane: 'F4-security', provides: ['secrets'], commands: [
    'secure_save_cloud_credentials', 'secure_get_cloud_credentials', 'secure_delete_cloud_credentials',
    'secure_clear_cloud_encryption_password', 'secure_store_is_available', 'secure_store_get_keystore_protection',
    'secure_store_set_keystore_protection', 'secret_prompt_submit', 'secret_prompt_status', 'secret_prompt_discard', 'secret_prompt_capabilities',
  ] },
  inject: ['paths', 'log'],
  apply(ctx: Context) {
    // The official profile installs dstu.native before secrets. Preserve legacy
    // minimal profiles without it; a selected native provider's errors propagate.
    const nativeArgon2 = ctx.reflect.get('nativeArgon2', false) as NativeArgon2 | undefined;
    ctx.reflect.provide('secrets', createSecretsService({ os: ctx.paths.os,
      log: ctx.log.logger('dstu_security::secure_store'), nativeArgon2 }));
    registerCommands(ctx);
  },
});
