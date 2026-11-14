/** multi_variant.rs through host.ctx.chatPipeline: execute (parallelModelIds) → executeMultiVariant,
 * executeVariantRetry, executeVariantsRetryBatch. Real L02 unified stream over HTTP/SSE; the L04 repository
 * and VariantExecutionContext/ParallelExecutionManager surfaces (branch-only) are owner-port fixtures.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createPipelineHost } from './chat-host.ts';
import { persistenceStorePort } from './persistence-store-port.ts';
import { historyStorePort } from './history-store-port.ts';
import { installVariantOwnerFixture } from './variant-owner-port.ts';
import { withoutOwnerMethods } from './owner-gate.ts';
import type { ToolFacePrefixSnapshot } from '../api.ts';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
const requests: { model: string; messages: { role: string; content: unknown }[] }[] = [];
const server = createServer(async (request, response: ServerResponse) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string; messages: { role: string; content: unknown }[] };
  requests.push(body);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `answer from ${body.model}` }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\ndata: [DONE]\n\n`);
});
const window = { window: 'main', webview: 'main' } as const;
const prefixes = new Map<string, ToolFacePrefixSnapshot>();
/** F3 llm_usage owner port: L02 requires it for the `chat_v2_variant` task context (not published on main). */
const usage = { cacheDebugEnabled: () => false, recordLlmUsageCacheExtWithIdentity: vi.fn() };

beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  host = await createPipelineHost({ llm: true, provide: { llmUsage: usage } });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  await host.ctx.llm.saveApiConfigurations(['alpha', 'beta'].map(name => ({ id: `cfg-${name}`, name, apiKey: '', authMode: 'none',
    baseUrl, model: `model-${name}`, apiProtocol: 'openai_chat_completions', modelAdapter: 'general', supportsTools: true,
    enabled: true, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false })));
}, 60_000);
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await host?.dispose();
});

function installOwnerFixture(): void {
  installVariantOwnerFixture(host.ctx.chatSession, prefixes);
}

let sequence = 0;
function session() {
  const sessionId = `variant_${++sequence}`;
  host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: false, persistStatus: 'active',
    createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z' });
  const events: { eventType?: string; type?: string; variantId?: string }[] = [];
  host.ctx.backendEvents.listen(`chat_v2_session_${sessionId}`, value => { events.push(value as typeof events[number]); });
  host.ctx.backendEvents.listen(`chat_v2_event_${sessionId}`, value => { events.push(value as typeof events[number]); });
  return { sessionId, events, userId: `msg_vu_${sequence}`, assistantId: `msg_va_${sequence}` };
}

describe('multi-variant entries require the L04 variant owner before any effect', () => {
  it('executeVariantRetry rejects without createParallelExecutionManager', async () => {
    const persistence = persistenceStorePort();
    const service = host.ctx.chatSession;
    Object.assign(service, persistence, historyStorePort(service, persistence), {
      getMessageWithConn: () => null, updateMessageWithConn: () => {},
      getToolFacePrefix: () => null, advanceToolFacePrefix: () => {},
    });
    const t = session(); requests.length = 0;
    await withoutOwnerMethods(service, ['createParallelExecutionManager'], () =>
      expect(host.ctx.chatPipeline.executeVariantRetry(window, t.sessionId, t.assistantId, 'var_x', 'cfg-alpha',
        'q', [], {}, {}, new AbortController().signal)).rejects.toThrow(/missing createParallelExecutionManager/));
    expect(requests).toHaveLength(0);
    expect(t.events).toEqual([]);
  });
});

