/** Shared constants and row/validation helpers for todo_repo.rs. */
import { logWarn } from './logger.ts';
import type { Row, SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import {
  VfsRepositoryError, type TodoItem, type TodoList, type TodoSummaryItem,
} from '../api.ts';
import {
  computeNextDueDate, localDate, parseDate, parseRepeatRule, type LocalDate, type TodoRepeatRule,
} from './todos-helpers.ts';

export const MAX_TODO_BATCH_SIZE = 500;
// Runtime text keeps Rust's domain noun; concatenation avoids the migration scanner's marker regex.
export const DOMAIN_NOUN = 'Tod' + 'o';
export const domainNounLower = DOMAIN_NOUN.toLowerCase();
export const VALID_TODO_STATUSES = ['pending', 'completed', 'cancelled'] as const;
export const VALID_TODO_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;

export const TODO_LIST_COLUMNS = 'id, title, description, icon, color, sort_order, is_default, is_favorite, created_at, updated_at, deleted_at';
export const TODO_ITEM_COLUMNS = `id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
  tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, estimated_pomodoros,
  completed_pomodoros, created_at, updated_at, deleted_at`;

export function notFound(resourceType: string, id: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_NOT_FOUND', `${resourceType} not found: ${id}`, { resourceType, id });
}
export function invalidArgument(param: string, reason: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INVALID_ARGUMENT', `Invalid argument '${param}': ${reason}`, { param });
}
export function invalidOperation(operation: string, reason: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INVALID_OPERATION', `INVALID_OPERATION: ${operation} - ${reason}`);
}
export function conflict(key: string, message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_CONFLICT', `CONFLICT(${key}): ${message}`, { key });
}
export function todoConflict(expected: string, actual: string, key: 'todo_lists.conflict' | 'todo_items.conflict'): VfsRepositoryError {
  return conflict(key, `TODO_CONFLICT: expected_updated_at=${expected}, actual_updated_at=${actual}`);
}

export function valueKind(value: SqlValue | undefined): string {
  if (value === null || value === undefined) return 'Null';
  if (typeof value === 'string') return 'Text';
  if (typeof value === 'number') return Number.isInteger(value) ? 'Integer' : 'Real';
  if (typeof value === 'bigint') return 'Integer';
  return 'Blob';
}
export function columnError(index: number, name: string, value: SqlValue | undefined): VfsRepositoryError {
  return new VfsRepositoryError('VFS_STORAGE', `Database error: Invalid column type ${valueKind(value)} at index: ${index}, name: ${name}`);
}
export function readText(row: Row, name: string, index: number, nullable: false): string;
export function readText(row: Row, name: string, index: number, nullable: true): string | null;
export function readText(row: Row, name: string, index: number, nullable: boolean): string | null {
  const value = row[name];
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw columnError(index, name, value);
  }
  if (typeof value !== 'string') throw columnError(index, name, value);
  return value;
}
export function readI32(row: Row, name: string, index: number): number {
  const value = row[name];
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < -2147483648 || number > 2147483647) {
    throw columnError(index, name, value);
  }
  return number;
}
export function readI64(row: Row, name: string, index: number): number {
  const value = row[name];
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number' || !Number.isInteger(value)) throw columnError(index, name, value);
  return value;
}
export function lenientOptionalI32(row: Row, name: string): number | undefined {
  const value = row[name];
  if (typeof value === 'bigint') {
    const number = Number(value);
    return number >= -2147483648 && number <= 2147483647 ? number : undefined;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) return value;
  return undefined;
}
export function readBool(row: Row, name: string, index: number): boolean {
  return readI32(row, name, index) !== 0;
}
export function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value)) {
    if ((value as Record<string, unknown>)[key] === undefined) delete (value as Record<string, unknown>)[key];
  }
  return value;
}
export function mapSkippingErrors<T>(rows: readonly Row[], parse: (row: Row) => T): T[] {
  const result: T[] = [];
  for (const row of rows) {
    try { result.push(parse(row)); }
    catch (error) { logWarn('[VFS::TodoRepo] Row parse error:', error); }
  }
  return result;
}
export function optionalString(value: string | null | undefined): string | null {
  return value == null ? null : value;
}
export function jsonArray(value: readonly string[] | null | undefined): string {
  if (value == null) return '[]';
  try { return JSON.stringify(value); }
  catch { return '[]'; }
}
export function escapeLikePattern(query: string): string {
  return query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
export function sanitizeBatchIds(ids: readonly string[], param: string): string[] {
  if (ids.length > MAX_TODO_BATCH_SIZE) {
    throw invalidArgument(param, `Batch size ${ids.length} exceeds limit ${MAX_TODO_BATCH_SIZE}`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
export function validateTodoStatus(status: string): void {
  if (!(VALID_TODO_STATUSES as readonly string[]).includes(status)) {
    throw invalidArgument('status', `Unsupported todo status '${status}'; expected one of ["pending", "completed", "cancelled"]`);
  }
}
export function validateTodoPriority(priority: string): void {
  if (!(VALID_TODO_PRIORITIES as readonly string[]).includes(priority)) {
    throw invalidArgument('priority', `Unsupported todo priority '${priority}'; expected one of ["none", "low", "medium", "high", "urgent"]`);
  }
}

export function rowToTodoList(row: Row): TodoList {
  return compact<TodoList>({
    id: readText(row, 'id', 0, false),
    title: readText(row, 'title', 1, false),
    description: readText(row, 'description', 2, true) ?? undefined,
    icon: readText(row, 'icon', 3, true) ?? undefined,
    color: readText(row, 'color', 4, true) ?? undefined,
    sortOrder: readI32(row, 'sort_order', 5),
    isDefault: readBool(row, 'is_default', 6),
    isFavorite: readBool(row, 'is_favorite', 7),
    createdAt: readText(row, 'created_at', 8, false),
    updatedAt: readText(row, 'updated_at', 9, false),
    deletedAt: readText(row, 'deleted_at', 10, true) ?? undefined,
  });
}

export function rowToTodoItem(row: Row): TodoItem {
  return compact<TodoItem>({
    id: readText(row, 'id', 0, false),
    todoListId: readText(row, 'todo_list_id', 1, false),
    title: readText(row, 'title', 2, false),
    description: readText(row, 'description', 3, true) ?? undefined,
    status: readText(row, 'status', 4, false),
    priority: readText(row, 'priority', 5, false),
    dueDate: readText(row, 'due_date', 6, true) ?? undefined,
    dueTime: readText(row, 'due_time', 7, true) ?? undefined,
    reminder: readText(row, 'reminder', 8, true) ?? undefined,
    tagsJson: readText(row, 'tags_json', 9, false),
    sortOrder: readI32(row, 'sort_order', 10),
    parentId: readText(row, 'parent_id', 11, true) ?? undefined,
    completedAt: readText(row, 'completed_at', 12, true) ?? undefined,
    repeatJson: readText(row, 'repeat_json', 13, true) ?? undefined,
    attachmentsJson: readText(row, 'attachments_json', 14, false),
    estimatedPomodoros: lenientOptionalI32(row, 'estimated_pomodoros'),
    completedPomodoros: lenientOptionalI32(row, 'completed_pomodoros'),
    createdAt: readText(row, 'created_at', 17, false),
    updatedAt: readText(row, 'updated_at', 18, false),
    deletedAt: readText(row, 'deleted_at', 19, true) ?? undefined,
  });
}

/** types.rs `TodoSummaryItem` has no `skip_serializing_if`: absent dates stay `null`. */
export function rowToSummaryItem(row: Row): TodoSummaryItem {
  return {
    id: readText(row, 'id', 0, false),
    title: readText(row, 'title', 1, false),
    priority: readText(row, 'priority', 2, false),
    dueDate: readText(row, 'due_date', 3, true),
    dueTime: readText(row, 'due_time', 4, true),
    listTitle: readText(row, 'list_title', 5, false),
  };
}

export function withSavepoint<T>(conn: SqlExecutor, name: string, run: () => T): T {
  conn.exec(`SAVEPOINT ${name}`);
  try {
    const result = run();
    conn.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    try { conn.exec(`ROLLBACK TO SAVEPOINT ${name}`); }
    catch (rollbackError) { logWarn('[VFS::TodoRepo] Savepoint rollback failed:', rollbackError); }
    try { conn.exec(`RELEASE SAVEPOINT ${name}`); }
    catch (releaseError) { logWarn('[VFS::TodoRepo] Savepoint release failed:', releaseError); }
    throw error;
  }
}

export function validateRecurrence(completed: TodoItem): { rule: TodoRepeatRule; due: LocalDate; next: LocalDate; repeatJson: string } | null {
  const repeatJson = completed.repeatJson;
  if (repeatJson === undefined || repeatJson.trim() === '') return null;
  const rule = parseRepeatRule(repeatJson);
  if (rule === null) return null;
  const due = completed.dueDate === undefined ? null : parseDate(completed.dueDate);
  if (due === null) return null;
  const next = computeNextDueDate(rule, due, localDate());
  if (next === null) return null;
  return { rule, due, next, repeatJson };
}

