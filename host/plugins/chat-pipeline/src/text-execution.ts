/** Single prepared text turn: pipeline.rs success/cancel/error lifetime + no-tool stream round.
 * This is an explicit internal stage, not a substitute for execute's model/context/tool planning.
 */
import type { Context } from '@deepseek-ai/cordis';
import { ChatV2Error, type ChatV2Emitter, type TokenUsage, type MessageSources } from '../../chat/api.ts';
import type { ApiConfig, LLMManager, LlmStreamEvents, LlmStreamHooks } from '../../llm/api.ts';
import type { PipelineContext } from './pipeline-context.ts';
import type { PipelinePersistence } from './incremental-persistence.ts';
import type { PipelineFinalPersistence } from './final-persistence.ts';
import type { PipelineHistoryLoader } from './history-loader.ts';
import type { LegacyChatMessage } from './microcompact.ts';
import { ChatV2StreamingAdapter } from './llm-adapter.ts';
import { bindStreamingSink } from './stream-sink.ts';
import { StreamHooksGuard } from './stream-hooks-guard.ts';
import { buildRunScopedStreamEvent, isRetryableLlmError } from './parallel-exec.ts';
import { accumulate, fromEstimate } from './token-usage.ts';
import { estimateTokensWithModel } from './token-budget.ts';
import { utf8ByteLength } from '../../../platform/util/index.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { parseU64 } from './budget.ts';
import { runStreamWithWatchdog } from './stream-watchdog.ts';

/** L02 unified stream adapter port. Production binding uses llmModel2Streaming, never singleShot. */
export interface UnifiedTextStream {
  call(request: { config: ApiConfig; messages: readonly LegacyChatMessage[]; systemPrompt: string;
    streamEvent: string; messageId: string; options: PipelineContext['options']; signal: AbortSignal;
    hooks: LlmStreamHooks; disableTools: true; sources?: MessageSources; compactionChecked?: boolean }): Promise<{ cancelled: boolean; assistantMessage: string }>;
}
export interface TextExecutionEffects {
  recordUsage(ctx: PipelineContext, usage: TokenUsage | null, success: boolean, error: string | null): void;
  accumulateGoalUsage(ctx: PipelineContext, emitter: ChatV2Emitter): void;
  scheduleSessionMetadata(ctx: PipelineContext, emitter: ChatV2Emitter): Promise<void>;
}
export interface PreparedTextTurn {
  execution: PipelineContext;
  config: ApiConfig;
  systemPrompt: string;
  /** Explicit no-tool stage; the full execute dispatcher must not route tool turns here. */
  disableTools: true;
}
export interface TextExecutionDependencies {
  persistence: PipelinePersistence;
  finalPersistence: PipelineFinalPersistence;
  history: PipelineHistoryLoader;
  stream: UnifiedTextStream;
  effects: TextExecutionEffects;
}
type Log = Pick<Context['logger'], 'info' | 'warn' | 'error' | 'debug'>;
const message = (error: unknown) => error instanceof Error ? error.message
  : error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message : String(error);

export class TextTurnExecution {
  private readonly deps: TextExecutionDependencies;
  private readonly events: LlmStreamEvents;
  private readonly manager: LLMManager;
  private readonly log: Log;
  private readonly readSetting: (key: string) => string | null;
  constructor(deps: TextExecutionDependencies, events: LlmStreamEvents, manager: LLMManager, log: Log,
    readSetting: (key: string) => string | null) {
    this.deps = deps; this.events = events; this.manager = manager; this.log = log;
    this.readSetting = readSetting;
  }

