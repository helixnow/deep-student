import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPipelineHost } from './chat-host.ts';
import { persistenceStorePort } from './persistence-store-port.ts';
import { historyStorePort } from './history-store-port.ts';
import type { ApiConfig } from '../../llm/api.ts';
import type { PipelineFinalStore, PipelinePostCommitEffects, UnifiedTextStream, TextExecutionEffects } from '../api.ts';
import { makeEmptyMessage } from '../src/microcompact.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
const base = persistenceStorePort();
const store: PipelineFinalStore = { ...base,
  getMessageWithConn: (_conn, id) => host.ctx.chatSession.getMessage(id),
  updateMessageWithConn: (conn, message) => { conn.run('UPDATE chat_v2_messages SET block_ids_json=?, meta_json=? WHERE id=?',
    [JSON.stringify(message.blockIds), JSON.stringify(message._meta), message.id]); },
};
const post: PipelinePostCommitEffects = { incrementResourceRefs: vi.fn(async () => {}),
  triggerAutoMemoryExtraction: vi.fn(), onTurnCommitted: vi.fn() };
const effects: TextExecutionEffects = { recordUsage: vi.fn(), accumulateGoalUsage: vi.fn(), scheduleSessionMetadata: vi.fn(async () => {}) };
let script: (request: Parameters<UnifiedTextStream['call']>[0]) => ReturnType<UnifiedTextStream['call']>;
const provider: UnifiedTextStream = { call: vi.fn(request => script(request)) };
let config: ApiConfig;
beforeAll(async () => {
  host = await createPipelineHost({ llm: true, provide: { finalStore: store, postEffects: post,
    executionEffects: effects, textProvider: provider } });
  await host.ctx.llm.saveApiConfigurations([{ id: 'config_plain', name: 'Plain', model: 'plain-model', apiKey: '',
    baseUrl: 'http://127.0.0.1', enabled: true, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false }]);
  config = (await host.ctx.llm.getApiConfigs())[0]!;
}, 60_000);
afterAll(async () => { await host?.dispose(); });
let sequence = 0;
function setup() {
  const sessionId = `text_exec_${++sequence}`;
  host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: false, persistStatus: 'active',
    createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z' });
  const ctx = host.ctx.chatPipeline.createPipelineContext({ sessionId, content: 'question', options: { disableTools: true, enableThinking: true } });
  ctx.modelDisplayName = config.model;
  const prompt = host.ctx.chatPipeline.buildSystemPrompt({ options: ctx.options, sources: {}, canvasNote: null, userProfile: null });
  ctx.compiledCurrentUserMessage = makeEmptyMessage('user', host.ctx.chatPipeline.combineUserContent(ctx.userContent, ctx.runtimeFacts, [], prompt.turnVolatile).text);
  const executor = host.ctx.chatPipeline.createPreparedTextExecution({
    persistence: host.ctx.chatPipeline.createPersistence(host.ctx.get('finalStore') as PipelineFinalStore),
    finalPersistence: host.ctx.chatPipeline.createFinalPersistence(host.ctx.get('finalStore') as PipelineFinalStore, host.ctx.get('postEffects') as PipelinePostCommitEffects),
    history: host.ctx.chatPipeline.createHistoryLoader(historyStorePort(host.ctx.chatSession, store)),
    stream: host.ctx.get('textProvider') as UnifiedTextStream, effects: host.ctx.get('executionEffects') as TextExecutionEffects,
  });
  const events: { eventType?: string; type?: string; phase?: string; result?: unknown }[] = [];
  const states: boolean[] = [];
  host.ctx.backendEvents.listen(`chat_v2_session_${sessionId}`, value => {
    events.push(value as typeof events[number]); states.push(host.ctx.chatSession.getMessage(ctx.assistantMessageId) !== null);
  });
  host.ctx.backendEvents.listen(`chat_v2_event_${sessionId}`, value => { events.push(value as typeof events[number]); });
  const emitter = host.ctx.chatPipeline.createSessionEventEmitter(sessionId, { batching: false });
  return { ctx, events, states, emitter, execute: (signal = new AbortController().signal) =>
    executor.execute({ execution: ctx, systemPrompt: prompt.stableSystem, config, disableTools: true }, emitter, signal) };
}

