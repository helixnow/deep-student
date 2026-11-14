import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTestHost, HandlerPanic } from '../../../kernel/testing.ts';
import { ContractSet } from '../../../kernel/contracts.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import plugin from '../index.ts';
import type { AgentAutomationService } from '../api.ts';
import {
  createManualRun, listAutomationRuns, loadAutomations, loadRunDeliveries, saveAutomations,
  type AutomationDefinition,
} from '../repository/automations.ts';
import { formatTimestampMillis, type AutomationSchedule } from '../src/automation-schedule.ts';
import { SCHEDULER_POLL_SECS } from '../src/automation-runtime.ts';
import {
  notificationTitleRunning, truncatePromptForNotification,
  type SystemNotificationRequest,
} from '../src/automation-notifications.ts';

// createTestHost() 默认每次同步读取并校验 contracts/ipc 全部契约（约 1.2s）；ContractSet 不可变，整个文件共用一份。
const contracts = ContractSet.fromDirectory();

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition was not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface TestStartupGate {
  isStartupReady(): boolean;
  waitStartupReady(timeout: number): Promise<boolean>;
  markStartupReady(): void;
}

/** F2 `createStartupGate` 的同语义测试实现：单次、单调的 ready 标记。 */
function createStartupGateFixture(): TestStartupGate {
  let ready = false;
  const waiters = new Set<() => void>();
  return {
    isStartupReady: () => ready,
    waitStartupReady(timeout: number): Promise<boolean> {
      if (ready) return Promise.resolve(true);
      return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const notify = () => { clearTimeout(timer); waiters.delete(notify); resolve(ready); };
        timer = setTimeout(() => { waiters.delete(notify); resolve(false); }, timeout);
        (timer as { unref?: () => void }).unref?.();
        waiters.add(notify);
      });
    },
    markStartupReady() {
      ready = true;
      for (const notify of waiters) notify();
      waiters.clear();
    },
  };
}

type FinalizerState = 'open' | 'running' | 'done' | 'failed';

/**
 * F3 `StartupFinalizerRegistry`（`ds-mig/F3-storage` `bf8f7b439`）的同失败语义测试实现：
 * 同名重复注册抛 `FINALIZER_DUPLICATE`，执行开始后注册抛 `FINALIZER_LATE_REGISTRATION`，
 * 执行失败停在 `failed` 并保留已完成列表。用于验证真实拒绝点，而非只手动调用成功钩子。
 */
