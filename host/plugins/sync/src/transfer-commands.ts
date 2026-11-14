/**
 * `data_governance_export_sync_data` / `data_governance_import_sync_data` 移植。
 *
 * 导出：逐库读取状态与待同步变更（含完整记录数据），按 serde pretty 风格写盘。
 * 导入：读取同步包，按策略路由到各库（冲突保护 + 隔离区重放），返回统计。
 */
import { rustTrim, decodeUtf8Strict } from '../../../platform/util/index.ts';
import { ioMessage } from '../../../platform/paths/io-error.ts';
import { parseSyncManifest } from './remote-manifest.ts';
import { dirname, join } from '../../../platform/util/path.ts';
import { CommandError } from '../../../kernel/api.ts';
import { utf8Encode } from '../../../platform/crypto/encoding.ts';
import { fs } from './local-runtime.ts';
import type { CoordinatedDatabaseName, DatabaseHandle, StorageService } from '../../../platform/storage/api.ts';
import type { PathsService } from '../../../platform/paths/api.ts';
import { isVirtualUri, rejectDoubleEncodedVirtualUri } from '../../../platform/storage/file-names.ts';
import type { SyncExportResponse, SyncImportResponse } from '../api.ts';
import type { EngineChange } from '../src/change-payload.ts';
import { parseSyncChange } from '../src/change-payload.ts';
import type { SyncLogger } from '../src/log.ts';
import { filterPendingChangesForDatabase, pendingHasChanges } from '../src/change-log.ts';
import { rowSyncTables } from '../src/classification.ts';
import { isJsonObject, jsonChunksLossless, parseJsonLossless, stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import { createManifest, detectConflicts, totalConflicts, type DatabaseSyncState, type SyncManifest } from '../src/merge.ts';
import { toRfc3339 as nowRfc3339 } from '../../../platform/time/index.ts';
import { enrichChangesWithData, getDatabaseSyncState } from '../repository/record-data.ts';
import { getPendingChanges } from '../repository/change-log.ts';
import { applyDownloadedChangesToDatabases, type MasteryHooks } from '../repository/apply-databases.ts';

const databases: readonly CoordinatedDatabaseName[] = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function open(storage: StorageService, name: CoordinatedDatabaseName): DatabaseHandle {
  const path = storage.pathOf(name);
  if (!fs.existsSync(dirname(path))) throw new Error(`unable to open database file: ${path}`);
  return storage.openFile(path, { profile: 'plain' });
}

function validateUserPath(value: string): void {
  if (value.includes('\0')) throw new CommandError('路径中不允许包含 null 字节');
  const normalized = value.replaceAll('\\', '/');
  if (normalized.split('/').includes('..')) {
    throw new CommandError("路径中不允许包含 '..' 目录遍历");
  }
}

function idColumnMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of rowSyncTables()) {
    const primaryKey = rustTrim(entry.primary_key);
    if (primaryKey === '' || primaryKey === '(virtual)' || primaryKey.includes(',')) continue;
    if (primaryKey !== 'id') map.set(entry.table_name, primaryKey);
  }
  return map;
}

export function collectLocalManifest(
  storage: StorageService,
  deviceId: string,
  withChanges: boolean,
  logger?: SyncLogger | null,
): { manifest: SyncManifest; changes: EngineChange[] } {
  const localDatabases: Record<string, DatabaseSyncState> = {};
  const changes: EngineChange[] = [];
  const idColumns = idColumnMap();
  for (const name of databases) {
    const path = storage.pathOf(name);
    if (!fs.existsSync(path)) continue;
    let db: DatabaseHandle;
    try {
      db = open(storage, name);
    } catch {
      // boundary-allow empty-catch: Rust 用 `if let Ok(conn)` 跳过无法打开的库，且不记录日志。
      continue;
    }
    try {
      try {
        const state = getDatabaseSyncState(db, name);
        localDatabases[name] = {
          schema_version: state.schema_version,
          data_version: state.data_version,
          checksum: state.checksum,
          last_updated_at: state.last_updated_at,
        };
      } catch { // boundary-allow empty-catch: Rust 用 `if let Ok(state)` 跳过状态读取失败，且不记录日志。
      }
      if (!withChanges) continue;
      try {
        const pending = filterPendingChangesForDatabase(getPendingChanges(db, null, null), name);
        if (!pendingHasChanges(pending)) continue;
        try {
          const enriched = enrichChangesWithData(db, pending.entries, idColumns);
          for (const change of enriched) {
            change.database_name = name;
            changes.push(change);
          }
        } catch (error) {
          // Rust warn! 后继续导出。
          logger?.warn(`[data_governance] 补全数据库 ${name} 变更数据失败: ${message(error)}`);
        }
      } catch { // boundary-allow empty-catch: Rust 用 `if let Ok(pending)` 跳过待同步查询失败，且不记录日志。
      }
    } finally {
      storage.close(db);
    }
  }
  return { manifest: createManifest(deviceId, localDatabases), changes };
}

