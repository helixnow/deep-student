/** Settings/model tool dispatch. Argument policy and assignment operations live in separate modules. */
const randomUUID = () => globalThis.crypto.randomUUID();
import type { SettingRow } from '../../../platform/settings/api.ts';
import type { ApiConfig, ModelAssignments, ModelProfile, VendorConfig } from '../api.ts';
import { defaultVendorConfig, modelProfileFromDe } from './config_values.ts';
import { isMaskedSecret } from './config_resolution.ts';
import {
  SETTINGS_GET_TOOL, SETTINGS_SET_TOOL, MODEL_ASSIGNMENTS_GET_TOOL, MODEL_ASSIGNMENTS_SET_TOOL, MODEL_PROFILE_ADD_TOOL,
  LLM_CONFIG_VENDORS_LIST_TOOL, LLM_CONFIG_VENDOR_UPSERT_TOOL, LLM_CONFIG_VENDOR_KEY_SET_TOOL, LLM_CONFIG_MODELS_FETCH_TOOL,
  LLM_CONFIG_TEST_TOOL, LLM_CONFIG_PROFILES_LIST_TOOL, LLM_CONFIG_PROFILE_UPSERT_TOOL, LLM_CONFIG_PROFILE_DELETE_TOOL,
  LLM_CONFIG_FAILOVER_GET_TOOL, LLM_CONFIG_FAILOVER_SET_TOOL, LLM_CONFIG_BUDGET_GET_TOOL, LLM_CONFIG_BUDGET_SET_TOOL,
  SETTINGS_DOMAINS_LIST_TOOL, SETTINGS_APPLY_TOOL,
  SETTINGS_CHANGED_EVENT, MODEL_ASSIGNMENTS_CHANGED_EVENT, MODEL_PROFILES_CHANGED_EVENT,
  SETTINGS_GET_FIELDS, SETTINGS_SET_FIELDS, MODEL_ASSIGNMENTS_GET_FIELDS, MODEL_ASSIGNMENTS_SET_FIELDS, MODEL_PROFILE_ADD_FIELDS,
  LLM_CONFIG_VENDORS_LIST_FIELDS, LLM_CONFIG_VENDOR_UPSERT_FIELDS, LLM_CONFIG_VENDOR_KEY_SET_FIELDS,
  LLM_CONFIG_MODELS_FETCH_FIELDS, LLM_CONFIG_TEST_FIELDS, LLM_CONFIG_PROFILES_LIST_FIELDS,
  LLM_CONFIG_PROFILE_UPSERT_FIELDS, LLM_CONFIG_PROFILE_DELETE_FIELDS, LLM_CONFIG_FAILOVER_GET_FIELDS,
  LLM_CONFIG_FAILOVER_SET_FIELDS, LLM_CONFIG_BUDGET_GET_FIELDS, LLM_CONFIG_BUDGET_SET_FIELDS,
  SETTINGS_DOMAINS_LIST_FIELDS, SETTINGS_APPLY_FIELDS, LLM_CONFIG_TOOLS, LLM_CONFIG_READ_ONLY_TOOLS,
  LLM_CONFIG_CREDENTIAL_TOOLS, SETTINGS_DOMAIN_NAMES, MEMORY_SETTING_KEYS, MEMORY_BOOLEAN_KEYS,
  ANKI_CONNECT_SETTING_KEYS, CHAT_STREAM_TIMEOUT_KEY, CHAT_STREAM_AUTO_CANCEL_KEY, AUTOMATION_BACKGROUND_KEY,
  VOICE_INPUT_CONFIG_KEY, FAILOVER_POLICY_KEY, INJECTION_BUDGET_KEY, MODEL_ASSIGNMENTS_KEY,
  MAX_CHAT_STREAM_TIMEOUT_MS,
  MAX_USIZE, MAX_SETTING_ROWS, MAX_MODEL_CONFIG_ID_CHARS, MAX_PROVIDER_TYPE_CHARS, MAX_BASE_URL_CHARS, MAX_API_KEY_CHARS,
  SAFE_READ_PREFIXES, SAFE_SETTING_KEYS, ToolFailure, fail, errorMessage, asciiLower, toolError, toolErrorWithFields, invalidArgument,
  argumentsObject, argumentsObjectAllowingCredentials, redactCredentialArguments, requiredString, requiredNullableString,
  optionalString, optionalBool, optionalStringMap, optionalPositiveInteger, profileCapabilityFlags, validateBaseUrl,
  validateProviderType, urlsSameOrigin, rejectCredentialPlaceholder, rejectSensitiveIdentifier, isSafeSettingKey,
  containsSensitiveIdentifier, validateSettingValue, isJsonObject,
  boundJsonStrings, boundedString, boundedOptionalString, stripToolNamespace,
  type ToolExecutionContext, type SettingsModelsDatabase, type SettingsModelsLlmManager, type SettingsModelsProbe,
  type ToolCall, type ToolResultInfo, type ToolSensitivity, type ToolConcurrency,
} from './settings_models_arguments.ts';
import { parseAssignmentSlot, safeModelJson, validateModelForSlot, modelCapabilitiesFromConfig,
  updateModelAssignmentAtomic, type SafeModelJson } from './settings_models_assignments.ts';
import { decodeFailoverPolicyExact, projectFailoverPolicy, defaultFailoverPolicy } from './policy.ts';

// Preserve the existing test/caller surface while keeping each responsibility independent.
export * from './settings_models_arguments.ts';
export * from './settings_models_assignments.ts';