function createFinalizerRegistry(storage: ReturnType<typeof createStorageService>) {
  const finalizers = new Map<string, () => void | Promise<void>>();
  let state: FinalizerState = 'open';
  const fail = (code: string, message: string): Error =>
    Object.assign(new Error(message), { code });
  const register = (name: string, fn: () => void | Promise<void>): void => {
    if (state !== 'open') {
      throw fail('FINALIZER_LATE_REGISTRATION',
        `startup finalizer "${name}" registered after runStartupFinalizers() started`);
    }
    if (typeof name !== 'string' || name.length === 0 || typeof fn !== 'function') {
      throw fail('FINALIZER_INVALID', 'startup finalizer requires a non-empty name and a function');
    }
    if (finalizers.has(name)) {
      throw fail('FINALIZER_DUPLICATE', `startup finalizer "${name}" is already registered`);
    }
    finalizers.set(name, fn);
  };
  const storageProbe = new Proxy(storage, {
    get(target, key, receiver) {
      if (key === 'registerFinalizer') return register;
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return {
    finalizers,
    storageProbe,
    register,
    /** 模拟组合根已进入 `runStartupFinalizers()`（此时插件才 apply）。 */
    markRunStarted(): void { state = 'running'; },
    get state(): FinalizerState { return state; },
    async runStartupFinalizers(): Promise<string[]> {
      if (state === 'done') return [...finalizers.keys()];
      state = 'running';
      const completed: string[] = [];
      for (const [name, fn] of finalizers) {
        try { await fn(); } catch (error) { state = 'failed'; throw error; }
        completed.push(name);
      }
      state = 'done';
      return completed;
    },
  };
}

function agentTurnAutomation(): AutomationDefinition {
  const schedule: AutomationSchedule = { kind: 'daily', time: '09:00', weekday: null, weekdays: null,
    day_of_month: null, interval_minutes: null, date: null, timezone: null };
  return {
    id: 'auto_agent', name: 'Agent run', schedule, prompt: 'Inspect mistakes',
    enabled: true, created_at: formatTimestampMillis(Date.now()), session_id: '',
    last_run_at: null, next_run_at: null, action_type: 'agent_turn', heartbeat: false,
    agent_prompt: null, session_mode: 'isolated', model_id: null, agent_session_id: null,
    catch_up_policy: 'run_once', max_retries: 0, retry_backoff_seconds: 60,
    timeout_seconds: 600, trusted_profile: null, version: 1,
  };
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
  host.ctx.provide('settings', settings);
  host.ctx.provide('storage', storage);
  await host.install(plugin);
  return { host, storage, db, settings };
}

describe('automations.rs command reads and explicit retry', () => {
  it('automation_summary_releases_database_guard_before_reading_settings', async () => {
    // Rust 版本用另一线程证明 summary 查询的数据库锁在读取 settings 前已释放
    // （读取 settings 会再取同一把锁，持锁会死锁）。TS 的等价性质是：
    // settings.get 被调用时没有任何语句或事务仍在执行。
    const host = await createTestHost({ contracts });
    try {
      const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
      const db = storage.database('mistakes');
      db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
      for (const name of ['V20260714__automation_scheduler.sql', 'V20260715__harden_automation_runtime.sql', 'V20260721__trusted_automation_profile.sql']) {
        db.exec(readFileSync(new URL(`../../../../resources/app/migrations/mistakes/${name}`, import.meta.url), 'utf8'));
      }
      const settings = createSettingsStore({ db: () => db, secureStore: () => null, isSensitiveKey: () => false });
      settings.save('chat_v2.automation_background_enabled', 'false');

      let depth = 0;
      let busyAtSettingsRead: boolean | null = null;
      const guarded = new Proxy(db, {
        get(target, key, receiver) {
          const value: unknown = Reflect.get(target, key, receiver);
          if (typeof value !== 'function') return value;
          const fn = value as (...args: unknown[]) => unknown;
          return (...args: unknown[]) => {
            depth += 1;
            try { return fn.apply(target, args); } finally { depth -= 1; }
          };
        },
      });
      const storageProbe = new Proxy(storage, {
        get(target, key, receiver) {
          if (key === 'database') return () => guarded;
          const value: unknown = Reflect.get(target, key, receiver);
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      const settingsProbe = new Proxy(settings, {
        get(target, key) {
          const value: unknown = Reflect.get(target, key, target);
          if (key === 'get') {
            return (name: string) => {
              busyAtSettingsRead = depth !== 0;
              return (value as (name: string) => string | null).call(target, name);
            };
          }
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      host.ctx.provide('settings', settingsProbe as unknown as typeof settings);
      host.ctx.provide('storage', storageProbe as unknown as typeof storage);
      await host.install(plugin);

      const summary = await host.invoke<Record<string, unknown>>('chat_v2_automation_summary');
      expect(busyAtSettingsRead).toBe(false);
      expect(summary.enabledCount).toBe(0);
      expect(summary.runningCount).toBe(0);
      expect(summary.failedCount).toBe(0);
      expect(summary.nextRunAt).toBeNull();
      expect(summary.backgroundEnabled).toBe(false);
      storage.dispose();
    } finally { await host.dispose(); }
  }, 2000);

  it('background setting persists before the change event', async () => {
    const { host, storage, settings } = await fixture();
    try {
      await expect(host.invoke('chat_v2_automation_set_background_enabled', { enabled: false })).resolves.toEqual({ success: true, enabled: false });
      expect(settings.get('chat_v2.automation_background_enabled')).toBe('false');
      expect(host.eventsNamed('chat_v2://automations_changed')).toEqual([{ action: 'background', automationId: '' }]);
      settings.save('chat_v2.automation_background_enabled', ' false ');
      expect(await host.invoke('chat_v2_automation_summary')).toMatchObject({ backgroundEnabled: true });
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('cancel endpoints finalize once automations without emitting once_completed', async () => {
    const { host, storage, db } = await fixture();
    const onceSchedule: AutomationSchedule = {
      kind: 'once', time: '09:00', weekday: null, weekdays: null, day_of_month: null,
      interval_minutes: null, date: '2026-08-01', timezone: 'UTC',
    };
    const onceAutomation = (id: string): AutomationDefinition => ({
      ...agentTurnAutomation(), id, name: id, schedule: onceSchedule,
      next_run_at: null, last_run_at: '2026-08-01T09:00:00+00:00',
    });
    try {
      const first = onceAutomation('auto_once_a');
      const second = onceAutomation('auto_once_b');
      saveAutomations(db, [first, second]);
      const firstRun = createManualRun(db, first.id, first.version);
      const secondRun = createManualRun(db, second.id, second.version);

      await expect(host.invoke('chat_v2_automation_cancel_run', { runId: firstRun.run_id }))
        .resolves.toEqual({ success: true, runId: firstRun.run_id });
      const service = host.ctx.get('agentAutomation') as AgentAutomationService;
      await service.cancelRun(secondRun.run_id);

      expect(loadAutomations(db).every((automation) => !automation.enabled)).toBe(true);
      expect(host.eventsNamed('chat_v2://automations_changed')).toEqual([
        { action: 'cancel_run', automationId: '' },
        { action: 'cancel_run', automationId: '' },
      ]);
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('registers scheduler startup recovery as an F3 storage finalizer when available', async () => {
    const host = await createTestHost({ contracts });
    const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
    const db = storage.database('mistakes');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    for (const name of ['V20260714__automation_scheduler.sql', 'V20260715__harden_automation_runtime.sql', 'V20260721__trusted_automation_profile.sql']) {
      db.exec(readFileSync(new URL(`../../../../resources/app/migrations/mistakes/${name}`, import.meta.url), 'utf8'));
    }
    const settings = createSettingsStore({ db: () => db, secureStore: () => null, isSensitiveKey: () => false });
    settings.save('chat_v2.automations', JSON.stringify([{
      id: 'auto_legacy', name: 'Legacy', schedule: { kind: 'daily', time: '09:00' },
      prompt: 'legacy prompt', enabled: true, created_at: '2026-01-01T00:00:00+00:00', session_id: '',
    }]));
    const lifecycle = createFinalizerRegistry(storage);
    const gate = createStartupGateFixture();
    host.ctx.provide('settings', settings);
    host.ctx.provide('storage', lifecycle.storageProbe);
    host.ctx.provide('startupGate', gate);
    await host.install(plugin);
    try {
      expect(lifecycle.finalizers.has('l06.automationSchedulerStartup')).toBe(true);
      expect(db.pluck<number>('SELECT COUNT(*) FROM automation_definitions')).toBe(0);
      await lifecycle.runStartupFinalizers();
      expect(db.pluck<number>('SELECT COUNT(*) FROM automation_definitions WHERE id = ?1', ['auto_legacy'])).toBe(1);
      expect(settings.get('chat_v2.automations_table_migrated')).toBe('true');
      gate.markStartupReady();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('starts the scheduler tick only after the startup finalizer and startup gate complete', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const host = await createTestHost({ contracts });
    const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
    const db = storage.database('mistakes');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    for (const name of ['V20260714__automation_scheduler.sql', 'V20260715__harden_automation_runtime.sql', 'V20260721__trusted_automation_profile.sql']) {
      db.exec(readFileSync(new URL(`../../../../resources/app/migrations/mistakes/${name}`, import.meta.url), 'utf8'));
    }
    const settings = createSettingsStore({ db: () => db, secureStore: () => null, isSensitiveKey: () => false });
    const lifecycle = createFinalizerRegistry(storage);
    const gate = createStartupGateFixture();
    const spawns: number[] = [];
    host.ctx.provide('settings', settings);
    host.ctx.provide('storage', lifecycle.storageProbe);
    host.ctx.provide('startupGate', gate);
    host.ctx.provide('backgroundTasks', {
      get size() { return spawns.length; },
      spawn<T>(_task: () => Promise<T>): Promise<T> | null { spawns.push(1); return null; },
      async shutdown() {},
    });
    try {
      await host.install(plugin);
      expect(lifecycle.finalizers.has('l06.automationSchedulerStartup')).toBe(true);
      await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_SECS * 1000);
      expect(spawns).toHaveLength(0);

      await lifecycle.runStartupFinalizers();
      await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_SECS * 1000);
      expect(spawns).toHaveLength(0);

      gate.markStartupReady();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_SECS * 1000);
      expect(spawns).toHaveLength(1);
    } finally {
      await host.unload('dstu.agent-orchestration');
      vi.useRealTimers();
      storage.dispose();
      await host.dispose();
    }
  });

  it('V09-P1-3 a finalizer name left by an earlier instance (FINALIZER_DUPLICATE) defers initialization and tick to the startup gate', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const host = await createTestHost({ contracts });
    const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
    const db = storage.database('mistakes');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    for (const name of ['V20260714__automation_scheduler.sql', 'V20260715__harden_automation_runtime.sql', 'V20260721__trusted_automation_profile.sql']) {
      db.exec(readFileSync(new URL(`../../../../resources/app/migrations/mistakes/${name}`, import.meta.url), 'utf8'));
    }
    const settings = createSettingsStore({ db: () => db, secureStore: () => null, isSensitiveKey: () => false });
    settings.save('chat_v2.automations', JSON.stringify([{
      id: 'auto_legacy', name: 'Legacy', schedule: { kind: 'daily', time: '09:00' },
      prompt: 'legacy prompt', enabled: true, created_at: '2026-01-01T00:00:00+00:00', session_id: '',
    }]));
    const lifecycle = createFinalizerRegistry(storage);
    // 真实 F3 同名拒绝点：重装前的实例已占用该名称，且旧 registry 没有注销手段。
    lifecycle.register('l06.automationSchedulerStartup', () => {});
    const gate = createStartupGateFixture();
    const spawns: number[] = [];
    host.ctx.provide('settings', settings);
    host.ctx.provide('storage', lifecycle.storageProbe);
    host.ctx.provide('startupGate', gate);
    host.ctx.provide('backgroundTasks', {
      get size() { return spawns.length; },
      spawn<T>(_task: () => Promise<T>): Promise<T> | null { spawns.push(1); return null; },
      async shutdown() {},
    });
    try {
      await host.install(plugin);
      // 注册被拒时不抢在启动收尾之前初始化或启动 tick。
      expect(db.pluck<number>('SELECT COUNT(*) FROM automation_definitions')).toBe(0);
      await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_SECS * 1000);
      expect(spawns).toHaveLength(0);
      expect(db.pluck<number>('SELECT COUNT(*) FROM automation_definitions')).toBe(0);
      // startupGate ready（全部 finalizer 成功）之后照常初始化并开始 tick，重装的调度器不会永远停着。
      gate.markStartupReady();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(db.pluck<number>('SELECT COUNT(*) FROM automation_definitions WHERE id = ?1', ['auto_legacy'])).toBe(1);
      await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_SECS * 1000);
      expect(spawns).toHaveLength(1);
    } finally {
      await host.unload('dstu.agent-orchestration');
      vi.useRealTimers();
      storage.dispose();
      await host.dispose();
    }
  });

  it('V09-P1-3 a registration after F3 started (FINALIZER_LATE_REGISTRATION) initializes and ticks only once the startup gate is ready', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const host = await createTestHost({ contracts });
    const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
    const db = storage.database('mistakes');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    for (const name of ['V20260714__automation_scheduler.sql', 'V20260715__harden_automation_runtime.sql', 'V20260721__trusted_automation_profile.sql']) {
      db.exec(readFileSync(new URL(`../../../../resources/app/migrations/mistakes/${name}`, import.meta.url), 'utf8'));
    }
    const settings = createSettingsStore({ db: () => db, secureStore: () => null, isSensitiveKey: () => false });
    settings.save('chat_v2.automations', JSON.stringify([{
      id: 'auto_legacy', name: 'Legacy', schedule: { kind: 'daily', time: '09:00' },
      prompt: 'legacy prompt', enabled: true, created_at: '2026-01-01T00:00:00+00:00', session_id: '',
    }]));
    const lifecycle = createFinalizerRegistry(storage);
    lifecycle.markRunStarted();
    const gate = createStartupGateFixture();
    const spawns: number[] = [];
    host.ctx.provide('settings', settings);
    host.ctx.provide('storage', lifecycle.storageProbe);
    host.ctx.provide('startupGate', gate);
    host.ctx.provide('backgroundTasks', {
      get size() { return spawns.length; },
      spawn<T>(_task: () => Promise<T>): Promise<T> | null { spawns.push(1); return null; },
      async shutdown() {},
    });
    try {
      await host.install(plugin);
      expect(lifecycle.state).toBe('running');
      expect(db.pluck<number>('SELECT COUNT(*) FROM automation_definitions')).toBe(0);
      await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_SECS * 1000);
      expect(spawns).toHaveLength(0);
      expect(db.pluck<number>('SELECT COUNT(*) FROM automation_definitions')).toBe(0);
      gate.markStartupReady();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(db.pluck<number>('SELECT COUNT(*) FROM automation_definitions WHERE id = ?1', ['auto_legacy'])).toBe(1);
      await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_SECS * 1000);
      expect(spawns).toHaveLength(1);
    } finally {
      await host.unload('dstu.agent-orchestration');
      vi.useRealTimers();
      storage.dispose();
      await host.dispose();
    }
  });

  it('ticks after the real F3 runStartupFinalizers and startup gate ready', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const host = await createTestHost({ contracts });
    const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
    const db = storage.database('mistakes');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    for (const name of ['V20260714__automation_scheduler.sql', 'V20260715__harden_automation_runtime.sql', 'V20260721__trusted_automation_profile.sql']) {
      db.exec(readFileSync(new URL(`../../../../resources/app/migrations/mistakes/${name}`, import.meta.url), 'utf8'));
    }
    const settings = createSettingsStore({ db: () => db, secureStore: () => null, isSensitiveKey: () => false });
    const spawns: number[] = [];
    host.ctx.provide('settings', settings);
    host.ctx.provide('storage', storage);
    host.ctx.provide('backgroundTasks', {
      get size() { return spawns.length; },
      spawn<T>(_task: () => Promise<T>): Promise<T> | null { spawns.push(1); return null; },
      async shutdown() {},
    });
    const gate = createStartupGateFixture();
    host.ctx.provide('startupGate', gate);
    try {
      await host.install(plugin);
      await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_SECS * 1000);
      expect(spawns).toHaveLength(0);
      // Composition-root order (host/kernel/connection.ts:117-122): real F3 registry, then the gate.
      await storage.runStartupFinalizers();
      await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_SECS * 1000);
      expect(spawns).toHaveLength(0);
      gate.markStartupReady();
      await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_SECS * 1000);
      expect(spawns).toHaveLength(1);
    } finally {
      await host.unload('dstu.agent-orchestration');
      vi.useRealTimers();
      storage.dispose();
      await host.dispose();
    }
  });

  it('V09-P1-3 install -> runStartupFinalizers -> unload -> install again starts the scheduler and the super session startup', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const host = await createTestHost({ contracts });
    const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
    const db = storage.database('mistakes');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    for (const name of ['V20260714__automation_scheduler.sql', 'V20260715__harden_automation_runtime.sql', 'V20260721__trusted_automation_profile.sql']) {
      db.exec(readFileSync(new URL(`../../../../resources/app/migrations/mistakes/${name}`, import.meta.url), 'utf8'));
    }
    const settings = createSettingsStore({ db: () => db, secureStore: () => null, isSensitiveKey: () => false });
    const spawns: number[] = [];
    host.ctx.provide('settings', settings);
    host.ctx.provide('storage', storage);
    host.ctx.provide('backgroundTasks', {
      get size() { return spawns.length; },
      spawn<T>(_task: () => Promise<T>): Promise<T> | null { spawns.push(1); return null; },
      async shutdown() {},
    });
    const gate = createStartupGateFixture();
    host.ctx.provide('startupGate', gate);
    let installed = false;
    try {
      await host.install(plugin);
      installed = true;
      await storage.runStartupFinalizers();
      gate.markStartupReady();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_SECS * 1000);
      expect(spawns).toHaveLength(1);

      await host.unload('dstu.agent-orchestration');
      installed = false;
      await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_SECS * 1000);
      expect(spawns).toHaveLength(1);

      // state.rs:1025-1062 runs on every start; a legacy superagent.db that shows up is migrated by the reinstalled instance.
      const legacyDir = join(host.app.dataDir, 'superagent');
      mkdirSync(legacyDir, { recursive: true });
      const legacy = storage.openFile(join(legacyDir, 'superagent.db'));
      legacy.exec("CREATE TABLE sa_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO sa_kv (key,value) VALUES ('enabled','false')");
      storage.close(legacy);
      saveAutomations(db, [{ ...agentTurnAutomation(), id: 'auto_after_reload' }]);

      await host.install(plugin);
      installed = true;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settings.get('super_agent.enabled')).toBe('false');
      expect(existsSync(join(legacyDir, 'superagent.db.legacy'))).toBe(true);
      await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_SECS * 1000);
      expect(spawns).toHaveLength(2);
    } finally {
      if (installed) await host.unload('dstu.agent-orchestration');
      vi.useRealTimers();
      storage.dispose();
      await host.dispose();
    }
  });

  it('does not initialize or tick when an earlier startup finalizer fails', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const host = await createTestHost({ contracts });
    const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
    const db = storage.database('mistakes');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    for (const name of ['V20260714__automation_scheduler.sql', 'V20260715__harden_automation_runtime.sql', 'V20260721__trusted_automation_profile.sql']) {
      db.exec(readFileSync(new URL(`../../../../resources/app/migrations/mistakes/${name}`, import.meta.url), 'utf8'));
    }
    const settings = createSettingsStore({ db: () => db, secureStore: () => null, isSensitiveKey: () => false });
    settings.save('chat_v2.automations', JSON.stringify([{
      id: 'auto_legacy', name: 'Legacy', schedule: { kind: 'daily', time: '09:00' },
      prompt: 'legacy prompt', enabled: true, created_at: '2026-01-01T00:00:00+00:00', session_id: '',
    }]));
    const lifecycle = createFinalizerRegistry(storage);
    lifecycle.register('earlier.failing', () => { throw new Error('startup boom'); });
    const spawns: number[] = [];
    host.ctx.provide('settings', settings);
    host.ctx.provide('storage', lifecycle.storageProbe);
    host.ctx.provide('backgroundTasks', {
      get size() { return spawns.length; },
      spawn<T>(_task: () => Promise<T>): Promise<T> | null { spawns.push(1); return null; },
      async shutdown() {},
    });
    try {
      await host.install(plugin);
      await expect(lifecycle.runStartupFinalizers()).rejects.toThrow('startup boom');
      expect(db.pluck<number>('SELECT COUNT(*) FROM automation_definitions')).toBe(0);
      await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_SECS * 1000);
      expect(spawns).toHaveLength(0);
    } finally {
      await host.unload('dstu.agent-orchestration');
      vi.useRealTimers();
      storage.dispose();
      await host.dispose();
    }
  });

  it('run_now maps a tripped kill switch to a validation command error', async () => {
    const { host, storage } = await fixture();
    host.ctx.provide('chatState', {
      killSwitch: {
        ensureAllowed() { throw new Error('AgentKillSwitch tripped: all agent activity is stopped.'); },
      },
    });
    try {
      let caught: unknown;
      try {
        await host.invoke('chat_v2_automation_run_now', { automationId: 'auto_test', expectedVersion: 1 });
      } catch (error) { caught = error; }
      expect(caught).toBe('{"code":"VALIDATION_ERROR","message":"AgentKillSwitch tripped: all agent activity is stopped."}');
      expect(caught).not.toBeInstanceOf(HandlerPanic);
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('run_now executes agent_turn through the published headless runner and emits completion', async () => {
    const host = await createTestHost({ contracts });
    const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
    const db = storage.database('mistakes');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    for (const name of ['V20260714__automation_scheduler.sql', 'V20260715__harden_automation_runtime.sql', 'V20260721__trusted_automation_profile.sql']) {
      db.exec(readFileSync(new URL(`../../../../resources/app/migrations/mistakes/${name}`, import.meta.url), 'utf8'));
    }
    const settings = createSettingsStore({ db: () => db, secureStore: () => null, isSensitiveKey: () => false });
    host.ctx.provide('settings', settings);
    host.ctx.provide('storage', storage);
    host.ctx.provide('chatState', {
      killSwitch: { ensureAllowed() {}, isTripped() { return false; } },
    });
    host.ctx.provide('chatSession', {
      runHeadlessTurn: async () => ({
        sessionId: 'sess_headless', assistantMessageId: 'msg_headless', status: 'completed',
        summary: 'headless finished', durationMs: 1,
      }),
      runHeadlessAgentTurn: async () => ({
        sessionId: 'sess_wake', assistantMessageId: 'msg_wake', content: 'ok', durationMs: 1,
      }),
    });
    await host.install(plugin);
    try {
      saveAutomations(db, [agentTurnAutomation()]);
      const result = await host.invoke<Record<string, unknown>>('chat_v2_automation_run_now', {
        automationId: 'auto_agent', expectedVersion: 1,
      });
      expect(result.status).toBe('started');
      await waitFor(() => host.eventsNamed('chat_v2_automation_run_completed').length === 1);
      const run = listAutomationRuns(db, 'auto_agent', 10)[0]!;
      expect(run.summary).toBe('headless finished');
      expect(run.session_id).toBe('sess_headless');
      expect(host.eventsNamed('chat_v2_automation_run_completed')).toEqual([
        expect.objectContaining({
          automationId: 'auto_agent', sessionId: 'sess_headless', status: 'success',
          summary: 'headless finished', heartbeat: false,
        }),
      ]);
      expect(host.eventsNamed('chat_v2://automations_changed')).toEqual([
        { action: 'run_now', automationId: 'auto_agent' },
        { action: 'run_completed', automationId: 'auto_agent' },
      ]);
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('run_now notify delivers the VFS todo through the published vfsRepo service', async () => {
    const host = await createTestHost({
      contracts,
      shell: (op) => {
        if (op === 'plugin:notification|notify') return null;
        if (op === 'plugin:window|is_focused' || op === 'plugin:window|is_visible') return true;
        if (op === 'plugin:window|is_minimized') return false;
        throw new Error(`unexpected shell request ${op}`);
      },
    });
    const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
    const db = storage.database('mistakes');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    for (const name of ['V20260714__automation_scheduler.sql', 'V20260715__harden_automation_runtime.sql', 'V20260721__trusted_automation_profile.sql']) {
      db.exec(readFileSync(new URL(`../../../../resources/app/migrations/mistakes/${name}`, import.meta.url), 'utf8'));
    }
    const vfs = storage.database('vfs');
    vfs.exec('CREATE TABLE todo_lists (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
    vfs.exec(`CREATE TABLE todo_items (
      id TEXT PRIMARY KEY, todo_list_id TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT, priority TEXT NOT NULL DEFAULT 'none', reminder TEXT)`);
    vfs.exec(`CREATE TABLE automation_todo_deliveries (
      run_id TEXT PRIMARY KEY NOT NULL, todo_item_id TEXT NOT NULL, created_at TEXT NOT NULL)`);
    const settings = createSettingsStore({ db: () => db, secureStore: () => null, isSensitiveKey: () => false });
    host.ctx.provide('settings', settings);
    host.ctx.provide('storage', storage);
    host.ctx.provide('chatState', {
      killSwitch: { ensureAllowed() {}, isTripped() { return false; } },
    });
    const notificationRequests: SystemNotificationRequest[] = [];
    host.ctx.provide('systemNotification', {
      policy: () => 'background',
      notificationsDisabled: () => false,
      notify: async (request: SystemNotificationRequest) => {
        notificationRequests.push(request);
        return { delivered: true, suppressed: null, error: null };
      },
    });
    let todoListLookups = 0;
    host.ctx.provide('vfsRepo', {
      todos: {
        ensureDefaultInbox(conn: {
          get<T>(sql: string): T | undefined;
          run(sql: string, params?: unknown[]): unknown;
        }) {
          todoListLookups += 1;
          const existing = conn.get<{ id: string }>("SELECT id FROM todo_lists WHERE id = 'inbox'");
          if (existing !== undefined) return existing;
          conn.run("INSERT INTO todo_lists (id, title) VALUES ('inbox', '收件箱')");
          return { id: 'inbox' };
        },
        createTodoItem(conn: { run(sql: string, params: unknown[]): unknown }, params: {
          todoListId: string; title: string; description?: string | null;
          priority?: string; reminder?: string | null;
        }) {
          const id = `ti_${Date.now()}`;
          conn.run('INSERT INTO todo_items (id, todo_list_id, title, description, priority, reminder) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
            [id, params.todoListId, params.title, params.description ?? null, params.priority ?? 'none', params.reminder ?? null]);
          return { id };
        },
      },
    });
    await host.install(plugin);
    const notifyAutomation: AutomationDefinition = {
      ...agentTurnAutomation(), id: 'auto_notify', name: 'Notify run',
      action_type: 'notify', session_mode: null, agent_prompt: null, prompt: 'Summarize mistakes',
    };
    try {
      saveAutomations(db, [notifyAutomation]);
      const result = await host.invoke<Record<string, unknown>>('chat_v2_automation_run_now', {
        automationId: 'auto_notify', expectedVersion: 1,
      });
      expect(result.status).toBe('started');
      await waitFor(() => listAutomationRuns(db, 'auto_notify', 10).some((run) => run.status !== 'running'));
      const run = listAutomationRuns(db, 'auto_notify', 10)[0]!;
      expect(run.status).toBe('success');
      expect(run.delivered).toEqual(expect.arrayContaining(['notification', 'todo']));
      expect(todoListLookups).toBe(1);
      expect(vfs.all('SELECT title, description FROM todo_items')).toEqual([
        { title: 'Notify run', description: 'Summarize mistakes' },
      ]);
      expect(host.eventsNamed('todo://changed')).toEqual([
        { source: 'automation', action: 'create_item' },
      ]);
      expect(host.eventsNamed('chat_v2://automations_changed')).toEqual([
        { action: 'run_now', automationId: 'auto_notify' },
        { action: 'run_completed', automationId: 'auto_notify' },
      ]);
      expect(notificationRequests).toEqual([{
        id: expect.any(Number),
        title: notificationTitleRunning('zh', 'Notify run'),
        body: truncatePromptForNotification('Summarize mistakes', 'zh'),
        suppressIfWindowActive: false,
      }]);
      expect(host.shellRequests.filter((request) => request.op === 'plugin:notification|notify')).toEqual([]);
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('retry command preserves delivered receipts for notify and clears them for agent turns', async () => {
    const { host, storage, db } = await fixture();
    try {
      for (const action of ['notify', 'agent_turn']) {
        db.run(`INSERT INTO automation_definitions(id,name,schedule_json,created_at,updated_at,action_type)
          VALUES (?1,'a','{"kind":"daily","time":"09:00"}','2026-01-01','2026-01-01',?2)`, [action, action]);
        db.run(`INSERT INTO automation_runs(id,automation_id,dedupe_key,scheduled_for,status,attempt,max_attempts,delivered_json,created_at,updated_at)
          VALUES (?1,?1,?1,'2026-01-01','error',3,3,'["todo"]','2026-01-01','2026-01-01')`, [action]);
        await expect(host.invoke('chat_v2_automation_retry_run', { runId: action })).resolves.toEqual({ success: true, runId: action });
        expect(db.get('SELECT status,trigger_type,retry_requested,max_attempts,delivered_json FROM automation_runs WHERE id=?1', [action]))
          .toEqual({ status: 'retrying', trigger_type: 'retry', retry_requested: 1, max_attempts: 4, delivered_json: action === 'notify' ? '["todo"]' : '[]' });
      }
      await expect(host.invoke('chat_v2_automation_retry_run', { runId: 'absent' }))
        .rejects.toBe('{"code":"VALIDATION_ERROR","message":"Run is not retryable"}');
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });
});
