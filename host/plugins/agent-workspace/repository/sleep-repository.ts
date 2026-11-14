// workspace/sleep_manager.rs 的持久化 SQL。
import type { SqlExecutor } from '../../../platform/storage/api.ts';

export interface SleepRow {
  id: string;
  workspace_id: string;
  coordinator_session_id: string;
  awaiting_agents: string;
  wake_condition: string;
  status: string;
  timeout_at: string | null;
  created_at: string;
  awakened_at: string | null;
  awakened_by: string | null;
  awaken_message: string | null;
  message_id: string | null;
  block_id: string | null;
}

export interface SleepRecord {
  id: string;
  workspaceId: string;
  coordinatorSessionId: string;
  awaitingAgentsJson: string;
  wakeConditionJson: string;
  status: string;
  timeoutAt: string | null;
  createdAt: string;
  messageId: string | null;
  blockId: string | null;
}

const SLEEP_COLUMNS = `id, workspace_id, coordinator_session_id, awaiting_agents, wake_condition,
     status, timeout_at, created_at, awakened_at, awakened_by, awaken_message,
     message_id, block_id`;

export function saveSleep(db: SqlExecutor, record: SleepRecord): void {
  db.run(
    `INSERT INTO sleep_block (id, workspace_id, coordinator_session_id, awaiting_agents,
     wake_condition, status, timeout_at, created_at, message_id, block_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    [
      record.id, record.workspaceId, record.coordinatorSessionId, record.awaitingAgentsJson,
      record.wakeConditionJson, record.status, record.timeoutAt, record.createdAt,
      record.messageId, record.blockId,
    ],
  );
}

export function getSleep(db: SqlExecutor, sleepId: string): SleepRow | undefined {
  return db.get<SleepRow>(`SELECT ${SLEEP_COLUMNS} FROM sleep_block WHERE id = ?1`, [sleepId]);
}

export function listSleeping(db: SqlExecutor): SleepRow[] {
  return db.all<SleepRow>(`SELECT ${SLEEP_COLUMNS} FROM sleep_block WHERE status = 'sleeping'`);
}

export function updateSleepStatus(
  db: SqlExecutor,
  sleepId: string,
  status: string,
  awakenedAt: string,
  awakenedBy: string | null,
  awakenMessage: string | null,
): void {
  db.run(
    'UPDATE sleep_block SET status = ?1, awakened_at = ?2, awakened_by = ?3, awaken_message = ?4 WHERE id = ?5',
    [status, awakenedAt, awakenedBy, awakenMessage, sleepId],
  );
}

export interface AgentStatusRow {
  session_id: string;
  status: string;
}

export function agentStatuses(db: SqlExecutor, workspaceId: string): AgentStatusRow[] {
  return db.all<AgentStatusRow>('SELECT session_id, status FROM agent WHERE workspace_id = ?1', [workspaceId]);
}

export interface SenderRow {
  sender_session_id: string;
}

export function completedAgentsSince(db: SqlExecutor, workspaceId: string, since: string): string[] {
  return db.all<SenderRow>(
    `SELECT DISTINCT sender_session_id FROM message
     WHERE workspace_id = ?1 AND message_type = 'result'
     AND created_at > ?2`,
    [workspaceId, since],
  ).map(row => row.sender_session_id);
}
