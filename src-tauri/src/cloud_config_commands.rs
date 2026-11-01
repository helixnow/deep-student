//! Backend SSOT for credential-free cloud-storage configuration.
//!
//! 实现（SSOT 读写、校验/规范化、草稿测试命令 `cloud_config_test_connection_draft`）
//! 在 dstu-sync 的 `cloud_config_commands` 模块，这里按原路径重导出其全部公开项。
//! 取 app `AppState` 的 4 个命令以薄包装留在这里：签名与拆分前完全一致，函数体
//! 委托给 dstu-sync 的 `*_with_database`，传入 `AppState.database`。

pub use dstu_sync::cloud_config_commands::*;

#[tauri::command]
pub async fn cloud_config_ssot_save(
    state: tauri::State<'_, crate::commands::AppState>,
    config: SafeCloudStorageConfig,
) -> Result<CloudConfigSsotResponse, crate::error_details::CommandError> {
    cloud_config_ssot_save_with_database(&state.database, config).await
}

#[tauri::command]
pub async fn cloud_config_ssot_get(
    state: tauri::State<'_, crate::commands::AppState>,
) -> Result<CloudConfigSsotResponse, crate::error_details::CommandError> {
    cloud_config_ssot_get_with_database(&state.database).await
}

/// 事务化发布：staged 凭据 + SSOT 两段写，任一失败回到旧 generation/旧 SSOT。
/// 算法与失败语义见 dstu-sync 的 `cloud_config_publish_with_database`。
#[tauri::command]
pub async fn cloud_config_publish(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
    config: SafeCloudStorageConfig,
    credentials: crate::secure_store::CloudStorageCredentials,
    encryption_password_is_preexisting: Option<bool>,
) -> Result<CloudConfigPublishResponse, crate::error_details::CommandError> {
    cloud_config_publish_with_database(
        app,
        &state.database,
        config,
        credentials,
        encryption_password_is_preexisting,
    )
    .await
}

/// 清除云配置：先事务性删除凭据，再删非敏感 SSOT 记录。
/// 顺序与失败恢复语义见 dstu-sync 的 `cloud_config_ssot_clear_with_database`。
#[tauri::command]
pub async fn cloud_config_ssot_clear(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
) -> Result<CloudConfigSsotResponse, crate::error_details::CommandError> {
    cloud_config_ssot_clear_with_database(app, &state.database).await
}
