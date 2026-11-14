/**
 * Agent self-configuration for the web-search layer.
 *
 * `dstu_config_search_get` / `dstu_config_search_set` / `dstu_config_search_key_set` /
 * `dstu_config_search_test` let the agent inspect and change the global web-search
 * engine, CN whitelist, provider strategies and per-provider credentials after the
 * user approves the call. Secrets are written through `settings.saveSecret` and are
 * never echoed back: `api_key` is redacted in tool-call events and persisted blocks.
 *
 * The class is registered through `BrowserToolExecutor` so the browser lane keeps a
 * single executor name while the search configuration surface stays a separate unit.
 */
import type {
  AgentToolCall, AgentToolResultInfo, ExecutionContext,
} from '../../../kernel/agent-api.ts';
import type { ToolConcurrency, ToolSensitivity } from '../../../kernel/agent-api.ts';
import { strip_tool_namespace } from '../../../platform/errors/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import {
  defaultProviderStrategies, normalizeProviderStrategies, parseProviderStrategies,
  serializeProviderStrategies, type ProviderStrategies,
} from '../../mcp/api.ts';

export const SEARCH_CONFIG_GET_TOOL = 'dstu_config_search_get';
export const SEARCH_CONFIG_SET_TOOL = 'dstu_config_search_set';
export const SEARCH_CONFIG_KEY_SET_TOOL = 'dstu_config_search_key_set';
export const SEARCH_CONFIG_TEST_TOOL = 'dstu_config_search_test';

export const SEARCH_CONFIG_TOOLS: readonly string[] = [
  SEARCH_CONFIG_GET_TOOL, SEARCH_CONFIG_SET_TOOL, SEARCH_CONFIG_KEY_SET_TOOL, SEARCH_CONFIG_TEST_TOOL,
];

/** Engines with a persisted per-provider credential (bing_rss needs none). */
export const KEYED_SEARCH_ENGINES = [
  'tavily', 'serpapi', 'brave', 'zhipu', 'bocha', 'deepseek', 'google_cse', 'searxng',
] as const;
export const SELECTABLE_SEARCH_ENGINES = [
  'bing_rss', ...KEYED_SEARCH_ENGINES,
] as const;
export type KeyedSearchEngine = (typeof KEYED_SEARCH_ENGINES)[number];

export const SEARCH_ENGINE_KEY = 'web_search.engine';
export const CN_WHITELIST_ENABLED_KEY = 'web_search.cn_whitelist.enabled';
export const CN_WHITELIST_DOMAINS_KEY = 'web_search.cn_whitelist.custom_sites';
export const PROVIDER_STRATEGIES_KEY = 'web_search.provider_strategies';
export const SETTINGS_CHANGED_EVENT = 'chat_v2://settings_changed';
export const MAX_DOMAINS = 200;
export const MAX_DOMAIN_CHARS = 253;
export const MAX_SEARCH_KEY_CHARS = 1_000;

export interface SearchEngineTestResult {
  ok: boolean;
  message: string;
  response_time: number;
  test_query: string;
  error_details?: string;
}

export interface SearchConfigToolPorts {
  readonly settings: SettingsStore;
  /** App-wide `chat_v2://settings_changed` broadcast. */
  emit(event: string, payload: unknown): void;
  /** `test_search_engine` implementation (network probe of one provider). */
  testEngine(engine: string): Promise<SearchEngineTestResult>;
  log?(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

interface AgentEmitterHooks {
  emitToolCallStart?(name: string, args: unknown, callId: string | null): void;
  emitToolCallEnd?(result: unknown | null): void;
  emitToolCallError?(error: string): void;
  saveToolBlock?(result: AgentToolResultInfo): void;
  isCancelled?(): boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function searchToolError(code: string, message: string, hint: string, retryable: boolean): string {
  return JSON.stringify({ code, message, hint, retryable });
}

function invalidArgument(field: string, reason: string): string {
  return searchToolError('INVALID_ARGUMENT', `Invalid '${field}': ${reason}`, 'Correct the tool arguments and retry.', false);
}

function argumentsObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!isObject(value)) throw new Error(invalidArgument('arguments', 'expected a JSON object'));
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) throw new Error(invalidArgument(field, 'unknown field; additional properties are not allowed'));
  }
  return value;
}

