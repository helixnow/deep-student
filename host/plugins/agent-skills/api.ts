import type { Context } from '@deepseek-ai/cordis';
import type { Disposer } from '../../kernel/api.ts';
import type { SettingsStore } from '../../platform/settings/api.ts';
import type { ToolSchemaRegistry } from './src/tools/injector.ts';
import type { AgentToolExecutor } from './src/tools/executor-registry.ts';
import type {
  SkillDirectoryEntry, SkillFileContent, SkillImportZipResult, SkillPackageFileEntry, SkillRequiresProbe,
  AcrBridgeRequest, TapCatalog, TapCatalogEntry, TapExportResult,
  SkillMarketDownloadScanResult, SkillMarketSearchResponse, SkillMarketSkillCard, SkillMarketSkillDetail,
  SkillMarketVerifyResult, SkillUpdateApplyResult, SkillUpdateCheckResult,
  CandidateSignalCounts, ReplayReport, SkillCandidatePromotion, SkillCandidateRollback,
  SkillCandidateSummary,
} from '../../../contracts/ipc/generated/L07-agent-skills-ptc.ts';

export type { Context, SkillDirectoryEntry, SkillFileContent, SkillImportZipResult, SkillPackageFileEntry, SkillRequiresProbe };
export type { AcrBridgeRequest, TapCatalog, TapCatalogEntry, TapExportResult };
export type { SkillMarketDownloadScanResult, SkillMarketSearchResponse, SkillMarketSkillCard, SkillMarketSkillDetail, SkillMarketVerifyResult };
export type { SkillUpdateApplyResult, SkillUpdateCheckResult };
export type { CandidateSignalCounts, ReplayReport, SkillCandidatePromotion, SkillCandidateRollback, SkillCandidateSummary };

export interface AcrBridgeResponse {
  correlationId: string;
  bridgeToken: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}
export interface AcrProgress {
  correlationId: string;
  bridgeToken: string;
  step: number;
  total?: number;
  message: string;
  entityId?: string;
}

export {
  ACR_BRIDGE_CANCEL, ACR_BRIDGE_PROGRESS_PREFIX, ACR_BRIDGE_REQUEST, ACR_BRIDGE_RESPONSE_PREFIX,
  CANCEL_DRAIN_MS, PROBE_TIMEOUT_MS, APPLY_OPS_BASE_MS, APPLY_OPS_CLAMP_MS, acrBridgeCall,
  applyOpsTimeoutMs, uncertainApplyReceipt, isValidApplyReceipt, isBridgeCancelled, isBridgeResultUnknown,
} from './src/workbench-bridge.ts';
export type { AcrBridgeCallContext, AcrBridgeLogger, BridgeEventBus } from './src/workbench-bridge.ts';

export {
  CandidateSourceKind, CandidateStatus, correctionTraceHash, detectCorrectionHint,
  onTaskFinalized, onTurnCommitted, outcomeFromFinalizationVerdict, parseLoadSkillsLoaded,
  processTurn, recordSkillActivation, SkillCandidateRepo, SkillOutcome, SkillUsageKind,
  SkillUsageRepo, toolTrace, TRAJECTORY_MIN_DISTINCT_TOOLS, trajectoryTraceHash,
  turnUsageSummaryFromCtx,
} from './src/skill-usage.ts';
export type {
  NewSkillCandidate, NewSkillUsage, SkillCandidateRow, SkillPipelineContext,
  SkillSendOptions, SkillToolResultInfo, SkillUsageRow, ToolCallTrace, TurnUsageSummary,
} from './src/skill-usage.ts';

