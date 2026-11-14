import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { isJsonObject, parseJsonLossless, stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';

export class PluginQuotaExceededError extends Error {}
export class PluginSchemaDowngradeWriteError extends Error {}
export interface FieldEnvelope { value: DbJson; hlc: string; dev: string; seq: bigint }
export interface PluginPutOptions { minWriterPluginSchema?: number; deleted?: boolean }
interface StoredRecord {
  payload_json: string; unknown_fields_json: string; field_versions_json: string;
  plugin_schema_version: number; min_writer_plugin_schema: number; deleted: number;
  updated_at: string; source_device_id: string;
}

function sorted(value: DbJson): DbJson {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isJsonObject(value)) return value;
  const result: Record<string, DbJson> = Object.create(null);
  for (const key of Object.keys(value).sort()) result[key] = sorted(value[key]!);
  return result;
}
const canonical = (value: DbJson): string => stringifyJsonLossless(sorted(value));
const byteLength = (text: string): number => new TextEncoder().encode(text).length;
function checkDepth(value: DbJson, depth = 0): void {
  if (!Array.isArray(value) && !isJsonObject(value)) return;
  if (depth + 1 > 16) throw new PluginQuotaExceededError('JSON depth exceeds 16');
  for (const child of Object.values(value)) checkDepth(child, depth + 1);
}

/** Ensure per-plugin scoped sync tables and outbox columns exist in SQLite. */
export function ensurePluginSyncRecordsTable(db: SqlExecutor): void {
  // FULL makes a committed put durable; never buffer plugin writes in JS memory.
  if (!db.inTransaction) db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec(`CREATE TABLE IF NOT EXISTS __plugin_sync_records (
    plugin_id TEXT NOT NULL, namespace TEXT NOT NULL, record_id TEXT NOT NULL,
    payload_json TEXT NOT NULL, unknown_fields_json TEXT NOT NULL DEFAULT '{}',
    field_versions_json TEXT NOT NULL DEFAULT '{}', plugin_schema_version INTEGER NOT NULL,
    min_writer_plugin_schema INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
    source_device_id TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(plugin_id, namespace, record_id));
    CREATE TABLE IF NOT EXISTS message_widget_states (
    owner_id TEXT NOT NULL, source_hash TEXT NOT NULL, widget_id TEXT NOT NULL DEFAULT 'default',
    model_content_json TEXT NOT NULL, updated_at TEXT NOT NULL, source_device_id TEXT NOT NULL,
    PRIMARY KEY(owner_id, source_hash, widget_id));
    CREATE TABLE IF NOT EXISTS __change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
    operation TEXT NOT NULL, changed_at TEXT NOT NULL, sync_version INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT);`);
  if (!db.all<{ name: string }>('PRAGMA table_info(__change_log)').some(row => row.name === 'payload_json')) {
    db.exec('ALTER TABLE __change_log ADD COLUMN payload_json TEXT');
  }
}

