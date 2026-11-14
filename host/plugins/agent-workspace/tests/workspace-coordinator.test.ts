import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { Workspace } from '../api.ts';
import { WorkspaceCoordinator, type WorkspaceCoordinatorOptions } from '../src/workspace/coordinator.ts';
import { newSleepBlockData } from '../src/workspace/sleep-manager.ts';
import { MAX_AGENTS_PER_WORKSPACE } from '../src/config.ts';

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

function setupCoordinator(options: Partial<WorkspaceCoordinatorOptions> = {}): { dir: string; coordinator: WorkspaceCoordinator; workspace: Workspace } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-coordinator-'));
  const coordinator = new WorkspaceCoordinator({ workspacesDir: dir, io, ...options });
  const workspace = coordinator.createWorkspace(COORD, 'test');
  coordinator.registerAgent(workspace.id, COORD, 'coordinator', null, null);
  return { dir, coordinator, workspace };
}

describe('workspace_coordinator', () => {
  it('missing governance guard rejects deletion before closing the workspace or cancelling sleeps', () => {
    const { coordinator, workspace, dir } = setupCoordinator();
    try {
      const sleeps = coordinator.getSleepManager(workspace.id);
      const data = newSleepBlockData(workspace.id, COORD, [], { type: 'result_message' });
      sleeps.beginSleep(data);
      const beforeFiles = fs.readdirSync(dir).sort();
      expect(() => coordinator.deleteWorkspace(workspace.id)).toThrow('governance.acquireOperationGuard');
      expect(coordinator.getWorkspace(workspace.id)?.status).toBe('active');
      expect(sleeps.isSleepActive(data.id)).toBe(true);
      expect(fs.readdirSync(dir).sort()).toEqual(beforeFiles);
    } finally {
      coordinator.closeWorkspace(workspace.id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('governance guard acquisition failure is propagated before any deletion', () => {
    const { coordinator, workspace, dir } = setupCoordinator({ operationGuard: () => { throw new Error('backup active'); } });
    try {
      expect(() => coordinator.deleteWorkspace(workspace.id)).toThrow('backup active');
      expect(coordinator.getWorkspace(workspace.id)?.status).toBe('active');
    } finally {
      coordinator.closeWorkspace(workspace.id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drain_inbox_marks_exact_drained_messages_processed', () => {
    const { coordinator, workspace } = setupCoordinator();
    coordinator.registerAgent(workspace.id, 'worker_1', 'worker', null, null);

    // 先发低优先级 result，再发高优先级 task：内存 FIFO 先取 result，
    // 而 DB 按 priority DESC 排序时 task 在前；旧实现的交集逻辑会漏标 result。
    const resultMessage = coordinator.sendMessage(
      workspace.id, 'worker_1', COORD, 'result', 'result content',
    );
    const taskMessage = coordinator.sendMessage(
      workspace.id, 'worker_1', COORD, 'task', 'task content',
    );

    const drained = coordinator.drainInbox(workspace.id, COORD, 1);
    expect(drained).toHaveLength(1);
    expect(drained[0]!.id).toBe(resultMessage.id);

    // DB 中只有被实际消费的 result 标记 processed，task 仍 unread。
    expect(coordinator.pendingInboxCount(workspace.id, COORD)).toBe(1);
    expect(coordinator.peekInbox(workspace.id, COORD).map(message => message.id))
      .toEqual([taskMessage.id]);

    // 再次 drain 取回 task 后收件箱清空（重启不会重复投喂）。
    const drainedAgain = coordinator.drainInbox(workspace.id, COORD, 10);
    expect(drainedAgain).toHaveLength(1);
    expect(drainedAgain[0]!.id).toBe(taskMessage.id);
    expect(coordinator.pendingInboxCount(workspace.id, COORD)).toBe(0);
  });

  it('peek_inbox_is_read_only_and_matches_drain_order', () => {
    const { coordinator, workspace } = setupCoordinator();
    coordinator.registerAgent(workspace.id, 'worker_1', 'worker', null, null);

    expect(coordinator.peekInbox(workspace.id, COORD)).toEqual([]);

    const resultMessage = coordinator.sendMessage(
      workspace.id, 'worker_1', COORD, 'result', 'result content',
    );
    const taskMessage = coordinator.sendMessage(
      workspace.id, 'worker_1', COORD, 'task', 'task content',
    );

    // 重复 peek 结果一致，且不改变收件箱状态。
    for (let round = 0; round < 2; round += 1) {
      expect(coordinator.peekInbox(workspace.id, COORD).map(message => message.id))
        .toEqual([resultMessage.id, taskMessage.id]);
    }
    expect(coordinator.pendingInboxCount(workspace.id, COORD)).toBe(2);
    expect(coordinator.hasPendingMessages(workspace.id, COORD)).toBe(true);

    // drain 的消费顺序与 peek 一致；drain 后 peek 反映剩余项。
    const drained = coordinator.drainInbox(workspace.id, COORD, 1);
    expect(drained[0]!.id).toBe(resultMessage.id);
    const remaining = coordinator.peekInbox(workspace.id, COORD);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(taskMessage.id);
  });

  it('close_workspace_cancels_active_sleeps', () => {
    const { coordinator, workspace } = setupCoordinator();
    const sleepManager = coordinator.getSleepManager(workspace.id);

    // 不设 timeout，避免依赖真实计时。
    const data = newSleepBlockData(workspace.id, COORD, [], { type: 'result_message' });
    const receiver = sleepManager.beginSleep(data);
    expect(sleepManager.isSleepActive(data.id)).toBe(true);

    coordinator.closeWorkspace(workspace.id);

    // 未决睡眠收到取消式唤醒，注册表被清空。
    const payload = receiver.tryRecv()!;
    expect(payload.reason).toBe('cancelled');
    expect(payload.awakenedBy).toBe('system');
    expect(sleepManager.isSleepActive(data.id)).toBe(false);
  });

  it('register_agent_quota_ignores_terminal_agents', () => {
    const { coordinator, workspace } = setupCoordinator();

    // 已注册 1 个 coordinator，再补足到 MAX_AGENTS_PER_WORKSPACE 个非终态 agent。
    for (let index = 1; index < MAX_AGENTS_PER_WORKSPACE; index += 1) {
      coordinator.registerAgent(workspace.id, `worker_${index}`, 'worker', null, null);
    }

    // 全部非终态 → 达到上限，注册被拒绝。
    expect(() => coordinator.registerAgent(workspace.id, 'worker_overflow', 'worker', null, null))
      .toThrow(/maximum active agent limit/);

    // 部分 worker 进入终态（completed/cancelled）后应释放配额。
    coordinator.updateAgentStatus(workspace.id, 'worker_1', 'completed');
    coordinator.updateAgentStatus(workspace.id, 'worker_2', 'cancelled');

    coordinator.registerAgent(workspace.id, 'worker_new_1', 'worker', null, null);
    coordinator.registerAgent(workspace.id, 'worker_new_2', 'worker', null, null);

    // 配额重新占满后再次拒绝。
    expect(() => coordinator.registerAgent(workspace.id, 'worker_overflow_2', 'worker', null, null))
      .toThrow();
  });
});
