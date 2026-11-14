import { Service, type Context } from '@deepseek-ai/cordis';
import { definePlugin } from '../../../kernel/api.ts';
import type { HostPlugin, PluginPlatform } from '../../../kernel/core.ts';
import { ChatV2Emitter, BackendEventsSink } from '../../chat/api.ts';
import { bindStreamingSink } from './stream-sink.ts';
import type { ChatPipelineService, JsonValue } from '../api.ts';
import { citationLedgerForReply, sanitizeRetrievalOutputForLlm } from './citations.ts';
import { localShellContractForPlatform } from './local-shell-contract.ts';
import {
  authorityStateFromMetadata, authorityStateToMetadata, craftDefaultAuthorityState,
  evaluateAuthorityGate, globalPlanGateManager, parsePermissionPreset,
  permissionPresetWireName, planCallBindingKey, requiresToolApproval,
} from './authority-mode.ts';
import { freezeToolFaceForPromptCache, mergeFrozenToolSchemaOrderBaseline } from './tool-face.ts';
import { parseApiUsage } from './token-usage.ts';
import { configureTokenizer } from './token-budget.ts';
import { PipelineContext } from './pipeline-context.ts';
import { PipelinePersistence } from './incremental-persistence.ts';
import { PipelineFinalPersistence } from './final-persistence.ts';
import { TextTurnExecution } from './text-execution.ts';
import { createUnifiedTextStream } from './unified-text-stream.ts';
import { manifestHasherOf, withRequestManifest } from './request-manifest.ts';
import { freezeExecutionContext } from './freeze-execution.ts';
import { compileFrozenContext } from './context-compiler.ts';
import { bindContextCompilationPorts, type ContextCompilerTempFiles } from './context-compiler-owner.ts';
import { resolveCanonicalImagePayloads, type CanonicalImageFiles } from './canonical-image-payloads.ts';
import { PipelineHistoryLoader } from './history-loader.ts';
import { StreamHooksGuard } from './stream-hooks-guard.ts';
import type {} from '../../llm/api.ts';
import { validateToolChain } from './history-replay.ts';
import type {} from '../../media/api.ts';
import { getBlockTypeForToolStatic } from './tool-block-type.ts';
import type {} from '../../agent-workspace/api.ts';
import { resolveHistoryContextSnapshot } from './history-vfs-context.ts';
import { persistReplaySidecar, persistUserLlmContentEarly } from './replay-persistence.ts';
import type {} from '../../chat/api.ts';
import { finalizeTaskCompletion, tryFinalizeTaskCompletion } from './completion-finalizer.ts';
import {
  configureCompactionBudgetLogger, effectiveUsableTokens, estimateMessageTokens,
  shouldCompact, shouldCompactAfterTool, usableTokens,
} from './compaction-budget.ts';
import {
  configureSegmentationLogger, selectTail, splitIntoTurns,
} from './segmentation.ts';
import { buildMemoryFlushSegmentId, splitMemoryFlushSegment } from './memory-flush.ts';
import {
  configureFinalizerLogger, finalizeTask, finalizationWireReport, parseDeclaredArtifacts,
} from './finalizer.ts';
import { buildSystemPromptWithProfileAndAgents, parseRendererCapabilities } from './prompt-builder.ts';
import {
  advanceMicrocompactAnchor, microcompactBatchEligibleTurns, microcompactOldToolOutputs,
} from './microcompact.ts';
import {
  advanceToolFacePrefixIntoMetadata, convergeToolFaceOrdersByVariantIndex,
  toolFacePrefixFromMetadata,
} from './tool-face.ts';
import {
  buildInjectedContextBlocks, buildRuntimeFactsBlock, buildUserContentFromContextRefs,
  collectInjectedContextTextAndImages, combineUserContent, combinedUserContent,
  configureContextLogger, contentBlocksOrdered, convertToContextRefs, wrapUserMessageText,
} from './context.ts';
import {
  applySendOverrides, auxiliaryMmEligible, canonicalContentForFreeze, generationModelKind,
  isDedicatedOcrCandidate, requestedActiveModelId, requestedGenerationModel,
  resolveStrictRequestedModel, selectGenerationConfig,
} from './model-selection.ts';
import {
  appendObservation, appendPreviewImages, applyExistingDerivedArtifacts,
  canonicalContentFromMessageMetadata, collectRuntimeImages, overrideMessageImagesWithCanonical,
  retainSelectedImagesForMultimodal, selectImagesWithBudget, sniffImageMime, stripAllImages,
} from './images.ts';
import {
  buildRetrievalPageImageInjection, buildRetrievalPageImageMessage, canonicalImageBlobHashes,
  collectRetrievalPageImageCandidates, countRequestImages, insertRetrievalPageImageMessage,
  resolveRetrievalPageImages, RetrievalPageImageBudget,
} from './retrieval-images.ts';
import {
  attachChildToTree, configureBudgetLogger, configureBudgetPersistence, configureBudgetSettings, configureBudgetSettingsReader, effectiveBudgetLimits,
  ledgerForTree, persistSnapshot, recordUsage, reserveChildSpec, resolveLimits,
  restoreBudgetLedgersFromDatabase, restoreBudgetLedgersFromDb, treeKeyForSession, tryConsume,
} from './budget.ts';
import { configureBudgetRepositoryLog, readSettingFromMainDb, readSettingWithConn } from '../repository/budget.ts';
import { setChatPipelineLocalFs, type ChatPipelineLocalFs } from './local-fs.ts';
import {
  setChatPipelineApprovalRuntime, type ChatPipelineApprovalRuntime,
} from './approval-runtime.ts';
import {
  decodeToolNameFromApi, encodeToolNameForApi, isExternalMcpToolName, isLoadSkillsToolName,
  isMcpToolAllowedByPolicy, normalizeToolNameForApi, prepareExternalToolSchema,
} from './canonical-tools.ts';
import {
  anchoredSkillIdsInHistory, buildInLoopSkillMessages, buildTransientSkillMessagesWithAudit,
  insertSkillMessagesAfterToolResult, insertTransientSkillMessages,
  orderedSkillIdsForInjection, parseSkillInjectionAnchors, rebuildAnchoredSkillMessages,
  rebuildAnchoredSkillMessagesGated, serializeSkillInjectionAnchors, skillBodyDigest,
  transientSkillMessageSkillId,
} from './skill-injection.ts';
import {
  cooldownSecondsForOutcome, compactionDidCompact, compactionIsFailed,
  compactionReasonCode, compactionStatus, compactionTokenEstimates, runSummaryCommitPost,
  validatedCompactionModelId,
} from './compaction-outcome.ts';
import {
  ChatV2StreamingAdapter, configureStreamingAdapterLogger, identityWrapTokenFilter, type StreamEventSink,
  type StreamingAdapterOptions,
} from './llm-adapter.ts';
import { createToolCall, orderToolCallsForExecution } from './tool-order.ts';
import { contentTextFromBlocks, toolResultsToMessages } from './history.ts';
import {
  PARALLEL_TOOL_CONCURRENCY, TOOL_TRANSIENT_RETRY_BACKOFF_MS, annotateAutoRetry,
  buildRunScopedStreamEvent, isRetryableLlmError, isTransientToolError,
  mergeRoundResultsInCallOrder, pinToolResultToBlock, planParallelSegments, runBoundedOrdered,
} from './parallel-exec.ts';
import {
  SESSION_METADATA_PROMPT, buildSessionMetadataPrompt, computeContentHash,
  configureSummaryLogger, fallbackSessionMetadata, parseSessionMetadataResponse,
  shouldGenerateSessionMetadata,
} from './summary.ts';
import {
  UNAVAILABLE_IMAGE_OBSERVATION, VISUAL_PREPROCESS_TURN_BUDGET_MS,
  contextImageCompileStrategy, finalizeVisualObservation, runPreprocessStage,
} from './preprocess.ts';
import {
  STREAM_WATCHDOG_STALL_GAP_MS, STREAM_WATCHDOG_TICK_MS, StreamIdleTracker,
  configureStreamWatchdogLogger, waitLlmStreamWithIdleTimeout,
} from './stream-watchdog.ts';
import {
  VariantStreamingAdapter, authoritativeContentResult, configureVariantAdapterLogger,
  type VariantAdapterOptions, VariantStreamContext,
} from './variant-adapter.ts';
import {
  executionSnapshotFromMessageMetadata, parseModelExecutionSnapshot,
  serializeModelExecutionSnapshot,
} from './execution-snapshot.ts';
import {
  buildReplaySkillPayloadSnapshot, extractCitedMemoryNoteIds, replaySnapshotHasMetadata,
} from './persistence.ts';
import {
  approvalManagerRequired, classifyLocalShellCall, defaultPipelineHookNames, immutableCommandGuardForToolCall, ToolAdmission,
} from './hooks.ts';
import { sourceUserCanonicalBeforeAssistant } from './multi-variant.ts';
import { PipelineExecution } from './execute.ts';
import {
  MissingCapabilityLog, SessionToolFaceBaselines, composeCompaction, composeExecution, composeMemoryFlushRecovery, composeVariants,
  resolveExecutionOwnerStore,
} from './execution-runtime.ts';
import { VariantPipeline } from './variant-run.ts';
import { CompactionRunner } from './compaction-run.ts';
import type { MemoryFlushRecovery } from './memory-flush-recovery.ts';
import { bindChatToolRuntime } from './tool-runtime.ts';
import { createSuperInboxSendPipeline, SUPER_INBOX_SEND_SERVICE } from './super-inbox-send.ts';
import type { WindowRef } from '../../../kernel/api.ts';
import type { ChatPipelineExecution } from '../api.ts';
import { shellGuardAdmitted } from './authority-mode.ts';
import {
  DEFAULT_CONTEXT_LIMIT, DEFAULT_GRAPH_TOP_K, DEFAULT_MULTIMODAL_TOP_K, DEFAULT_RAG_TOP_K,
  DEFAULT_TOOL_TIMEOUT_MS, effectiveMaxToolRounds, isConfigIdFormat,
} from './constants.ts';
import {
  configureRetrievalLogger, executeRetrievals, filterRetrievalResults,
  sourceInfoFromRagSource, truncateText,
} from './retrieval.ts';
import {
  normalizeToolNameForSkillMatch, skillAllowsTool, skillAllowsToolOnServer,
} from './skill-tool-policy.ts';
import { buildStaticFallbackSummary, compactionProfileForMode, extractOpaqueIdentifiers,
  makeSummarySystemMessage, missingIdentifiers, renderMessagesForPrompt,
  splitTextToTokenBudget, summaryIsStructurallyValid, truncateTextToTokenBudget } from './compaction-prompts.ts';

