//! 安全存储模块 - 跨平台凭据安全存储
//!
//! 存储实现（`SecureStore`、云存储凭据 API、根种子平台保护）在 dstu-security 的
//! `secure_store` 模块，这里按原路径重导出；Tauri 命令留在 app。依赖云存储配置的
//! hydrate 逻辑（`hydrate_cloud_config` / `hydrate_cloud_config_credentials`）与
//! 安全存储实例构造在 dstu-sync 的 `cloud_credentials`，这里按原路径重导出。

pub use dstu_security::secure_store::*;

// 凭据后端自取（hydrate），拆分前定义在本模块。`hydrate_cloud_config_credentials`
// 拆分前是 pub(crate)，唯一调用方 `cloud_config_commands` 已随 dstu-sync 迁出，不再重导出。
pub use dstu_sync::cloud_credentials::hydrate_cloud_config;

// ==================== Tauri 命令 ====================

use crate::error_details::CommandError;

// 全局安全存储实例（拆分前定义在本模块，现与 hydrate 共用 dstu-sync 的实现）。
use dstu_sync::cloud_credentials::get_secure_store;

/// 保存云存储凭据到安全存储。
///
/// `encryption_password_is_preexisting`：前端在「重输存量口令」入口（换机/
/// 重装恢复、legacy 云配置迁移）置 true，跳过新设口令的最小长度与
/// [Wave2-R5] 弱口令准入；缺省/false 保持新设口令 fail-closed。
#[tauri::command]
pub fn secure_save_cloud_credentials(
    app: tauri::AppHandle,
    credentials: CloudStorageCredentials,
    encryption_password_is_preexisting: Option<bool>,
) -> Result<CloudStorageCredentialStatus, CommandError> {
    let store = get_secure_store(Some(&app));
    store
        .update_cloud_credentials_with_policy(
            &credentials,
            encryption_password_is_preexisting.unwrap_or(false),
        )
        .map_err(|e| e.to_command_error("save_cloud_credentials"))
}

/// 获取云存储凭据存在状态；绝不向 WebView 返回 secret 值。
#[tauri::command]
pub fn secure_get_cloud_credentials(
    app: tauri::AppHandle,
) -> Result<CloudStorageCredentialStatus, CommandError> {
    let store = get_secure_store(Some(&app));
    store
        .cloud_credential_status()
        .map_err(|e| e.to_command_error("get_cloud_credentials"))
}

pub(crate) fn delete_cloud_credentials_for_app(
    app: &tauri::AppHandle,
) -> Result<(), SecureStoreError> {
    get_secure_store(Some(app)).delete_cloud_credentials()
}

/// 删除云存储凭据
#[tauri::command]
pub fn secure_delete_cloud_credentials(app: tauri::AppHandle) -> Result<(), CommandError> {
    delete_cloud_credentials_for_app(&app)
        .map_err(|e| e.to_command_error("delete_cloud_credentials"))
}

/// 显式停用端到端加密：仅从安全存储删除加密密码，传输凭据不受影响。
#[tauri::command]
pub fn secure_clear_cloud_encryption_password(
    app: tauri::AppHandle,
) -> Result<CloudStorageCredentialStatus, CommandError> {
    let store = get_secure_store(Some(&app));
    store
        .clear_cloud_encryption_password()
        .map_err(|e| e.to_command_error("clear_cloud_encryption_password"))
}

/// 检查安全存储是否可用
#[tauri::command]
pub fn secure_store_is_available(app: tauri::AppHandle) -> bool {
    let store = get_secure_store(Some(&app));
    store.is_available()
}

/// 查询「系统钥匙串保护」状态（只读文件系统，不触碰密钥库）
#[tauri::command]
pub fn secure_store_get_keystore_protection(
    app: tauri::AppHandle,
) -> Result<KeystoreProtectionStatus, CommandError> {
    let store = get_secure_store(Some(&app));
    store
        .keystore_protection_status()
        .map_err(|e| e.to_command_error("get_keystore_protection"))
}

/// 开启/关闭「系统钥匙串保护」并立即执行种子迁移。
/// 迁移涉及密钥库读写，可能阻塞在系统授权弹窗上，故用 async 让出主线程。
#[tauri::command]
pub async fn secure_store_set_keystore_protection(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<KeystoreProtectionStatus, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = get_secure_store(Some(&app));
        store
            .set_keystore_protection(enabled)
            .map_err(|e| e.to_command_error("set_keystore_protection"))?;
        store
            .keystore_protection_status()
            .map_err(|e| e.to_command_error("get_keystore_protection"))
    })
    .await
    .map_err(|e| CommandError::new("SECURE_STORE_INTERNAL", format!("任务执行失败: {}", e)))?
}
