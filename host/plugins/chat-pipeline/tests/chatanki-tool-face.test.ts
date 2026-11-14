/**
 * W02: a chatanki turn freezes its tool face into chat_v2_sessions.metadata_json
 * (G3 chatanki.library.list.bad_args.negative_page). Real chat DB, real agentTools roster and the
 * real chatanki plugin; only the provider is a local SSE server.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createPipelineHost } from './chat-host.ts';
import { persistenceStorePort } from './persistence-store-port.ts';
import { historyStorePort } from './history-store-port.ts';
import agentSkillsPlugin from '../../agent-skills/index.ts';
import orchestrationPlugin from '../../agent-orchestration/index.ts';
import chatankiPlugin from '../../chatanki/index.ts';

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

beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const mcp = { registry: { callTool: async (name: string) => [false, null, `未知工具: ${name}`, null, null, null],
    callToolWithDetails: async () => { throw new Error('not used'); }, detectToolConflicts: async () => [],
    stripMcpNamespace: (name: string) => name } };
  host = await createPipelineHost({ llm: true, provide: { mcp, review: {}, anki: {} } });
  await host.install(agentSkillsPlugin, orchestrationPlugin, chatankiPlugin);
  await host.ctx.llm.saveApiConfigurations([{ id: 'chatanki-config', name: 'chatanki test', apiKey: '', authMode: 'none',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'chatanki-model',
    apiProtocol: 'openai_chat_completions', modelAdapter: 'general', supportsTools: true,
    enabled: true, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false }]);
  const persistence = persistenceStorePort();
  const service = host.ctx.chatSession;
  Object.assign(service, persistence, historyStorePort(service, persistence), {
    getMessageWithConn: (_conn: unknown, id: string) => service.getMessage(id),
    updateMessageWithConn: (conn: { run(sql: string, params: unknown[]): void }, message: { id: string; blockIds: string[]; _meta?: unknown }) => {
      conn.run('UPDATE chat_v2_messages SET block_ids_json=?, meta_json=? WHERE id=?',
        [JSON.stringify(message.blockIds), JSON.stringify(message._meta ?? null), message.id]);
    },
  });
}, 60_000);
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await host?.dispose();
});

const schema = (name: string) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} } });
const hasTokenizer = (() => { try { createRequire(import.meta.url)('tiktoken'); return true; } catch { return false; } })();

describe.skipIf(!hasTokenizer)('chatanki session tool face', () => {
  // Rust (G3 A side) froze all seven offered names. update_library_card / delete_library_card have no chatanki
  // executor yet, so they are withheld from the provider request and from the frozen order; the rest is Rust's order.
  it('RF-W02-executable-only-tool-face: a chatanki turn freezes the executable offered tools into session metadata in Rust order', async () => {
    const sessionId = 'sess_chatanki_tool_face';
    host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: false, persistStatus: 'active',
      createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' });
    requests.length = 0;
    responses = [toolCallTurn('call_w0_107', 'builtin-chatanki_list_library_cards', { page: -1 }), answerTurn('W0_DONE')];
    await host.ctx.chatPipeline.execute({ window: 'main', webview: 'main' }, {
      sessionId, content: 'list library cards', userMessageId: 'msg_chatanki_face_u1', assistantMessageId: 'msg_chatanki_face_a1',
      options: { modelId: 'chatanki-config', enableThinking: false, memoryEnabled: false, ragEnabled: false,
        webSearchEnabled: false, contextLimit: 32768, maxTokens: 256,
        mcpToolSchemas: ['load_skills', 'builtin-chatanki_list_library_cards', 'builtin-chatanki_update_library_card',
          'builtin-chatanki_delete_library_card', 'builtin-chatanki_get_cards', 'builtin-chatanki_update_card',
          'builtin-chatanki_delete_card'].map(schema) },
    }, new AbortController().signal, null);
    expect(requests).toHaveLength(2);
    expect([...toolNames(requests[0])].sort()).toEqual(['builtin-chatanki_delete_card', 'builtin-chatanki_get_cards',
      'builtin-chatanki_list_library_cards', 'builtin-chatanki_update_card', 'builtin-load_skills']);
    const metadata = host.ctx.chatSession.getSession(sessionId)?.metadata as Record<string, unknown> | null | undefined;
    expect(metadata).toEqual({ toolFacePrefixGeneration: 0, frozenToolSchemaOrder: [
      'builtin-chatanki_delete_card', 'builtin-chatanki_get_cards', 'builtin-chatanki_list_library_cards',
      'builtin-chatanki_update_card', 'builtin-load_skills'] });
  });
});
