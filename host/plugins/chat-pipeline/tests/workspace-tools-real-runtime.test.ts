/**
 * W02: workspace_executor.rs through the production runtime — chatPipeline.execute → ToolLoop → L04 registry →
 * L07 WorkspaceToolContribution → WorkspaceToolExecutor, with worker dispatch going through the L04
 * `chatWorkerRuntime` service into a real background worker pipeline. Only the provider is a local SSE server.
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
import type { ToolFacePrefixSnapshot } from '../api.ts';

type Request = Record<string, unknown> & { messages?: { role: string; content: unknown }[] };
type Reply = (response: ServerResponse, request: Request) => void;
let host: Awaited<ReturnType<typeof createPipelineHost>>;
const mainRequests: Request[] = [];
const workerRequests: Request[] = [];
let mainReplies: Reply[] = [];
let workerReplies: Reply[] = [];
// A worker's turn is the parent's task delivered through the workspace inbox.
const isWorkerRequest = (request: Request) => (request.messages ?? [])
  .some(message => message.role === 'user' && String(message.content).includes('[来自 '));
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString()) as Request;
  const worker = isWorkerRequest(body);
  (worker ? workerRequests : mainRequests).push(body);
  const next = worker ? workerReplies.shift() ?? answer('worker 已收到') : mainReplies.shift();
  if (next === undefined) { response.writeHead(500); response.end('unexpected provider request'); return; }
  next(response, body);
});
const sse = (response: ServerResponse, ...events: unknown[]) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
};
const usage = { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 };
const lastToolOutput = (request: Request): Record<string, unknown> => {
  const tool = (request.messages ?? []).filter(message => message.role === 'tool').at(-1);
  return JSON.parse(String(tool?.content)) as Record<string, unknown>;
};
const toolCall = (id: string, name: string, args: (request: Request) => unknown): Reply => (response, request) => sse(response,
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args(request)) } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage });
const answer = (text: string): Reply => response => sse(response,
  { choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage });

const prefixes = new Map<string, ToolFacePrefixSnapshot>();
beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const mcp = { registry: { callTool: async (name: string) => [false, null, `未知工具: ${name}`, null, null, null],
    callToolWithDetails: async () => { throw new Error('not used'); }, detectToolConflicts: async () => [],
    stripMcpNamespace: (name: string) => name } };
  host = await createPipelineHost({ llm: true, provide: { mcp } });
  // dstu.agent-workspace is part of the finalization fixture profile.
  await host.install(agentSkillsPlugin, orchestrationPlugin);
  await host.ctx.llm.saveApiConfigurations([{ id: 'tool-config', name: 'tool test', apiKey: '', authMode: 'none',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'tool-model',
    apiProtocol: 'openai_chat_completions', modelAdapter: 'general', supportsTools: true,
    enabled: true, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false }]);
  await host.ctx.llm.saveModelAssignments({ model2_config_id: 'tool-config' });
  const persistence = persistenceStorePort();
  const service = host.ctx.chatSession;
  Object.assign(service, persistence, historyStorePort(service, persistence), {
    getMessageWithConn: (_conn: unknown, id: string) => service.getMessage(id),
    updateMessageWithConn: (conn: { run(sql: string, params: unknown[]): void }, message: { id: string; blockIds: string[]; _meta?: unknown }) => {
      conn.run('UPDATE chat_v2_messages SET block_ids_json=?, meta_json=? WHERE id=?',
        [JSON.stringify(message.blockIds), JSON.stringify(message._meta ?? null), message.id]);
    },
    getToolFacePrefix: (sessionId: string) => prefixes.get(sessionId) ?? null,
    advanceToolFacePrefix: (sessionId: string, snapshot: ToolFacePrefixSnapshot) => { prefixes.set(sessionId, structuredClone(snapshot)); },
  });
}, 60_000);
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await host?.dispose();
});

const schema = (name: string) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} } });
const WORKSPACE_TOOLS = ['workspace_create', 'workspace_create_agent', 'workspace_send', 'workspace_query',
  'workspace_set_context', 'workspace_get_context', 'workspace_update_document', 'workspace_read_document'];
const hasTokenizer = (() => { try { createRequire(import.meta.url)('tiktoken'); return true; } catch { return false; } })();

describe.skipIf(!hasTokenizer)('workspace tools retirement and subagent runtime through the real tool loop', () => {
  it('retires all 8 legacy workspace tools from tool advertisement and fails closed if invoked', async () => {
    const sessionId = 'ws_coordinator_1';
    host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: false, persistStatus: 'active',
      createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' });
    mainReplies = [
      toolCall('c1', 'builtin-workspace_create', () => ({ name: 'Team' })),
      answer('已改用 subagent 模式'),
    ];
    const assistantId = 'msg_ws_assistant_1';
    await host.ctx.chatPipeline.execute({ window: 'main', webview: 'main' },
      { sessionId, content: '组织一次协作', userMessageId: 'msg_ws_user_1', assistantMessageId: assistantId,
        options: { modelId: 'tool-config', enableThinking: false, memoryEnabled: false, webSearchEnabled: false,
          mcpToolSchemas: [
            ...WORKSPACE_TOOLS.map(name => schema(`builtin-${name}`)),
            schema('builtin-subagent_call'),
          ] } }, new AbortController().signal, null);

    const advertised = ((mainRequests[0]?.tools ?? []) as { function: { name: string } }[]).map(tool => tool.function.name);
    for (const legacyTool of WORKSPACE_TOOLS) {
      expect(advertised).not.toContain(`builtin-${legacyTool}`);
    }
    expect(advertised).toContain('builtin-subagent_call');

    const block = host.ctx.chatSession.getMessageBlocks(assistantId).find(item => item.toolName === 'builtin-workspace_create');
    expect(block?.status).toBe('error');
  }, 60_000);

  it('subagent_call creates a worker, dispatches it through chatWorkerRuntime and waits for its terminal task', async () => {
    const sessionId = 'subagent_parent_1';
    host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: false, persistStatus: 'active',
      createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' });
    workerRequests.length = 0;
    workerReplies = [answer('行列式等于 -2')];
    mainReplies = [
      toolCall('s1', 'builtin-subagent_call', () => ({ task: '计算 [[1,2],[3,4]] 的行列式', context: { hint: '2x2' } })),
      answer('子代理已完成'),
    ];
    const assistantId = 'msg_subagent_assistant_1';
    await host.ctx.chatPipeline.execute({ window: 'main', webview: 'main' },
      { sessionId, content: '委托一个子代理', userMessageId: 'msg_subagent_user_1', assistantMessageId: assistantId,
        options: { modelId: 'tool-config', enableThinking: false, memoryEnabled: false, webSearchEnabled: false,
          mcpToolSchemas: [schema('builtin-subagent_call')] } }, new AbortController().signal, null);

    const block = host.ctx.chatSession.getMessageBlocks(assistantId).find(item => item.toolName === 'builtin-subagent_call');
    expect(block?.status).toBe('success');
    const output = block!.toolOutput as Record<string, any>;
    expect(output).toMatchObject({ status: 'completed', output: '行列式等于 -2', output_truncated: false,
      auto_created_workspace: true, profile_id: 'worker', skill_id: null, resumed: false,
      token_usage: { promptTokens: 9, completionTokens: 3, totalTokens: 12 } });
    expect(output.agent_session_id).toMatch(/^subagent_worker_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(typeof output.run_id).toBe('string');
    expect(workerRequests).toHaveLength(1);
    expect(JSON.stringify(workerRequests[0]!.messages)).toContain('计算 [[1,2],[3,4]] 的行列式\\n\\n[Context]');
    const session = host.ctx.chatSession.getSession(output.agent_session_id);
    expect(session).toMatchObject({ mode: 'subagent', title: 'Subagent: worker', titleLocked: true,
      metadata: { workspace_id: output.workspace_id, role: 'worker', is_subagent: true, parent_session_id: sessionId,
        subagent_depth: 1, profile_skill_contents: {}, effective_agent_profile: { id: 'worker', skill_ids: [] } } });
    const workspace = host.ctx.agentWorkspace.getWorkspace(output.workspace_id);
    expect(workspace).toMatchObject({ name: '计算 [[1,2],[3,4]] 的行列式', creatorSessionId: sessionId });
    // The parent loop got the structured result, and the duplicate completion envelope was swallowed.
    const toolMessage = (mainRequests.at(-1)!.messages ?? []).filter(item => item.role === 'tool').at(-1);
    expect(String(toolMessage?.content)).toContain('行列式等于 -2');
    expect(host.ctx.agentWorkspace.drainInbox(output.workspace_id, sessionId, 10)
      .filter(item => item.content.includes('agent_completion'))).toEqual([]);
  }, 60_000);

  it('RF-W02-super-closed-worker-revival: Super-agent worker tools drive the worker lifecycle and a closed worker stays closed', async () => {
    const state = await host.invoke('super_session_set_enabled', { enabled: true }) as { sessionId: string; workspaceId: string };
    expect(state.sessionId).toBeTruthy();
    workerRequests.length = 0;
    workerReplies = [];
    let workerId = '';
    mainReplies = [
      toolCall('u1', 'builtin-super_dispatch_worker', () => ({ title: '查资料', task: '找出行列式的定义' })),
      toolCall('u2', 'builtin-super_list_workers', request => { workerId = String(lastToolOutput(request).worker_id); return {}; }),
      toolCall('u3', 'builtin-super_message_worker', () => ({ worker_id: workerId, message: '再补一个例子' })),
      toolCall('u4', 'builtin-super_close_worker', () => ({ worker_id: workerId })),
      toolCall('u5', 'builtin-super_message_worker', () => {
        // The cancelled run winds down after close and rewrites the status (workspace_handlers.rs:2015 / :1966).
        host.ctx.agentWorkspace.updateAgentStatus(state.workspaceId, workerId, 'cancelled');
        return { worker_id: workerId, message: '还在吗' };
      }),
      answer('Router 完成'),
    ];
    const assistantId = 'msg_super_assistant_1';
    await host.ctx.chatPipeline.execute({ window: 'main', webview: 'main' },
      { sessionId: state.sessionId, content: '派一个 worker', userMessageId: 'msg_super_user_1', assistantMessageId: assistantId,
        options: { modelId: 'tool-config', enableThinking: false, memoryEnabled: false, webSearchEnabled: false } },
      new AbortController().signal, null);

    const blocks = host.ctx.chatSession.getMessageBlocks(assistantId).filter(item => item.toolName?.startsWith('builtin-super_'));
    expect(blocks.map(item => [item.toolName, item.status])).toEqual([
      ['builtin-super_dispatch_worker', 'success'], ['builtin-super_list_workers', 'success'],
      ['builtin-super_message_worker', 'success'], ['builtin-super_close_worker', 'success'],
      ['builtin-super_message_worker', 'error']]);
    const [dispatch, list, follow, close, rejected] = blocks.map(item => item.toolOutput as Record<string, any>);
    expect(dispatch).toMatchObject({ workspace_id: state.workspaceId, worker_id: workerId, agent_session_id: workerId,
      title: '查资料', profile_id: 'explorer', auto_created_workspace: false, resumed: false });
    expect(workerId).toMatch(/^subagent_explorer_/);
    expect(host.ctx.chatSession.getSession(workerId)).toMatchObject({ title: '查资料', mode: 'subagent' });
    expect(host.ctx.agentWorkspace.getAgent(state.workspaceId, workerId)?.metadata).toMatchObject({
      super_agent: { title: '查资料', dispatched_in_message_id: assistantId } });
    expect(list).toMatchObject({ workspace_id: state.workspaceId, count: 1, workers: [{ worker_id: workerId, title: '查资料',
      profile_id: 'explorer', dispatched_in_message_id: assistantId, closed_by_router: false }] });
    expect(follow).toMatchObject({ worker_id: workerId, title: '查资料', resumed: true, agent_session_id: workerId });
    expect(close).toEqual({ worker_id: workerId, workspace_id: state.workspaceId, title: '查资料', status: 'closed', already_closed: false });
    // Rust only checks `status == Closed` (super_session_executor.rs:407), which the wind-down above has replaced;
    // it would accept the message and revive the worker the Router closed.
    expect(host.ctx.agentWorkspace.getAgent(state.workspaceId, workerId)).toMatchObject({ status: 'cancelled',
      metadata: { super_agent: { closed_by_router: true } } });
    expect(blocks[4]!.error).toBe(`Worker ${workerId} was closed; dispatch a new worker instead`);
    void rejected;
  }, 60_000);

  it('Super-agent worker tools fail closed outside the active Super session', async () => {
    const sessionId = 'not_super_1';
    host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: false, persistStatus: 'active',
      createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' });
    mainReplies = [toolCall('n1', 'builtin-super_list_workers', () => ({})), answer('done')];
    const assistantId = 'msg_not_super_1';
    await host.ctx.chatPipeline.execute({ window: 'main', webview: 'main' },
      { sessionId, content: 'x', userMessageId: 'msg_not_super_user_1', assistantMessageId: assistantId,
        options: { modelId: 'tool-config', enableThinking: false, memoryEnabled: false, webSearchEnabled: false,
          mcpToolSchemas: [schema('builtin-super_list_workers')] } }, new AbortController().signal, null);
    const block = host.ctx.chatSession.getMessageBlocks(assistantId).find(item => item.toolName === 'builtin-super_list_workers');
    expect(block).toMatchObject({ status: 'error', error: 'Super-agent tools are only available in the active Super-agent session' });
  }, 60_000);
});

