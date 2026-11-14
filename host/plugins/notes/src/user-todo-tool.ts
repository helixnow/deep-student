// chat_v2/tools/user_todo_executor.rs: argument validation, OCC envelopes,
// undo contracts and JSON rendering for the `user_todo_*` Agent tools. The
// repository writes live in L11 (`vfsRepo`); this module owns the tool
// contract shared by the chat runtime and localization boundary.
import { stripToolNamespace, withLocalizedMessage, type CanvasToolSensitivity } from './canvas-tool.ts';
import { charCount, takeChars as platformTakeChars, rustTrim } from '../../../platform/util/index.ts';
import {
  executeAgentToolWithLifecycle,
  type AgentToolCall, type AgentToolResultInfo, type ExecutionContext,
} from '../../../kernel/agent-api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type {
  CreateTodoItemParams, CreateTodoListParams, TodoItem, TodoList, TodoRepository,
  UpdateTodoItemParams, UpdateTodoListParams,
} from '../../vfs-repos/api.ts';
import { notesLog } from '../repository/log.ts';
import { decodeJson } from '../repository/json.ts';
import { isJsonObject, parseJsonLossless } from '../../../platform/util/lossless-json.ts';

export const MAX_PAGE_SIZE = 20;
export const MAX_CONTENT_CHARS = 2_000;
const MAX_ERROR_DETAIL_CHARS = 2_000;

export const USER_TODO_LIST_LISTS = 'user_todo_list_lists';
export const USER_TODO_CREATE_ITEM = 'user_todo_create_item';
export const USER_TODO_COMPLETE_ITEM = 'user_todo_complete_item';
export const USER_TODO_LIST_ITEMS = 'user_todo_list_items';
export const USER_TODO_GET_SUMMARY = 'user_todo_get_summary';
export const USER_TODO_UPDATE_ITEM = 'user_todo_update_item';
export const USER_TODO_DELETE_ITEM = 'user_todo_delete_item';
export const USER_TODO_CREATE_LIST = 'user_todo_create_list';
export const USER_TODO_UPDATE_LIST = 'user_todo_update_list';
export const USER_TODO_DELETE_LIST = 'user_todo_delete_list';
export const USER_TODO_SEARCH = 'user_todo_search';
export const USER_TODO_LIST_TRASH = 'user_todo_list_trash';
export const USER_TODO_RESTORE = 'user_todo_restore';
export const USER_TODO_REORDER = 'user_todo_reorder';

export const USER_TODO_TOOLS: readonly string[] = [
  USER_TODO_LIST_LISTS, USER_TODO_CREATE_ITEM, USER_TODO_COMPLETE_ITEM, USER_TODO_LIST_ITEMS,
  USER_TODO_GET_SUMMARY, USER_TODO_UPDATE_ITEM, USER_TODO_DELETE_ITEM, USER_TODO_CREATE_LIST,
  USER_TODO_UPDATE_LIST, USER_TODO_DELETE_LIST, USER_TODO_SEARCH, USER_TODO_LIST_TRASH,
  USER_TODO_RESTORE, USER_TODO_REORDER,
];

type Args = Record<string, unknown>;

function takeChars(value: string, limit: number): [string, boolean] {
  return [platformTakeChars(value, limit), charCount(value) > limit];
}

export function requiredString(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new Error(`缺少必需参数: ${key}`);
  const trimmed = rustTrim(value);
  if (trimmed.length === 0) throw new Error(`缺少必需参数: ${key}`);
  return trimmed;
}

export function validateTextLen(value: string, key: string, maxChars: number): void {
  if (charCount(value) > maxChars) throw new Error(`参数 ${key} 最多允许 ${maxChars} 个字符`);
}