  /** Caller has frozen the config and compiled the current text message; no tool loop is registered here. */
  async execute(turn: PreparedTextTurn, emitter: ChatV2Emitter, signal: AbortSignal): Promise<string> {
    const ctx = turn.execution;
    ctx.setCancellationToken(signal);
    const assistantId = ctx.assistantMessageId;
    emitter.emitStreamStart(assistantId, ctx.modelDisplayName);
    this.log.info(`[ChatV2::pipeline] Starting pipeline for session=${ctx.sessionId}, assistant_msg=${assistantId}`);
    if (!(ctx.options.skipUserMessageSave ?? false)) {
      try {
        await this.deps.persistence.saveUserMessageImmediately(ctx);
        this.log.info(`[ChatV2::pipeline] User message saved immediately: id=${ctx.userMessageId}`);
      } catch (error) { this.log.error(`[ChatV2::pipeline] Failed to save user message immediately (will rely on save_results as fallback): ${message(error)}`); }
    }
    try {
      if (signal.aborted) throw new ChatV2Error('Cancelled');
      await this.deps.history.loadChatHistory(ctx);
      if (signal.aborted) throw new ChatV2Error('Cancelled');
      try { this.deps.persistence.persistUserLlmContentEarly(ctx); }
      catch (error) { this.log.warn(`[ChatV2::pipeline] persist_user_llm_content_early failed (non-fatal, later save points may retry when the target block exists): session=${ctx.sessionId}, err=${message(error)}`); }
      await this.streamRound(turn, emitter, signal);
      await this.deps.finalPersistence.saveResults(ctx);
    } catch (error) {
      const cancelled = error instanceof ChatV2Error && error.kind === 'Cancelled';
      if (cancelled) this.log.info(`[ChatV2::pipeline] Pipeline cancelled for session=${ctx.sessionId}, attempting to save partial results...`);
      else this.log.error(`[ChatV2::pipeline] Pipeline error for session=${ctx.sessionId}: ${message(error)}, attempting to save partial results...`);
      this.collectPartial(ctx);
      const reason = cancelled ? 'cancel' : 'error';
      if (ctx.currentAdapter) this.log.info(`[ChatV2::pipeline] Retrieved partial content from adapter on ${reason}: content_len=${utf8ByteLength(ctx.finalContent)}, reasoning_len=${ctx.finalReasoning === null ? 'None' : `Some(${utf8ByteLength(ctx.finalReasoning)})`}`);
      try {
        await this.deps.finalPersistence.saveResults(ctx);
        this.log.info(`[ChatV2::pipeline] Partial results saved on ${reason}: content_len=${utf8ByteLength(ctx.finalContent)}, reasoning_len=${ctx.finalReasoning === null ? 'None' : `Some(${utf8ByteLength(ctx.finalReasoning)})`}`);
      } catch (saveError) { this.log.warn(`[ChatV2::pipeline] Failed to save partial results on ${reason}: ${message(saveError)}`); }
      if (cancelled) emitter.emitStreamCancelled(assistantId);
      else if (error instanceof ChatV2Error && error.kind === 'ContextWindowExceeded') {
        const data = error.data as { message: string; details: unknown };
        emitter.emitStreamErrorWithDetails(assistantId, message(error), error.code(), data.details);
      } else emitter.emitStreamError(assistantId, message(error));
      throw error;
    }
    emitter.emitStreamCompleteWithUsage(assistantId, ctx.elapsedMs(), ctx.tokenUsage.totalTokens > 0 ? ctx.tokenUsage : null);
    this.deps.effects.accumulateGoalUsage(ctx, emitter);
    this.log.info(`[ChatV2::pipeline] Pipeline completed for session=${ctx.sessionId}, duration=${ctx.elapsedMs()}ms`);
    await this.deps.effects.scheduleSessionMetadata(ctx, emitter);
    return assistantId;
  }

  private collectPartial(ctx: PipelineContext): void {
    const adapter = ctx.currentAdapter;
    if (!adapter) return;
    if (ctx.finalContent === '') ctx.finalContent = adapter.getAccumulatedContent();
    if (ctx.finalReasoning === null) ctx.finalReasoning = adapter.getAccumulatedReasoning();
    ctx.streamingThinkingBlockId ??= adapter.getThinkingBlockId();
    ctx.streamingContentBlockId ??= adapter.getContentBlockId();
    for (const segment of adapter.getTextSegments()) {
      if (segment.content === '') continue;
      const endedAt = segment.endedAt ?? Date.now();
      ctx.addInterleavedBlock({ id: segment.blockId, messageId: ctx.assistantMessageId, type: segment.blockType,
        status: 'success', content: segment.content, startedAt: segment.startedAt, endedAt,
        firstChunkAt: segment.startedAt });
    }
  }

