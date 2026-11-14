/** tool_loop.rs:1823–2442 (tool-call round) + 2781–3585 (execute_tool_calls / retry / execute_single_tool). */
import type { Context } from '@deepseek-ai/cordis';
import type { AdmittedToolDispatcher, ChatExecutionContext, ChatV2Emitter, ExecutionContext, ToolResultInfo } from '../../chat/api.ts';
import type { ApiConfig } from '../../llm/api.ts';
import type { JsonValue } from '../api.ts';
import { cloneAgentJson, preBudgetOutput } from '../../../kernel/agent-api.ts';
import type { McpToolSchema } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import type { PipelineContext } from './pipeline-context.ts';
import type { LegacyChatMessage } from './microcompact.ts';
import { ChatV2StreamingAdapter } from './llm-adapter.ts';
import { ApprovalGateHook, preflightBlockedResult, taskAuditAfterTool, type ApprovalGatePorts, type ToolHookContext } from './approval-gate.ts';
import { ToolAdmission } from './hooks.ts';
import {
  PARALLEL_TOOL_CONCURRENCY, TOOL_TRANSIENT_RETRY_BACKOFF_MS, annotateAutoRetry, isTransientToolError,
  mergeRoundResultsInCallOrder, pinToolResultToBlock, planParallelSegments, runBoundedOrdered,
} from './parallel-exec.ts';
import { orderToolCallsForExecution } from './tool-order.ts';
import { assignToolRoundReasoningItems, requiredFieldsForEmptyToolCall } from './tool-face.ts';
import { buildInLoopSkillMessages, skillBodyDigest } from './skill-injection.ts';
import { isLoadSkillsToolName } from './canonical-tools.ts';
import { canonicalImageBlobHashes, countRequestImages, RetrievalPageImageBudget } from './retrieval-images.ts';
import { estimateJsonTokens, shouldCompactAfterTool } from './compaction-budget.ts';
import { pushToolLimitBlock, type ToolRoundInput, type ToolRoundOutcome, type ToolRoundRunner } from './tool-loop.ts';

type Log = Pick<Context['logger'], 'info' | 'warn' | 'error' | 'debug'>;
export type ToolConcurrency = 'read_only' | 'safe_parallel' | 'serial';
export interface DispatchToolCall { id: string; name: string; arguments: JsonValue }

/** tool_loop.rs:3525–3555 ExecutionContext builder fields (L04 ChatExecutionContext owner). */
export interface ToolContextInit {
  sessionId: string; messageId: string; blockId: string; emitter: ChatV2Emitter; toolCallId: string;
  canvasNoteId: string | null; ragTopK: number | null; ragEnableReranking: boolean | null; variantId: string | null;
  skillStateVersion: number | null; roundId: string | null; executionAllowedTools: string[] | null;
  skillPackageRoots: Record<string, string> | null; questionAuthoringConfig: ApiConfig | null;
  shellGuardApproved: boolean; memoryEnabled: boolean; ragEnabled: boolean; webSearchEnabled: boolean;
  shellAuthorityAdmission: ChatExecutionContext['shell_authority_admission']; skillContents: Record<string, string> | null;
  skillEmbeddedTools: Record<string, McpToolSchema[]> | null; skillAdmissionErrors: Record<string, string> | null;
  cancellation: AbortSignal | null;
  /** tool_loop.rs:79 AdmittedToolDispatcher: child calls re-enter execute_single_tool. */
  dispatcher: (call: DispatchToolCall, child: ToolContextInit) => Promise<ToolResultInfo>;
  admittedDispatcher: AdmittedToolDispatcher;
}
/**
 * The tool face a runtime can actually serve. Only tools with an executable executor reach the
 * model: a schema whose call would end in `No executor found` is withheld instead of advertised.
 */
export interface ToolAdvertisement {
  /** injector.rs `inject_tool_schemas` over the executable executors' `SchemaToolRegistry` entries. */
  injectSchemaTools(ids: readonly string[] | null, llmContext: Map<string, unknown>): number;
  /** Builtin names need a specific executor; external MCP names need the General tail. */
  advertises(toolName: string): boolean;
}

