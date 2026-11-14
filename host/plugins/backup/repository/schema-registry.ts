import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { DATABASE_IDS, latestVersion, type CoordinatedId } from '../src/migrations.ts';
import { databasePath } from '../src/paths.ts';

export interface MigrationRecord {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
  duration_ms: number | null;
  success: boolean;
}

export interface DatabaseStatus {
  id: CoordinatedId;
  schema_version: number;
  min_compatible_version: number;
  max_compatible_version: number;
  data_contract_version: string;
  migration_history: MigrationRecord[];
  checksum: string;
  updated_at: string;
}

export interface SchemaRegistry {
  databases: Map<CoordinatedId, DatabaseStatus>;
  global_version: number;
  aggregated_at: string;
}

export interface DatabaseOpener {
  open(path: string, options?: { label?: string; mustExist?: boolean }): SqlExecutor;
  close(handle: SqlExecutor): void;
}

/** `get_data_contract_version`：v1 锚定 "1.0.0"，其余 "0.0.0"。 */
export function getDataContractVersion(schemaVersion: number): string {
  return schemaVersion >= 1 ? '1.0.0' : '0.0.0';
}

interface HistoryRow {
  version: number;
  name: string;
  checksum: string;
  applied_on: string;
}

function readMigrationHistory(db: SqlExecutor): MigrationRecord[] {
  const exists = db.pluck<number>(
    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='refinery_schema_history')",
  );
  if (Number(exists) !== 1) return [];
  const rows = db.all<HistoryRow>(
    'SELECT version, name, checksum, applied_on FROM refinery_schema_history ORDER BY version',
  );
  return rows.map(row => ({
    version: Number(row.version) >>> 0,
    name: String(row.name),
    checksum: String(row.checksum),
    applied_at: String(row.applied_on),
    duration_ms: null,
    success: true,
  }));
}

/**
 * `MigrationCoordinator::aggregate_schema_registry`：只聚合实际存在的库文件；
 * 文件存在但无 refinery 表时版本为 0、历史为空、checksum 为空。
 */
export function aggregateSchemaRegistry(
  activeDir: string,
  opener: DatabaseOpener,
  now: () => string,
  /** `aggregate_schema_registry_with_health`：启动健康中已阻断的库不读取。 */
  isBlocked: (id: CoordinatedId) => boolean = () => false,
): SchemaRegistry {
  const databases = new Map<CoordinatedId, DatabaseStatus>();
  for (const id of DATABASE_IDS) {
    if (isBlocked(id)) continue;
    const path = databasePath(activeDir, id);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const handle = opener.open(path, { label: `schema-registry:${id}`, mustExist: true });
    try {
      const history = readMigrationHistory(handle);
      const schemaVersion = history.reduce((max, record) => Math.max(max, record.version), 0);
      const checksum = history.find(record => record.version === schemaVersion)?.checksum ?? '';
      databases.set(id, {
        id,
        schema_version: schemaVersion,
        min_compatible_version: 1,
        max_compatible_version: latestVersion(id),
        data_contract_version: getDataContractVersion(schemaVersion),
        migration_history: history,
        checksum,
        updated_at: now(),
      });
    } finally {
      opener.close(handle);
    }
  }
  const globalVersion = [...databases.values()].reduce((max, status) => Math.max(max, status.schema_version), 0);
  return { databases, global_version: globalVersion, aggregated_at: now() };
}

/** `SchemaRegistry::check_dependencies`：依赖库缺失或版本为 0（而本库 > 0）即失败。 */
export function checkDependencies(registry: SchemaRegistry): void {
  for (const id of DATABASE_IDS) {
    const current = registry.databases.get(id);
    if (!current) continue;
    for (const dependency of DATABASE_DEPENDENCIES_ORDER[id] ?? []) {
      const dep = registry.databases.get(dependency);
      if (!dep) {
        throw new Error(`Dependency not satisfied: ${rustDebugId(id)} requires ${rustDebugId(dependency)}`);
      }
      if (dep.schema_version === 0 && current.schema_version > 0) {
        throw new Error(`Dependency not satisfied: ${rustDebugId(id)} requires ${rustDebugId(dependency)}`);
      }
    }
  }
}

/** Rust `Debug` 对 DatabaseId 的输出（`Vfs`/`ChatV2`/`Mistakes`/`LlmUsage`）。 */
export function rustDebugId(id: CoordinatedId): string {
  const names: Record<CoordinatedId, string> = { vfs: 'Vfs', chat_v2: 'ChatV2', mistakes: 'Mistakes', llm_usage: 'LlmUsage' };
  return names[id];
}

const DATABASE_DEPENDENCIES_ORDER: Readonly<Record<CoordinatedId, readonly CoordinatedId[]>> = {
  vfs: [],
  llm_usage: [],
  chat_v2: ['vfs'],
  mistakes: ['vfs'],
};

/** `SchemaRegistry::calculate_global_version`。 */
export function calculateGlobalVersion(databases: Iterable<{ schema_version: number }>): number {
  let max = 0;
  for (const status of databases) max = Math.max(max, status.schema_version);
  return max;
}

/** `calculate_aggregated_checksum`（SchemaRegistry 版本；aggregate_from_databases 用）。 */
export function aggregatedChecksum(records: readonly { version: number; checksum: string }[]): string {
  if (records.length === 0) return '';
  const combined = [...records]
    .sort((a, b) => a.version - b.version)
    .map(record => `${record.version}:${record.checksum}`)
    .join('|');
  return createHash('sha256').update(combined).digest('hex');
}
