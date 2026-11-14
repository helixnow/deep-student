import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createPaths } from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: acceptance loads the real L04 plugin entry, not a replacement chatState.
import chatPlugin from '../../chat/index.ts';
// boundary-allow cross-plugin-impl: acceptance loads the real L05 plugin entry to detect runtime dependency mismatches.
import workspacePlugin from '../../agent-workspace/index.ts';
// boundary-allow cross-plugin-impl: acceptance loads the real L11 owner; no test implementation of todo writes.
import reposPlugin from '../../vfs-repos/index.ts';
// boundary-allow cross-plugin-impl: real L10 owner is now a mandatory dependency of the real L13 plugin.
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: real L12 provider satisfies L13's mandatory vfsIndex dependency.
import indexPlugin from '../../vfs-index/index.ts';
// boundary-allow cross-plugin-impl: real L13 provider satisfies the real chat plugin dependency.
import vfsPlugin from '../../vfs/index.ts';
import { KILL_SWITCH_BLOCKED_MESSAGE } from '../../chat/api.ts';
import plugin from '../index.ts';

describe('O2/O3/O8 real L04/L05/L11/L13 plugin composition', () => {
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let storage: ReturnType<typeof createStorageService>;

  beforeAll(async () => {
    // Only the operating-system notification transport is replaced; all state,
    // repository methods and L06 dispatch run through installed production plugins.
    host = await createTestHost({ shell: op => {
      if (op === 'plugin:notification|notify') return null;
      throw new Error(`unexpected shell request: ${op}`);
    } });
    storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
    const report = await storage.migrations.runAll();
    if (!report.success) throw new Error(`migration failed: ${JSON.stringify(report)}`);
    host.ctx.provide('storage', storage);
    host.ctx.provide('settings', createSettingsStore({ db: () => storage.database('mistakes'),
      secureStore: () => null, isSensitiveKey: () => false }));
    host.ctx.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: 'linux',
      env: { HOME: host.app.dataDir, DEVICE_ID: 'l06-composition' } }));
    for (const entry of [reposPlugin, notesPlugin, indexPlugin, vfsPlugin, chatPlugin, workspacePlugin, plugin]) {
      await host.install(entry);
    }
  }, 120_000);

  afterAll(async () => { await host?.dispose(); storage?.dispose(); });

  it('O3 ensure-disabled leaves real chat and workspace stores untouched', async () => {
    expect(host.ctx.get('chatSession')).toBeDefined();
    expect(host.ctx.get('agentWorkspace')).toBeDefined();
    const db = storage.database('chat_v2');
    const before = db.pluck<number>('SELECT COUNT(*) FROM chat_v2_sessions');
    await expect(host.invoke('super_session_ensure')).resolves.toEqual({
      enabled: false, sessionId: null, workspaceId: null, pendingInbox: 0,
    });
    expect(db.pluck<number>('SELECT COUNT(*) FROM chat_v2_sessions')).toBe(before);
    expect(host.eventsNamed('super_session_changed')).toEqual([]);
  });

  it('O8 real chatState kill-switch rejects run_now before claiming a run', async () => {
    const db = storage.database('mistakes');
    const before = db.pluck<number>('SELECT COUNT(*) FROM automation_runs');
    host.ctx.chatState.killSwitch.trip('L06 composition');
    try {
      await expect(host.invoke('chat_v2_automation_run_now', { automationId: 'missing', expectedVersion: 1 }))
        .rejects.toBe(JSON.stringify({ code: 'VALIDATION_ERROR', message: KILL_SWITCH_BLOCKED_MESSAGE }));
      expect(db.pluck<number>('SELECT COUNT(*) FROM automation_runs')).toBe(before);
    } finally { host.ctx.chatState.killSwitch.reset(); }
  });

  async function runNotify(name: string) {
    const created = await host.invoke<{ automation: { id: string; version: number } }>(
      'chat_v2_automation_create', { request: { name, prompt: 'Review mistakes',
        schedule: { kind: 'daily', time: '09:00' }, enabled: false, maxRetries: 0 } });
    const started = await host.invoke<{ runId: string }>('chat_v2_automation_run_now', {
      automationId: created.automation.id, expectedVersion: created.automation.version,
    });
    await expect.poll(() => storage.database('mistakes').pluck<string>(
      'SELECT status FROM automation_runs WHERE id = ?1', [started.runId])).not.toBe('running');
    return started.runId;
  }

  it('O2 creates the real L11 todo and receipt before emitting todo://changed', async () => {
    const db = storage.database('vfs');
    const eventsBefore = host.eventsNamed('todo://changed').length;
    // A second storage service opens an independent connection, so it only sees
    // committed rows; the probe runs at the moment the event leaves the host.
    const observer = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
    const committedAtEvent: number[] = [];
    const events = host.events as unknown as { push: (...items: { event: string }[]) => number };
    const push = events.push;
    events.push = (...items) => {
      if (items.some((item) => item.event === 'todo://changed')) {
        committedAtEvent.push(observer.database('vfs').pluck<number>(`SELECT COUNT(*) FROM automation_todo_deliveries d
          JOIN todo_items t ON t.id = d.todo_item_id WHERE t.title = 'real owner success'`)!);
      }
      return push.apply(host.events, items as never);
    };
    const off = () => { events.push = push; observer.dispose(); };
    try {
      const runId = await runNotify('real owner success');
      expect(db.get(`SELECT t.title, t.description, t.priority FROM todo_items t
        JOIN automation_todo_deliveries d ON t.id = d.todo_item_id WHERE d.run_id = ?1`, [runId]))
        .toEqual({ title: 'real owner success', description: 'Review mistakes', priority: 'none' });
      expect(committedAtEvent).toEqual([1]);
      expect(host.eventsNamed('todo://changed').slice(eventsBefore))
        .toEqual([{ source: 'automation', action: 'create_item' }]);
    } finally { off(); }
  });

  it('V2-02 rolls back the owner todo when the delivery receipt INSERT fails', async () => {
    // Rust create_automation_todo:2596 returns before tx.commit(), so Drop rolls
    // back create_todo_item_with_conn as well; no todo event may be emitted.
    const db = storage.database('vfs');
    const eventsBefore = host.eventsNamed('todo://changed').length;
    const countBefore = db.pluck<number>('SELECT COUNT(*) FROM todo_items');
    db.exec(`CREATE TRIGGER l06_reject_receipt BEFORE INSERT ON automation_todo_deliveries
      BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END`);
    try {
      const runId = await runNotify('receipt failure');
      expect(db.pluck<number>('SELECT COUNT(*) FROM todo_items')).toBe(countBefore);
      expect(db.pluck<number>('SELECT COUNT(*) FROM automation_todo_deliveries WHERE run_id = ?1', [runId])).toBe(0);
      expect(host.eventsNamed('todo://changed')).toHaveLength(eventsBefore);
      expect(storage.database('mistakes').get('SELECT status, error FROM automation_runs WHERE id = ?1', [runId]))
        .toEqual({ status: 'error', error: 'Todo delivery failed' });
    } finally { db.exec('DROP TRIGGER l06_reject_receipt'); }
  });

  // Enables Super mode, so it stays last: the O3 case above relies on the disabled default.
  it('WP-274 g3w super_session_ensure.err_register_agent_quota replays on the real owners', async () => {
    type Step = { cmd: string; args: unknown; expect?: 'error' };
    const corpus = JSON.parse(readFileSync(new URL('../equivalence/g3w-agent-orchestration-01.json', import.meta.url), 'utf8')) as
      { scenarios: Array<{ id: string; steps: Step[] }> };
    const scenario = corpus.scenarios.find(entry => entry.id === 'g3w.agent-orchestration.super_session_ensure.err_register_agent_quota')!;
    const results: unknown[] = [];
    const resolve = (value: unknown): unknown => {
      if (typeof value === 'string') {
        return value.replace(/\$\{(\d+)\.(\w+)\}/g, (_, index: string, key: string) =>
          String((results[Number(index)] as Record<string, unknown>)[key]));
      }
      if (Array.isArray(value)) return value.map(resolve);
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, resolve(inner)]));
      }
      return value;
    };
    // workspace_create_agent registers only once an L03 `execute` exists; without initial_task it is never called.
    const executions: unknown[] = [];
    host.ctx.provide('chatPipeline', {
      execute: (...args: unknown[]) => { executions.push(args); throw new Error('worker pipeline must not run'); },
      attachChildToTree: () => { throw new Error('worker pipeline must not run'); },
    } as never);
    const last = scenario.steps.at(-1)!;
    for (const step of scenario.steps.slice(0, -1)) results.push(await host.invoke(step.cmd, resolve(step.args) as never));
    expect(last).toMatchObject({ cmd: 'super_session_ensure', expect: 'error' });
    await expect(host.invoke(last.cmd, resolve(last.args) as never))
      .rejects.toBe('Workspace has reached maximum active agent limit: 10');
    expect(executions).toEqual([]);
  });
});
