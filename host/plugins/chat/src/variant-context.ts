/** variant_context.rs:151-1199. Synchronous mutations replace Rust lock critical sections. */
import { now } from '../../../platform/time/index.ts';
import type { SharedContext, TokenUsage, ToolCall, ToolResultInfo, Variant, VariantMeta } from '../api.ts';
import type { StoredBlock } from '../repository/blocks.ts';
import type { ChatV2EventEmitter } from './events.ts';
import { generateBlockId } from './message-values.ts';
import { tokenUsageZero } from './types.ts';
import type { ChatLogger } from './logger.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';

export class VariantExecutionContext {
  private readonly id: string;
  private readonly model: string;
  private readonly message: string;
  private readonly shared: SharedContext;
  private readonly events: ChatV2EventEmitter;
  private readonly log: ChatLogger;
  /** Rust `cancel_token: parent.child_token()`: own controller, aborted by the parent or by `cancel()`. */
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly created: number;
  private configId: string | null = null;
  private currentStatus = 'pending';
  private currentError: string | null = null;
  private ids: string[] = [];
  private content = '';
  private reasoning: string | null = null;
  private contentId: string | null = null;
  private thinkingId: string | null = null;
  private contentFirstChunk: number | null = null;
  private thinkingFirstChunk: number | null = null;
  private usage = tokenUsageZero();
  private calls: ToolCall[] = [];
  private results: ToolResultInfo[] = [];
  private round = 0;
  private interleavedIds: string[] = [];
  private interleaved: StoredBlock[] = [];
  private pendingReasoning: string | null = null;
  private meta: VariantMeta | null = null;

