/** Production composition of pipeline.rs execution from published owner services.
 * Required owner surfaces fail before any event/write; optional Rust providers degrade exactly to None.
 */
import type { Context } from '@deepseek-ai/cordis';
import {
  BackendEventsSink, ChatV2Emitter, ChatV2Error,
  freezeMemoryKernelSnapshotWithConn, getMemoryKernelSnapshotWithConn,
  getSessionWithConn,
  type SessionState,
} from '../../chat/api.ts';
import { emitStudyEvent } from '../../plugin-services/api.ts';
import type { StreamEventSink as LlmStreamEventSink } from '../../llm/api.ts';
import { onTaskFinalized, onTurnCommitted } from '../../agent-skills/portable.ts';
import { ToolRounds } from './tool-round.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';
import { VARIANT_OWNER_METHODS, type VariantDependencies, type VariantExecutionManager } from './variant-run.ts';
import { resolveActiveApiConfig } from './tool-loop.ts';
import { finalizeTaskCompletion } from './completion-finalizer.ts';
import {
  buildBrowserScreenshotImageInjection, buildRetrievalPageImageInjection, MAX_BROWSER_SCREENSHOT_IMAGE_BYTES,
} from './retrieval-images.ts';
import { readAllBytes } from './local-fs.ts';
import type { ApiConfig } from '../../llm/api.ts';
import type { WindowRef } from '../../../kernel/api.ts';
import type { PipelineFinalStore, PipelinePostCommitEffects } from './persistence-port.ts';
import type { PipelineHistoryStore } from './history-port.ts';
import { PipelinePersistence } from './incremental-persistence.ts';
import { PipelineFinalPersistence } from './final-persistence.ts';
import { PipelineHistoryLoader } from './history-loader.ts';
import type { ContextCompilationPorts } from './context-compiler.ts';
import { bindContextCompilationPorts } from './context-compiler-owner.ts';
import { prepareDeepseekDocuments } from './deepseek-documents.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import type { ResolvedCanonicalImage } from './images.ts';
import type { CanonicalContentPart } from '../../chat/api.ts';
import { parseRendererCapabilities, RENDERER_CAPABILITIES_SETTING_KEY } from './prompt-builder.ts';
import { formatDeclarativeStudyPackPrompt } from './pipeline-hooks.ts';
import type { SessionSkillState } from './skill-injection.ts';
import { emptyToolFacePrefixSnapshot, refillToolFaceBaseline, mergeFrozenToolSchemaOrderBaseline,
  type ToolFacePrefixSnapshot } from './tool-face.ts';
import type { ToolFaceBaselineStore } from './tool-loop.ts';
import { errorMessage } from './tool-loop.ts';
import { manifestHasherOf, withRequestManifest } from './request-manifest.ts';
import { isMultiVariantEnabled, type CompactionRuntime, type ExecutionDependencies } from './execute.ts';
import { COMPACTION_OWNER_METHODS, type CompactionDependencies, type CompactionOwnerStore } from './compaction-run.ts';
import type { StandardModel2Output } from '../../llm/api.ts';
import type { PipelineContext } from './pipeline-context.ts';
import { WorkspaceInjectionRuntime } from './workspace-injection.ts';
import { composeChatToolRuntime } from './tool-runtime.ts';
import { MemoryFlushRecovery } from './memory-flush-recovery.ts';
import {
  claimNextPendingMemoryFlushWithConn, completeMemoryFlushWithConn,
  MEMORY_FLUSH_DRAIN_BATCH_SIZE, releaseMemoryFlushWithConn,
  saveMemoryFlushExtractionWithConn, skipPendingMemoryFlushesWithConn,
  updateMemoryFlushProgressWithConn,
} from '../repository/memory-flush.ts';
import type { FlushExtraction } from '../../memory/api.ts';
import { accumulateGoalUsage, createSessionMetadataRuntime, loadActiveGoalSummary, loadLearnerProfileBlock,
  loadProjectAgentsInstructions, loadUserProfile, recordRoundUsage, triggerAutoMemoryExtractionForTurn,
  type AgentsInstructionsPorts } from './execution-capabilities.ts';

/** L04 owner surface consumed by execution (repo.rs + session metadata, caller-owned connections). */
export interface ExecutionOwnerStore extends PipelineFinalStore, PipelineHistoryStore {
  loadSessionState(sessionId: string): SessionState | null;
  getToolFacePrefix(sessionId: string): ToolFacePrefixSnapshot | null;
  advanceToolFacePrefix(sessionId: string, snapshot: ToolFacePrefixSnapshot): void;
}
export const REQUIRED_OWNER_METHODS = [
  'buildUserMessage', 'createMessageWithConn', 'createBlockWithConn', 'getMessageBlocksWithConn',
  'listBlockPositionsWithConn', 'updateBlockReplayWithConn', 'getMessageWithConn', 'updateMessageWithConn',
  'getSessionMessageIdsWithConn', 'getMessagesByIdsWithConn', 'getHistoryBlocksWithReplayWithConn',
  'getActiveCompactionWithConn', 'getCompactionSummaryMessageIdsWithConn',
  'markAvailableSkillsSnapshotStaleWithConn', 'loadSessionState', 'getToolFacePrefix', 'advanceToolFacePrefix',
] as const satisfies readonly (keyof ExecutionOwnerStore)[];

