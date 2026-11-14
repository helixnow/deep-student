/**
 * L20-sync 插件本体（可移植）：入口按平台在 `index.ts` / `mobile.ts` 之间选择。
 *
 * 平台差异只有本地文件系统：业务库快照/WAL、blobs/assets 资产树、导出/导入 JSON、加密对象与断点临时
 * 文件都是同步与异步 `node:fs` 形状，走 `./local-runtime.ts` 端口。桌面入口注入 `node:fs` 实现
 * （`local-runtime.node.ts`），移动端入口不注入——缺省端口没有本地文件系统，走磁盘的指令按
 * `IO error` / `Database error` 降级，纯 SQLite 的指令与契约不受影响。
 */
import { definePlugin } from '../../../kernel/api.ts';
import { createPairingCode, applyPairingCode, type CreatePairingArgs, type ApplyPairingArgs } from './device-pairing.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { HostPlugin, PluginPlatform } from '../../../kernel/core.ts';
import { setLocalRuntime, type LocalRuntime } from './local-runtime.ts';
import type { BatchQuarantineResult, RecordConflictRow, RollbackSnapshotResponse, SyncExportResponse, SyncImportResponse, SyncQuarantineRow, SyncService, SyncSnapshotBatchRow } from '../api.ts';
import { Hlc } from './hlc.ts';
import { countRecordConflicts, discardAll, discardOne } from './local-commands.ts';
import { getSyncStatus } from './status.ts';
import { listSyncSnapshotBatches, purgeResolvedConflicts } from './history-commands.ts';
import { listQuarantine, listRecordConflicts, resolveConflicts } from './list-commands.ts';
import { cancelActiveSync, runUntilCallerOrPluginStops, runUntilPluginStops } from './cancellation.ts';
import { SyncProgressEmitter } from './emitter.ts';
import { retryQuarantine, retryAllQuarantine } from './quarantine-commands.ts';
import { exportSyncData } from './transfer-commands.ts';
import type { SyncContext } from './dependencies.ts';
import { createNoteHistoryHooks } from '../repository/note-history.ts';
import { setDefaultNoteHistory } from '../repository/apply.ts';
import { setDefaultProfileMerger } from './field-merge.ts';
import { mergeProfileJsonForSync } from '../../memory/api.ts';
import {
  applyDownloadedChanges,
  applyDownloadedChangesForceExactWithHooks,
  applyDownloadedChangesWithConflictGuard,
} from '../repository/apply.ts';
import { filterPendingChangesForDatabase } from './change-log.ts';
import { getPendingChanges } from '../repository/change-log.ts';
import {
  enrichChangesWithData,
  getDatabaseSyncState,
  getRecordData,
  recordsSemanticallyEqualForSync,
} from '../repository/record-data.ts';
import {
  cleanupSyncedChanges,
  markSyncedWithTimestamp,
  resetSyncBaselineAfterRestore,
} from '../repository/change-log.ts';
import { rollbackBatch } from '../repository/history.ts';
import { applyMergeStrategy, detectConflicts, hasPruneGap } from './merge.ts';
import { repoCheck } from './cloud-commands.ts';
import { detectPruneGap } from './prune-gap.ts';
import { uploadManifest, validateUploadSchemaCompatibility } from './manifest-upload.ts';
import { downloadChanges, commitDownloadProgress } from './download-changes.ts';
import { prepareDeleteVersionsForCleanup } from '../repository/apply-record.ts';
import { applyDownloadedChangesToDatabases } from '../repository/apply-databases.ts';
import { setPomodoroCountsOwner } from '../repository/pomodoro-counts.ts';
import type {} from '../../vfs-repos/api.ts';
import { importSyncDataCommand, resolveRecordConflictCommand, rollbackSyncSnapshotCommand, type ResolveConflictArgs } from './mutation-commands.ts';
import { executeDownload, executeBidirectional } from './execute-download.ts';
import { uploadEnrichedChanges } from './upload-changes.ts';
import { validateRemoteFormat } from './remote-format.ts';
import { detectChangeLogGaps } from './change-availability.ts';
import { detectSyncConflicts } from './detect-conflicts.ts';
import { createLocalPurgeReset } from './purge-reset.ts';
import { assertNotInMaintenance } from './cloud-runtime.ts';
import { runSync, runSyncWithProgress } from './run-sync.ts';
import { markBlobDeletedCommand, markAssetDeletedCommand } from './tombstone-commands.ts';
import { listUnsyncedItemsCommand } from './unsynced-command.ts';
import type { LocalSyncCommandPorts } from './sync-command-needs.ts';
import type { CloudStorageConfig } from '../../../../contracts/ipc/generated/_shared.ts';
import type { ConflictDetectionResponse, RepoCheckReport } from '../../../../contracts/ipc/generated/L20-sync.ts';


