/**
 * pipeline/variant_adapter.rs — streaming adapter for one parallel variant.
 *
 * Same reasoning/content alternation semantics as the single-variant adapter,
 * but every finished segment is synchronised into the variant's interleaved
 * block list immediately, so cancellation or a dropped stream before
 * `onComplete` still leaves the full incremental text in the context.
 */
import { utf8ByteLength } from '../../../platform/util/index.ts';
import {
  ChatV2StreamingAdapter, modelWrapTokenFilter, type WrapTokenModelConfig, type StreamedTextSegment,
  type StreamingToolCall, type WrapTokenFilter, type StreamEventSink, type StreamEventMeta,
} from './llm-adapter.ts';
import type { TokenUsage } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import { parseApiUsage } from './token-usage.ts';
import type { LegacyChatMessage } from './microcompact.ts';
import { cloneAgentJson } from '../../../kernel/agent-api.ts';

export const VARIANT_BLOCK_STATUS_SUCCESS = 'success';

export interface VariantAdapterLog {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

let variantLogger: VariantAdapterLog = { info() {}, warn() {}, debug() {} };

export function configureVariantAdapterLogger(logger: VariantAdapterLog): void {
  variantLogger = logger;
}

export interface VariantMessageBlock {
  id: string;
  messageId: string;
  blockType: string;
  status: string;
  content: string | null;
  startedAt: number | null;
  endedAt: number | null;
  firstChunkAt: number | null;
  blockIndex: number;
}

export interface VariantBlockEvent {
  type: string;
  phase: 'start' | 'chunk' | 'end' | 'error';
  blockId: string;
  chunk?: string;
  result?: unknown;
  payload?: unknown;
  error?: string;
}

/** The variant context surface the adapter drives (L03 stream context or the L04 VariantExecutionContext bridge). */
export interface VariantStreamHost {
  readonly variantId: string;
  readonly messageId: string;
  addInterleavedBlock(block: VariantMessageBlock): number;
  appendInterleavedBlockContent(blockId: string, text: string): boolean;
  getThinkingBlockId(): string | null;
  getContentBlockId(): string | null;
  setThinkingBlockId(blockId: string): void;
  setContentBlockId(blockId: string): void;
  appendContent(text: string): void;
  appendReasoning(text: string): void;
  addToolCall(call: StreamingToolCall): void;
  takeToolCalls(): StreamingToolCall[];
  setUsage(usage: TokenUsage): void;
  resetForNewRound(): void;
  emitToolCallPreparingStart(toolCallId: string, toolName: string, blockId: string, metadata?: StreamEventMeta): void;
  emitStart(type: string, blockId: string, payload: unknown | null): void;
  emitChunk(type: string, blockId: string, chunk: string): void;
  emitEnd(type: string, blockId: string, result: unknown | null): void;
  emitError?(type: string, blockId: string, error: string): void;
}

/**
 * VariantExecutionContext subset needed by the adapter. The production factory
 * binds an immediate event sink; the retained events array is diagnostic only.
 */
export class VariantStreamContext implements VariantStreamHost {
  readonly variantId: string;
  readonly modelId: string;
  readonly messageId: string;
  private readonly blocks: VariantMessageBlock[] = [];
  private readonly interleavedBlockIds: string[] = [];
  private thinkingBlockId: string | null = null;
  private contentBlockId: string | null = null;
  private accumulatedContent = '';
  private accumulatedReasoning = '';
  private collectedToolCalls: StreamingToolCall[] = [];
  private usage: TokenUsage | null = null;
  readonly events: VariantBlockEvent[] = [];
  private readonly now: () => number;
  private readonly sink: StreamEventSink | undefined;

  constructor(variantId: string, modelId: string, messageId: string,
    options: { now?: () => number; sink?: StreamEventSink } = {}) {
    this.variantId = variantId;
    this.modelId = modelId;
    this.messageId = messageId;
    this.now = options.now ?? Date.now;
    this.sink = options.sink;
  }

  addInterleavedBlock(block: VariantMessageBlock): number {
    const existing = this.blocks.find(candidate => candidate.id === block.id);
    if (existing !== undefined) {
      const index = existing.blockIndex;
      block.blockIndex = index;
      Object.assign(existing, block);
      return index;
    }
    const index = this.blocks.length;
    block.blockIndex = index;
    this.interleavedBlockIds.push(block.id);
    this.blocks.push(block);
    return index;
  }

