/**
 * 供应商 / 模型条目 / 旧版 ApiConfig 配置存储（移植 `dstu-llm/src/llm_manager/mod.rs`
 * 3552–3708、4094–4175、4575–4790、5650–5756、5756–6440、6681–7010、7881–7946）。
 *
 * 所有持久化键与 Rust 一致：`vendor_configs`、`model_profiles`、`model_assignments`、
 * `api_configs`、`builtin_model_profiles_snapshot`、`hidden_builtin_model_profile_ids`、
 * `builtin_caps_migration_v2`。内置供应商 API Key 走安全存储键 `<vendorId>.api_key`
 * （SiliconFlow 兼容键 `siliconflow.api_key`）。
 */
const randomUUID = () => globalThis.crypto.randomUUID();
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { CryptoService } from '../../../platform/secrets/api.ts';
import type {
  ApiConfig, ApiConfig__De, ModelAssignments, ModelAssignments__De,
  ModelProfile, VendorConfig,
} from '../api.ts';
import {
  AUTH_MODE_NONE, normalizeModelProfileProtocolConfig,
  normalizeVendorProtocolConfig, providerSupportsOpenaiResponses, resolvePreferredProtocolForProvider,
} from './protocol.ts';
import { loadAllBuiltins } from './config_builtins.ts';
import { defaultVendorConfig, modelProfileFromDe, apiConfigFromDe, modelAssignmentsFromDe,
  EMPTY_MODEL_ASSIGNMENTS, deserializeVendorConfigs, normalizeProfileRecord, type ApiConfigInput } from './config_values.ts';
import { isMaskedSecret, isSensitiveVendorHeader, apiOriginsMatch, isValidHeaderName,
  isValidHeaderValue, mergeVendorProfile } from './config_resolution.ts';
import { configurationError, databaseError, validationError, messageOf } from './config_errors.ts';
import { ModelProfileStore } from './config_profiles.ts';
import { resolveCapabilityOverrides, looksLikeImageGenerationModelId } from './capabilities.ts';
import { logInfo, logWarn } from './logging.ts';

export { ConfigError } from './config_errors.ts';

export interface ConfigDeps {
  readonly settings: SettingsStore;
  /** `CryptoService::new(app_data_dir)`，惰性打开并缓存。 */
  openCrypto(): Promise<CryptoService>;
  isEncryptedFormat(value: string): boolean;
  /** The active L01 manager shared with Codex IPC, never a second credential snapshot. */
  hasUsableCodexSession?(): Promise<boolean>;
}

const VENDOR_CONFIGS_KEY = 'vendor_configs';
const MODEL_PROFILES_KEY = 'model_profiles';
const MODEL_ASSIGNMENTS_KEY = 'model_assignments';
const API_CONFIGS_KEY = 'api_configs';

const DEFAULT_MODEL_ADAPTER = 'general';
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_GEMINI_API_VERSION = 'v1';


export { isMaskedSecret, isSensitiveVendorHeader, apiOriginsMatch,
  mergeVendorProfile, mergeBuiltinProfileUserAware, type ResolvedModelConfig } from './config_resolution.ts';

export { defaultVendorConfig, vendorConfigFromDe, modelProfileFromDe, apiConfigFromDe,
  EMPTY_MODEL_ASSIGNMENTS, modelAssignmentsFromDe, deserializeVendorConfigs,
  normalizeVendorRecord, normalizeProfileRecord } from './config_values.ts';

export { loadBuiltinVendors, loadBuiltinModels, loadAllBuiltins } from './config_builtins.ts';

export class LlmConfigStore {
  private cryptoPromise: Promise<CryptoService> | null = null;

  private readonly profiles: ModelProfileStore;
  private readonly deps: ConfigDeps;

  constructor(deps: ConfigDeps) {
    this.deps = deps;
    this.profiles = new ModelProfileStore(deps.settings, () => this.readUserVendorConfigs());
  }

  private get settings(): SettingsStore {
    return this.deps.settings;
  }

  private getSetting(key: string, failure: string): string | null {
    try {
      return this.settings.get(key);
    } catch (error) {
      throw databaseError(`${failure}: ${messageOf(error)}`);
    }
  }

