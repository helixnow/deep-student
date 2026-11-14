import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { WorkspaceCoordinator } from '../src/workspace/coordinator.ts';
import {
  InjectionThrottle, WorkspaceInjector, MAX_INJECTED_MESSAGE_CHARS,
} from '../api.ts';
import { INJECTION_COOLDOWN_MS } from '../src/config.ts';
import { newWorkspaceMessage } from '../src/workspace/types.ts';
import { monotonicMillis } from '../src/workspace/util.ts';

interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

const handles = new WeakMap<SqlExecutor, SqliteDatabase>();

function openSqlite(dbPath: string): SqlExecutor {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  const params = (value: unknown): unknown[] => {
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
  };
  const executor = {
    get: (sql: string, value?: unknown) => db.prepare(sql).get(...params(value)),
    one: (sql: string, value?: unknown) => {
      const row = db.prepare(sql).get(...params(value));
      if (row === undefined) throw new Error('Query returned no rows');
      return row;
    },
    pluck: (sql: string, value?: unknown) => {
      const row = db.prepare(sql).get(...params(value)) as Record<string, unknown> | undefined;
      return row === undefined ? undefined : Object.values(row)[0];
    },
    all: (sql: string, value?: unknown) => db.prepare(sql).all(...params(value)),
    iterate: (sql: string, value?: unknown) => db.prepare(sql).iterate(...params(value)),
    run: (sql: string, value?: unknown) => db.prepare(sql).run(...params(value)),
    exec: (sql: string) => { db.exec(sql); },
  } as unknown as SqlExecutor;
  handles.set(executor, db);
  return executor;
}

const io = {
  open: openSqlite,
  close: (executor: SqlExecutor) => {
    const db = handles.get(executor);
    if (db) db.close();
  },
};

const COORD = 'coord_sess';
const WORKER = 'worker_sess';

function setup(): { coordinator: WorkspaceCoordinator; workspaceId: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-injector-'));
  const coordinator = new WorkspaceCoordinator({ workspacesDir: dir, io });
  const workspace = coordinator.createWorkspace(COORD, 'test');
  coordinator.registerAgent(workspace.id, COORD, 'coordinator', null, null);
  coordinator.registerAgent(workspace.id, WORKER, 'worker', null, null);
  return { coordinator, workspaceId: workspace.id };
}

function sendResult(coordinator: WorkspaceCoordinator, workspaceId: string, content: string): void {
  coordinator.sendMessage(workspaceId, WORKER, COORD, 'result', content);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('workspace_injector', () => {
  it('throttle_enforces_cooldown_between_injections', async () => {
    const { coordinator, workspaceId } = setup();
    const injector = new WorkspaceInjector(coordinator);
    const throttle = new InjectionThrottle();

    sendResult(coordinator, workspaceId, 'first');
    const first = injector.checkAndInject(throttle, workspaceId, COORD, 5);
    expect(first.messages).toHaveLength(1);
    expect(throttle.injectionCount).toBe(1);

    // 冷却期内（50ms）第二次检查被节流，即使 inbox 有新消息。
    // 固定 last_injection 为“刚刚”，消除中间 DB 操作耗时导致的时序抖动。
    sendResult(coordinator, workspaceId, 'second');
    throttle.lastInjection = monotonicMillis();
    const second = injector.checkAndInject(throttle, workspaceId, COORD, 5);
    expect(second.messages).toEqual([]);
    expect(throttle.injectionCount).toBe(1);

    // 冷却期过后可再次注入。
    await sleep(INJECTION_COOLDOWN_MS + 20);
    const third = injector.checkAndInject(throttle, workspaceId, COORD, 5);
    expect(third.messages).toHaveLength(1);
    expect(throttle.injectionCount).toBe(2);
  });

  it('throttle_enforces_max_injections_per_round', async () => {
    const { coordinator, workspaceId } = setup();
    const injector = new WorkspaceInjector(coordinator);
    const throttle = new InjectionThrottle();

    sendResult(coordinator, workspaceId, 'first');
    const first = injector.checkAndInject(throttle, workspaceId, COORD, 1);
    expect(first.messages).toHaveLength(1);

    // 轮次上限已达：冷却期过后仍不再注入。
    sendResult(coordinator, workspaceId, 'second');
    await sleep(INJECTION_COOLDOWN_MS + 20);
    const second = injector.checkAndInject(throttle, workspaceId, COORD, 1);
    expect(second.messages).toEqual([]);
    expect(throttle.injectionCount).toBe(1);

    // reset_count 后恢复注入能力。
    throttle.resetCount();
    const third = injector.checkAndInject(throttle, workspaceId, COORD, 1);
    expect(third.messages).toHaveLength(1);
  });

  it('fresh_throttle_per_call_would_not_throttle_but_shared_one_does', () => {
    const { coordinator, workspaceId } = setup();
    const injector = new WorkspaceInjector(coordinator);

    // 复现旧缺陷的对照：每次新建 throttle 不会被节流；共享 throttle 才会。
    sendResult(coordinator, workspaceId, 'a');
    const shared = new InjectionThrottle();
    const first = injector.checkAndInject(shared, workspaceId, COORD, 5);
    expect(first.messages).toHaveLength(1);

    sendResult(coordinator, workspaceId, 'b');
    const fresh = new InjectionThrottle();
    const withFresh = injector.checkAndInject(fresh, workspaceId, COORD, 5);
    // 新 throttle 无冷却记录 → 立即注入（这正是旧实现节流失效的原因）。
    expect(withFresh.messages).toHaveLength(1);

    sendResult(coordinator, workspaceId, 'c');
    // 固定冷却起点，消除时序抖动。
    shared.lastInjection = monotonicMillis();
    const withShared = injector.checkAndInject(shared, workspaceId, COORD, 5);
    // 共享 throttle 处于冷却期 → 被正确节流。
    expect(withShared.messages).toEqual([]);
  });

  it('format_truncates_long_message_content', () => {
    const longContent = '长'.repeat(MAX_INJECTED_MESSAGE_CHARS + 100);
    const message = newWorkspaceMessage(
      'ws_x', WORKER, COORD, 'result', longContent,
    );

    const formatted = WorkspaceInjector.formatInjectedMessages([message]);
    expect(formatted).toContain('…[truncated]');
    expect(formatted.split('长').length - 1).toBe(MAX_INJECTED_MESSAGE_CHARS);
  });

  it('format_keeps_short_message_content_intact', () => {
    const message = newWorkspaceMessage(
      'ws_x', WORKER, COORD, 'progress', '短消息内容',
    );

    const formatted = WorkspaceInjector.formatInjectedMessages([message]);
    expect(formatted).toContain('短消息内容');
    expect(formatted).not.toContain('[truncated]');
  });
});
