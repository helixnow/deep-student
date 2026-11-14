/**
 * 自动化定义仓储（automations.rs 的定义 CRUD、schedule 序列化、列表映射、
 * 心跳定义与 next_run_at 维护）。运行记录/租约/通知回执在 `automation-runs.ts`。
 */
import type { DatabaseHandle, SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import {
  type AutomationSchedule, type CatchUpPolicy,
  DEFAULT_HEARTBEAT_INTERVAL_MINUTES, DEFAULT_MAX_RETRIES, DEFAULT_RETRY_BACKOFF_SECS, DEFAULT_TIMEOUT_SECS,
  MAX_AUTOMATIONS, MAX_NAME_LEN, MAX_PROMPT_LEN,
  computeNextTrigger, formatTimestampMillis,
  normalizeScheduleShape, onceSlotAlreadyConsumed, parseTimestampMillis,
  validateAutomationFields, validateSchedule,
} from '../src/automation-schedule.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { errorMessage } from '../src/automation-errors.ts';
import { decodeAutomationSchedule } from '../src/automation-schedule-json.ts';
import { cancelAutomationRunToken } from '../src/automation-run-guard.ts';
import {
  decodePersistedTrustedProfile, sealTrustedProfile, serializeTrustedProfile, type TrustedAutomationProfile,
} from '../src/trusted-profile.ts';
import {
  type ActionType, type AutomationCreateFields, type AutomationDefinition,
  type AutomationUpdateFields, type HeadlessSessionMode,
  dbError, isAppError, nowString, num, text, versionParam, HEARTBEAT_AUTOMATION_ID,
} from './automation-model.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';

function scheduleObject(schedule: AutomationSchedule): Record<string, unknown> {
  const value: Record<string, unknown> = { kind: schedule.kind, time: schedule.time };
  if (schedule.weekday !== null) value.weekday = schedule.weekday;
  if (schedule.weekdays !== null) value.weekdays = schedule.weekdays;
  if (schedule.day_of_month !== null) value.day_of_month = schedule.day_of_month;
  if (schedule.interval_minutes !== null) value.interval_minutes = schedule.interval_minutes;
  if (schedule.date !== null) value.date = schedule.date;
  if (schedule.timezone !== null) value.timezone = schedule.timezone;
  return value;
}

export function serializeSchedule(schedule: AutomationSchedule): string {
  return JSON.stringify(scheduleObject(schedule));
}

/**
 * automations.rs:250–274: serde 的 `skip_serializing_if = "Option::is_none"`
 * 同样作用于 IPC 返回的 `schedule`，未设置的字段必须省略而不是输出 null。
 */
export function scheduleToListItem(schedule: AutomationSchedule): Record<string, unknown> {
  return scheduleObject(schedule);
}

export function parseScheduleJson(raw: string): AutomationSchedule {
  return decodeAutomationSchedule(raw);
}

export function rowToAutomation(row: Record<string, SqlValue>): AutomationDefinition {
  let schedule: AutomationSchedule;
  const scheduleJson = text(row.schedule_json) ?? '';
  try {
    schedule = parseScheduleJson(scheduleJson);
  } catch (error) {
    // automations.rs:960–968 wraps serde with FromSqlConversionFailure(value.len(), Text, _).
    throw new Error(`Conversion error from type Text at index: ${utf8ByteLength(scheduleJson)}, ${errorMessage(error)}`);
  }
  const actionType: ActionType = text(row.action_type) === 'agent_turn' ? 'agent_turn' : 'notify';
  const sessionModeRaw = text(row.session_mode);
  const sessionMode: HeadlessSessionMode | null = sessionModeRaw === 'named' ? 'named'
    : sessionModeRaw === 'isolated' ? 'isolated' : null;
  const catchUpRaw = text(row.catch_up_policy);
  const catchUpPolicy: CatchUpPolicy = catchUpRaw === 'skip' ? 'skip'
    : catchUpRaw === 'catch_up_all' ? 'catch_up_all' : 'run_once';
  let trustedProfile: TrustedAutomationProfile | null = null;
  const profileJson = text(row.trusted_profile_json);
  if (profileJson !== null && rustTrim(profileJson) !== '') {
    trustedProfile = decodePersistedTrustedProfile(profileJson);
  }
  return {
    id: text(row.id) ?? '',
    name: text(row.name) ?? '',
    schedule,
    prompt: text(row.prompt) ?? '',
    enabled: num(row.enabled) !== 0,
    created_at: text(row.created_at) ?? '',
    session_id: text(row.source_session_id) ?? '',
    last_run_at: text(row.last_run_at),
    next_run_at: text(row.next_run_at),
    action_type: actionType,
    heartbeat: num(row.heartbeat) !== 0,
    agent_prompt: text(row.agent_prompt),
    session_mode: sessionMode,
    model_id: text(row.model_id),
    agent_session_id: text(row.agent_session_id),
    catch_up_policy: catchUpPolicy,
    max_retries: Math.max(0, Math.min(10, num(row.max_retries))),
    retry_backoff_seconds: Math.max(5, num(row.retry_backoff_seconds)),
    timeout_seconds: Math.max(30, num(row.timeout_seconds)),
    trusted_profile: trustedProfile,
    version: Math.max(1, num(row.version)),
  };
}

export function insertAutomation(executor: SqlExecutor, automation: AutomationDefinition): void {
  const scheduleJson = serializeSchedule(automation.schedule);
  const trustedProfileJson = automation.trusted_profile === null ? null : serializeTrustedProfile(automation.trusted_profile);
  executor.run(`INSERT INTO automation_definitions (
      id, name, schedule_json, prompt, enabled, created_at, updated_at,
      source_session_id, last_run_at, next_run_at, action_type, heartbeat,
      agent_prompt, session_mode, model_id, agent_session_id, catch_up_policy,
      max_retries, retry_backoff_seconds, timeout_seconds, trusted_profile_json, version
    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)`,
  [automation.id, automation.name, scheduleJson, automation.prompt, automation.enabled ? 1 : 0,
    automation.created_at, nowString(), automation.session_id, automation.last_run_at, automation.next_run_at,
    automation.action_type, automation.heartbeat ? 1 : 0, automation.agent_prompt, automation.session_mode,
    automation.model_id, automation.agent_session_id, automation.catch_up_policy, automation.max_retries,
    automation.retry_backoff_seconds, automation.timeout_seconds, trustedProfileJson, automation.version]);
}

export function generateAutomationId(nowMs: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(4));
  let suffix = '';
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `auto_${nowMs}_${suffix}`;
}

