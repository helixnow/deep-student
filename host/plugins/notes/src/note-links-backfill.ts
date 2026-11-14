import { noteRepository } from '../repository/notes.ts';
import { notesLog } from '../repository/log.ts';

const NOTE_LINKS_BACKFILL_BATCH_SIZE = 500;

/**
 * lib.rs:3752-3766: one-time note_links backfill at startup. Failure only warns;
 * the KV flag is written last, so the next launch retries.
 */
export function backfillNoteLinksAtStartup(): boolean {
  try {
    const ran = noteRepository.backfillNoteLinksOnce(NOTE_LINKS_BACKFILL_BATCH_SIZE);
    if (ran) notesLog.info('[AppSetup] One-time note links backfill completed');
    return ran;
  } catch (error) {
    notesLog.warnError('[AppSetup] Note links backfill failed (will retry next launch)', error);
    return false;
  }
}
