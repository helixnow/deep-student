//! Deep Student 同步与备份域 crate（domain 层）。
//!
//! - `cloud_storage`：云存储抽象与 WebDAV / S3 / FTP 实现、ZIP 备份上传下载与版本化、
//!   delta 快照格式与传输、备份/同步租约、坏对象隔离、只读巡检、断点续传，以及
//!   `cloud_storage_*` / `cloud_sync_*` Tauri 命令；
//! - `cloud_config_commands`：凭据无关的云配置 SSOT 与草稿测试命令（取 `AppState` 的
//!   4 个命令以薄包装留在 app 的同名模块）；
//! - `cloud_credentials`：从安全存储补全云配置凭据（拆分前在 app 的 `secure_store`）；
//! - `backup_job_manager`：备份任务管理器（Tauri State）与持久化任务；
//! - `data_governance::{backup, sync, restore_codes}`：备份管理器、记录级同步引擎与
//!   恢复稳定错误码。数据治理的命令层（`commands_*`，依赖 `AppState` / chat_v2 /
//!   mastery）与自动备份调度（`backup_config`）仍留在 app。
//!
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致：app 通过
//! `pub use dstu_sync::xxx`（`data_governance` 子模块在 app 的 `data_governance`
//! 模块内按原路径重导出）保留原路径。对上层能力的回调（主设置库取用、学习者画像
//! 同步合并）由 app 的 `extensions::register_extensions()` 接线。

// 拆分前这些模块通过 `crate::xxx` 引用已下沉到其他 dstu crate 的模块，保留原路径。
use dstu_core::{error_details, models};
use dstu_security::crypto;
use dstu_storage::{backup_common, data_space, database};
// 仅 data_governance（备份/同步引擎）使用，按同样的 cfg 引入避免未使用告警。
#[cfg(feature = "data_governance")]
use dstu_security::crypto_publication;
#[cfg(feature = "data_governance")]
use dstu_vfs::vfs;

/// 拆分前 `crate::secure_store` 是 app 模块：重导出 dstu-security 的 `secure_store`
/// 全部公开项，并定义云配置 hydrate（现位于 [`cloud_credentials`]）。保留原路径。
pub(crate) mod secure_store {
    pub(crate) use crate::cloud_credentials::{
        hydrate_cloud_config, hydrate_cloud_config_credentials,
    };
    pub(crate) use dstu_security::secure_store::*;
}

/// 拆分前 `data_governance::sync::field_merge` 直接调用 app 的
/// `memory::learner_profile::merge_profile_json_for_sync`。保留原路径，转发到
/// [`hooks`] 的 `SyncFieldMerger` 槽位（app 注册 memory 的实现）。
#[cfg(feature = "data_governance")]
pub(crate) mod memory {
    pub(crate) mod learner_profile {
        pub(crate) use crate::hooks::merge_profile_json_for_sync;
    }
}

#[allow(dead_code)]
pub mod backup_job_manager;
#[allow(dead_code)]
pub mod cloud_config_commands;
pub mod cloud_credentials;
#[allow(dead_code)]
pub mod cloud_storage;
pub mod hooks;

// 数据治理（条件编译，需启用 data_governance feature）
#[cfg(feature = "data_governance")]
#[allow(dead_code)]
pub mod data_governance;
