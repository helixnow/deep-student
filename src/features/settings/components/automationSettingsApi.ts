/**
 * 前端 ↔ Tauri 自动化命令契约层。
 *
 * 与后端 `src-tauri/src/chat_v2/automations.rs` 严格对齐：
 * - 请求体：Tauri 命令入参用 camelCase（Tauri 自动映射 Rust snake_case 参数名；
 *   `request` 结构体本身声明了 `rename_all = "camelCase"` + `deny_unknown_fields`）。
 * - 响应体：条目（`automation_to_list_item`）与 run（`AutomationRunRecord`）按
 *   snake_case 序列化，normalize* 均做 camelCase/snake_case 双键兼容读取。
 * - 错误：命令失败返回 JSON 字符串 `{"code","message",...}`；版本冲突
 *   （`AUTOMATION_VERSION_CONFLICT`）附带 `expectedVersion/currentVersion/current` 详情，
 *   见 {@link parseAutomationVersionConflict}。
 */

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

/**
 * 规范化 trusted profile 输入：集合字段去重排序、域名小写，
 * 与后端 `TrustedAutomationProfile::computed_hash` 的 canonical 形态保持一致，
 * 避免 profileHash 校验因顺序差异失败。
 */
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

/** 乐观并发冲突错误码（后端 `AUTOMATION_VERSION_CONFLICT_CODE` 常量的镜像） */
export const AUTOMATION_VERSION_CONFLICT_CODE = 'AUTOMATION_VERSION_CONFLICT';

export interface AutomationSchedule {
  kind: AutomationScheduleKind;
  time: string;
  weekday?: number;
  /**
   * weekly 的一周多天扩展（编号口径与 weekday 一致：0=周日 … 6=周六）。
   * 与 weekday 并存时后端以 weekdays 优先；缺失时回退单数 weekday（存量兼容）。
   */
  weekdays?: number[];
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

/**
 * 单次运行记录（后端 `AutomationRunRecord`，snake_case 序列化）。
 * status 取值：queued / running / success / heartbeat_ok / error / timeout /
 * spawn_error / retrying / cancelled / skipped / superseded。
 */
export interface AutomationRun {
  id: string;
  automationId: string;
  status: string;
  /** schedule / manual / catch_up 等触发来源 */
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
  /** 失败时的错误消息（后端 run 记录的 error 列，纯文本） */
  error?: string;
  /** 触发时刻（后端 `fired_at`，兼容旧记录时等于 scheduledFor） */
  firedAt?: string;
  /** 运行时长毫秒（后端查询侧派生的 `duration_ms`，未完成的 run 无此字段） */
  durationMs?: number;
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
  /** 第几次尝试（后端追加字段，供通知按 runId:attempt 精确去重；旧后端无此键） */
  attempt?: number;
  /**
   * 后端本次是否真的发出了 OS 通知（抑制/早退/失败均为 false）。
   * 前端据此精确互补：true 时绝不再弹 in-app toast；false 时由前端兜底。
   * 旧后端无此键，前端回退 visible && hasFocus 的既有判定。
   */
  osNotificationDelivered?: boolean;
}

/** `chat_v2_automation_summary` 概览（响应本身即 camelCase） */
export interface AutomationSummary {
  enabledCount: number;
  runningCount: number;
  /** 最近 24 小时内失败（error / timeout / spawn_error）的运行数 */
  failedCount: number;
  nextRunAt?: string;
  backgroundEnabled: boolean;
  /** 已完成并固化停用的一次性任务数（后端 `onceCompletedCount`） */
  onceCompletedCount?: number;
  /** 最近 24 小时内最后一次失败运行的结束时间（后端 `lastFailedRunAt`） */
  lastFailedRunAt?: string;
}

/**
 * 自动化命令统一错误载荷（后端 `automation_command_error` 序列化的 JSON 字符串）。
 * code 取值：VALIDATION_ERROR / DATABASE_ERROR / NOT_FOUND / NETWORK_ERROR /
 * IO_ERROR / LLM_ERROR / CONFIGURATION_ERROR / AUTOMATION_ERROR /
 * AUTOMATION_VERSION_CONFLICT / AUTOMATION_RUN_ALREADY_ACTIVE。
 */
export interface AutomationCommandErrorDetails {
  code?: string;
  message?: string;
  /** 冲突错误附带的 `errorType: "conflict"` */
  errorType?: string;
  retryable?: boolean;
}

/** 版本冲突错误详情（`serialize_automation_update_error` 的载荷结构） */
export interface AutomationVersionConflictDetails extends AutomationCommandErrorDetails {
  automationId?: string;
  expectedVersion?: number;
  currentVersion?: number;
  /** 冲突时后端返回的最新条目快照，可用于直接 patch 列表 */
  current?: AutomationListItem | null;
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

/** 从 unknown 错误对象提取原始字符串（Tauri 把命令错误放在 Error.message / string） */
const errorRawString = (cause: unknown): string | null => {
  if (typeof cause === 'string') return cause;
  if (cause instanceof Error) return cause.message;
  if (isRecord(cause)) {
    // 部分调用链会把命令错误包成 { message } / { error } 对象
    if (typeof cause.message === 'string') return cause.message;
    if (typeof cause.error === 'string') return cause.error;
  }
  return null;
};

/**
 * 健壮解析自动化命令错误（后端 serialize 的 `{"code","message",...}` JSON 字符串）。
 * 非 JSON / 解析失败时退化为 `{ message: 原始文本 }`，绝不抛错。
 */
export function parseAutomationCommandError(cause: unknown): AutomationCommandErrorDetails {
  const raw = errorRawString(cause);
  if (raw === null) return {};
  const text = raw.trim();
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) {
        return {
          ...(typeof parsed.code === 'string' ? { code: parsed.code } : {}),
          ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}),
          ...(typeof parsed.errorType === 'string' ? { errorType: parsed.errorType } : {}),
          ...(typeof parsed.retryable === 'boolean' ? { retryable: parsed.retryable } : {}),
        };
      }
    } catch {
      // fall through：按纯文本处理
    }
  }
  return { message: text };
}