export function automationVersionConflictError(
  automationId: string, expectedVersion: number, current: AutomationDefinition,
): AppError {
  return AppError.with_details('Conflict',
    'Automation changed after it was read. Refresh the automation list and retry with the current version.',
    {
      code: 'AUTOMATION_VERSION_CONFLICT', automationId, expectedVersion,
      currentVersion: current.version, current: automationToListObject(current, Date.now()) as unknown as JsonValue, retryable: true,
    });
}

export function createAutomation(db: DatabaseHandle, fields: AutomationCreateFields): AutomationDefinition {
  validateAutomationFields(fields.name, fields.prompt);
  validateSchedule(fields.schedule);
  normalizeScheduleShape(fields.schedule);
  if (fields.max_retries > 10) throw AppError.validation('max_retries must be between 0 and 10');
  if (fields.retry_backoff_seconds < 5 || fields.retry_backoff_seconds > 86_400) {
    throw AppError.validation('retry_backoff_seconds must be between 5 and 86400');
  }
  if (fields.timeout_seconds < 30 || fields.timeout_seconds > 3_600) {
    throw AppError.validation('timeout_seconds must be between 30 and 3600');
  }
  const trustedProfile = fields.trusted_profile === null ? null : sealTrustedProfile(fields.trusted_profile);
  if (trustedProfile !== null && fields.action_type !== 'agent_turn') {
    throw AppError.validation('trusted_profile requires action_type=agent_turn');
  }
  if (fields.action_type === 'notify'
    && (fields.agent_prompt !== null || fields.session_mode !== null || fields.model_id !== null)) {
    throw AppError.validation('agent fields require action_type=agent_turn');
  }
  if (fields.agent_prompt !== null && [...fields.agent_prompt].length > MAX_PROMPT_LEN) {
    throw AppError.validation(`agent_prompt must be at most ${MAX_PROMPT_LEN} characters`);
  }
  const nowMs = Date.now();
  const nextRunAt = fields.enabled ? formatTimestampMillis(computeNextTrigger(fields.schedule, nowMs)) : null;
  const automation: AutomationDefinition = {
    id: generateAutomationId(nowMs),
    name: rustTrim(fields.name),
    schedule: fields.schedule,
    prompt: rustTrim(fields.prompt),
    enabled: fields.enabled,
    created_at: formatTimestampMillis(nowMs),
    session_id: fields.source_session_id,
    last_run_at: null,
    next_run_at: nextRunAt,
    action_type: fields.action_type,
    heartbeat: fields.heartbeat,
    agent_prompt: fields.agent_prompt,
    session_mode: fields.session_mode,
    model_id: fields.model_id,
    agent_session_id: null,
    catch_up_policy: fields.catch_up_policy,
    max_retries: fields.max_retries,
    retry_backoff_seconds: fields.retry_backoff_seconds,
    timeout_seconds: fields.timeout_seconds,
    trusted_profile: trustedProfile,
    version: 1,
  };
  let entered = false;
  let bodyDone = false;
  try {
    db.transaction((tx) => {
      entered = true;
      let count: number;
      try {
        count = num(tx.pluck<SqlValue>('SELECT COUNT(*) FROM automation_definitions'));
      } catch (error) {
        throw dbError('Failed to count automations', error);
      }
      if (count >= MAX_AUTOMATIONS) {
        throw AppError.validation(`Automation limit reached (max ${MAX_AUTOMATIONS})`);
      }
      try {
        insertAutomation(tx, automation);
      } catch (error) {
        if (isAppError(error)) throw error;
        throw dbError('Failed to insert automation', error);
      }
      bodyDone = true;
    }, { behavior: 'immediate' });
  } catch (error) {
    if (isAppError(error)) throw error;
    if (!entered) throw dbError('Failed to start automation create', error);
    if (bodyDone) throw dbError('Failed to commit automation create', error);
    throw dbError('Failed to insert automation', error);
  }
  return automation;
}

