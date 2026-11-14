/**
 * pipeline/llm_adapter.rs — chat-pipeline streaming adapter.
 *
 * Converts LLM stream hooks into block-level events, collects tool calls, keeps
 * the real reasoning/content alternation as distinct segments, and caches
 * server-side web-search items so they can be replayed on the next turn.
 *
 * The Rust adapter also owns the model wrap-token filters; those are injected
 * here so the state machine has no dependency on a future L02 streaming source.
 */
import { utf8ByteLength, ModelWrapTokenStreamFilter, create_model_wrap_token_filter } from '../../../platform/util/index.ts';
import type { TokenUsage } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import { parseApiUsage } from './token-usage.ts';
import type { LegacyChatMessage } from './microcompact.ts';
import { cloneAgentJson } from '../../../kernel/agent-api.ts';

export const EVENT_TYPE_THINKING = 'thinking';
export const EVENT_TYPE_CONTENT = 'content';
export const EVENT_TYPE_WEB_SEARCH = 'web_search';
export const EVENT_TYPE_TOOL_CALL_PREPARING = 'tool_call_preparing';

export const BLOCK_TYPE_THINKING = 'thinking';
export const BLOCK_TYPE_CONTENT = 'content';

export interface StreamedTextSegment {
  blockId: string;
  blockType: string;
  content: string;
  startedAt: number;
  endedAt: number | null;
}

export type BlockEventPhase = 'start' | 'chunk' | 'end' | 'error';

/** chat_v2/events.rs `RegisteredBlockMeta`: round/skill-state attribution. */
export interface StreamEventMeta {
  skillStateVersion: number | null;
  roundId: string | null;
  variantId?: string | null;
}

/** Minimal block-event sink; the L04 emitter is wired once streaming exists. */
export interface StreamEventSink {
  emitStart(type: string, messageId: string, blockId: string | null,
    payload: unknown | null, meta?: StreamEventMeta): void;
  emitChunk(type: string, blockId: string, chunk: string, meta?: StreamEventMeta): void;
  emitEnd(type: string, blockId: string, result: unknown | null, meta?: StreamEventMeta): void;
  emitError(type: string, blockId: string, error: string, meta?: StreamEventMeta): void;
  emitToolCallPreparingStart(messageId: string, toolCallId: string, toolName: string,
    blockId: string | null, meta?: StreamEventMeta): void;
}

export interface StreamingAdapterLog {
  error(message: string): void;
  warn(message: string): void;
}

let adapterLogger: StreamingAdapterLog = { error() {}, warn() {} };

/** Plugin wiring supplies the Cordis logger; unit tests keep the quiet default. */
export function configureStreamingAdapterLogger(logger: StreamingAdapterLog): void {
  adapterLogger = logger;
}

/** model_special_tokens::ModelWrapTokenStreamFilter subset. */
export interface WrapTokenFilter {
  process(text: string): string;
  flush(): string;
  reset(): void;
}

/** `ModelWrapTokenPolicy::Disabled` behaviour. */
export function identityWrapTokenFilter(): WrapTokenFilter {
  return new ModelWrapTokenStreamFilter();
}

export interface WrapTokenModelConfig {
  providerType?: string | null;
  providerScope?: string | null;
  model: string;
}

export function modelWrapTokenFilter(config?: WrapTokenModelConfig | null): WrapTokenFilter {
  return config == null ? identityWrapTokenFilter()
    : create_model_wrap_token_filter(config.providerType, config.providerScope, config.model);
}

export interface StreamingToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface WebSearchSource {
  title: string | null;
  url: string | null;
  snippet: string | null;
  score: null;
  metadata: { sourceType: 'web_search' };
}

export interface StreamingAdapterOptions {
  modelConfig?: WrapTokenModelConfig | null;
  enableThinking: boolean;
  skillStateVersion?: number | null;
  roundId?: string | null;
  contentWrapTokenFilter?: WrapTokenFilter;
  reasoningWrapTokenFilter?: WrapTokenFilter;
  /** Injectable wall clock for persisted timestamps. */
  now?: () => number;
  /** Injectable monotonic clock for idle detection (Rust `Instant`). */
  elapsed?: () => number;
  /** Injectable block id source for deterministic tests. */
  generateBlockId?: () => string;
}

function stringField(value: unknown, key: string): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : null;
}