export function optionalText(args: Args, key: string, maxChars: number): string | null {
  if (!(key in args)) return null;
  const value = args[key];
  if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是字符串`);
  validateTextLen(value, key, maxChars);
  return value;
}

export function parseTags(args: Args): string[] | null {
  if (!('tags' in args)) return null;
  const value = args.tags;
  if (!Array.isArray(value)) throw new Error('参数 tags 必须是字符串数组');
  if (value.length > 50) throw new Error('参数 tags 最多允许 50 项');
  return value.map((item) => {
    if (typeof item !== 'string') throw new Error('参数 tags 必须全部是字符串');
    validateTextLen(item, 'tags[]', 200);
    return item;
  });
}

export function pagination(args: Args): { page: number; pageSize: number; offset: number } {
  const rawPage = typeof args.page === 'number' && Number.isInteger(args.page) && args.page >= 0
    ? args.page : 1;
  const rawPageSize = typeof args.page_size === 'number' && Number.isInteger(args.page_size) && args.page_size >= 0
    ? args.page_size
    : typeof args.pageSize === 'number' && Number.isInteger(args.pageSize) && args.pageSize >= 0
      ? args.pageSize : MAX_PAGE_SIZE;
  if (rawPage === 0 || rawPageSize < 1 || rawPageSize > MAX_PAGE_SIZE) {
    throw new Error(`page 必须 >= 1，page_size 必须在 1..=${MAX_PAGE_SIZE}`);
  }
  const offset = (rawPage - 1) * rawPageSize;
  return { page: rawPage, pageSize: rawPageSize, offset };
}

export type TodoView = 'all' | 'today' | 'overdue' | 'upcoming' | 'completed';

export function todoView(args: Args): TodoView {
  const raw = typeof args.view === 'string' ? args.view : 'all';
  if (raw === 'all' || raw === 'today' || raw === 'overdue' || raw === 'upcoming' || raw === 'completed') {
    return raw;
  }
  throw new Error(`不支持的 view: ${raw}`);
}

export function truncateContent(value: string | null | undefined): [string | null, boolean] {
  if (value === null || value === undefined) return [null, false];
  return takeChars(value, MAX_CONTENT_CHARS);
}

export function truncateRequiredContent(value: string): [string, boolean] {
  return takeChars(value, MAX_CONTENT_CHARS);
}

export interface TodoRepeatRule {
  freq: string;
  interval: number;
  byWeekday: number[] | null;
}

const VALID_REPEAT_FREQS = ['daily', 'weekly', 'monthly', 'yearly', 'weekdays'];
const REPEAT_RULE_FIELDS = ['freq', 'interval', 'byWeekday'] as const;

/** todo_repo.rs::parse_repeat_rule. */
export function parseRepeatRule(repeatJson: string): TodoRepeatRule | null {
  let raw: unknown;
  try {
    // Derived serde struct: duplicate known fields fail, unknown fields are
    // ignored, and integer tokens stay distinct from floats (1 vs 1.0 for u32).
    decodeJson(repeatJson, REPEAT_RULE_FIELDS);
    raw = parseJsonLossless(repeatJson);
  } catch {
    return null;
  }
  let fields: unknown[];
  if (Array.isArray(raw)) {
    // serde visit_seq: freq is required, defaulted trailing fields may be omitted.
    if (raw.length < 1 || raw.length > 3) return null;
    fields = raw;
  } else if (isJsonObject(raw)) {
    fields = REPEAT_RULE_FIELDS.map((key) => raw[key]);
  } else {
    return null;
  }
  const [freq, rawInterval, rawByWeekday] = fields;
  const isUint = (value: unknown, max: number): value is number => typeof value === 'number'
    && Number.isInteger(value) && value >= 0 && value <= max;
  if (typeof freq !== 'string') return null;
  const interval = rawInterval === undefined ? 1 : rawInterval;
  if (!isUint(interval, 0xffff_ffff)) return null;
  // serde: a present non-null byWeekday must deserialize as Vec<u8>, otherwise
  // the whole rule is rejected (not silently ignored).
  if (rawByWeekday !== undefined && rawByWeekday !== null
    && (!Array.isArray(rawByWeekday) || !rawByWeekday.every((day) => isUint(day, 255)))) {
    return null;
  }
  if (!VALID_REPEAT_FREQS.includes(freq)) return null;
  if (interval === 0 || interval > 999) return null;
  let byWeekday: number[] | null = null;
  if (Array.isArray(rawByWeekday)) {
    if (freq !== 'weekly') {
      byWeekday = null;
    } else {
      const days: number[] = [];
      for (const day of rawByWeekday as number[]) {
        if (day > 6) return null;
        days.push(day);
      }
      days.sort((a, b) => a - b);
      byWeekday = [...new Set(days)];
      if (byWeekday.length === 0) byWeekday = null;
    }
  }
  return { freq, interval, byWeekday };
}

export interface VfsTodoItem {
  id: string;
  todo_list_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  due_time: string | null;
  reminder: string | null;
  tags_json: string;
  sort_order: number;
  parent_id: string | null;
  completed_at: string | null;
  repeat_json: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** todo_item_json: user text is bounded and truncation is reported per field. */
export function todoItemJson(item: VfsTodoItem): Record<string, unknown> {
  const [description, contentTruncated] = truncateContent(item.description);
  const [title, titleTruncated] = truncateRequiredContent(item.title);
  const [dueDate, dueDateTruncated] = truncateContent(item.due_date);
  const [dueTime, dueTimeTruncated] = truncateContent(item.due_time);
  const [reminder, reminderTruncated] = truncateContent(item.reminder);
  let tagsTruncated = false;
  let rawTags: unknown = [];
  try {
    rawTags = decodeJson(item.tags_json);
  } catch {
    rawTags = [];
  }
  const tags = (Array.isArray(rawTags) ? rawTags : [])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => {
      const [bounded, truncated] = truncateRequiredContent(value);
      tagsTruncated ||= truncated;
      return bounded;
    });
  const fieldsTruncated: string[] = [];
  if (titleTruncated) fieldsTruncated.push('title');
  if (contentTruncated) fieldsTruncated.push('description');
  if (tagsTruncated) fieldsTruncated.push('tags');
  if (dueDateTruncated) fieldsTruncated.push('dueDate');
  if (dueTimeTruncated) fieldsTruncated.push('dueTime');
  if (reminderTruncated) fieldsTruncated.push('reminder');
  const repeat = item.repeat_json === null ? null : parseRepeatRule(item.repeat_json);
  return {
    id: item.id,
    listId: item.todo_list_id,
    title,
    description,
    status: item.status,
    priority: item.priority,
    dueDate,
    dueTime,
    reminder,
    tags,
    sortOrder: item.sort_order,
    parentId: item.parent_id,
    completedAt: item.completed_at,
    repeat: repeat === null ? null : {
      freq: repeat.freq, interval: repeat.interval, byWeekday: repeat.byWeekday,
    },
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    deletedAt: item.deleted_at,
    contentTruncated,
    fieldsTruncated,
  };
}

export function withUndoContract(
  payload: Record<string, unknown>,
  reversible: boolean,
  restoreWith: Record<string, unknown> | null,
  undoReason: string | null,
  reversibleWithApproval: boolean,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...payload,
    reversible,
    restoreWith: restoreWith ?? null,
  };
  if (undoReason !== null) result.undoReason = undoReason;
  if (reversibleWithApproval) result.reversibleWithApproval = true;
  return result;
}

export function todoOccRequired(action: string): string {
  return JSON.stringify(withLocalizedMessage(
    {
      code: 'TODO_OCC_REQUIRED',
      hint: '重新调用 user_todo_list_items 获取 updatedAt 后再操作 / Call user_todo_list_items again and use its updatedAt value.',
      retryable: false,
    },
    // boundary-allow todo-marker: Rust localization key literally contains "todo".
    'chat.tools.todo.occ_required',
    { action, requiredField: 'expected_updated_at' },
    `${action}前必须提供 expected_updated_at`,
    // boundary-allow todo-marker: Rust English fallback text mentions the todo tool.
    'expected_updated_at is required before this todo operation.',
  ));
}

export function todoConflict(message: string, current: Record<string, unknown> | null): string {
  const currentUpdatedAt = current === null ? null : (current.updatedAt ?? null);
  return JSON.stringify(withLocalizedMessage(
    {
      code: 'TODO_CONFLICT',
      // boundary-allow todo-marker: Rust hint text names the todo tool.
      hint: '待办已被其他写入更新；重新调用 user_todo_list_items 后再操作，勿盲目重试 / The todo changed elsewhere. Read it again before retrying.',
      retryable: false,
      current: current ?? null,
      currentUpdatedAt,
    },
    // boundary-allow todo-marker: Rust localization key literally contains "todo".
    'chat.tools.todo.conflict',
    { detail: message },
    message,
    // boundary-allow todo-marker: Rust English fallback text mentions the todo tool.
    'The todo was changed by another write. Read its latest version before retrying.',
  ));
}

function truncateErrorDetail(value: string): [string, boolean] {
  return [platformTakeChars(value, MAX_ERROR_DETAIL_CHARS), charCount(value) > MAX_ERROR_DETAIL_CHARS];
}

/** dstu-core/tool_args.rs::ensure_localized_error. */
export function ensureLocalizedError(
  error: string,
  defaultCode: string,
  messageKey: string,
  zhCn: string,
  enUs: string,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(error) as unknown;
  } catch (caught) {
    parsed = null;
  }
  const isLegacyObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  const payload: Record<string, unknown> = isLegacyObject
    ? { ...(parsed as Record<string, unknown>) } : {};
  if (!('code' in payload)) payload.code = defaultCode;
  if (!isLegacyObject) {
    const [detail, detailTruncated] = truncateErrorDetail(error);
    payload.detail = detail;
    payload.detailTruncated = detailTruncated;
  }
  if (!('retryable' in payload)) payload.retryable = false;
  const actualCode = payload.code ?? defaultCode;
  const params = payload.messageParams;
  const fallback = payload.messageFallback;
  const hasContract = typeof payload.messageKey === 'string'
    && params !== null && typeof params === 'object' && !Array.isArray(params)
    && fallback !== null && typeof fallback === 'object' && !Array.isArray(fallback)
    && typeof payload.message === 'string';
  if (hasContract) {
    (params as Record<string, unknown>).code = actualCode;
    return JSON.stringify(payload);
  }
  return JSON.stringify(withLocalizedMessage(
    payload, messageKey, { code: actualCode }, zhCn, enUs,
  ));
}

export function localizedTodoFailure(error: string): string {
  return ensureLocalizedError(
    // boundary-allow todo-marker: Rust stable code/key and fallback text contain "todo".
    error, 'TODO_OPERATION_FAILED', 'chat.tools.todo.error',
    // boundary-allow todo-marker: Rust English fallback text mentions the todo tool.
    '待办操作失败', 'The todo operation failed.',
  );
}

export function expectedTodoRevision(args: Args, action: string): string {
  const raw = args.expected_updated_at ?? args.expectedUpdatedAt;
  if (typeof raw !== 'string') throw new Error(todoOccRequired(action));
  const trimmed = rustTrim(raw);
  if (trimmed.length === 0) throw new Error(todoOccRequired(action));
  return trimmed;
}

export function optionalClearableString(args: Args, key: string, clearKey: string): string | null {
  const clear = args[clearKey] === true;
  if (clear && key in args) throw new Error(`参数 ${key} 与 ${clearKey}=true 不能同时提供`);
  if (clear) return '';
  if (!(key in args)) return null;
  const value = args[key];
  if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是字符串`);
  validateTextLen(value, key, MAX_CONTENT_CHARS);
  return value;
}