export function loadAutomations(db: SqlExecutor): AutomationDefinition[] {
  try {
    return db.all('SELECT * FROM automation_definitions ORDER BY created_at ASC, id ASC').map(rowToAutomation);
  } catch (error) {
    throw dbError('Failed to load automations', error);
  }
}

export function saveAutomations(db: DatabaseHandle, automations: readonly AutomationDefinition[]): void {
  try {
    db.transaction((tx) => {
      tx.run('DELETE FROM automation_definitions');
      for (const automation of automations) insertAutomation(tx, automation);
    }, { behavior: 'immediate' });
  } catch (error) {
    if (isAppError(error)) throw error;
    throw dbError('Failed to save automations', error);
  }
}

export function loadAutomation(tx: SqlExecutor, automationId: string): AutomationDefinition | null {
  const row = tx.get('SELECT * FROM automation_definitions WHERE id = ?1', [automationId]);
  return row === undefined ? null : rowToAutomation(row);
}

export function setAutomationEnabled(
  db: DatabaseHandle, automationId: string, expectedVersion: number, enabled: boolean,
): { previous: AutomationDefinition; current: AutomationDefinition } {
  const versionDb = versionParam(expectedVersion);
  let entered = false;
  let bodyDone = false;
  let noOp = false;
  try {
    return db.transaction((tx) => {
      entered = true;
      let previous: AutomationDefinition | null;
      try {
        previous = loadAutomation(tx, automationId);
      } catch (error) {
        throw dbError('Failed to load automation', error);
      }
      if (previous === null) throw AppError.validation(`Automation '${automationId}' not found`);
      if (previous.version !== expectedVersion) {
        throw automationVersionConflictError(automationId, expectedVersion, previous);
      }
      if (previous.enabled === enabled) {
        noOp = true;
        bodyDone = true;
        return { previous, current: previous };
      }
      const nextRunAt = enabled
        ? (() => {
          try {
            const slot = computeNextTrigger(previous.schedule, Date.now());
            return onceSlotAlreadyConsumed(previous, slot) ? null : formatTimestampMillis(slot);
          } catch { return null; }
        })()
        : null;
      let affected: number;
      try {
        affected = tx.run(`UPDATE automation_definitions
          SET enabled = ?2, next_run_at = ?3, updated_at = ?4, version = version + 1
          WHERE id = ?1 AND version = ?5`,
        [automationId, enabled ? 1 : 0, nextRunAt, nowString(), versionDb]).changes;
      } catch (error) {
        throw dbError('Failed to update automation', error);
      }
      if (affected === 0) throw automationVersionConflictError(automationId, expectedVersion, previous);
      const runningRunIds: string[] = [];
      if (!enabled) {
        const now = nowString();
        try {
          tx.run(`UPDATE automation_runs
            SET status = 'cancelled', finished_at = ?2, next_attempt_at = NULL, updated_at = ?2
            WHERE automation_id = ?1 AND status IN ('queued', 'retrying')`, [automationId, now]);
        } catch (error) {
          throw dbError('Failed to cancel pending automation retries', error);
        }
        // `running` 的 run 由执行器持有，不能直接改状态：只记下 id，提交后再取消令牌。
        try {
          for (const row of tx.all("SELECT id FROM automation_runs WHERE automation_id = ?1 AND status = 'running'", [automationId])) {
            runningRunIds.push(String(row.id));
          }
        } catch (error) {
          throw dbError('Failed to query running automation runs', error);
        }
      }
      let current: AutomationDefinition | null;
      try {
        current = loadAutomation(tx, automationId);
      } catch (error) {
        throw dbError('Failed to reload automation', error);
      }
      if (current === null) throw dbError('Failed to reload automation', 'missing row');
      // Rust 在 `tx.commit()` 之后才取消令牌。
      tx.afterCommit(() => {
        for (const runId of runningRunIds) cancelAutomationRunToken(runId);
      });
      bodyDone = true;
      return { previous, current };
    }, { behavior: 'immediate' });
  } catch (error) {
    if (isAppError(error)) throw error;
    if (!entered) throw dbError('Failed to start automation update', error);
    if (bodyDone) throw dbError(noOp ? 'Failed to commit automation no-op' : 'Failed to commit automation update', error);
    throw dbError('Failed to update automation', error);
  }
}