/**
 * 解析版本冲突错误；非冲突（code 不匹配）返回 null。
 * `current` 快照按列表条目规则规范化（解析失败时为 null，调用方可退化为全量刷新）。
 */
export function parseAutomationVersionConflict(
  cause: unknown,
): AutomationVersionConflictDetails | null {
  const base = parseAutomationCommandError(cause);
  if (base.code !== AUTOMATION_VERSION_CONFLICT_CODE) return null;

  const raw = errorRawString(cause);
  let payload: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw.trim());
      if (isRecord(parsed)) payload = parsed;
    } catch {
      // code 已确认冲突；详情缺失时仅返回基础字段
    }
  }
  return {
    ...base,
    ...(typeof payload.automationId === 'string' ? { automationId: payload.automationId } : {}),
    ...(typeof payload.expectedVersion === 'number'
      ? { expectedVersion: payload.expectedVersion }
      : {}),
    ...(typeof payload.currentVersion === 'number'
      ? { currentVersion: payload.currentVersion }
      : {}),
    ...('current' in payload ? { current: normalizeAutomation(payload.current) } : {}),
  };
}

/** 判断任意错误是否为自动化版本冲突（乐观并发失败） */
export function isAutomationVersionConflictError(cause: unknown): boolean {
  return parseAutomationCommandError(cause).code === AUTOMATION_VERSION_CONFLICT_CODE;
}

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

/**
 * weekdays 数组的防御式规范化：仅接受 0–6 的整数，去重升序；
 * 无效或为空返回 undefined（回退单数 weekday 语义）。
 */