  appendInterleavedBlockContent(blockId: string, text: string): boolean {
    for (let index = this.blocks.length - 1; index >= 0; index--) {
      const block = this.blocks[index]!;
      if (block.id !== blockId) continue;
      block.content = (block.content ?? '') + text;
      block.endedAt = this.now();
      return true;
    }
    return false;
  }

  getInterleavedBlocks(): VariantMessageBlock[] {
    return this.blocks.map(block => ({ ...block }));
  }

  getInterleavedBlockIds(): string[] {
    return [...this.interleavedBlockIds];
  }

  /** The variant's owned block ids; interleaved blocks are the streaming subset. */
  blockIds(): string[] {
    return [...this.interleavedBlockIds];
  }

  getThinkingBlockId(): string | null {
    return this.thinkingBlockId;
  }

  getContentBlockId(): string | null {
    return this.contentBlockId;
  }

  setThinkingBlockId(blockId: string): void {
    this.thinkingBlockId = blockId;
  }

  setContentBlockId(blockId: string): void {
    this.contentBlockId = blockId;
  }

  appendContent(text: string): void {
    this.accumulatedContent += text;
  }

  appendReasoning(text: string): void {
    this.accumulatedReasoning += text;
  }

  getAccumulatedContent(): string {
    return this.accumulatedContent;
  }

  getAccumulatedReasoning(): string {
    return this.accumulatedReasoning;
  }

  addToolCall(call: StreamingToolCall): void {
    this.collectedToolCalls.push(call);
  }

  takeToolCalls(): StreamingToolCall[] {
    const calls = this.collectedToolCalls;
    this.collectedToolCalls = [];
    return calls;
  }

  setUsage(usage: TokenUsage): void {
    this.usage = usage;
  }

  getUsage(): TokenUsage | null {
    return this.usage;
  }

  /** variant_context.rs `reset_for_new_round`: accumulated text/ids only. */
  resetForNewRound(): void {
    this.accumulatedContent = '';
    this.accumulatedReasoning = '';
    this.thinkingBlockId = null;
    this.contentBlockId = null;
  }

  private eventMeta(): StreamEventMeta {
    return { variantId: this.variantId, skillStateVersion: null, roundId: null };
  }

  emitToolCallPreparingStart(toolCallId: string, toolName: string, blockId: string,
    metadata?: StreamEventMeta): void {
    this.events.push({
      type: 'tool_call_preparing', phase: 'start', blockId,
      result: { toolCallId, toolName },
    });
    this.sink?.emitToolCallPreparingStart(this.messageId, toolCallId, toolName, blockId,
      { ...this.eventMeta(), ...metadata, variantId: this.variantId });
  }

  emitStart(type: string, blockId: string, payload: unknown | null): void {
    this.events.push({ type, phase: 'start', blockId, payload });
    this.sink?.emitStart(type, this.messageId, blockId, payload, this.eventMeta());
  }

  emitChunk(type: string, blockId: string, chunk: string): void {
    this.events.push({ type, phase: 'chunk', blockId, chunk });
    this.sink?.emitChunk(type, blockId, chunk, this.eventMeta());
  }

  emitEnd(type: string, blockId: string, result: unknown | null): void {
    this.events.push({ type, phase: 'end', blockId, result });
    this.sink?.emitEnd(type, blockId, result, this.eventMeta());
  }

  emitError(type: string, blockId: string, error: string): void {
    this.events.push({ type, phase: 'error', blockId, error });
    this.sink?.emitError(type, blockId, error, this.eventMeta());
  }
}

export interface VariantAdapterOptions {
  modelConfig?: WrapTokenModelConfig | null;
  enableThinking: boolean;
  skillStateVersion?: number | null;
  roundId?: string | null;
  contentWrapTokenFilter?: WrapTokenFilter;
  reasoningWrapTokenFilter?: WrapTokenFilter;
  now?: () => number;
  generateBlockId?: () => string;
}

export function authoritativeContentResult(content: string): { content: string } {
  return { content };
}

export class VariantStreamingAdapter {
  private readonly ctx: VariantStreamHost;
  private readonly enableThinking: boolean;
  private readonly now: () => number;
  private readonly generateBlockId: () => string;
  private readonly contentWrapFilter: WrapTokenFilter;
  private readonly reasoningWrapFilter: WrapTokenFilter;
  private readonly skillStateVersion: number | null;
  private readonly roundId: string | null;

