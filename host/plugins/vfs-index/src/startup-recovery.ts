/**
 * V04-03 / V04-04 — `lib.rs:3606-3644` runs these synchronously inside `build_app_state`, before
 * the frontend can call any command, in this order:
 * 1. `backfill_missing_previews` (query now, rendering in its own background task);
 * 2. `recover_stuck_tasks`, then `spawn(resume_recovered_tasks)` — the resume never gates startup;
 * 3. `VfsFullIndexingService::recover_stuck_indexing`.
 * Every step only logs a warning on failure. The resume loop mirrors
 * `pdf_processing_service.rs:3101-3138` and additionally stops when the plugin unloads.
 */
import type { Context } from '../../../kernel/api.ts';
import type { BackgroundTasks } from '../../../platform/diagnostics/api.ts';
import type { StartupFinalizerRegistration } from '../../../platform/storage/startup-finalizers.ts';
import type { PdfProcessingService, VfsIndexingApi } from '../api.ts';

export const VFS_INDEX_STARTUP_RECOVERY_FINALIZER = 'vfs-index.startup-recovery';
const MAX_AUTO_RESUME_CONCURRENCY = 2;
const AUTO_RESUME_POLL_MS = 2_000;
const STARTUP_READY_TIMEOUT_MS = 120_000;

export interface StartupRecoveryLog {
  info(message: string): void;
  warn(message: string): void;
}

interface StartupGateReader {
  waitStartupReady(timeout: number): Promise<boolean>;
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export interface VfsIndexStartupRecoveryDeps {
  pdf: Pick<PdfProcessingService, 'backfillMissingPreviews' | 'recoverStuckTasks'>;
  indexing: Pick<VfsIndexingApi, 'recoverStuckIndexing'>;
  logger: StartupRecoveryLog;
  spawnResume(fileIds: string[]): void;
}

export function runVfsIndexStartupRecovery(deps: VfsIndexStartupRecoveryDeps): void {
  const { logger } = deps;
  try {
    deps.pdf.backfillMissingPreviews();
  } catch (error) {
    logger.warn(`[AppSetup] Failed to schedule PDF preview backfill: ${messageOf(error)}`);
  }

  let recovered: string[] = [];
  try {
    recovered = deps.pdf.recoverStuckTasks();
  } catch (error) {
    logger.warn(`[AppSetup] Failed to recover stuck tasks: ${messageOf(error)}`);
  }
  if (recovered.length > 0) {
    logger.info(`[AppSetup] Recovered ${recovered.length} stuck media processing tasks, scheduling auto-resume`);
    deps.spawnResume(recovered);
  }

  try {
    const count = deps.indexing.recoverStuckIndexing();
    if (count > 0) logger.info(`[AppSetup] Recovered ${count} stuck indexing records`);
  } catch (error) {
    logger.warn(`[AppSetup] Failed to recover stuck indexing records: ${messageOf(error)}`);
  }
}

export interface ResumeScope {
  stopped(): boolean;
  sleep(ms: number): Promise<void>;
}

export async function resumeRecoveredTasksScoped(
  pdf: Pick<PdfProcessingService, 'runningCount' | 'isRunning' | 'startPipeline'>,
  fileIds: readonly string[],
  scope: ResumeScope,
  logger?: StartupRecoveryLog,
): Promise<void> {
  if (fileIds.length === 0) return;
  logger?.info(`[MediaProcessingService] Auto-resuming ${fileIds.length} recovered tasks`);
  for (const fileId of fileIds) {
    // The slots include user-triggered pipelines.
    while (pdf.runningCount() >= MAX_AUTO_RESUME_CONCURRENCY) {
      if (scope.stopped()) return;
      await scope.sleep(AUTO_RESUME_POLL_MS);
    }
    if (scope.stopped()) return;
    // The user may have restarted the file while we waited.
    if (pdf.isRunning(fileId)) continue;
    try {
      await pdf.startPipeline(fileId, null);
      logger?.info(`[MediaProcessingService] Auto-resumed pipeline for recovered file: ${fileId}`);
    } catch (error) {
      logger?.warn(`[MediaProcessingService] Failed to auto-resume file ${fileId}: ${messageOf(error)}`);
    }
  }
}

export interface VfsIndexStartupRecoveryOptions {
  pdf: PdfProcessingService;
  indexing: Pick<VfsIndexingApi, 'recoverStuckIndexing'>;
  logger: StartupRecoveryLog;
  /** vfs-index's pre-unbind hooks; the resume loop must stop before `pdf.dispose()` and the owner unbind. */
  beforeUnbind?: Array<() => Promise<void>>;
}

/**
 * Startup only: a reinstall after the finalizers ran skips the recovery (`late: 'skip'`), and unloading
 * withdraws a registration that has not run yet so a reinstall can register its own.
 */
export function registerVfsIndexStartupRecovery(ctx: Context, options: VfsIndexStartupRecoveryOptions): void {
  const { pdf, indexing, logger } = options;
  let stopped = false;
  let resume: Promise<void> | undefined;
  const sleepers = new Set<{ timer: ReturnType<typeof setTimeout>; resolve: () => void }>();
  const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => {
    if (stopped) { resolve(); return; }
    const entry = { resolve, timer: setTimeout(() => { sleepers.delete(entry); resolve(); }, ms) };
    sleepers.add(entry);
  });
  const wake = (): void => {
    for (const entry of sleepers) { clearTimeout(entry.timer); entry.resolve(); }
    sleepers.clear();
  };
  const stop = async (): Promise<void> => {
    stopped = true;
    wake();
    await resume;
  };

