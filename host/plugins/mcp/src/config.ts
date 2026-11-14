import type { McpConfig, JsonValue } from '../api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';

export function defaultMcpConfig(): McpConfig {
  return { enabled: false, protocol_version: '2025-06-18',
    transport: { type: 'stdio', command: 'mcp-server', args: [], framing: 'jsonl', env: {} },
    tools: { cache_ttl_ms: 300000, advertise_all_tools: true, whitelist: [], blacklist: [] },
    performance: { timeout_ms: 15000, rate_limit_per_second: 10, cache_max_size: 500, cache_ttl_ms: 300000 },
  };
}
export function shouldAdvertiseTool(config: McpConfig, name: string): boolean {
  return !config.tools.blacklist.includes(name) && (config.tools.advertise_all_tools || config.tools.whitelist.includes(name));
}
export function readSetting(settings: SettingsStore, key: string): string | null {
  try { return settings.get(key); } catch { return null; }
}
/** Rust `str::parse::<u64>()`, with no whitespace trimming or premature Number conversion. */
function parseExactU64(value: string | null): bigint | null {
  if (value === null) return null;
  const digits = value.startsWith('+') ? value.slice(1) : value;
  if (digits === '' || /[^0-9]/u.test(digits)) return null;
  const n = BigInt(value);
  return n <= 18446744073709551615n ? n : null;
}

