import { describe, expect, it } from 'vitest';
import {
  isZipWorkerInfrastructureError, runZipTask, stopIdleZipWorkers, ZipWorkerInfrastructureError,
} from '../src/workers/zip-pool.ts';

describe('zip worker pool error classes', () => {
  it('postMessage_failure_is_worker_infrastructure_not_invalid_zip', async () => {
    let caught: unknown;
    try {
      // Functions are not structured-cloneable, so postMessage fails before the
      // task reaches the worker. Rust reports the analogous join/transport
      // failure as IoError, not InvalidInput (skill_taps.rs:473-475).
      await runZipTask('scanRepoZip', { zipBytes: () => undefined });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ZipWorkerInfrastructureError);
    expect(isZipWorkerInfrastructureError(caught)).toBe(true);
  });

  it('worker_task_failure_keeps_zip_content_classification', async () => {
    let caught: unknown;
    try {
      await runZipTask('repackSkillSubdir', {
        zipBytes: Uint8Array.from([1, 2, 3]),
        subdir: 'skills/demo',
        fallbackDirName: 'demo',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(isZipWorkerInfrastructureError(caught)).toBe(false);
  });
});

describe('V09 P3-2: the process-wide pool releases idle workers on demand', () => {
  it('stopIdleZipWorkers terminates the idle worker a finished task left behind, and the pool respawns on the next task', async () => {
    const corrupt = { zipBytes: Uint8Array.from([1, 2, 3]), subdir: 'skills/demo', fallbackDirName: 'demo' };
    await expect(runZipTask('repackSkillSubdir', corrupt)).rejects.toThrow();
    expect(await stopIdleZipWorkers()).toBeGreaterThanOrEqual(1);
    expect(await stopIdleZipWorkers()).toBe(0);
    const error = await runZipTask('repackSkillSubdir', corrupt).catch((caught: unknown) => caught);
    expect(isZipWorkerInfrastructureError(error)).toBe(false);
    expect(await stopIdleZipWorkers()).toBeGreaterThanOrEqual(1);
  });
});
