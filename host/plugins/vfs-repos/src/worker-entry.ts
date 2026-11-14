/**
 * R13-02: worker-thread repository execution entry.
 *
 * The worker opens its own F3 `DatabaseHandle` to the vfs database file; no
 * handle, Cordis service, or better-sqlite3 connection is transferred from the
 * main thread. Repository calls and their internal transactions therefore run
 * on this thread's event loop, and errors are serialized back verbatim.
 */
import { parentPort, threadId, workerData } from 'node:worker_threads';
import { format as formatLog } from 'node:util';
import { SqliteDatabase } from '../../../platform/storage/database.ts';
import { PROFILES } from '../../../platform/storage/profiles.ts';
import { EssayRepo } from '../repository/essays.ts';
import { ExamRepo } from '../repository/exams.ts';
import { FolderRepo } from '../repository/folders.ts';
import { PomodoroRepo } from '../repository/pomodoros.ts';
import { TodoRepo } from '../repository/todos.ts';
import { TranslationRepo } from '../repository/translations.ts';
import { setRepositoryLogger } from '../repository/logger.ts';
import { VfsRepositoryError, type VfsWorkerSearchType } from '../api.ts';
import { detachNumberAtoms } from './worker-atoms.ts';

interface WorkerData {
  dbPath: string;
  deviceId: string;
}

interface Request {
  id: number;
  repository: 'todo' | 'pomodoro' | 'folder' | 'search';
  method: string;
  args: readonly unknown[];
}

interface ErrorPayload {
  name: string;
  message: string;
  code?: string;
  data?: unknown;
  stack?: string;
}

const data = workerData as WorkerData;
const db = new SqliteDatabase({ name: 'vfs-worker', path: data.dbPath, profile: PROFILES.vfs });

/** Rust `warn!`/`error!` etc. are forwarded to the main-thread plugin logger. */
function emitLog(level: 'error' | 'warn' | 'info' | 'debug', format: unknown, params: unknown[]): void {
  parentPort?.postMessage({ type: 'log', level, message: formatLog(format, ...params) });
}

setRepositoryLogger({
  error: (format, ...params) => emitLog('error', format, params),
  warn: (format, ...params) => emitLog('warn', format, params),
  info: (format, ...params) => emitLog('info', format, params),
  debug: (format, ...params) => emitLog('debug', format, params),
});

const todos = new TodoRepo();
const pomodoros = new PomodoroRepo();
const exams = new ExamRepo();
const translations = new TranslationRepo(data.deviceId);
const essays = new EssayRepo();
// Cascade adapters (notes are L10's main-thread service) are intentionally absent:
// only folder operations that never reach the cascade are callable here.
const folders = new FolderRepo();
const FOLDER_OPERATIONS: ReadonlySet<string> = new Set(['createFolder', 'getFolder', 'renameFolderIfVersion']);

function errorPayload(error: unknown): ErrorPayload {
  const payload: ErrorPayload = {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  };
  if (error instanceof VfsRepositoryError) {
    payload.code = error.code;
    payload.data = error.data;
  }
  if (error instanceof Error && error.stack !== undefined) payload.stack = error.stack;
  return payload;
}

/** Only connection-bound repository methods are callable; private/state fields are not. */
function callRepository(repository: 'todo' | 'pomodoro' | 'folder', method: string, args: readonly unknown[]): unknown {
  const instance: TodoRepo | PomodoroRepo | FolderRepo = repository === 'todo' ? todos
    : repository === 'pomodoro' ? pomodoros : folders;
  const prototype = repository === 'todo' ? TodoRepo.prototype
    : repository === 'pomodoro' ? PomodoroRepo.prototype : FolderRepo.prototype;
  if (!Object.prototype.hasOwnProperty.call(prototype, method) || method.startsWith('_')
    || (repository === 'folder' && !FOLDER_OPERATIONS.has(method))) {
    throw new Error(`unsupported ${repository} operation: ${method}`);
  }
  const fn = (instance as unknown as Record<string, ((...values: unknown[]) => unknown) | undefined>)[method];
  if (fn === undefined) throw new Error(`unsupported ${repository} operation: ${method}`);
  return fn.call(instance, db, ...args);
}

function search(type: VfsWorkerSearchType, query: string, limit: number, offset: number): unknown {
  if (type === 'exam') {
    return offset === 0 ? exams.searchExamSheets(db, query, limit) : exams.listExamSheets(db, query, limit, offset);
  }
  if (type === 'translation') {
    return offset === 0 ? translations.searchTranslations(db, query, limit)
      : translations.listTranslations(db, query, limit, offset);
  }
  if (type === 'essay') {
    return offset === 0 ? essays.searchEssays(db, query, limit)
      : essays.listEssays(db, query, limit, offset);
  }
  throw new Error(`unsupported resource search type: ${String(type)}`);
}

parentPort?.on('message', (request: Request) => {
  try {
    const value = request.repository === 'search'
      ? search(request.method as VfsWorkerSearchType, request.args[0] as string,
        request.args[1] as number, (request.args[2] as number | undefined) ?? 0)
      : callRepository(request.repository, request.method, request.args);
    const detached = detachNumberAtoms(value);
    parentPort?.postMessage({ type: 'response', id: request.id, ok: true, value: detached.value, atoms: detached.atoms });
  } catch (error) {
    parentPort?.postMessage({ type: 'response', id: request.id, ok: false, error: errorPayload(error) });
  }
});

parentPort?.on('close', () => db.close());
parentPort?.postMessage({ type: 'ready', threadId });
