/** pipeline/compaction.rs:250–1415 — run_compaction / compact_for_request / run_compaction_for_session.
 * L03 owns ordering (summary → one transaction → memory flush), lineage, cooldown and locks.
 * Chat rows are written only through the L04 owner methods with the caller's transaction.
 */
import type { Context } from '@deepseek-ai/cordis';
import { ChatV2Error, type ChatMessage, type ChatSession, type MessageBlock, type ChatV2Emitter } from '../../chat/api.ts';
import type { ApiConfig, LLMManager, StandardModel2Output } from '../../llm/api.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import type { PipelineContext } from './pipeline-context.ts';
import type { PersistenceBlock } from './persistence-port.ts';
import type { HistoryCompactionRecord } from './history-port.ts';
import {
  HEAD_USER_TURNS, MAX_SUMMARY_INPUT_TOKENS, MAX_TAIL_TOKENS, MIN_SUMMARY_INPUT_TOKENS, MIN_TAIL_TOKENS,
  SUMMARY_INPUT_RATIO, TAIL_PRESERVE_RATIO, effectiveUsableTokens, estimateMessageTokens,
} from './compaction-budget.ts';
import { selectManualTail, selectTail, splitIntoTurns, splitSummaryRanges, type TailSelection } from './segmentation.ts';
import {
  IDENTIFIER_AUDIT_MAX, IDENTIFIER_AUDIT_RECENT_MESSAGES, actualModelFromRawResponse, buildCompactionPrompt,
  buildStaticFallbackSummary, compactionProfileForMode, escapeUntrustedPromptData, extractOpaqueIdentifiers,
  missingIdentifiers, renderMessagesForPrompt, splitTextToTokenBudget, summaryIsStructurallyValid,
  truncateTextToTokenBudget,
} from './compaction-prompts.ts';
import { estimateTokensWithModel } from './token-budget.ts';
import { buildMemoryFlushSegmentId, splitMemoryFlushSegment } from './memory-flush.ts';
import { enqueueMemoryFlushWithConn, type PendingMemoryFlush } from '../repository/memory-flush.ts';
import {
  compactionDidCompact, compactionIsFailed, compactionReasonCode, compactionStatus, compactionTokenEstimates,
  cooldownSecondsForOutcome, runSummaryCommitPost, validatedCompactionModelId,
  type CompactionOutcome, type CompactionSkipReason,
} from './compaction-outcome.ts';

type Log = Pick<Context['logger'], 'info' | 'warn' | 'error' | 'debug'>;
const text = (error: unknown) => error instanceof Error ? error.message
  : error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message : String(error);
const BLOCK_TYPE_COMPACTION_SUMMARY = 'compaction_summary';
const U32_MAX = 0xffff_ffff;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const satSub = (a: number, b: number) => a > b ? a - b : 0;

/** types.rs CompactionRecord (repo shape published by L04). */
export interface CompactionRecordInput extends HistoryCompactionRecord {
  sessionId: string; tailStartTimeCreated: number; reason: string; isAuto: boolean; isOverflow: boolean;
  tokensBefore: number | null; tokensAfter: number | null; modelId: string | null; modelConfigId: string | null;
  previousCompactionId: string | null; rangeStartMessageId: string | null; rangeEndMessageId: string | null;
  compactedMessageCount: number | null; createdAt: number;
}
/** L04 owner surface for compaction (repo.rs create/set/mark + reads), caller-owned connection. */
export interface CompactionOwnerStore {
  getSession(sessionId: string): ChatSession | null;
  getSessionMessageIdsWithConn(conn: SqlExecutor, sessionId: string): string[];
  getMessagesByIdsWithConn(conn: SqlExecutor, sessionId: string, messageIds: string[]): ChatMessage[];
  getMessageBlocksWithConn(conn: SqlExecutor, messageId: string): PersistenceBlock[];
  getActiveCompactionWithConn(conn: SqlExecutor, sessionId: string): HistoryCompactionRecord | null;
  createMessageWithConn(conn: SqlExecutor, message: ChatMessage): void;
  createBlockWithConn(conn: SqlExecutor, block: PersistenceBlock): void;
  createCompactionWithConn(conn: SqlExecutor, record: CompactionRecordInput): void;
  setSessionLastCompactionWithConn(conn: SqlExecutor, sessionId: string, compactionId: string): void;
  markAvailableSkillsSnapshotStaleWithConn(conn: SqlExecutor, sessionId: string): number | bigint | null;
}
export const COMPACTION_OWNER_METHODS = ['getSession', 'getSessionMessageIdsWithConn', 'getMessagesByIdsWithConn',
  'getMessageBlocksWithConn', 'getActiveCompactionWithConn', 'createMessageWithConn', 'createBlockWithConn',
  'createCompactionWithConn', 'setSessionLastCompactionWithConn', 'markAvailableSkillsSnapshotStaleWithConn',
] as const satisfies readonly (keyof CompactionOwnerStore)[];