  private usage(adapter: ChatV2StreamingAdapter, messages: readonly LegacyChatMessage[], turn: PreparedTextTurn): TokenUsage {
    const api = adapter.getApiUsage();
    if (api !== null) {
      this.log.debug(`[ChatV2::pipeline] Using API usage: prompt=${api.promptTokens}, completion=${api.completionTokens}`);
      return api;
    }
    this.log.debug('[ChatV2::pipeline] API usage not available, using estimation');
    let prompt = turn.systemPrompt === '' ? '' : `${turn.systemPrompt}\n`;
    for (const entry of messages) {
      prompt += `${entry.role}: ${entry.content}\n`;
      if (entry.thinking_content != null) prompt += `${entry.thinking_content}\n`;
      if (entry.tool_call != null) prompt += `${JSON.stringify(entry.tool_call.args_json)}\n`;
      if (entry.tool_result?.data_json != null) prompt += `${JSON.stringify(entry.tool_result.data_json)}\n`;
    }
    const reasoning = adapter.getAccumulatedReasoning();
    const reasoningTokens = reasoning === null || reasoning === '' ? null : estimateTokensWithModel(reasoning, turn.config.model);
    return { ...fromEstimate(estimateTokensWithModel(prompt, turn.config.model) + messages.length * 4,
      Math.min(0xffff_ffff, estimateTokensWithModel(adapter.getAccumulatedContent(), turn.config.model) + (reasoningTokens ?? 0)), true),
    ...(reasoningTokens === null ? {} : { reasoningTokens }) };
  }

