// D005-01: production entry points of NoteLeaseRepo::cleanup.
// - lib.rs:1340-1346 startup reset with i64::MAX (results discarded, error fails setup);
// - lib.rs:1347-1353 interval(5s): immediate first tick; coalesce missed cleanup ticks;
// - lib.rs:704-712 WindowEvent::Destroyed → cleanup(window label, webview None);
// - lib.rs:487-491 on_page_load(Started) → cleanup(window None, webview label);
// - cmd/notes.rs:526-553 cleanup_note_editor_leases: emit `notes:lease-ended` per
//   cancellation, warn `Notes editor lease cleanup: {e}` on failure.
import type { Context } from '@deepseek-ai/cordis';
import { StorageError } from '../../../platform/storage/api.ts';
import type { LeaseCancellation } from '../../../../contracts/ipc/generated/L10-notes.ts';
import { noteLeaseRepository } from '../repository/leases.ts';
import { vfsErrorDisplay } from '../repository/errors.ts';
import { notesLog } from '../repository/log.ts';

export const LEASE_CLEANUP_INTERVAL_MS = 5000;
/** Rust `i64::MAX`, bound exactly (a JS number would round to 2^63). */
export const LEASE_STARTUP_RESET_NOW = 9223372036854775807n;

/** VfsError Display for `get_conn_safe` maintenance refusal; other errors as elsewhere. */
function cleanupErrorDisplay(error: unknown): string {
  if (error instanceof StorageError && error.code === 'MAINTENANCE') {
    return `MAINTENANCE_MODE: ${error.database ?? 'vfs'} is temporarily unavailable`;
  }
  return vfsErrorDisplay(error);
}

/** lib.rs:1342-1345: `.map_err(|e| format!("Notes lease startup cleanup: {}", e))?`. */
export function resetNoteEditorLeasesOnStartup(ctx: Context): void {
  try {
    noteLeaseRepository.cleanup(ctx.storage.database('vfs'), LEASE_STARTUP_RESET_NOW, null, null);
  } catch (error) {
    throw new Error(`Notes lease startup cleanup: ${cleanupErrorDisplay(error)}`, { cause: error });
  }
}

/** cmd/notes.rs::cleanup_note_editor_leases. */
export function cleanupNoteEditorLeases(ctx: Context, window: string | null, webview: string | null): void {
  let events: LeaseCancellation[];
  try {
    events = noteLeaseRepository.cleanup(
      ctx.storage.database('vfs'), noteLeaseRepository.now(), window, webview);
  } catch (error) {
    notesLog.warn(`Notes editor lease cleanup: ${cleanupErrorDisplay(error)}`);
    return;
  }
  for (const event of events) ctx.backendEvents.emit('notes:lease-ended', event);
}

/** Interval + Destroyed listener, both released with the plugin scope. */
export function scheduleNoteEditorLeaseCleanup(ctx: Context): void {
  ctx.effect(() => {
    let nextTick = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = () => {
      const now = performance.now();
      // One cleanup covers all expired leases, including after a long sleep.
      if (!stopped && now >= nextTick) {
        cleanupNoteEditorLeases(ctx, null, null);
        nextTick = now + LEASE_CLEANUP_INTERVAL_MS;
      }
      if (!stopped) {
        timer = setTimeout(tick, Math.ceil(nextTick - performance.now()));
        timer.unref?.();
      }
    };
    // 首轮在下一个宏任务执行（tokio interval 的首个 immediate tick）。
    const first = setTimeout(tick, 0);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearTimeout(timer);
    };
  });
  // close-requested is not destruction; Tauri only cleans on WindowEvent::Destroyed.
  // lib.rs:487-491 on_page_load(Started): the reloading webview only (window None).
  ctx.on('host/window', (ref, state) => {
    if (state === 'destroyed') cleanupNoteEditorLeases(ctx, ref.window, null);
    else if (state === 'page-load-started') cleanupNoteEditorLeases(ctx, null, ref.webview);
  });
}