/** Duck-typed against the injected L04 service; methods stay bound to the owner instance. */
export function resolveExecutionOwnerStore(owner: object): ExecutionOwnerStore {
  const record = owner as Record<string, unknown>;
  const missing = REQUIRED_OWNER_METHODS.filter(name => typeof record[name] !== 'function');
  if (missing.length > 0) {
    throw new ChatV2Error('Other', `chat pipeline execution requires the L04 chatSession owner API: missing ${missing.join(', ')}`);
  }
  const bound: Record<string, unknown> = {};
  for (const name of REQUIRED_OWNER_METHODS) bound[name] = (record[name] as (...args: unknown[]) => unknown).bind(owner);
  return bound as unknown as ExecutionOwnerStore;
}

/** types.rs:2610 SessionState::resolved_skill_state + SessionSkillState::from_legacy (serde defaults). */
export function resolvedSkillState(state: SessionState): SessionSkillState {
  const strings = (value: unknown): string[] | null =>
    Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : null;
  const parse = (raw: string | null | undefined): unknown => {
    if (raw == null) return undefined;
    try { return JSON.parse(raw) as unknown; } catch { return undefined; }
  };
  const structured = parse(state.skillStateJson);
  if (structured !== null && typeof structured === 'object' && !Array.isArray(structured)) {
    const value = structured as Record<string, unknown>;
    const field = (key: string) => value[key] === undefined ? [] : strings(value[key]);
    const fields = ['manualPinnedSkillIds', 'modeRequiredBundleIds', 'agenticSessionSkillIds', 'branchLocalSkillIds',
      'effectiveAllowedExternalServers'].map(field);
    const version = value.version === undefined ? 0 : value.version;
    const legacy = value.legacyMigrated;
    const validVersion = typeof version === 'number' && Number.isInteger(version) && version >= 0;
    if (fields.every(item => item !== null) && validVersion && (legacy === undefined || legacy === null || typeof legacy === 'boolean')) {
      return { manualPinnedSkillIds: fields[0]!, modeRequiredBundleIds: fields[1]!,
        agenticSessionSkillIds: fields[2]!, branchLocalSkillIds: fields[3]!, version: version as number };
    }
  }
  return { manualPinnedSkillIds: strings(parse(state.activeSkillIdsJson)) ?? [], modeRequiredBundleIds: [],
    agenticSessionSkillIds: strings(parse(state.loadedSkillIdsJson)) ?? [], branchLocalSkillIds: [], version: 0 };
}

/** helpers.rs:1303 load_effective_session_skill_state */
export function loadEffectiveSessionSkillState(store: Pick<ExecutionOwnerStore, 'loadSessionState'>,
  sessionId: string, options: PipelineContext['options'], log: Pick<Context['logger'], 'warn'>): SessionSkillState {
  const replayWithSnapshot = options.replayMode === 'original' && options.replaySkillContents != null;
  let state: SessionSkillState = { manualPinnedSkillIds: [], modeRequiredBundleIds: [], agenticSessionSkillIds: [],
    branchLocalSkillIds: [], version: 0 };
  if (!replayWithSnapshot) {
    try {
      const loaded = store.loadSessionState(sessionId);
      if (loaded !== null) state = resolvedSkillState(loaded);
    } catch (error) {
      log.warn(`[ChatV2::pipeline] Failed to load session skill state for transient injection: session_id=${sessionId}, error=${errorMessage(error)}`);
    }
  }
  if (options.activeSkillIds != null) {
    state = { ...state, manualPinnedSkillIds: [...new Set(options.activeSkillIds)].sort(compareUtf8) };
  }
  if (options.replaySkillContents != null && options.replayMode === 'original') {
    const pinned = new Set(state.manualPinnedSkillIds);
    state = { ...state, agenticSessionSkillIds: [...new Set(Object.keys(options.replaySkillContents)
      .filter(id => !pinned.has(id)))].sort(compareUtf8) };
  }
  return state;
}

