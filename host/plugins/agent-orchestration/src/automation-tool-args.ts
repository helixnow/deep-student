import {
  type AutomationSchedule, type CatchUpPolicy, type ScheduleKind,
  DEFAULT_MAX_RETRIES, DEFAULT_RETRY_BACKOFF_SECS, DEFAULT_TIMEOUT_SECS, MAX_PROMPT_LEN,
  normalizeScheduleShape, parseTimeHhmm, validateAutomationFields, validateSchedule,
} from './automation-schedule.ts';
import type { ActionType, HeadlessSessionMode } from '../repository/automations.ts';
import { rustTrim } from '../../../platform/util/index.ts';

/** automation_executor.rs:27–104 */
export const AUTOMATION_TOOL_NAMES = {
  propose: 'automation_propose', list: 'automation_list', setEnabled: 'automation_set_enabled',
  update: 'automation_update', delete: 'automation_delete', runNow: 'automation_run_now',
  runs: 'automation_runs', retryRun: 'automation_retry_run', cancelRun: 'automation_cancel_run',
} as const;
const HANDLED_TOOLS = new Set<string>(Object.values(AUTOMATION_TOOL_NAMES));
export const AUTOMATION_OCC_REQUIRED_CODE = 'AUTOMATION_OCC_REQUIRED';
export const AUTOMATION_RUN_ALREADY_ACTIVE_CODE = 'AUTOMATION_RUN_ALREADY_ACTIVE';
export const AUTOMATION_DUPLICATE_CODE = 'AUTOMATION_DUPLICATE';
const AUTOMATION_VERSION_CONFLICT_CODE = 'AUTOMATION_VERSION_CONFLICT';

export const PROPOSE_ALLOWED_KEYS = ['name', 'schedule', 'prompt', 'enabled', 'action_type',
  'agent_prompt', 'session_mode', 'model_id', 'catch_up_policy', 'max_retries',
  'retry_backoff_seconds', 'timeout_seconds', 'trusted_profile'] as const;
const SCHEDULE_ALLOWED_KEYS = ['kind', 'time', 'date', 'weekday', 'weekdays', 'day_of_month',
  'interval_minutes', 'timezone'] as const;

export type JsonObject = Record<string, unknown>;
export type ToolSensitivity = 'High' | 'Medium' | 'Low';

export type ParsedAgentFields = {
  agentPrompt: string | null;
  sessionMode: HeadlessSessionMode | null;
  modelId: string | null;
};

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

/** `strip_tool_namespace`: drops a leading `builtin-` or `mcp_` prefix. */
export function stripToolNamespace(toolName: string): string {
  if (toolName.startsWith('builtin-')) return toolName.slice('builtin-'.length);
  if (toolName.startsWith('mcp_')) return toolName.slice('mcp_'.length);
  return toolName;
}

export function canHandleAutomationTool(toolName: string): boolean {
  return HANDLED_TOOLS.has(stripToolNamespace(toolName));
}

export function rejectUnknownFields(args: unknown, allowed: readonly string[]): void {
  const object = asObject(args);
  if (object === null) throw new Error('Arguments must be a JSON object');
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw new Error(`Unknown field '${key}'. Allowed fields: ${allowed.join(', ')}`);
  }
}

export function parseRequiredString(args: unknown, key: string): string {
  const object = asObject(args) ?? {};
  const value = object[key];
  const trimmed = typeof value === 'string' ? rustTrim(value) : '';
  if (trimmed === '') throw new Error(`'${key}' is required and must be a non-empty string`);
  return trimmed;
}