function arrayField(value: unknown, key: string): unknown[] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field) ? field : null;
}

export class ChatV2StreamingAdapter {
  private readonly sink: StreamEventSink;
  private readonly messageId: string;
  private readonly enableThinking: boolean;
  private readonly skillStateVersion: number | null;
  private readonly roundId: string | null;
  private readonly now: () => number;
  private readonly elapsed: () => number;
  private readonly generateBlockId: () => string;

  private readonly contentWrapFilter: WrapTokenFilter;
  private readonly reasoningWrapFilter: WrapTokenFilter;

  private thinkingBlockId: string | null = null;
  private contentBlockId: string | null = null;
  private textSegments: StreamedTextSegment[] = [];
  private accumulatedContent = '';
  private accumulatedReasoning = '';
  private reasoningContentObserved = false;
  private collectedToolCalls: StreamingToolCall[] = [];
  private apiUsage: TokenUsage | null = null;
  private inThinkTag = false;
  private thinkTagBuffer = '';
  private cachedThoughtSignature: string | null = null;
  private responseReasoningItems: Array<[string | null, unknown]> = [];
  private preparingBlockIds = new Map<string, string>();
  private announcedToolCallIds = new Set<string>();
  private unpromotedPreparingBlockIds = new Map<string, string>();
  private argsDeltaBuffer = new Map<string, string>();
  private lastActivityAt: number;
  private webSearchBlockId: string | null = null;
  private webSearchStartedAt: number | null = null;
  private cachedWebSearchSources: WebSearchSource[] | null = null;
  private cachedWebSearchItems: unknown[] = [];

  constructor(sink: StreamEventSink, messageId: string, options: StreamingAdapterOptions) {
    this.sink = sink;
    this.messageId = messageId;
    this.enableThinking = options.enableThinking;
    this.skillStateVersion = options.skillStateVersion ?? null;
    this.roundId = options.roundId ?? null;
    this.now = options.now ?? Date.now;
    this.elapsed = options.elapsed ?? (() => performance.now());
    this.generateBlockId = options.generateBlockId
      ?? (() => `blk_${globalThis.crypto.randomUUID()}`);
    this.contentWrapFilter = options.contentWrapTokenFilter ?? modelWrapTokenFilter(options.modelConfig);
    this.reasoningWrapFilter = options.reasoningWrapTokenFilter ?? modelWrapTokenFilter(options.modelConfig);
    this.lastActivityAt = this.elapsed();
  }

  idleElapsedMs(): number {
    return Math.max(0, this.elapsed() - this.lastActivityAt);
  }

  getTextSegments(): StreamedTextSegment[] {
    return this.textSegments.map(segment => ({ ...segment }));
  }

  getAccumulatedContent(): string {
    return this.accumulatedContent;
  }

  getAccumulatedReasoning(): string | null {
    return this.reasoningContentObserved || this.accumulatedReasoning !== ''
      ? this.accumulatedReasoning
      : null;
  }

  getThinkingBlockId(): string | null {
    for (let index = this.textSegments.length - 1; index >= 0; index--) {
      const segment = this.textSegments[index]!;
      if (segment.blockType === BLOCK_TYPE_THINKING) return segment.blockId;
    }
    return null;
  }

  getContentBlockId(): string | null {
    for (let index = this.textSegments.length - 1; index >= 0; index--) {
      const segment = this.textSegments[index]!;
      if (segment.blockType === BLOCK_TYPE_CONTENT) return segment.blockId;
    }
    return null;
  }

  takeToolCalls(): StreamingToolCall[] {
    const calls = this.collectedToolCalls;
    this.collectedToolCalls = [];
    return calls;
  }

  hasToolCalls(): boolean {
    return this.collectedToolCalls.length > 0;
  }

  hasPreparingBlocks(): boolean {
    return this.unpromotedPreparingBlockIds.size > 0;
  }

  /**
   * 标记本轮已发出 tool_call_preparing 的占位块已交由工具执行阶段接管（或按指定 toolCallIds 精确标记），
   * 避免后续轮次重置或错误清理误杀已进入执行期的工具块。
   */
  markPreparingPromoted(toolCallIds?: Iterable<string>): void {
    if (toolCallIds === undefined) {
      this.unpromotedPreparingBlockIds.clear();
      return;
    }
    for (const id of toolCallIds) {
      this.unpromotedPreparingBlockIds.delete(id);
    }
  }

