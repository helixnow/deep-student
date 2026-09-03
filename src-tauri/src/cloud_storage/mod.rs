//! 云存储模块
//!
//! 提供统一的云存储访问层，支持 WebDAV 和 S3 兼容存储。
//!
//! ## 支持的存储后端
//! - **WebDAV**: 坚果云、Nextcloud、自建 WebDAV 等
//! - **S3**: AWS S3、Cloudflare R2、阿里云 OSS、MinIO 等
//!
//! ## 使用示例
//! ```rust,ignore
//! use cloud_storage::{create_storage, CloudStorageConfig, StorageProvider};
//!
//! let config = CloudStorageConfig {
//!     provider: StorageProvider::S3,
//!     s3: Some(S3Config { ... }),
//!     ..Default::default()
//! };
//!
//! let storage = create_storage(&config).await?;
//! storage.put("backups/data.zip", &data).await?;
//! ```

/// [R12-delta-lease] backup-v2 / GC 独立仓库租约（`backup-v2/locks/`，零生产接线；
/// 裁决见 docs/dev/wave2-D-backup-v2-decision.md）。
pub mod backup_lease;
/// [R4-bad-write] 坏正式对象收敛：隔离到 `.quarantine/`（附原因记录）+
/// 已校验 `.tmp` 优先收敛；只有坏正式对象时 fail-closed。零生产接线。
pub mod bad_object;
mod config;
// ============================================================================
// [Wave2-D R5 裁决] backup-v2 / delta 原语族 = **experimental 隔离**。
//
// 上方 backup_lease 与下方四个 delta_* 模块只是「未变文件复用 / 增量传输」的
// 未接线积木：仅 sync_r12_* 集成测试消费，生产 Cloud backup/restore 默认路径
// 仍是「全量 ZIP → 单对象 put/get」，不得因这些模块存在而宣称增量备份已实现。
// 引用面由 sync_r12_* 源码锁（字面子串 × `src/**/*.rs` 文件白名单）钉死：
// 本文件只允许出现各模块的裸声明行，禁止 pub use、禁止命令层导出。
// 裁决记录与接线前置清单：docs/dev/wave2-D-backup-v2-decision.md。
// ============================================================================
/// [R12-delta-format] backup-v2 快照/仓库配置纯 codec（experimental，零生产接线）。
pub mod delta_format;
/// [R12-delta-gc] backup-v2 两遍 candidate/grace GC 原语（experimental，零生产接线）。
pub mod delta_gc;
/// [R12-delta-restore] backup-v2 快照恢复原语（experimental，零生产接线）。
pub mod delta_restore;
/// [R12-delta-upload] backup-v2 快照发布原语（experimental，零生产接线）。
pub mod delta_upload;
/// [R4-e2ee-cas] `.encryption-marker` 首次认领 / v1 升级的租约认领协议
/// （能力探测 + `.encryption-marker.lease` 双寄存器互斥，替代盲 PUT）。
pub mod e2ee_claim;
#[cfg(not(target_os = "android"))]
mod ftp;
/// [R11-check] 云端仓库巡检（restic `check` 档，只读不修）
pub mod repo_check;
/// 断点续传下载编排（巡检 / 文件级对象共用；整包 ZIP 仍走 sync_manager）。
pub(crate) mod resume;
#[cfg(feature = "cloud_storage_s3")]
mod s3;
/// [R11-lease] 记录级同步的云端目标租约（TTL、陈旧回收、两阶段选主）。
pub mod sync_lease;
mod sync_manager;
mod traits;
/// [R4-verified-publish] 验证式发布原语（PUT 暂存 → 有界回读 → 发布 → 再回读，零生产接线）。
pub mod verified_publish;
mod webdav;

pub use config::{
    CloudStorageConfig, CloudStorageConfigError, FtpConfig, PlatformStorageCapabilities, S3Config,
    StorageProvider, WebDavConfig,
};
pub(crate) use sync_manager::normalize_device_id;
pub use sync_manager::{
    device_id_short_hash, generate_device_id_after_restore, get_device_id,
    last_encryption_memory_persist_failure, persist_device_id_after_restore,
    rotate_device_id_after_restore, BackupVersion, CloudManifest, CloudSyncManager, DownloadResult,
    EncryptionMarker, EncryptionMemoryPersistFailure, SyncStatus, UploadResult,
};
pub use traits::{
    CloudStorage, DownloadProgressCallback, FileInfo, ListOutcome, Result, UploadProgressCallback,
    RESUMABLE_DOWNLOAD_UNSUPPORTED,
};