  private saveSetting(key: string, value: string, failure: string): void {
    try {
      this.settings.save(key, value);
    } catch (error) {
      throw databaseError(`${failure}: ${messageOf(error)}`);
    }
  }

  private async crypto(): Promise<CryptoService> {
    if (this.cryptoPromise === null) this.cryptoPromise = this.deps.openCrypto();
    return this.cryptoPromise;
  }

  async encryptApiKey(apiKey: string): Promise<string> {
    if (this.deps.isEncryptedFormat(apiKey)) return apiKey;
    const crypto = await this.crypto();
    try {
      return crypto.migratePlaintextKey(apiKey);
    } catch (error) {
      throw configurationError(`加密API密钥失败: ${messageOf(error)}`);
    }
  }

  async decryptApiKeyIfNeeded(apiKey: string): Promise<string> {
    if (!this.deps.isEncryptedFormat(apiKey)) return apiKey;
    let data: { ciphertext: string; nonce: string; version: number | null };
    try {
      data = JSON.parse(apiKey) as typeof data;
    } catch (error) {
      throw configurationError(`解析加密数据失败: ${messageOf(error)}`);
    }
    const crypto = await this.crypto();
    try {
      return crypto.decryptApiKey(data);
    } catch (error) {
      throw configurationError(`解密API密钥失败: ${messageOf(error)}`);
    }
  }

  async hasUsableCodexSession(): Promise<boolean> {
    return this.deps.hasUsableCodexSession?.() ?? false;
  }

  // ---------------------------------------------------------------- 供应商

  /** `bootstrap_vendor_model_config` */
  async bootstrapVendorModelConfig(): Promise<void> {
    const vendorExists = this.getSetting(VENDOR_CONFIGS_KEY, '检测供应商配置失败') !== null;
    const profileExists = this.getSetting(MODEL_PROFILES_KEY, '检测模型条目失败') !== null;
    if (vendorExists && profileExists) {
      await this.repairVendorModelProtocolSettings();
      return;
    }

    const legacyRaw =
      this.getSetting(API_CONFIGS_KEY, '获取旧版API配置失败') ?? '[]';
    let legacyConfigs: ApiConfig[] = [];
    if (legacyRaw.trim() !== '' && legacyRaw.trim() !== '[]') {
      let parsed: ApiConfig[] | null = null;
      try {
        parsed = JSON.parse(legacyRaw) as ApiConfig[];
      } catch {
        parsed = null;
      }
      if (parsed !== null && Array.isArray(parsed)) {
        for (const config of parsed) {
          config.apiKey = await this.decryptApiKeyIfNeeded(config.apiKey);
        }
        legacyConfigs = parsed;
      } else {
        legacyConfigs = await this.migrateApiConfigsLegacy(legacyRaw);
      }
    }

    if (legacyConfigs.length === 0) {
      await this.saveVendorModelConfigs([], []);
      return;
    }

    const { vendors, profiles } = await this.flattenApiConfigsToVendorProfiles(legacyConfigs);
    legacyConfigs = [];
    await this.saveVendorModelConfigs(
      vendors.filter((vendor) => !vendor.isBuiltin),
      profiles.filter((profile) => !profile.isBuiltin),
    );
  }

  /** `repair_vendor_model_protocol_settings` */
  async repairVendorModelProtocolSettings(): Promise<void> {
    const rawVendors = this.getSetting(VENDOR_CONFIGS_KEY, '读取供应商配置失败') ?? '[]';
    const rawProfiles = this.getSetting(MODEL_PROFILES_KEY, '读取模型条目失败') ?? '[]';

    let vendors: VendorConfig[];
    let profiles: ModelProfile[];
    try {
      vendors = deserializeVendorConfigs(rawVendors);
    } catch (error) {
      throw configurationError(`解析供应商配置失败: ${messageOf(error)}`);
    }
    try {
      const parsed = JSON.parse(rawProfiles) as unknown;
      if (!Array.isArray(parsed)) throw new TypeError('invalid type: expected a sequence');
      profiles = parsed.map(normalizeProfileRecord);
    } catch (error) {
      throw configurationError(`解析模型条目失败: ${messageOf(error)}`);
    }

    let changed = false;
    for (const vendor of vendors) {
      changed = normalizeVendorProtocolConfig(vendor) || changed;
    }
    const vendorMap = new Map(vendors.map((vendor) => [vendor.id, vendor]));
    const builtins = this.loadBuiltinVendorProfiles();
    for (const vendor of builtins.vendors) {
      if (!vendorMap.has(vendor.id)) vendorMap.set(vendor.id, vendor);
    }
    for (const profile of profiles) {
      const vendor = vendorMap.get(profile.vendorId);
      changed = normalizeModelProfileProtocolConfig(profile, vendor) || changed;
    }

    if (changed) await this.saveVendorModelConfigs(vendors, profiles);
  }

