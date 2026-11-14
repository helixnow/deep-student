import { defineQuery, type Row, type SqlExecutor, type SqlValue } from '../../../platform/storage/api.ts';
import {
  decodePersistedTodoSteps, encodePersistedTodoSteps, todoTimestamp, todoTimestampI64,
} from '../src/todo-persisted.ts';
import { setTodoList } from '../src/todo-store.ts';
import { todoIsAllDone, type TodoList, type TodoTimestamp } from '../src/todo.ts';

export interface PersistedTodoList {
  list: TodoList;
  messageId: string;
  variantId: string | null;
}
export interface TodoLoadLogger { info(message: string): void }
export interface TodoPersistLogger { debug(message: string): void }

// todo_executor.rs:235–241: one active list per session row; REPLACE keeps the original nine columns.
const persistList = defineQuery<readonly [string, string, string | null, string, string, string, number, bigint, bigint]>(`
        INSERT OR REPLACE INTO chat_v2_todo_lists
        (session_id, message_id, variant_id, todo_list_id, title, steps_json, is_all_done, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        `);

// todo_executor.rs:280–285: no extra ordering, joins or transaction; reuse the supplied connection.
const loadIncomplete = defineQuery<readonly [string]>(`SELECT todo_list_id, title, steps_json, created_at, updated_at, message_id, variant_id
        FROM chat_v2_todo_lists
        WHERE session_id = ?1 AND is_all_done = 0`, { options: { safeIntegers: true } });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function columnError(value: SqlValue | undefined, index: number, name: string): Error {
  const type = value == null ? 'Null' : typeof value === 'string' ? 'Text'
    : typeof value === 'bigint' ? 'Integer' : typeof value === 'number' ? 'Real' : 'Blob';
  return new Error(`Invalid column type ${type} at index: ${index}, name: ${name}`);
}

function text(row: Row, name: string, index: number): string {
  const value = row[name];
  if (typeof value !== 'string') throw columnError(value, index, name);
  return value;
}

function timestamp(row: Row, name: string, index: number): TodoTimestamp {
  const value = row[name];
  if (typeof value !== 'bigint') throw columnError(value, index, name);
  return todoTimestamp(value);
}

/**
 * todo_executor.rs:224–261: runs on the supplied connection only (no own connection/transaction) and
 * never touches the in-memory store; serialize and SQL failures keep their distinct Rust contexts.
 */
export function persistTodoListWithConn(
  conn: SqlExecutor, sessionId: string, messageId: string, variantId: string | null, list: TodoList,
  log?: TodoPersistLogger,
): void {
  let stepsJson: string;
  try { stepsJson = encodePersistedTodoSteps(list.steps); }
  catch (error) { throw new Error(`Failed to serialize steps: ${errorMessage(error)}`); }
  try {
    conn.run(persistList, [sessionId, messageId, variantId, list.id, list.title, stepsJson,
      todoIsAllDone(list) ? 1 : 0, todoTimestampI64(list.createdAt), todoTimestampI64(list.updatedAt)]);
  } catch (error) {
    throw new Error(`Failed to persist TodoList: ${errorMessage(error)}`);
  }
  log?.debug(`[TodoListExecutor] Persisted TodoList ${list.id} for session ${sessionId} (message: ${messageId})`);
}

/** todo_executor.rs:276–324: read unfinished row; no row is None, never a synthesized list. */
export function loadPersistedTodoListWithConn(
  conn: SqlExecutor, sessionId: string, log?: TodoLoadLogger,
): PersistedTodoList | null {
  let id: string;
  let title: string;
  let stepsJson: string;
  let createdAt: TodoTimestamp;
  let updatedAt: TodoTimestamp;
  let messageId: string;
  let variantId: string | null;
  try {
    const row = conn.get(loadIncomplete, [sessionId]);
    if (row === undefined) return null;
    // Rust obtains every SQL column in this order before attempting steps JSON deserialization.
    id = text(row, 'todo_list_id', 0);
    title = text(row, 'title', 1);
    stepsJson = text(row, 'steps_json', 2);
    createdAt = timestamp(row, 'created_at', 3);
    updatedAt = timestamp(row, 'updated_at', 4);
    messageId = text(row, 'message_id', 5);
    variantId = row.variant_id === null ? null : text(row, 'variant_id', 6);
  } catch (error) {
    throw new Error(`Failed to load TodoList: ${errorMessage(error)}`);
  }
  let steps;
  try { steps = decodePersistedTodoSteps(stepsJson); }
  catch (error) { throw new Error(`Failed to deserialize steps: ${errorMessage(error)}`); }
  const list: TodoList = { id, title, steps, createdAt, updatedAt };
  log?.info(`[TodoListExecutor] Loaded persisted TodoList ${list.id} for session ${sessionId} (message: ${messageId})`);
  return { list, messageId, variantId };
}

/** todo_executor.rs:339–349: no row/error must not clear or overwrite the existing in-memory list. */
export function restoreTodoListFromDbWithConn(
  conn: SqlExecutor, sessionId: string, log?: TodoLoadLogger,
): TodoList | null {
  const persisted = loadPersistedTodoListWithConn(conn, sessionId, log);
  if (persisted === null) return null;
  setTodoList(sessionId, persisted.list);
  return persisted.list;
}