// Legacy runtime config still uses generated numeric DTOs; its wide-u64 conversion remains a D3 task.
export function parseU64(value: string | null): number | null {
  const n = parseExactU64(value);
  return n === null ? null : Number(n);
}
function object(value: unknown): Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []; }
function stringMap(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value)).filter((pair): pair is [string, string] => typeof pair[1] === 'string'));
}
// Option<Value>::or_else observes presence, not JSON null or the eventual value type.
function firstPresent(value: Record<string, JsonValue>, keys: string[]): JsonValue | undefined {
  for (const key of keys) if (Object.hasOwn(value, key)) return value[key];
  return undefined;
}
function asString(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
export function loadMcpConfig(
  settings: SettingsStore,
  log: (message: string) => void = () => undefined,
): McpConfig {
  const config = defaultMcpConfig();
  const get = (key: string) => readSetting(settings, key);
  const raw = get('mcp.tools.list');
  if (raw !== null) {
    let list: unknown;
    try { list = JSON.parse(raw); } catch { list = null; }
    if (Array.isArray(list) && list.length) {
      const first = object(list[0]);
      const type = first.transportType;
      if (type === 'stdio') {
        const args = typeof first.args === 'string' ? first.args.split(',') : strings(first.args);
        const framing = asString(firstPresent(first, ['framing', 'framingMode']))?.toLowerCase();
        const cwd = asString(firstPresent(first, ['cwd', 'workingDir']));
        config.transport = { type, command: asString(first.command) ?? 'mcp-server', args: args.map(s => s.trim()).filter(Boolean),
          ...(cwd === undefined ? {} : { working_dir: cwd }), framing: framing === 'content_length' || framing === 'content-length' ? 'content_length' : 'jsonl', env: stringMap(first.env) };
      } else if (type === 'websocket') {
        config.transport = { type, url: asString(first.url) ?? 'ws://localhost:8080', env: stringMap(first.env) };
      } else if (type === 'sse' || type === 'streamable_http') {
        let endpoint = firstPresent(first, type === 'sse' ? ['endpoint', 'url'] : ['url', 'endpoint']);
        if (endpoint === undefined) endpoint = object(Object.values(object(first.mcpServers))[0]).url;
        if (endpoint === undefined) endpoint = object(first.fetch).url;
        const headers = stringMap(first.headers);
        const apiKey = asString(first.apiKey);
        const auth = apiKey === undefined ? {} : { api_key: apiKey };
        config.transport = type === 'sse' ? { type, endpoint: asString(endpoint) ?? 'http://localhost:8080/sse', ...auth, headers }
          : { type, url: asString(endpoint) ?? 'http://localhost:8080/mcp', ...auth, headers };
      } else {
        log(`🔧 [MCP] Unknown transport type in tool config: ${String(type ?? '')}, using default`);
      }
    }
  } else {
    const type = get('mcp.transport.type');
    if (type === 'stdio') {
      const args = get('mcp.transport.args') ?? '';
      config.transport = { type, command: get('mcp.transport.command') ?? 'mcp-server', args: args === '' ? [] : args.split(',').map(s => s.trim()),
        framing: get('mcp.transport.framing') === 'content_length' ? 'content_length' : 'jsonl', env: {} };
    } else if (type === 'websocket') config.transport = { type, url: get('mcp.transport.url') ?? 'ws://localhost:8080', env: {} };
    else if (type !== null && type !== undefined) log(`🔧 [MCP] Unknown transport type: ${type}, using default`);
  }
  config.tools.cache_ttl_ms = parseU64(get('mcp.tools.cache_ttl_ms')) ?? config.tools.cache_ttl_ms;
  const advertise = get('mcp.tools.advertise_all_tools');
  if (advertise !== null) config.tools.advertise_all_tools = !['0', 'false'].includes(advertise.toLowerCase());
  for (const key of ['whitelist', 'blacklist'] as const) {
    const raw = get(`mcp.tools.${key}`);
    if (raw !== null && raw !== '') config.tools[key] = raw.split(',').map(s => s.trim());
  }
  for (const key of ['timeout_ms', 'rate_limit_per_second', 'cache_max_size', 'cache_ttl_ms'] as const) {
    config.performance[key] = parseU64(get(`mcp.performance.${key}`)) ?? config.performance[key];
  }
  return config;
}
export function mcpStatus(settings: SettingsStore) {
  const get = (key: string) => readSetting(settings, key);
  const selected = get('session.selected_mcp_tools');
  const enabled = selected !== null && rustTrim(selected) !== '';
  return {
    available: false, enabled, connected: false, enabled_reason: selected !== null && !enabled ? '会话未选择MCP工具' : null,
    server_info: null, tools_count: 0, last_error: 'backend_mcp_disabled',
    namespace_prefix: get('mcp.tools.namespace_prefix') ?? '', conflict_resolution: get('mcp.tools.conflict_resolution') ?? 'use_namespace',
    cache_state: { ttl_ms: parseExactU64(get('mcp.tools.cache_ttl_ms')) ?? 300000n, last_built_at: null },
  };
}
export function saveMcpConfig(settings: SettingsStore, value: JsonValue): void {
  const config = object(value);
  const transport = object(config.transport);
  if (typeof transport.type === 'string') {
    settings.save('mcp.transport.type', transport.type);
    if (transport.type === 'stdio') {
      if (typeof transport.command === 'string') settings.save('mcp.transport.command', transport.command);
      if (Array.isArray(transport.args)) settings.save('mcp.transport.args', strings(transport.args).join(','));
      if (typeof transport.framing === 'string') settings.save('mcp.transport.framing', transport.framing);
    } else if (transport.type === 'websocket' && typeof transport.url === 'string') settings.save('mcp.transport.url', transport.url);
  }
  const tools = object(config.tools);
  const saveU64 = (key: string, value: JsonValue | undefined) => {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 18446744073709551616) settings.save(key, BigInt(value).toString());
  };
  saveU64('mcp.tools.cache_ttl_ms', tools.cache_ttl_ms);
  if (typeof tools.advertise_all_tools === 'boolean') settings.save('mcp.tools.advertise_all_tools', String(tools.advertise_all_tools));
  for (const key of ['whitelist', 'blacklist']) if (Array.isArray(tools[key])) settings.save(`mcp.tools.${key}`, strings(tools[key]).join(','));
  const performance = object(config.performance);
  for (const key of ['timeout_ms', 'rate_limit_per_second', 'cache_max_size', 'cache_ttl_ms']) saveU64(`mcp.performance.${key}`, performance[key]);
}
