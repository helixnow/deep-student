/** D-003: pipeline.rs:1143–1148 drops execute_with_tools, including its event outlets.
 * Real chatPipeline → L02 → L01 HTTP/SSE and real L04 repositories; only the remote server is scripted.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { once, getEventListeners } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { LlmStreamHooks } from '../../llm/api.ts';
import { createPipelineHost } from './chat-host.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
let respond: (response: ServerResponse) => void;
let requests = 0;
const server = createServer(async (request, response) => {
  for await (const _chunk of request) { /* Consume the real provider request. */ }
  requests++;
  respond(response);
});
const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const window = { window: 'main', webview: 'main' } as const;

beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  host = await createPipelineHost({ llm: true });
  await host.ctx.llm.saveApiConfigurations([{ id: 'cancel-config', name: 'cancel test', apiKey: '', authMode: 'none',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'cancel-model',
    apiProtocol: 'openai_chat_completions', modelAdapter: 'general', supportsTools: true,
    enabled: true, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false }]);
}, 60_000);
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await host?.dispose();
});

it.each([false, true])('D-003 cancel after partial drops the loser (pending tool=%s) and cleans before terminal', async pendingTool => {
  const sessionId = `cancel_drop_${pendingTool}`, assistantId = `msg_${sessionId}`, userId = `user_${sessionId}`;
  host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: true, persistStatus: 'active',
    createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z' });
  host.events.length = 0; requests = 0;
  const cancel = new AbortController();
  let onClosed!: () => void;
  const closed = new Promise<void>(resolve => { onClosed = resolve; });
  let writableEnded: boolean | undefined;
  respond = response => {
    response.on('close', () => { writableEnded = response.writableEnded; onClosed(); });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (pendingTool) response.write(data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_pending',
      type: 'function', function: { name: 'builtin-echo_text', arguments: '{"text":"pending"}' } }] } }] }));
    response.write(data({ choices: [{ delta: { content: 'partial before cancel' } }] }));
    // No Done/EOF: the real transport must close this connection on AbortSignal.
  };
  let owner: LlmStreamHooks | undefined, streamEvent = '', providerSettled = false;
  const register = host.ctx.llmStreamEvents.registerStreamHooks.bind(host.ctx.llmStreamEvents);
  const registration = vi.spyOn(host.ctx.llmStreamEvents, 'registerStreamHooks').mockImplementation((key, hooks) => {
    streamEvent = key; owner = hooks; register(key, hooks);
  });
  const model2 = host.ctx.llmModel2Streaming.callUnifiedModel2Stream.bind(host.ctx.llmModel2Streaming);
  const call = vi.spyOn(host.ctx.llmModel2Streaming, 'callUnifiedModel2Stream').mockImplementation(async input => {
    try { return await model2(input); } finally { providerSettled = true; }
  });
  const terminalStates: { settled: boolean; hookRemoved: boolean; blocks: (string | null | undefined)[] }[] = [];
  const offBlock = host.ctx.backendEvents.listenWindow(window, `chat_v2_event_${sessionId}`, value => {
    if ((value as { phase?: string }).phase === 'chunk') cancel.abort();
  });
  const offSession = host.ctx.backendEvents.listenWindow(window, `chat_v2_session_${sessionId}`, value => {
    if ((value as { eventType?: string }).eventType === 'stream_cancelled') terminalStates.push({
      settled: providerSettled,
      hookRemoved: !host.ctx.llmStreamEvents.unregisterStreamHooksIfOwner(streamEvent, owner!),
      blocks: host.ctx.chatSession.getMessageBlocks(assistantId).map(block => block.content),
    });
  });
  try {
    await expect(host.ctx.chatPipeline.execute(window, { sessionId, content: 'cancel me',
      userMessageId: userId, assistantMessageId: assistantId,
      options: { modelId: 'cancel-config', enableThinking: false, memoryEnabled: false, ragEnabled: false,
        webSearchEnabled: false, autoMemoryExtraction: false } }, cancel.signal, null)).rejects.toThrow('Cancelled');
    await closed;
    expect(writableEnded).toBe(false);
    expect(requests).toBe(1);
    expect(call).toHaveBeenCalledTimes(1);
    expect(terminalStates).toEqual([{ settled: true, hookRemoved: true, blocks: ['partial before cancel'] }]);
    expect(getEventListeners(cancel.signal, 'abort')).toEqual([]);
    expect(await host.ctx.llm.consumePendingCancel(streamEvent)).toBe(false);
    const labels = host.events.map(event => {
      const payload = event.payload as { eventType?: string; type?: string; phase?: string };
      return [event.event.replace(streamEvent, 'scoped'), payload.eventType ?? `${payload.type}:${payload.phase}`];
    });
    expect(labels).toEqual([
      [`chat_v2_session_${sessionId}`, 'stream_start'],
      [`chat_v2_event_${sessionId}`, 'skill_injection_audit:end'],
      ['chat_v2_llm_request_body', 'undefined:undefined'],
      ['scoped_start', 'undefined:undefined'], ['scoped_id', 'undefined:undefined'],
      ...(pendingTool ? [[`chat_v2_event_${sessionId}`, 'tool_call_preparing:start']] : []),
      [`chat_v2_event_${sessionId}`, 'content:start'],
      [`chat_v2_event_${sessionId}`, 'content:chunk'],
      [`chat_v2_session_${sessionId}`, 'stream_cancelled'],
    ]);
    expect(host.ctx.chatSession.getMessage(assistantId)!._meta?.usage).toEqual({
      promptTokens: 0, completionTokens: 0, totalTokens: 0, source: 'tiktoken',
    });
    expect(host.ctx.chatSession.getMessageBlocks(assistantId)).toMatchObject([
      { type: 'content', status: 'success', content: 'partial before cancel' },
    ]);
  } finally { offBlock(); offSession(); registration.mockRestore(); call.mockRestore(); }
});
