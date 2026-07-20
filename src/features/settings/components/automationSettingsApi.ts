export type AutomationScheduleKind = 'daily' | 'weekly' | 'weekdays' | 'monthly' | 'interval' | 'once';
export type AutomationActionType = 'notify' | 'agent_turn';
export type AutomationCatchUpPolicy = 'skip' | 'run_once' | 'catch_up_all';
export type AutomationSessionMode = 'isolated' | 'named';
export type AutomationRootAccess = 'read_only' | 'read_write';

export interface TrustedAutomationProfile {
  schemaVersion: 1;
  profileHash: string;
  allowedTools: string[];
  runtimeRoots: Array<{ rootId: string; access: AutomationRootAccess }>;
  shellCommandPrefixes: string[];
  networkDomains: string[];
  maxToolRounds: number;
  timeoutSeconds: number;
  maxOutputBytes: number;
  rollbackRequired: boolean;
}

export function prepareTrustedAutomationProfile(
  input: Omit<TrustedAutomationProfile, 'schemaVersion' | 'profileHash'> & { profileHash?: string },
): TrustedAutomationProfile {
  return {
    schemaVersion: 1,
    profileHash: input.profileHash?.trim() ?? '',
    allowedTools: Array.from(new Set(input.allowedTools)).sort(),
    runtimeRoots: [...input.runtimeRoots].sort((a, b) => a.rootId.localeCompare(b.rootId)),
    shellCommandPrefixes: Array.from(new Set(input.shellCommandPrefixes)).sort(),
    networkDomains: Array.from(new Set(input.networkDomains.map((domain) => domain.toLowerCase()))).sort(),
    maxToolRounds: input.maxToolRounds,
    timeoutSeconds: input.timeoutSeconds,
    maxOutputBytes: input.maxOutputBytes,
    rollbackRequired: input.rollbackRequired,
  };
}
export const AUTOMATION_VERSION_CONFLICT_CODE = 'AUTOMATION_VERSION_CONFLICT';

export interface AutomationSchedule {
  kind: AutomationScheduleKind;
  time: string;
  weekday?: number;
  dayOfMonth?: number;
  intervalMinutes?: number;
  /** YYYY-MM-DD，仅 kind === 'once' 使用（once 需要 time + date + 可选 timezone） */
  date?: string;
  timezone?: string;
}

export interface AutomationListItem {
  id: string;
  version: number;
  name: string;
  schedule: AutomationSchedule;
  prompt: string;
  enabled: boolean;
  actionType: AutomationActionType;
  heartbeat: boolean;
  agentPrompt?: string;
  sessionMode?: AutomationSessionMode;
  modelId?: string;
  catchUpPolicy: AutomationCatchUpPolicy;
  maxRetries: number;
  retryBackoffSeconds: number;
  timeoutSeconds: number;
  trustedProfile?: TrustedAutomationProfile;
  sessionId?: string;
  agentSessionId?: string;
  createdAt?: string;
  lastRunAt?: string;
  nextTriggerAt?: string;
}

export interface AutomationListResult {
  count: number;
  max: number;
  automations: AutomationListItem[];
}

export interface AutomationUpdateInput {
  automationId: string;
  expectedVersion: number;
  name?: string;
  schedule?: AutomationSchedule;
  prompt?: string;
  actionType?: AutomationActionType;
  agentPrompt?: string | null;
  sessionMode?: AutomationSessionMode | null;
  modelId?: string | null;
  catchUpPolicy?: AutomationCatchUpPolicy;
  maxRetries?: number;
  retryBackoffSeconds?: number;
  timeoutSeconds?: number;
  trustedProfile?: TrustedAutomationProfile | null;
}

export interface AutomationCreateInput extends Omit<AutomationUpdateInput, 'automationId' | 'expectedVersion'> {
  name: string;
  schedule: AutomationSchedule;
  prompt: string;
  enabled?: boolean;
  actionType: AutomationActionType;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  status: string;
  triggerType: string;
  scheduledFor: string;
  attempt: number;
  maxAttempts: number;
  startedAt?: string;
  finishedAt?: string;
  nextAttemptAt?: string;
  sessionId?: string;
  delivered: string[];
  summary?: string;
  error?: string;
}