/** L03-composed tool runtime (L04 registry/context + L05/L06 approval and policy owners).
 * Shared service or per-turn composition; L03 keeps every ordering/admission branch.
 */
export interface ChatToolRuntime {
  gate: ApprovalGatePorts;
  /** Absent for runtimes that predate it: tool schemas are then advertised as received. */
  advertisement?: ToolAdvertisement;
  concurrencyClass(toolName: string): ToolConcurrency;
  /** L04 ToolExecutorRegistry.execute against an L04 ChatExecutionContext built from `init`. */
  execute(call: DispatchToolCall, init: ToolContextInit): Promise<ToolResultInfo>;
  /** VfsFileRepo::get_file_with_conn existence (vfs_db None → null: Rust skips the check). */
  vfsFileExists(fileId: string): boolean | null;
  /** todo_executor get_todo_list + persist_todo_list (owner); no-op when the session has no list. */
  persistTodoList(sessionId: string, messageId: string): void;
}
export interface ToolExecutionPorts extends ChatToolRuntime {
  resolveToolAuthoringConfig(ctx: PipelineContext): Promise<ApiConfig | null>;
  finalizeTaskCompletion(ctx: PipelineContext): void;
  onTaskFinalized(ctx: PipelineContext): void;
  saveIntermediateResultsWithRetry(ctx: PipelineContext, stage: string): Promise<boolean>;
  buildRetrievalPageImageInjection(results: readonly ToolResultInfo[], budget: RetrievalPageImageBudget): LegacyChatMessage | null;
  resolveActiveApiConfig(ctx: PipelineContext): Promise<ApiConfig | null>;
  log: Log;
}

/** Who a tool round runs for: the single-variant turn or one parallel variant (variant_id set). */
export interface ToolCallScope {
  sessionId: string;
  messageId: string;
  variantId: string | null;
  options: PipelineContext['options'];
  cancellation: AbortSignal | null;
}
export function scopeOf(ctx: PipelineContext): ToolCallScope {
  return { sessionId: ctx.sessionId, messageId: ctx.assistantMessageId, variantId: null, options: ctx.options,
    cancellation: ctx.cancellationToken() };
}

const HEARTBEAT_TOOLS = ['coordinator_sleep', 'builtin-coordinator_sleep'];
const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;

function docType(name: string): { type: string; action: string } | null {
  const short = name.startsWith('builtin-') ? name.slice(8) : name.startsWith('mcp_') ? name.slice(4) : name;
  for (const type of ['pptx', 'xlsx', 'docx']) if (short.startsWith(`${type}_`)) return { type, action: short.slice(type.length + 1) };
  return null;
}

function attachRetryPayload(payload: unknown, retryAttempt: number): Record<string, unknown> {
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>), retry: true, retryAttempt };
  }
  return { retry: true, retryAttempt };
}

function wrapRetryEmitter(emitter: ChatV2Emitter, retryAttempt: number): ChatV2Emitter {
  const wrapped = Object.create(emitter) as ChatV2Emitter;
  wrapped.emitStart = (type, messageId, blockId, payload, variantId) =>
    emitter.emitStart(type, messageId, blockId, attachRetryPayload(payload, retryAttempt), variantId);
  wrapped.emitStartWithMeta = (type, messageId, blockId, payload, variantId, skillStateVersion, roundId) =>
    emitter.emitStartWithMeta(
      type, messageId, blockId, attachRetryPayload(payload, retryAttempt),
      variantId, skillStateVersion, roundId,
    );
  return wrapped;
}

export class ToolRounds implements ToolRoundRunner {
  private readonly ports: ToolExecutionPorts;
  private readonly gate: ApprovalGateHook;
  /** One dispatcher for the turn, including every nested executor invocation. */
  readonly admittedDispatcher: AdmittedToolDispatcher = {
    dispatchWithAdmission: (call, context) => this.executeSingleTool(
      { ...call, arguments: call.arguments as JsonValue }, this.initFromExecutionContext(context)),
  };
  private readonly dispatch = (call: DispatchToolCall, init: ToolContextInit) => this.executeSingleTool(call, init);
  constructor(ports: ToolExecutionPorts) { this.ports = ports; this.gate = new ApprovalGateHook(ports.gate, ports.log); }
  get advertisement(): ToolAdvertisement | null { return this.ports.advertisement ?? null; }

