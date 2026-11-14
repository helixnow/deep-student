import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService, type StorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import {
  claimScheduledRun, completeRun, insertAutomation, listAutomationRuns,
  setRunDeliveryMarker, type AutomationDefinition,
} from '../repository/automations.ts';
import {
  AutomationSchedulerState, type AutomationDispatchPort, type AutomationLog, runAutomationNow, tickAutomations,
} from '../src/automation-runtime.ts';
import { formatTimestampMillis, type AutomationSchedule } from '../src/automation-schedule.ts';

let cleanup: (() => Promise<void>) | null = null;
let scheduler = new AutomationSchedulerState();

async function fixture(): Promise<{ db: DatabaseHandle; storage: StorageService }> {
  const host = await createTestHost();
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  const db = storage.database('mistakes');
  for (const name of ['V20260714__automation_scheduler.sql', 'V20260715__harden_automation_runtime.sql', 'V20260721__trusted_automation_profile.sql']) {
    db.exec(readFileSync(new URL(`../../../../resources/app/migrations/mistakes/${name}`, import.meta.url), 'utf8'));
  }
  cleanup = async () => { storage.dispose(); await host.dispose(); };
  return { db, storage };
}

afterEach(async () => {
  scheduler = new AutomationSchedulerState();
  await cleanup?.();
  cleanup = null;
});

const silentLog: AutomationLog = { info: () => {}, warn: () => {}, error: () => {} };

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition was not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function schedule(kind: AutomationSchedule['kind'], time: string, overrides: Partial<AutomationSchedule> = {}): AutomationSchedule {
  return { kind, time, weekday: null, weekdays: null, day_of_month: null,
    interval_minutes: null, date: null, timezone: null, ...overrides };
}

function sampleDaily(time: string, overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'auto_test', name: 'Daily review', schedule: schedule('daily', time),
    prompt: 'Summarize mistakes', enabled: true, created_at: formatTimestampMillis(Date.now()),
    session_id: '', last_run_at: null, next_run_at: null,
    action_type: 'notify', heartbeat: false, agent_prompt: null, session_mode: null,
    model_id: null, agent_session_id: null, catch_up_policy: 'run_once',
    max_retries: 0, retry_backoff_seconds: 60, timeout_seconds: 600,
    trusted_profile: null, version: 1, ...overrides,
  };
}

function port(overrides: Partial<AutomationDispatchPort> = {}): AutomationDispatchPort & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    ensureKillSwitchAllowed: () => {},
    emitChanged: (action: string, automationId: string) => { events.push(`${action}:${automationId}`); },
    notificationLanguage: () => 'zh',
    runHeadlessTurn: async () => ({
      sessionId: 'sess_test', assistantMessageId: 'msg_test', status: 'completed',
      summary: 'done', durationMs: 1,
    }),
    deliverNotify: async () => ({ delivered: [] }),
    sendRunNotification: async () => ({ handled: true, deliveredOs: false }),
    deliverPendingNotifications: async () => 0,
    emitRunCompleted: (payload) => { events.push(`completed:${payload.status}:${payload.runId}`); },
    ...overrides,
  };
}

