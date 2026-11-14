/** 诊断包 worker 入口（见 `diagnostics.ts` buildZipInWorker）。 */
import { parentPort, workerData } from 'node:worker_threads';
import { buildDiagnosticsZip, type DiagnosticsZipInput } from './diagnostics-sanitize.ts';

if (parentPort === null) throw new Error('diagnostics worker must run inside worker_threads');
try {
  // writeZip 可能返回 Buffer 池里的切片（池不可转移），先复制到独立 ArrayBuffer 再转移。
  const zip = new Uint8Array(buildDiagnosticsZip(workerData as DiagnosticsZipInput));
  parentPort.postMessage({ zip }, [zip.buffer]);
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
