import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { SleepBlockData, WakeCondition } from '../api.ts';
import { WorkspaceDatabase } from '../src/workspace/database.ts';
import type { WorkspaceStoreIo } from '../src/workspace/database.ts';
import {
  SleepManager, newSleepBlockData, wakeConditionJson, withTimeout,
} from '../src/workspace/sleep-manager.ts';
import { saveSleep } from '../repository/sleep-repository.ts';

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

const io: WorkspaceStoreIo = {
  open: openSqlite,
  close: executor => {
    const db = handles.get(executor);
    if (db) db.close();
  },
};

const COORD = 'coord_sess';
const WORKER = 'worker_sess';

let databaseCounter = 0;

function setupManager(): { dir: string; manager: SleepManager; database: WorkspaceDatabase } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-sleep-manager-'));
  databaseCounter += 1;
  const db = WorkspaceDatabase.create(io, dir, `ws_test${databaseCounter}`);
  const connection = db.getConnection();
  const now = new Date().toISOString();
  connection.run(
    "INSERT INTO workspace (id, name, status, creator_session_id, created_at, updated_at) VALUES (?1, 'test', 'active', ?2, ?3, ?3)",
    [db.workspaceId, COORD, now],
  );
  for (const [sessionId, role] of [[COORD, 'coordinator'], [WORKER, 'worker']] as const) {
    connection.run(
      "INSERT INTO agent (session_id, workspace_id, role, status, joined_at, last_active_at) VALUES (?1, ?2, ?3, 'idle', ?4, ?4)",
      [sessionId, db.workspaceId, role, now],
    );
  }
  return { dir, manager: new SleepManager(connection), database: db };
}

function setAgentStatus(database: WorkspaceDatabase, sessionId: string, status: string): void {
  database.getConnection().run('UPDATE agent SET status = ?1 WHERE session_id = ?2', [status, sessionId]);
}

/** 向 coordinator 的 inbox 插入一条未读消息（模拟 worker 在睡眠创建前发出的消息）。 */
function insertUnreadInboxMessage(
  database: WorkspaceDatabase,
  messageType: string,
  content: string,
): void {
  const connection = database.getConnection();
  const now = new Date().toISOString();
  const messageId = `wsmsg_${crypto.randomUUID()}`;
  connection.run(
    `INSERT INTO message (id, workspace_id, sender_session_id, target_session_id,
     message_type, content, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'delivered', ?7)`,
    [messageId, database.workspaceId, WORKER, COORD, messageType, content, now],
  );
  connection.run(
    "INSERT INTO inbox (session_id, message_id, priority, status, created_at) VALUES (?1, ?2, 0, 'unread', ?3)",
    [COORD, messageId, now],
  );
}

function makeSleepData(database: WorkspaceDatabase, wakeCondition: WakeCondition): SleepBlockData {
  // 不设置 timeout_at，避免测试依赖真实计时（spawn_timeout_task）。
  return newSleepBlockData(database.workspaceId, COORD, [WORKER], wakeCondition);
}

