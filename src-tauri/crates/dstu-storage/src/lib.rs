//! Deep Student 存储层 crate。
//!
//! 主数据库与连接池（`database`）、数据空间与设备身份（`data_space`）、文件与
//! 统一文件管理（`file_manager` / `unified_file_manager`）、分块上传
//! （`staged_upload`）、启动清理与备份公共工具（`startup_cleanup` /
//! `backup_common`）、批量操作与特性开关（`batch_operations` /
//! `feature_flags`）、注入预算（`injection_budget`）、LLM 用量统计
//! （`llm_usage`），以及原先位于 `data_governance` 的存储级部分：
//! 迁移协调器（`migration`）、schema 注册表（`schema_registry`）、审计日志
//! （`audit`）与本地删除 journal（`file_deletion_queue`）。
//!
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致：app 通过
//! `pub use dstu_storage::xxx` 保留原路径，`data_governance` 再按原路径
//! 重导出 `audit` / `migration` / `schema_registry` / `file_deletion_queue`。

// 拆分前这些模块通过 `crate::models` / `crate::secure_store` / `crate::utils`
// / `crate::startup_gate` 引用这些 crate，保留原路径。
use dstu_core::{llm_config, media_types, models};
use dstu_platform::startup_gate;
use dstu_security::{crypto_publication, secure_store};
use dstu_util::utils;

// 治理部分（audit / migration / schema_registry / file_deletion_queue）拆分前
// 整体位于 `#[cfg(feature = "data_governance")] pub mod data_governance` 内，
// 这里保留同一 feature 门控（app 的三个 profile 都启用该 feature）。
#[cfg(feature = "data_governance")]
pub mod audit;
pub mod backup_common;
pub mod batch_operations;
pub mod data_space;
#[allow(dead_code)]
pub mod database;
pub mod feature_flags;
#[cfg(feature = "data_governance")]
pub mod file_deletion_queue;
pub mod file_manager;
pub mod injection_budget;
pub mod llm_usage; // LLM 使用量统计模块（独立 llm_usage.db）
#[cfg(feature = "data_governance")]
pub mod migration;
#[cfg(feature = "data_governance")]
pub mod schema_registry;
/// SQLite 连接级 VFS writer capability 与 board writer guard。
pub mod sqlite_capability;
pub mod staged_upload; // 大文件分块暂存上传（替代 WebView 内 base64 + JSON IPC）
pub mod startup_cleanup;
#[allow(dead_code)]
pub mod unified_file_manager;