function optionalString(args: Record<string, unknown>, field: string, maxChars: number): string | null {
  if (!(field in args) || args[field] === null) return null;
  const raw = args[field];
  if (typeof raw !== 'string') throw new Error(invalidArgument(field, 'expected a string'));
  const value = raw.trim();
  if (value === '') return null;
  if ([...value].length > maxChars) throw new Error(invalidArgument(field, `must contain at most ${maxChars} characters`));
  return value;
}

function requiredString(args: Record<string, unknown>, field: string, maxChars: number): string {
  const value = optionalString(args, field, maxChars);
  if (value === null) throw new Error(invalidArgument(field, 'field is required'));
  return value;
}

function optionalBool(args: Record<string, unknown>, field: string): boolean | null {
  if (!(field in args) || args[field] === null) return null;
  if (typeof args[field] !== 'boolean') throw new Error(invalidArgument(field, 'expected a boolean'));
  return args[field] as boolean;
}

function isCredentialPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === '<redacted>' || (trimmed !== '' && [...trimmed].every(character => character === '*'));
}

export function redactSearchConfigArguments(value: unknown): unknown {
  if (!isObject(value)) return value;
  const redacted = { ...value };
  if (typeof redacted['api_key'] === 'string' && redacted['api_key'] !== '') redacted['api_key'] = '<redacted>';
  return redacted;
}

export function searchConfigSensitivity(toolName: string): ToolSensitivity {
  return strip_tool_namespace(toolName) === SEARCH_CONFIG_GET_TOOL
    || strip_tool_namespace(toolName) === SEARCH_CONFIG_TEST_TOOL ? 'low' : 'high';
}

export function searchConfigConcurrency(toolName: string): ToolConcurrency {
  const name = strip_tool_namespace(toolName);
  return name === SEARCH_CONFIG_GET_TOOL || name === SEARCH_CONFIG_TEST_TOOL ? 'read_only' : 'serial';
}

export class SearchConfigToolExecutor {
  private readonly ports: SearchConfigToolPorts;

  constructor(ports: SearchConfigToolPorts) { this.ports = ports; }

