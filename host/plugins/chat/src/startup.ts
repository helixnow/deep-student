/** Rust init_chat_v2 post-database-open cleanup order (mod.rs:245-264). */
import type { StorageService } from '../../../platform/storage/api.ts';
import { cleanupOrphanUserContentBlocks, reconcileInterruptedBlocksOnStartup } from '../repository/startup.ts';
import { chatDatabase } from './handlers.ts';
import { errorText, type ChatLogger } from './logger.ts';

export function reconcileChatStartup(storage: StorageService, log: ChatLogger): void {
  try {
    const count = cleanupOrphanUserContentBlocks(chatDatabase(storage), log);
    if (count > 0) log.info(`[ChatV2] Startup cleanup: removed ${count} orphan user content blocks`);
  } catch (error) {
    log.warn(`[ChatV2] Startup cleanup failed (non-fatal): ${errorText(error)}`);
  }
  try {
    reconcileInterruptedBlocksOnStartup(chatDatabase(storage), log);
  } catch (error) {
    log.warn(`[ChatV2] Startup block reconcile failed (non-fatal): ${errorText(error)}`);
  }
}
