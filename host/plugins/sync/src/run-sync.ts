import { syncGovernance } from '../../backup/api.ts';
/** commands_sync.rs:1586-2317,2859-3364. Registered through the published command-level ports. */
import { join } from '../../../platform/util/path.ts';
import { fs } from './local-runtime.ts';
import { fromHex } from '../../../platform/crypto/encoding.ts';
import { CommandError } from '../../../kernel/api.ts';
import { acquireSyncTargetLease, providerKey, type RuntimeCloudStorageConfig, type CloudStorage, type SyncTargetLeaseGuard } from '../../sync-providers/api.ts';
import type { SyncExecutionResponse } from '../../../../contracts/ipc/generated/L20-sync.ts';
import type { SyncContext } from './dependencies.ts';
import { assembleSyncCommandPorts, type LocalSyncCommandPorts } from './sync-command-needs.ts';
import type { FileSyncDirection } from './workspace-sync.ts';
import type { MergeStrategy } from './merge.ts';
import type { SyncExecutionResult } from './execute-download.ts';
import { SyncProgressEmitter, OptionalEmitter, setStatusSink, clearStatusSink, reportSyncStatus } from './emitter.ts';
import { installSyncCancelSlot, clearSyncCancelSlot } from './cancellation.ts';
import { assertNotInMaintenance } from './cloud-runtime.ts';
import { createPayloadCodec, type FilePayloadCodec } from './payload.ts';
import { validateRemoteFormat } from './remote-format.ts';
import { validateUploadSchemaCompatibility } from './manifest-upload.ts';
import { enforceRecordUploadEncryptionPolicyForConfig } from './upload-policy.ts';
import { validateSyncRegistryDrift } from '../repository/registry-preflight.ts';
import { collectLocalManifest } from './transfer-commands.ts';
import { collectFullSnapshotChanges, collectSyncChanges } from './collect-sync-changes.ts';
import { executeDownloadWithProgress, executeBidirectionalWithProgress, type SyncPassOptions } from './record-progress.ts';
import { executeUploadWithProgress } from './record-upload-progress.ts';
import { executePlainSync } from './record-plain.ts';
import { SyncV5RuntimeCoordinator, storageWithV5Ranges } from './v5-runtime-bridge.ts';
import type { PairingSettings } from './device-pairing.ts';
import { tableExists } from '../repository/sqlite-values.ts';
import type { CoordinatedDatabaseName, StorageService } from '../../../platform/storage/api.ts';

function countUnresolvedQuarantine(localStorage: StorageService): number {
  const dbNames: readonly CoordinatedDatabaseName[] = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];
  let count = 0;
  for (const name of dbNames) {
    const path = localStorage.pathOf(name);
    if (!fs.existsSync(path)) continue;
    let db;
    try { db = localStorage.openFile(path, { profile: 'plain' }); }
    catch { continue; }
    try {
      if (!tableExists(db, '__sync_quarantine')) continue;
      count += Number(db.pluck<number | bigint>('SELECT COUNT(*) FROM __sync_quarantine') ?? 0);
    } catch {
      // ignore read errors on optional quarantine check
    } finally {
      localStorage.close(db);
    }
  }
  return count;
}

