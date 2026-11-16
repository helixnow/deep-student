/**
 * Portable entry point for the `mcp` lane (zero Node built-ins or Node globals).
 * Used by mobile plugins and pure runtime consumers that must not pull `node:child_process` / `node:crypto`.
 */
export type {
  CancellableWebSearchPort,
  Content,
  DetailedToolRegistry,
  ErrorDetails,
  JsonValue,
  McpClient,
  McpService,
  McpTool,
  McpToolResult,
  RagSourceInfo,
  ResourceContent,
  SearchInput,
  SearchResult,
  Tool,
  ToolContext,
  ToolInvocation,
  ToolInvocationWithDetails,
  ToolRegistry,
  WebSearchService,
} from './api.ts';
export const mcpService = { name: 'mcp', version: '1.0.0' } as const;
export const webSearchService = { name: 'webSearch', version: '1.0.0' } as const;
export type { McpTransportConfig } from '../../../contracts/ipc/generated/L19-mcp-browser.ts';
export type { ProviderStrategies } from './src/web-search-core.ts';
export {
  CN_TRUSTED_SITES,
  buildInjectText,
  defaultProviderStrategies,
  defaultToolConfig,
  doSearch,
  getStrategy,
  hasValidKeys,
  hostAsFileName,
  isUrlWhitelisted,
  loadToolConfig,
  normalizeProviderStrategies,
  normalizeScore,
  normalizeUrl,
  parseProviderStrategies,
  serializeProviderStrategies,
  toolConfigFromEnv,
} from './src/web-search.ts';
export type {
  CnWhitelistConfig,
  ProviderResponse,
  SearchItem,
  ToolConfig,
} from './src/web-search.ts';
export {
  HostMcpService,
  createWebSearchToolRegistry,
  type McpServiceOptions,
  type WebSearchRegistryOptions,
  type WebSearchToolDb,
  type WebSearchToolLog,
} from './src/service-core.ts';
export {
  CONNECT_RETRY_DELAY_MS,
  JsonRpcProbe,
  createRemoteTransportForConfig,
  createSseProbeTransport,
  formatProbeOutcome,
  httpProbeConfig,
  probeTransport,
  sseProbeConfig,
  testHttp,
  testSse,
  testStreamableHttpRmcp,
  testWebSocket,
  type HttpProbeConfig,
  type JsonRpcProbeOptions,
  type McpRemoteNetwork,
  type ProbeOutcome,
  type ProbePrompt,
  type ProbeResource,
  type ProbeServer,
  type ProbeTool,
  type ProgressCallback,
  type SseProbeConfig,
  type Transport,
} from './src/probe-core.ts';
export { parseSerdeJson, parseSerdeJsonBytes, type SerdeJsonResult } from './src/serde-json.ts';
export { parseCnCustomSites } from './src/web-search-config.ts';