  private loadBuiltinVendorProfiles(): { vendors: VendorConfig[]; profiles: ModelProfile[] } {
    return loadAllBuiltins([], []);
  }

  async readUserVendorConfigs(): Promise<VendorConfig[]> {
    const raw = this.getSetting(VENDOR_CONFIGS_KEY, '获取供应商配置失败') ?? '[]';
    let vendors: VendorConfig[];
    try {
      vendors = deserializeVendorConfigs(raw);
    } catch (error) {
      throw configurationError(`解析供应商配置失败: ${messageOf(error)}`);
    }

    for (const vendor of vendors) {
      for (const [name, value] of Object.entries(vendor.headers)) {
        if (!isSensitiveVendorHeader(name)) continue;
        try {
          vendor.headers[name] = await this.decryptApiKeyIfNeeded(value);
        } catch (error) {
          logWarn(`⚠️ 供应商 ${vendor.id} 的敏感请求头 ${name} 解密失败，将移除该请求头: ${messageOf(error)}`);
          vendor.headers[name] = '';
        }
      }
      for (const [name, value] of Object.entries(vendor.headers)) {
        if (value === '') delete vendor.headers[name];
      }

      const decryptedKeys: string[] = [];
      for (const key of vendor.apiKeys) {
        try {
          const decrypted = await this.decryptApiKeyIfNeeded(key);
          const trimmed = decrypted.trim();
          if (trimmed !== '') decryptedKeys.push(trimmed);
        } catch { // boundary-allow empty-catch: Rust `filter_map(|k| decrypt_api_key_if_needed(k).ok())` 丢弃解密失败条目
        }
      }
      vendor.apiKeys = decryptedKeys;

      try {
        const decrypted = await this.decryptApiKeyIfNeeded(vendor.apiKey);
        const isBuiltinVendor = vendor.isBuiltin || vendor.id.startsWith('builtin-');
        if (isBuiltinVendor && decrypted !== '') {
          try {
            await this.settings.saveSecret(`${vendor.id}.api_key`, decrypted);
            logInfo(`✅ 已迁移内置供应商 ${vendor.id} 的 API 密钥到安全存储`);
          } catch (error) {
            logWarn(`⚠️ 迁移内置供应商 ${vendor.id} 的 API 密钥到安全存储失败: ${messageOf(error)}`);
          }
          vendor.apiKey = '';
          vendor.isBuiltin = true;
          continue;
        }
        vendor.apiKey = decrypted;
      } catch (error) {
        logWarn(`⚠️ 供应商 ${vendor.id} 的 API 密钥解密失败，将清空密钥: ${messageOf(error)}`);
        vendor.apiKey = '';
      }
      normalizeVendorProtocolConfig(vendor);
    }
    return vendors;
  }

