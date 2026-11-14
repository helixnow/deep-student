/**
 * Schema 指纹（`__governance_schema_fingerprints`），移植自 coordinator.rs：
 * `ensure_schema_fingerprint_table`、`compute_schema_fingerprint`、`hash_canonical_schema`、
 * `filter_canonical_schema_to_scope`、`compute_schema_fingerprint_scope`、
 * `verify_schema_fingerprint`、`is_known_chat_v2_prior_scope_fingerprint`、
 * `log_known_prior_scope_recovery_rejection`、`scope_delta_matches`、`schema_object_definition`、
 * `build_migration_scratch`、`CHAT_V2_KNOWN_PRIOR_SCOPE_RECOVERIES`。
 *
 * 规范文本与哈希必须与 Rust 逐字节一致：已有用户库里存着 Rust 计算的指纹，
 * 不一致会在稳态启动时被判为漂移（fail-close）。
 */
import { sha256HexSync } from '../../crypto/sync.ts';
import type { CoordinatedDatabaseName } from '../api.ts';
import { Connection } from '../connection.ts';
import { PROFILES } from '../profiles.ts';
import type { MigrationSet } from './definitions.ts';
import { MigrationError, errorText } from './errors.ts';
import type { MigrationLog } from './helpers.ts';
import { chronoRfc3339Now } from './refinery.ts';

export const SCHEMA_FINGERPRINT_TABLE = '__governance_schema_fingerprints';

const CHAT_V2_SESSION_TAGS_SYNC_VERSION = 20260711;
const CHAT_V2_SESSION_TAGS_PREVIOUS_VERSION = 20260528;
const CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION = 20260721;
const CHAT_V2_WORKSPACE_DELETION_JOURNAL_PREVIOUS_VERSION = 20260720;
const CHAT_V2_WORKSPACE_DELETION_JOURNAL_LEGACY_SCOPE_VERSION = 20260719;
const CHAT_V2_WORKSPACE_DELETION_JOURNAL_LEGACY_FINGERPRINT = '50871351ff82068328d59089f21a2b400be006e15be136ce5991d8e2d41fabd6';

interface KnownPriorScopeRecoverySpec {
  targetVersion: number;
  previousVersion: number;
  acceptedRecordedScopeVersions: readonly number[];
  acceptedRecordedFingerprints: readonly string[];
  validateCurrentSchemaAgainstTarget: boolean;
  migrationName: string;
  addedTables: readonly string[];
  addedIndexes: readonly string[];
  addedTriggers: readonly string[];
}

export const CHAT_V2_KNOWN_PRIOR_SCOPE_RECOVERIES: readonly KnownPriorScopeRecoverySpec[] = [
  {
    targetVersion: CHAT_V2_SESSION_TAGS_SYNC_VERSION,
    previousVersion: CHAT_V2_SESSION_TAGS_PREVIOUS_VERSION,
    acceptedRecordedScopeVersions: [CHAT_V2_SESSION_TAGS_PREVIOUS_VERSION],
    acceptedRecordedFingerprints: [],
    validateCurrentSchemaAgainstTarget: false,
    migrationName: 'session_tags_sync_coverage',
    addedTables: [],
    addedIndexes: [],
    addedTriggers: [
      'trg__change_log_session_tags_delete',
      'trg__change_log_session_tags_insert',
      'trg__change_log_session_tags_update',
    ],
  },
  {
    targetVersion: CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION,
    previousVersion: CHAT_V2_WORKSPACE_DELETION_JOURNAL_PREVIOUS_VERSION,
    acceptedRecordedScopeVersions: [
      CHAT_V2_WORKSPACE_DELETION_JOURNAL_PREVIOUS_VERSION,
      CHAT_V2_WORKSPACE_DELETION_JOURNAL_LEGACY_SCOPE_VERSION,
    ],
    acceptedRecordedFingerprints: [CHAT_V2_WORKSPACE_DELETION_JOURNAL_LEGACY_FINGERPRINT],
    validateCurrentSchemaAgainstTarget: true,
    migrationName: 'workspace_deletion_intent_journal',
    addedTables: ['__file_deletion_journal'],
    addedIndexes: ['idx__file_deletion_journal_recovery', 'idx__file_deletion_journal_target'],
    addedTriggers: ['trg__workspace_deletion_queue_published'],
  },
];