export {
  DEFAULT_LIST_LIMIT, deriveLearnedSkillId, DRIFT_ANCHOR_RUN_MISSING,
  DRIFT_ANCHOR_USER_MESSAGE_MISSING, DRIFT_ANCHOR_USAGE_MISSING, DRIFT_CORRECTION_MARK_MISSING,
  DRIFT_EVIDENCE_UNPARSEABLE, DRIFT_FAILURE_MARK_MISSING, DRIFT_OUTCOME_INVALIDATED,
  DRIFT_PAYLOAD_UNPARSEABLE, DRIFT_SKILLS_DIVERGED, DRIFT_TRACE_HASH_MISMATCH,
  DRIFT_USAGE_ROWS_MISSING, G09_FRONTMATTER_SOURCE, LEARNED_CORRECTION_PREFIX,
  LEARNED_WORKFLOW_PREFIX, MAX_LIST_LIMIT, learnedSkillsBase, listCandidateSummaries,
  normalizeCandidateId, normalizeListLimit, normalizeListStatus, parseCorrectionInput,
  parseStatusFilter, parseTrajectoryInput, promoteCandidateWithBase, readInstalledLineage,
  reconcileProbes, recomputeTraceHash, replayCandidate, replayTransitions,
  retireLearnedSkill, rollbackCandidateWithBase, sanitizeInline, SKILL_ARCHIVE_SUBDIR,
  SKILL_FILE_NAME, summaryFromRow,
} from './src/skill-replay.ts';
export type { CorrectionReconcileInput, InstalledLineage, TrajectoryReconcileInput } from './src/skill-replay.ts';
export { isPortableSkillPathComponent } from './src/skill-package.ts';