/** Rust `Value::as_u64` plus decimal strings. */
function valueAsU64(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^[0-9]+$/.test(rustTrim(value))) {
    const parsed = Number(rustTrim(value));
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** Fields that are absent or explicitly null count as not provided. */
export function provided(args: unknown, key: string): unknown {
  const object = asObject(args) ?? {};
  return Object.hasOwn(object, key) && object[key] !== null ? object[key] : undefined;
}

/** Rust `str::to_ascii_lowercase`: only A-Z change (JS toLowerCase also folds non-ASCII). */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

/** automation_executor.rs:342-359; the error echoes the trimmed, lowercased value. */
function parseKind(raw: unknown): ScheduleKind {
  if (typeof raw !== 'string') throw new Error("'schedule.kind' is required");
  const text = asciiLower(rustTrim(raw));
  if (text === 'daily' || text === 'weekly' || text === 'weekdays'
    || text === 'monthly' || text === 'interval' || text === 'once') return text;
  throw new Error(`Invalid schedule.kind '${text}'. Allowed: daily, weekly, weekdays, monthly, interval, once`);
}

/** automation_executor.rs:328–484. */
export function parseToolSchedule(value: unknown, nowMs: number = Date.now()): AutomationSchedule {
  const object = asObject(value);
  if (object === null) throw new Error("'schedule' must be a JSON object");
  for (const key of Object.keys(object)) {
    if (!(SCHEDULE_ALLOWED_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Unknown schedule field '${key}'. Allowed: ${SCHEDULE_ALLOWED_KEYS.join(', ')}`);
    }
  }
  const kind = parseKind(object.kind);
  let time = '';
  if (kind !== 'interval') {
    const raw = provided(object, 'time');
    if (raw === undefined) throw new Error("'schedule.time' is required (HH:MM, 24h)");
    const text = typeof raw === 'string' ? rustTrim(raw) : '';
    if (text === '') throw new Error("'schedule.time' must be an HH:MM (24h) string");
    time = text;
  }
  const rawDate = object.date;
  let date: string | null = null;
  if (rawDate !== undefined && rawDate !== null) {
    const text = typeof rawDate === 'string' ? rustTrim(rawDate) : '';
    if (text === '') throw new Error("'schedule.date' must be a YYYY-MM-DD string");
    date = text;
  }
  if (kind === 'once' && date === null) {
    throw new Error("'schedule.date' is required when kind is 'once' (YYYY-MM-DD)");
  }
  const weekday = (() => {
    const raw = provided(object, 'weekday');
    if (raw === undefined) return null;
    const parsed = valueAsU64(raw);
    if (parsed === null) throw new Error("'schedule.weekday' must be an integer 0-6");
    if (parsed > 6) throw new Error("'schedule.weekday' must be between 0 (Sunday) and 6 (Saturday)");
    return parsed;
  })();
  const weekdays = (() => {
    const raw = provided(object, 'weekdays');
    if (raw === undefined) return null;
    if (!Array.isArray(raw)) throw new Error("'schedule.weekdays' must be an array of integers 0-6");
    const parsed: number[] = [];
    for (const item of raw) {
      const day = valueAsU64(item);
      if (day === null) throw new Error("'schedule.weekdays' must be an array of integers 0-6");
      if (day > 6) throw new Error("'schedule.weekdays' values must be between 0 (Sunday) and 6 (Saturday)");
      parsed.push(day);
    }
    parsed.sort((a, b) => a - b);
    const unique = [...new Set(parsed)];
    return unique.length === 0 ? null : unique;
  })();
  const intervalMinutes = (() => {
    const raw = provided(object, 'interval_minutes');
    if (raw === undefined) return null;
    const parsed = valueAsU64(raw);
    if (parsed === null) throw new Error("'schedule.interval_minutes' must be a positive integer");
    if (parsed > 4_294_967_295) throw new Error("'schedule.interval_minutes' is out of range");
    return parsed;
  })();
  const dayOfMonth = (() => {
    const raw = provided(object, 'day_of_month');
    if (raw === undefined) return null;
    const parsed = valueAsU64(raw);
    if (parsed === null || parsed > 255) throw new Error("'schedule.day_of_month' must be an integer 1-31");
    return parsed;
  })();
  const timezone = (() => {
    const raw = object.timezone;
    if (raw === undefined || raw === null) return null;
    const text = typeof raw === 'string' ? rustTrim(raw) : '';
    if (text === '') throw new Error("'schedule.timezone' must be a non-empty IANA timezone string");
    return text;
  })();
  const schedule: AutomationSchedule = {
    kind, time, date, weekday, weekdays, day_of_month: dayOfMonth,
    interval_minutes: intervalMinutes, timezone,
  };
  try {
    validateSchedule(schedule, nowMs);
  } catch (error) {
    const message = error !== null && typeof error === 'object' && 'message' in error
      ? String(error.message) : String(error);
    throw new Error(message);
  }
  normalizeScheduleShape(schedule);
  return schedule;
}

export function parseOptionalActionType(args: unknown): ActionType | null {
  const value = provided(args, 'action_type');
  if (value === undefined) return null;
  if (typeof value !== 'string') throw new Error("'action_type' must be a string: notify | agent_turn");
  // automations.rs:519-528 AutomationActionType::parse
  const raw = asciiLower(rustTrim(value));
  if (raw === 'notify') return 'notify';
  if (raw === 'agent_turn') return 'agent_turn';
  throw new Error(`Invalid action_type '${raw}'. Allowed: notify, agent_turn`);
}

export function parseActionType(args: unknown): ActionType {
  return parseOptionalActionType(args) ?? 'notify';
}

export function parseCatchUpPolicy(args: unknown, required: boolean): CatchUpPolicy | null {
  const value = provided(args, 'catch_up_policy');
  if (value === undefined) return required ? 'run_once' : null;
  if (typeof value !== 'string') throw new Error("'catch_up_policy' must be skip | run_once | catch_up_all");
  // automations.rs:236-246 CatchUpPolicy::parse
  const raw = asciiLower(rustTrim(value));
  if (raw === 'skip') return 'skip';
  if (raw === 'run_once') return 'run_once';
  if (raw === 'catch_up_all') return 'catch_up_all';
  throw new Error(`Invalid catch_up_policy '${raw}'. Allowed: skip, run_once, catch_up_all`);
}

export function parseOptionalU64(args: unknown, key: string, min: number, max: number): number | null {
  const value = provided(args, key);
  if (value === undefined) return null;
  const parsed = valueAsU64(value);
  if (parsed === null) throw new Error(`'${key}' must be an integer`);
  if (parsed < min || parsed > max) throw new Error(`'${key}' must be between ${min} and ${max}`);
  return parsed;
}

export function automationOccRequiredError(): string {
  return JSON.stringify({
    code: AUTOMATION_OCC_REQUIRED_CODE,
    errorType: 'validation',
    message: 'expected_version is required; call automation_list and use its current version',
    messageFallback: {
      'zh-CN': '必须先调用 automation_list，并将当前 version 原样传为 expected_version。',
      'en-US': 'Call automation_list first and pass its current version as expected_version.',
    },
    requiredField: 'expected_version',
    retryable: false,
  });
}

export function parseRequiredVersion(args: unknown): number {
  const parsed = parseOptionalU64(args, 'expected_version', 1, Number.MAX_SAFE_INTEGER);
  if (parsed === null) throw new Error(automationOccRequiredError());
  return parsed;
}

/** `Some(None)` clears, `Some(value)` sets, `undefined` leaves untouched. */
export function parseNullableString(
  args: unknown, key: string, maxChars: number | null,
): { value: string | null } | undefined {
  const object = asObject(args) ?? {};
  if (!Object.hasOwn(object, key)) return undefined;
  const raw = object[key];
  if (raw === null) return { value: null };
  if (typeof raw !== 'string') throw new Error(`'${key}' must be a string or null`);
  const value = rustTrim(raw);
  if (maxChars !== null && [...value].length > maxChars) {
    throw new Error(`'${key}' must be at most ${maxChars} characters`);
  }
  return { value: value === '' ? null : value };
}

export function parseNullableSessionMode(args: unknown): { value: HeadlessSessionMode | null } | undefined {
  const object = asObject(args) ?? {};
  if (!Object.hasOwn(object, 'session_mode')) return undefined;
  const raw = object.session_mode;
  if (raw === null) return { value: null };
  if (typeof raw !== 'string') throw new Error("'session_mode' must be isolated | named | null");
  // headless.rs:1178-1186 HeadlessSessionMode::parse
  const value = asciiLower(rustTrim(raw));
  if (value === 'isolated') return { value: 'isolated' };
  if (value === 'named') return { value: 'named' };
  throw new Error(`Invalid session_mode '${value}'. Allowed: isolated, named`);
}

/** automation_executor.rs:585–645. */
export function parseAgentFields(args: unknown, actionType: ActionType): ParsedAgentFields {
  const rawPrompt = provided(args, 'agent_prompt');
  const agentPrompt = (() => {
    if (rawPrompt === undefined) return null;
    if (typeof rawPrompt !== 'string') throw new Error("'agent_prompt' must be a string");
    const value = rustTrim(rawPrompt);
    if (value === '') return null;
    if ([...value].length > MAX_PROMPT_LEN) throw new Error(`agent_prompt must be at most ${MAX_PROMPT_LEN} characters`);
    return value;
  })();
  const rawMode = provided(args, 'session_mode');
  const sessionMode = (() => {
    if (rawMode === undefined) return null;
    if (typeof rawMode !== 'string') throw new Error("'session_mode' must be a string: isolated | named");
    const value = asciiLower(rustTrim(rawMode));
    if (value === 'isolated') return 'isolated';
    if (value === 'named') return 'named';
    throw new Error(`Invalid session_mode '${value}'. Allowed: isolated, named`);
  })();
  const rawModel = provided(args, 'model_id');
  const modelId = (() => {
    if (rawModel === undefined) return null;
    if (typeof rawModel !== 'string') throw new Error("'model_id' must be a string");
    const value = rustTrim(rawModel);
    return value === '' ? null : value;
  })();
  if (actionType === 'notify' && (agentPrompt !== null || sessionMode !== null || modelId !== null)) {
    throw new Error("agent_prompt / session_mode / model_id are only valid when action_type is 'agent_turn'");
  }
  return { agentPrompt, sessionMode, modelId };
}

/** automation_executor.rs:150–189. */
export function describeSchedule(schedule: AutomationSchedule): string {
  const names = ['日', '一', '二', '三', '四', '五', '六'];
  switch (schedule.kind) {
    case 'daily': return `每天 ${schedule.time}`;
    case 'weekdays': return `工作日（周一至周五）${schedule.time}`;
    case 'weekly': {
      const days = schedule.weekdays !== null && schedule.weekdays.length > 0
        ? [...new Set(schedule.weekdays)].sort((a, b) => a - b).map((day) => names[day] ?? '?')
        : [schedule.weekday === null ? '?' : names[schedule.weekday] ?? '?'];
      return `每周${days.join('、')} ${schedule.time}`;
    }
    case 'monthly':
      return `每月 ${schedule.day_of_month ?? 1} 日 ${schedule.time}（短月份自动落到月末）`;
    case 'interval': return `每 ${schedule.interval_minutes ?? 0} 分钟`;
    case 'once': return `仅 ${schedule.date ?? '指定日期'} ${schedule.time} 触发一次（触发后自动完成，不再重复）`;
  }
}

/** automation_executor.rs:196–210: mutates the list item with the derived flag. */
export function annotateOnceCompleted(item: JsonObject): void {
  const schedule = item.schedule;
  const parsed = asObject(schedule);
  if (parsed === null || parsed.kind !== 'once') return;
  const hasRun = typeof item.last_run_at === 'string';
  const nextTrigger = item.next_trigger_at;
  const nextTriggerCleared = nextTrigger === undefined || nextTrigger === null;
  item.once_completed = hasRun && nextTriggerCleared;
}

/** automation_executor.rs:213–258. */
export function friendlyAutomationError(error: string): string {
  const tryParseObject = (raw: string): JsonObject | null => {
    try { return asObject(JSON.parse(raw)); }
    catch { return null; }
  };
  const object = tryParseObject(error);
  if (object !== null) {
    const code = typeof object.code === 'string' ? object.code : '';
    const hint = code === AUTOMATION_VERSION_CONFLICT_CODE
      ? '该自动化在你读取之后被修改过（可能是用户在设置页改的）。请重新调用 automation_list 获取最新 version 和内容，与用户确认改动仍然成立后，用新的 expected_version 重试；不要用猜测的版本号覆盖。'
      : code === AUTOMATION_OCC_REQUIRED_CODE
        ? '先调用 automation_list 拿到该自动化当前的 version，并原样作为 expected_version 传入后重试。'
        : code === AUTOMATION_RUN_ALREADY_ACTIVE_CODE
          ? '该自动化已有一次运行在排队或执行中，不能重复启动。可先用 automation_runs 查看当前运行状态，等它结束后再试，或用 automation_cancel_run 取消进行中的运行后重试。'
          : code === AUTOMATION_DUPLICATE_CODE
            ? '已存在名称、调度和提示词完全相同的自动化（可能上一次创建其实已成功）。请先用 automation_list 核对 existing 中的 id；确实需要再建一条时，换一个不同的 name 重试。'
            : null;
    if (hint !== null && !Object.hasOwn(object, 'hint')) object.hint = hint;
    return JSON.stringify(object);
  }
  if (error.includes('Automation limit reached')) {
    return `${error}（自动化数量已达上限）。请先用 automation_list 查看现有任务，与用户确认删除或停用不再需要的任务后再创建新的。`;
  }
  if (error.includes(AUTOMATION_RUN_ALREADY_ACTIVE_CODE)) {
    return `${error}。该自动化已有运行在排队或执行中：可用 automation_runs 查看状态，等待其完成，或用 automation_cancel_run 取消后再重试。`;
  }
  if (error.includes('not found')) {
    return `${error}。请先用 automation_list（自动化 id）或 automation_runs（运行 id）确认 id 是否存在、是否已被删除。`;
  }
  return error;
}

/** automation_executor.rs:1247–1272. */
export function automationSensitivityLevel(toolName: string): ToolSensitivity {
  const name = stripToolNamespace(toolName);
  if (name === AUTOMATION_TOOL_NAMES.propose || name === AUTOMATION_TOOL_NAMES.delete) return 'High';
  if (name === AUTOMATION_TOOL_NAMES.setEnabled || name === AUTOMATION_TOOL_NAMES.update
    || name === AUTOMATION_TOOL_NAMES.runNow || name === AUTOMATION_TOOL_NAMES.retryRun
    || name === AUTOMATION_TOOL_NAMES.cancelRun) return 'Medium';
  if (name === AUTOMATION_TOOL_NAMES.list || name === AUTOMATION_TOOL_NAMES.runs) return 'Low';
  return 'Low';
}

export function hasDynamicAutomationSensitivity(toolName: string): boolean {
  return stripToolNamespace(toolName) === AUTOMATION_TOOL_NAMES.update;
}

export function automationSensitivityLevelForCall(toolName: string, args: unknown): ToolSensitivity {
  const object = asObject(args) ?? {};
  if (stripToolNamespace(toolName) === AUTOMATION_TOOL_NAMES.update
    && Object.hasOwn(object, 'trusted_profile') && object.trusted_profile !== null) {
    return 'High';
  }
  return automationSensitivityLevel(toolName);
}

/** `parse_time_hhmm` is re-exported for the tool layer's schedule validation. */
export { parseTimeHhmm };
