/**
 * notify 类自动化的待办投递（Rust `chat_v2/automations.rs:2508–2612`
 * `create_automation_todo`）。待办本身由 L11 `TodoRepository` 创建；本模块只负责
 * 回执表 `automation_todo_deliveries` 的幂等写入，SQL 留在本 lane 的 repository/。
 */
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { civilTime, toRfc3339, ymd } from '../../../platform/time/index.ts';

/** L11 `TodoRepository` 中本模块消费的最小面。 */
export interface AutomationTodoRepository {
  ensureDefaultInbox(conn: SqlExecutor): { id: string };
  createTodoItem(conn: SqlExecutor, params: {
    todoListId: string;
    title: string;
    description?: string | null;
    priority?: string;
    dueDate?: string | null;
    dueTime?: string | null;
    reminder?: string | null;
    tags?: readonly string[] | null;
    parentId?: string | null;
    attachments?: readonly string[] | null;
    repeatJson?: string | null;
  }): { id: string };
}

export interface AutomationTodoLogger {
  warn(message: string): void;
}

export interface AutomationTodoDeps {
  vfs: DatabaseHandle;
  todos: AutomationTodoRepository | undefined;
  log: AutomationTodoLogger;
  /** 提交成功后广播（Rust `app_handle.emit("todo://changed", …)`）。 */
  emit?: (event: string, payload: { source: string; action: string }) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localReminder(nowMs: number): string {
  const t = civilTime(BigInt(nowMs) * 1_000_000n, true);
  return `${ymd(t)}T${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

/**
 * 为一次 notify run 创建收件箱待办并写投递回执；返回是否已交付。
 * 同一 run 重复调用不会创建第二条待办（回执表以 run_id 为主键）。
 */
export function deliverAutomationTodo(
  deps: AutomationTodoDeps, runId: string, name: string, prompt: string, nowMs: number,
): boolean {
  if (deps.todos === undefined) {
    deps.log.warn('[AutomationScheduler] VFS todo repository is not available; automation todo cannot be created');
    return false;
  }
  const todos = deps.todos;
  let inbox: { id: string };
  try {
    inbox = todos.ensureDefaultInbox(deps.vfs);
  } catch (error) {
    deps.log.warn(`[AutomationScheduler] ensure_default_inbox failed: ${messageOf(error)}`);
    return false;
  }
  const reminder = localReminder(nowMs);
  // Rust returns before `tx.commit()` on every step failure, so Drop rolls the
  // transaction back (including an already-created todo item). Throwing this
  // marker out of the callback gives the same rollback after the step's own warn.
  const rollback = new Error('automation todo delivery rolled back');
  let entered = false;
  let bodyDone = false;
  let created = false;
  let delivered: boolean;
  try {
    delivered = deps.vfs.transaction((tx) => {
      entered = true;
      let existing: string | undefined;
      try {
        existing = tx.pluck<string>(
          'SELECT todo_item_id FROM automation_todo_deliveries WHERE run_id = ?1', [runId]);
      } catch (error) {
        deps.log.warn(`[AutomationScheduler] read todo delivery receipt failed: ${messageOf(error)}`);
        throw rollback;
      }
      if (existing !== undefined && existing !== null) {
        bodyDone = true;
        return true;
      }
      let itemId: string;
      try {
        itemId = todos.createTodoItem(tx, {
          todoListId: inbox.id,
          title: name,
          description: prompt,
          priority: 'none',
          dueDate: null,
          dueTime: null,
          reminder,
          tags: null,
          parentId: null,
          attachments: null,
          repeatJson: null,
        }).id;
      } catch (error) {
        deps.log.warn(`[AutomationScheduler] create_todo_item failed: ${messageOf(error)}`);
        throw rollback;
      }
      try {
        tx.run(`INSERT INTO automation_todo_deliveries (run_id, todo_item_id, created_at)
          VALUES (?1, ?2, ?3)`,
        [runId, itemId, toRfc3339(BigInt(nowMs) * 1_000_000n)]);
      } catch (error) {
        deps.log.warn(`[AutomationScheduler] persist todo delivery receipt failed: ${messageOf(error)}`);
        throw rollback;
      }
      created = true;
      bodyDone = true;
      return true;
    }, { behavior: 'immediate' });
  } catch (error) {
    if (error === rollback) return false;
    const step = !entered ? 'begin todo delivery failed' : bodyDone ? 'commit todo delivery failed'
      : 'todo delivery transaction failed';
    deps.log.warn(`[AutomationScheduler] ${step}: ${messageOf(error)}`);
    return false;
  }
  if (delivered && created && deps.emit !== undefined) {
    try { deps.emit('todo://changed', { source: 'automation', action: 'create_item' }); }
    catch (error) {
      deps.log.warn(`[AutomationScheduler] emit todo://changed failed: ${messageOf(error)}`);
    }
  }
  return delivered;
}