  private contentBlockInitialized = false;
  private thinkingBlockInitialized = false;
  private textSegments: StreamedTextSegment[] = [];
  private inThinkTag = false;
  private thinkTagBuffer = '';
  private readonly preparingBlockIds = new Map<string, string>();
  private readonly unpromotedPreparingBlockIds = new Map<string, string>();
  private readonly argsDeltaBuffer = new Map<string, string>();

  constructor(ctx: VariantStreamHost, options: VariantAdapterOptions) {
    this.ctx = ctx;
    this.enableThinking = options.enableThinking;
    this.now = options.now ?? Date.now;
    this.generateBlockId = options.generateBlockId ?? (() => `blk_${globalThis.crypto.randomUUID()}`);
    this.contentWrapFilter = options.contentWrapTokenFilter ?? modelWrapTokenFilter(options.modelConfig);
    this.reasoningWrapFilter = options.reasoningWrapTokenFilter ?? modelWrapTokenFilter(options.modelConfig);
    this.skillStateVersion = options.skillStateVersion ?? null;
    this.roundId = options.roundId ?? null;
  }

  takeToolCalls(): StreamingToolCall[] {
    return this.ctx.takeToolCalls();
  }

  hasPreparingBlocks(): boolean {
    return this.unpromotedPreparingBlockIds.size > 0;
  }

  markPreparingPromoted(toolCallIds?: Iterable<string>): void {
    if (toolCallIds === undefined) {
      this.unpromotedPreparingBlockIds.clear();
      return;
    }
    for (const id of toolCallIds) {
      this.unpromotedPreparingBlockIds.delete(id);
    }
  }

  discardPreparingBlocks(): number {
    if (this.unpromotedPreparingBlockIds.size === 0) return 0;
    const count = this.unpromotedPreparingBlockIds.size;
    for (const [toolCallId, blockId] of this.unpromotedPreparingBlockIds) {
      this.ctx.emitEnd('tool_call_preparing', blockId, null);
      this.preparingBlockIds.delete(toolCallId);
      this.argsDeltaBuffer.delete(toolCallId);
    }
    this.unpromotedPreparingBlockIds.clear();
    return count;
  }

  failPreparingBlocks(error: string): number {
    if (this.unpromotedPreparingBlockIds.size === 0) return 0;
    const count = this.unpromotedPreparingBlockIds.size;
    for (const [toolCallId, blockId] of this.unpromotedPreparingBlockIds) {
      if (this.ctx.emitError) {
        this.ctx.emitError('tool_call_preparing', blockId, error);
      } else {
        this.ctx.emitEnd('tool_call_preparing', blockId, null);
      }
      this.preparingBlockIds.delete(toolCallId);
      this.argsDeltaBuffer.delete(toolCallId);
    }
    this.unpromotedPreparingBlockIds.clear();
    return count;
  }

  /** variant_adapter.rs `reset_for_new_round`. */
  resetForNewRound(): void {
    this.discardPreparingBlocks();
    this.contentBlockInitialized = false;
    this.thinkingBlockInitialized = false;
    this.textSegments = [];
    this.inThinkTag = false;
    this.thinkTagBuffer = '';
    this.preparingBlockIds.clear();
    this.argsDeltaBuffer.clear();
    this.unpromotedPreparingBlockIds.clear();
    this.contentWrapFilter.reset();
    this.reasoningWrapFilter.reset();
    this.ctx.resetForNewRound();
  }

  onToolCallStart(toolCallId: string, toolName: string): void {
    variantLogger.info(`[ChatV2::VariantAdapter] Tool call start: variant=`
      + `${this.ctx.variantId}, id=${toolCallId}, name=${toolName}`);
    if (ChatV2StreamingAdapter.isBuiltinRetrievalTool(toolName)) return;
    if (this.preparingBlockIds.has(toolCallId)) return;
    const blockId = this.generateBlockId();
    this.preparingBlockIds.set(toolCallId, blockId);
    this.unpromotedPreparingBlockIds.set(toolCallId, blockId);
    this.ctx.emitToolCallPreparingStart(toolCallId, toolName, blockId,
      { skillStateVersion: this.skillStateVersion, roundId: this.roundId });
  }

  onToolCallArgsDelta(toolCallId: string, delta: string): void {
    const blockId = this.preparingBlockIds.get(toolCallId);
    if (blockId === undefined) return;
    const buffered = (this.argsDeltaBuffer.get(toolCallId) ?? '') + delta;
    this.argsDeltaBuffer.set(toolCallId, buffered);
    if (utf8ByteLength(buffered) < 500) return;
    this.argsDeltaBuffer.delete(toolCallId);
    if (buffered !== '') this.ctx.emitChunk('tool_call_preparing', blockId, buffered);
  }

