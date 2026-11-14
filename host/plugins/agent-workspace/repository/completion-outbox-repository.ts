// chat_v2 主库 `completion_outbox`（G03-a）的 SQL 与迁移。
//
// 迁移来源：`migrations/chat_v2/V20260908__completion_outbox.sql`。
import type { SqlExecutor } from '../../../platform/storage/api.ts';

export interface CompletionOutboxRow {
  delivery_id: string;
  task_id: string | null;
  run_id: string;
  workspace_id: string;
  agent_session_id: string;
  target_session_id: string;
  target_generation: string | null;
  payload_json: string;
  state: string;
  claim_owner: string | null;
  claim_expiry: string | null;
  attempt_count: number;
  created_at: string;
  delivered_at: string | null;
}

export interface NewCompletionRecord {
  deliveryId: string;
  taskId: string | null;
  runId: string;
  workspaceId: string;
  agentSessionId: string;
  targetSessionId: string;
  targetGeneration: string | null;
  payloadJson: string;
  createdAt: string;
}

const COMPLETION_OUTBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS completion_outbox (
    delivery_id       TEXT PRIMARY KEY,
    task_id           TEXT,
    run_id            TEXT NOT NULL,
    workspace_id      TEXT NOT NULL,
    agent_session_id  TEXT NOT NULL,
    target_session_id TEXT NOT NULL,
    target_generation TEXT,
    payload_json      TEXT NOT NULL,
    state             TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'claimed', 'delivered', 'expired')),
    claim_owner       TEXT,
    claim_expiry      TEXT,
    attempt_count     INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    delivered_at      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_completion_outbox_run
    ON completion_outbox(run_id);

CREATE INDEX IF NOT EXISTS idx_completion_outbox_state
    ON completion_outbox(state, claim_expiry);

CREATE INDEX IF NOT EXISTS idx_completion_outbox_target
    ON completion_outbox(target_session_id, state);
`;

export function applyCompletionOutboxMigration(db: SqlExecutor): void {
  db.exec(COMPLETION_OUTBOX_SCHEMA);
}

/** `INSERT OR IGNORE`：返回 `changes()`（0 = run_id 幂等命中）。 */
export function enqueueCompletion(db: SqlExecutor, record: NewCompletionRecord): number {
  return db.run(
    `INSERT OR IGNORE INTO completion_outbox (
        delivery_id, task_id, run_id, workspace_id, agent_session_id,
        target_session_id, target_generation, payload_json,
        state, attempt_count, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', 0, ?9)`,
    [
      record.deliveryId, record.taskId, record.runId, record.workspaceId,
      record.agentSessionId, record.targetSessionId, record.targetGeneration,
      record.payloadJson, record.createdAt,
    ],
  ).changes;
}

export function getCompletion(db: SqlExecutor, deliveryId: string): CompletionOutboxRow | undefined {
  return db.get<CompletionOutboxRow>('SELECT * FROM completion_outbox WHERE delivery_id = ?1', [deliveryId]);
}

export function getCompletionByRunId(db: SqlExecutor, runId: string): CompletionOutboxRow | undefined {
  return db.get<CompletionOutboxRow>('SELECT * FROM completion_outbox WHERE run_id = ?1', [runId]);
}

export function markCompletionDeliveredByDeliveryId(db: SqlExecutor, deliveryId: string, timestamp: string): number {
  return db.run(
    `UPDATE completion_outbox
     SET state = 'delivered', delivered_at = ?2, claim_owner = NULL, claim_expiry = NULL
     WHERE delivery_id = ?1 AND state IN ('pending', 'claimed')`,
    [deliveryId, timestamp],
  ).changes;
}

export function reclaimExpiredCompletionClaims(db: SqlExecutor, timestamp: string): number {
  return db.run(
    `UPDATE completion_outbox
     SET state = 'pending', claim_owner = NULL, claim_expiry = NULL
     WHERE state = 'claimed' AND claim_expiry IS NOT NULL AND claim_expiry <= ?1`,
    [timestamp],
  ).changes;
}

export function claimPendingCompletions(
  db: SqlExecutor,
  owner: string,
  leaseExpiry: string,
  notBefore: string,
  limit: number,
): CompletionOutboxRow[] {
  db.run(
    `UPDATE completion_outbox
     SET state = 'claimed', claim_owner = ?1, claim_expiry = ?2,
         attempt_count = attempt_count + 1
     WHERE delivery_id IN (
         SELECT delivery_id FROM completion_outbox
         WHERE state = 'pending' AND created_at <= ?3
         ORDER BY created_at
         LIMIT ?4
     )`,
    [owner, leaseExpiry, notBefore, limit],
  );
  return db.all<CompletionOutboxRow>(
    `SELECT * FROM completion_outbox
     WHERE state = 'claimed' AND claim_owner = ?1 AND claim_expiry = ?2
     ORDER BY created_at`,
    [owner, leaseExpiry],
  );
}

export function releaseCompletionClaim(db: SqlExecutor, deliveryId: string, owner: string): number {
  return db.run(
    `UPDATE completion_outbox
     SET state = 'pending', claim_owner = NULL, claim_expiry = NULL
     WHERE delivery_id = ?1 AND state = 'claimed' AND claim_owner = ?2`,
    [deliveryId, owner],
  ).changes;
}

export function markCompletionDelivered(db: SqlExecutor, deliveryId: string, owner: string, timestamp: string): number {
  return db.run(
    `UPDATE completion_outbox
     SET state = 'delivered', delivered_at = ?3, claim_owner = NULL, claim_expiry = NULL
     WHERE delivery_id = ?1 AND state = 'claimed' AND claim_owner = ?2`,
    [deliveryId, owner, timestamp],
  ).changes;
}

export function markCompletionExpired(db: SqlExecutor, deliveryId: string, owner: string | null): number {
  if (owner === null) {
    return db.run(
      `UPDATE completion_outbox
       SET state = 'expired', claim_owner = NULL, claim_expiry = NULL
       WHERE delivery_id = ?1 AND state = 'pending'`,
      [deliveryId],
    ).changes;
  }
  return db.run(
    `UPDATE completion_outbox
     SET state = 'expired', claim_owner = NULL, claim_expiry = NULL
     WHERE delivery_id = ?1 AND (state = 'pending'
         OR (state = 'claimed' AND claim_owner = ?2))`,
    [deliveryId, owner],
  ).changes;
}

/** workspace 库 message 表是否已存在该 run_id 的 Result 消息（dispatcher 补投前查重）。 */
export function completionMessageExists(db: SqlExecutor, workspaceId: string, runId: string): boolean {
  const count = db.pluck<number>(
    `SELECT COUNT(*) FROM message
     WHERE workspace_id = ?1 AND message_type = 'result'
       AND json_extract(content, '$.run_id') = ?2`,
    [workspaceId, runId],
  );
  return Number(count ?? 0) > 0;
}