export function optionalRepeatJson(args: Args): string | null {
  const clear = args.clear_repeat === true;
  if (clear && 'repeat' in args) throw new Error('参数 repeat 与 clear_repeat=true 不能同时提供');
  if (clear) return '';
  const value = 'repeat' in args ? args.repeat : args.repeat_json;
  if (value === undefined) return null;
  if (typeof value === 'string') {
    validateTextLen(value, 'repeat', MAX_CONTENT_CHARS);
    return value;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const serialized = JSON.stringify(value);
    validateTextLen(serialized, 'repeat', MAX_CONTENT_CHARS);
    return serialized;
  }
  throw new Error('参数 repeat 必须是重复规则对象或 JSON 字符串');
}

export function userTodoSensitivity(toolName: string): CanvasToolSensitivity {
  const stripped = stripToolNamespace(toolName);
  if (stripped === USER_TODO_DELETE_LIST) return 'high';
  if (stripped === USER_TODO_CREATE_ITEM || stripped === USER_TODO_COMPLETE_ITEM
    || stripped === USER_TODO_UPDATE_ITEM || stripped === USER_TODO_DELETE_ITEM
    || stripped === USER_TODO_CREATE_LIST || stripped === USER_TODO_UPDATE_LIST
    || stripped === USER_TODO_RESTORE || stripped === USER_TODO_REORDER) return 'medium';
  return 'low';
}