/** helpers.rs:1034/1276 — process-lifetime memory baseline plus owner persistence. */
export class SessionToolFaceBaselines implements ToolFaceBaselineStore {
  private readonly orders = new Map<string, ToolFacePrefixSnapshot>();
  private readonly owner: () => Pick<ExecutionOwnerStore, 'getToolFacePrefix' | 'advanceToolFacePrefix'>;
  private readonly log: Pick<Context['logger'], 'warn'> & Partial<Pick<Context['logger'], 'info'>>;
  constructor(owner: () => Pick<ExecutionOwnerStore, 'getToolFacePrefix' | 'advanceToolFacePrefix'>,
    log: Pick<Context['logger'], 'warn'> & Partial<Pick<Context['logger'], 'info'>>) { this.owner = owner; this.log = log; }
  load(sessionId: string): ToolFacePrefixSnapshot {
    const existing = this.orders.get(sessionId);
    if (existing !== undefined) return structuredClone(existing);
    let persisted = emptyToolFacePrefixSnapshot();
    try { persisted = this.owner().getToolFacePrefix(sessionId) ?? emptyToolFacePrefixSnapshot(); }
    catch (error) {
      this.log.warn(`[ChatV2::pipeline] Failed to load persisted tool face prefix (fallback to fresh generation-0 baseline): session_id=${sessionId}, error=${errorMessage(error)}`);
    }
    return refillToolFaceBaseline(this.orders, sessionId, persisted);
  }
  storeOrder(sessionId: string, baseline: readonly string[]): void {
    const entry = this.orders.get(sessionId) ?? emptyToolFacePrefixSnapshot();
    mergeFrozenToolSchemaOrderBaseline(entry.order, baseline);
    this.orders.set(sessionId, entry);
    try { this.owner().advanceToolFacePrefix(sessionId, structuredClone(entry)); }
    catch (error) {
      this.log.warn(`[ChatV2::pipeline] Failed to persist frozen tool schema order (in-memory baseline still active): session_id=${sessionId}, error=${errorMessage(error)}`);
    }
  }
  /** helpers.rs:1110 converge_session_tool_face_prefix — the only generation bump point. */
  converge(sessionId: string, prefixes: readonly (readonly [number, ToolFacePrefixSnapshot])[]): ToolFacePrefixSnapshot {
    const ordered = [...prefixes].sort((a, b) => a[0] - b[0]);
    const converged: string[] = [];
    for (const [, snapshot] of ordered) mergeFrozenToolSchemaOrderBaseline(converged, snapshot.order);
    const startsWith = (order: readonly string[]) => order.length <= converged.length && order.every((name, i) => converged[i] === name);
    const trueFork = ordered.some(([, snapshot]) => !startsWith(snapshot.order));
    const candidates = ordered.filter(([, snapshot]) => snapshot.order.length === converged.length && startsWith(snapshot.order))
      .flatMap(([, snapshot]) => snapshot.schemaDigest === null ? [] : [snapshot.schemaDigest]);
    const digest = candidates.length > 0 && candidates.every(value => value === candidates[0]) ? candidates[0]! : null;
    const entry = this.orders.get(sessionId) ?? emptyToolFacePrefixSnapshot();
    mergeFrozenToolSchemaOrderBaseline(entry.order, converged);
    if (trueFork) {
      entry.generation += 1;
      this.log.info?.(`[ChatV2::pipeline] Tool face prefix fork detected at fan-out convergence: session_id=${sessionId}, new_generation=${entry.generation}, variants=${ordered.length}`);
    }
    if (digest !== null) entry.schemaDigest = digest;
    this.orders.set(sessionId, entry);
    const baseline = structuredClone(entry);
    try { this.owner().advanceToolFacePrefix(sessionId, baseline); }
    catch (error) {
      this.log.warn(`[ChatV2::pipeline] Failed to persist converged tool face prefix (in-memory baseline still active): session_id=${sessionId}, error=${errorMessage(error)}`);
    }
    return baseline;
  }
  clear(): void { this.orders.clear(); }
}

/** Optional owner capabilities: logged once per process when an owner has not published them. */
export class MissingCapabilityLog {
  private readonly seen = new Set<string>();
  private readonly log: Pick<Context['logger'], 'warn'>;
  constructor(log: Pick<Context['logger'], 'warn'>) { this.log = log; }
  note(capability: string, consequence: string): void {
    if (this.seen.has(capability)) return;
    this.seen.add(capability);
    this.log.warn(`[ChatV2::pipeline] owner capability unavailable: ${capability}; ${consequence}`);
  }
}

export interface ExecutionCompositionInput {
  ctx: Context;
  owner: ExecutionOwnerStore;
  toolFace: ToolFaceBaselineStore;
  missing: MissingCapabilityLog;
  resolveCanonicalImages(parts: readonly CanonicalContentPart[]): Promise<(ResolvedCanonicalImage | null)[]>;
  resolveSnapshot: ConstructorParameters<typeof PipelineHistoryLoader>[1]['resolveSnapshot'];
  compaction: CompactionRuntime | null;
  memoryFlushRecovery: MemoryFlushRecovery;
}

/** tool_loop.rs:3367 resolve_tool_authoring_config: frozen model first, then active; max_tokens only. */
async function resolveToolAuthoringConfig(llm: import('../../llm/api.ts').LLMManager, log: Context['logger'],
  execution: PipelineContext): Promise<ApiConfig | null> {
  const withMaxTokens = (config: ApiConfig) => {
    const copy = structuredClone(config);
    if (execution.options.maxTokens != null) copy.maxOutputTokens = execution.options.maxTokens;
    return copy;
  };
  const snapshot = execution.executionSnapshot;
  if (snapshot !== null) {
    const key = rustTrimId(snapshot.resolvedModelId);
    if (key !== null) {
      let configs: ApiConfig[] | null = null;
      try { configs = await llm.getApiConfigs(); }
      catch (error) {
        log.warn(`[ChatV2::pipeline] resolve_api_config_by_id: failed to load API configs (key=${key}): ${errorMessage(error)}; falling back to defaults`);
      }
      const found = configs?.find(config => config.id === key) ?? configs?.find(config => config.model === key);
      if (found !== undefined) return withMaxTokens(found);
    }
  }
  const active = await resolveActiveApiConfig(llm, execution);
  return active === null ? null : withMaxTokens(active);
}
const rustTrimId = (value: string) => { const trimmed = value.trim(); return trimmed === '' ? null : trimmed; };