describe('sleep_manager', () => {
  it.each(['result_message', 'all_completed'] as const)(
    'wakes %s sleep when the awaited worker is closed',
    (type) => {
      const { dir, manager, database } = setupManager();
      try {
        const data = makeSleepData(database, { type });
        const receiver = manager.beginSleep(data);
        setAgentStatus(database, WORKER, 'closed');

        const awakened = manager.checkAndWakeByAgentStatus(database.workspaceId, WORKER, 'closed');
        expect(awakened).toHaveLength(1);
        expect(receiver.tryRecv()?.reason).toBe('all_completed');
        expect(manager.getSleep(data.id)?.status).toBe('awakened');
        expect(manager.isSleepActive(data.id)).toBe(false);
      } finally {
        manager.cancelAllActive('test_cleanup');
        database.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('initial check wakes when the awaited worker was already closed', () => {
    const { dir, manager, database } = setupManager();
    try {
      setAgentStatus(database, WORKER, 'closed');
      const data = makeSleepData(database, { type: 'result_message' });
      const receiver = manager.beginSleep(data);
      expect(manager.checkInitialWakeConditions(data.id)).toHaveLength(1);
      expect(receiver.tryRecv()?.reason).toBe('all_completed');
    } finally {
      manager.cancelAllActive('test_cleanup');
      database.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('initial_check_wakes_when_result_arrived_before_sleep', () => {
    const { manager, database } = setupManager();
    insertUnreadInboxMessage(database, 'result', '早到的结果');

    const data = makeSleepData(database, { type: 'result_message' });
    const receiver = manager.beginSleep(data);

    const awakened = manager.checkInitialWakeConditions(data.id);
    expect(awakened).toHaveLength(1);
    expect(awakened[0]!.wakeReason).toBe('message');
    expect(awakened[0]!.awakenedBy).toBe(WORKER);

    const payload = receiver.tryRecv()!;
    expect(payload.reason).toBe('message');
    expect(payload.message?.content).toBe('早到的结果');

    // 与正常唤醒同路径：DB 状态被更新，active_sleeps 中已移除。
    const stored = manager.getSleep(data.id)!;
    expect(stored.status).toBe('awakened');
    expect(manager.isSleepActive(data.id)).toBe(false);
  });

  it('initial_check_wakes_when_agents_already_terminal', () => {
    const { manager, database } = setupManager();
    // worker 在睡眠创建前就已进入终态（含 cancelled）。
    setAgentStatus(database, WORKER, 'cancelled');

    const data = makeSleepData(database, { type: 'result_message' });
    const receiver = manager.beginSleep(data);

    const awakened = manager.checkInitialWakeConditions(data.id);
    expect(awakened).toHaveLength(1);
    expect(awakened[0]!.wakeReason).toBe('all_completed');

    const payload = receiver.tryRecv()!;
    expect(payload.reason).toBe('all_completed');
    expect(manager.getSleep(data.id)!.status).toBe('awakened');
  });

  it('initial_check_does_not_wake_without_conditions', () => {
    const { manager, database } = setupManager();
    setAgentStatus(database, WORKER, 'running');
    // inbox 中只有 progress 消息，不满足 ResultMessage 条件。
    insertUnreadInboxMessage(database, 'progress', '进行中');

    const data = makeSleepData(database, { type: 'result_message' });
    const receiver = manager.beginSleep(data);

    expect(manager.checkInitialWakeConditions(data.id)).toEqual([]);
    expect(receiver.tryRecv()).toBeNull();

    // 正常睡眠不受影响。
    expect(manager.isSleepActive(data.id)).toBe(true);
    expect(manager.getSleep(data.id)!.status).toBe('sleeping');
  });

  it('agent_status_wake_treats_cancelled_as_terminal', () => {
    const { manager, database } = setupManager();
    const data = makeSleepData(database, { type: 'result_message' });
    const receiver = manager.beginSleep(data);

    // worker 被取消 → 应触发 all-terminal 唤醒而不是睡到超时。
    setAgentStatus(database, WORKER, 'cancelled');
    const awakened = manager.checkAndWakeByAgentStatus(database.workspaceId, WORKER, 'cancelled');
    expect(awakened).toHaveLength(1);
    expect(awakened[0]!.wakeReason).toBe('all_completed');

    const payload = receiver.tryRecv()!;
    expect(payload.reason).toBe('all_completed');
  });

  // 端到端模拟 sleep_executor 的生产路径：消息在 begin_sleep 之前已到 →
  // 初始检查触发唤醒 → wait_for_wake 立即完成。
  it('executor_flow_initial_check_then_wait_completes_immediately', async () => {
    const { manager, database } = setupManager();
    insertUnreadInboxMessage(database, 'result', '早到的结果');

    const data = makeSleepData(database, { type: 'result_message' });
    const receiver = manager.beginSleep(data);

    const awakened = manager.checkInitialWakeConditions(data.id);
    expect(awakened).toHaveLength(1);
    expect(awakened[0]!.wakeReason).toBe('message');

    const payload = await Promise.race([
      SleepManager.waitForWake(receiver, data.id),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('waitForWake must complete immediately')), 200);
      }),
    ]);
    expect(payload.reason).toBe('message');
    expect(payload.message?.content).toBe('早到的结果');
    expect(manager.getSleep(data.id)!.status).toBe('awakened');
  });

  it('cancel_all_active_cancels_and_is_idempotent', () => {
    const { manager, database } = setupManager();
    const dataA = makeSleepData(database, { type: 'result_message' });
    const dataB = makeSleepData(database, { type: 'any_message' });
    const receiverA = manager.beginSleep(dataA);
    const receiverB = manager.beginSleep(dataB);

    expect(manager.cancelAllActive('workspace_closed')).toBe(2);

    for (const receiver of [receiverA, receiverB]) {
      const payload = receiver.tryRecv()!;
      expect(payload.reason).toBe('cancelled');
      expect(payload.awakenedBy).toBe('system');
    }

    expect(manager.isSleepActive(dataA.id)).toBe(false);
    expect(manager.isSleepActive(dataB.id)).toBe(false);
    for (const id of [dataA.id, dataB.id]) {
      const stored = manager.getSleep(id)!;
      expect(stored.status).toBe('cancelled');
      expect(stored.awakenMessage).toBe('workspace_closed');
    }

    // 幂等：再次调用无副作用。
    expect(manager.cancelAllActive('workspace_closed')).toBe(0);
  });

  it('cancel_all_active_aborts_timeout_tasks', () => {
    const { manager, database } = setupManager();
    const data = withTimeout(makeSleepData(database, { type: 'result_message' }), 60_000);
    const receiver = manager.beginSleep(data);

    expect(manager.timeoutTaskIds()).toContain(data.id);

    expect(manager.cancelAllActive('test_shutdown')).toBe(1);
    const payload = receiver.tryRecv()!;
    expect(payload.reason).toBe('cancelled');
    expect(manager.timeoutTaskIds()).toEqual([]);
  });

  it('restore_and_activate_sleeps_is_idempotent', () => {
    const { manager, database } = setupManager();
    const data = makeSleepData(database, { type: 'result_message' });
    // 仅持久化（模拟重启前遗留的 sleeping 记录），不注册 active_sleeps。
    saveSleep(database.getConnection(), {
      id: data.id,
      workspaceId: data.workspaceId,
      coordinatorSessionId: data.coordinatorSessionId,
      awaitingAgentsJson: JSON.stringify(data.awaitingAgents),
      wakeConditionJson: wakeConditionJson(data.wakeCondition),
      status: data.status,
      timeoutAt: data.timeoutAt,
      createdAt: data.createdAt,
      messageId: data.messageId,
      blockId: data.blockId,
    });

    const first = manager.restoreAndActivateSleeps();
    expect(first).toHaveLength(1);

    // 第二次恢复（如 get_instance 并发重入）不应重复激活。
    expect(manager.restoreAndActivateSleeps()).toEqual([]);
    expect(manager.isSleepActive(data.id)).toBe(true);
  });
});