/** `todo_list_json`: same truncation reporting as `todo_item_json`. */
export function todoListJson(list: TodoList): Record<string, unknown> {
  const [description, contentTruncated] = truncateContent(list.description ?? null);
  const [title, titleTruncated] = truncateRequiredContent(list.title);
  const [icon, iconTruncated] = truncateContent(list.icon ?? null);
  const [color, colorTruncated] = truncateContent(list.color ?? null);
  const fieldsTruncated: string[] = [];
  if (titleTruncated) fieldsTruncated.push('title');
  if (contentTruncated) fieldsTruncated.push('description');
  if (iconTruncated) fieldsTruncated.push('icon');
  if (colorTruncated) fieldsTruncated.push('color');
  return {
    id: list.id,
    title,
    description,
    icon,
    color,
    sortOrder: list.sortOrder,
    isDefault: list.isDefault,
    isFavorite: list.isFavorite,
    createdAt: list.createdAt,
    updatedAt: list.updatedAt,
    deletedAt: list.deletedAt ?? null,
    contentTruncated,
    fieldsTruncated,
  };
}

/** L11 repo row (camelCase) → Rust `VfsTodoItem` vocabulary used by `todo_item_json`. */
export function todoItemJsonFromRepo(item: TodoItem): Record<string, unknown> {
  return todoItemJson({
    id: item.id,
    todo_list_id: item.todoListId,
    title: item.title,
    description: item.description ?? null,
    status: item.status,
    priority: item.priority,
    due_date: item.dueDate ?? null,
    due_time: item.dueTime ?? null,
    reminder: item.reminder ?? null,
    tags_json: item.tagsJson,
    sort_order: item.sortOrder,
    parent_id: item.parentId ?? null,
    completed_at: item.completedAt ?? null,
    repeat_json: item.repeatJson ?? null,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    deleted_at: item.deletedAt ?? null,
  });
}

/** `paginated_payload` (snake_case wire fields). */
export function paginatedPayload(
  key: string,
  values: readonly unknown[],
  total: number,
  page: number,
  pageSize: number,
): Record<string, unknown> {
  const consumed = page * pageSize;
  const hasMore = Number.isSafeInteger(consumed) && consumed < total;
  return {
    success: true,
    count: values.length,
    total,
    page,
    page_size: pageSize,
    has_more: hasMore,
    truncated: hasMore,
    [key]: values,
  };
}

/** Repository surface needed by the executor; production binds L11 `todos`. */
export interface UserTodoExecutorPorts {
  readonly conn: () => SqlExecutor;
  readonly todos: TodoRepository;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function argsObject(value: unknown): Args {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Args : {};
}

function boolArg(args: Args, key: string): boolean {
  return args[key] === true;
}

function optionalRepoText(args: Args, key: string, maxChars: number): string | null {
  return optionalText(args, key, maxChars);
}

function todoItemConflict(
  conn: SqlExecutor,
  todos: TodoRepository,
  itemId: string,
  message: string,
): string {
  const current = todos.getTodoItem(conn, itemId);
  return todoConflict(message, current === null ? null : todoItemJsonFromRepo(current));
}

function todoListConflict(
  conn: SqlExecutor,
  todos: TodoRepository,
  listId: string,
  message: string,
): string {
  const current = todos.getTodoList(conn, listId);
  return todoConflict(message, current === null ? null : todoListJson(current));
}

/** chat_v2/tools/user_todo_executor.rs::emit_todo_changed (source="agent"). */
function emitTodoChanged(
  ctx: ExecutionContext,
  call: AgentToolCall,
  action: string,
  entityIds: readonly string[],
): void {
  if (!ctx.host.hasFrontend()) return;
  const runId = ctx.ids.toolCallId || ctx.ids.blockId || call.id;
  const payload = { source: 'agent', action, entityIds: [...entityIds], runId };
  try {
    ctx.host.emit('todo://changed', payload);
  } catch (error) {
    notesLog.debug(`[UserTodoExecutor] Failed to emit todo://changed: ${errorText(error)}`);
  }
}

function localizedItemCreated(title: string): Record<string, unknown> {
  return withLocalizedMessage(
    {
      success: true,
      previous: null,
      reversible: true,
    },
    'chat.tools.todo.item_created',
    { title },
    `已创建待办项「${title}」`,
    `Created todo item "${title}".`,
  );
}

function localizedItemCompleted(title: string): Record<string, unknown> {
  return withLocalizedMessage(
    { success: true },
    'chat.tools.todo.item_completed',
    { title },
    `待办项「${title}」已标记为完成`,
    `Marked todo item "${title}" as completed.`,
  );
}

function localizedItemAlreadyCompleted(title: string): Record<string, unknown> {
  return withLocalizedMessage(
    { success: true },
    'chat.tools.todo.item_already_completed',
    { title },
    `待办项「${title}」已经是完成状态`,
    `Todo item "${title}" is already completed.`,
  );
}

function localizedItemUpdated(title: string): Record<string, unknown> {
  return withLocalizedMessage(
    { success: true },
    'chat.tools.todo.item_updated',
    { title },
    `已更新待办项「${title}」`,
    `Updated todo item "${title}".`,
  );
}

function localizedEmpty(): Record<string, unknown> {
  return withLocalizedMessage(
    {
      success: true,
      stats: { totalPending: 0, todayDue: 0, overdueCount: 0, todayCompleted: 0 },
    },
    'chat.tools.todo.empty',
    {},
    '没有待办事项',
    'There are no todo items.',
  );
}

/** Tool executor for `user_todo_*` (chat_v2/tools/user_todo_executor.rs). */
export class UserTodoExecutor {
  private readonly ports: UserTodoExecutorPorts | null;

