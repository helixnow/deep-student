/** Serde defaults and wire decoding for persisted LLM configurations. */
const randomUUID = () => globalThis.crypto.randomUUID();
import type { ApiConfig, ApiConfig__De, ModelAssignments,
  ModelProfile, ModelProfile__De, VendorConfig, VendorConfig__De } from '../api.ts';
import { AUTH_MODE_NONE, providerSupportsOpenaiResponses, resolvePreferredProtocolForProvider } from './protocol.ts';
import { f32ToJsonNumber, rustTrim } from '../../../platform/util/portable.ts';

/**
 * Rust `f32` 配置字段的 JS 值：该 f32 的最短往返十进制（serde_json 回给前端、写进请求体的就是它）。
 * IPC 的 `x-float: f32` 解码给的是 `Math.fround`（0.7 → 0.699999988079071），库里也可能有更长的旧文本。
 * 窄化溢出时保留 ±Infinity（Rust `as f32` 同样得到 inf，序列化为 null）。
 */
function f32Value(value: number): number {
  return f32ToJsonNumber(value) ?? Math.fround(value);
}
function optionalF32(value: number | null | undefined): number | null {
  return value == null ? null : f32Value(value);
}

export function defaultVendorConfig(): VendorConfig {
  return { id: randomUUID(), name: 'New Vendor', providerType: 'openai', authMode: null,
    apiProtocol: resolvePreferredProtocolForProvider('openai', 'openai', 'https://api.openai.com/v1', null),
    supportsOpenaiResponses: providerSupportsOpenaiResponses('openai', 'https://api.openai.com/v1', null),
    baseUrl: '', apiKey: '', apiKeys: [], headers: {}, rateLimitPerMinute: null, defaultTimeoutMs: null,
    notes: null, isBuiltin: false, isReadOnly: false, sortOrder: null, maxTokensLimit: null, websiteUrl: null };
}
export function vendorConfigFromDe(de: VendorConfig__De): VendorConfig {
  return { id: de.id, name: de.name, providerType: de.providerType, authMode: de.authMode ?? null,
    apiProtocol: de.apiProtocol ?? null, supportsOpenaiResponses: de.supportsOpenaiResponses ?? null,
    baseUrl: de.baseUrl, apiKey: de.apiKey, apiKeys: de.apiKeys ?? [], headers: de.headers ?? {},
    rateLimitPerMinute: de.rateLimitPerMinute ?? null, defaultTimeoutMs: de.defaultTimeoutMs ?? null,
    notes: de.notes ?? null, isBuiltin: de.isBuiltin ?? false, isReadOnly: de.isReadOnly ?? false,
    sortOrder: de.sortOrder ?? null, maxTokensLimit: de.maxTokensLimit ?? null, websiteUrl: de.websiteUrl ?? null };
}
export function modelProfileFromDe(de: ModelProfile__De): ModelProfile {
  return { id: de.id, vendorId: de.vendorId, label: de.label, model: de.model,
    providerScope: de.providerScope ?? null, apiProtocol: de.apiProtocol ?? null,
    modelAdapter: de.modelAdapter ?? 'general', isMultimodal: de.isMultimodal ?? false,
    isReasoning: de.isReasoning ?? false, isEmbedding: de.isEmbedding ?? false, isReranker: de.isReranker ?? false,
    isImageGeneration: de.isImageGeneration ?? false, supportsTools: de.supportsTools ?? false,
    supportsReasoning: de.supportsReasoning ?? false, status: de.status ?? 'enabled', enabled: de.enabled ?? true,
    maxOutputTokens: de.maxOutputTokens ?? 8192, temperature: f32Value(de.temperature ?? 0.7),
    reasoningEffort: de.reasoningEffort ?? null, reasoningMode: de.reasoningMode ?? null,
    thinkingEnabled: de.thinkingEnabled ?? false, thinkingBudget: de.thinkingBudget ?? null,
    includeThoughts: de.includeThoughts ?? false, enableThinking: de.enableThinking ?? null,
    minP: optionalF32(de.minP), topK: de.topK ?? null, geminiApiVersion: de.geminiApiVersion ?? null,
    isBuiltin: de.isBuiltin ?? false, repetitionPenalty: optionalF32(de.repetitionPenalty),
    reasoningSplit: de.reasoningSplit ?? null, effort: de.effort ?? null, verbosity: de.verbosity ?? null,
    isFavorite: de.isFavorite ?? false, maxTokensLimit: de.maxTokensLimit ?? null,
    contextWindow: de.contextWindow ?? de.context_window ?? null, extraBody: de.extraBody ?? null };
}
export type ApiConfigInput = ApiConfig__De & { supports_tools?: boolean };
export function apiConfigFromDe(de: ApiConfigInput): ApiConfig {
  return { id: de.id, name: de.name, vendorId: de.vendorId ?? null, vendorName: de.vendorName ?? null,
    providerType: de.providerType ?? null, providerScope: de.providerScope ?? null, authMode: de.authMode ?? null,
    apiProtocol: de.apiProtocol ?? null, supportsOpenaiResponses: de.supportsOpenaiResponses ?? null,
    apiKey: de.apiKey, baseUrl: de.baseUrl, model: de.model, isMultimodal: de.isMultimodal,
    isReasoning: de.isReasoning, isEmbedding: de.isEmbedding, isReranker: de.isReranker,
    isImageGeneration: de.isImageGeneration ?? false, enabled: de.enabled, modelAdapter: de.modelAdapter ?? 'general',
    maxOutputTokens: de.maxOutputTokens ?? 8192, temperature: f32Value(de.temperature ?? 0.7),
    supportsTools: de.supportsTools ?? de.supports_tools ?? false, geminiApiVersion: de.geminiApiVersion ?? 'v1',
    isBuiltin: de.isBuiltin ?? false, isReadOnly: de.isReadOnly ?? false,
    reasoningEffort: de.reasoningEffort ?? null, reasoningMode: de.reasoningMode ?? null,
    thinkingEnabled: de.thinkingEnabled ?? false, thinkingBudget: de.thinkingBudget ?? null,
    includeThoughts: de.includeThoughts ?? false, minP: optionalF32(de.minP), topK: de.topK ?? null,
    enableThinking: de.enableThinking ?? null, supportsReasoning: de.supportsReasoning ?? false,
    headers: de.headers ?? null, topPOverride: null, frequencyPenaltyOverride: null, presencePenaltyOverride: null,
    repetitionPenalty: optionalF32(de.repetitionPenalty), reasoningSplit: de.reasoningSplit ?? null,
    effort: de.effort ?? null, verbosity: de.verbosity ?? null, isFavorite: de.isFavorite ?? false,
    maxTokensLimit: de.maxTokensLimit ?? null, contextWindow: de.contextWindow ?? de.context_window ?? null,
    extraBody: de.extraBody ?? null, resolvedAdapterId: null };
}
export const EMPTY_MODEL_ASSIGNMENTS: ModelAssignments = {
  model2_config_id: null, review_analysis_model_config_id: null, anki_card_model_config_id: null,
  qbank_ai_grading_model_config_id: null, qbank_ai_generation_model_config_id: null,
  embedding_model_config_id: null, reranker_model_config_id: null, chat_title_model_config_id: null,
  exam_sheet_ocr_model_config_id: null, translation_model_config_id: null, vl_embedding_model_config_id: null,
  vl_reranker_model_config_id: null, memory_decision_model_config_id: null, voice_input_asr_model_config_id: null,
  image_generation_model_config_id: null, compaction_model_config_id: null, translation_display_mode: null,
};
export function modelAssignmentsFromDe(de: unknown): ModelAssignments {
  const fields = Object.keys(EMPTY_MODEL_ASSIGNMENTS);
  const record = serdeRecord(de, fields, 'ModelAssignments');
  const out = { ...EMPTY_MODEL_ASSIGNMENTS };
  for (const key of Object.keys(EMPTY_MODEL_ASSIGNMENTS) as (keyof ModelAssignments)[]) {
    const value = record[key];
    if (value !== undefined) (out as Record<string, string | null>)[key] = optionalString(record, key);
  }
  return out;
}
export function deserializeVendorConfigs(raw: string): VendorConfig[] {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value)) throw invalidType(value, 'a sequence');
  const out: VendorConfig[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      out.push(normalizeVendorRecord(entry));
      continue;
    }
    const object = { ...(entry as Record<string, unknown>) };
    const hasAuthMode = typeof object['authMode'] === 'string' && rustTrim(object['authMode']) !== '';
    if (object['noApiKey'] === true && !hasAuthMode) object['authMode'] = AUTH_MODE_NONE;
    out.push(normalizeVendorRecord(object));
  }
  return out;
}
function invalidType(value: unknown, expected: string): TypeError {
  const actual = value === null ? 'null' : Array.isArray(value) ? 'sequence'
    : typeof value === 'object' ? 'map' : typeof value === 'string' ? `string ${JSON.stringify(value)}`
      : typeof value === 'boolean' ? `boolean \`${value}\``
        : typeof value === 'number' ? `${Number.isInteger(value) ? 'integer' : 'floating point'} \`${value}\`` : String(value);
  return new TypeError(`invalid type: ${actual}, expected ${expected}`);
}
/** serde Vec<String>: reject the whole value instead of filtering malformed members. */
export function decodeStringVector(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalidType(value, 'a sequence');
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw invalidType(item, 'a string');
    strings.push(item);
  }
  return strings;
}
function serdeRecord(value: unknown, fields: readonly string[], name: string): Record<string, unknown> {
  if (Array.isArray(value)) {
    if (value.length > fields.length) throw new TypeError(`invalid length ${value.length}, expected fewer elements in array`);
    return Object.fromEntries(value.map((entry, index) => [fields[index]!, entry]));
  }
  if (value === null || typeof value !== 'object') throw invalidType(value, `struct ${name}`);
  return value as Record<string, unknown>;
}
function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (value === undefined) throw new TypeError(`missing field \`${key}\``);
  if (typeof value !== 'string') throw invalidType(value, 'a string');
  return value;
}
function optionalString(record: Record<string, unknown>, key: string): string | null {
  if (record[key] == null) return null;
  return requiredString(record, key);
}
function optionalNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value == null) return null;
  return numberValue(value, key);
}
function numberValue(value: unknown, key: string): number {
  const kind = key === 'sortOrder' || key === 'thinkingBudget' ? 'i32'
    : key === 'defaultTimeoutMs' ? 'u64'
      : ['rateLimitPerMinute', 'maxTokensLimit', 'maxOutputTokens', 'topK', 'contextWindow', 'context_window'].includes(key) ? 'u32' : 'f32';
  if (typeof value !== 'number') throw invalidType(value, kind);
  if (!Number.isFinite(value)) throw new TypeError('number out of range');
  if (kind !== 'f32' && !Number.isInteger(value)) throw invalidType(value, kind);
  if (kind === 'u32' && (value < 0 || value > 0xffff_ffff)
    || kind === 'i32' && (value < -0x8000_0000 || value > 0x7fff_ffff)
    || kind === 'u64' && value < 0) {
    throw new TypeError(`invalid value: integer \`${value}\`, expected ${kind}`);
  }
  return kind === 'f32' ? f32Value(value) : value;
}
function optionalBoolean(record: Record<string, unknown>, key: string, fallback = false): boolean {
  if (record[key] === undefined) return fallback;
  if (typeof record[key] !== 'boolean') throw invalidType(record[key], 'a boolean');
  return record[key] as boolean;
}
function nullableBoolean(record: Record<string, unknown>, key: string): boolean | null {
  return record[key] == null ? null : optionalBoolean(record, key);
}
function defaultedString(record: Record<string, unknown>, key: string, fallback: string): string {
  return record[key] === undefined ? fallback : requiredString(record, key);
}
function defaultedNumber(record: Record<string, unknown>, key: string, fallback: number): number {
  return record[key] === undefined ? fallback : numberValue(record[key], key);
}
function stringMap(record: Record<string, unknown>, key: string): Record<string, string> {
  const value = record[key];
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidType(value, 'a map');
  const out: Record<string, string> = {};
  for (const [name, text] of Object.entries(value)) {
    if (typeof text !== 'string') throw invalidType(text, 'a string');
    Object.defineProperty(out, name, { value: text, enumerable: true, writable: true, configurable: true });
  }
  return out;
}
export function normalizeVendorRecord(value: unknown): VendorConfig {
  const record = serdeRecord(value, ['id', 'name', 'providerType', 'authMode', 'apiProtocol', 'supportsOpenaiResponses',
    'baseUrl', 'apiKey', 'apiKeys', 'headers', 'rateLimitPerMinute', 'defaultTimeoutMs', 'notes', 'isBuiltin',
    'isReadOnly', 'sortOrder', 'maxTokensLimit', 'websiteUrl'], 'VendorConfig');
  const apiKeys = record['apiKeys'];
  if (apiKeys !== undefined && !Array.isArray(apiKeys)) throw invalidType(apiKeys, 'a sequence');
  for (const key of apiKeys ?? []) if (typeof key !== 'string') throw invalidType(key, 'a string');
  return { id: requiredString(record, 'id'), name: requiredString(record, 'name'),
    providerType: requiredString(record, 'providerType'), authMode: optionalString(record, 'authMode'),
    apiProtocol: optionalString(record, 'apiProtocol'),
    supportsOpenaiResponses: nullableBoolean(record, 'supportsOpenaiResponses'),
    baseUrl: requiredString(record, 'baseUrl'), apiKey: requiredString(record, 'apiKey'),
    apiKeys: apiKeys === undefined ? [] : [...apiKeys] as string[],
    headers: stringMap(record, 'headers'), rateLimitPerMinute: optionalNumber(record, 'rateLimitPerMinute'),
    defaultTimeoutMs: optionalNumber(record, 'defaultTimeoutMs'), notes: optionalString(record, 'notes'),
    isBuiltin: optionalBoolean(record, 'isBuiltin'), isReadOnly: optionalBoolean(record, 'isReadOnly'),
    sortOrder: optionalNumber(record, 'sortOrder'), maxTokensLimit: optionalNumber(record, 'maxTokensLimit'),
    websiteUrl: optionalString(record, 'websiteUrl') };
}
export function normalizeProfileRecord(value: unknown): ModelProfile {
  const record = serdeRecord(value, ['id', 'vendorId', 'label', 'model', 'providerScope', 'apiProtocol', 'modelAdapter',
    'isMultimodal', 'isReasoning', 'isEmbedding', 'isReranker', 'isImageGeneration', 'supportsTools', 'supportsReasoning',
    'status', 'enabled', 'maxOutputTokens', 'temperature', 'reasoningEffort', 'reasoningMode', 'thinkingEnabled',
    'thinkingBudget', 'includeThoughts', 'enableThinking', 'minP', 'topK', 'geminiApiVersion', 'isBuiltin',
    'repetitionPenalty', 'reasoningSplit', 'effort', 'verbosity', 'isFavorite', 'maxTokensLimit', 'contextWindow', 'extraBody'], 'ModelProfile');
  if (Object.hasOwn(record, 'contextWindow') && Object.hasOwn(record, 'context_window')) throw new TypeError('duplicate field `contextWindow`');
  const extra = record['extraBody'];
  if (extra != null && (typeof extra !== 'object' || Array.isArray(extra))) throw invalidType(extra, 'a map');
  return { id: requiredString(record, 'id'), vendorId: requiredString(record, 'vendorId'),
    label: requiredString(record, 'label'), model: requiredString(record, 'model'),
    providerScope: optionalString(record, 'providerScope'), apiProtocol: optionalString(record, 'apiProtocol'),
    modelAdapter: defaultedString(record, 'modelAdapter', 'general'),
    isMultimodal: optionalBoolean(record, 'isMultimodal'), isReasoning: optionalBoolean(record, 'isReasoning'),
    isEmbedding: optionalBoolean(record, 'isEmbedding'), isReranker: optionalBoolean(record, 'isReranker'),
    isImageGeneration: optionalBoolean(record, 'isImageGeneration'), supportsTools: optionalBoolean(record, 'supportsTools'),
    supportsReasoning: optionalBoolean(record, 'supportsReasoning'), status: defaultedString(record, 'status', 'enabled'),
    enabled: optionalBoolean(record, 'enabled', true), maxOutputTokens: defaultedNumber(record, 'maxOutputTokens', 8192),
    temperature: defaultedNumber(record, 'temperature', 0.7), reasoningEffort: optionalString(record, 'reasoningEffort'),
    reasoningMode: optionalString(record, 'reasoningMode'), thinkingEnabled: optionalBoolean(record, 'thinkingEnabled'),
    thinkingBudget: optionalNumber(record, 'thinkingBudget'), includeThoughts: optionalBoolean(record, 'includeThoughts'),
    enableThinking: nullableBoolean(record, 'enableThinking'),
    minP: optionalNumber(record, 'minP'), topK: optionalNumber(record, 'topK'), geminiApiVersion: optionalString(record, 'geminiApiVersion'),
    isBuiltin: optionalBoolean(record, 'isBuiltin'), repetitionPenalty: optionalNumber(record, 'repetitionPenalty'),
    reasoningSplit: nullableBoolean(record, 'reasoningSplit'),
    effort: optionalString(record, 'effort'), verbosity: optionalString(record, 'verbosity'),
    isFavorite: optionalBoolean(record, 'isFavorite'), maxTokensLimit: optionalNumber(record, 'maxTokensLimit'),
    contextWindow: optionalNumber(record, 'contextWindow') ?? optionalNumber(record, 'context_window'),
    extraBody: extra == null ? null : extra as Record<string, unknown> };
}