  /** 丢弃尚未进入工具执行阶段的 preparing 占位块（发 tool_call_preparing:end 让前端安全移除）。 */
  discardPreparingBlocks(): number {
    if (this.unpromotedPreparingBlockIds.size === 0) return 0;
    const count = this.unpromotedPreparingBlockIds.size;
    for (const [toolCallId, blockId] of this.unpromotedPreparingBlockIds) {
      this.emitEnd(EVENT_TYPE_TOOL_CALL_PREPARING, blockId, null);
      this.preparingBlockIds.delete(toolCallId);
      this.argsDeltaBuffer.delete(toolCallId);
    }
    this.unpromotedPreparingBlockIds.clear();
    return count;
  }

  /** 将尚未进入工具执行阶段的 preparing 占位块推进为错误终态（发 tool_call_preparing:error）。 */
  failPreparingBlocks(error: string): number {
    if (this.unpromotedPreparingBlockIds.size === 0) return 0;
    const count = this.unpromotedPreparingBlockIds.size;
    for (const [toolCallId, blockId] of this.unpromotedPreparingBlockIds) {
      this.emitError(EVENT_TYPE_TOOL_CALL_PREPARING, blockId, error);
      this.preparingBlockIds.delete(toolCallId);
      this.argsDeltaBuffer.delete(toolCallId);
    }
    this.unpromotedPreparingBlockIds.clear();
    return count;
  }

  getApiUsage(): TokenUsage | null {
    return this.apiUsage;
  }

  getThoughtSignature(): string | null {
    return this.cachedThoughtSignature;
  }

  getResponseReasoningItems(): Array<[string | null, unknown]> {
    return this.responseReasoningItems.map(([id, item]) =>
      [id, structuredClone(item)] as [string | null, unknown]);
  }

  takeWebSearchSources(): WebSearchSource[] | null {
    const sources = this.cachedWebSearchSources;
    this.cachedWebSearchSources = null;
    return sources;
  }

  takeWebSearchItems(): unknown[] {
    const items = this.cachedWebSearchItems;
    this.cachedWebSearchItems = [];
    return items;
  }

  /**
   * Retry reset: a failed attempt may have streamed partial content or
   * collected tool calls, so every accumulator and active block id is cleared.
   */
  resetStreamState(): void {
    this.discardPreparingBlocks();
    this.accumulatedContent = '';
    this.accumulatedReasoning = '';
    this.reasoningContentObserved = false;
    this.collectedToolCalls = [];
    this.apiUsage = null;
    this.inThinkTag = false;
    this.thinkTagBuffer = '';
    this.contentWrapFilter.reset();
    this.reasoningWrapFilter.reset();
    this.cachedThoughtSignature = null;
    this.responseReasoningItems = [];
    this.preparingBlockIds.clear();
    this.announcedToolCallIds.clear();
    this.unpromotedPreparingBlockIds.clear();
    this.argsDeltaBuffer.clear();
    this.thinkingBlockId = null;
    this.contentBlockId = null;
    this.textSegments = [];
    this.webSearchBlockId = null;
    this.webSearchStartedAt = null;
    this.cachedWebSearchSources = null;
    this.cachedWebSearchItems = [];
    this.touchActivity();
  }

  onContentChunk(text: string): void {
    this.touchActivity();
    if (text === '') return;

    const filtered = this.contentWrapFilter.process(text);
    if (filtered === '') return;

    this.thinkTagBuffer += filtered;
    this.processThinkTagBuffer();
  }

  onReasoningChunk(text: string): void {
    this.touchActivity();
    if (!this.enableThinking) return;

    this.reasoningContentObserved = true;
    if (text === '') return;

    const filtered = this.reasoningWrapFilter.process(text);
    if (filtered === '') return;

    this.accumulatedReasoning += filtered;
    const blockId = this.ensureThinkingStarted();
    if (blockId !== null) {
      this.appendTextSegment(blockId, filtered);
      this.emitChunk(EVENT_TYPE_THINKING, blockId, filtered);
    }
  }