  constructor(ports?: UserTodoExecutorPorts) {
    this.ports = ports ?? null;
  }

  canHandle(toolName: string): boolean {
    return USER_TODO_TOOLS.includes(stripToolNamespace(toolName));
  }

  sensitivityLevel(toolName: string): CanvasToolSensitivity {
    return userTodoSensitivity(toolName);
  }

  name(): string {
    return 'UserTodoExecutor';
  }

  async execute(call: AgentToolCall, ctx: ExecutionContext): Promise<AgentToolResultInfo> {
    const args = argsObject(call.arguments);
    return executeAgentToolWithLifecycle(call, ctx, () => this.run(call, args, ctx), {
      formatError: error => localizedTodoFailure(errorText(error)),
      warn: message => notesLog.warn(`[UserTodoExecutor] ${message}`),
    });
  }

  private requirePorts(): UserTodoExecutorPorts {
    if (this.ports === null) throw new Error('VFS database not available');
    return this.ports;
  }

  private async run(
    call: AgentToolCall,
    args: Args,
    ctx: ExecutionContext,
  ): Promise<Record<string, unknown>> {
    const ports = this.requirePorts();
    switch (stripToolNamespace(call.name)) {
      case USER_TODO_LIST_LISTS: return this.listLists(args, ports);
      case USER_TODO_CREATE_ITEM: return this.createItem(args, ports, ctx, call);
      case USER_TODO_COMPLETE_ITEM: return this.completeItem(args, ports, ctx, call);
      case USER_TODO_LIST_ITEMS: return this.listItems(args, ports);
      case USER_TODO_GET_SUMMARY: return this.getSummary(ports);
      case USER_TODO_UPDATE_ITEM: return this.updateItem(args, ports, ctx, call);
      case USER_TODO_DELETE_ITEM: return this.deleteItem(args, ports, ctx, call);
      case USER_TODO_CREATE_LIST: return this.createList(args, ports, ctx, call);
      case USER_TODO_UPDATE_LIST: return this.updateList(args, ports, ctx, call);
      case USER_TODO_DELETE_LIST: return this.deleteList(args, ports, ctx, call);
      case USER_TODO_SEARCH: return this.search(args, ports);
      case USER_TODO_LIST_TRASH: return this.listTrash(args, ports);
      case USER_TODO_RESTORE: return this.restore(args, ports, ctx, call);
      case USER_TODO_REORDER: return this.reorder(args, ports, ctx, call);
      default: throw new Error(`未知的用户待办工具: ${call.name}`);
    }
  }

  private listLists(args: Args, ports: UserTodoExecutorPorts): Record<string, unknown> {
    const lists = ports.todos.listTodoLists(ports.conn());
    const { page, pageSize, offset } = pagination(args);
    const values = lists.slice(offset, offset + pageSize).map(todoListJson);
    return paginatedPayload('lists', values, lists.length, page, pageSize);
  }

  private createItem(
    args: Args,
    ports: UserTodoExecutorPorts,
    ctx: ExecutionContext,
    call: AgentToolCall,
  ): Record<string, unknown> {
    const conn = ports.conn();
    const rawTitle = args.title;
    if (typeof rawTitle !== 'string') throw new Error('缺少必需参数: title');
    const title = rawTitle;
    validateTextLen(title, 'title', 200);

    const listId = 'list_id' in args
      ? (() => {
        const id = requiredString(args, 'list_id');
        validateTextLen(id, 'list_id', 512);
        return id;
      })()
      : ports.todos.ensureDefaultInbox(conn).id;

    const parent = optionalRepoText(args, 'parent_id', 512);
    const params: CreateTodoItemParams = {
      todoListId: listId,
      title,
      description: optionalRepoText(args, 'description', MAX_CONTENT_CHARS),
      priority: optionalRepoText(args, 'priority', 16) ?? 'none',
      dueDate: optionalRepoText(args, 'due_date', 32),
      dueTime: optionalRepoText(args, 'due_time', 32),
      reminder: optionalRepoText(args, 'reminder', 64),
      tags: parseTags(args),
      parentId: parent === null ? null : (rustTrim(parent).length === 0 ? null : rustTrim(parent)),
      repeatJson: (() => {
        const repeat = optionalRepeatJson(args);
        return repeat === null || rustTrim(repeat).length === 0 ? null : repeat;
      })(),
    };
    const item = ports.todos.createTodoItem(conn, params);
    emitTodoChanged(ctx, call, 'create_item', [item.id, item.todoListId]);

    const payload = localizedItemCreated(title);
    payload.item = todoItemJsonFromRepo(item);
    payload.restoreWith = {
      tool: USER_TODO_DELETE_ITEM,
      arguments: { item_id: item.id, expected_updated_at: item.updatedAt },
    };
    return payload;
  }

