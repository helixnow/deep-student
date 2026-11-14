/**
 * 四个核心库的迁移契约集合（= Rust `migration/mod.rs` 的 `ALL_MIGRATION_SETS` / `get_migration_set`）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CoordinatedDatabaseName } from '../../api.ts';
import { buildMigrationSet, type MigrationSet } from '../definitions.ts';
import { CHAT_V2_MIGRATIONS } from './chat_v2.ts';
import { LLM_USAGE_MIGRATIONS } from './llm_usage.ts';
import { MISTAKES_MIGRATIONS_LIST } from './mistakes.ts';
import { VFS_MIGRATIONS } from './vfs.ts';

/** 仓库内迁移 SQL 目录（Rust `include_str!("../../../../migrations/...")` 的同一批文件）。 */
export const DEFAULT_MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../resources/app/migrations',
);

/** Rust `ALL_MIGRATION_SETS` 的顺序（VFS → Chat V2 → Mistakes → LLM Usage）。 */
export const ALL_MIGRATION_SET_ORDER = ['vfs', 'chat_v2', 'mistakes', 'llm_usage'] as const;

/** Rust `DATABASE_COUNT`。 */
export const DATABASE_COUNT = 4;

export function loadMigrationSets(migrationsDir: string): Record<CoordinatedDatabaseName, MigrationSet> {
  return {
    vfs: buildMigrationSet('vfs', VFS_MIGRATIONS, migrationsDir),
    chat_v2: buildMigrationSet('chat_v2', CHAT_V2_MIGRATIONS, migrationsDir),
    mistakes: buildMigrationSet('mistakes', MISTAKES_MIGRATIONS_LIST, migrationsDir),
    llm_usage: buildMigrationSet('llm_usage', LLM_USAGE_MIGRATIONS, migrationsDir),
  };
}

/** Rust `get_migration_set(database_name)`：未知名称返回 undefined。 */
export function getMigrationSet(
  sets: Record<CoordinatedDatabaseName, MigrationSet>,
  name: string,
): MigrationSet | undefined {
  switch (name) {
    case 'vfs':
    case 'chat_v2':
    case 'mistakes':
    case 'llm_usage':
      return sets[name];
    default:
      return undefined;
  }
}
