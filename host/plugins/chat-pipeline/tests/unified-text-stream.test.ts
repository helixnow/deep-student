import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createPipelineHost } from './chat-host.ts';
import { persistenceStorePort } from './persistence-store-port.ts';
import { historyStorePort } from './history-store-port.ts';
import { makeEmptyMessage } from '../src/microcompact.ts';
import type { ApiConfig } from '../../llm/api.ts';
import type { PipelineFinalStore, PipelinePostCommitEffects, TextExecutionEffects } from '../api.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
let config: ApiConfig;
const requests: unknown[] = [];
let respond: (response: ServerResponse) => void;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  respond(response);
});
const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const base = persistenceStorePort();
const store: PipelineFinalStore = { ...base,
  getMessageWithConn: (_conn, id) => host.ctx.chatSession.getMessage(id),
  updateMessageWithConn: (conn, message) => { conn.run('UPDATE chat_v2_messages SET block_ids_json=?, meta_json=? WHERE id=?',
    [JSON.stringify(message.blockIds), JSON.stringify(message._meta), message.id]); },
};
const post: PipelinePostCommitEffects = { incrementResourceRefs: vi.fn(async () => {}),
  triggerAutoMemoryExtraction: vi.fn(), onTurnCommitted: vi.fn() };
const effects: TextExecutionEffects = { recordUsage: vi.fn(), accumulateGoalUsage: vi.fn(), scheduleSessionMetadata: vi.fn(async () => {}) };
beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  host = await createPipelineHost({ llm: true, provide: { networkTestStore: store, networkTestPost: post, networkTestEffects: effects } });
  await host.ctx.llm.saveApiConfigurations([{ id: 'network-config', name: 'network test', apiKey: '', authMode: 'none',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'test-model',
    apiProtocol: 'openai_chat_completions', modelAdapter: 'general', supportsTools: true,
    enabled: true, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false }]);
  config = (await host.ctx.llm.getApiConfigs())[0]!;
}, 60_000);
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await host?.dispose();
});
let sequence = 0;
function turn() {
  const session = `unified_network_${++sequence}`;
  host.ctx.chatSession.createSession({ id: session, mode: 'chat', titleLocked: false, persistStatus: 'active',
    createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z' });
  const ctx = host.ctx.chatPipeline.createPipelineContext({ sessionId: session, content: 'ping', options: {
    modelId: 'must-not-win', model2OverrideId: config.id, temperature: 0.25, maxTokens: 128,
    disableTools: true, memoryEnabled: false, webSearchEnabled: false,
  } });
  ctx.modelDisplayName = config.model;
  ctx.compiledCurrentUserMessage = makeEmptyMessage('user', '<user_query>ping</user_query>');
  const sinkEvents: string[] = [];
  const sink = { emit(channel: string, payload: unknown) { sinkEvents.push(channel); host.ctx.backendEvents.emit(channel, payload); } };
  const stream = host.ctx.chatPipeline.createUnifiedTextStream(sink, { window: 'main', webview: 'main' });
  const emitter = host.ctx.chatPipeline.createSessionEventEmitter(session, { batching: false });
  const executor = host.ctx.chatPipeline.createPreparedTextExecution({
    persistence: host.ctx.chatPipeline.createPersistence(host.ctx.get('networkTestStore') as PipelineFinalStore),
    finalPersistence: host.ctx.chatPipeline.createFinalPersistence(host.ctx.get('networkTestStore') as PipelineFinalStore, host.ctx.get('networkTestPost') as PipelinePostCommitEffects),
    history: host.ctx.chatPipeline.createHistoryLoader(historyStorePort(host.ctx.chatSession, store)),
    stream, effects: host.ctx.get('networkTestEffects') as TextExecutionEffects,
  });
  const sessionEvents: unknown[] = [];
  host.ctx.backendEvents.listen(`chat_v2_session_${session}`, payload => {
    sessionEvents.push(payload);
    if (payload !== null && typeof payload === 'object' && 'eventType' in payload && payload.eventType === 'stream_complete') {
      expect(host.ctx.chatSession.getMessage(ctx.assistantMessageId)).not.toBeNull();
    }
  });
  return { ctx, emitter, sinkEvents, sessionEvents, execute: (signal = new AbortController().signal) =>
    executor.execute({ execution: ctx, config, systemPrompt: 'exact frozen system', disableTools: true }, emitter, signal) };
}

describe('L03 → real L02 unified stream → real L01 HTTP/SSE → save before terminal', () => {
  it('consumes the scripted HTTP provider, propagates overrides and persists hook-produced content', async () => {
    requests.length = 0;
    respond = response => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(data({ choices: [{ delta: { content: 'network answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } }) + 'data: [DONE]\n\n');
    };
    const t = turn();
    try {
      expect(await t.execute()).toBe(t.ctx.assistantMessageId);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ model: 'test-model', stream: true, temperature: 0.25, max_tokens: 128,
        // Rust model2_pipeline.rs:5378–5383 uses a cacheable content array for the system role.
        messages: [{ role: 'system', content: [{ type: 'text', text: 'exact frozen system', cache_control: { type: 'ephemeral' } }] },
          { role: 'user', content: '<user_query>ping</user_query>' }] });
      expect(requests[0]).not.toHaveProperty('tools');
      expect(host.ctx.chatSession.getMessageBlocks(t.ctx.assistantMessageId).map(block => block.content)).toEqual(['network answer']);
      expect(host.ctx.chatSession.getMessage(t.ctx.assistantMessageId)!._meta?.usage).toMatchObject({ promptTokens: 7, completionTokens: 2, totalTokens: 9 });
      expect(t.sessionEvents).toEqual([expect.objectContaining({ eventType: 'stream_start' }), expect.objectContaining({ eventType: 'stream_complete' })]);
      expect(t.sinkEvents.some(name => name.endsWith('_usage'))).toBe(true);
    } finally { t.emitter.dispose(); }
  });
  it('bridges AbortSignal into L02 cancel registry and closes an actual stalled response', async () => {
    const t = turn(); const cancel = new AbortController();
    let close!: () => void;
    const closed = new Promise<void>(resolve => { close = resolve; });
    respond = response => {
      response.on('close', close);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(data({ choices: [{ delta: { content: 'partial network' } }] }));
    };
    host.ctx.backendEvents.listen(`chat_v2_event_${t.ctx.sessionId}`, payload => {
      if (payload !== null && typeof payload === 'object' && 'phase' in payload && payload.phase === 'chunk') cancel.abort();
    });
    try {
      await expect(t.execute(cancel.signal)).rejects.toThrow('Cancelled');
      await closed;
      expect(host.ctx.chatSession.getMessageBlocks(t.ctx.assistantMessageId).map(block => block.content)).toEqual(['partial network']);
      expect(t.sessionEvents).toEqual([expect.objectContaining({ eventType: 'stream_start' }), expect.objectContaining({ eventType: 'stream_cancelled' })]);
      // pipeline.rs:1143–1148 drops the LLM future on cancel: model2_pipeline.rs:6729 `{stream}_cancelled` is never emitted.
      expect(t.sinkEvents.filter(name => name.endsWith('_cancelled'))).toEqual([]);
    } finally { t.emitter.dispose(); }
  });
});