  onToolCallStart(toolCallId: string, toolName: string): void {
    this.touchActivity();
    const firstStart = !this.announcedToolCallIds.has(toolCallId);
    if (firstStart) this.announcedToolCallIds.add(toolCallId);

    // Pair the most recent unpaired reasoning item with this function call.
    // A repeated start for an already-paired id must never claim the next item.
    const alreadyClaimed = this.responseReasoningItems
      .some(([id]) => id === toolCallId);
    if (!alreadyClaimed) {
      for (let index = this.responseReasoningItems.length - 1; index >= 0; index--) {
        const entry = this.responseReasoningItems[index]!;
        if (entry[0] === null) {
          entry[0] = toolCallId;
          break;
        }
      }
    }

    if (!firstStart) return;

    // Retrieval tools render their own block and emit no tool_call_start, so a
    // preparing block here would orphan a second row.
    if (ChatV2StreamingAdapter.isBuiltinRetrievalTool(toolName)) return;

    const blockId = this.generateBlockId();
    this.preparingBlockIds.set(toolCallId, blockId);
    this.unpromotedPreparingBlockIds.set(toolCallId, blockId);
    this.emitToolCallPreparingStart(this.messageId, toolCallId, toolName, blockId);
  }

  onToolCallArgsDelta(toolCallId: string, delta: string): void {
    this.touchActivity();
    const blockId = this.preparingBlockIds.get(toolCallId);
    if (blockId === undefined) return;

    const buffered = (this.argsDeltaBuffer.get(toolCallId) ?? '') + delta;
    this.argsDeltaBuffer.set(toolCallId, buffered);
    if (utf8ByteLength(buffered) < 500) return;

    this.argsDeltaBuffer.delete(toolCallId);
    if (buffered !== '') this.emitChunk(EVENT_TYPE_TOOL_CALL_PREPARING, blockId, buffered);
  }

  onToolCall(message: LegacyChatMessage): void {
    const toolCall = message.tool_call;
    if (toolCall === undefined || toolCall === null) return;
    this.flushArgsDeltaBuffer(toolCall.id);
    this.collectedToolCalls.push({
      id: toolCall.id,
      name: toolCall.tool_name,
      arguments: cloneAgentJson(toolCall.args_json),
    });
  }

  onThoughtSignature(signature: string): void {
    this.cachedThoughtSignature = signature;
  }

  onResponseReasoningItem(item: unknown): void {
    this.touchActivity();
    this.responseReasoningItems.push([null, structuredClone(item)]);
  }

  onUsage(usage: unknown): void {
    this.touchActivity();
    const tokenUsage = parseApiUsage(usage);
    if (tokenUsage !== null) this.apiUsage = tokenUsage;
  }

  onWebSearch(payload: unknown): void {
    this.touchActivity();
    this.handleWebSearch(payload);
  }

  onComplete(): void {
    this.finalizeAllWithAuthoritativeContent();
  }

  onError(error: string): void {
    adapterLogger.error(`[ChatV2::pipeline] LLM adapter error for message `
      + `${this.messageId}: ${error}`);
    const contentBlockId = this.contentBlockId;
    this.contentBlockId = null;
    if (contentBlockId !== null) {
      this.finishTextSegment(contentBlockId);
      this.emitError(EVENT_TYPE_CONTENT, contentBlockId, error);
    }
    this.failPreparingBlocks(error);
    this.finalizeThinking();
  }

  finalizeAll(): void {
    this.finalizeAllInner(false);
  }

  /** `<think>`/`<thinking>` start-tag prefix detection (never matches `<table>`). */
  static endsWithPotentialThinkStart(text: string): boolean {
    return ['<thinking', '<thinkin', '<thinki', '<think', '<thin', '<thi', '<th', '<t', '<']
      .some(prefix => text.endsWith(prefix));
  }

  /** `</think>`/`</thinking>` end-tag prefix detection. */
  static endsWithPotentialThinkEnd(text: string): boolean {
    return ['</thinking', '</thinkin', '</thinki', '</think', '</thin', '</thi', '</th',
      '</t', '</', '<'].some(prefix => text.endsWith(prefix));
  }

  static isBuiltinRetrievalTool(toolName: string): boolean {
    if (toolName.startsWith('mcp_') || toolName.startsWith('mcp.tools.')) return false;
    const stripped = toolName.startsWith('builtin-')
      ? toolName.slice('builtin-'.length)
      : toolName.startsWith('builtin:')
        ? toolName.slice('builtin:'.length)
        : toolName;
    // 与执行器发出自定义检索块的集合保持一致；memory_search 由 MemoryToolExecutor 发标准 tool_call。
    return stripped === 'rag_search'
      || stripped === 'multimodal_search'
      || stripped === 'unified_search'
      || stripped === 'web_search'
      || stripped === 'insight_recall';
  }

