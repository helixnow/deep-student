/**
 * `dstu-sync/src/cloud_config_commands.rs` + `cloud_credentials.rs`：
 * 非敏感云配置 SSOT、草稿试连与凭据自取（hydrate）。配置形状与校验见 `cloud-config-model.ts`。
 *
 * 非敏感字段只信任后端 SSOT；IPC 传入的 secret 一律丢弃，再由安全存储覆盖。
 * 明文公网传输只允许来自已持久化的 `allow_insecure` 决策。
 */

import type { Context } from '@deepseek-ai/cordis';
import {
  DESKTOP_CAPABILITIES, validateConfig,
  type PlatformStorageCapabilities, type RuntimeCloudStorageConfig, type SyncProviderService,
} from '../../sync-providers/api.ts';
import {
  CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE,
  SecureStoreError,
  type CloudStorageCredentials,
  type SecretsService,
} from '../../../platform/secrets/api.ts';
import type { CloudConfigService, CloudConfigPublishArgs } from '../../../platform/errors/cloud-config-api.ts';
import type {
  CloudConfigPublishResponse, CloudConfigSsotResponse,
} from '../../../../contracts/ipc/generated/F4-security.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';
import { CommandError } from '../../../kernel/api.ts';
import {
  CLOUD_CONFIG_INVALID_CODE, CloudConfigSsotError, applyCloudCredentials, applyDraftCredentials, intoRuntimeConfig,
  invalid, parseConfigObject, parseSafeCloudStorageConfig, providerName, replaceWithPersistedCloudConfig,
  serializableConfig, serializeSafeCloudStorageConfig, trim, validateAndNormalize, type SafeCloudStorageConfig,
} from './cloud-config-model.ts';

export {
  CLOUD_CONFIG_INVALID_CODE, CloudConfigSsotError, applyCloudCredentials, applyDraftCredentials, intoRuntimeConfig,
  parseSafeCloudStorageConfig, providerName, replaceWithPersistedCloudConfig, serializeSafeCloudStorageConfig,
  validateAndNormalize,
  type SafeCloudStorageConfig, type SafeFtpConfig, type SafeS3Config, type SafeWebDavConfig,
} from './cloud-config-model.ts';

export const CLOUD_CONFIG_SSOT_SETTING_KEY = 'cloud_storage.config.safe_v1';
export const CLOUD_CONNECTION_CHECK_FAILED_CODE = 'E_CLOUD_CONNECTION_CHECK_FAILED';
export const CLOUD_CONFIG_NOT_CONFIGURED_CODE = 'E_CLOUD_CONFIG_NOT_CONFIGURED';
export const CLOUD_CONFIG_STORAGE_CODE = 'E_CLOUD_CONFIG_STORAGE';
export const CLOUD_CREDENTIALS_UNAVAILABLE_CODE = 'E_CLOUD_CREDENTIALS_UNAVAILABLE';

const MAX_STORED_CONFIG_BYTES = 16 * 1_024;

export const CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_MESSAGE =
  `[${CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE}] 云端端到端加密密码至少需要 8 个字符（不能为空白）`;

export interface CloudConfigDraftTestResponse {
  ok: true;
  generation: number;
}

export interface CloudConfigSettingsStore {
  get(key: string): string | null;
  save(key: string, value: string): void;
}

function storage(detail: string): CloudConfigSsotError {
  return new CloudConfigSsotError(
    CLOUD_CONFIG_STORAGE_CODE,
    `cloud configuration storage failed: ${detail}`,
  );
}

function credentialsUnavailable(detail: string): CloudConfigSsotError {
  return new CloudConfigSsotError(
    CLOUD_CREDENTIALS_UNAVAILABLE_CODE,
    `cloud credentials are unavailable or incomplete: ${detail}`,
  );
}

export function saveCloudConfigSsot(
  settings: CloudConfigSettingsStore,
  config: SafeCloudStorageConfig,
  capabilities: PlatformStorageCapabilities = DESKTOP_CAPABILITIES,
): SafeCloudStorageConfig {
  const normalized = validateAndNormalize(config, capabilities);
  const encoded = serializeSafeCloudStorageConfig(normalized);
  if (utf8ByteLength(encoded) > MAX_STORED_CONFIG_BYTES) {
    throw invalid('serialized configuration is too large');
  }
  try {
    settings.save(CLOUD_CONFIG_SSOT_SETTING_KEY, encoded);
  } catch (error) {
    throw storage(error instanceof Error ? error.message : String(error));
  }
  return normalized;
}

