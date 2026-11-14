import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService, type StorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import {
  completeRun, createManualRun, loadRunDeliveries, saveAutomations,
  type AutomationDefinition,
} from '../repository/automations.ts';
import {
  NOTIFICATION_RETRY_DELAY_MS, deliverPendingAgentNotifications, deliverRunNotification,
  notificationIdForRun, notificationLanguage, notificationTitleFailed, notificationTitleSuccess,
  truncatePromptForNotification,
  type NotificationDeps, type SystemNotificationOutcome, type SystemNotificationPort,
  type SystemNotificationRequest,
} from '../src/automation-notifications.ts';
import { formatTimestampMillis, type AutomationSchedule } from '../src/automation-schedule.ts';

let cleanup: (() => Promise<void>) | null = null;

async function fixture(): Promise<{ db: DatabaseHandle; storage: StorageService; now: number }> {
  const host = await createTestHost();
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  const db = storage.database('mistakes');
  for (const name of ['V20260714__automation_scheduler.sql', 'V20260715__harden_automation_runtime.sql', 'V20260721__trusted_automation_profile.sql']) {
    db.exec(readFileSync(new URL(`../../../../resources/app/migrations/mistakes/${name}`, import.meta.url), 'utf8'));
  }
  cleanup = async () => { storage.dispose(); await host.dispose(); };
  return { db, storage, now: Date.now() };
}

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

function schedule(kind: AutomationSchedule['kind'], time: string, overrides: Partial<AutomationSchedule> = {}): AutomationSchedule {
  return { kind, time, weekday: null, weekdays: null, day_of_month: null,
    interval_minutes: null, date: null, timezone: null, ...overrides };
}

function automation(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'auto_notify', name: 'Daily review', schedule: schedule('daily', '09:00'),
    prompt: 'Summarize mistakes', enabled: true, created_at: formatTimestampMillis(Date.now()),
    session_id: '', last_run_at: null, next_run_at: null,
    action_type: 'notify', heartbeat: false, agent_prompt: null, session_mode: null,
    model_id: null, agent_session_id: null, catch_up_policy: 'run_once',
    max_retries: 0, retry_backoff_seconds: 60, timeout_seconds: 600,
    trusted_profile: null, version: 1, ...overrides,
  };
}

function finishedRun(
  db: DatabaseHandle, status: string = 'success', deliveries: string[] = ['notification_pending'],
): { run_id: string; attempt: number } {
  const definition = automation();
  saveAutomations(db, [definition]);
  const claimed = createManualRun(db, definition.id, definition.version);
  expect(completeRun(db, claimed.run_id, claimed.attempt, status, deliveries, 'sess_done', 'done', null))
    .toBe(true);
  return { run_id: claimed.run_id, attempt: claimed.attempt };
}

interface ShellCall { op: string; args: unknown }

function notificationService(
  outcome: SystemNotificationOutcome, disabled = false,
): { service: SystemNotificationPort; requests: SystemNotificationRequest[] } {
  const requests: SystemNotificationRequest[] = [];
  return {
    requests,
    service: {
      policy: () => disabled ? 'never' : 'background',
      notificationsDisabled: () => disabled,
      notify: async (request) => {
        requests.push(request);
        return outcome;
      },
    },
  };
}

function deps(
  db: DatabaseHandle, now: number,
  options: {
    policy?: string | null;
    language?: string | null;
    windowActive?: boolean;
    notifyFails?: boolean;
    calls?: ShellCall[];
    notification?: SystemNotificationPort;
  } = {},
): NotificationDeps {
  const calls = options.calls ?? [];
  return {
    db,
    settings: {
      get(key) {
        if (key === 'system-notification-policy') return options.policy ?? null;
        if (key === 'language') return options.language ?? null;
        return null;
      },
    },
    shell: {
      async request<R = unknown>(op: string, args?: unknown): Promise<R> {
        calls.push({ op, args });
        if (op === 'plugin:notification|notify') {
          if (options.notifyFails === true) throw new Error('notification boom');
          return null as R;
        }
        if (options.windowActive !== false) {
          if (op === 'plugin:window|is_minimized') return false as R;
          return true as R;
        }
        return false as R;
      },
    },
    ...(options.notification === undefined ? {} : { notification: options.notification }),
    logger: { warn: () => {} },
    now: () => now,
  };
}