  /** `ChatV2LLMAdapter::generate_block_id` — `blk_` + a UUID. */
  static generateBlockId(): string {
    return `blk_${globalThis.crypto.randomUUID()}`;
  }

  // RUST-FIX(RF-W05-streaming-adapter-block-round-id): attach roundId and skillStateVersion to all block events (content, thinking, web_search, tool_call_preparing), not only tool_call_preparing.
  private eventMeta(): StreamEventMeta {
    return { skillStateVersion: this.skillStateVersion, roundId: this.roundId };
  }

  private emitStart(type: string, messageId: string, blockId: string | null,
    payload: unknown | null): void {
    this.sink.emitStart(type, messageId, blockId, payload, this.eventMeta());
  }

  private emitChunk(type: string, blockId: string, chunk: string): void {
    this.sink.emitChunk(type, blockId, chunk, this.eventMeta());
  }

  private emitEnd(type: string, blockId: string, result: unknown | null): void {
    this.sink.emitEnd(type, blockId, result, this.eventMeta());
  }

  private emitError(type: string, blockId: string, error: string): void {
    this.sink.emitError(type, blockId, error, this.eventMeta());
  }

  private emitToolCallPreparingStart(messageId: string, toolCallId: string, toolName: string,
    blockId: string | null): void {
    this.sink.emitToolCallPreparingStart(messageId, toolCallId, toolName, blockId,
      this.eventMeta());
  }

  private touchActivity(): void {
    this.lastActivityAt = this.elapsed();
  }

  private flushArgsDeltaBuffer(toolCallId: string): void {
    const blockId = this.preparingBlockIds.get(toolCallId);
    if (blockId === undefined) return;
    this.preparingBlockIds.delete(toolCallId);
    const chunk = this.argsDeltaBuffer.get(toolCallId) ?? '';
    this.argsDeltaBuffer.delete(toolCallId);
    if (chunk !== '') this.emitChunk(EVENT_TYPE_TOOL_CALL_PREPARING, blockId, chunk);
  }

  private ensureThinkingStarted(): string | null {
    if (!this.enableThinking) return null;

    // Reasoning after content means the previous content segment is finished;
    // later text must open a new content block.
    this.finalizeContent(true);

    if (this.thinkingBlockId === null) {
      const blockId = this.generateBlockId();
      this.textSegments.push({
        blockId,
        blockType: BLOCK_TYPE_THINKING,
        content: '',
        startedAt: this.now(),
        endedAt: null,
      });
      this.emitStart(EVENT_TYPE_THINKING, this.messageId, blockId, null);
      this.thinkingBlockId = blockId;
    }
    return this.thinkingBlockId;
  }

  private ensureContentStarted(): string {
    this.finalizeThinking();
    if (this.contentBlockId === null) {
      const blockId = this.generateBlockId();
      this.textSegments.push({
        blockId,
        blockType: BLOCK_TYPE_CONTENT,
        content: '',
        startedAt: this.now(),
        endedAt: null,
      });
      this.emitStart(EVENT_TYPE_CONTENT, this.messageId, blockId, null);
      this.contentBlockId = blockId;
    }
    return this.contentBlockId;
  }

  private finalizeThinking(): void {
    const blockId = this.thinkingBlockId;
    if (blockId === null) return;
    this.thinkingBlockId = null;
    this.finishTextSegment(blockId);
    this.emitEnd(EVENT_TYPE_THINKING, blockId, null);
  }

  private finalizeContent(includeAuthoritativeContent: boolean): void {
    const blockId = this.contentBlockId;
    if (blockId === null) return;
    this.contentBlockId = null;
    this.finishTextSegment(blockId);
    const result = includeAuthoritativeContent
      ? { content: this.textSegmentContent(blockId) }
      : null;
    this.emitEnd(EVENT_TYPE_CONTENT, blockId, result);
  }

  private appendTextSegment(blockId: string, text: string): void {
    for (let index = this.textSegments.length - 1; index >= 0; index--) {
      const segment = this.textSegments[index]!;
      if (segment.blockId === blockId) {
        segment.content += text;
        return;
      }
    }
  }

