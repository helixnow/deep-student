/**
 * Learning overview pure layer — TS mirror of
 * `src-tauri/src/chat_v2/tools/learning_overview_executor.rs` request parsing,
 * aggregation and pagination. SQL collectors are outside this module.
 */
import { withLocalizedMessage } from './tool-errors.ts';
import { stripToolNamespace } from './paper-save.ts';

export const LEARNING_OVERVIEW = 'learning_overview';
export const POMODORO_TODAY_STATS = 'pomodoro_today_stats';
export const POMODORO_DAILY_STATS = 'pomodoro_daily_stats';
export const POMODORO_RECORD_CREATE = 'pomodoro_record_create';
export const POMODORO_RECORD_LIST = 'pomodoro_record_list';
export const POMODORO_RECORD_DELETE = 'pomodoro_record_delete';
export const MAX_RANGE_DAYS = 90;
export const MAX_PAGE_SIZE = 20;
export const MAX_RECORD_LIMIT = 100;
export const MAX_POMODORO_DURATION_SECONDS = 86_400;
export const MAX_POMODORO_NOTE_CHARS = 2_000;

export interface PageRequest {
  page: number;
  pageSize: number;
}
export interface OverviewRequest {
  startDate: string;
  endDate: string;
  page: PageRequest;
}
export interface DailyRequest {
  days: number;
  page: PageRequest;
}
export interface DailyActivityDetails {
  chatSessions: number;
  chatMessages: number;
  notesEdited: number;
  textbooksOpened: number;
  examsCreated: number;
  translationsCreated: number;
  essaysCreated: number;
  ankiCardsCreated: number;
  questionsAnswered: number;
}
export interface LearningActivity {
  date: string;
  count: number;
  details: DailyActivityDetails;
  studySeconds: number;
}
export interface PomodoroDailyStat {
  date: string;
  completedCount: number;
  focusSeconds: number;
  interruptedCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidArgument(field: string, zhCn: string, enUs: string): string {
  return JSON.stringify(withLocalizedMessage({
    code: 'INVALID_ARGUMENT', field, retryable: false,
  }, 'chat.tools.learning.invalid_argument', { field }, zhCn, enUs));
}

function argumentsObject(argumentsValue: unknown): Record<string, unknown> {
  if (!isRecord(argumentsValue)) {
    throw invalidArgument('arguments', '参数必须是 JSON 对象', 'Arguments must be a JSON object.');
  }
  return argumentsValue;
}

function ensureAllowedKeys(argumentsValue: Record<string, unknown>, allowed: readonly string[]): void {
  const key = Object.keys(argumentsValue).find(item => !allowed.includes(item));
  if (key !== undefined) {
    throw invalidArgument(key, `不支持字段 ${key}`, `Unknown field '${key}'; additional properties are not allowed.`);
  }
}

function optionalU32(argumentsValue: Record<string, unknown>, field: string, fallback: number,
  min: number, max: number): number {
  const value = argumentsValue[field];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw invalidArgument(field, `${field} 必须是整数`, `'${field}' must be an integer.`);
  }
  if (value < min || value > max) {
    throw invalidArgument(field, `${field} 必须在 ${min}..=${max} 范围内`,
      `'${field}' must be between ${min} and ${max}.`);
  }
  return value;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Strict `%Y-%m-%d` calendar validation (same messages as `optional_date`). */
function optionalDate(argumentsValue: Record<string, unknown>, field: string): string | null {
  const value = argumentsValue[field];
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    throw invalidArgument(field, `${field} 必须是 YYYY-MM-DD 字符串`,
      `'${field}' must be a YYYY-MM-DD string.`);
  }
  if (value.length !== 10) {
    throw invalidArgument(field, `${field} 必须使用精确 YYYY-MM-DD 格式`,
      `'${field}' must use the exact YYYY-MM-DD format.`);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw invalidArgument(field, `${field} 不是有效日历日期`,
      `'${field}' is not a valid calendar date.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw invalidArgument(field, `${field} 不是有效日历日期`,
      `'${field}' is not a valid calendar date.`);
  }
  return value;
}

function parsePage(argumentsValue: Record<string, unknown>): PageRequest {
  return {
    page: optionalU32(argumentsValue, 'page', 1, 1, 0xffffffff),
    pageSize: optionalU32(argumentsValue, 'page_size', MAX_PAGE_SIZE, 1, MAX_PAGE_SIZE),
  };
}

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}

function inclusiveDays(start: string, end: string): number {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  return Math.trunc((endMs - startMs) / 86_400_000) + 1;
}

/** Rust `parse_overview_request` (defaults to the last 7 local days). */
export function parseOverviewRequest(argumentsValue: unknown, today = localToday()): OverviewRequest {
  const argumentsObjectValue = argumentsObject(argumentsValue);
  ensureAllowedKeys(argumentsObjectValue, ['start_date', 'end_date', 'page', 'page_size']);
  const start = optionalDate(argumentsObjectValue, 'start_date');
  const end = optionalDate(argumentsObjectValue, 'end_date');
  let startDate: string;
  let endDate: string;
  if (start === null && end === null) {
    endDate = today;
    startDate = addDays(today, -6);
  } else if (start !== null && end !== null) {
    startDate = start;
    endDate = end;
  } else {
    throw invalidArgument('date_range', 'start_date 与 end_date 必须同时提供或同时省略',
      'Provide both start_date and end_date, or omit both.');
  }
  if (startDate > endDate) {
    throw invalidArgument('start_date', 'start_date 不得晚于 end_date',
      'start_date must not be later than end_date.');
  }
  if (endDate > today) {
    throw invalidArgument('end_date', 'end_date 不得晚于今天',
      'end_date must not be later than today.');
  }
  if (inclusiveDays(startDate, endDate) > MAX_RANGE_DAYS) {
    throw invalidArgument('date_range', `日期范围最多 ${MAX_RANGE_DAYS} 天`,
      `The date range may contain at most ${MAX_RANGE_DAYS} days.`);
  }
  return { startDate, endDate, page: parsePage(argumentsObjectValue) };
}

/** Rust `execute_today` argument gate: a JSON object with no fields. */
export function parseTodayRequest(argumentsValue: unknown): void {
  ensureAllowedKeys(argumentsObject(argumentsValue), []);
}

/** Rust `parse_daily_request`. */
export function parseDailyRequest(argumentsValue: unknown): DailyRequest {
  const argumentsObjectValue = argumentsObject(argumentsValue);
  ensureAllowedKeys(argumentsObjectValue, ['days', 'page', 'page_size']);
  return {
    days: optionalU32(argumentsObjectValue, 'days', 7, 1, MAX_RANGE_DAYS),
    page: parsePage(argumentsObjectValue),
  };
}

export interface PomodoroRecordCreateRequest {
  duration: number;
  mode: 'countdown' | 'stopwatch';
  todoId: string | null;
  note: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PomodoroRecordListRequest {
  startDate: string;
  endDate: string;
  todoId: string | null;
  limit: number;
}

export interface PomodoroRecordDeleteRequest {
  id: string;
}

function optionalText(argumentsValue: Record<string, unknown>, field: string,
  maxChars: number): string | null {
  const value = argumentsValue[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw invalidArgument(field, `${field} 必须是字符串`, `'${field}' must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw invalidArgument(field, `${field} 不能为空`, `'${field}' must not be empty.`);
  }
  if ([...trimmed].length > maxChars) {
    throw invalidArgument(field, `${field} 最多 ${maxChars} 个字符`,
      `'${field}' may contain at most ${maxChars} characters.`);
  }
  return trimmed;
}

/** Accepts an RFC3339 timestamp with an explicit offset/`Z`, or a local date-time. */
function optionalTimestamp(argumentsValue: Record<string, unknown>, field: string): string | null {
  const value = argumentsValue[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw invalidArgument(field, `${field} 必须是 ISO 8601 时间字符串`,
      `'${field}' must be an ISO 8601 timestamp.`);
  }
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/
    .exec(trimmed);
  if (match === null || Number.isNaN(Date.parse(trimmed))) {
    throw invalidArgument(field, `${field} 不是有效的 ISO 8601 时间`,
      `'${field}' is not a valid ISO 8601 timestamp.`);
  }
  return trimmed;
}

function requiredText(argumentsValue: Record<string, unknown>, field: string, maxChars: number): string {
  const value = optionalText(argumentsValue, field, maxChars);
  if (value === null) {
    throw invalidArgument(field, `缺少必需字段 ${field}`, `Missing required field '${field}'.`);
  }
  return value;
}

/** `pomodoro_record_create` argument gate. */
export function parsePomodoroRecordCreateRequest(argumentsValue: unknown): PomodoroRecordCreateRequest {
  const argumentsObjectValue = argumentsObject(argumentsValue);
  ensureAllowedKeys(argumentsObjectValue, [
    'duration', 'mode', 'todo_id', 'note', 'started_at', 'completed_at',
  ]);
  const duration = optionalU32(argumentsObjectValue, 'duration', 0, 1, MAX_POMODORO_DURATION_SECONDS);
  if (duration === 0) {
    throw invalidArgument('duration', '缺少必需字段 duration', "Missing required field 'duration'.");
  }
  const rawMode = argumentsObjectValue.mode;
  let mode: 'countdown' | 'stopwatch' = 'countdown';
  if (rawMode !== undefined && rawMode !== null) {
    if (rawMode !== 'countdown' && rawMode !== 'stopwatch') {
      throw invalidArgument('mode', "mode 必须是 'countdown' 或 'stopwatch'",
        "'mode' must be 'countdown' or 'stopwatch'.");
    }
    mode = rawMode;
  }
  const startedAt = optionalTimestamp(argumentsObjectValue, 'started_at');
  const completedAt = optionalTimestamp(argumentsObjectValue, 'completed_at');
  if (startedAt !== null && completedAt !== null
    && Date.parse(completedAt) < Date.parse(startedAt)) {
    throw invalidArgument('completed_at', 'completed_at 不得早于 started_at',
      'completed_at must not be earlier than started_at.');
  }
  return {
    duration,
    mode,
    todoId: optionalText(argumentsObjectValue, 'todo_id', 128),
    note: optionalText(argumentsObjectValue, 'note', MAX_POMODORO_NOTE_CHARS),
    startedAt,
    completedAt,
  };
}

/** `pomodoro_record_list` argument gate (defaults to the last 7 local days). */
export function parsePomodoroRecordListRequest(argumentsValue: unknown,
  today = localToday()): PomodoroRecordListRequest {
  const argumentsObjectValue = argumentsObject(argumentsValue);
  ensureAllowedKeys(argumentsObjectValue, ['start_date', 'end_date', 'todo_id', 'limit']);
  const start = optionalDate(argumentsObjectValue, 'start_date');
  const end = optionalDate(argumentsObjectValue, 'end_date');
  const endDate = end ?? today;
  const startDate = start ?? (start === null && end === null ? addDays(endDate, -6) : endDate);
  if (startDate > endDate) {
    throw invalidArgument('start_date', 'start_date 不得晚于 end_date',
      'start_date must not be later than end_date.');
  }
  if (endDate > today) {
    throw invalidArgument('end_date', 'end_date 不得晚于今天',
      'end_date must not be later than today.');
  }
  if (inclusiveDays(startDate, endDate) > MAX_RANGE_DAYS) {
    throw invalidArgument('date_range', `日期范围最多 ${MAX_RANGE_DAYS} 天`,
      `The date range may contain at most ${MAX_RANGE_DAYS} days.`);
  }
  return {
    startDate,
    endDate,
    todoId: optionalText(argumentsObjectValue, 'todo_id', 128),
    limit: optionalU32(argumentsObjectValue, 'limit', 20, 1, MAX_RECORD_LIMIT),
  };
}

/** `pomodoro_record_delete` argument gate. */
export function parsePomodoroRecordDeleteRequest(argumentsValue: unknown): PomodoroRecordDeleteRequest {
  const argumentsObjectValue = argumentsObject(argumentsValue);
  ensureAllowedKeys(argumentsObjectValue, ['id']);
  return { id: requiredText(argumentsObjectValue, 'id', 128) };
}

export interface ActivityTotals {
  count: number;
  chatSessions: number;
  chatMessages: number;
  notesEdited: number;
  textbooksOpened: number;
  examsCreated: number;
  translationsCreated: number;
  essaysCreated: number;
  ankiCardsCreated: number;
  questionsAnswered: number;
}

export function aggregateActivities(activities: readonly LearningActivity[]): ActivityTotals {
  const totals: ActivityTotals = {
    count: 0, chatSessions: 0, chatMessages: 0, notesEdited: 0, textbooksOpened: 0,
    examsCreated: 0, translationsCreated: 0, essaysCreated: 0, ankiCardsCreated: 0,
    questionsAnswered: 0,
  };
  for (const activity of activities) {
    totals.count += activity.count;
    totals.chatSessions += activity.details.chatSessions;
    totals.chatMessages += activity.details.chatMessages;
    totals.notesEdited += activity.details.notesEdited;
    totals.textbooksOpened += activity.details.textbooksOpened;
    totals.examsCreated += activity.details.examsCreated;
    totals.translationsCreated += activity.details.translationsCreated;
    totals.essaysCreated += activity.details.essaysCreated;
    totals.ankiCardsCreated += activity.details.ankiCardsCreated;
    totals.questionsAnswered += activity.details.questionsAnswered;
  }
  return totals;
}

export function aggregatePomodoro(items: readonly PomodoroDailyStat[]): {
  completedCount: number; focusSeconds: number; interruptedCount: number;
} {
  return {
    completedCount: items.reduce((sum, item) => sum + item.completedCount, 0),
    focusSeconds: items.reduce((sum, item) => sum + item.focusSeconds, 0),
    interruptedCount: items.reduce((sum, item) => sum + item.interruptedCount, 0),
  };
}

const EMPTY_ACTIVITY: DailyActivityDetails = {
  chatSessions: 0, chatMessages: 0, notesEdited: 0, textbooksOpened: 0,
  examsCreated: 0, translationsCreated: 0, essaysCreated: 0, ankiCardsCreated: 0,
  questionsAnswered: 0,
};

export interface MergedDailyEntry {
  date: string;
  activityCount: number;
  studySeconds: number;
  activities: DailyActivityDetails;
  pomodoro: PomodoroDailyStat;
}

/** Rust `merge_daily` (fills every date in the inclusive range). */
export function mergeDaily(activities: readonly LearningActivity[],
  pomodoro: readonly PomodoroDailyStat[], startDate: string, endDate: string): MergedDailyEntry[] {
  const byDate = new Map(activities.map(item => [item.date, item]));
  const pomodoroByDate = new Map(pomodoro.map(item => [item.date, item]));
  const daily: MergedDailyEntry[] = [];
  let date = startDate;
  while (date <= endDate) {
    const activity = byDate.get(date);
    const focus = pomodoroByDate.get(date);
    daily.push({
      date,
      activityCount: activity?.count ?? 0,
      studySeconds: activity?.studySeconds ?? 0,
      activities: activity?.details ?? { ...EMPTY_ACTIVITY },
      pomodoro: focus ?? {
        date, completedCount: 0, focusSeconds: 0, interruptedCount: 0,
      },
    });
    date = addDays(date, 1);
  }
  return daily;
}

export function paginate<T>(items: readonly T[], page: PageRequest): { items: T[]; hasMore: boolean } {
  const offset = (page.page - 1) * page.pageSize;
  const pageItems = items.slice(offset, offset + page.pageSize);
  return { items: pageItems, hasMore: offset + pageItems.length < items.length };
}

export type ToolSensitivity = 'low' | 'medium' | 'high';
export type ToolConcurrency = 'read_only' | 'serial';

export function learningOverviewCanHandle(toolName: string): boolean {
  return [LEARNING_OVERVIEW, POMODORO_TODAY_STATS, POMODORO_DAILY_STATS,
    POMODORO_RECORD_CREATE, POMODORO_RECORD_LIST, POMODORO_RECORD_DELETE]
    .includes(stripToolNamespace(toolName));
}

export function learningOverviewSensitivity(toolName = ''): ToolSensitivity {
  switch (stripToolNamespace(toolName)) {
    case POMODORO_RECORD_DELETE: return 'high';
    case POMODORO_RECORD_CREATE: return 'medium';
    default: return 'low';
  }
}

export function learningOverviewConcurrency(toolName = ''): ToolConcurrency {
  switch (stripToolNamespace(toolName)) {
    case POMODORO_RECORD_CREATE: case POMODORO_RECORD_DELETE: return 'serial';
    default: return 'read_only';
  }
}
