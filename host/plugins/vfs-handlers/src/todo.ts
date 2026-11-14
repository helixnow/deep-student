/** vfs/todo_handlers.rs: 待办清单/条目命令层（薄层：校验、错误映射、事件）。 */
import type { Context } from '@deepseek-ai/cordis';
import { rustTrim } from '../../../platform/util/portable.ts';
import { requireMaintenance, type VfsMaintenanceService } from './maintenance-needs.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type {
  CommandErrorEnvelope,
} from './errors.ts';
import { customCommandError, envelopeCommandError, todoCommandError } from './errors.ts';
import type { RawPromptLlm } from './llm-needs.ts';
import type {
  CreateTodoItemParams,
  CreateTodoListParams,
  TodoBatchIdsResult,
  TodoBatchItemsResult,
  TodoItem,
  TodoItemWithChildStats,
  TodoList,
  TodoRepository,
  UpdateTodoItemParams,
  UpdateTodoListParams,
} from '../../vfs-repos/api.ts';

export interface TodoListInput {
  title: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
}

export interface UpdateTodoListInput extends TodoListInput {
  id: string;
}

export interface CreateTodoItemInput {
  todoListId: string;
  title: string;
  description?: string | null;
  priority?: string;
  dueDate?: string | null;
  dueTime?: string | null;
  reminder?: string | null;
  tags?: string[] | null;
  parentId?: string | null;
  attachments?: string[] | null;
  repeatJson?: string | null;
}

export interface UpdateTodoItemInput {
  id: string;
  title?: string | null;
  description?: string | null;
  status?: string | null;
  priority?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  reminder?: string | null;
  tags?: string[] | null;
  parentId?: string | null;
  attachments?: string[] | null;
  repeatJson?: string | null;
  estimatedPomodoros?: number | null;
  completedPomodoros?: number | null;
  expectedUpdatedAt?: string | null;
}

export interface ReorderItemsInput {
  listId: string;
  itemIds: string[];
  expectedUpdatedAt?: string | null;
}

export interface ReorderListsInput {
  listIds: string[];
}

export interface MoveTodoItemInput {
  itemId: string;
  targetListId: string;
}

export interface TodoEventDeps {
  readonly log: Context['logger'];
  readonly emit: (event: string, payload: unknown) => void;
}

export interface TodoDeps extends TodoEventDeps {
  readonly maintenance?: VfsMaintenanceService;
  readonly conn: () => DatabaseHandle;
  readonly repos: TodoRepository;
  /** Optional until L02 publishes callModel2RawPrompt on llm@1. */
  readonly llm: RawPromptLlm | undefined;
}

/** todo_handlers::emit_todo_changed（source 固定 "user"，失败只记 debug 日志）。 */
export function emitTodoChanged(deps: TodoEventDeps, action: string, entityIds: readonly string[]): void {
  try {
    deps.emit('todo://changed', { source: 'user', action, entityIds: [...entityIds] });
  } catch (error) {
    deps.log.debug('[todo_handlers] Failed to emit todo://changed: %s', error);
  }
}

function fail(deps: TodoDeps, command: string, error: unknown): never {
  throw new CommandError(todoCommandError(deps.log, command, error));
}

function failCustom(deps: TodoDeps, command: string, code: string, message: string): never {
  throw new CommandError(customCommandError(deps.log, command, code, message));
}

export function createList(deps: TodoDeps, input: TodoListInput): TodoList {
  const params: CreateTodoListParams = {
    title: input.title,
    description: input.description ?? null,
    icon: input.icon ?? null,
    color: input.color ?? null,
    isDefault: false,
  };
  try {
    const list = deps.repos.createTodoList(deps.conn(), params);
    emitTodoChanged(deps, 'create_list', [list.id]);
    return list;
  } catch (error) {
    return fail(deps, 'todo_create_list', error);
  }
}

export function getList(deps: TodoDeps, listId: string): TodoList | null {
  try {
    return deps.repos.getTodoList(deps.conn(), listId);
  } catch (error) {
    return fail(deps, 'todo_get_list', error);
  }
}

