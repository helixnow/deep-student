/** context.rs:279–519 — mutable state owned by one pipeline execution. */
import type {
  CanonicalContentPart, ContextSnapshot, MessageBlock, MessageSources,
  ModelExecutionSnapshot, ToolResultInfo,
} from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import type { SendContextRef, SendOptions } from '../../../../contracts/ipc/generated/_shared.ts';
import { buildRuntimeFactsBlock } from './context.ts';
import type { ChatV2StreamingAdapter } from './llm-adapter.ts';
import type { LegacyChatMessage } from './microcompact.ts';
import { zero } from './token-usage.ts';
import { getBlockTypeForToolStatic } from './tool-block-type.ts';
import type { BackendSendOptions } from './persistence.ts';
import type { PipelineSendRequest } from '../api.ts';
import { allToolResultsToMessages, historyMessage } from './history-replay.ts';
import type { StreamedTextSegment } from './llm-adapter.ts';
import { sendContextRefToContextRef } from './context.ts';
import { cloneAgentJson, preBudgetOutput } from '../../../kernel/agent-api.ts';
import type { ContextRef } from '../../../../contracts/ipc/generated/L04-chat-session.ts';

/** Minimal L04 AttachmentInput view; no constructor/serialization logic is copied. */
export interface AttachmentInput {
  name: string;
  mimeType: string;
  base64Content?: string | null;
  textContent?: string | null;
  metadata?: unknown;
}

export class PipelineContext {
  static getBlockTypeForToolStatic = getBlockTypeForToolStatic;
  readonly sessionId: string;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  userContent: string;
  runtimeFacts: string;
  attachments: AttachmentInput[] = [];
  chatHistory: LegacyChatMessage[] = [];
  compiledCurrentUserMessage: LegacyChatMessage | null = null;
  canonicalContent: CanonicalContentPart[] = [];
  executionSnapshot: ModelExecutionSnapshot | null = null;
  retrievedSources: MessageSources = {};
  turnVolatileContext: string | null = null;
  options: BackendSendOptions;
  toolResults: ToolResultInfo[] = [];
  finalContent = '';
  finalReasoning: string | null = null;
  activeBlocks = new Map<string, string>();
  generatedBlocks: MessageBlock[] = [];
  streamingThinkingBlockId: string | null = null;
  streamingContentBlockId: string | null = null;
  streamingRetrievalBlockIds = new Map<string, string>();
  toolResultsAddedCount = 0;
  private readonly startTime: number;
  /** Epoch counterpart of startTime for owner consumers that need wall-clock start (skill_usage). */
  readonly startedAtEpochMs: number;
  tokenUsage = zero();
  interleavedBlockIds: string[] = [];
  interleavedBlocks: (MessageBlock & { blockIndex?: number })[] = [];
  dirtyInterleavedBlockIds = new Set<string>();
  intermediateSaveCommitted = false;
  globalBlockIndex = 0;
  pendingReasoningForApi: string | null = null;
  roundTextByToolCallId = new Map<string, string>();
  responseReasoningByToolCallId = new Map<string, unknown>();
  responseWebSearchItems: unknown[] = [];
  pendingThoughtSignature: string | null = null;
  currentAdapter: ChatV2StreamingAdapter | null = null;
  userContextRefs: SendContextRef[];
  contextSnapshot: Required<ContextSnapshot>;
  modelDisplayName: string | null = null;
  lastBlockEndedAt: number | null = null;
  workspaceId: string | null;
  workspaceInjectionCount = 0;
  private cancelSignal: AbortSignal | null = null;
  lastRoundHeartbeat = false;
  needsCompaction = false;

  constructor(request: PipelineSendRequest) {
    this.sessionId = request.sessionId;
    this.userMessageId = request.userMessageId ?? `msg_${globalThis.crypto.randomUUID()}`;
    this.assistantMessageId = request.assistantMessageId ?? `msg_${globalThis.crypto.randomUUID()}`;
    this.userContent = request.content;
    this.runtimeFacts = buildRuntimeFactsBlock(request.content);
    this.options = structuredClone(request.options ?? {});
    this.startTime = performance.now();
    this.startedAtEpochMs = Date.now();
    this.userContextRefs = structuredClone(request.userContextRefs ?? []);
    this.contextSnapshot = { userRefs: [], retrievalRefs: [],
      pathMap: structuredClone(request.pathMap ?? {}) };
    this.workspaceId = request.workspaceId ?? null;
  }

  setCancellationToken(signal: AbortSignal): void { this.cancelSignal = signal; }
  cancellationToken(): AbortSignal | null { return this.cancelSignal; }
  elapsedMs(): number { return Math.floor(performance.now() - this.startTime); }

