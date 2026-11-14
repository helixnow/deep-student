/** Profile persistence, built-in snapshots and user-hidden model reconciliation. */
import type { ModelProfile, VendorConfig } from '../api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { loadAllBuiltins } from './config_builtins.ts';
import { mergeBuiltinProfileUserAware } from './config_resolution.ts';
import { decodeStringVector, normalizeProfileRecord } from './config_values.ts';
import { normalizeModelProfileProtocolConfig } from './protocol.ts';
import { configurationError, databaseError, messageOf } from './config_errors.ts';
import { logInfo, logWarn } from './logging.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import { formatF32 } from '../../../platform/serde-compat/index.ts';

const PROFILES = 'model_profiles';
const SNAPSHOT = 'builtin_model_profiles_snapshot';
const HIDDEN = 'hidden_builtin_model_profile_ids';
const CAPS = 'builtin_caps_migration_v2';

/** Rust `ModelProfile` 的 serde 字段顺序，快照/条目按此顺序序列化以保持字节一致。 */
const PROFILE_JSON_FIELDS = [
  'id', 'vendorId', 'label', 'model', 'providerScope', 'apiProtocol', 'modelAdapter',
  'isMultimodal', 'isReasoning', 'isEmbedding', 'isReranker', 'isImageGeneration',
  'supportsTools', 'supportsReasoning', 'status', 'enabled', 'maxOutputTokens', 'temperature',
  'reasoningEffort', 'reasoningMode', 'thinkingEnabled', 'thinkingBudget', 'includeThoughts',
  'enableThinking', 'minP', 'topK', 'geminiApiVersion', 'isBuiltin', 'repetitionPenalty',
  'reasoningSplit', 'effort', 'verbosity', 'isFavorite', 'maxTokensLimit', 'contextWindow', 'extraBody',
] as const;
/** Rust `f32` 字段：serde_json 写 zmij 的 f32 最短十进制（0.7 而非 0.699999988079071，1.0 而非 1）；DB 文本比较按字节。 */
const PROFILE_FLOAT_FIELDS = new Set(['temperature', 'minP', 'repetitionPenalty']);

/** `serde_json::to_string(&Vec<ModelProfile>)` 等价输出：固定字段顺序 + f32 格式。 */
export function stringifyProfileArray(profiles: readonly ModelProfile[]): string {
  const items = profiles.map(profile => {
    const record = profile as unknown as Record<string, unknown>;
    const fields = PROFILE_JSON_FIELDS.map(key => {
      const value = record[key] ?? null;
      const json = PROFILE_FLOAT_FIELDS.has(key) && typeof value === 'number'
        ? formatF32(value)
        : JSON.stringify(value);
      return `${JSON.stringify(key)}:${json}`;
    });
    return `{${fields.join(',')}}`;
  });
  return `[${items.join(',')}]`;
}

export class ModelProfileStore {
  private readonly settings: SettingsStore;
  private readonly readVendors: () => Promise<VendorConfig[]>;
  constructor(settings: SettingsStore, readVendors: () => Promise<VendorConfig[]>) {
    this.settings = settings;
    this.readVendors = readVendors;
  }

  private save(key: string, value: unknown, serializeFailure: string, saveFailure: string): void {
    let json: string;
    try { json = JSON.stringify(value); }
    catch (error) { throw configurationError(`${serializeFailure}: ${messageOf(error)}`); }
    try { this.settings.save(key, json); }
    catch (error) { throw databaseError(`${saveFailure}: ${messageOf(error)}`); }
  }

  private saveProfiles(key: string, profiles: readonly ModelProfile[], serializeFailure: string, saveFailure: string): void {
    let json: string;
    try { json = stringifyProfileArray(profiles); }
    catch (error) { throw configurationError(`${serializeFailure}: ${messageOf(error)}`); }
    try { this.settings.save(key, json); }
    catch (error) { throw databaseError(`${saveFailure}: ${messageOf(error)}`); }
  }

  async read(): Promise<ModelProfile[]> {
    let raw: string;
    try { raw = this.settings.get(PROFILES) ?? '[]'; }
    catch (error) { throw databaseError(`获取模型条目失败: ${messageOf(error)}`); }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (error) { throw configurationError(`解析模型条目失败: ${messageOf(error)}`); }
    if (!Array.isArray(parsed)) throw configurationError('解析模型条目失败: invalid type: expected a sequence');
    try { return parsed.map(normalizeProfileRecord); }
    catch (error) { throw configurationError(`解析模型条目失败: ${messageOf(error)}`); }
  }

  private hidden(): Set<string> {
    let raw: string | null;
    try { raw = this.settings.get(HIDDEN); }
    catch { return new Set(); } // mod.rs:4667–4669: database read failure is silent.
    if (raw === null) return new Set();
    try {
      const parsed: unknown = JSON.parse(raw);
      return new Set(decodeStringVector(parsed).map(rustTrim).filter(id => id !== ''));
    } catch (error) {
      logWarn(`[VendorModel] 解析隐藏内置模型列表失败，回退为空列表: ${messageOf(error)}`);
      return new Set();
    }
  }
  private saveHidden(ids: ReadonlySet<string>): void {
    this.save(HIDDEN, [...ids].filter(id => rustTrim(id) !== '').sort(), '序列化隐藏内置模型列表失败', '保存隐藏内置模型列表失败');
  }
  private snapshot(): Map<string, ModelProfile> {
    try {
      const raw = this.settings.get(SNAPSHOT);
      if (raw === null) return new Map();
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Map();
      return new Map(parsed.map(profile => { const value = normalizeProfileRecord(profile); return [value.id, value]; }));
    } catch { return new Map(); }
  }