export function listLists(deps: TodoDeps): TodoList[] {
  try {
    return deps.repos.listTodoLists(deps.conn());
  } catch (error) {
    return fail(deps, 'todo_list_lists', error);
  }
}

export function updateList(deps: TodoDeps, input: UpdateTodoListInput): TodoList {
  const params: UpdateTodoListParams = {
    title: input.title ?? null,
    description: input.description ?? null,
    icon: input.icon ?? null,
    color: input.color ?? null,
  };
  try {
    const list = deps.repos.updateTodoList(deps.conn(), input.id, params);
    emitTodoChanged(deps, 'update_list', [list.id]);
    return list;
  } catch (error) {
    return fail(deps, 'todo_update_list', error);
  }
}

export function deleteList(deps: TodoDeps, listId: string): null {
  try {
    deps.repos.deleteTodoList(deps.conn(), listId);
    emitTodoChanged(deps, 'delete_list', [listId]);
    return null;
  } catch (error) {
    return fail(deps, 'todo_delete_list', error);
  }
}

export function toggleListFavorite(deps: TodoDeps, listId: string): TodoList {
  try {
    const list = deps.repos.toggleTodoListFavorite(deps.conn(), listId);
    emitTodoChanged(deps, 'update_list', [list.id]);
    return list;
  } catch (error) {
    return fail(deps, 'todo_toggle_list_favorite', error);
  }
}

export function ensureInbox(deps: TodoDeps, title: string | null): TodoList {
  try {
    return deps.repos.ensureDefaultInbox(deps.conn(), title);
  } catch (error) {
    return fail(deps, 'todo_ensure_inbox', error);
  }
}

export function reorderLists(deps: TodoDeps, input: ReorderListsInput): null {
  try {
    deps.repos.reorderTodoLists(deps.conn(), input.listIds);
    emitTodoChanged(deps, 'reorder_lists', input.listIds);
    return null;
  } catch (error) {
    return fail(deps, 'todo_reorder_lists', error);
  }
}

export function listDeletedLists(deps: TodoDeps, limit: number | null, offset: number | null): TodoList[] {
  try {
    return deps.repos.listDeletedTodoLists(deps.conn(), limit ?? 100, offset ?? 0);
  } catch (error) {
    return fail(deps, 'todo_list_deleted_lists', error);
  }
}

export function restoreList(deps: TodoDeps, listId: string): TodoList {
  try {
    const list = deps.repos.restoreTodoList(deps.conn(), listId);
    emitTodoChanged(deps, 'restore_list', [list.id]);
    return list;
  } catch (error) {
    return fail(deps, 'todo_restore_list', error);
  }
}

export function purgeList(deps: TodoDeps, listId: string): null {
  try {
    deps.repos.purgeTodoList(deps.conn(), listId);
    emitTodoChanged(deps, 'purge_list', [listId]);
    return null;
  } catch (error) {
    return fail(deps, 'todo_purge_list', error);
  }
}

export function purgeDeletedLists(deps: TodoDeps): number {
  try {
    const purged = deps.repos.purgeDeletedTodoLists(deps.conn());
    if (purged > 0) emitTodoChanged(deps, 'purge_deleted_lists', []);
    return purged;
  } catch (error) {
    return fail(deps, 'todo_purge_deleted_lists', error);
  }
}

export function restoreItem(deps: TodoDeps, itemId: string): TodoItem {
  try {
    const item = deps.repos.restoreTodoItem(deps.conn(), itemId);
    emitTodoChanged(deps, 'restore', [item.id]);
    return item;
  } catch (error) {
    return fail(deps, 'todo_restore_item', error);
  }
}

export function listDeletedItems(deps: TodoDeps, limit: number | null, offset: number | null): TodoItem[] {
  try {
    return deps.repos.listDeletedTodoItems(deps.conn(), limit ?? 100, offset ?? 0);
  } catch (error) {
    return fail(deps, 'todo_list_deleted_items', error);
  }
}