describe('automations.rs scheduler tick and run_now', () => {
  it('tick_claims_due_automation_and_dispatches_it_once', async () => {
    const { db } = await fixture();
    const due = formatTimestampMillis(Date.now() - 60_000);
    insertAutomation(db, sampleDaily('09:00', { next_run_at: due }));
    const calls: string[] = [];
    const dispatch = port({
      deliverNotify: async (claimed) => {
        calls.push(claimed.run_id);
        setRunDeliveryMarker(db, claimed.run_id, claimed.attempt, 'running', 'notification', true);
        setRunDeliveryMarker(db, claimed.run_id, claimed.attempt, 'running', 'todo', true);
        return { delivered: ['notification', 'todo'] };
      },
    });
    const deps = { db, dispatch, log: silentLog, now: () => Date.now(), scheduler };

    await tickAutomations(deps);
    await tickAutomations(deps);

    expect(calls).toHaveLength(1);
    const runs = listAutomationRuns(db, 'auto_test', 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('success');
    expect(JSON.parse(String(db.pluck('SELECT delivered_json FROM automation_runs WHERE id = ?1', [runs[0]!.id]))))
      .toEqual(['notification', 'todo']);
    expect(dispatch.events).toContain('run_completed:auto_test');
  });

  it('catch_up_skip_marks_missed_slot_skipped_without_dispatch', async () => {
    const { db } = await fixture();
    const stale = formatTimestampMillis(Date.now() - 10 * 60_000);
    insertAutomation(db, sampleDaily('09:00', { catch_up_policy: 'skip', next_run_at: stale }));
    let dispatched = 0;
    const deps = {
      db, dispatch: port({ deliverNotify: async () => { dispatched += 1; return { delivered: [] }; } }),
      log: silentLog, now: () => Date.now(), scheduler,
    };

    await tickAutomations(deps);

    expect(dispatched).toBe(0);
    expect(listAutomationRuns(db, 'auto_test', 10)[0]!.status).toBe('skipped');
    expect(listAutomationRuns(db, 'auto_test', 10)[0]!.summary)
      .toBe('Skipped by catch-up policy after the app was unavailable');
  });

  it('kill_switch_block_cancels_claimed_run_with_rust_message', async () => {
    const { db } = await fixture();
    const due = formatTimestampMillis(Date.now() - 60_000);
    insertAutomation(db, sampleDaily('09:00', { next_run_at: due }));
    const deps = {
      db,
      dispatch: port({ ensureKillSwitchAllowed: () => { throw new Error('kill switch tripped'); } }),
      log: silentLog,
      now: () => Date.now(), scheduler,
    };

    await tickAutomations(deps);

    const run = listAutomationRuns(db, 'auto_test', 10)[0]!;
    expect(run.status).toBe('cancelled');
    expect(run.summary).toBe('Skipped: AgentKillSwitch / automation scheduler paused');
    expect(deps.dispatch.events).toContain('run_cancelled:auto_test');
  });

  it('paused_scheduler_skips_tick_and_rejects_run_now', async () => {
    const { db } = await fixture();
    const due = formatTimestampMillis(Date.now() - 60_000);
    insertAutomation(db, sampleDaily('09:00', { next_run_at: due }));
    let dispatched = 0;
    const deps = {
      db, dispatch: port({ deliverNotify: async () => { dispatched += 1; return { delivered: [] }; } }),
      log: silentLog, now: () => Date.now(), scheduler,
    };

    scheduler.pause();
    await tickAutomations(deps);
    expect(dispatched).toBe(0);
    expect(listAutomationRuns(db, 'auto_test', 10)).toEqual([]);
    expect(() => runAutomationNow(deps, 'auto_test', 1))
      .toThrow('Automation dispatch is paused (AgentKillSwitch / scheduler pause). Resume agents and automations first.');
    scheduler.resume();
    await tickAutomations(deps);
    expect(dispatched).toBe(1);
  });

  it('retrying_run_is_claimed_and_dispatched_on_tick', async () => {
    const { db } = await fixture();
    const due = formatTimestampMillis(Date.now() - 60_000);
    insertAutomation(db, sampleDaily('09:00', { next_run_at: due }));
    const claimed = claimScheduledRun(db, 'auto_test', due, Date.now())!;
    expect(claimed).not.toBeNull();
    // 让该 run 进入到期重试态。
    db.run(`UPDATE automation_runs SET status = 'retrying', next_attempt_at = ?2, finished_at = NULL
      WHERE id = ?1`, [claimed.run_id, formatTimestampMillis(Date.now() - 1000)]);
    let retried: string | null = null;
    const deps = {
      db,
      dispatch: port({ deliverNotify: async (run) => { retried = run.run_id; return { delivered: [] }; } }),
      log: silentLog,
      now: () => Date.now(), scheduler,
    };

    await tickAutomations(deps);

    expect(retried).toBe(claimed.run_id);
    expect(listAutomationRuns(db, 'auto_test', 10)[0]!.trigger_type).toBe('retry');
  });

  it('run_now_notify_starts_a_manual_run_and_rejects_stale_version', async () => {
    const { db } = await fixture();
    insertAutomation(db, sampleDaily('09:00'));
    const dispatched: string[] = [];
    const deps = {
      db,
      dispatch: port({
        deliverNotify: async (claimed) => {
          dispatched.push(claimed.run_id);
          setRunDeliveryMarker(db, claimed.run_id, claimed.attempt, 'running', 'notification', true);
          setRunDeliveryMarker(db, claimed.run_id, claimed.attempt, 'running', 'todo', true);
          return { delivered: ['notification', 'todo'] };
        },
      }),
      log: silentLog,
      now: () => Date.now(), scheduler,
    };

    const result = runAutomationNow(deps, 'auto_test', 1);
    expect(result.status).toBe('started');
    expect(result.automationId).toBe('auto_test');
    expect(typeof result.runId).toBe('string');
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatched).toEqual([result.runId]);
    expect(listAutomationRuns(db, 'auto_test', 10)[0]!.trigger_type).toBe('manual');
    expect(() => runAutomationNow(deps, 'auto_test', 9))
      .toThrow('Automation changed after it was read. Refresh the automation list and retry with the current version.');
    expect(() => runAutomationNow(deps, 'absent', 1)).toThrow("Automation 'absent' not found");
  });

  it('agent_turn_run_now_is_single_flight', async () => {
    const { db } = await fixture();
    insertAutomation(db, sampleDaily('09:00', { action_type: 'agent_turn' }));
    let started = 0;
    let finish: () => void = () => {};
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const deps = {
      db,
      dispatch: port({ runHeadlessTurn: async () => {
        started += 1;
        await gate;
        return {
          sessionId: 'sess_turn', assistantMessageId: 'msg_turn', status: 'completed',
          summary: 'ok', durationMs: 1,
        };
      } }),
      log: silentLog,
      now: () => Date.now(), scheduler,
    };

    const first = runAutomationNow(deps, 'auto_test', 1);
    expect(first.status).toBe('started');
    expect(first.timeoutSecs).toBe(600);
    await waitFor(() => started === 1);
    expect(() => runAutomationNow(deps, 'auto_test', 1))
      .toThrow("Automation 'auto_test' is already running (single-flight)");
    finish();
    await waitFor(() => listAutomationRuns(db, 'auto_test', 10).some((run) => run.status === 'success'));
    // 释放后可以再次手动运行。
    expect(() => runAutomationNow(deps, 'auto_test', 1)).not.toThrow();
  });

  it('agent_turn_completion_persists_named_session_and_emits_run_completed', async () => {
    const { db } = await fixture();
    insertAutomation(db, sampleDaily('09:00', {
      action_type: 'agent_turn', agent_prompt: '  inspect mistakes  ',
      session_mode: 'named', agent_session_id: null,
    }));
    const notifications: Array<Record<string, unknown>> = [];
    const completed: Array<Record<string, unknown>> = [];
    const deps = {
      db,
      dispatch: port({
        runHeadlessTurn: async (request) => {
          expect(request.prompt).toBe('inspect mistakes');
          expect(request.sessionMode).toBe('named');
          expect(request.cancellationToken).toBeInstanceOf(AbortSignal);
          return {
            sessionId: 'sess_named', assistantMessageId: 'msg_named', status: 'completed',
            summary: 'all clear', durationMs: 1,
          };
        },
        sendRunNotification: async (request) => {
          notifications.push(request as unknown as Record<string, unknown>);
          return { handled: true, deliveredOs: true };
        },
        emitRunCompleted: (payload) => { completed.push(payload as unknown as Record<string, unknown>); },
      }),
      log: silentLog,
      now: () => Date.now(), scheduler,
    };

    runAutomationNow(deps, 'auto_test', 1);
    await waitFor(() => listAutomationRuns(db, 'auto_test', 10).some((run) => run.status !== 'running'));

    const run = listAutomationRuns(db, 'auto_test', 10)[0]!;
    expect(run.summary).toBe('all clear');
    expect(run.status).toBe('success');
    expect(run.session_id).toBe('sess_named');
    expect(JSON.parse(String(db.pluck('SELECT delivered_json FROM automation_runs WHERE id = ?1', [run.id]))))
      .toContain('notification_pending');
    expect(db.pluck('SELECT agent_session_id FROM automation_definitions WHERE id = ?1', ['auto_test']))
      .toBe('sess_named');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ status: 'success', suppressIfWindowActive: true });
    expect(completed).toEqual([expect.objectContaining({
      automationId: 'auto_test', sessionId: 'sess_named', status: 'success',
      summary: 'all clear', heartbeat: false, osNotificationDelivered: true,
    })]);
  });

  it('heartbeat_idle_precheck_skips_the_llm_turn_and_finalizes_heartbeat_ok', async () => {
    const { db } = await fixture();
    const due = formatTimestampMillis(Date.now() - 60_000);
    insertAutomation(db, sampleDaily('09:00', {
      action_type: 'agent_turn', heartbeat: true, next_run_at: due,
    }));
    let headlessCalls = 0;
    const completed: Array<Record<string, unknown>> = [];
    const deps = {
      db,
      dispatch: port({
        heartbeatIdlePrecheck: () => true,
        runHeadlessTurn: async () => {
          headlessCalls += 1;
          throw new Error('must not run the LLM turn');
        },
        sendRunNotification: async () => {
          throw new Error('idle heartbeat must not notify');
        },
        emitRunCompleted: (payload) => { completed.push(payload as unknown as Record<string, unknown>); },
      }),
      log: silentLog,
      now: () => Date.now(), scheduler,
    };

    await tickAutomations(deps);
    await waitFor(() => listAutomationRuns(db, 'auto_test', 10).length === 1);
    await waitFor(() => completed.length === 1);

    expect(headlessCalls).toBe(0);
    const run = listAutomationRuns(db, 'auto_test', 10)[0]!;
    expect(run.status).toBe('heartbeat_ok');
    expect(run.summary).toBe('HEARTBEAT_OK');
    expect(completed[0]).toMatchObject({
      status: 'heartbeat_ok', summary: 'HEARTBEAT_OK', heartbeat: true,
      osNotificationDelivered: false, sessionId: null,
    });
  });

  it('mark_app_exiting_blocks_further_dispatch', async () => {
    const { db } = await fixture();
    const due = formatTimestampMillis(Date.now() - 60_000);
    insertAutomation(db, sampleDaily('09:00', { next_run_at: due }));
    let dispatched = 0;
    const deps = {
      db, dispatch: port({ deliverNotify: async () => { dispatched += 1; return { delivered: [] }; } }),
      log: silentLog, now: () => Date.now(), scheduler,
    };

    scheduler.markAppExiting();
    await tickAutomations(deps);
    expect(dispatched).toBe(0);
    expect(() => runAutomationNow(deps, 'auto_test', 1))
      .toThrow('Automation dispatch is paused (AgentKillSwitch / scheduler pause). Resume agents and automations first.');
  });
});