/** 平台差异部分：桌面入口注入 `node:fs` / `node:os` 端口，移动端入口不注入。 */
export interface SyncPluginOptions {
  platforms?: readonly PluginPlatform[];
  /** `() => port` 在 apply 时求值并安装；缺省用无本地文件系统的端口。 */
  localRuntime?: (ctx: Context) => LocalRuntime;
}

/** 插件本体（可移植）：入口按平台在 `index.ts` / `mobile.ts` 之间选择。 */
export function createSyncPlugin(options: SyncPluginOptions = {}): HostPlugin {
  return definePlugin({
  meta: {
    id: 'dstu.sync', lane: 'L20-sync', provides: ['sync'],
    ...(options.platforms ? { platforms: options.platforms } : {}),
    commands: [
      'data_governance_count_record_conflicts',
      'data_governance_discard_quarantine',
      'data_governance_discard_all_quarantine',
      'data_governance_get_sync_status',
      'data_governance_list_sync_snapshot_batches',
      'data_governance_purge_resolved_conflicts',
      'data_governance_list_quarantine',
      'data_governance_list_record_conflicts',
      'data_governance_resolve_conflicts',
      'data_governance_retry_quarantine',
      'data_governance_retry_all_quarantine',
      'data_governance_cancel_sync',
      'data_governance_export_sync_data',
      'data_governance_repo_check',
      'data_governance_detect_conflicts',
      'data_governance_detect_prune_gap',
      'data_governance_import_sync_data',
      'data_governance_resolve_record_conflict',
      'data_governance_rollback_sync_snapshot_batch',
      'data_governance_run_sync',
      'data_governance_run_sync_with_progress',
      'data_governance_mark_blob_deleted',
      'data_governance_mark_asset_deleted',
      'data_governance_list_unsynced_items',
    ],
  },
  inject: options.platforms?.includes('mobile')
    ? ['storage', 'paths', 'notes', 'syncProvider', 'secrets', 'vfsDatabase', 'syncSupport', 'vfsRepo', 'mastery']
    : ['storage', 'paths', 'notes', 'backup', 'syncProvider', 'secrets', 'vfsDatabase', 'syncSupport', 'nativeCompression', 'vfsRepo', 'mastery'],
  apply(context) {
    const ctx = context as SyncContext;
    const pairingSettings = (): SettingsStore => {
      const settings = ctx.reflect.get('settings') as SettingsStore | undefined;
      if (!settings) throw new Error('Settings service unavailable');
      return settings;
    };
    setLocalRuntime(options.localRuntime?.(ctx) ?? null);
    ctx.effect(() => () => setLocalRuntime(null));
    const purgeReset = createLocalPurgeReset(() => ctx.syncSupport.state);
    setPomodoroCountsOwner(() => ctx.vfsRepo.pomodoros);
    setDefaultNoteHistory(createNoteHistoryHooks(
      () => ctx.notes,
      () => ctx.syncSupport.noteHistory,
    ));
    // hooks.rs SYNC_FIELD_MERGER: the app root installs memory's learner-profile merger.
    ctx.effect(() => {
      setDefaultProfileMerger({ mergeProfileJsonForSync });
      return () => setDefaultProfileMerger(null);
    });
    // Effects are disposed after the kernel stops waiting for in-flight commands; cancel any sync still running then.
    const disposed = new AbortController();
    ctx.effect(() => () => disposed.abort());
    const localSyncPorts = (): LocalSyncCommandPorts => ({
      tombstones: ctx.syncSupport.tombstones,
      workspaceCoordinator: (ctx.reflect.get('agentWorkspace') as LocalSyncCommandPorts['workspaceCoordinator'] | undefined) ?? null,
    });
    const service: SyncService = {
      createPairingCode: args => createPairingCode(pairingSettings(), args),
      applyPairingCode: args => applyPairingCode(pairingSettings(), args),
      runSync: (direction, config, strategy, signal) => runUntilCallerOrPluginStops(signal, disposed.signal,
        run => runSync(ctx, localSyncPorts(), direction, config ?? null, strategy ?? null, run, options.platforms?.includes('mobile'))),
      runSyncWithProgress: (direction, config, strategy, signal) => runUntilCallerOrPluginStops(signal, disposed.signal,
        run => runSyncWithProgress(ctx, localSyncPorts(), direction, config ?? null, strategy ?? null, run, options.platforms?.includes('mobile'))),
      markBlobDeleted: (config, hash, path, size) => markBlobDeletedCommand(ctx, ctx.backup.syncCommandPorts().limiter, ctx.syncSupport.tombstones, config, hash, path, size),
      markAssetDeleted: (config, key, size) => markAssetDeletedCommand(ctx, ctx.backup.syncCommandPorts().limiter, ctx.syncSupport.tombstones, config, key, size),
      listUnsyncedItems: config => listUnsyncedItemsCommand(ctx, ctx.syncSupport.tombstones, config),
      resetDefaultAfterLocalPurge: () => purgeReset.resetDefaultAfterLocalPurge(),
      importSyncData: (path, strategy) => importSyncDataCommand(ctx, path, strategy ?? null),
      resolveRecordConflict: args => resolveRecordConflictCommand(ctx, args),
      rollbackSyncSnapshotBatch: (database, batch) => rollbackSyncSnapshotCommand(ctx, database, batch),
      applyDownloadedChangesToDatabases: async (changes, strategy) => applyDownloadedChangesToDatabases(
        ctx.storage, changes, strategy, await ctx.paths.deviceId(), {
          recomputeAllStatesWithConn: db => ctx.mastery.recomputeAllStatesWithConn(db),
          syncAllLearnerProfiles: () => ctx.mastery.syncAllLearnerProfiles(),
        }, ctx.logger('sync'),
      ),
      prepareDeleteVersionsForCleanup,
      commitDownloadProgress: (storage, downloaded, options) => commitDownloadProgress(
        storage, downloaded, { ...options, logger: ctx.logger('sync') }, () => ctx.syncSupport.state,
      ),
      executeBidirectional: (storage, pending, local, strategy, options) => executeBidirectional(
        storage, pending, local, strategy, { ...options, logger: ctx.logger('sync') }, () => ctx.syncSupport.state, ctx.nativeCompression,
      ),
      uploadEnrichedChanges: (storage, changes, options, progress) => uploadEnrichedChanges(
        storage, changes, { ...options, logger: ctx.logger('sync') }, () => ctx.syncSupport.state, ctx.nativeCompression, progress,
      ),
      executeDownload: (storage, local, strategy, options) => executeDownload(
        storage, local, strategy, { ...options, logger: ctx.logger('sync') }, () => ctx.syncSupport.state, ctx.nativeCompression,
      ),
      downloadChanges: (storage, since, perDbSince, options) => downloadChanges(
        storage, since, perDbSince, { ...options, logger: ctx.logger('sync') }, () => ctx.syncSupport.state, ctx.nativeCompression,
      ),
      validateUploadSchemaCompatibility: (storage, manifest, options) =>
        validateUploadSchemaCompatibility(storage, manifest, { ...options, logger: ctx.logger('sync') }),
      uploadManifest: (storage, manifest, options) =>
        uploadManifest(storage, manifest, { ...options, logger: ctx.logger('sync') }, () => ctx.syncSupport.state),
      validateRemoteFormat: (storage, willWrite, options) =>
        validateRemoteFormat(storage, willWrite, { ...options, logger: ctx.logger('sync') }),
      detectChangeLogGaps: (storage, options, openState) =>
        detectChangeLogGaps(storage, { ...options, logger: ctx.logger('sync') }, openState),
      parseHlc: Hlc.parse,
      createHlc: (millis, counter) => new Hlc(millis, counter),
      countRecordConflicts: () => countRecordConflicts(ctx.storage),
      discardQuarantine: (name, id) => discardOne(ctx.storage, name, id),
      discardAllQuarantine: () => discardAll(ctx.storage),
      getSyncStatus: () => {
        ctx.logger('sync').debug('[data_governance] 获取同步状态');
        assertNotInMaintenance(ctx);
        return getSyncStatus(ctx.storage, ctx.paths, ctx.logger('sync'));
      },
      listSyncSnapshotBatches: limit => listSyncSnapshotBatches(ctx.storage, limit),
      purgeResolvedConflicts: days => purgeResolvedConflicts(ctx.storage, days),
      listQuarantine: (limit, offset) => listQuarantine(ctx.storage, limit, offset),
      listRecordConflicts: (limit, offset) => listRecordConflicts(ctx.storage, limit, offset),
      resolveConflicts: (strategy, cloudManifestJson) => resolveConflicts(strategy, cloudManifestJson, () => {
        ctx.logger('sync').info(`[data_governance] 开始解决冲突，策略: ${strategy}`);
        assertNotInMaintenance(ctx);
      }),
      retryQuarantine: (databaseName, quarantineId) => retryQuarantine(ctx.storage, ctx.paths, databaseName, quarantineId),
      retryAllQuarantine: () => retryAllQuarantine(ctx.storage, ctx.paths),
      exportSyncData: outputPath => exportSyncData(ctx.storage, ctx.paths, outputPath, ctx.logger('sync')),
      cancelSync: () => {
        const cancelled = cancelActiveSync();
        if (cancelled) ctx.logger('sync').info('[data_governance] 用户请求取消同步');
        return cancelled;
      },
      createProgressEmitter: () => new SyncProgressEmitter(ctx.backendEvents, message => ctx.logger.error(message)),

      applyDownloadedChanges: (db, changes, options) => applyDownloadedChanges(db, changes, {
        deviceId: options.deviceId,
        idColumnMap: options.idColumnMap ?? null,
        allowSyncTestFixtureTables: options.allowSyncTestFixtureTables,
        logger: ctx.logger('sync'),
      }),
      applyDownloadedChangesWithConflictGuard: (db, changes, options, guard) =>
        applyDownloadedChangesWithConflictGuard(db, changes, {
          deviceId: options.deviceId,
          idColumnMap: options.idColumnMap ?? null,
          allowSyncTestFixtureTables: options.allowSyncTestFixtureTables,
          logger: ctx.logger('sync'),
        }, guard),
      applyDownloadedChangesForceExactWithHooks: (db, changes, options, hooks) =>
        applyDownloadedChangesForceExactWithHooks(db, changes, {
          deviceId: options.deviceId,
          idColumnMap: options.idColumnMap ?? null,
          allowSyncTestFixtureTables: options.allowSyncTestFixtureTables,
          logger: ctx.logger('sync'),
        }, hooks),
      getPendingChanges: (db, tableFilter, limit) => getPendingChanges(db, tableFilter, limit),
      filterPendingChangesForDatabase: (pending, databaseName) =>
        filterPendingChangesForDatabase(pending, databaseName),
      enrichChangesWithData: (db, entries, idColumnMap) => enrichChangesWithData(db, entries, idColumnMap),
      getRecordData: (db, tableName, recordId, idColumn) =>
        getRecordData(db, tableName, recordId, idColumn) as ReturnType<SyncService['getRecordData']>,
      recordsSemanticallyEqualForSync: (local, cloud) =>
        recordsSemanticallyEqualForSync(local as never, cloud as never),
      getDatabaseSyncState: (db, databaseName) => getDatabaseSyncState(db, databaseName),
      resetSyncBaselineAfterRestore: db => resetSyncBaselineAfterRestore(db),
      markSyncedWithTimestamp: (db, changeIds) => markSyncedWithTimestamp(db, changeIds),
      cleanupSyncedChanges: (db, olderThan) => cleanupSyncedChanges(db, olderThan),
      rollbackBatch: (db, batchId, idColumnMap, databaseName) =>
        rollbackBatch(db, batchId, idColumnMap ?? null, databaseName ?? null),
      hasPruneGap: (sinceVersion, minAvailableVersion) =>
        hasPruneGap(sinceVersion, minAvailableVersion ?? null),
      detectConflicts: (local, cloud) => detectConflicts(local, cloud),
      applyMergeStrategy: (strategy, conflicts) => applyMergeStrategy(strategy, conflicts),
    };
    ctx.reflect.provide('sync', service);
    type RunArgs = { direction: string; cloudConfig?: CloudStorageConfig | null; strategy?: string | null };
    ctx.commands.register<RunArgs>('data_governance_run_sync', ({ direction, cloudConfig, strategy }, call) =>
      runUntilPluginStops(call.signal, disposed.signal, signal => service.runSync(direction, cloudConfig, strategy, signal)));
    ctx.commands.register<RunArgs>('data_governance_run_sync_with_progress', ({ direction, cloudConfig, strategy }, call) =>
      runUntilPluginStops(call.signal, disposed.signal, signal => service.runSyncWithProgress(direction, cloudConfig, strategy, signal)));
    ctx.commands.register<{ cloudConfig: CloudStorageConfig; hash: string; relativePath?: string | null; size?: number | null }>(
      'data_governance_mark_blob_deleted', ({ cloudConfig, hash, relativePath, size }) => service.markBlobDeleted(cloudConfig, hash, relativePath ?? null, size == null ? null : BigInt(size)));
    ctx.commands.register<{ cloudConfig: CloudStorageConfig; key: string; size?: number | null }>(
      'data_governance_mark_asset_deleted', ({ cloudConfig, key, size }) => service.markAssetDeleted(cloudConfig, key, size == null ? null : BigInt(size)));
    ctx.commands.register<{ cloudConfig: CloudStorageConfig }>('data_governance_list_unsynced_items', ({ cloudConfig }) => service.listUnsyncedItems(cloudConfig));
    ctx.commands.register<{ inputPath: string; strategy?: string | null }, SyncImportResponse>('data_governance_import_sync_data',
      ({ inputPath, strategy }) => service.importSyncData(inputPath, strategy));
    ctx.commands.register<ResolveConflictArgs, void>('data_governance_resolve_record_conflict', args => service.resolveRecordConflict(args));
    ctx.commands.register<{ databaseName: string; batchId: string }, RollbackSnapshotResponse>('data_governance_rollback_sync_snapshot_batch',
      ({ databaseName, batchId }) => service.rollbackSyncSnapshotBatch(databaseName, batchId));
    ctx.commands.register('data_governance_count_record_conflicts', () => service.countRecordConflicts());
    ctx.commands.register<{ databaseName: string; quarantineId: number }, boolean>('data_governance_discard_quarantine',
      ({ databaseName, quarantineId }) => service.discardQuarantine(databaseName, quarantineId));
    ctx.commands.register('data_governance_discard_all_quarantine', () => service.discardAllQuarantine());
    ctx.commands.register('data_governance_get_sync_status', () => service.getSyncStatus());
    ctx.commands.register<{ limit?: number | null }, SyncSnapshotBatchRow[]>('data_governance_list_sync_snapshot_batches',
      ({ limit }) => service.listSyncSnapshotBatches(limit));
    ctx.commands.register<{ olderThanDays?: number | null }, number>('data_governance_purge_resolved_conflicts',
      ({ olderThanDays }) => service.purgeResolvedConflicts(olderThanDays));
    ctx.commands.register<{ limit?: number | null; offset?: number | null }, SyncQuarantineRow[]>('data_governance_list_quarantine',
      ({ limit, offset }) => service.listQuarantine(limit, offset));
    ctx.commands.register<{ limit?: number | null; offset?: number | null }, RecordConflictRow[]>('data_governance_list_record_conflicts',
      ({ limit, offset }) => service.listRecordConflicts(limit, offset));
    ctx.commands.register<{ strategy: string; cloudManifestJson: string }, never>('data_governance_resolve_conflicts',
      ({ strategy, cloudManifestJson }) => service.resolveConflicts(strategy, cloudManifestJson));
    ctx.commands.register<{ databaseName: string; quarantineId: number }, boolean>('data_governance_retry_quarantine',
      ({ databaseName, quarantineId }) => service.retryQuarantine(databaseName, quarantineId));
    ctx.commands.register<Record<string, never>, BatchQuarantineResult>('data_governance_retry_all_quarantine',
      () => service.retryAllQuarantine());
    ctx.commands.register<{ outputPath?: string | null }, SyncExportResponse>('data_governance_export_sync_data',
      ({ outputPath }) => service.exportSyncData(outputPath));
    ctx.commands.register('data_governance_cancel_sync', () => service.cancelSync());
    ctx.commands.register<{ cloudConfig: CloudStorageConfig }, RepoCheckReport>('data_governance_repo_check',
      ({ cloudConfig }) => repoCheck(ctx, cloudConfig));
    ctx.commands.register<{ cloudConfig: CloudStorageConfig }>('data_governance_detect_prune_gap',
      ({ cloudConfig }) => detectPruneGap(ctx, cloudConfig));
    ctx.commands.register<{ cloudManifestJson?: string | null; cloudConfig?: CloudStorageConfig | null }, ConflictDetectionResponse>('data_governance_detect_conflicts',
      args => detectSyncConflicts(ctx, args));
  },
});
}