export function purgeItem(deps: TodoDeps, itemId: string): null {
  try {
    deps.repos.purgeTodoItem(deps.conn(), itemId);
    emitTodoChanged(deps, 'purge_item', [itemId]);
    return null;
  } catch (error) {
    return fail(deps, 'todo_purge_item', error);
  }
}

export function purgeDeletedItems(deps: TodoDeps): number {
  try {
    const purged = deps.repos.purgeDeletedTodoItems(deps.conn());
    if (purged > 0) emitTodoChanged(deps, 'purge_deleted_items', []);
    return purged;
  } catch (error) {
    return fail(deps, 'todo_purge_deleted_items', error);
  }
}

export function createItem(deps: TodoDeps, input: CreateTodoItemInput): TodoItem {
  const params: CreateTodoItemParams = {
    todoListId: input.todoListId,
    title: input.title,
    description: input.description ?? null,
    priority: input.priority ?? 'none',
    dueDate: input.dueDate ?? null,
    dueTime: input.dueTime ?? null,
    reminder: input.reminder ?? null,
    tags: input.tags ?? null,
    parentId: input.parentId ?? null,
    attachments: input.attachments ?? null,
    repeatJson: input.repeatJson ?? null,
  };
  try {
    const item = deps.repos.createTodoItem(deps.conn(), params);
    emitTodoChanged(deps, 'create', [item.id]);
    return item;
  } catch (error) {
    return fail(deps, 'todo_create_item', error);
  }
}

export function getItem(deps: TodoDeps, itemId: string): TodoItem | null {
  try {
    return deps.repos.getTodoItem(deps.conn(), itemId);
  } catch (error) {
    return fail(deps, 'todo_get_item', error);
  }
}

export function listItems(
  deps: TodoDeps,
  listId: string,
  includeCompleted: boolean,
  limit: number | null,
  offset: number | null,
): TodoItem[] {
  try {
    return deps.repos.listItemsByList(deps.conn(), listId, includeCompleted, limit, offset);
  } catch (error) {
    return fail(deps, 'todo_list_items', error);
  }
}

export function updateItem(deps: TodoDeps, input: UpdateTodoItemInput): TodoItem {
  if (input.completedPomodoros != null) {
    return failCustom(
      deps,
      'todo_update_item',
      'VFS_INVALID_ARGUMENT',
      'completedPomodoros is derived from pomodoro records and cannot be updated directly',
    );
  }
  const params: UpdateTodoItemParams = {
    title: input.title ?? null,
    description: input.description ?? null,
    status: input.status ?? null,
    priority: input.priority ?? null,
    dueDate: input.dueDate ?? null,
    dueTime: input.dueTime ?? null,
    reminder: input.reminder ?? null,
    tags: input.tags ?? null,
    parentId: input.parentId ?? null,
    attachments: input.attachments ?? null,
    repeatJson: input.repeatJson ?? null,
    estimatedPomodoros: input.estimatedPomodoros ?? null,
    expectedUpdatedAt: input.expectedUpdatedAt ?? null,
  };
  try {
    const item = deps.repos.updateTodoItem(deps.conn(), input.id, params);
    emitTodoChanged(deps, 'update', [item.id]);
    return item;
  } catch (error) {
    return fail(deps, 'todo_update_item', error);
  }
}

export function toggleItem(deps: TodoDeps, itemId: string, expectedUpdatedAt: string | null): TodoItem {
  try {
    const item = deps.repos.toggleTodoItem(deps.conn(), itemId, expectedUpdatedAt);
    emitTodoChanged(deps, 'toggle', [item.id]);
    return item;
  } catch (error) {
    return fail(deps, 'todo_toggle_item', error);
  }
}

export function deleteItem(deps: TodoDeps, itemId: string): null {
  try {
    deps.repos.deleteTodoItem(deps.conn(), itemId);
    emitTodoChanged(deps, 'delete', [itemId]);
    return null;
  } catch (error) {
    return fail(deps, 'todo_delete_item', error);
  }
}

