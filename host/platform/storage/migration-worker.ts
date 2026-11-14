import { StorageError, type MigrationReport } from './api.ts';
import type { StartupComponentIssue } from './migration/backup.ts';
import { rememberStartupBackupGuards, startupBackupGuardKeys } from './migration/backup.ts';
import { createDatabaseWorkerPool, deserializeError, type SerializedError } from './worker-pool.ts';

export interface MigrationWorkerOptions {
  appDataDir: string;
  migrationsDir?: string;
  auditDbPath?: string | null;
  /** 见 `MigrationCoordinatorOptions.diagnosticSandbox`：只给迁移诊断的一次性测试槽（`slots/slotC|slotD`）设 true。 */
  diagnosticSandbox?: boolean;
}
export interface MigrationWorkerReport extends MigrationReport {
  componentHealth: { components: StartupComponentIssue[] };
  /** Internal execution evidence, not an IPC response field. */
  threadId: number;
}
export interface MigrationWorker {
  /** Whole actual MigrationCoordinator.runAll, without a timeout or invoke cancellation. */
  runAll(options: MigrationWorkerOptions): Promise<MigrationWorkerReport>;
  /** Refuse new calls; drain every accepted job before terminating the worker. */
  close(): Promise<void>;
}

export interface MigrationWorkerRequest {
  options: MigrationWorkerOptions;
  backupGuards: string[];
}
export type MigrationWorkerReply = { backupGuards: string[] } & (
  { ok: true; report: MigrationWorkerReport } | { ok: false; error: SerializedError }
);

/** Thin execution bridge; the migration algorithm stays in migration/coordinator.ts. */
export function createMigrationWorker(options: { baseDir: string }): MigrationWorker {
  const pool = createDatabaseWorkerPool({
    baseDir: options.baseDir,
    taskModule: new URL('./migration/worker-tasks.ts', import.meta.url),
    tasks: ['migration_run_all'], size: 1, timeoutMs: 0,
  });
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<MigrationWorkerReport>>();
  return {
    runAll(config) {
      if (closing) return Promise.reject(new StorageError('TX_CLOSED', 'migration worker is closed'));
      const job = pool.runWithDatabases<MigrationWorkerReply>('migration_run_all', {
        options: config, backupGuards: startupBackupGuardKeys(),
      } satisfies MigrationWorkerRequest, {
        activeDir: config.appDataDir, databases: [], timeoutMs: 0,
      }).then(reply => {
        // A completed backup remains guarded even if a later migration step failed.
        rememberStartupBackupGuards(reply.backupGuards);
        if (reply.ok === false) throw deserializeError(reply.error);
        return reply.report;
      });
      pending.add(job);
      void job.then(() => pending.delete(job), () => pending.delete(job));
      return job;
    },
    close() {
      return closing ??= Promise.allSettled([...pending]).then(() => pool.close());
    },
  };
}