/// 本端启用加密后拒收明文遗留对象 / 拒明文上传。
pub const SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE: &str = "E_SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED";
/// 密码与云端既有备份不一致，或 DSBK 解密失败。
pub const SYNC_E2EE_WRONG_PASSWORD_CODE: &str = "E_SYNC_E2EE_WRONG_PASSWORD";
/// `.encryption-marker` 损坏、缺校验子或无法校验。
pub const SYNC_E2EE_MARKER_CORRUPTED_CODE: &str = "E_SYNC_E2EE_MARKER_CORRUPTED";
/// 云端已加密，但本机未提供 / 未配置解密密码。
pub const SYNC_E2EE_PASSWORD_REQUIRED_CODE: &str = "E_SYNC_E2EE_PASSWORD_REQUIRED";
/// [R4-antidegrade] 云端已登记加密标记（`.encryption-marker`），但下载到的备份
/// 对象头部不是 DSBK 魔数——疑似密文被明文替换（降级攻击）或云端目录被篡改，
/// 下载侧必须拒收，不得把该对象当明文备份「原样保留」为成功。
pub const SYNC_E2EE_DOWNGRADE_REJECTED_CODE: &str = "E_SYNC_E2EE_DOWNGRADE_REJECTED";
/// [P11] 「本机加密目录记忆」（第二道明文防线）持久化失败：不阻断本次云操作，
/// 但本机记忆降级，经 `SyncStatus.encryptionMemoryPersistFailure` 暴露到设置页。
pub const SYNC_E2EE_MEMORY_PERSIST_FAILED_CODE: &str = "E_SYNC_E2EE_MEMORY_PERSIST_FAILED";

/// 给 E2EE fail-closed 诊断加上稳定 code，文案仍可改语言。
pub fn sync_e2ee_error(code: &'static str, message: impl std::fmt::Display) -> String {
    format!("[{code}] {message}")
}

/// [R4-antidegrade][R6-downgrade-optin] 下载侧防降级判定
/// （纯函数，供 `cloud_sync_download` 与单测共用）。
///
/// - `cloud_marker_present`：云端 `.encryption-marker` 是否存在。上游读取采用
///   fail-closed 语义：标记对象存在但内容损坏时同样视为「存在」，宁可多拦一次
///   也不放行可疑明文。
/// - `locally_remembered_encrypted`：[R6] 本机「该云端目录曾经加密」记忆
///   （`EncryptedRootMemory`，P11 明文上传第二道防线）是否命中。云端标记与
///   备份对象在攻击者可写的同一云端，标记被删除后仅剩这道本机门；记忆文件
///   损坏按命中处理（fail-closed，语义在 `was_encrypted` 内部）。
/// - `object_is_encrypted`：下载对象头 4 字节是否为 DSBK 魔数。
/// - `plaintext_history_opt_in`：[R6] 用户对**本次下载**显式确认「我知道这是
///   启用加密前的旧明文版本，仍要恢复」。一次一确认：该值只来自本次命令参数，
///   不写入任何持久开关；默认 `false`，明文历史不得默认成功。opt-in 只放宽
///   本判定，不放宽恢复链后续的整槽校验，对 DSBK 密文对象无任何影响。
///
/// 判定（对象为 DSBK 密文时一律放行走解密链）：
/// - 标记存在 + 非 DSBK：该 root 的恢复链应当全部为密文，出现明文对象说明
///   密文被替换或云端被降级篡改，无 opt-in 时返回
///   [`SYNC_E2EE_DOWNGRADE_REJECTED_CODE`]；
/// - 标记不存在 + 本机记忆命中 + 非 DSBK：[R6 双门] 标记可能已被攻击者删除，
///   无 opt-in 时同码拒绝，不因删 marker 而回到「合法明文」象限；
/// - 标记不存在 + 无本机记忆 + 非 DSBK：预 E2EE 时代的合法明文备份，放行；
/// - 标记不存在 + DSBK：v0.9.44 等旧版加密但未写标记，放行走解密路径。
pub(crate) fn ensure_download_not_degraded(
    cloud_marker_present: bool,
    locally_remembered_encrypted: bool,
    object_is_encrypted: bool,
    plaintext_history_opt_in: bool,
) -> Result<()> {
    if object_is_encrypted {
        return Ok(());
    }
    if !cloud_marker_present && !locally_remembered_encrypted {
        // 预 E2EE 时代的合法明文备份，保持现行为放行。
        return Ok(());
    }
    if plaintext_history_opt_in {
        tracing::warn!(
            "[CloudSync][R6-downgrade-optin] 用户显式确认恢复明文历史版本，本次放行\
             （云端标记存在: {cloud_marker_present}, 本机曾加密记忆: {locally_remembered_encrypted}）。\
             该确认不持久化，仅对本次下载有效。"
        );
        return Ok(());
    }
    if cloud_marker_present {
        return Err(AppError::validation(sync_e2ee_error(
            SYNC_E2EE_DOWNGRADE_REJECTED_CODE,
            "云端已登记端到端加密标记，但下载到的备份对象不是 DSBK 密文，疑似密文被明文替换\
             （降级攻击）或云端目录被篡改，已拒绝还原该对象。请人工核查云端目录完整性后重试。",
        )));
    }
    Err(AppError::validation(sync_e2ee_error(
        SYNC_E2EE_DOWNGRADE_REJECTED_CODE,
        "云端加密标记已缺失，但本机记忆显示该云端目录曾启用端到端加密，且下载到的备份对象\
         不是 DSBK 密文——疑似云端目录被降级篡改（加密标记被删除、密文被明文替换），\
         已拒绝还原该对象。请人工核查云端目录完整性后重试。",
    )))
}

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::models::{AppError, AppErrorType};
#[cfg(not(target_os = "android"))]
use ftp::FtpStorage;
#[cfg(feature = "cloud_storage_s3")]
use s3::S3Storage;
use webdav::WebDavStorage;