export function reorderItems(deps: TodoDeps, input: ReorderItemsInput): null {
  try {
    deps.repos.reorderItems(deps.conn(), input.listId, input.itemIds, input.expectedUpdatedAt ?? null);
    emitTodoChanged(deps, 'reorder', [input.listId]);
    return null;
  } catch (error) {
    return fail(deps, 'todo_reorder_items', error);
  }
}

export function moveItem(deps: TodoDeps, input: MoveTodoItemInput): TodoItem {
  try {
    const item = deps.repos.moveTodoItem(deps.conn(), input.itemId, input.targetListId);
    emitTodoChanged(deps, 'move', [item.id]);
    return item;
  } catch (error) {
    return fail(deps, 'todo_move_item', error);
  }
}

export function listToday(
  deps: TodoDeps,
  includeCompleted: boolean,
  limit: number | null,
  offset: number | null,
): TodoItem[] {
  try {
    return deps.repos.listTodayItems(deps.conn(), includeCompleted, limit, offset);
  } catch (error) {
    return fail(deps, 'todo_list_today', error);
  }
}

export function listOverdue(
  deps: TodoDeps,
  includeCompleted: boolean,
  limit: number | null,
  offset: number | null,
): TodoItem[] {
  try {
    return deps.repos.listOverdueItems(deps.conn(), includeCompleted, limit, offset);
  } catch (error) {
    return fail(deps, 'todo_list_overdue', error);
  }
}

export function listUpcoming(deps: TodoDeps, days: number, includeCompleted: boolean): TodoItem[] {
  try {
    return deps.repos.listUpcomingItems(deps.conn(), days, includeCompleted);
  } catch (error) {
    return fail(deps, 'todo_list_upcoming', error);
  }
}

export function listReminders(deps: TodoDeps): TodoItem[] {
  try {
    return deps.repos.listReminderItems(deps.conn());
  } catch (error) {
    return fail(deps, 'todo_list_reminders', error);
  }
}

export function listAllPending(deps: TodoDeps): TodoItem[] {
  try {
    return deps.repos.listAllPendingItems(deps.conn());
  } catch (error) {
    return fail(deps, 'todo_list_all_pending', error);
  }
}

export function listCompleted(deps: TodoDeps, listId: string | null): TodoItem[] {
  try {
    return deps.repos.listCompletedItems(deps.conn(), listId);
  } catch (error) {
    return fail(deps, 'todo_list_completed', error);
  }
}

export function search(deps: TodoDeps, query: string, limit: number | null, offset: number | null): TodoItem[] {
  try {
    const [items] = deps.repos.searchItemsPaginated(deps.conn(), query, limit ?? 50, offset ?? 0);
    return items;
  } catch (error) {
    return fail(deps, 'todo_search', error);
  }
}

export function getActiveSummary(deps: TodoDeps): ReturnType<TodoRepository['getActiveTodoSummary']> {
  try {
    return deps.repos.getActiveTodoSummary(deps.conn());
  } catch (error) {
    return fail(deps, 'todo_get_active_summary', error);
  }
}

export function countsSnapshot(deps: TodoDeps): ReturnType<TodoRepository['countsSnapshot']> {
  try {
    return deps.repos.countsSnapshot(deps.conn());
  } catch (error) {
    return fail(deps, 'todo_counts_snapshot', error);
  }
}

export function batchComplete(deps: TodoDeps, itemIds: readonly string[]): TodoBatchItemsResult {
  try {
    const [result, eventIds] = deps.repos.batchCompleteItems(deps.conn(), itemIds);
    if (eventIds.length > 0) emitTodoChanged(deps, 'batch_complete', eventIds);
    return result;
  } catch (error) {
    return fail(deps, 'todo_batch_complete', error);
  }
}

export function batchReschedule(
  deps: TodoDeps,
  itemIds: readonly string[],
  dueDate: string | null,
  dueTime: string | null,
): TodoBatchItemsResult {
  try {
    const result = deps.repos.batchRescheduleItems(deps.conn(), itemIds, dueDate, dueTime);
    if (result.items.length > 0) emitTodoChanged(deps, 'batch_reschedule', result.items.map(item => item.id));
    return result;
  } catch (error) {
    return fail(deps, 'todo_batch_reschedule', error);
  }
}

