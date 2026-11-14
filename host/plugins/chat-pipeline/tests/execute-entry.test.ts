/** pipeline.rs:599/705/1062 + tool_loop.rs no-tool round through host.ctx.chatPipeline.execute.
 * Real L02 unified stream → real L01 HTTP/SSE adapter (local script server) → L03 save → terminal.
 * Only the L04 repository surface that main has not integrated yet is supplied by the owner-port fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createPipelineHost } from './chat-host.ts';
import { persistenceStorePort } from './persistence-store-port.ts';
import { historyStorePort } from './history-store-port.ts';
import { ChatV2Error } from '../../chat/api.ts';
import type { ToolFacePrefixSnapshot } from '../api.ts';
import { withoutOwnerMethods } from './owner-gate.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
const requests: Record<string, unknown>[] = [];
let respond: (response: ServerResponse, body: Record<string, unknown>) => void;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
  requests.push(body);
  respond(response, body);
});
const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const window = { window: 'main', webview: 'main' } as const;
const prefixes = new Map<string, ToolFacePrefixSnapshot>();

function installOwnerFixture(): void {
  const persistence = persistenceStorePort();
  const service = host.ctx.chatSession;
  const history = historyStorePort(service, persistence);
  Object.assign(service, persistence, history, {
    getMessageWithConn: (_conn: unknown, id: string) => service.getMessage(id),
    updateMessageWithConn: (conn: { run(sql: string, params: unknown[]): void }, message: { id: string; blockIds: string[]; _meta?: unknown }) => {
      conn.run('UPDATE chat_v2_messages SET block_ids_json=?, meta_json=? WHERE id=?',
        [JSON.stringify(message.blockIds), JSON.stringify(message._meta ?? null), message.id]);
    },
    getToolFacePrefix: (sessionId: string) => prefixes.get(sessionId) ?? null,
    advanceToolFacePrefix: (sessionId: string, snapshot: ToolFacePrefixSnapshot) => { prefixes.set(sessionId, structuredClone(snapshot)); },
  });
}

beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  host = await createPipelineHost({ llm: true });
  await host.ctx.llm.saveApiConfigurations([{ id: 'exec-config', name: 'execute test', apiKey: '', authMode: 'none',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'exec-model',
    apiProtocol: 'openai_chat_completions', modelAdapter: 'general', supportsTools: true,
    enabled: true, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false }]);
}, 60_000);
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await host?.dispose();
});

let sequence = 0;
function session() {
  const sessionId = `exec_entry_${++sequence}`;
  host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: false, persistStatus: 'active',
    createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z' });
  const events: { eventType?: string; type?: string; phase?: string; error?: string }[] = [];
  const persistedAtEvent: boolean[] = [];
  const userId = `msg_user_${sequence}`, assistantId = `msg_assistant_${sequence}`;
  host.ctx.backendEvents.listen(`chat_v2_session_${sessionId}`, value => {
    events.push(value as typeof events[number]);
    persistedAtEvent.push(host.ctx.chatSession.getMessage(assistantId) !== null);
  });
  host.ctx.backendEvents.listen(`chat_v2_event_${sessionId}`, value => { events.push(value as typeof events[number]); });
  return { sessionId, userId, assistantId, events, persistedAtEvent,
    request: (options: Record<string, unknown> = {}) => ({ sessionId, content: 'ping from user', userMessageId: userId,
      assistantMessageId: assistantId, options: { modelId: 'exec-config', enableThinking: false, memoryEnabled: false,
        webSearchEnabled: false, ...options } }) };
}
const terminals = (events: { eventType?: string }[]) => events.filter(e => e.eventType).map(e => e.eventType);

describe('chatPipeline.execute requires the L04 owner surface before any event or write', () => {
  it('rejects without stream_start or saved messages when chatSession lacks repository methods', async () => {
    const t = session();
    await withoutOwnerMethods(host.ctx.chatSession, ['buildUserMessage'], () =>
      expect(host.ctx.chatPipeline.execute(window, t.request(), new AbortController().signal, null))
        .rejects.toThrow(/requires the L04 chatSession owner API: missing buildUserMessage/));
    expect(t.events).toEqual([]);
    expect(host.ctx.chatSession.getMessage(t.userId)).toBeNull();
  });
});

describe('pipeline.rs single-variant execute → provider stream → save_results → terminal', () => {
  beforeAll(() => installOwnerFixture());

  it('plain answer: frozen model, real HTTP request, user + assistant persisted before stream_complete', async () => {
    const t = session(); requests.length = 0;
    respond = response => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(data({ choices: [{ delta: { content: 'pong answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } }) + 'data: [DONE]\n\n');
    };
    expect(await host.ctx.chatPipeline.execute(window, t.request(), new AbortController().signal, null)).toBe(t.assistantId);
    expect(requests).toHaveLength(1);
    const body = requests[0]!;
    expect(body).toMatchObject({ model: 'exec-model', stream: true });
    expect(body).not.toHaveProperty('tools');
    const messages = body.messages as { role: string; content: unknown }[];
    expect(messages[0]!.role).toBe('system');
    expect(messages.at(-1)!.role).toBe('user');
    expect(String(messages.at(-1)!.content)).toContain('<user_query>');
    expect(String(messages.at(-1)!.content)).toContain('ping from user');
    // Rust pipeline.rs:290: the user message is written before execute_internal; save_results completes it.
    expect(host.ctx.chatSession.getMessage(t.userId)).toMatchObject({ role: 'user', sessionId: t.sessionId });
    expect(host.ctx.chatSession.getMessageBlocks(t.assistantId).map(block => block.content)).toEqual(['pong answer']);
    const assistant = host.ctx.chatSession.getMessage(t.assistantId)!;
    expect(assistant._meta?.usage).toMatchObject({ promptTokens: 11, completionTokens: 3, totalTokens: 14 });
    expect(assistant._meta?.modelId).toBe('exec-model');
    expect(terminals(t.events)).toEqual(['stream_start', 'stream_complete']);
    expect(t.persistedAtEvent.at(-1)).toBe(true);
    const start = t.events.find(e => e.eventType === 'stream_start') as { modelId?: string } | undefined;
    expect(start?.modelId).toBe('exec-model');
  });

  it('second turn replays persisted history through L03 history loading', async () => {
    const t = session(); requests.length = 0;
    respond = response => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      // API usage keeps the round off the estimator path (native tiktoken is an infra-owned package).
      response.end(data({ choices: [{ delta: { content: 'turn answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) + 'data: [DONE]\n\n');
    };
    await host.ctx.chatPipeline.execute(window, t.request(), new AbortController().signal, null);
    const next = { ...t.request(), content: 'follow up', userMessageId: `${t.userId}_2`, assistantMessageId: `${t.assistantId}_2` };
    await host.ctx.chatPipeline.execute(window, next, new AbortController().signal, null);
    const roles = (requests[1]!.messages as { role: string; content: unknown }[]).map(m => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
    expect((requests[1]!.messages as { content: unknown }[])[2]!.content).toBe('turn answer');
  });

  it('provider failure after partial output saves partial content and emits only stream_error', async () => {
    const t = session(); requests.length = 0;
    respond = response => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(data({ choices: [{ delta: { content: 'partial' } }] }));
      setTimeout(() => response.destroy(), 20);
    };
    await expect(host.ctx.chatPipeline.execute(window, t.request(), new AbortController().signal, null))
      .rejects.toBeInstanceOf(ChatV2Error);
    expect(requests).toHaveLength(1);
    expect(host.ctx.chatSession.getMessageBlocks(t.assistantId).map(block => block.content)).toEqual(['partial']);
    expect(terminals(t.events)).toEqual(['stream_start', 'stream_error']);
    expect(t.persistedAtEvent.at(-1)).toBe(true);
  });

  it('does not retry again after a retry streams partial content and then fails', async () => {
    const t = session(); requests.length = 0;
    host.ctx.settings.save('chat.stream.timeout_ms', '1');
    respond = response => {
      if (requests.length === 1) {
        // A provider-side connection failure reported as a non-retryable HTTP status
        // reaches L03 directly, without spending L02's separate HTTP retry budget.
        response.writeHead(400); response.end('connection failed');
      } else if (requests.length === 2) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(data({ choices: [{ delta: { content: 'retry partial' } }] }));
        // Keep this stream open until L03's idle watchdog cancels it.
      } else {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(data({ choices: [{ delta: { content: 'unwanted replacement' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) + 'data: [DONE]\n\n');
      }
    };
    try {
      await expect(host.ctx.chatPipeline.execute(window, t.request(), new AbortController().signal, null))
        .rejects.toBeInstanceOf(ChatV2Error);
      expect(requests).toHaveLength(2);
      expect(host.ctx.chatSession.getMessageBlocks(t.assistantId).map(block => block.content)).toEqual(['retry partial']);
      expect(terminals(t.events)).toEqual(['stream_start', 'stream_reconnect', 'stream_error']);
    } finally { host.ctx.settings.save('chat.stream.timeout_ms', ''); }
  });

  it('cancellation closes the real stream, saves partial content and emits stream_cancelled', async () => {
    const t = session(); const cancel = new AbortController();
    let closed!: () => void;
    const closedPromise = new Promise<void>(resolve => { closed = resolve; });
    respond = response => {
      response.on('close', closed);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(data({ choices: [{ delta: { content: 'cancelled partial' } }] }));
    };
    host.ctx.backendEvents.listen(`chat_v2_event_${t.sessionId}`, value => {
      if ((value as { phase?: string }).phase === 'chunk') cancel.abort();
    });
    await expect(host.ctx.chatPipeline.execute(window, t.request(), cancel.signal, null)).rejects.toThrow('Cancelled');
    await closedPromise;
    expect(host.ctx.chatSession.getMessageBlocks(t.assistantId).map(block => block.content)).toEqual(['cancelled partial']);
    expect(terminals(t.events)).toEqual(['stream_start', 'stream_cancelled']);
  });

  it('executeWithExistingUser keeps the existing user row untouched (skip_user_message_save)', async () => {
    const t = session(); requests.length = 0;
    respond = response => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(data({ choices: [{ delta: { content: 'retry answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) + 'data: [DONE]\n\n');
    };
    await host.ctx.chatPipeline.executeWithExistingUser(window, t.request(), new AbortController().signal, null);
    expect(host.ctx.chatSession.getMessageBlocks(t.assistantId).map(block => block.content)).toEqual(['retry answer']);
    expect(terminals(t.events)).toEqual(['stream_start', 'stream_complete']);
  });

  it('executeWithEmitter rejects parallel model ids before emitting or saving (pipeline.rs:160)', async () => {
    const t = session(); requests.length = 0;
    const emitter = host.ctx.chatPipeline.createSessionEventEmitter(t.sessionId, { batching: false });
    try {
      await expect(host.ctx.chatPipeline.executeWithEmitter(emitter,
        t.request({ parallelModelIds: ['exec-config', 'exec-config'] }), new AbortController().signal, null))
        .rejects.toThrow('Validation error: multi-variant execution requires a windowed emitter; use execute()');
      expect(requests).toHaveLength(0);
      expect(t.events).toEqual([]);
      expect(host.ctx.chatSession.getMessage(t.userId)).toBeNull();
    } finally { emitter.dispose(); }
  });
});