  constructor(variantId: string, modelId: string, messageId: string, sharedContext: SharedContext,
    emitter: ChatV2EventEmitter, parent: AbortSignal, log: ChatLogger) {
    this.id = variantId; this.model = modelId; this.message = messageId;
    this.shared = sharedContext; this.events = emitter; this.log = log;
    log.info(`[ChatV2::VariantContext] Created variant ${variantId} for model ${modelId} in message ${messageId}`);
    this.signal = this.controller.signal; this.created = now().millis;
    if (parent.aborted) this.controller.abort();
    else parent.addEventListener('abort', () => this.controller.abort(), { once: true, signal: this.signal });
  }
  variantId(): string { return this.id; }
  modelId(): string { return this.model; }
  messageId(): string { return this.message; }
  cancelToken(): AbortSignal { return this.signal; }
  /**
   * The token itself, for `state.register_existing_token(key, ctx.cancel_token().clone())`
   * (multi_variant.rs:345/2892): aborting it cancels this variant only, exactly like
   * cancelling the Rust child token; the parent token is unaffected.
   */
  cancelController(): AbortController { return this.controller; }
  isCancelled(): boolean { return this.signal.aborted; }
  sharedContext(): Readonly<SharedContext> { return this.shared; }
  emitter(): ChatV2EventEmitter { return this.events; }
  emitterArc(): ChatV2EventEmitter { return this.events; }
  createdAt(): number { return this.created; }
  setConfigId(id: string): void { this.configId = id; }
  getConfigId(): string | null { return this.configId; }
  setMeta(meta: VariantMeta): void { this.meta = structuredClone(meta); }
  getMeta(): VariantMeta | null { return this.meta === null ? null : structuredClone(this.meta); }
  status(): string { return this.currentStatus; }
  error(): string | null { return this.currentError; }
  blockIds(): string[] { return [...this.ids]; }
  createBlock(type: string): string {
    const id = generateBlockId(); this.ids.push(id);
    this.log.debug(`[ChatV2::VariantContext] Created block ${id} (${type}) for variant ${this.id}`);
    return id;
  }
  addBlockId(id: string): void { this.ids.push(id); }
  setContentBlockId(id: string): void { if (!this.ids.includes(id)) this.ids.push(id); this.contentId = id; }
  setThinkingBlockId(id: string): void { if (!this.ids.includes(id)) this.ids.push(id); this.thinkingId = id; }
  getContentBlockId(): string | null { return this.contentId; }
  getThinkingBlockId(): string | null { return this.thinkingId; }
  appendContent(text: string): void {
    if (text !== '' && this.contentFirstChunk === null) this.contentFirstChunk = now().millis;
    this.content += text;
  }
  appendReasoning(text: string): void {
    if (text !== '' && this.thinkingFirstChunk === null) this.thinkingFirstChunk = now().millis;
    this.reasoning = (this.reasoning ?? '') + text;
  }
  getAccumulatedContent(): string { return this.content; }
  getAccumulatedReasoning(): string | null { return this.reasoning; }
  getContentFirstChunkAt(): number | null { return this.contentFirstChunk; }
  getThinkingFirstChunkAt(): number | null { return this.thinkingFirstChunk; }
  setUsage(usage: TokenUsage): void {
    const source = usage.source.charAt(0).toUpperCase() + usage.source.slice(1);
    this.log.info(`[ChatV2::VariantContext] variant=${this.id} set usage: prompt=${usage.promptTokens}, completion=${usage.completionTokens}, source=${source}`);
    this.usage = structuredClone(usage);
  }
  getUsage(): TokenUsage { return structuredClone(this.usage); }
  hasUsage(): boolean { return this.usage.totalTokens > 0; }
  addToolCall(call: ToolCall): void { this.calls.push(structuredClone(call)); }
  takeToolCalls(): ToolCall[] { const calls = this.calls; this.calls = []; return calls; }
  hasToolCalls(): boolean { return this.calls.length > 0; }
  addToolResult(result: ToolResultInfo): void { this.results.push(structuredClone(result)); }
  addToolResults(results: readonly ToolResultInfo[]): void { this.results.push(...structuredClone(results)); }
  getToolResults(): ToolResultInfo[] { return structuredClone(this.results); }
  incrementToolRound(): number { const previous = this.round; this.round = (previous + 1) >>> 0; return previous; }
  getToolRound(): number { return this.round; }
  addInterleavedBlock(block: StoredBlock): number {
    const existing = this.interleaved.findIndex(value => value.id === block.id);
    const index = existing < 0 ? this.interleaved.length : this.interleaved[existing]!.blockIndex;
    const owned = { ...structuredClone(block), blockIndex: index };
    if (existing >= 0) this.interleaved[existing] = owned;
    else { this.interleavedIds.push(block.id); this.interleaved.push(owned); }
    return index;
  }
  appendInterleavedBlockContent(blockId: string, text: string): boolean {
    const block = this.interleaved.findLast(value => value.id === blockId);
    if (block === undefined) return false;
    block.content = (block.content ?? '') + text; block.endedAt = now().millis; return true;
  }
  getInterleavedBlocks(): StoredBlock[] { return structuredClone(this.interleaved); }
  getInterleavedBlockIds(): string[] { return [...this.interleavedIds]; }
  hasInterleavedBlocks(): boolean { return this.interleaved.length > 0; }
  setPendingReasoning(text: string | null): void { this.pendingReasoning = text; }
  getPendingReasoning(): string | null { return this.pendingReasoning; }
  clearPendingReasoning(): void { this.pendingReasoning = null; }
  resetForNewRound(): void {
    this.content = ''; this.reasoning = null; this.contentId = null; this.thinkingId = null;
    this.contentFirstChunk = null; this.thinkingFirstChunk = null;
  }
  emitStart(type: string, blockId: string, payload: unknown | null): void { this.events.emitStart(type, this.message, blockId, payload, this.id); }
  emitChunk(type: string, blockId: string, chunk: string): void { this.events.emitChunk(type, blockId, chunk, this.id); }
  emitEnd(type: string, blockId: string, result: unknown | null): void { this.events.emitEnd(type, blockId, result, this.id); }
  emitError(type: string, blockId: string, error: string): void { this.events.emitError(type, blockId, error, this.id); }
  emitToolCallPreparing(toolCallId: string, toolName: string, blockId: string | null): void {
    this.events.emitToolCallPreparingWithVariant(this.message, toolCallId, toolName, blockId, this.id);
  }
  emitToolCallPreparingChunk(blockId: string, chunk: string): void { this.emitChunk('tool_call_preparing', blockId, chunk); }
  private terminal(): boolean { return ['success', 'error', 'cancelled'].includes(this.currentStatus); }
  startStreaming(): void {
    if (this.currentStatus !== 'pending') {
      this.log.warn(`[ChatV2::VariantContext] Variant ${this.id} cannot start streaming: already in ${this.currentStatus} state`); return;
    }
    this.currentStatus = 'streaming';
    this.log.info(`[ChatV2::VariantContext] Variant ${this.id} started streaming with model ${this.model}`);
    this.events.emitVariantStart(this.message, this.id, this.model);
  }
  complete(): void {
    if (this.terminal()) { this.log.warn(`[ChatV2::VariantContext] Variant ${this.id} already in terminal state, skipping complete`); return; }
    this.currentStatus = 'success'; this.log.info(`[ChatV2::VariantContext] Variant ${this.id} completed successfully`);
    this.events.emitVariantEnd(this.id, 'success', null, this.hasUsage() ? this.getUsage() : null);
  }
  fail(error: string): void {
    if (this.terminal()) { this.log.warn(`[ChatV2::VariantContext] Variant ${this.id} already in terminal state, skipping fail`); return; }
    this.currentStatus = 'error'; this.currentError = error;
    this.log.error(`[ChatV2::VariantContext] Variant ${this.id} failed: ${error}`);
    this.events.emitVariantEnd(this.id, 'error', error, this.hasUsage() ? this.getUsage() : null);
  }
  cancel(): void {
    this.controller.abort();
    if (this.terminal()) { this.log.debug(`[ChatV2::VariantContext] Variant ${this.id} already in terminal state, skipping cancel event`); return; }
    this.currentStatus = 'cancelled'; this.log.info(`[ChatV2::VariantContext] Variant ${this.id} cancelled`);
    this.events.emitVariantEnd(this.id, 'cancelled', null, this.hasUsage() ? this.getUsage() : null);
  }
  toVariant(): Variant {
    return { id: this.id, modelId: this.model, blockIds: this.blockIds(), status: this.currentStatus, createdAt: this.created,
      ...(this.configId === null ? {} : { configId: this.configId }), ...(this.currentError === null ? {} : { error: this.currentError }),
      ...(this.hasUsage() ? { usage: this.getUsage() } : {}), ...(this.meta === null ? {} : { meta: this.getMeta()! }) };
  }
}