export function normalizeWeekdays(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const valid = raw.filter(
    (item): item is number => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 6,
  );
  const deduped = Array.from(new Set(valid)).sort((a, b) => a - b);
  return deduped.length > 0 ? deduped : undefined;
}

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
  const rawWeekdays = normalizeWeekdays(value.weekdays);
  const rawDayOfMonth = value.dayOfMonth ?? value.day_of_month;
  const rawInterval = value.intervalMinutes ?? value.interval_minutes;

  return {
    kind,
    time: typeof value.time === 'string' ? value.time : '',
    ...(typeof rawWeekday === 'number' ? { weekday: rawWeekday } : {}),
    ...(rawWeekdays ? { weekdays: rawWeekdays } : {}),
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
  const weekdays = schedule.kind === 'weekly' ? normalizeWeekdays(schedule.weekdays) : undefined;
  return {
    kind: schedule.kind,
    time: schedule.kind === 'interval' ? '' : schedule.time,
    ...(schedule.kind === 'weekly' ? { weekday: schedule.weekday } : {}),
    // 多天调度双向透传：非空才发送（后端 weekly 校验拒绝空数组）
    ...(weekdays ? { weekdays } : {}),
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

/**
 * 调用 `chat_v2_automation_list` 拉取全部自动化。
 * 响应 `{ count, max, automations }`；结构不合法时抛
 * `AUTOMATION_LIST_INVALID_RESPONSE`，无法规范化的条目会被静默过滤。
 */
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

/**
 * 调用 `chat_v2_automation_set_enabled` 启用/停用单条自动化（带乐观并发版本校验）。
 * 返回后端最新条目快照；快照解析失败返回 null（调用方退化为全量刷新）。
 * 版本不匹配时抛 `AUTOMATION_VERSION_CONFLICT` 错误。
 */
export async function setAutomationEnabled(
  invoke: AutomationInvoke,
  automationId: string,
  expectedVersion: number,
  enabled: boolean,
): Promise<AutomationListItem | null> {
  const raw = await invoke('chat_v2_automation_set_enabled', { automationId, expectedVersion, enabled });
  return extractAutomationSnapshot(raw);
}

/**
 * 调用 `chat_v2_automation_update` 局部更新（未提供的字段保持不变）。
 * `agentPrompt` / `sessionMode` / `modelId` / `trustedProfile` 传 `null`
 * 表示显式清空（后端 `Option<Option<T>>` 双层语义），`undefined` 表示不修改。
 * 返回最新条目快照；版本不匹配时抛 `AUTOMATION_VERSION_CONFLICT` 错误。
 */
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

/**
 * 调用 `chat_v2_automation_create` 新建自动化。
 * agent_turn 类型缺省 agentPrompt 时回落为 prompt；notify 类型不发送 Agent 相关字段
 * （后端 request 为 `deny_unknown_fields`，字段名必须与命令契约一致）。
 * 返回新建条目快照；容量已满等校验失败时抛 `VALIDATION_ERROR`。
 */
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

/**
 * 调用 `chat_v2_automation_delete` 永久删除（运行历史一并删除，不可恢复）。
 * 版本不匹配时抛 `AUTOMATION_VERSION_CONFLICT` 错误；心跳任务后端会拒绝删除。
 */
export async function deleteAutomation(
  invoke: AutomationInvoke,
  automationId: string,
  expectedVersion: number,
): Promise<void> {
  await invoke('chat_v2_automation_delete', { automationId, expectedVersion });
}

/**
 * 调用 `chat_v2_automation_run_now` 绕过调度立即运行一次。
 * agent_turn 拉起 headless 运行后立即返回（单飞保护：已有活动 run 时抛
 * `AUTOMATION_RUN_ALREADY_ACTIVE`）；notify 同步投递通知+待办。
 * 版本不匹配时抛 `AUTOMATION_VERSION_CONFLICT` 错误。
 */
export async function runAutomationNow(
  invoke: AutomationInvoke,
  automationId: string,
  expectedVersion: number,
): Promise<void> {
  await invoke('chat_v2_automation_run_now', { automationId, expectedVersion });
}

/** 数值字段兜底：非有限数值一律回落到 fallback，避免 NaN 渗入 UI */
const readFiniteNumber = (value: unknown, fallback: number): number => {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? candidate : fallback;
};

/** duration_ms 透传：仅接受非负有限数值，缺失/非法返回 undefined（区别于 0） */
const readDurationMs = (raw: Record<string, unknown>): number | undefined => {
  const candidate = Number(raw.durationMs ?? raw.duration_ms);
  return Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined;
};

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
    attempt: readFiniteNumber(raw.attempt ?? 1, 1),
    maxAttempts: readFiniteNumber(raw.maxAttempts ?? raw.max_attempts ?? 1, 1),
    startedAt: readString(raw, 'startedAt', 'started_at'),
    finishedAt: readString(raw, 'finishedAt', 'finished_at'),
    nextAttemptAt: readString(raw, 'nextAttemptAt', 'next_attempt_at'),
    sessionId: readString(raw, 'sessionId', 'session_id'),
    delivered: Array.isArray(raw.delivered)
      ? raw.delivered.filter((item): item is string => typeof item === 'string')
      : [],
    summary: readString(raw, 'summary'),
    error: readString(raw, 'error'),
    firedAt: readString(raw, 'firedAt', 'fired_at'),
    durationMs: readDurationMs(raw),
  };
};

/**
 * 调用 `chat_v2_automation_runs` 拉取运行历史（created_at 倒序）。
 * `automationId` 缺省时返回全部任务的历史；limit 由后端 clamp 到 1–200。
 */
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

/** 调用 `chat_v2_automation_retry_run`：把失败的 run 标记为立即重试（下一轮调度即触发） */
export async function retryAutomationRun(invoke: AutomationInvoke, runId: string): Promise<void> {
  await invoke('chat_v2_automation_retry_run', { runId });
}

/** 调用 `chat_v2_automation_cancel_run`：取消运行中 / 等待重试的 run */
export async function cancelAutomationRun(invoke: AutomationInvoke, runId: string): Promise<void> {
  await invoke('chat_v2_automation_cancel_run', { runId });
}

/** 调用 `chat_v2_automation_summary`，返回调度概览（无参数） */
export async function getAutomationSummary(invoke: AutomationInvoke): Promise<AutomationSummary> {
  const raw = await invoke('chat_v2_automation_summary');
  const value = isRecord(raw) ? raw : {};
  const onceCompletedCount = readFiniteNumber(value.onceCompletedCount, -1);
  return {
    enabledCount: readFiniteNumber(value.enabledCount, 0),
    runningCount: readFiniteNumber(value.runningCount, 0),
    failedCount: readFiniteNumber(value.failedCount, 0),
    nextRunAt: typeof value.nextRunAt === 'string' ? value.nextRunAt : undefined,
    backgroundEnabled: value.backgroundEnabled !== false,
    ...(onceCompletedCount >= 0 ? { onceCompletedCount } : {}),
    ...(typeof value.lastFailedRunAt === 'string' && value.lastFailedRunAt
      ? { lastFailedRunAt: value.lastFailedRunAt }
      : {}),
  };
}

/**
 * 调用 `chat_v2_automation_set_background_enabled`：开/关「窗口关闭后驻留后台继续调度」。
 * 该设置持久化到 settings 表，不影响应用前台运行时的调度。
 */
export async function setAutomationBackgroundEnabled(
  invoke: AutomationInvoke,
  enabled: boolean,
): Promise<void> {
  await invoke('chat_v2_automation_set_background_enabled', { enabled });
}