/// 云同步操作进度事件（通过 `cloud-sync-progress` 事件发送到前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudSyncProgressEvent {
    /// 关联一次完整操作，避免并发/迟到事件串台。
    operation_id: String,
    /// 操作类型: "upload" | "download"
    operation: &'static str,
    /// 阶段标识: "transferring" | "done"
    stage: &'static str,
    /// 阶段描述（面向用户的中文说明）
    stage_label: &'static str,
    /// 已传输字节数
    bytes_done: u64,
    /// 总字节数（0 = 未知）
    bytes_total: u64,
    /// 传输进度百分比 0.0–100.0（仅文件传输阶段有意义）
    percent: f32,
}

fn emit_sync_progress(app: &AppHandle, event: CloudSyncProgressEvent) {
    if let Err(e) = app.emit("cloud-sync-progress", &event) {
        tracing::warn!("[CloudSync] 进度事件发射失败: {}", e);
    }
}

/// 根据配置创建存储实例
///
/// # Arguments
/// * `config` - 云存储配置
///
/// # Returns
/// 实现了 CloudStorage trait 的存储实例
pub async fn create_storage(config: &CloudStorageConfig) -> Result<Box<dyn CloudStorage>> {
    create_storage_with_capabilities(config, PlatformStorageCapabilities::current()).await
}

/// 同 [`create_storage`]，显式注入后端能力（测试钩子，行为等价）。
///
/// 校验先行：能力不支持的 provider 在 `validate_with_capabilities` 即被拒绝，
/// 稳定 code 与 SSOT 保存/加载路径一致；下方按编译期能力保留的兜底分支使用
/// 同一 code/message 常量，保证任何路径都不会把面向编译者的提示暴露给终端用户
/// （RESTORE-MATRIX P3-2）。
pub async fn create_storage_with_capabilities(
    config: &CloudStorageConfig,
    capabilities: PlatformStorageCapabilities,
) -> Result<Box<dyn CloudStorage>> {
    // 验证配置（含不可用 provider 的显式拒绝）
    config
        .validate_with_capabilities(capabilities)
        .map_err(config_error_to_app_error)?;

    let root = config.root();

    match config.provider {
        StorageProvider::WebDav => {
            let webdav_config = config
                .webdav
                .clone()
                .ok_or_else(|| AppError::validation("缺少 WebDAV 配置"))?;
            let storage = WebDavStorage::new(webdav_config, root)?;
            Ok(Box::new(storage))
        }
        #[cfg(feature = "cloud_storage_s3")]
        StorageProvider::S3 => {
            let s3_config = config
                .s3
                .clone()
                .ok_or_else(|| AppError::validation("缺少 S3 配置"))?;
            let storage = S3Storage::new(s3_config, root).await?;
            Ok(Box::new(storage))
        }
        #[cfg(not(feature = "cloud_storage_s3"))]
        StorageProvider::S3 => Err(platform_capability_app_error(
            crate::cloud_config_commands::S3_UNSUPPORTED_IN_BUILD_CODE,
            crate::cloud_config_commands::S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE,
        )),
        #[cfg(not(target_os = "android"))]
        StorageProvider::Ftp => {
            let ftp_config = config
                .ftp
                .clone()
                .ok_or_else(|| AppError::validation("缺少 FTP 配置"))?;
            let storage = FtpStorage::new(ftp_config, root)?;
            Ok(Box::new(storage))
        }
        #[cfg(target_os = "android")]
        StorageProvider::Ftp => Err(platform_capability_app_error(
            crate::cloud_config_commands::FTP_UNSUPPORTED_ON_ANDROID_CODE,
            crate::cloud_config_commands::FTP_UNSUPPORTED_ON_ANDROID_MESSAGE,
        )),
    }
}