/** `chat_v2_automation_run_completed` 事件 payload（camelCase，与后端 emit 保持一致） */
export interface AutomationRunCompletedPayload {
  automationId: string;
  runId: string;
  automationName?: string;
  sessionId?: string | null;
  status?: string;
  summary?: string;
  heartbeat?: boolean;
}

export interface AutomationSummary {
  enabledCount: number;
  runningCount: number;
  failedCount: number;
  nextRunAt?: string;
  backgroundEnabled: boolean;
}

export type AutomationInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export type AutomationListen = (
  eventName: string,
  handler: (event: unknown) => void,
) => Promise<() => void>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readString = (
  value: Record<string, unknown>,
  camelKey: string,
  snakeKey = camelKey,
): string | undefined => {
  const candidate = value[camelKey] ?? value[snakeKey];
  return typeof candidate === 'string' && candidate.trim() ? candidate : undefined;
};

const readBoolean = (
  value: Record<string, unknown>,
  camelKey: string,
  snakeKey = camelKey,
  fallback = false,
): boolean => {
  const candidate = value[camelKey] ?? value[snakeKey];
  return typeof candidate === 'boolean' ? candidate : fallback;
};

function normalizeSchedule(raw: unknown): AutomationSchedule {
  const value = isRecord(raw) ? raw : {};
  const rawKind = value.kind;
  const kind: AutomationScheduleKind =
    rawKind === 'weekly'
      || rawKind === 'weekdays'
      || rawKind === 'monthly'
      || rawKind === 'interval'
      || rawKind === 'once'
      ? rawKind
      : 'daily';
  const rawWeekday = value.weekday;
  const rawDayOfMonth = value.dayOfMonth ?? value.day_of_month;
  const rawInterval = value.intervalMinutes ?? value.interval_minutes;

  return {
    kind,
    time: typeof value.time === 'string' ? value.time : '',
    ...(typeof rawWeekday === 'number' ? { weekday: rawWeekday } : {}),
    ...(typeof rawDayOfMonth === 'number' ? { dayOfMonth: rawDayOfMonth } : {}),
    ...(typeof rawInterval === 'number' ? { intervalMinutes: rawInterval } : {}),
    ...(typeof value.date === 'string' && value.date.trim() ? { date: value.date } : {}),
    ...(typeof value.timezone === 'string' && value.timezone.trim()
      ? { timezone: value.timezone }
      : {}),
  };
}

/** create/update 共用的 schedule 序列化（后端 snake_case 同名 `date` 由 Tauri 反序列化处理，前端保持 camelCase 请求体） */
function serializeSchedule(schedule: AutomationSchedule): Record<string, unknown> {
  return {
    kind: schedule.kind,
    time: schedule.kind === 'interval' ? '' : schedule.time,
    ...(schedule.kind === 'weekly' ? { weekday: schedule.weekday } : {}),
    ...(schedule.kind === 'monthly' ? { dayOfMonth: schedule.dayOfMonth } : {}),
    ...(schedule.kind === 'interval' ? { intervalMinutes: schedule.intervalMinutes } : {}),
    ...(schedule.kind === 'once' && schedule.date ? { date: schedule.date } : {}),
    ...(schedule.timezone ? { timezone: schedule.timezone } : {}),
  };
}

