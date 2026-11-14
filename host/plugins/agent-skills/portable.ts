/**
 * Node-free subset of `api.ts` for consumers that must also load on mobile (chat / chat-pipeline /
 * agent-orchestration closures). Every export is the same value `api.ts` publishes;
 * tests/portability.test.ts keeps the runtime closure free of Node-specific deps.
 *
 * Skill packages, ZIP, workshop files, connectors and MCP materialization stay desktop-only in `api.ts`;
 * `GeneralToolExecutor` gets the materialization step from `tools/mcp-materialization-port.ts`.
 */
export { SkillsExecutor } from './src/tools/skills-executor.ts';
export { stripToolNamespace } from './src/tools/naming.ts';
export {
  TaskObjectHandleBuilder, buildCorpusManifest, corpusManifestModelNotice, derivedEdge, deserializeDerivedEdge,
  hashTransformParams, managedLocator, validateTaskObjectHandle, withParamsHash,
} from './src/tools/task-objects.ts';
export { InMemoryToolSchemaRegistry, injectToolSchemas, TOOL_SCHEMA_TOKEN_WARNING_THRESHOLD } from './src/tools/injector.ts';
export type { ToolSchemaRegistry } from './src/tools/injector.ts';
export { GeneralToolExecutor } from './src/tools/general-executor.ts';
export type { ToolSensitivity } from './src/tools/general-executor.ts';
export { onTaskFinalized, onTurnCommitted } from './src/skill-usage.ts';
export type { SkillPipelineContext, SkillToolResultInfo } from './src/skill-usage.ts';
export { sessionSideEffectSummary } from './repository/connector-ledger.ts';
export type { SessionSideEffectSummary } from './repository/connector-ledger.ts';
export { resolvedSessionSkillIds } from './src/tools/skills-tool-executor.ts';
export { MCP_SERVER_PROPOSE } from './src/tools/mcp-propose-executor.ts';
export { MCP_SERVER_REMOVE, MCP_SERVER_SET_ENABLED, MCP_SERVER_UPDATE, mcpEntryRevision } from './src/tools/mcp-manage-executor.ts';
export { readMcpToolsList } from './src/tools/mcp-settings-store.ts';
export type { McpMaterializationTarget, McpOutputMaterialization } from './src/tools/mcp-materialization-port.ts';
export type { AgentToolExecutor } from './src/tools/executor-registry.ts';