export {
  InMemoryToolSchemaRegistry, injectToolSchemas, TOOL_SCHEMA_TOKEN_WARNING_THRESHOLD,
} from './src/tools/injector.ts';
export type { ToolSchemaRegistry } from './src/tools/injector.ts';
export { AgentToolExecutorRegistry } from './src/tools/executor-registry.ts';
export type {
  AgentSchemaTool, AgentToolConcurrency, AgentToolExecutor, AgentToolSensitivity,
} from './src/tools/executor-registry.ts';
export {
  MCP_ALLOW_UNAPPROVED_KEY, MCP_TOOLS_LIST_KEY, SETTINGS_CHANGED_EVENT,
  emitMcpListChanged, parseAllowUnapprovedValue, readMcpAllowUnapproved, readMcpToolsList,
  restoreListSnapshot, withMcpListMutation, writeMcpAllowUnapproved, writeMcpToolsList,
} from './src/tools/mcp-settings-store.ts';
export { resolvedSessionSkillIds } from './src/tools/skills-tool-executor.ts';
export { GeneralToolExecutor } from './src/tools/general-executor.ts';
export type { ToolSensitivity } from './src/tools/general-executor.ts';
export {
  BUILTIN_LOAD_SKILLS_TOOL_NAME,
  LOAD_SKILLS_TOOL_NAME, SkillsExecutor, buildLoadSkillsMessage, buildLoadSkillsOutput,
  classifyRequestedSkills, collectAvailableRuntimeSkillIds, parseSkillsArgument,
} from './src/tools/skills-executor.ts';
export type { LoadSkillsOutput, LoadedToolOutput, LoadSkillsOutcomeInput } from './src/tools/skills-executor.ts';
export {
  CANVAS_TOOL_NAMES, EXTERNAL_MCP_DOTTED_TOOL_PREFIX, EXTERNAL_MCP_TOOL_PREFIX,
  isCanvasTool, isExternalMcpToolName, isHighRiskExternalMcpTool, semanticToolShortName,
  stripToolNamespace, toolSourceNamespace,
} from './src/tools/naming.ts';
export type { ToolSourceNamespace } from './src/tools/naming.ts';
export {
  CANVAS_TOOL_SCHEMAS, NoteAppendTool, NoteCreateTool, NoteListTool, NoteReadTool,
  NoteReplaceTool, NoteSearchTool, NoteSetTool, appendToSection, extractSection,
  generateSummary, parseStructure, replaceContent,
} from './src/tools/canvas-tools.ts';
export type { ToolSchema } from './src/tools/canvas-tools.ts';
export {
  DEFAULT_MAX_LENGTH, DEFAULT_START_INDEX, DEFAULT_USER_AGENT, DEEPSEEK_API_KEY_SETTING,
  DEEPSEEK_FETCH_ENABLED_SETTING, DEEPSEEK_FETCH_ENDPOINT, FetchExecutor, MAX_BINARY_LENGTH,
  MAX_CONTENT_LENGTH, MAX_REDIRECTS, REQUEST_TIMEOUT_SECS, binaryHeaderFamilyMatches,
  cleanHtmlContent, cleanMarkdownContent, collectDownloadStreamLimited, decodeBytesWithCharset,
  deepseekFetchSettingEnabled, deepseekFetchSuccessResult, describeDeepseekFetchFailure,
  detectCharsetFromContentType, detectCharsetFromHtmlMeta, filenameFromHeadersOrUrl,
  htmlToMarkdownText, looksLikeHtml, paginateContent, parseDeepseekFetchResponse,
  sanitizeDownloadName, shouldUseDeepseekFetch, sniffBinaryKind, tryExtractMainContent,
} from './src/tools/fetch-executor.ts';
export type { BinaryKind, DeepseekFetchSuccessArgs, PaginateResult } from './src/tools/fetch-executor.ts';
export {
  FLAG_WORKBENCH_AGENT, HINT_CANCELLED, HINT_DISABLED, HINT_FLAG_OFF, HINT_UNAVAILABLE,
  SETTING_WORKBENCH_AGENT_CONTROL, TIMEOUT_MUTATE_MS,
  TIMEOUT_QUERY_MS, TIMEOUT_WAIT_MS, WORKBENCH_TOOL_NAMES, WorkbenchToolExecutor,
  appCommandBusinessError, bridgeCommandAndTimeout, canDispatchUnderOffGate,
  injectApprovalRiskCeiling, isLegacyHighRiskCommand, isReadonlyWorkbenchTool,
  isWorkbenchAgentDelegationEnabled, isWorkbenchAgentEnabled, isWorkbenchTool, mapBridgeError,
  normalizeBridgeArgs, resolveWorkbenchGates,
  structuredError, trustedApprovalRiskCeiling, workbenchCancelled, workbenchDisabled,
  workbenchFlagDisabled, workbenchResultUnknown, workbenchUnavailable,
} from './src/tools/workbench-executor.ts';
export type { WorkbenchGateEnvironment, WorkbenchGateMode, WorkbenchToolContext, WorkbenchToolName } from './src/tools/workbench-executor.ts';
export {
  LEGACY_PROVIDER_ID, LegacyExecutorAdapter, LegacyToolProvider,
  buildLegacyToolRegistry, buildLegacyToolRegistry as buildToolRegistry,
  projectLegacyDescriptor, validateLegacyRegistry,
} from './src/tools/legacy-tool-provider.ts';
export type {
  LegacyExecutorRegistry, LegacyToolDescriptor, LegacyToolExecutor, LegacyToolLogger,
} from './src/tools/legacy-tool-provider.ts';
export {
  AGENT_INSTALLED_MARKER, INSTALL_SUCCESS_MESSAGE, POST_WRITE_TRUST_NEXT_STEP,
  PROVENANCE_SETTINGS_PREFIX, SKILL_INSTALL, SKILL_SCAN, SkillInstallExecutor, safeTruncate,
} from './src/tools/skill-install-executor.ts';
export type { ParsedSource } from './src/tools/skill-install-executor.ts';
export {
  BRIDGE_REQUEST_EVENT, BRIDGE_RESPONSE_PREFIX, BRIDGE_TIMEOUT_MS,
  SKILL_REMOVE, SKILL_SET_ENABLED, SKILL_TRUST_REQUEST, SkillLifecycleExecutor,
  lifecycleRiskRank, normalizeLifecycleSha256, requiredSkillId, skillDescriptionFromValue,
  stripNamespace as stripLifecycleNamespace, validateSkillId,
} from './src/tools/skill-lifecycle-executor.ts';
export type { SkillDescription } from './src/tools/skill-lifecycle-executor.ts';
export {
  MAX_BINARY_ITEMS, MAX_COLLISION_ATTEMPTS, MAX_ENCODED_ITEM_BYTES, MAX_ITEM_BYTES,
  MAX_NAME_CHARS, MAX_TOTAL_BYTES, MCP_SUBDIR, extensionForMime, materializeMcpToolOutput,
  materializeMcpToolOutputAtRoot, mcpProvenanceFromUsage, sanitizeFileName, sanitizeSegment,
} from './src/tools/mcp-content-materializer.ts';
export type { McpOutputProvenance } from './src/tools/mcp-content-materializer.ts';
export {
  CORPUS_MANIFEST_SCHEMA_VERSION, LEGACY_DERIVED_TRANSFORM_ID, TASK_OBJECT_SCHEMA_VERSION,
  TaskObjectHandleBuilder, buildCorpusManifest, canClaimCompleteSuccess,
  corpusManifestModelNotice, derivedEdge, deserializeBatchManifest, deserializeCorpusManifest,
  deserializeDerivedEdge, deserializeTaskObjectHandle,
  hashTransformParams, managedLocator, taskObjectHandle, utcRfc3339Now,
  validateCorpusManifest, validateLocator, validateTaskObjectHandle, withParamsHash,
} from './src/tools/task-objects.ts';
export type {
  BatchItemStatus, BatchManifest, BatchManifestItem, CorpusManifest, CorpusManifestEntry,
  CorpusManifestPage, DerivedEdge, ManagedLocator, ObjectAcl, ObjectCapabilities,
  ObjectProvenance, ProviderObjectRef, TaskObjectHandle, TaskObjectKind,
} from './src/tools/task-objects.ts';
export {
  DEFAULT_MAX_CALLS, DEFAULT_TIMEOUT_SECS, INLINE_RESULT_MAX_CHARS, MAX_CALLS_LIMIT,
  MAX_CALLSTACK_SIZE, MAX_HEAP_BYTES, MAX_SCRIPT_BYTES, MAX_TICK_COUNT, MAX_TIMEOUT_SECS,
  OBJECT_READ_DEFAULT_LIMIT, PTC_ALLOWED_TOOLS, PTC_WRITE_TOOLS, PtcBrokerState,
  RESULT_PREVIEW_CHARS, argsFingerprint, defaultPtcInterpreterLimits, isPtcAllowedTool,
  isPtcWritableTool, normalizePtcToolName, runPtcScript, runPtcScriptWithLimits, truncateChars,
} from './src/tools/ptc-runtime.ts';
export type {
  PtcBrokerOptions, PtcDescriptorPolicy, PtcDispatch, PtcDispatchEnvelope, PtcInterpreterLimits,
  PtcLogger, PtcReadSource, PtcScriptOutcome, PtcTraceEntry,
} from './src/tools/ptc-runtime.ts';
export {
  PtcExecutor, PtcSubContextTemplate, buildFailureOutput, buildSuccessOutput,
  materializeResultToDir, parsePtcArgs, ptcResultHandle, writesSummaryOf,
} from './src/tools/ptc-executor.ts';
export { PtcToolExecutor, childContext } from './src/tools/ptc-tool-executor.ts';
export type { PtcToolExecutorOptions } from './src/tools/ptc-tool-executor.ts';
export type {
  MaterializedResult, PtcAdmittedDispatcher, PtcArgs, PtcBuildContext, PtcExecutionContext,
  PtcExecutorOptions, PtcSubContext,
} from './src/tools/ptc-executor.ts';
export {
  OBJECT_READABLE_ROOT_IDS, OBJECT_READ_PAGE_MAX_BYTES, OBJECT_WRITABLE_ROOT_IDS,
  OBJECT_WRITE_MAX_BYTES, readTaskObjectPage, writeTaskObjectPage,
} from './src/tools/object-pages.ts';
export type { TaskObjectPage, TaskObjectWriteOutcome } from './src/tools/object-pages.ts';
export {
  commitConnectorReceipt, confirmConnectorReceipt,
} from './src/tools/task-objects.ts';
export type {
  ConnectorOperationReceipt, OperationState,
} from './src/tools/task-objects.ts';
export {
  SKILL_MARKET_DETAIL_TOOL, SKILL_MARKET_DOWNLOAD_SCAN_TOOL, SKILL_MARKET_SEARCH_TOOL,
  SKILL_MARKET_VERIFY_TOOL, SkillMarketInstallToolExecutor, SkillMarketReadToolExecutor,
} from './src/skill-market.ts';
export type {
  MarketToolConcurrency, MarketToolSensitivity,
} from './src/skill-market.ts';
export {
  DEFAULT_PAGE_LIMIT as LLM_USAGE_DEFAULT_PAGE_LIMIT, LLM_USAGE_TOOL_NAME,
  LlmUsageToolExecutor, MAX_HOURLY_TREND_DAYS, MAX_PAGE_LIMIT, MAX_PAGE_OFFSET,
  MAX_TEXT_FIELD_CHARS, MAX_TREND_DAYS, executeUsageQuery, parseUsageQuery, runUsageQuery,
} from './src/tools/llm-usage-executor.ts';
export type {
  PageRequest as LlmUsagePageRequest, UsageGranularity, UsageQuery,
} from './src/tools/llm-usage-executor.ts';
export {
  APPLY_SUCCESS_MESSAGE, MAX_PENDING_PROPOSALS, SKILL_WORKSHOP_APPLY, SKILL_WORKSHOP_PROPOSE,
  SkillWorkshopExecutor,
} from './src/tools/skill-workshop-executor.ts';
export {
  MAX_CONTENT_BYTES, MAX_PACKAGE_FILES, MAX_PACKAGE_FILE_BYTES, MAX_PACKAGE_TOTAL_BYTES,
  normalizePackagePath, normalizeWorkshopSha256, packageFileMeta, packageFilesFromArgs,
  packageSha256, readPackageDirectory, sha256Hex, validateContent, validatePackageFiles,
  workshopRisk,
} from './src/tools/skill-workshop-package.ts';
export {
  PROPOSALS_SUBDIR, PROPOSAL_META_FILE, generateProposalId, proposalRevisionSha256,
  readProposalMeta, readProposalPackage, validateProposalId, validateWorkshopSkillId,
  verifyApprovedProposal, writeProposalFiles, writeProposalMeta,
} from './src/tools/skill-workshop-proposals.ts';
export type {
  SkillWorkshopOptions, SkillWorkshopProvenance, WorkshopSettingsStore,
} from './src/tools/skill-workshop-executor.ts';
export type { ProposalFileMeta } from './src/tools/skill-workshop-package.ts';
export type {
  AgentWorkshopMarker, ProposalFileInput, ProposalMeta,
} from './src/tools/skill-workshop-proposals.ts';
export {
  ENV_PLACEHOLDER as MCP_ENV_PLACEHOLDER, MCP_SERVER_PROPOSE, McpProposeExecutor,
  REMOTE_TEST_TIMEOUT_SECS, STDIO_TEST_TIMEOUT_SECS, buildServerEntry, findDuplicate,
  mcpProposeProvenanceKey, parseProposeInput, parseRequiredString, parseStringArray,
  parseTransport, redactSensitiveJson, rejectUnknownFields, removeProposedEntry,
  sanitizeTestError, serverName, serverId as mcpServerId, serverSummary, validateHttpsUrl,
} from './src/tools/mcp-propose-executor.ts';
export type {
  McpProposeContext, McpProposeDependencies, McpTransport, ProposeInput as McpProposeInput,
} from './src/tools/mcp-propose-executor.ts';
export {
  MANAGE_PROVENANCE_PREFIX, MCP_SERVER_REMOVE, MCP_SERVER_SET_ENABLED, MCP_SERVER_UPDATE,
  McpManageExecutor, PROPOSE_PROVENANCE_PREFIX, REMOVE_ALLOWED_KEYS, SET_ENABLED_ALLOWED_KEYS,
  UPDATE_ALLOWED_KEYS, applyUpdate, entryEnabled, entryId, entryName, entrySummary,
  entryTransportRaw, findNameConflict, findServerIndex, mcpEntryRevision, missingEnvVars,
  parseUpdateInput, provenanceCleanupKeys,
  rejectUnknownFields as rejectManageUnknownFields, serverNotFound,
} from './src/tools/mcp-manage-executor.ts';
export type {
  McpManageContext, McpManageDependencies, UpdateInput as McpUpdateInput, UpdateOutcome,
} from './src/tools/mcp-manage-executor.ts';
export {
  CONNECTOR_COMMIT_TOOL, CONNECTOR_CONFIRM_TOOL, CONNECTOR_DRAFT_TOOL, CONNECTOR_REGISTRY_KEY,
  CONNECTOR_REGISTRY_TOOL, DEFAULT_CONFIRM_TTL_SECS, MAX_CONFIRM_TTL_SECS,
  SUPPORTED_CAPABILITIES, WEBHOOK_PROVIDER_KIND, WEBHOOK_SUBMIT_MAX_ATTEMPTS,
  ConnectorToolExecutor, ProviderError, capabilityAvailable, capabilityFingerprint,
  extractExternalOperationId, findCapability, nowMs as connectorNowMs,
  operationExpired, parseAttachmentHandle, parseAttachments, parseDraft, parseRegistry,
  providerObjectHandle, readRegistry, receiptOf,
  registryOutput, requireSameSession, sha256Json, systemIdempotencyKey,
} from './src/tools/connector-executor.ts';
export { reconcileConnectorOperationsWithLookup } from './src/tools/connector-reconcile.ts';
export type { ReconcileReport } from './src/tools/connector-reconcile.ts';
export type {
  CapabilityConfig, CapabilitySnapshot, ConnectorConfig, ConnectorExecutionContext,
  ConnectorProvider, ConnectorSettings, ConnectorToolCallResult, DraftPreview, OAuthSnapshot,
  ProviderErrorKind, ProviderOperation, ProviderOutcome, ProviderReceipt,
  WebhookConfig,
} from './src/tools/connector-executor.ts';
export {
  CONNECTOR_OPERATION_STATES, canTransitionConnectorOperation, getConnectorOperation,
  getConnectorOperationByIdempotencyKey, insertConnectorDraft,
  listConnectorOperationsBySession, listPendingConnectorReconcile, markConnectorCommitted,
  markConnectorConfirmed, markConnectorFailed, markConnectorOutcomeUnknown,
  markConnectorSubmitting, parseConnectorOperationState, reconcileConnectorOnStartup,
  reconcileSubmittingOnStartup, sessionSideEffectSummary,
} from './repository/connector-ledger.ts';
export type {
  ConnectorOperation, ConnectorOperationState, NewConnectorOperation, SessionSideEffectSummary,
} from './repository/connector-ledger.ts';

