/** Cross-lane MCP contracts; wire names follow dstu-mcp's serde definitions. */
export type {
  McpConfig, McpConfig__De, McpFraming, McpTransportConfig, OAuthConfig,
  McpOAuthStatus, StartOAuthOutcome, ProviderStrategies, ProviderStrategy, ToolConflict,
} from '../../../contracts/ipc/generated/L19-mcp-browser.ts';
import type { McpConfig, ToolConflict } from '../../../contracts/ipc/generated/L19-mcp-browser.ts';
import type { WindowRef } from '../../kernel/api.ts';
import type { ToolConfig } from './src/web-search.ts';
import type { SettingsStore } from '../../platform/settings/api.ts';
import type { ErrorDetails } from '../../platform/errors/api.ts';
export type { ErrorDetails } from '../../platform/errors/api.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface ResourceContent { uri: string; mimeType: string | null; text: string | null; blob: string | null }
export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: ResourceContent };
export interface McpTool { name: string; description: string | null; inputSchema: JsonValue }
export interface McpToolResult { content: Content[]; isError: boolean | null }
export interface McpClient {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, arguments_: JsonValue | null): Promise<McpToolResult>;
  isConnected(): boolean;
  disconnect(): Promise<void>;
}
export interface RagSourceInfo {
  documentId: string; fileName: string; chunkText: string; score: number; chunkIndex: number;
  sourceType?: string; subject?: string; stage?: string;
}
export interface SearchInput {
  query: string; top_k: number; engine: string | null; site: string | null;
  time_range: string | null; start: number | null; force_engine: string | null;
}
export interface SearchResult {
  name: string; ok: boolean; args?: SearchInput; result?: JsonValue; error?: JsonValue;
  error_details?: { code: 'CONFIG_MISSING' | 'HTTP_CLIENT_ERROR' | 'HTTP_SERVER_ERROR' | 'TIMEOUT'
    | 'RATE_LIMIT' | 'UNREACHABLE' | 'PARSE_ERROR' | 'UNKNOWN'; message: string; suggestion: string; trace_id?: string };
  citations?: RagSourceInfo[]; usage?: JsonValue; inject_text?: string;
}
export interface ToolContext {
  supports_tools: boolean;
  mcp_client: McpClient | null;
  stream_event: string | null;
  stage: string | null;
  memory_enabled: boolean | null;
  /** Calling window for the frontend MCP bridge; absent for headless runs. */
  window?: WindowRef | null;
  /** Cancellation signal propagated from the executing tool turn. */
  signal?: AbortSignal | null;
}
export type ToolInvocation = [boolean, JsonValue | null, string | null, JsonValue | null, RagSourceInfo[] | null, string | null];
/** Rust `call_tool_with_details`: the six tool fields followed by structured error details. */
export type ToolInvocationWithDetails = [...ToolInvocation, ErrorDetails | null];
export interface Tool {
  name(): string;
  schema(): JsonValue;
  invoke(args: JsonValue, context: ToolContext): Promise<ToolInvocation>;
}
export interface ToolRegistry {
  detectToolConflicts(): Promise<ToolConflict[]>;
  stripMcpNamespace(name: string): string;
  callTool(name: string, args: JsonValue, context: ToolContext): Promise<ToolInvocation>;
}
/** The real registry published by the mcp/browser providers. */
export interface DetailedToolRegistry extends ToolRegistry {
  /** Uses Rust's detailed-call routing, error precedence and usage metadata. */
  callToolWithDetails(name: string, args: JsonValue, context: ToolContext): Promise<ToolInvocationWithDetails>;
}
export const mcpService = { name: 'mcp', version: '1.0.0' } as const;
export const webSearchService = { name: 'webSearch', version: '1.0.0' } as const;

export interface McpService {
  getGlobalClient(): Promise<McpClient | null>;
  initializeGlobalClient(config: McpConfig): Promise<void>;
  registry: DetailedToolRegistry;
}
export interface WebSearchService {
  doSearch(input: SearchInput, signal?: AbortSignal): Promise<SearchResult>;
}
/**
 * L13 `RetrievalWebSearchPort` (`builtin_retrieval_executor.rs:666-741`).
 *
 * The caller loads configuration before it emits the `web_search` start event,
 * then passes the run's cancellation signal into the same HTTP requests.
 */
export interface CancellableWebSearchPort {
  /** `WebSearchConfig::from_env_and_file` + DB overrides; `null` keeps env/file only. */
  loadConfig(settings: SettingsStore | null): Promise<ToolConfig>;
  /** `do_search(&config, input)` with the caller's signal aborting in-flight transport. */
  doSearch(config: ToolConfig, input: SearchInput, signal: AbortSignal): Promise<SearchResult>;
}
export {
  CN_TRUSTED_SITES, buildInjectText, defaultProviderStrategies, defaultToolConfig, doSearch, getStrategy,
  hasValidKeys, hostAsFileName, isUrlWhitelisted, loadToolConfig, normalizeProviderStrategies, normalizeScore,
  normalizeUrl, parseProviderStrategies, serializeProviderStrategies, toolConfigFromEnv,
} from './src/web-search.ts';
export type {
  CnWhitelistConfig, ProviderResponse, SearchItem, ToolConfig,
} from './src/web-search.ts';
/**
 * `ToolRegistry::new_with([WebSearchTool])` (cmd/web_search.rs test_search_engine, mod.rs:670-697 fallback).
 * Pass `options.db` for Rust's `ToolContext.db = Some(..)`: engine gate, session routing and aggregation.
 */
export { createWebSearchToolRegistry } from './src/service.ts';
export type { WebSearchRegistryOptions, WebSearchToolDb, WebSearchToolLog } from './src/service.ts';
/** `crate::mcp::test_helpers` connection probes (mcp_propose_executor.rs live tests). */
export { testStdio, testSse, testHttp, testWebSocket, testStreamableHttpRmcp } from './src/probe.ts';
/** serde_json::from_str / from_slice::<Value> input rules (shared with the browser bridge). */
export { parseSerdeJson, parseSerdeJsonBytes, type SerdeJsonResult } from './src/serde-json.ts';
declare module '@deepseek-ai/cordis' {
  interface Context { mcp: McpService; webSearch: WebSearchService & CancellableWebSearchPort }
}