function createBrowserScreenshotInjector(ctx: Context, log: Context['logger']) {
  return (
    results: readonly import('../../chat/api.ts').ToolResultInfo[],
    budget: { imageBudget: number; imagesInRequest: number },
  ) => buildBrowserScreenshotImageInjection(results, {
    imageBudget: budget.imageBudget,
    imagesInRequest: budget.imagesInRequest,
    readArtifactBytes: async (artifactPath: string): Promise<Uint8Array | null> => {
      const files = ctx.reflect.get('files', false) as Pick<FilesService, 'readBytes'> | undefined;
      if (files !== undefined) {
        try {
          return await files.readBytes(artifactPath, { maxBytes: MAX_BROWSER_SCREENSHOT_IMAGE_BYTES });
        } catch (error) {
          const kind = error !== null && typeof error === 'object' && 'kind' in error
            ? (error as { kind?: unknown }).kind : null;
          if (kind === 'TooLarge' || kind === 'NotFound') return null;
        }
      }
      try {
        return readAllBytes(artifactPath);
      } catch {
        // boundary-allow empty-catch: localFs unavailable on mobile or missing artifact
        return null;
      }
    },
    logger: log,
  });
}

/** Resolve the shared runtime, or bind L04/L05/L06 owners in this production composition root. */
function composeToolRounds(ctx: Context, missing: MissingCapabilityLog, persistence: PipelinePersistence,
  chatDb: () => import('../../../platform/storage/api.ts').DatabaseHandle): ToolRounds | null {
  const runtime = ctx.get('chatToolRuntime') ?? composeChatToolRuntime(ctx, missing);
  const llm = ctx.get('llm');
  if (runtime === null || !llm) {
    missing.note('chatToolRuntime (L03 composition of L04/L05/L06 owners)',
      'model tool calls end the turn with a Tool error');
    return null;
  }
  const log = ctx.logger;
  return new ToolRounds({ ...runtime, log,
    resolveToolAuthoringConfig: execution => resolveToolAuthoringConfig(llm, log, execution),
    finalizeTaskCompletion: execution => finalizeTaskCompletion(execution, ctx.chatSession, null, log),
    onTaskFinalized: execution => onTaskFinalized(chatDb(), { sessionId: execution.sessionId,
      assistantMessageId: execution.assistantMessageId, userMessageId: execution.userMessageId,
      startTime: execution.startedAtEpochMs, tokenUsage: { totalTokens: execution.tokenUsage.totalTokens },
      options: { skipUserMessageSave: execution.options.skipUserMessageSave ?? undefined,
        executionAllowedTools: execution.options.executionAllowedTools ?? undefined,
        schemaToolIds: execution.options.schemaToolIds ?? undefined },
      toolResults: execution.toolResults.map(result => ({ toolName: result.toolName, success: result.success,
        input: result.input, output: result.output })), logger: log }),
    saveIntermediateResultsWithRetry: (execution, stage) => persistence.saveIntermediateResultsWithRetry(execution, stage),
    buildRetrievalPageImageInjection: (results, budget) => buildRetrievalPageImageInjection(results, budget,
      ctx.get('vfs')?.database ?? null, ctx.get('vfsRepo')?.blobs ?? null, log),
    buildBrowserScreenshotImageInjection: createBrowserScreenshotInjector(ctx, log),
    resolveActiveApiConfig: execution => resolveActiveApiConfig(llm, execution),
  });
}

/** Binds compaction.rs owner calls; missing L04 methods fail before any compaction work. */
export function resolveCompactionOwnerStore(owner: object): CompactionOwnerStore {
  const record = owner as Record<string, unknown>;
  const missing = COMPACTION_OWNER_METHODS.filter(name => typeof record[name] !== 'function');
  if (missing.length > 0) {
    throw new ChatV2Error('Other', `compaction requires the L04 chatSession owner API: missing ${missing.join(', ')}`);
  }
  const bound: Record<string, unknown> = {};
  for (const name of COMPACTION_OWNER_METHODS) bound[name] = (record[name] as (...args: unknown[]) => unknown).bind(owner);
  return bound as unknown as CompactionOwnerStore;
}