/** skill_requires.rs:48; declarations retain source order and duplicates when probed. */
export interface SkillRequires {
  bins: string[];
  env: string[];
  python_packages: string[];
}

export interface AgentSkillsService {
  extractFrontmatter(text: string): string | null;
  parseRequires(text: string): SkillRequires;
  probeRequires(requires: SkillRequires): Promise<SkillRequiresProbe>;
  formatMissingRequiresHints(probe: SkillRequiresProbe): string[];
  getAllowedSkillsBases(): string[];
  commandMentionsSkillsDirectory(command: string): boolean;
  canonicalizeSkillPackageRoot(path: string): string;
  listDirectories(path: string): Promise<SkillDirectoryEntry[]>;
  listPackageFiles(path: string): Promise<SkillPackageFileEntry[]>;
  readFile(path: string): Promise<SkillFileContent>;
  create(basePath: string, skillId: string, content: string): Promise<SkillFileContent>;
  update(path: string, content: string): Promise<SkillFileContent>;
  delete(path: string): Promise<null>;
  importZip(zipPath: string, basePath: string, overwrite: boolean, dryRun: boolean | null | undefined): Promise<SkillImportZipResult>;
  tapCatalog(repoUrl: string): Promise<TapCatalog>;
  tapInstall(zipUrl: string, subdir: string, overwrite: boolean, dryRun: boolean | null | undefined, expectedPackageSha256: string | null | undefined): Promise<SkillImportZipResult>;
  exportTap(skillIds: readonly string[], destPath: string): Promise<TapExportResult>;
  marketSearch(q: string | null | undefined, limit: number | null | undefined, nonSuspiciousOnly: boolean | null | undefined, sort: string | null | undefined): Promise<SkillMarketSearchResponse>;
  marketDetail(slug: string): Promise<SkillMarketSkillDetail>;
  marketVerify(slug: string, version: string | null | undefined): Promise<SkillMarketVerifyResult>;
  marketDownloadAndScan(
    slug: string, version: string | null | undefined, install: boolean | null | undefined,
    overwrite: boolean | null | undefined, expectedPackageSha256: string | null | undefined,
    tempZipPath: string | null | undefined, declaredRiskLevel: string | null | undefined,
  ): Promise<SkillMarketDownloadScanResult>;
  recordSkillActivation(skillId: string, sessionId?: string | null): null;
  listSkillCandidates(status: string | null | undefined, limit: number | null | undefined): SkillCandidateSummary[];
  replaySkillCandidate(candidateId: string): ReplayReport;
  /** Desktop writes synchronously; hosts without sync files (mobile OPFS) return a promise. */
  promoteSkillCandidate(candidateId: string): SkillCandidatePromotion | Promise<SkillCandidatePromotion>;
  rollbackSkillCandidate(candidateId: string): SkillCandidateRollback | Promise<SkillCandidateRollback>;
}