fn platform_capability_app_error(code: &'static str, message: impl Into<String>) -> AppError {
    AppError::with_details(
        AppErrorType::Configuration,
        message,
        serde_json::json!({ "code": code }),
    )
}

fn config_error_to_app_error(error: CloudStorageConfigError) -> AppError {
    match error.code() {
        Some(code) => platform_capability_app_error(code, error.to_string()),
        None => AppError::validation(error.to_string()),
    }
}

// ============== Tauri Commands ==============

/// 检查云存储连接
#[tauri::command]
pub async fn cloud_storage_check_connection(
    app: AppHandle,
    mut config: CloudStorageConfig,
) -> Result<bool> {
    crate::secure_store::hydrate_cloud_config(&app, &mut config);
    let storage = create_storage(&config).await?;
    storage.check_connection().await?;
    Ok(true)
}

/// 上传文件到云存储
#[tauri::command]
pub async fn cloud_storage_put(
    app: AppHandle,
    mut config: CloudStorageConfig,
    key: String,
    data: Vec<u8>,
) -> Result<()> {
    crate::secure_store::hydrate_cloud_config(&app, &mut config);
    let storage = create_storage(&config).await?;
    storage.put(&key, &data).await
}

/// 从云存储下载文件
#[tauri::command]
pub async fn cloud_storage_get(
    app: AppHandle,
    mut config: CloudStorageConfig,
    key: String,
) -> Result<Option<Vec<u8>>> {
    crate::secure_store::hydrate_cloud_config(&app, &mut config);
    let storage = create_storage(&config).await?;
    storage.get(&key).await
}

/// 列出云存储中的文件
#[tauri::command]
pub async fn cloud_storage_list(
    app: AppHandle,
    mut config: CloudStorageConfig,
    prefix: String,
) -> Result<Vec<FileInfo>> {
    crate::secure_store::hydrate_cloud_config(&app, &mut config);
    let storage = create_storage(&config).await?;
    storage.list(&prefix).await
}

/// 删除云存储中的文件
#[tauri::command]
pub async fn cloud_storage_delete(
    app: AppHandle,
    mut config: CloudStorageConfig,
    key: String,
) -> Result<()> {
    crate::secure_store::hydrate_cloud_config(&app, &mut config);
    let storage = create_storage(&config).await?;
    storage.delete(&key).await
}

/// 获取文件信息
#[tauri::command]
pub async fn cloud_storage_stat(
    app: AppHandle,
    mut config: CloudStorageConfig,
    key: String,
) -> Result<Option<FileInfo>> {
    crate::secure_store::hydrate_cloud_config(&app, &mut config);
    let storage = create_storage(&config).await?;
    storage.stat(&key).await
}

/// 检查文件是否存在
#[tauri::command]
pub async fn cloud_storage_exists(
    app: AppHandle,
    mut config: CloudStorageConfig,
    key: String,
) -> Result<bool> {
    crate::secure_store::hydrate_cloud_config(&app, &mut config);
    let storage = create_storage(&config).await?;
    storage.exists(&key).await
}

// ============== Sync Manager Commands ==============

/// 获取同步状态
#[tauri::command]
pub async fn cloud_sync_get_status(
    app: AppHandle,
    mut config: CloudStorageConfig,
) -> Result<SyncStatus> {
    crate::secure_store::hydrate_cloud_config(&app, &mut config);
    let storage = create_storage(&config).await?;
    let manager = CloudSyncManager::new(storage, get_device_id());
    Ok(manager.get_status().await)
}

/// 列出云端所有备份版本
#[tauri::command]
pub async fn cloud_sync_list_versions(
    app: AppHandle,
    mut config: CloudStorageConfig,
) -> Result<Vec<BackupVersion>> {
    crate::secure_store::hydrate_cloud_config(&app, &mut config);
    let storage = create_storage(&config).await?;
    let manager = CloudSyncManager::new(storage, get_device_id());
    manager.list_versions().await
}

