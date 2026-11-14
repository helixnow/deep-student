import { describe, expect, it } from 'vitest';
import { ChatV2State, StreamGuard, AgentKillSwitch, KILL_SWITCH_BLOCKED_MESSAGE } from '../api.ts';

describe('chat_v2/state.rs', () => {
  it('test_register_and_cancel_stream', () => {
    const state = new ChatV2State();
    const token = state.registerStream('sess_123');
    expect(token.signal.aborted).toBe(false);
    expect(state.hasActiveStream('sess_123')).toBe(true);
    expect(state.cancelStream('sess_123')).toBe(true);
    expect(token.signal.aborted).toBe(true);
    expect(state.hasActiveStream('sess_123')).toBe(false);
  });
  it('test_cancel_nonexistent_stream', () => {
    expect(new ChatV2State().cancelStream('sess_nonexistent')).toBe(false);
  });
  it('test_remove_stream', () => {
    const state = new ChatV2State();
    const token = state.registerStream('sess_456');
    state.removeStream('sess_456');
    expect(token.signal.aborted).toBe(false);
    expect(state.hasActiveStream('sess_456')).toBe(false);
  });
  it('test_active_stream_count', () => {
    const state = new ChatV2State();
    expect(state.activeStreamCount()).toBe(0);
    state.registerStream('sess_1');
    expect(state.activeStreamCount()).toBe(1);
    state.registerStream('sess_2');
    expect(state.activeStreamCount()).toBe(2);
    state.cancelStream('sess_1');
    expect(state.activeStreamCount()).toBe(1);
    state.removeStream('sess_2');
    expect(state.activeStreamCount()).toBe(0);
  });
  it('test_try_register_stream_success', () => {
    const state = new ChatV2State();
    expect(state.tryRegisterStream('sess_atomic')).not.toBeNull();
    expect(state.hasActiveStream('sess_atomic')).toBe(true);
  });
  it('test_try_register_stream_reject_duplicate', () => {
    const state = new ChatV2State();
    expect(state.tryRegisterStream('sess_dup')).not.toBeNull();
    expect(state.tryRegisterStream('sess_dup')).toBeNull();
  });
  it('test_stream_guard_cleanup_on_normal_drop', () => {
    const state = new ChatV2State();
    const registration = state.tryRegisterStreamOwned('sess_guard_1')!;
    expect(state.hasActiveStream('sess_guard_1')).toBe(true);
    new StreamGuard(state, 'sess_guard_1', registration).dispose();
    expect(state.hasActiveStream('sess_guard_1')).toBe(false);
  });
  it('test_stream_guard_idempotent_double_cleanup', () => {
    const state = new ChatV2State();
    const guard = new StreamGuard(state, 'sess_guard_2', state.tryRegisterStreamOwned('sess_guard_2')!);
    state.removeStream('sess_guard_2');
    expect(state.hasActiveStream('sess_guard_2')).toBe(false);
    guard.dispose();
    expect(state.hasActiveStream('sess_guard_2')).toBe(false);
  });
  it('test_stream_guard_cleanup_on_panic', () => {
    const state = new ChatV2State();
    const registration = state.tryRegisterStreamOwned('sess_guard_panic')!;
    expect(state.hasActiveStream('sess_guard_panic')).toBe(true);
    expect(() => {
      const guard = new StreamGuard(state, 'sess_guard_panic', registration);
      try { throw new Error('simulated panic inside spawned task'); }
      finally { guard.dispose(); }
    }).toThrow('simulated panic inside spawned task');
    expect(state.hasActiveStream('sess_guard_panic')).toBe(false);
  });
  it('stale_guard_cannot_remove_immediate_retry_generation', () => {
    const state = new ChatV2State();
    const old = state.tryRegisterStreamOwned('sess_retry')!;
    const guard = new StreamGuard(state, 'sess_retry', old);
    expect(state.cancelStream('sess_retry')).toBe(true);
    const retry = state.tryRegisterStreamOwned('sess_retry')!;
    expect(retry.generation).not.toBe(old.generation);
    guard.dispose();
    expect(state.hasActiveStream('sess_retry')).toBe(true);
    expect(state.removeStreamIfGeneration('sess_retry', retry.generation)).toBe(true);
  });
  it('stale_guard_cannot_remove_replacement_after_early_cleanup', () => {
    const state = new ChatV2State();
    const old = state.tryRegisterStreamOwned('sess_early_error')!;
    const guard = new StreamGuard(state, 'sess_early_error', old);
    state.removeStream('sess_early_error');
    const replacement = state.tryRegisterStreamOwned('sess_early_error')!;
    guard.dispose();
    expect(state.hasActiveStream('sess_early_error')).toBe(true);
    expect(state.removeStreamIfGeneration('sess_early_error', replacement.generation)).toBe(true);
  });
  it('stale_variant_child_guard_cannot_remove_retry_token', () => {
    const state = new ChatV2State();
    const key = 'sess_retry:variant_reused';
    const old = state.registerExistingTokenOwned(key, new AbortController());
    const guard = new StreamGuard(state, key, old);
    expect(state.cancelStream(key)).toBe(true);
    const retryToken = new AbortController();
    const retry = state.registerExistingTokenOwned(key, retryToken);
    expect(retry.generation).not.toBe(old.generation);
    guard.dispose();
    expect(state.hasActiveStream(key)).toBe(true);
    expect(retryToken.signal.aborted).toBe(false);
    expect(state.removeStreamIfGeneration(key, retry.generation)).toBe(true);
  });
  it('tracked tasks drain after close and timeout leaves unfinished tasks tracked', async () => {
    const state = new ChatV2State();
    let finish!: () => void;
    const task = state.spawnTracked(new Promise<void>(resolve => { finish = resolve; }));
    expect(state.trackedTaskCount()).toBe(1);
    expect(await state.shutdownTasks(1)).toBe(false);
    expect(state.trackedTaskCount()).toBe(1);
    finish();
    await task;
    expect(await state.shutdownTasks(100)).toBe(true);
  });
});

