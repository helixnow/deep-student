import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { WorkspaceDatabase } from '../src/workspace/database.ts';
import type { WorkspaceStoreIo } from '../src/workspace/database.ts';
import {
  SubagentTaskError, SubagentTaskManager, newSubagentTask,
} from '../src/workspace/subagent-task.ts';
import type { SubagentTaskData } from '../api.ts';

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

let workspaceCounter = 0;

function setupManager(): { dir: string; manager: SubagentTaskManager; database: WorkspaceDatabase } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-subagent-task-'));
  workspaceCounter += 1;
  const db = WorkspaceDatabase.create(io, dir, `ws_test${workspaceCounter}`);
  const connection = db.getConnection();
  const now = new Date().toISOString();
  connection.run(
    "INSERT INTO workspace (id, name, status, creator_session_id, created_at, updated_at) VALUES (?1, ?2, 'active', ?3, ?4, ?4)",
    [`ws_test${workspaceCounter}`, 'test', 'creator_sess', now],
  );
  return { dir, manager: new SubagentTaskManager(connection), database: db };
}

function makeTask(manager: SubagentTaskManager, database: WorkspaceDatabase): SubagentTaskData {
  const agentSessionId = `agent_${crypto.randomUUID()}`;
  const connection = database.getConnection();
  const now = new Date().toISOString();
  connection.run(
    "INSERT INTO agent (session_id, workspace_id, role, status, joined_at, last_active_at) VALUES (?1, ?2, 'worker', 'idle', ?3, ?3)",
    [agentSessionId, database.workspaceId, now],
  );
  const task = newSubagentTask(database.workspaceId, agentSessionId, null, 'test task');
  manager.createTask(task);
  return task;
}