function hasEditableField(fields: AutomationUpdateFields): boolean {
  return fields.name !== undefined || fields.schedule !== undefined || fields.prompt !== undefined
    || fields.actionType !== undefined || fields.agentPrompt !== undefined || fields.sessionMode !== undefined
    || fields.modelId !== undefined || fields.catchUpPolicy !== undefined || fields.maxRetries !== undefined
    || fields.retryBackoffSeconds !== undefined || fields.timeoutSeconds !== undefined
    || fields.trustedProfile !== undefined;
}

export function updateAutomationFull(
  db: DatabaseHandle, automationId: string, expectedVersion: number, fields: AutomationUpdateFields,
): { previous: AutomationDefinition; current: AutomationDefinition } {
  const versionDb = versionParam(expectedVersion);
  if (!hasEditableField(fields)) throw AppError.validation('At least one editable field is required');
  if (fields.schedule !== undefined) {
    validateSchedule(fields.schedule);
    normalizeScheduleShape(fields.schedule);
  }
  if (fields.name !== undefined) {
    const name = rustTrim(fields.name);
    if (name === '') throw AppError.validation('name must not be empty');
    if ([...name].length > MAX_NAME_LEN) throw AppError.validation(`name must be at most ${MAX_NAME_LEN} characters`);
  }
  if (fields.prompt !== undefined) {
    if (rustTrim(fields.prompt) === '') throw AppError.validation('prompt must not be empty');
    if ([...fields.prompt].length > MAX_PROMPT_LEN) throw AppError.validation(`prompt must be at most ${MAX_PROMPT_LEN} characters`);
  }
  if (fields.agentPrompt !== undefined && fields.agentPrompt.value !== null && [...fields.agentPrompt.value].length > MAX_PROMPT_LEN) {
    throw AppError.validation(`agent_prompt must be at most ${MAX_PROMPT_LEN} characters`);
  }
  if (fields.maxRetries !== undefined && (fields.maxRetries < 0 || fields.maxRetries > 10)) {
    throw AppError.validation('max_retries must be between 0 and 10');
  }
  if (fields.retryBackoffSeconds !== undefined && (fields.retryBackoffSeconds < 5 || fields.retryBackoffSeconds > 86_400)) {
    throw AppError.validation('retry_backoff_seconds must be between 5 and 86400');
  }
  if (fields.timeoutSeconds !== undefined && (fields.timeoutSeconds < 30 || fields.timeoutSeconds > 3_600)) {
    throw AppError.validation('timeout_seconds must be between 30 and 3600');
  }
  let entered = false;
  let bodyDone = false;
  try {
    return db.transaction((tx) => {
      entered = true;
      let previous: AutomationDefinition | null;
      try {
        previous = loadAutomation(tx, automationId);
      } catch (error) {
        throw dbError('Failed to load automation', error);
      }
      if (previous === null) throw AppError.validation(`Automation '${automationId}' not found`);
      if (previous.version !== expectedVersion) {
        throw automationVersionConflictError(automationId, expectedVersion, previous);
      }
      const current: AutomationDefinition = {
        ...previous, schedule: { ...previous.schedule },
        ...(fields.trustedProfile !== undefined
          ? { trusted_profile: fields.trustedProfile.value === null ? null : sealTrustedProfile(fields.trustedProfile.value) }
          : {}),
      };
      if (fields.name !== undefined) current.name = rustTrim(fields.name);
      if (fields.schedule !== undefined) {
        current.schedule = fields.schedule;
        if (current.enabled) {
          try { current.next_run_at = formatTimestampMillis(computeNextTrigger(current.schedule, Date.now())); }
          catch { current.next_run_at = null; }
        } else current.next_run_at = null;
      }
      if (fields.prompt !== undefined) current.prompt = rustTrim(fields.prompt);
      if (fields.actionType !== undefined) {
        current.action_type = fields.actionType;
        if (fields.actionType === 'notify') {
          current.agent_prompt = null;
          current.session_mode = null;
          current.model_id = null;
          current.agent_session_id = null;
          current.trusted_profile = null;
        }
      }
      if (fields.agentPrompt !== undefined) {
        const value = fields.agentPrompt.value === null ? '' : rustTrim(fields.agentPrompt.value);
        current.agent_prompt = value === '' ? null : value;
      }
      if (fields.sessionMode !== undefined) {
        current.session_mode = fields.sessionMode.value;
        if (current.session_mode !== 'named') current.agent_session_id = null;
      }
      if (fields.modelId !== undefined) {
        const value = fields.modelId.value === null ? '' : rustTrim(fields.modelId.value);
        current.model_id = value === '' ? null : value;
      }
      if (fields.catchUpPolicy !== undefined) current.catch_up_policy = fields.catchUpPolicy;
      if (fields.maxRetries !== undefined) current.max_retries = fields.maxRetries;
      if (fields.retryBackoffSeconds !== undefined) current.retry_backoff_seconds = fields.retryBackoffSeconds;
      if (fields.timeoutSeconds !== undefined) current.timeout_seconds = fields.timeoutSeconds;
      if (current.action_type === 'notify'
        && (current.agent_prompt !== null || current.session_mode !== null
          || current.model_id !== null || current.trusted_profile !== null)) {
        throw AppError.validation('agent fields require action_type=agent_turn');
      }
      const scheduleJson = serializeSchedule(current.schedule);
      const trustedProfileJson = current.trusted_profile === null ? null : serializeTrustedProfile(current.trusted_profile);
      let affected: number;
      try {
        affected = tx.run(`UPDATE automation_definitions
          SET name = ?2, schedule_json = ?3, prompt = ?4, action_type = ?5,
              agent_prompt = ?6, session_mode = ?7, model_id = ?8,
              agent_session_id = ?9, catch_up_policy = ?10, max_retries = ?11,
              retry_backoff_seconds = ?12, timeout_seconds = ?13,
              next_run_at = ?14, trusted_profile_json = ?15, updated_at = ?16, version = version + 1
          WHERE id = ?1 AND version = ?17`,
        [automationId, current.name, scheduleJson, current.prompt, current.action_type,
          current.agent_prompt, current.session_mode, current.model_id, current.agent_session_id,
          current.catch_up_policy, current.max_retries, current.retry_backoff_seconds,
          current.timeout_seconds, current.next_run_at, trustedProfileJson, nowString(), versionDb]).changes;
      } catch (error) {
        throw dbError('Failed to update automation', error);
      }
      if (affected === 0) throw automationVersionConflictError(automationId, expectedVersion, previous);
      let reloaded: AutomationDefinition | null;
      try {
        reloaded = loadAutomation(tx, automationId);
      } catch (error) {
        throw dbError('Failed to reload automation', error);
      }
      if (reloaded === null) throw dbError('Failed to reload automation', 'missing row');
      bodyDone = true;
      return { previous, current: reloaded };
    }, { behavior: 'immediate' });
  } catch (error) {
    if (isAppError(error)) throw error;
    if (!entered) throw dbError('Failed to start automation update', error);
    if (bodyDone) throw dbError('Failed to commit automation update', error);
    throw dbError('Failed to update automation', error);
  }
}