  /** tool_loop.rs:79–109: read the CHILD context, never capture the parent's admission or cancellation. */
  private initFromExecutionContext(context: ExecutionContext): ToolContextInit {
    return { sessionId: context.session_id, messageId: context.message_id, blockId: context.block_id,
      emitter: context.emitter as ChatV2Emitter, toolCallId: context.tool_call_id ?? '',
      canvasNoteId: context.canvas_note_id, ragTopK: context.rag_top_k, ragEnableReranking: context.rag_enable_reranking,
      variantId: context.variant_id, skillStateVersion: context.skill_state_version, roundId: context.round_id,
      executionAllowedTools: context.execution_allowed_tools, skillPackageRoots: context.skill_package_roots,
      questionAuthoringConfig: context.question_authoring_config ?? null,
      shellGuardApproved: false, shellAuthorityAdmission: null,
      memoryEnabled: context.memory_enabled, ragEnabled: context.rag_enabled, webSearchEnabled: context.web_search_enabled,
      skillContents: context.skill_contents, skillEmbeddedTools: context.skill_embedded_tools,
      skillAdmissionErrors: context.skill_admission_errors, cancellation: context.cancellation_token,
      dispatcher: this.dispatch, admittedDispatcher: this.admittedDispatcher };
  }

  /** tool_loop.rs:1823–2442 */
  async run(input: ToolRoundInput): Promise<ToolRoundOutcome> {
    const { ctx, emitter, adapter, toolCalls, recursionDepth, state } = input;
    const { log } = this.ports;
    const currentReasoning = adapter.getAccumulatedReasoning();
    const roundContent = adapter.getAccumulatedContent();
    ctx.collectStreamedTextSegments(adapter.getTextSegments(), ctx.assistantMessageId);
    adapter.finalizeAll();
    ctx.pendingReasoningForApi = currentReasoning;
    log.debug(`[ChatV2::pipeline] Interleaved: collected thinking block for round ${recursionDepth}, total blocks=${ctx.interleavedBlockIds.length}, pending_reasoning=${ctx.pendingReasoningForApi?.length ?? 0}`);
    if (await this.ports.saveIntermediateResultsWithRetry(ctx, 'pre-tool-execution') && ctx.interleavedBlocks.length > 0) {
      log.info(`[ChatV2::pipeline] Pre-tool intermediate save completed, blocks=${ctx.interleavedBlockIds.length}`);
    }
    const roundId = `tool-round-${recursionDepth}`;
    const calls: DispatchToolCall[] = toolCalls.map(call => ({ id: call.id, name: call.name, arguments: call.arguments as JsonValue }));
    const toExecute: DispatchToolCall[] = [];
    const synthetic: ToolResultInfo[] = [];
    const currentEmpty = new Set<string>();
    for (const call of calls) {
      const required = requiredFieldsForEmptyToolCall(call, input.frozenToolSchemas);
      if (required === null) { toExecute.push(call); continue; }
      currentEmpty.add(call.name);
      const blockId = ChatV2StreamingAdapter.generateBlockId();
      const message = `Tool '${call.name}' returned empty arguments but requires: ${required.join(', ')}. The tool was not executed; retry with complete arguments.`;
      emitter.emitStartWithMeta('tool_call', ctx.assistantMessageId, blockId,
        { toolName: call.name, toolInput: call.arguments, toolCallId: call.id }, null, ctx.options.skillStateVersion, roundId);
      emitter.emitErrorWithMeta('tool_call', blockId, message, null, ctx.options.skillStateVersion, roundId);
      synthetic.push({ toolCallId: call.id, blockId, toolName: call.name, input: call.arguments,
        output: { error: message }, success: false, error: message });
    }
    const stopAfterRepeat = [...currentEmpty].some(name => state.previousEmptyRequiredTools.has(name));
    state.previousEmptyRequiredTools = currentEmpty;
    const executed = toExecute.length === 0 ? [] : await this.executeToolCalls(toExecute, emitter, scopeOf(ctx), roundId,
      await this.ports.resolveToolAuthoringConfig(ctx), input.mcpToolNameMapping);
    const results = mergeRoundResultsInCallOrder(calls, executed, synthetic);
    log.info(`[ChatV2::pipeline] Tool execution completed: ${results.filter(r => r.success).length}/${results.length} succeeded`);

    for (const result of results) {
      if (!isLoadSkillsToolName(result.toolName) || !result.success) continue;
      // RUST-FIX(RF-W02-loaded-skill-ids-truncation): read ids from the pre-budget output; tool_loop.rs:2016
      // reads the budgeted one and loses them once the result degrades to a JSON preview.
      const inner = field(preBudgetOutput(result), 'result');
      const ids = field(inner, 'loaded_skill_ids') ?? field(inner, 'skill_ids');
      if (!Array.isArray(ids)) continue;
      const loaded = ids.filter((id): id is string => typeof id === 'string');
      if (loaded.length === 0) continue;
      const embedded = ctx.options.skillEmbeddedTools;
      if (embedded != null) {
        const fresh = loaded.flatMap(id => embedded[id] ?? []);
        if (fresh.length > 0) {
          const schemas = (ctx.options.mcpToolSchemas ??= []) as McpToolSchema[];
          const before = schemas.length;
          const existing = new Set(schemas.map(tool => tool.name));
          let added = 0;
          for (const tool of fresh) if (!existing.has(tool.name)) { schemas.push(tool); added++; }
          if (added > 0) log.info(`[ChatV2::pipeline] 🆕 Progressive disclosure: added ${added} tools from skills ${JSON.stringify(loaded)}, total tools: ${before} -> ${schemas.length}`);
        }
      }
      const anchor = result.toolCallId;
      if (anchor == null || anchor === '') continue;
      const contents = new Map(Object.entries(ctx.options.replaySkillContents ?? ctx.options.skillContents ?? {}));
      const dependencies = ctx.options.skillDependencies == null ? null : new Map(Object.entries(ctx.options.skillDependencies));
      const batch = buildInLoopSkillMessages(loaded, contents, dependencies, ctx.options.contextLimit ?? null,
        state.injectedSkillIds, ctx.options.skillStateVersion ?? 0);
      state.cumulativeSkillAudit.missingSkillIds.push(...batch.audit.missingSkillIds);
      state.cumulativeSkillAudit.droppedSkillIds.push(...batch.audit.droppedSkillIds);
      if (batch.audit.injectedSkillIds.length === 0) continue;
      for (const id of batch.audit.injectedSkillIds) state.injectedSkillIds.add(id);
      state.cumulativeSkillAudit.injectedSkillIds.push(...batch.audit.injectedSkillIds);
      state.cumulativeSkillAudit.estimatedTokens += batch.audit.estimatedTokens;
      const anchors = ctx.options.skillInjectionAnchors ??= { beforeTurnUser: false };
      const roundLast = results.at(-1)?.toolCallId;
      const roundLastId = roundLast == null || roundLast === '' ? null : roundLast;
      (anchors.toolAnchored ??= []).push({ toolCallId: anchor, skillIds: [...batch.audit.injectedSkillIds],
        roundLastToolCallId: roundLastId });
      for (const id of batch.audit.injectedSkillIds) {
        const body = contents.get(id);
        if (body !== undefined) (anchors.skillContentDigests ??= {})[id] = skillBodyDigest(id, body);
      }
      log.info(`[ChatV2::pipeline] P1-8: anchored ${batch.audit.injectedSkillIds.length} in-loop skill(s) after load_skills tool_call_id=${anchor}`);
      state.inLoopSkillBatches.push([anchor, roundLastId, batch.messages]);
    }
    for (const result of results) ctx.addToolBlock(result, ctx.assistantMessageId);
    log.debug(`[ChatV2::pipeline] Interleaved: added ${results.length} tool blocks, total blocks=${ctx.interleavedBlockIds.length}`);
    const taskCompleted = results.some(r => field(r.output, 'task_completed') === true);
    const heartbeat = results.some(r => HEARTBEAT_TOOLS.includes(r.toolName) && field(r.output, 'continue_execution') === true);
    ctx.lastRoundHeartbeat = heartbeat;
    if (heartbeat) log.info('[ChatV2::pipeline] Heartbeat detected from whitelisted tool, will bypass configured recursion limit');
    if (results.some(r => r.toolName.includes('todo_'))) this.ports.persistTodoList(ctx.sessionId, ctx.assistantMessageId);

    const signature = adapter.getThoughtSignature();
    const pending = ctx.pendingReasoningForApi;
    const withReasoning = results.map((result, index) => index === 0
      ? { ...result, reasoningContent: pending, thoughtSignature: signature } : result);
    const firstId = withReasoning[0]?.toolCallId;
    assignToolRoundReasoningItems(ctx.responseReasoningByToolCallId as Map<string, JsonValue>,
      adapter.getResponseReasoningItems() as [string | null, JsonValue][], firstId == null || firstId === '' ? null : firstId);
    if (roundContent !== '' && firstId != null && firstId !== '') ctx.roundTextByToolCallId.set(firstId, roundContent);
    const snapshot = ctx.executionSnapshot;
    if (snapshot !== null && snapshot.resolvedModelIsMultimodal) {
      const lastId = withReasoning.at(-1)?.toolCallId;
      if (lastId != null && lastId !== '') {
        if (state.retrievalPageImageBudget === null) {
          let images = countRequestImages(ctx.chatHistory);
          if (ctx.options.isContinue !== true && ctx.compiledCurrentUserMessage !== null) {
            images += countRequestImages([ctx.compiledCurrentUserMessage]);
          }
          state.retrievalPageImageBudget = new RetrievalPageImageBudget(snapshot.generationPlan.imageBudget, images,
            canonicalImageBlobHashes(ctx.canonicalContent));
        }
        const page = this.ports.buildRetrievalPageImageInjection(withReasoning,
          state.retrievalPageImageBudget as RetrievalPageImageBudget);
        if (page !== null) state.retrievalPageImageBatches.push([lastId, page]);
      }
    }
    ctx.addToolResults(withReasoning);
    if (stopAfterRepeat) {
      const message = '模型连续返回缺少必填参数的空工具调用，已停止自动续轮。请重试或改用其他模型。';
      pushToolLimitBlock(ctx, emitter, message, { content: message, reason: 'repeated_empty_required_arguments' }, log);
    }
    if (!ctx.needsCompaction) {
      const config = await this.ports.resolveActiveApiConfig(ctx);
      const delta = ctx.toolResults.slice(-results.length).reverse()
        .reduce((sum, r) => (sum + estimateJsonTokens(r.output, ctx.options.modelId)) >>> 0, 0);
      if (shouldCompactAfterTool({ tokenUsage: ctx.tokenUsage, options: ctx.options }, config, delta)) ctx.needsCompaction = true;
    }
    if (await this.ports.saveIntermediateResultsWithRetry(ctx, 'post-tool-execution')) {
      log.info(`[ChatV2::pipeline] Intermediate save completed after tool round ${recursionDepth}, blocks=${ctx.interleavedBlockIds.length}`);
    }
    if (stopAfterRepeat) { ctx.pendingReasoningForApi = null; return 'return'; }
    input.injectWorkspaceMessages();
    if (taskCompleted) {
      log.info(`[ChatV2::pipeline] Task completed detected via attempt_completion, stopping recursive loop at depth=${recursionDepth}`);
      this.ports.finalizeTaskCompletion(ctx);
      this.ports.onTaskFinalized(ctx);
      ctx.collectStreamedTextSegments(adapter.getTextSegments(), ctx.assistantMessageId);
      ctx.pendingReasoningForApi = null;
      return 'return';
    }
    return 'continue';
  }