  async get(): Promise<ModelProfile[]> {
    let profiles = await this.read();
    const hidden = this.hidden();
    let migrated: boolean;
    try { migrated = this.settings.get(CAPS) !== null; } catch { migrated = false; }
    if (!migrated) {
      const builtinMap = new Map(loadAllBuiltins([], []).profiles.map(profile => [profile.id, profile]));
      let patched = false;
      for (const profile of profiles) {
        const builtin = builtinMap.get(profile.id);
        if (builtin === undefined) continue;
        if (profile.supportsTools !== builtin.supportsTools || profile.isMultimodal !== builtin.isMultimodal
          || profile.isReasoning !== builtin.isReasoning || profile.supportsReasoning !== builtin.supportsReasoning) {
          profile.isMultimodal = builtin.isMultimodal; profile.isReasoning = builtin.isReasoning;
          profile.isEmbedding = builtin.isEmbedding; profile.isReranker = builtin.isReranker;
          profile.supportsTools = builtin.supportsTools; profile.supportsReasoning = builtin.supportsReasoning;
          patched = true;
          logInfo(`[VendorModel] 迁移: ${profile.id} 能力字段已从内置定义同步 (supports_tools=${builtin.supportsTools})`);
        }
      }
      if (patched) {
        try { await this.write(profiles); }
        catch (error) { logWarn(`[VendorModel] 迁移保存失败（不影响本次读取）: ${messageOf(error)}`); }
      }
      try { this.settings.save(SNAPSHOT, '[]'); } catch { // boundary-allow empty-catch: Rust let _ = save_setting ignores this result
      }
      try { this.settings.save(CAPS, 'done'); } catch { // boundary-allow empty-catch: Rust independently attempts the migration marker write
      }
      logInfo('[VendorModel] 能力字段迁移完成');
    }
    const snapshot = this.snapshot(), builtinProfiles = loadAllBuiltins([], []).profiles;
    try {
      const builtinMap = new Map(builtinProfiles.map(profile => [profile.id, profile]));
      const knownModels = new Map(profiles.filter(profile => builtinMap.has(profile.id)).map(profile => [profile.id, profile.model]));
      const original = new Set(hidden);
      for (const id of hidden) {
        const current = builtinMap.get(id);
        if (current === undefined || (snapshot.get(id)?.model !== current.model && knownModels.get(id) !== current.model)) hidden.delete(id);
      }
      if (hidden.size !== original.size || [...hidden].some(id => !original.has(id))) this.saveHidden(hidden);
    } catch (error) { logWarn(`[VendorModel] 修正隐藏内置模型列表失败，继续使用现有值: ${messageOf(error)}`); }
    if (hidden.size > 0) profiles = profiles.filter(profile => !hidden.has(profile.id));
    for (const builtin of builtinProfiles) if (!hidden.has(builtin.id)) mergeBuiltinProfileUserAware(profiles, builtin, snapshot.get(builtin.id));
    try { this.saveProfiles(SNAPSHOT, builtinProfiles, '序列化内置模型快照失败', '保存内置模型快照失败'); }
    catch (error) { logWarn(`[VendorModel] 保存内置模型快照失败（不影响读取）: ${messageOf(error)}`); }
    return profiles;
  }

  async write(profiles: readonly ModelProfile[]): Promise<void> {
    const builtin = loadAllBuiltins([], []);
    const ids = new Set(builtin.profiles.map(profile => profile.id));
    const models = new Map(builtin.profiles.map(profile => [profile.id, profile.model]));
    const incoming = new Set(profiles.map(profile => profile.id).filter(id => ids.has(id)));
    const existing = await this.read().catch((): ModelProfile[] => []);
    const snapshot = this.snapshot();
    const known = new Set([...ids].filter(id => {
      const model = models.get(id);
      return model !== undefined && (snapshot.get(id)?.model === model || existing.some(profile => profile.id === id && profile.model === model));
    }));
    if (known.size > 0 || incoming.size > 0) this.saveHidden(new Set([...known].filter(id => !incoming.has(id))));
    const vendors = new Map((await this.readVendors().catch((): VendorConfig[] => [])).map(vendor => [vendor.id, vendor]));
    for (const vendor of builtin.vendors) if (!vendors.has(vendor.id)) vendors.set(vendor.id, vendor);
    const sanitized = profiles.map(profile => ({ ...profile }));
    for (const profile of sanitized) normalizeModelProfileProtocolConfig(profile, vendors.get(profile.vendorId));
    this.saveProfiles(PROFILES, sanitized, '序列化模型条目失败', '保存模型条目失败');
  }
}