export interface CompactionDependencies {
  llm: LLMManager;
  connection(): DatabaseHandle;
  owner: CompactionOwnerStore;
  /** llm_manager.call_agent_compaction_raw_prompt (L02 owner); rejects when unpublished. */
  summarize(modelConfigId: string, prompt: string, sessionId: string): Promise<StandardModel2Output>;
  /** compaction/memory_flush.rs worker drain after commit. */
  flushPendingMemorySegments(sessionId: string): Promise<void>;
  log: Log;
}

const isSummaryOnly = (record: HistoryCompactionRecord) => record.tailStartMessageId === record.summaryMessageId;
const historyBoundaryId = (record: HistoryCompactionRecord) =>
  isSummaryOnly(record) ? record.rangeEndMessageId ?? '' : record.tailStartMessageId;

interface PreparedCompaction {
  summaryMessage: ChatMessage;
  summaryBlock: PersistenceBlock;
  record: CompactionRecordInput;
  summaryTokens: number;
  memoryFlushes: PendingMemoryFlush[];
}

/** Process-lifetime compaction state (Rust: ChatV2Pipeline.compaction_locks / compaction_cooldowns). */
export class CompactionRunner {
  private readonly locks = new Set<string>();
  private readonly cooldowns = new Map<string, number>();
  private deps: () => CompactionDependencies;
  constructor(deps: () => CompactionDependencies) { this.deps = deps; }

  isLocked(sessionId: string): boolean { return this.locks.has(sessionId); }

  /** compaction.rs:250 run_compaction */
  async runCompaction(ctx: PipelineContext, emitter: ChatV2Emitter): Promise<CompactionOutcome> {
    if (!ctx.needsCompaction) return { kind: 'notNeeded', reason: 'notTriggered' };
    const sessionId = ctx.sessionId;
    const model = ctx.options.model2OverrideId ?? ctx.options.modelId ?? null;
    const outcome = await this.runWithFeedback(sessionId, model, 'auto', [ctx.userMessageId, ctx.assistantMessageId],
      ctx.options.contextLimit ?? null, ctx.options.memoryEnabled ?? null, ctx.cancellationToken(), emitter);
    ctx.needsCompaction = false;
    if (!compactionDidCompact(outcome)) {
      this.deps().log.debug(`[compaction] session=${sessionId} skipped: status=${statusCode(outcome)} reason=${reasonDebug(outcome)}`);
    }
    return outcome;
  }

  /** compaction.rs:301 compact_for_request (single-variant form). */
  compactForRequest(ctx: PipelineContext, emitter: ChatV2Emitter, budgetError: unknown): Promise<boolean> {
    return this.compactForRequestWith(ctx.sessionId, ctx.options, [ctx.userMessageId, ctx.assistantMessageId],
      emitter, ctx.cancellationToken(), budgetError);
  }