/** `data_governance_export_sync_data`（commands_sync.rs:2369）。 */
export async function exportSyncData(
  storage: StorageService,
  paths: PathsService,
  outputPath?: string | null,
  logger?: SyncLogger | null,
): Promise<SyncExportResponse> {
  logger?.info('[data_governance] 导出同步数据');
  const deviceId = await paths.deviceId();
  const { manifest, changes } = collectLocalManifest(storage, deviceId, true, logger);
  const exportData: SyncExportData = {
    manifest,
    pending_changes: changes,
    exported_at: nowRfc3339(),
  };

  let output: string;
  if (outputPath !== null && outputPath !== undefined) {
    try {
      rejectDoubleEncodedVirtualUri(outputPath);
    } catch (error) {
      throw new CommandError(message(error));
    }
    if (isVirtualUri(outputPath)) {
      throw new CommandError(`无法写入目标 URI: Electron 宿主不支持虚拟路径 ${outputPath}`);
    }
    validateUserPath(outputPath);
    output = outputPath;
  } else {
    output = join(storage.locations.activeDir, 'sync_export.json');
  }

  try {
    fs.mkdirSync(dirname(output), { recursive: true });
  } catch (error) {
    throw new CommandError(`创建目录失败: ${message(error)}`);
  }

  writeSyncExportData(output, exportData);
  logger?.info(`[data_governance] 同步数据已导出: path=${output}, changes=${changes.length}`);

  return {
    success: true,
    output_path: output,
    manifest_databases: Object.keys(manifest.databases).length,
    pending_changes_count: changes.length,
  };
}

export interface SyncExportData {
  manifest: SyncManifest;
  pending_changes: EngineChange[];
  exported_at: string;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`缺少必填字段 ${field}`);
  return value;
}

function parseImportData(text: string): SyncExportData {
  const parsed = parseJsonLossless(text);
  if (!isJsonObject(parsed)) throw new Error('导入数据不是 JSON 对象');
  if (!isJsonObject(parsed.manifest)) throw new Error('缺少必填字段 manifest');
  const manifest = parseSyncManifest(stringifyJsonLossless(parsed.manifest));

  if (!Array.isArray(parsed.pending_changes)) throw new Error('缺少必填字段 pending_changes');
  const changes: EngineChange[] = [];
  for (const value of parsed.pending_changes) {
    if (!isJsonObject(value)) throw new Error('pending_changes 条目不是 JSON 对象');
    changes.push(parseSyncChange(stringifyJsonLossless(value)));
  }
  return { manifest, pending_changes: changes, exported_at: requireString(parsed.exported_at, 'exported_at') };
}

/** commands_sync.rs:2518: create precedes serialization; IO and encoding errors differ. */
export function writeSyncExportData(path: string, data: SyncExportData): void {
  let fd: number;
  try { fd = fs.openSync(path, 'w'); }
  catch (error) { throw new CommandError(`写入文件失败: ${ioMessage(error)}`); }
  try {
    const buffer = new Uint8Array(8192);
    let used = 0;
    const flush = () => {
      try {
        for (let offset = 0; offset < used;) offset += fs.writeSync(fd, buffer, offset, used - offset);
        used = 0;
      } catch (error) { throw new CommandError(`写入文件失败: ${ioMessage(error)}`); }
    };
    try {
      for (const token of jsonChunksLossless(data as unknown as DbJson, true)) {
        const bytes = utf8Encode(token);
        for (let offset = 0; offset < bytes.length;) {
          const count = Math.min(bytes.length - offset, buffer.length - used);
          buffer.set(bytes.subarray(offset, offset + count), used);
          used += count;
          offset += count;
          if (used === buffer.length) flush();
        }
      }
    } catch (error) {
      if (error instanceof CommandError) throw error;
      throw new CommandError(`序列化导出数据失败: ${message(error)}`);
    }
    flush();
  } finally {
    try { fs.closeSync(fd); }
    catch { // boundary-allow empty-catch: Rust File Drop ignores close errors after the explicit writer flush.
    }
  }
}

