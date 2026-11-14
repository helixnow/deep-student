/**
 * Worker entry for `zip-pool.ts`. Runs only ZIP/file CPU work; no Cordis service
 * is available here. Errors are serialized back to the Host with name+message.
 */
import { parentPort } from 'node:worker_threads';
import { repackSkillSubdir, scanRepoZipForCatalog, buildTapExportArchive } from '../skill-taps.ts';
import { scanSkillZipBytes } from '../skill-package.ts';

interface WorkerRequest {
  id: number;
  task: string;
  payload: Record<string, unknown>;
}

function bytesOf(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error('zip worker: missing byte payload');
}

function runTask(task: string, payload: Record<string, unknown>): unknown | Promise<unknown> {
  switch (task) {
    case 'scanRepoZip':
      return scanRepoZipForCatalog(bytesOf(payload.zipBytes));
    case 'repackSkillSubdir':
      return repackSkillSubdir(
        bytesOf(payload.zipBytes),
        String(payload.subdir ?? ''),
        String(payload.fallbackDirName ?? ''),
      );
    case 'scanSkillPackage':
      return scanSkillZipBytes(bytesOf(payload.zipBytes));
    case 'exportTap':
      return buildTapExportArchive(String(payload.base ?? ''), (payload.skillIds as string[]) ?? []);
    default:
      throw new Error(`zip worker: unknown task '${task}'`);
  }
}

if (parentPort !== null) {
  const port = parentPort;
  port.on('message', (request: WorkerRequest) => {
    void Promise.resolve()
      .then(() => runTask(request.task, request.payload))
      .then(
        result => port.postMessage({ id: request.id, ok: true, result }),
        (error: unknown) => port.postMessage({
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : 'Error',
        }),
      );
  });
}