describe('subagent_task', () => {
  it('normalizes persisted timestamps through platform time without losing nanos or optional-null semantics', () => {
    const { manager, database, dir } = setupManager();
    try {
      const task = makeTask(manager, database);
      const db = database.getConnection();
      db.run('UPDATE subagent_task SET created_at = ?1, started_at = ?2, completed_at = ?3 WHERE id = ?4', [
        '2026-11-03T08:00:00.123456789+08:00', '2026-11-03T01:00:00.120Z', 'invalid', task.id,
      ]);
      const loaded = manager.getTask(task.id)!;
      expect(loaded.createdAt).toBe('2026-11-03T00:00:00.123456789+00:00');
      expect(loaded.startedAt).toBe('2026-11-03T01:00:00.120+00:00');
      expect(loaded.completedAt).toBeNull();
      db.run('UPDATE subagent_task SET started_at = NULL, created_at = ?1 WHERE id = ?2', [
        '2026-02-30T00:00:00Z', task.id,
      ]);
      expect(() => manager.getTask(task.id)).toThrow('Invalid RFC3339 in created_at');
    } finally {
      database.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is_valid_transition_pending_outbound', () => {
    expect(SubagentTaskManager.isValidTransition('pending', 'running')).toBe(true);
    expect(SubagentTaskManager.isValidTransition('pending', 'cancelled')).toBe(true);
    expect(SubagentTaskManager.isValidTransition('pending', 'failed')).toBe(true);
    expect(SubagentTaskManager.isValidTransition('pending', 'completed')).toBe(false);
  });

  it('is_valid_transition_running_outbound', () => {
    expect(SubagentTaskManager.isValidTransition('running', 'completed')).toBe(true);
    expect(SubagentTaskManager.isValidTransition('running', 'failed')).toBe(true);
    expect(SubagentTaskManager.isValidTransition('running', 'cancelled')).toBe(true);
    expect(SubagentTaskManager.isValidTransition('running', 'pending')).toBe(false);
  });

  it('is_valid_transition_terminal_states_reject_outbound', () => {
    const all = ['pending', 'running', 'completed', 'failed', 'cancelled', 'unknown'] as const;
    for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
      for (const target of all) {
        expect(
          SubagentTaskManager.isValidTransition(terminal, target),
          `${terminal} -> ${target}`,
        ).toBe(terminal === target);
      }
    }
  });

  it('is_valid_transition_unknown_edges', () => {
    expect(SubagentTaskManager.isValidTransition('running', 'unknown')).toBe(true);
    for (const to of ['running', 'completed', 'failed', 'cancelled'] as const) {
      expect(
        SubagentTaskManager.isValidTransition('unknown', to),
        `Unknown -> ${to} must be legal`,
      ).toBe(true);
    }
    expect(SubagentTaskManager.isValidTransition('pending', 'unknown')).toBe(false);
    expect(SubagentTaskManager.isValidTransition('unknown', 'pending')).toBe(false);
  });

  it('is_valid_transition_same_state_idempotent', () => {
    for (const state of ['pending', 'running', 'completed', 'failed', 'cancelled', 'unknown'] as const) {
      expect(SubagentTaskManager.isValidTransition(state, state)).toBe(true);
    }
  });

  it('update_status_happy_path_pending_to_running_to_completed', () => {
    const { manager, database } = setupManager();
    const task = makeTask(manager, database);

    manager.updateStatus(task.id, 'running', null);
    expect(manager.getTask(task.id)!.status).toBe('running');

    manager.updateStatus(task.id, 'completed', 'ok');
    expect(manager.getTask(task.id)!.status).toBe('completed');
  });

  it('update_status_rejects_completed_to_running', () => {
    const { manager, database } = setupManager();
    const task = makeTask(manager, database);

    manager.updateStatus(task.id, 'running', null);
    manager.updateStatus(task.id, 'completed', null);

    let caught: unknown = null;
    try {
      manager.updateStatus(task.id, 'running', null);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SubagentTaskError);
    const error = caught as SubagentTaskError;
    expect(error.kind).toBe('invalid_transition');
    expect(error.from).toBe('completed');
    expect(error.to).toBe('running');
    expect(error.taskId).toBe(task.id);
    expect(manager.getTask(task.id)!.status).toBe('completed');
  });

  it('update_status_rejects_pending_to_completed_skip', () => {
    const { manager, database } = setupManager();
    const task = makeTask(manager, database);

    expect(() => manager.updateStatus(task.id, 'completed', null)).toThrow(SubagentTaskError);
    expect(manager.getTask(task.id)!.status).toBe('pending');
  });

  it('update_status_idempotent_same_state', () => {
    const { manager, database } = setupManager();
    const task = makeTask(manager, database);

    manager.updateStatus(task.id, 'pending', null);
    manager.updateStatus(task.id, 'running', null);
    manager.updateStatus(task.id, 'running', null);
  });

  it('update_status_not_found_returns_error', () => {
    const { manager } = setupManager();
    let caught: unknown = null;
    try {
      manager.updateStatus('missing_task', 'running', null);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SubagentTaskError);
    expect((caught as SubagentTaskError).kind).toBe('not_found');
  });

  it('mark_running_rejected_on_terminal_task', () => {
    const { manager, database } = setupManager();

    // Completed 终态：mark_running 必须被拒绝且状态不被覆盖。
    const task = makeTask(manager, database);
    manager.markRunning(task.id);
    manager.updateStatus(task.id, 'completed', 'done');
    expect(() => manager.markRunning(task.id)).toThrow(SubagentTaskError);
    const after = manager.getTask(task.id)!;
    expect(after.status).toBe('completed');
    expect(after.resultSummary).toBe('done');

    // Cancelled 终态同样拒绝。
    const task2 = makeTask(manager, database);
    manager.updateStatus(task2.id, 'cancelled', 'user cancelled');
    expect(() => manager.markRunning(task2.id)).toThrow(SubagentTaskError);
    expect(manager.getTask(task2.id)!.status).toBe('cancelled');
  });

  it('mark_running_preserves_first_started_at', async () => {
    const { manager, database } = setupManager();
    const task = makeTask(manager, database);

    manager.markRunning(task.id);
    const firstStartedAt = manager.getTask(task.id)!.startedAt;
    expect(firstStartedAt).not.toBeNull();

    await new Promise(resolve => setTimeout(resolve, 10));
    manager.markRunning(task.id);
    const secondStartedAt = manager.getTask(task.id)!.startedAt;
    expect(secondStartedAt).toBe(firstStartedAt);
  });

  it('cancelled_task_excluded_from_restore', () => {
    const { manager, database } = setupManager();

    const taskPending = makeTask(manager, database);
    const taskRunning = makeTask(manager, database);
    manager.markRunning(taskRunning.id);
    const taskCancelled = makeTask(manager, database);
    manager.markRunning(taskCancelled.id);
    manager.updateStatus(taskCancelled.id, 'cancelled', 'user cancelled');

    const ids = manager.getTasksToRestore().map(task => task.id);
    expect(ids).toContain(taskPending.id);
    expect(ids).toContain(taskRunning.id);
    expect(ids).not.toContain(taskCancelled.id);
  });

  it('running_to_unknown_transition_via_db', () => {
    const { manager, database } = setupManager();
    const task = makeTask(manager, database);
    manager.markRunning(task.id);

    manager.markUnknown(task.id, 'owner lost');
    const after = manager.getTask(task.id)!;
    expect(after.status).toBe('unknown');
    expect(after.startedAt).not.toBeNull();
    expect(after.completedAt).toBeNull();
    expect(after.resultSummary).toBe('owner lost');

    manager.markCompleted(task.id, 'late completion');
    const completed = manager.getTask(task.id)!;
    expect(completed.status).toBe('completed');
    expect(completed.resultSummary).toBe('late completion');
  });

  it('unknown_preserves_result_summary_when_reason_absent', () => {
    const { manager, database } = setupManager();
    const task = makeTask(manager, database);
    manager.markRunning(task.id);
    manager.markUnknown(task.id, 'first reason');
    manager.updateStatus(task.id, 'unknown', null);
    expect(manager.getTask(task.id)!.resultSummary).toBe('first reason');
  });

  it('sweep_orphaned_running_converts_only_dead_owners', () => {
    const { manager, database } = setupManager();

    const taskDeadA = makeTask(manager, database);
    manager.markRunning(taskDeadA.id);
    const taskAlive = makeTask(manager, database);
    manager.markRunning(taskAlive.id);
    const taskDeadB = makeTask(manager, database);
    manager.markRunning(taskDeadB.id);
    const taskPending = makeTask(manager, database);

    // alive 集合只含 taskAlive 的 agent。
    const aliveAgent = taskAlive.agentSessionId;
    const swept = manager.sweepOrphanedRunning(agent => agent === aliveAgent);
    const sweptIds = swept.map(task => task.id);
    expect(swept).toHaveLength(2);
    expect(sweptIds).toContain(taskDeadA.id);
    expect(sweptIds).toContain(taskDeadB.id);

    expect(manager.getTask(taskAlive.id)!.status).toBe('running');
    expect(manager.getTask(taskPending.id)!.status).toBe('pending');

    // 幂等：以相同 alive 判定再次 sweep，无行可收敛。
    expect(manager.sweepOrphanedRunning(agent => agent === aliveAgent)).toEqual([]);

    const unknownIds = manager.getUnknownTasks().map(task => task.id);
    expect(unknownIds).toContain(taskDeadA.id);
    expect(unknownIds).toContain(taskDeadB.id);

    const restoreIds = manager.getTasksToRestore().map(task => task.id);
    expect(restoreIds).not.toContain(taskDeadA.id);
    expect(restoreIds).toContain(taskAlive.id);
    expect(restoreIds).toContain(taskPending.id);
  });
});