  canHandle(toolName: string): boolean { return SEARCH_CONFIG_TOOLS.includes(strip_tool_namespace(toolName)); }
  sensitivityLevel(toolName: string): ToolSensitivity { return searchConfigSensitivity(toolName); }
  concurrencyClass(toolName: string): ToolConcurrency { return searchConfigConcurrency(toolName); }
  name(): string { return 'SearchConfigToolExecutor'; }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.ports.log?.(level, message);
  }

  private readSetting(key: string): string | null {
    try { return this.ports.settings.get(key); }
    catch (error) {
      this.log('warn', `[SearchConfigToolExecutor] failed to read ${key}: ${errorText(error)}`);
      return null;
    }
  }

  private async readSecretOrSetting(key: string): Promise<string | null> {
    try {
      const secret = await this.ports.settings.getSecret(key);
      if (secret !== null && secret !== '') return secret;
    } catch (error) {
      this.log('warn', `[SearchConfigToolExecutor] failed to read secret ${key}: ${errorText(error)}`);
    }
    return this.readSetting(key);
  }

  private saveSetting(key: string, value: string): void {
    try { this.ports.settings.save(key, value); }
    catch (error) {
      throw new Error(searchToolError('SETTINGS_WRITE_FAILED', `Failed to save '${key}': ${errorText(error)}`,
        'Retry after checking local storage availability.', true));
    }
  }

  private async saveSecret(key: string, value: string): Promise<void> {
    try { await this.ports.settings.saveSecret(key, value); }
    catch (error) {
      throw new Error(searchToolError('SETTINGS_WRITE_FAILED', `Failed to save '${key}': ${errorText(error)}`,
        'Retry after checking local storage availability.', true));
    }
  }

  private parseBooleanSetting(key: string, fallback: boolean): boolean {
    const raw = this.readSetting(key);
    if (raw === null) return fallback;
    const value = raw.trim().toLowerCase();
    if (value === '') return fallback;
    return value === 'true' || value === '1' || value === 'yes' || value === 'on';
  }

  private domains(): string[] {
    const raw = this.readSetting(CN_WHITELIST_DOMAINS_KEY);
    if (raw === null || raw.trim() === '') return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) return parsed;
    } catch { // boundary-allow empty-catch: Legacy CSV form is accepted by the web-search loader; normalise the same way.
    }
    return raw.split(',').map(item => item.trim()).filter(item => item !== '');
  }

  private strategies(): ProviderStrategies | null {
    const raw = this.readSetting(PROVIDER_STRATEGIES_KEY);
    if (raw === null || raw.trim() === '') return null;
    return parseProviderStrategies(raw);
  }

  async execute(call: AgentToolCall, ctx: ExecutionContext): Promise<AgentToolResultInfo> {
    const started = Date.now();
    const toolName = strip_tool_namespace(call.name);
    const safeArguments = toolName === SEARCH_CONFIG_KEY_SET_TOOL
      ? redactSearchConfigArguments(call.arguments) : call.arguments;
    const hooks = ctx as unknown as AgentEmitterHooks;
    const blockId = ctx.ids.blockId === undefined ? undefined : ctx.ids.blockId;
    try { hooks.emitToolCallStart?.(call.name, safeArguments, call.id); }
    catch (error) { this.log('warn', `[SearchConfigToolExecutor] start emit failed: ${errorText(error)}`); }
    const base: AgentToolResultInfo = {
      toolCallId: call.id,
      ...(blockId === undefined ? {} : { blockId }),
      toolName: call.name,
      input: safeArguments,
      output: null,
      success: false,
    };
    let output: unknown;
    try {
      if (hooks.isCancelled?.() === true) {
        throw new Error(searchToolError('CANCELLED', 'The run was cancelled before the tool started.',
          'Do not retry automatically.', false));
      }
      output = await this.dispatch(toolName, call.arguments);
    } catch (error) {
      const failure = errorText(error);
      try { hooks.emitToolCallError?.(failure); }
      catch (emitError) { this.log('warn', `[SearchConfigToolExecutor] error emit failed: ${errorText(emitError)}`); }
      const result: AgentToolResultInfo = { ...base, error: failure, durationMs: Date.now() - started };
      this.persist(hooks, result);
      return result;
    }
    const durationMs = Date.now() - started;
    try { hooks.emitToolCallEnd?.({ result: output, durationMs }); }
    catch (error) { this.log('warn', `[SearchConfigToolExecutor] end emit failed: ${errorText(error)}`); }
    const result: AgentToolResultInfo = { ...base, output, success: true, durationMs };
    this.persist(hooks, result);
    return result;
  }

  private persist(hooks: AgentEmitterHooks, result: AgentToolResultInfo): void {
    try { hooks.saveToolBlock?.(result); }
    catch (error) { this.log('warn', `[SearchConfigToolExecutor] block persistence failed: ${errorText(error)}`); }
  }

  private async dispatch(toolName: string, argumentsValue: unknown): Promise<unknown> {
    switch (toolName) {
      case SEARCH_CONFIG_GET_TOOL: return await this.executeGet(argumentsValue);
      case SEARCH_CONFIG_SET_TOOL: return this.executeSet(argumentsValue);
      case SEARCH_CONFIG_KEY_SET_TOOL: return await this.executeKeySet(argumentsValue);
      case SEARCH_CONFIG_TEST_TOOL: return await this.executeTest(argumentsValue);
      default:
        throw new Error(searchToolError('UNKNOWN_TOOL', `Unknown search configuration tool '${toolName}'.`,
          'Use one of the dstu_config_search_* tools.', false));
    }
  }

  private async engineStatus(engine: KeyedSearchEngine): Promise<{
    engine: string; configured: boolean; key_present: boolean; detail: string | null;
  }> {
    const secretKey = engine === 'searxng' ? 'web_search.searxng.api_key' : `web_search.api_key.${engine}`;
    const key = await this.readSecretOrSetting(secretKey);
    if (engine === 'google_cse') {
      const cx = await this.readSecretOrSetting('web_search.google_cse.cx');
      return { engine, configured: Boolean(key && cx), key_present: Boolean(key),
        detail: key ? (cx ? null : 'missing cx') : 'missing api_key' };
    }
    if (engine === 'searxng') {
      const endpoint = await this.readSecretOrSetting('web_search.searxng.endpoint');
      return { engine, configured: Boolean(endpoint), key_present: Boolean(key),
        detail: endpoint ? null : 'missing endpoint' };
    }
    return { engine, configured: Boolean(key), key_present: Boolean(key), detail: key ? null : 'missing api_key' };
  }

  private async executeGet(argumentsValue: unknown): Promise<unknown> {
    argumentsObject(argumentsValue, []);
    const engines = [];
    for (const engine of KEYED_SEARCH_ENGINES) engines.push(await this.engineStatus(engine));
    return {
      engine: this.readSetting(SEARCH_ENGINE_KEY),
      cn_whitelist: {
        enabled: this.parseBooleanSetting(CN_WHITELIST_ENABLED_KEY, false),
        use_default: this.parseBooleanSetting('web_search.cn_whitelist.use_default', true),
        domains: this.domains(),
      },
      provider_strategies: this.strategies(),
      engines,
      configured_engines: engines.filter(entry => entry.configured).map(entry => entry.engine),
    };
  }

  private validateEngine(value: string, keyedOnly: boolean): string {
    const allowed: readonly string[] = keyedOnly ? KEYED_SEARCH_ENGINES : SELECTABLE_SEARCH_ENGINES;
    if (!allowed.includes(value)) {
      throw new Error(invalidArgument('engine', `unsupported engine '${value}'; expected one of ${allowed.join(', ')}`));
    }
    return value;
  }

  private executeSet(argumentsValue: unknown): unknown {
    const args = argumentsObject(argumentsValue, [
      'engine', 'cn_whitelist_enabled', 'cn_whitelist_domains', 'cn_whitelist_use_default', 'provider_strategies',
    ]);
    if (Object.keys(args).length === 0) {
      throw new Error(invalidArgument('arguments', 'provide at least one of engine, cn_whitelist_enabled, '
        + 'cn_whitelist_domains, cn_whitelist_use_default or provider_strategies'));
    }
    const changed: string[] = [];
    const engine = optionalString(args, 'engine', 40);
    if (engine !== null) {
      this.validateEngine(engine, false);
      this.saveSetting(SEARCH_ENGINE_KEY, engine);
      changed.push(SEARCH_ENGINE_KEY);
    }
    const enabled = optionalBool(args, 'cn_whitelist_enabled');
    if (enabled !== null) {
      this.saveSetting(CN_WHITELIST_ENABLED_KEY, String(enabled));
      changed.push(CN_WHITELIST_ENABLED_KEY);
    }
    const useDefault = optionalBool(args, 'cn_whitelist_use_default');
    if (useDefault !== null) {
      this.saveSetting('web_search.cn_whitelist.use_default', String(useDefault));
      changed.push('web_search.cn_whitelist.use_default');
    }
    if ('cn_whitelist_domains' in args) {
      const raw = args['cn_whitelist_domains'];
      if (!Array.isArray(raw) || !raw.every(item => typeof item === 'string')) {
        throw new Error(invalidArgument('cn_whitelist_domains', 'expected an array of strings'));
      }
      if (raw.length > MAX_DOMAINS) throw new Error(invalidArgument('cn_whitelist_domains', `at most ${MAX_DOMAINS} domains`));
      const domains = raw.map(item => (item as string).trim()).filter(item => item !== '');
      for (const domain of domains) {
        if ([...domain].length > MAX_DOMAIN_CHARS || /[\s/]/.test(domain)) {
          throw new Error(invalidArgument('cn_whitelist_domains', `invalid domain '${domain}'`));
        }
      }
      this.saveSetting(CN_WHITELIST_DOMAINS_KEY, JSON.stringify(domains));
      changed.push(CN_WHITELIST_DOMAINS_KEY);
    }
    if ('provider_strategies' in args) {
      const normalized = normalizeProviderStrategies(args['provider_strategies']);
      if (normalized === null) {
        throw new Error(invalidArgument('provider_strategies', 'expected a valid ProviderStrategies object'));
      }
      this.saveSetting(PROVIDER_STRATEGIES_KEY, serializeProviderStrategies(normalized));
      changed.push(PROVIDER_STRATEGIES_KEY);
    }
    const eventEmitted = this.emitChanged({ action: 'search_config_set', keys: changed });
    return {
      changed,
      changed_count: changed.length,
      event: SETTINGS_CHANGED_EVENT,
      event_emitted: eventEmitted,
      current: {
        engine: this.readSetting(SEARCH_ENGINE_KEY),
        cn_whitelist_enabled: this.parseBooleanSetting(CN_WHITELIST_ENABLED_KEY, false),
        cn_whitelist_domains: this.domains(),
        provider_strategies: this.strategies() ?? defaultProviderStrategies(),
      },
    };
  }

  private async executeKeySet(argumentsValue: unknown): Promise<unknown> {
    const args = argumentsObject(argumentsValue, ['engine', 'api_key', 'cx', 'endpoint']);
    const engine = this.validateEngine(requiredString(args, 'engine', 40), true);
    const apiKey = requiredString(args, 'api_key', MAX_SEARCH_KEY_CHARS);
    if (isCredentialPlaceholder(apiKey)) {
      throw new Error(searchToolError('API_KEY_PLACEHOLDER_REJECTED',
        'The api_key value is a redaction placeholder, not a real key.',
        'The key shown in chat history is redacted. Ask the user to paste the real key again.', false));
    }
    const secretKey = engine === 'searxng' ? 'web_search.searxng.api_key' : `web_search.api_key.${engine}`;
    await this.saveSecret(secretKey, apiKey);
    const saved: string[] = [secretKey];
    if (engine === 'google_cse') {
      const cx = requiredString(args, 'cx', 200);
      await this.saveSecret('web_search.google_cse.cx', cx);
      saved.push('web_search.google_cse.cx');
    } else if (engine === 'searxng') {
      const endpoint = optionalString(args, 'endpoint', 500);
      if (endpoint !== null) {
        await this.saveSecret('web_search.searxng.endpoint', endpoint);
        saved.push('web_search.searxng.endpoint');
      }
    }
    const eventEmitted = this.emitChanged({ action: 'search_config_key_set', engine });
    return {
      engine,
      saved_keys: saved.map(key => (key === 'web_search.google_cse.cx' ? 'cx'
        : key === 'web_search.searxng.endpoint' ? 'endpoint' : 'api_key')),
      key_present: true,
      event: SETTINGS_CHANGED_EVENT,
      event_emitted: eventEmitted,
    };
  }

  private async executeTest(argumentsValue: unknown): Promise<unknown> {
    const args = argumentsObject(argumentsValue, ['engine']);
    const engine = this.validateEngine(requiredString(args, 'engine', 40), false);
    let result: SearchEngineTestResult;
    try { result = await this.ports.testEngine(engine); }
    catch (error) {
      throw new Error(searchToolError('SEARCH_TEST_FAILED', `Search engine test failed: ${errorText(error)}`,
        'Check the API key, endpoint and network connectivity, then retry.', true));
    }
    return {
      engine,
      success: result.ok,
      message: result.message,
      latency_ms: result.response_time,
      test_query: result.test_query,
      error_details: result.error_details ?? null,
    };
  }

  private emitChanged(payload: Record<string, unknown>): boolean {
    try { this.ports.emit(SETTINGS_CHANGED_EVENT, payload); return true; }
    catch (error) {
      this.log('warn', `[SearchConfigToolExecutor] settings_changed emit failed: ${errorText(error)}`);
      return false;
    }
  }
}
