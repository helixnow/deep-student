//! # Migration 模块
//!
//! 统一的数据库迁移框架，基于 Refinery 实现。
//!
//! ---
//!
//! # ⚠️ 迁移脚本编写规范（必读）
//!
//! ## 核心原则
//!
//! 1. **事务原子性**：通过 `set_grouped(true)` 确保整个迁移在单个事务中执行，失败自动回滚
//! 2. **幂等设计**：脚本可以安全重复执行，使用 `IF EXISTS` / `IF NOT EXISTS`
//! 3. **防御性清理**：迁移前清理孤儿数据和中间状态表
//! 4. **永不修改历史**：已发布的迁移脚本不可修改，通过新脚本修复问题
//!
//! ## SQL 脚本模板
//!
//! ```sql
//! -- ============================================================================
//! -- Vyyyymmdd: [迁移描述]
//! -- ============================================================================
//!
//! -- STEP 0: 中间状态清理（处理之前失败的迁移遗留）
//! DROP TABLE IF EXISTS target_table_new;
//!
//! -- STEP 1: 数据完整性修复（删除违反新约束的数据）
//! DELETE FROM child_table WHERE parent_id NOT IN (SELECT id FROM parent_table);
//!
//! -- STEP 2: 创建新表
//! CREATE TABLE target_table_new (...);
//!
//! -- STEP 3: 复制数据
//! INSERT INTO target_table_new SELECT * FROM target_table;
//!
//! -- STEP 4: 替换表
//! DROP TABLE target_table;
//! ALTER TABLE target_table_new RENAME TO target_table;
//!
//! -- STEP 5: 重建索引
//! CREATE INDEX IF NOT EXISTS idx_xxx ON target_table(...);
//! ```
//!
//! ## 发版后修复错误迁移
//!
//! **禁止**：修改已发布的迁移脚本（Refinery 会检测 checksum 变化）
//!
//! **正确做法**：创建新的修复迁移脚本，处理所有可能的状态：
//! - 状态 A：原迁移成功执行 → 无操作
//! - 状态 B：原迁移失败，有中间状态 → 清理后重新执行
//! - 状态 C：原迁移从未执行 → 完整执行
//!
//! ## 检查清单
//!
//! - [ ] STEP 0: `DROP TABLE IF EXISTS xxx_new` (中间状态清理)
//! - [ ] STEP 1: `DELETE` 违反约束的数据 (数据完整性修复)
//! - [ ] 使用 `IF EXISTS` / `IF NOT EXISTS` 确保幂等
//! - [ ] 测试：正常数据 / 有孤儿数据 / 有中间状态表 / 重复执行
//!
//! ---
//!
//! ## 设计原则
//!
//! 1. **统一框架**：所有数据库使用同一套迁移机制
//! 2. **验证机制**：每个迁移配套验证配置，执行后自动验证
//! 3. **依赖排序**：按数据库依赖关系排序执行
//! 4. **审计追踪**：所有迁移操作记录审计日志
//!
//! ## 版本号规范
//!
//! 采用时间戳 + 序号格式，避免多人协作冲突：
//! ```text
//! V20260130_001__init.sql
//! V20260130_002__add_index.sql
//! ```
//!
//! ## 组件
//!
//! - `coordinator`: 多库迁移协调器
//! - `definitions`: 迁移定义（含验证配置）
//! - `verifier`: 迁移后验证
//! - `script_checker`: **迁移脚本静态检查器**（编译时反模式检测）
//! - `vfs`: VFS 数据库迁移定义
//! - `chat_v2`: Chat V2 数据库迁移定义
//! - `mistakes`: 主数据库迁移定义（历史命名）
//! - `llm_usage`: LLM 使用统计数据库迁移定义
//!
//! ## 使用示例
//!
//! ```rust,ignore
//! use crate::migration::{MigrationCoordinator, ALL_MIGRATION_SETS};
//!
//! // 查看所有迁移集合
//! for set in ALL_MIGRATION_SETS {
//!     println!("Database: {}, Migrations: {}", set.database_name, set.migrations.len());
//! }
//!
//! // 执行迁移
//! let mut coordinator = MigrationCoordinator::new(app_data_dir);
//! let report = coordinator.run_all()?;
//! ```

// ============================================================================
// 子模块
// ============================================================================

pub mod chat_v2;
pub mod coordinator;
pub mod definitions;
pub mod llm_usage;
pub mod mistakes;
pub mod script_checker;
pub mod verifier;
pub mod vfs;

// ============================================================================
// Re-exports - 核心类型
// ============================================================================

// 协调器
pub use coordinator::{DatabaseMigrationReport, MigrationCoordinator, MigrationReport};

// 定义类型
pub use definitions::{MigrationDef, MigrationSet};

// 验证器
pub use verifier::MigrationVerifier;

// ============================================================================
// Re-exports - 各数据库迁移集合
// ============================================================================

pub use chat_v2::CHAT_V2_MIGRATION_SET;
pub use llm_usage::LLM_USAGE_MIGRATION_SET;
pub use mistakes::MISTAKES_MIGRATIONS;
pub use vfs::VFS_MIGRATION_SET;

// ============================================================================
// 聚合常量
// ============================================================================