  async vendorConfigsForRuntime(): Promise<VendorConfig[]> {
    const vendors = await this.readUserVendorConfigs();
    const builtins = this.loadBuiltinVendorProfiles();
    for (const vendor of builtins.vendors) {
      const existing = vendors.find((item) => item.id === vendor.id);
      if (existing !== undefined) {
        if (vendor.authMode !== null) existing.authMode = vendor.authMode;
        continue;
      }
      vendors.push(vendor);
    }

    for (const vendor of vendors) {
      const isBuiltinVendor = vendor.isBuiltin || vendor.id.startsWith('builtin-');
      if (!isBuiltinVendor) continue;
      const isInvalid =
        vendor.apiKey === '' ||
        vendor.apiKey === '***' ||
        [...vendor.apiKey].every((character) => character === '*');
      if (isInvalid) {
        try {
          const key = await this.settings.getSecret(`${vendor.id}.api_key`);
          if (key !== null && key !== '') vendor.apiKey = key;
        } catch { // boundary-allow empty-catch: Rust `if let Ok(Some(key))` 忽略安全存储读取错误
        }
        if (vendor.id === 'builtin-siliconflow' && vendor.apiKey === '') {
          try {
            const legacy = await this.settings.getSecret('siliconflow.api_key');
            if (legacy !== null && legacy !== '') vendor.apiKey = legacy;
          } catch { // boundary-allow empty-catch: Rust `if let Ok(Some(sf_key))` 忽略安全存储读取错误
          }
        }
      }
      vendor.isBuiltin = true;
    }
    return vendors;
  }

  async vendorConfigForRuntime(vendorId: string): Promise<VendorConfig> {
    const vendor = (await this.vendorConfigsForRuntime()).find((item) => item.id === vendorId);
    if (vendor === undefined) throw configurationError('供应商不存在或已被删除');
    return vendor;
  }

  async runtimeConfigForVendorModel(vendorId: string, model: string): Promise<ApiConfig | null> {
    const vendor = await this.vendorConfigForRuntime(vendorId).catch(() => null);
    if (vendor === null) return null;
    const profiles = await this.getModelProfiles().catch(() => []);
    const profile = profiles.find((item) => item.vendorId === vendorId && item.model === model);
    if (profile === undefined) return null;
    const codexAuthenticated = await this.hasUsableCodexSession();
    return mergeVendorProfile(vendor, profile, codexAuthenticated, (value) => value).runtime;
  }

  async getVendorConfigs(): Promise<VendorConfig[]> {
    await this.bootstrapVendorModelConfig();
    const vendors = await this.readUserVendorConfigs();
    const builtins = this.loadBuiltinVendorProfiles();
    for (const vendor of builtins.vendors) {
      const existing = vendors.find((item) => item.id === vendor.id);
      if (existing !== undefined) {
        existing.notes = vendor.notes;
        existing.name = vendor.name;
        existing.websiteUrl = vendor.websiteUrl;
        if (vendor.authMode !== null) existing.authMode = vendor.authMode;
        existing.isBuiltin = true;
        continue;
      }
      vendor.apiKey = '';
      vendors.push(vendor);
    }

    for (const vendor of vendors) {
      const isBuiltinVendor = vendor.isBuiltin || vendor.id.startsWith('builtin-');
      let hasApiKey =
        vendor.apiKey.trim() !== '' &&
        vendor.apiKey !== '***' &&
        ![...vendor.apiKey].every((character) => character === '*');
      if (isBuiltinVendor && !hasApiKey) {
        try {
          const key = await this.settings.getSecret(`${vendor.id}.api_key`);
          if (key !== null && key !== '') hasApiKey = true;
        } catch { // boundary-allow empty-catch: Rust `if let Ok(Some(key))` 忽略安全存储读取错误
        }
        if (vendor.id === 'builtin-siliconflow' && !hasApiKey) {
          try {
            const sfKey = await this.settings.getSecret('siliconflow.api_key');
            if (sfKey !== null && sfKey !== '') hasApiKey = true;
          } catch { // boundary-allow empty-catch: Rust `if let Ok(Some(sf_key))` 忽略安全存储读取错误
          }
        }
      }
      vendor.apiKey = hasApiKey ? '***' : '';
      vendor.apiKeys = vendor.apiKeys.map(() => '***');
      for (const [name, value] of Object.entries(vendor.headers)) {
        if (isSensitiveVendorHeader(name) && value.trim() !== '') vendor.headers[name] = '***';
      }
      if (isBuiltinVendor) vendor.isBuiltin = true;
    }
    return vendors;
  }