export function deleteAutomation(db: DatabaseHandle, automationId: string, expectedVersion: number): AutomationDefinition {
  const versionDb = versionParam(expectedVersion);
  let entered = false;
  let bodyDone = false;
  try {
    return db.transaction((tx) => {
      entered = true;
      let deleted: AutomationDefinition | null;
      try {
        deleted = loadAutomation(tx, automationId);
      } catch (error) {
        throw dbError('Failed to load automation', error);
      }
      if (deleted === null) throw AppError.validation(`Automation '${automationId}' not found`);
      if (deleted.version !== expectedVersion) {
        throw automationVersionConflictError(automationId, expectedVersion, deleted);
      }
      if (deleted.heartbeat || deleted.id === HEARTBEAT_AUTOMATION_ID) {
        throw AppError.validation('The built-in heartbeat automation cannot be deleted; disable it instead');
      }
      let hasActiveRuns: boolean;
      try {
        hasActiveRuns = num(tx.pluck(`SELECT EXISTS(
          SELECT 1 FROM automation_runs WHERE automation_id = ?1 AND status IN ('queued', 'running', 'retrying'))`,
        [automationId])) !== 0;
      } catch (error) {
        throw dbError('Failed to check active automation runs', error);
      }
      if (hasActiveRuns) throw AppError.validation('Cancel active runs before deleting this automation');
      let affected: number;
      try {
        affected = tx.run('DELETE FROM automation_definitions WHERE id = ?1 AND version = ?2',
          [automationId, versionDb]).changes;
      } catch (error) {
        throw dbError('Failed to delete automation', error);
      }
      if (affected === 0) throw automationVersionConflictError(automationId, expectedVersion, deleted);
      bodyDone = true;
      return deleted;
    }, { behavior: 'immediate' });
  } catch (error) {
    if (isAppError(error)) throw error;
    if (!entered) throw dbError('Failed to start automation delete', error);
    if (bodyDone) throw dbError('Failed to commit automation delete', error);
    throw dbError('Failed to delete automation', error);
  }
}

