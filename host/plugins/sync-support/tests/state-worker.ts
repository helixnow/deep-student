/**
 * state 相关测试的并发子线程：在写者持有 `BEGIN IMMEDIATE` 时申请事件序号。
 * 主线程在子线程阻塞等待期间提交事务，验证 `BEGIN IMMEDIATE` 先等写者再读。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { SqliteDatabase } from '../../../platform/storage/database.ts';
import { serviceHost } from './service-host.ts';

const { path } = workerData as { path: string };
try {
  const db = new SqliteDatabase({ name: 'contender', path, profile: { busyTimeoutMs: 5000 } });
  const h = await serviceHost(db);
  try {
    const seq = h.service.state.reserveTombstoneEventSeq('instance', 'device', 'assets', 'operation-b', 0n);
    parentPort?.postMessage({ ok: true, seq: seq.toString() });
  } finally { await h.dispose(); }
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