export function batchSetPriority(
  deps: TodoDeps,
  itemIds: readonly string[],
  priority: string,
): TodoBatchItemsResult {
  try {
    const result = deps.repos.batchSetPriorityItems(deps.conn(), itemIds, priority);
    if (result.items.length > 0) emitTodoChanged(deps, 'batch_set_priority', result.items.map(item => item.id));
    return result;
  } catch (error) {
    return fail(deps, 'todo_batch_set_priority', error);
  }
}

export function batchMove(
  deps: TodoDeps,
  itemIds: readonly string[],
  targetListId: string,
): TodoBatchItemsResult {
  try {
    const result = deps.repos.batchMoveItems(deps.conn(), itemIds, targetListId);
    if (result.items.length > 0) emitTodoChanged(deps, 'batch_move', result.items.map(item => item.id));
    return result;
  } catch (error) {
    return fail(deps, 'todo_batch_move', error);
  }
}

export function batchDelete(deps: TodoDeps, itemIds: readonly string[]): TodoBatchIdsResult {
  try {
    const result = deps.repos.batchDeleteItems(deps.conn(), itemIds);
    if (result.affectedIds.length > 0) emitTodoChanged(deps, 'batch_delete', result.affectedIds);
    return result;
  } catch (error) {
    return fail(deps, 'todo_batch_delete', error);
  }
}

export function batchRestore(deps: TodoDeps, itemIds: readonly string[]): TodoBatchItemsResult {
  try {
    const result = deps.repos.batchRestoreItems(deps.conn(), itemIds);
    if (result.items.length > 0) emitTodoChanged(deps, 'batch_restore', result.items.map(item => item.id));
    return result;
  } catch (error) {
    return fail(deps, 'todo_batch_restore', error);
  }
}

export function batchPurge(deps: TodoDeps, itemIds: readonly string[]): TodoBatchIdsResult {
  try {
    const result = deps.repos.batchPurgeItems(deps.conn(), itemIds);
    if (result.affectedIds.length > 0) emitTodoChanged(deps, 'batch_purge', result.affectedIds);
    return result;
  } catch (error) {
    return fail(deps, 'todo_batch_purge', error);
  }
}

export function trashCounts(deps: TodoDeps): ReturnType<TodoRepository['trashCounts']> {
  try {
    return deps.repos.trashCounts(deps.conn());
  } catch (error) {
    return fail(deps, 'todo_trash_counts', error);
  }
}

export function statsOverview(deps: TodoDeps, days: number | null): ReturnType<TodoRepository['statsOverview']> {
  try {
    return deps.repos.statsOverview(deps.conn(), days ?? 30);
  } catch (error) {
    return fail(deps, 'todo_stats_overview', error);
  }
}

export function listAllTags(deps: TodoDeps): ReturnType<TodoRepository['listAllTags']> {
  try {
    return deps.repos.listAllTags(deps.conn());
  } catch (error) {
    return fail(deps, 'todo_list_all_tags', error);
  }
}

export function listItemsWithStats(
  deps: TodoDeps,
  listId: string,
  includeCompleted: boolean,
  limit: number | null,
  offset: number | null,
): TodoItemWithChildStats[] {
  try {
    return deps.repos.listItemsWithChildStats(deps.conn(), listId, includeCompleted, limit, offset);
  } catch (error) {
    return fail(deps, 'todo_list_items_with_stats', error);
  }
}

