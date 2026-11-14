import type { Context } from '@deepseek-ai/cordis';
import type { NotesService } from '../../notes/api.ts';
import type { SyncProviderService } from '../../sync-providers/api.ts';
import type { SyncSupportService } from '../../sync-support/api.ts';
import type {} from '../../backup/api.ts';
import type {} from '../../review/api.ts';
import type {} from '../../vfs/api.ts';
import type {} from '../../../platform/secrets/api.ts';

/** Published interfaces under the names mandated by ARCHITECTURE appendix A.
 * L10/L23 still declare their old Context keys until their rename is merged.
 * Runtime dependencies are mandatory in index.ts; there is no old-name fallback.
 */
export type SyncContext = Context & {
  notes: NotesService;
  syncProvider: SyncProviderService;
  syncSupport: SyncSupportService;
};
