import { parentPort, threadId, workerData } from 'node:worker_threads';
import { StorageError } from '../../api.ts';
import { openStartupDatabase } from '../../node.ts';
import { createTestHost } from '../../../../kernel/testing.ts';
import nativePlugin from '../../../native/index.ts';

// Contender on its own StartupDatabase (default PROFILES.sync_state, like Rust
// `Connection::open`). Control word: 0 = keep waiting, 1 = release (true), 2 = cancel (false).
const port = parentPort!;
const control = new Int32Array(workerData.control as SharedArrayBuffer);
const host = await createTestHost({ plugins: [nativePlugin], contracts: { only: [] } });
const db = openStartupDatabase(workerData.path as string, { label: 'contender', nativeSqliteBusy: host.ctx.nativeSqliteBusy });
const invocations: number[] = [];

db.setBusyHandler((priorInvocations) => {
  invocations.push(priorInvocations);
  if (priorInvocations === 0) {
    port.postMessage({ kind: 'waiting', threadId, priorInvocations, inTransaction: db.inTransaction });
  }
  // Bounded wait: a vanished parent ends in `false`, never a stuck sqlite3_step.
  while (Atomics.load(control, 0) === 0) {
    if (Atomics.wait(control, 0, 0, 10_000) === 'timed-out') return false;
  }
  return Atomics.load(control, 0) === 1;
});

port.on('message', async (command: 'reserve' | 'close') => {
  if (command === 'close') {
    db.close();
    await host.dispose();
    port.postMessage({ kind: 'closed' });
    port.close();
    return;
  }
  try {
    db.begin('immediate');
    const count = db.pluck<number>('SELECT COUNT(*) FROM lock_probe');
    db.run('INSERT INTO lock_probe VALUES (2)');
    db.commit();
    port.postMessage({ kind: 'reserved', count, invocations, inTransaction: db.inTransaction });
  } catch (error) {
    if (!(error instanceof StorageError)) throw error;
    db.rollback();
    port.postMessage({
      kind: 'failed', code: error.code, sqliteCode: error.sqliteCode, phase: error.phase,
      invocations, inTransaction: db.inTransaction,
    });
  }
});
port.postMessage({ kind: 'ready', threadId });
