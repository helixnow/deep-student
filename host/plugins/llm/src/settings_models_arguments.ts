/** settings_models_executor.rs: tool contract, public-setting allowlists and argument validation. */
import type { SettingRow } from '../../../platform/settings/api.ts';
import type { ApiConfig, ModelAssignments, ModelProfile, VendorConfig } from '../api.ts';
import { apiOriginsMatch } from './config_resolution.ts';

export const SETTINGS_GET_TOOL = 'settings_get';
export const SETTINGS_SET_TOOL = 'settings_set';
export const MODEL_ASSIGNMENTS_GET_TOOL = 'model_assignments_get';
export const MODEL_ASSIGNMENTS_SET_TOOL = 'model_assignments_set';
export const MODEL_PROFILE_ADD_TOOL = 'model_profile_add';
// Agent self-configuration surface (LLM vendors, keys, models, failover, budget, settings domains).
export const LLM_CONFIG_VENDORS_LIST_TOOL = 'llm_config_vendors_list';
export const LLM_CONFIG_VENDOR_UPSERT_TOOL = 'llm_config_vendor_upsert';
export const LLM_CONFIG_VENDOR_KEY_SET_TOOL = 'llm_config_vendor_key_set';
export const LLM_CONFIG_MODELS_FETCH_TOOL = 'llm_config_models_fetch';
export const LLM_CONFIG_TEST_TOOL = 'llm_config_test';
export const LLM_CONFIG_PROFILES_LIST_TOOL = 'llm_config_profiles_list';
export const LLM_CONFIG_PROFILE_UPSERT_TOOL = 'llm_config_profile_upsert';
export const LLM_CONFIG_PROFILE_DELETE_TOOL = 'llm_config_profile_delete';
export const LLM_CONFIG_FAILOVER_GET_TOOL = 'llm_config_failover_get';
export const LLM_CONFIG_FAILOVER_SET_TOOL = 'llm_config_failover_set';
export const LLM_CONFIG_BUDGET_GET_TOOL = 'llm_config_budget_get';
export const LLM_CONFIG_BUDGET_SET_TOOL = 'llm_config_budget_set';
export const SETTINGS_DOMAINS_LIST_TOOL = 'settings_domains_list';
export const SETTINGS_APPLY_TOOL = 'settings_apply';
export const SETTINGS_CHANGED_EVENT = 'chat_v2://settings_changed';
export const MODEL_ASSIGNMENTS_CHANGED_EVENT = 'chat_v2://model_assignments_changed';
export const MODEL_PROFILES_CHANGED_EVENT = 'chat_v2://model_profiles_changed';
export const MAX_TOOL_STRING_CHARS = 2_000;
export const MAX_MODEL_CONFIG_ID_CHARS = 200;
export const MAX_SETTING_ROWS = 20;
export const MAX_BASE_URL_CHARS = 300;
export const MAX_API_KEY_CHARS = 500;
export const MAX_PROVIDER_TYPE_CHARS = 40;
export const MAX_USIZE = 18_446_744_073_709_551_615n;
export const SETTINGS_GET_FIELDS: readonly string[] = ['prefix'];
export const SETTINGS_SET_FIELDS: readonly string[] = ['key', 'value'];
export const MODEL_ASSIGNMENTS_GET_FIELDS: readonly string[] = ['page', 'page_size'];
export const MODEL_ASSIGNMENTS_SET_FIELDS: readonly string[] = ['slot', 'config_id', 'expected_current_config_id'];
/** api_key is a legitimate input only here; redact it before events or persistence. */
export const MODEL_PROFILE_ADD_FIELDS: readonly string[] = [
  'model', 'label', 'vendor_id', 'vendor_name', 'provider_type', 'base_url', 'api_key',
  'is_multimodal', 'is_reasoning', 'is_embedding', 'is_reranker', 'is_image_generation',
  'supports_tools', 'context_window', 'max_output_tokens',
];
export const SAFE_READ_PREFIXES: readonly string[] = [
  'theme', 'language', 'enableNotifications', 'maxChatHistory', 'markdownRendererMode',
  'auto_save', 'macos.', 'sidebar.', 'ui.', 'thinking.', 'textbook.',
];
export const SAFE_SETTING_KEYS: readonly string[] = [
  'theme', 'theme_palette', 'language', 'enableNotifications', 'maxChatHistory', 'markdownRendererMode',
  'auto_save', 'macos.native_font_smoothing', 'sidebar.translucent', 'ui.pointer_cursor',
  'thinking.auto_collapse', 'textbook.max_pages',
];
/** Self-config tool argument allowlists. `api_key` appears only in redacted credential tools. */
export const LLM_CONFIG_VENDORS_LIST_FIELDS: readonly string[] = [];
export const LLM_CONFIG_VENDOR_UPSERT_FIELDS: readonly string[] = [
  'vendor_id', 'vendor_name', 'provider_type', 'base_url', 'api_key', 'auth_mode', 'headers', 'enabled',
];
export const LLM_CONFIG_VENDOR_KEY_SET_FIELDS: readonly string[] = ['vendor_id', 'api_key'];
export const LLM_CONFIG_MODELS_FETCH_FIELDS: readonly string[] = ['vendor_id', 'provider_type', 'base_url', 'api_key'];
export const LLM_CONFIG_TEST_FIELDS: readonly string[] = ['profile_id', 'vendor_id', 'model'];
export const LLM_CONFIG_PROFILES_LIST_FIELDS: readonly string[] = [];
export const LLM_CONFIG_PROFILE_UPSERT_FIELDS: readonly string[] = [
  'profile_id', 'vendor_id', 'model', 'name', 'label', 'enabled', 'is_multimodal', 'supports_thinking',
  'supports_function_calling', 'context_window', 'max_output_tokens',
];
export const LLM_CONFIG_PROFILE_DELETE_FIELDS: readonly string[] = ['profile_id'];
export const LLM_CONFIG_FAILOVER_GET_FIELDS: readonly string[] = [];
export const LLM_CONFIG_FAILOVER_SET_FIELDS: readonly string[] = ['policy'];
export const LLM_CONFIG_BUDGET_GET_FIELDS: readonly string[] = [];
export const LLM_CONFIG_BUDGET_SET_FIELDS: readonly string[] = ['config'];
export const SETTINGS_DOMAINS_LIST_FIELDS: readonly string[] = ['domain'];
export const SETTINGS_APPLY_FIELDS: readonly string[] = ['domain', 'values'];
export const LLM_CONFIG_TOOLS: readonly string[] = [
  LLM_CONFIG_VENDORS_LIST_TOOL, LLM_CONFIG_VENDOR_UPSERT_TOOL, LLM_CONFIG_VENDOR_KEY_SET_TOOL,
  LLM_CONFIG_MODELS_FETCH_TOOL, LLM_CONFIG_TEST_TOOL, LLM_CONFIG_PROFILES_LIST_TOOL,
  LLM_CONFIG_PROFILE_UPSERT_TOOL, LLM_CONFIG_PROFILE_DELETE_TOOL, LLM_CONFIG_FAILOVER_GET_TOOL,
  LLM_CONFIG_FAILOVER_SET_TOOL, LLM_CONFIG_BUDGET_GET_TOOL, LLM_CONFIG_BUDGET_SET_TOOL,
  SETTINGS_DOMAINS_LIST_TOOL, SETTINGS_APPLY_TOOL,
];
export const LLM_CONFIG_READ_ONLY_TOOLS: readonly string[] = [
  LLM_CONFIG_VENDORS_LIST_TOOL, LLM_CONFIG_MODELS_FETCH_TOOL, LLM_CONFIG_TEST_TOOL,
  LLM_CONFIG_PROFILES_LIST_TOOL, LLM_CONFIG_FAILOVER_GET_TOOL, LLM_CONFIG_BUDGET_GET_TOOL,
  SETTINGS_DOMAINS_LIST_TOOL,
];
/** Tools whose `api_key` argument must be redacted before events or block persistence. */
export const LLM_CONFIG_CREDENTIAL_TOOLS: readonly string[] = [
  MODEL_PROFILE_ADD_TOOL, LLM_CONFIG_VENDOR_UPSERT_TOOL, LLM_CONFIG_VENDOR_KEY_SET_TOOL,
  LLM_CONFIG_MODELS_FETCH_TOOL,
];
export const SETTINGS_DOMAIN_NAMES: readonly string[] = [
  'general', 'voice_input', 'memory', 'anki_connect', 'chat_stream', 'automation',
];
export const MEMORY_SETTING_KEYS: Readonly<Record<string, string>> = {
  root_folder: 'memory.root_folder',
  privacy_mode: 'memory.privacy_mode',
  auto_create_subfolders: 'memory.auto_create_subfolders',
  default_category: 'memory.default_category',
  auto_extract_frequency: 'memory.auto_extract_frequency',
};
export const MEMORY_BOOLEAN_KEYS: readonly string[] = ['privacy_mode', 'auto_create_subfolders'];
export const ANKI_CONNECT_SETTING_KEYS: Readonly<Record<string, string>> = {
  url: 'anki_connect_url',
  deck: 'anki_connect_deck',
  enabled: 'anki_connect_enabled',
};
export const CHAT_STREAM_TIMEOUT_KEY = 'chat.stream.timeout_ms';
export const CHAT_STREAM_AUTO_CANCEL_KEY = 'chat.stream.auto_cancel_on_timeout';
export const AUTOMATION_BACKGROUND_KEY = 'chat_v2.automation_background_enabled';
export const VOICE_INPUT_CONFIG_KEY = 'voice_input.config';
export const FAILOVER_POLICY_KEY = 'llm_failover_policy';
export const INJECTION_BUDGET_KEY = 'injection_budget.config';
export const MODEL_ASSIGNMENTS_KEY = 'model_assignments';
export const MAX_CHAT_STREAM_TIMEOUT_MS = 86_400_000;
export const SENSITIVE_IDENTIFIER_FRAGMENTS: readonly string[] = [
  'apikey', 'token', 'secret', 'oauth', 'password', 'credential', 'private', 'access',
  'authorization', 'cookie', 'session', 'mcp', 'cloudstorage', 'toolapproval', 'permission',
];

