// cmd/notes.rs notes_db_vacuum / notes_list_tags run inside `spawn_blocking`.
// F3 `createDatabaseWorkerPool` loads this module in a worker thread; each task
// gets its own DatabaseHandle and returns data only. Log lines are collected and
// replayed by the main thread into `ctx.logger('notes')`.
import type {
  DatabaseWorkerTaskContext, DatabaseWorkerTasks, SqlExecutor,
} from '../../../platform/storage/api.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { AppError } from '../../../platform/errors/api.ts';
import { configureNotesLogger } from '../repository/log.ts';
import { listTags, vacuum } from './note-commands.ts';

export type NotesWorkerLevel = 'error' | 'warn' | 'info' | 'debug';

export type NotesWorkerReply =
  | { readonly ok: true; readonly value: unknown; readonly logs: Array<[NotesWorkerLevel, string]> }
  | { readonly ok: false; readonly error: AppError; readonly logs: Array<[NotesWorkerLevel, string]> };

function run(work: (ctx: DatabaseWorkerTaskContext) => unknown) {
  return (ctx: DatabaseWorkerTaskContext): NotesWorkerReply => {
    const logs: Array<[NotesWorkerLevel, string]> = [];
    configureNotesLogger({
      error: (message) => logs.push(['error', message]),
      warn: (message) => logs.push(['warn', message]),
      info: (message) => logs.push(['info', message]),
      debug: (message) => logs.push(['debug', message]),
    });
    try {
      return { ok: true, value: work(ctx), logs };
    } catch (error) {
      if (error instanceof CommandError) return { ok: false, error: error.value as AppError, logs };
      throw error;
    } finally {
      configureNotesLogger(null);
    }
  };
}

export const NOTES_WORKER_TASKS = ['vacuum', 'listTags'] as const;

export type NotesWorkerTask = (typeof NOTES_WORKER_TASKS)[number];

export const workerTasks: DatabaseWorkerTasks = {
  vacuum: run(({ db }) => vacuum(db)),
  listTags: run(({ db }) => listTags(db)),
};

/**
 * 没有 worker 线程时（移动端端口返回 null）在调用线程上执行同一份任务实现。
 * 任务本身已经抛出 `CommandError`，与 worker 路径的 `reply.error` 重抛等价。
 */
export function runNotesTaskInline<T>(task: NotesWorkerTask, conn: SqlExecutor): T {
  switch (task) {
    case 'vacuum': return vacuum(conn) as T;
    case 'listTags': return listTags(conn) as T;
  }
}
