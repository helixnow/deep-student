/**
 * Database worker entry. Loads a lane-owned task module (it must export
 * `workerTasks`), opens a fresh storage service per task, and returns only data.
 * No SQL text or Sqlite handle crosses the thread boundary.
 */
import { parentPort, threadId, workerData } from 'node:worker_threads';
import type { DatabaseName } from './api.ts';
import { createStorageService } from './service.ts';
import { serializeError, type DatabaseWorkerTasks, type MultiDatabaseWorkerTasks, type WorkerLogMessage, type WorkerReply, type WorkerRequest } from './worker-pool.ts';
import { assertNoDatabaseHandles, WorkerDatabases } from './worker-databases.ts';

interface WorkerData {
  readonly tasksModule: string;
  readonly baseDir: string;
  readonly dataLocalDir?: string;
  readonly migrationsDir?: string;
}

const data = workerData as WorkerData;
if (parentPort === null) throw new Error('database worker must run inside worker_threads');

async function loadTasks(): Promise<{ single?: DatabaseWorkerTasks; multi?: MultiDatabaseWorkerTasks }> {
  type TaskModule = { workerTasks?: DatabaseWorkerTasks; multiDatabaseWorkerTasks?: MultiDatabaseWorkerTasks };
  const module = await import(data.tasksModule) as TaskModule & { default?: TaskModule };
  const single = module.workerTasks ?? module.default?.workerTasks;
  const multi = module.multiDatabaseWorkerTasks ?? module.default?.multiDatabaseWorkerTasks;
  if (single === undefined && multi === undefined) {
    throw new Error(`worker task module ${data.tasksModule} must export workerTasks or multiDatabaseWorkerTasks`);
  }
  return { single, multi };
}

const tasks = await loadTasks();

function reply(message: WorkerReply): void {
  try {
    parentPort!.postMessage(message);
  } catch (error) {
    // A non-cloneable task result must fail the task instead of hanging the pool.
    parentPort!.postMessage({
      id: message.id,
      ok: false,
      error: serializeError(error),
      threadId,
    } satisfies WorkerReply);
  }
}

parentPort.on('message', (request: WorkerRequest) => {
  void (async () => {
    if ('databases' in request) {
      const task = tasks.multi?.[request.task];
      if (task === undefined) throw new Error(`unknown multi-database worker task: ${request.task}`);
      const databases = new WorkerDatabases(request.activeDir, request.databases);
      let value: unknown;
      try {
        value = await task({
          payload: request.payload, threadId, activeDir: request.activeDir,
          log: (target, level, message) => parentPort!.postMessage({ kind: 'log', target, level, message } satisfies WorkerLogMessage),
          openExisting: (name, options) => databases.openExisting(name, options),
          openFile: (filePath, options) => databases.openFile(filePath, options),
          close: (db) => databases.close(db),
        });
      } finally { databases.dispose(); }
      assertNoDatabaseHandles(value);
      reply({ id: request.id, ok: true, value, threadId });
      return;
    }
    const task = tasks.single?.[request.task];
    if (task === undefined) throw new Error(`unknown worker task: ${request.task}`);
    const storage = createStorageService({
      baseDir: data.baseDir,
      ...(data.dataLocalDir === undefined ? {} : { dataLocalDir: data.dataLocalDir }),
      ...(data.migrationsDir === undefined ? {} : { migrationsDir: data.migrationsDir }),
    });
    try {
      const db = storage.database(request.database as DatabaseName);
      const value = await task({ db, payload: request.payload, threadId });
      reply({ id: request.id, ok: true, value, threadId });
    } finally {
      storage.dispose();
    }
  })().catch((error: unknown) => {
    reply({ id: request.id, ok: false, error: serializeError(error), threadId });
  });
});