export type ToolSensitivity = 'low' | 'medium' | 'high';
export type ToolConcurrency = 'read_only' | 'safe_parallel' | 'serial';
export interface ToolCall { id: string; name: string; arguments: unknown }
export interface ToolResultInfo {
  toolCallId?: string; blockId?: string; toolName: string; input: unknown; output: unknown;
  success: boolean; error?: string; durationMs?: number; reasoningContent?: string; thoughtSignature?: string;
}
export function stripToolNamespace(toolName: string): string {
  if (toolName.startsWith('builtin-')) return toolName.slice('builtin-'.length);
  if (toolName.startsWith('mcp_')) return toolName.slice('mcp_'.length);
  return toolName;
}
export interface VoiceInputCapabilities {
  isAsrModel(model: string, displayName: string): boolean;
  asrProviderSupported(providerId: string | null, apiProtocol: string | null): boolean;
}
export interface SettingsModelsDatabase {
  get(key: string): string | null;
  save(key: string, value: string): void;
  listByPrefix(prefix: string): SettingRow[];
}
export interface SettingsModelsLlmManager {
  getApiConfigs(): Promise<ApiConfig[]>;
  getVendorConfigs(): Promise<VendorConfig[]>;
  getModelProfiles(): Promise<ModelProfile[]>;
  getModelAssignments(): Promise<ModelAssignments>;
  saveVendorModelConfigs(vendors: readonly VendorConfig[], profiles: readonly ModelProfile[]): Promise<void>;
  /** Optional: when present the profile-delete tool uses the manager instead of the settings row. */
  saveModelAssignments?(assignments: ModelAssignments): Promise<void>;
}
/** Neutral projection of a remote model catalog entry (no credentials). */
export interface FetchedModelSummary {
  id: string;
  label: string;
  context_window: number | null;
  max_output_tokens: number | null;
}
/** Neutral projection of the connection probe result. */
export interface ModelProbeResult {
  ok: boolean;
  latency_ms: number;
  message: string;
  warning: string | null;
  category: string | null;
}
/** Network/credential side of the self-config tools, supplied by the llm plugin runtime. */
export interface SettingsModelsProbe {
  /** `fetch_vendor_models`: vendor.apiKey is already usable (decrypted / auth_mode=none). */
  fetchVendorModels(vendor: VendorConfig): Promise<FetchedModelSummary[]>;
  /** `test_api_connection` for a vendor/model pair; never returns the key. */
  testConnection(vendor: VendorConfig, model: string, persisted: boolean): Promise<ModelProbeResult>;
}
export interface SettingsModelsAppEvents { emit(event: string, payload: unknown): void }
export interface ToolExecutionContext {
  blockId: string;
  database?: SettingsModelsDatabase | null;
  llm?: SettingsModelsLlmManager | null;
  probe?: SettingsModelsProbe | null;
  voiceInput: VoiceInputCapabilities;
  appEvents: SettingsModelsAppEvents;
  emitToolCallStart(name: string, args: unknown, callId: string | null): void;
  emitToolCallEnd(payload: unknown): void;
  emitToolCallError(error: string): void;
  saveToolBlock(result: ToolResultInfo): void;
  warn(message: string): void;
}
export class ToolFailure extends Error {
  readonly payload: string;
  constructor(payload: string) { super(payload); this.name = 'ToolFailure'; this.payload = payload; }
}
export function fail(payload: string): never { throw new ToolFailure(payload); }
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function asciiLower(value: string): string { return value.replace(/[A-Z]/g, character => character.toLowerCase()); }
function charLength(value: string): number { return [...value].length; }