  /** context.rs:1334–1382: append to history, before the current user's compiled message. */
  injectWorkspaceMessages(formatted: string, log: { debug(message: string): void }): boolean {
    if (formatted === '') return false;
    const message = historyMessage('user', formatted);
    message.metadata = { workspace_injection: true, workspace_id: this.workspaceId };
    this.chatHistory.push(message);
    this.workspaceInjectionCount++;
    log.debug(`[ChatV2::context] Injected workspace messages, total injections: ${this.workspaceInjectionCount}`);
    return true;
  }

  shouldContinueForWorkspace(): boolean {
    return this.workspaceInjectionCount > 0 && this.workspaceId !== null;
  }

  /** context.rs:1184 — only the frozen, non-empty live request is authoritative. */
  liveUserLlmContent(): string | null {
    const content = this.compiledCurrentUserMessage?.content;
    return content === undefined || content === '' ? null : content;
  }

  allToolResultsToMessages(): LegacyChatMessage[] {
    return allToolResultsToMessages(this.toolResults, this.roundTextByToolCallId, this.responseReasoningByToolCallId);
  }

  addToolResults(results: readonly ToolResultInfo[]): void {
    const owned = cloneAgentJson(results);
    for (const result of owned) {
      if (result.blockId !== undefined && result.blockId !== null) {
        this.dirtyInterleavedBlockIds.add(result.blockId);
      }
    }
    this.toolResults.push(...owned);
  }

  /** context.rs:766 — replacement keeps its index and always marks its payload dirty. */
  addInterleavedBlock(block: MessageBlock & { blockIndex?: number }): number {
    this.dirtyInterleavedBlockIds.add(block.id);
    const existing = this.interleavedBlocks.findIndex(value => value.id === block.id);
    const index = existing < 0 ? this.globalBlockIndex++ : this.interleavedBlocks[existing]!.blockIndex ?? 0;
    const owned = { ...cloneAgentJson(block), blockIndex: index };
    if (existing < 0) {
      this.interleavedBlockIds.push(block.id);
      this.interleavedBlocks.push(owned);
    } else this.interleavedBlocks[existing] = owned;
    return index;
  }

  /** context.rs:1207 — re-entrant: rebuild user refs, keep retrieval refs/path_map. */
  initContextSnapshot(log?: { debug(message: string): void }): void {
    this.contextSnapshot.userRefs = this.userContextRefs.map(ref => sendContextRefToContextRef(ref));
    log?.debug(`[ChatV2::pipeline] Initialized context snapshot with ${this.contextSnapshot.userRefs.length} user refs`);
  }

  /** context.rs:1228 */
  addRetrievalRefsToSnapshot(refs: readonly ContextRef[], log?: { debug(message: string): void }): void {
    this.contextSnapshot.retrievalRefs.push(...structuredClone(refs));
    log?.debug(`[ChatV2::pipeline] Added ${this.contextSnapshot.retrievalRefs.length} retrieval refs to context snapshot`);
  }

  /** context.rs:790 — empty segments are skipped; open segments end now. */
  collectStreamedTextSegments(segments: readonly StreamedTextSegment[], messageId: string): void {
    for (const segment of segments) {
      if (segment.content === '') continue;
      const endedAt = segment.endedAt ?? Date.now();
      this.addInterleavedBlock({ id: segment.blockId, messageId, type: segment.blockType, status: 'success',
        content: segment.content, startedAt: segment.startedAt, endedAt, firstChunkAt: segment.startedAt });
      this.lastBlockEndedAt = endedAt;
    }
  }

  /** context.rs:835 add_tool_block — the tool result block id is the persisted/evented id. */
  addToolBlock(result: ToolResultInfo, messageId: string): void {
    const now = Date.now();
    const startedAt = now - (result.durationMs ?? 0);
    this.addInterleavedBlock({ id: result.blockId ?? `blk_${globalThis.crypto.randomUUID()}`, messageId,
      type: getBlockTypeForToolStatic(result.toolName), status: result.success ? 'success' : 'error',
      toolName: result.toolName, toolInput: cloneAgentJson(result.input), toolOutput: cloneAgentJson(preBudgetOutput(result)),
      ...(result.success || result.error == null ? {} : { error: result.error }),
      startedAt, endedAt: now, firstChunkAt: startedAt });
    this.lastBlockEndedAt = now;
  }

  mergeResponseWebSearchItems(items: readonly unknown[]): void {
    const idOf = (item: unknown): string | null => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
      const id = (item as Record<string, unknown>).id;
      return typeof id === 'string' ? id : null;
    };
    for (const item of items) {
      const id = idOf(item);
      const index = id === null ? -1 : this.responseWebSearchItems.findIndex(v => idOf(v) === id);
      if (index < 0) this.responseWebSearchItems.push(structuredClone(item));
      else this.responseWebSearchItems[index] = structuredClone(item);
    }
  }
}
