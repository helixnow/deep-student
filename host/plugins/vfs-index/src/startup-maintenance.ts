/**
 * Startup maintenance from `src/lib.rs`:
 * - 1646-1656: after 6 s, `LanceVectorStore::new` (base RAG schema) then
 *   `optimize_chat_tables(Some(7), None, false)` and `optimize_kb_tables(Some(7), None, false)`;
 *   every failure is ignored.
 * - 3293-3320: `start_vfs_index_worker` (Lance builds only) runs the one-shot
 *   paged-PDF requeue migration and only warns on failure.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import type { SettingsWithConn } from '../../../platform/settings/api.ts';
import type { LanceEngineService } from '../api.ts';
import { ensureBaseRagSchema } from '../repository/chat-lance.ts';
import { requeuePagedPdfsOnce } from '../repository/index-state.ts';
import { ChatLanceStore } from './chat-embeddings.ts';
import type { LaneLogger } from './logger.ts';

export const STARTUP_LANCE_MAINTENANCE_DELAY_MS = 6_000;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function requeuePagedPdfsAtWorkerStart(vfsDb: SqlExecutor, logger?: LaneLogger): void {
  try {
    const requeued = requeuePagedPdfsOnce(vfsDb);
    if (requeued > 0) {
      logger?.info(`[VfsIndexWorker] Requeued ${requeued} multi-page PDFs for per-page indexing`);
    }
  } catch (error) {
    logger?.warn(`[VfsIndexWorker] Paged PDF requeue migration failed: ${messageOf(error)}`);
  }
}

export interface StartupLanceMaintenanceDeps {
  /** mistakes.db, the `Database` behind `LanceVectorStore`. */
  db: SqlExecutor;
  engine: LanceEngineService;
  /** `ctx.files`: Lance directory creation on first connect (async on mobile). */
  files: FilesService;
  lanceEnabled(): boolean;
  logger?: LaneLogger;
  settings?: SettingsWithConn;
}

export async function runStartupLanceMaintenance(deps: StartupLanceMaintenanceDeps): Promise<void> {
  // `lance_store_stub` optimizers return Ok(0) without touching settings or Lance.
  if (!deps.lanceEnabled()) {
    try { ensureBaseRagSchema(deps.db, deps.logger); }
    catch (error) { deps.logger?.warn(`[Lance优化] LanceVectorStore::new failed: ${messageOf(error)}`); }
    return;
  }
  let store: ChatLanceStore;
  try {
    store = ChatLanceStore.create(deps.db, deps.engine, () => deps.files, deps.logger, deps.settings);
  } catch (error) {
    deps.logger?.warn(`[Lance优化] LanceVectorStore::new failed: ${messageOf(error)}`);
    return;
  }
  await store.optimizeChatTables(7, null, false).catch(() => 0);
  await store.optimizeKbTables(7, null, false).catch(() => 0);
}
