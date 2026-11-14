// workspace/subagent_task.rs 的持久化 SQL。
import type { SqlExecutor } from '../../../platform/storage/api.ts';

export interface SubagentTaskRow {
  id: string;
  workspace_id: string;
  agent_session_id: string;
  skill_id: string | null;
  initial_task: string | null;
  status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  result_summary: string | null;
}

export interface SubagentTaskRecord {
  id: string;
  workspaceId: string;
  agentSessionId: string;
  skillId: string | null;
  initialTask: string | null;
  status: string;
  createdAt: string;
}

const TASK_COLUMNS = `id, workspace_id, agent_session_id, skill_id, initial_task,
     status, created_at, started_at, completed_at, result_summary`;

export function createTask(db: SqlExecutor, record: SubagentTaskRecord): void {
  db.run(
    `INSERT INTO subagent_task (id, workspace_id, agent_session_id, skill_id,
     initial_task, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    [
      record.id, record.workspaceId, record.agentSessionId, record.skillId,
      record.initialTask, record.status, record.createdAt,
    ],
  );
}

/** 原子状态转换；返回 `changes()`。前驱列表来自可信常量，可安全内插。 */
export function updateTaskStatus(
  db: SqlExecutor,
  taskId: string,
  status: string,
  now: string,
  resultSummary: string | null,
  allowedPredecessors: string,
): number {
  switch (status) {
    case 'running':
      return db.run(
        `UPDATE subagent_task SET status = ?1, started_at = COALESCE(started_at, ?2), completed_at = NULL
         WHERE id = ?3 AND status IN (${allowedPredecessors})`,
        [status, now, taskId],
      ).changes;
    case 'completed':
    case 'failed':
    case 'cancelled':
      return db.run(
        `UPDATE subagent_task SET status = ?1, completed_at = ?2, result_summary = ?3
         WHERE id = ?4 AND status IN (${allowedPredecessors})`,
        [status, now, resultSummary, taskId],
      ).changes;
    case 'pending':
      return db.run(
        `UPDATE subagent_task SET status = ?1, started_at = NULL, completed_at = NULL, result_summary = NULL
         WHERE id = ?2 AND status IN (${allowedPredecessors})`,
        [status, taskId],
      ).changes;
    case 'unknown':
      return db.run(
        `UPDATE subagent_task SET status = ?1, result_summary = COALESCE(?2, result_summary)
         WHERE id = ?3 AND status IN (${allowedPredecessors})`,
        [status, resultSummary, taskId],
      ).changes;
    default:
      throw new Error(`Unsupported subagent task status: ${status}`);
  }
}

export function selectTaskStatus(db: SqlExecutor, taskId: string): string | undefined {
  return db.pluck<string>('SELECT status FROM subagent_task WHERE id = ?1', [taskId]);
}

export function getTask(db: SqlExecutor, taskId: string): SubagentTaskRow | undefined {
  return db.get<SubagentTaskRow>(`SELECT ${TASK_COLUMNS} FROM subagent_task WHERE id = ?1`, [taskId]);
}

export function listUnknownTasks(db: SqlExecutor): SubagentTaskRow[] {
  return db.all<SubagentTaskRow>(
    `SELECT ${TASK_COLUMNS} FROM subagent_task WHERE status = 'unknown' ORDER BY created_at`,
  );
}

export function listTasksToRestore(db: SqlExecutor): SubagentTaskRow[] {
  return db.all<SubagentTaskRow>(
    `SELECT ${TASK_COLUMNS} FROM subagent_task WHERE status IN ('pending', 'running')`,
  );
}

export function listRecentTasks(db: SqlExecutor, limit: number): SubagentTaskRow[] {
  return db.all<SubagentTaskRow>(
    `SELECT ${TASK_COLUMNS} FROM subagent_task ORDER BY created_at DESC LIMIT ?1`,
    [limit],
  );
}

export function getAgentTask(db: SqlExecutor, agentSessionId: string): SubagentTaskRow | undefined {
  return db.get<SubagentTaskRow>(
    `SELECT ${TASK_COLUMNS} FROM subagent_task WHERE agent_session_id = ?1 AND status IN ('pending', 'running')
     ORDER BY created_at DESC LIMIT 1`,
    [agentSessionId],
  );
}

export function listRunningTaskIds(db: SqlExecutor): string[] {
  return db.all<{ id: string }>(
    "SELECT id FROM subagent_task WHERE status = 'running' ORDER BY created_at",
  ).map(row => row.id);
}
