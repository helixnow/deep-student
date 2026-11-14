/**
 * F3 存储中依赖 Node 的值导出（仅桌面）：文件删除队列（工作区与 notes 资源）、worker 线程池、迁移 worker、
 * 统一文件管理的文件读写辅助、`sync_state.db` 路径与启动期独立开库。类型、错误、`defineQuery` 等仍从 `api.ts` 导入。
 *
 * 导入方已全部改到本入口（`storage-mobile/tests/storage-entries.test.ts` 的 PENDING_IMPORTERS 为空）；`api.ts` 里
 * 剩下的同名重导出删掉后，它的运行时只剩 `errors.ts` 等可移植模块。新增的名字只从本入口导出。
 */
export {
  prepareWorkspaceDeletion,
  finishWorkspaceDeletion,
  recoverWorkspaceDeletions,
  cancelReadyWorkspaceDeletion,
  registerNoteAssetRetention,
  assetLocalPathFromKey,
  deleteAssetWithJournal,
  prepareAssetDeletionWithConn,
  finishAssetDeletionWithConn,
  recoverAssetDeletions,
} from './file-deletion-queue.ts';
export type { PreparedDeletionIntent, NoteAssetRetention } from './file-deletion-queue.ts';
export { createDatabaseWorkerPool } from './worker-pool.ts';
export type {
  DatabaseWorkerPool, DatabaseWorkerPoolOptions, DatabaseWorkerRunOptions,
  DatabaseWorkerTaskContext, DatabaseWorkerTask, DatabaseWorkerTasks,
  MultiDatabaseWorkerTaskContext, MultiDatabaseWorkerTasks, MultiDatabaseWorkerRunOptions,
} from './worker-pool.ts';
export { createMigrationWorker } from './migration-worker.ts';
export type { MigrationWorker, MigrationWorkerOptions, MigrationWorkerReport } from './migration-worker.ts';
export {
  isVirtualUri, rejectDoubleEncodedVirtualUri, queuePersistableSafUri, copyFileVerified,
  readAllBytesBounded, getFileSize, hashFileSha256, resolveFileInfo, isOpaqueDocumentId,
  extractFileName, extractExtension, detectExtensionFromMagic, sanitizeFileNameForFs,
} from './unified-file-manager.ts';
export { syncStateDatabasePath } from './locations.ts';
export { openStartupDatabase } from './startup-database.ts';
export type { StartupDatabase, OpenStartupDatabaseOptions } from './startup-database.ts';