function appendQuarantineVisibilityWarning(result: SyncExecutionResult, quarantineCount: number): void {
  if (quarantineCount <= 0) return;
  const notice = `同步部分完成：${quarantineCount} 条变更应用失败（详见隔离区）`;
  if (!result.error_message) {
    result.error_message = notice;
  } else if (!result.error_message.includes('隔离区')) {
    result.error_message = `${result.error_message}；${notice}`;
  }
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const notConfigured = 'Cloud storage is not configured. Save a cloud config in Settings first.';
export const LAST_SYNC_AT_SETTING_KEY = 'data_governance.last_sync_at';
export const FULL_SNAPSHOT_PUSH_SETTING_KEY = 'data_governance.pending_full_snapshot_push';

function consumeFullSnapshotPushFlag(ctx: SyncContext): boolean {
  try {
    const settings = ctx.reflect?.get?.('settings') as {
      get?: (key: string) => string | null;
      save?: (key: string, value: string) => void;
      delete?: (key: string) => void;
    } | undefined;
    if (!settings || typeof settings.get !== 'function') return false;
    const raw = settings.get(FULL_SNAPSHOT_PUSH_SETTING_KEY);
    if (!raw || raw.trim() === '' || raw === 'false' || raw === '0') return false;
    try {
      if (typeof settings.delete === 'function') settings.delete(FULL_SNAPSHOT_PUSH_SETTING_KEY);
      else settings.save?.(FULL_SNAPSHOT_PUSH_SETTING_KEY, '');
    } catch {
      // ignore setting cleanup errors
    }
    return true;
  } catch {
    return false;
  }
}

export function persistLastSyncAt(ctx: SyncContext): void {
  try {
    const settings = ctx.reflect?.get?.('settings') as {
      save?: (key: string, value: string) => void;
      set?: (key: string, value: string) => void;
    } | undefined;
    const timestamp = new Date().toISOString();
    if (settings && typeof settings.save === 'function') {
      settings.save(LAST_SYNC_AT_SETTING_KEY, timestamp);
    } else if (settings && typeof settings.set === 'function') {
      settings.set(LAST_SYNC_AT_SETTING_KEY, timestamp);
    }
  } catch {
    // Never fail completed sync or break test fixtures without SettingsStore.
  }
}

/**
 * 浏览器/移动端切后台会冻结定时器，心跳续租停摆超过 TTL 后云端租约已被其他设备取走；
 * 恢复后继续上传/提交就是把云端当成自己的盲写。每个远端写入步骤前都必须确认
 * `heartbeatFailure()` 为空，非空立即中止本轮同步（failed，等待下一轮重新争租约）。
 */
function assertLeaseHeartbeatHealthy(lease: SyncTargetLeaseGuard | null): void {
  const failure = lease === null ? null : lease.heartbeatFailure();
  if (failure === null || failure === undefined) return;
  throw new Error(`同步租约心跳已失效，已中止本轮远端写入以防盲写云端: ${message(failure)}`);
}

/** Explicit V5 production entry; existing legacy commands keep their wire format. */
export async function runSyncV5(
  ctx: SyncContext, localPorts: LocalSyncCommandPorts, direction: string,
  cloudConfig: RuntimeCloudStorageConfig | null = null, signal: AbortSignal | null = null,
): Promise<SyncExecutionResponse> {
  assertNotInMaintenance(ctx);
  const ports = assembleSyncCommandPorts(ctx, localPorts);
  const parsed = parseSyncDirection(direction);
  const permit = ports.limiter.tryAcquire();
  if (!permit) throw new CommandError('另一个数据治理任务（同步/备份/恢复）正在进行中，请稍后再试。');
  const start = performance.now(), controller = new AbortController();
  const cancel = () => controller.abort();
  let deviceId = '', lease: SyncTargetLeaseGuard | null = null;
  const target = `cloud_sync/v5/${parsed.toLowerCase()}`;
  try {
    ctx.syncProvider.setCancelToken(controller.signal);
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
    const checkCancelled = () => { if (controller.signal.aborted || ctx.syncProvider.isSyncCancelled()) throw new Error('同步已取消'); };
    checkCancelled();
    const config = cloudConfig ?? await ports.loadHydratedCloudConfig();
    if (!config) throw new Error(notConfigured);
    await syncGovernance(ctx).hydrateCloudConfig(config);
    deviceId = await ctx.paths.deviceId();
    ports.saveSyncAudit({ direction: parsed, recordsAffected: 0, target, outcome: { kind: 'started' }, details: { device_id: deviceId, protocol: 'v5' } });
    const settings = ctx.reflect.get('settings') as PairingSettings;
    const encodedRoot = await settings.getSecret('cloud_sync.v5_root');
    if (!encodedRoot) throw new Error('V5 repository keys are not configured. Pair this device first.');
    const root = JSON.parse(encodedRoot) as { repoId: string; kCid: string; masterKeys: [number, string][]; contentEpoch: number };
    const storage = storageWithV5Ranges(await ctx.syncProvider.createStorage(config));
    lease = await acquireSyncTargetLease(storage, deviceId);
    checkCancelled();
    const names: CoordinatedDatabaseName[] = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];
    const databases = new Map(names.map(name => [name, ctx.storage.database(name)]));
    const runtime = new SyncV5RuntimeCoordinator({ repoId: root.repoId, deviceId, stateDb: ctx.storage.database('sync_state'), databases, storage,
      secrets: { kCid: fromHex(root.kCid), masterKeys: new Map(root.masterKeys.map(([epoch, key]) => [epoch, fromHex(key)])) }, contentEpoch: root.contentEpoch });
    let uploaded = 0, downloaded = 0, skipped = 0;
    if (parsed !== 'Download') {
      const changes = await collectSyncChanges(ctx.storage, null);
      checkCancelled();
      assertLeaseHeartbeatHealthy(lease);
      const publication = await runtime.publishChangesToV5Cloud(changes, { isolateOversize: true });
      uploaded = publication.published;
      skipped = publication.quarantinedOversize ?? 0;
      // The head is durable; isolated log IDs are archived too, with their durable quarantine retained.
      for (const name of names) {
        const ids = changes.filter(change => (change.database_name ?? 'vfs') === name && change.change_log_id != null).map(change => change.change_log_id!);
        if (ids.length) ctx.sync.markSyncedWithTimestamp(databases.get(name)!, ids);
      }
    }
    checkCancelled();
    if (parsed !== 'Upload') {
      assertLeaseHeartbeatHealthy(lease);
      downloaded = (await runtime.pullAndApplyFromV5Cloud()).applied;
    }
    checkCancelled();
    persistLastSyncAt(ctx);
    const duration = Math.floor(performance.now() - start);
    ports.saveSyncAudit({ direction: parsed, recordsAffected: uploaded + downloaded, target, outcome: { kind: 'complete', durationMs: duration },
      details: { device_id: deviceId, protocol: 'v5', changes_uploaded: uploaded, changes_downloaded: downloaded } });
    return { success: true, direction: parsed.toLowerCase(), device_id: deviceId, changes_uploaded: uploaded, changes_downloaded: downloaded,
      conflicts_detected: 0, duration_ms: duration, error_message: null, skipped_changes: skipped };
  } catch (error) {
    ports.saveSyncAudit({ direction: parsed, recordsAffected: 0, target, outcome: { kind: 'failed', error: message(error) }, details: { device_id: deviceId, protocol: 'v5' } });
    throw error instanceof CommandError ? error : new CommandError(message(error));
  } finally {
    signal?.removeEventListener('abort', cancel);
    ctx.syncProvider.clearCancelToken();
    try { await lease?.release(); }
    catch (error) { ctx.logger('sync').warn(`[sync-v5] 释放同步租约失败: ${message(error)}`); }
    permit.release();
  }
}
export function parseSyncDirection(direction: string): FileSyncDirection {
  switch (direction.toLowerCase()) {
    case 'upload': return 'Upload'; case 'download': return 'Download'; case 'bidirectional': case 'both': return 'Bidirectional';
    default: throw new Error(`无效的同步方向: ${direction}。可选值: upload, download, bidirectional`);
  }
}
export function parseSyncStrategy(strategy: string | null | undefined): MergeStrategy {
  switch (strategy ?? 'keep_latest') {
    case 'keep_local': return 'KeepLocal'; case 'use_cloud': return 'UseCloud'; case 'keep_latest': return 'KeepLatest'; case 'manual': return 'Manual';
    default: throw new Error(`无效的合并策略: ${strategy}。可选值: keep_local, use_cloud, keep_latest, manual`);
  }
}