  /** tool_loop.rs:2781 execute_tool_calls */
  async executeToolCalls(calls: readonly DispatchToolCall[], emitter: ChatV2Emitter, scope: ToolCallScope,
    roundId: string, authoring: ApiConfig | null,
    mapping: ReadonlyMap<string, { rawToolName: string; preferredServerId: string | null }>): Promise<ToolResultInfo[]> {
    const { log } = this.ports;
    const mapped = calls.map(call => {
      const route = mapping.get(call.name);
      if (route === undefined) return call;
      log.debug(`[ChatV2::pipeline] Reverse-mapping tool name: ${call.name} → ${route.rawToolName}`);
      const args = cloneAgentJson(call.arguments);
      if (route.preferredServerId !== null && args !== null && typeof args === 'object' && !Array.isArray(args)) {
        args._serverId = route.preferredServerId;
      }
      return { id: call.id, name: route.rawToolName, arguments: args };
    });
    const ordered = orderToolCallsForExecution(mapped) as DispatchToolCall[];
    const flags = ordered.map(call => this.isParallelEligible(call));
    const segments = planParallelSegments(flags);
    log.debug(`[ChatV2::pipeline] Executing ${ordered.length} tool calls in ${segments.length} segment(s), ${flags.filter(Boolean).length} parallel-eligible`);
    const created = new Map<string, string>();
    const results: ToolResultInfo[] = [];
    for (const [parallel, range] of segments) {
      const batch = ordered.slice(range.start, range.end);
      if (parallel) {
        if (batch.length > 1) log.info(`[ChatV2::pipeline] ⚡ Executing ${batch.length} parallel-safe tools concurrently (limit=${PARALLEL_TOOL_CONCURRENCY}): ${JSON.stringify(batch.map(call => call.name))}`);
        results.push(...await runBoundedOrdered(batch.map(call => () => {
          const fixed = this.fixupDocumentResourceId(call, created) ?? call;
          return this.executeWithTransientRetry(fixed, this.ports.concurrencyClass(fixed.name) === 'read_only',
            emitter, scope, roundId, authoring);
        }), PARALLEL_TOOL_CONCURRENCY));
        continue;
      }
      for (const call of batch) {
        if (field(call.arguments, '_truncation_error') === true) {
          const errorMessage = typeof field(call.arguments, '_error_message') === 'string'
            ? field(call.arguments, '_error_message') as string : '工具调用参数被截断';
          const rawLen = field(call.arguments, '_args_len');
          const argsLen = typeof rawLen === 'number' && Number.isInteger(rawLen) && rawLen >= 0 ? rawLen : 0;
          log.warn(`[ChatV2::pipeline] 工具调用 JSON 被截断，跳过执行并反馈 LLM 重试: tool=${call.name}, args_len=${argsLen}`);
          const blockId = ChatV2StreamingAdapter.generateBlockId();
          emitter.emitStartWithMeta('tool_call', scope.messageId, blockId, { toolName: call.name,
            toolInput: { _truncated: true, _args_len: argsLen }, toolCallId: call.id }, scope.variantId, scope.options.skillStateVersion, roundId);
          emitter.emitErrorWithMeta('tool_call', blockId, `工具调用 ${call.name} 的参数因输出长度超限被截断（已生成 ${argsLen} 字符），工具未执行，正在自动重试。`,
            scope.variantId, scope.options.skillStateVersion, roundId);
          const hint = `CRITICAL ERROR: Tool call '${call.name}' FAILED — your output was truncated at ${argsLen} characters because it exceeded the max_tokens limit. The JSON arguments were incomplete and the tool was NOT executed.\n\nYOU MUST retry with significantly smaller arguments. Mandatory rules:\n1. Reduce the total argument size to under 50% of the previous attempt.\n2. For mindmap_create: create only the skeleton (top-level branches + minimal children), then use edit_nodes to add details incrementally.\n3. For any tool: remove verbose text, avoid deeply nested structures, keep JSON compact.\n4. If the content is inherently large, split it into multiple smaller tool calls.\n\nDo NOT repeat the same call with the same size — it will fail again.`;
          results.push({ toolCallId: call.id, blockId, toolName: call.name, input: call.arguments,
            output: { error: errorMessage }, success: false, error: hint });
          continue;
        }
        const target = this.fixupDocumentResourceId(call, created) ?? call;
        const info = await this.executeWithTransientRetry(target, false, emitter, scope, roundId, authoring);
        if (info.success) this.captureCreatedFileId(target.name, info.output, created);
        results.push(info);
      }
    }
    return results;
  }