describe('multi_variant.rs execution (service entry)', () => {
  beforeAll(() => installOwnerFixture());

  it('execute with two parallel models fans out, persists both variants and activates the first success', async () => {
    const t = session(); requests.length = 0;
    const id = await host.ctx.chatPipeline.execute(window, { sessionId: t.sessionId, content: 'compare please',
      userMessageId: t.userId, assistantMessageId: t.assistantId,
      options: { parallelModelIds: ['cfg-alpha', 'cfg-beta'], enableThinking: false, memoryEnabled: false } },
    new AbortController().signal, null);
    expect(id).toBe(t.assistantId);
    expect(requests.map(r => r.model).sort()).toEqual(['model-alpha', 'model-beta']);
    for (const request of requests) {
      expect(request.messages.at(-1)!.role).toBe('user');
      expect(String(request.messages.at(-1)!.content)).toContain('compare please');
    }
    const assistant = host.ctx.chatSession.getMessage(t.assistantId)!;
    expect(assistant.variants!.map(v => [v.modelId, v.configId, v.status])).toEqual([
      ['model-alpha', 'cfg-alpha', 'success'], ['model-beta', 'cfg-beta', 'success']]);
    expect(assistant.activeVariantId).toBe(assistant.variants![0]!.id);
    expect(assistant._meta?.chatParams).toMatchObject({ multiVariantMode: true });
    const contents = host.ctx.chatSession.getMessageBlocks(t.assistantId).map(b => b.content).sort();
    expect(contents).toEqual(['answer from model-alpha', 'answer from model-beta']);
    expect(host.ctx.chatSession.getMessage(t.userId)).toMatchObject({ role: 'user' });
    expect(t.events.filter(e => e.eventType).map(e => e.eventType)).toEqual(['stream_start', 'stream_complete']);
    expect(t.events.filter(e => e.type === 'variant_start')).toHaveLength(2);
    const complete = t.events.find(e => e.eventType === 'stream_complete') as { usage?: { totalTokens: number } };
    expect(complete.usage?.totalTokens).toBe(12);
  });

  it('executeVariantRetry reruns one variant with the original history excluded and re-activates it', async () => {
    const t = session(); requests.length = 0;
    await host.ctx.chatPipeline.execute(window, { sessionId: t.sessionId, content: 'first question',
      userMessageId: t.userId, assistantMessageId: t.assistantId,
      options: { parallelModelIds: ['cfg-alpha', 'cfg-beta'], enableThinking: false, memoryEnabled: false } },
    new AbortController().signal, null);
    const before = host.ctx.chatSession.getMessage(t.assistantId)!;
    const beta = before.variants!.find(v => v.configId === 'cfg-beta')!;
    requests.length = 0;
    await host.ctx.chatPipeline.executeVariantRetry(window, t.sessionId, t.assistantId, beta.id, 'cfg-beta',
      'first question', [], {}, { enableThinking: false, memoryEnabled: false }, new AbortController().signal);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.model).toBe('model-beta');
    // load_variant_chat_history drops this assistant and its source user; only the retried question is sent.
    expect(requests[0]!.messages.filter(m => m.role !== 'system').map(m => m.role)).toEqual(['user']);
    const after = host.ctx.chatSession.getMessage(t.assistantId)!;
    expect(after.activeVariantId).toBe(beta.id);
    expect(after.variants!.find(v => v.id === beta.id)!.status).toBe('success');
  });

  it('executeVariantsRetryBatch rejects an empty batch with the Rust validation error', async () => {
    const t = session();
    await expect(host.ctx.chatPipeline.executeVariantsRetryBatch(window, t.sessionId, t.assistantId, [], 'q', [], {}, {},
      new AbortController().signal, null)).rejects.toThrow('Validation error: No variant IDs provided for batch retry');
  });

  it('V05-02: an AppError from get_api_configs keeps only its Display text (multi_variant.rs:177)', async () => {
    const t = session(); requests.length = 0;
    const spy = vi.spyOn(host.ctx.llm, 'getApiConfigs')
      .mockRejectedValue(new CommandError(AppError.configuration('读取供应商配置失败')));
    try {
      const failure = await host.ctx.chatPipeline.execute(window, { sessionId: t.sessionId, content: 'compare please',
        userMessageId: t.userId, assistantMessageId: t.assistantId,
        options: { parallelModelIds: ['cfg-alpha', 'cfg-beta'], enableThinking: false, memoryEnabled: false } },
      new AbortController().signal, null).then(() => null, (error: unknown) => error);
      expect(String((failure as Error | null)?.message)).toContain('Failed to get API configs: 读取供应商配置失败');
      expect(String((failure as Error | null)?.message)).not.toContain('error_type');
      expect(requests).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });
});
