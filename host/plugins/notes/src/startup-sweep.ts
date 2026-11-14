// V04-07 — lib.rs:3646-3768: after setup Rust runs one `spawn_blocking` task that holds the
// DeletePropagation permit for the whole sequence, skips everything when the permit is busy,
// and only warns on each step's failure:
//   recover_asset_deletions → VfsBlobRepo::cleanup_unreferenced → (get_conn_safe)
//   cleanup_unreferenced_retrievals(24h) → cleanup_orphan_note_mindmap_resources(24h)
//   → sweep_orphan_index_units → backfill_note_links_once.
// The whole sequence starts once the startup gate opens so it never delays ready.
import type { Context } from '@deepseek-ai/cordis';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { StartupFinalizerRegistration } from '../../../platform/storage/startup-finalizers.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import { acquireDeletePropagation } from './deletion-permit.ts';
import { notesLocalRuntime } from './local-runtime.ts';
import { backfillNoteLinksAtStartup } from './note-links-backfill.ts';

export const NOTES_STARTUP_SWEEP_FINALIZER = 'notes.startup-sweep';
export const RETRIEVAL_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;
const STARTUP_READY_TIMEOUT_MS = 120_000;

export interface StartupSweepLog {
  info(message: string): void;
  warn(message: string): void;
}

/** The `vfsDatabase` surface Rust's sweep uses (`vfs_db.get_conn_safe()` / `blobs_dir()`). */
export interface SweepVfsDatabase {
  getConnSafe(): SqlExecutor;
  blobsDir(): string;
}

export interface StartupSweepDeps {
  activeDir: string;
  acquireGuard(): { release(): void };
  recoverAssetDeletions(activeDir: string): number;
  vfsDatabase(): SweepVfsDatabase;
  repos: Pick<VfsReposService, 'blobs' | 'resources' | 'embeddingUnits'>;
  /** Warns on its own failure; runs even when the table sweeps had no connection (lib.rs:3752). */
  backfillNoteLinks(): void;
  logger: StartupSweepLog;
}

interface StartupGateReader {
  waitStartupReady(timeout: number): Promise<boolean>;
}

interface BackgroundSpawner {
  spawn<T>(task: () => Promise<T>): Promise<T> | null;
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function runStartupSweep(deps: StartupSweepDeps): void {
  const { logger, repos } = deps;
  let guard: { release(): void };
  try {
    guard = deps.acquireGuard();
  } catch (error) {
    logger.warn(`[AppSetup] 跳过启动删除恢复：另一数据治理操作正在运行: ${messageOf(error)}`);
    return;
  }
  try {
    try {
      const count = deps.recoverAssetDeletions(deps.activeDir);
      if (count > 0) logger.info(`[AppSetup] Recovered ${count} prepared asset deletions`);
    } catch (error) {
      logger.warn(`[AppSetup] Prepared asset deletion recovery failed: ${messageOf(error)}`);
    }

    try {
      const database = deps.vfsDatabase();
      const count = repos.blobs.cleanupUnreferenced(database.getConnSafe(), database.blobsDir());
      if (count > 0) logger.info(`[AppSetup] Swept ${count} unreferenced blobs`);
    } catch (error) {
      logger.warn(`[AppSetup] Unreferenced blob sweep failed: ${messageOf(error)}`);
    }

    sweepTables(deps);
    deps.backfillNoteLinks();
  } finally {
    guard.release();
  }
}

function sweepTables({ logger, repos, vfsDatabase }: StartupSweepDeps): void {
  let conn: SqlExecutor;
  try {
    conn = vfsDatabase().getConnSafe();
  } catch (error) {
    logger.warn(`[AppSetup] Retrieval sweep skipped (no connection): ${messageOf(error)}`);
    return;
  }
  try {
    const count = repos.resources.cleanupUnreferencedRetrievals(conn, RETRIEVAL_SWEEP_GRACE_MS);
    if (count > 0) logger.info(`[AppSetup] Swept ${count} unreferenced retrieval resources`);
  } catch (error) {
    logger.warn(`[AppSetup] Retrieval resource sweep failed: ${messageOf(error)}`);
  }
  try {
    const count = repos.resources.cleanupOrphanNoteMindmapResources(conn, RETRIEVAL_SWEEP_GRACE_MS);
    if (count > 0) logger.info(`[AppSetup] Swept ${count} orphan note/mindmap resources`);
  } catch (error) {
    logger.warn(`[AppSetup] Orphan note/mindmap sweep failed: ${messageOf(error)}`);
  }
  try {
    const count = repos.embeddingUnits.sweepOrphanIndexUnits(conn);
    if (count > 0) logger.info(`[AppSetup] Swept ${count} orphan index units (lance rows enqueued)`);
  } catch (error) {
    logger.warn(`[AppSetup] Orphan index unit sweep failed: ${messageOf(error)}`);
  }
}

export function registerNotesStartupSweep(ctx: Context): void {
  const logger = ctx.logger('notes');
  let stopped = false;
  let sweep: Promise<void> | undefined;

  const run = async (): Promise<void> => {
    if (stopped) return;
    runStartupSweep({
      activeDir: ctx.storage.locations.activeDir,
      acquireGuard: () => acquireDeletePropagation(ctx),
      recoverAssetDeletions: (activeDir) => notesLocalRuntime().recoverAssetDeletions(activeDir),
      vfsDatabase: () => {
        const database = ctx.get('vfsDatabase' as never) as Partial<SweepVfsDatabase> | undefined;
        if (typeof database?.getConnSafe !== 'function' || typeof database.blobsDir !== 'function') {
          throw new Error('vfsDatabase service is not available');
        }
        return database as SweepVfsDatabase;
      },
      repos: ctx.get('vfsRepo') as VfsReposService,
      backfillNoteLinks: () => { backfillNoteLinksAtStartup(); },
      logger,
    });
  };
  const launch = (): void => {
    if (stopped) return;
    const background = ctx.get('backgroundTasks' as never) as BackgroundSpawner | undefined;
    const task = background === undefined ? run() : background.spawn(run);
    sweep = task?.catch((error: unknown) => {
      logger.warn(`[AppSetup] startup sweep failed: ${messageOf(error)}`);
    });
  };
  const launchAfterReady = (): void => {
    let gate: Partial<StartupGateReader> | undefined;
    try { gate = ctx.get('startupGate' as never) as Partial<StartupGateReader> | undefined; }
    catch { gate = undefined; }
    if (typeof gate?.waitStartupReady !== 'function') { launch(); return; }
    void gate.waitStartupReady(STARTUP_READY_TIMEOUT_MS).then((ready) => {
      if (stopped) return;
      // The gate only keeps the sweep from delaying ready; Rust spawns it after setup unconditionally.
      if (!ready) logger.warn('[AppSetup] startup gate was not marked ready; running startup sweep anyway');
      launch();
    }).catch((error: unknown) => {
      logger.warn(`[AppSetup] failed while waiting for startup gate: ${messageOf(error)}`);
    });
  };

  // Startup-only (lib.rs:3646): a reinstall after startup skips it, an unload withdraws it.
  const finalizer = new AbortController();
  const options: StartupFinalizerRegistration = { late: 'skip', signal: finalizer.signal };
  try {
    ctx.storage.registerFinalizer(NOTES_STARTUP_SWEEP_FINALIZER, launchAfterReady, options);
  } catch (error) {
    logger.warn(`[AppSetup] startup sweep finalizer not registered: ${messageOf(error)}`);
    return;
  }
  ctx.effect(() => async () => {
    finalizer.abort();
    stopped = true;
    await sweep;
  });
}