  private completeItem(
    args: Args,
    ports: UserTodoExecutorPorts,
    ctx: ExecutionContext,
    call: AgentToolCall,
  ): Record<string, unknown> {
    const conn = ports.conn();
    const itemId = args.item_id;
    if (typeof itemId !== 'string') throw new Error('缺少必需参数: item_id');
    const expected = expectedTodoRevision(args, '完成待办');
    const existing = ports.todos.getTodoItem(conn, itemId);
    if (existing === null) throw new Error(`待办项 ${itemId} 不存在`);
    if (existing.updatedAt !== expected) {
      throw new Error(todoConflict('待办已被其他写入更新', todoItemJsonFromRepo(existing)));
    }
    if (existing.status === 'completed') {
      const displayTitle = truncateRequiredContent(existing.title)[0];
      const payload = localizedItemAlreadyCompleted(displayTitle);
      payload.item = todoItemJsonFromRepo(existing);
      payload.previous = todoItemJsonFromRepo(existing);
      return withUndoContract(
        payload, false, null, '本次调用未产生状态变化，无需撤销', false,
      );
    }
    let item: TodoItem;
    try {
      item = ports.todos.toggleTodoItem(conn, itemId, expected);
    } catch (error) {
      const message = errorText(error);
      if (message.includes('TODO_CONFLICT')) {
        throw new Error(todoItemConflict(conn, ports.todos, itemId, message));
      }
      throw error;
    }
    emitTodoChanged(ctx, call, 'complete_item', [item.id, item.todoListId]);
    const displayTitle = truncateRequiredContent(item.title)[0];
    const payload = localizedItemCompleted(displayTitle);
    payload.item = todoItemJsonFromRepo(item);
    payload.previous = todoItemJsonFromRepo(existing);
    return withUndoContract(
      payload, false, null, 'update_item 工具不暴露 status，无法安全重放未完成状态', false,
    );
  }

  private listItems(args: Args, ports: UserTodoExecutorPorts): Record<string, unknown> {
    const conn = ports.conn();
    const view = todoView(args);
    const includeCompleted = boolArg(args, 'include_completed');
    const listId = typeof args.list_id === 'string' ? args.list_id : null;
    let items: TodoItem[];
    switch (view) {
      case 'today': items = ports.todos.listTodayItems(conn, includeCompleted); break;
      case 'overdue': items = ports.todos.listOverdueItems(conn, includeCompleted); break;
      case 'upcoming': items = ports.todos.listUpcomingItems(conn, 7, includeCompleted); break;
      case 'completed': items = ports.todos.listCompletedItems(conn, listId); break;
      default:
        if (listId !== null) {
          items = ports.todos.listItemsByList(conn, listId, includeCompleted);
        } else {
          items = ports.todos.listAllPendingItems(conn);
          if (includeCompleted) items = [...items, ...ports.todos.listCompletedItems(conn, null)];
        }
    }
    const { page, pageSize, offset } = pagination(args);
    const values = items.slice(offset, offset + pageSize).map(todoItemJsonFromRepo);
    const payload = paginatedPayload('items', values, items.length, page, pageSize);
    payload.view = view;
    return payload;
  }

  private getSummary(ports: UserTodoExecutorPorts): Record<string, unknown> {
    const summary = ports.todos.getActiveTodoSummary(ports.conn());
    if (summary === null) return localizedEmpty();
    const formatted = ports.todos.formatActiveSummaryForPrompt(summary);
    const [bounded, truncated] = truncateRequiredContent(formatted);
    return {
      success: true,
      stats: {
        totalPending: summary.stats.totalPending,
        todayDue: summary.stats.todayDue,
        overdueCount: summary.stats.overdueCount,
        todayCompleted: summary.stats.todayCompleted,
      },
      todayItems: summary.todayItems.length,
      overdueItems: summary.overdueItems.length,
      formattedSummary: bounded,
      fieldsTruncated: truncated ? ['formattedSummary'] : [],
    };
  }

