import Database from 'better-sqlite3';
import { parentPort, threadId, workerData } from 'node:worker_threads';
import { sqliteBusy } from '../../sqlite-busy/index.ts';

// Contender for the busy-handler handshake: control word 0 = keep waiting,
// 1 = release (handler returns true), 2 = cancel (handler returns false).
const port = parentPort!;
const control = new Int32Array(workerData.control as SharedArrayBuffer);
const db = new Database(workerData.path as string, { timeout: 0 });
const invocations: number[] = [];

sqliteBusy.setBusyHandler(db, (priorInvocations) => {
  invocations.push(priorInvocations);
  if (priorInvocations === 0) port.postMessage({ kind: 'waiting', threadId, priorInvocations, inTransaction: db.inTransaction });
  Atomics.wait(control, 0, 0);
  return Atomics.load(control, 0) === 1;
});

port.on('message', (command: 'reserve' | 'close') => {
  if (command === 'close') {
    db.close();
    port.postMessage({ kind: 'closed' });
    port.close();
    return;
  }
  try {
    db.exec('BEGIN IMMEDIATE');
    const count = (db.prepare('SELECT COUNT(*) FROM lock_probe').pluck().get() as number); // boundary-allow sql-outside-repository: 测试 worker 的锁探针表，非业务存储
    db.exec('INSERT INTO lock_probe VALUES (2)'); // boundary-allow sql-outside-repository: 测试 worker 的锁探针表，非业务存储
    db.exec('COMMIT');
    port.postMessage({ kind: 'reserved', count, invocations, inTransaction: db.inTransaction });
  } catch (error) {
    port.postMessage({
      kind: 'failed', code: (error as { code?: string }).code, invocations, inTransaction: db.inTransaction,
    });
  }
});
port.postMessage({ kind: 'ready', threadId });