class PipelineService extends Service implements ChatPipelineService, SinglePipelineExecution {
  private readonly missingCapabilities: MissingCapabilityLog;
  private readonly toolFaceBaselines: SessionToolFaceBaselines;
  private readonly compactionRunner: CompactionRunner;
  private readonly memoryFlushRecovery: MemoryFlushRecovery;
  constructor(ctx: Context) {
    super(ctx, 'chatPipeline');
    configureTokenizer(((ctx.reflect.get('nativeTokenizer', false) as import('../../../platform/native/tokenizer/api.ts').NativeTokenizer | undefined) ?? null) as never);
    configureStreamingAdapterLogger(ctx.logger);
    configureStreamWatchdogLogger(ctx.logger);
    configureBudgetLogger(ctx.logger);
    configureBudgetSettings(ctx.settings);
    configureBudgetRepositoryLog(ctx.logger);
    const budgetConnection = () => ctx.chatSession.database.getConnSafe();
    ctx.effect(() => configureBudgetPersistence(budgetConnection));
    restoreBudgetLedgersFromDatabase(budgetConnection);
    configureFinalizerLogger(ctx.logger);
    configureVariantAdapterLogger(ctx.logger);
    configureContextLogger(ctx.logger);
    configureSegmentationLogger(ctx.logger);
    configureCompactionBudgetLogger(ctx.logger);
    configureSummaryLogger(ctx.logger);
    configureRetrievalLogger(ctx.logger);
    this.missingCapabilities = new MissingCapabilityLog(ctx.logger);
    this.toolFaceBaselines = new SessionToolFaceBaselines(
      () => resolveExecutionOwnerStore(this.ctx.chatSession), ctx.logger);
    const memoryFlushRecovery = composeMemoryFlushRecovery(ctx, this.missingCapabilities);
    this.memoryFlushRecovery = memoryFlushRecovery;
    this.compactionRunner = new CompactionRunner(() => composeCompaction(this.ctx, this.missingCapabilities, memoryFlushRecovery));
    // lib.rs:1561–1564: startup recovery pass spawned once the pipeline is built.
    memoryFlushRecovery.spawn();
  }