/** Secure settings operations consumed by L19 and L06 (mcp_settings_store.rs). */
export interface AgentToolsService {
  /**
   * Register executors owned by another plugin (L10/L21/L24, …) in registration
   * order. The chat tool runtime orders `toolExecutors()` by the Rust roster
   * (`orderExecutorsByRoster`) when it assembles dispatch; registering twice
   * appends twice, matching Rust `ToolExecutorRegistry::register`.
   * Returns an idempotent disposer for this call's entries only. Disposing an
   * old registration never removes later registrations of the same objects or
   * names. Previously returned snapshots remain unchanged.
   * The caller must bind disposal to its own scope; ignoring the return value
   * remains supported but does not arrange automatic cleanup.
   *
   * ```ts
   * ctx.inject(['agentTools'], scope => {
   *   const registration = scope.agentTools.registerToolExecutors([new QBankExecutor(deps)]);
   *   scope.effect(() => () => registration.dispose());
   * });
   * ```
   * `name()` must equal the roster name (`QBankExecutor`); `execute(call, ctx)` receives the L04
   * `ToolCall` / `ExecutionContext`. Until such an executable entry exists, the tool's schema is
   * withheld from the model.
   */
  registerToolExecutors(executors: readonly AgentToolExecutor[]): Disposer;
  /** Snapshot of the executors registered through `registerToolExecutors`. */
  toolExecutors(): readonly AgentToolExecutor[];
  readMcpToolsList(settings: SettingsStore): Promise<unknown[]>;
  writeMcpToolsList(settings: SettingsStore, list: readonly unknown[]): Promise<void>;
  readMcpAllowUnapproved(settings: SettingsStore): Promise<boolean>;
  writeMcpAllowUnapproved(settings: SettingsStore, enabled: boolean): Promise<void>;
  /** L06/L19: tell the front end to reload MCP connections after a config write. */
  emitMcpListChanged(action: string): boolean;
  /** `inject_tool_schemas`: returns the number of injected schemas. */
  injectToolSchemas(
    schemaToolIds: readonly string[] | null | undefined,
    llmContext: Map<string, unknown>,
    registry: ToolSchemaRegistry,
  ): number;
}

/** `agentSkills` 服务版本描述（ARCHITECTURE.md §3）。 */
export const agentSkillsService = { name: 'agentSkills', version: '1.0.0' } as const;
/** `agentTools` 服务版本描述（ARCHITECTURE.md §3）。 */
export const agentToolsService = { name: 'agentTools', version: '1.0.0' } as const;

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentSkills: AgentSkillsService;
    agentTools: AgentToolsService;
  }
}
