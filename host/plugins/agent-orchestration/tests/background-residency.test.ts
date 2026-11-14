/**
 * V04-02 Host 侧：`agentAutomation.backgroundResidency()` 汇总关窗后台驻留的三个条件与通知策略，
 * 口径与外壳 `electron/shell/background-residency.ts` 的 `residencyStateFromCommands` 相同（Rust `lib.rs:1714-1760`）。
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ContractSet } from '../../../kernel/contracts.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import plugin from '../index.ts';
import type { AgentAutomationService } from '../api.ts';
import { type AutomationDefinition, saveAutomations } from '../repository/automations.ts';
import { formatTimestampMillis } from '../src/automation-schedule.ts';

const contracts = ContractSet.fromDirectory();

afterEach(() => new Promise<void>((resolve) => { setImmediate(resolve); }));

async function fixture() {
  const host = await createTestHost({ contracts, hostCallCaller: 'require' });
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  const db = storage.database('mistakes');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
  for (const name of ['V20260714__automation_scheduler.sql', 'V20260715__harden_automation_runtime.sql', 'V20260721__trusted_automation_profile.sql']) {
    db.exec(readFileSync(new URL(`../../../../resources/app/migrations/mistakes/${name}`, import.meta.url), 'utf8'));
  }
  const settings = createSettingsStore({ db: () => db, secureStore: () => null, isSensitiveKey: () => false });
  host.ctx.provide('settings', settings);
  host.ctx.provide('storage', storage);
  await host.install(plugin);
  const service = host.ctx.get('agentAutomation') as AgentAutomationService;
  const close = async () => { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); };
  return { host, db, settings, service, close };
}

function automation(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'auto_test', name: 'Daily review',
    schedule: { kind: 'daily', time: '09:00', weekday: null, weekdays: null, day_of_month: null, interval_minutes: null, date: null, timezone: null },
    prompt: 'Summarize mistakes', enabled: true, created_at: formatTimestampMillis(Date.now()),
    session_id: 'ui', last_run_at: null, next_run_at: null,
    action_type: 'notify', heartbeat: false, agent_prompt: null, session_mode: null,
    model_id: null, agent_session_id: null, catch_up_policy: 'run_once',
    max_retries: 2, retry_backoff_seconds: 60, timeout_seconds: 600,
    trusted_profile: null, version: 1, ...overrides,
  };
}

const NONE = { automation: false, superAgent: false, quickAssistant: false, notificationsDisabled: false };

describe('V04-02 agentAutomation.backgroundResidency (lib.rs:1714-1760)', () => {
  it('reports nothing when no condition holds', async () => {
    const { service, close } = await fixture();
    try {
      expect(service.backgroundResidency()).toEqual(NONE);
    } finally { await close(); }
  });

  it('automation: an enabled automation with automation_background_enabled unset keeps the app in the background', async () => {
    const { db, service, close } = await fixture();
    try {
      saveAutomations(db, [automation()]);
      expect(service.backgroundResidency()).toEqual({ ...NONE, automation: true });
    } finally { await close(); }
  });

  it('automation: only the exact string "false" turns automation_background_enabled off', async () => {
    const { db, settings, service, close } = await fixture();
    try {
      saveAutomations(db, [automation()]);
      for (const value of ['true', 'False', 'FALSE', '0', '', ' false ']) {
        settings.save('chat_v2.automation_background_enabled', value);
        expect(service.backgroundResidency().automation, `value ${JSON.stringify(value)}`).toBe(true);
      }
      settings.save('chat_v2.automation_background_enabled', 'false');
      expect(service.backgroundResidency().automation).toBe(false);
    } finally { await close(); }
  });

  it('automation: false when no automation is enabled', async () => {
    const { db, service, close } = await fixture();
    try {
      saveAutomations(db, [automation({ enabled: false })]);
      expect(service.backgroundResidency().automation).toBe(false);
    } finally { await close(); }
  });

  it('superAgent: super_agent.enabled trimmed equals "true" or "1"', async () => {
    const { settings, service, close } = await fixture();
    try {
      for (const value of ['true', '1', '  true\n', ' 1 ']) {
        settings.save('super_agent.enabled', value);
        expect(service.backgroundResidency(), `value ${JSON.stringify(value)}`).toEqual({ ...NONE, superAgent: true });
      }
      for (const value of ['TRUE', 'yes', '0', 'false', '']) {
        settings.save('super_agent.enabled', value);
        expect(service.backgroundResidency().superAgent, `value ${JSON.stringify(value)}`).toBe(false);
      }
    } finally { await close(); }
  });

  it('quickAssistant: quick_assistant.background_enabled must equal "true" exactly', async () => {
    const { settings, service, close } = await fixture();
    try {
      settings.save('quick_assistant.background_enabled', 'true');
      expect(service.backgroundResidency()).toEqual({ ...NONE, quickAssistant: true });
      for (const value of [' true', 'TRUE', '1', 'false']) {
        settings.save('quick_assistant.background_enabled', value);
        expect(service.backgroundResidency().quickAssistant, `value ${JSON.stringify(value)}`).toBe(false);
      }
    } finally { await close(); }
  });

  it('notificationsDisabled: system-notification-policy equals "never"', async () => {
    const { settings, service, close } = await fixture();
    try {
      settings.save('system-notification-policy', 'never');
      expect(service.backgroundResidency()).toEqual({ ...NONE, notificationsDisabled: true });
      for (const value of ['always', 'background', ' never', 'NEVER']) {
        settings.save('system-notification-policy', value);
        expect(service.backgroundResidency().notificationsDisabled, `value ${JSON.stringify(value)}`).toBe(false);
      }
    } finally { await close(); }
  });

  it('read failures fall back like Rust: settings unreadable -> false (automation flag defaults on), automation load failure -> false', async () => {
    const { db, settings, service, close } = await fixture();
    try {
      saveAutomations(db, [automation()]);
      settings.save('super_agent.enabled', 'true');
      settings.save('quick_assistant.background_enabled', 'true');
      settings.save('system-notification-policy', 'never');
      settings.save('chat_v2.automation_background_enabled', 'false');
      db.exec('DROP TABLE settings');
      expect(() => db.pluck('SELECT value FROM settings')).toThrow();
      // automations.rs:4779-4792: an unreadable automation_background_enabled counts as enabled.
      expect(service.backgroundResidency()).toEqual({ ...NONE, automation: true });
      db.run("UPDATE automation_definitions SET schedule_json = 'not json' WHERE id = 'auto_test'");
      expect(service.backgroundResidency()).toEqual(NONE);
    } finally { await close(); }
  });

  it('is callable from the local main window through plugin:host|call, and markAppExiting is not', async () => {
    const { host, db, settings, close } = await fixture();
    try {
      saveAutomations(db, [automation()]);
      settings.save('quick_assistant.background_enabled', 'true');
      await expect(host.invoke('plugin:host|call', { service: 'agentAutomation', method: 'backgroundResidency', args: [], caller: 'dstu.agent-orchestration' }))
        .resolves.toEqual({ automation: true, superAgent: false, quickAssistant: true, notificationsDisabled: false });
      await expect(host.invoke('plugin:host|call', { service: 'agentAutomation', method: 'markAppExiting', args: [], caller: 'dstu.agent-orchestration' }))
        .rejects.toMatchObject({ error_type: 'Validation', message: expect.stringContaining('does not expose "markAppExiting" to UI') });
    } finally { await close(); }
  });
});
