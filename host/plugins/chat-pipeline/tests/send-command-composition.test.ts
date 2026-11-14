/** WP-025: registered L04 send → L03 execute/compiler → L02/L01 HTTP → L04 WithConn.
 * No replacement command, pipeline, compiler or repository. Only the remote provider is scripted.
 * Source: send_message.rs:462–710; pipeline.rs:705–1057,1062–1217.
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createPipelineHost } from './chat-host.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
let respond: (response: ServerResponse) => void;
const requests: { model: string; stream: boolean; messages: { role: string; content: string }[]; tools?: unknown }[] = [];
const earlyUsers: (string | null | undefined)[][] = [];
let currentUserId = '';
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  earlyUsers.push(host.ctx.chatSession.getMessageBlocks(currentUserId).map(block => block.content));
  respond(response);
});
const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const window = { window: 'main', webview: 'main' } as const;
const content = '请回答：单轮真实发送\n保留中文与换行';

beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  // Real F4 backgroundTasks is required by L04's production send registration.
  host = await createPipelineHost({ llm: true, diagnostics: true });
  await host.invoke('save_api_configurations', { configs: [{ id: 'wp025-config', name: 'WP025',
    apiKey: '', authMode: 'none', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    model: 'wp025-model', apiProtocol: 'openai_chat_completions', modelAdapter: 'general',
    enabled: true, supportsTools: true, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false }] });
}, 60_000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await host?.dispose();
});

it.each(['success', 'http-error', 'cancel'] as const)('WP-025 registered send single round: %s', async outcome => {
  const sessionId = `sess_wp025_${outcome}`, userId = `user_wp025_${outcome}`, assistantId = `msg_wp025_${outcome}`;
  host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: true, persistStatus: 'active',
    createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z' });
  requests.length = 0; earlyUsers.length = 0; host.events.length = 0; currentUserId = userId;
  const owner = host.ctx.chatSession;
  // Passive spies retain each real method and expose the D1 transaction identity.
  const messages = vi.spyOn(owner, 'createMessageWithConn');
  const blocks = vi.spyOn(owner, 'createBlockWithConn');
  const sidecars = vi.spyOn(owner, 'updateBlockReplayWithConn');
  const stream = vi.spyOn(host.ctx.llmModel2Streaming, 'callUnifiedModel2Stream');
  const hooks = vi.spyOn(host.ctx.llmStreamEvents, 'registerStreamHooks');
  let closed!: () => void;
  const transportClosed = new Promise<void>(resolve => { closed = resolve; });
  let writableEnded: boolean | undefined;
  respond = response => {
    response.on('close', () => { writableEnded = response.writableEnded; closed(); });
    if (outcome === 'http-error') {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'WP025 business rejection', type: 'invalid_request_error' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (outcome === 'cancel') {
      response.write(data({ choices: [{ delta: { content: 'partial before cancel' } }] }));
      return; // The real cancellation must close this still-open HTTP stream.
    }
    response.end(data({ choices: [{ delta: { content: '单轮回答' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } }) + 'data: [DONE]\n\n');
  };
  type Terminal = { eventType: string; messageId: string; error?: string; streamGeneration?: number };
  const terminalPayloads: Terminal[] = [];
  const persistedAtTerminal: { roles: string[]; user: (string | null | undefined)[]; assistant: (string | null | undefined)[] }[] = [];
  let finish!: () => void;
  const terminal = new Promise<void>(resolve => { finish = resolve; });
  const offSession = host.ctx.backendEvents.listenWindow(window, `chat_v2_session_${sessionId}`, raw => {
    const event = raw as Terminal;
    if (!['stream_complete', 'stream_error', 'stream_cancelled'].includes(event.eventType)) return;
    terminalPayloads.push(event);
    // Public reads use the primary connection: only committed transaction data is visible here.
    persistedAtTerminal.push({ roles: owner.getSessionMessages(sessionId).map(message => message.role),
      user: owner.getMessageBlocks(userId).map(block => block.content),
      assistant: owner.getMessageBlocks(assistantId).map(block => block.content) });
    finish();
  });
  let finishCancel!: (result: unknown) => void;
  const cancelCommand = new Promise<unknown>(resolve => { finishCancel = resolve; });
  let cancelRequested = false;
  const offBlock = host.ctx.backendEvents.listenWindow(window, `chat_v2_event_${sessionId}`, raw => {
    const event = raw as { type: string; phase: string };
    if (outcome === 'cancel' && event.type === 'content' && event.phase === 'chunk' && !cancelRequested) {
      cancelRequested = true;
      finishCancel(host.invoke('chat_v2_cancel_stream', { sessionId, messageId: assistantId }));
    }
  });
  try {
    // send returns admission ID, not the asynchronous provider result.
    await expect(host.invoke('chat_v2_send_message', { request: { sessionId, content,
      userMessageId: userId, assistantMessageId: assistantId,
      options: { modelId: 'wp025-config', disableTools: true, enableThinking: false,
        memoryEnabled: false, ragEnabled: false, webSearchEnabled: false, autoMemoryExtraction: false } } }, window))
      .resolves.toBe(assistantId);
    const generation = host.ctx.chatState.registrationGeneration(sessionId);
    expect(generation).not.toBeNull();
    if (outcome === 'cancel') await expect(cancelCommand).resolves.toBeNull();
    await terminal;
    await transportClosed;
    // Terminal alone precedes the L04 StreamGuard/task finally: wait for the actual owner barrier.
    await vi.waitFor(() => expect(host.ctx.chatState.trackedTaskCount()).toBe(0));
    expect(await host.invoke('chat_v2_has_active_stream', { sessionId })).toBe(false);
    expect(requests).toHaveLength(1);
    expect(earlyUsers).toEqual([[content]]);
    expect(requests[0]).toMatchObject({ model: 'wp025-model', stream: true });
    expect(requests[0]).not.toHaveProperty('tools');
    expect(requests[0]!.messages.map(message => message.role)).toEqual(['system', 'user']);
    const compiled = requests[0]!.messages[1]!.content;
    expect(compiled).toContain(`<user_query>\n${content}\n</user_query>`);
    expect(compiled).toContain('<injected_context>');
    expect(compiled).toContain('<runtime_facts>');
    expect(requests[0]!.messages[0]!.content).not.toContain('<runtime_facts>');
    expect(stream).toHaveBeenCalledTimes(1);
    expect(stream.mock.calls[0]![0]).toMatchObject({ disableTools: true, modelOverrideId: 'wp025-config' });
    const userBlocks = owner.getMessageBlocks(userId);
    expect(userBlocks).toHaveLength(1);
    const replay = owner.getBlockReplayMapWithConn(owner.database.getConnSafe(), userId);
    expect(replay.get(userBlocks[0]!.id)?.llmContent).toBe(compiled);
    expect(owner.getMessage(assistantId)?._meta?.executionSnapshot).toMatchObject({
      resolvedModelId: 'wp025-config', resolvedModelIsMultimodal: false, executionRoute: 'text_model_direct',
    });
    const finalTx = messages.mock.calls.find(([, message]) => message.id === assistantId)![0];
    expect(finalTx).not.toBe(owner.database.getConnSafe());
    expect(messages.mock.calls.some(([conn, message]) => conn === finalTx && message.id === userId)).toBe(true);
    expect(blocks.mock.calls.some(([conn, block]) => conn === finalTx && block.messageId === userId)).toBe(true);
    expect(sidecars.mock.calls.some(([conn, id]) => conn === finalTx && id === userBlocks[0]!.id)).toBe(true);
    const expectedContent = outcome === 'success' ? ['单轮回答'] : outcome === 'cancel' ? ['partial before cancel'] : [];
    expect(persistedAtTerminal).toEqual([{ roles: ['user', 'assistant'], user: [content], assistant: expectedContent }]);
    const terminalType = outcome === 'success' ? 'stream_complete' : outcome === 'cancel' ? 'stream_cancelled' : 'stream_error';
    expect(terminalPayloads).toHaveLength(1);
    expect(terminalPayloads[0]).toMatchObject({ eventType: terminalType, messageId: assistantId, streamGeneration: Number(generation) });
    if (outcome === 'http-error') expect(terminalPayloads[0]!.error).toContain('WP025 business rejection');
    if (outcome === 'success') expect(owner.getMessage(assistantId)?._meta?.usage)
      .toMatchObject({ promptTokens: 11, completionTokens: 3, totalTokens: 14 });
    for (const block of owner.getMessageBlocks(assistantId)) {
      expect(block).toMatchObject({ type: 'content', status: 'success' });
      expect(blocks.mock.calls.some(([conn, saved]) => conn === finalTx && saved.id === block.id)).toBe(true);
    }
    const streamEvent = stream.mock.calls[0]![0].streamEvent;
    const hookOwner = hooks.mock.calls.find(([key]) => key === streamEvent)![1];
    expect(host.ctx.llmStreamEvents.unregisterStreamHooksIfOwner(streamEvent, hookOwner)).toBe(false);
    expect(await host.ctx.llm.consumePendingCancel(streamEvent)).toBe(false);
    if (outcome === 'cancel') {
      expect(writableEnded).toBe(false);
      const labels = host.events.map(event => {
        const payload = event.payload as { eventType?: string; type?: string; phase?: string };
        return [event.event.replace(streamEvent, 'scoped'), payload.eventType ?? `${payload.type}:${payload.phase}`];
      });
      expect(labels).toEqual([
        ['chat_v2_request_audit', 'undefined:undefined'],
        [`chat_v2_session_${sessionId}`, 'stream_start'],
        [`chat_v2_event_${sessionId}`, 'skill_injection_audit:end'],
        ['chat_v2_llm_request_body', 'undefined:undefined'],
        ['scoped_start', 'undefined:undefined'], ['scoped_id', 'undefined:undefined'],
        [`chat_v2_event_${sessionId}`, 'content:start'],
        [`chat_v2_event_${sessionId}`, 'content:chunk'],
        [`chat_v2_session_${sessionId}`, 'stream_cancelled'],
      ]);
      // Provider settled, transport closed and tracked task drained: no pending loser can emit later.
      expect(host.events.at(-1)?.event).toBe(`chat_v2_session_${sessionId}`);
    }
  } finally { offBlock(); offSession(); }
});
