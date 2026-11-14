import { MigrationCoordinator } from './coordinator.ts';
import { rememberStartupBackupGuards, startupBackupGuardKeys } from './backup.ts';
import { setStorageLogger, type StorageLogLevel } from '../logging.ts';
import { serializeError, type MultiDatabaseWorkerTasks } from '../worker-pool.ts';
import type { MigrationWorkerReply, MigrationWorkerRequest } from '../migration-worker.ts';

export const multiDatabaseWorkerTasks: MultiDatabaseWorkerTasks = {
  async migration_run_all({ payload, threadId, log }): Promise<MigrationWorkerReply> {
    const { options, backupGuards } = payload as MigrationWorkerRequest;
    rememberStartupBackupGuards(backupGuards);
    // The worker thread has no storage log sink of its own: route every storageLog line (coordinator,
    // schema registry, ...) to the parent Host logger with its Rust target, whatever `logTarget` says.
    setStorageLogger((target) => {
      const forward = (level: StorageLogLevel) => (message: string) => log(target, level, message);
      return { target, error: forward('error'), warn: forward('warn'), info: forward('info'), debug: forward('debug'), trace: forward('trace') };
    });
    try {
      const coordinator = new MigrationCoordinator({
        appDataDir: options.appDataDir,
        ...(options.migrationsDir === undefined ? {} : { migrationsDir: options.migrationsDir }),
        ...(options.auditDbPath === undefined ? {} : { auditDbPath: options.auditDbPath }),
        ...(options.diagnosticSandbox === true ? { diagnosticSandbox: true } : {}),
      });
      // Coordinator owns every migration/backup connection and closes it in its own finally.
      const report = await coordinator.runAll();
      return {
        ok: true,
        report: {
          databases: report.databases, success: report.success, error: report.error,
          totalDurationMs: report.totalDurationMs, componentHealth: report.componentHealth.toJSON(), threadId,
        },
        backupGuards: startupBackupGuardKeys(),
      };
    } catch (error) {
      return { ok: false, error: serializeError(error), backupGuards: startupBackupGuardKeys() };
    } finally {
      setStorageLogger(null);
    }
  },
};