  /** tool_loop.rs:3071 + hooks.rs:1153 tool_may_require_approval */
  private isParallelEligible(call: DispatchToolCall): boolean {
    if (field(call.arguments, '_truncation_error') === true) return false;
    if (this.ports.concurrencyClass(call.name) === 'serial') return false;
    const base = this.ports.gate.baseSensitivity(call.name, call.arguments);
    return this.ports.gate.effectiveSensitivity(base, call.name, call.arguments) === 'low';
  }

  /** tool_loop.rs:3101 */
  private async executeWithTransientRetry(call: DispatchToolCall, allowRetry: boolean, emitter: ChatV2Emitter,
    scope: ToolCallScope, roundId: string, authoring: ApiConfig | null): Promise<ToolResultInfo> {
    const { log } = this.ports;
    let retries = 0;
    const blockId = ChatV2StreamingAdapter.generateBlockId();
    const signal = scope.cancellation;
    for (;;) {
      let info: ToolResultInfo;
      const attemptEmitter = retries > 0 ? wrapRetryEmitter(emitter, retries) : emitter;
      try {
        info = pinToolResultToBlock(await this.executeSingleTool(call, this.initFor(scope, attemptEmitter, call, blockId, roundId, authoring)), blockId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`[ChatV2::pipeline] Unexpected tool call error for ${call.name}: ${message}`);
        info = { toolCallId: call.id, blockId, toolName: call.name, input: call.arguments, output: null, success: false, error: message };
      }
      if (info.success || !allowRetry || retries >= TOOL_TRANSIENT_RETRY_BACKOFF_MS.length) return annotateAutoRetry(info, retries);
      const errorText = info.error ?? '';
      if (!isTransientToolError(errorText) || signal?.aborted) return annotateAutoRetry(info, retries);
      const backoff = TOOL_TRANSIENT_RETRY_BACKOFF_MS[retries]!;
      retries += 1;
      log.info(`[ChatV2::pipeline] 🔁 Read-only tool ${call.name} hit transient failure, auto-retrying (${retries}/${TOOL_TRANSIENT_RETRY_BACKOFF_MS.length}) after ${backoff}ms: ${errorText}`);
      const cancelled = await new Promise<boolean>(resolve => {
        const abort = () => { clearTimeout(timer); resolve(true); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(false); }, backoff);
        signal?.addEventListener('abort', abort, { once: true });
      });
      if (cancelled) {
        log.info(`[ChatV2::pipeline] Auto-retry aborted by cancellation: ${call.name}`);
        return annotateAutoRetry(info, retries - 1);
      }
    }
  }

  private initFor(scope: ToolCallScope, emitter: ChatV2Emitter, call: DispatchToolCall, blockId: string, roundId: string,
    authoring: ApiConfig | null): ToolContextInit {
    const options = scope.options;
    return { sessionId: scope.sessionId, messageId: scope.messageId, blockId, emitter, toolCallId: call.id,
      canvasNoteId: options.canvasNoteId ?? null, ragTopK: options.ragTopK ?? null,
      ragEnableReranking: options.ragEnableReranking ?? null, variantId: scope.variantId,
      skillStateVersion: options.skillStateVersion ?? null, roundId,
      executionAllowedTools: options.executionAllowedTools ?? null, skillPackageRoots: options.skillPackageRoots ?? null,
      questionAuthoringConfig: authoring, shellGuardApproved: false, memoryEnabled: options.memoryEnabled ?? true,
      ragEnabled: options.ragEnabled ?? true, webSearchEnabled: options.webSearchEnabled ?? true,
      shellAuthorityAdmission: null, skillContents: options.skillContents ?? null,
      skillEmbeddedTools: (options.skillEmbeddedTools ?? null) as Record<string, McpToolSchema[]> | null,
      skillAdmissionErrors: options.skillAdmissionErrors ?? null, cancellation: scope.cancellation,
      dispatcher: this.dispatch, admittedDispatcher: this.admittedDispatcher };
  }

  /** tool_loop.rs:3409 execute_single_tool (also the AdmittedToolDispatcher entry). */
  async executeSingleTool(call: DispatchToolCall, init: ToolContextInit): Promise<ToolResultInfo> {
    const { log } = this.ports;
    log.debug(`[ChatV2::pipeline] Executing tool via ExecutorRegistry: name=${call.name}, id=${call.id}`);
    const hook: ToolHookContext = { toolCall: call, blockId: init.blockId, emitter: init.emitter, sessionId: init.sessionId,
      messageId: init.messageId, variantId: init.variantId, skillStateVersion: init.skillStateVersion, roundId: init.roundId,
      skillPackageRoots: init.skillPackageRoots, executionAllowedTools: init.executionAllowedTools,
      cancellation: init.cancellation, memoryEnabled: init.memoryEnabled, ragEnabled: init.ragEnabled,
      webSearchEnabled: init.webSearchEnabled };
    const admission = ToolAdmission.create(call.arguments);
    const gated = await this.gate.beforeTool(hook, admission);
    if (gated.kind === 'block') return gated.result;
    const authority = admission.authorityAdmission();
    const contextInit: ToolContextInit = { ...init, toolCallId: call.id, shellGuardApproved: admission.shellGuardAdmitted(),
      shellAuthorityAdmission: authority === null ? null : [authority[0], authority[1]],
      dispatcher: this.dispatch, admittedDispatcher: this.admittedDispatcher };
    init.emitter.registerBlockEventMeta(init.blockId, init.variantId, init.skillStateVersion, init.roundId);
    const killed = this.ports.gate.killSwitchError();
    if (killed !== null) return preflightBlockedResult(hook, this.ports.gate, killed);
    if (init.cancellation?.aborted) return preflightBlockedResult(hook, this.ports.gate, '流已取消，工具执行中止');
    let result: ToolResultInfo;
    try { result = await this.ports.execute(call, contextInit); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      init.emitter.emitErrorWithMeta('tool_call', init.blockId, message, init.variantId, init.skillStateVersion, init.roundId);
      log.error(`[ChatV2::pipeline] Executor error for tool ${call.name}: ${message}`);
      return { toolCallId: call.id, blockId: init.blockId, toolName: call.name,
        input: this.ports.gate.redactForDisplay(call.name, call.arguments), output: null, success: false, error: message };
    }
    taskAuditAfterTool(hook, admission, result, log);
    return result;
  }

  /** tool_loop.rs:3241 */
  private fixupDocumentResourceId(call: DispatchToolCall, created: ReadonlyMap<string, string>): DispatchToolCall | null {
    if (created.size === 0) return null;
    const kind = docType(call.name);
    if (kind === null || kind.action === 'create') return null;
    const resourceId = field(call.arguments, 'resource_id');
    if (typeof resourceId !== 'string') return null;
    const actual = created.get(kind.type);
    if (actual === undefined || resourceId === actual) return null;
    if (this.ports.vfsFileExists(resourceId) === true) return null;
    const args = cloneAgentJson(call.arguments) as Record<string, JsonValue>;
    if (args !== null && typeof args === 'object' && !Array.isArray(args)) args.resource_id = actual;
    this.ports.log.info(`[ChatV2::pipeline] 🔧 资源ID修正: ${call.name} 的 resource_id '${resourceId}' → '${actual}' (同批次 ${kind.type}_create 返回)`);
    return { ...call, arguments: args };
  }

  /** tool_loop.rs:3318 */
  private captureCreatedFileId(name: string, output: unknown, created: Map<string, string>): void {
    const kind = docType(name);
    if (kind === null || kind.action !== 'create') return;
    const direct = field(output, 'file_id');
    const nested = field(field(output, 'result'), 'file_id');
    const id = typeof direct === 'string' ? direct : typeof nested === 'string' ? nested : null;
    if (id === null) return;
    this.ports.log.info(`[ChatV2::pipeline] 📦 捕获 ${kind.type}_create 返回的 file_id: ${id}`);
    created.set(kind.type, id);
  }
}