/**
 * commands_sync.rs:1586-2317: unlike the progress command, engine `?` errors reject. Rust installs no user cancel token
 * here; `signal` (plugin stop, a caller dropping the run) reaches the provider cancellation points through a run-local one.
 */
export async function runSync(
  ctx: SyncContext, localPorts: LocalSyncCommandPorts, direction: string, cloudConfig: RuntimeCloudStorageConfig | null, strategy: string | null,
  signal: AbortSignal | null = null, mobile = false,
): Promise<SyncExecutionResponse> {
  const logger = ctx.logger('sync');
  logger.info(`[data_governance] 开始执行同步: direction=${direction}, strategy=${strategy === null ? 'None' : `Some(${JSON.stringify(strategy)})`}`);
  assertNotInMaintenance(ctx);
  const ports = assembleSyncCommandPorts(ctx, localPorts);
  const start = performance.now();
  let parsed: FileSyncDirection, merge: MergeStrategy, config: RuntimeCloudStorageConfig;
  try {
    parsed = parseSyncDirection(direction); merge = parseSyncStrategy(strategy);
    const loaded = cloudConfig ?? await ports.loadHydratedCloudConfig();
    if (loaded === null) throw new Error(notConfigured); config = loaded;
  } catch (error) { throw new CommandError(message(error)); }
  await syncGovernance(ctx).hydrateCloudConfig(config);
  const deviceId = await ctx.paths.deviceId();
  ports.saveSyncAudit({ direction: parsed, recordsAffected: 0, target: `cloud_sync/${parsed.toLowerCase()}`, outcome: { kind: 'started' }, details: {
    device_id: deviceId, direction, strategy: strategy ?? 'keep_latest', provider: { webdav: 'WebDav', s3: 'S3', ftp: 'Ftp' }[providerKey(config.provider ?? 'webdav')], root: config.root ?? null,
  } });
  let permit;
  try { permit = ports.limiter.tryAcquire(); }
  catch (error) {
    ports.saveSyncAudit({ direction: parsed, recordsAffected: 0, target: `cloud_sync/${parsed.toLowerCase()}`,
      outcome: { kind: 'failed', error: message(error), durationMs: Math.floor(performance.now() - start) },
      details: { device_id: deviceId, direction: parsed.toLowerCase(), strategy: strategy ?? 'keep_latest' } });
    throw new CommandError(message(error));
  }
  if (permit === null) {
    const busy = '另一个数据治理任务（同步/备份/恢复）正在进行中，请稍后再试。';
    ports.saveSyncAudit({ direction: parsed, recordsAffected: 0, target: `cloud_sync/${parsed.toLowerCase()}`,
      outcome: { kind: 'failed', error: busy, durationMs: Math.floor(performance.now() - start) },
      details: { device_id: deviceId, direction: parsed.toLowerCase(), strategy: strategy ?? 'keep_latest' } });
    throw new CommandError(busy);
  }
  let codec: FilePayloadCodec | null = null, lease: SyncTargetLeaseGuard | null = null;
  const controller = new AbortController(), cancel = () => controller.abort();
  try {
    ctx.syncProvider.setCancelToken(controller.signal);
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
    let storage;
    try { storage = await ctx.syncProvider.createStorage(config); }
    catch (error) { throw new Error(`创建云存储失败: ${message(error)}`); }
    codec = await createPayloadCodec(ctx.secrets.backup, config.encryptionPassword);
    const deferredConflictKeys = new Set<string>();
    const options: SyncPassOptions = { deviceId, codec, logger, localStorage: ctx.storage, openState: () => ctx.syncSupport.state,
      settings: ctx.reflect.get('settings') as SyncPassOptions['settings'], appDataDir: ctx.paths.appDataDir, mobile,
      compression: ctx.nativeCompression,
      application: {
        apply: (changes, selected) => ctx.sync.applyDownloadedChangesToDatabases(changes, selected, {
          deferConflictingOverwrite: selected === 'KeepLatest' || selected === 'Manual',
          onDeferredConflict: key => deferredConflictKeys.add(key),
        }),
        consumeDeferredConflictKeys: () => {
          const copy = new Set(deferredConflictKeys);
          deferredConflictKeys.clear();
          return copy;
        },
      },
      tombstones: ports.tombstones, isCancelled: () => ctx.syncProvider.isSyncCancelled() };
    try { await validateRemoteFormat(storage, parsed !== 'Download', options); }
    catch (error) { throw new Error(`同步格式协商失败: ${message(error)}`); }
    lease = await acquireSyncTargetLease(storage, deviceId);
    if (parsed !== 'Download') await enforceRecordUploadEncryptionPolicyForConfig(ctx.syncProvider, config, deviceId,
      { backup: ctx.secrets.backup, encryptionMemoryPath: join(ctx.app.dataDir, '.cloud-encrypted-roots.json') });
    validateSyncRegistryDrift(ctx.storage);
    const local = collectLocalManifest(ctx.storage, deviceId, false).manifest;
    try { await validateUploadSchemaCompatibility(storage, local, options); }
    catch (error) { throw new Error(`同步 schema 预检失败: ${message(error)}`); }
    const pushSnapshot = parsed === 'Upload' && consumeFullSnapshotPushFlag(ctx);
    const enriched = pushSnapshot
      ? await collectFullSnapshotChanges(ctx.storage, null)
      : await collectSyncChanges(ctx.storage, null);
    assertLeaseHeartbeatHealthy(lease);
    const [result, skipped] = await executePlainSync(storage, enriched, local, parsed, merge, options, ports.workspaceCoordinator, start);
    const unresolvedQuarantine = parsed !== 'Upload' ? countUnresolvedQuarantine(ctx.storage) : 0;
    appendQuarantineVisibilityWarning(result, unresolvedQuarantine);
    if (result.success && result.error_message === null) persistLastSyncAt(ctx);
    else if (result.success) persistLastSyncAt(ctx);
    logger.info(`[data_governance] 同步完成: direction=${result.direction.toLowerCase()}, uploaded=${result.changes_uploaded}, downloaded=${result.changes_downloaded}, conflicts=${result.conflicts_detected}, skipped=${skipped}, duration=${result.duration_ms}ms`);
    ports.saveSyncAudit({ direction: result.direction, recordsAffected: result.changes_uploaded + result.changes_downloaded,
      target: `cloud_sync/${result.direction.toLowerCase()}`, outcome: result.success ? { kind: 'complete', durationMs: result.duration_ms } : { kind: 'failed', error: result.error_message ?? 'sync failed', durationMs: result.duration_ms },
      details: { device_id: deviceId, direction: result.direction.toLowerCase(), strategy: strategy ?? 'keep_latest', changes_uploaded: result.changes_uploaded,
        changes_downloaded: result.changes_downloaded, conflicts_detected: result.conflicts_detected, quarantined: unresolvedQuarantine } });
    return { ...result, direction: result.direction.toLowerCase(), device_id: deviceId, skipped_changes: skipped };
  } catch (error) {
    const detail = message(error);
    const duration = Math.floor(performance.now() - start);
    ports.saveSyncAudit({ direction: parsed, recordsAffected: 0, target: `cloud_sync/${parsed.toLowerCase()}`, outcome: { kind: 'failed', error: detail, durationMs: duration },
      details: { device_id: deviceId, direction: parsed.toLowerCase(), strategy: strategy ?? 'keep_latest' } });
    throw error instanceof CommandError ? error : new CommandError(detail);
  }
  finally {
    signal?.removeEventListener('abort', cancel); ctx.syncProvider.clearCancelToken();
    if (lease !== null) {
      try { await lease.release(); }
      catch (error) { logger.warn(`[data_governance] 释放同步目标租约失败，将等待 TTL 回收: ${message(error)}`); }
    }
    codec?.dispose(); permit.release();
  }
}
/** commands_sync.rs:2859-3364; `signal` cancels like data_governance_cancel_sync, which keeps working unchanged. */
export async function runSyncWithProgress(
  ctx: SyncContext, localPorts: LocalSyncCommandPorts, direction: string, cloudConfig: RuntimeCloudStorageConfig | null, strategy: string | null,
  signal: AbortSignal | null = null, mobile = false,
): Promise<SyncExecutionResponse> {
  const logger = ctx.logger('sync');
  logger.info(`[data_governance] 开始执行带进度的同步: direction=${direction}, strategy=${strategy === null ? 'None' : `Some(${JSON.stringify(strategy)})`}`);
  assertNotInMaintenance(ctx);
  const ports = assembleSyncCommandPorts(ctx, localPorts);
  const start = performance.now();
  const emitter = new SyncProgressEmitter(ctx.backendEvents, text => logger.error(text));
  let cancelTokenInstalled = false;
  let auditStarted = false;
  let auditParsed: FileSyncDirection | null = null;
  let auditDeviceId: string | null = null;
  const auditStrategy = strategy ?? 'keep_latest';
  const fail = async (error: unknown): Promise<never> => {
    const cancelled = cancelTokenInstalled && ctx.syncProvider.isSyncCancelled();
    const detail = cancelled ? '同步已取消' : message(error);
    await emitter.emitFailed(detail);
    if (auditStarted && auditParsed !== null) {
      const durationMs = Math.floor(performance.now() - start);
      ports.saveSyncAudit({
        direction: auditParsed,
        recordsAffected: 0,
        target: `cloud_sync/${auditParsed.toLowerCase()}`,
        outcome: cancelled ? { kind: 'cancelled', error: detail, durationMs } : { kind: 'failed', error: detail, durationMs },
        details: { device_id: auditDeviceId, direction: auditParsed.toLowerCase(), strategy: auditStrategy, with_progress: true, cancelled },
      });
    }
    throw new CommandError(detail);
  };
  let parsed: FileSyncDirection, merge: MergeStrategy, config: RuntimeCloudStorageConfig;
  try {
    parsed = parseSyncDirection(direction); merge = parseSyncStrategy(strategy);
    const loaded = cloudConfig ?? await ports.loadHydratedCloudConfig();
    if (loaded === null) throw new Error(notConfigured);
    config = loaded;
  } catch (error) { return fail(error); }
  await syncGovernance(ctx).hydrateCloudConfig(config);
  const deviceId = await ctx.paths.deviceId();
  auditParsed = parsed;
  auditDeviceId = deviceId;
  auditStarted = true;
  ports.saveSyncAudit({ direction: parsed, recordsAffected: 0, target: `cloud_sync/${parsed.toLowerCase()}`, outcome: { kind: 'started' }, details: {
    device_id: deviceId, direction, strategy: auditStrategy,
    provider: { webdav: 'WebDav', s3: 'S3', ftp: 'Ftp' }[providerKey(config.provider ?? 'webdav')], root: config.root ?? null, with_progress: true,
  } });
  let permit;
  try { permit = ports.limiter.tryAcquire(); }
  catch (error) { return fail(error); }
  if (permit === null) return fail(new Error('另一个数据治理任务（同步/备份/恢复）正在进行中，请稍后再试。'));
  const controller = new AbortController(), cancel = () => controller.abort();
  let hooks = false, codec: FilePayloadCodec | null = null, lease: SyncTargetLeaseGuard | null = null;
  try {
    await emitter.emitPreparing();
    ctx.syncProvider.setCancelToken(controller.signal); cancelTokenInstalled = true; installSyncCancelSlot(controller);
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
    ctx.syncProvider.setStatusHook(reportSyncStatus); setStatusSink(emitter); hooks = true;
    await emitter.emitDetectingChanges();
    let storage: CloudStorage;
    try { storage = await ctx.syncProvider.createStorage(config); }
    catch (error) { return fail(new Error(`创建云存储失败: ${message(error)}`)); }
    codec = await createPayloadCodec(ctx.secrets.backup, config.encryptionPassword);
    const deferredConflictKeys = new Set<string>();
    const options: SyncPassOptions = { deviceId, codec, logger, localStorage: ctx.storage, openState: () => ctx.syncSupport.state,
      settings: ctx.reflect.get('settings') as SyncPassOptions['settings'], appDataDir: ctx.paths.appDataDir, mobile,
      compression: ctx.nativeCompression,
      application: {
        apply: (changes, selected) => ctx.sync.applyDownloadedChangesToDatabases(changes, selected, {
          deferConflictingOverwrite: selected === 'KeepLatest' || selected === 'Manual',
          onDeferredConflict: key => deferredConflictKeys.add(key),
        }),
        consumeDeferredConflictKeys: () => {
          const copy = new Set(deferredConflictKeys);
          deferredConflictKeys.clear();
          return copy;
        },
      },
      tombstones: ports.tombstones,
      isCancelled: () => ctx.syncProvider.isSyncCancelled() };
    try { await validateRemoteFormat(storage, parsed !== 'Download', options); }
    catch (error) { return fail(new Error(`同步格式协商失败: ${message(error)}`)); }
    try { lease = await acquireSyncTargetLease(storage, deviceId); }
    catch (error) { return fail(error); }
    if (parsed !== 'Download') {
      try { await enforceRecordUploadEncryptionPolicyForConfig(ctx.syncProvider, config, deviceId,
        { backup: ctx.secrets.backup, encryptionMemoryPath: join(ctx.app.dataDir, '.cloud-encrypted-roots.json') }); }
      catch (error) { return fail(error); }
    }
    try { validateSyncRegistryDrift(ctx.storage); }
    catch (error) { return fail(error); }
    const local = collectLocalManifest(ctx.storage, deviceId, false).manifest;
    try { await validateUploadSchemaCompatibility(storage, local, options); }
    catch (error) { return fail(new Error(`同步 schema 预检失败: ${message(error)}`)); }
    let enriched;
    try {
      const pushSnapshot = parsed === 'Upload' && consumeFullSnapshotPushFlag(ctx);
      enriched = pushSnapshot
        ? await collectFullSnapshotChanges(ctx.storage, emitter)
        : await collectSyncChanges(ctx.storage, emitter);
    }
    catch (error) { return fail(error); }
    try { assertLeaseHeartbeatHealthy(lease); }
    catch (error) { return fail(error); }
    const optional = new OptionalEmitter(emitter);
    let result: SyncExecutionResult, skipped: number;
    try {
      if (parsed === 'Upload') [result, skipped] = await executeUploadWithProgress(storage, enriched, local, options, ports.workspaceCoordinator, optional);
      else if (parsed === 'Download') [result, skipped] = await executeDownloadWithProgress(storage, local, merge, options, ports.workspaceCoordinator, optional);
      else [result, skipped] = await executeBidirectionalWithProgress(storage, enriched,
        { total_count: enriched.length, entries: enriched.map(change => ({ id: change.change_log_id ?? 0 })) }, local, merge, options, ports.workspaceCoordinator, optional);
    } catch (error) {
      const cancelled = ctx.syncProvider.isSyncCancelled();
      const detail = cancelled ? '同步已取消' : message(error);
      const durationMs = Math.floor(performance.now() - start);
      await emitter.emitFailed(detail); logger.error(`[data_governance] 带进度同步失败: ${detail}`);
      ports.saveSyncAudit({ direction: parsed, recordsAffected: 0, target: `cloud_sync/${parsed.toLowerCase()}`,
        outcome: cancelled ? { kind: 'cancelled', error: detail, durationMs } : { kind: 'failed', error: detail, durationMs },
        details: { device_id: deviceId, direction: parsed.toLowerCase(), strategy: auditStrategy, with_progress: true, cancelled } });
      return { success: false, direction: parsed.toLowerCase(), changes_uploaded: 0, changes_downloaded: 0, conflicts_detected: 0,
        duration_ms: durationMs, device_id: deviceId, error_message: detail, skipped_changes: 0 };
    }
    const unresolvedQuarantine = parsed !== 'Upload' ? countUnresolvedQuarantine(ctx.storage) : 0;
    appendQuarantineVisibilityWarning(result, unresolvedQuarantine);
    if (result.success && result.error_message === null) {
      persistLastSyncAt(ctx);
      await emitter.emitCompleted();
    } else {
      if (result.success) persistLastSyncAt(ctx);
      await emitter.emitPartial(result.error_message ?? '同步未完全成功：部分步骤失败或有变更被跳过，请检查同步详情。');
    }
    logger.info(`[data_governance] 带进度同步完成: direction=${result.direction.toLowerCase()}, uploaded=${result.changes_uploaded}, downloaded=${result.changes_downloaded}, conflicts=${result.conflicts_detected}, skipped=${skipped}, duration=${result.duration_ms}ms`);
    ports.saveSyncAudit({ direction: result.direction, recordsAffected: result.changes_uploaded + result.changes_downloaded,
      target: `cloud_sync/${result.direction.toLowerCase()}`,
      outcome: result.success ? { kind: 'complete', durationMs: result.duration_ms } : { kind: 'failed', error: result.error_message ?? 'sync failed', durationMs: result.duration_ms },
      details: { device_id: deviceId, direction: result.direction.toLowerCase(), strategy: auditStrategy, changes_uploaded: result.changes_uploaded,
        changes_downloaded: result.changes_downloaded, conflicts_detected: result.conflicts_detected, skipped_changes: skipped, quarantined: unresolvedQuarantine, with_progress: true } });
    return { ...result, direction: result.direction.toLowerCase(), device_id: deviceId, skipped_changes: skipped };
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (hooks) { ctx.syncProvider.clearStatusHook(); ctx.syncProvider.clearCancelToken(); clearStatusSink(); clearSyncCancelSlot(controller); }
    else { ctx.syncProvider.clearCancelToken(); }
    if (lease !== null) {
      try { await lease.release(); }
      catch (error) { logger.warn(`[data_governance] 释放带进度同步目标租约失败，将等待 TTL 回收: ${message(error)}`); }
    }
    codec?.dispose();
    permit.release();
  }
}