function automationActionValue(actionType: ActionType): string {
  return actionType;
}

export function automationToListItem(automation: AutomationDefinition, nowMs: number): Record<string, unknown> {
  let nextTrigger = automation.next_run_at;
  if (nextTrigger === null && automation.enabled) {
    try {
      const slot = computeNextTrigger(automation.schedule, nowMs);
      nextTrigger = onceSlotAlreadyConsumed(automation, slot) ? null : formatTimestampMillis(slot);
    } catch {
      nextTrigger = 'unknown';
    }
  }
  const sessionMode = automation.action_type === 'notify' ? null : (automation.session_mode ?? 'isolated');
  return {
    id: automation.id, name: automation.name, schedule: scheduleToListItem(automation.schedule), prompt: automation.prompt,
    enabled: automation.enabled, created_at: automation.created_at, session_id: automation.session_id,
    last_run_at: automation.last_run_at, next_trigger_at: nextTrigger,
    action_type: automationActionValue(automation.action_type), heartbeat: automation.heartbeat,
    agent_prompt: automation.agent_prompt, session_mode: sessionMode, model_id: automation.model_id,
    agent_session_id: automation.agent_session_id, catch_up_policy: automation.catch_up_policy,
    max_retries: automation.max_retries, retry_backoff_seconds: automation.retry_backoff_seconds,
    timeout_seconds: automation.timeout_seconds, trusted_profile: automation.trusted_profile,
    version: automation.version,
  };
}