/// 上传备份到云端（带实时进度事件）
///
/// 通过 `cloud-sync-progress` Tauri 事件向前端推送字节级传输进度。
#[tauri::command]
pub async fn cloud_sync_upload(
    app_handle: AppHandle,
    mut config: CloudStorageConfig,
    zip_path: String,
    app_version: Option<String>,
    note: Option<String>,
    recovery_kind: Option<String>,
) -> Result<UploadResult> {
    crate::secure_store::hydrate_cloud_config(&app_handle, &mut config);
    let _operation = crate::backup_common::DataGovernanceOperationGuard::try_acquire(
        crate::backup_common::DataGovernanceOperationKind::Backup,
        None,
    )?;
    let operation_id = _operation.operation_id().to_string();

    let storage = create_storage(&config).await?;
    let manager = CloudSyncManager::new(storage, get_device_id());

    let encryption_password = config.encryption_password.clone().filter(|s| !s.is_empty());

    // [R02-e2ee][R06-e2ee-verifier] 上传前执行端到端加密一致性策略：
    // - 有密码：校验云端加密标记（.encryption-marker）中的不可逆密码校验子——
    //   配错密码的设备在写入任何 backups/ 对象之前即失败，不会向同一 root 写入
    //   另一套无法互解的密文；无标记时登记带校验子的标记，旧版无校验子标记
    //   以本机密码一次性升级（损坏/异常标记 fail-closed）；
    // - 无密码：若该 root 已有加密标记，直接拒绝明文上传，避免同一恢复链上
    //   明文/密文混布（换机无密码时可能误还原明文旧版本、泄露本应加密的数据）。
    manager
        .enforce_encryption_policy_before_upload_with_password(encryption_password.as_deref())
        .await?;

    // 如果配置了加密密码，先把 ZIP 加密到临时文件再上传
    // 临时文件在 ZIP 附近创建，上传成功后删除
    let mut encrypted_temp: Option<tempfile::TempPath> = None;
    let actual_upload_path: std::path::PathBuf = if let Some(pwd) = encryption_password.as_deref() {
        tracing::info!("[CloudSync] 端到端加密已启用，流式加密上传...");
        // [F14] 流式分块加密到临时文件（同目录 → 同一文件系统，rename/上传快），
        // 内存占用恒定，避免多 GB 备份一次性读入内存导致 OOM。
        let original = std::path::Path::new(&zip_path);
        let parent = original
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."));
        let temp_path = tempfile::Builder::new()
            .prefix(".cloud-upload-")
            .suffix(".dsbk")
            .tempfile_in(parent)
            .map_err(|e| AppError::file_system(format!("创建加密临时文件失败: {}", e)))?
            .into_temp_path();
        crate::crypto::backup_crypto::encrypt_backup_file(original, &temp_path, pwd)
            .map_err(|e| AppError::internal(format!("加密备份失败: {}", e)))?;
        let path = temp_path.to_path_buf();
        encrypted_temp = Some(temp_path);
        path
    } else {
        std::path::Path::new(&zip_path).to_path_buf()
    };

    let file_size = std::fs::metadata(&actual_upload_path)
        .map_err(|error| {
            AppError::file_system(format!(
                "读取待上传备份大小失败 {:?}: {}",
                actual_upload_path, error
            ))
        })?
        .len();

    emit_sync_progress(
        &app_handle,
        CloudSyncProgressEvent {
            operation_id: operation_id.clone(),
            operation: "upload",
            stage: "transferring",
            stage_label: "正在上传文件...",
            bytes_done: 0,
            bytes_total: file_size,
            percent: 0.0,
        },
    );

    let handle = app_handle.clone();
    let progress_operation_id = operation_id.clone();
    let progress_cb: traits::UploadProgressCallback = Box::new(move |done, total| {
        let pct = if total > 0 {
            (done as f32 / total as f32 * 95.0).min(95.0)
        } else {
            0.0
        };
        emit_sync_progress(
            &handle,
            CloudSyncProgressEvent {
                operation_id: progress_operation_id.clone(),
                operation: "upload",
                stage: "transferring",
                stage_label: "正在上传文件...",
                bytes_done: done,
                bytes_total: total,
                percent: pct,
            },
        );
    });

    let upload_result = manager
        .upload_with_progress(
            &actual_upload_path,
            app_version,
            note,
            recovery_kind,
            Some(progress_cb),
        )
        .await;

    // TempPath 在成功和错误路径都会自动清理，且每次操作使用独立随机文件名。
    drop(encrypted_temp);

    let result = upload_result?;

    emit_sync_progress(
        &app_handle,
        CloudSyncProgressEvent {
            operation_id,
            operation: "upload",
            stage: "done",
            stage_label: "上传完成",
            bytes_done: file_size,
            bytes_total: file_size,
            percent: 100.0,
        },
    );

    Ok(result)
}