/// 所有数据库的迁移集合
///
/// 按依赖顺序排列：
/// 1. VFS - 核心资源存储（无依赖）
/// 2. Chat V2 - 聊天系统（依赖 VFS）
/// 3. Mistakes - 主数据库（依赖 VFS）
/// 4. LLM Usage - LLM 使用统计（无依赖）
///
/// ## 使用示例
///
/// ```rust,ignore
/// for set in ALL_MIGRATION_SETS {
///     println!("Database: {}", set.database_name);
///     println!("  Latest version: {}", set.latest_version());
///     println!("  Migrations: {}", set.migrations.len());
/// }
/// ```
pub const ALL_MIGRATION_SETS: &[&MigrationSet] = &[
    &VFS_MIGRATION_SET,
    &CHAT_V2_MIGRATION_SET,
    &MISTAKES_MIGRATIONS,
    &LLM_USAGE_MIGRATION_SET,
];

/// 数据库数量
pub const DATABASE_COUNT: usize = 4;

/// 获取指定数据库的迁移集合
///
/// ## 参数
/// - `database_name`: 数据库名称（vfs, chat_v2, mistakes, llm_usage）
///
/// ## 返回
/// - `Some(&MigrationSet)`: 找到对应的迁移集合
/// - `None`: 未知的数据库名称
pub fn get_migration_set(database_name: &str) -> Option<&'static MigrationSet> {
    match database_name {
        "vfs" => Some(&VFS_MIGRATION_SET),
        "chat_v2" => Some(&CHAT_V2_MIGRATION_SET),
        "mistakes" => Some(&MISTAKES_MIGRATIONS),
        "llm_usage" => Some(&LLM_USAGE_MIGRATION_SET),
        _ => None,
    }
}

// ============================================================================
// 错误类型
// ============================================================================

/// 迁移错误
#[derive(Debug, thiserror::Error)]
pub enum MigrationError {
    #[error("Database error: {0}")]
    Database(String),

    #[error("Refinery error: {0}")]
    Refinery(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Checksum mismatch for migration {version}: expected {expected}, got {actual}")]
    ChecksumMismatch {
        version: u32,
        expected: String,
        actual: String,
    },

    #[error("Migration {version} failed: {reason}")]
    MigrationFailed { version: u32, reason: String },

    #[error("Verification failed for migration {version}: {reason}")]
    VerificationFailed { version: u32, reason: String },

    #[error("Dependency not satisfied: {database} requires {dependency}")]
    DependencyNotSatisfied {
        database: String,
        dependency: String,
    },

    #[error("Insufficient disk space: {available_mb}MB available, need at least {required_mb}MB. Please free up disk space and retry.")]
    InsufficientDiskSpace { available_mb: u64, required_mb: u64 },

    #[error("Migration failed but recovered from backup: {original_error} (restored {restored_count} databases)")]
    RecoveredFromBackup {
        original_error: String,
        restored_count: usize,
    },

    #[error("Not implemented: {0}")]
    NotImplemented(String),
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_all_migration_sets_count() {
        assert_eq!(ALL_MIGRATION_SETS.len(), DATABASE_COUNT);
    }

    #[test]
    fn test_all_migration_sets_names() {
        let names: Vec<&str> = ALL_MIGRATION_SETS
            .iter()
            .map(|set| set.database_name)
            .collect();
        assert!(names.contains(&"vfs"));
        assert!(names.contains(&"chat_v2"));
        assert!(names.contains(&"mistakes"));
        assert!(names.contains(&"llm_usage"));
    }

    #[test]
    fn test_get_migration_set() {
        assert!(get_migration_set("vfs").is_some());
        assert!(get_migration_set("chat_v2").is_some());
        assert!(get_migration_set("mistakes").is_some());
        assert!(get_migration_set("llm_usage").is_some());
        assert!(get_migration_set("unknown").is_none());
    }

    #[test]
    fn test_all_sets_have_migrations() {
        for set in ALL_MIGRATION_SETS {
            assert!(
                !set.migrations.is_empty(),
                "Database {} has no migrations",
                set.database_name
            );
        }
    }

    #[test]
    fn test_all_sets_have_valid_versions() {
        for set in ALL_MIGRATION_SETS {
            assert!(
                set.latest_version() > 0,
                "Database {} has invalid latest version",
                set.database_name
            );
        }
    }

    /// 自动检查所有迁移脚本是否符合健壮性规范
    ///
    /// 此测试在编译时自动运行，确保新增的迁移脚本符合规范。
    /// 如果脚本确认无问题，可在脚本中添加 `-- @skip-check: <rule_name>` 跳过检查。
    #[test]
    fn test_all_migration_scripts_pass_checker() {
        use crate::migration::script_checker::check_migration_script;

        let mut all_passed = true;
        let mut error_messages = Vec::new();

        for set in ALL_MIGRATION_SETS {
            for migration in set.migrations.iter() {
                let script_name = format!("{}:{}", set.database_name, migration.name);
                let result = check_migration_script(&script_name, migration.sql);

                if !result.passed {
                    all_passed = false;
                    let mut msg = format!("\n❌ {}\n", script_name);
                    for error in &result.errors {
                        msg.push_str(&format!("   [{}] {}\n", error.rule, error.message));
                        msg.push_str(&format!("   💡 {}\n", error.suggestion));
                    }
                    error_messages.push(msg);
                }

                // 打印警告但不失败
                for warning in &result.warnings {
                    eprintln!("⚠️ [{}] {}: {}", warning.rule, script_name, warning.message);
                }
            }
        }

        if !all_passed {
            panic!(
                "\n\n迁移脚本检查失败:\n{}\n\n如果确认无问题，可在脚本中添加: -- @skip-check: <rule_name>\n",
                error_messages.join("\n")
            );
        }
    }
}
