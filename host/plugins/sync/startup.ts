/**
 * L20 pre-storage bootstrap provider (X4-W13).
 *
 * F1's official profile assembles this module immediately after the kernel entry
 * and before every `host/platform/*` entry. It injects only `paths`, so importing
 * it never pulls `storage`/`syncSupport` into the pre-storage phase. The late
 * `dstu.sync` plugin intentionally no longer provides `storageStartupSync`.
 *
 * Assembly contract (owned by F1/C2, not written from this lane):
 * - module: `host/plugins/sync/startup.ts` (default export `definePlugin`)
 * - meta.id `dstu.sync-startup`, `provides: ['storageStartupSync']`, `inject: ['paths']`
 * - position: kernel -> this module -> platform (the generator already enforces the
 *   unique `storageStartupSync` provider + paths-only injection once the module is
 *   included; it currently discovers only `host/plugins/<name>/index.ts`).
 *
 * F3 calls `resetDefaultAfterLocalPurge()` after purging local data and before
 * clearing `.purge_on_next_start`; a thrown error keeps the marker and keeps
 * business databases closed.
 */
import { definePlugin } from '../../kernel/api.ts';
import type {} from '../../platform/paths/api.ts';
import { syncStateDatabasePath } from '../../platform/storage/node.ts';
import { resetDefaultAfterLocalPurgeAt } from './repository/startup-state.ts';

export default definePlugin({
  meta: {
    id: 'dstu.sync-startup',
    lane: 'L20-sync',
    provides: ['storageStartupSync'],
  },
  inject: ['paths'],
  apply(ctx) {
    const path = syncStateDatabasePath(ctx.paths.os.dataLocal);
    ctx.provide('storageStartupSync', {
      resetDefaultAfterLocalPurge: () => resetDefaultAfterLocalPurgeAt(path),
    });
  },
});