/// 从云端下载备份（带实时进度事件）
///
/// 通过 `cloud-sync-progress` Tauri 事件向前端推送字节级下载进度。
///
/// `allow_plaintext_history`：[R6-downgrade-optin] 用户对**本次下载**显式确认
/// 「恢复启用加密前的旧明文版本」。缺省 / `false` 保持防降级默认拒；`true`
/// 仅放宽 [`ensure_download_not_degraded`] 这一道判定（恢复链后续整槽校验
/// 不受影响）。该参数不来自 `CloudStorageConfig`、不写入任何持久开关——
/// 一次调用一次确认。
#[tauri::command]
pub async fn cloud_sync_download(
    app_handle: AppHandle,
    mut config: CloudStorageConfig,
    version_id: Option<String>,
    local_dir: String,
    allow_plaintext_history: Option<bool>,
) -> Result<DownloadResult> {
    crate::secure_store::hydrate_cloud_config(&app_handle, &mut config);
    let _operation = crate::backup_common::DataGovernanceOperationGuard::try_acquire(
        crate::backup_common::DataGovernanceOperationKind::Restore,
        None,
    )?;
    let operation_id = _operation.operation_id().to_string();
    let storage = create_storage(&config).await?;
    let manager = CloudSyncManager::new(storage, get_device_id());
    let plaintext_history_opt_in = allow_plaintext_history.unwrap_or(false);

    // [R4-antidegrade] 下载前先读取云端加密标记：标记存在的 root 只允许 DSBK
    // 密文进入还原链。读取失败（网络等）直接失败，不猜测标记状态；标记内容
    // 损坏时 `read_encryption_marker` 按存在处理（fail-closed）。
    let cloud_marker_present = manager.read_encryption_marker().await?.is_some();
    // [R6 双门] 本机「该云端目录曾经加密」记忆：marker 被攻击者删除时仍拒明文
    // （与明文上传侧 ensure_plaintext_upload_allowed 的第二道防线对称）。
    let locally_remembered_encrypted = manager.encrypted_root_remembered_locally();

    emit_sync_progress(
        &app_handle,
        CloudSyncProgressEvent {
            operation_id: operation_id.clone(),
            operation: "download",
            stage: "transferring",
            stage_label: "正在下载备份...",
            bytes_done: 0,
            bytes_total: 0,
            percent: 0.0,
        },
    );

    let handle = app_handle.clone();
    let progress_operation_id = operation_id.clone();
    let progress_cb: traits::DownloadProgressCallback = Box::new(move |done, total| {
        let pct = if total > 0 {
            (done as f32 / total as f32 * 95.0).min(95.0)
        } else {
            0.0
        };
        emit_sync_progress(
            &handle,
            CloudSyncProgressEvent {
                operation_id: progress_operation_id.clone(),
                operation: "download",
                stage: "transferring",
                stage_label: "正在下载备份...",
                bytes_done: done,
                bytes_total: total,
                percent: pct,
            },
        );
    });

    let result = manager
        .download_with_progress(
            version_id.as_deref(),
            std::path::Path::new(&local_dir),
            Some(progress_cb),
        )
        .await?;

    // 如果文件被加密（DSBK 魔数）则解密；未加密且云端无加密标记（且本机无
    // 「曾加密」记忆）则原样保留（预 E2EE 明文备份）。云端有加密标记（或
    // marker 已缺失但本机记忆命中）而对象非 DSBK 时按降级攻击拒收——除非
    // 本次调用带显式 opt-in，见 ensure_download_not_degraded。
    // 支持"用户上传时加密，下载设备未配置密码"的场景：返回明确错误
    let downloaded_path = std::path::Path::new(&result.local_path);
    let head = {
        use std::io::Read;
        let mut buf = [0u8; 4];
        let mut file = std::fs::File::open(downloaded_path).map_err(|error| {
            AppError::file_system(format!(
                "打开已下载备份进行格式识别失败 {:?}: {}",
                downloaded_path, error
            ))
        })?;
        file.read_exact(&mut buf).map_err(|error| {
            AppError::validation(format!(
                "已下载备份过短或无法读取 {:?}: {}",
                downloaded_path, error
            ))
        })?;
        buf
    };
    let is_encrypted = crate::crypto::backup_crypto::is_encrypted_backup(&head);
    if let Err(error) = ensure_download_not_degraded(
        cloud_marker_present,
        locally_remembered_encrypted,
        is_encrypted,
        plaintext_history_opt_in,
    ) {
        // 疑似被替换的明文对象不留在本地磁盘，避免用户绕过错误误用其内容；
        // 清理失败只记日志，防降级错误本身仍然返回。
        if let Err(remove_error) = std::fs::remove_file(downloaded_path) {
            tracing::warn!(
                "[CloudSync] 防降级拒收后清理已下载对象失败 {:?}: {}",
                downloaded_path,
                remove_error
            );
        }
        return Err(error);
    }
    if is_encrypted {
        let pwd = config
            .encryption_password
            .as_deref()
            .filter(|s| !s.is_empty());
        let pwd = pwd.ok_or_else(|| {
            AppError::configuration(sync_e2ee_error(
                SYNC_E2EE_PASSWORD_REQUIRED_CODE,
                "云端备份已加密，但未提供解密密码。请在云存储配置里填写相同的加密密码后重试。",
            ))
        })?;
        tracing::info!("[CloudSync] 检测到加密备份，开始流式解密...");
        // [F14] 流式分块解密到同目录临时文件再原子改名，内存占用恒定，避免多 GB
        // 备份一次性入内存；同时兼容旧的 DSBK v1（整文件）格式。
        let parent = downloaded_path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."));
        let temp_path = tempfile::Builder::new()
            .prefix(".cloud-decrypt-")
            .suffix(".tmp")
            .tempfile_in(parent)
            .map_err(|e| AppError::file_system(format!("创建解密临时文件失败: {}", e)))?
            .into_temp_path();
        crate::crypto::backup_crypto::decrypt_backup_file(downloaded_path, &temp_path, pwd)
            .map_err(|e| {
                AppError::validation(sync_e2ee_error(
                    SYNC_E2EE_WRONG_PASSWORD_CODE,
                    format!("解密备份失败（密码错或数据损坏）: {}", e),
                ))
            })?;
        temp_path
            .persist(downloaded_path)
            .map_err(|e| AppError::file_system(format!("保存解密后 ZIP 失败: {}", e.error)))?;
    }

    emit_sync_progress(
        &app_handle,
        CloudSyncProgressEvent {
            operation_id,
            operation: "download",
            stage: "done",
            stage_label: "下载完成",
            bytes_done: result.version.size,
            bytes_total: result.version.size,
            percent: 100.0,
        },
    );

    Ok(result)
}