  private finishTextSegment(blockId: string): void {
    for (let index = this.textSegments.length - 1; index >= 0; index--) {
      const segment = this.textSegments[index]!;
      if (segment.blockId === blockId) {
        segment.endedAt = this.now();
        return;
      }
    }
  }

  private textSegmentContent(blockId: string): string {
    return this.textSegments.find(segment => segment.blockId === blockId)?.content ?? '';
  }

  private finalizeAllWithAuthoritativeContent(): void {
    this.finalizeAllInner(true);
  }

  private finalizeAllInner(includeAuthoritativeContent: boolean): void {
    const contentTail = this.contentWrapFilter.flush();
    if (contentTail !== '') this.thinkTagBuffer += contentTail;

    // The reasoning channel has its own filter and never participates in the
    // `<think>` tag state machine; its tail goes straight to thinking.
    const reasoningTail = this.reasoningWrapFilter.flush();
    if (reasoningTail !== '' && this.enableThinking) {
      this.accumulatedReasoning += reasoningTail;
      const blockId = this.ensureThinkingStarted();
      if (blockId !== null) {
        this.appendTextSegment(blockId, reasoningTail);
        this.emitChunk(EVENT_TYPE_THINKING, blockId, reasoningTail);
      }
    }

    this.flushThinkTagBuffer();
    this.finalizeThinking();
    this.finalizeContent(includeAuthoritativeContent);
  }

  private flushThinkTagBuffer(): void {
    if (this.thinkTagBuffer === '') return;
    const remaining = this.thinkTagBuffer;
    this.thinkTagBuffer = '';

    if (this.inThinkTag && this.enableThinking) {
      adapterLogger.warn(`[ChatV2::LLMAdapter] Flushing unclosed <think> tag content: `
        + `${remaining.length} chars`);
      this.accumulatedReasoning += remaining;
      const blockId = this.ensureThinkingStarted();
      if (blockId !== null) {
        this.appendTextSegment(blockId, remaining);
        this.emitChunk(EVENT_TYPE_THINKING, blockId, remaining);
      }
    } else if (remaining !== '') {
      this.accumulatedContent += remaining;
      const blockId = this.ensureContentStarted();
      this.appendTextSegment(blockId, remaining);
      this.emitChunk(EVENT_TYPE_CONTENT, blockId, remaining);
    }
  }

  /** Routes `<think>`-tagged relay output into thinking/content blocks. */
  private processThinkTagBuffer(): void {
    const START_TAGS = ['<thinking>', '<think>'];
    const END_TAGS = ['</thinking>', '</think>'];

    for (;;) {
      if (this.thinkTagBuffer === '') return;

      if (this.inThinkTag) {
        let endPos = -1;
        let tagLength = 0;
        for (const endTag of END_TAGS) {
          const position = this.thinkTagBuffer.indexOf(endTag);
          if (position >= 0 && (endPos < 0 || position < endPos)) {
            endPos = position;
            tagLength = endTag.length;
          }
        }

        if (endPos >= 0) {
          const thinkingContent = this.thinkTagBuffer.slice(0, endPos);
          this.thinkTagBuffer = this.thinkTagBuffer.slice(endPos + tagLength);
          if (thinkingContent !== '' && this.enableThinking) {
            this.accumulatedReasoning += thinkingContent;
            const blockId = this.ensureThinkingStarted();
            if (blockId !== null) {
              this.appendTextSegment(blockId, thinkingContent);
              this.emitChunk(EVENT_TYPE_THINKING, blockId, thinkingContent);
            }
          }
          this.inThinkTag = false;
          continue;
        }

        if (ChatV2StreamingAdapter.endsWithPotentialThinkEnd(this.thinkTagBuffer)) return;

        const thinkingContent = this.thinkTagBuffer;
        this.thinkTagBuffer = '';
        if (thinkingContent !== '' && this.enableThinking) {
          this.accumulatedReasoning += thinkingContent;
          const blockId = this.ensureThinkingStarted();
          if (blockId !== null) {
            this.appendTextSegment(blockId, thinkingContent);
            this.emitChunk(EVENT_TYPE_THINKING, blockId, thinkingContent);
          }
        }
        return;
      }

      let startPos = -1;
      let tagLength = 0;
      for (const startTag of START_TAGS) {
        const position = this.thinkTagBuffer.indexOf(startTag);
        if (position >= 0 && (startPos < 0 || position < startPos)) {
          startPos = position;
          tagLength = startTag.length;
        }
      }

      if (startPos >= 0) {
        const contentBefore = this.thinkTagBuffer.slice(0, startPos);
        this.thinkTagBuffer = this.thinkTagBuffer.slice(startPos + tagLength);
        if (contentBefore !== '') {
          this.accumulatedContent += contentBefore;
          const blockId = this.ensureContentStarted();
          this.appendTextSegment(blockId, contentBefore);
          this.emitChunk(EVENT_TYPE_CONTENT, blockId, contentBefore);
        }
        this.inThinkTag = true;
        continue;
      }

      if (ChatV2StreamingAdapter.endsWithPotentialThinkStart(this.thinkTagBuffer)) {
        const ltPosition = this.thinkTagBuffer.lastIndexOf('<');
        if (ltPosition >= 0) {
          const contentBefore = this.thinkTagBuffer.slice(0, ltPosition);
          this.thinkTagBuffer = this.thinkTagBuffer.slice(ltPosition);
          if (contentBefore !== '') {
            this.accumulatedContent += contentBefore;
            const blockId = this.ensureContentStarted();
            this.appendTextSegment(blockId, contentBefore);
            this.emitChunk(EVENT_TYPE_CONTENT, blockId, contentBefore);
          }
        }
        return;
      }

      const content = this.thinkTagBuffer;
      this.thinkTagBuffer = '';
      if (content !== '') {
        this.accumulatedContent += content;
        const blockId = this.ensureContentStarted();
        this.appendTextSegment(blockId, content);
        this.emitChunk(EVENT_TYPE_CONTENT, blockId, content);
      }
      return;
    }
  }

