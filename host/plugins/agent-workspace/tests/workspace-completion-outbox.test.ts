import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import {
  CompletionOutbox, completionMessageExists, nowCompletionTimestamp,
} from '../src/workspace/completion-outbox.ts';
import type { NewCompletionDelivery } from '../src/workspace/completion-outbox.ts';
import { applyCompletionOutboxMigration } from '../repository/completion-outbox-repository.ts';

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

function inMemoryExecutor(): { db: SqliteDatabase; executor: SqlExecutor } {
  const db = new DatabaseSync(':memory:');
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
  return { db, executor };
}

function setupTestDb(): { db: SqliteDatabase; outbox: CompletionOutbox } {
  const { db, executor } = inMemoryExecutor();
  applyCompletionOutboxMigration(executor);
  return { db, outbox: new CompletionOutbox(executor) };
}

/** completion_outbox.rs:376-384: real single-ChatV2 migration, with audit disabled. */
async function withMigratedChatDb(test: (db: SqlExecutor) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'completion-outbox-migration-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root, auditDbPath: null });
  try {
    const report = await storage.migrations.migrateSingle('chat_v2');
    expect(report.success, report.error ?? 'ChatV2 migrations should apply cleanly').toBe(true);
    test(storage.database('chat_v2'));
  } finally {
    storage.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

function newDelivery(deliveryId: string, runId: string): NewCompletionDelivery {
  return {
    deliveryId,
    taskId: `task_${runId}`,
    runId,
    workspaceId: 'ws_1',
    agentSessionId: 'agent_1',
    targetSessionId: 'parent_1',
    targetGeneration: 'corr_1',
    payloadJson: '{"type":"agent_completion","run_id":"r"}',
    createdAt: nowCompletionTimestamp(),
  };
}

function futureExpiry(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

function pastTimestamp(): string {
  return new Date(Date.now() - 3_600_000).toISOString();
}

describe('completion_outbox', () => {
  it('g03_migration_creates_completion_outbox_table', () => withMigratedChatDb(db => {
    const table = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'completion_outbox'",
    );
    expect(table?.name).toBe('completion_outbox');
    for (const index of [
      'idx_completion_outbox_run',
      'idx_completion_outbox_state',
      'idx_completion_outbox_target',
    ]) {
      const found = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?1",
        [index],
      );
      expect(found?.name, `missing index ${index}`).toBe(index);
    }
  }));

  it('g03_enqueue_is_idempotent_by_run_id', () => {
    const { outbox } = setupTestDb();
    expect(outbox.enqueue(newDelivery('d-1', 'run-1'))).toBe('inserted');

    // 同 run_id 不同 delivery_id：幂等命中，不产生第二行。
    expect(outbox.enqueue(newDelivery('d-2', 'run-1'))).toBe('duplicate_run');
    expect(outbox.get('d-2')).toBeNull();
    expect(outbox.getByRunId('run-1')!.deliveryId).toBe('d-1');

    // 不同 run_id：正常入帐。
    expect(outbox.enqueue(newDelivery('d-3', 'run-2'))).toBe('inserted');
  });

  it('g03_claim_grace_period_skips_fresh_rows', () => {
    const { outbox } = setupTestDb();
    outbox.enqueue(newDelivery('d-1', 'run-1'));

    // not_before 取当前时刻：刚创建的行可被认领。
    expect(outbox.claimPending('owner-a', futureExpiry(), nowCompletionTimestamp(), 10)).toHaveLength(1);

    // 重新造一行：not_before 取过去时刻（宽限期内），新行不得被认领。
    outbox.enqueue(newDelivery('d-2', 'run-2'));
    const graceNotBefore = new Date(Date.now() - 60_000).toISOString();
    const claimed = outbox.claimPending('owner-a', futureExpiry(), graceNotBefore, 10);
    expect(claimed.every(delivery => delivery.deliveryId !== 'd-2')).toBe(true);

    // 宽限期过后（not_before 覆盖其 created_at）该行可被认领。
    const later = outbox.claimPending('owner-a', futureExpiry(), nowCompletionTimestamp(), 10);
    expect(later.some(delivery => delivery.deliveryId === 'd-2')).toBe(true);
  });

  it('g03_claim_excludes_already_claimed_and_terminal', () => {
    const { outbox } = setupTestDb();
    outbox.enqueue(newDelivery('d-1', 'run-1'));
    outbox.enqueue(newDelivery('d-2', 'run-2'));

    const notBefore = nowCompletionTimestamp();
    expect(outbox.claimPending('owner-a', futureExpiry(), notBefore, 10)).toHaveLength(2);

    // 已被 owner-a 认领的行对 owner-b 不可见。
    expect(outbox.claimPending('owner-b', futureExpiry(), notBefore, 10)).toEqual([]);

    // delivered 终态不再被认领。
    expect(outbox.markDelivered('d-1', 'owner-a')).toBe(true);
    const claimedA2 = outbox.claimPending('owner-a', futureExpiry(), nowCompletionTimestamp(), 10);
    expect(claimedA2.every(delivery => delivery.deliveryId !== 'd-1')).toBe(true);
  });

  it('g03_reclaim_expired_claims_returns_rows_to_pending', () => {
    const { outbox } = setupTestDb();
    outbox.enqueue(newDelivery('d-1', 'run-1'));
    outbox.enqueue(newDelivery('d-2', 'run-2'));

    // d-1 租约已过期（崩溃遗留），d-2 租约有效。
    const notBefore = nowCompletionTimestamp();
    const claimed = outbox.claimPending('owner-dead', pastTimestamp(), notBefore, 1);
    expect(claimed).toHaveLength(1);
    const claimedAlive = outbox.claimPending('owner-alive', futureExpiry(), notBefore, 10);
    expect(claimedAlive).toHaveLength(1);

    expect(outbox.reclaimExpiredClaims()).toBe(1);
    const row = outbox.get(claimed[0]!.deliveryId)!;
    expect(row.state).toBe('pending');
    expect(row.claimOwner).toBeNull();
    const alive = outbox.get(claimedAlive[0]!.deliveryId)!;
    expect(alive.state).toBe('claimed');
    expect(alive.claimOwner).toBe('owner-alive');

    // 回收后可被重新认领；attempt_count 单调递增。
    const reclaimed = outbox.claimPending('owner-b', futureExpiry(), nowCompletionTimestamp(), 10);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.deliveryId).toBe(claimed[0]!.deliveryId);
    expect(reclaimed[0]!.attemptCount).toBe(2);
  });

  it('g03_release_claim_and_owner_guards', () => {
    const { outbox } = setupTestDb();
    outbox.enqueue(newDelivery('d-1', 'run-1'));
    expect(outbox.claimPending('owner-a', futureExpiry(), nowCompletionTimestamp(), 10)).toHaveLength(1);

    // owner 守卫：他人不能 release / delivered / claimed-expire 本行。
    expect(outbox.releaseClaim('d-1', 'owner-b')).toBe(false);
    expect(outbox.markDelivered('d-1', 'owner-b')).toBe(false);
    expect(outbox.markExpired('d-1', 'owner-b')).toBe(false);
    expect(outbox.get('d-1')!.state).toBe('claimed');

    // release 后回 pending，可再认领。
    expect(outbox.releaseClaim('d-1', 'owner-a')).toBe(true);
    expect(outbox.get('d-1')!.state).toBe('pending');
    expect(outbox.claimPending('owner-b', futureExpiry(), nowCompletionTimestamp(), 10)).toHaveLength(1);
    expect(outbox.markDelivered('d-1', 'owner-b')).toBe(true);
    const row = outbox.get('d-1')!;
    expect(row.state).toBe('delivered');
    expect(row.deliveredAt).not.toBeNull();
  });

  it('g03_terminal_states_reject_further_transitions', () => {
    const { outbox } = setupTestDb();
    outbox.enqueue(newDelivery('d-1', 'run-1'));
    outbox.enqueue(newDelivery('d-2', 'run-2'));

    // 闭包自投递收敛路径：pending → delivered（无需 claim）。
    expect(outbox.markDeliveredByDeliveryId('d-1')).toBe(true);
    expect(outbox.markDeliveredByDeliveryId('d-1')).toBe(false);
    expect(outbox.get('d-1')!.state).toBe('delivered');

    // expired 终态。
    expect(outbox.markExpired('d-2', null)).toBe(true);
    expect(outbox.markExpired('d-2', null)).toBe(false);
    expect(outbox.markDeliveredByDeliveryId('d-2')).toBe(false);
    expect(outbox.claimPending('owner-a', futureExpiry(), nowCompletionTimestamp(), 10)).toEqual([]);
  });

  it('g03_completion_message_exists_matches_by_run_id', () => {
    const { db, executor } = inMemoryExecutor();
    db.exec(
      `CREATE TABLE message (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          sender_session_id TEXT NOT NULL,
          target_session_id TEXT,
          message_type TEXT NOT NULL,
          content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          metadata_json TEXT
      );`,
    );
    db.prepare(
      "INSERT INTO message (id, workspace_id, sender_session_id, message_type, content, created_at) VALUES ('m1', 'ws_1', 'agent_1', 'result', '{\"type\":\"agent_completion\",\"run_id\":\"run-1\"}', 't')",
    ).run();
    db.prepare(
      "INSERT INTO message (id, workspace_id, sender_session_id, message_type, content, created_at) VALUES ('m2', 'ws_1', 'agent_1', 'progress', '{\"run_id\":\"run-2\"}', 't')",
    ).run();

    expect(completionMessageExists(executor, 'ws_1', 'run-1')).toBe(true);
    // progress 类型不算完成投递。
    expect(completionMessageExists(executor, 'ws_1', 'run-2')).toBe(false);
    // 其他 workspace 隔离。
    expect(completionMessageExists(executor, 'ws_2', 'run-1')).toBe(false);
  });

  it('g03_target_state_check_constraint', () => withMigratedChatDb(db => {
    let message = '';
    try {
      db.run(
        `INSERT INTO completion_outbox (
            delivery_id, run_id, workspace_id, agent_session_id,
            target_session_id, payload_json, state, created_at
         ) VALUES ('d-x', 'run-x', 'ws', 'agent', 'parent', '{}', 'bogus', 't')`,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('CHECK');
  }));
});