  private updateItem(
    args: Args,
    ports: UserTodoExecutorPorts,
    ctx: ExecutionContext,
    call: AgentToolCall,
  ): Record<string, unknown> {
    const conn = ports.conn();
    const itemId = args.item_id;
    if (typeof itemId !== 'string') throw new Error('缺少必需参数: item_id');
    const expected = expectedTodoRevision(args, '更新待办');
    const previous = ports.todos.getTodoItem(conn, itemId);
    if (previous === null) throw new Error(`待办项 ${itemId} 不存在`);
    const title = optionalRepoText(args, 'title', 200);
    if (title !== null && rustTrim(title).length === 0) {
      throw new Error('参数 title 不得为空');
    }
    const params: UpdateTodoItemParams = {
      title,
      description: optionalRepoText(args, 'description', MAX_CONTENT_CHARS),
      status: null,
      priority: optionalRepoText(args, 'priority', 16),
      dueDate: optionalRepoText(args, 'due_date', 32),
      dueTime: optionalRepoText(args, 'due_time', 32),
      reminder: optionalClearableString(args, 'reminder', 'clear_reminder'),
      tags: parseTags(args),
      parentId: optionalClearableString(args, 'parent_id', 'clear_parent'),
      repeatJson: optionalRepeatJson(args),
      estimatedPomodoros: null,
      expectedUpdatedAt: expected,
    };
    let item: TodoItem;
    try {
      item = ports.todos.updateTodoItem(conn, itemId, params);
    } catch (error) {
      const message = errorText(error);
      if (message.includes('TODO_CONFLICT')) {
        throw new Error(todoItemConflict(conn, ports.todos, itemId, message));
      }
      throw error;
    }
    emitTodoChanged(ctx, call, 'update_item', [item.id, item.todoListId]);
    const displayTitle = truncateRequiredContent(item.title)[0];
    const payload = localizedItemUpdated(displayTitle);
    payload.updatedAt = item.updatedAt;
    payload.item = todoItemJsonFromRepo(item);
    payload.previous = todoItemJsonFromRepo(previous);
    return withUndoContract(
      payload, false, null, '部分字段采用三态清空语义，当前工具无法无损重放所有旧字段', false,
    );
  }

  private deleteItem(
    args: Args,
    ports: UserTodoExecutorPorts,
    ctx: ExecutionContext,
    call: AgentToolCall,
  ): Record<string, unknown> {
    const conn = ports.conn();
    const itemId = requiredString(args, 'item_id');
    const expected = expectedTodoRevision(args, '删除待办');
    let previous: TodoItem;
    try {
      previous = ports.todos.deleteTodoItemIfVersion(conn, itemId, expected);
    } catch (error) {
      const message = errorText(error);
      if (message.includes('TODO_CONFLICT')) {
        throw new Error(todoItemConflict(conn, ports.todos, itemId, message));
      }
      throw error;
    }
    emitTodoChanged(ctx, call, 'delete_item', [previous.id, previous.todoListId]);
    return {
      success: true,
      itemId: previous.id,
      listId: previous.todoListId,
      softDeleted: true,
      previous: todoItemJsonFromRepo(previous),
      reversible: true,
      restoreWith: {
        tool: USER_TODO_RESTORE,
        arguments: { entity_type: 'item', entity_id: previous.id },
      },
    };
  }

  private createList(
    args: Args,
    ports: UserTodoExecutorPorts,
    ctx: ExecutionContext,
    call: AgentToolCall,
  ): Record<string, unknown> {
    const conn = ports.conn();
    const title = requiredString(args, 'title');
    validateTextLen(title, 'title', 200);
    const params: CreateTodoListParams = {
      title,
      description: optionalRepoText(args, 'description', MAX_CONTENT_CHARS),
      icon: optionalRepoText(args, 'icon', 64),
      color: optionalRepoText(args, 'color', 32),
      isDefault: false,
    };
    const list = ports.todos.createTodoList(conn, params);
    emitTodoChanged(ctx, call, 'create_list', [list.id]);
    return withUndoContract(
      { success: true, list: todoListJson(list), previous: null },
      false,
      {
        tool: USER_TODO_DELETE_LIST,
        arguments: { list_id: list.id, expected_updated_at: list.updatedAt },
      },
      '撤销创建需要执行 High 风险的清单删除并重新取得用户确认',
      true,
    );
  }

  private updateList(
    args: Args,
    ports: UserTodoExecutorPorts,
    ctx: ExecutionContext,
    call: AgentToolCall,
  ): Record<string, unknown> {
    const conn = ports.conn();
    const listId = requiredString(args, 'list_id');
    const expected = expectedTodoRevision(args, '更新清单');
    if (!['title', 'description', 'icon', 'color'].some((key) => key in args)) {
      throw new Error('更新清单时至少提供 title/description/icon/color 之一');
    }
    const title = optionalRepoText(args, 'title', 200);
    if (title !== null && rustTrim(title).length === 0) {
      throw new Error('参数 title 不得为空');
    }
    const params: UpdateTodoListParams = {
      title,
      description: optionalRepoText(args, 'description', MAX_CONTENT_CHARS),
      icon: optionalRepoText(args, 'icon', 64),
      color: optionalRepoText(args, 'color', 32),
    };
    let previous: TodoList;
    let current: TodoList;
    try {
      [previous, current] = ports.todos.updateTodoListIfVersion(conn, listId, params, expected);
    } catch (error) {
      const message = errorText(error);
      if (message.includes('TODO_CONFLICT')) {
        throw new Error(todoListConflict(conn, ports.todos, listId, message));
      }
      throw error;
    }
    emitTodoChanged(ctx, call, 'update_list', [current.id]);
    return withUndoContract(
      { success: true, list: todoListJson(current), previous: todoListJson(previous) },
      false,
      null,
      '当前清单更新参数无法表达所有可选字段的精确清空/恢复',
      false,
    );
  }

  private deleteList(
    args: Args,
    ports: UserTodoExecutorPorts,
    ctx: ExecutionContext,
    call: AgentToolCall,
  ): Record<string, unknown> {
    const conn = ports.conn();
    const listId = requiredString(args, 'list_id');
    const expected = expectedTodoRevision(args, '删除清单');
    let previous: TodoList;
    try {
      previous = ports.todos.deleteTodoListIfVersion(conn, listId, expected);
    } catch (error) {
      const message = errorText(error);
      if (message.includes('TODO_CONFLICT')) {
        throw new Error(todoListConflict(conn, ports.todos, listId, message));
      }
      throw error;
    }
    emitTodoChanged(ctx, call, 'delete_list', [previous.id]);
    return {
      success: true,
      listId: previous.id,
      softDeleted: true,
      previous: todoListJson(previous),
      reversible: true,
      restoreWith: {
        tool: USER_TODO_RESTORE,
        arguments: { entity_type: 'list', entity_id: previous.id },
      },
    };
  }

