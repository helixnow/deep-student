// A real independent SQLite writer, released from another thread while the upload waits.
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
const db = new DatabaseSync(workerData.path);
db.exec('BEGIN IMMEDIATE');
parentPort.postMessage('locked');
setTimeout(() => {
  db.exec('COMMIT');
  db.close();
  parentPort.postMessage('released');
}, 200);
