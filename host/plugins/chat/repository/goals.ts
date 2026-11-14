import { defineQuery, type SqlExecutor } from '../../../platform/storage/api.ts';
import type { GoalRecord } from '../api.ts';
import { databaseOperation } from './errors.ts';

export function getGoal(db: SqlExecutor, id: string): GoalRecord | null {
  return databaseOperation(() => db.get<GoalRecord>(`SELECT session_id AS sessionId, goal_id AS goalId,
    objective, status, token_budget AS tokenBudget, tokens_used AS tokensUsed,
    time_used_seconds AS timeUsedSeconds, continuation_count AS continuationCount,
    created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs FROM chat_v2_goals WHERE session_id = ?1`, [id]) ?? null);
}
/** Runtime budget arithmetic must not first round SQLite i64 through a JS number. */
export type RuntimeGoalRecord = Omit<GoalRecord, 'tokenBudget' | 'tokensUsed' | 'timeUsedSeconds' | 'continuationCount' | 'createdAtMs' | 'updatedAtMs'> & {
  tokenBudget: bigint | null; tokensUsed: bigint; timeUsedSeconds: bigint;
  continuationCount: bigint; createdAtMs: bigint; updatedAtMs: bigint;
};
const runtimeGoal = defineQuery<[string], RuntimeGoalRecord>(`SELECT session_id AS sessionId, goal_id AS goalId,
  objective, status, token_budget AS tokenBudget, tokens_used AS tokensUsed,
  time_used_seconds AS timeUsedSeconds, continuation_count AS continuationCount,
  created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs FROM chat_v2_goals WHERE session_id = ?1`,
{ options: { safeIntegers: true } });
export function getRuntimeGoal(db: SqlExecutor, id: string): RuntimeGoalRecord | null {
  return databaseOperation(() => db.get(runtimeGoal, [id]) ?? null);
}
export function insertGoal(db: SqlExecutor, r: GoalRecord): void {
  databaseOperation(() => db.run(`INSERT INTO chat_v2_goals (session_id, goal_id, objective, status, token_budget,
    tokens_used, time_used_seconds, continuation_count, created_at_ms, updated_at_ms)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`, [r.sessionId, r.goalId, r.objective, r.status,
    r.tokenBudget, r.tokensUsed, r.timeUsedSeconds, r.continuationCount, r.createdAtMs, r.updatedAtMs]));
}
export function updateStatus(db: SqlExecutor, id: string, expected: string, status: string): GoalRecord | null {
  return databaseOperation(() => {
    const { changes } = db.run(`UPDATE chat_v2_goals SET status = ?3, updated_at_ms = ?4
      WHERE session_id = ?1 AND goal_id = ?2`, [id, expected, status, Date.now()]);
    return changes === 0 ? null : getGoal(db, id);
  });
}
export function updateObjective(db: SqlExecutor, id: string, objective: string, budget: number | null): GoalRecord | null {
  return databaseOperation(() => {
    const { changes } = db.run(`UPDATE chat_v2_goals SET objective = ?2, token_budget = ?3,
      updated_at_ms = ?4 WHERE session_id = ?1`, [id, objective, budget, Date.now()]);
    return changes === 0 ? null : getGoal(db, id);
  });
}
export function addUsage(db: SqlExecutor, id: string, goalId: string, tokens: number, seconds: number): void {
  databaseOperation(() => db.run(`UPDATE chat_v2_goals SET tokens_used = tokens_used + ?3,
    time_used_seconds = time_used_seconds + ?4, updated_at_ms = ?5 WHERE session_id = ?1 AND goal_id = ?2`,
  [id, goalId, tokens, seconds, Date.now()]));
}
export function claimContinuation(db: SqlExecutor, id: string, goalId: string, max: number): boolean {
  return databaseOperation(() => db.run(`UPDATE chat_v2_goals SET continuation_count = continuation_count + 1,
    updated_at_ms = ?3 WHERE session_id = ?1 AND goal_id = ?2 AND status = 'active'
    AND continuation_count < ?4 AND (token_budget IS NULL OR tokens_used < token_budget)`,
  [id, goalId, Date.now(), max]).changes === 1);
}
export function deleteGoal(db: SqlExecutor, id: string): void {
  databaseOperation(() => db.run('DELETE FROM chat_v2_goals WHERE session_id = ?1', [id]));
}