function requireDatabase(ctx: ToolExecutionContext): SettingsModelsDatabase {
  if (ctx.database !== undefined && ctx.database !== null) return ctx.database;
  return fail(toolError('DEPENDENCY_UNAVAILABLE', 'The settings database is unavailable.',
    'Retry after the application finishes starting.', true));
}
function requireLlm(ctx: ToolExecutionContext): SettingsModelsLlmManager {
  if (ctx.llm !== undefined && ctx.llm !== null) return ctx.llm;
  return fail(toolError('DEPENDENCY_UNAVAILABLE', 'The model manager is unavailable.',
    'Retry after the application finishes starting.', true));
}
function emitAppEvent(ctx: ToolExecutionContext, event: string, payload: unknown): boolean {
  try { ctx.appEvents.emit(event, payload); return true; } catch { return false; }
}
async function readModelAssignments(llm: SettingsModelsLlmManager): Promise<ModelAssignments> {
  try { return await llm.getModelAssignments(); }
  catch (error) { return fail(toolError('MODEL_ASSIGNMENTS_READ_FAILED', `Failed to read model assignments: ${errorMessage(error)}`,
    'Retry after checking the model settings.', true)); }
}
async function readApiConfigs(llm: SettingsModelsLlmManager): Promise<ApiConfig[]> {
  try { return await llm.getApiConfigs(); }
  catch (error) { return fail(toolError('MODEL_DIRECTORY_READ_FAILED', `Failed to read the model directory: ${errorMessage(error)}`,
    'Retry after checking the model settings.', true)); }
}
async function readVendors(llm: SettingsModelsLlmManager): Promise<VendorConfig[]> {
  try { return await llm.getVendorConfigs(); }
  catch (error) { return fail(toolError('VENDOR_DIRECTORY_READ_FAILED', `Failed to read the vendor directory: ${errorMessage(error)}`,
    'Retry after checking the model settings.', true)); }
}
async function readProfiles(llm: SettingsModelsLlmManager): Promise<ModelProfile[]> {
  try { return await llm.getModelProfiles(); }
  catch (error) { return fail(toolError('MODEL_DIRECTORY_READ_FAILED', `Failed to read the model directory: ${errorMessage(error)}`,
    'Retry after checking the model settings.', true)); }
}
function requireProbe(ctx: ToolExecutionContext): SettingsModelsProbe {
  if (ctx.probe !== undefined && ctx.probe !== null) return ctx.probe;
  return fail(toolError('DEPENDENCY_UNAVAILABLE', 'The model probe service is unavailable.',
    'Retry after the application finishes starting.', true));
}
async function saveDirectory(llm: SettingsModelsLlmManager, vendors: readonly VendorConfig[],
  profiles: readonly ModelProfile[], code: string, what: string): Promise<void> {
  try { await llm.saveVendorModelConfigs(vendors, profiles); }
  catch (error) { fail(toolError(code, `Failed to save ${what}: ${errorMessage(error)}`,
    'Retry after checking the local database.', true)); }
}
function readSettingRaw(database: SettingsModelsDatabase, key: string): string | null {
  try { return database.get(key); }
  catch (error) { fail(toolError('SETTINGS_READ_FAILED', `Failed to read '${key}': ${errorMessage(error)}`,
    'Retry after checking the local database.', true)); }
}
function writeSettingRaw(database: SettingsModelsDatabase, key: string, value: string): void {
  try { database.save(key, value); }
  catch (error) { fail(toolError('SETTINGS_WRITE_FAILED', `Failed to save '${key}': ${errorMessage(error)}`,
    'Retry after checking local storage availability.', true)); }
}
/** Storage convention: booleans round-trip as 'true'/'false' (chat stream uses '1'/'0'). */
function parseStoredBool(raw: string | null, fallback: boolean): boolean {
  if (raw === null) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === '') return fallback;
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}
function parseJsonObjectField(raw: string | null, field: string): Record<string, unknown> | null {
  if (raw === null || raw.trim() === '') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) {
    fail(toolError('SETTING_VALUE_INVALID', `Stored '${field}' is not valid JSON: ${errorMessage(error)}`,
      'Repair the setting in Settings and retry.', false));
  }
  if (!isJsonObject(parsed)) fail(toolError('SETTING_VALUE_INVALID', `Stored '${field}' is not a JSON object.`,
    'Repair the setting in Settings and retry.', false));
  return parsed;
}
const INJECTION_TYPES = ['Rag', 'Memory', 'LearnerProfile', 'WebSearch', 'Context', 'SystemPrompt', 'UserInput', 'ToolResults'] as const;
const INJECTION_PRIORITIES = ['Critical', 'High', 'Medium', 'Low', 'Optional'] as const;
/** Validate the persisted `injection_budget.config` shape used by budget_commands.ts. */
function validateBudgetConfig(value: unknown): Record<string, unknown> {
  if (!isJsonObject(value)) fail(invalidArgument('config', 'expected a JSON object'));
  const allowed = ['total_budget', 'reserved_for_user_input', 'reserved_for_system', 'type_limits',
    'priority_weights', 'enable_smart_truncation'];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(invalidArgument(key, 'unknown field'));
  const usize = (field: string, raw: unknown): number => {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || !Number.isSafeInteger(raw)) {
      fail(invalidArgument(field, 'expected a non-negative integer'));
    }
    return raw;
  };
  const total = usize('total_budget', value['total_budget']);
  const reservedUser = usize('reserved_for_user_input', value['reserved_for_user_input']);
  const reservedSystem = usize('reserved_for_system', value['reserved_for_system']);
  const typeLimits = value['type_limits'];
  if (!isJsonObject(typeLimits)) fail(invalidArgument('type_limits', 'expected an object'));
  const limits: Record<string, number> = {};
  for (const [key, limit] of Object.entries(typeLimits)) {
    if (!(INJECTION_TYPES as readonly string[]).includes(key)) fail(invalidArgument('type_limits', `unknown variant '${key}'`));
    limits[key] = usize(`type_limits.${key}`, limit);
  }
  const weights = value['priority_weights'];
  if (!isJsonObject(weights)) fail(invalidArgument('priority_weights', 'expected an object'));
  const parsedWeights: Record<string, number> = {};
  for (const [key, weight] of Object.entries(weights)) {
    if (!(INJECTION_PRIORITIES as readonly string[]).includes(key)) fail(invalidArgument('priority_weights', `unknown variant '${key}'`));
    if (typeof weight !== 'number' || !Number.isFinite(weight)) fail(invalidArgument(`priority_weights.${key}`, 'expected a finite number'));
    parsedWeights[key] = weight;
  }
  if (typeof value['enable_smart_truncation'] !== 'boolean') {
    fail(invalidArgument('enable_smart_truncation', 'expected a boolean'));
  }
  return {
    total_budget: total,
    reserved_for_user_input: reservedUser,
    reserved_for_system: reservedSystem,
    type_limits: limits,
    priority_weights: parsedWeights,
    enable_smart_truncation: value['enable_smart_truncation'],
  };
}
/** Domain value readers/writers for `settings_domains_list` / `settings_apply`. */
function readGeneralDomain(database: SettingsModelsDatabase): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const key of SAFE_SETTING_KEYS) out[key] = readSettingRaw(database, key);
  return out;
}
function readMemoryDomain(database: SettingsModelsDatabase): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, key] of Object.entries(MEMORY_SETTING_KEYS)) {
    const raw = readSettingRaw(database, key);
    out[name] = MEMORY_BOOLEAN_KEYS.includes(name) ? (raw === null ? null : parseStoredBool(raw, false)) : raw;
  }
  return out;
}
function readAnkiConnectDomain(database: SettingsModelsDatabase): Record<string, unknown> {
  const raw = readSettingRaw(database, ANKI_CONNECT_SETTING_KEYS['url']!);
  const deck = readSettingRaw(database, ANKI_CONNECT_SETTING_KEYS['deck']!);
  const enabled = readSettingRaw(database, ANKI_CONNECT_SETTING_KEYS['enabled']!);
  return { url: raw, deck, enabled: enabled === null ? null : parseStoredBool(enabled, false) };
}
function readChatStreamDomain(database: SettingsModelsDatabase): Record<string, unknown> {
  const timeout = readSettingRaw(database, CHAT_STREAM_TIMEOUT_KEY);
  const autoCancel = readSettingRaw(database, CHAT_STREAM_AUTO_CANCEL_KEY);
  return { timeout_ms: timeout, auto_cancel_on_timeout: autoCancel === null ? null : parseStoredBool(autoCancel, true) };
}
function readAutomationDomain(database: SettingsModelsDatabase): Record<string, unknown> {
  const raw = readSettingRaw(database, AUTOMATION_BACKGROUND_KEY);
  return { background_enabled: raw === null ? null : parseStoredBool(raw, true) };
}
function readVoiceInputDomain(database: SettingsModelsDatabase): Record<string, unknown> {
  const raw = readSettingRaw(database, VOICE_INPUT_CONFIG_KEY);
  if (raw === null || raw.trim() === '') return { config: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    return isJsonObject(parsed) ? { config: parsed } : { config: null, invalid: true };
  } catch {
    return { config: null, invalid: true };
  }
}
function readDomain(database: SettingsModelsDatabase, domain: string): Record<string, unknown> {
  switch (domain) {
    case 'general': return readGeneralDomain(database);
    case 'voice_input': return readVoiceInputDomain(database);
    case 'memory': return readMemoryDomain(database);
    case 'anki_connect': return readAnkiConnectDomain(database);
    case 'chat_stream': return readChatStreamDomain(database);
    case 'automation': return readAutomationDomain(database);
    default: return fail(invalidArgument('domain', `unknown settings domain '${domain}'`));
  }
}
function requireDomain(value: string): string {
  if (!SETTINGS_DOMAIN_NAMES.includes(value)) {
    fail(invalidArgument('domain', `unknown settings domain '${value}'; expected one of ${SETTINGS_DOMAIN_NAMES.join(', ')}`));
  }
  return value;
}
function applyGeneralDomain(database: SettingsModelsDatabase, values: Record<string, unknown>,
  previous: Record<string, string | null>, changed: string[]): void {
  for (const [key, raw] of Object.entries(values)) {
    if (!isSafeSettingKey(key)) fail(invalidArgument(key, 'not a writable general setting'));
    const serialized = validateSettingValue(key, raw);
    if (previous[key] === serialized) continue;
    writeSettingRaw(database, key, serialized);
    changed.push(key);
  }
}
function applyMemoryDomain(database: SettingsModelsDatabase, values: Record<string, unknown>, changed: string[]): void {
  for (const [name, raw] of Object.entries(values)) {
    const key = MEMORY_SETTING_KEYS[name];
    if (key === undefined) fail(invalidArgument(name, 'not a writable memory setting'));
    let serialized: string;
    if (MEMORY_BOOLEAN_KEYS.includes(name)) {
      if (typeof raw !== 'boolean') fail(invalidArgument(name, 'expected a boolean'));
      serialized = String(raw);
    } else {
      if (typeof raw !== 'string') fail(invalidArgument(name, 'expected a string'));
      if ([...raw].length > 1_000) fail(invalidArgument(name, 'must contain at most 1000 characters'));
      serialized = raw;
    }
    if (readSettingRaw(database, key) === serialized) continue;
    writeSettingRaw(database, key, serialized);
    changed.push(key);
  }
}
function applyAnkiConnectDomain(database: SettingsModelsDatabase, values: Record<string, unknown>, changed: string[]): void {
  for (const [name, raw] of Object.entries(values)) {
    const key = ANKI_CONNECT_SETTING_KEYS[name];
    if (key === undefined) fail(invalidArgument(name, 'not a writable AnkiConnect setting'));
    let serialized: string;
    if (name === 'enabled') {
      if (typeof raw !== 'boolean') fail(invalidArgument(name, 'expected a boolean'));
      serialized = String(raw);
    } else {
      if (typeof raw !== 'string') fail(invalidArgument(name, 'expected a string'));
      if ([...raw].length > 2_000) fail(invalidArgument(name, 'must contain at most 2000 characters'));
      serialized = raw;
    }
    if (readSettingRaw(database, key) === serialized) continue;
    writeSettingRaw(database, key, serialized);
    changed.push(key);
  }
}
function applyChatStreamDomain(database: SettingsModelsDatabase, values: Record<string, unknown>, changed: string[]): void {
  if ('timeout_ms' in values) {
    const raw = values['timeout_ms'];
    if (raw !== null && (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_CHAT_STREAM_TIMEOUT_MS)) {
      fail(invalidArgument('timeout_ms', `expected null or an integer between 0 and ${MAX_CHAT_STREAM_TIMEOUT_MS}`));
    }
    const serialized = raw === null ? '' : String(raw);
    if (readSettingRaw(database, CHAT_STREAM_TIMEOUT_KEY) !== serialized) {
      writeSettingRaw(database, CHAT_STREAM_TIMEOUT_KEY, serialized);
      changed.push(CHAT_STREAM_TIMEOUT_KEY);
    }
  }
  if ('auto_cancel_on_timeout' in values) {
    const raw = values['auto_cancel_on_timeout'];
    if (typeof raw !== 'boolean') fail(invalidArgument('auto_cancel_on_timeout', 'expected a boolean'));
    const serialized = raw ? '1' : '0';
    if (readSettingRaw(database, CHAT_STREAM_AUTO_CANCEL_KEY) !== serialized) {
      writeSettingRaw(database, CHAT_STREAM_AUTO_CANCEL_KEY, serialized);
      changed.push(CHAT_STREAM_AUTO_CANCEL_KEY);
    }
  }
}
function applyAutomationDomain(database: SettingsModelsDatabase, values: Record<string, unknown>, changed: string[]): void {
  if (!('background_enabled' in values)) return;
  const raw = values['background_enabled'];
  if (typeof raw !== 'boolean') fail(invalidArgument('background_enabled', 'expected a boolean'));
  const serialized = raw ? 'true' : 'false';
  if (readSettingRaw(database, AUTOMATION_BACKGROUND_KEY) !== serialized) {
    writeSettingRaw(database, AUTOMATION_BACKGROUND_KEY, serialized);
    changed.push(AUTOMATION_BACKGROUND_KEY);
  }
}
function applyVoiceInputDomain(database: SettingsModelsDatabase, values: Record<string, unknown>, changed: string[]): void {
  if (!('config' in values)) fail(invalidArgument('config', 'field is required'));
  const raw = values['config'];
  if (raw !== null && !isJsonObject(raw)) fail(invalidArgument('config', 'expected a JSON object or null'));
  if (raw === null) {
    if (readSettingRaw(database, VOICE_INPUT_CONFIG_KEY) === '') return;
    writeSettingRaw(database, VOICE_INPUT_CONFIG_KEY, '');
    changed.push(VOICE_INPUT_CONFIG_KEY);
    return;
  }
  const current = parseJsonObjectField(readSettingRaw(database, VOICE_INPUT_CONFIG_KEY), VOICE_INPUT_CONFIG_KEY);
  const merged = { ...(current ?? {}), ...raw };
  let serialized: string;
  try { serialized = JSON.stringify(merged); }
  catch (error) { fail(invalidArgument('config', `not serializable: ${errorMessage(error)}`)); }
  if ([...serialized].length > 20_000) fail(invalidArgument('config', 'must contain at most 20000 characters'));
  if (readSettingRaw(database, VOICE_INPUT_CONFIG_KEY) === serialized) return;
  writeSettingRaw(database, VOICE_INPUT_CONFIG_KEY, serialized);
  changed.push(VOICE_INPUT_CONFIG_KEY);
}
const DOMAIN_APPLIERS: Readonly<Record<string, (database: SettingsModelsDatabase, values: Record<string, unknown>,
  changed: string[]) => void>> = {
  general: (database, values, changed) => applyGeneralDomain(database, values, readGeneralDomain(database), changed),
  voice_input: applyVoiceInputDomain,
  memory: applyMemoryDomain,
  anki_connect: applyAnkiConnectDomain,
  chat_stream: applyChatStreamDomain,
  automation: applyAutomationDomain,
};
function clearAssignmentsReferencingProfile(database: SettingsModelsDatabase, profileId: string): string[] {
  const stored = readSettingRaw(database, MODEL_ASSIGNMENTS_KEY);
  if (stored === null || stored.trim() === '') return [];
  let parsed: unknown;
  try { parsed = JSON.parse(stored); }
  catch (error) {
    fail(toolError('MODEL_ASSIGNMENTS_INVALID', `Stored model assignments are invalid: ${errorMessage(error)}`,
      'Open Settings and repair the model assignments before retrying.', false));
  }
  if (!isJsonObject(parsed)) fail(toolError('MODEL_ASSIGNMENTS_INVALID', 'Stored model assignments are invalid.',
    'Open Settings and repair the model assignments before retrying.', false));
  const updated: Record<string, unknown> = { ...parsed };
  const cleared: string[] = [];
  for (const [slot, value] of Object.entries(parsed)) {
    if (value === profileId) { updated[slot] = null; cleared.push(slot); }
  }
  if (cleared.length > 0) writeSettingRaw(database, MODEL_ASSIGNMENTS_KEY, JSON.stringify(updated));
  return cleared;
}
interface SettingsRowPayload { key: string; value: string; updated_at: string; truncated: boolean }