describe('automations.rs run notification policy and redelivery', () => {
  it('never policy suppresses and clears pending without scheduling a retry', async () => {
    const { db, now } = await fixture();
    const { run_id, attempt } = finishedRun(db);
    const calls: ShellCall[] = [];
    const outcome = await deliverRunNotification(deps(db, now, { policy: 'never', calls }), {
      runId: run_id, attempt, status: 'success',
      title: notificationTitleSuccess('zh', 'Daily review'), body: 'done',
      suppressIfWindowActive: true,
    });
    expect(outcome).toEqual({ handled: true, deliveredOs: false });
    expect(calls).toEqual([]);
    expect(loadRunDeliveries(db, run_id)).not.toContain('notification_pending');
    expect(db.pluck('SELECT next_attempt_at FROM automation_runs WHERE id = ?1', [run_id])).toBeNull();
  });

  it('active main window suppresses completion notifications', async () => {
    const { db, now } = await fixture();
    const { run_id, attempt } = finishedRun(db);
    const calls: ShellCall[] = [];
    const outcome = await deliverRunNotification(deps(db, now, { windowActive: true, calls }), {
      runId: run_id, attempt, status: 'success',
      title: notificationTitleSuccess('zh', 'Daily review'), body: 'done',
      suppressIfWindowActive: true,
    });
    expect(outcome).toEqual({ handled: true, deliveredOs: false });
    expect(calls.map((call) => call.op)).toEqual([
      'plugin:window|is_focused', 'plugin:window|is_visible', 'plugin:window|is_minimized',
    ]);
    expect(loadRunDeliveries(db, run_id)).not.toContain('notification_pending');
  });

  it('delivers once, records the marker, and never re-sends the same run', async () => {
    const { db, now } = await fixture();
    const { run_id, attempt } = finishedRun(db);
    const calls: ShellCall[] = [];
    const request = {
      runId: run_id, attempt, status: 'success',
      title: notificationTitleSuccess('zh', 'Daily review'), body: 'done',
      suppressIfWindowActive: false,
    };
    const first = await deliverRunNotification(deps(db, now, { calls }), request);
    expect(first).toEqual({ handled: true, deliveredOs: true });
    expect(calls.filter((call) => call.op === 'plugin:notification|notify')).toHaveLength(1);
    expect(loadRunDeliveries(db, run_id)).toContain('notification');

    const second = await deliverRunNotification(deps(db, now, { calls }), request);
    expect(second).toEqual({ handled: true, deliveredOs: false });
    expect(calls.filter((call) => call.op === 'plugin:notification|notify')).toHaveLength(1);
  });

  it('a failed OS delivery releases the reservation and schedules a retry', async () => {
    const { db, now } = await fixture();
    const { run_id, attempt } = finishedRun(db, 'error', ['notification_pending']);
    const outcome = await deliverRunNotification(deps(db, now, { notifyFails: true }), {
      runId: run_id, attempt, status: 'error',
      title: notificationTitleFailed('zh', 'Daily review'), body: 'failed',
      suppressIfWindowActive: false,
    });
    expect(outcome).toEqual({ handled: false, deliveredOs: false });
    expect(loadRunDeliveries(db, run_id)).not.toContain('notification');
    const retryAt = String(db.pluck('SELECT next_attempt_at FROM automation_runs WHERE id = ?1', [run_id]));
    expect(retryAt.endsWith('+00:00')).toBe(true);
    expect(Date.parse(retryAt)).toBeGreaterThanOrEqual(now + NOTIFICATION_RETRY_DELAY_MS - 2_000);
  });

  it('uses the F2 systemNotification service and records only a delivered outcome', async () => {
    const { db, now } = await fixture();
    const { run_id, attempt } = finishedRun(db);
    const calls: ShellCall[] = [];
    const { service, requests } = notificationService({ delivered: true, suppressed: null, error: null });
    const outcome = await deliverRunNotification(
      deps(db, now, { calls, windowActive: false, notification: service }),
      {
        runId: run_id, attempt, status: 'success',
        title: notificationTitleSuccess('zh', 'Daily review'), body: 'done',
        suppressIfWindowActive: true,
      },
    );
    expect(outcome).toEqual({ handled: true, deliveredOs: true });
    expect(requests).toEqual([{
      id: notificationIdForRun(run_id),
      title: notificationTitleSuccess('zh', 'Daily review'),
      body: 'done',
      suppressIfWindowActive: false,
    }]);
    expect(calls.map((call) => call.op)).toEqual([
      'plugin:window|is_focused', 'plugin:window|is_visible', 'plugin:window|is_minimized',
    ]);
    expect(loadRunDeliveries(db, run_id)).toContain('notification');
  });

  it('honors F2 policy suppression without calling notify or writing a delivery marker', async () => {
    const { db, now } = await fixture();
    const { run_id, attempt } = finishedRun(db);
    const { service, requests } = notificationService(
      { delivered: false, suppressed: 'policy', error: null }, true,
    );
    const outcome = await deliverRunNotification(deps(db, now, { notification: service }), {
      runId: run_id, attempt, status: 'success',
      title: notificationTitleSuccess('zh', 'Daily review'), body: 'done',
      suppressIfWindowActive: true,
    });
    expect(outcome).toEqual({ handled: true, deliveredOs: false });
    expect(requests).toHaveLength(0);
    expect(loadRunDeliveries(db, run_id)).not.toContain('notification');
    expect(db.pluck('SELECT next_attempt_at FROM automation_runs WHERE id = ?1', [run_id])).toBeNull();
  });

  it('prechecks window activity before reserving with the F2 service', async () => {
    const { db, now } = await fixture();
    const { run_id, attempt } = finishedRun(db);
    const calls: ShellCall[] = [];
    const { service, requests } = notificationService(
      { delivered: false, suppressed: null, error: 'notify must not run' },
    );
    const outcome = await deliverRunNotification(
      deps(db, now, { calls, windowActive: true, notification: service }),
      {
        runId: run_id, attempt, status: 'success',
        title: notificationTitleSuccess('zh', 'Daily review'), body: 'done',
        suppressIfWindowActive: true,
      },
    );
    expect(outcome).toEqual({ handled: true, deliveredOs: false });
    expect(requests).toHaveLength(0);
    expect(calls.map((call) => call.op)).toEqual([
      'plugin:window|is_focused', 'plugin:window|is_visible', 'plugin:window|is_minimized',
    ]);
    expect(loadRunDeliveries(db, run_id)).not.toContain('notification');
    expect(db.pluck('SELECT next_attempt_at FROM automation_runs WHERE id = ?1', [run_id])).toBeNull();
  });

  it('does not attempt the delivery reservation while the window is active', async () => {
    const { db, now } = await fixture();
    const { run_id, attempt } = finishedRun(db);
    const guarded = new Proxy(db, {
      get(target, key, receiver) {
        if (key === 'transaction') {
          return () => { throw new Error('delivery reservation must not start'); };
        }
        const value: unknown = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as typeof db;
    const { service, requests } = notificationService(
      { delivered: true, suppressed: null, error: null },
    );
    const outcome = await deliverRunNotification(
      deps(guarded, now, { windowActive: true, notification: service }),
      {
        runId: run_id, attempt, status: 'success',
        title: notificationTitleSuccess('zh', 'Daily review'), body: 'done',
        suppressIfWindowActive: true,
      },
    );
    expect(outcome).toEqual({ handled: true, deliveredOs: false });
    expect(requests).toHaveLength(0);
    expect(loadRunDeliveries(db, run_id)).not.toContain('notification');
    expect(db.pluck('SELECT next_attempt_at FROM automation_runs WHERE id = ?1', [run_id])).toBeNull();
  });

  it('honors F2 window suppression reported after the reservation', async () => {
    const { db, now } = await fixture();
    const { run_id, attempt } = finishedRun(db);
    const { service, requests } = notificationService(
      { delivered: false, suppressed: 'window-active', error: null },
    );
    const outcome = await deliverRunNotification(
      deps(db, now, { windowActive: false, notification: service }),
      {
        runId: run_id, attempt, status: 'success',
        title: notificationTitleSuccess('zh', 'Daily review'), body: 'done',
        suppressIfWindowActive: true,
      },
    );
    expect(outcome).toEqual({ handled: true, deliveredOs: false });
    expect(requests).toHaveLength(1);
    expect(loadRunDeliveries(db, run_id)).not.toContain('notification');
    expect(db.pluck('SELECT next_attempt_at FROM automation_runs WHERE id = ?1', [run_id])).toBeNull();
  });

  it('releases the F2 reservation and schedules a retry when delivery reports an error', async () => {
    const { db, now } = await fixture();
    const { run_id, attempt } = finishedRun(db, 'error', ['notification_pending']);
    const { service } = notificationService({ delivered: false, suppressed: null, error: 'no notification daemon' });
    const outcome = await deliverRunNotification(deps(db, now, { notification: service }), {
      runId: run_id, attempt, status: 'error',
      title: notificationTitleFailed('zh', 'Daily review'), body: 'failed',
      suppressIfWindowActive: false,
    });
    expect(outcome).toEqual({ handled: false, deliveredOs: false });
    expect(loadRunDeliveries(db, run_id)).not.toContain('notification');
    const retryAt = String(db.pluck('SELECT next_attempt_at FROM automation_runs WHERE id = ?1', [run_id]));
    expect(retryAt.endsWith('+00:00')).toBe(true);
    expect(Date.parse(retryAt)).toBeGreaterThanOrEqual(now + NOTIFICATION_RETRY_DELAY_MS - 2_000);
  });

  it('redelivers pending completion notifications at most once per run', async () => {
    const { db, now } = await fixture();
    const { run_id } = finishedRun(db, 'success', ['notification_pending']);
    const calls: ShellCall[] = [];
    const notificationDeps = deps(db, now, { calls, windowActive: false });
    expect(await deliverPendingAgentNotifications(notificationDeps)).toBe(1);
    expect(await deliverPendingAgentNotifications(notificationDeps)).toBe(0);
    expect(calls.filter((call) => call.op === 'plugin:notification|notify')).toHaveLength(1);
    expect(loadRunDeliveries(db, run_id)).toContain('notification');
  });

  it('notification copy matches the Rust language and truncation rules', () => {
    expect(notificationLanguage(' en-US ')).toBe('en');
    expect(notificationLanguage('zh-CN')).toBe('zh');
    expect(notificationLanguage(null)).toBe('zh');
    expect(truncatePromptForNotification('short', 'zh')).toBe('short 打开 Deep Student 执行此任务');
    expect(truncatePromptForNotification('x'.repeat(101), 'en'))
      .toBe(`${'x'.repeat(100)}… Open Deep Student to run this task.`);
  });
});
