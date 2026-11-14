/** state.rs:528. Only syncSupport owns the state-store transaction. */
import type { StorageStartupSyncService } from '../../../platform/storage/api.ts';
import type { SyncStateStore } from '../../sync-support/api.ts';

export function createLocalPurgeReset(state: () => Pick<SyncStateStore, 'resetDefaultAfterLocalPurge'>): StorageStartupSyncService {
  return { resetDefaultAfterLocalPurge: () => state().resetDefaultAfterLocalPurge() };
}
