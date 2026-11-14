/**
 * W02: the multi-variant pipeline advertises only tools the production runtime can execute, like the single
 * pipeline. Real agentTools registrations; only the provider is a local OpenAI-compatible SSE server.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createPipelineHost } from './chat-host.ts';
import { installVariantOwnerFixture } from './variant-owner-port.ts';
import agentSkillsPlugin from '../../agent-skills/index.ts';
import orchestrationPlugin from '../../agent-orchestration/index.ts';
import type { ToolFacePrefixSnapshot } from '../api.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
const requests: Record<string, unknown>[] = [];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
});
const toolNames = (request: Record<string, unknown> | undefined) =>
  ((request?.tools ?? []) as { function: { name: string } }[]).map(tool => tool.function.name);
const schema = (name: string) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} } });

beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const mcp = { registry: { callTool: async (name: string) => [false, null, `未知工具: ${name}`, null, null, null],
    callToolWithDetails: async () => { throw new Error('not used'); }, detectToolConflicts: async () => [],
    stripMcpNamespace: (name: string) => name } };
  host = await createPipelineHost({ llm: true, provide: { mcp,
    llmUsage: { cacheDebugEnabled: () => false, recordLlmUsageCacheExtWithIdentity: vi.fn() } } });
  await host.install(agentSkillsPlugin, orchestrationPlugin);
  await host.ctx.llm.saveApiConfigurations([{ id: 'cfg-adv', name: 'adv', apiKey: '', authMode: 'none',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'model-adv',
    apiProtocol: 'openai_chat_completions', modelAdapter: 'general', supportsTools: true, enabled: true,
    isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false }]);
  installVariantOwnerFixture(host.ctx.chatSession, new Map<string, ToolFacePrefixSnapshot>());
}, 60_000);
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await host?.dispose();
});

describe('multi-variant tool advertisement', () => {
  it('withholds MCP schemas without an executable executor and keeps builtin and external ones', async () => {
    const sessionId = 'variant_adv_1', assistantId = 'msg_va_1', variantId = 'var_va_1';
    host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: false, persistStatus: 'active',
      createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' });
    host.ctx.chatSession.createMessage({ id: assistantId, sessionId, role: 'assistant', blockIds: [], timestamp: Date.now(),
      activeVariantId: variantId, variants: [{ id: variantId, modelId: 'model-adv', configId: 'cfg-adv', blockIds: [],
        status: 'pending', createdAt: Date.now() }] });
    requests.length = 0;
    await host.ctx.chatPipeline.executeVariantRetry({ window: 'main', webview: 'main' }, sessionId, assistantId, variantId,
      'cfg-adv', 'question', [], {}, { enableThinking: false, memoryEnabled: false, mcpToolSchemas: [
        schema('builtin-ask_user'), schema('builtin-no_such_builtin_tool'), schema('builtin-todo_get'), schema('weather_lookup'),
      ] }, new AbortController().signal);
    expect(requests).toHaveLength(1);
    const names = toolNames(requests[0]);
    expect(names).toEqual(expect.arrayContaining(['builtin-ask_user', 'builtin-todo_get', 'mcp_weather_lookup']));
    expect(names).not.toContain('builtin-no_such_builtin_tool');
  }, 40_000);
});