/** One recovery state per pipeline (pipeline.rs:327–328); wired to L17 memory flush extraction & apply (RFC-001 M2). */
export function composeMemoryFlushRecovery(ctx: Context, missing: MissingCapabilityLog): MemoryFlushRecovery {
  const workerId = `flush_worker_${globalThis.crypto.randomUUID().slice(0, 8)}`;
  return new MemoryFlushRecovery({
    connection: () => ctx.chatSession.database.getConnSafe(),
    log: ctx.logger,
    drainClaimable: async (sessionId) => {
      const memory = ctx.get('memory');
      if (!memory || !ctx.get('vfs')) {
        missing.note('L03 memory-flush worker', 'memory/vfs service unavailable; pending flush rows stay queued');
        return false;
      }
      const chatDbHandle = ctx.chatSession.database.getConnSafe();
      try {
        if (memory.isPrivacyMode()) {
          skipPendingMemoryFlushesWithConn(chatDbHandle, sessionId, 'privacy mode', Date.now());
          return false;
        }
        if (memory.getAutoExtractFrequency() === 'off') {
          skipPendingMemoryFlushesWithConn(chatDbHandle, sessionId, 'auto extract off', Date.now());
          return false;
        }
      } catch (error) {
        ctx.logger.warn(`[compaction] memory flush policy check failed: ${errorMessage(error)}`);
        return false;
      }

      let processed = 0;
      for (let i = 0; i < MEMORY_FLUSH_DRAIN_BATCH_SIZE; i += 1) {
        const pending = claimNextPendingMemoryFlushWithConn(chatDbHandle, sessionId, workerId, Date.now());
        if (pending === null) break;
        try {
          let extraction: FlushExtraction;
          if (pending.extractionJson !== null && pending.extractionJson.trim() !== '') {
            extraction = JSON.parse(pending.extractionJson) as FlushExtraction;
          } else {
            extraction = await memory.extractCompactionSegment(pending.segmentText);
            saveMemoryFlushExtractionWithConn(
              chatDbHandle,
              pending.segmentId,
              workerId,
              JSON.stringify(extraction),
              Date.now(),
            );
          }

          await memory.applyFlushExtraction(extraction, {
            segmentId: pending.segmentId,
            sessionId: pending.sessionId,
            factsCompleted: pending.factsCompleted,
            activitiesCompleted: pending.activitiesCompleted,
            onProgress: (factsCompleted, activitiesCompleted) => {
              updateMemoryFlushProgressWithConn(
                chatDbHandle,
                pending.segmentId,
                workerId,
                factsCompleted,
                activitiesCompleted,
                Date.now(),
              );
            },
          });

          completeMemoryFlushWithConn(chatDbHandle, pending.segmentId, workerId, Date.now());
          try { memory.cleanupFlushReceipts(pending.segmentId); } catch { /* non-fatal */ }
          processed += 1;
        } catch (error) {
          const msg = errorMessage(error);
          ctx.logger.warn(`[compaction] memory flush drain failed for segment=${pending.segmentId}: ${msg}`);
          releaseMemoryFlushWithConn(chatDbHandle, pending.segmentId, workerId, msg, Date.now());
          break;
        }
      }
      if (processed > 0) {
        void memory.spawnPostWriteMaintenance().catch(() => undefined);
      }
      return processed >= MEMORY_FLUSH_DRAIN_BATCH_SIZE;
    },
  });
}

export function composeCompaction(ctx: Context, missing: MissingCapabilityLog,
  memoryFlushRecovery: MemoryFlushRecovery): CompactionDependencies {
  const llm = ctx.get('llm');
  if (!llm) throw new ChatV2Error('Other', 'compaction requires the llm service');
  const owner = resolveCompactionOwnerStore(ctx.chatSession);
  return {
    llm, owner, log: ctx.logger,
    connection: () => ctx.chatSession.database.getConnSafe(),
    summarize: (modelConfigId, prompt, sessionId): Promise<StandardModel2Output> => {
      const raw = ctx.get('llmRawPrompt');
      if (!raw) {
        missing.note('llmRawPrompt.callAgentCompactionRawPrompt', 'compaction summaries use the deterministic static fallback (manual compaction fails)');
        return Promise.reject(new Error('L02 llmRawPrompt service is not available'));
      }
      return raw.callAgentCompactionRawPrompt(modelConfigId, prompt, sessionId);
    },
    flushPendingMemorySegments: sessionId => memoryFlushRecovery.flushPendingSegments(sessionId),
  };
}