/** Create a capability-scoped plugin sync store persisted in `__plugin_sync_records`. */
export function createScopedPluginSyncStore(
  db: SqlExecutor,
  capabilityToken: { readonly pluginId: string; readonly pluginSchemaVersion: number },
  hlcClock: { nextHlc(): string; readonly deviceId: string },
) {
  const { pluginId, pluginSchemaVersion } = capabilityToken;
  const read = (namespace: string, recordId: string) => db.get<StoredRecord>(
    'SELECT * FROM __plugin_sync_records WHERE plugin_id=? AND namespace=? AND record_id=?',
    [pluginId, namespace, recordId]);
  function serialize(namespace: string, recordId: string): DbJson | undefined {
    const row = read(namespace, recordId);
    if (!row || row.deleted) return undefined;
    const payload = parseJsonLossless(row.payload_json);
    const unknown = parseJsonLossless(row.unknown_fields_json) as Record<string, DbJson>;
    if (isJsonObject(payload)) for (const [key, envelope] of Object.entries(unknown)) {
      if (!Object.hasOwn(payload, key)) Object.defineProperty(payload, key, {
        value: (envelope as unknown as FieldEnvelope).value, enumerable: true, writable: true, configurable: true,
      });
    }
    return payload;
  }
  return {
    get: serialize,
    serialize,
    put(namespace: string, recordId: string, payload: DbJson, options: PluginPutOptions = {}): void {
      checkDepth(payload);
      const payloadJson = canonical(payload);
      if (byteLength(payloadJson) > 65_536) throw new PluginQuotaExceededError('Record exceeds 64 KiB');
      db.exec('SAVEPOINT plugin_sync_put');
      try {
        const existing = read(namespace, recordId);
        if (existing && existing.min_writer_plugin_schema > pluginSchemaVersion) {
          throw new PluginSchemaDowngradeWriteError('Plugin schema is below min_writer_plugin_schema');
        }
        const hlc = hlcClock.nextHlc();
        const unknown = existing ? parseJsonLossless(existing.unknown_fields_json) as Record<string, DbJson> : Object.create(null);
        const previous = existing ? parseJsonLossless(existing.payload_json) : null;
        const versions = existing ? parseJsonLossless(existing.field_versions_json) as Record<string, DbJson> : Object.create(null);
        if (existing && existing.plugin_schema_version > pluginSchemaVersion && isJsonObject(previous) && isJsonObject(payload)) {
          for (const [key, value] of Object.entries(previous)) if (!Object.hasOwn(payload, key)) {
            unknown[key] = versions[key] ?? { value, hlc: existing.updated_at, dev: existing.source_device_id, seq: 0n };
          }
        }
        const nextVersions: Record<string, DbJson> = Object.create(null);
        if (isJsonObject(payload)) for (const [key, value] of Object.entries(payload)) {
          const opaque = unknown[key];
          if (isJsonObject(opaque) && Object.hasOwn(opaque, 'value') && canonical(opaque.value!) === canonical(value)) {
            // A read/spread/write is not a causal edit to an opaque register.
            nextVersions[key] = opaque;
            continue;
          }
          delete unknown[key];
          nextVersions[key] = { value, hlc, dev: hlcClock.deviceId, seq: 0n };
        }
        const unknownJson = canonical(unknown);
        const totals = db.one<{ count: number; bytes: number }>(`SELECT COUNT(*) AS count,
          COALESCE(SUM(length(CAST(payload_json AS BLOB))+length(CAST(unknown_fields_json AS BLOB))),0) AS bytes
          FROM __plugin_sync_records WHERE plugin_id=? AND deleted=0 AND NOT(namespace=? AND record_id=?)`,
        [pluginId, namespace, recordId]);
        if (!options.deleted && (totals.count + 1 > 2000 || totals.bytes + byteLength(payloadJson) + byteLength(unknownJson) > 5 * 1024 * 1024)) {
          throw new PluginQuotaExceededError('Plugin exceeds 2000 records or 5 MiB');
        }
        db.run(`INSERT OR REPLACE INTO __plugin_sync_records VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          [pluginId, namespace, recordId, payloadJson, unknownJson, canonical(nextVersions),
            Math.max(pluginSchemaVersion, existing?.plugin_schema_version ?? 0),
            Math.max(options.minWriterPluginSchema ?? 1, existing?.min_writer_plugin_schema ?? 1),
            hlc, hlcClock.deviceId, options.deleted ? 1 : 0]);
        const key = canonical([pluginId, namespace, recordId]);
        const snapshot = canonical({ payload: serialize(namespace, recordId) ?? null, fields: nextVersions,
          unknown, deleted: options.deleted ?? false });
        const operation = options.deleted ? 'DELETE' : 'UPDATE';
        const changed = db.run(`UPDATE __change_log SET payload_json=?, changed_at=?, operation=?
          WHERE table_name='__plugin_sync_records' AND record_id=? AND sync_version=0`, [snapshot, hlc, operation, key]);
        if (!changed.changes) db.run(`INSERT INTO __change_log(table_name,record_id,operation,changed_at,sync_version,payload_json)
          VALUES('__plugin_sync_records',?,?,?,0,?)`, [key, operation, hlc, snapshot]);
        const pending = db.one<{ bytes: number }>(`SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) AS bytes
          FROM __change_log WHERE table_name='__plugin_sync_records' AND sync_version=0
          AND json_extract(record_id,'$[0]')=?`, [pluginId]);
        if (pending.bytes > 10 * 1024 * 1024) throw new PluginQuotaExceededError('Pending plugin log exceeds 10 MiB');
        db.exec('RELEASE plugin_sync_put');
      } catch (error) {
        db.exec('ROLLBACK TO plugin_sync_put; RELEASE plugin_sync_put');
        throw error;
      }
    },
  };
}