  /** compaction.rs:431; hard owner/transaction errors reject, soft outcomes resolve. */
  runCompactionForSession: SinglePipelineExecution['runCompactionForSession'] = (sessionId, modelId, reason,
    excludeIds, contextLimit, memoryEnabled, cancellation) =>
    this.compactionRunner.runForSession(sessionId, modelId, reason, excludeIds, contextLimit, memoryEnabled, cancellation);

  /** Composes pipeline.rs from the current service graph; fails before any emit/write when L04 is absent. */
  private composed() {
    const owner = resolveExecutionOwnerStore(this.ctx.chatSession);
    const missing = this.missingCapabilities;
    const runner = this.compactionRunner;
    const deps = composeExecution({ ctx: this.ctx, owner, toolFace: this.toolFaceBaselines, missing,
      memoryFlushRecovery: this.memoryFlushRecovery,
      // L11 has not published getBlobHashByFileOrResourceId; an unresolved hash is Rust's None slot.
      resolveCanonicalImages: parts => this.resolveCanonicalImagePayloads(parts, () => {
        missing.note('vfsRepo.getBlobHashByFileOrResourceId', 'canonical images without blob_hash are not hydrated');
        return null;
      }),
      resolveSnapshot: (original, message, conn) => this.resolveHistoryContextSnapshot(original, message, conn),
      compaction: {
        runCompaction: (execution, emitter) => runner.runCompaction(execution, emitter),
        compactForRequest: (execution, emitter, error) => runner.compactForRequest(execution, emitter, error),
        runOverflowCompaction: (execution, model, emitter) => runner.runWithFeedback(execution.sessionId,
          model, 'overflow', [execution.userMessageId, execution.assistantMessageId], execution.options.contextLimit ?? null,
          execution.options.memoryEnabled ?? null, execution.cancellationToken(), emitter),
      } });
    const variants = () => new VariantPipeline(composeVariants(this.ctx, owner, deps, this.toolFaceBaselines, missing,
      (sessionId, options, excludes, emitter, signal, error) =>
        runner.compactForRequestWith(sessionId, options, excludes, emitter, signal, error)));
    deps.multiVariant = (window, request, modelIds, signal, state) =>
      variants().executeMultiVariant(window, request, modelIds, signal, state);
    return { deps, variants };
  }
  private execution(window: WindowRef | null): PipelineExecution {
    return new PipelineExecution(this.composed().deps, window);
  }
  bindToolRuntime: ChatPipelineService['bindToolRuntime'] = (authority, todo) =>
    bindChatToolRuntime(this.ctx, authority, todo);
  /** multi_variant.rs:86 (direct entry; execute() routes here for parallelModelIds ≥ 2 when enabled). */
  executeMultiVariant: SinglePipelineExecution['executeMultiVariant'] = async (window, request, modelIds, cancellation, state) =>
    this.composed().variants().executeMultiVariant(window, structuredClone(request), [...modelIds], cancellation, state);
  /** multi_variant.rs:3053 */
  executeVariantRetry: SinglePipelineExecution['executeVariantRetry'] = async (window, sessionId, messageId, variantId,
    modelId, userContent, userAttachments, sharedContext, options, cancellation) =>
    this.composed().variants().executeVariantRetry(window, sessionId, messageId, variantId, modelId, userContent,
      userAttachments, structuredClone(sharedContext), structuredClone(options), cancellation);
  /** multi_variant.rs:2831 */
  executeVariantsRetryBatch: SinglePipelineExecution['executeVariantsRetryBatch'] = async (window, sessionId, messageId,
    variants, userContent, userAttachments, sharedContext, options, cancellation, state) =>
    this.composed().variants().executeVariantsRetryBatch(window, sessionId, messageId, structuredClone(variants), userContent,
      userAttachments, structuredClone(sharedContext), structuredClone(options), cancellation, state);
  execute: SinglePipelineExecution['execute'] = async (window, request, cancellation, state) => {
    const execution = this.execution(window);
    return execution.execute(window, request, cancellation, state);
  };
  executeWithEmitter: SinglePipelineExecution['executeWithEmitter'] = async (emitter, request, cancellation, state) =>
    this.execution(null).executeWithEmitter(emitter, request, cancellation, state);
  /** handlers/send_message.rs:1175–1207: same execute with skip_user_message_save = true. */
  executeWithExistingUser: SinglePipelineExecution['executeWithExistingUser'] = async (window, request, cancellation, state) =>
    this.execute(window, { ...request, options: { ...request.options, skipUserMessageSave: true } }, cancellation, state);
  citationLedgerForReply = citationLedgerForReply;
  createPipelineContext: ChatPipelineService['createPipelineContext'] = request => new PipelineContext(request);
  compileFrozenContext: ChatPipelineService['compileFrozenContext'] = (execution, ports) =>
    compileFrozenContext(execution, ports, this.ctx.logger);
  bindContextCompilationPorts: ChatPipelineService['bindContextCompilationPorts'] = (owner, fileBlob) => {
    const paths = this.ctx.get('paths');
    if (!paths) throw new Error('Context compilation requires paths service');
    return bindContextCompilationPorts(owner, parts => this.resolveCanonicalImagePayloads(parts, fileBlob),
      paths.os.temp, () => this.platformFiles());
  };
  /** `ctx.files`：OCR 临时目录与 blob 读取；缺席时按平台配置错误报告。 */
  private platformFiles(): CanonicalImageFiles & ContextCompilerTempFiles {
    const files = this.ctx.reflect.get('files', false) as CanonicalImageFiles & ContextCompilerTempFiles | undefined;
    if (files === undefined) throw new Error('chat-pipeline 文件访问需要 files 服务');
    return files;
  }
  resolveCanonicalImagePayloads: ChatPipelineService['resolveCanonicalImagePayloads'] = (parts, fileBlob) =>
    resolveCanonicalImagePayloads(parts, this.ctx.get('vfs')?.database ?? null,
      this.ctx.get('vfsRepo')?.blobs ?? null, fileBlob, this.ctx.logger, () => this.platformFiles());
  freezeExecutionContext: ChatPipelineService['freezeExecutionContext'] = (execution, buildCanonical) => {
    const manager = this.ctx.get('llm'), ocr = this.ctx.get('llmOcrModels');
    if (!manager || !ocr) throw new Error('Request execution requires llm and llmOcrModels services');
    return freezeExecutionContext(execution, manager, ocr, buildCanonical, this.ctx.logger);
  };
  immutableCommandGuardForToolCall: ChatPipelineService['immutableCommandGuardForToolCall'] = (call, classify = classifyLocalShellCall) =>
    immutableCommandGuardForToolCall(call, classify, () => this.ctx.get('paths')?.os.home ?? null);
  createPersistence: ChatPipelineService['createPersistence'] = store =>
    new PipelinePersistence(() => this.ctx.chatSession.database.getConnSafe(), store, this.ctx.logger);
  createFinalPersistence: ChatPipelineService['createFinalPersistence'] = (store, effects) =>
    new PipelineFinalPersistence(() => this.ctx.chatSession.database.getConnSafe(), store, effects, this.ctx.logger);
  createPreparedTextExecution: ChatPipelineService['createPreparedTextExecution'] = dependencies => {
    const events = this.ctx.get('llmStreamEvents'), manager = this.ctx.get('llm');
    if (!events || !manager) throw new Error('Prepared text execution requires llmStreamEvents and llm services');
    return new TextTurnExecution(dependencies, events, manager, this.ctx.logger, key => this.ctx.settings.get(key));
  };
  createUnifiedTextStream: ChatPipelineService['createUnifiedTextStream'] = (sink, window = null) => {
    const service = this.ctx.get('llmModel2Streaming'), manager = this.ctx.get('llm');
    if (!service || !manager) throw new Error('Unified text streaming requires llmModel2Streaming and llm services');
    return createUnifiedTextStream(withRequestManifest(service, this.ctx.logger, manifestHasherOf(this.ctx)), manager, sink, window);
  };
  createStreamHooksGuard: ChatPipelineService['createStreamHooksGuard'] = (streamEvent, owner) => {
    const events = this.ctx.get('llmStreamEvents'), manager = this.ctx.get('llm');
    if (!events || !manager) throw new Error('Stream hooks require llmStreamEvents and llm services');
    return new StreamHooksGuard(events, manager, streamEvent, owner);
  };
  createHistoryLoader: ChatPipelineService['createHistoryLoader'] = store => new PipelineHistoryLoader(store, {
    getConnection: () => this.ctx.chatSession.database.getConnSafe(),
    getVfsConnection: () => this.ctx.get('vfs')?.database.getConnSafe() ?? null,
    resolveSnapshot: (original, message, conn) => this.resolveHistoryContextSnapshot(original, message, conn),
    extractDocument: (name, base64) => {
      const docs = this.ctx.get('docs');
      if (!docs) throw new Error('History document parsing requires docs service');
      return docs.extractTextFromBase64(name, base64);
    },
    logger: this.ctx.logger,
  });
  validateToolChain: ChatPipelineService['validateToolChain'] = messages => validateToolChain(messages, this.ctx.logger);
  getBlockTypeForToolStatic = getBlockTypeForToolStatic;
  createSessionEventEmitter: ChatPipelineService['createSessionEventEmitter'] = (sessionId, options = {}) => {
    const emitter = ChatV2Emitter.withSinkAndBatching(new BackendEventsSink(this.ctx.backendEvents, this.ctx.logger),
      sessionId, options.batching ?? true).withStreamGeneration(options.streamGeneration);
    this.ctx.effect(() => () => emitter.dispose());
    return emitter;
  };
  bindStreamingSink = bindStreamingSink;
  createVariantStreamContext: ChatPipelineService['createVariantStreamContext'] =
    (emitter, variantId, modelId, messageId, options = {}) =>
      new VariantStreamContext(variantId, modelId, messageId, { ...options, sink: bindStreamingSink(emitter) });
  resolveHistoryContextSnapshot: ChatPipelineService['resolveHistoryContextSnapshot'] = (original, message, conn) => {
    const resolver = this.ctx.reflect.get('agentVfsResolver', false) as import('../../agent-workspace/api.ts').AgentVfsResolver | undefined;
    if (!resolver) return Promise.resolve([original, []]);
    return resolveHistoryContextSnapshot(original, message, conn, this.ctx.vfsRepo.resources, resolver, this.ctx.logger);
  };
  persistUserLlmContentEarly: ChatPipelineService['persistUserLlmContentEarly'] = (execution, writer) =>
    persistUserLlmContentEarly(execution, () => this.ctx.chatSession.database.getConnSafe(),
      (_conn, id) => this.ctx.chatSession.getMessageBlocks(id), writer, this.ctx.logger);
  persistReplaySidecar = persistReplaySidecar;
  tryFinalizeTaskCompletion: ChatPipelineService['tryFinalizeTaskCompletion'] = (execution, locator = null) =>
    tryFinalizeTaskCompletion(execution, this.ctx.chatSession, locator, this.ctx.logger);
  finalizeTaskCompletion: ChatPipelineService['finalizeTaskCompletion'] = (execution, locator = null) =>
    finalizeTaskCompletion(execution, this.ctx.chatSession, locator, this.ctx.logger);
  localShellContractForPlatform = localShellContractForPlatform;
  sanitizeRetrievalOutputForLlm = sanitizeRetrievalOutputForLlm;
  planGateManager = globalPlanGateManager();
  requiresToolApproval = requiresToolApproval;
  evaluateAuthorityGate = evaluateAuthorityGate;
  planCallBindingKey = planCallBindingKey;
  freezeToolFace = freezeToolFaceForPromptCache;
  mergeFrozenToolSchemaOrderBaseline = mergeFrozenToolSchemaOrderBaseline;
  parseApiUsage = parseApiUsage;
  usableTokens = usableTokens;
  effectiveUsableTokens = effectiveUsableTokens;
  shouldCompact = shouldCompact;
  shouldCompactAfterTool = shouldCompactAfterTool;
  estimateMessageTokens = estimateMessageTokens;
  splitIntoTurns = splitIntoTurns;
  selectTail = selectTail;
  compactionProfileForMode = compactionProfileForMode;
  summaryIsStructurallyValid = summaryIsStructurallyValid;
  buildStaticFallbackSummary = buildStaticFallbackSummary;
  extractOpaqueIdentifiers = extractOpaqueIdentifiers;
  missingIdentifiers = missingIdentifiers;
  renderMessagesForPrompt = renderMessagesForPrompt;
  makeSummarySystemMessage = makeSummarySystemMessage;
  truncateTextToTokenBudget = truncateTextToTokenBudget;
  splitTextToTokenBudget = splitTextToTokenBudget;
  buildMemoryFlushSegmentId = buildMemoryFlushSegmentId;
  splitMemoryFlushSegment = splitMemoryFlushSegment;
  finalizeTask = finalizeTask;
  finalizationWireReport = finalizationWireReport;
  parseDeclaredArtifacts = parseDeclaredArtifacts;
  parseRendererCapabilities = parseRendererCapabilities;
  buildSystemPrompt = buildSystemPromptWithProfileAndAgents;
  microcompactBatchEligibleTurns = microcompactBatchEligibleTurns;
  advanceMicrocompactAnchor = advanceMicrocompactAnchor;
  microcompactOldToolOutputs = microcompactOldToolOutputs;
  convergeToolFaceOrdersByVariantIndex = convergeToolFaceOrdersByVariantIndex;
  toolFacePrefixFromMetadata = toolFacePrefixFromMetadata;
  advanceToolFacePrefixIntoMetadata = advanceToolFacePrefixIntoMetadata;
  wrapUserMessageText = wrapUserMessageText;
  buildRuntimeFactsBlock = buildRuntimeFactsBlock;
  buildInjectedContextBlocks = buildInjectedContextBlocks;
  collectInjectedContextTextAndImages = collectInjectedContextTextAndImages;
  combineUserContent = combineUserContent;
  generationModelKind = generationModelKind;
  auxiliaryMmEligible = auxiliaryMmEligible;
  isDedicatedOcrCandidate = isDedicatedOcrCandidate;
  requestedGenerationModel = requestedGenerationModel;
  selectGenerationConfig = selectGenerationConfig;
  resolveStrictRequestedModel = resolveStrictRequestedModel;
  applySendOverrides = applySendOverrides;
  requestedActiveModelId = requestedActiveModelId;
  canonicalContentForFreeze = canonicalContentForFreeze;
  selectImagesWithBudget = selectImagesWithBudget;
  collectRuntimeImages = collectRuntimeImages;
  applyExistingDerivedArtifacts = applyExistingDerivedArtifacts;
  overrideMessageImagesWithCanonical = overrideMessageImagesWithCanonical;
  retainSelectedImagesForMultimodal = retainSelectedImagesForMultimodal;
  stripAllImages = stripAllImages;
  appendObservation = appendObservation;
  sniffImageMime = sniffImageMime;
  canonicalContentFromMessageMetadata = canonicalContentFromMessageMetadata;
  appendPreviewImages = appendPreviewImages;
  collectRetrievalPageImageCandidates = collectRetrievalPageImageCandidates;
  countRequestImages = countRequestImages;
  canonicalImageBlobHashes = canonicalImageBlobHashes;
  createRetrievalPageImageBudget = (imageBudget: number, imagesInRequest: number,
    alreadyReferencedBlobs: ReadonlySet<string>) =>
    new RetrievalPageImageBudget(imageBudget, imagesInRequest, alreadyReferencedBlobs);
  buildRetrievalPageImageMessage = buildRetrievalPageImageMessage;
  resolveRetrievalPageImages: ChatPipelineService['resolveRetrievalPageImages'] = candidates =>
    resolveRetrievalPageImages(candidates, this.ctx.get('vfs')?.database ?? null,
      this.ctx.get('vfsRepo')?.blobs ?? null, this.ctx.logger);
  buildRetrievalPageImageInjection: ChatPipelineService['buildRetrievalPageImageInjection'] = (results, budget) =>
    buildRetrievalPageImageInjection(results, budget, this.ctx.get('vfs')?.database ?? null,
      this.ctx.get('vfsRepo')?.blobs ?? null, this.ctx.logger);
  insertRetrievalPageImageMessage = insertRetrievalPageImageMessage;
  resolveBudgetLimits = resolveLimits;
  effectiveBudgetLimits = effectiveBudgetLimits;
  configureBudgetSettingsReader = configureBudgetSettingsReader;
  attachChildToTree = attachChildToTree;
  treeKeyForSession = treeKeyForSession;
  budgetLedgerForTree = ledgerForTree;
  tryConsumeTreeBudget = tryConsume;
  recordTreeUsage = recordUsage;
  reserveChildSpec = reserveChildSpec;
  persistBudgetSnapshot = persistSnapshot;
  restoreBudgetLedgersFromDb = restoreBudgetLedgersFromDb;
  readBudgetSetting = readSettingWithConn;
  readBudgetSettingFromFile: ChatPipelineService['readBudgetSettingFromFile'] = (path, key) =>
    readSettingFromMainDb(this.ctx.storage, path, key);
  normalizeToolNameForApi = normalizeToolNameForApi;
  encodeToolNameForApi = encodeToolNameForApi;
  decodeToolNameFromApi = decodeToolNameFromApi;
  prepareExternalToolSchema = prepareExternalToolSchema;
  isMcpToolAllowedByPolicy = isMcpToolAllowedByPolicy;
  isExternalMcpToolName = isExternalMcpToolName;
  isLoadSkillsToolName = isLoadSkillsToolName;
  orderedSkillIdsForInjection = orderedSkillIdsForInjection;
  buildTransientSkillMessagesWithAudit = buildTransientSkillMessagesWithAudit;
  insertTransientSkillMessages = insertTransientSkillMessages;
  buildInLoopSkillMessages = buildInLoopSkillMessages;
  insertSkillMessagesAfterToolResult = insertSkillMessagesAfterToolResult;
  anchoredSkillIdsInHistory = anchoredSkillIdsInHistory;
  rebuildAnchoredSkillMessages = rebuildAnchoredSkillMessages;
  rebuildAnchoredSkillMessagesGated = rebuildAnchoredSkillMessagesGated;
  skillBodyDigest = skillBodyDigest;
  serializeSkillInjectionAnchors = serializeSkillInjectionAnchors;
  parseSkillInjectionAnchors = parseSkillInjectionAnchors;
  transientSkillMessageSkillId = transientSkillMessageSkillId;
  compactionStatus = compactionStatus;
  compactionReasonCode = compactionReasonCode;
  compactionDidCompact = compactionDidCompact;
  compactionTokenEstimates = compactionTokenEstimates;
  compactionIsFailed = compactionIsFailed;
  cooldownSecondsForOutcome = cooldownSecondsForOutcome;
  validatedCompactionModelId = validatedCompactionModelId;
  runSummaryCommitPost = runSummaryCommitPost;
  createStreamingAdapter = (sink: StreamEventSink, messageId: string,
    options: StreamingAdapterOptions) =>
    new ChatV2StreamingAdapter(sink, messageId, options);
  identityWrapTokenFilter = identityWrapTokenFilter;
  orderToolCallsForExecution = orderToolCallsForExecution;
  parsePermissionPreset = parsePermissionPreset;
  permissionPresetWireName = permissionPresetWireName;
  craftDefaultAuthorityState = craftDefaultAuthorityState;
  authorityStateFromMetadata = authorityStateFromMetadata;
  authorityStateToMetadata = authorityStateToMetadata;
  createVariantStreamingAdapter = (ctx: VariantStreamContext, options: VariantAdapterOptions) =>
    new VariantStreamingAdapter(ctx, options);
  authoritativeContentResult = authoritativeContentResult;
  parseModelExecutionSnapshot = parseModelExecutionSnapshot;
  serializeModelExecutionSnapshot = serializeModelExecutionSnapshot;
  executionSnapshotFromMessageMetadata = executionSnapshotFromMessageMetadata;
  buildReplaySkillPayloadSnapshot = buildReplaySkillPayloadSnapshot;
  replaySnapshotHasMetadata = replaySnapshotHasMetadata;
  extractCitedMemoryNoteIds = extractCitedMemoryNoteIds;
  approvalManagerRequired = approvalManagerRequired;
  defaultPipelineHookNames = defaultPipelineHookNames;
  createToolAdmission = (argumentsValue: JsonValue) => ToolAdmission.create(argumentsValue);
  shellGuardAdmitted = shellGuardAdmitted;
  sourceUserCanonicalBeforeAssistant = sourceUserCanonicalBeforeAssistant;
  effectiveMaxToolRounds = effectiveMaxToolRounds;
  isConfigIdFormat = isConfigIdFormat;
  truncateText = truncateText;
  sourceInfoFromRagSource = sourceInfoFromRagSource;
  filterRetrievalResults = filterRetrievalResults;
  executeRetrievals = executeRetrievals;
  normalizeToolNameForSkillMatch = normalizeToolNameForSkillMatch;
  skillAllowsTool = skillAllowsTool;
  skillAllowsToolOnServer = skillAllowsToolOnServer;
  generateBlockId = () => ChatV2StreamingAdapter.generateBlockId();
  readonly defaultToolTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS;
  readonly defaultRagTopK = DEFAULT_RAG_TOP_K;
  readonly defaultGraphTopK = DEFAULT_GRAPH_TOP_K;
  readonly defaultMultimodalTopK = DEFAULT_MULTIMODAL_TOP_K;
  readonly defaultContextLimit = DEFAULT_CONTEXT_LIMIT;
  buildUserContentFromContextRefs = buildUserContentFromContextRefs;
  convertToContextRefs = convertToContextRefs;
  combinedUserContent = combinedUserContent;
  contentBlocksOrdered = contentBlocksOrdered;
  contentTextFromBlocks = contentTextFromBlocks;
  toolResultsToMessages = toolResultsToMessages;
  createToolCall = createToolCall;
  planParallelSegments = planParallelSegments;
  isTransientToolError = isTransientToolError;
  isRetryableLlmError = isRetryableLlmError;
  annotateAutoRetry = annotateAutoRetry;
  pinToolResultToBlock = pinToolResultToBlock;
  buildRunScopedStreamEvent = buildRunScopedStreamEvent;
  runBoundedOrdered = runBoundedOrdered;
  mergeRoundResultsInCallOrder = mergeRoundResultsInCallOrder;
  readonly parallelToolConcurrency = PARALLEL_TOOL_CONCURRENCY;
  readonly toolTransientRetryBackoffMs = TOOL_TRANSIENT_RETRY_BACKOFF_MS;
  parseSessionMetadataResponse = parseSessionMetadataResponse;
  fallbackSessionMetadata = fallbackSessionMetadata;
  computeContentHash = computeContentHash;
  buildSessionMetadataPrompt = buildSessionMetadataPrompt;
  shouldGenerateSessionMetadata = shouldGenerateSessionMetadata;
  readonly sessionMetadataPrompt = SESSION_METADATA_PROMPT;
  contextImageCompileStrategy = contextImageCompileStrategy;
  finalizeVisualObservation = finalizeVisualObservation;
  runPreprocessStage = runPreprocessStage;
  readonly unavailableImageObservation = UNAVAILABLE_IMAGE_OBSERVATION;
  readonly visualPreprocessTurnBudgetMs = VISUAL_PREPROCESS_TURN_BUDGET_MS;
  createStreamIdleTracker = () => new StreamIdleTracker();
  waitLlmStreamWithIdleTimeout = waitLlmStreamWithIdleTimeout;
  readonly streamWatchdogTickMs = STREAM_WATCHDOG_TICK_MS;
  readonly streamWatchdogStallGapMs = STREAM_WATCHDOG_STALL_GAP_MS;
}