export class ParallelExecutionManager {
  private readonly global: AbortController;
  private readonly contexts = new Map<string, VariantExecutionContext>();
  private readonly log: ChatLogger;
  constructor(log: ChatLogger, controller = new AbortController()) { this.log = log; this.global = controller; }
  globalCancelToken(): AbortSignal { return this.global.signal; }
  addVariant(context: VariantExecutionContext): void { this.contexts.set(context.variantId(), context); }
  createVariant(id: string, model: string, message: string, shared: SharedContext, emitter: ChatV2EventEmitter): VariantExecutionContext {
    const context = new VariantExecutionContext(id, model, message, shared, emitter, this.global.signal, this.log);
    this.addVariant(context); return context;
  }
  getVariant(id: string): VariantExecutionContext | null { return this.contexts.get(id) ?? null; }
  cancelVariant(id: string): boolean {
    const context = this.getVariant(id);
    if (context === null) { this.log.warn(`[ChatV2::ParallelManager] Variant ${id} not found`); return false; }
    context.cancel(); this.log.info(`[ChatV2::ParallelManager] Cancelled variant ${id}`); return true;
  }
  cancelAll(): void {
    this.global.abort(); this.log.info('[ChatV2::ParallelManager] Cancelled all variants');
    for (const context of this.contexts.values()) if (['pending', 'streaming'].includes(context.status())) context.cancel();
  }
  getVariants(): Variant[] { return [...this.contexts.values()].map(context => context.toVariant()); }
  variantCount(): number { return this.contexts.size; }
  getFirstSuccess(): string | null {
    const ordered = [...this.contexts.values()].sort((a, b) => a.createdAt() - b.createdAt()
      || compareUtf8(a.variantId(), b.variantId()));
    return (ordered.find(context => context.status() === 'success') ?? ordered.find(context => context.status() === 'cancelled') ?? ordered[0])?.variantId() ?? null;
  }
  allCompleted(): boolean { return [...this.contexts.values()].every(context => ['success', 'error', 'cancelled'].includes(context.status())); }
  hasStreaming(): boolean { return [...this.contexts.values()].some(context => context.status() === 'streaming'); }
  successCount(): number { return [...this.contexts.values()].filter(context => context.status() === 'success').length; }
  errorCount(): number { return [...this.contexts.values()].filter(context => context.status() === 'error').length; }
  removeVariant(id: string): VariantExecutionContext | null { const context = this.getVariant(id); this.contexts.delete(id); return context; }
  clear(): void { this.contexts.clear(); }
}
