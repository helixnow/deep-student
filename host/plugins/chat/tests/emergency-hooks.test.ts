import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import shell from '../../../../electron/index.ts';
import { vfsStub } from './database-fixture.ts';
import type { WorkspaceAgent } from '../../agent-workspace/api.ts';

describe('kill_switch.rs complete emergency-stop side effects', () => {
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let calls: string[];
  let policy: string | null;
  let agents: WorkspaceAgent[];
  let paused: boolean;
  beforeEach(async () => {
    calls = []; policy = null; agents = []; paused = false;
    host = await createTestHost({ plugins: [shell, plugin], provide: {
      storage: {}, vfs: vfsStub, settings: { get: () => policy },
      agentAutomation: { isSchedulerPaused: () => paused, pauseScheduler() { paused = true; calls.push('pause'); },
        resumeScheduler() { paused = false; }, cancelActiveRunsForEmergencyStop() { calls.push('runs'); } },
      agentApproval: { rejectAllPending(reason: string) { calls.push(`approvals:${reason}`); return 2; } },
      agentWorkspace: { loadedWorkspaceIds: () => ['ws'], listAgents: () => agents,
        updateAgentStatus(_w: string, id: string, status: WorkspaceAgent['status']) { calls.push(`worker:${id}`); agents.find(a => a.sessionId === id)!.status = status; },
        getTaskManager: () => ({ getTasksToRestore: () => [{ id: 'task_1' }], updateStatus(id: string) { calls.push(`task:${id}`); } }),
      },
    }, shell(op) { if (op === 'plugin:notification|notify') { calls.push('notify'); return null; } throw new Error(`Unexpected shell operation: ${op}`); } });
  });
  afterEach(async () => { await host.dispose(); });
  function add(id: string, status: WorkspaceAgent['status'], role: WorkspaceAgent['role'] = 'worker') {
    agents.push({ sessionId: id, status, role, workspaceId: 'ws', skillId: null, joinedAt: '', lastActiveAt: '' });
  }
  it('emergency stop preserves hook/approval/worker/notification/event/log ordering', async () => {
    add('worker_run', 'running'); add('worker_queue', 'queued'); add('coord', 'running', 'coordinator');
    const token = host.ctx.chatState.registerStream('worker_run'); token.signal.addEventListener('abort', () => calls.push('stream'));
    const handle = host.ctx.chatSession.registerEmergencyCancelHook({ cancelForEmergencyStop(reason) { calls.push(`hook:${reason}`); return 3; } });
    host.ctx.backendEvents.listen('chat_v2://kill_switch_changed', () => calls.push('event'));
    const logs: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export(message) { if (message.type === 'warn') logs.push(String(message.args[0])); } });
    const result = await host.invoke('chat_v2_emergency_stop', { reason: ' stop ' });
    expect(result).toMatchObject({ cancelledStreams: 1, tripped: true, automationsPaused: true });
    expect(calls).toEqual(['pause', 'stream', 'runs', 'hook:stop', 'approvals:stop', 'worker:worker_run', 'worker:worker_queue', 'task:task_1', 'notify', 'event']);
    expect(agents.find(a => a.role === 'coordinator')?.status).toBe('running');
    expect(logs).toContain('[ChatV2::kill_switch] emergency_stop: newly_tripped=true, cancelled_streams=1, rejected_approvals=2, cancelled_workers=2, cancelled_chatanki_pipelines=3, reason=stop');
    handle.dispose(); calls.length = 0;
    await host.invoke('chat_v2_emergency_stop', { reason: 'again' });
    expect(calls).toEqual(['pause', 'runs', 'approvals:again', 'task:task_1', 'event']);
  });
  it('parses_policy_with_background_default', () => {
    for (const [raw, expected] of [['always', 'always'], ['never', 'never'], ['background', 'background'], ['sometimes', 'background'], [null, 'background']] as const) {
      policy = raw; expect(host.ctx.systemNotification.policy()).toBe(expected);
    }
  });
  it('never notification policy logs suppression and does not call the OS channel', async () => {
    policy = 'never'; const logs: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export(message) { if (message.type === 'info') logs.push(String(message.args[0])); } });
    await host.invoke('chat_v2_emergency_stop', {});
    expect(calls).not.toContain('notify');
    expect(logs).toContain('[ChatV2::kill_switch] system notifications disabled by policy; skipped emergency notification');
  });
  it('trip_pauses_automation_dispatch_gate', async () => {
    expect(paused).toBe(false); await host.invoke('chat_v2_emergency_stop', { reason: 'automation_gate' });
    expect(paused).toBe(true); await host.invoke('chat_v2_resume_agents');
    expect(() => host.ctx.chatState.killSwitch.ensureAllowed()).not.toThrow(); expect(paused).toBe(true);
    await host.invoke('chat_v2_resume_automations'); expect(paused).toBe(false);
  });
});
