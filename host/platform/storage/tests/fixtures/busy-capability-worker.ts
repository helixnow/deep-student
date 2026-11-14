import { parentPort, threadId, workerData } from 'node:worker_threads';
import { StorageError } from '../../api.ts';
import { openStartupDatabase } from '../../node.ts';

const port = parentPort!;
const db = openStartupDatabase(workerData.path, {
  label: 'contender',
  profile: { busyTimeoutMs: 50, synchronous: 'FULL' },
});

// This reports a completed SQLite call, never entry into a busy handler.
port.on('message', (command: 'attempt' | 'read' | 'close') => {
  try {
    if (command === 'close') {
      db.close();
      port.postMessage({ kind: 'closed' });
      port.close();
      return;
    }
    if (command === 'attempt') {
      const started = performance.now();
      try {
        db.begin('immediate');
        port.postMessage({ kind: 'acquired', inTransaction: db.inTransaction });
      } catch (error) {
        if (!(error instanceof StorageError)) throw error;
        port.postMessage({
          kind: 'returned-busy', code: error.code, sqliteCode: error.sqliteCode,
          phase: error.phase, inTransaction: db.inTransaction,
          elapsedMs: performance.now() - started, threadId,
        });
      }
      return;
    }
    db.begin('immediate');
    try {
      const value = db.pluck<number>('SELECT value FROM lock_probe');
      db.commit();
      port.postMessage({ kind: 'read', value, inTransaction: db.inTransaction });
    } finally {
      db.rollback();
    }
  } catch (error) {
    db.close();
    throw error;
  }
});
port.postMessage({ kind: 'ready', threadId });