/** Builds pipeline.rs dependencies from the current service graph (per call; owners may appear later). */
export function composeExecution(input: ExecutionCompositionInput): ExecutionDependencies {
  const { ctx, owner, missing } = input;
  const log = ctx.logger;
  const llm = ctx.get('llm'), ocr = ctx.get('llmOcrModels'), streamEvents = ctx.get('llmStreamEvents');
  const streaming = ctx.get('llmModel2Streaming');
  if (!llm || !ocr || !streamEvents || !streaming) {
    throw new ChatV2Error('Other', 'chat pipeline execution requires llm, llmOcrModels, llmStreamEvents and llmModel2Streaming services');
  }
  const model2 = withRequestManifest(streaming, log, manifestHasherOf(ctx));
  const chatDb = () => ctx.chatSession.database.getConnSafe();
  const sessionMode = (sessionId: string): string | null => {
    try {
      return getSessionWithConn(chatDb(), sessionId)?.mode ?? null;
    } catch {
      return null;
    }
  };
  const readSetting = (key: string) => ctx.settings.get(key);
  const post: PipelinePostCommitEffects = {
    async incrementResourceRefs(ids) {
      if (ids.length === 0) return;
      const vfs = ctx.get('vfs'), repo = ctx.get('vfsRepo');
      if (!vfs || !repo) { log.warn('[ChatV2::pipeline] vfs_db not available, skipping increment_resource_refs'); return; }
      let conn;
      try { conn = vfs.database.getConnSafe(); }
      catch (error) { log.error(`[ChatV2::pipeline] Failed to get vfs.db connection for increment_resource_refs: ${errorMessage(error)}`); return; }
      for (const id of ids) {
        try { repo.resources.incrementRef(conn, id); }
        catch (error) { log.warn(`[ChatV2::pipeline] Failed to increment ref for resource ${id}: ${errorMessage(error)}`); }
      }
      log.debug(`[ChatV2::pipeline] Incremented refs for ${ids.length} resources in vfs.db: ${JSON.stringify(ids.slice(0, 3))}`);
    },
    triggerAutoMemoryExtraction(execution) {
      if (execution.cancellationToken?.()?.aborted) {
        log.debug('[AutoMemory] Turn cancelled, skipping auto-extraction');
        return;
      }
      if (execution.options.autoMemoryExtraction === false) {
        log.debug('[AutoMemory] Auto-extraction disabled for this turn, skipping');
        return;
      }
      if (execution.options.memoryEnabled === false) {
        log.debug('[AutoMemory] Session memory disabled, skipping auto-extraction');
        return;
      }
      const memory = ctx.get('memory');
      if (!ctx.get('vfs') || !memory) return;
      void triggerAutoMemoryExtractionForTurn(memory, log, execution.options.memoryEnabled, execution.userContent,
        execution.finalContent, execution.toolResults, 'AutoMemory');
    },
    onTurnCommitted(execution) {
      void onTurnCommitted(chatDb(), { sessionId: execution.sessionId, assistantMessageId: execution.assistantMessageId,
        userMessageId: execution.userMessageId, startTime: execution.startedAtEpochMs,
        tokenUsage: { totalTokens: execution.tokenUsage.totalTokens },
        options: { skipUserMessageSave: execution.options.skipUserMessageSave ?? undefined,
          executionAllowedTools: execution.options.executionAllowedTools ?? undefined,
          schemaToolIds: execution.options.schemaToolIds ?? undefined },
        toolResults: execution.toolResults.map(result => ({ toolName: result.toolName, success: result.success,
          input: result.input, output: result.output })), logger: log });
    },
  };
  const persistence = new PipelinePersistence(chatDb, owner, log);
  const finalPersistence = new PipelineFinalPersistence(chatDb, owner, post, log);
  const history = new PipelineHistoryLoader(owner, {
    getConnection: chatDb,
    getVfsConnection: () => ctx.get('vfs')?.database.getConnSafe() ?? null,
    resolveSnapshot: input.resolveSnapshot,
    extractDocument: (name, base64) => {
      const docs = ctx.get('docs');
      if (!docs) throw new Error('History document parsing requires docs service');
      return docs.extractTextFromBase64(name, base64);
    },
    logger: log,
  });
  // context_compiler.rs:721–859 owner calls: L02 llmRawPrompt (auxiliary MM) + llmOcrPages (dedicated OCR).
  const raw = ctx.get('llmRawPrompt'), ocrPages = ctx.get('llmOcrPages'), paths = ctx.get('paths');
  const compilePorts: ContextCompilationPorts = raw && ocrPages && paths
    ? bindContextCompilationPorts({
      callRawPromptWithConfigIdAndImagesCancellable: (configId, prompt, images, caller, signal) =>
        raw.callRawPromptWithConfigIdAndImagesCancellable(configId, prompt, images, caller, signal),
      callDedicatedOcrFreeTextWithFallback: (imagePath, signal) => ocrPages.callDedicatedOcrFreeTextWithFallback(imagePath, signal),
    }, parts => input.resolveCanonicalImages(parts), paths.os.temp, () => {
      const files = ctx.reflect.get('files', false) as Pick<FilesService, 'mkdir' | 'writeBytes' | 'rm'> | undefined;
      if (files === undefined) throw new Error('chat-pipeline 文件访问需要 files 服务');
      return files;
    })
    : {
      resolveCanonicalImages: parts => input.resolveCanonicalImages(parts),
      observeImages: async () => {
        missing.note('llmRawPrompt.callRawPromptWithConfigIdAndImagesCancellable', 'auxiliary multimodal observation falls back to OCR');
        throw new Error('auxiliary multimodal owner operation is not available');
      },
      ocrImage: async () => {
        missing.note('llmOcrPages.callDedicatedOcrFreeTextWithFallback', 'OCR fallback reports the image as unavailable');
        throw new Error('dedicated OCR owner operation is not available');
      },
    };
  compilePorts.prepareDeepseekDocuments = turn => prepareDeepseekDocuments(ctx, turn,
    () => owner.getMessageWithConn(chatDb(), turn.userMessageId));
  const rawPrompt = ctx.get('llmRawPrompt');
  const sessionMetadata = rawPrompt ? createSessionMetadataRuntime({ connection: chatDb, log,
    callTitle: (prompt, sessionId) => rawPrompt.callAgentChatTitleRawPrompt(prompt, sessionId) }) : null;
  if (sessionMetadata === null) missing.note('llmRawPrompt.callAgentChatTitleRawPrompt', 'session title/tags are not generated');
  const agentsPorts: AgentsInstructionsPorts = {
    connection: chatDb, log,
    workspaceRoot: () => {
      const roots = ctx.get('runtimeRoots');
      if (!roots) throw new Error('runtimeRoots service is not available');
      return roots.rootById('workspace', {}).path;
    },
    loadAgentsInstructions: root => ctx.chatSession.loadAgentsInstructions(root),
    isDirectory: path => ctx.get('runtimeRoots')?.isDirectory?.(path) ?? false,
    cwd: () => ctx.get('runtimeRoots')?.currentDir?.() ?? null,
  };
  const memoryPrompt = () => {
    const memory = ctx.get('memory');
    return memory && ctx.get('vfs') ? memory : null;
  };
  const backendSink: LlmStreamEventSink = { emit: (channel, payload) => ctx.backendEvents.emit(channel, payload) };
  const noopSink: LlmStreamEventSink = { emit() {} };
  const workspace = ctx.get('agentWorkspace');
  return {
    llm, ocr, streamEvents, model2, log, readSetting,
    toolFace: input.toolFace,
    loadEffectiveSkillState: (sessionId, options) => loadEffectiveSessionSkillState(owner, sessionId, options, log),
    recordUsage: record => {
      const usage = ctx.get('llmUsage');
      if (!usage) {
        missing.note('llmUsage.recordLlmUsageCacheExt', 'chat_v2 round usage is not written to the usage ledger');
        return;
      }
      recordRoundUsage(usage, record);
    },
    streamSinkFor: emitter => emitter.tryWindow() !== null ? backendSink : noopSink,
    toolRounds: composeToolRounds(ctx, missing, persistence, chatDb),
    workspace: workspace ? new WorkspaceInjectionRuntime(workspace, chatDb, ctx.chatSession, log) : null,

    persistence, finalPersistence, history, compilePorts,
    prompt: {
      canvasNote: async () => null,
      userProfile: async execution => {
        if (execution.options.memoryEnabled === false) return null;
        const memory = memoryPrompt();
        if (memory === null) return null;
        return loadUserProfile(memory, log, execution.sessionId, execution.options.memoryEnabled);
      },
      learnerProfile: execution => {
        if (execution.options.memoryEnabled === false) return null;
        const memory = memoryPrompt(), budget = ctx.get('injectionBudget');
        if (memory === null || !budget) return null;
        return loadLearnerProfileBlock(memory, budget, log, execution.options.memoryEnabled);
      },
      memoryKernel: async execution => {
        if (execution.options.memoryEnabled === false) {
          return { kernel: null, delta: null, handled: true };
        }
        const provider = ctx.get('memoryProvider');
        if (!provider || !ctx.get('vfs')) {
          return { kernel: null, delta: null, handled: false };
        }
        try {
          const conn = chatDb();
          const req = {
            sessionId: execution.sessionId,
            memoryEnabled: execution.options.memoryEnabled,
            mode: sessionMode(execution.sessionId),
          };
          const existing = getMemoryKernelSnapshotWithConn(conn, execution.sessionId);
          if (existing === null) {
            const fresh = provider.buildSessionSnapshot(req);
            const frozen = freezeMemoryKernelSnapshotWithConn(conn, execution.sessionId, fresh);
            return {
              kernel: frozen.renderedKernel !== '' ? frozen.renderedKernel : null,
              delta: null,
              handled: true,
            };
          }
          const delta = provider.buildSessionDelta(req, existing);
          return {
            kernel: existing.renderedKernel !== '' ? existing.renderedKernel : null,
            delta,
            handled: true,
          };
        } catch (error) {
          log.warn(`[ChatV2::pipeline] memoryKernel snapshot failed (session=${execution.sessionId}): ${errorMessage(error)}`);
          return { kernel: null, delta: null, handled: false };
        }
      },
      pluginExtensions: async execution => {
        const parts: string[] = [];
        const hooks = ctx.get('chatPipelineHooks');
        if (hooks) {
          const hooked = await hooks.runAugmentSystemPrompt({
            sessionId: execution.sessionId,
            mode: sessionMode(execution.sessionId),
            userContent: execution.userContent,
          });
          if (hooked) parts.push(hooked);
        }
        const declarativeAssets = (ctx.reflect?.get?.('declarativeAssets', false) ?? (ctx as unknown as Record<string, unknown>).declarativeAssets) as
          | import('./pipeline-hooks.ts').DeclarativeStudyPackAssetsLike
          | undefined;
        const packPrompt = formatDeclarativeStudyPackPrompt(declarativeAssets);
        if (packPrompt) parts.push(packPrompt);
        return parts.length > 0 ? parts.join('\n\n') : null;
      },
      agentsInstructions: execution => loadProjectAgentsInstructions(agentsPorts, execution.sessionId),
      activeGoal: sessionId => loadActiveGoalSummary(chatDb, log, sessionId),
      insightHints: execution => {
        const hints = ctx.get('insightHints');
        if (!hints || !ctx.get('vfs')) return null;
        try {
          return hints.existenceHints({ sessionId: execution.sessionId, userMessageId: execution.userMessageId,
            userContent: execution.userContent });
        } catch (error) {
          log.warn(`[ChatV2::pipeline] insight existence hints failed (session=${execution.sessionId}): ${errorMessage(error)}`);
          return null;
        }
      },
      rendererCapabilities: () => {
        let raw: string | null = null;
        try { raw = readSetting(RENDERER_CAPABILITIES_SETTING_KEY); } catch { raw = null; }
        return parseRendererCapabilities(raw);
      },
    },
    effects: {
      accumulateGoalUsage: (sessionId, emitter, tokens, elapsed) =>
        accumulateGoalUsage(chatDb, ctx.backendEvents, log, sessionId, emitter, tokens, elapsed),
      emitAnswerFinished: payload => {
        emitStudyEvent(ctx, 'study/answer-finished', payload);
        const hooks = ctx.get('chatPipelineHooks');
        if (hooks) {
          void hooks.runAfterReply({
            sessionId: payload.sessionId,
            messageId: payload.messageId,
            userContent: payload.question,
            assistantContent: payload.content,
            durationMs: payload.durationMs,
          }).catch(() => undefined);
        }
      },
    },
    sessionMetadata,
    compaction: input.compaction,
    canonicalVfsImages: null,
    superTurnOverrides: null,
    scheduleMemoryFlushRecovery: () => input.memoryFlushRecovery.scheduleRecovery(),
    windowEmitter: (window: WindowRef, sessionId, generation) =>
      ChatV2Emitter.withSink(Object.assign(new BackendEventsSink(ctx.backendEvents, log), { window: () => window }),
        sessionId).withStreamGeneration(generation),
    multiVariantEnabled: isMultiVariantEnabled,
    multiVariant: null,
  };
}