/** commands_sync.rs:2535: preserve read/parse categories and full record payloads. */
export function readSyncImportData(path: string): SyncExportData {
  let bytes: Uint8Array;
  try { bytes = fs.readFileSync(path); }
  catch (error) { throw new CommandError(`读取文件失败: ${ioMessage(error)}`); }
  try { return parseImportData(decodeUtf8Strict(bytes)); }
  catch (error) { throw new CommandError(`解析导入数据失败: ${message(error)}`); }
}

/** `data_governance_import_sync_data`（commands_sync.rs:2571）。 */
export async function importSyncData(
  storage: StorageService,
  paths: PathsService,
  inputPath: string,
  strategy: string | null | undefined,
  mastery?: MasteryHooks,
  logger?: SyncLogger | null,
): Promise<SyncImportResponse> {
  try {
    rejectDoubleEncodedVirtualUri(inputPath);
  } catch (error) {
    throw new CommandError(message(error));
  }
  if (isVirtualUri(inputPath)) {
    throw new CommandError(`无法读取导入文件: Electron 宿主不支持虚拟路径 ${inputPath}`);
  }
  validateUserPath(inputPath);

  const importData = readSyncImportData(inputPath);

  const deviceId = await paths.deviceId();
  const local = collectLocalManifest(storage, deviceId, false, logger);
  const detection = detectConflicts(local.manifest, importData.manifest);

  let mergeStrategy: 'KeepLocal' | 'UseCloud' | 'KeepLatest' | 'Manual';
  const rawStrategy = strategy ?? 'keep_latest';
  switch (rawStrategy) {
    case 'keep_local': mergeStrategy = 'KeepLocal'; break;
    case 'use_cloud': mergeStrategy = 'UseCloud'; break;
    case 'keep_latest': mergeStrategy = 'KeepLatest'; break;
    case 'manual': mergeStrategy = 'Manual'; break;
    default:
      throw new CommandError(
        `无效的合并策略: ${rawStrategy}。可选值: keep_local, use_cloud, keep_latest, manual`,
      );
  }

  let importedChanges = 0;
  let incompleteSkipped = 0;
  let failed = 0;
  let recordConflicts = 0;
  if (importData.pending_changes.length > 0) {
    let applied;
    try {
      applied = applyDownloadedChangesToDatabases(
        storage,
        importData.pending_changes,
        mergeStrategy,
        deviceId,
        mastery,
        logger,
      );
    } catch (error) {
      logger?.error(`[data_governance] 应用导入变更失败: ${message(error)}`);
      throw new CommandError(`应用导入变更失败: ${message(error)}。请检查导入文件完整性后重试`);
    }
    importedChanges = applied.total_success;
    incompleteSkipped = applied.total_incomplete_skipped;
    failed = applied.total_failed;
    recordConflicts = applied.total_conflicts;
    logger?.info(`[data_governance] 导入变更应用完成: applied=${importedChanges}, failed=${failed}, skipped=${applied.total_skipped}`);
  }

  logger?.info(`[data_governance] 同步数据导入完成: applied=${importedChanges}, failed=${failed}, conflicts=${totalConflicts(detection)}`);

  let errorMessage: string | null = null;
  if (recordConflicts > 0 && mergeStrategy === 'Manual') {
    errorMessage = `已保留本地数据并记录 ${recordConflicts} 个冲突快照，请在冲突面板逐条裁决。`;
  } else if (failed > 0) {
    errorMessage = `${failed}条变更应用失败`;
  } else if (incompleteSkipped > 0) {
    errorMessage = `导入已完成，但有 ${incompleteSkipped} 条变更因数据不完整被跳过。建议在源设备重新导出完整同步数据。`;
  }

  return {
    success: failed === 0,
    imported_changes: importedChanges,
    conflicts_detected: Math.max(recordConflicts, totalConflicts(detection)),
    needs_manual_resolution: mergeStrategy === 'Manual' && recordConflicts > 0,
    error_message: errorMessage,
  };
}
