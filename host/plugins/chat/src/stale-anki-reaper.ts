/**
 * `StaleAnkiBlockReaper` slot and the delete gate that consults it
 * (manage_session.rs:242-314). chatanki fills the slot; while it is empty there
 * is nothing to reap and running anki blocks are counted as-is.
 */
import type { Slot } from '../../../kernel/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { sessionHasRunningAnkiBlocks } from '../repository/sessions.ts';
import { errorText, type ChatLogger } from './logger.ts';

export interface StaleAnkiBlockReaper {
  /** Marks crash/force-quit leftovers in the session as failed and returns their block ids. */
  reapStaleRunningAnkiBlocks(sessionId: string): string[];
}

export type StaleAnkiBlockReaperSlot = Slot<StaleAnkiBlockReaper>;

/** `session_has_running_anki_blocks`: reap first; a reap failure only warns. */
export function sessionHasLiveAnkiBlocks(db: SqlExecutor, sessionId: string,
  reapers: StaleAnkiBlockReaperSlot, log: ChatLogger): boolean {
  const reaper = reapers.get();
  if (reaper !== undefined) {
    try {
      const reaped = reaper.reapStaleRunningAnkiBlocks(sessionId);
      if (reaped.length > 0) {
        log.info(`[ChatV2::handlers] Marked ${reaped.length} stale running anki block(s) as failed before delete check (session ${sessionId})`);
      }
    } catch (error) {
      log.warn(`[ChatV2::handlers] Failed to reap stale running anki blocks for ${sessionId}: ${errorText(error)}`);
    }
  }
  return sessionHasRunningAnkiBlocks(db, sessionId);
}