  /** compaction.rs:301 compact_for_request — shared by single and multi-variant paths. */
  async compactForRequestWith(sessionId: string, options: PipelineContext['options'], excludeIds: readonly string[],
    emitter: ChatV2Emitter, signal: AbortSignal | null, budgetError: unknown): Promise<boolean> {
    const { log } = this.deps();
    const details = budgetError !== null && typeof budgetError === 'object' && 'details' in budgetError
      ? (budgetError as { details: unknown }).details : null;
    const detail = (key: string): unknown => details !== null && typeof details === 'object' && !Array.isArray(details)
      ? (details as Record<string, unknown>)[key] : undefined;
    const rawModel = detail('compaction_model_id');
    const model = typeof rawModel === 'string' ? rawModel : options.model2OverrideId ?? options.modelId ?? null;
    const rawLimit = detail('input_limit');
    const limit = typeof rawLimit === 'number' && Number.isInteger(rawLimit) && rawLimit >= 0 && rawLimit <= U32_MAX
      ? rawLimit : options.contextLimit ?? null;
    let outcome: { ok: true; value: CompactionOutcome } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await this.runWithFeedback(sessionId, model, 'auto',
        excludeIds, limit, options.memoryEnabled ?? null, signal, emitter) };
    } catch (error) { outcome = { ok: false, error }; }
    if (signal?.aborted) throw new ChatV2Error('Cancelled');
    if (!outcome.ok) {
      log.warn(`[compaction] request preflight failed session=${sessionId}: ${text(outcome.error)}`);
      emitter.emitCompactionFailed('internalError');
      return false;
    }
    const value = outcome.value;
    if (compactionDidCompact(value)) {
      const [before, after] = compactionTokenEstimates(value);
      emitter.emitCompactionCompleted(before, after);
      return true;
    }
    if (value.kind === 'skipped' && value.reason === 'lockBusy') {
      const deadline = Date.now() + 120_000;
      for (;;) {
        if (signal?.aborted) throw new ChatV2Error('Cancelled');
        if (!this.locks.has(sessionId)) return true;
        if (Date.now() >= deadline) return false;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    log.info(`[compaction] request preflight did not compact session=${sessionId}: status=${statusCode(value)} reason=${reasonDebug(value)}; keeping every unsummarized message`);
    if (compactionIsFailed(value)) {
      const reason = compactionReasonCode(value);
      if (reason !== null) emitter.emitCompactionFailed(reason);
    }
    return false;
  }

  /** compaction.rs:431 run_compaction_for_session (no feedback emitter). */
  runForSession(sessionId: string, modelId: string | null, reason: string, excludeIds: readonly string[],
    contextLimit: number | null, memoryEnabled: boolean | null, signal: AbortSignal | null): Promise<CompactionOutcome> {
    return this.runWithFeedback(sessionId, modelId, reason, excludeIds, contextLimit, memoryEnabled, signal, null);
  }

  /** compaction.rs:454 */
  async runWithFeedback(sessionId: string, modelId: string | null, reason: string, excludeIds: readonly string[],
    contextLimit: number | null, memoryEnabled: boolean | null, signal: AbortSignal | null,
    emitter: ChatV2Emitter | null): Promise<CompactionOutcome> {
    if (reason !== 'manual' && reason !== 'overflow') {
      const until = this.cooldowns.get(sessionId);
      if (until !== undefined && performance.now() < until) {
        this.deps().log.info(`[compaction] session=${sessionId} in failure cooldown; skip auto trigger`);
        return { kind: 'skipped', reason: 'cooldown' };
      }
    }
    const outcome = await this.inner(sessionId, modelId, reason, excludeIds, contextLimit, memoryEnabled, signal, emitter);
    const seconds = cooldownSecondsForOutcome(outcome);
    if (seconds === null) this.cooldowns.delete(sessionId);
    else this.cooldowns.set(sessionId, performance.now() + seconds * 1000);
    return outcome;
  }

  /** compaction.rs:390 compaction_model_override */
  private async compactionModelOverride(): Promise<string | null> {
    const { llm, log } = this.deps();
    try {
      const assignments = await llm.getModelAssignments();
      const id = assignments.compaction_model_config_id;
      if (id == null) return null;
      const trimmed = rustTrim(id);
      return trimmed === '' ? null : trimmed;
    } catch (error) {
      log.warn(`[compaction] failed to read model assignments for compaction model override: ${text(error)}`);
      return null;
    }
  }

  /** compaction.rs:1444 resolve_api_config_by_id */
  private async resolveApiConfigById(key: string): Promise<ApiConfig | null> {
    const { llm, log } = this.deps();
    const trimmed = rustTrim(key);
    if (trimmed === '') return null;
    let configs: ApiConfig[];
    try { configs = await llm.getApiConfigs(); }
    catch (error) {
      log.warn(`[ChatV2::pipeline] resolve_api_config_by_id: failed to load API configs (key=${trimmed}): ${text(error)}; falling back to defaults`);
      return null;
    }
    return configs.find(config => config.id === trimmed) ?? configs.find(config => config.model === trimmed) ?? null;
  }

  private async inner(sessionId: string, requestedModel: string | null, rawReason: string,
    excludeIds: readonly string[], contextLimit: number | null, memoryEnabled: boolean | null,
    signal: AbortSignal | null, emitter: ChatV2Emitter | null): Promise<CompactionOutcome> {
    const deps = this.deps();
    const { log, owner } = deps;
    const dedicated = await this.compactionModelOverride();
    const effectiveModelId = validatedCompactionModelId(dedicated ?? requestedModel);
    if (effectiveModelId === null) {
      log.warn('[compaction] no model_id; skip compaction (no fallback)');
      return { kind: 'skipped', reason: 'noModel' };
    }
    const reason = rawReason === 'manual' ? 'manual' : rawReason === 'overflow' ? 'overflow' : 'auto';
    if (this.locks.has(sessionId)) {
      log.info(`[compaction] session=${sessionId} already running; skip this trigger`);
      return { kind: 'skipped', reason: 'lockBusy' };
    }
    this.locks.add(sessionId);
    try {
      log.info(`[compaction] running for session=${sessionId}`);
      const conn = deps.connection();
      let mode: string | null = null;
      try { mode = owner.getSession(sessionId)?.mode ?? null; } catch { mode = null; }
      const profile = compactionProfileForMode(mode);
      const ids = owner.getSessionMessageIdsWithConn(conn, sessionId);
      const exclude = new Set(excludeIds);
      const candidates = owner.getMessagesByIdsWithConn(conn, sessionId, ids).filter(message => !exclude.has(message.id));
      const blocksByMsg = new Map<string, MessageBlock[]>();
      for (const message of candidates) {
        try { blocksByMsg.set(message.id, owner.getMessageBlocksWithConn(conn, message.id)); }
        catch (error) { log.warn(`[compaction] load blocks failed for ${message.id}: ${text(error)}`); }
      }
      const messages = candidates.filter(message =>
        !(blocksByMsg.get(message.id)?.some(block => block.type === BLOCK_TYPE_COMPACTION_SUMMARY) ?? false));
      const apiConfig = await this.resolveApiConfigById(effectiveModelId);
      const modelForTokens = apiConfig?.model ?? effectiveModelId;
      const usable = effectiveUsableTokens(apiConfig, contextLimit);
      if (usable < 4_096) {
        log.warn(`[compaction] input budget too small for safe summarization: session=${sessionId} usable=${usable}`);
        return { kind: 'skipped', reason: 'usableTooSmall' };
      }
      const turns = splitIntoTurns(messages);
      const recovery = reason === 'overflow' || reason === 'manual';
      const estimate = (message: ChatMessage) => estimateMessageTokens(message, blocksByMsg, modelForTokens);
      if (!recovery && turns.length < HEAD_USER_TURNS + 2 && messages.length < HEAD_USER_TURNS * 2 + 2) {
        const estimated = messages.reduce((sum, message) => sum + estimate(message), 0);
        const small = usable > 0 && Math.floor(estimated * 100 / usable) <= 70;
        log.info(`[compaction] sparse-session guard: msgs=${messages.length} turns=${turns.length} est_tokens=${estimated} usable=${usable} -> ${small ? 'skip (small)' : 'proceed (large)'}`);
        if (small) return { kind: 'notNeeded', reason: 'sessionTooShort' };
      }
      const previous = owner.getActiveCompactionWithConn(conn, sessionId);
      const visibleStartOf = (record: HistoryCompactionRecord | null) => {
        if (record === null) return null;
        const index = messages.findIndex(message => message.id === historyBoundaryId(record));
        return index < 0 ? null : index + (isSummaryOnly(record) ? 1 : 0);
      };
      const visibleStart = visibleStartOf(previous) ?? 0;
      const tailBudgetRaw = reason === 'manual'
        ? Math.trunc(Math.min(messages.slice(visibleStart).reduce((sum, message) => sum + estimate(message), 0), usable) * TAIL_PRESERVE_RATIO)
        : Math.trunc(usable * TAIL_PRESERVE_RATIO);
      const tailBudget = clamp(tailBudgetRaw, reason === 'manual' ? 1 : MIN_TAIL_TOKENS, MAX_TAIL_TOKENS);
      let tail: TailSelection | null;
      if (reason === 'manual') tail = selectManualTail(messages, turns, tailBudget, blocksByMsg, modelForTokens);
      else if (reason === 'overflow') {
        let start = turns.at(-1)?.start ?? messages.length;
        const lastTokens = messages.slice(start).reduce((sum, message) => sum + estimate(message), 0);
        if (start === 0 || lastTokens > tailBudget) start = messages.length;
        tail = { tailStartIdx: start, tailTokens: messages.slice(start).reduce((sum, message) => sum + estimate(message), 0) };
      } else tail = selectTail(messages, turns, tailBudget, blocksByMsg, modelForTokens);
      if (tail === null) {
        log.info('[compaction] no suitable tail cut; skip');
        return { kind: 'notNeeded', reason: 'noCompactibleRange' };
      }
      if (messages.length === 0) return { kind: 'notNeeded', reason: 'sessionTooShort' };
      const tailStart = messages[tail.tailStartIdx];
      const summaryMessageId = `msg_${globalThis.crypto.randomUUID()}`;
      const tailBoundaryId = tailStart?.id ?? summaryMessageId;
      const rangeEnd = tailStart ?? messages.at(-1)!;
      log.debug(`[compaction] tail_start=${tailBoundaryId} idx=${tail.tailStartIdx} tail_tokens~${tail.tailTokens} budget=${tailBudget}`);
      let previousSummary: string | null = null;
      if (previous !== null) {
        previousSummary = owner.getMessageBlocksWithConn(conn, previous.summaryMessageId)
          .find(block => block.type === BLOCK_TYPE_COMPACTION_SUMMARY)?.content ?? null;
      }
      const headTurns = recovery ? 0 : Math.min(HEAD_USER_TURNS, turns.length);
      const headEnd = headTurns > 0 ? turns[headTurns - 1]!.end : 0;
      const anchorEnd = reason === 'manual' ? 0 : headEnd;
      const previousVisible = visibleStartOf(previous);
      const middleStart = previousVisible === null ? anchorEnd : Math.max(previousVisible, anchorEnd);
      const middleEnd = tail.tailStartIdx;
      if (middleStart >= middleEnd) {
        log.info('[compaction] no incremental middle to summarize; skip');
        return { kind: 'notNeeded', reason: 'noCompactibleRange' };
      }
      const requestBudget = Math.min(clamp(Math.trunc(usable * SUMMARY_INPUT_RATIO), MIN_SUMMARY_INPUT_TOKENS,
        MAX_SUMMARY_INPUT_TOKENS), satSub(usable, 512));
      const perMsgCap = clamp(Math.floor(requestBudget / 16), 256, 8_000);
      const headText = truncateTextToTokenBudget(renderMessagesForPrompt(messages, blocksByMsg, 0, headEnd, perMsgCap,
        modelForTokens), clamp(Math.floor(requestBudget / 5), 256, 16_000), modelForTokens);
      const previousForPrompt = previousSummary === null ? null
        : truncateTextToTokenBudget(previousSummary, clamp(Math.floor(requestBudget / 3), 256, 12_000), modelForTokens);
      const fixedInput = estimateTokensWithModel(`${profile.system}\n${headText}\n${previousForPrompt ?? ''}`, modelForTokens) + 512;
      const inputBudget = satSub(requestBudget, fixedInput);
      if (inputBudget < 256) {
        log.warn(`[compaction] fixed summary context exhausts request budget: session=${sessionId} request=${requestBudget} fixed=${fixedInput}`);
        return { kind: 'skipped', reason: 'usableTooSmall' };
      }
      const ranges = splitSummaryRanges(messages, turns, blocksByMsg, middleStart, middleEnd, inputBudget, perMsgCap, modelForTokens);
      if (ranges.length === 0) return { kind: 'notNeeded', reason: 'noCompactibleRange' };
      const chunks = ranges.flatMap(([start, end]) => splitTextToTokenBudget(escapeUntrustedPromptData(
        renderMessagesForPrompt(messages, blocksByMsg, start, end, Number.MAX_SAFE_INTEGER, modelForTokens)), inputBudget, modelForTokens));
      const recentStart = Math.max(satSub(middleEnd, IDENTIFIER_AUDIT_RECENT_MESSAGES), middleStart);
      const auditIdentifiers = extractOpaqueIdentifiers(escapeUntrustedPromptData(renderMessagesForPrompt(messages,
        blocksByMsg, recentStart, middleEnd, perMsgCap, modelForTokens)), IDENTIFIER_AUDIT_MAX);
      let flushSegments: [number, string, string][] = [];
      if (memoryEnabled === false) {
        log.info(`[compaction] session memory disabled; skip memory flush enqueue: session=${sessionId}`);
      } else if (middleStart < middleEnd) {
        const flushText = renderMessagesForPrompt(messages, blocksByMsg, middleStart, middleEnd, perMsgCap, modelForTokens);
        flushSegments = splitMemoryFlushSegment(flushText).map((segment, ordinal) => [ordinal,
          buildMemoryFlushSegmentId(sessionId, previous?.id ?? null, messages[middleStart]!.id, rangeEnd.id, ordinal), segment]);
      }
      const previousSummaryTokens = previousSummary === null ? 0 : estimateTokensWithModel(previousSummary, modelForTokens);
      const tokensBefore = Math.min(messages.slice(previousVisible ?? 0)
        .reduce((sum, message) => sum + estimate(message), previousSummaryTokens), U32_MAX);
      const compactedCount = satSub(middleEnd, middleStart);

      emitter?.emitCompactionStarted(reason);
      // Rust Arc<Mutex<CompactionSkipReason>> written from the summary/persist closures.
      const abort: { reason: CompactionSkipReason } = { reason: 'summaryFailed' };
      try {
        const committed = await runSummaryCommitPost<PreparedCompaction, unknown>(async () => {
          let rolling = previousForPrompt;
          let actualModel: string | null = null;
          let usedFallback = false;
          const hardCap = clamp(Math.floor(tailBudgetRaw / 2), 512, 12_000);
          const race = async (call: Promise<StandardModel2Output>): Promise<StandardModel2Output | null | Error> => {
            const settled = call.then(value => value, error => (error instanceof Error ? error : new Error(text(error))));
            if (signal === null) return settled;
            if (signal.aborted) return null;
            let remove = () => {};
            const cancelled = new Promise<null>(resolve => {
              const abort = () => resolve(null);
              signal.addEventListener('abort', abort, { once: true });
              remove = () => signal.removeEventListener('abort', abort);
            });
            try { return await Promise.race([settled, cancelled]); } finally { remove(); }
          };
          for (const [chunkIndex, chunk] of chunks.entries()) {
            const fallback = (why: string) => {
              usedFallback = true;
              log.warn(`[compaction] static fallback summary used session=${sessionId} chunk=${chunkIndex + 1}/${chunks.length} reason=${why}`);
              return buildStaticFallbackSummary(profile, chunk, hardCap, modelForTokens);
            };
            rolling = rolling === null ? null
              : truncateTextToTokenBudget(rolling, clamp(Math.floor(requestBudget / 3), 256, 12_000), modelForTokens);
            const prompt = buildCompactionPrompt(profile, headText, chunk, rolling);
            const result = await race(deps.summarize(effectiveModelId, prompt, sessionId));
            if (result === null) { abort.reason = 'cancelled'; return { ok: true, value: null }; }
            if (result instanceof Error) {
              log.error(`[compaction] summary failed session=${sessionId} chunk=${chunkIndex + 1}/${chunks.length}: ${result.message}`);
              if (reason === 'manual') { abort.reason = 'summaryFailed'; return { ok: true, value: null }; }
              rolling = fallback('llm_call_failed');
              continue;
            }
            actualModel = actualModelFromRawResponse(result.raw_response) ?? actualModel;
            let candidate = rustTrim(result.assistant_message);
            let candidateTokens = estimateTokensWithModel(candidate, modelForTokens);
            const finalChunk = chunkIndex + 1 === chunks.length;
            let missing = finalChunk ? missingIdentifiers(candidate, auditIdentifiers) : [];
            if (!summaryIsStructurallyValid(candidate, profile) || candidateTokens > hardCap || missing.length > 0) {
              const repairInput = truncateTextToTokenBudget(candidate, clamp(Math.floor(requestBudget / 2), 256, 12_000), modelForTokens);
              const missingSection = missing.length === 0 ? ''
                : `\n\n以下关键标识符缺失，必须逐字出现在摘要中（不得改写、截断或省略）：\n${missing.map(id => `- ${id}`).join('\n')}`;
              const repairPrompt = `${profile.system}\n\n上一次输出未通过结构、长度或标识符保真校验。请完整保留全部 ${profile.requiredHeadings.length} 个规定标题，在不超过约 ${hardCap} tokens 的前提下重新输出；不要解释。${missingSection}\n\n<invalid_summary_data>\n${escapeUntrustedPromptData(repairInput)}\n</invalid_summary_data>`;
              const repaired = await race(deps.summarize(effectiveModelId, repairPrompt, sessionId));
              if (repaired === null) { abort.reason = 'cancelled'; return { ok: true, value: null }; }
              if (repaired instanceof Error) {
                log.error(`[compaction] summary repair failed session=${sessionId} chunk=${chunkIndex + 1}/${chunks.length}: ${repaired.message}`);
                if (reason === 'manual') { abort.reason = 'summaryFailed'; return { ok: true, value: null }; }
                rolling = fallback('repair_call_failed');
                continue;
              }
              actualModel = actualModelFromRawResponse(repaired.raw_response) ?? actualModel;
              candidate = rustTrim(repaired.assistant_message);
              candidateTokens = estimateTokensWithModel(candidate, modelForTokens);
              if (finalChunk) missing = missingIdentifiers(candidate, auditIdentifiers);
            }
            if (!summaryIsStructurallyValid(candidate, profile) || candidateTokens > hardCap) {
              if (reason === 'manual') { abort.reason = 'summaryFailed'; return { ok: true, value: null }; }
              rolling = fallback('invalid_after_repair');
              continue;
            }
            if (missing.length > 0) {
              log.warn(`[compaction] identifier audit: ${missing.length} identifier(s) still missing after repair (session=${sessionId}): ${JSON.stringify(missing)}`);
            }
            rolling = candidate;
          }
          if (rolling === null || rustTrim(rolling) === '') { abort.reason = 'summaryFailed'; return { ok: true, value: null }; }
          const summaryText = rolling;
          const actualModelId = actualModel ?? apiConfig?.model ?? effectiveModelId;
          const summaryTokens = estimateTokensWithModel(summaryText, modelForTokens) >>> 0;
          const tokensAfter = summaryTokens + tail!.tailTokens;
          const now = Date.now();
          const summaryBlockId = `blk_${globalThis.crypto.randomUUID()}`;
          const compactionId = `cmp_${globalThis.crypto.randomUUID()}`;
          const record: CompactionRecordInput = { id: compactionId, sessionId, summaryMessageId,
            tailStartMessageId: tailBoundaryId, tailStartTimeCreated: rangeEnd.timestamp, reason,
            isAuto: reason === 'auto', isOverflow: reason === 'overflow', tokensBefore, tokensAfter,
            modelId: actualModelId, modelConfigId: effectiveModelId, previousCompactionId: previous?.id ?? null,
            rangeStartMessageId: messages[middleStart]!.id, rangeEndMessageId: rangeEnd.id,
            compactedMessageCount: compactedCount, createdAt: now };
          return { ok: true, value: {
            summaryMessage: { id: summaryMessageId, sessionId, role: 'assistant', blockIds: [summaryBlockId], timestamp: now },
            summaryBlock: { id: summaryBlockId, messageId: summaryMessageId, type: BLOCK_TYPE_COMPACTION_SUMMARY,
              status: 'success', content: summaryText, toolOutput: { sessionId, compactionId,
                previousCompactionId: previous?.id ?? null, reason, createdAt: now,
                rangeStartMessageId: messages[middleStart]!.id, rangeEndMessageId: rangeEnd.id,
                tailStartMessageId: tailBoundaryId, compactedMessageCount: compactedCount,
                tailMessageCount: satSub(messages.length, tail!.tailStartIdx), tokensBefore, tokensAfter, summaryTokens,
                summaryPasses: chunks.length, summaryDegraded: usedFallback, modelId: actualModelId,
                modelConfigId: effectiveModelId },
              startedAt: now, endedAt: now, firstChunkAt: now, blockIndex: 0 },
            record, summaryTokens,
            memoryFlushes: flushSegments.map(([ordinal, segmentId, segmentText]) => ({ segmentId, compactionId, sessionId,
              segmentOrdinal: ordinal, segmentText, extractionJson: null, factsCompleted: 0, activitiesCompleted: 0 })),
          } };
        }, prepared => {
          try {
            const persisted = this.persist(prepared);
            if (!persisted) abort.reason = 'staleLineage';
            return { ok: true, value: persisted };
          } catch (error) { return { ok: false, error }; }
        }, async () => { await deps.flushPendingMemorySegments(sessionId); });
        if (!committed.ok) throw committed.error;
        if (committed.value === null) {
          return abort.reason === 'cancelled' ? { kind: 'skipped', reason: 'cancelled' } : { kind: 'failed', reason: abort.reason };
        }
        const prepared = committed.value;
        log.info(`[compaction] committed: id=${prepared.record.id} tail_start_msg=${prepared.record.tailStartMessageId} summary_tokens=${prepared.summaryTokens} tokens_after=${prepared.record.tokensAfter === null ? 'None' : `Some(${prepared.record.tokensAfter})`}`);
        return { kind: 'compacted', tokensBefore, tokensAfter: prepared.record.tokensAfter };
      } finally { emitter?.emitCompactionFinished(); }
    } finally { this.locks.delete(sessionId); }
  }

  /** compaction.rs:1352 persist_prepared_compaction — one transaction, lineage check first. */
  private persist(prepared: PreparedCompaction): boolean {
    const { owner, log } = this.deps();
    const db = this.deps().connection();
    return db.transaction((tx: SqlExecutor) => {
      // The active record is selected through sessions.last_compaction_id by the owner.
      const current = owner.getActiveCompactionWithConn(tx, prepared.record.sessionId)?.id ?? null;
      if (current !== prepared.record.previousCompactionId) {
        log.warn(`[compaction] active lineage changed before commit for session=${prepared.record.sessionId}; discarding stale summary`);
        return false;
      }
      owner.createMessageWithConn(tx, prepared.summaryMessage);
      owner.createBlockWithConn(tx, prepared.summaryBlock);
      owner.createCompactionWithConn(tx, prepared.record);
      owner.setSessionLastCompactionWithConn(tx, prepared.record.sessionId, prepared.record.id);
      const pending = owner.markAvailableSkillsSnapshotStaleWithConn(tx, prepared.record.sessionId);
      if (pending !== null) log.info(`[compaction] available_skills catalog marked stale in commit tx: session=${prepared.record.sessionId} pending_generation=${pending}`);
      else log.debug(`[compaction] available_skills snapshot never frozen; no catalog generation bump: session=${prepared.record.sessionId}`);
      for (const flush of prepared.memoryFlushes) {
        if (!enqueueMemoryFlushWithConn(tx, flush, prepared.record.createdAt)) {
          log.debug(`[compaction] memory segment already queued: segment=${flush.segmentId} compaction=${flush.compactionId}`);
        }
      }
      return true;
    });
  }
}

const statusCode = (outcome: CompactionOutcome) => compactionStatus(outcome);
const reasonDebug = (outcome: CompactionOutcome) => {
  const reason = compactionReasonCode(outcome);
  return reason === null ? 'None' : `Some(${JSON.stringify(reason)})`;
};