function normalizeAutomation(raw: unknown): AutomationListItem | null {
  if (!isRecord(raw)) return null;
  const id = readString(raw, 'id');
  const name = readString(raw, 'name');
  const version = raw.version;
  if (!id || !name || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return null;
  }

  const rawActionType = raw.actionType ?? raw.action_type;
  const actionType: AutomationActionType = rawActionType === 'agent_turn' ? 'agent_turn' : 'notify';
  const prompt = readString(raw, 'prompt') ?? '';
  const profileRaw = raw.trustedProfile ?? raw.trusted_profile;
  const trustedProfile = isRecord(profileRaw) ? profileRaw as unknown as TrustedAutomationProfile : undefined;

  return {
    id,
    version,
    name,
    schedule: normalizeSchedule(raw.schedule),
    prompt,
    enabled: readBoolean(raw, 'enabled'),
    actionType,
    heartbeat: readBoolean(raw, 'heartbeat'),
    agentPrompt: readString(raw, 'agentPrompt', 'agent_prompt'),
    sessionMode: (raw.sessionMode ?? raw.session_mode) === 'named' ? 'named' : 'isolated',
    modelId: readString(raw, 'modelId', 'model_id'),
    catchUpPolicy: (raw.catchUpPolicy ?? raw.catch_up_policy) === 'skip'
      ? 'skip'
      : (raw.catchUpPolicy ?? raw.catch_up_policy) === 'catch_up_all'
        ? 'catch_up_all'
        : 'run_once',
    maxRetries: typeof (raw.maxRetries ?? raw.max_retries) === 'number'
      ? Number(raw.maxRetries ?? raw.max_retries)
      : 2,
    retryBackoffSeconds: typeof (raw.retryBackoffSeconds ?? raw.retry_backoff_seconds) === 'number'
      ? Number(raw.retryBackoffSeconds ?? raw.retry_backoff_seconds)
      : 60,
    timeoutSeconds: typeof (raw.timeoutSeconds ?? raw.timeout_seconds) === 'number'
      ? Number(raw.timeoutSeconds ?? raw.timeout_seconds)
      : 600,
    trustedProfile,
    sessionId: readString(raw, 'sessionId', 'session_id'),
    agentSessionId: readString(raw, 'agentSessionId', 'agent_session_id'),
    createdAt: readString(raw, 'createdAt', 'created_at'),
    lastRunAt: readString(raw, 'lastRunAt', 'last_run_at'),
    nextTriggerAt: readString(raw, 'nextTriggerAt', 'next_trigger_at'),
  };
}

export async function listAutomations(invoke: AutomationInvoke): Promise<AutomationListResult> {
  const raw = await invoke('chat_v2_automation_list');
  if (!isRecord(raw) || !Array.isArray(raw.automations)) {
    throw new Error('AUTOMATION_LIST_INVALID_RESPONSE');
  }

  const automations = raw.automations
    .map(normalizeAutomation)
    .filter((item): item is AutomationListItem => item !== null);
  const rawCount = typeof raw.count === 'number' ? raw.count : automations.length;
  const rawMax = typeof raw.max === 'number' ? raw.max : 20;

  return {
    count: Math.max(0, rawCount),
    max: Math.max(0, rawMax),
    automations,
  };
}

/**
 * 从 mutation 响应中提取最新条目快照。
 * create 返回 `{ success, automation }`，update 返回 `{ success, current, ... }`；
 * 解析失败返回 null（不抛错），调用方可退化为全量 refresh。
 */
function extractAutomationSnapshot(raw: unknown): AutomationListItem | null {
  if (!isRecord(raw)) return null;
  const candidate = raw.automation ?? raw.current ?? raw;
  return normalizeAutomation(candidate);
}

export async function setAutomationEnabled(
  invoke: AutomationInvoke,
  automationId: string,
  expectedVersion: number,
  enabled: boolean,
): Promise<AutomationListItem | null> {
  const raw = await invoke('chat_v2_automation_set_enabled', { automationId, expectedVersion, enabled });
  return extractAutomationSnapshot(raw);
}

export async function updateAutomation(
  invoke: AutomationInvoke,
  input: AutomationUpdateInput,
): Promise<AutomationListItem | null> {
  const request: Record<string, unknown> = {
    automationId: input.automationId,
    expectedVersion: input.expectedVersion,
  };
  if (input.name !== undefined) request.name = input.name;
  if (input.schedule) {
    request.schedule = serializeSchedule(input.schedule);
  }
  if (input.prompt !== undefined) request.prompt = input.prompt;
  if (input.actionType !== undefined) request.actionType = input.actionType;
  if (input.agentPrompt !== undefined) request.agentPrompt = input.agentPrompt;
  if (input.sessionMode !== undefined) request.sessionMode = input.sessionMode;
  if (input.modelId !== undefined) request.modelId = input.modelId;
  if (input.catchUpPolicy !== undefined) request.catchUpPolicy = input.catchUpPolicy;
  if (input.maxRetries !== undefined) request.maxRetries = input.maxRetries;
  if (input.retryBackoffSeconds !== undefined) request.retryBackoffSeconds = input.retryBackoffSeconds;
  if (input.timeoutSeconds !== undefined) request.timeoutSeconds = input.timeoutSeconds;
  if (input.trustedProfile !== undefined) request.trustedProfile = input.trustedProfile;

  const raw = await invoke('chat_v2_automation_update', { request });
  return extractAutomationSnapshot(raw);
}