  async saveVendorConfigs(configs: readonly VendorConfig[]): Promise<void> {
    const existingVendors = await this.readUserVendorConfigs().catch((): VendorConfig[] => []);
    const builtins = this.loadBuiltinVendorProfiles();
    for (const vendor of builtins.vendors) {
      if (!existingVendors.some((existing) => existing.id === vendor.id)) existingVendors.push(vendor);
    }
    const existingMap = new Map(existingVendors.map((vendor) => [vendor.id, vendor]));

    // 先完成跨配置校验，再触碰任何安全存储。
    for (const cfg of configs) {
      for (const [name, value] of Object.entries(cfg.headers)) {
        if (!isValidHeaderName(name)) throw validationError(`无效的供应商请求头名称: ${name}`);
        if (!isValidHeaderValue(value)) throw validationError('供应商请求头包含无效字符');
      }
      const existing = existingMap.get(cfg.id);
      if (existing === undefined) continue;
      if (apiOriginsMatch(existing.baseUrl, cfg.baseUrl)) continue;
      const usesNoAuth = cfg.authMode?.toLowerCase() === AUTH_MODE_NONE;
      if (!usesNoAuth) {
        if (isMaskedSecret(cfg.apiKey)) {
          throw validationError('修改供应商地址的主机、协议或端口时必须重新输入 API 密钥');
        }
        if (cfg.apiKeys.some((key) => isMaskedSecret(key))) {
          throw validationError('修改供应商地址的主机、协议或端口时必须重新输入备用 API 密钥');
        }
      }
      if (
        Object.entries(cfg.headers).some(
          ([name, value]) => isSensitiveVendorHeader(name) && isMaskedSecret(value),
        )
      ) {
        throw validationError('修改供应商地址的主机、协议或端口时必须重新输入敏感请求头');
      }
    }

    const sanitized: VendorConfig[] = [];
    for (const cfg of configs) {
      const clone: VendorConfig = { ...cfg, headers: { ...cfg.headers }, apiKeys: [...cfg.apiKeys] };
      normalizeVendorProtocolConfig(clone);

      const existing = existingMap.get(cfg.id);
      const originChanged =
        existing !== undefined && !apiOriginsMatch(existing.baseUrl, cfg.baseUrl);
      const usesNoAuth = cfg.authMode?.toLowerCase() === AUTH_MODE_NONE;

      const protectedHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(cfg.headers)) {
        if (!isSensitiveVendorHeader(name)) {
          protectedHeaders[name] = value;
          continue;
        }
        const trimmed = value.trim();
        const keepPlaceholder =
          trimmed === '***' || (trimmed !== '' && [...trimmed].every((character) => character === '*'));
        if (keepPlaceholder && originChanged) {
          throw validationError('修改供应商地址的主机、协议或端口时必须重新输入敏感请求头');
        }
        const effectiveValue = keepPlaceholder ? (existing?.headers[name] ?? '') : trimmed;
        if (effectiveValue !== '') {
          protectedHeaders[name] = await this.encryptApiKey(effectiveValue);
        }
      }
      clone.headers = protectedHeaders;

      if (usesNoAuth) {
        clone.apiKeys = [];
      } else {
        const existingKeys = existing?.apiKeys ?? [];
        const keysToStore: string[] = [];
        for (const [index, submittedRaw] of cfg.apiKeys.entries()) {
          const submitted = submittedRaw.trim();
          if (submitted === '') continue;
          const isPlaceholder = submitted === '***' || [...submitted].every((character) => character === '*');
          if (isPlaceholder) {
            if (originChanged) {
              throw validationError('修改供应商地址的主机、协议或端口时必须重新输入备用 API 密钥');
            }
            const existingKey = existingKeys[index];
            if (existingKey !== undefined) keysToStore.push(existingKey);
          } else {
            keysToStore.push(submitted);
          }
        }
        const encryptedKeys: string[] = [];
        for (const key of keysToStore) encryptedKeys.push(await this.encryptApiKey(key));
        clone.apiKeys = encryptedKeys;
      }

      const trimmed = usesNoAuth ? '' : cfg.apiKey.trim();
      const keepPlaceholder =
        trimmed === '***' || (trimmed !== '' && [...trimmed].every((character) => character === '*'));
      const isBuiltinVendor = cfg.isBuiltin || cfg.id.startsWith('builtin-');

      if (keepPlaceholder && originChanged) {
        throw validationError('修改供应商地址的主机、协议或端口时必须重新输入 API 密钥');
      }

      if (isBuiltinVendor) {
        const secretKey = `${cfg.id}.api_key`;
        if (keepPlaceholder) {
          // 保留安全存储中的值
        } else if (trimmed === '') {
          try {
            await this.settings.deleteSecret(secretKey);
          } catch (error) {
            throw databaseError(
              `Failed to clear builtin vendor API key for ${cfg.id}: ${messageOf(error)}`,
            );
          }
          if (cfg.id === 'builtin-siliconflow') {
            try {
              await this.settings.deleteSecret('siliconflow.api_key');
            } catch (error) {
              throw databaseError(`Failed to clear SiliconFlow compatibility key: ${messageOf(error)}`);
            }
          }
        } else {
          try {
            await this.settings.saveSecret(secretKey, trimmed);
          } catch (error) {
            throw databaseError(`Failed to save builtin vendor API key: ${messageOf(error)}`);
          }
          if (cfg.id === 'builtin-siliconflow') {
            try {
              await this.settings.saveSecret('siliconflow.api_key', trimmed);
            } catch (error) {
              throw databaseError(`Failed to save SiliconFlow compatibility key: ${messageOf(error)}`);
            }
          }
        }
        clone.apiKey = '';
        clone.isBuiltin = true;
      } else {
        const effectiveApiKey = keepPlaceholder
          ? (existingMap.get(cfg.id)?.apiKey ?? '')
          : trimmed;
        clone.apiKey = await this.encryptApiKey(effectiveApiKey);
        clone.isReadOnly = false;
      }
      sanitized.push(clone);
    }

