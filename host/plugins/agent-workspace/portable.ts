/**
 * Node-free subset of `api.ts` for consumers that must also load on mobile (chat / chat-pipeline /
 * agent-orchestration closures). Every export is the same value `api.ts` publishes;
 * tests/portability.test.ts keeps the runtime closure free of Node-specific deps.
 *
 * Runtime roots, custom agent files, persona editing, shell approval binding and the shell/sandbox
 * executors stay desktop-only in `api.ts`; consumers that need a root path or MCP materialization on
 * desktop inject it through their own optional port (see each plugin's local runtime port).
 */
export {
  blocksToContent, escapeXmlAttr, escapeXmlContent, imageBlock, inferMediaTypeFromName, textBlock,
  type ContentBlock,
} from './src/vfs-resolver/model.ts';
export {
  resolveEssay, resolveInsightCard, resolveMindmap, resolveNote, resolveTranslation,
} from './src/vfs-resolver/resources.ts';
export { textbookFileRow } from './repository/vfs-resolver-repository.ts';
export { completionMessageExists, nowCompletionTimestamp } from './src/workspace/completion-outbox.ts';
export {
  MAX_CONCURRENT_WORKERS, MAX_SUBAGENT_DEPTH, SUBAGENT_WAIT_BUDGET_SECS, WORKER_PIPELINE_CANCEL_GRACE_SECS,
  WORKER_PIPELINE_TIMEOUT_SECS,
} from './src/config.ts';
export { newSubagentTask } from './src/workspace/subagent-task.ts';
export { CHATANKI_READONLY_TOOLS } from './src/workspace/tool-registry.ts';
export { WORKSPACE_WORKER_READY_EVENT } from './src/tools/workspace-executor.ts';
export { installWorkspaceCardReadScope, workspaceCardReadScope } from './src/workspace/card-read-scope.ts';
export {
  AgentProfileResolver, DEFAULT_PROFILE_ID, WORKER_PROFILE_ID, EXPLORER_PROFILE_ID, validatePersonaModelConfig,
} from './src/workspace/agent-profile.ts';
export { newSleepBlockData } from './src/workspace/sleep-manager.ts';
export { WorkspaceInjector, InjectionThrottle, MAX_INJECTED_MESSAGE_CHARS } from './src/workspace/injector.ts';

/** Pure path algebra shared with the desktop runtime-root resolver (`runtime-paths.ts`). */
export {
  effectiveRuntimeRootId, explicitRuntimeRootIdFromArgs, normalizeRuntimeRelativePath, safeSessionDir, sha256Hex,
} from './src/runtime-path-values.ts';
export type { AuthorizedRootRisk } from './src/runtime-path-values.ts';

/** Approval-scope values: pure classification / scope keys / shell guard (no filesystem access). */
export {
  ShellCommandGuardEffect, analyzeShellCommand, immutableShellCommandGuard, isLocalShellExecuteTool,
  isPrivilegeEscalationToolForArgs, isShellRuntimeToolForArgs, makeRuntimeApprovalScope, makeRuntimeScopeKey,
  neverRememberApprovalForArgs, ignoresBroadApprovalBypassForArgs, redactToolArgumentsForDisplay,
  runtimeRootBindingFromArgs,
} from './src/approval-scope/portable.ts';
export type {
  JsonObject, RuntimeApprovalScope, ShellCommandAnalysis, ShellCommandGuardDecision,
} from './src/approval-scope/portable.ts';
export { isExternalMcpCall, toolApprovalSource } from './src/tool-approval-policy.ts';
export {
  effectiveSensitivity, runtimeApprovalScope, shellCommandDecision, vfsFileExists,
} from './src/tool-approval-gate-core.ts';
export type { ApprovalGateCall, LocalShellApprovalDeps, LocalShellApprovalResult } from './src/tool-approval-gate-core.ts';

/** Types for consumers that inject desktop-only runtime-root / custom-agent operations as ports. */
export type {
  RuntimeRootDeps, SettingsLike, StagedFile, RuntimeRootAccessValue, RuntimeRootKindValue,
} from './src/runtime-roots.ts';
export type { RuntimeRoot, RuntimeDirectoryPage } from '../../../contracts/ipc/generated/L05-agent-workspace.ts';
export type { CustomAgentFileInfo, FrontmatterSummary } from './src/workspace/custom-agents.ts';
export type {
  PersonaModelConfig, AgentProfile, AgentRuntimeConfig, CustomProfileSource,
} from './src/workspace/agent-profile.ts';
export type { CompletionDelivery, NewCompletionDelivery, CompletionDeliveryState, EnqueueOutcome } from './src/workspace/completion-outbox.ts';
export type { WorkspaceCardReadScope } from './src/workspace/card-read-scope.ts';
export type { InjectionResult, WorkspaceInjectionCoordinator } from './src/workspace/injector.ts';
