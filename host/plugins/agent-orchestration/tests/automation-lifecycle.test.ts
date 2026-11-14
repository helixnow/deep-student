/**
 * V09 P1-5：退出与卸载时取消在途自动化运行（Rust `lib.rs:3251` 在 `RunEvent::ExitRequested` 第一行
 * `mark_automation_app_exiting()`），调度器的暂停/退出标记随插件实例重置。
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ContractSet } from '../../../kernel/contracts.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import plugin from '../index.ts';
import type { AgentAutomationService, HeadlessTurnRequest, HeadlessTurnResult } from '../api.ts';
import { type AutomationDefinition, listAutomationRuns, saveAutomations } from '../repository/automations.ts';
import { formatTimestampMillis } from '../src/automation-schedule.ts';

const contracts = ContractSet.fromDirectory();
const PAUSED = '{"code":"VALIDATION_ERROR","message":"Automation dispatch is paused (AgentKillSwitch / scheduler pause). Resume agents and automations first."}';

afterEach(() => new Promise<void>((resolve) => { setImmediate(resolve); }));

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition was not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function agentTurn(id: string): AutomationDefinition {
  return {
    id, name: `Agent ${id}`,
    schedule: { kind: 'daily', time: '09:00', weekday: null, weekdays: null, day_of_month: null, interval_minutes: null, date: null, timezone: null },
    prompt: 'Inspect mistakes', enabled: true, created_at: formatTimestampMillis(Date.now()), session_id: '',
    last_run_at: null, next_run_at: null, action_type: 'agent_turn', heartbeat: false,
    agent_prompt: null, session_mode: 'isolated', model_id: null, agent_session_id: null,
    catch_up_policy: 'run_once', max_retries: 0, retry_backoff_seconds: 60,
    timeout_seconds: 600, trusted_profile: null, version: 1,
  };
}

/** headless turn 一直挂起，直到取消 token 触发才以 cancelled 结束（`ChatV2Error::Cancelled`）。 */
function blockingHeadless() {
  const signals: AbortSignal[] = [];
  let settled = 0;
  const runHeadlessTurn = (request: HeadlessTurnRequest): Promise<HeadlessTurnResult> => new Promise((resolve) => {
    const signal = request.cancellationToken!;
    signals.push(signal);
    signal.addEventListener('abort', () => {
      settled += 1;
      resolve({ sessionId: 'sess_cancelled', assistantMessageId: 'msg_cancelled', status: 'cancelled', summary: '', durationMs: 1, error: 'cancelled' });
    }, { once: true });
  });
  return { signals, get settled() { return settled; }, runHeadlessTurn };
}

async function fixture() {
  const host = await createTestHost({ contracts });
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  const db = storage.database('mistakes');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
  for (const name of ['V20260714__automation_scheduler.sql', 'V20260715__harden_automation_runtime.sql', 'V20260721__trusted_automation_profile.sql']) {
    db.exec(readFileSync(new URL(`../../../../resources/app/migrations/mistakes/${name}`, import.meta.url), 'utf8'));
  }
  const settings = createSettingsStore({ db: () => db, secureStore: () => null, isSensitiveKey: () => false });
  const headless = blockingHeadless();
  host.ctx.provide('settings', settings);
  host.ctx.provide('storage', storage);
  host.ctx.provide('chatState', { killSwitch: { ensureAllowed() {}, isTripped() { return false; } } });
  host.ctx.provide('chatSession', {
    runHeadlessTurn: headless.runHeadlessTurn,
    runHeadlessAgentTurn: async () => { throw new Error('unused'); },
  });
  await host.install(plugin);
  let installed = true;
  return {
    host, db, headless,
    service: () => host.ctx.get('agentAutomation') as AgentAutomationService,
    async unload() { installed = false; await host.unload('dstu.agent-orchestration'); },
    async reinstall() { await host.install(plugin); installed = true; },
    async close() {
      if (installed) await host.unload('dstu.agent-orchestration');
      storage.dispose();
      await host.dispose();
    },
  };
}

function emitHostExiting(host: TestHost): void {
  (host.ctx.emit as unknown as (name: string, info: { reason: string }) => void)('host/exiting', { reason: 'shutdown' });
}

describe('V09-P1-5 automation runs on exit and unload', () => {
  it('unloading the plugin cancels the in-flight run as shutdown and leaves it recoverable', async () => {
    const f = await fixture();
    try {
      saveAutomations(f.db, [agentTurn('auto_a')]);
      await expect(f.host.invoke<{ status: string }>('chat_v2_automation_run_now', { automationId: 'auto_a', expectedVersion: 1 }))
        .resolves.toMatchObject({ status: 'started' });
      await waitFor(() => f.headless.signals.length === 1);

      await f.unload();

      expect(f.headless.signals[0]!.aborted).toBe(true);
      await waitFor(() => f.headless.settled === 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      // automations.rs shutdown path: the run is not finalized as a user cancel; startup recovery retries it.
      const [run] = listAutomationRuns(f.db, 'auto_a', 10);
      expect(run).toMatchObject({ status: 'running', summary: null });
      expect(f.host.eventsNamed('chat_v2_automation_run_completed')).toEqual([]);
    } finally { await f.close(); }
  });

  it('a reinstalled plugin dispatches again after the previous instance was marked exiting and paused', async () => {
    const f = await fixture();
    try {
      saveAutomations(f.db, [agentTurn('auto_a')]);
      f.service().pauseScheduler();
      f.service().markAppExiting();
      expect(f.service().isSchedulerPaused()).toBe(true);
      expect(f.service().appIsExiting()).toBe(true);
      await expect(f.host.invoke('chat_v2_automation_run_now', { automationId: 'auto_a', expectedVersion: 1 })).rejects.toBe(PAUSED);

      await f.unload();
      await f.reinstall();

      expect(f.service().isSchedulerPaused()).toBe(false);
      expect(f.service().appIsExiting()).toBe(false);
      await expect(f.host.invoke<{ status: string }>('chat_v2_automation_run_now', { automationId: 'auto_a', expectedVersion: 1 }))
        .resolves.toMatchObject({ status: 'started' });
      await waitFor(() => f.headless.signals.length === 1);
    } finally { await f.close(); }
  });

  it('host/exiting cancels the in-flight run as shutdown and blocks further dispatch', async () => {
    const f = await fixture();
    try {
      saveAutomations(f.db, [agentTurn('auto_a'), agentTurn('auto_b')]);
      await f.host.invoke('chat_v2_automation_run_now', { automationId: 'auto_a', expectedVersion: 1 });
      await waitFor(() => f.headless.signals.length === 1);

      emitHostExiting(f.host);

      expect(f.service().appIsExiting()).toBe(true);
      expect(f.headless.signals[0]!.aborted).toBe(true);
      await waitFor(() => f.headless.settled === 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(listAutomationRuns(f.db, 'auto_a', 10)[0]).toMatchObject({ status: 'running', summary: null });
      await expect(f.host.invoke('chat_v2_automation_run_now', { automationId: 'auto_b', expectedVersion: 1 })).rejects.toBe(PAUSED);
      expect(f.headless.signals).toHaveLength(1);
      expect(listAutomationRuns(f.db, 'auto_b', 10)).toEqual([]);
    } finally { await f.close(); }
  });
});
