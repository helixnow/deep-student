/**
 * workspace_run_agent / workspace_create_agent / workspace_restore_executions.
 * Ports `workspace_handlers.rs::runtime_completion_tests` (L2811-2903) and adds
 * production-entry contract tests (Rust has none for these commands).
 *
 * Real: chat plugin + L05 agent-workspace plugin + chat_v2/workspace DBs + L03
 * `attachChildToTree` (real chat-pipeline helper host). Stand-ins, because the
 * owners have not published them on main yet: L03 `execute` (contract in
 * chat-pipeline/api.ts ChatPipelineExecution), L06 `headlessToolSchemas`,
 * L05 `CHATANKI_READONLY_TOOLS` (portable exports replaced with vi.mock).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import workspace from '../../agent-workspace/index.ts';
import pipelinePlugin from '../../chat-pipeline/index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { newSession } from '../src/types.ts';
import { ChatV2Error, ensureGrantLive, lookupGrantForSession } from '../api.ts';
import type { BackendSendRequest } from '../src/send-message.ts';
import {
  agentCompletionEnvelope, resolveProfileSkillSnapshot, workerRuntimeSurfaces,
} from '../src/workspace-run-agent.ts';
import { AgentProfileResolver, EXPLORER_PROFILE_ID } from '../../agent-workspace/api.ts';

const stand = vi.hoisted(() => ({
  headless: [
    { name: 'builtin-web_search', description: 'web search', inputSchema: { type: 'object' } },
    { name: 'builtin-note_append', description: 'not in any read-only profile', inputSchema: { type: 'object' } },
  ],
  chatanki: ['builtin-chatanki_get_cards', 'builtin-chatanki_status', 'builtin-chatanki_analyze', 'builtin-chatanki_list_templates'],
}));
vi.mock('../../agent-orchestration/portable.ts', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), headlessToolSchemas: () => structuredClone(stand.headless),
}));
vi.mock('../../agent-workspace/portable.ts', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), CHATANKI_READONLY_TOOLS: stand.chatanki,
}));

describe('workspace_handlers.rs runtime_completion_tests', () => {
  it('completion_envelope_uses_stable_runtime_protocol_fields', () => {
    const value = JSON.parse(JSON.stringify(agentCompletionEnvelope({
      workspaceId: 'ws_test', agentSessionId: 'agent_test', parentSessionId: 'sess_parent', taskId: 'task_test',
      runId: 'msg_run', correlationId: 'wsmsg_task', status: 'completed', finalOutput: 'done', error: null,
      completedAt: '2026-07-11T00:00:00Z',
      tokenUsage: { promptTokens: 120, completionTokens: 30, totalTokens: 150, source: 'api' },
    })));
    expect(value.type).toBe('agent_completion');
    expect(value.workspace_id).toBe('ws_test');
    expect(value.agent_session_id).toBe('agent_test');
    expect(value.parent_session_id).toBe('sess_parent');
    expect(value.task_id).toBe('task_test');
    expect(value.run_id).toBe('msg_run');
    expect(value.correlation_id).toBe('wsmsg_task');
    expect(value.status).toBe('completed');
    expect(value.final_output).toBe('done');
    expect('error' in value).toBe(false);
    expect(value.token_usage.promptTokens).toBe(120);
    expect(value.token_usage.completionTokens).toBe(30);
    expect(value.token_usage.totalTokens).toBe(150);
  });

  it('failed_completion_omits_output_and_carries_error', () => {
    const value = JSON.parse(JSON.stringify(agentCompletionEnvelope({
      workspaceId: 'ws_test', agentSessionId: 'agent_test', parentSessionId: null, taskId: null, runId: 'msg_run',
      correlationId: null, status: 'failed', finalOutput: null, error: 'pipeline failed',
      completedAt: '2026-07-11T00:00:00Z', tokenUsage: null,
    })));
    expect(value.status).toBe('failed');
    expect(value.error).toBe('pipeline failed');
    expect('final_output' in value).toBe(false);
    expect('task_id' in value).toBe(false);
    expect('correlation_id' in value).toBe(false);
    expect('parent_session_id' in value).toBe(false);
    expect('token_usage' in value).toBe(false);
  });

  it('profile_skill_snapshot_selects_declared_ids_and_rejects_missing', () => {
    const metadata = { profile_skill_contents: { research: 'snapshot body', unrelated: 'must not be injected' } };
    const selected = resolveProfileSkillSnapshot(['research'], metadata);
    expect(selected.size).toBe(1);
    expect(selected.get('research')).toBe('snapshot body');
    expect(selected.has('unrelated')).toBe(false);
    expect(() => resolveProfileSkillSnapshot(['missing'], metadata)).toThrow(/silently ignored/);
  });
});

describe('worker runtime commands (production entry)', () => {
  let helperFixture: ReturnType<typeof databaseFixture>;
  let helpers: Awaited<ReturnType<typeof createTestHost>>;
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let requests: BackendSendRequest[];
  let behavior: (request: BackendSendRequest, signal: AbortSignal) => Promise<string>;
  let grantDuringRun: { live: boolean } | null;

  beforeAll(async () => {
    helperFixture = databaseFixture();
    helpers = await createTestHost({ plugins: [plugin, pipelinePlugin], provide: {
      storage: helperFixture.storage, vfs: vfsStub, settings: {}, nativeTokenizer: {}, vfsRepo: {}, agentVfsResolver: {},
    } });
  });
  afterAll(async () => { await helpers.dispose(); helperFixture.dispose(); });
  beforeEach(async () => {
    f = databaseFixture();
    requests = []; grantDuringRun = null;
    behavior = async request => request.assistantMessageId!;
    const real = helpers.ctx.chatPipeline;
    host = await createTestHost({ plugins: [workspace, plugin], provide: {
      storage: f.storage, vfs: vfsStub, settings: {}, secrets: {},
      chatPipeline: {
        async execute(_window: unknown, request: BackendSendRequest, signal: AbortSignal) {
          requests.push(request);
          const grant = lookupGrantForSession(request.sessionId);
          grantDuringRun = grant === null ? null : { live: ensureGrantLive(grant) === null };
          return behavior(request, signal);
        },
        attachChildToTree: (parent: string, child: string, declared?: null) => real.attachChildToTree(parent, child, declared),
      },
    } });
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });

  async function waitFor(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 500 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(predicate()).toBe(true);
  }
  async function newWorkspace(name: string | null = null): Promise<string> {
    const created = await host.invoke<{ workspace_id: string }>('workspace_create', { sessionId: 'owner', request: { name } });
    host.ctx.agentWorkspace.registerAgent(created.workspace_id, 'owner', 'coordinator', null, null);
    return created.workspace_id;
  }
  const events = (name: string) => host.events.filter(event => event.event === name).map(event => event.payload as Record<string, unknown>);

  it('surfaces gate is open only because every cross-lane surface is present', () => {
    expect(workerRuntimeSurfaces()?.chatankiReadonlyTools).toEqual(stand.chatanki);
  });

  it('workspace_create_agent: worker with initial task runs through the backend runtime and delivers completion', async () => {
    const ws = await newWorkspace();
    const response = await host.invoke<Record<string, unknown>>('workspace_create_agent', { request: {
      workspace_id: ws, requester_session_id: 'owner', skill_id: null, role: null, initial_task: 'do it', system_prompt: 'SP',
    } });
    const agentId = response.agent_session_id as string;
    expect(agentId).toMatch(/^agent_worker_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(response).toEqual({ agent_session_id: agentId, workspace_id: ws, role: 'worker', skill_id: null, status: 'idle' });

    const session = host.ctx.chatSession.getSession(agentId)!;
    expect(session.mode).toBe('agent');
    expect(session.title).toBe('Agent: Worker');
    expect(session.description).toBe(`工作区 ${[...ws].slice(0, 8).join('')} 的 Agent`);
    expect(session.titleLocked).toBe(true);
    expect(session.metadata).toEqual({ workspace_id: ws, role: 'worker', skill_id: null, system_prompt: 'SP',
      recommended_models: [], parent_session_id: 'owner', subagent_depth: 1 });

    await waitFor(() => host.ctx.agentWorkspace.getAgent(ws, agentId)?.status === 'completed');
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.sessionId).toBe(agentId);
    expect(request.content).toBe('[来自 owner] do it');
    expect(request.workspaceId).toBe(ws);
    const options = request.options as Record<string, unknown>;
    expect(options.systemPromptOverride).toBe('SP');
    expect(options.ragEnabled).toBe(false);
    expect(options.graphRagEnabled).toBe(false);
    expect(options.memoryEnabled).toBe(false);
    expect(options.strictModelId).toBe(false);
    expect(options.activeSkillIds).toBeNull();
    expect(options.skillContents).toBeNull();
    expect((options.mcpToolSchemas as { name: string }[]).map(schema => schema.name))
      .toEqual([]);
    expect(options.executionAllowedTools).toEqual([]);
    expect(typeof options.streamGeneration).toBe('bigint');
    expect(grantDuringRun).toEqual({ live: true });
    expect(lookupGrantForSession(agentId)).toBeNull();
    expect(host.ctx.chatState.hasActiveStream(agentId)).toBe(false);

    const task = host.ctx.agentWorkspace.getTaskManager(ws).getAgentTask(agentId);
    expect(task).toBeNull(); // completed tasks are no longer the agent's pending/running task
    const results = host.ctx.agentWorkspace.listMessages(ws, 100).filter(m => m.messageType === 'result');
    expect(results).toHaveLength(1);
    const envelope = JSON.parse(results[0]!.content);
    expect(envelope).toMatchObject({ type: 'agent_completion', workspace_id: ws, agent_session_id: agentId,
      parent_session_id: 'owner', run_id: request.assistantMessageId, status: 'completed', final_output: '' });
    expect(typeof envelope.task_id).toBe('string');
    expect(host.ctx.agentWorkspace.getTaskManager(ws).getTask(envelope.task_id)).toMatchObject({
      status: 'completed', resultSummary: 'Task completed successfully' });
    expect(host.ctx.agentCompletionOutbox.getByRunId(request.assistantMessageId!)?.state).toBe('delivered');
    expect(events('workspace_agent_completion')).toEqual([envelope]);
    expect(events('workspace_worker_ready')).toEqual([{ workspace_id: ws, agent_session_id: agentId, skill_id: null,
      run_id: request.assistantMessageId, runtime_managed: true }]);
  });

  it('pipeline failure and cancellation settle agent, task and envelope', async () => {
    const ws = await newWorkspace();
    behavior = async () => { throw new Error('boom'); };
    const failed = await host.invoke<{ agent_session_id: string }>('workspace_create_agent', { request: {
      workspace_id: ws, requester_session_id: 'owner', initial_task: 'a' } });
    await waitFor(() => host.ctx.agentWorkspace.getAgent(ws, failed.agent_session_id)?.status === 'failed');
    behavior = async () => { throw new ChatV2Error('Cancelled'); };
    const cancelled = await host.invoke<{ agent_session_id: string }>('workspace_create_agent', { request: {
      workspace_id: ws, requester_session_id: 'owner', initial_task: 'b' } });
    await waitFor(() => host.ctx.agentWorkspace.getAgent(ws, cancelled.agent_session_id)?.status === 'cancelled');
    const envelopes = events('workspace_agent_completion');
    expect(envelopes.map(e => [e.agent_session_id, e.status, e.error, 'final_output' in e])).toEqual([
      [failed.agent_session_id, 'failed', 'boom', false],
      [cancelled.agent_session_id, 'cancelled', 'execution cancelled', false],
    ]);
    const tasks = host.ctx.agentWorkspace.getTaskManager(ws);
    expect(tasks.getTask(envelopes[0]!.task_id as string)).toMatchObject({ status: 'failed', resultSummary: 'boom' });
    expect(tasks.getTask(envelopes[1]!.task_id as string)).toMatchObject({ status: 'cancelled', resultSummary: 'execution cancelled' });
  });

  it('workspace_run_agent: rejects unknown agents, coordinators and outsiders; empty inbox is idempotent idle', async () => {
    const ws = await newWorkspace();
    const run = (agent: string, requester = 'owner') => host.invoke('workspace_run_agent', { request: {
      workspace_id: ws, agent_session_id: agent, requester_session_id: requester } });
    await expect(run('missing')).rejects.toBe('Agent not found: missing');
    await expect(run('owner')).rejects.toBe('Coordinator agents cannot be auto-run, they are driven by user input');
    await expect(run('owner', 'outsider')).rejects.toEqual(expect.any(String));
    host.ctx.chatSession.createSession(newSession('worker_a', 'agent'));
    host.ctx.agentWorkspace.registerAgent(ws, 'worker_a', 'worker', null, null);
    expect(await run('worker_a')).toEqual({ agent_session_id: 'worker_a', message_id: '', status: 'idle' });
    expect(host.ctx.agentWorkspace.getAgent(ws, 'worker_a')?.status).toBe('idle');
    expect(requests).toEqual([]);
  });

  it('chatWorkerRuntime service runs workers through the same backend entry and exposes the session store', async () => {
    const ws = await newWorkspace();
    const runtime = host.ctx.chatWorkerRuntime;
    const window = { window: 'main', webview: 'main' };
    expect(runtime.isRunAvailable()).toBe(true);
    await expect(runtime.runWorkspaceAgentBackend({ workspace_id: ws, agent_session_id: 'missing',
      requester_session_id: 'owner' }, window)).rejects.toThrow('Agent not found: missing');

    runtime.sessionStore.createSession({ id: 'worker_svc', mode: 'agent', title: 'Agent: Worker', description: null,
      summary_hash: null, title_locked: true, persist_status: 'active', created_at: '2026-11-07T00:00:00Z',
      updated_at: '2026-11-07T00:00:00Z', metadata: { workspace_id: ws }, group_id: null, tags_hash: null, tags: null });
    expect(runtime.sessionStore.sessionMetadata('worker_svc')).toEqual({ workspace_id: ws });
    expect(runtime.sessionStore.sessionMetadata('nope')).toBeNull();
    expect(host.ctx.chatSession.getSession('worker_svc')).toMatchObject({ mode: 'agent', titleLocked: true });

    host.ctx.agentWorkspace.registerAgent(ws, 'worker_svc', 'worker', null, null);
    host.ctx.agentWorkspace.sendMessage(ws, 'owner', 'worker_svc', 'task', 'go');
    const run = await runtime.runWorkspaceAgentBackend({ workspace_id: ws, agent_session_id: 'worker_svc',
      requester_session_id: 'owner', reminder: null }, window);
    expect(run.status).toBe('running');
    await waitFor(() => host.ctx.agentWorkspace.getAgent(ws, 'worker_svc')?.status === 'completed');
    expect(requests.map(r => r.sessionId)).toEqual(['worker_svc']);
    expect(run.message_id).toBe(requests[0]!.assistantMessageId);
  });

  it('workspace_run_agent: active stream conflict re-enqueues drained messages', async () => {
    const ws = await newWorkspace();
    host.ctx.chatSession.createSession(newSession('worker_b', 'agent'));
    host.ctx.agentWorkspace.registerAgent(ws, 'worker_b', 'worker', null, null);
    host.ctx.agentWorkspace.sendMessage(ws, 'owner', 'worker_b', 'task', 'x');
    host.ctx.chatState.registerStream('worker_b');
    await expect(host.invoke('workspace_run_agent', { request: { workspace_id: ws, agent_session_id: 'worker_b',
      requester_session_id: 'owner' } })).rejects.toBe('Agent has an active stream. Please wait for completion.');
    expect(host.ctx.agentWorkspace.pendingInboxCount(ws, 'worker_b')).toBe(1);
    expect(requests).toEqual([]);
  });

  it('workspace_run_agent: persisted persona profile drives prompt, strict model, skills and schema injection', async () => {
    const ws = await newWorkspace('Team');
    const profile = { ...AgentProfileResolver.builtIn(EXPLORER_PROFILE_ID)!, model: 'cfg-1', skills: ['research'] };
    const metadata = AgentProfileResolver.persistIntoMetadata(undefined, profile);
    const session = newSession('worker_p', 'agent');
    session.metadata = { parent_session_id: 'owner', recommended_models: ['rec'],
      profile_skill_contents: { research: 'body', unrelated: 'x' } };
    host.ctx.chatSession.createSession(session);
    host.ctx.agentWorkspace.registerAgent(ws, 'worker_p', 'worker', null, metadata);
    host.ctx.agentWorkspace.sendMessage(ws, 'owner', 'worker_p', 'task', 'look');
    const response = await host.invoke<{ status: string; message_id: string }>('workspace_run_agent', { request: {
      workspace_id: ws, agent_session_id: 'worker_p', requester_session_id: 'owner', reminder: 'R' } });
    expect(response.status).toBe('running');
    await waitFor(() => host.ctx.agentWorkspace.getAgent(ws, 'worker_p')?.status === 'completed');
    const options = requests[0]!.options as Record<string, unknown>;
    expect(requests[0]!.content).toBe('R\n\n---\n\n[来自 owner] look');
    expect(options.modelId).toBe('cfg-1');
    expect(options.strictModelId).toBe(true);
    expect(options.reasoningEffort).toBe('high');
    expect(options.activeSkillIds).toEqual(['research']);
    expect(options.skillContents).toEqual({ research: 'body' });
    expect(options.systemPromptOverride).toContain(`# 子代理任务环境\n- 工作区名称: Team\n- 工作区 ID: ${ws}\n\n最终回答会由运行时自动交付给父代理`);
    expect((options.mcpToolSchemas as { name: string }[]).map(schema => schema.name))
      .toEqual(['builtin-web_search']);
    expect(options.executionAllowedTools).toEqual(profile.allowedTools);

    // Missing persona skill snapshot: fail-closed with drained-message rollback.
    host.ctx.chatSession.createSession(Object.assign(newSession('worker_q', 'agent'), { metadata: { parent_session_id: 'owner' } }));
    host.ctx.agentWorkspace.registerAgent(ws, 'worker_q', 'worker', null, metadata);
    host.ctx.agentWorkspace.sendMessage(ws, 'owner', 'worker_q', 'task', 'look');
    await expect(host.invoke('workspace_run_agent', { request: { workspace_id: ws, agent_session_id: 'worker_q',
      requester_session_id: 'owner' } })).rejects.toBe('Persisted persona skill snapshot is missing [research]; refusing to run with silently ignored skills');
    expect(host.ctx.agentWorkspace.pendingInboxCount(ws, 'worker_q')).toBe(1);
    expect(host.ctx.chatState.hasActiveStream('worker_q')).toBe(false);
  });

  it('workspace_restore_executions: reruns pending tasks with inbox, reports orphaned running tasks as unknown', async () => {
    const ws = await newWorkspace();
    const tasks = host.ctx.agentWorkspace.getTaskManager(ws);
    for (const id of ['worker_r', 'worker_s']) {
      host.ctx.chatSession.createSession(Object.assign(newSession(id, 'agent'), { metadata: { parent_session_id: 'owner' } }));
      host.ctx.agentWorkspace.registerAgent(ws, id, 'worker', null, null);
    }
    const { newSubagentTask } = await import('../../agent-workspace/api.ts');
    const pending = newSubagentTask(ws, 'worker_r', null, 'resume me');
    tasks.createTask(pending);
    host.ctx.agentWorkspace.sendMessage(ws, 'owner', 'worker_r', 'task', 'resume me');
    const orphan = newSubagentTask(ws, 'worker_s', null, 'lost');
    tasks.createTask(orphan);
    tasks.markRunning(orphan.id);

    const response = await host.invoke<Record<string, unknown>>('workspace_restore_executions', { sessionId: 'owner', workspaceId: ws });
    expect(response).toMatchObject({ subagent_tasks_restored: 1, restored_agent_ids: ['worker_r'],
      has_active_sleeps: false, active_sleep_ids: [] });
    expect(response.unknown_tasks).toEqual([{ task_id: orphan.id, agent_session_id: 'worker_s', skill_id: null,
      initial_task: 'lost', started_at: expect.any(String), created_at: orphan.createdAt }]);
    await waitFor(() => host.ctx.agentWorkspace.getAgent(ws, 'worker_r')?.status === 'completed');
    expect(requests.map(r => r.sessionId)).toEqual(['worker_r']);
    expect(events('workspace_worker_ready')).toEqual([{ workspace_id: ws, agent_session_id: 'worker_r', skill_id: null,
      restored: true, reminder: null, runtime_managed: true }]);
    await expect(host.invoke('workspace_restore_executions', { sessionId: 'outsider', workspaceId: ws })).rejects.toEqual(expect.any(String));
  });
});
