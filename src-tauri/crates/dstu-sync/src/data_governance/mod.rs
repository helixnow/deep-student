//! 数据治理的备份 / 同步半区。
//!
//! 拆分前位于 app 的 `data_governance` 模块：`backup`（备份管理器）、`sync`（记录级
//! 同步引擎）、`restore_codes`（恢复稳定错误码）。app 的 `data_governance` 模块按原
//! 路径重导出这三个子模块；命令层（`commands_*`）、初始化（`init`）与 DTO 仍留在 app。

pub mod backup;
pub mod restore_codes;
pub mod sync;

// 存储层模块（原 data_governance::{migration,schema_registry}）已下沉到 dstu-storage；
// `backup` / `sync` 按 `crate::data_governance::xxx` / `super::xxx` 引用它们，这里保留原路径。
use dstu_storage::{migration, schema_registry};
