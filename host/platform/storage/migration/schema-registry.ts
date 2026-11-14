/**
 * `dstu-storage/src/schema_registry.rs`（SchemaRegistry 派生视图）与
 * `coordinator.rs::aggregate_schema_registry{,_with_health}` / `read_migration_history` 的移植。
 *
 * serde 形状：`DatabaseId` 是无 rename 的单元变体（`Vfs`/`ChatV2`/`Mistakes`/`LlmUsage`），
 * 字段 snake_case；`databases` 为 HashMap（键序无意义，不得据此做字符串比对）。
 */
import fs from 'node:fs';
import type { CoordinatedDatabaseName } from '../api.ts';
import { Connection } from '../connection.ts';
import { PROFILES } from '../profiles.ts';
import { ALL_ORDERED, DATABASE_DEPENDENCIES, type StartupComponentHealth } from './backup.ts';
import type { MigrationCoordinator } from './coordinator.ts';
import { MigrationError, errorText } from './errors.ts';
import { sha256HexSync } from '../../crypto/sync.ts';
import { chronoRfc3339Now } from './refinery.ts';
import { storageLog } from '../logging.ts';

export const DATABASE_ID_SERDE: Readonly<Record<CoordinatedDatabaseName, string>> = {
  vfs: 'Vfs',
  chat_v2: 'ChatV2',
  mistakes: 'Mistakes',
  llm_usage: 'LlmUsage',
};

export interface MigrationRecord {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
  duration_ms: number | null;
  success: boolean;
}

export interface DatabaseStatus {
  id: CoordinatedDatabaseName;
  schema_version: number;
  min_compatible_version: number;
  max_compatible_version: number;
  data_contract_version: string;
  migration_history: MigrationRecord[];
  checksum: string;
  updated_at: string;
}

/** `VERSION_MAPPING`。 */
export const VERSION_MAPPING: ReadonlyArray<readonly [number, string]> = [[1, '1.0.0']];

/** `get_data_contract_version`。 */
export function getDataContractVersion(schemaVersion: number): string {
  for (let i = VERSION_MAPPING.length - 1; i >= 0; i--) {
    const [ver, contract] = VERSION_MAPPING[i]!;
    if (schemaVersion >= ver) return contract;
  }
  return '0.0.0';
}

/** `SchemaRegistryError` 的 Display。 */
export class SchemaRegistryError extends Error {
  readonly kind: 'Database' | 'TableNotFound' | 'DependencyNotSatisfied';
  readonly database?: CoordinatedDatabaseName;
  readonly missingDependency?: CoordinatedDatabaseName;

  constructor(
    kind: 'Database' | 'TableNotFound' | 'DependencyNotSatisfied',
    message: string,
    database?: CoordinatedDatabaseName,
    missingDependency?: CoordinatedDatabaseName,
  ) {
    super(message);
    this.kind = kind;
    this.database = database;
    this.missingDependency = missingDependency;
    this.name = 'SchemaRegistryError';
  }
}

function regDb<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw new SchemaRegistryError('Database', `Database error: ${errorText(error)}`);
  }
}

export class SchemaRegistry {
  databases = new Map<CoordinatedDatabaseName, DatabaseStatus>();
  globalVersion = 0;
  aggregatedAt = chronoRfc3339Now();

  /** `aggregate_from_databases`。 */
  static aggregateFromDatabases(connections: Iterable<readonly [CoordinatedDatabaseName, Connection]>): SchemaRegistry {
    const registry = new SchemaRegistry();
    const now = chronoRfc3339Now();
    for (const [id, conn] of connections) {
      const exists = regDb(() => conn.get("SELECT name FROM sqlite_master WHERE type='table' AND name = ?1", ['refinery_schema_history']));
      if (exists === undefined) {
        registry.databases.set(id, {
          id,
          schema_version: 0,
          min_compatible_version: 0,
          max_compatible_version: 0,
          data_contract_version: getDataContractVersion(0),
          migration_history: [],
          checksum: '',
          updated_at: now,
        });
        continue;
      }
      const raw = regDb(() =>
        conn.all<{ version: number; name: string; applied_on: string; checksum: string }>(
          'SELECT version, name, applied_on, checksum FROM refinery_schema_history ORDER BY version ASC',
        ),
      );
      for (const r of raw) {
        if (typeof r.name !== 'string' || typeof r.applied_on !== 'string' || typeof r.checksum !== 'string') {
          throw new SchemaRegistryError('Database', 'Database error: Invalid column type');
        }
      }
      const history: MigrationRecord[] = raw.map((r) => ({
        version: r.version,
        name: r.name,
        checksum: r.checksum,
        applied_at: r.applied_on,
        duration_ms: null,
        success: true,
      }));
      const schemaVersion = history.reduce((m, r) => Math.max(m, r.version), 0);
      const updatedAt = history.map((r) => r.applied_at).reduce((m, v) => (Buffer.compare(Buffer.from(v), Buffer.from(m)) > 0 ? v : m), '');
      registry.databases.set(id, {
        id,
        schema_version: schemaVersion,
        min_compatible_version: schemaVersion,
        max_compatible_version: schemaVersion,
        data_contract_version: getDataContractVersion(schemaVersion),
        migration_history: history,
        checksum: SchemaRegistry.calculateAggregatedChecksum(history),
        updated_at: updatedAt,
      });
    }
    registry.globalVersion = registry.calculateGlobalVersion();
    registry.aggregatedAt = now;
    return registry;
  }