export function toolError(code: string, message: string, hint: string, retryable: boolean,
  fields: Record<string, unknown> = {}): string {
  const bounded = boundedString(message);
  return JSON.stringify({ code, message: bounded.value, message_truncated: bounded.truncated,
    message_key: `chat.tools.settings_models.errors.${code.toLowerCase()}`, hint, retryable, ...fields });
}
export function toolErrorWithFields(code: string, message: string, hint: string, retryable: boolean,
  fields: Record<string, unknown>): string { return toolError(code, message, hint, retryable, fields); }
export function invalidArgument(field: string, reason: string): string {
  return toolError('INVALID_ARGUMENT', `Invalid '${field}': ${reason}`, 'Correct the tool arguments and retry.', false);
}
export function argumentsObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  rejectSensitiveArgumentFields(value);
  return objectWithAllowedFields(value, fields);
}
export function argumentsObjectAllowingCredentials(value: unknown, fields: readonly string[]): Record<string, unknown> {
  return objectWithAllowedFields(value, fields);
}
function objectWithAllowedFields(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!isJsonObject(value)) fail(invalidArgument('arguments', 'expected a JSON object'));
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) fail(invalidArgument(field, 'unknown field; additional properties are not allowed'));
  }
  return value;
}
export function redactCredentialArguments(value: unknown): unknown {
  if (!isJsonObject(value)) return value;
  const redacted = { ...value }, apiKey = redacted['api_key'];
  if (typeof apiKey === 'string' && apiKey !== '') redacted['api_key'] = '<redacted>';
  return redacted;
}
/** A placeholder that must never be persisted as a real credential. */
export function isCredentialPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === '<redacted>' || (trimmed !== '' && [...trimmed].every(character => character === '*'));
}
export function rejectCredentialPlaceholder(field: string, value: string): void {
  if (!isCredentialPlaceholder(value)) return;
  fail(toolError('API_KEY_PLACEHOLDER_REJECTED',
    `The ${field} value is a redaction placeholder, not a real key.`,
    'The key shown in chat history is redacted. Ask the user to paste the real key again.', false));
}
export function optionalStringMap(args: Record<string, unknown>, field: string): Record<string, string> | null {
  if (!(field in args) || args[field] === null) return null;
  const raw = args[field];
  if (!isJsonObject(raw)) fail(invalidArgument(field, 'expected an object of string values'));
  const entries = Object.entries(raw);
  if (entries.length > 32) fail(invalidArgument(field, 'must contain at most 32 entries'));
  const result: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (key.trim() === '' || charLength(key) > 128) fail(invalidArgument(field, 'header names must be 1-128 characters'));
    if (typeof item !== 'string' || charLength(item) > 4_000) {
      fail(invalidArgument(field, `header '${key}' expects a string of at most 4000 characters`));
    }
    result[key] = item;
  }
  return result;
}
export function optionalString(args: Record<string, unknown>, field: string, maxChars: number): string | null {
  if (!(field in args)) return null;
  const raw = args[field];
  if (raw === null) return null;
  if (typeof raw !== 'string') fail(invalidArgument(field, 'expected a string'));
  const value = raw.trim();
  if (value === '') return null;
  if (charLength(value) > maxChars) fail(invalidArgument(field, `must contain at most ${maxChars} characters`));
  return value;
}
export function optionalBool(args: Record<string, unknown>, field: string): boolean {
  const raw = args[field];
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== 'boolean') fail(invalidArgument(field, 'expected a boolean'));
  return raw;
}
export function optionalU32(args: Record<string, unknown>, field: string, maximum: number): number | null {
  const raw = args[field];
  if (raw === undefined || raw === null) return null;
  const valid = typeof raw === 'number' && Number.isInteger(raw) && raw > 0 && raw <= 0xffff_ffff && raw <= maximum;
  if (!valid) fail(invalidArgument(field, `expected an integer between 1 and ${maximum}`));
  return raw;
}
export interface ProfileCapabilityFlags {
  multimodal: boolean; reasoning: boolean; embedding: boolean; reranker: boolean;
  imageGeneration: boolean; supportsTools: boolean; contextWindow: number | null; maxOutputTokens: number | null;
}
export function profileCapabilityFlags(args: Record<string, unknown>): ProfileCapabilityFlags {
  const flags = { multimodal: optionalBool(args, 'is_multimodal'), reasoning: optionalBool(args, 'is_reasoning'),
    embedding: optionalBool(args, 'is_embedding'), reranker: optionalBool(args, 'is_reranker'),
    imageGeneration: optionalBool(args, 'is_image_generation'), supportsTools: optionalBool(args, 'supports_tools'),
    contextWindow: optionalU32(args, 'context_window', 10_000_000), maxOutputTokens: optionalU32(args, 'max_output_tokens', 1_000_000) };
  const specialist = Number(flags.embedding) + Number(flags.reranker) + Number(flags.imageGeneration);
  if (specialist > 1) fail(invalidArgument('is_embedding', 'embedding/reranker/image_generation are mutually exclusive'));
  if (specialist === 1 && (flags.multimodal || flags.reasoning || flags.supportsTools)) {
    fail(invalidArgument('is_embedding', 'specialist models cannot also be multimodal/reasoning/tool-capable'));
  }
  return flags;
}
export function validateBaseUrl(value: string): void {
  let parsed: URL;
  try { parsed = new URL(value); } catch { fail(invalidArgument('base_url', 'expected an absolute http(s) URL')); }
  const scheme = parsed.protocol.replace(/:$/, '');
  if (asciiLower(scheme) !== 'http' && asciiLower(scheme) !== 'https') fail(invalidArgument('base_url', 'only http/https URLs are allowed'));
  if (parsed.hostname === '') fail(invalidArgument('base_url', 'URL must include a host'));
}
export function validateProviderType(value: string): void {
  if (value === '' || !/^[A-Za-z0-9._-]+$/.test(value)) {
    fail(invalidArgument('provider_type', "only ASCII letters, digits, '-', '_' and '.' are allowed"));
  }
}
export function urlsSameOrigin(left: string, right: string): boolean { return apiOriginsMatch(left, right); }
export function requiredString(args: Record<string, unknown>, field: string, maxChars: number): string {
  if (!(field in args)) fail(invalidArgument(field, 'field is required'));
  const raw = args[field];
  if (typeof raw !== 'string') fail(invalidArgument(field, 'expected a string'));
  const value = raw.trim();
  if (value === '') fail(invalidArgument(field, 'must not be blank'));
  if (charLength(value) > maxChars) fail(invalidArgument(field, `must contain at most ${maxChars} characters`));
  return value;
}
export function requiredNullableString(args: Record<string, unknown>, field: string): string | null {
  if (!(field in args)) fail(invalidArgument(field, 'field is required and may be null'));
  const raw = args[field];
  if (raw === null) return null;
  if (typeof raw !== 'string') fail(invalidArgument(field, 'expected a string or null'));
  const value = raw.trim();
  if (value === '') fail(invalidArgument(field, 'use null instead of a blank string'));
  if (charLength(value) > MAX_MODEL_CONFIG_ID_CHARS) fail(invalidArgument(field, `must contain at most ${MAX_MODEL_CONFIG_ID_CHARS} characters`));
  return value;
}
export function optionalPositiveInteger(args: Record<string, unknown>, field: string, defaultValue: number, maximum: number | bigint): number {
  if (!(field in args)) return defaultValue;
  const raw = args[field];
  const valid = typeof raw === 'number' && Number.isInteger(raw) && raw > 0
    && (typeof maximum === 'bigint' ? BigInt(raw) <= maximum : raw <= maximum);
  if (!valid) fail(invalidArgument(field, `expected an integer between 1 and ${maximum}`));
  return raw;
}
function compactIdentifier(value: string): string {
  let compact = '';
  for (const character of value) if (/[A-Za-z0-9]/.test(character)) compact += character;
  return asciiLower(compact);
}
export function containsSensitiveIdentifier(value: string): boolean {
  const compact = compactIdentifier(value);
  return SENSITIVE_IDENTIFIER_FRAGMENTS.some(fragment => compact.includes(fragment));
}
export function rejectSensitiveIdentifier(field: string, value: string): void {
  if (containsSensitiveIdentifier(value)) fail(toolError('SENSITIVE_SETTING_REJECTED', `'${field}' targets a protected setting namespace.`,
    'Credentials, OAuth, MCP, sync credentials, sessions, permissions, and approval policy are available only in Settings.', false));
}
export function rejectSensitiveArgumentFields(value: unknown): void {
  if (Array.isArray(value)) { for (const nested of value) rejectSensitiveArgumentFields(nested); return; }
  if (!isJsonObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (containsSensitiveIdentifier(key)) fail(toolError('SENSITIVE_FIELD_REJECTED', `Argument field '${key}' is protected.`,
      'Do not pass credentials, tokens, sessions, permissions, or approval policy to this tool.', false));
    rejectSensitiveArgumentFields(nested);
  }
}
export function isSafeSettingKey(key: string): boolean { return SAFE_SETTING_KEYS.includes(key) && !containsSensitiveIdentifier(key); }
export function validateSettingValue(key: string, value: unknown): string {
  switch (key) {
    case 'theme': return validatedEnum(value, key, ['light', 'dark', 'auto']);
    case 'theme_palette': return validatedEnum(value, key, ['default', 'purple', 'green', 'orange', 'pink', 'teal', 'muted', 'paper', 'custom']);
    case 'language': return validatedEnum(value, key, ['zh-CN', 'en-US']);
    case 'markdownRendererMode': return validatedEnum(value, key, ['legacy', 'enhanced']);
    case 'enableNotifications': case 'auto_save': case 'macos.native_font_smoothing':
    case 'sidebar.translucent': case 'ui.pointer_cursor': case 'thinking.auto_collapse':
      if (typeof value !== 'boolean') fail(invalidArgument('value', `'${key}' expects a boolean`));
      return String(value);
    case 'maxChatHistory': return validatedInteger(value, key, 10, 1_000);
    case 'textbook.max_pages': return validatedInteger(value, key, 1, 50);
    default: return fail(toolError('SETTING_WRITE_NOT_ALLOWED', `Setting '${key}' cannot be changed by the agent.`,
      'Open Settings to change protected or unsupported settings.', false));
  }
}
function validatedEnum(value: unknown, key: string, allowed: readonly string[]): string {
  if (typeof value !== 'string') fail(invalidArgument('value', `'${key}' expects a string`));
  if (!allowed.includes(value)) fail(invalidArgument('value', `'${key}' accepts only: ${allowed.join(', ')}`));
  return value;
}
function validatedInteger(value: unknown, key: string, minimum: number, maximum: number): string {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(invalidArgument('value', `'${key}' expects an integer`));
  if (value < minimum || value > maximum) fail(invalidArgument('value', `'${key}' must be between ${minimum} and ${maximum}`));
  return String(value);
}
export interface BoundedString { value: string; truncated: boolean }
export function boundedString(value: string): BoundedString {
  const characters = [...value];
  return characters.length <= MAX_TOOL_STRING_CHARS ? { value, truncated: false }
    : { value: characters.slice(0, MAX_TOOL_STRING_CHARS).join(''), truncated: true };
}
export interface BoundedOptionalString { value: string | null; truncated: boolean }
export function boundedOptionalString(value: string | null): BoundedOptionalString {
  return value === null ? { value: null, truncated: false } : boundedString(value);
}
export function boundJsonStrings(value: unknown): { value: unknown; truncated: boolean } {
  if (typeof value === 'string') return boundedString(value);
  if (Array.isArray(value)) {
    let truncated = false;
    const items = value.map(item => { const bounded = boundJsonStrings(item); truncated ||= bounded.truncated; return bounded.value; });
    return { value: items, truncated };
  }
  if (isJsonObject(value)) {
    let truncated = false;
    const entries: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const bounded = boundJsonStrings(nested); truncated ||= bounded.truncated; entries[key] = bounded.value;
    }
    return { value: entries, truncated };
  }
  return { value, truncated: false };
}
