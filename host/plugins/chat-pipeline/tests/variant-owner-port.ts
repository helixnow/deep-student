/** External L04 owner replacement: VariantExecutionContext / ParallelExecutionManager as published on the
 * ds-mig/L04-chat-session branch (variant_context.rs). Main has not integrated that surface yet; this fixture
 * reproduces only the owner's state transitions and event emission, never L03 execution logic.
 */
import type { ChatSessionService, ChatV2Emitter, SharedContext, TokenUsage, ToolResultInfo, Variant, VariantMeta } from '../../chat/api.ts';
import type { PersistenceBlock } from '../src/persistence-port.ts';
import type { VariantExecution, VariantExecutionManager } from '../src/variant-run.ts';
import type { ToolFacePrefixSnapshot } from '../api.ts';
import { persistenceStorePort } from './persistence-store-port.ts';
import { historyStorePort } from './history-store-port.ts';

const zero = (): TokenUsage => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0, source: 'api' });

class FixtureVariant implements VariantExecution {
  private state = 'pending';
  private failure: string | null = null;
  private meta: VariantMeta | null = null;
  private config: string | null = null;
  private ids: string[] = [];
  private contentId: string | null = null;
  private thinkingId: string | null = null;
  private content = '';
  private reasoning: string | null = null;
  private usage = zero();
  private calls: { id: string; name: string; arguments: unknown }[] = [];
  private results: ToolResultInfo[] = [];
  private round = 0;
  private interleaved: PersistenceBlock[] = [];
  private readonly child = new AbortController();
  private readonly created = Date.now();
  constructor(private readonly id: string, private readonly model: string, private readonly message: string,
    private readonly events: ChatV2Emitter, parent: AbortSignal) {
    if (parent.aborted) this.child.abort(); else parent.addEventListener('abort', () => this.child.abort(), { once: true });
  }
  variantId() { return this.id; } modelId() { return this.model; } messageId() { return this.message; }
  cancelToken() { return this.child.signal; } cancelController() { return this.child; } isCancelled() { return this.child.signal.aborted; }
  emitter() { return this.events; } setConfigId(id: string) { this.config = id; } getConfigId() { return this.config; }
  setMeta(meta: VariantMeta) { this.meta = structuredClone(meta); } getMeta() { return this.meta === null ? null : structuredClone(this.meta); }
  status() { return this.state; } error() { return this.failure; } blockIds() { return [...this.ids]; }
  setContentBlockId(id: string) { if (!this.ids.includes(id)) this.ids.push(id); this.contentId = id; }
  setThinkingBlockId(id: string) { if (!this.ids.includes(id)) this.ids.push(id); this.thinkingId = id; }
  getContentBlockId() { return this.contentId; } getThinkingBlockId() { return this.thinkingId; }
  appendContent(text: string) { this.content += text; } appendReasoning(text: string) { this.reasoning = (this.reasoning ?? '') + text; }
  getAccumulatedContent() { return this.content; } getAccumulatedReasoning() { return this.reasoning; }
  setUsage(usage: TokenUsage) { this.usage = structuredClone(usage); } getUsage() { return structuredClone(this.usage); }
  addToolCall(call: { id: string; name: string; arguments: unknown }) { this.calls.push(structuredClone(call)); }
  takeToolCalls() { const calls = this.calls; this.calls = []; return calls; }
  addToolResult(result: ToolResultInfo) { this.results.push(structuredClone(result)); }
  getToolResults() { return structuredClone(this.results); }
  incrementToolRound() { return this.round++; }
  addInterleavedBlock(block: PersistenceBlock) {
    const existing = this.interleaved.findIndex(value => value.id === block.id);
    const index = existing < 0 ? this.interleaved.length : this.interleaved[existing]!.blockIndex;
    const owned = { ...structuredClone(block), blockIndex: index };
    if (existing >= 0) this.interleaved[existing] = owned; else this.interleaved.push(owned);
    return index;
  }
  appendInterleavedBlockContent(blockId: string, text: string) {
    const block = this.interleaved.findLast(value => value.id === blockId);
    if (block === undefined) return false;
    block.content = (block.content ?? '') + text; block.endedAt = Date.now(); return true;
  }
  getInterleavedBlocks() { return structuredClone(this.interleaved); }
  setPendingReasoning() {}
  resetForNewRound() { this.content = ''; this.reasoning = null; this.contentId = null; this.thinkingId = null; }
  emitStart(type: string, blockId: string, payload: unknown | null) { this.events.emitStart(type, this.message, blockId, payload, this.id); }
  emitChunk(type: string, blockId: string, chunk: string) { this.events.emitChunk(type, blockId, chunk, this.id); }
  emitEnd(type: string, blockId: string, result: unknown | null) { this.events.emitEnd(type, blockId, result, this.id); }
  private terminal() { return ['success', 'error', 'cancelled'].includes(this.state); }
  startStreaming() { if (this.state !== 'pending') return; this.state = 'streaming'; this.events.emitVariantStart(this.message, this.id, this.model); }
  complete() { if (this.terminal()) return; this.state = 'success'; this.events.emitVariantEnd(this.id, 'success', null, this.usage.totalTokens > 0 ? this.usage : null); }
  fail(error: string) { if (this.terminal()) return; this.state = 'error'; this.failure = error; this.events.emitVariantEnd(this.id, 'error', error, null); }
  cancel() { this.child.abort(); if (this.terminal()) return; this.state = 'cancelled'; this.events.emitVariantEnd(this.id, 'cancelled', null, null); }
  toVariant(): Variant {
    return { id: this.id, modelId: this.model, blockIds: this.blockIds(), status: this.state, createdAt: this.created,
      ...(this.config === null ? {} : { configId: this.config }), ...(this.failure === null ? {} : { error: this.failure }),
      ...(this.usage.totalTokens > 0 ? { usage: this.getUsage() } : {}), ...(this.meta === null ? {} : { meta: this.getMeta()! }) };
  }
}