  /** `calculate_aggregated_checksum`：`version:checksum` 按版本以 `|` 连接后 SHA-256。 */
  static calculateAggregatedChecksum(records: readonly MigrationRecord[]): string {
    if (records.length === 0) return '';
    const sorted = [...records].sort((a, b) => a.version - b.version);
    const combined = sorted.map((r) => `${r.version}:${r.checksum}`).join('|');
    return sha256HexSync(combined);
  }

  getStatus(id: CoordinatedDatabaseName): DatabaseStatus | undefined {
    return this.databases.get(id);
  }

  getSchemaVersion(id: CoordinatedDatabaseName): number | undefined {
    return this.databases.get(id)?.schema_version;
  }

  /** `check_dependencies`。 */
  checkDependencies(): void {
    for (const id of ALL_ORDERED) {
      const current = this.databases.get(id);
      if (current === undefined) continue;
      for (const dep of DATABASE_DEPENDENCIES[id]) {
        const depStatus = this.databases.get(dep);
        if (depStatus === undefined || (depStatus.schema_version === 0 && current.schema_version > 0)) {
          throw new SchemaRegistryError(
            'DependencyNotSatisfied',
            `Dependency not satisfied: ${DATABASE_ID_SERDE[id]} requires ${DATABASE_ID_SERDE[dep]}`,
            id,
            dep,
          );
        }
      }
    }
  }

  calculateGlobalVersion(): number {
    let max = 0;
    for (const s of this.databases.values()) max = Math.max(max, s.schema_version);
    return max;
  }

  needsMigration(id: CoordinatedDatabaseName, targetVersion: number): boolean {
    const status = this.databases.get(id);
    return status === undefined ? true : status.schema_version < targetVersion;
  }

  getSummary(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, s] of this.databases) out[id] = s.schema_version;
    return out;
  }

  /** serde 序列化形状。 */
  toJSON(): { databases: Record<string, unknown>; global_version: number; aggregated_at: string } {
    const databases: Record<string, unknown> = {};
    for (const [id, s] of this.databases) databases[DATABASE_ID_SERDE[id]] = { ...s, id: DATABASE_ID_SERDE[id] };
    return { databases, global_version: this.globalVersion, aggregated_at: this.aggregatedAt };
  }
}

/** `read_migration_history`（坏行跳过并告警，同 Rust `log_and_skip_err`）。 */
function readMigrationHistory(conn: Connection, warn: (m: string) => void): MigrationRecord[] {
  const exists = coordDb(
    () => conn.pluck<number>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='refinery_schema_history')") === 1,
  );
  if (!exists) return [];
  const rows = coordDb(() =>
    conn.all<{ version: unknown; name: unknown; checksum: unknown; applied_on: unknown }>(
      'SELECT version, name, checksum, applied_on FROM refinery_schema_history ORDER BY version',
    ),
  );
  const out: MigrationRecord[] = [];
  for (const r of rows) {
    if (typeof r.version !== 'number' || typeof r.name !== 'string' || typeof r.checksum !== 'string' || typeof r.applied_on !== 'string') {
      warn('[MigrationCoordinator] Row parse error (skipped): Invalid column type');
      continue;
    }
    out.push({ version: r.version, name: r.name, checksum: r.checksum, applied_at: r.applied_on, duration_ms: null, success: true });
  }
  return out;
}

function coordDb<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw MigrationError.database(errorText(error), error);
  }
}

/**
 * `aggregate_schema_registry` / `aggregate_schema_registry_with_health`：
 * 传入 health 时单库读失败只阻断该库（并做依赖闭包），否则直接抛错。
 */
export function aggregateSchemaRegistry(coordinator: MigrationCoordinator, health?: StartupComponentHealth): SchemaRegistry {
  const registry = new SchemaRegistry();
  for (const id of ALL_ORDERED) {
    if (health?.isBlocked(id) === true) continue;
    const dbPath = coordinator.getDatabasePath(id);
    if (!fs.existsSync(dbPath)) continue;
    const fail = (prefix: string, error: unknown): boolean => {
      if (health === undefined) throw error;
      health.markBlocked(id, `${prefix}: ${errorText(error)}`);
      health.applyDatabaseDependencyClosure();
      return true;
    };
    let conn: Connection;
    try {
      conn = new Connection(dbPath, { label: id, profile: PROFILES.plain });
    } catch (error) {
      if (fail('Schema aggregation failed', MigrationError.database(`${id}: ${errorText(error)}`, error))) continue;
      throw error;
    }
    try {
      let version: number;
      try {
        version = coordinator.getCurrentVersion(conn);
      } catch (error) {
        if (fail('Schema version read failed', error)) continue;
        throw error;
      }
      let history: MigrationRecord[];
      try {
        history = readMigrationHistory(conn, (m) => storageLog('dstu_storage::migration', 'warn', m));
      } catch (error) {
        if (fail('Migration history read failed', error)) continue;
        throw error;
      }
      registry.databases.set(id, {
        id,
        schema_version: version,
        min_compatible_version: 1,
        max_compatible_version: coordinator.sets[id].latestVersion(),
        data_contract_version: getDataContractVersion(version),
        migration_history: history,
        checksum: history.find((r) => r.version === version)?.checksum ?? '',
        updated_at: chronoRfc3339Now(),
      });
    } finally {
      conn.close();
    }
  }
  registry.globalVersion = registry.calculateGlobalVersion();
  registry.aggregatedAt = chronoRfc3339Now();
  return registry;
}
