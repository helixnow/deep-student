/**
 * W02: the production tool runtime end to end — chatPipeline.execute → ToolLoop → composeChatToolRuntime
 * (roster-ordered L04 ToolExecutorRegistry over real `agentTools` registrations from agent-orchestration /
 * agent-skills) → executors. Only the provider is replaced by a local OpenAI-compatible SSE server.
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
import mediaPlugin from '../../media/index.ts';
import { mcpEntryRevision } from '../../agent-skills/api.ts';
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

const prefixes = new Map<string, ToolFacePrefixSnapshot>();
beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  // External MCP is not exercised here; the registry only has to exist for the runtime to compose.
  const mcp = { registry: { callTool: async (name: string) => [false, null, `未知工具: ${name}`, null, null, null],
    callToolWithDetails: async () => { throw new Error('not used'); }, detectToolConflicts: async () => [],
    stripMcpNamespace: (name: string) => name } };
  host = await createPipelineHost({ llm: true, provide: { mcp } });
  await host.install(agentSkillsPlugin, orchestrationPlugin, mediaPlugin);
  await host.ctx.llm.saveApiConfigurations([{ id: 'tool-config', name: 'tool test', apiKey: '', authMode: 'none',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'tool-model',
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
    getToolFacePrefix: (sessionId: string) => prefixes.get(sessionId) ?? null,
    advanceToolFacePrefix: (sessionId: string, snapshot: ToolFacePrefixSnapshot) => { prefixes.set(sessionId, structuredClone(snapshot)); },
  });
}, 60_000);
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await host?.dispose();
});

interface McpSchema { name: string; description: string; inputSchema: Record<string, unknown> }
const schema = (name: string, properties: Record<string, unknown> = {}, required: string[] = []): McpSchema =>
  ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties, required } });
const askUserSchema = schema('builtin-ask_user', { question: { type: 'string' }, options: { type: 'array' } }, ['question']);

let sequence = 0;
function turn(options: { mcpToolSchemas?: McpSchema[]; schemaToolIds?: string[]; skillContents?: Record<string, string>;
  skillEmbeddedTools?: Record<string, McpSchema[]> }) {
  const sessionId = `real_runtime_${++sequence}`;
  host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: false, persistStatus: 'active',
    createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' });
  const events: Record<string, unknown>[] = [];
  host.ctx.backendEvents.listen(`chat_v2_event_${sessionId}`, value => { events.push(value as Record<string, unknown>); });
  const assistantId = `msg_real_assistant_${sequence}`;
  return { sessionId, assistantId, events, run: () => host.ctx.chatPipeline.execute({ window: 'main', webview: 'main' },
    { sessionId, content: 'do the task', userMessageId: `msg_real_user_${sequence}`, assistantMessageId: assistantId,
      options: { modelId: 'tool-config', enableThinking: false, memoryEnabled: false, webSearchEnabled: false,
        ...options } }, new AbortController().signal, null) };
}

const hasTokenizer = (() => { try { createRequire(import.meta.url)('tiktoken'); return true; } catch { return false; } })();

describe.skipIf(!hasTokenizer)('production tool runtime through the real tool loop', () => {
  it('attempt_completion is advertised, executes through the registry and ends the loop without another provider round', async () => {
    const t = turn({ schemaToolIds: ['todo_init'] });
    requests.length = 0;
    responses = [toolCallTurn('call_done_1', 'attempt_completion', { result: '全部完成', command: 'npm test' })];
    expect(await t.run()).toBe(t.assistantId);
    expect(requests).toHaveLength(1);
    expect(toolNames(requests[0])).toEqual(expect.arrayContaining(['todo_init', 'attempt_completion']));
    const block = host.ctx.chatSession.getMessageBlocks(t.assistantId).find(item => item.toolName === 'attempt_completion');
    expect(block).toMatchObject({ status: 'success',
      toolOutput: { completed: true, result: '全部完成', command: 'npm test', task_completed: true } });
  });

  it('ask_user waits for chat_v2_ask_user_respond and feeds the answer into the next provider round', async () => {
    const t = turn({ mcpToolSchemas: [askUserSchema] });
    requests.length = 0;
    responses = [
      toolCallTurn('call_ask_1', 'builtin-ask_user', { question: '选哪个？', options: ['甲', { label: ' 乙 ', reason: '更快' }] }),
      answerTurn('你选择了乙'),
    ];
    const asked = new Promise<void>(resolve => {
      host.ctx.backendEvents.listen(`chat_v2_event_${t.sessionId}`, value => {
        const event = value as { type?: string; phase?: string };
        if (event.type === 'tool_call' && event.phase === 'start') resolve();
      });
    });
    const running = t.run();
    await asked;
    expect(requests).toHaveLength(1);
    await host.invoke('chat_v2_ask_user_respond',
      { toolCallId: 'call_ask_1', selectedTexts: ['乙'], selectedIndices: [1], customText: null, source: 'user_click' });
    expect(await running).toBe(t.assistantId);
    expect(requests).toHaveLength(2);
    expect(toolNames(requests[0])).toContain('builtin-ask_user');
    const toolMessage = (requests[1]!.messages as { role: string; content: unknown; tool_call_id?: string }[])
      .find(message => message.role === 'tool');
    expect(toolMessage?.tool_call_id).toBe('call_ask_1');
    expect(String(toolMessage?.content)).toContain('乙');
    const blocks = host.ctx.chatSession.getMessageBlocks(t.assistantId);
    expect(blocks.find(item => item.toolName === 'builtin-ask_user')).toMatchObject({ status: 'success', toolOutput: {
      question: '选哪个？', selected: ['乙'], selected_indices: [1], custom_text: null, source: 'user_click',
      options: [{ label: '甲' }, { label: '乙', reason: '更快' }], multiple: false } });
    expect(blocks.at(-1)!.content).toBe('你选择了乙');
  });

  it('withholds schemas whose tools have no executable executor and keeps the executable ones', async () => {
    const t = turn({
      mcpToolSchemas: [askUserSchema, schema('builtin-no_such_builtin_tool'), schema('builtin-todo_get')],
      schemaToolIds: ['goal_get', 'unknown_schema_tool'],
    });
    requests.length = 0;
    responses = [answerTurn('nothing to do')];
    await t.run();
    expect(requests).toHaveLength(1);
    const names = toolNames(requests[0]);
    expect(names).toEqual(expect.arrayContaining(['builtin-ask_user', 'builtin-todo_get', 'goal_get', 'attempt_completion']));
    expect(names).not.toContain('builtin-no_such_builtin_tool');
    expect(names).not.toContain('unknown_schema_tool');
  });

  it('load_skills records the session skill state and progressively discloses the skill\'s executable tools', async () => {
    const t = turn({
      mcpToolSchemas: [schema('builtin-load_skills', { skills: { type: 'array' } }, ['skills'])],
      skillContents: { interaction: '# Interaction skill' },
      skillEmbeddedTools: { interaction: [askUserSchema, schema('builtin-no_such_builtin_tool')] },
    });
    requests.length = 0;
    responses = [
      toolCallTurn('call_skills_1', 'builtin-load_skills', { skills: '["interaction", "missing-skill"]' }),
      answerTurn('技能已加载'),
    ];
    await t.run();
    expect(requests).toHaveLength(2);
    expect(toolNames(requests[0])).not.toContain('builtin-ask_user');
    expect(toolNames(requests[1])).toContain('builtin-ask_user');
    expect(toolNames(requests[1])).not.toContain('builtin-no_such_builtin_tool');
    const block = host.ctx.chatSession.getMessageBlocks(t.assistantId).find(item => item.toolName === 'builtin-load_skills');
    expect(block).toMatchObject({ status: 'success', toolOutput: { result: { status: 'success',
      requested_skill_ids: ['interaction', 'missing-skill'], loaded_skill_ids: ['interaction'],
      newly_loaded_skill_ids: ['interaction'], missing_skill_ids: ['missing-skill'], available_skill_ids: ['interaction'],
      loaded_tool_names: ['builtin-ask_user', 'builtin-no_such_builtin_tool'], skill_state_version: 1 } } });
    const state = JSON.parse(host.ctx.chatSession.loadSessionState(t.sessionId)!.skillStateJson!) as Record<string, unknown>;
    expect(state).toMatchObject({ agenticSessionSkillIds: ['interaction'], version: 1, legacyMigrated: false });
  });

  it('RF-W02-loaded-skill-ids-truncation: load_skills over the 30k result budget still discloses the loaded skill\'s tools', async () => {
    // Rust tool_loop.rs:2016 reads loaded_skill_ids from the budgeted output; once the result falls back to the
    // JSON `preview` string the ids are gone and the skill's embedded tools are never advertised.
    const filler = Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [`filler-skill-${String(i).padStart(5, '0')}`, '# filler']));
    const t = turn({
      mcpToolSchemas: [schema('builtin-load_skills', { skills: { type: 'array' } }, ['skills'])],
      skillContents: { interaction: '# Interaction skill', ...filler },
      skillEmbeddedTools: { interaction: [askUserSchema] },
    });
    requests.length = 0;
    responses = [
      toolCallTurn('call_skills_big', 'builtin-load_skills', { skills: ['interaction', 'missing-skill'] }),
      answerTurn('技能已加载'),
    ];
    await t.run();
    expect(requests).toHaveLength(2);
    const toolMessage = (requests[1]!.messages as { role: string; content: unknown }[]).find(message => message.role === 'tool');
    expect(String(toolMessage?.content)).toContain('"truncated":true');
    expect(String(toolMessage?.content)).toContain('"preview"');
    expect(toolNames(requests[0])).not.toContain('builtin-ask_user');
    expect(toolNames(requests[1])).toContain('builtin-ask_user');
  });

  it('goal tools persist through the L04 goal repository and enforce one unfinished goal per session', async () => {
    const t = turn({ schemaToolIds: ['goal_create'] });
    requests.length = 0;
    responses = [
      toolCallTurn('call_goal_1', 'goal_create', { objective: '  学完第一章  ', token_budget: 5000 }),
      toolCallTurn('call_goal_2', 'goal_create', { objective: '另一个目标' }),
      toolCallTurn('call_goal_3', 'goal_update', { status: 'complete' }),
      answerTurn('目标完成'),
    ];
    await t.run();
    const blocks = host.ctx.chatSession.getMessageBlocks(t.assistantId).filter(item => item.toolName?.startsWith('goal_'));
    expect(blocks.map(item => item.status)).toEqual(['success', 'error', 'success']);
    expect(blocks[0]!.toolOutput).toMatchObject({ success: true,
      goal: { sessionId: t.sessionId, objective: '学完第一章', status: 'active', tokenBudget: 5000, tokensUsed: 0 } });
    expect(blocks[1]!.error).toMatch(/^cannot create a new goal because this session has an unfinished goal/);
    expect(blocks[2]!.toolOutput).toMatchObject({ goal: { status: 'complete' }, message: '目标已标记完成，自动续跑停止。' });
  });

  it('todo tools run against the shared session store and report continue_execution until all steps are done', async () => {
    const t = turn({ schemaToolIds: ['todo_init'] });
    requests.length = 0;
    responses = [
      toolCallTurn('call_todo_1', 'todo_init', { title: '两步任务', steps: [{ description: '第一步' }, { description: '第二步' }] }),
      toolCallTurn('call_todo_2', 'todo_update', { stepId: 'step_1', status: 'done', result: 'ok' }),
      toolCallTurn('call_todo_3', 'todo_update', { stepId: 'step_2', status: 'completed' }),
      answerTurn('完成'),
    ];
    await t.run();
    expect(requests).toHaveLength(4);
    const outputs = host.ctx.chatSession.getMessageBlocks(t.assistantId)
      .filter(item => item.toolName?.startsWith('todo_')).map(item => item.toolOutput as Record<string, unknown>);
    expect(outputs.map(output => [output.progress ?? null, output.isAllDone, output.continue_execution])).toEqual([
      [null, false, true], ['1/2', false, true], ['2/2', true, false],
    ]);
    expect(host.ctx.agentTodo.getTodoList(t.sessionId)?.steps.map(step => step.status)).toEqual(['completed', 'completed']);
  });

  it('self_inspect reports roots, skills, MCP servers and search configuration without secret values', async () => {
    const server = { id: 'brave', name: 'Brave Search', transportType: 'stdio', command: 'npx', env: { BRAVE_API_KEY: 'sk-secret' } };
    await host.ctx.settings.saveSecret('mcp.tools.list', JSON.stringify([server, { name: 'Legacy' }]));
    host.ctx.settings.save('web_search.engine', 'tavily');
    host.ctx.settings.save('web_search.api_key.tavily', 'tvly-secret');
    const t = turn({ mcpToolSchemas: [schema('builtin-self_inspect', { section: { type: 'string' } })],
      skillContents: { interaction: '# 交互' } });
    requests.length = 0;
    responses = [toolCallTurn('call_inspect_1', 'builtin-self_inspect', {}), answerTurn('ok')];
    await t.run();
    const block = host.ctx.chatSession.getMessageBlocks(t.assistantId).find(item => item.toolName === 'builtin-self_inspect');
    expect(block?.status).toBe('success');
    const output = block!.toolOutput as Record<string, any>;
    expect(Object.keys(output)).toEqual(['section', 'roots', 'skills', 'mcp', 'search', 'effective_runtime']);
    expect(output.roots.roots.map((root: { id: string }) => root.id)).toEqual(expect.arrayContaining(['artifacts', 'temp']));
    expect(Object.keys(output.roots.roots[0])).toEqual(['id', 'kind', 'path', 'access', 'label', 'description', 'session_scoped', 'configured']);
    expect(output.skills).toMatchObject({ registered_skills: [{ id: 'interaction', content_length: 8, runtime_admitted: true,
      admission_error: null, loaded: false, active: false }], loaded_skill_ids: [], session_skill_state_available: true });
    expect(output.mcp.servers).toEqual([
      { id: 'brave', name: 'Brave Search', transport: 'stdio', enabled: true, has_stable_id: true, entry_revision: mcpEntryRevision(server) },
      { id: 'Legacy', name: 'Legacy', transport: 'unknown', enabled: true, has_stable_id: false, entry_revision: mcpEntryRevision({ name: 'Legacy' }) },
    ]);
    expect(output.search).toMatchObject({ runtime_enabled: false, settings: [
      { key: 'web_search.api_key.tavily', configured: true }, { key: 'web_search.engine', configured: true }] });
    expect(output.effective_runtime).toMatchObject({ persona: null,
      permissions: { execution_allowlist_enforced: false, allowed_tool_count: null },
      features: { web_search_enabled: false, memory_enabled: false } });
    const serialized = JSON.stringify(output);
    for (const secret of ['sk-secret', 'tvly-secret', 'npx']) expect(serialized).not.toContain(secret);
  });

  it('session tools read the real chat_v2 database and refuse to mutate the running session', async () => {
    const t = turn({ mcpToolSchemas: [schema('builtin-session_get', { session_id: { type: 'string' } }, ['session_id']),
      schema('builtin-session_rename', { session_id: { type: 'string' }, title: { type: 'string' } }, ['session_id', 'title'])] });
    responses = [
      toolCallTurn('call_session_get', 'builtin-session_get', { session_id: t.sessionId }),
      toolCallTurn('call_session_rename', 'builtin-session_rename', { session_id: t.sessionId, title: 'x' }),
      answerTurn('done'),
    ];
    await t.run();
    const blocks = host.ctx.chatSession.getMessageBlocks(t.assistantId);
    const get = blocks.find(item => item.toolName === 'builtin-session_get');
    expect(get?.status).toBe('success');
    expect(get!.toolOutput).toMatchObject({ id: t.sessionId, persistStatus: 'active', tags: [], groupName: null });
    const rename = blocks.find(item => item.toolName === 'builtin-session_rename');
    expect(rename?.error).toBe('不能对当前正在使用的会话执行重命名');
  });

  it('tool_pack is assembled by the pipeline and re-enters the real registry for each child', async () => {
    const t = turn({ mcpToolSchemas: [schema('builtin-tool_pack', { tools: { type: 'array' } }, ['tools'])] });
    requests.length = 0;
    responses = [
      toolCallTurn('call_pack_1', 'builtin-tool_pack', { tools: [
        { name: 'session_get', args: { session_id: t.sessionId } },
        { name: 'builtin-session_rename', args: { session_id: t.sessionId, title: 'x' } }] }),
      answerTurn('done'),
    ];
    await t.run();
    expect(toolNames(requests[0])).toContain('builtin-tool_pack');
    const blocks = host.ctx.chatSession.getMessageBlocks(t.assistantId);
    const pack = blocks.find(item => item.toolName === 'builtin-tool_pack');
    expect(pack).toMatchObject({ status: 'success', toolOutput: { succeeded: 1, failed: 1, status: 'partial', results: [
      { index: 0, tool_name: 'session_get', success: true, output: { id: t.sessionId } },
      { index: 1, tool_name: 'builtin-session_rename', success: false, error: '不能对当前正在使用的会话执行重命名' }] } });
  });

  it('settings/model tools read the main settings table and the llm model directory', async () => {
    host.ctx.settings.save('theme', 'dark');
    host.ctx.settings.save('api_key_hint', 'never listed');
    const t = turn({ mcpToolSchemas: [schema('builtin-settings_get', { prefix: { type: 'string' } }, ['prefix']),
      schema('builtin-model_assignments_get')] });
    requests.length = 0;
    responses = [
      toolCallTurn('call_settings_1', 'builtin-settings_get', { prefix: 'theme' }),
      toolCallTurn('call_models_1', 'builtin-model_assignments_get', {}),
      answerTurn('读取完成'),
    ];
    await t.run();
    expect(toolNames(requests[0])).toEqual(expect.arrayContaining(['builtin-settings_get', 'builtin-model_assignments_get']));
    const blocks = host.ctx.chatSession.getMessageBlocks(t.assistantId);
    const settings = blocks.find(item => item.toolName === 'builtin-settings_get');
    expect(settings).toMatchObject({ status: 'success', toolOutput: { prefix: 'theme', count: 1,
      settings: [{ key: 'theme', value: 'dark', truncated: false }],
      message_key: 'chat.tools.settings_models.settings_get.success' } });
    const models = blocks.find(item => item.toolName === 'builtin-model_assignments_get');
    expect(models).toMatchObject({ status: 'success', toolOutput: {
      available_models: expect.arrayContaining([expect.objectContaining({ id: 'tool-config', name: 'tool test', model_type: 'text' })]),
      pagination: { page: 1, page_size: 20 },
      message_key: 'chat.tools.settings_models.model_assignments_get.success' } });
  });
});
