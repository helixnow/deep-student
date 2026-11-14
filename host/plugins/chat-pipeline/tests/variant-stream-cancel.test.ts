/** multi_variant.rs:1495–1549 — the variant LLM call races the idle watchdog and the variant cancel token.
 * On either branch Rust drops the provider future: the HTTP stream is closed and the dropped future emits
 * nothing further (no `{stream}_cancelled`). Real L02 unified stream over a held-open local SSE response.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createPipelineHost } from './chat-host.ts';
import { installVariantOwnerFixture } from './variant-owner-port.ts';
import type { ToolFacePrefixSnapshot } from '../api.ts';

interface HeldStream { request: IncomingMessage; response: ServerResponse; closed: Promise<{ socketDestroyed: boolean; writableEnded: boolean }> }
let host: Awaited<ReturnType<typeof createPipelineHost>>;
let arrived: (stream: HeldStream) => void = () => {};
const server = createServer(async (request, response) => {
  for await (const _chunk of request) { /* drain body */ }
  const closed = new Promise<{ socketDestroyed: boolean; writableEnded: boolean }>(resolve => response.on('close',
    () => resolve({ socketDestroyed: request.socket.destroyed, writableEnded: response.writableEnded })));
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial variant' } }] })}\n\n`);
  // Deliberately never ends: only the client's cancellation can close this response.
  arrived({ request, response, closed });
});
const window = { window: 'main', webview: 'main' } as const;
const usage = { cacheDebugEnabled: () => false, recordLlmUsageCacheExtWithIdentity: vi.fn() };

beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  host = await createPipelineHost({ llm: true, provide: { llmUsage: usage } });
  await host.ctx.llm.saveApiConfigurations([{ id: 'cfg-held', name: 'held', apiKey: '', authMode: 'none',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'model-held',
    apiProtocol: 'openai_chat_completions', modelAdapter: 'general', supportsTools: false, enabled: true,
    isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false }]);
  installVariantOwnerFixture(host.ctx.chatSession, new Map<string, ToolFacePrefixSnapshot>());
}, 60_000);
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await host?.dispose();
});

let sequence = 0;
function variantMessage() {
  const n = ++sequence;
  const sessionId = `variant_cancel_${n}`, assistantId = `msg_vc_${n}`, variantId = `var_vc_${n}`;
  host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: false, persistStatus: 'active',
    createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' });
  host.ctx.chatSession.createMessage({ id: assistantId, sessionId, role: 'assistant', blockIds: [], timestamp: Date.now(),
    activeVariantId: variantId, variants: [{ id: variantId, modelId: 'model-held', configId: 'cfg-held', blockIds: [],
      status: 'pending', createdAt: Date.now() }] });
  const held = new Promise<HeldStream>(resolve => { arrived = resolve; });
  const from = host.events.length;
  const trace = () => host.events.slice(from).map(event => event.event);
  const streamEvent = () => {
    const start = trace().find(name => name.startsWith(`chat_v2_event_${sessionId}_var_${variantId}_run_`) && name.endsWith('_start'));
    return start?.slice(0, -'_start'.length);
  };
  return { sessionId, assistantId, variantId, held, trace, streamEvent };
}
const closedWithin = (stream: HeldStream, ms: number) => Promise.race([stream.closed,
  new Promise<'still open'>(resolve => setTimeout(() => resolve('still open'), ms).unref())]);

describe('multi_variant.rs variant LLM call cancellation (service entry, real HTTP)', () => {
  it('idle timeout cancels the upstream HTTP stream and fails the variant with the Rust timeout error', async () => {
    host.ctx.settings.save('chat.stream.timeout_ms', '1');
    const t = variantMessage();
    try {
      await expect(host.ctx.chatPipeline.executeVariantRetry(window, t.sessionId, t.assistantId, t.variantId, 'cfg-held',
        'held question', [], {}, { enableThinking: false, memoryEnabled: false }, new AbortController().signal))
        // error.rs:105 Display of ChatV2Error::Timeout.
        .rejects.toThrow(/^Tool execution timeout: LLM stream timed out: no data received for \d+s$/);
      const stream = await t.held;
      expect(await closedWithin(stream, 5_000)).toEqual({ socketDestroyed: true, writableEnded: false });
      const streamEvent = t.streamEvent();
      expect(streamEvent).toBeDefined();
      // The dropped Rust future cannot emit its `_cancelled` epilogue.
      expect(t.trace().filter(name => name.startsWith(streamEvent!) && name !== `${streamEvent}_start` && name !== `${streamEvent}_id`)).toEqual([]);
      expect(await host.ctx.llm.consumePendingCancel(streamEvent!)).toBe(false);
      const variant = host.ctx.chatSession.getMessage(t.assistantId)!.variants!.find(v => v.id === t.variantId)!;
      expect(variant).toMatchObject({ status: 'error', error: expect.stringMatching(/^LLM stream timed out: no data received for \d+s$/) });
    } finally { host.ctx.settings.save('chat.stream.timeout_ms', ''); }
  }, 40_000);

  it('variant cancel token closes the upstream stream, keeps partial text and emits no `{stream}_cancelled`', async () => {
    const t = variantMessage();
    const cancel = new AbortController();
    host.ctx.backendEvents.listen(`chat_v2_event_${t.sessionId}`, value => {
      const event = value as { type?: string; phase?: string };
      if (event.type === 'content' && event.phase === 'chunk') cancel.abort();
    });
    await host.ctx.chatPipeline.executeVariantRetry(window, t.sessionId, t.assistantId, t.variantId, 'cfg-held',
      'held question', [], {}, { enableThinking: false, memoryEnabled: false }, cancel.signal);
    expect(cancel.signal.aborted).toBe(true);
    const stream = await t.held;
    expect(await closedWithin(stream, 5_000)).toEqual({ socketDestroyed: true, writableEnded: false });
    const streamEvent = t.streamEvent();
    expect(streamEvent).toBeDefined();
    expect(t.trace()).not.toContain(`${streamEvent}_cancelled`);
    expect(t.trace().filter(name => name.startsWith(streamEvent!) && name !== `${streamEvent}_start` && name !== `${streamEvent}_id`)).toEqual([]);
    expect(await host.ctx.llm.consumePendingCancel(streamEvent!)).toBe(false);
    const message = host.ctx.chatSession.getMessage(t.assistantId)!;
    expect(message.variants!.find(v => v.id === t.variantId)!.status).toBe('cancelled');
    expect(host.ctx.chatSession.getMessageBlocks(t.assistantId).map(block => [block.type, block.content, block.status]))
      .toEqual([['content', 'partial variant', 'success']]);
  }, 40_000);
});