/** multi_variant.rs runtime: requires the L04 variant owner (createParallelExecutionManager). */
export function composeVariants(ctx: Context, owner: ExecutionOwnerStore, execution: ExecutionDependencies,
  toolFace: SessionToolFaceBaselines, missing: MissingCapabilityLog,
  compactForRequest: VariantDependencies['compactForRequest']): VariantDependencies {
  const service = ctx.chatSession as unknown as Record<string, unknown>;
  const create = service.createParallelExecutionManager;
  if (typeof create !== 'function') {
    throw new ChatV2Error('Other', `multi-variant execution requires the L04 chatSession owner API: missing ${VARIANT_OWNER_METHODS.join(', ')}`);
  }
  const log = ctx.logger;
  const variantDeps: VariantDependencies & {
    buildBrowserScreenshotImageInjection: ReturnType<typeof createBrowserScreenshotInjector>;
  } = {
    llm: execution.llm, ocr: execution.ocr, streamEvents: execution.streamEvents, model2: execution.model2, log,
    readSetting: execution.readSetting, owner,
    createManager: controller => (create as (c: AbortController) => VariantExecutionManager).call(ctx.chatSession, controller),
    history: execution.history, compilePorts: execution.compilePorts, toolFace,
    toolRounds: execution.toolRounds as ToolRounds | null,
    connection: () => ctx.chatSession.database.getConnSafe(),
    windowEmitter: execution.windowEmitter, streamSinkFor: execution.streamSinkFor,
    rendererCapabilities: execution.prompt.rendererCapabilities,
    loadEffectiveSkillState: execution.loadEffectiveSkillState,
    compactForRequest,
    buildRetrievalPageImageInjection: (results, budget) => buildRetrievalPageImageInjection(results, budget,
      ctx.get('vfs')?.database ?? null, ctx.get('vfsRepo')?.blobs ?? null, log),
    buildBrowserScreenshotImageInjection: createBrowserScreenshotInjector(ctx, log),
    incrementResourceRefsWithinSave: ids => {
      const vfs = ctx.get('vfs'), repo = ctx.get('vfsRepo');
      if (!vfs || !repo) { log.warn('[ChatV2::pipeline] Multi-variant: vfs_db not available, skipping increment refs'); return; }
      let conn;
      try { conn = vfs.database.getConnSafe(); }
      catch { log.warn('[ChatV2::pipeline] Multi-variant: failed to get vfs.db connection for increment refs'); return; }
      for (const id of ids) {
        try { repo.resources.incrementRef(conn, id); }
        catch (error) { log.warn(`[ChatV2::pipeline] Failed to increment ref for resource ${id}: ${errorMessage(error)}`); }
      }
      log.debug(`[ChatV2::pipeline] Multi-variant: incremented refs for ${ids.length} resources in vfs.db`);
    },
    triggerAutoMemoryExtraction: (memoryEnabled, userContent, assistantContent, toolResults) => {
      if (memoryEnabled === false) { log.debug('[AutoMemory::MultiVariant] Session memory disabled, skipping auto-extraction'); return; }
      const memory = ctx.get('memory');
      if (!ctx.get('vfs') || !memory) return;
      void triggerAutoMemoryExtractionForTurn(memory, log, memoryEnabled, userContent, assistantContent,
        toolResults, 'AutoMemory::MultiVariant');
    },
    updateSessionSkillState: (sessionId, state) => {
      const update = service.updateSessionSkillStateV2;
      if (typeof update !== 'function') {
        missing.note('chatSession.updateSessionSkillStateV2', 'retry skill-state restoration is skipped (Rust ignores its result)');
        return;
      }
      // Rust `let _ = ChatV2Repo::update_session_skill_state_v2(..)`: the outcome is discarded.
      try { (update as (id: string, value: unknown) => void).call(ctx.chatSession, sessionId, state); }
      catch { return; }
    },
    missing: (capability, consequence) => missing.note(capability, consequence),
  };
  return variantDeps;
}
