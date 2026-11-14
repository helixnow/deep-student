/** Runs the real F3 vfs migration off the test thread and reports the migrated file. */
import { parentPort, workerData } from 'node:worker_threads';
import { createStorageService } from '../../../platform/storage/service.ts';

const { dir } = workerData as { dir: string };
const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
let message: { ok: true; path: string } | { ok: false; error: string };
try {
  await storage.migrations.migrateSingle('vfs');
  message = { ok: true, path: storage.pathOf('vfs') };
} catch (error) {
  message = { ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) };
} finally {
  // Close before reporting so the parent copies a checkpointed file.
  storage.dispose();
}
parentPort?.postMessage(message);