  private async streamRound(turn: PreparedTextTurn, emitter: ChatV2Emitter, signal: AbortSignal): Promise<void> {
    const ctx = turn.execution;
    const adapter = new ChatV2StreamingAdapter(bindStreamingSink(emitter), ctx.assistantMessageId, {
      enableThinking: ctx.options.enableThinking ?? false, skillStateVersion: ctx.options.skillStateVersion,
      roundId: 'tool-round-0', modelConfig: turn.config,
    });
    ctx.currentAdapter = adapter;
    const streamEvent = buildRunScopedStreamEvent(ctx.sessionId, ctx.assistantMessageId, globalThis.crypto.randomUUID(), ctx.options.streamGeneration ?? null);
    const hooks: LlmStreamHooks = {
      onContentChunk: value => adapter.onContentChunk(value), onReasoningChunk: value => adapter.onReasoningChunk(value),
      onUsage: value => adapter.onUsage(value), onResponseReasoningItem: value => adapter.onResponseReasoningItem(value),
      onThoughtSignature: value => adapter.onThoughtSignature(value), onWebSearch: value => adapter.onWebSearch(value),
      onComplete: () => adapter.onComplete(),
    };
    this.events.registerStreamHooks(streamEvent, hooks);
    const guard = new StreamHooksGuard(this.events, this.manager, streamEvent, hooks);
    const messages = [...ctx.chatHistory, ...(ctx.compiledCurrentUserMessage === null ? [] : [ctx.compiledCurrentUserMessage])];
    const read = (key: string) => { try { return this.readSetting(key); } catch { return null; } }; // helpers.rs:346 .ok().flatten().
    const rawTimeout = read('chat.stream.timeout_ms');
    const timeout = rawTimeout === null ? null : parseU64(rawTimeout);
    // Total limit is 7200s; values beyond it are unreachable by the idle branch.
    const idleMs = timeout === null || timeout === 0n ? 600_000 : Number(((timeout + 999n) / 1000n) > 7200n ? 7201n : (timeout + 999n) / 1000n) * 1000;
    const rawCancel = read('chat.stream.auto_cancel_on_timeout');
    const cancelOnIdle = rawCancel === null || !['0', 'false'].includes(rustTrim(rawCancel).replace(/[A-Z]/g, c => c.toLowerCase()));
    try {
      let result: { cancelled: boolean; assistantMessage: string } | undefined;
      for (let retry = 0; ; retry++) {
        try {
          // The stream port turns the abandoned signal into requestCancelStream; hooks are revoked here first.
          const outcome = await runStreamWithWatchdog({ cancellation: signal,
            start: abandoned => this.deps.stream.call({ config: turn.config, messages,
              systemPrompt: turn.systemPrompt, streamEvent, messageId: ctx.assistantMessageId, options: ctx.options,
              signal: abandoned, hooks, disableTools: true, sources: ctx.retrievedSources }),
            cancelUpstream: () => { this.events.unregisterStreamHooksIfOwner(streamEvent, hooks); },
            idleLimitMs: idleMs, totalLimitMs: 7_200_000, cancelOnIdle, idleElapsed: () => adapter.idleElapsedMs() });
          if (outcome.kind === 'cancelled') throw new ChatV2Error('Cancelled');
          if (outcome.kind === 'idleTimeout') {
            this.log.error(retry === 0
              ? `[ChatV2::pipeline] LLM stream idle timeout after ${outcome.idleSecs}s without data, session=${ctx.sessionId}`
              : `[ChatV2::pipeline] LLM stream retry idle timeout after ${outcome.idleSecs}s, session=${ctx.sessionId}, retry=${retry}/2`);
            throw new Error(`LLM stream call timed out: no data received for ${outcome.idleSecs}s`);
          }
          if (outcome.kind === 'totalTimeout') {
            this.log.error(retry === 0
              ? `[ChatV2::pipeline] LLM stream exceeded absolute limit ${outcome.totalSecs}s, session=${ctx.sessionId}`
              : `[ChatV2::pipeline] LLM stream retry exceeded absolute limit ${outcome.totalSecs}s, session=${ctx.sessionId}, retry=${retry}/2`);
            throw new Error(`LLM stream call exceeded absolute time limit (${outcome.totalSecs}s)`);
          }
          if (outcome.outcome.ok === false) throw outcome.outcome.error;
          result = outcome.outcome.value;
          if (retry > 0) this.log.info(`[ChatV2::pipeline] LLM retry ${retry} succeeded`);
          break;
        } catch (error) {
          if (signal.aborted || (error instanceof ChatV2Error && error.kind === 'Cancelled')) throw new ChatV2Error('Cancelled');
          const hasOutput = adapter.getAccumulatedContent() !== '' || (adapter.getAccumulatedReasoning() ?? '') !== '';
          if (hasOutput) this.log.warn(`[ChatV2::pipeline] Stream failed after output; suppressing automatic retry/failover for session=${ctx.sessionId}`);
          if (hasOutput || retry === 2 || !isRetryableLlmError(message(error))) {
            await guard.cleanup();
            const failedUsage = adapter.getApiUsage();
            if (failedUsage !== null) accumulate(ctx.tokenUsage, failedUsage);
            this.deps.effects.recordUsage(ctx, failedUsage, false, message(error));
            adapter.onError(message(error)); this.log.error(`[ChatV2::pipeline] LLM call failed: ${message(error)}`);
            if (error instanceof ChatV2Error) throw error;
            throw new ChatV2Error(message(error).toLowerCase().includes('timed out') ? 'Timeout' : 'Llm', message(error));
          }
          const delay = 1000 * 2 ** retry;
          this.log.warn(`[ChatV2::pipeline] Transient LLM error, retry ${retry + 1}/2 after ${delay}ms: ${message(error)}`);
          emitter.emitStreamReconnect(ctx.assistantMessageId, retry + 1, 2);
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new ChatV2Error('Cancelled')); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          });
          this.events.unregisterStreamHooksIfOwner(streamEvent, hooks); adapter.resetStreamState();
          this.events.registerStreamHooks(streamEvent, hooks);
        }
      }
      await guard.cleanup();
      this.log.info(`[ChatV2::pipeline] LLM call succeeded, cancelled=${result.cancelled}, content_len=${utf8ByteLength(result.assistantMessage)}`);
      this.collectPartial(ctx);
      if (ctx.finalContent === '' && result.assistantMessage !== '') ctx.finalContent = result.assistantMessage;
      const usage = this.usage(adapter, messages, turn);
      accumulate(ctx.tokenUsage, usage);
      this.log.info(`[ChatV2::pipeline] Token usage for round 0: prompt=${usage.promptTokens}, completion=${usage.completionTokens}, total=${usage.totalTokens}, source=${usage.source}; Accumulated: prompt=${ctx.tokenUsage.promptTokens}, completion=${ctx.tokenUsage.completionTokens}, total=${ctx.tokenUsage.totalTokens}, source=${ctx.tokenUsage.source}`);
      this.deps.effects.recordUsage(ctx, usage, true, null);
      if (result.cancelled) { adapter.finalizeAll(); throw new ChatV2Error('Cancelled'); }
      const webSources = adapter.takeWebSearchSources();
      if (webSources?.length) ctx.retrievedSources.webSearch = webSources as never;
      ctx.mergeResponseWebSearchItems(adapter.takeWebSearchItems());
      for (const [id, item] of adapter.getResponseReasoningItems()) ctx.responseReasoningByToolCallId.set(id ?? '__final_assistant__', item);
    } finally { await guard.cleanup(); }
  }
}