export function loadCloudConfigSsot(
  settings: CloudConfigSettingsStore,
  capabilities: PlatformStorageCapabilities = DESKTOP_CAPABILITIES,
): SafeCloudStorageConfig {
  let encoded: string | null;
  try {
    encoded = settings.get(CLOUD_CONFIG_SSOT_SETTING_KEY);
  } catch (error) {
    throw storage(error instanceof Error ? error.message : String(error));
  }
  if (encoded === null) {
    throw new CloudConfigSsotError(
      CLOUD_CONFIG_NOT_CONFIGURED_CODE,
      'cloud sync is not configured in the backend SSOT',
    );
  }
  if (utf8ByteLength(encoded) > MAX_STORED_CONFIG_BYTES) {
    throw invalid('stored configuration is too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw invalid('stored configuration is malformed');
  }
  let config: SafeCloudStorageConfig;
  try {
    config = parseConfigObject(parsed);
  } catch {
    throw invalid('stored configuration is malformed');
  }
  return validateAndNormalize(config, capabilities);
}

export interface HydrateDeps {
  readonly settings: CloudConfigSettingsStore | null;
  readonly secrets: SecretsService | null;
  readonly dataDir: string;
  readonly warn: (message: string) => void;
}

/** `hydrate_cloud_config`：非敏感形状来自 SSOT，secret 来自安全存储。 */
export async function hydrateCloudConfig(
  config: RuntimeCloudStorageConfig,
  deps: HydrateDeps,
): Promise<void> {
  let persisted: SafeCloudStorageConfig | null = null;
  if (deps.settings !== null) {
    try {
      persisted = loadCloudConfigSsot(deps.settings);
    } catch (error) {
      if (!(error instanceof CloudConfigSsotError && error.code === CLOUD_CONFIG_NOT_CONFIGURED_CODE)) {
        deps.warn(`读取后端云配置 SSOT 失败（清空 IPC 配置并 fail-closed）: ${messageOf(error)}`);
      }
    }
  }
  replaceWithPersistedCloudConfig(config, persisted);
  await applyStoredCloudCredentials(config, deps);
}

async function applyStoredCloudCredentials(
  config: RuntimeCloudStorageConfig,
  deps: HydrateDeps,
): Promise<void> {
  let credentials: CloudStorageCredentials | null = null;
  if (deps.secrets !== null) {
    try {
      credentials = await deps.secrets.openStore(deps.dataDir).getCloudCredentials();
    } catch (error) {
      deps.warn(`读取云存储凭据失败（清空 IPC secret 并 fail-closed）: ${messageOf(error)}`);
    }
  }
  applyCloudCredentials(config, credentials);
}

/**
 * `load_hydrated_cloud_config_ssot`（cloud_config_commands.rs:547）：
 * SSOT 非敏感元数据 + 安全存储凭据 + 与 `create_storage` 相同的校验。
 * `NotConfigured` 返回 null（调用方映射“未配置”）；其它 SSOT 错误上抛；
 * 凭据缺失/不完整映射为 `E_CLOUD_CREDENTIALS_UNAVAILABLE`。
 */
export async function loadHydratedCloudConfigSsot(
  deps: HydrateDeps,
): Promise<RuntimeCloudStorageConfig | null> {
  if (deps.settings === null) return null;
  let persisted: SafeCloudStorageConfig;
  try {
    persisted = loadCloudConfigSsot(deps.settings);
  } catch (error) {
    if (error instanceof CloudConfigSsotError && error.code === CLOUD_CONFIG_NOT_CONFIGURED_CODE) return null;
    throw error;
  }
  const config = intoRuntimeConfig(persisted);
  await applyStoredCloudCredentials(config, deps);
  try {
    validateConfig(config);
  } catch (error) {
    throw credentialsUnavailable(messageOf(error));
  }
  return config;
}

export function rejectShortNewEncryptionPassword(
  secrets: SecretsService,
  credentials: CloudStorageCredentials,
  preexisting: boolean,
): void {
  if (!preexisting && secrets.cloudEncryptionPasswordTooShort(credentials.encryptionPassword ?? null)) {
    throw new CommandError({
      code: CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE,
      message: CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_MESSAGE,
    });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const value = (error as { value?: unknown }).value;
  if (typeof value === 'object' && value !== null) {
    const details = (value as { details?: unknown }).details;
    if (typeof details === 'object' && details !== null) {
      const code = (details as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
  }
  return null;
}

/** `cloud_app_error_to_command_error`：平台能力码优先，其余用调用方兜底码。 */
export function cloudAppErrorToCommandError(error: unknown, fallbackCode: string): CommandError {
  return new CommandError({ code: errorCode(error) ?? fallbackCode, message: messageOf(error) });
}

export function validateDraftRuntime(
  config: RuntimeCloudStorageConfig,
): void {
  try {
    validateConfig(config);
  } catch (error) {
    const code = errorCode(error);
    if (code !== null) throw cloudAppErrorToCommandError(error, CLOUD_CONFIG_INVALID_CODE);
    throw credentialsUnavailable(messageOf(error)).toCommandError();
  }
}

export interface CloudConfigDraftArgs {
  config: SafeCloudStorageConfig;
  credentials: CloudStorageCredentials;
  encryptionPasswordIsPreexisting?: boolean | null;
}

/** `cloud_config_test_connection_draft`：零持久化副作用的草稿试连。 */
export async function testConnectionDraft(
  ctx: Context,
  args: CloudConfigDraftArgs,
  deps: {
    readonly secrets: SecretsService | null;
    readonly provider: SyncProviderService | null;
  },
): Promise<CloudConfigDraftTestResponse> {
  if (deps.secrets === null) {
    throw new CommandError({
      code: 'SECURE_STORE_UNAVAILABLE',
      message: '安全存储服务尚未提供，无法读取云凭据 generation',
    });
  }
  rejectShortNewEncryptionPassword(
    deps.secrets,
    args.credentials,
    args.encryptionPasswordIsPreexisting === true,
  );

  let config: SafeCloudStorageConfig;
  try {
    config = validateAndNormalize(args.config);
  } catch (error) {
    if (error instanceof CloudConfigSsotError) throw error.toCommandError();
    throw error;
  }
  const runtime = intoRuntimeConfig(config);
  applyDraftCredentials(runtime, args.credentials);
  validateDraftRuntime(runtime);

  if (deps.provider === null) {
    throw new CommandError({
      code: CLOUD_CONFIG_INVALID_CODE,
      message: '云存储提供商服务（syncProvider）尚未提供，无法执行草稿连接测试',
    });
  }
  let storage;
  try {
    storage = await deps.provider.createStorage(runtime);
  } catch (error) {
    throw cloudAppErrorToCommandError(error, CLOUD_CONFIG_INVALID_CODE);
  }
  try {
    await storage.checkConnection();
  } catch (error) {
    throw cloudAppErrorToCommandError(error, CLOUD_CONNECTION_CHECK_FAILED_CODE);
  }

  const generation = await deps.secrets.openStore(ctx.app.dataDir).cloudCredentialsActiveGeneration();
  return { ok: true, generation: u64ToJsonNumber(generation) };
}


// ------------------------------------------------------------------ cloudConfig 服务（F4 命令的注入点）

/**
 * Rust `u64` → IPC JSON number。
 *
 * 与原 Tauri/serde_json 输出一致：整数直接作为 JSON number 发送，超出 JS
 * `Number.MAX_SAFE_INTEGER` 时允许发生与前端 JSON.parse 相同的精度收敛，
 * 不额外拒绝 Rust 合法输入（D3）。内部账本/比较仍使用 bigint。
 */
export function u64ToJsonNumber(value: bigint): number {
  return Number(value);
}

function secureStoreCommandError(error: unknown, operation: string): CommandError {
  if (error instanceof SecureStoreError) {
    return new CommandError({ ...error.toCommandError(operation), data: { operation } });
  }
  return new CommandError({
    code: 'SECURE_STORE_INTERNAL',
    message: messageOf(error),
    data: { operation },
  });
}

function ssotStorageError(error: unknown): CloudConfigSsotError {
  return new CloudConfigSsotError(
    CLOUD_CONFIG_STORAGE_CODE,
    `cloud configuration storage failed: ${messageOf(error)}`,
  );
}

type WireSafeCloudStorageConfig = NonNullable<CloudConfigSsotResponse['config']>;

/** Rust `SafeCloudStorageConfig` 的 serde 输出：`root` 为 None、`allow_insecure` 为 false 时省略。 */
function wireConfig(config: SafeCloudStorageConfig): WireSafeCloudStorageConfig {
  return serializableConfig(config) as WireSafeCloudStorageConfig;
}

/** Rust `CloudConfigSsotResponse`（cloud_config_commands.rs:115-125）：Option 字段为 None 时省略键。 */
function configuredView(config: SafeCloudStorageConfig): CloudConfigSsotResponse {
  return {
    configured: true,
    provider: providerName(config),
    ...(config.root === null ? {} : { root: config.root }),
    config: wireConfig(config),
  };
}

const UNCONFIGURED_VIEW: CloudConfigSsotResponse = { configured: false };

export interface CloudConfigServiceDeps {
  readonly settings: SettingsStore;
  readonly secrets: SecretsService;
  readonly dataDir: string;
  readonly warn: (message: string) => void;
}

/** `cloud_config_ssot_*` / `cloud_config_publish` 的服务实现（F4 命令层注入）。 */
export function createCloudConfigService(deps: CloudConfigServiceDeps): CloudConfigService {
  let mutationTail: Promise<unknown> = Promise.resolve();
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(operation);
    mutationTail = result.catch(() => {}); // boundary-allow empty-catch: keep mutation queue alive; caller awaits result directly
    return result;
  };
  const store = () => deps.secrets.openStore(deps.dataDir);
  const nonempty = (value: string | null | undefined): boolean =>
    value !== null && value !== undefined && trim(value) !== '';
  const normalizeCredentials = (credentials: {
    webdavPassword?: string | null; s3SecretAccessKey?: string | null;
    ftpPassword?: string | null; encryptionPassword?: string | null;
  }): CloudStorageCredentials => {
    const normalized: CloudStorageCredentials = {};
    if (credentials.webdavPassword != null) normalized.webdavPassword = credentials.webdavPassword;
    if (credentials.s3SecretAccessKey != null) normalized.s3SecretAccessKey = credentials.s3SecretAccessKey;
    if (credentials.ftpPassword != null) normalized.ftpPassword = credentials.ftpPassword;
    if (credentials.encryptionPassword != null) normalized.encryptionPassword = credentials.encryptionPassword;
    return normalized;
  };

  const service: CloudConfigService = {
    async save(config: SafeCloudStorageConfig): Promise<CloudConfigSsotResponse> {
      try {
        return configuredView(saveCloudConfigSsot(deps.settings, validateAndNormalize(parseSafeCloudStorageConfig(config))));
      } catch (error) {
        if (error instanceof CloudConfigSsotError) throw error.toCommandError();
        throw error;
      }
    },

    async get(): Promise<CloudConfigSsotResponse> {
      try {
        return configuredView(loadCloudConfigSsot(deps.settings));
      } catch (error) {
        if (error instanceof CloudConfigSsotError) {
          if (error.code === CLOUD_CONFIG_NOT_CONFIGURED_CODE) return UNCONFIGURED_VIEW;
          throw error.toCommandError();
        }
        throw error;
      }
    },

    async clear(): Promise<CloudConfigSsotResponse> {
      // fail-early：设置库连读都失败时，两条记录都不动。
      try {
        deps.settings.get(CLOUD_CONFIG_SSOT_SETTING_KEY);
      } catch (error) {
        throw ssotStorageError(error).toCommandError();
      }
      const secure = store();
      let credentialsSnapshot: CloudStorageCredentials | null;
      try {
        credentialsSnapshot = await secure.getCloudCredentials();
      } catch (error) {
        throw secureStoreCommandError(error, 'cloud_config_ssot_clear');
      }
      try {
        await secure.deleteCloudCredentialsTransactional();
      } catch (error) {
        throw secureStoreCommandError(error, 'delete_cloud_credentials_transactional');
      }
      try {
        deps.settings.delete(CLOUD_CONFIG_SSOT_SETTING_KEY);
      } catch (error) {
        let credentialsRestored = true;
        if (credentialsSnapshot !== null) {
          try {
            await secure.saveCloudCredentials(credentialsSnapshot);
          } catch (restoreError) {
            credentialsRestored = false;
            deps.warn(`清除云配置失败且凭据恢复失败（凭据已删、SSOT 残留）: ${messageOf(restoreError)}`);
          }
        }
        throw new CommandError({
          code: 'E_CLOUD_CONFIG_STORAGE',
          message: ssotStorageError(error).message,
          data: { operation: 'cloud_config_ssot_clear', credentialsRestored },
        });
      }
      return UNCONFIGURED_VIEW;
    },

    async publish(args: CloudConfigPublishArgs): Promise<CloudConfigPublishResponse> {
      const credentials = normalizeCredentials(args.credentials);
      rejectShortNewEncryptionPassword(
        deps.secrets,
        credentials,
        args.encryptionPasswordIsPreexisting === true,
      );
      // (a) raw SSOT snapshot；读失败即中止（什么都没写）。
      let ssotSnapshot: string | null;
      try {
        ssotSnapshot = deps.settings.get(CLOUD_CONFIG_SSOT_SETTING_KEY);
      } catch (error) {
        throw ssotStorageError(error).toCommandError();
      }
      let config: SafeCloudStorageConfig;
      try {
        config = validateAndNormalize(parseSafeCloudStorageConfig(args.config));
      } catch (error) {
        if (error instanceof CloudConfigSsotError) throw error.toCommandError();
        throw error;
      }
      const secure = store();
      let activeCredentials: CloudStorageCredentials;
      try {
        activeCredentials = (await secure.getCloudCredentials()) ?? {};
      } catch (error) {
        throw secureStoreCommandError(error, 'get_cloud_credentials');
      }
      const providerSecretPresent = config.provider === 'webdav'
        ? nonempty(credentials.webdavPassword) || nonempty(activeCredentials.webdavPassword)
        : config.provider === 's3'
          ? nonempty(credentials.s3SecretAccessKey) || nonempty(activeCredentials.s3SecretAccessKey)
          : nonempty(credentials.ftpPassword) || nonempty(activeCredentials.ftpPassword);
      if (!providerSecretPresent) {
        throw new CloudConfigSsotError(
          CLOUD_CREDENTIALS_UNAVAILABLE_CODE,
          `cloud credentials are unavailable or incomplete: 发布被拒绝：${providerName(config)} 凭据在草稿与已发布记录中均为空，发布后的 generation 将指向空凭据`,
        ).toCommandError();
      }
      let stagedGeneration: bigint;
      try {
        stagedGeneration = await secure.writeStagedCloudCredentials(
          credentials,
          args.encryptionPasswordIsPreexisting === true,
        );
      } catch (error) {
        throw secureStoreCommandError(error, 'write_staged_cloud_credentials');
      }
      let saved: SafeCloudStorageConfig;
      try {
        saved = saveCloudConfigSsot(deps.settings, config);
      } catch (error) {
        try {
          await secure.abortStagedCloudCredentials(stagedGeneration);
        } catch (abortError) {
          deps.warn(`发布失败后丢弃 staged 凭据失败（active 未受影响）: ${messageOf(abortError)}`);
        }
        if (error instanceof CloudConfigSsotError) throw error.toCommandError();
        throw error;
      }
      try {
        await secure.commitStagedCloudCredentials(stagedGeneration);
      } catch (error) {
        let ssotRestored = true;
        try {
          if (ssotSnapshot !== null) deps.settings.save(CLOUD_CONFIG_SSOT_SETTING_KEY, ssotSnapshot);
          else deps.settings.delete(CLOUD_CONFIG_SSOT_SETTING_KEY);
        } catch (restoreError) {
          ssotRestored = false;
          deps.warn(`提交凭据失败且 SSOT 恢复失败（凭据仍为旧 generation）: ${messageOf(restoreError)}`);
        }
        try {
          await secure.abortStagedCloudCredentials(stagedGeneration);
        } catch (abortError) {
          deps.warn(`提交失败后丢弃 staged 凭据失败: ${messageOf(abortError)}`);
        }
        throw new CommandError({
          code: error instanceof SecureStoreError ? error.stableCode : 'SECURE_STORE_INTERNAL',
          message: messageOf(error),
          data: { operation: 'commit_staged_cloud_credentials', ssotRestored },
        });
      }
      return {
        ok: true,
        generation: u64ToJsonNumber(stagedGeneration),
        provider: providerName(saved),
        ...(saved.root === null ? {} : { root: saved.root }),
        config: wireConfig(saved),
      };
    },
  };
  return {
    ...service,
    save: config => mutate(() => service.save(config)),
    publish: args => mutate(() => service.publish(args)),
    clear: () => mutate(() => service.clear()),
  };
}
