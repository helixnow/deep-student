import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { vfsStub } from './database-fixture.ts';
import type { WorkspaceRuntimeTaskManager, WorkspaceWakeInfo } from '../api.ts';
import type { WorkspaceAgent } from '../../agent-workspace/api.ts';

describe('workspace cancellation and sleep command ordering', () => {
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let agents: WorkspaceAgent[];
  let calls: unknown[][];
  let failures: Set<string>;
  let wake: WorkspaceWakeInfo | null;
  let taskPresent: boolean;
  const logs: { level: string; message: string }[] = [];
  beforeEach(async () => {
    agents = []; calls = []; failures = new Set(); wake = null; taskPresent = true; logs.length = 0;
    const taskManager: WorkspaceRuntimeTaskManager = {
      getTasksToRestore() { calls.push(['tasks']); if (failures.has('tasks')) throw Object.assign(new Error('Database error: tasks broken'), { kind: 'database', detail: 'tasks broken' }); return [{ id: 'task_1' }, { id: 'task_2' }]; },
      getAgentTask(id) { calls.push(['task', id]); if (failures.has('task')) throw Object.assign(new Error('Database error: query broken'), { kind: 'database', detail: 'query broken' }); return taskPresent ? { id: 'task_1' } : null; },
      updateStatus(id, status, reason) { calls.push(['task-status', id, status, reason]); if (failures.has(id)) throw Object.assign(new Error('Database error: write broken'), { kind: 'database', detail: 'write broken' }); },
    };
    const coordinator = {
      getWorkspace(id: string) { calls.push(['workspace', id]); return id === 'missing' ? null : { id, creatorSessionId: 'owner' }; },
      ensureMemberOrCreator(w: string, s: string) { calls.push(['member', w, s]); if (s === 'outsider') throw new Error('access denied'); },
      listAgents() { calls.push(['agents']); if (failures.has('agents')) throw new Error('agents broken'); return agents; },
      updateAgentStatus(w: string, a: string, status: string) { calls.push(['agent-status', w, a, status]); if (failures.has('agent-status')) throw new Error('status broken'); },
      closeWorkspace(w: string) { calls.push(['close', w]); if (failures.has('close')) throw new Error('close broken'); },
      deleteWorkspace(w: string) { calls.push(['delete', w]); },
      getTaskManager() { calls.push(['task-manager']); if (failures.has('task-manager')) throw new Error('manager broken'); return taskManager; },
      getSleepManager() { calls.push(['sleep-manager']); if (failures.has('sleep-manager')) throw new Error('sleep manager broken'); return {
        manualWake(id: string, message: string | null) { calls.push(['wake', id, message]); if (failures.has('wake')) throw Object.assign(new Error(`Sleep not found: ${id}`), { kind: 'not_found' }); return wake; },
        cancel(id: string) { calls.push(['cancel-sleep', id]); if (failures.has('cancel-sleep')) throw Object.assign(new Error('Database error: locked'), { kind: 'database' }); return true; },
      }; },
      emitWarning(value: unknown) { calls.push(['warning', value]); },
      emitCoordinatorAwakened(value: WorkspaceWakeInfo) { calls.push(['awakened', value]); },
    };
    host = await createTestHost({ plugins: [plugin], provide: { storage: {}, vfs: vfsStub, agentWorkspace: coordinator } });
    host.ctx.logger.exporter({ levels: { default: 4 }, export(message) { logs.push({ level: message.type, message: String(message.args[0]) }); } });
  });
  afterEach(async () => { await host.dispose(); });
  function agent(id: string, status: WorkspaceAgent['status'], role: WorkspaceAgent['role'] = 'worker') {
    agents.push({ sessionId: id, status, role, workspaceId: 'ws', skillId: null, joinedAt: '', lastActiveAt: '' });
  }
  it('close/delete reject missing workspace and non-creators before cancellation', async () => {
    const stream = host.ctx.chatState.registerStream('agent');
    await expect(host.invoke('workspace_close', { sessionId: 'owner', workspaceId: 'missing' })).rejects.toBe('Workspace not found: missing');
    await expect(host.invoke('workspace_delete', { sessionId: 'other', workspaceId: 'ws' })).rejects.toBe('Permission denied: only workspace creator can perform this action');
    expect(calls).toEqual([['workspace', 'missing'], ['workspace', 'ws']]); expect(stream.signal.aborted).toBe(false);
  });
  it('close cancels worker streams and tasks before closing; nonrunning idle workers stay unchanged', async () => {
    agent('running', 'running'); agent('idle_stream', 'idle'); agent('idle', 'idle'); agent('owner', 'running', 'coordinator');
    const stream = host.ctx.chatState.registerStream('idle_stream'); const owner = host.ctx.chatState.registerStream('owner');
    expect(await host.invoke('workspace_close', { sessionId: 'owner', workspaceId: 'ws' })).toBeNull();
    expect(stream.signal.aborted).toBe(true); expect(owner.signal.aborted).toBe(false);
    expect(calls).toEqual([['workspace', 'ws'], ['agents'], ['agent-status', 'ws', 'running', 'cancelled'],
      ['agent-status', 'ws', 'idle_stream', 'cancelled'], ['task-manager'], ['tasks'],
      ['task-status', 'task_1', 'cancelled', 'workspace closed'], ['task-status', 'task_2', 'cancelled', 'workspace closed'], ['close', 'ws']]);
    expect(logs).toContainEqual({ level: 'info', message: '[Workspace::handlers] Cancelled worker on workspace closed: agent=running, had_stream=false' });
  });
  it('delete continues after agent enumeration and individual task failures', async () => {
    failures.add('agents'); failures.add('task_1');
    expect(await host.invoke('workspace_delete', { sessionId: 'owner', workspaceId: 'ws' })).toBeNull();
    expect(calls.at(-1)).toEqual(['delete', 'ws']);
    expect(calls).toContainEqual(['task-status', 'task_2', 'cancelled', 'workspace deleted']);
    expect(logs).toContainEqual({ level: 'warn', message: '[Workspace::handlers] Failed to list agents for cancel propagation (workspace deleted): agents broken' });
    expect(logs).toContainEqual({ level: 'warn', message: '[Workspace::handlers] Failed to cancel task task_1 on workspace deleted: Database("write broken")' });
  });
  it('close failure does not roll back earlier cancellation; ignored status failure still logs worker cancellation', async () => {
    agent('worker', 'running'); const token = host.ctx.chatState.registerStream('worker');
    failures.add('agent-status'); failures.add('task-manager'); failures.add('close');
    await expect(host.invoke('workspace_close', { sessionId: 'owner', workspaceId: 'ws' })).rejects.toBe('close broken');
    expect(token.signal.aborted).toBe(true);
    expect(logs).toContainEqual({ level: 'info', message: '[Workspace::handlers] Cancelled worker on workspace closed: agent=worker, had_stream=true' });
    expect(logs).toContainEqual({ level: 'warn', message: '[Workspace::handlers] Failed to get task manager for cancel propagation (workspace closed): manager broken' });
  });
  it('cancel_agent authorizes first, persists cancellation and emits the Rust warning payload', async () => {
    const token = host.ctx.chatState.registerStream('worker');
    await expect(host.invoke('workspace_cancel_agent', { sessionId: 'outsider', workspaceId: 'ws', agentSessionId: 'worker' })).rejects.toBe('access denied');
    expect(token.signal.aborted).toBe(false); calls.length = 0;
    expect(await host.invoke('workspace_cancel_agent', { sessionId: 'owner', workspaceId: 'ws', agentSessionId: 'worker' })).toBe(true);
    expect(token.signal.aborted).toBe(true);
    expect(calls).toEqual([['member', 'ws', 'owner'], ['task-manager'], ['task', 'worker'],
      ['task-status', 'task_1', 'cancelled', 'user cancelled'], ['agent-status', 'ws', 'worker', 'cancelled'],
      ['warning', { workspace_id: 'ws', code: 'agent_cancelled', message: 'Agent worker execution cancelled by user',
        agent_session_id: 'worker', message_id: null, retry_count: null, max_retries: null }]]);
  });
  it('chatWorkerRuntime.cancelWorkspaceAgentBackend is the trusted entry: no membership check, same cancellation', async () => {
    const token = host.ctx.chatState.registerStream('worker');
    await expect(host.ctx.chatWorkerRuntime.cancelWorkspaceAgentBackend('ws', 'worker')).resolves.toBeUndefined();
    expect(token.signal.aborted).toBe(true);
    expect(calls).toEqual([['task-manager'], ['task', 'worker'],
      ['task-status', 'task_1', 'cancelled', 'user cancelled'], ['agent-status', 'ws', 'worker', 'cancelled'],
      ['warning', { workspace_id: 'ws', code: 'agent_cancelled', message: 'Agent worker execution cancelled by user',
        agent_session_id: 'worker', message_id: null, retry_count: null, max_retries: null }]]);
  });
  it('chatWorkerRuntime.runWorkspaceAgentBackend fails closed until the pipeline runtime is bound', async () => {
    expect(host.ctx.chatWorkerRuntime.isRunAvailable()).toBe(false);
    await expect(host.ctx.chatWorkerRuntime.runWorkspaceAgentBackend({ workspace_id: 'ws', agent_session_id: 'worker',
      requester_session_id: 'owner' }, { window: 'main', webview: 'main' }))
      .rejects.toThrow('Worker runtime is not available: chat pipeline execute or workspace surfaces missing');
    expect(calls).toEqual([]);
  });
  it('cancel_agent returns false for no stream or task, and task errors only warn', async () => {
    taskPresent = false;
    expect(await host.invoke('workspace_cancel_agent', { sessionId: 'owner', workspaceId: 'ws', agentSessionId: 'worker' })).toBe(false);
    expect(calls.some(row => row[0] === 'warning')).toBe(false);
    failures.add('task'); calls.length = 0;
    expect(await host.invoke('workspace_cancel_agent', { sessionId: 'owner', workspaceId: 'ws', agentSessionId: 'worker' })).toBe(false);
    expect(logs).toContainEqual({ level: 'warn', message: '[Workspace::handlers] Failed to query task for cancel: agent=worker, error=Database("query broken")' });
  });
  it('manual_wake emits only after a successful wake and retains nullable user message', async () => {
    const request = { workspace_id: 'ws', requester_session_id: 'owner', sleep_id: 'sleep' };
    expect(await host.invoke('workspace_manual_wake', { request })).toEqual({ success: false, sleep_id: 'sleep' });
    expect(calls).toEqual([['member', 'ws', 'owner'], ['sleep-manager'], ['wake', 'sleep', null]]);
    wake = { sleepId: 'sleep', workspaceId: 'ws', coordinatorSessionId: 'owner', awakenedBy: 'user', awakenMessage: 'go', wakeReason: 'manual' };
    calls.length = 0;
    expect(await host.invoke('workspace_manual_wake', { request: { ...request, message: 'go' } })).toEqual({ success: true, sleep_id: 'sleep' });
    expect(calls.at(-1)).toEqual(['awakened', wake]);
    expect(logs).toContainEqual({ level: 'info', message: '[Workspace::handlers] Manual wake: sleep_id=sleep, success=true' });
  });
  it('sleep errors preserve Debug variants and manager acquisition preserves Display', async () => {
    failures.add('wake');
    await expect(host.invoke('workspace_manual_wake', { request: { workspace_id: 'ws', requester_session_id: 'owner', sleep_id: 'sleep' } }))
      .rejects.toBe('Failed to wake: NotFound("sleep")');
    failures.add('cancel-sleep');
    await expect(host.invoke('workspace_cancel_sleep', { sessionId: 'owner', workspaceId: 'ws', sleepId: 'sleep' }))
      .rejects.toBe('Failed to cancel sleep: Database("locked")');
    failures.add('sleep-manager');
    await expect(host.invoke('workspace_cancel_sleep', { sessionId: 'owner', workspaceId: 'ws', sleepId: 'sleep' })).rejects.toBe('sleep manager broken');
    expect(logs).toEqual([]);
  });
  it('cancel_sleep returns the manager boolean and logs after cancellation', async () => {
    expect(await host.invoke('workspace_cancel_sleep', { sessionId: 'owner', workspaceId: 'ws', sleepId: 'sleep' })).toBe(true);
    expect(calls).toEqual([['member', 'ws', 'owner'], ['sleep-manager'], ['cancel-sleep', 'sleep']]);
    expect(logs).toEqual([{ level: 'info', message: '[Workspace::handlers] Cancel sleep: sleep_id=sleep, cancelled=true' }]);
  });
});