  private search(args: Args, ports: UserTodoExecutorPorts): Record<string, unknown> {
    const query = requiredString(args, 'query');
    validateTextLen(query, 'query', 200);
    const { page, pageSize, offset } = pagination(args);
    const [items, total] = ports.todos.searchItemsPaginated(ports.conn(), query, pageSize, offset);
    return paginatedPayload('items', items.map(todoItemJsonFromRepo), total, page, pageSize);
  }

  private listTrash(args: Args, ports: UserTodoExecutorPorts): Record<string, unknown> {
    const conn = ports.conn();
    const entityType = requiredString(args, 'entity_type');
    const { page, pageSize, offset } = pagination(args);
    let values: Array<Record<string, unknown>>;
    let total: number;
    if (entityType === 'item') {
      const items = ports.todos.listDeletedTodoItems(conn, pageSize, offset);
      total = ports.todos.countDeletedTodoItems(conn);
      values = items.map((item) => ({ ...todoItemJsonFromRepo(item), entityType: 'item' }));
    } else if (entityType === 'list') {
      const lists = ports.todos.listDeletedTodoLists(conn, pageSize, offset);
      total = ports.todos.countDeletedTodoLists(conn);
      values = lists.map((list) => ({ ...todoListJson(list), entityType: 'list' }));
    } else {
      throw new Error('entity_type 必须是 item 或 list');
    }
    return paginatedPayload('items', values, total, page, pageSize);
  }

  private restore(
    args: Args,
    ports: UserTodoExecutorPorts,
    ctx: ExecutionContext,
    call: AgentToolCall,
  ): Record<string, unknown> {
    const conn = ports.conn();
    const entityType = requiredString(args, 'entity_type');
    const entityId = requiredString(args, 'entity_id');
    let entity: Record<string, unknown>;
    let entityIds: string[];
    let restoreWith: Record<string, unknown>;
    let reversible: boolean;
    let undoReason: string | null;
    let withApproval: boolean;
    if (entityType === 'item') {
      const item = ports.todos.restoreTodoItem(conn, entityId);
      entityIds = [item.id, item.todoListId];
      restoreWith = {
        tool: USER_TODO_DELETE_ITEM,
        arguments: { item_id: item.id, expected_updated_at: item.updatedAt },
      };
      entity = todoItemJsonFromRepo(item);
      reversible = true;
      undoReason = null;
      withApproval = false;
    } else if (entityType === 'list') {
      const list = ports.todos.restoreTodoList(conn, entityId);
      entityIds = [list.id];
      restoreWith = {
        tool: USER_TODO_DELETE_LIST,
        arguments: { list_id: list.id, expected_updated_at: list.updatedAt },
      };
      entity = todoListJson(list);
      reversible = false;
      undoReason = '撤销清单恢复需要执行 High 风险的清单删除并重新取得用户确认';
      withApproval = true;
    } else {
      throw new Error('entity_type 必须是 item 或 list');
    }
    emitTodoChanged(ctx, call, 'restore', entityIds);
    return withUndoContract(
      {
        success: true,
        entityType,
        entity,
        previous: { entityType, id: entityId, deleted: true },
      },
      reversible,
      restoreWith,
      undoReason,
      withApproval,
    );
  }

  private reorder(
    args: Args,
    ports: UserTodoExecutorPorts,
    ctx: ExecutionContext,
    call: AgentToolCall,
  ): Record<string, unknown> {
    const conn = ports.conn();
    const listId = requiredString(args, 'list_id');
    const expected = expectedTodoRevision(args, '重排清单');
    const rawIds = args.item_ids;
    if (!Array.isArray(rawIds)) throw new Error('缺少必需参数: item_ids');
    const itemIds = rawIds.map((value) => {
      if (typeof value !== 'string') throw new Error('item_ids 必须全部是字符串');
      return value;
    });
    if (itemIds.length === 0 || itemIds.length > 500) {
      throw new Error('item_ids 数量必须在 1..=500');
    }
    const previous = ports.todos.listItemsByList(conn, listId, true).map((item) => item.id);
    try {
      ports.todos.reorderItems(conn, listId, itemIds, expected);
    } catch (error) {
      const message = errorText(error);
      if (message.includes('TODO_CONFLICT')) {
        throw new Error(todoListConflict(conn, ports.todos, listId, message));
      }
      throw error;
    }
    const currentList = ports.todos.getTodoList(conn, listId);
    if (currentList === null) throw new Error(`待办清单 ${listId} 不存在`);
    emitTodoChanged(ctx, call, 'reorder', [listId]);
    return {
      success: true,
      listId,
      reorderedCount: itemIds.length,
      previous: { itemIds: previous },
      reversible: true,
      restoreWith: {
        tool: USER_TODO_REORDER,
        arguments: {
          list_id: listId,
          item_ids: previous,
          expected_updated_at: currentList.updatedAt,
        },
      },
    };
  }
}