describe('chat_v2/kill_switch.rs core', () => {
  it('trip_rejects_register_stream', () => {
    const state = new ChatV2State();
    expect(state.tryRegisterStream('sess_ks_1')).not.toBeNull();
    state.removeStream('sess_ks_1');
    expect(state.killSwitch.trip('unit_test')).toBe(true);
    expect(state.tryRegisterStream('sess_ks_2')).toBeNull();
    expect(state.hasActiveStream('sess_ks_2')).toBe(false);
    expect(() => state.killSwitch.ensureAllowed()).toThrow();
  });
  it('trip_blocks_headless_admission_with_explicit_error', () => {
    const state = new ChatV2State();
    state.killSwitch.trip('headless_gate');
    expect(() => state.killSwitch.ensureAllowed()).toThrow(KILL_SWITCH_BLOCKED_MESSAGE);
    expect(KILL_SWITCH_BLOCKED_MESSAGE).toContain('AgentKillSwitch');
  });
  it('cancel_all_streams_cancels_active_tokens', () => {
    const state = new ChatV2State();
    const a = state.tryRegisterStream('sess_a')!;
    const b = state.tryRegisterStream('sess_b')!;
    expect(state.cancelAllStreams()).toBe(2);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(state.activeStreamCount()).toBe(0);
  });
  it('status_snapshot_reports_trip_metadata', () => {
    const ks = new AgentKillSwitch();
    expect(ks.statusSnapshot(false).tripped).toBe(false);
    ks.trip('reason-x');
    const status = ks.statusSnapshot(false);
    expect(status.tripped).toBe(true);
    expect(status.killSwitchTripped).toBe(status.tripped);
    expect(status.reason).toBe('reason-x');
    expect(status.trippedAtMs).not.toBeNull();
    ks.reset();
    const cleared = ks.statusSnapshot(false);
    expect(cleared.tripped).toBe(false);
    expect(cleared.killSwitchTripped).toBe(false);
    expect(cleared.reason).toBeNull();
  });
  it('status_serializes_independent_pause_and_trip_fields', () => {
    const ks = new AgentKillSwitch();
    ks.trip('serde-check');
    const json = JSON.parse(JSON.stringify(ks.statusSnapshot(false)));
    expect(json.killSwitchTripped).toBe(true);
    expect(json).toHaveProperty('automationsPaused');
    ks.reset();
  });
});
