/**
 * 自动化运行记录仓储（automations.rs 的 run 历史、投递回执、租约/重试/
 * 取消/once 收尾与启动回收）。定义 CRUD 在 `automation-definitions.ts`。
 */
import type { DatabaseHandle, SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import {
  MAX_RUN_HISTORY, MAX_STORED_RUNS_PER_AUTOMATION,
  computeNextTrigger, formatTimestampMillis, parseTimestampMillis,
} from '../src/automation-schedule.ts';
import { automationRunHasLiveExecutor, cancelAutomationRunToken } from '../src/automation-run-guard.ts';
import {
  type AutomationDefinition, type AutomationRunRecord, type ClaimedAutomationRun,
  AUTOMATION_LEASE_GRACE_SECS, dbError, isAppError, nowString, num, schedulerIdentity, text, versionParam,
} from './automation-model.ts';
import {
  automationVersionConflictError, loadAutomation, rowToAutomation,
} from './automation-definitions.ts';

/** automations.rs:2935–2949（调用方 Rust 全用 `unwrap_or_default()`）。 */
export function loadRunDeliveries(db: SqlExecutor, runId: string): string[] {
  const raw = db.pluck<string>('SELECT delivered_json FROM automation_runs WHERE id = ?1', [runId]);
  if (raw === undefined || raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch { return []; }
}

export interface PendingNotificationRun {
  run_id: string;
  attempt: number;
  status: string;
  session_id: string | null;
  summary: string | null;
  error: string | null;
  delivered: string[];
  automation_name: string;
}

/** automations.rs:5296–5360：待补投的 agent 完成通知。 */
export function listPendingNotificationRuns(
  db: SqlExecutor, nowMs: number = Date.now(), limit: number = 8,
): PendingNotificationRun[] {
  try {
    return db.all<Record<string, SqlValue>>(`SELECT r.id, r.attempt, r.status, r.session_id,
        r.summary, r.error, r.delivered_json, a.name
      FROM automation_runs r
      JOIN automation_definitions a ON a.id = r.automation_id
      WHERE r.status IN ('success', 'error', 'timeout', 'spawn_error')
        AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= ?1)
        AND EXISTS (
          SELECT 1 FROM json_each(r.delivered_json)
          WHERE json_each.value = 'notification_pending'
        )
      ORDER BY r.updated_at ASC
      LIMIT ?2`, [formatTimestampMillis(nowMs), limit]).map((row) => {
      let delivered: string[] = [];
      try {
        const parsed: unknown = JSON.parse(text(row.delivered_json) ?? '[]');
        delivered = Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
      } catch { delivered = []; }
      return {
        run_id: text(row.id) ?? '',
        attempt: num(row.attempt),
        status: text(row.status) ?? '',
        session_id: text(row.session_id),
        summary: text(row.summary),
        error: text(row.error),
        delivered,
        automation_name: text(row.name) ?? '',
      };
    });
  } catch (error) {
    throw dbError('Failed to query pending notifications', error);
  }
}

/** automations.rs:3010–3033. */
export function setNotificationRetryAt(
  db: SqlExecutor, runId: string, expectedAttempt: number, expectedStatus: string,
  retryAt: string | null,
): void {
  try {
    db.run(`UPDATE automation_runs SET next_attempt_at = ?2, updated_at = ?3
      WHERE id = ?1 AND attempt = ?4 AND status = ?5`,
    [runId, retryAt, nowString(), expectedAttempt, expectedStatus]);
  } catch (error) {
    throw dbError('Failed to update notification retry time', error);
  }
}

/** automations.rs:3823–3836：执行前确认 run 仍由当前 attempt 持有。 */
export function automationRunIsRunning(
  db: SqlExecutor, runId: string, attempt: number,
): boolean {
  try {
    return num(db.pluck<SqlValue>(
      "SELECT EXISTS(SELECT 1 FROM automation_runs WHERE id = ?1 AND attempt = ?2 AND status = 'running')",
      [runId, attempt])) !== 0;
  } catch (error) {
    throw dbError('Failed to verify automation run', error);
  }
}

/** automations.rs:2951–3008. */
export function setRunDeliveryMarker(
  db: DatabaseHandle, runId: string, expectedAttempt: number, expectedStatus: string,
  channel: string, present: boolean,
): boolean {
  let entered = false;
  let bodyDone = false;
  try {
    return db.transaction((tx) => {
      entered = true;
      let row: { attempt: number; status: string; delivered_json: string } | undefined;
      try {
        row = tx.get<{ attempt: number; status: string; delivered_json: string }>(
          'SELECT attempt, status, delivered_json FROM automation_runs WHERE id = ?1', [runId]);
      } catch (error) {
        throw dbError('Failed to load delivery state', error);
      }
      if (row === undefined) return false;
      if (row.attempt !== expectedAttempt || row.status !== expectedStatus) return false;
      let delivered: string[];
      try {
        const parsed: unknown = JSON.parse(row.delivered_json);
        delivered = Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
      } catch { delivered = []; }
      const alreadyPresent = delivered.includes(channel);
      if (present === alreadyPresent) return true;
      if (present) delivered.push(channel);
      else delivered = delivered.filter((entry) => entry !== channel);
      const serialized = JSON.stringify(delivered);
      let changed: number;
      try {
        changed = tx.run(`UPDATE automation_runs SET delivered_json = ?2, updated_at = ?3
          WHERE id = ?1 AND attempt = ?4 AND status = ?5`,
        [runId, serialized, nowString(), expectedAttempt, expectedStatus]).changes;
      } catch (error) {
        throw dbError('Failed to update delivery state', error);
      }
      bodyDone = true;
      return changed === 1;
    }, { behavior: 'immediate' });
  } catch (error) {
    if (isAppError(error)) throw error;
    if (!entered) throw dbError('Failed to start delivery update', error);
    if (bodyDone) throw dbError('Failed to commit delivery state', error);
    throw dbError('Failed to update delivery state', error);
  }
}

function runDurationMs(startedAt: string | null, finishedAt: string | null): number | null {
  const started = parseTimestampMillis(startedAt ?? '');
  const finished = parseTimestampMillis(finishedAt ?? '');
  if (started === null || finished === null) return null;
  return Math.max(0, finished - started);
}

export function rowToRun(row: Record<string, SqlValue>): AutomationRunRecord {
  const deliveredRaw = text(row.delivered_json) ?? '[]';
  let delivered: string[] = [];
  try {
    const parsed: unknown = JSON.parse(deliveredRaw);
    if (Array.isArray(parsed)) delivered = parsed.filter((value): value is string => typeof value === 'string');
  } catch { delivered = []; }
  const scheduledFor = text(row.scheduled_for) ?? '';
  const startedAt = text(row.started_at);
  const finishedAt = text(row.finished_at);
  return {
    id: text(row.id) ?? '', automation_id: text(row.automation_id) ?? '',
    fired_at: scheduledFor, delivered, session_id: text(row.session_id), status: text(row.status),
    trigger_type: text(row.trigger_type) ?? '', scheduled_for: scheduledFor,
    attempt: Math.max(1, num(row.attempt)), max_attempts: Math.max(1, num(row.max_attempts)),
    started_at: startedAt, finished_at: finishedAt, next_attempt_at: text(row.next_attempt_at),
    summary: text(row.summary), error: text(row.error),
    duration_ms: runDurationMs(startedAt, finishedAt),
  };
}

const RUN_COLUMNS = 'id, automation_id, trigger_type, scheduled_for, status, attempt, max_attempts, started_at, finished_at, next_attempt_at, session_id, delivered_json, summary, error, created_at';

export function listAutomationRuns(
  db: SqlExecutor, automationId: string | null, limit: number,
): AutomationRunRecord[] {
  const bounded = Math.min(200, Math.max(1, Math.trunc(limit)));
  try {
    const rows = automationId === null
      ? db.all(`SELECT ${RUN_COLUMNS} FROM automation_runs ORDER BY created_at DESC LIMIT ?1`, [bounded])
      : db.all(`SELECT ${RUN_COLUMNS} FROM automation_runs WHERE automation_id = ?1 ORDER BY created_at DESC LIMIT ?2`,
        [automationId, bounded]);
    return rows.map(rowToRun);
  } catch (error) {
    throw dbError('Failed to query run history', error);
  }
}

/** automations.rs:2083–2148: one bounded page of run history plus the unfiltered total. */
export function listAutomationRunsPage(
  db: SqlExecutor, automationId: string | null, limit: number, offset: number,
): { runs: AutomationRunRecord[]; total: number } {
  const bounded = Math.min(20, Math.max(1, Math.trunc(limit)));
  const filter = automationId === null ? '' : 'WHERE automation_id = ?1 ';
  const scope: SqlValue[] = automationId === null ? [] : [automationId];
  const page = automationId === null ? 'LIMIT ?1 OFFSET ?2' : 'LIMIT ?2 OFFSET ?3';
  let runs: AutomationRunRecord[];
  try {
    runs = db.all(`SELECT ${RUN_COLUMNS} FROM automation_runs ${filter}ORDER BY created_at DESC ${page}`,
      [...scope, bounded, offset]).map(rowToRun);
  } catch (error) {
    throw dbError('Failed to query paged run history', error);
  }
  let total: number;
  try {
    total = Number(db.pluck<number>(`SELECT COUNT(*) FROM automation_runs ${filter}`, scope) ?? 0);
  } catch (error) {
    throw dbError('Failed to count run history', error);
  }
  return { runs, total: Math.max(0, total) };
}

export function loadAutomationRuns(db: SqlExecutor): AutomationRunRecord[] {
  return listAutomationRuns(db, null, MAX_RUN_HISTORY);
}

export function pruneRunHistory(executor: SqlExecutor, runId: string): void {
  let automationId: string | undefined;
  try {
    automationId = executor.pluck<string>('SELECT automation_id FROM automation_runs WHERE id = ?1', [runId]);
  } catch (error) {
    throw dbError('Failed to resolve automation run owner', error);
  }
  if (automationId === undefined) return;
  try {
    executor.run(`DELETE FROM automation_runs
      WHERE automation_id = ?1
        AND status NOT IN ('queued', 'running', 'retrying')
        AND id NOT IN (
          SELECT id FROM automation_runs WHERE automation_id = ?1
          ORDER BY created_at DESC, id DESC LIMIT ?2)`,
    [automationId, MAX_STORED_RUNS_PER_AUTOMATION]);
  } catch (error) {
    throw dbError('Failed to prune automation run history', error);
  }
}

export function cancelAutomationRun(
  db: DatabaseHandle, runId: string, hooks?: OnceFinalizeLogHooks,
): void {
  const now = nowString();
  try {
    const changed = db.run(`UPDATE automation_runs
      SET status = 'cancelled', finished_at = ?2, next_attempt_at = NULL,
          lease_expires_at = NULL, retry_requested = 0, updated_at = ?2
      WHERE id = ?1 AND status IN ('queued', 'running', 'retrying')`, [runId, now]).changes;
    if (changed !== 1) throw AppError.validation('Run is not cancellable');
  } catch (error) {
    if (isAppError(error)) throw error;
    throw dbError('Failed to cancel automation run', error);
  }
  pruneRunHistory(db, runId);
  let automationId: string | undefined;
  try {
    automationId = db.pluck<string>('SELECT automation_id FROM automation_runs WHERE id = ?1', [runId]);
  } catch (error) {
    throw dbError('Failed to resolve cancelled run owner', error);
  }
  // Rust：先取消令牌，再固化 once 收尾。
  cancelAutomationRunToken(runId);
  if (automationId !== undefined) {
    let automation: AutomationDefinition | null = null;
    try {
      automation = loadAutomation(db, automationId);
    } catch {
      // Rust `if let Ok(Some(automation)) = get_automation(...)`：读取失败时跳过收尾。
      automation = null;
    }
    if (automation !== null) {
      // Rust `cancel_automation_run` has no AppHandle: it passes None, so the
      // cancel path logs info/warn but never emits once_completed.
      finalizeOnceAutomation(db, automation,
        hooks === undefined ? undefined : { info: hooks.info, warn: hooks.warn });
    }
  }
}

export interface OnceFinalizeLogHooks {
  info?(message: string): void;
  warn?(message: string): void;
}

export interface OnceFinalizeHooks extends OnceFinalizeLogHooks {
  emitChanged?(action: string, automationId: string): void;
}

/**
 * automations.rs:1894–1930：once 时点消耗后的运行时收尾。
 * 失败只 warn（不得静默吞错）；成功 changed=1 时记录 info 并发出 once_completed。
 */
export function finalizeOnceAutomation(
  db: SqlExecutor, automation: AutomationDefinition, hooks?: OnceFinalizeHooks,
): void {
  if (automation.schedule.kind !== 'once') return;
  try {
    const changed = db.run(`UPDATE automation_definitions
      SET enabled = 0, updated_at = ?2
      WHERE id = ?1 AND enabled = 1 AND next_run_at IS NULL`, [automation.id, nowString()]).changes;
    if (changed === 1) {
      hooks?.info?.(`[AutomationScheduler] once automation '${automation.id}' completed; disabled`);
      hooks?.emitChanged?.('once_completed', automation.id);
    }
  } catch (error) {
    hooks?.warn?.(`[AutomationScheduler] failed to finalize once automation '${automation.id}': ${dbError('Failed to finalize once automation', error).message}`);
  }
}

export function effectiveLeaseTimeoutSeconds(automation: AutomationDefinition): number {
  const profileTimeout = automation.trusted_profile?.timeoutSeconds ?? 0;
  return Number(profileTimeout > automation.timeout_seconds ? profileTimeout : automation.timeout_seconds);
}

export function createManualRun(
  db: DatabaseHandle, automationId: string, expectedVersion: number,
): ClaimedAutomationRun {
  const versionDb = versionParam(expectedVersion);
  try {
    return db.transaction((tx) => {
      let automation = loadAutomation(tx, automationId);
      if (automation === null || automation.version !== expectedVersion) {
        if (automation === null) throw AppError.validation(`Automation '${automationId}' not found`);
        throw automationVersionConflictError(automationId, expectedVersion, automation);
      }
      const activeRunId = tx.pluck<string>(`SELECT id FROM automation_runs
        WHERE automation_id = ?1 AND status IN ('queued', 'running', 'retrying')
        ORDER BY created_at DESC LIMIT 1`, [automationId]);
      if (activeRunId !== undefined) {
        throw AppError.with_details('Conflict',
          `Automation '${automationId}' already has an active run '${activeRunId}'; wait for it to finish or cancel it first`,
          { code: 'AUTOMATION_RUN_ALREADY_ACTIVE', automationId, activeRunId, retryable: true });
      }
      const nowMs = Date.now();
      const now = formatTimestampMillis(nowMs);
      const runId = `run_${globalThis.crypto.randomUUID()}`;
      const leaseExpiresAt = formatTimestampMillis(nowMs + (effectiveLeaseTimeoutSeconds(automation) + AUTOMATION_LEASE_GRACE_SECS) * 1000);
      tx.run(`INSERT INTO automation_runs (
          id, automation_id, dedupe_key, trigger_type, scheduled_for, status,
          retry_requested, attempt, max_attempts, claimed_by, claimed_at, lease_expires_at,
          started_at, delivered_json, created_at, updated_at)
        VALUES (?1,?2,?3,'manual',?4,'running',1,1,?5,?6,?4,?7,?4,'[]',?4,?4)`,
      [runId, automation.id, `manual:${runId}`, now, automation.max_retries + 1,
        schedulerIdentity(), leaseExpiresAt]);
      return { run_id: runId, automation, scheduled_for: now, trigger_type: 'manual', attempt: 1 };
    }, { behavior: 'immediate' });
  } catch (error) {
    if (isAppError(error)) throw error;
    throw dbError('Failed to create manual automation run', error);
  }
}

function leaseExpiresAt(nowMs: number, timeoutSeconds: number): string {
  return formatTimestampMillis(nowMs + (timeoutSeconds + AUTOMATION_LEASE_GRACE_SECS) * 1000);
}

/** automations.rs:2667–2682. */
export function nextAfterClaim(
  automation: AutomationDefinition, scheduledForMs: number, nowMs: number,
): string | null {
  if (automation.schedule.kind === 'once') return null;
  const base = automation.catch_up_policy === 'catch_up_all' ? scheduledForMs : nowMs;
  return formatTimestampMillis(computeNextTrigger(automation.schedule, base));
}

/** automations.rs:2687–2785. */
export function claimScheduledRun(
  db: DatabaseHandle, automationId: string, expectedNextRunAt: string, nowMs: number,
): ClaimedAutomationRun | null {
  try {
    return db.transaction((tx) => {
      const row = tx.get('SELECT * FROM automation_definitions WHERE id = ?1 AND enabled = 1', [automationId]);
      if (row === undefined) return null;
      const automation = rowToAutomation(row);
      if (automation.next_run_at !== expectedNextRunAt) return null;
      const scheduledFor = parseTimestampMillis(expectedNextRunAt);
      if (scheduledFor === null) throw AppError.internal('Invalid automation timestamp');
      if (scheduledFor > nowMs) return null;
      const hasActiveRun = num(tx.pluck(`SELECT EXISTS(
        SELECT 1 FROM automation_runs WHERE automation_id = ?1 AND status IN ('queued', 'running', 'retrying'))`,
      [automationId])) !== 0;
      if (hasActiveRun) return null;
      const nextRunAt = nextAfterClaim(automation, scheduledFor, nowMs);
      const now = formatTimestampMillis(nowMs);
      const changed = tx.run(`UPDATE automation_definitions
        SET last_run_at = ?3, next_run_at = ?4, updated_at = ?5
        WHERE id = ?1 AND enabled = 1 AND next_run_at = ?2`,
      [automationId, expectedNextRunAt, formatTimestampMillis(scheduledFor), nextRunAt, now]).changes;
      if (changed !== 1) return null;
      const runId = `run_${globalThis.crypto.randomUUID()}`;
      const dedupeKey = `schedule:${automationId}:${formatTimestampMillis(scheduledFor)}`;
      tx.run(`INSERT INTO automation_runs (
          id, automation_id, dedupe_key, trigger_type, scheduled_for, status,
          attempt, max_attempts, claimed_by, claimed_at, lease_expires_at,
          started_at, delivered_json, created_at, updated_at)
        VALUES (?1,?2,?3,'schedule',?4,'running',1,?5,?6,?7,?8,?7,'[]',?7,?7)`,
      [runId, automationId, dedupeKey, formatTimestampMillis(scheduledFor),
        automation.max_retries + 1, schedulerIdentity(), now, leaseExpiresAt(nowMs, effectiveLeaseTimeoutSeconds(automation))]);
      automation.last_run_at = formatTimestampMillis(scheduledFor);
      automation.next_run_at = nextRunAt;
      return { run_id: runId, automation, scheduled_for: formatTimestampMillis(scheduledFor),
        trigger_type: 'schedule', attempt: 1 };
    }, { behavior: 'immediate' });
  } catch (error) {
    if (isAppError(error)) throw error;
    throw dbError('Failed to claim scheduled run', error);
  }
}

/** automations.rs:5087–5177. */
export function claimRetryRun(db: DatabaseHandle, runId: string, nowMs: number = Date.now()): ClaimedAutomationRun | null {
  if (automationRunHasLiveExecutor(runId)) return null;
  try {
    return db.transaction((tx) => {
      const row = tx.get(`SELECT automation_id, scheduled_for, attempt, retry_requested
        FROM automation_runs WHERE id = ?1 AND status = 'retrying' AND next_attempt_at <= ?2`,
      [runId, formatTimestampMillis(nowMs)]);
      if (row === undefined) return null;
      const automationId = String(row.automation_id);
      const scheduledFor = String(row.scheduled_for);
      const previousAttempt = num(row.attempt);
      const retryRequested = num(row.retry_requested) !== 0;
      const automation = loadAutomation(tx, automationId);
      if (automation === null) return null;
      if (!automation.enabled && !retryRequested) {
        tx.run(`UPDATE automation_runs
          SET status = 'cancelled', finished_at = ?2, lease_expires_at = NULL, updated_at = ?2
          WHERE id = ?1`, [runId, formatTimestampMillis(nowMs)]);
        return null;
      }
      const hasOtherRunning = num(tx.pluck(`SELECT EXISTS(
        SELECT 1 FROM automation_runs WHERE automation_id = ?1 AND id != ?2 AND status IN ('queued', 'running'))`,
      [automationId, runId])) !== 0;
      if (hasOtherRunning) return null;
      const now = formatTimestampMillis(nowMs);
      const changed = tx.run(`UPDATE automation_runs
        SET status = 'running', trigger_type = 'retry', attempt = attempt + 1,
            claimed_by = ?2, claimed_at = ?3, lease_expires_at = ?4,
            started_at = ?3, finished_at = NULL, next_attempt_at = NULL, updated_at = ?3
        WHERE id = ?1 AND status = 'retrying'`,
      [runId, schedulerIdentity(), now, leaseExpiresAt(nowMs, effectiveLeaseTimeoutSeconds(automation))]).changes;
      if (changed !== 1) return null;
      return { run_id: runId, automation, scheduled_for: scheduledFor,
        trigger_type: 'retry', attempt: previousAttempt + 1 };
    }, { behavior: 'immediate' });
  } catch (error) {
    if (isAppError(error)) throw error;
    throw dbError('Failed to claim retry run', error);
  }
}

/** automations.rs:5179–5294. */
export function recoverStaleAutomationRuns(
  db: DatabaseHandle, nowMs: number = Date.now(), hooks?: OnceFinalizeHooks,
): number {
  const candidates = db.all(`SELECT id, automation_id, claimed_by, lease_expires_at, attempt, retry_requested
    FROM automation_runs WHERE status = 'running'`);
  const currentOwner = schedulerIdentity();
  const cancelHooks = hooks === undefined ? undefined : { info: hooks.info, warn: hooks.warn };
  let recovered = 0;
  for (const row of candidates) {
    const runId = String(row.id);
    const automationId = String(row.automation_id);
    const automation = loadAutomation(db, automationId);
    if (automation === null) continue;
    const foreignOwner = text(row.claimed_by) !== currentOwner;
    const leaseRaw = text(row.lease_expires_at);
    const leaseExpires = leaseRaw === null ? null : parseTimestampMillis(leaseRaw);
    const leaseExpired = leaseExpires === null || leaseExpires <= nowMs;
    if (!foreignOwner && !leaseExpired) continue;
    if (automationRunHasLiveExecutor(runId)) {
      db.run(`UPDATE automation_runs SET lease_expires_at = ?2, updated_at = ?3
        WHERE id = ?1 AND status = 'running'`,
      [runId, leaseExpiresAt(nowMs, effectiveLeaseTimeoutSeconds(automation)), formatTimestampMillis(nowMs)]);
      continue;
    }
    if (!automation.enabled && num(row.retry_requested) === 0) {
      cancelAutomationRun(db, runId, cancelHooks);
      recovered += 1;
      continue;
    }
    if (automation.action_type === 'notify') {
      const delivered = loadRunDeliveries(db, runId);
      // boundary-allow todo-marker: Rust delivery kind is literally "todo" (automations.rs:5241).
      if (delivered.includes('notification') && delivered.includes('todo')) {
        completeRun(db, runId, num(row.attempt), 'success', delivered, null, automation.prompt, null);
        finalizeOnceAutomation(db, automation, hooks);
        recovered += 1;
        continue;
      }
    }
    const outcome = retryOrFinishRun(db, runId, num(row.attempt), automation, 'error', null,
      'Application stopped before the automation run completed',
      automation.action_type === 'agent_turn' && !automation.heartbeat);
    if (outcome === 'finished') finalizeOnceAutomation(db, automation, hooks);
    recovered += 1;
  }
  return recovered;
}

export function dueRetryIds(db: SqlExecutor, nowMs: number = Date.now()): string[] {
  return db.all(`SELECT id FROM automation_runs WHERE status = 'retrying' AND next_attempt_at <= ?1
    ORDER BY next_attempt_at ASC`, [formatTimestampMillis(nowMs)]).map((row) => String(row.id));
}

export function completeRun(
  db: SqlExecutor, runId: string, expectedAttempt: number, status: string,
  delivered: readonly string[], sessionId: string | null, summary: string | null, error: string | null,
): boolean {
  const now = nowString();
  // automations.rs:2911–2927: the terminal status may also overwrite itself, but
  // never a run that has moved on to retrying/running under a new attempt.
  const changed = db.run(`UPDATE automation_runs
    SET status = ?3, delivered_json = ?4, session_id = ?5, summary = ?6, error = ?7,
        finished_at = ?8, next_attempt_at = NULL, lease_expires_at = NULL, updated_at = ?8
    WHERE id = ?1 AND attempt = ?2 AND status IN ('running', ?3)`, [runId, expectedAttempt, status,
    JSON.stringify(delivered), sessionId, summary, error, now]).changes === 1;
  if (changed) pruneRunHistory(db, runId);
  return changed;
}

export type RunFinalizeOutcome = 'finished' | 'retry_scheduled' | 'superseded';

export function retryOrFinishRun(
  db: DatabaseHandle, runId: string, expectedAttempt: number, automation: AutomationDefinition,
  terminalStatus: string, sessionId: string | null, error: string, notifyOnTerminal: boolean,
): RunFinalizeOutcome {
  const row = db.get('SELECT attempt, max_attempts, status, delivered_json FROM automation_runs WHERE id = ?1', [runId]);
  if (row === undefined) throw AppError.database('Failed to load automation attempt: Query returned no rows');
  const attempt = num(row.attempt);
  const maxAttempts = num(row.max_attempts);
  const currentStatus = text(row.status);
  if (attempt !== expectedAttempt || currentStatus !== 'running') return 'superseded';
  if (attempt < maxAttempts) {
    const exponent = Math.max(0, Math.min(10, attempt - 1));
    const delay = Math.min(automation.retry_backoff_seconds * 2 ** exponent, 86_400);
    const nextAttempt = formatTimestampMillis(Date.now() + delay * 1000);
    const changed = db.run(`UPDATE automation_runs
      SET status = 'retrying', error = ?2, session_id = ?3, next_attempt_at = ?4,
          finished_at = NULL, lease_expires_at = NULL, updated_at = ?5
      WHERE id = ?1 AND status = 'running' AND attempt = ?6`,
    [runId, error, sessionId, nextAttempt, nowString(), expectedAttempt]).changes;
    return changed === 1 ? 'retry_scheduled' : 'superseded';
  }
  let delivered: string[] = [];
  try {
    const parsed: unknown = JSON.parse(text(row.delivered_json) ?? '[]');
    if (Array.isArray(parsed)) delivered = parsed.filter((value): value is string => typeof value === 'string');
  } catch { delivered = []; }
  if (notifyOnTerminal && !delivered.includes('notification') && !delivered.includes('notification_pending')) {
    delivered.push('notification_pending');
  }
  return completeRun(db, runId, expectedAttempt, terminalStatus, delivered, sessionId, null, error)
    ? 'finished' : 'superseded';
}