/** todo_handlers::parse_breakdown_titles */
export function parseBreakdownTitles(raw: string): string[] {
  const trimmed = rustTrim(raw);
  let cleaned = trimmed;
  if (trimmed.startsWith('```')) {
    let value = trimmed;
    for (const prefix of ['```json', '```JSON', '```']) {
      while (value.startsWith(prefix)) value = value.slice(prefix.length);
    }
    while (value.endsWith('```')) value = value.slice(0, -3);
    cleaned = rustTrim(value);
  }

  let candidate = cleaned;
  if (!isJsonParseable(cleaned)) {
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    candidate = cleaned.slice(start, end + 1);
  }

  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];

  const titles: string[] = [];
  for (const entry of value) {
    let text: string | undefined;
    if (typeof entry === 'string') text = entry;
    else if (typeof entry === 'object' && entry !== null && 'title' in entry) {
      const title = (entry as { title?: unknown }).title;
      if (typeof title === 'string') text = title;
    }
    if (text === undefined) continue;
    const title = rustTrim(text);
    if (title === '') continue;
    const chars = Array.from(title);
    titles.push(chars.length > 60 ? chars.slice(0, 60).join('') : title);
    if (titles.length === 8) break;
  }
  return titles;
}

function isJsonParseable(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * todo_ai_breakdown: 调工具模型拆解任务并在一个 SAVEPOINT 内落库。
 * LLM 接口来自 L02（见 llm-needs.ts），失败时映射为 INTERNAL_ERROR，保持 Rust 文案。
 */
export async function aiBreakdown(deps: TodoDeps, itemId: string): Promise<TodoItem[]> {
  let item: TodoItem | null;
  let existing: string[];
  try {
    item = deps.repos.getTodoItem(deps.conn(), itemId);
    if (item === null) {
      throw new CommandError(envelopeCommandError(deps.log, 'todo_ai_breakdown', {
        code: 'VFS_NOT_FOUND',
        message: `ITEM_NOT_FOUND: todo:${itemId}`,
        data: { resourceType: 'todo', id: itemId },
      }));
    }
    if (item.parentId != null) {
      return failCustom(deps, 'todo_ai_breakdown', 'VFS_INVALID_OPERATION', '子任务不支持再次拆解');
    }
    const siblings = deps.repos.listItemsByList(deps.conn(), item.todoListId, false);
    existing = siblings
      .filter(candidate => candidate.parentId === itemId)
      .map(candidate => candidate.title);
  } catch (error) {
    if (error instanceof CommandError) throw error;
    return fail(deps, 'todo_ai_breakdown', error);
  }

  const prompt: string[] = [
    '你是任务规划助手。把下面的任务拆解为 3-6 个具体、可独立执行的子任务。\n' +
    '输出要求：只输出一个 JSON 字符串数组，例如 ["子任务一","子任务二"]。' +
    '不要 markdown 代码块，不要编号，不要任何解释文字。\n' +
    '每条不超过 30 字，语言与任务标题保持一致，按执行顺序排列。\n\n',
    `任务标题：${item.title}\n`,
  ];
  if (item.description != null && rustTrim(item.description) !== '') {
    prompt.push(`任务备注：${Array.from(item.description).slice(0, 500).join('')}\n`);
  }
  if (item.dueDate != null) prompt.push(`截止日期：${item.dueDate}\n`);
  if (existing.length > 0) prompt.push(`已有子任务（不要重复生成）：${existing.join('、')}\n`);

  if (deps.llm === undefined) {
    // L02 has not published callModel2RawPrompt yet; surface the same envelope shape as a
    // failed model call instead of inventing a result.
    return failCustom(deps, 'todo_ai_breakdown', 'INTERNAL_ERROR',
      'LLMManager.call_model2_raw_prompt is unavailable: llm@1 does not expose it');
  }
  let output: string;
  try {
    const result = await deps.llm.callModel2RawPrompt(prompt.join(''), null, { Other: 'todo_breakdown' });
    output = result.assistant_message;
  } catch (error) {
    return failCustom(deps, 'todo_ai_breakdown', 'INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
  }

  const titles = parseBreakdownTitles(output);
  if (titles.length === 0) {
    return failCustom(deps, 'todo_ai_breakdown', 'AI_EMPTY_RESULT', 'AI 未能生成有效的子任务，请重试');
  }

  try {
    const created = requireMaintenance(deps.maintenance).createTodoSubtasks(item.todoListId, itemId, titles);
    emitTodoChanged(deps, 'create', created.map(entry => entry.id));
    return created;
  } catch (error) {
    return fail(deps, 'todo_ai_breakdown', error);
  }
}

export type { CommandErrorEnvelope };