/** Rust `BTreeSet<String>`：按 UTF-8 字节序排列的去重集合。 */
export class SortedNameSet {
  private readonly items: readonly string[];
  constructor(values: Iterable<string>) {
    this.items = Object.freeze([...new Set(values)].sort(byteCompare));
  }
  has(name: string): boolean {
    return this.items.includes(name);
  }
  [Symbol.iterator](): IterableIterator<string> {
    return this.items[Symbol.iterator]();
  }
  toArray(): readonly string[] {
    return this.items;
  }
  isSubsetOf(other: SortedNameSet): boolean {
    return this.items.every((name) => other.has(name));
  }
  difference(other: SortedNameSet): string[] {
    return this.items.filter((name) => !other.has(name));
  }
}

const UTF8 = new TextEncoder();

function byteCompare(a: string, b: string): number {
  const left = UTF8.encode(a);
  const right = UTF8.encode(b);
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return left.length - right.length;
}

export interface SchemaFingerprintScope {
  tables: SortedNameSet;
  indexes: SortedNameSet;
  triggers: SortedNameSet;
}

export interface SchemaFingerprint {
  hash: string;
  canonicalSchema: string;
  scope: SchemaFingerprintScope;
}

function db<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw MigrationError.database(errorText(error), error);
  }
}

function openScratch(): Connection {
  return db(() => new Connection(':memory:', { label: 'migration-scratch', profile: PROFILES.plain }));
}

/** `build_migration_scratch`：内存库中依次执行 version ≤ schemaVersion 的迁移 SQL。调用方负责关闭。 */
export function buildMigrationScratch(set: MigrationSet, schemaVersion: number): Connection {
  const scratch = openScratch();
  try {
    for (const migration of set.migrations) {
      if (migration.refineryVersion <= schemaVersion) db(() => scratch.exec(migration.sql));
    }
  } catch (error) {
    scratch.close();
    throw error;
  }
  return scratch;
}

type ReplayedMigrations = ReadonlyArray<readonly [version: number, sql: string]>;

const SCOPE_CACHE_MAX_ENTRIES = 32;
const scopeCache: Array<{ readonly replayed: ReplayedMigrations; readonly scope: SchemaFingerprintScope }> = [];

/** `buildMigrationScratch` 依次执行的（版本、SQL）序列；scope 只由它决定。 */
function replayedMigrations(set: MigrationSet, schemaVersion: number): ReplayedMigrations {
  return set.migrations.filter((m) => m.refineryVersion <= schemaVersion).map((m) => [m.refineryVersion, m.sql] as const);
}

function sameReplay(a: ReplayedMigrations, b: ReplayedMigrations): boolean {
  return a.length === b.length && a.every(([version, sql], i) => version === b[i]![0] && sql === b[i]![1]);
}

/**
 * `compute_schema_fingerprint_scope`：迁移管理的对象名（scratch 库中的表/索引/触发器）。
 * 结果按重放内容缓存（进程内，最多 {@link SCOPE_CACHE_MAX_ENTRIES} 项，键就是（版本、SQL）序列本身，逐项全等比较）：
 * 同一 Worker 里的后续迁移不再在 `:memory:` 重放全部迁移。返回的 scope 是冻结的共享对象。
 */
export function computeSchemaFingerprintScope(set: MigrationSet, schemaVersion: number): SchemaFingerprintScope {
  const replayed = replayedMigrations(set, schemaVersion);
  const cached = scopeCache.find((entry) => sameReplay(entry.replayed, replayed));
  if (cached !== undefined) return cached.scope;
  const scope = computeScopeFromScratch(set, schemaVersion);
  if (scopeCache.length >= SCOPE_CACHE_MAX_ENTRIES) scopeCache.shift();
  scopeCache.push({ replayed, scope });
  return scope;
}

