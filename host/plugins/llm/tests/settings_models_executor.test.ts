import { describe, expect, it } from 'vitest';
import type { SettingRow, SettingsStore } from '../../../platform/settings/api.ts';
import type { CryptoService } from '../../../platform/secrets/api.ts';
import type {
  ApiConfig, ModelAssignments, ModelProfile, VendorConfig,
} from '../api.ts';
import { EMPTY_MODEL_ASSIGNMENTS, LlmConfigStore, defaultVendorConfig, modelProfileFromDe } from '../src/config_store.ts';
import {
  ASSIGNMENT_SLOTS, MAX_MODEL_CONFIG_ID_CHARS, MAX_TOOL_STRING_CHARS, MAX_USIZE,
  MODEL_ASSIGNMENTS_SET_FIELDS, MODEL_PROFILE_ADD_FIELDS, SETTINGS_GET_FIELDS,
  SettingsModelsToolExecutor, argumentsObject, argumentsObjectAllowingCredentials,
  assignmentSlotCurrent, boundJsonStrings, boundedString, containsSensitiveIdentifier,
  isSafeSettingKey, optionalPositiveInteger, parseAssignmentSlot, profileCapabilityFlags,
  redactCredentialArguments, requiredNullableString, safeModelJson, updateModelAssignmentAtomic,
  urlsSameOrigin, validateBaseUrl, validateModelForSlot, validateProviderType,
  validateSettingValue,
  type ModelCapabilities, type SettingsModelsDatabase, type SettingsModelsLlmManager,
  type ToolCall, type ToolExecutionContext, type ToolResultInfo, type VoiceInputCapabilities,
} from '../src/settings_models_executor.ts';
import { makeConfig } from './support.ts';

// ------------------------------------------------------------------ 内存依赖

/** 真实内存 settings 表（`SettingsStore` 的同步子集就是执行器的依赖面）。 */
class MemorySettings implements SettingsStore {
  readonly plain = new Map<string, string>();
  readonly secrets = new Map<string, string>();