  private cacheWebSearchItem(item: unknown): void {
    const id = stringField(item, 'id');
    if (id !== null) {
      const existingIndex = this.cachedWebSearchItems
        .findIndex(existing => stringField(existing, 'id') === id);
      if (existingIndex >= 0) {
        this.cachedWebSearchItems[existingIndex] = structuredClone(item);
        return;
      }
    }
    this.cachedWebSearchItems.push(structuredClone(item));
  }

  private handleWebSearch(payload: unknown): void {
    const item = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).item
      : undefined;
    if (item !== undefined) this.cacheWebSearchItem(item);

    const stage = stringField(payload, 'stage') ?? 'completed';

    if (stage === 'completed') {
      const entries = arrayField(payload, 'sources') ?? [];
      const sources = new Map((this.cachedWebSearchSources ?? []).map(source => [source.url, source]));
      for (const entry of entries) {
        const url = stringField(entry, 'url') ?? '';
        if (url === '') continue;
        const prior = sources.get(url);
        sources.set(url, {
          title: stringField(entry, 'title') || prior?.title || null,
          url,
          snippet: stringField(entry, 'snippet') || prior?.snippet || null,
          score: null,
          metadata: { sourceType: 'web_search' },
        });
      }
      this.cachedWebSearchSources = [...sources.values()];

      // A completed-only stream still needs the start event, or the frontend
      // never creates the web_search block.
      let blockId = this.webSearchBlockId;
      if (blockId === null) {
        blockId = this.generateBlockId();
        this.emitStart(EVENT_TYPE_WEB_SEARCH, this.messageId, blockId, null);
        this.webSearchBlockId = blockId;
      }

      const durationMs = this.webSearchStartedAt === null
        ? 0
        : Math.max(0, this.now() - this.webSearchStartedAt);

      const numberedSources = this.cachedWebSearchSources.map((source, index) => ({
        index: index + 1,
        citationTag: `[搜索-${index + 1}]`,
        typeIndex: index + 1,
        title: source.title,
        url: source.url,
        snippet: source.snippet,
        score: source.score,
        source_type: 'web_search',
      }));

      this.emitEnd(EVENT_TYPE_WEB_SEARCH, blockId, {
        sources: numberedSources,
        count: numberedSources.length,
        durationMs,
      });
    } else {
      if (this.webSearchBlockId === null) {
        const generated = this.generateBlockId();
        this.emitStart(EVENT_TYPE_WEB_SEARCH, this.messageId, generated, null);
        this.webSearchBlockId = generated;
      }
      this.webSearchStartedAt = this.now();
    }
  }
}