export function automationToListObject(automation: AutomationDefinition, nowMs: number): Record<string, unknown> {
  return automationToListItem(automation, nowMs);
}

export function automationListResponse(db: SqlExecutor): Record<string, unknown> {
  const automations = loadAutomations(db);
  const now = Date.now();
  return { count: automations.length, max: MAX_AUTOMATIONS,
    automations: automations.map((automation) => automationToListItem(automation, now)) };
}

/** automations.rs:596–604. */
export function effectiveAgentPrompt(automation: AutomationDefinition): string {
  const candidate = automation.agent_prompt === null ? '' : rustTrim(automation.agent_prompt);
  // automations.rs:596–604：返回 trim 后的非空 agent_prompt。
  return candidate === '' ? automation.prompt : candidate;
}

function truncateAgentText(value: string): { text: string; truncated: boolean } {
  const chars = [...value];
  return { text: chars.slice(0, 2_000).join(''), truncated: chars.length > 2_000 };
}

/** automations.rs:1812–1835: the Agent-facing mapping is bounded at 2000 chars. */
export function automationToAgentListItem(automation: AutomationDefinition, nowMs: number): Record<string, unknown> {
  const value = automationToListItem(automation, nowMs);
  const fieldsTruncated: string[] = [];
  for (const field of ['prompt', 'agent_prompt'] as const) {
    const source = automation[field];
    if (source !== null) {
      const bounded = truncateAgentText(source);
      value[field] = bounded.text;
      if (bounded.truncated) fieldsTruncated.push(field);
    }
  }
  value.promptTruncated = fieldsTruncated.includes('prompt') || fieldsTruncated.includes('agent_prompt');
  value.fieldsTruncated = fieldsTruncated;
  return value;
}

export function updateAutomationLastRunAt(db: SqlExecutor, automationId: string, firedAt: string): void {
  db.run('UPDATE automation_definitions SET last_run_at = ?2, updated_at = ?3 WHERE id = ?1',
    [automationId, firedAt, nowString()]);
}

export function updateAutomationAgentSessionId(
  db: SqlExecutor, automationId: string, expectedVersion: number, sessionId: string,
): void {
  db.run(`UPDATE automation_definitions
    SET agent_session_id = ?2, updated_at = ?3
    WHERE id = ?1 AND version = ?4 AND action_type = 'agent_turn' AND session_mode = 'named'`,
  [automationId, sessionId, nowString(), expectedVersion]);
}

export const DEFAULT_HEARTBEAT_PROMPT = `你是 Deep Student 的后台心跳检查代理。请依次检查以下清单（只使用可用的只读工具，工具不可用则跳过该项）：
1. 用 builtin-user_todo_get_summary 检查今天到期或已逾期的待办事项；
2. 用 builtin-qbank_list（include_stats=true）留意最近 3 天没有练习记录、或错误率偏高需要复习的题库/错题本；
3. 如需补充上下文，可用 builtin-unified_search 搜索相关学习记录。
输出规则：
- 如果所有检查都没有需要用户关注的事项，只输出 HEARTBEAT_OK，不要输出任何其他内容；
- 如果有需要关注的事项，用简洁中文逐条列出（数量 + 建议动作），且不要出现 HEARTBEAT_OK 字样；
- 不要向用户提问，不要执行任何写操作或高敏感操作。`;

/** automations.rs:4228–4261. */
export function defaultHeartbeatDefinition(nowMs: number): AutomationDefinition {
  return {
    id: HEARTBEAT_AUTOMATION_ID, name: '学习心跳检查',
    schedule: { kind: 'interval', time: '', weekday: null, weekdays: null, day_of_month: null,
      interval_minutes: DEFAULT_HEARTBEAT_INTERVAL_MINUTES, date: null, timezone: null },
    prompt: DEFAULT_HEARTBEAT_PROMPT, enabled: false, created_at: formatTimestampMillis(nowMs),
    session_id: '', last_run_at: null, next_run_at: null, action_type: 'agent_turn', heartbeat: true,
    agent_prompt: null, session_mode: null, model_id: null, agent_session_id: null,
    catch_up_policy: 'run_once', max_retries: DEFAULT_MAX_RETRIES,
    retry_backoff_seconds: DEFAULT_RETRY_BACKOFF_SECS, timeout_seconds: DEFAULT_TIMEOUT_SECS,
    trusted_profile: null, version: 1,
  };
}