  onToolCall(message: LegacyChatMessage): void {
    const toolCall = message.tool_call;
    if (toolCall === undefined || toolCall === null) return;
    // Rust reads the mapping without removing it: a later delta still flushes.
    const blockId = this.preparingBlockIds.get(toolCall.id);
    if (blockId !== undefined) {
      const chunk = this.argsDeltaBuffer.get(toolCall.id) ?? '';
      this.argsDeltaBuffer.delete(toolCall.id);
      if (chunk !== '') this.ctx.emitChunk('tool_call_preparing', blockId, chunk);
    }
    this.ctx.addToolCall({
      id: toolCall.id,
      name: toolCall.tool_name,
      arguments: cloneAgentJson(toolCall.args_json),
    });
    variantLogger.info(`[ChatV2::VariantAdapter] Collected tool call: variant=`
      + `${this.ctx.variantId}, id=${toolCall.id}, name=${toolCall.tool_name}`);
  }

  onToolResult(message: LegacyChatMessage): void {
    const result = message.tool_result;
    if (result === undefined || result === null) return;
    variantLogger.debug(`[ChatV2::VariantAdapter] on_tool_result: variant=`
      + `${this.ctx.variantId}, call_id=${result.call_id}`);
  }

  onUsage(usage: unknown): void {
    const parsed = parseApiUsage(usage);
    if (parsed === null) {
      variantLogger.warn(`[ChatV2::VariantAdapter] variant=${this.ctx.variantId}`
        + ` failed to parse usage`);
      return;
    }
    this.ctx.setUsage(parsed);
    variantLogger.info(`[ChatV2::VariantAdapter] variant=${this.ctx.variantId} usage: `
      + `prompt=${parsed.promptTokens}, completion=${parsed.completionTokens}, `
      + `total=${parsed.totalTokens}, source=${parsed.source}`);
  }

  onContentChunk(text: string): void {
    if (text === '') return;
    const filtered = this.contentWrapFilter.process(text);
    if (filtered === '') return;
    this.thinkTagBuffer += filtered;
    this.processThinkTagBuffer();
  }

  onReasoningChunk(text: string): void {
    if (!this.enableThinking || text === '') return;
    const filtered = this.reasoningWrapFilter.process(text);
    if (filtered === '') return;

    this.ctx.appendReasoning(filtered);
    const blockId = this.ensureThinkingStarted();
    if (blockId !== null) {
      this.appendTextSegment(blockId, filtered);
      this.ctx.emitChunk('thinking', blockId, filtered);
    }
  }

  onComplete(): void {
    this.finalizeAllWithAuthoritativeContent();
  }

  finalizeAll(): void {
    this.finalizeAllInner(false);
  }

  private finalizeThinking(): void {
    if (!this.thinkingBlockInitialized) return;
    const blockId = this.ctx.getThinkingBlockId();
    if (blockId !== null) {
      this.finishTextSegment(blockId);
      this.ctx.emitEnd('thinking', blockId, null);
    }
    this.thinkingBlockInitialized = false;
  }

  private finalizeContent(includeAuthoritativeContent: boolean): void {
    if (!this.contentBlockInitialized) return;
    const blockId = this.ctx.getContentBlockId();
    if (blockId !== null) {
      this.finishTextSegment(blockId);
      const result = includeAuthoritativeContent
        ? authoritativeContentResult(this.textSegmentContent(blockId))
        : null;
      this.ctx.emitEnd('content', blockId, result);
    }
    this.contentBlockInitialized = false;
  }

  private startTextSegment(blockId: string, blockType: string): void {
    this.textSegments.push({
      blockId,
      blockType,
      content: '',
      startedAt: this.now(),
      endedAt: null,
    });
  }

  private syncTextSegment(segment: StreamedTextSegment): void {
    if (segment.content === '') return;
    const endedAt = segment.endedAt ?? this.now();
    this.ctx.addInterleavedBlock({
      id: segment.blockId,
      messageId: this.ctx.messageId,
      blockType: segment.blockType,
      status: VARIANT_BLOCK_STATUS_SUCCESS,
      content: segment.content,
      startedAt: segment.startedAt,
      endedAt,
      firstChunkAt: segment.startedAt,
      blockIndex: 0,
    });
  }