describe('pipeline.rs prepared text stage calls provider and commits before terminal', () => {
  it('ordinary answer invokes external LLM, persists live wrapper and authoritative streamed blocks', async () => {
    const t = setup(); vi.mocked(provider.call).mockClear();
    script = async request => {
      expect(request.disableTools).toBe(true);
      expect(request.messages).toHaveLength(1);
      expect(request.messages[0]!.content).toBe(t.ctx.liveUserLlmContent());
      const db = host.ctx.chatSession.database.getConnSafe();
      expect(db.pluck('SELECT llm_content FROM chat_v2_blocks WHERE message_id = ?', [t.ctx.userMessageId])).toBe(t.ctx.liveUserLlmContent());
      request.hooks.onReasoningChunk?.('thinking'); request.hooks.onContentChunk?.('real answer');
      request.hooks.onUsage?.({ prompt_tokens: 5, completion_tokens: 2 });
      request.hooks.onComplete?.('real answer', 'thinking');
      return { cancelled: false, assistantMessage: 'real answer' };
    };
    try {
      expect(await t.execute()).toBe(t.ctx.assistantMessageId);
      expect(provider.call).toHaveBeenCalledTimes(1);
      expect(host.ctx.chatSession.getMessageBlocks(t.ctx.assistantMessageId).map(b => b.content)).toEqual(['thinking', 'real answer']);
      expect(t.events.filter(e => e.eventType).map(e => e.eventType)).toEqual(['stream_start', 'stream_complete']);
      expect(t.states).toEqual([false, true]);
      expect(host.ctx.chatSession.getMessage(t.ctx.assistantMessageId)!._meta?.usage).toMatchObject({ totalTokens: 7 });
      const request = vi.mocked(provider.call).mock.calls[0]![0];
      expect(host.ctx.llmStreamEvents.unregisterStreamHooksIfOwner(request.streamEvent, request.hooks)).toBe(false);
    } finally { t.emitter.dispose(); }
  });
  it('error after partial output suppresses retry, persists partial answer and emits only error terminal', async () => {
    const t = setup(); vi.mocked(provider.call).mockClear();
    script = async request => { request.hooks.onContentChunk?.('partial answer'); throw new Error('connection failed'); };
    try {
      await expect(t.execute()).rejects.toThrow('LLM error: connection failed');
      expect(provider.call).toHaveBeenCalledTimes(1);
      expect(host.ctx.chatSession.getMessageBlocks(t.ctx.assistantMessageId)[0]!.content).toBe('partial answer');
      expect(t.events.filter(e => e.eventType).map(e => e.eventType)).toEqual(['stream_start', 'stream_error']);
      expect(t.states).toEqual([false, true]);
    } finally { t.emitter.dispose(); }
  });
  it('preserves partial output from a failed retry instead of starting another attempt', async () => {
    const t = setup(); vi.mocked(provider.call).mockClear();
    let attempts = 0;
    script = async request => {
      attempts += 1;
      if (attempts > 1) request.hooks.onContentChunk?.('retry partial');
      throw new Error('connection failed');
    };
    try {
      await expect(t.execute()).rejects.toThrow('LLM error: connection failed');
      expect(provider.call).toHaveBeenCalledTimes(2);
      expect(host.ctx.chatSession.getMessageBlocks(t.ctx.assistantMessageId).map(block => block.content)).toEqual(['retry partial']);
      expect(t.events.filter(e => e.eventType).map(e => e.eventType)).toEqual(['stream_start', 'stream_reconnect', 'stream_error']);
    } finally { t.emitter.dispose(); }
  });
  it('cancellation aborts the actual provider, saves partial text and emits cancelled not error', async () => {
    const t = setup(); const cancel = new AbortController(); let signalObserved = false;
    script = async request => {
      request.hooks.onContentChunk?.('cancelled partial');
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => { signalObserved = true; reject(new Error('connection closed')); }, { once: true });
        cancel.abort();
      });
    };
    try {
      await expect(t.execute(cancel.signal)).rejects.toThrow('Cancelled');
      expect(signalObserved).toBe(true);
      expect(host.ctx.chatSession.getMessageBlocks(t.ctx.assistantMessageId)[0]!.content).toBe('cancelled partial');
      expect(t.events.filter(e => e.eventType).map(e => e.eventType)).toEqual(['stream_start', 'stream_cancelled']);
      expect(t.states).toEqual([false, true]);
    } finally { t.emitter.dispose(); }
  });
  it('empty-output transient failure retries the real provider once with reconnect and the same frozen request', async () => {
    const t = setup(); vi.mocked(provider.call).mockClear(); let attempts = 0;
    script = async request => {
      attempts++;
      if (attempts === 1) throw new Error('connection reset');
      request.hooks.onContentChunk?.('retried'); request.hooks.onComplete?.('retried', null);
      return { cancelled: false, assistantMessage: 'retried' };
    };
    try {
      await t.execute();
      expect(provider.call).toHaveBeenCalledTimes(2);
      const calls = vi.mocked(provider.call).mock.calls;
      expect(calls[0]![0].config).toBe(calls[1]![0].config);
      expect(calls[0]![0].messages).toBe(calls[1]![0].messages);
      expect(calls[0]![0].streamEvent).toBe(calls[1]![0].streamEvent);
      expect(t.events.filter(e => e.eventType).map(e => e.eventType)).toEqual(['stream_start', 'stream_reconnect', 'stream_complete']);
      expect(host.ctx.chatSession.getMessageBlocks(t.ctx.assistantMessageId).map(b => b.content)).toEqual(['retried']);
    } finally { t.emitter.dispose(); }
  });
  it('idle timeout drains the abandoned provider before the retry reuses the same stream key', async () => {
    const t = setup(); vi.mocked(provider.call).mockClear();
    const steps: string[] = [];
    let attempts = 0;
    script = request => {
      const attempt = ++attempts;
      steps.push(`start ${attempt}`);
      if (attempt === 1) {
        // Like the L02 transport: an abandoned call releases its stream key only after observing the abort.
        return new Promise(resolve => request.signal.addEventListener('abort', () => setTimeout(() => {
          steps.push('settle 1'); resolve({ cancelled: true, assistantMessage: '' });
        }, 1_500), { once: true }));
      }
      request.hooks.onContentChunk?.('after retry'); request.hooks.onComplete?.('after retry', null);
      return Promise.resolve({ cancelled: false, assistantMessage: 'after retry' });
    };
    host.ctx.settings.save('chat.stream.timeout_ms', '1');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const run = t.execute();
      // 10s watchdog tick → idle timeout; 1.5s provider drain; 1s retry backoff.
      await vi.advanceTimersByTimeAsync(10_000 + 1_500 + 1_000);
      expect(await run).toBe(t.ctx.assistantMessageId);
      expect(steps).toEqual(['start 1', 'settle 1', 'start 2']);
      const calls = vi.mocked(provider.call).mock.calls;
      expect(calls[0]![0].streamEvent).toBe(calls[1]![0].streamEvent);
      expect(t.events.filter(e => e.eventType).map(e => e.eventType)).toEqual(['stream_start', 'stream_reconnect', 'stream_complete']);
    } finally {
      vi.useRealTimers();
      host.ctx.settings.save('chat.stream.timeout_ms', '');
      t.emitter.dispose();
    }
  });
});
