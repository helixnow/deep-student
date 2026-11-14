import type { Commands } from '../../../../contracts/ipc/generated/L06-agent-orchestration.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { ActionType, AutomationCreateFields, AutomationUpdateFields, HeadlessSessionMode, OptionalValue } from '../repository/automations.ts';
import type { TrustedAutomationProfile } from './trusted-profile.ts';
import type { AutomationSchedule, CatchUpPolicy, ScheduleKind } from './automation-schedule.ts';

type CreateRequest = Commands['chat_v2_automation_create']['args']['request'];
type UpdateRequest = Commands['chat_v2_automation_update']['args']['request'];
type ScheduleRequest = CreateRequest['schedule'];

const SCHEDULE_KINDS: readonly ScheduleKind[] = ['daily', 'weekly', 'weekdays', 'monthly', 'interval', 'once'];
const CATCH_UP_POLICIES: readonly CatchUpPolicy[] = ['skip', 'run_once', 'catch_up_all'];
const ACTION_TYPES: readonly ActionType[] = ['notify', 'agent_turn'];
const SESSION_MODES: readonly HeadlessSessionMode[] = ['isolated', 'named'];

function variant(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && (value as Record<string, unknown>)[keys[0]!] === null) return keys[0]!;
  }
  return null;
}

function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const name = variant(value);
  if (name !== null && (allowed as readonly string[]).includes(name)) return name as T;
  throw AppError.validation(`Invalid ${field} '${name ?? String(value)}'. Allowed: ${allowed.join(', ')}`);
}

export function normalizeScheduleKind(value: unknown): ScheduleKind {
  return normalizeEnum(value, SCHEDULE_KINDS, 'schedule kind');
}

export function scheduleFromRequest(request: ScheduleRequest): AutomationSchedule {
  return {
    kind: normalizeScheduleKind(request.kind),
    time: request.time ?? '',
    weekday: request.weekday ?? null,
    weekdays: request.weekdays ?? null,
    day_of_month: request.dayOfMonth ?? null,
    interval_minutes: request.intervalMinutes ?? null,
    date: request.date ?? null,
    timezone: request.timezone ?? null,
  };
}

export function actionTypeFromRequest(value: unknown, defaultValue: ActionType | null): ActionType | null {
  if (value === undefined || value === null) return defaultValue;
  return normalizeEnum(value, ACTION_TYPES, 'action type');
}

export function catchUpPolicyFromRequest(value: unknown): CatchUpPolicy {
  if (value === undefined || value === null) return 'run_once';
  return normalizeEnum(value, CATCH_UP_POLICIES, 'catch_up_policy');
}

export function sessionModeFromRequest(value: unknown): HeadlessSessionMode | null {
  if (value === undefined || value === null) return null;
  return normalizeEnum(value, SESSION_MODES, 'session_mode');
}

export function createFieldsFromRequest(request: CreateRequest, trustedProfile: AutomationCreateFields['trusted_profile']): AutomationCreateFields {
  return {
    name: request.name,
    schedule: scheduleFromRequest(request.schedule),
    prompt: request.prompt,
    enabled: request.enabled ?? true,
    action_type: actionTypeFromRequest(request.actionType, 'notify')!,
    heartbeat: false,
    agent_prompt: request.agentPrompt ?? null,
    session_mode: sessionModeFromRequest(request.sessionMode),
    model_id: request.modelId ?? null,
    catch_up_policy: catchUpPolicyFromRequest(request.catchUpPolicy),
    max_retries: request.maxRetries ?? 2,
    retry_backoff_seconds: request.retryBackoffSeconds ?? 60,
    timeout_seconds: request.timeoutSeconds ?? 600,
    trusted_profile: trustedProfile,
    source_session_id: 'ui',
  };
}

/** `deserialize_optional_nullable`: absent -> undefined, explicit null -> {value:null}. */
function optionalNullable<T>(request: UpdateRequest, key: keyof UpdateRequest, map: (value: unknown) => T): { value: T | null } | undefined {
  if (!Object.hasOwn(request, key)) return undefined;
  const raw = request[key];
  if (raw === null || raw === undefined) return { value: null };
  return { value: map(raw) };
}

export function updateFieldsFromRequest(
  request: UpdateRequest, trustedProfile: OptionalValue<TrustedAutomationProfile> | undefined,
): AutomationUpdateFields {
  const fields: AutomationUpdateFields = {};
  if (request.name !== undefined && request.name !== null) fields.name = request.name;
  if (request.schedule !== undefined && request.schedule !== null) fields.schedule = scheduleFromRequest(request.schedule);
  if (request.prompt !== undefined && request.prompt !== null) fields.prompt = request.prompt;
  if (request.actionType !== undefined && request.actionType !== null) {
    fields.actionType = actionTypeFromRequest(request.actionType, null)!;
  }
  const agentPrompt = optionalNullable(request, 'agentPrompt', (value) => String(value));
  if (agentPrompt !== undefined) fields.agentPrompt = agentPrompt;
  const sessionMode = optionalNullable(request, 'sessionMode', (value) => normalizeEnum(value, SESSION_MODES, 'session_mode'));
  if (sessionMode !== undefined) fields.sessionMode = sessionMode;
  const modelId = optionalNullable(request, 'modelId', (value) => String(value));
  if (modelId !== undefined) fields.modelId = modelId;
  if (request.catchUpPolicy !== undefined && request.catchUpPolicy !== null) {
    fields.catchUpPolicy = normalizeEnum(request.catchUpPolicy, CATCH_UP_POLICIES, 'catch_up_policy');
  }
  if (request.maxRetries !== undefined && request.maxRetries !== null) fields.maxRetries = request.maxRetries;
  if (request.retryBackoffSeconds !== undefined && request.retryBackoffSeconds !== null) {
    fields.retryBackoffSeconds = request.retryBackoffSeconds;
  }
  if (request.timeoutSeconds !== undefined && request.timeoutSeconds !== null) fields.timeoutSeconds = request.timeoutSeconds;
  if (trustedProfile !== undefined) fields.trustedProfile = trustedProfile;
  return fields;
}
