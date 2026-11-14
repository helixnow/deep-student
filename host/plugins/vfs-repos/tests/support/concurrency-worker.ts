/**
 * Independent-connection concurrency worker.
 *
 * Each worker opens its own F3 handle to the same vfs.db file and calls the
 * production repository code. The barrier is a SharedArrayBuffer gate so the
 * main thread releases all workers at the same time, reproducing the Rust
 * tests' `thread::spawn` / `Barrier` race instead of serializing calls.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { SqliteDatabase } from '../../../../platform/storage/database.ts';
import { PROFILES } from '../../../../platform/storage/profiles.ts';
import { QuestionRepo } from '../../repository/questions.ts';
import { ResourceRepo } from '../../repository/resources.ts';

interface JobBase {
  dbPath: string;
}
export type ConcurrencyJob =
  | (JobBase & { mode: 'resource'; content: string; index: number })
  | (JobBase & { mode: 'question'; questionId: string; expected: string; content: string });

const data = workerData as ConcurrencyJob & { gate: SharedArrayBuffer };
const db = new SqliteDatabase({
  name: `vfs-concurrency-${data.mode}`,
  path: data.dbPath,
  profile: PROFILES.vfs,
});

try {
  parentPort?.postMessage({ type: 'ready' });
  Atomics.wait(new Int32Array(data.gate), 0, 0);

  if (data.mode === 'resource') {
    const result = new ResourceRepo().createOrReuse(
      db, 'note', data.content, `note_${data.index}`, 'notes', null);
    parentPort?.postMessage({
      type: 'done',
      ok: true,
      value: {
        resourceId: result.resourceId,
        hash: result.hash,
        isNew: result.isNew,
      },
    });
  } else {
    const updated = new QuestionRepo().updateQuestion(db, data.questionId, {
      content: data.content,
      expected_updated_at: data.expected,
    });
    parentPort?.postMessage({ type: 'done', ok: true, value: updated.content });
  }
} catch (error) {
  parentPort?.postMessage({
    type: 'done',
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  });
} finally {
  db.close();
}