export class SettingsModelsToolExecutor {
  canHandle(toolName: string): boolean {
    const name = stripToolNamespace(toolName);
    return name === SETTINGS_GET_TOOL || name === SETTINGS_SET_TOOL || name === MODEL_ASSIGNMENTS_GET_TOOL
      || name === MODEL_ASSIGNMENTS_SET_TOOL || name === MODEL_PROFILE_ADD_TOOL || LLM_CONFIG_TOOLS.includes(name);
  }
  sensitivityLevel(toolName: string): ToolSensitivity {
    switch (stripToolNamespace(toolName)) {
      case SETTINGS_SET_TOOL: case MODEL_ASSIGNMENTS_SET_TOOL: return 'medium';
      case MODEL_PROFILE_ADD_TOOL:
      case LLM_CONFIG_VENDOR_UPSERT_TOOL: case LLM_CONFIG_VENDOR_KEY_SET_TOOL:
      case LLM_CONFIG_PROFILE_UPSERT_TOOL: case LLM_CONFIG_PROFILE_DELETE_TOOL:
      case LLM_CONFIG_FAILOVER_SET_TOOL: case LLM_CONFIG_BUDGET_SET_TOOL: case SETTINGS_APPLY_TOOL:
        return 'high';
      default: return 'low';
    }
  }
  concurrencyClass(toolName: string): ToolConcurrency {
    const name = stripToolNamespace(toolName);
    if (name === SETTINGS_GET_TOOL || name === MODEL_ASSIGNMENTS_GET_TOOL) return 'read_only';
    if (LLM_CONFIG_READ_ONLY_TOOLS.includes(name)) return 'read_only';
    return 'serial';
  }
  name(): string { return 'SettingsModelsToolExecutor'; }
  async execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResultInfo> {
    const startedAt = Date.now(), toolName = stripToolNamespace(call.name);
    const safeArguments = LLM_CONFIG_CREDENTIAL_TOOLS.includes(toolName)
      ? redactCredentialArguments(call.arguments) : call.arguments;
    ctx.emitToolCallStart(call.name, safeArguments, call.id);
    let output: unknown;
    try { output = await this.dispatch(toolName, call, ctx); }
    catch (error) {
      const failure = error instanceof ToolFailure ? error.payload : errorMessage(error);
      const duration = Date.now() - startedAt;
      ctx.emitToolCallError(failure);
      const result: ToolResultInfo = { toolCallId: call.id, blockId: ctx.blockId, toolName: call.name,
        input: safeArguments, output: null, success: false, error: failure, durationMs: duration };
      this.persist(ctx, result);
      return result;
    }
    const durationMs = Date.now() - startedAt;
    ctx.emitToolCallEnd({ result: output, durationMs });
    const result: ToolResultInfo = { toolCallId: call.id, blockId: ctx.blockId, toolName: call.name,
      input: safeArguments, output, success: true, durationMs };
    this.persist(ctx, result);
    return result;
  }
  private persist(ctx: ToolExecutionContext, result: ToolResultInfo): void {
    try { ctx.saveToolBlock(result); }
    catch (error) { ctx.warn(`[SettingsModelsToolExecutor] Failed to persist tool block: ${errorMessage(error)}`); }
  }
  private async dispatch(toolName: string, call: ToolCall, ctx: ToolExecutionContext): Promise<unknown> {
    switch (toolName) {
      case SETTINGS_GET_TOOL: return this.executeSettingsGet(call.arguments, ctx);
      case SETTINGS_SET_TOOL: return this.executeSettingsSet(call.arguments, ctx);
      case MODEL_ASSIGNMENTS_GET_TOOL: return this.executeModelAssignmentsGet(call.arguments, ctx);
      case MODEL_ASSIGNMENTS_SET_TOOL: return this.executeModelAssignmentsSet(call.arguments, ctx);
      case MODEL_PROFILE_ADD_TOOL: return this.executeModelProfileAdd(call.arguments, ctx);
      case LLM_CONFIG_VENDORS_LIST_TOOL: return this.executeVendorsList(call.arguments, ctx);
      case LLM_CONFIG_VENDOR_UPSERT_TOOL: return this.executeVendorUpsert(call.arguments, ctx);
      case LLM_CONFIG_VENDOR_KEY_SET_TOOL: return this.executeVendorKeySet(call.arguments, ctx);
      case LLM_CONFIG_MODELS_FETCH_TOOL: return this.executeModelsFetch(call.arguments, ctx);
      case LLM_CONFIG_TEST_TOOL: return this.executeConfigTest(call.arguments, ctx);
      case LLM_CONFIG_PROFILES_LIST_TOOL: return this.executeProfilesList(call.arguments, ctx);
      case LLM_CONFIG_PROFILE_UPSERT_TOOL: return this.executeProfileUpsert(call.arguments, ctx);
      case LLM_CONFIG_PROFILE_DELETE_TOOL: return this.executeProfileDelete(call.arguments, ctx);
      case LLM_CONFIG_FAILOVER_GET_TOOL: return this.executeFailoverGet(call.arguments, ctx);
      case LLM_CONFIG_FAILOVER_SET_TOOL: return this.executeFailoverSet(call.arguments, ctx);
      case LLM_CONFIG_BUDGET_GET_TOOL: return this.executeBudgetGet(call.arguments, ctx);
      case LLM_CONFIG_BUDGET_SET_TOOL: return this.executeBudgetSet(call.arguments, ctx);
      case SETTINGS_DOMAINS_LIST_TOOL: return this.executeSettingsDomainsList(call.arguments, ctx);
      case SETTINGS_APPLY_TOOL: return this.executeSettingsApply(call.arguments, ctx);
      default: return fail(toolError('UNKNOWN_TOOL', `Unknown settings/model tool '${call.name}'.`,
        'Use one of the registered settings/model tools.', false));
    }
  }
  private executeSettingsGet(argumentsValue: unknown, ctx: ToolExecutionContext): unknown {
    const args = argumentsObject(argumentsValue, SETTINGS_GET_FIELDS);
    const prefix = requiredString(args, 'prefix', 128);
    rejectSensitiveIdentifier('prefix', prefix);
    if (!SAFE_READ_PREFIXES.includes(prefix)) fail(toolError('SETTING_PREFIX_NOT_ALLOWED',
      `Setting prefix '${prefix}' is not readable by the agent.`, 'Use one of the public prefixes declared by the settings tool schema.', false));
    const database = requireDatabase(ctx);
    let rows: SettingRow[];
    try { rows = database.listByPrefix(prefix); }
    catch (error) { fail(toolError('SETTINGS_READ_FAILED', `Failed to read public settings: ${errorMessage(error)}`,
      'Retry after checking the local database.', true)); }
    const settings: SettingsRowPayload[] = [];
    for (const row of rows) {
      if (!isSafeSettingKey(row.key) || containsSensitiveIdentifier(row.key)) continue;
      const value = boundedString(row.value), updatedAt = boundedString(row.updatedAt);
      settings.push({ key: row.key, value: value.value, updated_at: updatedAt.value, truncated: value.truncated || updatedAt.truncated });
      if (settings.length === MAX_SETTING_ROWS) break;
    }
    return { prefix, settings, count: settings.length, message_key: 'chat.tools.settings_models.settings_get.success' };
  }
  private executeSettingsSet(argumentsValue: unknown, ctx: ToolExecutionContext): unknown {
    const args = argumentsObject(argumentsValue, SETTINGS_SET_FIELDS), key = requiredString(args, 'key', 128);
    rejectSensitiveIdentifier('key', key);
    if (!isSafeSettingKey(key)) fail(toolError('SETTING_WRITE_NOT_ALLOWED', `Setting '${key}' cannot be changed by the agent.`,
      'Open Settings for credentials, permissions, MCP, sync, and other protected values.', false));
    if (!('value' in args)) fail(invalidArgument('value', 'field is required'));
    const value = validateSettingValue(key, args['value']), database = requireDatabase(ctx);
    let previousValue: string | null;
    try { previousValue = database.get(key); }
    catch (error) { fail(toolError('SETTINGS_READ_FAILED', `Failed to read the current setting: ${errorMessage(error)}`,
      'Retry after checking the local database.', true)); }
    const changed = previousValue !== value;
    if (changed) {
      try { database.save(key, value); }
      catch (error) { fail(toolError('SETTINGS_WRITE_FAILED', `Failed to save the setting: ${errorMessage(error)}`,
        'Retry after checking local storage availability.', true)); }
    }
    const eventEmitted = emitAppEvent(ctx, SETTINGS_CHANGED_EVENT, { action: 'set', key });
    const previous = boundedOptionalString(previousValue);
    return { key, value, previous_value: previous.value, previous_value_truncated: previous.truncated, changed,
      event: SETTINGS_CHANGED_EVENT, event_emitted: eventEmitted, runtime_sync: eventEmitted ? 'event_emitted' : 'persisted_refresh_pending',
      message_key: eventEmitted ? 'chat.tools.settings_models.settings_set.success' : 'chat.tools.settings_models.settings_set.saved_refresh_pending' };
  }
  private async executeModelAssignmentsGet(argumentsValue: unknown, ctx: ToolExecutionContext): Promise<unknown> {
    const args = argumentsObject(argumentsValue, MODEL_ASSIGNMENTS_GET_FIELDS);
    const page = optionalPositiveInteger(args, 'page', 1, MAX_USIZE), pageSize = optionalPositiveInteger(args, 'page_size', 20, 20);
    const llm = requireLlm(ctx), assignments = await readModelAssignments(llm), configs = await readApiConfigs(llm);
    const totalModels = configs.length, start = (page - 1) * pageSize, end = Math.min(start + pageSize, totalModels);
    const availableModels: SafeModelJson[] = start < totalModels ? configs.slice(start, end).map(config => safeModelJson(config, ctx.voiceInput)) : [];
    const bounded = boundJsonStrings(assignments);
    return { assignments: bounded.value, assignments_truncated: bounded.truncated, available_models: availableModels,
      pagination: { page, page_size: pageSize, total: totalModels, has_more: end < totalModels },
      message_key: 'chat.tools.settings_models.model_assignments_get.success' };
  }
  private async executeModelAssignmentsSet(argumentsValue: unknown, ctx: ToolExecutionContext): Promise<unknown> {
    const args = argumentsObject(argumentsValue, MODEL_ASSIGNMENTS_SET_FIELDS);
    const slot = parseAssignmentSlot(requiredString(args, 'slot', 128));
    const configId = requiredNullableString(args, 'config_id'), expectedCurrentConfigId = requiredNullableString(args, 'expected_current_config_id');
    if (configId !== null) {
      const llm = requireLlm(ctx), configs = await readApiConfigs(llm);
      const config = configs.find(candidate => candidate.id === configId);
      if (config === undefined) fail(toolError('MODEL_NOT_FOUND', `Model configuration '${configId}' does not exist.`,
        'Call model_assignments_get and choose an available model id.', false));
      validateModelForSlot(slot, modelCapabilitiesFromConfig(config, ctx.voiceInput), ctx.voiceInput);
    }
    const database = requireDatabase(ctx), update = updateModelAssignmentAtomic(database, slot, configId, expectedCurrentConfigId);
    if (update.kind === 'conflict') {
      const current = boundedOptionalString(update.currentConfigId);
      fail(toolErrorWithFields('MODEL_ASSIGNMENT_CONFLICT', 'The model assignment changed after it was read.',
        'Call model_assignments_get, inspect the current slot, and retry with that value as expected_current_config_id.', false,
        { slot, current_config_id: current.value, current_config_id_truncated: current.truncated, expected_current_config_id: expectedCurrentConfigId }));
    }
    const eventEmitted = emitAppEvent(ctx, MODEL_ASSIGNMENTS_CHANGED_EVENT, { action: 'set', slot });
    const bounded = boundJsonStrings(update.assignments), previous = boundedOptionalString(update.previousConfigId);
    return { slot, previous_config_id: previous.value, previous_config_id_truncated: previous.truncated, config_id: configId,
      assignments: bounded.value, assignments_truncated: bounded.truncated, changed: update.changed,
      event: MODEL_ASSIGNMENTS_CHANGED_EVENT, event_emitted: eventEmitted,
      runtime_sync: eventEmitted ? 'event_emitted' : 'persisted_refresh_pending', message_key: eventEmitted
        ? 'chat.tools.settings_models.model_assignments_set.success' : 'chat.tools.settings_models.model_assignments_set.saved_refresh_pending' };
  }
  private async executeModelProfileAdd(argumentsValue: unknown, ctx: ToolExecutionContext): Promise<unknown> {
    const args = argumentsObjectAllowingCredentials(argumentsValue, MODEL_PROFILE_ADD_FIELDS);
    const model = requiredString(args, 'model', MAX_MODEL_CONFIG_ID_CHARS);
    const label = optionalString(args, 'label', MAX_MODEL_CONFIG_ID_CHARS), vendorId = optionalString(args, 'vendor_id', MAX_MODEL_CONFIG_ID_CHARS);
    const vendorName = optionalString(args, 'vendor_name', MAX_MODEL_CONFIG_ID_CHARS), providerType = optionalString(args, 'provider_type', MAX_PROVIDER_TYPE_CHARS);
    const baseUrl = optionalString(args, 'base_url', MAX_BASE_URL_CHARS), apiKey = optionalString(args, 'api_key', MAX_API_KEY_CHARS);
    if (apiKey !== null && isMaskedSecret(apiKey)) fail(toolError('API_KEY_PLACEHOLDER_REJECTED',
      'The api_key value is a redaction placeholder, not a real key.', 'The key shown in chat history is redacted. Ask the user to paste the real key again.', false));
    const capabilities = profileCapabilityFlags(args), llm = requireLlm(ctx);
    let vendors: VendorConfig[];
    try { vendors = await llm.getVendorConfigs(); }
    catch (error) { return fail(toolError('VENDOR_DIRECTORY_READ_FAILED', `Failed to read the vendor directory: ${errorMessage(error)}`,
      'Retry after checking the model settings.', true)); }
    let vendorReused = false, apiKeyApplied = false;
    let resolvedVendorId: string;
    if (vendorId !== null) {
      const existing = vendors.find(vendor => vendor.id === vendorId);
      if (existing === undefined) fail(toolError('MODEL_VENDOR_NOT_FOUND', `Vendor '${vendorId}' does not exist.`,
        'Call model_assignments_get to list vendors, or omit vendor_id and pass vendor_name + base_url to create one.', false));
      vendorReused = true;
      if (apiKey !== null && apiKey !== '') { existing.apiKey = apiKey; apiKeyApplied = true; }
      resolvedVendorId = vendorId;
    } else {
      if (vendorName === null) fail(invalidArgument('vendor_name', 'required when vendor_id is omitted'));
      if (baseUrl === null) fail(invalidArgument('base_url', 'required when vendor_id is omitted'));
      validateBaseUrl(baseUrl);
      const resolvedProviderType = providerType ?? 'openai';
      validateProviderType(resolvedProviderType);
      const existing = vendors.find(vendor => urlsSameOrigin(vendor.baseUrl, baseUrl)
        && asciiLower(vendor.providerType) === asciiLower(resolvedProviderType));
      if (existing !== undefined) {
        vendorReused = true;
        if (apiKey !== null && apiKey !== '') { existing.apiKey = apiKey; apiKeyApplied = true; }
        resolvedVendorId = existing.id;
      } else {
        const newVendorId = `agent-${randomUUID()}`;
        apiKeyApplied = apiKey !== null && apiKey !== '';
        vendors.push({ ...defaultVendorConfig(), id: newVendorId, name: vendorName, providerType: resolvedProviderType,
          apiProtocol: null, supportsOpenaiResponses: null, baseUrl, apiKey: apiKey ?? '' });
        resolvedVendorId = newVendorId;
      }
    }
    let profiles: ModelProfile[];
    try { profiles = await llm.getModelProfiles(); }
    catch (error) { return fail(toolError('MODEL_DIRECTORY_READ_FAILED', `Failed to read the model directory: ${errorMessage(error)}`,
      'Retry after checking the model settings.', true)); }
    const duplicate = profiles.find(profile => profile.vendorId === resolvedVendorId && asciiLower(profile.model) === asciiLower(model));
    if (duplicate !== undefined) fail(toolErrorWithFields('MODEL_PROFILE_EXISTS',
      `Model '${model}' already exists on this vendor as '${duplicate.label}'.`,
      'Use model_assignments_set to assign the existing model, or choose a different model name.', false, { existing_profile_id: duplicate.id }));
    const profileId = `agent-${randomUUID()}`;
    const profile = modelProfileFromDe({ id: profileId, vendorId: resolvedVendorId, label: label ?? model, model,
      isMultimodal: capabilities.multimodal, isReasoning: capabilities.reasoning, isEmbedding: capabilities.embedding,
      isReranker: capabilities.reranker, isImageGeneration: capabilities.imageGeneration, supportsTools: capabilities.supportsTools,
      contextWindow: capabilities.contextWindow, ...(capabilities.maxOutputTokens === null ? {} : { maxOutputTokens: capabilities.maxOutputTokens }) });
    profiles.push(profile);
    try { await llm.saveVendorModelConfigs(vendors, profiles); }
    catch (error) { return fail(toolError('MODEL_PROFILE_ADD_FAILED', `Failed to save the model configuration: ${errorMessage(error)}`,
      'Retry after checking the local database.', true)); }
    const eventEmitted = emitAppEvent(ctx, MODEL_PROFILES_CHANGED_EVENT, { action: 'add', vendor_id: resolvedVendorId, profile_id: profileId });
    return { profile_id: profileId, vendor_id: resolvedVendorId, vendor_reused: vendorReused, api_key_applied: apiKeyApplied,
      label: profile.label, model: profile.model, enabled: profile.enabled,
      capabilities: { multimodal: profile.isMultimodal, reasoning: profile.isReasoning, embedding: profile.isEmbedding,
        reranker: profile.isReranker, image_generation: profile.isImageGeneration, supports_tools: profile.supportsTools },
      event: MODEL_PROFILES_CHANGED_EVENT, event_emitted: eventEmitted,
      runtime_sync: eventEmitted ? 'event_emitted' : 'persisted_refresh_pending', message_key: 'chat.tools.settings_models.model_profile_add.success' };
  }
  private async executeVendorsList(argumentsValue: unknown, ctx: ToolExecutionContext): Promise<unknown> {
    argumentsObject(argumentsValue, LLM_CONFIG_VENDORS_LIST_FIELDS);
    const llm = requireLlm(ctx), vendors = await readVendors(llm), profiles = await readProfiles(llm);
    const items = vendors.map(vendor => ({
      id: vendor.id,
      name: boundedString(vendor.name).value,
      display_name: boundedString(vendor.name).value,
      provider_type: vendor.providerType,
      base_url: vendor.baseUrl,
      auth_mode: vendor.authMode,
      enabled: profiles.some(profile => profile.vendorId === vendor.id && profile.enabled),
      key_present: Boolean(vendor.apiKey && vendor.apiKey.trim()),
      keys_count: vendor.apiKeys?.length ?? 0,
      builtin: vendor.isBuiltin,
      read_only: vendor.isReadOnly,
    }));
    return { vendors: items, count: items.length, message_key: 'chat.tools.settings_models.llm_config_vendors_list.success' };
  }
  private async executeVendorUpsert(argumentsValue: unknown, ctx: ToolExecutionContext): Promise<unknown> {
    const args = argumentsObjectAllowingCredentials(argumentsValue, LLM_CONFIG_VENDOR_UPSERT_FIELDS);
    const vendorId = optionalString(args, 'vendor_id', MAX_MODEL_CONFIG_ID_CHARS);
    const apiKey = optionalString(args, 'api_key', MAX_API_KEY_CHARS);
    if (apiKey !== null) rejectCredentialPlaceholder('api_key', apiKey);
    const providerType = optionalString(args, 'provider_type', MAX_PROVIDER_TYPE_CHARS);
    const baseUrl = optionalString(args, 'base_url', MAX_BASE_URL_CHARS);
    const authMode = optionalString(args, 'auth_mode', MAX_PROVIDER_TYPE_CHARS);
    const headers = optionalStringMap(args, 'headers');
    const enabled = 'enabled' in args ? optionalBool(args, 'enabled') : null;
    const llm = requireLlm(ctx), vendors = await readVendors(llm), profiles = await readProfiles(llm);
    let vendor: VendorConfig, created = false;
    if (vendorId !== null) {
      const existing = vendors.find(candidate => candidate.id === vendorId);
      if (existing === undefined) fail(toolError('MODEL_VENDOR_NOT_FOUND', `Vendor '${vendorId}' does not exist.`,
        'Call llm_config_vendors_list to read vendor ids, or omit vendor_id to create a new vendor.', false));
      if (existing.isReadOnly) fail(toolError('MODEL_VENDOR_READ_ONLY', `Vendor '${vendorId}' is read-only.`,
        'Create a separate vendor instead of editing a built-in one.', false));
      vendor = existing;
      const name = optionalString(args, 'vendor_name', MAX_MODEL_CONFIG_ID_CHARS);
      if (name !== null) vendor.name = name;
      if (providerType !== null) { validateProviderType(providerType); vendor.providerType = providerType; }
      if (baseUrl !== null) { validateBaseUrl(baseUrl); vendor.baseUrl = baseUrl; }
      if (apiKey !== null && apiKey !== '') vendor.apiKey = apiKey;
      if (authMode !== null) vendor.authMode = authMode;
      if (headers !== null) vendor.headers = headers;
    } else {
      const name = requiredString(args, 'vendor_name', MAX_MODEL_CONFIG_ID_CHARS);
      const requiredProviderType = requiredString(args, 'provider_type', MAX_PROVIDER_TYPE_CHARS);
      const requiredBaseUrl = requiredString(args, 'base_url', MAX_BASE_URL_CHARS);
      validateBaseUrl(requiredBaseUrl);
      validateProviderType(requiredProviderType);
      vendor = { ...defaultVendorConfig(), id: `agent-${randomUUID()}`, name, providerType: requiredProviderType,
        authMode, baseUrl: requiredBaseUrl, apiKey: apiKey ?? '', headers: headers ?? {} };
      vendors.push(vendor);
      created = true;
    }
    if (enabled !== null) {
      for (const profile of profiles) if (profile.vendorId === vendor.id) profile.enabled = enabled;
    }
    await saveDirectory(llm, vendors, profiles, 'MODEL_VENDOR_SAVE_FAILED', 'the vendor configuration');
    const eventEmitted = emitAppEvent(ctx, MODEL_PROFILES_CHANGED_EVENT,
      { action: created ? 'vendor_add' : 'vendor_update', vendor_id: vendor.id });
    return {
      vendor_id: vendor.id,
      created,
      name: vendor.name,
      provider_type: vendor.providerType,
      base_url: vendor.baseUrl,
      auth_mode: vendor.authMode,
      enabled: profiles.some(profile => profile.vendorId === vendor.id && profile.enabled),
      key_present: Boolean(vendor.apiKey && vendor.apiKey.trim()),
      keys_count: vendor.apiKeys?.length ?? 0,
      event: MODEL_PROFILES_CHANGED_EVENT,
      event_emitted: eventEmitted,
      message_key: 'chat.tools.settings_models.llm_config_vendor_upsert.success',
    };
  }
  private async executeVendorKeySet(argumentsValue: unknown, ctx: ToolExecutionContext): Promise<unknown> {
    const args = argumentsObjectAllowingCredentials(argumentsValue, LLM_CONFIG_VENDOR_KEY_SET_FIELDS);
    const vendorId = requiredString(args, 'vendor_id', MAX_MODEL_CONFIG_ID_CHARS);
    const apiKey = requiredString(args, 'api_key', MAX_API_KEY_CHARS);
    rejectCredentialPlaceholder('api_key', apiKey);
    const llm = requireLlm(ctx), vendors = await readVendors(llm), profiles = await readProfiles(llm);
    const vendor = vendors.find(candidate => candidate.id === vendorId);
    if (vendor === undefined) fail(toolError('MODEL_VENDOR_NOT_FOUND', `Vendor '${vendorId}' does not exist.`,
      'Call llm_config_vendors_list and retry with an existing vendor_id.', false));
    if (vendor.isReadOnly) fail(toolError('MODEL_VENDOR_READ_ONLY', `Vendor '${vendorId}' is read-only.`,
      'Create a separate vendor instead of editing a built-in one.', false));
    vendor.apiKey = apiKey;
    await saveDirectory(llm, vendors, profiles, 'MODEL_VENDOR_SAVE_FAILED', 'the vendor API key');
    const eventEmitted = emitAppEvent(ctx, MODEL_PROFILES_CHANGED_EVENT, { action: 'vendor_key_set', vendor_id: vendorId });
    return {
      vendor_id: vendorId,
      key_present: true,
      keys_count: vendor.apiKeys?.length ?? 0,
      event: MODEL_PROFILES_CHANGED_EVENT,
      event_emitted: eventEmitted,
      message_key: 'chat.tools.settings_models.llm_config_vendor_key_set.success',
    };
  }
  private async executeModelsFetch(argumentsValue: unknown, ctx: ToolExecutionContext): Promise<unknown> {
    const args = argumentsObjectAllowingCredentials(argumentsValue, LLM_CONFIG_MODELS_FETCH_FIELDS);
    const vendorId = optionalString(args, 'vendor_id', MAX_MODEL_CONFIG_ID_CHARS);
    const providerType = optionalString(args, 'provider_type', MAX_PROVIDER_TYPE_CHARS);
    const baseUrl = optionalString(args, 'base_url', MAX_BASE_URL_CHARS);
    const apiKey = optionalString(args, 'api_key', MAX_API_KEY_CHARS);
    if (apiKey !== null) rejectCredentialPlaceholder('api_key', apiKey);
    let vendor: VendorConfig, persisted = false;
    if (vendorId !== null) {
      const llm = requireLlm(ctx), vendors = await readVendors(llm);
      const existing = vendors.find(candidate => candidate.id === vendorId);
      if (existing === undefined) fail(toolError('MODEL_VENDOR_NOT_FOUND', `Vendor '${vendorId}' does not exist.`,
        'Call llm_config_vendors_list and retry with an existing vendor_id.', false));
      vendor = existing;
      persisted = true;
    } else {
      if (providerType === null) fail(invalidArgument('provider_type', 'required when vendor_id is omitted'));
      if (baseUrl === null) fail(invalidArgument('base_url', 'required when vendor_id is omitted'));
      validateBaseUrl(baseUrl);
      validateProviderType(providerType);
      vendor = { ...defaultVendorConfig(), id: 'probe', name: 'probe', providerType, baseUrl, apiKey: apiKey ?? '' };
    }
    const probe = requireProbe(ctx);
    let models;
    try { models = await probe.fetchVendorModels(vendor); }
    catch (error) {
      fail(toolError('MODEL_FETCH_FAILED', `Failed to fetch remote models: ${errorMessage(error)}`,
        'Check the base URL, API key and network connectivity, then retry.', true));
    }
    return {
      vendor_id: persisted ? vendor.id : null,
      models: models.map(model => ({ id: model.id, label: model.label, context_window: model.context_window,
        max_output_tokens: model.max_output_tokens })),
      count: models.length,
      message_key: 'chat.tools.settings_models.llm_config_models_fetch.success',
    };
  }
  private async executeConfigTest(argumentsValue: unknown, ctx: ToolExecutionContext): Promise<unknown> {
    const args = argumentsObject(argumentsValue, LLM_CONFIG_TEST_FIELDS);
    const profileId = optionalString(args, 'profile_id', MAX_MODEL_CONFIG_ID_CHARS);
    const vendorId = optionalString(args, 'vendor_id', MAX_MODEL_CONFIG_ID_CHARS);
    const requestedModel = optionalString(args, 'model', MAX_MODEL_CONFIG_ID_CHARS);
    const llm = requireLlm(ctx), vendors = await readVendors(llm), profiles = await readProfiles(llm);
    let vendor: VendorConfig | undefined, model: string;
    if (profileId !== null) {
      const profile = profiles.find(candidate => candidate.id === profileId);
      if (profile === undefined) fail(toolError('MODEL_PROFILE_NOT_FOUND', `Model profile '${profileId}' does not exist.`,
        'Call llm_config_profiles_list and retry with an existing profile_id.', false));
      model = requestedModel ?? profile.model;
      vendor = vendors.find(candidate => candidate.id === profile.vendorId);
      if (vendor === undefined) fail(toolError('MODEL_VENDOR_NOT_FOUND', `Vendor '${profile.vendorId}' does not exist.`,
        'Call llm_config_vendors_list and re-create the missing vendor.', false));
    } else {
      if (vendorId === null) fail(invalidArgument('vendor_id', 'required when profile_id is omitted'));
      if (requestedModel === null) fail(invalidArgument('model', 'required when profile_id is omitted'));
      model = requestedModel;
      vendor = vendors.find(candidate => candidate.id === vendorId);
      if (vendor === undefined) fail(toolError('MODEL_VENDOR_NOT_FOUND', `Vendor '${vendorId}' does not exist.`,
        'Call llm_config_vendors_list and retry with an existing vendor_id.', false));
    }
    const probe = requireProbe(ctx);
    let outcome;
    try { outcome = await probe.testConnection(vendor, model, true); }
    catch (error) {
      fail(toolError('MODEL_TEST_FAILED', `Connection test failed: ${errorMessage(error)}`,
        'Check the vendor settings and network connectivity, then retry.', true));
    }
    const message = outcome.message !== '' ? outcome.message
      : outcome.warning !== null ? outcome.warning : outcome.ok ? 'Connection OK' : 'Connection failed';
    return {
      success: outcome.ok,
      latency_ms: outcome.latency_ms,
      message,
      model,
      vendor_id: vendor.id,
      category: outcome.category,
      message_key: 'chat.tools.settings_models.llm_config_test.success',
    };
  }
  private async executeProfilesList(argumentsValue: unknown, ctx: ToolExecutionContext): Promise<unknown> {
    argumentsObject(argumentsValue, LLM_CONFIG_PROFILES_LIST_FIELDS);
    const llm = requireLlm(ctx), profiles = await readProfiles(llm);
    const items = profiles.map(profile => ({
      id: profile.id,
      vendor_id: profile.vendorId,
      name: boundedString(profile.label).value,
      model: profile.model,
      enabled: profile.enabled,
      is_multimodal: profile.isMultimodal,
      supports_thinking: profile.isReasoning || profile.supportsReasoning || profile.thinkingEnabled,
      supports_function_calling: profile.supportsTools,
      context_window: profile.contextWindow,
      max_output_tokens: profile.maxOutputTokens,
      is_builtin: profile.isBuiltin,
    }));
    return { profiles: items, count: items.length, message_key: 'chat.tools.settings_models.llm_config_profiles_list.success' };
  }
  private async executeProfileUpsert(argumentsValue: unknown, ctx: ToolExecutionContext): Promise<unknown> {
    const args = argumentsObject(argumentsValue, LLM_CONFIG_PROFILE_UPSERT_FIELDS);
    const profileId = optionalString(args, 'profile_id', MAX_MODEL_CONFIG_ID_CHARS);
    const vendorId = optionalString(args, 'vendor_id', MAX_MODEL_CONFIG_ID_CHARS);
    const model = optionalString(args, 'model', MAX_MODEL_CONFIG_ID_CHARS);
    const name = optionalString(args, 'name', MAX_MODEL_CONFIG_ID_CHARS) ?? optionalString(args, 'label', MAX_MODEL_CONFIG_ID_CHARS);
    const contextProvided = 'context_window' in args;
    const contextWindow = contextProvided && args['context_window'] !== null
      ? optionalPositiveInteger(args, 'context_window', 1, 10_000_000) : null;
    const contextCleared = contextProvided && args['context_window'] === null;
    const maxTokensProvided = 'max_output_tokens' in args;
    const maxOutputTokens = maxTokensProvided ? optionalPositiveInteger(args, 'max_output_tokens', 1, 1_000_000) : null;
    const llm = requireLlm(ctx), vendors = await readVendors(llm), profiles = await readProfiles(llm);
    let profile: ModelProfile, created = false;
    if (profileId !== null) {
      const existing = profiles.find(candidate => candidate.id === profileId);
      if (existing === undefined) fail(toolError('MODEL_PROFILE_NOT_FOUND', `Model profile '${profileId}' does not exist.`,
        'Call llm_config_profiles_list and retry with an existing profile_id.', false));
      profile = existing;
    } else {
      if (vendorId === null) fail(invalidArgument('vendor_id', 'required when profile_id is omitted'));
      if (model === null) fail(invalidArgument('model', 'required when profile_id is omitted'));
      const vendor = vendors.find(candidate => candidate.id === vendorId);
      if (vendor === undefined) fail(toolError('MODEL_VENDOR_NOT_FOUND', `Vendor '${vendorId}' does not exist.`,
        'Create the vendor with llm_config_vendor_upsert first.', false));
      const duplicate = profiles.find(candidate => candidate.vendorId === vendorId
        && asciiLower(candidate.model) === asciiLower(model));
      if (duplicate === undefined) {
        profile = modelProfileFromDe({ id: `agent-${randomUUID()}`, vendorId, label: name ?? model, model });
        profiles.push(profile);
        created = true;
      } else {
        profile = duplicate;
      }
    }
    if (name !== null) profile.label = name;
    if ('enabled' in args) profile.enabled = optionalBool(args, 'enabled');
    if ('is_multimodal' in args) profile.isMultimodal = optionalBool(args, 'is_multimodal');
    if ('supports_thinking' in args) {
      const thinking = optionalBool(args, 'supports_thinking');
      profile.isReasoning = thinking;
      profile.supportsReasoning = thinking;
      profile.thinkingEnabled = thinking;
    }
    if ('supports_function_calling' in args) profile.supportsTools = optionalBool(args, 'supports_function_calling');
    if (contextProvided) profile.contextWindow = contextWindow;
    if (contextCleared) profile.contextWindow = null;
    if (maxTokensProvided && maxOutputTokens !== null) profile.maxOutputTokens = maxOutputTokens;
    await saveDirectory(llm, vendors, profiles, 'MODEL_PROFILE_SAVE_FAILED', 'the model profile');
    const eventEmitted = emitAppEvent(ctx, MODEL_PROFILES_CHANGED_EVENT,
      { action: created ? 'profile_add' : 'profile_update', vendor_id: profile.vendorId, profile_id: profile.id });
    return {
      profile_id: profile.id,
      vendor_id: profile.vendorId,
      created,
      name: profile.label,
      model: profile.model,
      enabled: profile.enabled,
      is_multimodal: profile.isMultimodal,
      supports_thinking: profile.isReasoning || profile.supportsReasoning || profile.thinkingEnabled,
      supports_function_calling: profile.supportsTools,
      context_window: profile.contextWindow,
      max_output_tokens: profile.maxOutputTokens,
      event: MODEL_PROFILES_CHANGED_EVENT,
      event_emitted: eventEmitted,
      message_key: 'chat.tools.settings_models.llm_config_profile_upsert.success',
    };
  }
  private async executeProfileDelete(argumentsValue: unknown, ctx: ToolExecutionContext): Promise<unknown> {
    const args = argumentsObject(argumentsValue, LLM_CONFIG_PROFILE_DELETE_FIELDS);
    const profileId = requiredString(args, 'profile_id', MAX_MODEL_CONFIG_ID_CHARS);
    const llm = requireLlm(ctx), vendors = await readVendors(llm), profiles = await readProfiles(llm);
    const index = profiles.findIndex(candidate => candidate.id === profileId);
    if (index < 0) fail(toolError('MODEL_PROFILE_NOT_FOUND', `Model profile '${profileId}' does not exist.`,
      'Call llm_config_profiles_list and retry with an existing profile_id.', false));
    const [removed] = profiles.splice(index, 1);
    await saveDirectory(llm, vendors, profiles, 'MODEL_PROFILE_DELETE_FAILED', 'the model profile deletion');
    const clearedSlots = ctx.database === undefined || ctx.database === null
      ? [] : clearAssignmentsReferencingProfile(ctx.database, profileId);
    const profilesEvent = emitAppEvent(ctx, MODEL_PROFILES_CHANGED_EVENT,
      { action: 'profile_delete', vendor_id: removed?.vendorId ?? null, profile_id: profileId });
    const assignmentsEvent = clearedSlots.length === 0 ? false
      : emitAppEvent(ctx, MODEL_ASSIGNMENTS_CHANGED_EVENT, { action: 'clear_deleted_profile', profile_id: profileId, slots: clearedSlots });
    return {
      profile_id: profileId,
      deleted: true,
      cleared_slots: clearedSlots,
      event: MODEL_PROFILES_CHANGED_EVENT,
      event_emitted: profilesEvent,
      assignments_event: MODEL_ASSIGNMENTS_CHANGED_EVENT,
      assignments_event_emitted: assignmentsEvent,
      message_key: 'chat.tools.settings_models.llm_config_profile_delete.success',
    };
  }
  private executeFailoverGet(argumentsValue: unknown, ctx: ToolExecutionContext): unknown {
    argumentsObject(argumentsValue, LLM_CONFIG_FAILOVER_GET_FIELDS);
    const database = requireDatabase(ctx), raw = readSettingRaw(database, FAILOVER_POLICY_KEY);
    if (raw === null || raw.trim() === '') {
      return { policy: defaultFailoverPolicy(), configured: false, message_key: 'chat.tools.settings_models.llm_config_failover_get.success' };
    }
    let policy;
    try { policy = projectFailoverPolicy(decodeFailoverPolicyExact(raw)); }
    catch {
      // Invalid stored policies are discarded by the runtime; expose the default without failing the read.
      policy = defaultFailoverPolicy();
    }
    return { policy, configured: true, message_key: 'chat.tools.settings_models.llm_config_failover_get.success' };
  }
  private executeFailoverSet(argumentsValue: unknown, ctx: ToolExecutionContext): unknown {
    const args = argumentsObject(argumentsValue, LLM_CONFIG_FAILOVER_SET_FIELDS);
    if (!('policy' in args)) fail(invalidArgument('policy', 'field is required'));
    const policy = args['policy'];
    if (!isJsonObject(policy)) fail(invalidArgument('policy', 'expected a JSON object'));
    let decoded;
    try { decoded = projectFailoverPolicy(decodeFailoverPolicyExact(JSON.stringify(policy))); }
    catch (error) { fail(invalidArgument('policy', `invalid failover policy: ${errorMessage(error)}`)); }
    const database = requireDatabase(ctx), previous = readSettingRaw(database, FAILOVER_POLICY_KEY);
    const serialized = JSON.stringify(decoded), changed = previous !== serialized;
    if (changed) writeSettingRaw(database, FAILOVER_POLICY_KEY, serialized);
    const eventEmitted = emitAppEvent(ctx, SETTINGS_CHANGED_EVENT, { action: 'set', key: FAILOVER_POLICY_KEY });
    return { policy: decoded, changed, event: SETTINGS_CHANGED_EVENT, event_emitted: eventEmitted,
      message_key: 'chat.tools.settings_models.llm_config_failover_set.success' };
  }
  private executeBudgetGet(argumentsValue: unknown, ctx: ToolExecutionContext): unknown {
    argumentsObject(argumentsValue, LLM_CONFIG_BUDGET_GET_FIELDS);
    const database = requireDatabase(ctx), raw = readSettingRaw(database, INJECTION_BUDGET_KEY);
    if (raw === null || raw.trim() === '') {
      return { config: null, configured: false, message_key: 'chat.tools.settings_models.llm_config_budget_get.success' };
    }
    let config: unknown;
    try { config = JSON.parse(raw); }
    catch (error) {
      fail(toolError('SETTING_VALUE_INVALID', `Stored injection budget config is not valid JSON: ${errorMessage(error)}`,
        'Repair the budget configuration in Settings and retry.', false));
    }
    return { config, configured: true, message_key: 'chat.tools.settings_models.llm_config_budget_get.success' };
  }
  private executeBudgetSet(argumentsValue: unknown, ctx: ToolExecutionContext): unknown {
    const args = argumentsObject(argumentsValue, LLM_CONFIG_BUDGET_SET_FIELDS);
    if (!('config' in args)) fail(invalidArgument('config', 'field is required'));
    const config = validateBudgetConfig(args['config']);
    const database = requireDatabase(ctx), previous = readSettingRaw(database, INJECTION_BUDGET_KEY);
    const serialized = JSON.stringify(config), changed = previous !== serialized;
    if (changed) writeSettingRaw(database, INJECTION_BUDGET_KEY, serialized);
    const eventEmitted = emitAppEvent(ctx, SETTINGS_CHANGED_EVENT, { action: 'set', key: INJECTION_BUDGET_KEY });
    return { config, changed, event: SETTINGS_CHANGED_EVENT, event_emitted: eventEmitted,
      message_key: 'chat.tools.settings_models.llm_config_budget_set.success' };
  }
  private executeSettingsDomainsList(argumentsValue: unknown, ctx: ToolExecutionContext): unknown {
    const args = argumentsObject(argumentsValue, SETTINGS_DOMAINS_LIST_FIELDS);
    const database = requireDatabase(ctx);
    const requested = optionalString(args, 'domain', 64);
    if (requested !== null) {
      const domain = requireDomain(requested);
      return { domains: { [domain]: readDomain(database, domain) }, message_key: 'chat.tools.settings_models.settings_domains_list.success' };
    }
    const domains: Record<string, unknown> = {};
    for (const domain of SETTINGS_DOMAIN_NAMES) domains[domain] = readDomain(database, domain);
    return { domains, message_key: 'chat.tools.settings_models.settings_domains_list.success' };
  }
  private executeSettingsApply(argumentsValue: unknown, ctx: ToolExecutionContext): unknown {
    const args = argumentsObject(argumentsValue, SETTINGS_APPLY_FIELDS);
    const domain = requireDomain(requiredString(args, 'domain', 64));
    if (!('values' in args)) fail(invalidArgument('values', 'field is required'));
    const values = args['values'];
    if (!isJsonObject(values)) fail(invalidArgument('values', 'expected a JSON object'));
    const database = requireDatabase(ctx), changed: string[] = [];
    const applier = DOMAIN_APPLIERS[domain]!;
    applier(database, values, changed);
    const eventEmitted = emitAppEvent(ctx, SETTINGS_CHANGED_EVENT, { action: 'settings_apply', domain, changed });
    return {
      domain,
      applied: Object.keys(values),
      changed,
      changed_count: changed.length,
      settings: readDomain(database, domain),
      event: SETTINGS_CHANGED_EVENT,
      event_emitted: eventEmitted,
      runtime_sync: eventEmitted ? 'event_emitted' : 'persisted_refresh_pending',
      message_key: 'chat.tools.settings_models.settings_apply.success',
    };
  }
}
export function createSettingsModelsToolExecutor(): SettingsModelsToolExecutor { return new SettingsModelsToolExecutor(); }
