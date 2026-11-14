import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
// boundary-allow cross-plugin-impl: shared integration fixture creates the real chat DB and pipeline; test-only.
import { createPipelineHost } from '../../chat-pipeline/tests/chat-host.ts';
// boundary-allow cross-plugin-impl: existing pipeline repository fixture, test-only; production code uses public services.
import { persistenceStorePort } from '../../chat-pipeline/tests/persistence-store-port.ts';
// boundary-allow cross-plugin-impl: existing history repository fixture, test-only.
import { historyStorePort } from '../../chat-pipeline/tests/history-store-port.ts';
import agentSkills from '../../agent-skills/index.ts'; // boundary-allow cross-plugin-impl: install real plugin in integration test.
import orchestration from '../../agent-orchestration/index.ts'; // boundary-allow cross-plugin-impl: install real plugin in integration test.
import { WorkshopOperations } from '../src/operations.ts';
import { PipelineWorkshopGeneration } from '../src/generation.ts';
import { WorkshopCatalog } from '../src/catalog.ts';
import { WorkshopToolExecutor } from '../src/tools.ts';
import { pluginServiceName } from '../../../kernel/plugin-id.ts';

it('runs the actual chat pipeline against a local SSE provider and reaches a compiled pending confirmation', async () => {
  let responseText = '';
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests.length === 1) {
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read-sdk', type: 'function', function: {
        name: 'dstu_plugin_api_read', arguments: JSON.stringify({ id: 'sdk:version' }),
      } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
      return;
    }
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: responseText }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const host = await createPipelineHost({ llm: true, provide: { mcp: { registry: {
    callTool: async () => [false, null, 'not used', null, null, null], detectToolConflicts: async () => [], stripMcpNamespace: (name: string) => name,
  } } } });
  try {
    await host.install(agentSkills, orchestration);
    const address = server.address() as { port: number };
    await host.ctx.llm.saveApiConfigurations([{ id: 'workshop-probe', name: 'Workshop probe', apiKey: '', authMode: 'none',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'workshop-model', apiProtocol: 'openai_chat_completions', modelAdapter: 'general', supportsTools: true,
      enabled: true, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false }]);
    const service = host.ctx.chatSession, persistence = persistenceStorePort();
    Object.assign(service, persistence, historyStorePort(service, persistence), {
      getMessageWithConn: (_conn: unknown, id: string) => service.getMessage(id),
      updateMessageWithConn: (conn: { run(sql: string, params: unknown[]): void }, message: { id: string; blockIds: string[]; _meta?: unknown }) =>
        conn.run('UPDATE chat_v2_messages SET block_ids_json=?, meta_json=? WHERE id=?', [JSON.stringify(message.blockIds), JSON.stringify(message._meta ?? null), message.id]),
    });
    const ops = new WorkshopOperations({ ...host.ctx.app, version: '0.20.0', dataDir: host.ctx.paths.appDataDir });
    const tools = new WorkshopToolExecutor(ops, new WorkshopCatalog(() => []));
    const registration = host.ctx.agentTools.registerToolExecutors([tools]);
    ops.bindGeneration(new PipelineWorkshopGeneration(service, host.ctx.chatPipeline, tools));
    const card = await ops.propose({ sessionId: 'parent-probe', title: 'Recall', description: 'Return a word recall helper', template: 'host-tool', changes: [], capabilities: [] });
    const name = pluginServiceName(card.pluginId);
    responseText = JSON.stringify({ files: [{ path: 'index.ts', content: `export default {name:${JSON.stringify(card.pluginId)},meta:{id:${JSON.stringify(card.pluginId)},version:'1.0.0',provides:[${JSON.stringify(name)}],remote:{${JSON.stringify(name)}:['review']}},apply(ctx){ctx.provide(${JSON.stringify(name)},{review(){return 'pipeline-generated';}});}};` }] });
    await ops.create(card.id, card.revision);
    await vi.waitFor(async () => expect((await ops.status(card.id)).state).not.toBe('generating'), { timeout: 30_000 });
    const final = await ops.status(card.id);
    expect(final.state, final.error ?? '').toBe('pending-confirmation');
    expect(final.check?.ok).toBe(true);
    expect(requests).toHaveLength(2);
    const toolReply = (requests[1]?.messages as { role: string; tool_call_id?: string; content?: string }[]).find(message => message.role === 'tool' && message.tool_call_id === 'read-sdk');
    expect(toolReply?.content).toContain('0.20.0');
    const advertised = requests.flatMap(request => ((request.tools ?? []) as { function: { name: string } }[]).map(tool => tool.function.name));
    expect(advertised).toEqual(expect.arrayContaining(['dstu_plugin_api_list', 'dstu_plugin_api_read']));
    expect(advertised).not.toContain('dstu_plugin_propose_install');
    expect(advertised).not.toContain('builtin-local_shell_execute');
    registration.dispose();
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await host.dispose();
  }
}, 60_000);
