import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { ChatV2State, KILL_SWITCH_CHANGED_EVENT } from '../api.ts';
import type { KillSwitchStatus } from '../api.ts';
import { emergencyStop, resumeAgents, resumeAutomations } from '../src/kill-switch.ts';
import type { AutomationSchedulerLike } from '../src/kill-switch.ts';

/** Records the calls the Rust kill switch makes on the L06 scheduler. */
function fakeScheduler(paused = false): AutomationSchedulerLike & { calls: string[] } {
  const calls: string[] = [];
  let isPaused = paused;
  return {
    calls,
    isSchedulerPaused: () => isPaused,
    pauseScheduler: () => { isPaused = true; calls.push('pause'); },
    resumeScheduler: () => { isPaused = false; calls.push('resume'); },
    cancelActiveRunsForEmergencyStop: () => { calls.push('cancel-runs'); },
  };
}

describe('chat_v2 kill switch commands', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeEach(async () => {
    f = databaseFixture();
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });

  it('kill_switch_status reports an untripped switch with no automation scheduler', async () => {
    const status = await host.invoke<KillSwitchStatus>('chat_v2_kill_switch_status');
    expect(status).toEqual({
      tripped: false, killSwitchTripped: false, trippedAtMs: null, reason: null,
      automationsPaused: false,
    });
  });

  it('emergency_stop trips, cancels every stream, pauses automations and emits status', async () => {
    const state = host.ctx.get('chatState') as ChatV2State;
    const tokenA = state.registerStream('sess_a');
    const tokenB = state.registerStream('sess_b');
    const scheduler = fakeScheduler(false);

    const status = emergencyStop(state, scheduler, '  disk full  ');

    expect(status.tripped).toBe(true);
    expect(status.killSwitchTripped).toBe(true);
    expect(status.reason).toBe('disk full');
    expect(status.automationsPaused).toBe(true);
    expect(status.cancelledStreams).toBe(2);
    expect(tokenA.signal.aborted).toBe(true);
    expect(tokenB.signal.aborted).toBe(true);
    expect(scheduler.calls).toEqual(['pause', 'cancel-runs']);
    expect(state.hasActiveStream('sess_a')).toBe(false);
  });

  it('emergency_stop falls back to the default reason and omits zero cancelledStreams', () => {
    const state = new ChatV2State();
    const status = emergencyStop(state, undefined, '   ');
    expect(status.reason).toBe('user_emergency_stop');
    expect(status.cancelledStreams).toBeUndefined();
    // serde `skip_serializing_if = "is_zero"` keeps the key out of the wire payload.
    expect('cancelledStreams' in status).toBe(false);
    expect(JSON.parse(JSON.stringify(status))).not.toHaveProperty('cancelledStreams');
  });

  it('emergency_stop command emits chat_v2://kill_switch_changed with the returned status', async () => {
    const state = host.ctx.get('chatState') as ChatV2State;
    state.registerStream('sess_stream');
    const status = await host.invoke<KillSwitchStatus>('chat_v2_emergency_stop', {
      reason: 'unit test',
    });
    expect(status.tripped).toBe(true);
    expect(status.cancelledStreams).toBe(1);
    expect(host.eventsNamed(KILL_SWITCH_CHANGED_EVENT)).toEqual([status]);
  });

  it('resume_agents resets the trip but keeps automations paused', () => {
    const state = new ChatV2State();
    const scheduler = fakeScheduler(false);
    emergencyStop(state, scheduler, 'test');
    scheduler.calls.length = 0;

    const status = resumeAgents(state, scheduler);

    expect(status.tripped).toBe(false);
    expect(status.reason).toBeNull();
    expect(status.trippedAtMs).toBeNull();
    expect(status.automationsPaused).toBe(true);
    expect(scheduler.calls).toEqual([]);
  });

  it('resume_automations refuses while tripped and resumes after resume_agents', () => {
    const state = new ChatV2State();
    const scheduler = fakeScheduler(false);
    emergencyStop(state, scheduler, 'test');
    scheduler.calls.length = 0;

    expect(() => resumeAutomations(state, scheduler)).toThrow(
      'Cannot resume automations while AgentKillSwitch is still tripped. Call chat_v2_resume_agents first.');
    expect(scheduler.calls).toEqual([]);

    resumeAgents(state, scheduler);
    const status = resumeAutomations(state, scheduler);
    expect(status).toMatchObject({ tripped: false, automationsPaused: false });
    expect(scheduler.calls).toEqual(['resume']);
  });

  it('resume_automations command surfaces the raw string error while tripped', async () => {
    await host.invoke('chat_v2_emergency_stop', {});
    await expect(host.invoke('chat_v2_resume_automations')).rejects.toBe(
      'Cannot resume automations while AgentKillSwitch is still tripped. Call chat_v2_resume_agents first.');

    const resumed = await host.invoke<KillSwitchStatus>('chat_v2_resume_agents');
    expect(resumed.tripped).toBe(false);
    await expect(host.invoke('chat_v2_resume_automations')).resolves.toMatchObject({
      tripped: false, automationsPaused: false,
    });
  });
});