export function parallelExecutionManagerPort(controller: AbortController): VariantExecutionManager {
  const contexts = new Map<string, FixtureVariant>();
  return {
    createVariant(id: string, model: string, message: string, _shared: SharedContext, emitter: ChatV2Emitter) {
      const ctx = new FixtureVariant(id, model, message, emitter, controller.signal);
      contexts.set(id, ctx); return ctx;
    },
    getFirstSuccess: () => [...contexts.values()].find(ctx => ctx.status() === 'success')?.variantId() ?? null,
    successCount: () => [...contexts.values()].filter(ctx => ctx.status() === 'success').length,
    errorCount: () => [...contexts.values()].filter(ctx => ctx.status() === 'error').length,
  };
}

/** Installs the L04 repository + variant owner surfaces the variant pipeline needs on the real chatSession service. */
export function installVariantOwnerFixture(service: ChatSessionService, prefixes: Map<string, ToolFacePrefixSnapshot>): void {
  const persistence = persistenceStorePort();
  Object.assign(service, persistence, historyStorePort(service, persistence), {
    getMessageWithConn: (_conn: unknown, id: string) => service.getMessage(id),
    updateMessageWithConn: (_conn: unknown, message: Parameters<typeof service.updateMessage>[0]) => service.updateMessage(message),
    // Full rows so variants/activeVariantId/meta survive (repo.rs create_message is INSERT OR REPLACE).
    createMessageWithConn: (_conn: unknown, message: Parameters<typeof service.createMessage>[0]) =>
      service.getMessage(message.id) === null ? service.createMessage(message) : service.updateMessage(message),
    getToolFacePrefix: (sessionId: string) => prefixes.get(sessionId) ?? null,
    advanceToolFacePrefix: (sessionId: string, snapshot: ToolFacePrefixSnapshot) => { prefixes.set(sessionId, structuredClone(snapshot)); },
    createParallelExecutionManager: (controller: AbortController) => parallelExecutionManagerPort(controller),
  });
}