function computeScopeFromScratch(set: MigrationSet, schemaVersion: number): SchemaFingerprintScope {
  const scratch = buildMigrationScratch(set, schemaVersion);
  try {
    const tables = db(() =>
      scratch.all<{ name: string }>(
        `SELECT name FROM sqlite_master
                       WHERE type='table'
                         AND name NOT LIKE 'sqlite_%'
                         AND name != 'refinery_schema_history'
                         AND name != ?1
                       ORDER BY name`,
        [SCHEMA_FINGERPRINT_TABLE],
      ),
    );
    const indexes = db(() =>
      scratch.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name"),
    );
    const triggers = db(() => scratch.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name"));
    return Object.freeze({
      tables: new SortedNameSet(tables.map((r) => r.name)),
      indexes: new SortedNameSet(indexes.map((r) => r.name)),
      triggers: new SortedNameSet(triggers.map((r) => r.name)),
    });
  } finally {
    scratch.close();
  }
}

/** `hash_canonical_schema`：SHA-256 小写十六进制。 */
export function hashCanonicalSchema(canonical: string): string {
  return sha256HexSync(canonical);
}

/** Rust `str::lines()`：按 `\n` 切分，去掉行尾 `\r`，末尾空行不产出。 */
function rustLines(text: string): string[] {
  if (text.length === 0) return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** `filter_canonical_schema_to_scope`。 */
export function filterCanonicalSchemaToScope(canonical: string, scope: SchemaFingerprintScope): string {
  let filtered = '';
  let includeCurrentTable = false;
  let includeContinuation = false;
  for (const line of rustLines(canonical)) {
    if (line.startsWith('table:')) {
      includeContinuation = false;
      includeCurrentTable = scope.tables.has(line.slice('table:'.length));
      if (includeCurrentTable) filtered += `${line}\n`;
      continue;
    }
    if (line.startsWith('col:')) {
      includeContinuation = false;
      if (includeCurrentTable) filtered += `${line}\n`;
      continue;
    }
    if (line.startsWith('idx:')) {
      includeContinuation = false;
      const indexName = line.slice(4).split(':')[0] ?? '';
      if (includeCurrentTable && scope.indexes.has(indexName)) {
        filtered += `${line}\n`;
        includeContinuation = true;
      }
      continue;
    }
    if (line.startsWith('trg:')) {
      includeContinuation = false;
      const triggerName = line.slice(4).split(':')[0] ?? '';
      if (includeCurrentTable && scope.triggers.has(triggerName)) {
        filtered += `${line}\n`;
        includeContinuation = true;
      }
      continue;
    }
    if (includeContinuation) filtered += `${line}\n`;
  }
  return filtered;
}

function exists(conn: Connection, sql: string, params: readonly string[]): boolean {
  return db(() => conn.pluck<number>(sql, params) === 1);
}

/** `compute_schema_fingerprint`。 */
export function computeSchemaFingerprint(
  conn: Connection,
  set: MigrationSet,
  schemaVersion: number,
  scope: SchemaFingerprintScope = computeSchemaFingerprintScope(set, schemaVersion),
): SchemaFingerprint {
  let canonical = '';
  for (const table of scope.tables) {
    canonical += `table:${table}\n`;
    if (!exists(conn, "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)", [table])) {
      canonical += `missing_table:${table}\n`;
      continue;
    }
    const escaped = table.replaceAll("'", "''");
    const columns = db(() =>
      conn.all<{ cid: number; name: string; type: string | null; notnull: number; dflt_value: string | null; pk: number }>(
        `PRAGMA table_info('${escaped}')`,
      ),
    );
    for (const c of columns) {
      canonical += `col:${c.cid}:${c.name}:${c.type ?? ''}:${c.notnull}:${c.dflt_value ?? ''}:${c.pk}\n`;
    }
    const indexes = db(() =>
      conn.all<{ name: string; sql: string }>(
        "SELECT name, IFNULL(sql, '') AS sql FROM sqlite_master                     WHERE type='index' AND tbl_name = ?1 AND name NOT LIKE 'sqlite_autoindex%'                     ORDER BY name",
        [table],
      ),
    );
    for (const index of indexes) {
      if (!scope.indexes.has(index.name)) continue;
      canonical += `idx:${index.name}:${index.sql}\n`;
    }
    const triggers = db(() =>
      conn.all<{ name: string; sql: string }>(
        "SELECT name, IFNULL(sql, '') AS sql FROM sqlite_master                     WHERE type='trigger' AND tbl_name = ?1                     ORDER BY name",
        [table],
      ),
    );
    for (const trigger of triggers) {
      if (!scope.triggers.has(trigger.name)) continue;
      canonical += `trg:${trigger.name}:${trigger.sql}\n`;
    }
  }
  for (const index of scope.indexes) {
    if (!exists(conn, "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1)", [index])) {
      canonical += `missing_idx:${index}\n`;
    }
  }
  for (const trigger of scope.triggers) {
    if (!exists(conn, "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?1)", [trigger])) {
      canonical += `missing_trg:${trigger}\n`;
    }
  }
  return { hash: hashCanonicalSchema(canonical), canonicalSchema: canonical, scope };
}

/** `ensure_schema_fingerprint_table`。 */
export function ensureSchemaFingerprintTable(conn: Connection, log: MigrationLog): void {
  db(() =>
    conn.run(`CREATE TABLE IF NOT EXISTS ${SCHEMA_FINGERPRINT_TABLE} (
                database_id TEXT NOT NULL,
                schema_version INTEGER NOT NULL,
                fingerprint TEXT NOT NULL,
                verified_at TEXT NOT NULL,
                PRIMARY KEY (database_id, schema_version)
            )`),
  );
  try {
    conn.run(`ALTER TABLE ${SCHEMA_FINGERPRINT_TABLE} ADD COLUMN canonical_schema TEXT`);
  } catch (error) {
    const message = errorText(error);
    if (message.includes('duplicate column')) {
      log('debug', `${SCHEMA_FINGERPRINT_TABLE}.canonical_schema already exists`);
    } else {
      log('warn', `Failed to add canonical_schema column to ${SCHEMA_FINGERPRINT_TABLE} (non-duplicate error)`, { error: message });
    }
  }
}

type ObjectDefinition = readonly [string, string, string, string] | undefined;

/** `schema_object_definition`。 */
function schemaObjectDefinition(conn: Connection, objectType: string, name: string): ObjectDefinition {
  const row = db(() =>
    conn.get<{ type: string; name: string; tbl_name: string; sql: string }>(
      `SELECT type, name, tbl_name, IFNULL(sql, '') AS sql
             FROM sqlite_master WHERE type = ?1 AND name = ?2`,
      [objectType, name],
    ),
  );
  return row === undefined ? undefined : [row.type, row.name, row.tbl_name, row.sql];
}

function sameDefinition(a: ObjectDefinition, b: ObjectDefinition): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.every((v, i) => v === b[i]);
}

/** `scope_delta_matches`。 */
function scopeDeltaMatches(previous: SchemaFingerprintScope, current: SchemaFingerprintScope, spec: KnownPriorScopeRecoverySpec): boolean {
  const matches = (prev: SortedNameSet, cur: SortedNameSet, expectedAdded: readonly string[]) => {
    const expected = new SortedNameSet(expectedAdded).toArray();
    const diff = cur.difference(prev);
    return prev.isSubsetOf(cur) && diff.length === expected.length && diff.every((name, i) => name === expected[i]);
  };
  return (
    matches(previous.tables, current.tables, spec.addedTables) &&
    matches(previous.indexes, current.indexes, spec.addedIndexes) &&
    matches(previous.triggers, current.triggers, spec.addedTriggers)
  );
}

function logRejection(log: MigrationLog, id: CoordinatedDatabaseName, spec: KnownPriorScopeRecoverySpec, reason: string): void {
  log('warn', 'Rejected known chat_v2 prior-scope fingerprint recovery', {
    database: id,
    target_version: spec.targetVersion,
    previous_version: spec.previousVersion,
    migration: spec.migrationName,
    reason,
  });
}

/** `is_known_chat_v2_prior_scope_fingerprint`。 */
export function isKnownChatV2PriorScopeFingerprint(
  conn: Connection,
  id: CoordinatedDatabaseName,
  set: MigrationSet,
  schemaVersion: number,
  storedHash: string,
  storedCanonicalSchema: string | null,
  current: SchemaFingerprint,
  log: MigrationLog,
): boolean {
  if (id !== 'chat_v2' || set.databaseName !== 'chat_v2') return false;
  const spec = CHAT_V2_KNOWN_PRIOR_SCOPE_RECOVERIES.find((s) => s.targetVersion === schemaVersion);
  if (spec === undefined) return false;
  if (storedCanonicalSchema === null) {
    logRejection(log, id, spec, 'missing_canonical_schema');
    return false;
  }
  if (hashCanonicalSchema(storedCanonicalSchema) !== storedHash) {
    logRejection(log, id, spec, 'stored_hash_mismatch');
    return false;
  }
  const targetPosition = set.migrations.findIndex((m) => m.refineryVersion === schemaVersion);
  if (targetPosition === -1) {
    logRejection(log, id, spec, 'target_migration_not_found');
    return false;
  }
  const target = set.migrations[targetPosition]!;
  const previousVersion = targetPosition > 0 ? set.migrations[targetPosition - 1]!.refineryVersion : undefined;
  if (target.name !== spec.migrationName || previousVersion !== spec.previousVersion) {
    logRejection(log, id, spec, 'migration_chain_mismatch');
    return false;
  }
  const previousScope = computeSchemaFingerprintScope(set, spec.previousVersion);
  if (!scopeDeltaMatches(previousScope, current.scope, spec)) {
    logRejection(log, id, spec, 'managed_scope_delta_mismatch');
    return false;
  }
  const scratch = buildMigrationScratch(set, schemaVersion);
  try {
    if (spec.validateCurrentSchemaAgainstTarget) {
      const expectedCurrent = computeSchemaFingerprint(scratch, set, schemaVersion);
      if (current.canonicalSchema !== expectedCurrent.canonicalSchema) {
        logRejection(log, id, spec, 'current_schema_does_not_match_target_migrations');
        return false;
      }
      let recordedScopeMatches = false;
      for (const recordedVersion of spec.acceptedRecordedScopeVersions) {
        const recordedScratch = buildMigrationScratch(set, recordedVersion);
        try {
          const expectedRecorded = computeSchemaFingerprint(recordedScratch, set, recordedVersion);
          if (expectedRecorded.canonicalSchema === storedCanonicalSchema) {
            recordedScopeMatches = true;
            break;
          }
        } finally {
          recordedScratch.close();
        }
      }
      const knownHistorical = spec.acceptedRecordedFingerprints.includes(storedHash);
      if (!recordedScopeMatches && !knownHistorical) {
        logRejection(log, id, spec, 'recorded_scope_canonical_mismatch');
        return false;
      }
    } else {
      const currentInPrevious = filterCanonicalSchemaToScope(current.canonicalSchema, previousScope);
      if (currentInPrevious !== storedCanonicalSchema) {
        logRejection(log, id, spec, 'previous_scope_canonical_mismatch');
        return false;
      }
    }
    for (const [objectType, names] of [
      ['table', spec.addedTables],
      ['index', spec.addedIndexes],
      ['trigger', spec.addedTriggers],
    ] as const) {
      for (const name of names) {
        const actual = schemaObjectDefinition(conn, objectType, name);
        const expected = schemaObjectDefinition(scratch, objectType, name);
        if (actual === undefined || !sameDefinition(actual, expected)) {
          logRejection(log, id, spec, 'added_object_definition_mismatch');
          return false;
        }
      }
    }
  } finally {
    scratch.close();
  }
  log('warn', 'Validated and recovering known chat_v2 prior-scope schema fingerprint', {
    database: id,
    target_version: spec.targetVersion,
    previous_version: spec.previousVersion,
    migration: spec.migrationName,
    stored_fingerprint: storedHash,
    actual_fingerprint: current.hash,
  });
  return true;
}

/** `verify_schema_fingerprint`。 */
export function verifySchemaFingerprint(
  conn: Connection,
  id: CoordinatedDatabaseName,
  set: MigrationSet,
  schemaVersion: number,
  allowRebaseline: boolean,
  log: MigrationLog,
): void {
  if (schemaVersion === 0) return;
  const latestSupported = set.latestVersion();
  if (schemaVersion > latestSupported) {
    log('warn', 'Skipping schema fingerprint because database history is newer than this binary', {
      database: id,
      history_version: schemaVersion,
      latest_supported_version: latestSupported,
    });
    return;
  }
  ensureSchemaFingerprintTable(conn, log);
  const current = computeSchemaFingerprint(conn, set, schemaVersion);
  const existing = db(() =>
    conn.get<{ fingerprint: string; canonical_schema: string | null }>(
      `SELECT fingerprint, canonical_schema FROM ${SCHEMA_FINGERPRINT_TABLE} WHERE database_id = ?1 AND schema_version = ?2`,
      [id, schemaVersion],
    ),
  );
  if (existing !== undefined) {
    const stored = existing.fingerprint;
    if (stored !== current.hash) {
      const filteredLegacyHash =
        existing.canonical_schema === null
          ? undefined
          : hashCanonicalSchema(filterCanonicalSchemaToScope(existing.canonical_schema, current.scope));
      const legacyBroadScope = filteredLegacyHash === current.hash;
      const knownPriorScope = legacyBroadScope
        ? false
        : isKnownChatV2PriorScopeFingerprint(conn, id, set, schemaVersion, stored, existing.canonical_schema, current, log);
      if (legacyBroadScope) {
        log('warn', 'Schema fingerprint used legacy broad scope, rebaseline to migration-managed scope', { database: id, version: schemaVersion });
      } else if (knownPriorScope) {
        log('debug', 'Known chat_v2 prior-scope fingerprint recovered (audit warning already emitted)', { database: id, version: schemaVersion });
      } else if (allowRebaseline) {
        log('warn', 'Schema fingerprint drift detected, rebaseline enabled', { database: id, version: schemaVersion });
      } else {
        throw new MigrationError({
          kind: 'VerificationFailed',
          version: schemaVersion,
          reason: `Schema fingerprint drift detected at v${schemaVersion} (db: ${id}). Use the canonical_schema column in ${SCHEMA_FINGERPRINT_TABLE} to diff the expected vs actual schema.`,
        });
      }
    }
    db(() =>
      conn.run(
        `UPDATE ${SCHEMA_FINGERPRINT_TABLE} SET verified_at = ?3, fingerprint = ?4, canonical_schema = ?5 WHERE database_id = ?1 AND schema_version = ?2`,
        [id, schemaVersion, chronoRfc3339Now(), current.hash, current.canonicalSchema],
      ),
    );
    return;
  }
  db(() =>
    conn.run(
      `INSERT INTO ${SCHEMA_FINGERPRINT_TABLE} (database_id, schema_version, fingerprint, verified_at, canonical_schema) VALUES (?1, ?2, ?3, ?4, ?5)`,
      [id, schemaVersion, current.hash, chronoRfc3339Now(), current.canonicalSchema],
    ),
  );
}
