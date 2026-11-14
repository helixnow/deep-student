import { afterEach, describe, expect, it, vi } from 'vitest';
import { Connection } from '../connection.ts';
import { MigrationSet, type MigrationDef } from '../migration/definitions.ts';
import { DEFAULT_MIGRATIONS_DIR, loadMigrationSets } from '../migration/definitions/index.ts';
import {
  buildMigrationScratch,
  computeSchemaFingerprint,
  computeSchemaFingerprintScope,
  SortedNameSet,
  type SchemaFingerprintScope,
} from '../migration/fingerprint.ts';
import { MigrationError } from '../migration/errors.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Counts the SQL batches replayed into migration scratch databases. */
function countScratchReplays() {
  const exec = vi.spyOn(Connection.prototype, 'exec');
  return () => exec.mock.contexts.filter((conn) => (conn as Connection).label === 'migration-scratch').length;
}

function names(scope: SchemaFingerprintScope) {
  return { tables: [...scope.tables], indexes: [...scope.indexes], triggers: [...scope.triggers] };
}

function groundTruth(set: MigrationSet, version: number) {
  const scratch = buildMigrationScratch(set, version);
  try {
    const of = (type: string, extra: string) =>
      scratch.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = ?1 ${extra}`, [type]).map((r) => r.name).sort();
    return {
      tables: of('table', "AND name NOT LIKE 'sqlite_%' AND name != 'refinery_schema_history' AND name != '__governance_schema_fingerprints'"),
      indexes: of('index', "AND name NOT LIKE 'sqlite_autoindex%'"),
      triggers: of('trigger', ''),
    };
  } finally {
    scratch.close();
  }
}

function withSql(set: MigrationSet, version: number, edit: (sql: string) => string): MigrationSet {
  return new MigrationSet(
    set.databaseName,
    set.migrations.map((m): MigrationDef => (m.refineryVersion === version ? { ...m, sql: edit(m.sql) } : m)),
  );
}

describe('computeSchemaFingerprintScope is cached by migration content', () => {
  it('equal migration content from a freshly loaded set reuses the scope without replaying into :memory:', () => {
    const first = loadMigrationSets(DEFAULT_MIGRATIONS_DIR).mistakes;
    const scope = computeSchemaFingerprintScope(first, first.latestVersion());
    const replays = countScratchReplays();
    const second = loadMigrationSets(DEFAULT_MIGRATIONS_DIR).mistakes;
    expect(second).not.toBe(first);
    expect(computeSchemaFingerprintScope(second, second.latestVersion())).toBe(scope);
    expect(replays()).toBe(0);
    expect(names(scope)).toEqual(groundTruth(second, second.latestVersion()));
  });

  it('a different SQL text at or below the version is a different key; above the version it is not', () => {
    const set = loadMigrationSets(DEFAULT_MIGRATIONS_DIR).llm_usage;
    const versions = set.migrations.map((m) => m.refineryVersion);
    const middle = versions[Math.floor(versions.length / 2)]!;
    const last = versions[versions.length - 1]!;
    const base = computeSchemaFingerprintScope(set, middle);

    const above = withSql(set, last, (sql) => `${sql}\nCREATE TABLE w14_above_version (id INTEGER);`);
    let replays = countScratchReplays();
    expect(computeSchemaFingerprintScope(above, middle)).toBe(base);
    expect(replays()).toBe(0);
    vi.restoreAllMocks();

    const edited = withSql(set, middle, (sql) => `${sql}\nCREATE TABLE w14_scope_probe (id INTEGER);`);
    replays = countScratchReplays();
    const changed = computeSchemaFingerprintScope(edited, middle);
    expect(replays()).toBeGreaterThan(0);
    expect([...changed.tables]).toEqual([...base.tables, 'w14_scope_probe'].sort());
    expect(names(changed)).toEqual(groundTruth(edited, middle));
    expect(computeSchemaFingerprintScope(set, middle)).toBe(base);
  });

  it('each schema version has its own entry and matches a fresh replay', () => {
    const set = loadMigrationSets(DEFAULT_MIGRATIONS_DIR).chat_v2;
    for (const version of [set.migrations[0]!.refineryVersion, 20260720, 20260721, set.latestVersion()]) {
      expect(names(computeSchemaFingerprintScope(set, version)), String(version)).toEqual(groundTruth(set, version));
    }
    expect([...computeSchemaFingerprintScope(set, 20260721).tables]).toContain('__file_deletion_journal');
    expect([...computeSchemaFingerprintScope(set, 20260720).tables]).not.toContain('__file_deletion_journal');
  });

  it('cached scopes are frozen so callers cannot change what later migrations see', () => {
    const set = loadMigrationSets(DEFAULT_MIGRATIONS_DIR).llm_usage;
    const scope = computeSchemaFingerprintScope(set, set.latestVersion());
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.tables.toArray())).toBe(true);
    expect(() => (scope.tables.toArray() as string[]).push('x')).toThrow(TypeError);
  });

  it('a replay failure is not cached', () => {
    const set = loadMigrationSets(DEFAULT_MIGRATIONS_DIR).llm_usage;
    const broken = withSql(set, set.latestVersion(), () => 'CREATE TABLE w14_broken (');
    expect(() => computeSchemaFingerprintScope(broken, broken.latestVersion())).toThrow(MigrationError);
    const replays = countScratchReplays();
    expect(() => computeSchemaFingerprintScope(broken, broken.latestVersion())).toThrow(MigrationError);
    expect(replays()).toBeGreaterThan(0);
  });

  it('fingerprints computed with the cached scope equal those computed from a fresh replay', () => {
    const set = loadMigrationSets(DEFAULT_MIGRATIONS_DIR).vfs;
    const version = set.latestVersion();
    computeSchemaFingerprintScope(set, version);
    const truth = groundTruth(set, version);
    const fresh: SchemaFingerprintScope = {
      tables: new SortedNameSet(truth.tables),
      indexes: new SortedNameSet(truth.indexes),
      triggers: new SortedNameSet(truth.triggers),
    };
    const db = buildMigrationScratch(set, version);
    try {
      const replays = countScratchReplays();
      const cached = computeSchemaFingerprint(db, loadMigrationSets(DEFAULT_MIGRATIONS_DIR).vfs, version);
      expect(replays()).toBe(0);
      const uncached = computeSchemaFingerprint(db, set, version, fresh);
      expect(cached.hash).toBe(uncached.hash);
      expect(cached.canonicalSchema).toBe(uncached.canonicalSchema);
    } finally {
      db.close();
    }
  });
});