  const launch = (fileIds: string[]): void => {
    if (stopped) return;
    // The background-task signal also aborts at `BackgroundTasks.shutdown()`, independent of this plugin's unload.
    const run = (signal?: AbortSignal): Promise<void> => {
      signal?.addEventListener('abort', wake, { once: true });
      return resumeRecoveredTasksScoped(pdf, fileIds, { stopped: () => stopped || signal?.aborted === true, sleep }, logger);
    };
    const background = ctx.get('backgroundTasks') as BackgroundTasks | undefined;
    const task = background === undefined ? run() : background.spawn(run);
    resume = task?.catch((error: unknown) => {
      logger.warn(`[MediaProcessingService] Auto-resume stopped: ${messageOf(error)}`);
    });
  };
  // Rust spawns the resume during setup and waits for nothing; here it starts once the IPC startup gate
  // opens, and still starts if the gate never opens: `pending` is not a stuck stage, so a skipped resume
  // would leave the files idle until the user retries them by hand.
  const spawnResume = (fileIds: string[]): void => {
    let gate: Partial<StartupGateReader> | undefined;
    try { gate = ctx.get('startupGate' as never) as Partial<StartupGateReader> | undefined; }
    catch { gate = undefined; }
    if (typeof gate?.waitStartupReady !== 'function') { launch(fileIds); return; }
    void gate.waitStartupReady(STARTUP_READY_TIMEOUT_MS).then((ready) => {
      if (!ready && !stopped) {
        logger.warn('[AppSetup] startup gate was not marked ready within 120 s; resuming recovered media tasks anyway');
      }
    }, (error: unknown) => {
      logger.warn(`[AppSetup] failed while waiting for startup gate: ${messageOf(error)}; resuming recovered media tasks anyway`);
    }).then(() => { launch(fileIds); }).catch((error: unknown) => {
      logger.warn(`[MediaProcessingService] Auto-resume stopped: ${messageOf(error)}`);
    });
  };

  const finalizer = new AbortController();
  const once: StartupFinalizerRegistration = { late: 'skip', signal: finalizer.signal };
  try {
    ctx.storage.registerFinalizer(VFS_INDEX_STARTUP_RECOVERY_FINALIZER, () => {
      runVfsIndexStartupRecovery({ pdf, indexing, logger, spawnResume });
    }, once);
  } catch (error) {
    logger.warn(`startup recovery finalizer not registered: ${messageOf(error)}`);
    return;
  }
  ctx.effect(() => async () => {
    finalizer.abort();
    await stop();
  });
  options.beforeUnbind?.unshift(stop);
}