/// 删除云端备份版本
#[tauri::command]
pub async fn cloud_sync_delete_version(
    app: AppHandle,
    mut config: CloudStorageConfig,
    version_id: String,
) -> Result<()> {
    crate::secure_store::hydrate_cloud_config(&app, &mut config);
    let _operation = crate::backup_common::DataGovernanceOperationGuard::try_acquire(
        crate::backup_common::DataGovernanceOperationKind::Prune,
        None,
    )?;
    let storage = create_storage(&config).await?;
    let manager = CloudSyncManager::new(storage, get_device_id());
    manager.delete_version(&version_id).await
}

/// 获取设备 ID
#[tauri::command]
pub fn cloud_sync_get_device_id() -> String {
    get_device_id()
}

/// 检查 S3 feature 是否启用
#[tauri::command]
pub fn cloud_storage_is_s3_enabled() -> bool {
    cfg!(feature = "cloud_storage_s3")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_validation() {
        let config = CloudStorageConfig {
            provider: StorageProvider::WebDav,
            webdav: Some(WebDavConfig {
                endpoint: "https://dav.example.com".into(),
                username: "user".into(),
                password: "pass".into(),
            }),
            ..Default::default()
        };
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_provider_display() {
        assert_eq!(format!("{}", StorageProvider::WebDav), "WebDAV");
        assert_eq!(format!("{}", StorageProvider::S3), "S3");
    }

    #[test]
    fn sync_e2ee_error_prefixes_stable_codes() {
        assert_eq!(
            sync_e2ee_error(SYNC_E2EE_WRONG_PASSWORD_CODE, "密码不一致"),
            format!("[{SYNC_E2EE_WRONG_PASSWORD_CODE}] 密码不一致")
        );
        assert!(
            sync_e2ee_error(SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE, "已拒绝未加密上传")
                .starts_with(&format!("[{SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE}]"))
        );
        assert!(
            sync_e2ee_error(SYNC_E2EE_MARKER_CORRUPTED_CODE, "缺少密码校验子")
                .contains(SYNC_E2EE_MARKER_CORRUPTED_CODE)
        );
    }

    /// [R4-antidegrade] 云端有加密标记 + 下载对象非 DSBK：必须返回稳定防降级
    /// 错误码，而不是把明文对象「原样保留」当成功。
    #[test]
    fn download_rejected_when_marker_present_but_object_not_dsbk() {
        let error = ensure_download_not_degraded(true, false, false, false)
            .expect_err("标记存在而对象非 DSBK 时必须拒收");
        assert!(matches!(error.error_type, AppErrorType::Validation));
        assert!(
            error.message.contains(SYNC_E2EE_DOWNGRADE_REJECTED_CODE),
            "防降级错误必须携带稳定码 {SYNC_E2EE_DOWNGRADE_REJECTED_CODE}，实际: {}",
            error.message
        );
        assert!(
            error
                .message
                .starts_with(&format!("[{SYNC_E2EE_DOWNGRADE_REJECTED_CODE}]")),
            "稳定码应以 [code] 前缀出现，便于前端/日志匹配"
        );
    }

    /// [R4-antidegrade] 标记存在 + DSBK 密文：放行，仍走现有解密路径。
    #[test]
    fn download_allowed_when_marker_present_and_object_is_dsbk() {
        ensure_download_not_degraded(true, false, true, false)
            .expect("标记存在且对象为 DSBK 应放行解密");
    }

    /// [R4-antidegrade] 标记不存在 + 无本机记忆 + 非 DSBK：预 E2EE 明文备份，
    /// 保持现行为。
    #[test]
    fn download_allowed_for_legacy_plaintext_without_marker() {
        ensure_download_not_degraded(false, false, false, false)
            .expect("无标记且无本机记忆的明文备份应保持现行为放行");
    }

    /// [R4-antidegrade] 标记不存在 + DSBK：旧版加密未写标记，放行走解密路径。
    #[test]
    fn download_allowed_for_dsbk_without_marker() {
        ensure_download_not_degraded(false, false, true, false)
            .expect("无标记的 DSBK 对象应放行解密");
    }

    /// [R6 双门] 标记被删但本机「曾加密」记忆命中 + 非 DSBK：同码拒绝，
    /// 删 marker 不得把明文对象送回「合法明文」象限。
    #[test]
    fn download_rejected_when_marker_deleted_but_locally_remembered() {
        let error = ensure_download_not_degraded(false, true, false, false)
            .expect_err("marker 缺失但本机记忆命中时必须拒收明文对象");
        assert!(matches!(error.error_type, AppErrorType::Validation));
        assert!(
            error
                .message
                .starts_with(&format!("[{SYNC_E2EE_DOWNGRADE_REJECTED_CODE}]")),
            "双门拒绝必须复用稳定码 {SYNC_E2EE_DOWNGRADE_REJECTED_CODE}，实际: {}",
            error.message
        );
    }

    /// [R6 双门] 本机记忆命中但对象是 DSBK 密文：放行走解密链，记忆门只拦明文。
    #[test]
    fn download_allowed_for_dsbk_when_locally_remembered() {
        ensure_download_not_degraded(false, true, true, false)
            .expect("本机记忆命中的 DSBK 对象应放行解密");
    }

    /// [R6-downgrade-optin] 显式 opt-in（一次一确认）放行明文历史版本：
    /// 标记存在与「标记被删 + 本机记忆」两种拒绝态都可被本次确认覆盖。
    #[test]
    fn download_opt_in_allows_plaintext_history_once() {
        ensure_download_not_degraded(true, false, false, true)
            .expect("标记存在 + 显式 opt-in 应放行明文历史版本");
        ensure_download_not_degraded(false, true, false, true)
            .expect("本机记忆命中 + 显式 opt-in 应放行明文历史版本");
        ensure_download_not_degraded(true, true, false, true)
            .expect("双门同时命中 + 显式 opt-in 应放行明文历史版本");
    }

    /// [R6-downgrade-optin] opt-in 对 DSBK 密文对象无任何影响（不产生其他松动），
    /// 且缺省（false）时明文历史仍默认拒绝。
    #[test]
    fn download_opt_in_has_no_effect_on_ciphertext_and_default_still_rejects() {
        ensure_download_not_degraded(true, true, true, true)
            .expect("DSBK 对象与 opt-in 无关，放行");
        ensure_download_not_degraded(true, false, false, false)
            .expect_err("未 opt-in 时明文历史不得默认成功");
    }

    /// [R4-antidegrade] 头 4 字节判定与 backup_crypto 的 DSBK 魔数保持一致：
    /// ZIP 头（PK\x03\x04）与随机字节都不是密文；DSBK 头是密文。
    #[test]
    fn download_head_classification_matches_backup_crypto_magic() {
        assert!(!crate::crypto::backup_crypto::is_encrypted_backup(
            b"PK\x03\x04"
        ));
        assert!(!crate::crypto::backup_crypto::is_encrypted_backup(&[
            0x00, 0x11, 0x22, 0x33
        ]));
        assert!(crate::crypto::backup_crypto::is_encrypted_backup(b"DSBK"));
    }
}
