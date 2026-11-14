/**
 * `ctx.settings`：应用设置键值存储（F4，移植 `dstu-storage/src/database/mod.rs` 4108–4360）。
 *
 * 存储位置与 Rust 相同：主库 `mistakes`（`<active>/mistakes.db`）的 `settings` 表
 * `(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`，
 * `updated_at` = chrono `Utc::now().to_rfc3339()`（`2026-11-03T02:09:00.123456+00:00` 形式）。
 * 只经 F3 `ctx.storage` 的 `SqlExecutor` 访问，不直连驱动。
 *
 * 敏感键（`ctx.secrets.isSensitiveKey`）的 `*Secret` 方法走安全存储
 * （`<active>/.secure`，即主库所在目录，同 Rust `Database::new` 用 `db_path.parent()`），
 * 绝不明文回退；读取时把遗留的数据库明文迁入安全存储并删除明文行。
 */

import type { SecureStore } from '../secrets/api.ts';
import type { SqlExecutor } from '../storage/api.ts';

/** `get_settings_by_prefix` 的一行（Rust 元组 `(key, value, updated_at)`）。 */
export interface SettingRow {
  key: string;
  value: string;
  updatedAt: string;
}

export interface SettingsStore {
  /** `save_setting`：UPSERT，值未变时不更新 `updated_at`。 */
  save(key: string, value: string): void;
  /** `get_setting`。 */
  get(key: string): string | null;
  /** `delete_setting`：返回是否删除了行。 */
  delete(key: string): boolean;
  /** `get_settings_by_prefix`：`LIKE prefix%`，按 `updated_at DESC`。 */
  listByPrefix(prefix: string): SettingRow[];
  /** `delete_settings_by_prefix`：返回删除行数。 */
  deleteByPrefix(prefix: string): number;

  /** `save_secret`：非敏感键 = `save`；敏感键写安全存储并删除遗留明文行（失败回滚安全副本）。 */
  saveSecret(key: string, value: string): Promise<void>;
  /** `get_secret`：非敏感键 = `get`；敏感键读安全存储，缺失时迁移遗留明文。 */
  getSecret(key: string): Promise<string | null>;
  /** `delete_secret`：敏感键同时删安全存储与数据库，两边都尝试。 */
  deleteSecret(key: string): Promise<boolean>;
}

/**
 * D1 单写者事务接缝：调用方在 F3 事务里把同一个 `SqlExecutor` 传进来，
 * SQL 仍只在本模块执行。消费方不得自己写 `settings` 表。
 */
export interface SettingsWithConn {
  /** `save_setting`（在调用方事务内；UPSERT 值不变时不更新 `updated_at`）。 */
  saveWithConn(conn: SqlExecutor, key: string, value: string): void;
  /** `get_setting`（在调用方事务内）。 */
  getWithConn(conn: SqlExecutor, key: string): string | null;
  /** `delete_setting`（在调用方事务内）。 */
  deleteWithConn(conn: SqlExecutor, key: string): boolean;
  /** `get_settings_by_prefix`（在调用方事务内）。 */
  listByPrefixWithConn(conn: SqlExecutor, prefix: string): SettingRow[];
  /** `delete_settings_by_prefix`（在调用方事务内）。 */
  deleteByPrefixWithConn(conn: SqlExecutor, prefix: string): number;
}

/** 设置错误：`message` 与 Rust anyhow 文案一致（中文）。 */
export class SettingsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SettingsError';
  }
}

export interface SettingsService extends SettingsStore {
  /**
   * 绑定任意库与安全存储（测试库、导入库）。`secureStore = null` 对应 Rust `secure_store: None`
   * （敏感键读写一律拒绝）。
   */
  bind(db: SqlExecutor, secureStore: SecureStore | null): SettingsStore;
}

// 必须引入 Context 才能合并到 cordis 重导出的 Context（而不是新建同名接口）。
import type { Context } from '@deepseek-ai/cordis';
export type { Context };

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** F4：应用设置；真实服务同时提供 D1 的 `*WithConn` 事务接缝。 */
    settings: SettingsService & SettingsWithConn;
  }
}
