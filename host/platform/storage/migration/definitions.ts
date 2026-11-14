/**
 * `dstu-storage/src/migration/definitions.rs`：迁移验证契约（表/列/索引/烟测查询/幂等标记）。
 * `sql` 是迁移文件原文（Rust 中 `include_str!`），由 {@link loadMigrationSql} 从迁移目录读取。
 */
import path from 'node:path';
import type { CoordinatedDatabaseName } from '../api.ts';
import { readMigrationSql } from './refinery.ts';

export interface MigrationDefSpec {
  readonly refineryVersion: number;
  readonly name: string;
  /** 相对迁移根目录的文件路径，如 `vfs/V20260130__init.sql`。 */
  readonly file: string;
  readonly expectedTables?: readonly string[];
  readonly expectedColumns?: ReadonlyArray<readonly [string, string]>;
  readonly expectedIndexes?: readonly string[];
  readonly expectedQueries?: readonly string[];
  readonly idempotent?: boolean;
}

export interface MigrationDef {
  readonly refineryVersion: number;
  readonly name: string;
  readonly sql: string;
  readonly expectedTables: readonly string[];
  readonly expectedColumns: ReadonlyArray<readonly [string, string]>;
  readonly expectedIndexes: readonly string[];
  readonly expectedQueries: readonly string[];
  readonly idempotent: boolean;
}

export class MigrationSet {
  readonly databaseName: CoordinatedDatabaseName;
  readonly migrations: readonly MigrationDef[];

  constructor(
    databaseName: CoordinatedDatabaseName,
    migrations: readonly MigrationDef[],
  ) {
    this.databaseName = databaseName;
    this.migrations = migrations;
  }

  /** `MigrationSet::get`。 */
  get(version: number): MigrationDef | undefined {
    return this.migrations.find((m) => m.refineryVersion === version);
  }

  /** `MigrationSet::pending`。 */
  pending(currentVersion: number): MigrationDef[] {
    return this.migrations.filter((m) => m.refineryVersion > currentVersion);
  }

  /** `MigrationSet::latest_version`：最后一项的版本（无则 0）。 */
  latestVersion(): number {
    return this.migrations[this.migrations.length - 1]?.refineryVersion ?? 0;
  }

  count(): number {
    return this.migrations.length;
  }
}

export function loadMigrationSql(migrationsDir: string, file: string): string {
  return readMigrationSql(path.join(migrationsDir, file));
}

export function buildMigrationSet(
  databaseName: CoordinatedDatabaseName,
  specs: readonly MigrationDefSpec[],
  migrationsDir: string,
): MigrationSet {
  return new MigrationSet(
    databaseName,
    specs.map((s) => ({
      refineryVersion: s.refineryVersion,
      name: s.name,
      sql: loadMigrationSql(migrationsDir, s.file),
      expectedTables: s.expectedTables ?? [],
      expectedColumns: s.expectedColumns ?? [],
      expectedIndexes: s.expectedIndexes ?? [],
      expectedQueries: s.expectedQueries ?? [],
      idempotent: s.idempotent ?? false,
    })),
  );
}