    let json: string;
    try {
      json = JSON.stringify(sanitized);
    } catch (error) {
      throw configurationError(`序列化供应商配置失败: ${messageOf(error)}`);
    }
    this.saveSetting(VENDOR_CONFIGS_KEY, json, '保存供应商配置失败');
  }

  // ---------------------------------------------------------------- 模型条目

  async readUserModelProfiles(): Promise<ModelProfile[]> {
    return this.profiles.read();
  }

  async getModelProfiles(): Promise<ModelProfile[]> {
    await this.bootstrapVendorModelConfig();
    return this.profiles.get();
  }

  async saveModelProfiles(profiles: readonly ModelProfile[]): Promise<void> {
    await this.profiles.write(profiles);
  }

  async saveVendorModelConfigs(
    vendors: readonly VendorConfig[],
    profiles: readonly ModelProfile[],
  ): Promise<void> {
    await this.saveVendorConfigs(vendors);
    await this.saveModelProfiles(profiles);
  }

  // ---------------------------------------------------------------- 旧版 ApiConfig

  async getApiConfigs(): Promise<ApiConfig[]> {
    await this.bootstrapVendorModelConfig();
    const vendors = await this.vendorConfigsForRuntime();
    const profiles = await this.getModelProfiles();
    const vendorMap = new Map(vendors.map((vendor) => [vendor.id, vendor]));
    const codexAuthenticated = await this.hasUsableCodexSession();

    const resolved: ApiConfig[] = [];
    for (const profile of profiles) {
      const vendor = vendorMap.get(profile.vendorId);
      if (vendor === undefined) {
        logWarn(`[VendorModel] 找不到模型条目关联的供应商: ${profile.id}`);
        continue;
      }
      // `vendorConfigsForRuntime` 已解密非内置供应商的主/备用 key 与敏感头；
      // Rust `merge_vendor_profile` 的二次解密对明文是恒等操作。
      resolved.push(mergeVendorProfile(vendor, profile, codexAuthenticated, (value) => value).runtime);
    }
    return resolved;
  }

  /** Rust `LLMManager::candidate_api_keys_for`：主 key + 供应商额外 key（去重）。 */
  async candidateApiKeysFor(config: ApiConfig): Promise<string[]> {
    if ((config.authMode ?? '').toLowerCase() === AUTH_MODE_NONE) return [''];
    const keys = [config.apiKey];
    if (config.vendorId !== null && config.vendorId !== undefined) {
      let vendors: VendorConfig[] = [];
      try {
        vendors = await this.vendorConfigsForRuntime();
      } catch { // boundary-allow empty-catch: Rust `if let Ok(vendors)` 读取失败时只用主 key，不记录日志
      }
      const vendor = vendors.find((item) => item.id === config.vendorId);
      if (vendor !== undefined) {
        for (const raw of vendor.apiKeys) {
          const key = raw.trim();
          if (key !== '' && !keys.includes(key)) keys.push(key);
        }
      }
    }
    return keys;
  }

  async saveApiConfigurations(configs: readonly ApiConfig__De[]): Promise<void> {
    await this.bootstrapVendorModelConfig();
    const plainConfigs: ApiConfig[] = [];
    for (const de of configs) {
      const config = apiConfigFromDe(de);
      if (config.isBuiltin) continue;
      config.apiKey = await this.decryptApiKeyIfNeeded(config.apiKey);
      plainConfigs.push(config);
    }
    const { vendors, profiles } = await this.flattenApiConfigsToVendorProfiles(plainConfigs);
    await this.saveVendorModelConfigs(
      vendors.filter((vendor) => !vendor.isBuiltin),
      profiles.filter((profile) => !profile.isBuiltin),
    );
  }

  private async flattenApiConfigsToVendorProfiles(
    configs: readonly ApiConfig[],
  ): Promise<{ vendors: VendorConfig[]; profiles: ModelProfile[] }> {
    const vendorsMap = new Map<string, VendorConfig>();
    const profiles: ModelProfile[] = [];

    for (const cfg of configs) {
      const providerScope = cfg.providerScope ?? cfg.providerType;
      const capabilityOverrides = resolveCapabilityOverrides(cfg.model, providerScope);
      const key = cfg.vendorId ?? `auto::${cfg.baseUrl.trim()}::${cfg.apiKey.trim()}`;
      let vendorEntry = vendorsMap.get(key);
      if (vendorEntry === undefined) {
        const providerType = cfg.providerType ?? cfg.modelAdapter;
        vendorEntry = {
          id: cfg.vendorId ?? `vendor-${randomUUID()}`,
          name: cfg.vendorName !== null && cfg.vendorName !== '' ? cfg.vendorName : cfg.name,
          providerType,
          authMode: cfg.authMode,
          apiProtocol: cfg.apiProtocol,
          supportsOpenaiResponses: cfg.supportsOpenaiResponses,
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          apiKeys: [],
          headers: cfg.headers === null ? {} : { ...cfg.headers },
          rateLimitPerMinute: null,
          defaultTimeoutMs: null,
          notes: null,
          isBuiltin: cfg.isBuiltin,
          isReadOnly: cfg.isReadOnly,
          sortOrder: null,
          maxTokensLimit: cfg.maxTokensLimit,
          websiteUrl: null,
        };
        vendorsMap.set(key, vendorEntry);
      }

      profiles.push({
        id: cfg.id,
        vendorId: vendorEntry.id,
        label: cfg.name,
        model: cfg.model,
        providerScope,
        apiProtocol: cfg.apiProtocol,
        modelAdapter: cfg.modelAdapter,
        isMultimodal: cfg.isMultimodal || capabilityOverrides.isMultimodal,
        isReasoning: cfg.isReasoning,
        isEmbedding: cfg.isEmbedding,
        isReranker: cfg.isReranker,
        isImageGeneration:
          cfg.isImageGeneration || looksLikeImageGenerationModelId(cfg.model),
        supportsTools: cfg.supportsTools || capabilityOverrides.supportsTools,
        supportsReasoning:
          cfg.supportsReasoning || cfg.isReasoning || capabilityOverrides.supportsReasoning,
        status: cfg.enabled ? 'enabled' : 'disabled',
        enabled: cfg.enabled,
        maxOutputTokens: cfg.maxOutputTokens,
        temperature: cfg.temperature,
        reasoningEffort: cfg.reasoningEffort,
        reasoningMode: cfg.reasoningMode,
        thinkingEnabled: cfg.thinkingEnabled,
        thinkingBudget: cfg.thinkingBudget,
        includeThoughts: cfg.includeThoughts,
        enableThinking: cfg.enableThinking,
        minP: cfg.minP,
        topK: cfg.topK,
        geminiApiVersion: cfg.geminiApiVersion,
        isBuiltin: cfg.isBuiltin,
        isFavorite: cfg.isFavorite,
        maxTokensLimit: cfg.maxTokensLimit,
        contextWindow: cfg.contextWindow ?? capabilityOverrides.contextWindow,
        repetitionPenalty: cfg.repetitionPenalty,
        reasoningSplit: cfg.reasoningSplit,
        effort: cfg.effort,
        verbosity: cfg.verbosity,
        extraBody: cfg.extraBody,
      });
    }

    return { vendors: [...vendorsMap.values()], profiles };
  }

  private async migrateApiConfigsLegacy(oldConfigRaw: string): Promise<ApiConfig[]> {
    const migrateOne = (old: Record<string, unknown>, includeReasoning: boolean): ApiConfig => {
      const baseUrl = String(old['base_url'] ?? '');
      return {
        id: String(old['id'] ?? ''),
        name: String(old['name'] ?? ''),
        vendorId: null,
        vendorName: null,
        providerType: null,
        providerScope: null,
        authMode: null,
        apiProtocol: resolvePreferredProtocolForProvider(
          null,
          DEFAULT_MODEL_ADAPTER,
          baseUrl,
          null,
        ),
        supportsOpenaiResponses: providerSupportsOpenaiResponses(null, baseUrl, null),
        apiKey: String(old['api_key'] ?? ''),
        baseUrl,
        model: String(old['model'] ?? ''),
        isMultimodal: old['is_multimodal'] === true,
        isReasoning: includeReasoning && old['is_reasoning'] === true,
        isEmbedding: false,
        isReranker: false,
        isImageGeneration: false,
        enabled: old['enabled'] === true,
        modelAdapter: DEFAULT_MODEL_ADAPTER,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        temperature: DEFAULT_TEMPERATURE,
        supportsTools: false,
        geminiApiVersion: DEFAULT_GEMINI_API_VERSION,
        isBuiltin: false,
        isReadOnly: false,
        reasoningEffort: null,
        reasoningMode: null,
        thinkingEnabled: false,
        thinkingBudget: null,
        includeThoughts: false,
        minP: null,
        topK: null,
        enableThinking: null,
        supportsReasoning: includeReasoning && old['is_reasoning'] === true,
        headers: null,
        topPOverride: null,
        frequencyPenaltyOverride: null,
        presencePenaltyOverride: null,
        repetitionPenalty: null,
        reasoningSplit: null,
        effort: null,
        verbosity: null,
        isFavorite: false,
        maxTokensLimit: null,
        contextWindow: null,
        extraBody: null,
        resolvedAdapterId: null,
      };
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(oldConfigRaw);
    } catch (error) {
      throw configurationError(`解析旧版API配置失败: ${messageOf(error)}`);
    }
    if (!Array.isArray(parsed)) {
      throw configurationError('解析旧版API配置失败: invalid type: expected a sequence');
    }
    // V2 比 V1 多 `is_reasoning`；serde 把缺失字段视为类型错误。
    const isV2 = parsed.every(
      (item) => item !== null && typeof item === 'object' && 'is_reasoning' in item,
    );
    return parsed.map((item) => migrateOne(item as Record<string, unknown>, isV2));
  }

  // ---------------------------------------------------------------- 模型分配

  async getModelAssignments(): Promise<ModelAssignments> {
    const raw =
      this.getSetting(MODEL_ASSIGNMENTS_KEY, '获取模型分配配置失败') ??
      '{"model2_config_id": null, "review_analysis_model_config_id": null, "anki_card_model_config_id": null, "qbank_ai_grading_model_config_id": null}';
    try {
      const parsed: unknown = JSON.parse(raw);
      return modelAssignmentsFromDe(parsed);
    } catch (error) {
      throw configurationError(`解析模型分配配置失败: ${messageOf(error)}`);
    }
  }

  async saveModelAssignments(assignments: ModelAssignments__De): Promise<void> {
    const normalized = modelAssignmentsFromDe(assignments);
    let json: string;
    try {
      json = JSON.stringify(normalized);
    } catch (error) {
      throw configurationError(`序列化模型分配配置失败: ${messageOf(error)}`);
    }
    this.saveSetting(MODEL_ASSIGNMENTS_KEY, json, '保存模型分配配置失败');
  }
}
