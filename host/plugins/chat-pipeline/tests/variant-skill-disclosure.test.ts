/**
 * Multi-variant progressive disclosure (multi_variant.rs:1719) through the real tool runtime. Only the provider is a
 * local OpenAI-compatible SSE server.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createPipelineHost } from './chat-host.ts';
import { installVariantOwnerFixture } from './variant-owner-port.ts';
import agentSkillsPlugin from '../../agent-skills/index.ts';
import orchestrationPlugin from '../../agent-orchestration/index.ts';
import type { ToolFacePrefixSnapshot } from '../api.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
const requests: Record<string, unknown>[] = [];
let responses: ((response: ServerResponse) => void)[] = [];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
  const next = responses.shift();
  if (next === undefined) { response.writeHead(500); response.end('unexpected provider request'); return; }
  next(response);
});
const sse = (...events: unknown[]) => (response: ServerResponse) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
};
const usage = { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 };
const toolCallTurn = (id: string, name: string, args: unknown) => sse(
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage });
const answerTurn = (text: string) => sse({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage });
const toolNames = (request: Record<string, unknown> | undefined) =>
  ((request?.tools ?? []) as { function: { name: string } }[]).map(tool => tool.function.name);
const schema = (name: string, properties: Record<string, unknown> = {}, required: string[] = []) =>
  ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties, required } });

beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const mcp = { registry: { callTool: async (name: string) => [false, null, `未知工具: ${name}`, null, null, null],
    callToolWithDetails: async () => { throw new Error('not used'); }, detectToolConflicts: async () => [],
    stripMcpNamespace: (name: string) => name } };
  host = await createPipelineHost({ llm: true, provide: { mcp,
    llmUsage: { cacheDebugEnabled: () => false, recordLlmUsageCacheExtWithIdentity: vi.fn() } } });
  await host.install(agentSkillsPlugin, orchestrationPlugin);
  await host.ctx.llm.saveApiConfigurations([{ id: 'cfg-skill', name: 'skill', apiKey: '', authMode: 'none',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'model-skill',
    apiProtocol: 'openai_chat_completions', modelAdapter: 'general', supportsTools: true, enabled: true,
    isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false }]);
  installVariantOwnerFixture(host.ctx.chatSession, new Map<string, ToolFacePrefixSnapshot>());
}, 60_000);
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await host?.dispose();
});

describe('multi-variant progressive disclosure', () => {
  it('RF-W05-variant-loaded-skill-ids-truncation: variant load_skills over the 30k result budget still discloses the loaded skill\'s tools', async () => {
    // Rust multi_variant.rs:1719 reads loaded_skill_ids from the budgeted output; once the result falls back to the
    // JSON `preview` string the ids are gone and the skill's embedded tools are never advertised to the variant.
    const filler = Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [`filler-skill-${String(i).padStart(5, '0')}`, '# filler']));
    const sessionId = 'variant_skill_1', assistantId = 'msg_vs_1', variantId = 'var_vs_1';
    host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: false, persistStatus: 'active',
      createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' });
    host.ctx.chatSession.createMessage({ id: assistantId, sessionId, role: 'assistant', blockIds: [], timestamp: Date.now(),
      activeVariantId: variantId, variants: [{ id: variantId, modelId: 'model-skill', configId: 'cfg-skill', blockIds: [],
        status: 'pending', createdAt: Date.now() }] });
    requests.length = 0;
    responses = [
      toolCallTurn('call_skills_big', 'builtin-load_skills', { skills: ['interaction', 'missing-skill'] }),
      answerTurn('技能已加载'),
    ];
    await host.ctx.chatPipeline.executeVariantRetry({ window: 'main', webview: 'main' }, sessionId, assistantId, variantId,
      'cfg-skill', 'question', [], {}, { enableThinking: false, memoryEnabled: false,
        mcpToolSchemas: [schema('builtin-load_skills', { skills: { type: 'array' } }, ['skills'])],
        skillContents: { interaction: '# Interaction skill', ...filler },
        skillEmbeddedTools: { interaction: [schema('builtin-ask_user', { question: { type: 'string' } }, ['question'])] },
      }, new AbortController().signal);
    expect(requests).toHaveLength(2);
    const toolMessage = (requests[1]!.messages as { role: string; content: unknown }[]).find(message => message.role === 'tool');
    expect(String(toolMessage?.content)).toContain('"truncated":true');
    expect(String(toolMessage?.content)).toContain('"preview"');
    expect(toolNames(requests[0])).not.toContain('builtin-ask_user');
    expect(toolNames(requests[1])).toContain('builtin-ask_user');
  }, 40_000);
});
