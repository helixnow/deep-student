import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { isAppError } from './automation-model.ts';
import { chronoRfc3339 } from '../../../platform/time/index.ts';
import { automationCommandError, errorMessage } from '../src/automation-errors.ts';

/** chrono `Utc::now().to_rfc3339()`（AutoSi 小数秒，UTC 写 `+00:00`）。 */
function rustNow(): string {
  return chronoRfc3339(BigInt(Date.now()) * 1_000_000n);
}

export function automationSummary(db: SqlExecutor) {
  try {
    const enabled = db.pluck<number>('SELECT COUNT(*) FROM automation_definitions WHERE enabled = 1')!;
    const running = db.pluck<number>("SELECT COUNT(*) FROM automation_runs WHERE status = 'running'")!;
    const failed = db.pluck<number>(`SELECT COUNT(*) FROM automation_runs
      WHERE status IN ('error', 'timeout', 'spawn_error') AND finished_at >= ?1`,
    [chronoRfc3339(BigInt(Date.now() - 86_400_000) * 1_000_000n)])!;
    const nextRunAt = db.pluck<string | null>(`SELECT MIN(run_at) FROM (
      SELECT next_run_at AS run_at FROM automation_definitions
      WHERE enabled = 1 AND next_run_at IS NOT NULL
      UNION ALL
      SELECT r.next_attempt_at AS run_at FROM automation_runs r
      JOIN automation_definitions a ON a.id = r.automation_id
      WHERE r.status = 'retrying' AND (a.enabled = 1 OR r.retry_requested = 1)
      AND r.next_attempt_at IS NOT NULL
    )`)!;
    const onceCompleted = db.pluck<number>(`SELECT COUNT(*) FROM automation_definitions
      WHERE enabled = 0 AND next_run_at IS NULL AND last_run_at IS NOT NULL
      AND json_extract(schedule_json, '$.kind') = 'once'`)!;
    const lastFailedRunAt = db.pluck<string | null>(`SELECT MAX(finished_at) FROM automation_runs
      WHERE status IN ('error', 'timeout', 'spawn_error') AND finished_at >= ?1`,
    [chronoRfc3339(BigInt(Date.now() - 86_400_000) * 1_000_000n)])!;
    return { enabledCount: enabled, runningCount: running, failedCount: failed,
      nextRunAt, onceCompletedCount: onceCompleted, lastFailedRunAt };
  } catch (error) {
    throw automationCommandError(AppError.database(`Failed to query automation summary: ${errorMessage(error)}`));
  }
}

export function retryAutomationRun(db: SqlExecutor, runId: string): void {
  try { retryAutomationRunCore(db, runId); }
  catch (error) { throw isAppError(error) ? automationCommandError(error) : error; }
}

/** automations.rs:4569–4594 (`AppError` for the agent tool; the command wraps it). */
export function retryAutomationRunCore(db: SqlExecutor, runId: string): void {
  let changed;
  try {
    changed = db.run(`UPDATE automation_runs
      SET status = 'retrying', next_attempt_at = ?2, finished_at = NULL,
        error = NULL, trigger_type = 'retry', retry_requested = 1, lease_expires_at = NULL,
        delivered_json = CASE WHEN EXISTS (
          SELECT 1 FROM automation_definitions a WHERE a.id = automation_runs.automation_id
          AND a.action_type = 'agent_turn'
        ) THEN '[]' ELSE delivered_json END,
        max_attempts = MAX(max_attempts, attempt + 1), updated_at = ?2
      WHERE id = ?1 AND status IN ('error', 'timeout', 'spawn_error', 'cancelled')`,
    [runId, rustNow()]).changes;
  } catch (error) {
    throw AppError.database(`Failed to retry automation run: ${errorMessage(error)}`);
  }
  if (changed !== 1) throw AppError.validation('Run is not retryable');
}