  save(key: string, value: string): void {
    this.plain.set(key, value);
  }
  get(key: string): string | null {
    return this.plain.get(key) ?? null;
  }
  delete(key: string): boolean {
    return this.plain.delete(key);
  }
  listByPrefix(prefix: string): SettingRow[] {
    return [...this.plain.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value, updatedAt: '2026-11-03T00:00:00+00:00' }));
  }
  deleteByPrefix(prefix: string): number {
    let removed = 0;
    for (const key of [...this.plain.keys()]) {
      if (key.startsWith(prefix)) {
        this.plain.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
  async saveSecret(key: string, value: string): Promise<void> {
    this.secrets.set(key, value);
  }
  async getSecret(key: string): Promise<string | null> {
    return this.secrets.get(key) ?? null;
  }
  async deleteSecret(key: string): Promise<boolean> {
    return this.secrets.delete(key);
  }
}

/** 确定性 LLM 管理器替身（仅测试使用），记录最后一次保存的目录。 */
class MemoryLlmManager implements SettingsModelsLlmManager {
  assignments: ModelAssignments = { ...EMPTY_MODEL_ASSIGNMENTS };
  vendors: VendorConfig[] = [];
  profiles: ModelProfile[] = [];
  configs: ApiConfig[] = [];
  savedVendors: VendorConfig[] | null = null;
  savedProfiles: ModelProfile[] | null = null;

  async getApiConfigs(): Promise<ApiConfig[]> {
    return this.configs;
  }
  async getVendorConfigs(): Promise<VendorConfig[]> {
    return this.vendors;
  }
  async getModelProfiles(): Promise<ModelProfile[]> {
    return this.profiles;
  }
  async getModelAssignments(): Promise<ModelAssignments> {
    return this.assignments;
  }
  async saveVendorModelConfigs(
    vendors: readonly VendorConfig[],
    profiles: readonly ModelProfile[],
  ): Promise<void> {
    this.savedVendors = [...vendors];
    this.savedProfiles = [...profiles];
    this.vendors = [...vendors];
    this.profiles = [...profiles];
  }
}

/** dstu-media `voice_input` 的确定性契约替身（拒绝表与 Rust 一致）。 */
const voiceInputCapabilities: VoiceInputCapabilities = {
  isAsrModel(model: string, displayName: string): boolean {
    const name = `${model} ${displayName}`.toLowerCase();
    return name.includes('asr') || name.includes('whisper');
  },
  asrProviderSupported(providerId: string | null, apiProtocol: string | null): boolean {
    const provider = providerId === null ? null : providerId.trim().toLowerCase();
    if (provider === 'anthropic' || provider === 'gemini' || provider === 'google'
      || provider === 'openai_codex') {
      return false;
    }
    return apiProtocol !== 'anthropic_messages' && apiProtocol !== 'google_generate_content';
  },
};

interface RecordedEffects {
  starts: { name: string; args: unknown; callId: string | null }[];
  ends: unknown[];
  errors: string[];
  blocks: ToolResultInfo[];
  events: { event: string; payload: unknown }[];
  warnings: string[];
}

function makeContext(options: {
  database?: SettingsModelsDatabase | null;
  llm?: SettingsModelsLlmManager | null;
  eventSinkThrows?: boolean;
} = {}): { ctx: ToolExecutionContext; effects: RecordedEffects } {
  const effects: RecordedEffects = {
    starts: [], ends: [], errors: [], blocks: [], events: [], warnings: [],
  };
  const ctx: ToolExecutionContext = {
    blockId: 'block-1',
    database: options.database ?? null,
    llm: options.llm ?? null,
    voiceInput: voiceInputCapabilities,
    appEvents: {
      emit(event: string, payload: unknown): void {
        if (options.eventSinkThrows === true) throw new Error('event bridge offline');
        effects.events.push({ event, payload });
      },
    },
    emitToolCallStart(name, args, callId): void {
      effects.starts.push({ name, args, callId });
    },
    emitToolCallEnd(payload): void {
      effects.ends.push(payload);
    },
    emitToolCallError(error): void {
      effects.errors.push(error);
    },
    saveToolBlock(result): void {
      effects.blocks.push(result);
    },
    warn(message): void {
      effects.warnings.push(message);
    },
  };
  return { ctx, effects };
}

function payloadOf(result: ToolResultInfo): Record<string, unknown> {
  return result.output as Record<string, unknown>;
}

function errorPayload(result: ToolResultInfo): Record<string, unknown> {
  return JSON.parse(result.error ?? '{}') as Record<string, unknown>;
}

function textCapabilities(): ModelCapabilities {
  return {
    enabled: true,
    multimodal: false,
    embedding: false,
    reranker: false,
    imageGeneration: false,
    audioTranscription: false,
    providerId: 'openai',
    apiProtocol: 'openai_responses',
  };
}

const encryptedFormat = (value: string): boolean => {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return typeof parsed['ciphertext'] === 'string' && typeof parsed['nonce'] === 'string';
  } catch {
    return false;
  }
};

/** 测试用内存 CryptoService（与 config_store.test.ts 相同的明文往返）。 */
const memoryCrypto = {
  keyPath: '/tmp/.master_key',
  keyFingerprint: '00000000',
  encryptApiKey(plaintext: string) {
    return {
      ciphertext: Buffer.from(plaintext, 'utf8').toString('base64'),
      nonce: '',
      version: 2,
    };
  },
  decryptApiKey(data: { ciphertext: string }) {
    return Buffer.from(data.ciphertext, 'base64').toString('utf8');
  },
  migratePlaintextKey(plaintext: string) {
    return JSON.stringify(memoryCrypto.encryptApiKey(plaintext));
  },
  verifyKeyIntegrity() {
    return true;
  },
  async rotateMasterKey() {
    return memoryCrypto as unknown as CryptoService;
  },
} as unknown as CryptoService;

describe('src/chat_v2/tools/settings_models_executor.rs', () => {
  it('exposes_exact_tool_surface_with_expected_risk', () => {
    const executor = new SettingsModelsToolExecutor();
    for (const tool of ['settings_get', 'model_assignments_get']) {
      expect(executor.canHandle(tool)).toBe(true);
      expect(executor.canHandle(`builtin-${tool}`)).toBe(true);
      expect(executor.sensitivityLevel(tool)).toBe('low');
      expect(executor.concurrencyClass(tool)).toBe('read_only');
    }
    for (const tool of ['settings_set', 'model_assignments_set']) {
      expect(executor.canHandle(tool)).toBe(true);
      expect(executor.sensitivityLevel(tool)).toBe('medium');
      expect(executor.concurrencyClass(tool)).toBe('serial');
    }
    // 新增模型配置：High（必经审批且永不记住）+ Serial
    expect(executor.canHandle('model_profile_add')).toBe(true);
    expect(executor.canHandle('builtin-model_profile_add')).toBe(true);
    expect(executor.sensitivityLevel('model_profile_add')).toBe('high');
    expect(executor.concurrencyClass('model_profile_add')).toBe('serial');
    expect(executor.canHandle('builtin-api_key_set')).toBe(false);
  });

  it('profile_add_arguments_redact_api_key_before_crossing_boundaries', () => {
    const argumentsValue = {
      model: 'deepseek-chat',
      vendor_name: 'DeepSeek',
      base_url: 'https://api.deepseek.com/v1',
      api_key: 'sk-super-secret',
    };
    const redacted = redactCredentialArguments(argumentsValue) as Record<string, unknown>;
    const serialized = JSON.stringify(redacted);
    expect(serialized.includes('sk-super-secret')).toBe(false);
    expect(redacted['api_key']).toBe('<redacted>');
    expect(redacted['model']).toBe('deepseek-chat');
    expect(redacted['base_url']).toBe('https://api.deepseek.com/v1');

    // 无 key / 空 key 不产生占位符
    const noKey = redactCredentialArguments({ model: 'm', vendor_id: 'v' }) as Record<string, unknown>;
    expect('api_key' in noKey).toBe(false);
    const emptyKey = redactCredentialArguments({ model: 'm', api_key: '' }) as Record<string, unknown>;
    expect(emptyKey['api_key']).toBe('');
  });

  it('profile_add_fields_allow_api_key_but_nothing_else_sensitive', () => {
    const valid = {
      model: 'gpt-4o',
      api_key: 'sk-xxx',
      supports_tools: true,
    };
    expect(() => argumentsObjectAllowingCredentials(valid, MODEL_PROFILE_ADD_FIELDS)).not.toThrow();

    const sneaky = {
      model: 'gpt-4o',
      authorization: 'Bearer x',
    };
    expect(() => argumentsObjectAllowingCredentials(sneaky, MODEL_PROFILE_ADD_FIELDS))
      .toThrow(/INVALID_ARGUMENT/);

    // 通用路径依旧硬拒 api_key 字段
    expect(() => argumentsObject(valid, SETTINGS_GET_FIELDS)).toThrow(/SENSITIVE_FIELD_REJECTED/);
  });

  it('profile_add_validation_rules', () => {
    expect(() => validateBaseUrl('https://api.openai.com/v1')).not.toThrow();
    expect(() => validateBaseUrl('http://127.0.0.1:11434/v1')).not.toThrow();
    expect(() => validateBaseUrl('ftp://example.com')).toThrow(/INVALID_ARGUMENT/);
    expect(() => validateBaseUrl('not-a-url')).toThrow(/INVALID_ARGUMENT/);

    expect(() => validateProviderType('openai')).not.toThrow();
    expect(() => validateProviderType('azure-openai')).not.toThrow();
    expect(() => validateProviderType('bad provider')).toThrow(/INVALID_ARGUMENT/);

    expect(urlsSameOrigin('https://api.a.com/v1', 'https://api.a.com/other')).toBe(true);
    expect(urlsSameOrigin('https://api.a.com/v1', 'https://api.b.com/v1')).toBe(false);
    expect(urlsSameOrigin('https://a.com:8443/v1', 'https://a.com/v1')).toBe(false);

    const flags = profileCapabilityFlags({ is_multimodal: true, supports_tools: true });
    expect(flags.multimodal).toBe(true);
    expect(flags.supportsTools).toBe(true);
    expect(flags.embedding).toBe(false);

    expect(() => profileCapabilityFlags({ is_embedding: true, is_reranker: true }))
      .toThrow(/INVALID_ARGUMENT/);
    expect(() => profileCapabilityFlags({ is_reranker: true, supports_tools: true }))
      .toThrow(/INVALID_ARGUMENT/);

    expect(profileCapabilityFlags({ context_window: 128_000 }).contextWindow).toBe(128_000);
    expect(() => profileCapabilityFlags({ context_window: 0 })).toThrow(/INVALID_ARGUMENT/);
  });

  it('sensitive_names_are_separator_and_case_insensitive', () => {
    for (const protectedName of [
      'web_search.API-Key',
      'ApiKey',
      'auth_token',
      'client.secret',
      'oauth.session',
      'password',
      'service_credential',
      'private_key',
      'ACCESS_KEY',
      'Authorization',
      'cookie_store',
      'tool-approval.override',
      'cloud_storage.password',
      'mcp.tools',
      'permission',
    ]) {
      expect(containsSensitiveIdentifier(protectedName), protectedName).toBe(true);
    }
    expect(containsSensitiveIdentifier('thinking.auto_collapse')).toBe(false);
    expect(containsSensitiveIdentifier('enableNotifications')).toBe(false);
  });

  it('request_fields_and_database_rows_both_fail_closed', () => {
    const protectedArgument = {
      prefix: 'theme',
      api_key: 'must never be accepted',
    };
    expect(() => argumentsObject(protectedArgument, SETTINGS_GET_FIELDS))
      .toThrow(/SENSITIVE_FIELD_REJECTED/);

    expect(isSafeSettingKey('theme')).toBe(true);
    expect(isSafeSettingKey('ui.pointer_cursor')).toBe(true);
    expect(isSafeSettingKey('ui.private_token')).toBe(false);
    expect(isSafeSettingKey('mcp.tools.list')).toBe(false);
  });

  it('settings_values_use_exact_types_and_ranges', () => {
    expect(validateSettingValue('theme', 'dark')).toBe('dark');
    expect(validateSettingValue('enableNotifications', true)).toBe('true');
    expect(validateSettingValue('maxChatHistory', 20)).toBe('20');
    expect(() => validateSettingValue('theme', 'sepia')).toThrow(/INVALID_ARGUMENT/);
    expect(() => validateSettingValue('enableNotifications', 'true')).toThrow(/INVALID_ARGUMENT/);
    expect(() => validateSettingValue('maxChatHistory', 9)).toThrow(/INVALID_ARGUMENT/);
    expect(() => validateSettingValue('textbook.max_pages', 51)).toThrow(/INVALID_ARGUMENT/);
    expect(() => validateSettingValue('api_key', 'secret')).toThrow(/SETTING_WRITE_NOT_ALLOWED/);
  });

  it('assignment_args_require_explicit_nullable_occ_value', () => {
    const missingExpected = {
      slot: 'model2_config_id',
      config_id: 'model-a',
    };
    const object = argumentsObject(missingExpected, MODEL_ASSIGNMENTS_SET_FIELDS);
    expect(() => requiredNullableString(object, 'expected_current_config_id'))
      .toThrow(/INVALID_ARGUMENT/);

    const clear = {
      slot: 'model2_config_id',
      config_id: null,
      expected_current_config_id: 'model-a',
    };
    const clearObject = argumentsObject(clear, MODEL_ASSIGNMENTS_SET_FIELDS);
    expect(requiredNullableString(clearObject, 'config_id')).toBeNull();
    expect(parseAssignmentSlot(clearObject['slot'] as string)).toBe('model2_config_id');
    expect(() => parseAssignmentSlot('embedding_model_config_id'))
      .toThrow(/MODEL_ASSIGNMENT_SLOT_NOT_ALLOWED/);
    expect(() => parseAssignmentSlot('translation_display_mode'))
      .toThrow(/MODEL_ASSIGNMENT_SLOT_NOT_ALLOWED/);

    const oversized = { config_id: 'm'.repeat(MAX_MODEL_CONFIG_ID_CHARS + 1) };
    expect(() => requiredNullableString(oversized, 'config_id')).toThrow(/INVALID_ARGUMENT/);
  });

  it('model_directory_pagination_is_bounded', () => {
    expect(optionalPositiveInteger({}, 'page', 1, MAX_USIZE)).toBe(1);
    expect(optionalPositiveInteger({}, 'page_size', 20, 20)).toBe(20);

    const valid = { page: 3, page_size: 7 };
    expect(optionalPositiveInteger(valid, 'page', 1, MAX_USIZE)).toBe(3);
    expect(optionalPositiveInteger(valid, 'page_size', 20, 20)).toBe(7);

    for (const invalid of [0, 21, '20']) {
      expect(() => optionalPositiveInteger({ page_size: invalid }, 'page_size', 20, 20))
        .toThrow(/INVALID_ARGUMENT/);
    }
    // Rust `usize::MAX` 上限在错误文案里保持不变
    expect(() => optionalPositiveInteger({ page: 0 }, 'page', 1, MAX_USIZE))
      .toThrow(/18446744073709551615/);
  });

  it('model_capability_matrix_matches_runtime_consumers', () => {
    const text = textCapabilities();
    expect(() => validateModelForSlot('model2_config_id', text, voiceInputCapabilities))
      .not.toThrow();
    expect(() => validateModelForSlot('translation_model_config_id', text, voiceInputCapabilities))
      .not.toThrow();
    expect(() => validateModelForSlot('reranker_model_config_id', text, voiceInputCapabilities))
      .toThrow(/MODEL_CAPABILITY_MISMATCH/);
    expect(() => validateModelForSlot('exam_sheet_ocr_model_config_id', text, voiceInputCapabilities))
      .toThrow(/MODEL_CAPABILITY_MISMATCH/);

    const reranker = { ...text, reranker: true };
    expect(() => validateModelForSlot('reranker_model_config_id', reranker, voiceInputCapabilities))
      .not.toThrow();
    expect(() => validateModelForSlot('model2_config_id', reranker, voiceInputCapabilities))
      .toThrow(/MODEL_CAPABILITY_MISMATCH/);

    const ocr = { ...text, multimodal: true };
    expect(() => validateModelForSlot('exam_sheet_ocr_model_config_id', ocr, voiceInputCapabilities))
      .not.toThrow();

    const image = { ...text, imageGeneration: true };
    expect(() => validateModelForSlot('image_generation_model_config_id', image, voiceInputCapabilities))
      .not.toThrow();

    expect(() => validateModelForSlot('voice_input_asr_model_config_id', text, voiceInputCapabilities))
      .toThrow(/MODEL_CAPABILITY_MISMATCH/);
    const asr = { ...text, audioTranscription: true };
    expect(() => validateModelForSlot('voice_input_asr_model_config_id', asr, voiceInputCapabilities))
      .not.toThrow();
    const asrCustom = {
      ...asr,
      providerId: 'custom',
      apiProtocol: 'openai_chat_completions',
    };
    expect(() => validateModelForSlot('voice_input_asr_model_config_id', asrCustom, voiceInputCapabilities))
      .not.toThrow();
    const asrAnthropic = {
      ...asr,
      providerId: 'anthropic',
      apiProtocol: 'anthropic_messages',
    };
    expect(() => validateModelForSlot('voice_input_asr_model_config_id', asrAnthropic, voiceInputCapabilities))
      .toThrow(/MODEL_CAPABILITY_MISMATCH/);

    const disabled = { ...text, enabled: false };
    expect(() => validateModelForSlot('model2_config_id', disabled, voiceInputCapabilities))
      .toThrow(/MODEL_DISABLED/);
  });

  it('model_directory_projection_never_contains_runtime_secrets', () => {
    const config = makeConfig({
      id: 'model-id',
      name: 'Safe display name',
      vendorName: 'Provider',
      model: 'raw-model-should-not-be-returned',
      apiKey: 'super-secret-api-key',
      baseUrl: 'https://private.example.test/v1',
      headers: { Authorization: 'Bearer hidden' },
      enabled: true,
    });
    const serialized = JSON.stringify(safeModelJson(config, voiceInputCapabilities));
    expect(serialized).toContain('model-id');
    expect(serialized).toContain('Safe display name');
    for (const secret of [
      'super-secret-api-key',
      'private.example.test',
      'Bearer hidden',
      'raw-model-should-not-be-returned',
      'api_key',
      'base_url',
      'headers',
    ]) {
      expect(serialized, `leaked: ${secret}`).not.toContain(secret);
    }
  });

  it('assignment_update_is_atomic_and_occ_guarded', () => {
    const database = new MemorySettings();

    const first = updateModelAssignmentAtomic(database, 'model2_config_id', 'model-a', null);
    expect(first.kind).toBe('updated');
    if (first.kind !== 'updated') throw new Error('unexpected conflict');
    expect(first.previousConfigId).toBeNull();
    expect(first.assignments.model2_config_id).toBe('model-a');
    expect(first.changed).toBe(true);

    const stale = updateModelAssignmentAtomic(database, 'model2_config_id', 'model-b', null);
    expect(stale.kind).toBe('conflict');
    if (stale.kind !== 'conflict') throw new Error('stale update must conflict');
    expect(stale.currentConfigId).toBe('model-a');

    const persisted = JSON.parse(database.get('model_assignments') ?? '{}') as Record<string, unknown>;
    expect(persisted['model2_config_id']).toBe('model-a');

    const cleared = updateModelAssignmentAtomic(database, 'model2_config_id', null, 'model-a');
    expect(cleared.kind).toBe('updated');
    if (cleared.kind !== 'updated') throw new Error('clear should succeed');
    expect(cleared.assignments.model2_config_id).toBeNull();

    // 损坏的持久化内容必须失败关闭，而不是静默重置整张分配表。
    database.save('model_assignments', 'not-json');
    expect(() => updateModelAssignmentAtomic(database, 'model2_config_id', null, null))
      .toThrow(/MODEL_ASSIGNMENTS_INVALID/);
  });

  it('all_tool_strings_are_unicode_bounded', () => {
    const input = '设'.repeat(MAX_TOOL_STRING_CHARS + 1);
    const bounded = boundedString(input);
    expect(bounded.truncated).toBe(true);
    expect([...bounded.value].length).toBe(MAX_TOOL_STRING_CHARS);

    const nested = { outer: { value: input } };
    const boundedNested = boundJsonStrings(nested);
    expect(boundedNested.truncated).toBe(true);
    const outer = (boundedNested.value as { outer: { value: string } }).outer;
    expect([...outer.value].length).toBe(MAX_TOOL_STRING_CHARS);
  });

  // ---------------------------------------------------------------- 执行路径

  it('settings_get returns only rows that pass both allow-list layers', async () => {
    const executor = new SettingsModelsToolExecutor();
    const database = new MemorySettings();
    database.save('ui.pointer_cursor', 'true');
    database.save('ui.private_token', 'leak');
    database.save('mcp.tools.list', 'x');
    database.save('theme', 'dark');
    const long = 'a'.repeat(MAX_TOOL_STRING_CHARS + 5);
    database.save('macos.native_font_smoothing', long);

    const { ctx } = makeContext({ database });
    const result = await executor.execute(
      { id: 'call-1', name: 'settings_get', arguments: { prefix: 'ui.' } },
      ctx,
    );
    expect(result.success).toBe(true);
    const payload = payloadOf(result);
    expect(payload['prefix']).toBe('ui.');
    expect(payload['count']).toBe(1);
    expect(payload['message_key']).toBe('chat.tools.settings_models.settings_get.success');
    const rows = payload['settings'] as { key: string; value: string; truncated: boolean; updated_at: string }[];
    expect(rows.map((row) => row.key)).toEqual(['ui.pointer_cursor']);
    expect(rows[0]?.updated_at).toBe('2026-11-03T00:00:00+00:00');

    const macos = await executor.execute(
      { id: 'call-2', name: 'settings_get', arguments: { prefix: 'macos.' } },
      ctx,
    );
    const macosRow = (payloadOf(macos)['settings'] as { value: string; truncated: boolean }[])[0];
    expect(macosRow?.truncated).toBe(true);
    expect(macosRow?.value).toHaveLength(MAX_TOOL_STRING_CHARS);

    const forbidden = await executor.execute(
      { id: 'call-3', name: 'settings_get', arguments: { prefix: 'vendor_configs' } },
      ctx,
    );
    expect(forbidden.success).toBe(false);
    expect(errorPayload(forbidden)['code']).toBe('SETTING_PREFIX_NOT_ALLOWED');

    const noDatabase = makeContext();
    const unavailable = await executor.execute(
      { id: 'call-4', name: 'settings_get', arguments: { prefix: 'theme' } },
      noDatabase.ctx,
    );
    expect(errorPayload(unavailable)['code']).toBe('DEPENDENCY_UNAVAILABLE');
  });

  it('settings_set persists validated values and reports runtime sync state', async () => {
    const executor = new SettingsModelsToolExecutor();
    const database = new MemorySettings();
    const { ctx, effects } = makeContext({ database });

    const first = await executor.execute(
      { id: 'call-1', name: 'settings_set', arguments: { key: 'theme', value: 'dark' } },
      ctx,
    );
    expect(first.success).toBe(true);
    expect(database.get('theme')).toBe('dark');
    const payload = payloadOf(first);
    expect(payload['previous_value']).toBeNull();
    expect(payload['changed']).toBe(true);
    expect(payload['event_emitted']).toBe(true);
    expect(payload['runtime_sync']).toBe('event_emitted');
    expect(payload['message_key']).toBe('chat.tools.settings_models.settings_set.success');
    expect(effects.events).toEqual([
      { event: 'chat_v2://settings_changed', payload: { action: 'set', key: 'theme' } },
    ]);
    expect(effects.ends).toHaveLength(1);

    const second = await executor.execute(
      { id: 'call-2', name: 'settings_set', arguments: { key: 'theme', value: 'dark' } },
      ctx,
    );
    expect(payloadOf(second)['changed']).toBe(false);
    expect(payloadOf(second)['previous_value']).toBe('dark');

    const restricted = await executor.execute(
      { id: 'call-3', name: 'settings_set', arguments: { key: 'mcp.tools.list', value: 'x' } },
      ctx,
    );
    expect(restricted.success).toBe(false);
    expect(restricted.error).toContain('SENSITIVE_SETTING_REJECTED');

    const invalid = await executor.execute(
      { id: 'call-4', name: 'settings_set', arguments: { key: 'theme', value: 'sepia' } },
      ctx,
    );
    expect(errorPayload(invalid)['code']).toBe('INVALID_ARGUMENT');

    const offline = makeContext({ database, eventSinkThrows: true });
    const pending = await executor.execute(
      { id: 'call-5', name: 'settings_set', arguments: { key: 'language', value: 'en-US' } },
      offline.ctx,
    );
    expect(payloadOf(pending)['event_emitted']).toBe(false);
    expect(payloadOf(pending)['runtime_sync']).toBe('persisted_refresh_pending');
    expect(payloadOf(pending)['message_key'])
      .toBe('chat.tools.settings_models.settings_set.saved_refresh_pending');
  });

  it('model_assignments_get paginates the directory and returns the full assignment payload', async () => {
    const executor = new SettingsModelsToolExecutor();
    const manager = new MemoryLlmManager();
    manager.assignments = { ...EMPTY_MODEL_ASSIGNMENTS, model2_config_id: 'model-1' };
    manager.configs = [
      makeConfig({ id: 'model-1', name: 'One', vendorName: 'Vendor A', enabled: true }),
      makeConfig({ id: 'model-2', name: 'Two', vendorName: 'Vendor A', enabled: false }),
      makeConfig({ id: 'model-3', name: 'Three', vendorName: 'Vendor B', enabled: true, isMultimodal: true }),
    ];
    const { ctx } = makeContext({ llm: manager });

    const result = await executor.execute(
      { id: 'call-1', name: 'model_assignments_get', arguments: { page: 2, page_size: 2 } },
      ctx,
    );
    expect(result.success).toBe(true);
    const payload = payloadOf(result);
    const assignments = payload['assignments'] as Record<string, unknown>;
    expect(assignments['model2_config_id']).toBe('model-1');
    expect(assignments['translation_display_mode']).toBeNull();
    expect(payload['assignments_truncated']).toBe(false);
    const models = payload['available_models'] as { id: string; provider: string; model_type: string }[];
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe('model-3');
    expect(models[0]?.provider).toBe('Vendor B');
    expect(models[0]?.model_type).toBe('multimodal_text');
    expect(payload['pagination']).toEqual({
      page: 2, page_size: 2, total: 3, has_more: false,
    });

    const firstPage = await executor.execute(
      { id: 'call-2', name: 'model_assignments_get', arguments: { page: 1, page_size: 2 } },
      ctx,
    );
    expect(payloadOf(firstPage)['pagination']).toEqual({
      page: 1, page_size: 2, total: 3, has_more: true,
    });

    const beyond = await executor.execute(
      { id: 'call-3', name: 'model_assignments_get', arguments: { page: 9, page_size: 2 } },
      ctx,
    );
    expect(payloadOf(beyond)['available_models']).toEqual([]);
  });

  it('model_assignments_set assigns, rejects stale writes, and clears slots', async () => {
    const executor = new SettingsModelsToolExecutor();
    const database = new MemorySettings();
    const manager = new MemoryLlmManager();
    manager.configs = [
      makeConfig({ id: 'model-a', name: 'Text', enabled: true }),
      makeConfig({ id: 'model-b', name: 'Other Text', enabled: true }),
      makeConfig({ id: 'reranker-a', name: 'Ranker', enabled: true, isReranker: true }),
    ];
    const { ctx, effects } = makeContext({ database, llm: manager });

    const assigned = await executor.execute({
      id: 'call-1',
      name: 'model_assignments_set',
      arguments: {
        slot: 'model2_config_id',
        config_id: 'model-a',
        expected_current_config_id: null,
      },
    }, ctx);
    expect(assigned.success).toBe(true);
    const payload = payloadOf(assigned);
    expect(payload['slot']).toBe('model2_config_id');
    expect(payload['previous_config_id']).toBeNull();
    expect(payload['config_id']).toBe('model-a');
    expect(payload['changed']).toBe(true);
    expect(payload['event_emitted']).toBe(true);
    const stored = JSON.parse(database.get('model_assignments') ?? '{}') as Record<string, unknown>;
    expect(stored['model2_config_id']).toBe('model-a');
    expect(effects.events[0]).toEqual({
      event: 'chat_v2://model_assignments_changed',
      payload: { action: 'set', slot: 'model2_config_id' },
    });

    const stale = await executor.execute({
      id: 'call-2',
      name: 'model_assignments_set',
      arguments: {
        slot: 'model2_config_id',
        config_id: 'model-b',
        expected_current_config_id: null,
      },
    }, ctx);
    expect(stale.success).toBe(false);
    const conflict = errorPayload(stale);
    expect(conflict['code']).toBe('MODEL_ASSIGNMENT_CONFLICT');
    expect(conflict['current_config_id']).toBe('model-a');
    expect(conflict['current_config_id_truncated']).toBe(false);
    expect(conflict['expected_current_config_id']).toBeNull();

    const missing = await executor.execute({
      id: 'call-3',
      name: 'model_assignments_set',
      arguments: {
        slot: 'model2_config_id',
        config_id: 'does-not-exist',
        expected_current_config_id: 'model-a',
      },
    }, ctx);
    expect(errorPayload(missing)['code']).toBe('MODEL_NOT_FOUND');

    const mismatch = await executor.execute({
      id: 'call-4',
      name: 'model_assignments_set',
      arguments: {
        slot: 'reranker_model_config_id',
        config_id: 'model-a',
        expected_current_config_id: null,
      },
    }, ctx);
    expect(errorPayload(mismatch)['code']).toBe('MODEL_CAPABILITY_MISMATCH');

    const cleared = await executor.execute({
      id: 'call-5',
      name: 'model_assignments_set',
      arguments: {
        slot: 'model2_config_id',
        config_id: null,
        expected_current_config_id: 'model-a',
      },
    }, ctx);
    expect(cleared.success).toBe(true);
    expect(payloadOf(cleared)['previous_config_id']).toBe('model-a');
    const clearedStored = JSON.parse(database.get('model_assignments') ?? '{}') as Record<string, unknown>;
    expect(clearedStored['model2_config_id']).toBeNull();

    // 槽位选择器与 Rust 的 13 个可写槽位一致（embedding/compaction/display 不可写）
    expect(ASSIGNMENT_SLOTS).not.toContain('embedding_model_config_id');
    expect(ASSIGNMENT_SLOTS).not.toContain('compaction_model_config_id');
    expect(ASSIGNMENT_SLOTS).not.toContain('translation_display_mode');
  });

  it('model_profile_add creates a vendor and profile without leaking the api key', async () => {
    const executor = new SettingsModelsToolExecutor();
    const manager = new MemoryLlmManager();
    const { ctx, effects } = makeContext({ database: new MemorySettings(), llm: manager });

    const call: ToolCall = {
      id: 'call-1',
      name: 'model_profile_add',
      arguments: {
        model: 'deepseek-chat',
        label: 'DeepSeek Chat',
        vendor_name: 'DeepSeek',
        base_url: 'https://api.deepseek.com/v1',
        api_key: 'sk-super-secret',
        context_window: 64_000,
        supports_tools: true,
      },
    };
    const result = await executor.execute(call, ctx);
    expect(result.success).toBe(true);
    const payload = payloadOf(result);
    expect(payload['vendor_reused']).toBe(false);
    expect(payload['api_key_applied']).toBe(true);
    expect(payload['label']).toBe('DeepSeek Chat');
    expect(payload['model']).toBe('deepseek-chat');
    expect(payload['enabled']).toBe(true);
    expect(payload['event_emitted']).toBe(true);
    expect(payload['message_key']).toBe('chat.tools.settings_models.model_profile_add.success');
    expect((payload['capabilities'] as Record<string, unknown>)['supports_tools']).toBe(true);

    expect(manager.savedVendors).toHaveLength(1);
    const vendor = manager.savedVendors?.[0];
    expect(vendor?.id.startsWith('agent-')).toBe(true);
    expect(vendor?.providerType).toBe('openai');
    expect(vendor?.apiProtocol).toBeNull();
    expect(vendor?.supportsOpenaiResponses).toBeNull();
    expect(vendor?.apiKey).toBe('sk-super-secret');
    expect(manager.savedProfiles).toHaveLength(1);
    const profile = manager.savedProfiles?.[0];
    expect(profile?.vendorId).toBe(vendor?.id);
    expect(profile?.contextWindow).toBe(64_000);
    expect(profile?.maxOutputTokens).toBe(8192);
    expect(profile?.supportsTools).toBe(true);

    // 执行期使用真实 key；跨事件/持久化边界的副本已脱敏。
    expect((result.input as Record<string, unknown>)['api_key']).toBe('<redacted>');
    expect((effects.starts[0]?.args as Record<string, unknown>)['api_key']).toBe('<redacted>');
    expect(JSON.stringify(result)).not.toContain('sk-super-secret');
    expect(effects.events[0]).toEqual({
      event: 'chat_v2://model_profiles_changed',
      payload: {
        action: 'add',
        vendor_id: payload['vendor_id'],
        profile_id: payload['profile_id'],
      },
    });
  });

  it('model_profile_add reuses same-origin vendors and rejects duplicate profiles', async () => {
    const executor = new SettingsModelsToolExecutor();
    const manager = new MemoryLlmManager();
    const { ctx } = makeContext({ database: new MemorySettings(), llm: manager });

    const first = await executor.execute({
      id: 'call-1',
      name: 'model_profile_add',
      arguments: {
        model: 'deepseek-chat',
        vendor_name: 'DeepSeek',
        base_url: 'https://api.deepseek.com/v1',
        api_key: 'sk-a',
      },
    }, ctx);
    expect(first.success).toBe(true);
    const firstPayload = payloadOf(first);

    const duplicate = await executor.execute({
      id: 'call-2',
      name: 'model_profile_add',
      arguments: {
        model: 'DEEPSEEK-CHAT',
        vendor_id: firstPayload['vendor_id'],
      },
    }, ctx);
    expect(duplicate.success).toBe(false);
    const duplicateError = errorPayload(duplicate);
    expect(duplicateError['code']).toBe('MODEL_PROFILE_EXISTS');
    expect(duplicateError['existing_profile_id']).toBe(firstPayload['profile_id']);

    // 同源 + 同类型供应商复用，不重复创建
    const reused = await executor.execute({
      id: 'call-3',
      name: 'model_profile_add',
      arguments: {
        model: 'deepseek-reasoner',
        vendor_name: 'DeepSeek Mirror',
        base_url: 'https://api.deepseek.com/other',
        api_key: 'sk-b',
      },
    }, ctx);
    expect(reused.success).toBe(true);
    expect(payloadOf(reused)['vendor_reused']).toBe(true);
    expect(payloadOf(reused)['vendor_id']).toBe(firstPayload['vendor_id']);
    expect(manager.savedVendors).toHaveLength(1);
    expect(manager.savedVendors?.[0]?.apiKey).toBe('sk-b');
    expect(manager.savedProfiles).toHaveLength(2);

    const placeholder = await executor.execute({
      id: 'call-4',
      name: 'model_profile_add',
      arguments: {
        model: 'deepseek-coder',
        vendor_id: firstPayload['vendor_id'],
        api_key: '***',
      },
    }, ctx);
    expect(errorPayload(placeholder)['code']).toBe('API_KEY_PLACEHOLDER_REJECTED');

    const unknownVendor = await executor.execute({
      id: 'call-5',
      name: 'model_profile_add',
      arguments: { model: 'm', vendor_id: 'nope' },
    }, ctx);
    expect(errorPayload(unknownVendor)['code']).toBe('MODEL_VENDOR_NOT_FOUND');

    const missingVendorName = await executor.execute({
      id: 'call-6',
      name: 'model_profile_add',
      arguments: { model: 'm', base_url: 'https://api.example.test/v1' },
    }, ctx);
    expect(errorPayload(missingVendorName)['code']).toBe('INVALID_ARGUMENT');

    const badBaseUrl = await executor.execute({
      id: 'call-7',
      name: 'model_profile_add',
      arguments: { model: 'm', vendor_name: 'X', base_url: 'not-a-url' },
    }, ctx);
    expect(errorPayload(badBaseUrl)['code']).toBe('INVALID_ARGUMENT');
  });

  it('model_assignments_set accepts a real LlmConfigStore as the model manager', async () => {
    const executor = new SettingsModelsToolExecutor();
    const settings = new MemorySettings();
    const vendor: VendorConfig = {
      ...defaultVendorConfig(),
      id: 'vendor-real',
      name: 'Real Vendor',
      providerType: 'openai',
      apiProtocol: null,
      supportsOpenaiResponses: null,
      baseUrl: 'https://api.real.test/v1',
      apiKey: 'sk-real',
      isBuiltin: false,
    };
    const profile = modelProfileFromDe({
      id: 'profile-real',
      vendorId: 'vendor-real',
      label: 'Real Model',
      model: 'real-model',
      enabled: true,
      supportsTools: true,
    });
    settings.save('vendor_configs', JSON.stringify([vendor]));
    settings.save('model_profiles', JSON.stringify([profile]));
    settings.save('builtin_caps_migration_v2', 'done');
    const store = new LlmConfigStore({
      settings,
      isEncryptedFormat: encryptedFormat,
      openCrypto: async () => memoryCrypto,
    });

    const { ctx, effects } = makeContext({ database: settings, llm: store });
    const result = await executor.execute({
      id: 'call-1',
      name: 'model_assignments_set',
      arguments: {
        slot: 'model2_config_id',
        config_id: 'profile-real',
        expected_current_config_id: null,
      },
    }, ctx);
    expect(result.success).toBe(true);
    expect(payloadOf(result)['config_id']).toBe('profile-real');
    expect(effects.errors).toEqual([]);
    const persisted = JSON.parse(settings.get('model_assignments') ?? '{}') as Record<string, unknown>;
    expect(persisted['model2_config_id']).toBe('profile-real');
    // 真实 store 的读回值仍是完整 ModelAssignments
    expect(await store.getModelAssignments()).toMatchObject({ model2_config_id: 'profile-real' });
  });
});
