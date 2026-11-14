import type { DatabaseHandle, SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import {
  type AutomationSchedule, type CatchUpPolicy, DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BACKOFF_SECS, DEFAULT_TIMEOUT_SECS, computeNextTrigger, formatTimestampMillis,
} from '../src/automation-schedule.ts';
import type { ActionType, AutomationDefinition, HeadlessSessionMode } from './automations.ts';

export const AUTOMATIONS_KEY = 'chat_v2.automations';
export const AUTOMATION_LEGACY_MIGRATED_KEY = 'chat_v2.automations_table_migrated';

function parseSchedule(value: unknown): AutomationSchedule {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('schedule must be an object');
  }
  const object = value as Record<string, unknown>;
  const kind = object.kind;
  if (kind !== 'daily' && kind !== 'weekly' && kind !== 'weekdays' && kind !== 'monthly'
    && kind !== 'interval' && kind !== 'once') {
    throw new Error(`unknown schedule kind '${String(kind)}'`);
  }
  const numberOrNull = (key: string): number | null => typeof object[key] === 'number' ? object[key] as number : null;
  const stringOrNull = (key: string): string | null => typeof object[key] === 'string' ? object[key] as string : null;
  return {
    kind,
    time: typeof object.time === 'string' ? object.time : '',
    weekday: numberOrNull('weekday'),
    weekdays: Array.isArray(object.weekdays)
      ? object.weekdays.filter((day): day is number => typeof day === 'number') : null,
    day_of_month: numberOrNull('day_of_month'),
    interval_minutes: numberOrNull('interval_minutes'),
    date: stringOrNull('date'),
    timezone: stringOrNull('timezone'),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Serde defaults for `AutomationDefinition`: legacy JSON predates action/heartbeat/headless fields. */
export function parseLegacyDefinition(value: unknown): AutomationDefinition {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('automation must be an object');
  }
  const object = value as Record<string, unknown>;
  const actionType: ActionType = object.action_type === 'agent_turn' ? 'agent_turn' : 'notify';
  const sessionModeRaw = object.session_mode;
  const sessionMode: HeadlessSessionMode | null = sessionModeRaw === 'named' ? 'named'
    : sessionModeRaw === 'isolated' ? 'isolated' : null;
  const catchUpRaw = object.catch_up_policy;
  const catchUpPolicy: CatchUpPolicy = catchUpRaw === 'skip' ? 'skip'
    : catchUpRaw === 'catch_up_all' ? 'catch_up_all' : 'run_once';
  const profile = object.trusted_profile;
  return {
    id: String(object.id ?? ''),
    name: String(object.name ?? ''),
    schedule: parseSchedule(object.schedule),
    prompt: typeof object.prompt === 'string' ? object.prompt : '',
    enabled: object.enabled === true,
    created_at: String(object.created_at ?? ''),
    session_id: typeof object.session_id === 'string' ? object.session_id : '',
    last_run_at: stringOrNull(object.last_run_at),
    next_run_at: stringOrNull(object.next_run_at),
    action_type: actionType,
    heartbeat: object.heartbeat === true,
    agent_prompt: stringOrNull(object.agent_prompt),
    session_mode: sessionMode,
    model_id: stringOrNull(object.model_id),
    agent_session_id: stringOrNull(object.agent_session_id),
    catch_up_policy: catchUpPolicy,
    max_retries: typeof object.max_retries === 'number' ? object.max_retries : DEFAULT_MAX_RETRIES,
    retry_backoff_seconds: typeof object.retry_backoff_seconds === 'number'
      ? object.retry_backoff_seconds : DEFAULT_RETRY_BACKOFF_SECS,
    timeout_seconds: typeof object.timeout_seconds === 'number'
      ? object.timeout_seconds : DEFAULT_TIMEOUT_SECS,
    trusted_profile: profile !== null && typeof profile === 'object'
      ? profile as AutomationDefinition['trusted_profile'] : null,
    version: typeof object.version === 'number' ? object.version : 1,
  };
}

/**
 * automations.rs:1221–1268: import the legacy settings JSON once. The source
 * value is kept as a rollback snapshot; the marker prevents a second import.
 *
 * D1: Rust does not put the settings reads and the marker write in the same
 * transaction as the definition inserts (`automations.rs:1221–1268`): it reads
 * and parses first, commits the inserts, then saves the marker. The settings
 * owner's `get`/`save` keep that original boundary; wrapping the owner
 * `*WithConn` methods in one transaction would change the Rust commit order.
 */
export interface LegacyAutomationSettings {
  get(key: string): string | null;
  save(key: string, value: string): void;
}

function parseLegacyAutomations(raw: string | null): AutomationDefinition[] {
  if (raw === null || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw AppError.internal(`Failed to parse legacy automations: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw AppError.internal('Failed to parse legacy automations: expected an array');
  try {
    return parsed.map(parseLegacyDefinition);
  } catch (error) {
    throw AppError.internal(`Failed to parse legacy automations: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function insertLegacyAutomations(
  executor: SqlExecutor, definitions: readonly AutomationDefinition[],
  insert: (executor: SqlExecutor, automation: AutomationDefinition) => void,
  nowMs: number,
): number {
  let migrated = 0;
  for (const automation of definitions) {
    const exists = Number(executor.pluck<SqlValue>('SELECT EXISTS(SELECT 1 FROM automation_definitions WHERE id = ?1)',
      [automation.id])) !== 0;
    if (exists) continue;
    if (automation.next_run_at === null && automation.enabled) {
      try {
        automation.next_run_at = formatTimestampMillis(computeNextTrigger(automation.schedule, nowMs));
      } catch {
        automation.next_run_at = null;
      }
    }
    insert(executor, automation);
    migrated += 1;
  }
  return migrated;
}

export function migrateLegacyAutomations(
  settings: LegacyAutomationSettings,
  db: DatabaseHandle, insert: (executor: SqlExecutor, automation: AutomationDefinition) => void,
  nowMs: number = Date.now(),
): number {
  if (settings.get(AUTOMATION_LEGACY_MIGRATED_KEY) === 'true') return 0;
  const definitions = parseLegacyAutomations(settings.get(AUTOMATIONS_KEY));
  let migrated = 0;
  db.transaction((tx) => {
    migrated = insertLegacyAutomations(tx, definitions, insert, nowMs);
  }, { behavior: 'immediate' });
  // Rust saves the marker after the definition transaction commits; a marker
  // failure leaves the imported definitions committed.
  settings.save(AUTOMATION_LEGACY_MIGRATED_KEY, 'true');
  return migrated;
}
