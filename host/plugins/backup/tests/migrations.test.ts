import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import {
  aggregateSchemaRegistry, checkDependencies, getDataContractVersion, type DatabaseOpener,
} from '../repository/schema-registry.ts';
import { databasePath } from '../src/paths.ts';
import { latestVersion } from '../src/migrations.ts';

function fakeOpener(rows: Array<{ version: number; name: string; checksum: string; applied_on: string }>): DatabaseOpener {
  const db = {
    pluck: () => 1,
    all: () => rows,
  } as unknown as SqlExecutor;
  return { open: () => db, close: () => undefined };
}

it('refresh_schema_registry_from_dir_swaps_latest_live_state', () => {
  const root = join(tmpdir(), `dstu-schema-${process.pid}-${Date.now()}`);
  mkdirSync(join(root, 'databases'), { recursive: true });
  writeFileSync(databasePath(root, 'vfs'), '');
  const now = () => '2026-01-01T00:00:00.000Z';

  const first = aggregateSchemaRegistry(root, fakeOpener([
    { version: 1, name: 'V1', checksum: 'abc', applied_on: '2026-01-01T00:00:00Z' },
  ]), now);
  expect(first.databases.get('vfs')?.schema_version).toBe(1);
  expect(first.global_version).toBe(1);
  expect(first.databases.get('vfs')?.max_compatible_version).toBe(latestVersion('vfs'));

  const second = aggregateSchemaRegistry(root, fakeOpener([
    { version: 1, name: 'V1', checksum: 'abc', applied_on: '2026-01-01T00:00:00Z' },
    { version: 2, name: 'V2', checksum: 'def', applied_on: '2026-01-02T00:00:00Z' },
  ]), now);
  expect(second.databases.get('vfs')?.schema_version).toBe(2);
  expect(second.databases.get('vfs')?.checksum).toBe('def');
  expect(second.global_version).toBe(2);
});

it('aggregate_schema_registry_skips_missing_databases', () => {
  const root = join(tmpdir(), `dstu-schema-empty-${process.pid}-${Date.now()}`);
  mkdirSync(join(root, 'databases'), { recursive: true });
  const registry = aggregateSchemaRegistry(root, fakeOpener([]), () => '2026-01-01T00:00:00.000Z');
  expect(registry.databases.size).toBe(0);
  expect(registry.global_version).toBe(0);
});

it('schema_registry_check_dependencies_requires_vfs', () => {
  const root = join(tmpdir(), `dstu-schema-deps-${process.pid}-${Date.now()}`);
  mkdirSync(join(root, 'databases'), { recursive: true });
  writeFileSync(databasePath(root, 'chat_v2'), '');
  const registry = aggregateSchemaRegistry(root, fakeOpener([
    { version: 1, name: 'V1', checksum: 'abc', applied_on: '2026-01-01T00:00:00Z' },
  ]), () => '2026-01-01T00:00:00.000Z');
  expect(() => checkDependencies(registry)).toThrow('Dependency not satisfied: ChatV2 requires Vfs');
});

it('get_data_contract_version_matches_v1_anchor', () => {
  expect(getDataContractVersion(0)).toBe('0.0.0');
  expect(getDataContractVersion(1)).toBe('1.0.0');
  expect(getDataContractVersion(20261005)).toBe('1.0.0');
});