export async function createAutomation(
  invoke: AutomationInvoke,
  input: AutomationCreateInput,
): Promise<AutomationListItem | null> {
  const request: Record<string, unknown> = {
    name: input.name,
    schedule: serializeSchedule(input.schedule),
    prompt: input.prompt,
    enabled: input.enabled ?? true,
    actionType: input.actionType,
    catchUpPolicy: input.catchUpPolicy ?? 'run_once',
    maxRetries: input.maxRetries ?? 2,
    retryBackoffSeconds: input.retryBackoffSeconds ?? 60,
    timeoutSeconds: input.timeoutSeconds ?? 600,
    ...(input.trustedProfile ? { trustedProfile: input.trustedProfile } : {}),
  };
  if (input.actionType === 'agent_turn') {
    request.agentPrompt = input.agentPrompt || input.prompt;
    request.sessionMode = input.sessionMode ?? 'isolated';
    if (input.modelId) request.modelId = input.modelId;
  }
  const raw = await invoke('chat_v2_automation_create', { request });
  return extractAutomationSnapshot(raw);
}

export async function deleteAutomation(
  invoke: AutomationInvoke,
  automationId: string,
  expectedVersion: number,
): Promise<void> {
  await invoke('chat_v2_automation_delete', { automationId, expectedVersion });
}

export async function runAutomationNow(
  invoke: AutomationInvoke,
  automationId: string,
  expectedVersion: number,
): Promise<void> {
  await invoke('chat_v2_automation_run_now', { automationId, expectedVersion });
}

const normalizeRun = (raw: unknown): AutomationRun | null => {
  if (!isRecord(raw)) return null;
  const id = readString(raw, 'id');
  const automationId = readString(raw, 'automationId', 'automation_id');
  if (!id || !automationId) return null;
  return {
    id,
    automationId,
    status: readString(raw, 'status') ?? 'unknown',
    triggerType: readString(raw, 'triggerType', 'trigger_type') ?? 'schedule',
    scheduledFor: readString(raw, 'scheduledFor', 'scheduled_for') ?? '',
    attempt: Number(raw.attempt ?? 1),
    maxAttempts: Number(raw.maxAttempts ?? raw.max_attempts ?? 1),
    startedAt: readString(raw, 'startedAt', 'started_at'),
    finishedAt: readString(raw, 'finishedAt', 'finished_at'),
    nextAttemptAt: readString(raw, 'nextAttemptAt', 'next_attempt_at'),
    sessionId: readString(raw, 'sessionId', 'session_id'),
    delivered: Array.isArray(raw.delivered)
      ? raw.delivered.filter((item): item is string => typeof item === 'string')
      : [],
    summary: readString(raw, 'summary'),
    error: readString(raw, 'error'),
  };
};

export async function listAutomationRuns(
  invoke: AutomationInvoke,
  automationId?: string,
  limit = 50,
): Promise<AutomationRun[]> {
  const raw = await invoke('chat_v2_automation_runs', { automationId, limit });
  if (!isRecord(raw) || !Array.isArray(raw.runs)) {
    throw new Error('AUTOMATION_RUNS_INVALID_RESPONSE');
  }
  return raw.runs.map(normalizeRun).filter((run): run is AutomationRun => run !== null);
}

export async function retryAutomationRun(invoke: AutomationInvoke, runId: string): Promise<void> {
  await invoke('chat_v2_automation_retry_run', { runId });
}

export async function cancelAutomationRun(invoke: AutomationInvoke, runId: string): Promise<void> {
  await invoke('chat_v2_automation_cancel_run', { runId });
}

export async function getAutomationSummary(invoke: AutomationInvoke): Promise<AutomationSummary> {
  const raw = await invoke('chat_v2_automation_summary');
  const value = isRecord(raw) ? raw : {};
  return {
    enabledCount: Number(value.enabledCount ?? 0),
    runningCount: Number(value.runningCount ?? 0),
    failedCount: Number(value.failedCount ?? 0),
    nextRunAt: typeof value.nextRunAt === 'string' ? value.nextRunAt : undefined,
    backgroundEnabled: value.backgroundEnabled !== false,
  };
}

export async function setAutomationBackgroundEnabled(
  invoke: AutomationInvoke,
  enabled: boolean,
): Promise<void> {
  await invoke('chat_v2_automation_set_background_enabled', { enabled });
}