  private appendTextSegment(blockId: string, text: string): void {
    for (let index = this.textSegments.length - 1; index >= 0; index--) {
      const segment = this.textSegments[index]!;
      if (segment.blockId !== blockId) continue;
      segment.content += text;
      // Sync incrementally so a cancelled stream still keeps the tail.
      if (!this.ctx.appendInterleavedBlockContent(blockId, text)) {
        this.syncTextSegment({ ...segment });
      }
      return;
    }
  }

  private finishTextSegment(blockId: string): void {
    for (let index = this.textSegments.length - 1; index >= 0; index--) {
      const segment = this.textSegments[index]!;
      if (segment.blockId !== blockId) continue;
      segment.endedAt = this.now();
      this.syncTextSegment({ ...segment });
      return;
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

    const reasoningTail = this.reasoningWrapFilter.flush();
    if (reasoningTail !== '' && this.enableThinking) {
      this.ctx.appendReasoning(reasoningTail);
      const blockId = this.ensureThinkingStarted();
      if (blockId !== null) {
        this.appendTextSegment(blockId, reasoningTail);
        this.ctx.emitChunk('thinking', blockId, reasoningTail);
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
      this.ctx.appendReasoning(remaining);
      const blockId = this.ensureThinkingStarted();
      if (blockId !== null) {
        this.appendTextSegment(blockId, remaining);
        this.ctx.emitChunk('thinking', blockId, remaining);
      }
    } else if (remaining !== '') {
      this.ctx.appendContent(remaining);
      const blockId = this.ensureContentStarted();
      if (blockId !== null) {
        this.appendTextSegment(blockId, remaining);
        this.ctx.emitChunk('content', blockId, remaining);
      }
    }
  }

  private ensureThinkingStarted(): string | null {
    if (!this.enableThinking) return null;
    this.finalizeContent(true);

    if (!this.thinkingBlockInitialized) {
      const blockId = this.generateBlockId();
      this.ctx.setThinkingBlockId(blockId);
      this.startTextSegment(blockId, 'thinking');
      this.ctx.emitStart('thinking', blockId, null);
      this.thinkingBlockInitialized = true;
    }
    return this.ctx.getThinkingBlockId();
  }

  private ensureContentStarted(): string | null {
    this.finalizeThinking();
    if (!this.contentBlockInitialized) {
      const blockId = this.generateBlockId();
      this.ctx.setContentBlockId(blockId);
      this.startTextSegment(blockId, 'content');
      this.ctx.emitStart('content', blockId, null);
      this.contentBlockInitialized = true;
    }
    return this.ctx.getContentBlockId();
  }

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
            this.ctx.appendReasoning(thinkingContent);
            const blockId = this.ensureThinkingStarted();
            if (blockId !== null) {
              this.appendTextSegment(blockId, thinkingContent);
              this.ctx.emitChunk('thinking', blockId, thinkingContent);
            }
          }
          this.inThinkTag = false;
          continue;
        }

        if (ChatV2StreamingAdapter.endsWithPotentialThinkEnd(this.thinkTagBuffer)) return;

        const thinkingContent = this.thinkTagBuffer;
        this.thinkTagBuffer = '';
        if (thinkingContent !== '' && this.enableThinking) {
          this.ctx.appendReasoning(thinkingContent);
          const blockId = this.ensureThinkingStarted();
          if (blockId !== null) {
            this.appendTextSegment(blockId, thinkingContent);
            this.ctx.emitChunk('thinking', blockId, thinkingContent);
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
          this.ctx.appendContent(contentBefore);
          const blockId = this.ensureContentStarted();
          if (blockId !== null) {
            this.appendTextSegment(blockId, contentBefore);
            this.ctx.emitChunk('content', blockId, contentBefore);
          }
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
            this.ctx.appendContent(contentBefore);
            const blockId = this.ensureContentStarted();
            if (blockId !== null) {
              this.appendTextSegment(blockId, contentBefore);
              this.ctx.emitChunk('content', blockId, contentBefore);
            }
          }
        }
        return;
      }

      const content = this.thinkTagBuffer;
      this.thinkTagBuffer = '';
      if (content !== '') {
        this.ctx.appendContent(content);
        const blockId = this.ensureContentStarted();
        if (blockId !== null) {
          this.appendTextSegment(blockId, content);
          this.ctx.emitChunk('content', blockId, content);
        }
      }
      return;
    }
  }
}
