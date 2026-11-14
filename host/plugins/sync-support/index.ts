/**
 * L20b：同步引擎支撑模块（tombstone / note_history / pomodoro_counts / state /
 * conflict_resolver）的 Host 插件。
 *
 * 消费方：L20 `dstu.sync` 的 SyncManager（`ctx.syncSupport`）。
 * 无 Tauri 命令；`sync_state` 库由 F3 storage 注册表提供，首次读写 state 时才打开。
 */
import { definePlugin } from '../../kernel/api.ts';
import type {} from '../notes/api.ts';
import type {} from '../vfs-repos/api.ts';
import { SqliteSyncStateStore } from './src/state.ts';
import { createSyncSupport } from './src/service.ts';
import type { SyncSupportService } from './api.ts';
import type { FilesService } from '../../platform/files/api.ts';
import { filesTombstonePort } from './src/tombstone-files.ts';

export type {
  SyncSupportService,
  SyncSupportErrorKind,
  SyncSupportError,
  SyncStateStore,
  TombstoneSupport,
  NoteHistorySupport,
  PomodoroCountsSupport,
  ConflictSupport,
  ConflictResolver,
  ConflictPolicy,
  ConflictSide,
  ConflictOutcome,
  ConflictRecordToSave,
  ConflictAwareApplyResult,
  SyncHistoryPort,
  PayloadCodec,
  SyncPayloadCodec,
  AsyncPayloadCodec,
  TombstoneEvent,
  BlobTombstones,
  AssetTombstones,
  WorkspaceTombstones,
  TombstoneStorage,
} from './api.ts';
export { isClockDriftSuspected } from './api.ts';
export { plainCodec } from './api.ts';

export default definePlugin({
  meta: {
    id: 'dstu.sync-support',
    lane: 'L20-sync',
    provides: ['syncSupport'],
    platforms: ['desktop', 'mobile'],
  },
  inject: ['storage', 'notes', 'vfsRepo'],
  apply(ctx) {
    const state = new SqliteSyncStateStore(() => ctx.storage.database('sync_state'));
    const service: SyncSupportService = createSyncSupport({
      state,
      notes: () => ctx.notes,
      pomodoros: () => ctx.vfsRepo.pomodoros,
      localFiles: filesTombstonePort(() => ctx.get('files') as FilesService | undefined),
      logger: {
        warn: (message: string) => ctx.logger.warn(message),
        info: (message: string) => ctx.logger.info(message),
      },
    });
    ctx.provide('syncSupport', service);
  },
});