type SinglePipelineExecution = ChatPipelineExecution;

/** 平台差异部分：桌面入口注入 `node:fs` 同步端口，移动端入口不注入（产物校验/检索页图片降级）。 */
export interface ChatPipelinePluginOptions {
  platforms?: readonly PluginPlatform[];
  /** `() => port` 在 apply 时求值并安装；缺省用无本地文件系统的端口。 */
  localFs?: () => ChatPipelineLocalFs;
  /** 本地 shell 审批绑定端口；缺省对本地 shell 调用 fail-closed。 */
  approvalRuntime?: () => ChatPipelineApprovalRuntime;
}

/** 插件本体（可移植）：入口按平台在 `index.ts` / `mobile.ts` 之间选择。 */
export function createChatPipelinePlugin(options: ChatPipelinePluginOptions = {}): HostPlugin {
  return definePlugin({
  meta: {
    id: 'dstu.chat-pipeline', lane: 'L03-chat-pipeline', commands: [], provides: ['chatPipeline', SUPER_INBOX_SEND_SERVICE],
    ...(options.platforms === undefined ? {} : { platforms: options.platforms }),
  },
  inject: options.platforms?.includes('mobile')
    ? ['chatSession', 'settings', 'storage', 'vfsRepo']
    : ['nativeTokenizer', 'chatSession', 'settings', 'storage', 'vfsRepo', 'agentVfsResolver'],
  apply(ctx) {
    setChatPipelineLocalFs(options.localFs?.() ?? null);
    ctx.effect(() => () => setChatPipelineLocalFs(null));
    setChatPipelineApprovalRuntime(options.approvalRuntime?.() ?? null);
    ctx.effect(() => () => setChatPipelineApprovalRuntime(null));
    const service = new PipelineService(ctx);
    let disposed = false;
    ctx.effect(() => () => { disposed = true; });
    const port = { execute: service.execute };
    // goal/runtime.rs:435 resolve_emit_window: `app.webview_windows()` keyed by webview label ("main", else the first).
    const webviews = new Map<string, WindowRef>();
    ctx.on('host/window', (ref, windowState) => {
      if (windowState === 'created') webviews.set(ref.webview, { ...ref });
      else if (windowState === 'destroyed') webviews.delete(ref.webview);
    });
    ctx.provide(SUPER_INBOX_SEND_SERVICE, createSuperInboxSendPipeline({
      sessions: () => ctx.chatSession,
      state: () => ctx.get('chatState'),
      background: () => ctx.get('backgroundTasks'),
      port: () => disposed ? undefined : port,
      resolveWindow: () => webviews.get('main') ?? webviews.values().next().value ?? null,
      emit: (event, payload) => { ctx.backendEvents.emit(event, payload); },
    }));
  },
  });
}
