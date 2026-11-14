import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Connection } from '../connection.ts';
import { PROFILES } from '../profiles.ts';
import { ALL_ORDERED, DATABASE_DEPENDENCIES, StartupComponentHealth } from '../migration/backup.ts';
import { MigrationCoordinator } from '../migration/coordinator.ts';
import { aggregateSchemaRegistry, getDataContractVersion, SchemaRegistry, SchemaRegistryError } from '../migration/schema-registry.ts';

function withHistory(records: Array<[number, string, string, string]>): Connection {
  const c = new Connection(':memory:', { label: 'm', profile: PROFILES.plain });
  c.exec(`CREATE TABLE refinery_schema_history (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_on TEXT NOT NULL, checksum TEXT NOT NULL)`);
  for (const r of records) c.run('INSERT INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (?1, ?2, ?3, ?4)', r);
  return c;
}
const empty = () => new Connection(':memory:', { label: 'e', profile: PROFILES.plain });
const T = '2026-01-30T10:00:00Z';

describe('schema_registry.rs (ported tests)', () => {
  it('test_aggregate_from_single_database', () => {
    const c = withHistory([[1, 'V1__init', T, 'abc123'], [2, 'V2__add_index', '2026-01-30T11:00:00Z', 'def456']]);
    const r = SchemaRegistry.aggregateFromDatabases([['vfs', c]]);
    expect(r.databases.size).toBe(1);
    const s = r.getStatus('vfs')!;
    expect(s.schema_version).toBe(2);
    expect(s.migration_history.map((h) => h.version)).toEqual([1, 2]);
  });
  it('test_aggregate_from_multiple_databases', () => {
    const r = SchemaRegistry.aggregateFromDatabases([
      ['vfs', withHistory([[1, 'V1__vfs_init', T, 'vfs123']])],
      ['chat_v2', withHistory([[1, 'a', T, 'x'], [2, 'b', T, 'y'], [3, 'c', T, 'z']])],
    ]);
    expect(r.databases.size).toBe(2);
    expect(r.globalVersion).toBe(3);
    expect(r.getStatus('vfs')!.schema_version).toBe(1);
    expect(r.getStatus('chat_v2')!.schema_version).toBe(3);
  });
  it('test_aggregate_with_empty_database', () => {
    const r = SchemaRegistry.aggregateFromDatabases([['llm_usage', empty()]]);
    expect(r.getStatus('llm_usage')!.schema_version).toBe(0);
    expect(r.getStatus('llm_usage')!.migration_history).toEqual([]);
  });
  it('test_check_dependencies_satisfied', () => {
    const r = SchemaRegistry.aggregateFromDatabases([['vfs', withHistory([[1, 'a', T, 'x']])], ['chat_v2', withHistory([[1, 'b', T, 'y']])]]);
    expect(() => r.checkDependencies()).not.toThrow();
  });
  it('test_check_dependencies_not_satisfied', () => {
    const r = SchemaRegistry.aggregateFromDatabases([['vfs', empty()], ['chat_v2', withHistory([[1, 'b', T, 'y']])]]);
    try {
      r.checkDependencies();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaRegistryError);
      expect((error as SchemaRegistryError).database).toBe('chat_v2');
      expect((error as SchemaRegistryError).missingDependency).toBe('vfs');
      expect((error as Error).message).toBe('Dependency not satisfied: ChatV2 requires Vfs');
    }
  });
  it('test_calculate_global_version', () => {
    const r = SchemaRegistry.aggregateFromDatabases([
      ['vfs', withHistory([[1, 'V1', T, 'a'], [2, 'V2', T, 'b']])],
      ['chat_v2', withHistory([[1, 'V1', T, 'c']])],
      ['llm_usage', withHistory([[1, 'V1', T, 'd'], [2, 'V2', T, 'e'], [3, 'V3', T, 'f']])],
    ]);
    expect(r.globalVersion).toBe(3);
    expect(r.calculateGlobalVersion()).toBe(3);
  });
  it('test_needs_migration', () => {
    const r = SchemaRegistry.aggregateFromDatabases([['vfs', withHistory([[1, 'V1', T, 'a']])]]);
    expect(r.needsMigration('vfs', 2)).toBe(true);
    expect(r.needsMigration('vfs', 1)).toBe(false);
    expect(r.needsMigration('chat_v2', 1)).toBe(true);
  });
  it('test_get_summary', () => {
    const r = SchemaRegistry.aggregateFromDatabases([['vfs', withHistory([[1, 'V1', T, 'a']])], ['chat_v2', withHistory([[1, 'V1', T, 'b'], [2, 'V2', T, 'c']])]]);
    expect(r.getSummary()).toEqual({ vfs: 1, chat_v2: 2 });
  });
  it('test_aggregated_checksum_consistency', () => {
    const r = SchemaRegistry.aggregateFromDatabases([['vfs', withHistory([[1, 'V1', T, 'checksum_a'], [2, 'V2', T, 'checksum_b']])]]);
    const s = r.getStatus('vfs')!;
    expect(s.checksum).toBe(SchemaRegistry.calculateAggregatedChecksum(s.migration_history));
    expect(s.checksum).not.toBe('');
  });
  it('test_data_contract_version_mapping', () => {
    expect(getDataContractVersion(0)).toBe('0.0.0');
    expect(getDataContractVersion(1)).toBe('1.0.0');
    expect(getDataContractVersion(2)).toBe('1.0.0');
    expect(getDataContractVersion(100)).toBe('1.0.0');
  });
  it('test_database_id_dependencies', () => {
    expect(DATABASE_DEPENDENCIES.vfs).toEqual([]);
    expect(DATABASE_DEPENDENCIES.llm_usage).toEqual([]);
    expect(DATABASE_DEPENDENCIES.chat_v2).toEqual(['vfs']);
    expect(DATABASE_DEPENDENCIES.mistakes).toEqual(['vfs']);
  });
  it('test_database_id_all_ordered', () => {
    expect(ALL_ORDERED.length).toBe(4);
    expect(ALL_ORDERED.indexOf('vfs')).toBeLessThan(ALL_ORDERED.indexOf('chat_v2'));
    expect(ALL_ORDERED.indexOf('vfs')).toBeLessThan(ALL_ORDERED.indexOf('mistakes'));
  });
});

describe('coordinator aggregate_schema_registry', () => {
  it('aggregates migrated databases with serde shape and isolates unreadable ones with health', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-reg-'));
    try {
      const c = new MigrationCoordinator({ appDataDir: dir });
      await c.runAll();
      const reg = aggregateSchemaRegistry(c);
      expect(reg.databases.size).toBe(4);
      expect(reg.globalVersion).toBe(Math.max(...ALL_ORDERED.map((id) => c.sets[id].latestVersion())));
      const json = reg.toJSON();
      expect(Object.keys(json.databases).sort()).toEqual(['ChatV2', 'LlmUsage', 'Mistakes', 'Vfs']);
      expect((json.databases.Vfs as { id: string }).id).toBe('Vfs');
      fs.writeFileSync(c.getDatabasePath('chat_v2'), 'not a database at all, definitely not sqlite');
      const health = new StartupComponentHealth();
      const reg2 = aggregateSchemaRegistry(c, health);
      expect(reg2.databases.has('chat_v2')).toBe(false);
      expect(health.isBlocked('chat_v2')).toBe(true);
      expect(() => aggregateSchemaRegistry(c)).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
