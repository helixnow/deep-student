/**
 * 测试数据库管理（`src-tauri/src/commands.rs:7169-7390`）与播种器
 * （`src-tauri/src/test_utils/database_seed.rs`）。
 *
 * Rust 的测试库是 `FileManager::get_writable_app_data_dir()/test_mistakes.db`；Host 的
 * FileManager 等价物是活动数据空间槽目录（`activeDir`，见 locations.ts），因此测试库与
 * `get_database_info` 报告的是同一路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import { StorageError, type ConnectionProfile, type DatabaseHandle, type StorageLocations } from './api.ts';
import { SqliteDatabase } from './database.ts';

/** `Database::new` 的连接参数（database/mod.rs:1203-1209）：仅 foreign_keys + busy_timeout。 */
const TEST_DATABASE_PROFILE: ConnectionProfile = { foreignKeys: true, busyTimeoutMs: 3000 };

export const TEST_DATABASE_FILE = 'test_mistakes.db';

/** `writable_dir.join("test_mistakes.db")`。 */
export function testDatabasePath(locations: StorageLocations): string {
  return path.join(locations.activeDir, TEST_DATABASE_FILE);
}

/**
 * `Database::new(&test_db_path)`：创建父目录并打开连接。调用方负责关闭。
 * 错误文案保留 Rust anyhow `with_context` 的最外层上下文（Display 不含 source）。
 */
export function openTestDatabase(filePath: string): SqliteDatabase {
  const parent = path.dirname(filePath);
  try {
    fs.mkdirSync(parent, { recursive: true });
  } catch (error) {
    throw new StorageError('SQLITE', `创建数据库目录失败: ${JSON.stringify(parent)}`, { cause: error });
  }
  try {
    return new SqliteDatabase({ name: 'test_mistakes', path: filePath, profile: TEST_DATABASE_PROFILE });
  } catch (error) {
    throw new StorageError('SQLITE', `打开数据库连接失败: ${JSON.stringify(filePath)}`, { cause: error });
  }
}

/** `database_seed.rs:10-26` `SeedConfig`。 */
export interface SeedConfig {
  create_basic_mistakes: boolean;
  create_mistakes_with_chat: boolean;
  create_mistakes_with_attachments: boolean;
  create_diverse_mistakes: boolean;
}

/** `database_seed.rs:28-37` `SeedConfig::default()`：全部为 true。 */
export function defaultSeedConfig(): SeedConfig {
  return {
    create_basic_mistakes: true,
    create_mistakes_with_chat: true,
    create_mistakes_with_attachments: true,
    create_diverse_mistakes: true,
  };
}

/**
 * `commands.rs:7351-7372`：`cfg.get(key).and_then(Value::as_bool).unwrap_or(true)`。
 * 非对象、缺失键、非布尔值一律回退 true（与 Rust `Value::get` 一致）。
 */
export function parseSeedConfig(value: unknown): SeedConfig {
  const field = (key: keyof SeedConfig): boolean => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return true;
    const raw = (value as Record<string, unknown>)[key];
    return typeof raw === 'boolean' ? raw : true;
  };
  return {
    create_basic_mistakes: field('create_basic_mistakes'),
    create_mistakes_with_chat: field('create_mistakes_with_chat'),
    create_mistakes_with_attachments: field('create_mistakes_with_attachments'),
    create_diverse_mistakes: field('create_diverse_mistakes'),
  };
}

/** `database_seed.rs:46-51` `SeedResult`。 */
export interface SeedResult {
  mistakes_created: number;
  messages_created: number;
  errors: string[];
}

/**
 * `database_seed.rs:32-39`：错题模块已废弃，播种是显式空操作（返回 0/0/[]）。
 * 保留 `_db`/`_config` 参数与返回值形状，避免调用方误以为播种会写入数据。
 */
export function seedTestDatabase(_db: DatabaseHandle, _config: SeedConfig): SeedResult {
  return { mistakes_created: 0, messages_created: 0, errors: [] };
}