/** automations.rs:4264–4276. Mutates the list like the Rust helper. */
export function ensureHeartbeatInList(automations: AutomationDefinition[], nowMs: number): boolean {
  if (automations.some((automation) => automation.heartbeat || automation.id === HEARTBEAT_AUTOMATION_ID)) {
    return false;
  }
  automations.push(defaultHeartbeatDefinition(nowMs));
  return true;
}

/** automations.rs:4282–4300：幂等预置心跳自动化（默认 disabled）。 */
export function ensureHeartbeatAutomation(db: SqlExecutor, nowMs: number = Date.now()): boolean {
  const exists = loadAutomations(db).some(
    (automation) => automation.heartbeat || automation.id === HEARTBEAT_AUTOMATION_ID);
  if (exists) return false;
  try {
    insertAutomation(db, defaultHeartbeatDefinition(nowMs));
    return true;
  } catch (error) {
    if (errorMessage(error).includes('UNIQUE')) return false;
    throw error;
  }
}

/** automations.rs:3701–3703. Rust `str::trim`. */
export function heartbeatIsSilent(content: string): boolean {
  return rustTrim(content) === 'HEARTBEAT_OK';
}

/** automations.rs:5382–5394: maximum plausible gap between two triggers, in ms. */
export function scheduleSkewThreshold(schedule: AutomationSchedule): number | null {
  switch (schedule.kind) {
    case 'daily': return 48 * 3_600_000;
    case 'weekly': return 14 * 86_400_000;
    case 'weekdays': return 6 * 86_400_000;
    case 'interval': return schedule.interval_minutes === null ? null : schedule.interval_minutes * 2 * 60_000;
    case 'monthly':
    case 'once': return null;
  }
}

export { DEFAULT_HEARTBEAT_INTERVAL_MINUTES, DEFAULT_MAX_RETRIES, DEFAULT_RETRY_BACKOFF_SECS, DEFAULT_TIMEOUT_SECS };

export function initializeNextRun(db: SqlExecutor, automation: AutomationDefinition): void {
  if (!automation.enabled || automation.next_run_at !== null) return;
  const now = Date.now();
  if (automation.schedule.kind === 'once') {
    let consumed = false;
    try {
      consumed = computeNextTrigger(automation.schedule, now) <= now;
    } catch { consumed = false; }
    if (consumed) return;
  }
  const next = formatTimestampMillis(computeNextTrigger(automation.schedule, now));
  db.run('UPDATE automation_definitions SET next_run_at = ?2, updated_at = ?3 WHERE id = ?1 AND enabled = 1 AND next_run_at IS NULL',
    [automation.id, next, nowString()]);
}

/** automations.rs:5398–5444: clock-skew / dirty data guard before claim. */
export function repairSkewedNextRun(
  db: DatabaseHandle, automation: AutomationDefinition, expectedNextRunAt: string, nowMs: number,
): string | null {
  const threshold = scheduleSkewThreshold(automation.schedule);
  if (threshold === null) return null;
  const scheduledFor = parseTimestampMillis(expectedNextRunAt);
  if (scheduledFor === null) throw AppError.internal('Invalid automation timestamp');
  if (scheduledFor - nowMs <= threshold) return null;
  const fresh = formatTimestampMillis(computeNextTrigger(automation.schedule, nowMs));
  let changed: number;
  try {
    changed = db.run(`UPDATE automation_definitions
      SET next_run_at = ?3, updated_at = ?4
      WHERE id = ?1 AND enabled = 1 AND next_run_at = ?2`,
    [automation.id, expectedNextRunAt, fresh, nowString()]).changes;
  } catch (error) {
    throw dbError('Failed to repair skewed next_run_at', error);
  }
  if (changed !== 1) return null;
  return fresh;
}
