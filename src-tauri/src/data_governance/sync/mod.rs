//! # Sync 模块
//!
//! 云同步管理系统。
//!
//! ## 设计原则
//!
//! 1. **版本戳机制**：每条记录有 `local_version` 和 `updated_at`
//! 2. **记录级冲突检测**：不是全库覆盖，而是按记录检测冲突
//! 3. **Tombstone 删除**：删除用 `deleted_at` 标记，而非直接删除
//! 4. **用户选择**：冲突时由用户选择合并策略
//!
//! ## 同步字段
//!
//! 所有需要同步的表应添加以下字段：
//!
//! ```sql
//! ALTER TABLE xxx ADD COLUMN device_id TEXT;
//! ALTER TABLE xxx ADD COLUMN local_version INTEGER DEFAULT 0;
//! ALTER TABLE xxx ADD COLUMN updated_at TEXT;
//! ALTER TABLE xxx ADD COLUMN deleted_at TEXT;  -- tombstone
//! ```
//!
//! ## 组件
//!
//! - `manager`: 同步管理器
//! - `conflict`: 记录级冲突检测
//! - `merge`: 合并策略
//! - `progress`: 同步进度管理
//! - `emitter`: 进度事件发射器
//!
//! ## 云存储集成
//!
//! 支持与云存储模块对接，提供以下功能：
//! - 上传/下载同步清单
//! - 上传/下载变更数据
//! - 支持增量同步
//! - 进度回调和实时状态更新

// 子模块声明
pub mod classification;
pub mod conflict_resolver;
pub mod emitter;
pub mod field_merge;
pub mod hlc;
pub mod progress;
pub mod state;
pub mod tombstone;

// 重新导出常用类型
pub use conflict_resolver::{
    ConflictAwareApplyResult, ConflictOutcome, ConflictPolicy, ConflictRecordToSave,
    ConflictResolver, ConflictSide,
};
pub use emitter::{OptionalEmitter, SyncProgressCallback, SyncProgressEmitter, EVENT_NAME};
pub use hlc::{Hlc, MAX_DRIFT_MS};
pub use progress::{ProgressTracker, SpeedCalculator, SyncPhase, SyncProgress};
use state::SyncStateStore;
pub use tombstone::{
    apply_blob_tombstones, AssetTombstoneEntry, AssetTombstones, BlobTombstoneEntry, BlobTombstones,
};

/// 公开的时间戳解析函数（供 conflict_resolver 等子模块复用）
pub fn parse_flexible_timestamp_public(s: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    use chrono::{DateTime, NaiveDateTime, Utc};
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    if let Ok(naive) = NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S") {
        return Some(naive.and_utc());
    }
    if let Ok(naive) = NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S") {
        return Some(naive.and_utc());
    }
    // 纯数字串：尝试作为毫秒时间戳解析
    // （resources / chat_v2_todo_lists 等表用 INTEGER ms 存储 updated_at）
    if let Ok(ms) = s.parse::<i64>() {
        // 秒级 (1e9 ~ 1e10) vs 毫秒级 (1e12 ~ 1e13) 用阈值区分，避免
        // 2038 前后年份的数值被误当毫秒
        const MS_THRESHOLD: i64 = 100_000_000_000; // 1e11
        if ms >= MS_THRESHOLD {
            return DateTime::<Utc>::from_timestamp_millis(ms);
        } else if ms >= 1_000_000_000 {
            return DateTime::<Utc>::from_timestamp(ms, 0);
        }
    }
    None
}

use super::schema_registry::DatabaseId;
use classification::SyncCategory;
use rusqlite::{params, types::Type, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// 记录并跳过迭代中的错误，避免静默丢弃
fn log_and_skip_err<T, E: std::fmt::Display>(result: Result<T, E>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::warn!("[Sync] Row parse error (skipped): {}", e);
            None
        }
    }
}

type IdAliasMap = HashMap<(String, String), String>;
type ForeignKeyViolationSet = HashSet<String>;

#[derive(Debug, Clone)]
struct ForeignKeyColumn {
    child_column: String,
    parent_table: String,
    parent_column: String,
}

/// 带指数退避的异步重试工具
///
/// 对可重试的网络操作（如上传/下载清单和变更）进行最多 `max_retries` 次尝试，
/// 每次失败后以指数退避等待（500ms, 1s, 2s, ...）。
///
/// [P3 Fix] 注意：底层传输层（WebDAV/S3）可能有自己的重试机制（通常 3 次）。
/// 调用方应使用较低的 max_retries（建议 2）以避免叠加过多重试。
#[cfg(feature = "data_governance")]
async fn retry_async<F, Fut, T>(op_name: &str, max_retries: u32, f: F) -> Result<T, SyncError>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T, SyncError>>,
{
    let base_ms: u64 = 500;
    let mut last_err = SyncError::Network(format!("{}: 未知错误", op_name));
    for attempt in 0..max_retries {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last_err = e;
                if attempt + 1 < max_retries {
                    let delay = base_ms * (1u64 << attempt);
                    tracing::warn!(
                        "[Sync] {} 重试 {}/{}: {}（等待 {}ms）",
                        op_name,
                        attempt + 1,
                        max_retries,
                        last_err,
                        delay
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                }
            }
        }
    }
    Err(last_err)
}

#[cfg(feature = "data_governance")]
// 云存储集成
use crate::cloud_storage::CloudStorage;

/// 同步清单
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncManifest {
    /// 同步事务 ID
    pub sync_transaction_id: String,
    /// 各数据库状态
    pub databases: HashMap<String, DatabaseSyncState>,
    /// 状态
    pub status: SyncTransactionStatus,
    /// 创建时间
    pub created_at: String,
    /// 设备 ID
    pub device_id: String,
    /// 云同步协议格式版本（3 = per-device seq/cursor）
    #[serde(default = "default_manifest_format_version")]
    pub format_version: u32,
    /// 本设备已经成功发布到云端的最大序号
    #[serde(default)]
    pub published_max_seq: u64,
    /// 本设备已经安全消费到的其他设备序号
    #[serde(default)]
    pub cursors: HashMap<String, u64>,
    /// restore 后旧设备清单可指向新设备 ID
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    /// 本设备最近见过的快照（Phase 2 快照引导占位）
    #[serde(default)]
    pub snapshot_seen: HashMap<String, String>,
}

fn default_manifest_format_version() -> u32 {
    2
}

/// 数据库同步状态
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseSyncState {
    /// Schema 版本
    pub schema_version: u32,
    /// 数据版本（最大 local_version）
    pub data_version: u64,
    /// Checksum
    pub checksum: String,
    /// 最后更新时间
    #[serde(default)]
    pub last_updated_at: Option<String>,
}

/// 同步事务状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SyncTransactionStatus {
    /// 完成
    Complete,
    /// 部分完成（需要修复）
    Partial,
    /// 失败
    Failed,
}

/// 数据库级冲突
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseConflict {
    /// 数据库名称
    pub database_name: String,
    /// 冲突类型
    pub conflict_type: DatabaseConflictType,
    /// 本地状态
    pub local_state: Option<DatabaseSyncState>,
    /// 云端状态
    pub cloud_state: Option<DatabaseSyncState>,
}

/// 数据库冲突类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum DatabaseConflictType {
    /// Schema 版本不匹配（需要迁移）
    SchemaMismatch,
    /// 数据版本冲突（双方都有修改）
    DataConflict,
    /// Checksum 不匹配（数据内容不同）
    ChecksumMismatch,
    /// 本地有，云端没有
    LocalOnly,
    /// 云端有，本地没有
    CloudOnly,
}

/// 冲突记录（记录级别）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictRecord {
    /// 数据库名称
    pub database_name: String,
    /// 表名
    pub table_name: String,
    /// 记录 ID
    pub record_id: String,
    /// 本地版本
    pub local_version: u64,
    /// 云端版本
    pub cloud_version: u64,
    /// 本地更新时间
    pub local_updated_at: String,
    /// 云端更新时间
    pub cloud_updated_at: String,
    /// 本地数据（JSON）
    pub local_data: serde_json::Value,
    /// 云端数据（JSON）
    pub cloud_data: serde_json::Value,
}

/// 冲突检测结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictDetectionResult {
    /// 数据库级冲突
    pub database_conflicts: Vec<DatabaseConflict>,
    /// 记录级冲突（需要进一步查询数据库）
    pub record_conflicts: Vec<ConflictRecord>,
    /// 是否有冲突
    pub has_conflicts: bool,
    /// 是否需要迁移
    pub needs_migration: bool,
}

impl ConflictDetectionResult {
    /// 创建空的检测结果（无冲突）
    pub fn empty() -> Self {
        Self {
            database_conflicts: Vec::new(),
            record_conflicts: Vec::new(),
            has_conflicts: false,
            needs_migration: false,
        }
    }

    /// 冲突总数
    pub fn total_conflicts(&self) -> usize {
        self.database_conflicts.len() + self.record_conflicts.len()
    }
}

/// 合并策略
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum MergeStrategy {
    /// 保留本地
    KeepLocal,
    /// 使用云端
    UseCloud,
    /// 保留最新（按 updated_at）
    KeepLatest,
    /// 手动合并（用户选择）
    Manual,
}

/// 同步结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    /// 是否成功
    pub success: bool,
    /// 同步的数据库数量
    pub synced_databases: usize,
    /// 解决的冲突数量
    pub resolved_conflicts: usize,
    /// 需要手动处理的冲突
    pub pending_manual_conflicts: Vec<ConflictRecord>,
    /// 错误信息（如果有）
    pub errors: Vec<String>,
}

impl SyncResult {
    /// 创建成功结果
    pub fn success(synced_databases: usize, resolved_conflicts: usize) -> Self {
        Self {
            success: true,
            synced_databases,
            resolved_conflicts,
            pending_manual_conflicts: Vec::new(),
            errors: Vec::new(),
        }
    }

    /// 创建需要手动处理的结果
    pub fn needs_manual(conflicts: Vec<ConflictRecord>) -> Self {
        Self {
            success: false,
            synced_databases: 0,
            resolved_conflicts: 0,
            pending_manual_conflicts: conflicts,
            errors: Vec::new(),
        }
    }

    /// 创建失败结果
    pub fn failure(errors: Vec<String>) -> Self {
        Self {
            success: false,
            synced_databases: 0,
            resolved_conflicts: 0,
            pending_manual_conflicts: Vec::new(),
            errors,
        }
    }
}

/// 同步错误
#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Database error: {0}")]
    Database(String),

    #[error("Network error: {0}")]
    Network(String),

    #[error("Conflict detected: {count} records")]
    Conflict { count: usize },

    #[error("Schema mismatch: local={local}, cloud={cloud}")]
    SchemaMismatch { local: u32, cloud: u32 },

    #[error("Partial sync: {completed}/{total} databases")]
    PartialSync { completed: usize, total: usize },

    #[error("Manual resolution required: {count} conflicts")]
    ManualResolutionRequired { count: usize },

    #[error("Not implemented: {0}")]
    NotImplemented(String),

    /// 云端变更时间戳超出本地 wall clock 未来容忍窗口（疑似时钟漂移/篡改）。
    /// 此类变更必须进入隔离区（可见、可重放），绝不允许静默丢弃——
    /// 否则一台时钟超前的设备的全部写入会被其他设备永久忽略（违反 INV-1）。
    #[error("Clock drift suspected: {table}.{record_id} timestamp is {drift_ms}ms in the future")]
    ClockDriftSuspected {
        table: String,
        record_id: String,
        drift_ms: i64,
    },
}

/// 云端 UPSERT 新鲜度评估结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpsertFreshness {
    /// 正常应用
    Proceed,
    /// 本地严格更新（LWW），跳过这条云端变更
    SkipStale,
    /// 云端时间戳超前本地 wall clock 过多，疑似漂移 → 调用方必须隔离而非丢弃
    SuspectDrift { drift_ms: i64 },
}

#[derive(Debug, Clone)]
struct DeleteVersion {
    changed_at: String,
    source_device_id: String,
    source_seq: u64,
}

/// 同步字段 SQL（用于需要同步的表）
pub const SYNC_FIELDS_SQL: &str = r#"
    -- 添加同步字段
    ALTER TABLE {table} ADD COLUMN device_id TEXT;
    ALTER TABLE {table} ADD COLUMN local_version INTEGER DEFAULT 0;
    ALTER TABLE {table} ADD COLUMN sync_version INTEGER DEFAULT 0;
    ALTER TABLE {table} ADD COLUMN updated_at TEXT DEFAULT (datetime('now'));
    ALTER TABLE {table} ADD COLUMN deleted_at TEXT;  -- tombstone，非 NULL 表示已删除

    -- 创建索引
    CREATE INDEX IF NOT EXISTS idx_{table}_local_version ON {table}(local_version);
    CREATE INDEX IF NOT EXISTS idx_{table}_sync_version ON {table}(sync_version);
    CREATE INDEX IF NOT EXISTS idx_{table}_deleted_at ON {table}(deleted_at);
"#;

/// 工作区数据库云同步清单（ws_*.db 文件级同步）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WorkspacesManifest {
    /// ws_id → 条目
    pub entries: HashMap<String, WorkspaceEntry>,
    #[serde(default)]
    pub updated_at: String,
}

/// 单个工作区数据库的同步条目
///
/// [P1 churn 修复] 两个哈希字段承担不同职责，不可混用：
/// - `sha256`：**传输对象**（VACUUM INTO 快照）的哈希，用于下载完整性校验；
/// - `source_sha256`：上传时**本地源文件**的哈希，用于变更检测。
///   VACUUM 会重写页布局，快照哈希与活动文件哈希几乎永不相等——
///   旧实现拿 `sha256` 与本地活动文件哈希比较，导致每次同步都误判
///   "已变更" 而把所有工作区 DB 原样重传。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkspaceEntry {
    pub sha256: String,
    pub size: u64,
    pub updated_at: String,
    /// 上传时本地源文件（活动 .db）的哈希；旧清单无此字段（None 时退化为旧行为）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_sha256: Option<String>,
    /// 上传者设备 ID（审计/调试）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    /// Immutable content object. Legacy manifests fall back to `<ws_id>.db`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_key: Option<String>,
}

/// VFS blob 云同步清单（内容寻址）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BlobsManifest {
    /// content_hash → 条目
    pub entries: HashMap<String, BlobEntry>,
    #[serde(default)]
    pub updated_at: String,
}

/// 单个 blob 的同步条目
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlobEntry {
    /// 相对路径（相对于 vfs_blobs/），如 "ab/abc123....pdf"
    pub relative_path: String,
    pub size: u64,
    #[serde(default)]
    pub updated_at: String,
}

/// VFS Blob 同步结果，区分完全成功与部分失败
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BlobSyncOutcome {
    pub uploaded: usize,
    pub downloaded: usize,
    pub upload_failures: Vec<String>,
    pub download_failures: Vec<String>,
}

impl BlobSyncOutcome {
    pub fn has_failures(&self) -> bool {
        !self.upload_failures.is_empty() || !self.download_failures.is_empty()
    }

    pub fn failure_summary(&self) -> Option<String> {
        if !self.has_failures() {
            return None;
        }
        Some(format!(
            "附件同步部分失败：{} 个上传失败，{} 个下载失败",
            self.upload_failures.len(),
            self.download_failures.len()
        ))
    }
}

/// 通用资产目录云同步清单（images/documents/...）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AssetDirsManifest {
    /// key -> 条目，key 形如 "active/images/a.png" 或 "app_data/pdf_ocr_sessions/x.json"
    pub entries: HashMap<String, AssetFileEntry>,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AssetFileEntry {
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub updated_at: String,
    /// Immutable content-addressed object key. Absent on legacy manifests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_key: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AssetSyncOutcome {
    pub uploaded: usize,
    pub downloaded: usize,
    pub upload_failures: Vec<String>,
    pub download_failures: Vec<String>,
}

pub(crate) type FileTransferProgressCallback =
    std::sync::Arc<dyn Fn(String, u64, u64) + Send + Sync>;

impl AssetSyncOutcome {
    pub fn has_failures(&self) -> bool {
        !self.upload_failures.is_empty() || !self.download_failures.is_empty()
    }

    pub fn failure_summary(&self) -> Option<String> {
        if !self.has_failures() {
            return None;
        }
        Some(format!(
            "资产目录同步部分失败：{} 个上传失败，{} 个下载失败",
            self.upload_failures.len(),
            self.download_failures.len()
        ))
    }
}

/// 下载变更结果（包含非致命解析告警）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DownloadChangesResult {
    pub changes: Vec<SyncChangeWithData>,
    pub decode_failures: Vec<String>,
    pub cursor_advancements: HashMap<String, u64>,
    pub legacy_processed_keys: Vec<String>,
}

impl DownloadChangesResult {
    pub fn len(&self) -> usize {
        self.changes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }

    pub fn iter(&self) -> std::slice::Iter<'_, SyncChangeWithData> {
        self.changes.iter()
    }
}

impl AsRef<[SyncChangeWithData]> for DownloadChangesResult {
    fn as_ref(&self) -> &[SyncChangeWithData] {
        &self.changes
    }
}

impl IntoIterator for DownloadChangesResult {
    type Item = SyncChangeWithData;
    type IntoIter = std::vec::IntoIter<SyncChangeWithData>;

    fn into_iter(self) -> Self::IntoIter {
        self.changes.into_iter()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ParsedChangeKey {
    V3 {
        device_id: String,
        seq: u64,
        version: u64,
    },
    Legacy {
        device_id: String,
        version: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SyncDatabaseSnapshot {
    format_version: u32,
    database_name: String,
    device_id: String,
    created_at: String,
    schema_version: u32,
    data_version: u64,
    checksum: String,
    /// Per uploader seq covered by this full database snapshot.
    covered_cursors: HashMap<String, u64>,
    /// table_name -> complete RowSync rows for this database.
    rows: HashMap<String, Vec<serde_json::Value>>,
}

#[derive(Debug, Clone)]
struct SnapshotCoverage {
    covered_cursors: HashMap<String, u64>,
}

/// 同步管理器
pub struct SyncManager {
    /// 本地设备 ID
    device_id: String,
    /// 可选的端到端加密密码（对文本 payload 生效，批判报告 P0-2 修复）
    ///
    /// 覆盖范围：
    /// - ✅ 加密：`SyncManifest`、`SyncChangesPayload`、`*Tombstones`、
    ///   各种 metadata manifest（workspaces/blobs/assets）
    /// - ❌ **不**加密：VFS blob 的 raw bytes、workspace `.db` 文件。
    ///   原因：blob 走内容寻址（sha256 作 key），加密会破坏去重语义；
    ///   workspace DB 的完整性校验依赖明文 sha256。这两类的加密需要
    ///   额外的密文-明文 hash 双校验，作为后续 P1 任务单独处理。
    ///
    /// 语义：
    /// - `None` 或空字符串：所有 payload 明文上传（向后兼容旧数据）
    /// - `Some(pw)` 非空：文本 payload 使用 `DSBK` 容器加密（AES-256-GCM + Argon2id）
    ///
    /// 解密端自动探测：遇到 `DSBK` 魔数走解密，否则当明文处理。这让加密可以
    /// 平滑启用，不破坏已存在的明文云端数据。
    #[cfg(feature = "data_governance")]
    encryption_password: Option<String>,
}

impl SyncManager {
    /// 创建新的同步管理器（不启用 payload 加密）
    pub fn new(device_id: String) -> Self {
        Self {
            device_id,
            #[cfg(feature = "data_governance")]
            encryption_password: None,
        }
    }

    /// 创建带可选加密密码的同步管理器
    ///
    /// 空字符串 / `None` 等价于 `new()`（明文模式）。
    #[cfg(feature = "data_governance")]
    pub fn with_encryption(device_id: String, password: Option<String>) -> Self {
        let password = password.filter(|s| !s.is_empty());
        Self {
            device_id,
            encryption_password: password,
        }
    }

    /// 是否启用了 payload 加密
    #[cfg(feature = "data_governance")]
    pub fn encryption_enabled(&self) -> bool {
        self.encryption_password
            .as_deref()
            .map(|s| !s.is_empty())
            .unwrap_or(false)
    }

    /// 加密文本 payload 为上传格式（若未启用则原样返回）
    ///
    /// 输出：`DSBK` 容器（参见 `crypto::backup_crypto::encrypt_backup`）
    #[cfg(feature = "data_governance")]
    fn encode_payload(&self, plaintext: &[u8]) -> Result<Vec<u8>, SyncError> {
        match self.encryption_password.as_deref() {
            Some(pw) if !pw.is_empty() => {
                crate::crypto::backup_crypto::encrypt_backup(plaintext, pw)
                    .map_err(|e| SyncError::Database(format!("加密 sync payload 失败: {}", e)))
            }
            _ => Ok(plaintext.to_vec()),
        }
    }

    /// 解密下载的 payload（若魔数匹配则解密；否则原样返回，向后兼容老明文数据）
    ///
    /// 失败模式：
    /// - 数据带 `DSBK` 头但本端未配密码 → 返回错误（提示用户设置密码）
    /// - 数据带 `DSBK` 头但密码错误 → 返回错误
    /// - 数据未加密（无 `DSBK` 头） → 原样返回（兼容）
    #[cfg(feature = "data_governance")]
    fn decode_payload(&self, data: &[u8]) -> Result<Vec<u8>, SyncError> {
        if crate::crypto::backup_crypto::is_encrypted_backup(data) {
            match self.encryption_password.as_deref() {
                Some(pw) if !pw.is_empty() => {
                    crate::crypto::backup_crypto::decrypt_backup(data, pw).map_err(|e| {
                        SyncError::Database(format!(
                            "解密 sync payload 失败（密码错误或数据损坏）: {}",
                            e
                        ))
                    })
                }
                _ => Err(SyncError::Database(
                    "检测到加密的 sync payload 但本端未配置加密密码。\
                     请在云同步设置里填入正确的密码后重试。"
                        .to_string(),
                )),
            }
        } else {
            Ok(data.to_vec())
        }
    }

    /// 获取设备 ID
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// 检测数据库级冲突
    ///
    /// 比较本地和云端的 SyncManifest，找出：
    /// 1. Schema 版本不匹配的数据库
    /// 2. 数据版本冲突（双方都有修改）
    /// 3. 仅存在于一方的数据库
    pub fn detect_conflicts(
        local_manifest: &SyncManifest,
        cloud_manifest: &SyncManifest,
    ) -> Result<ConflictDetectionResult, SyncError> {
        let mut result = ConflictDetectionResult::empty();

        // 收集所有数据库名称
        let mut all_databases: std::collections::HashSet<&String> =
            local_manifest.databases.keys().collect();
        all_databases.extend(cloud_manifest.databases.keys());

        for db_name in all_databases {
            let local_state = local_manifest.databases.get(db_name);
            let cloud_state = cloud_manifest.databases.get(db_name);

            match (local_state, cloud_state) {
                // 双方都有该数据库
                (Some(local), Some(cloud)) => {
                    // 检查 Schema 版本
                    if local.schema_version != cloud.schema_version {
                        result.database_conflicts.push(DatabaseConflict {
                            database_name: db_name.clone(),
                            conflict_type: DatabaseConflictType::SchemaMismatch,
                            local_state: Some(local.clone()),
                            cloud_state: Some(cloud.clone()),
                        });
                        result.needs_migration = true;
                    }
                    // Schema 版本相同，检查数据版本
                    else if local.data_version != cloud.data_version {
                        // 双方数据版本不同，可能存在冲突
                        if local.checksum != cloud.checksum {
                            result.database_conflicts.push(DatabaseConflict {
                                database_name: db_name.clone(),
                                conflict_type: DatabaseConflictType::DataConflict,
                                local_state: Some(local.clone()),
                                cloud_state: Some(cloud.clone()),
                            });
                        }
                    }
                    // 数据版本相同但 checksum 不同（异常情况）
                    else if local.checksum != cloud.checksum {
                        result.database_conflicts.push(DatabaseConflict {
                            database_name: db_name.clone(),
                            conflict_type: DatabaseConflictType::ChecksumMismatch,
                            local_state: Some(local.clone()),
                            cloud_state: Some(cloud.clone()),
                        });
                    }
                }
                // 仅本地有
                (Some(local), None) => {
                    result.database_conflicts.push(DatabaseConflict {
                        database_name: db_name.clone(),
                        conflict_type: DatabaseConflictType::LocalOnly,
                        local_state: Some(local.clone()),
                        cloud_state: None,
                    });
                }
                // 仅云端有
                (None, Some(cloud)) => {
                    result.database_conflicts.push(DatabaseConflict {
                        database_name: db_name.clone(),
                        conflict_type: DatabaseConflictType::CloudOnly,
                        local_state: None,
                        cloud_state: Some(cloud.clone()),
                    });
                }
                // 双方都没有（不应该发生）
                (None, None) => {}
            }
        }

        result.has_conflicts =
            !result.database_conflicts.is_empty() || !result.record_conflicts.is_empty();

        Ok(result)
    }

    /// 检测记录级冲突
    ///
    /// 对于给定的数据库，比较本地和云端的记录差异。
    /// 这个方法需要实际的记录数据，通常在数据库级冲突检测后调用。
    #[deprecated(
        note = "Use conflict_resolver/__sync_conflicts production paths; this helper is legacy/test-only."
    )]
    pub fn detect_record_conflicts(
        database_name: &str,
        local_records: &[RecordSnapshot],
        cloud_records: &[RecordSnapshot],
    ) -> Vec<ConflictRecord> {
        let mut conflicts = Vec::new();

        // 构建云端记录索引（按 record_id）
        let cloud_index: HashMap<&str, &RecordSnapshot> = cloud_records
            .iter()
            .map(|r| (r.record_id.as_str(), r))
            .collect();

        // 遍历本地记录，查找冲突
        for local_record in local_records {
            if let Some(cloud_record) = cloud_index.get(local_record.record_id.as_str()) {
                // 双方都有该记录，检查是否冲突
                #[allow(deprecated)]
                if Self::is_record_conflicting(local_record, cloud_record) {
                    conflicts.push(ConflictRecord {
                        database_name: database_name.to_string(),
                        table_name: local_record.table_name.clone(),
                        record_id: local_record.record_id.clone(),
                        local_version: local_record.local_version,
                        cloud_version: cloud_record.local_version,
                        local_updated_at: local_record.updated_at.clone(),
                        cloud_updated_at: cloud_record.updated_at.clone(),
                        local_data: local_record.data.clone(),
                        cloud_data: cloud_record.data.clone(),
                    });
                }
            }
        }

        conflicts
    }

    /// 判断两条记录是否冲突
    ///
    /// 冲突条件（LWW + 基线比对）：
    /// 1. 双方各自的 local_version > sync_version，表明都有未同步的修改
    /// 2. 数据内容不同
    ///
    /// 不再要求 sync_version 完全相等：当两台设备经过各自独立的同步周期后
    /// sync_version 自然会发散，原先的相等判断会导致静默数据覆盖。
    #[deprecated(
        note = "Use conflict_resolver::__sync_conflicts production paths; this helper is legacy/test-only."
    )]
    fn is_record_conflicting(local: &RecordSnapshot, cloud: &RecordSnapshot) -> bool {
        let local_modified = local.local_version > local.sync_version;
        let cloud_modified = cloud.local_version > cloud.sync_version;

        if local_modified && cloud_modified {
            return local.data != cloud.data;
        }
        false
    }

    /// 执行同步
    ///
    /// 根据合并策略处理冲突并返回同步结果。
    #[deprecated(
        note = "Use execute_download/execute_bidirectional and conflict_resolver paths; this API does not apply real database changes."
    )]
    pub fn sync(
        &self,
        strategy: MergeStrategy,
        detection_result: &ConflictDetectionResult,
    ) -> Result<SyncResult, SyncError> {
        // 如果需要迁移，先处理 Schema 不匹配
        if detection_result.needs_migration {
            return Err(SyncError::SchemaMismatch {
                local: 0, // 具体版本在实际使用时填充
                cloud: 0,
            });
        }

        // 如果是手动模式且有冲突，返回需要手动处理
        if strategy == MergeStrategy::Manual && detection_result.has_conflicts {
            return Err(SyncError::ManualResolutionRequired {
                count: detection_result.total_conflicts(),
            });
        }

        let mut resolved_count = 0;
        let mut pending_manual = Vec::new();

        // 处理记录级冲突
        for conflict in &detection_result.record_conflicts {
            match strategy {
                MergeStrategy::KeepLocal => {
                    // 保留本地，标记云端需要更新
                    resolved_count += 1;
                }
                MergeStrategy::UseCloud => {
                    // 使用云端，本地需要更新
                    resolved_count += 1;
                }
                MergeStrategy::KeepLatest => {
                    // 比较时间戳，保留最新的；平局由写入者 device_id / 内容 tiebreaker 决定。
                    let (local_dev, cloud_dev) = Self::lww_device_pair(
                        &conflict.local_data,
                        Some(&conflict.cloud_data),
                        None,
                    );
                    if Self::compare_lww_timestamps(
                        &conflict.local_updated_at,
                        local_dev,
                        &conflict.local_data.to_string(),
                        &conflict.cloud_updated_at,
                        cloud_dev,
                        &conflict.cloud_data.to_string(),
                    ) != std::cmp::Ordering::Less
                    {
                        // 本地更新，云端需要更新
                    } else {
                        // 云端更新，本地需要更新
                    }
                    resolved_count += 1;
                }
                MergeStrategy::Manual => {
                    // 需要用户手动处理
                    pending_manual.push(conflict.clone());
                }
            }
        }

        // 返回结果
        if pending_manual.is_empty() {
            Ok(SyncResult::success(
                detection_result.database_conflicts.len(),
                resolved_count,
            ))
        } else {
            Ok(SyncResult::needs_manual(pending_manual))
        }
    }

    /// 解决单个冲突
    ///
    /// 用户手动选择后调用此方法应用选择。
    pub fn resolve_conflict(
        &self,
        conflict: &ConflictRecord,
        resolution: ConflictResolution,
    ) -> Result<ResolvedRecord, SyncError> {
        let resolved_data = match resolution {
            ConflictResolution::KeepLocal => conflict.local_data.clone(),
            ConflictResolution::UseCloud => conflict.cloud_data.clone(),
            ConflictResolution::Merge(merged_data) => merged_data,
        };

        Ok(ResolvedRecord {
            database_name: conflict.database_name.clone(),
            table_name: conflict.table_name.clone(),
            record_id: conflict.record_id.clone(),
            resolved_data,
            new_version: conflict.local_version.max(conflict.cloud_version) + 1,
            resolved_at: chrono::Utc::now().to_rfc3339(),
            resolved_by: self.device_id.clone(),
        })
    }

    /// 创建同步清单
    pub fn create_manifest(&self, databases: HashMap<String, DatabaseSyncState>) -> SyncManifest {
        SyncManifest {
            sync_transaction_id: uuid::Uuid::new_v4().to_string(),
            databases,
            status: SyncTransactionStatus::Complete,
            created_at: chrono::Utc::now().to_rfc3339(),
            device_id: self.device_id.clone(),
            format_version: 3,
            published_max_seq: 0,
            cursors: HashMap::new(),
            superseded_by: None,
            snapshot_seen: HashMap::new(),
        }
    }

    // ========================================================================
    // 云存储集成方法
    // ========================================================================

    /// 旧版单清单路径（用于向后兼容迁移读取）
    const LEGACY_MANIFEST_KEY: &'static str = "data_governance/sync_manifest.json";
    /// 按设备隔离的清单目录前缀
    const MANIFESTS_PREFIX: &'static str = "data_governance/manifests";
    /// 变更数据的云端路径前缀
    const CHANGES_PREFIX: &'static str = "data_governance/changes";
    /// 全量快照路径前缀
    const SNAPSHOTS_PREFIX: &'static str = "data_governance/snapshots";
    /// 明文远端实例标识。用于把本地游标/上传序号与具体云端隔离。
    const INSTANCE_KEY: &'static str = "data_governance/instance.json";
    /// 明文格式协商文件。
    const FORMAT_KEY: &'static str = "data_governance/format.json";
    const SNAPSHOT_FORMAT_VERSION: u32 = 1;
    const SNAPSHOT_INTERVAL_DAYS: i64 = 7;
    const SNAPSHOT_RETAIN_PER_DB: usize = 2;
    /// Current v1 snapshots are UPSERT-only and cannot prove set equality.
    /// They must not advance cursors across a prune gap or authorize pruning.
    const AUTHORITATIVE_SNAPSHOT_REPLACE_ENABLED: bool = false;

    /// 构建按设备隔离的清单路径
    fn device_manifest_key(device_id: &str) -> String {
        format!("{}/{}.json", Self::MANIFESTS_PREFIX, device_id)
    }

    async fn ensure_remote_instance_id(
        &self,
        storage: &dyn CloudStorage,
    ) -> Result<String, SyncError> {
        let provider = storage.provider_name();
        let endpoint_hint = storage.instance_binding_hint();
        if let Some(bytes) = storage
            .get(Self::INSTANCE_KEY)
            .await
            .map_err(|e| SyncError::Network(format!("读取远端实例标识失败: {}", e)))?
        {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if let Some(id) = value.get("instance_id").and_then(|v| v.as_str()) {
                    if !id.trim().is_empty() {
                        let instance_id = id.trim().to_string();
                        let store = SyncStateStore::open_default()?;
                        store.bind_instance(&instance_id, provider, &endpoint_hint)?;
                        return Ok(instance_id);
                    }
                }
            }
        }

        let instance_id = uuid::Uuid::new_v4().to_string();
        let body = serde_json::json!({
            "instance_id": instance_id,
            "format_version": 3,
            "created_at": chrono::Utc::now().to_rfc3339(),
        });
        let bytes = serde_json::to_vec_pretty(&body)
            .map_err(|e| SyncError::Database(format!("序列化远端实例标识失败: {}", e)))?;
        storage
            .put(Self::INSTANCE_KEY, &bytes)
            .await
            .map_err(|e| SyncError::Network(format!("写入远端实例标识失败: {}", e)))?;
        let format = serde_json::json!({
            "format_version": 3,
            "min_client": "deep-student-cloud-sync-v3",
        });
        if let Ok(bytes) = serde_json::to_vec_pretty(&format) {
            let _ = storage.put(Self::FORMAT_KEY, &bytes).await;
        }
        let store = SyncStateStore::open_default()?;
        store.bind_instance(&instance_id, provider, &endpoint_hint)?;
        Ok(instance_id)
    }

    /// 上传本地清单到云端（按设备隔离，自带网络重试）
    pub async fn upload_manifest(
        &self,
        storage: &dyn CloudStorage,
        manifest: &SyncManifest,
    ) -> Result<(), SyncError> {
        let instance_id = self.ensure_remote_instance_id(storage).await?;
        let mut manifest = manifest.clone();
        manifest.format_version = 3;
        manifest.device_id = self.device_id.clone();
        if let Ok(store) = SyncStateStore::open_default() {
            if let Ok(rotations) = store.device_rotations_for_new(&self.device_id) {
                for (old_device_id, reason) in rotations {
                    if let Err(e) = self
                        .mark_device_manifest_superseded(storage, &old_device_id, &self.device_id)
                        .await
                    {
                        tracing::warn!(
                            "[sync] 写入旧设备 superseded_by 失败: old={}, new={}, reason={}, err={}",
                            old_device_id,
                            self.device_id,
                            reason,
                            e
                        );
                    }
                }
            }
            manifest.published_max_seq = store
                .published_max_seq(&instance_id, &self.device_id)
                .unwrap_or(0);
            manifest.cursors = store.cursors(&instance_id).unwrap_or_default();
        }

        let json = serde_json::to_vec_pretty(&manifest)
            .map_err(|e| SyncError::Database(format!("序列化清单失败: {}", e)))?;

        // [P0-2] 可选 payload 加密
        let payload = self.encode_payload(&json)?;

        let key = Self::device_manifest_key(&self.device_id);

        // [P3 Fix] 降低为 2 次，避免与传输层重试叠加
        retry_async("上传清单", 2, || {
            let payload = payload.clone();
            let key = key.clone();
            async move {
                storage
                    .put(&key, &payload)
                    .await
                    .map_err(|e| SyncError::Network(format!("上传清单失败: {}", e)))
            }
        })
        .await?;

        tracing::info!(
            "[sync] 清单已上传到云端: device={}, tx={}, databases={}, key={}, encrypted={}",
            manifest.device_id,
            manifest.sync_transaction_id,
            manifest.databases.len(),
            key,
            self.encryption_enabled()
        );

        Ok(())
    }

    async fn mark_device_manifest_superseded(
        &self,
        storage: &dyn CloudStorage,
        old_device_id: &str,
        new_device_id: &str,
    ) -> Result<(), SyncError> {
        if old_device_id.trim().is_empty() || old_device_id == new_device_id {
            return Ok(());
        }

        let key = Self::device_manifest_key(old_device_id);
        let mut manifest = match storage
            .get(&key)
            .await
            .map_err(|e| SyncError::Network(format!("读取旧设备清单失败: {}", e)))?
        {
            Some(bytes) => {
                let decoded = self.decode_payload(&bytes)?;
                serde_json::from_slice::<SyncManifest>(&decoded)
                    .map_err(|e| SyncError::Database(format!("解析旧设备清单失败: {}", e)))?
            }
            None => SyncManifest {
                sync_transaction_id: uuid::Uuid::new_v4().to_string(),
                databases: HashMap::new(),
                status: SyncTransactionStatus::Complete,
                created_at: chrono::Utc::now().to_rfc3339(),
                device_id: old_device_id.to_string(),
                format_version: 3,
                published_max_seq: 0,
                cursors: HashMap::new(),
                superseded_by: None,
                snapshot_seen: HashMap::new(),
            },
        };

        if manifest.superseded_by.as_deref() == Some(new_device_id) {
            return Ok(());
        }

        manifest.format_version = 3;
        manifest.device_id = old_device_id.to_string();
        manifest.superseded_by = Some(new_device_id.to_string());
        let json = serde_json::to_vec_pretty(&manifest)
            .map_err(|e| SyncError::Database(format!("序列化旧设备清单失败: {}", e)))?;
        let payload = self.encode_payload(&json)?;
        storage
            .put(&key, &payload)
            .await
            .map_err(|e| SyncError::Network(format!("上传旧设备 superseded_by 失败: {}", e)))?;
        Ok(())
    }

    /// 从云端下载清单（合并所有其他设备的清单）
    ///
    /// 策略：
    /// 1. 列出 `data_governance/manifests/` 下所有设备清单
    /// 2. 排除本设备，合并其他设备的数据库状态（取各库最高 data_version）
    /// 3. 向后兼容：若新目录为空，回退读取旧的单文件清单
    pub async fn download_manifest(
        &self,
        storage: &dyn CloudStorage,
    ) -> Result<SyncManifest, SyncError> {
        // 列出所有设备清单文件
        let list = storage
            .list_outcome(Self::MANIFESTS_PREFIX)
            .await
            .map_err(|e| SyncError::Network(format!("列出清单文件失败: {}", e)))?;
        if list.truncated {
            return Err(SyncError::Network(
                "云端清单列表被截断，已停止同步以避免漏读设备状态".to_string(),
            ));
        }
        let files = list.files;

        let mut merged_databases: HashMap<String, DatabaseSyncState> = HashMap::new();
        let mut any_found = false;
        let mut latest_created_at: Option<chrono::DateTime<chrono::Utc>> = None;
        let mut latest_created_at_raw = String::new();
        let mut merged_divergence: std::collections::HashSet<String> =
            std::collections::HashSet::new();

        for file in &files {
            let file_device_id = file
                .key
                .rsplit('/')
                .next()
                .and_then(|f| f.strip_suffix(".json"))
                .unwrap_or("");

            if file_device_id == self.device_id || file_device_id.is_empty() {
                continue;
            }

            let bytes = storage
                .get(&file.key)
                .await
                .map_err(|e| SyncError::Network(format!("下载设备清单失败 {}: {}", file.key, e)))?;
            if let Some(bytes) = bytes {
                // [P0-2] 透明解密：data_governance feature 下走 decode_payload；
                // 老明文数据 + 加密数据都由 decode_payload 自动识别 DSBK 魔数分流
                //
                // [P2 fail-close] 解密失败必须硬错误，与变更文件路径口径一致。
                // 此前静默 continue 会让密码配错的设备把云端视为近空实例：
                // data_version 比较、prune gap 判断、合并基线全部失真，并可能
                // 以错误密码开始推送。损坏 JSON（非加密问题）仍保留跳过。
                let decoded = self.decode_payload(&bytes).map_err(|e| {
                    SyncError::Database(format!(
                        "设备清单无法解密，已停止同步（请检查加密密码）: {} ({})",
                        file.key, e
                    ))
                })?;
                let manifest = match serde_json::from_slice::<SyncManifest>(&decoded) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!("[sync] 跳过损坏设备清单: key={}, error={}", file.key, e);
                        continue;
                    }
                };
                any_found = true;
                if let Some(dt) = Self::parse_flexible_timestamp(&manifest.created_at) {
                    if latest_created_at.map_or(true, |prev| dt > prev) {
                        latest_created_at = Some(dt);
                        latest_created_at_raw = manifest.created_at.clone();
                    }
                }
                // 合并：对每个数据库取最高 data_version 的状态
                for (db_name, state) in &manifest.databases {
                    let entry = merged_databases
                        .entry(db_name.clone())
                        .or_insert_with(|| state.clone());
                    if state.data_version > entry.data_version {
                        *entry = state.clone();
                    } else if state.data_version == entry.data_version
                        && !entry.checksum.is_empty()
                        && !state.checksum.is_empty()
                        && state.checksum != entry.checksum
                    {
                        merged_divergence.insert(db_name.clone());
                        entry.checksum = Self::DIVERGED_CHECKSUM_SENTINEL.to_string();
                    }
                }
                tracing::debug!(
                    "[sync] 合并设备清单: device={}, databases={}",
                    file_device_id,
                    manifest.databases.len()
                );
            }
        }

        if !merged_divergence.is_empty() {
            tracing::warn!(
                "[sync] 检测到同版本云端分叉数据库: {}",
                merged_divergence
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(",")
            );
        }

        // 向后兼容：如果没有新格式清单，回退到旧的单文件
        if !any_found {
            if let Some(bytes) = storage
                .get(Self::LEGACY_MANIFEST_KEY)
                .await
                .map_err(|e| SyncError::Network(format!("下载旧版清单失败: {}", e)))?
            {
                let decoded = self.decode_payload(&bytes)?;
                let manifest = serde_json::from_slice::<SyncManifest>(&decoded)
                    .map_err(|e| SyncError::Database(format!("解析旧版清单失败: {}", e)))?;
                // 旧清单来自另一设备（或自己），直接使用
                if manifest.device_id != self.device_id {
                    tracing::info!(
                        "[sync] 从旧版单清单迁移读取: device={}, databases={}",
                        manifest.device_id,
                        manifest.databases.len()
                    );
                    return Ok(manifest);
                }
            }
        }

        if !any_found && merged_databases.is_empty() {
            tracing::info!("[sync] 云端没有其他设备的同步清单");
            return Ok(SyncManifest {
                sync_transaction_id: String::new(),
                databases: HashMap::new(),
                status: SyncTransactionStatus::Complete,
                created_at: chrono::Utc::now().to_rfc3339(),
                device_id: String::new(),
                format_version: 3,
                published_max_seq: 0,
                cursors: HashMap::new(),
                superseded_by: None,
                snapshot_seen: HashMap::new(),
            });
        }

        tracing::info!(
            "[sync] 合并云端清单完成: other_devices={}, merged_databases={}",
            files.len().saturating_sub(1),
            merged_databases.len()
        );

        Ok(SyncManifest {
            sync_transaction_id: uuid::Uuid::new_v4().to_string(),
            databases: merged_databases,
            status: SyncTransactionStatus::Complete,
            created_at: if latest_created_at_raw.is_empty() {
                chrono::Utc::now().to_rfc3339()
            } else {
                latest_created_at_raw
            },
            device_id: "merged".to_string(),
            format_version: 3,
            published_max_seq: 0,
            cursors: HashMap::new(),
            superseded_by: None,
            snapshot_seen: HashMap::new(),
        })
    }

    async fn download_device_manifests(
        &self,
        storage: &dyn CloudStorage,
    ) -> Result<HashMap<String, SyncManifest>, SyncError> {
        let list = storage
            .list_outcome(Self::MANIFESTS_PREFIX)
            .await
            .map_err(|e| SyncError::Network(format!("列出清单文件失败: {}", e)))?;
        if list.truncated {
            return Err(SyncError::Network(
                "云端清单列表被截断，已停止同步以避免漏读设备状态".to_string(),
            ));
        }
        let mut manifests = HashMap::new();
        for file in list.files {
            let Some(device_id) = file
                .key
                .rsplit('/')
                .next()
                .and_then(|f| f.strip_suffix(".json"))
            else {
                continue;
            };
            let Some(bytes) = storage
                .get(&file.key)
                .await
                .map_err(|e| SyncError::Network(format!("下载设备清单失败 {}: {}", file.key, e)))?
            else {
                continue;
            };
            // [P2 fail-close] 解密失败必须硬错误：此函数支撑 prune 安全边界
            // （活跃消费者游标下界）与 published_max_seq 判定。静默跳过会把
            // 密码不符的设备从安全计算中剔除，可能误删其尚未消费的变更文件。
            let decoded = self.decode_payload(&bytes).map_err(|e| {
                SyncError::Database(format!(
                    "设备清单无法解密，已停止同步（请检查加密密码）: {} ({})",
                    file.key, e
                ))
            })?;
            match serde_json::from_slice::<SyncManifest>(&decoded) {
                Ok(manifest) => {
                    manifests.insert(device_id.to_string(), manifest);
                }
                Err(e) => {
                    tracing::warn!("[sync] 跳过损坏设备清单: key={}, error={}", file.key, e);
                }
            }
        }
        Ok(manifests)
    }

    /// 上传变更数据（v1 旧格式：仅 ChangeLogEntry 元数据，不含行数据）
    ///
    /// **已废弃**：新代码应使用 `upload_enriched_changes`，它携带完整记录数据。
    /// 此方法仅保留用于极端回退场景。
    ///
    /// # 参数
    /// * `storage` - 云存储实例
    /// * `changes` - 待上传的变更数据
    ///
    /// # 返回
    /// * `Ok(())` - 上传成功
    /// * `Err(SyncError)` - 上传失败
    pub async fn upload_changes(
        &self,
        storage: &dyn CloudStorage,
        changes: &PendingChanges,
    ) -> Result<(), SyncError> {
        if !changes.has_changes() {
            tracing::debug!("[sync] 没有变更需要上传");
            return Ok(());
        }

        // 生成变更数据文件的键（版本使用秒级时间戳，与 legacy 文件同一版本空间）
        // 秒级冲突由 build_change_key 的 UUID nonce 防护
        let version = chrono::Utc::now().timestamp() as u64;
        let key = self.build_change_key(version);

        let json = serde_json::to_vec_pretty(changes)
            .map_err(|e| SyncError::Database(format!("序列化变更数据失败: {}", e)))?;

        // [P0-2] 保持与新链路一致的加密行为
        let payload = self.encode_payload(&json)?;

        storage
            .put(&key, &payload)
            .await
            .map_err(|e| SyncError::Network(format!("上传变更数据失败: {}", e)))?;

        tracing::info!(
            "[sync] 变更数据已上传(legacy): device={}, count={}, key={}, encrypted={}",
            self.device_id,
            changes.total_count,
            key,
            self.encryption_enabled()
        );

        Ok(())
    }

    /// 上传带完整数据的变更（新链路）
    ///
    /// 将带完整记录数据的 `SyncChangeWithData` 序列化并上传到云端。
    /// 这确保下载端可以直接回放变更，无需再查询源数据库。
    ///
    /// # 参数
    /// * `storage` - 云存储实例
    /// * `changes` - 带完整数据的变更列表
    pub async fn upload_enriched_changes(
        &self,
        storage: &dyn CloudStorage,
        changes: &[SyncChangeWithData],
        progress: Option<Box<dyn Fn(u64, u64) + Send + Sync>>,
    ) -> Result<(), SyncError> {
        if changes.is_empty() {
            tracing::debug!("[sync] 没有变更需要上传");
            return Ok(());
        }

        let instance_id = self.ensure_remote_instance_id(storage).await?;
        let store = SyncStateStore::open_default()?;
        let cloud_max_seq = self
            .max_cloud_seq_for_device(storage, &self.device_id)
            .await?;
        let source_seq = store.next_upload_seq(&instance_id, &self.device_id, cloud_max_seq)?;

        // 版本使用秒级时间戳，仅作为展示/排序辅助；消费进度由 v3 seq/cursor 承载。
        let version = chrono::Utc::now().timestamp() as u64;
        let key = self.build_change_key_v3(source_seq, version);

        // 序列化为带完整数据的新格式
        let payload = SyncChangesPayload {
            changes: changes.to_vec(),
            total_count: changes.len(),
            device_id: self.device_id.clone(),
            format_version: 3, // v3 = 带完整数据 + per-device seq/cursor
            source_seq,
            source_device_id: self.device_id.clone(),
        };

        // Phase 5 Optimization: Compact JSON + Zstd Compression
        // 1. Serialize to compact JSON
        let json = serde_json::to_vec(&payload)
            .map_err(|e| SyncError::Database(format!("序列化变更数据失败: {}", e)))?;

        // 2. Compress using Zstd (default level 0 is usually 3)
        //    **顺序重要**：先压缩后加密。密文几乎不可压缩，如果反过来会浪费 CPU 且
        //    文件反而变大；而且若先加密再压，解密端必须先解压再解密，流程不对称。
        let compressed = zstd::stream::encode_all(std::io::Cursor::new(json), 0)
            .map_err(|e| SyncError::Database(format!("压缩变更数据失败: {}", e)))?;

        // 3. [P0-2] 可选端到端加密（AES-256-GCM + Argon2id）
        let final_bytes = self.encode_payload(&compressed)?;

        let compressed_size = compressed.len();
        let uploaded_size = final_bytes.len();
        let _total_count = payload.total_count;

        // [P0-10/C8] 上传后回验对象 size + 重试。
        //   - 进度路径首次走流式 put_file（实时字节进度），上传后用 stat 回验 size；
        //     若回验不符或上传失败，回退到带退避重试 + 回验的 put 路径（重试时无进度）。
        //   - 非进度路径直接走带退避重试 + 回验的 put 路径。
        // 回验失败一律返回 Err，调用方不会推进 sync_version（不 mark），下轮重传。
        if let Some(cb) = progress {
            // 有进度回调：写入临时文件，通过 put_file 流式上传以实时汇报字节进度
            let tmp = tempfile::NamedTempFile::new()
                .map_err(|e| SyncError::Database(format!("创建临时上传文件失败: {}", e)))?;
            std::fs::write(tmp.path(), &final_bytes)
                .map_err(|e| SyncError::Database(format!("写入临时上传文件失败: {}", e)))?;

            let streamed_ok = match storage.put_file(&key, tmp.path(), Some(cb)).await {
                Ok(_) => Self::verify_uploaded_size(storage, &key, uploaded_size as u64).await,
                Err(e) => {
                    tracing::warn!(
                        "[sync] 变更流式上传失败，将回退重试: key={}, err={}",
                        key,
                        e
                    );
                    false
                }
            };
            if !streamed_ok {
                Self::put_change_with_verify_retry(storage, &key, &final_bytes).await?;
            }
        } else {
            // 无进度回调：直接 PUT 字节，带指数退避重试 + size 回验
            Self::put_change_with_verify_retry(storage, &key, &final_bytes).await?;
        }
        store.mark_published_seq(&instance_id, &self.device_id, source_seq)?;

        tracing::info!(
            "[sync] 带完整数据的变更已上传: device={}, count={}, key={}, compressed_size={}, uploaded_size={}, encrypted={}",
            self.device_id,
            changes.len(),
            key,
            compressed_size,
            uploaded_size,
            self.encryption_enabled()
        );

        Ok(())
    }

    /// [P0-10/C8] 校验已上传对象的 size 是否与期望一致。
    ///
    /// stat 失败或对象缺失/大小不符均返回 `false`（视为未确认，触发重传），
    /// 而不是直接报错，以便上层统一处理重试与回退。
    async fn verify_uploaded_size(storage: &dyn CloudStorage, key: &str, expected: u64) -> bool {
        match storage.stat(key).await {
            Ok(Some(info)) => {
                if info.size == expected {
                    true
                } else {
                    tracing::warn!(
                        "[sync] 上传 size 回验不符: key={}, 期望={}, 实际={}",
                        key,
                        expected,
                        info.size
                    );
                    false
                }
            }
            Ok(None) => {
                tracing::warn!("[sync] 上传后对象不存在（回验失败）: key={}", key);
                false
            }
            Err(e) => {
                tracing::warn!("[sync] 上传 size 回验 stat 失败: key={}, err={}", key, e);
                false
            }
        }
    }

    /// [P0-10/C8] 带退避重试的 PUT，每次上传后立即回验 size，不符即报错并触发下次重试。
    async fn put_change_with_verify_retry(
        storage: &dyn CloudStorage,
        key: &str,
        bytes: &[u8],
    ) -> Result<(), SyncError> {
        let expected = bytes.len() as u64;
        retry_async("上传变更数据", 2, || {
            let bytes = bytes.to_vec();
            let key = key.to_string();
            async move {
                storage
                    .put(&key, &bytes)
                    .await
                    .map_err(|e| SyncError::Network(format!("上传变更数据失败: {}", e)))?;
                match storage.stat(&key).await {
                    Ok(Some(info)) if info.size == expected => Ok(()),
                    Ok(Some(info)) => Err(SyncError::Network(format!(
                        "上传后 size 校验失败: key={}, 期望={}, 实际={}",
                        key, expected, info.size
                    ))),
                    Ok(None) => Err(SyncError::Network(format!("上传后对象不存在: key={}", key))),
                    Err(e) => Err(SyncError::Network(format!("上传后回验失败: {}", e))),
                }
            }
        })
        .await
    }

    /// 下载变更数据（支持新旧两种格式）
    ///
    /// 从云端下载指定版本之后的所有变更数据。
    /// - 新格式（v2）：`SyncChangesPayload`，包含完整记录数据
    /// - 旧格式（v1）：`PendingChanges`，仅含 ChangeLogEntry 元数据
    ///
    /// 返回统一的 `Vec<SyncChangeWithData>`，新格式数据已含 `data` 字段，
    /// 旧格式的 INSERT/UPDATE 变更 `data` 字段为 None（回放时会记录告警并跳过）。
    ///
    /// # 参数
    /// * `storage` - 云存储实例
    /// * `since_version` - 起始版本号（时间戳），获取此版本之后的变更
    /// * `per_db_since` - 各数据库的起始版本号（用于跨库过滤）
    ///
    /// # 返回
    /// * `Ok(DownloadChangesResult)` - 下载的变更数据（含完整记录）及非致命解析告警
    /// * `Err(SyncError)` - 下载失败
    pub async fn download_changes(
        &self,
        storage: &dyn CloudStorage,
        since_version: u64,
        per_db_since: Option<&HashMap<String, u64>>,
    ) -> Result<DownloadChangesResult, SyncError> {
        let list = storage
            .list_outcome(Self::CHANGES_PREFIX)
            .await
            .map_err(|e| SyncError::Network(format!("列出变更文件失败: {}", e)))?;
        if list.truncated {
            return Err(SyncError::Network(
                "云端变更列表被截断，已停止下载以避免静默漏同步".to_string(),
            ));
        }
        let files = list.files;
        let instance_id = self.ensure_remote_instance_id(storage).await?;
        let store = SyncStateStore::open_default()?;
        let device_manifests = self
            .download_device_manifests(storage)
            .await
            .map_err(|e| SyncError::Network(format!("下载设备 manifest 失败: {}", e)))?;

        // [P0-8/C6] 版本号毫秒/秒归一化：legacy 文件名可能写入了毫秒时间戳（>1e11），
        // 而 since_version / per_db_since / prune / min_available 都以秒为口径。
        let since_norm = Self::normalize_version_to_seconds(since_version);

        let mut v3_files: HashMap<String, Vec<(u64, u64, String)>> = HashMap::new();
        let mut legacy_files: Vec<(String, u64, String)> = Vec::new();
        for file in files {
            match Self::parse_change_key(&file.key) {
                Some(ParsedChangeKey::V3 {
                    device_id,
                    seq,
                    version,
                }) => {
                    if device_id == self.device_id {
                        continue;
                    }
                    v3_files.entry(device_id).or_default().push((
                        seq,
                        Self::normalize_version_to_seconds(version),
                        file.key,
                    ));
                }
                Some(ParsedChangeKey::Legacy { device_id, version }) => {
                    if device_id == self.device_id {
                        continue;
                    }
                    legacy_files.push((
                        device_id,
                        Self::normalize_version_to_seconds(version),
                        file.key,
                    ));
                }
                None => {}
            }
        }

        let mut all_changes: Vec<(String, u64, u64, SyncChangeWithData)> = Vec::new();
        let decode_failures: Vec<String> = Vec::new();
        let mut legacy_processed_keys: Vec<String> = Vec::new();
        let mut cursor_advancements: HashMap<String, u64> = HashMap::new();

        for (uploader, mut files) in v3_files {
            files.sort_by_key(|(seq, version, key)| (*seq, *version, key.clone()));
            let mut expected = store.get_cursor(&instance_id, &uploader)?.saturating_add(1);
            let published_max = device_manifests
                .get(&uploader)
                .map(|m| m.published_max_seq)
                .unwrap_or_else(|| files.iter().map(|(seq, _, _)| *seq).max().unwrap_or(0));

            let mut index = 0usize;
            while index < files.len() {
                let seq = files[index].0;
                if seq < expected {
                    index += 1;
                    continue;
                }
                if seq > expected {
                    if expected <= published_max {
                        return Err(SyncError::Network(format!(
                            "云端文件缺失/无法解密，已停在安全点：设备 {} 缺少序号 {}（已发布到 {}）",
                            uploader, expected, published_max
                        )));
                    }
                    break;
                }

                while index < files.len() && files[index].0 == seq {
                    let (_, version, key) = files[index].clone();
                    let Some(data) = storage
                        .get(&key)
                        .await
                        .map_err(|e| SyncError::Network(format!("下载变更文件失败: {}", e)))?
                    else {
                        return Err(SyncError::Network(format!(
                            "云端文件缺失/无法解密，已停在安全点：{}",
                            key
                        )));
                    };
                    let decrypted = self.decode_payload(&data).map_err(|e| {
                        SyncError::Network(format!(
                            "云端文件缺失/无法解密，已停在安全点：{} ({})",
                            key, e
                        ))
                    })?;
                    let decoded_data =
                        zstd::stream::decode_all(std::io::Cursor::new(decrypted.as_slice()))
                            .unwrap_or(decrypted);
                    let payload = serde_json::from_slice::<SyncChangesPayload>(&decoded_data)
                        .map_err(|e| {
                            SyncError::Network(format!(
                                "云端文件缺失/无法解密，已停在安全点：{} ({})",
                                key, e
                            ))
                        })?;
                    let source_device = if payload.source_device_id.is_empty() {
                        uploader.clone()
                    } else {
                        payload.source_device_id.clone()
                    };
                    let source_seq = if payload.source_seq == 0 {
                        seq
                    } else {
                        payload.source_seq
                    };
                    for mut change in payload.changes {
                        change.source_device_id = Some(source_device.clone());
                        change.source_seq = Some(source_seq);
                        all_changes.push((source_device.clone(), source_seq, version, change));
                    }
                    cursor_advancements.insert(uploader.clone(), seq);
                    index += 1;
                }

                expected = expected.saturating_add(1);
            }
        }

        legacy_files.sort_by_key(|(device, version, key)| (device.clone(), *version, key.clone()));
        for (legacy_device, version, key) in legacy_files {
            if version < since_norm || store.is_legacy_processed(&instance_id, &key)? {
                continue;
            }
            if let Some(data) = storage
                .get(&key)
                .await
                .map_err(|e| SyncError::Network(format!("下载 legacy 变更文件失败: {}", e)))?
            {
                let decrypted = self.decode_payload(&data).map_err(|e| {
                    SyncError::Network(format!(
                        "legacy 云端变更无法解密，已停在安全点：{} ({})",
                        key, e
                    ))
                })?;
                let decoded_data =
                    zstd::stream::decode_all(std::io::Cursor::new(decrypted.as_slice()))
                        .unwrap_or(decrypted);
                if let Ok(payload) = serde_json::from_slice::<SyncChangesPayload>(&decoded_data) {
                    let source_device = if payload.source_device_id.is_empty() {
                        legacy_device.clone()
                    } else {
                        payload.source_device_id.clone()
                    };
                    let source_seq = if payload.source_seq == 0 {
                        version
                    } else {
                        payload.source_seq
                    };
                    for mut change in payload.changes {
                        change.source_device_id = Some(source_device.clone());
                        change.source_seq = Some(source_seq);
                        if let Some(db) = change.database_name.as_deref() {
                            if let Some(db_since) = per_db_since.and_then(|m| m.get(db)) {
                                if version < Self::normalize_version_to_seconds(*db_since) {
                                    continue;
                                }
                            }
                        }
                        all_changes.push(("legacy".to_string(), 0, version, change));
                    }
                    legacy_processed_keys.push(key);
                } else if let Ok(changes) = serde_json::from_slice::<PendingChanges>(&decoded_data)
                {
                    for entry in &changes.entries {
                        let mut change = SyncChangeWithData::from_entry(entry);
                        change.source_device_id = Some(legacy_device.clone());
                        change.source_seq = Some(version);
                        all_changes.push(("legacy".to_string(), 0, version, change));
                    }
                    legacy_processed_keys.push(key);
                } else {
                    return Err(SyncError::Network(format!(
                        "legacy 云端变更无法解析，已停在安全点：{}",
                        key
                    )));
                }
            }
        }

        // v3 先按上传设备与 seq 连续顺序排序；同一变更包内部再按 writer-side 顺序。
        all_changes.sort_by(|a, b| {
            let (a_device, a_seq, a_version, a_change) = a;
            let (b_device, b_seq, b_version, b_change) = b;

            match a_device.cmp(b_device) {
                std::cmp::Ordering::Equal => {}
                ord => return ord,
            }
            match a_seq.cmp(b_seq) {
                std::cmp::Ordering::Equal => {}
                ord => return ord,
            }

            match a_version.cmp(b_version) {
                std::cmp::Ordering::Equal => {}
                ord => return ord,
            }

            let ta = Self::parse_flexible_timestamp(&a_change.changed_at);
            let tb = Self::parse_flexible_timestamp(&b_change.changed_at);
            match (ta, tb) {
                (Some(a_dt), Some(b_dt)) => a_dt.cmp(&b_dt),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => a_change.changed_at.cmp(&b_change.changed_at),
            }
            .then_with(|| a_change.database_name.cmp(&b_change.database_name))
            .then_with(|| a_change.table_name.cmp(&b_change.table_name))
            // SQLite change_log_id preserves the writer-side trigger/order within
            // one uploaded package. Keep it ahead of record_id so same-second
            // parent/child rows are not alphabetically inverted on download.
            .then_with(|| a_change.change_log_id.cmp(&b_change.change_log_id))
            .then_with(|| a_change.record_id.cmp(&b_change.record_id))
            .then_with(|| a_change.operation.as_str().cmp(b_change.operation.as_str()))
        });

        let before_dedupe = all_changes.len();
        all_changes = Self::dedupe_downloaded_changes_with_source(all_changes);
        let deduped = before_dedupe.saturating_sub(all_changes.len());

        tracing::info!(
            "[sync] 从云端下载变更: since={}, total={}, deduped={}, v3_devices={}, legacy={}",
            since_version,
            all_changes.len(),
            deduped,
            cursor_advancements.len(),
            legacy_processed_keys.len()
        );

        Ok(DownloadChangesResult {
            changes: all_changes
                .into_iter()
                .map(|(_, _, _, change)| change)
                .collect(),
            decode_failures,
            cursor_advancements,
            legacy_processed_keys,
        })
    }

    /// 判断变更文件是否属于本设备
    fn is_own_change_file(key: &str, self_device_id: &str) -> bool {
        // 路径: data_governance/changes/{device_id}/{version}-{nonce}.json[.zst]
        let parts: Vec<&str> = key.split('/').collect();
        if parts.len() >= 3 {
            // parts: ["data_governance", "changes", "{device_id}", "{filename}"]
            if let Some(device_part) = parts.get(2) {
                return *device_part == self_device_id;
            }
        }
        false
    }

    /// 从文件路径解析版本号
    fn parse_version_from_key(key: &str) -> Option<u64> {
        // v3 格式: data_governance/changes/{device_id}/{seq}-{version}-{nonce}.json.zst
        // 新格式: data_governance/changes/{device_id}/{version}-{nonce}.json.zst
        // 旧格式: data_governance/changes/{device_id}/{version}-{nonce}.json
        //     或: data_governance/changes/{device_id}/{version}.json
        match Self::parse_change_key(key) {
            Some(ParsedChangeKey::V3 { version, .. }) => Some(version),
            Some(ParsedChangeKey::Legacy { version, .. }) => Some(version),
            None => None,
        }
    }

    fn parse_change_key(key: &str) -> Option<ParsedChangeKey> {
        let parts: Vec<&str> = key.split('/').collect();
        let device_id = parts.get(2)?.to_string();
        let filename = parts.last()?;
        let stem = filename
            .strip_suffix(".json.zst")
            .or_else(|| filename.strip_suffix(".json"))?;
        let mut segments = stem.split('-');
        let first = segments.next()?;
        let second = segments.next();

        if first.len() == 12 && first.chars().all(|c| c.is_ascii_digit()) {
            if let Some(second) = second {
                if let (Ok(seq), Ok(version)) = (first.parse::<u64>(), second.parse::<u64>()) {
                    return Some(ParsedChangeKey::V3 {
                        device_id,
                        seq,
                        version,
                    });
                }
            }
        }

        first
            .parse::<u64>()
            .ok()
            .map(|version| ParsedChangeKey::Legacy { device_id, version })
    }

    fn dedupe_downloaded_changes(
        changes: Vec<(u64, SyncChangeWithData)>,
    ) -> Vec<(u64, SyncChangeWithData)> {
        // [P0-7] keep-last 去重：对内容指纹相同的重复变更，保留顺序上**最后**出现的一条。
        //
        // 之前的 keep-first 实现存在终态错误：序列 "x=1 → x=2 → x=1" 中，第 1 条与第 3 条
        // 的内容指纹相同，keep-first 会保留第 1 条 (x=1) 并丢弃第 3 条 (x=1)，最终保留
        // [x=1, x=2]，按序应用后终态变成 x=2（错误，正确终态应为 x=1）。
        //
        // 倒序扫描时首次见到某指纹即保留（对应正序最后一条），再恢复原始顺序，
        // 即可保证回到旧值的序列其终态正确。
        let mut seen = HashSet::new();
        let mut kept_rev: Vec<(u64, SyncChangeWithData)> = Vec::with_capacity(changes.len());

        for (version, change) in changes.into_iter().rev() {
            let key = Self::download_change_dedupe_key(&change);
            if seen.insert(key) {
                kept_rev.push((version, change));
            }
        }

        kept_rev.reverse();
        kept_rev
    }

    fn dedupe_downloaded_changes_with_source(
        changes: Vec<(String, u64, u64, SyncChangeWithData)>,
    ) -> Vec<(String, u64, u64, SyncChangeWithData)> {
        let mut seen = HashSet::new();
        let mut kept_rev: Vec<(String, u64, u64, SyncChangeWithData)> =
            Vec::with_capacity(changes.len());

        for (device, seq, version, change) in changes.into_iter().rev() {
            let key = Self::download_change_dedupe_key(&change);
            if seen.insert(key) {
                kept_rev.push((device, seq, version, change));
            }
        }

        kept_rev.reverse();
        kept_rev
    }

    fn download_change_dedupe_key(change: &SyncChangeWithData) -> String {
        use sha2::{Digest, Sha256};

        let data = change
            .data
            .as_ref()
            .map(Self::canonicalize_sync_value_for_compare)
            .unwrap_or(serde_json::Value::Null);
        let raw = serde_json::json!({
            "database": change.database_name,
            "table": change.table_name,
            "record": change.record_id,
            "operation": change.operation.as_str(),
            "data": data,
        });
        let encoded = serde_json::to_vec(&raw).unwrap_or_default();
        let digest = Sha256::digest(&encoded);
        hex::encode(&digest[..16])
    }

    /// 将版本号归一化为秒级时间戳
    ///
    /// 历史代码可能将 sync_version 写入了毫秒值（>1e12）。
    /// 秒级时间戳范围大约是 1e9 ~ 2e9（1970-2038），
    /// 毫秒时间戳在 1e12 ~ 2e12。阈值 1e11 可安全区分。
    fn normalize_version_to_seconds(version: u64) -> u64 {
        const MILLIS_THRESHOLD: u64 = 100_000_000_000; // 1e11
        if version > MILLIS_THRESHOLD {
            version / 1000
        } else {
            version
        }
    }

    /// 构造变更文件 key（避免秒级冲突覆盖）
    fn build_change_key(&self, version: u64) -> String {
        let nonce = uuid::Uuid::new_v4();
        format!(
            "{}/{}/{}-{}.json.zst",
            Self::CHANGES_PREFIX,
            self.device_id,
            version,
            nonce
        )
    }

    /// 构造 v3 变更文件 key：{seq:012}-{ts}-{nonce}.json.zst
    fn build_change_key_v3(&self, seq: u64, version: u64) -> String {
        let nonce = uuid::Uuid::new_v4();
        format!(
            "{}/{}/{:012}-{}-{}.json.zst",
            Self::CHANGES_PREFIX,
            self.device_id,
            seq,
            version,
            nonce
        )
    }

    async fn max_cloud_seq_for_device(
        &self,
        storage: &dyn CloudStorage,
        device_id: &str,
    ) -> Result<u64, SyncError> {
        let prefix = format!("{}/{}", Self::CHANGES_PREFIX, device_id);
        let list = storage
            .list_outcome(&prefix)
            .await
            .map_err(|e| SyncError::Network(format!("列出本设备变更文件失败: {}", e)))?;
        if list.truncated {
            return Err(SyncError::Network(
                "云端本设备变更列表被截断，无法安全分配上传序号".to_string(),
            ));
        }
        Ok(list
            .files
            .iter()
            .filter_map(|f| match Self::parse_change_key(&f.key) {
                Some(ParsedChangeKey::V3 {
                    device_id: parsed,
                    seq,
                    ..
                }) if parsed == device_id => Some(seq),
                _ => None,
            })
            .max()
            .unwrap_or(0))
    }

    fn database_path_for_active_dir(
        db_id: &DatabaseId,
        active_dir: &std::path::Path,
    ) -> std::path::PathBuf {
        match db_id {
            DatabaseId::Vfs => active_dir.join("databases").join("vfs.db"),
            DatabaseId::ChatV2 => active_dir.join("chat_v2.db"),
            DatabaseId::Mistakes => active_dir.join("mistakes.db"),
            DatabaseId::LlmUsage => active_dir.join("llm_usage.db"),
        }
    }

    fn snapshot_key(database_name: &str, device_id: &str) -> String {
        format!(
            "{}/{}/{}-{}-{}.json.zst",
            Self::SNAPSHOTS_PREFIX,
            database_name,
            chrono::Utc::now().timestamp_millis(),
            device_id,
            uuid::Uuid::new_v4()
        )
    }

    async fn snapshot_due_for_db(
        &self,
        storage: &dyn CloudStorage,
        database_name: &str,
    ) -> Result<bool, SyncError> {
        let prefix = format!("{}/{}", Self::SNAPSHOTS_PREFIX, database_name);
        let list = storage
            .list_outcome(&prefix)
            .await
            .map_err(|e| SyncError::Network(format!("列出快照失败: {}", e)))?;
        if list.truncated {
            return Err(SyncError::Network(
                "云端快照列表被截断，无法安全判断是否需要生成快照".to_string(),
            ));
        }
        let Some(newest) = list.files.iter().map(|f| f.last_modified).max() else {
            return Ok(true);
        };
        let cutoff = chrono::Utc::now() - chrono::Duration::days(Self::SNAPSHOT_INTERVAL_DAYS);
        Ok(newest < cutoff)
    }

    fn table_exists_for_snapshot(conn: &Connection, table_name: &str) -> Result<bool, SyncError> {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            params![table_name],
            |row| row.get(0),
        )
        .map_err(|e| SyncError::Database(format!("检查快照表是否存在失败: {}", e)))
    }

    fn collect_snapshot_rows(
        conn: &Connection,
        database_name: &str,
    ) -> Result<HashMap<String, Vec<serde_json::Value>>, SyncError> {
        let mut tables = classification::TableClassification::row_sync_tables()
            .into_iter()
            .filter(|table| table.database == database_name)
            .collect::<Vec<_>>();
        tables.sort_by(|a, b| a.table_name.cmp(b.table_name));

        let mut rows_by_table = HashMap::new();
        for table in tables {
            if !Self::table_exists_for_snapshot(conn, table.table_name)? {
                continue;
            }
            let columns = Self::table_column_names(conn, table.table_name)?;
            if columns.is_empty() {
                continue;
            }
            let table_ident = Self::quote_identifier(table.table_name)?;
            let select_columns = columns
                .iter()
                .map(|column| Self::quote_identifier(column))
                .collect::<Result<Vec<_>, _>>()?
                .join(", ");
            let order_columns = Self::checksum_order_columns(table.primary_key, &columns);
            let order_expr = if order_columns.is_empty() {
                "rowid".to_string()
            } else {
                order_columns
                    .iter()
                    .map(|column| Self::quote_identifier(column))
                    .collect::<Result<Vec<_>, _>>()?
                    .join(", ")
            };
            let sql = format!(
                "SELECT {} FROM {} ORDER BY {}",
                select_columns, table_ident, order_expr
            );
            let mut stmt = conn.prepare(&sql).map_err(|e| {
                SyncError::Database(format!("准备快照查询失败 {}: {}", table.table_name, e))
            })?;
            let mut rows = stmt.query([]).map_err(|e| {
                SyncError::Database(format!("执行快照查询失败 {}: {}", table.table_name, e))
            })?;
            let mut table_rows = Vec::new();
            while let Some(row) = rows.next().map_err(|e| {
                SyncError::Database(format!("读取快照行失败 {}: {}", table.table_name, e))
            })? {
                let mut obj = serde_json::Map::new();
                for (idx, column) in columns.iter().enumerate() {
                    obj.insert(column.clone(), Self::sqlite_value_to_json(row, idx));
                }
                table_rows.push(serde_json::Value::Object(obj));
            }
            rows_by_table.insert(table.table_name.to_string(), table_rows);
        }
        Ok(rows_by_table)
    }

    fn build_database_snapshot(
        &self,
        conn: &Connection,
        database_name: &str,
        state: DatabaseSyncState,
        covered_cursors: HashMap<String, u64>,
    ) -> Result<SyncDatabaseSnapshot, SyncError> {
        Ok(SyncDatabaseSnapshot {
            format_version: Self::SNAPSHOT_FORMAT_VERSION,
            database_name: database_name.to_string(),
            device_id: self.device_id.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
            schema_version: state.schema_version,
            data_version: state.data_version,
            checksum: state.checksum,
            covered_cursors,
            rows: Self::collect_snapshot_rows(conn, database_name)?,
        })
    }

    async fn prune_snapshots_for_db(
        &self,
        storage: &dyn CloudStorage,
        database_name: &str,
    ) -> Result<usize, SyncError> {
        let prefix = format!("{}/{}", Self::SNAPSHOTS_PREFIX, database_name);
        let list = storage
            .list_outcome(&prefix)
            .await
            .map_err(|e| SyncError::Network(format!("列出快照失败: {}", e)))?;
        if list.truncated {
            tracing::warn!("[sync] 快照列表被截断，跳过快照清理: {}", database_name);
            return Ok(0);
        }
        let mut files = list.files;
        files.sort_by(|a, b| {
            b.last_modified
                .cmp(&a.last_modified)
                .then_with(|| b.key.cmp(&a.key))
        });
        let mut deleted = 0usize;
        for file in files.into_iter().skip(Self::SNAPSHOT_RETAIN_PER_DB) {
            storage
                .delete(&file.key)
                .await
                .map_err(|e| SyncError::Network(format!("删除旧快照失败 {}: {}", file.key, e)))?;
            deleted += 1;
        }
        Ok(deleted)
    }

    /// 生成按库全量快照。快照用于新设备/断层引导，也为 v3 prune 提供安全覆盖下界。
    pub async fn upload_sync_snapshots(
        &self,
        storage: &dyn CloudStorage,
        active_dir: &std::path::Path,
    ) -> Result<usize, SyncError> {
        if !Self::AUTHORITATIVE_SNAPSHOT_REPLACE_ENABLED {
            tracing::info!(
                "[sync] 跳过 v1 UPSERT-only 快照发布：权威 replace/delete-set 协议尚未启用"
            );
            return Ok(0);
        }
        let instance_id = self.ensure_remote_instance_id(storage).await?;
        let store = SyncStateStore::open_default()?;
        let mut covered_cursors = store.cursors(&instance_id)?;
        covered_cursors.insert(
            self.device_id.clone(),
            store.published_max_seq(&instance_id, &self.device_id)?,
        );

        let mut uploaded = 0usize;
        for db_id in DatabaseId::all_ordered() {
            let database_name = db_id.as_str();
            let db_path = Self::database_path_for_active_dir(&db_id, active_dir);
            if !db_path.exists() || !self.snapshot_due_for_db(storage, database_name).await? {
                continue;
            }

            let conn = Connection::open(&db_path).map_err(|e| {
                SyncError::Database(format!("打开数据库生成快照失败 {}: {}", database_name, e))
            })?;
            conn.busy_timeout(std::time::Duration::from_secs(5))
                .map_err(|e| {
                    SyncError::Database(format!(
                        "设置快照 busy_timeout 失败 {}: {}",
                        database_name, e
                    ))
                })?;
            let state = Self::get_database_sync_state(&conn, database_name)?;
            let snapshot =
                self.build_database_snapshot(&conn, database_name, state, covered_cursors.clone())?;
            let json = serde_json::to_vec(&snapshot)
                .map_err(|e| SyncError::Database(format!("序列化快照失败: {}", e)))?;
            let compressed = zstd::stream::encode_all(std::io::Cursor::new(json), 0)
                .map_err(|e| SyncError::Database(format!("压缩快照失败: {}", e)))?;
            let payload = self.encode_payload(&compressed)?;
            let key = Self::snapshot_key(database_name, &self.device_id);
            storage
                .put(&key, &payload)
                .await
                .map_err(|e| SyncError::Network(format!("上传快照失败 {}: {}", key, e)))?;
            uploaded += 1;
            let _ = self.prune_snapshots_for_db(storage, database_name).await?;
            tracing::info!(
                "[sync] 已上传数据库快照: db={}, key={}, tables={}",
                database_name,
                key,
                snapshot.rows.len()
            );
        }
        Ok(uploaded)
    }

    fn decode_snapshot_payload(&self, bytes: &[u8]) -> Result<SyncDatabaseSnapshot, SyncError> {
        let decoded = self.decode_payload(bytes)?;
        let json =
            zstd::stream::decode_all(std::io::Cursor::new(decoded.as_slice())).unwrap_or(decoded);
        serde_json::from_slice::<SyncDatabaseSnapshot>(&json)
            .map_err(|e| SyncError::Database(format!("解析数据库快照失败: {}", e)))
    }

    async fn download_latest_snapshots(
        &self,
        storage: &dyn CloudStorage,
    ) -> Result<HashMap<String, SyncDatabaseSnapshot>, SyncError> {
        let list = storage
            .list_outcome(Self::SNAPSHOTS_PREFIX)
            .await
            .map_err(|e| SyncError::Network(format!("列出快照失败: {}", e)))?;
        if list.truncated {
            return Err(SyncError::Network(
                "云端快照列表被截断，已停止快照引导以避免漏读".to_string(),
            ));
        }

        let mut latest: HashMap<String, SyncDatabaseSnapshot> = HashMap::new();
        for file in list.files {
            if !file.key.ends_with(".json.zst") {
                continue;
            }
            let Some(bytes) = storage
                .get(&file.key)
                .await
                .map_err(|e| SyncError::Network(format!("下载快照失败 {}: {}", file.key, e)))?
            else {
                continue;
            };
            let snapshot = match self.decode_snapshot_payload(&bytes) {
                Ok(snapshot) => snapshot,
                Err(e) => {
                    tracing::warn!("[sync] 跳过损坏快照: key={}, error={}", file.key, e);
                    continue;
                }
            };
            let replace = latest
                .get(&snapshot.database_name)
                .map(|old| snapshot.created_at > old.created_at)
                .unwrap_or(true);
            if replace {
                latest.insert(snapshot.database_name.clone(), snapshot);
            }
        }
        Ok(latest)
    }

    fn expected_snapshot_databases() -> HashSet<String> {
        classification::TableClassification::row_sync_tables()
            .into_iter()
            .map(|table| table.database.to_string())
            .collect()
    }

    fn missing_snapshot_databases(
        snapshots: &HashMap<String, SyncDatabaseSnapshot>,
    ) -> Vec<String> {
        let mut missing = Self::expected_snapshot_databases()
            .into_iter()
            .filter(|db| !snapshots.contains_key(db))
            .collect::<Vec<_>>();
        missing.sort();
        missing
    }

    async fn latest_snapshot_coverages(
        &self,
        storage: &dyn CloudStorage,
    ) -> Result<HashMap<String, SnapshotCoverage>, SyncError> {
        let snapshots = self.download_latest_snapshots(storage).await?;
        let missing = Self::missing_snapshot_databases(&snapshots);
        if !missing.is_empty() {
            tracing::warn!(
                "[sync] 快照覆盖不完整，拒绝用于 prune: missing_dbs={:?}",
                missing
            );
            return Ok(HashMap::new());
        }
        Ok(snapshots
            .into_iter()
            .map(|(db, snapshot)| {
                (
                    db,
                    SnapshotCoverage {
                        covered_cursors: snapshot.covered_cursors,
                    },
                )
            })
            .collect())
    }

    fn snapshot_record_id(
        table: &classification::TableClassification,
        row: &serde_json::Value,
    ) -> Option<String> {
        let obj = row.as_object()?;
        let pk_columns = table
            .primary_key
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.starts_with('('))
            .collect::<Vec<_>>();
        if pk_columns.is_empty() {
            return None;
        }
        if pk_columns.len() == 1 {
            let value = obj.get(pk_columns[0])?;
            return Self::json_value_to_alias_key(value).or_else(|| Some(value.to_string()));
        }

        let mut pk = serde_json::Map::new();
        for column in pk_columns {
            pk.insert(column.to_string(), obj.get(column)?.clone());
        }
        serde_json::to_string(&serde_json::Value::Object(pk)).ok()
    }

    /// 将最新快照转换为可复用的下载变更，以便新设备或断层设备先引导到快照覆盖点。
    pub async fn download_snapshot_bootstrap_changes(
        &self,
        storage: &dyn CloudStorage,
    ) -> Result<DownloadChangesResult, SyncError> {
        let mut snapshots = self.download_latest_snapshots(storage).await?;
        if snapshots.is_empty() {
            return Ok(DownloadChangesResult::default());
        }
        let missing = Self::missing_snapshot_databases(&snapshots);
        if !missing.is_empty() {
            tracing::warn!(
                "[sync] 快照覆盖不完整，拒绝用于下载引导: missing_dbs={:?}",
                missing
            );
            return Ok(DownloadChangesResult::default());
        }

        let mut ordered = snapshots.drain().collect::<Vec<_>>();
        ordered.sort_by(|a, b| a.0.cmp(&b.0));

        let mut changes = Vec::new();
        let mut cursor_advancements: Option<HashMap<String, u64>> = None;
        for (database_name, snapshot) in ordered {
            cursor_advancements = Some(match cursor_advancements.take() {
                None => snapshot.covered_cursors.clone(),
                Some(mut current) => {
                    current.retain(|device_id, seq| {
                        if let Some(next) = snapshot.covered_cursors.get(device_id) {
                            *seq = (*seq).min(*next);
                            true
                        } else {
                            false
                        }
                    });
                    current
                }
            });

            let mut tables = classification::TableClassification::row_sync_tables()
                .into_iter()
                .filter(|table| table.database == database_name)
                .collect::<Vec<_>>();
            tables.sort_by(|a, b| a.table_name.cmp(b.table_name));
            for table in tables {
                let Some(rows) = snapshot.rows.get(table.table_name) else {
                    continue;
                };
                for row in rows {
                    let Some(record_id) = Self::snapshot_record_id(&table, row) else {
                        tracing::warn!(
                            "[sync] 快照行缺少主键，已跳过: db={}, table={}",
                            database_name,
                            table.table_name
                        );
                        continue;
                    };
                    let changed_at = row
                        .as_object()
                        .and_then(|obj| obj.get("updated_at"))
                        .and_then(Self::timestamp_value_to_lww_string)
                        .unwrap_or_else(|| snapshot.created_at.clone());
                    changes.push(SyncChangeWithData {
                        table_name: table.table_name.to_string(),
                        record_id,
                        operation: ChangeOperation::Insert,
                        data: Some(row.clone()),
                        changed_at,
                        change_log_id: None,
                        database_name: Some(database_name.clone()),
                        suppress_change_log: Some(true),
                        source_device_id: Some(format!("snapshot:{}", snapshot.device_id)),
                        source_seq: None,
                    });
                }
            }
        }

        Ok(DownloadChangesResult {
            changes,
            decode_failures: Vec::new(),
            cursor_advancements: cursor_advancements.unwrap_or_default(),
            legacy_processed_keys: Vec::new(),
        })
    }

    async fn safe_prune_seq_for_self(
        &self,
        storage: &dyn CloudStorage,
        active_days: u64,
    ) -> Result<u64, SyncError> {
        let coverages = self.latest_snapshot_coverages(storage).await?;
        if coverages.is_empty() {
            return Ok(0);
        }
        let snapshot_covered = coverages
            .values()
            .filter_map(|coverage| coverage.covered_cursors.get(&self.device_id).copied())
            .min()
            .unwrap_or(0);
        if snapshot_covered == 0 {
            return Ok(0);
        }

        let manifests = self.download_device_manifests(storage).await?;
        let active_cutoff = chrono::Utc::now() - chrono::Duration::days(active_days as i64);
        let mut active_consumer_cursors = Vec::new();
        for (device_id, manifest) in manifests {
            if device_id == self.device_id || manifest.superseded_by.is_some() {
                continue;
            }
            let active = Self::parse_flexible_timestamp(&manifest.created_at)
                .map(|ts| ts >= active_cutoff)
                .unwrap_or(true);
            if active {
                active_consumer_cursors
                    .push(manifest.cursors.get(&self.device_id).copied().unwrap_or(0));
            }
        }

        let active_cursor_floor = active_consumer_cursors
            .into_iter()
            .min()
            .unwrap_or(snapshot_covered);
        Ok(snapshot_covered.min(active_cursor_floor))
    }

    pub async fn commit_download_progress(
        &self,
        storage: &dyn CloudStorage,
        downloaded: &DownloadChangesResult,
    ) -> Result<(), SyncError> {
        let instance_id = self.ensure_remote_instance_id(storage).await?;
        let store = SyncStateStore::open_default()?;
        for (device, seq) in &downloaded.cursor_advancements {
            store.set_cursor(&instance_id, &device, *seq)?;
        }
        for key in &downloaded.legacy_processed_keys {
            store.mark_legacy_processed(&instance_id, key)?;
        }
        Ok(())
    }

    /// 清理云端过期的变更文件
    ///
    /// 两级清理策略：
    /// 1. 本设备文件：删除版本号早于 `retention_days` 天前的文件
    /// 2. [P2 Fix] 任意设备文件：删除版本号早于 `retention_days * 3` 天前的文件，
    ///    解决退役/重装设备遗留的变更文件永久占用云端存储的问题。
    ///    3 倍宽限期确保即使设备长期离线，也有足够的窗口恢复同步。
    pub async fn prune_old_changes(
        &self,
        storage: &dyn CloudStorage,
        retention_days: u64,
    ) -> Result<usize, SyncError> {
        if !Self::AUTHORITATIVE_SNAPSHOT_REPLACE_ENABLED {
            tracing::info!("[sync] 自动 prune 已禁用：当前快照不具备权威 replace/delete-set 语义");
            return Ok(0);
        }
        let list = storage
            .list_outcome(Self::CHANGES_PREFIX)
            .await
            .map_err(|e| SyncError::Network(format!("列出变更文件失败: {}", e)))?;
        if list.truncated {
            tracing::warn!("[sync] 云端变更列表被截断，跳过本轮 prune 以避免误删");
            return Ok(0);
        }
        let safe_seq = self
            .safe_prune_seq_for_self(storage, retention_days)
            .await?;
        if safe_seq == 0 {
            tracing::info!("[sync] 跳过变更文件 prune：尚无覆盖本设备变更的安全快照/游标下界");
            return Ok(0);
        }

        let mut deleted = 0usize;
        for file in list.files {
            match Self::parse_change_key(&file.key) {
                Some(ParsedChangeKey::V3 { device_id, seq, .. })
                    if device_id == self.device_id && seq <= safe_seq =>
                {
                    storage.delete(&file.key).await.map_err(|e| {
                        SyncError::Network(format!("删除变更文件失败 {}: {}", file.key, e))
                    })?;
                    deleted += 1;
                }
                _ => {}
            }
        }

        tracing::info!(
            "[sync] v3 变更文件 prune 完成: device={}, safe_seq={}, deleted={}",
            self.device_id,
            safe_seq,
            deleted
        );
        Ok(deleted)
    }

    /// 执行完整的上传同步流程（v1 旧格式：不含完整行数据）
    ///
    /// **已废弃**：新代码应在调用方直接使用 `upload_enriched_changes` + `upload_manifest`。
    /// 此方法上传的 `PendingChanges` 仅含 ChangeLogEntry 元数据，下载端无法回放 INSERT/UPDATE。
    ///
    /// # 参数
    /// * `storage` - 云存储实例
    /// * `pending` - 待上传的变更数据（已从数据库获取）
    /// * `local_manifest` - 本地同步清单
    ///
    /// # 返回
    /// * `(SyncExecutionResult, Vec<i64>)` - 同步执行结果和需要标记为已同步的变更 ID
    pub async fn execute_upload(
        &self,
        storage: &dyn CloudStorage,
        pending: &PendingChanges,
        local_manifest: &SyncManifest,
    ) -> Result<(SyncExecutionResult, Vec<i64>), SyncError> {
        let start = std::time::Instant::now();

        if !pending.has_changes() {
            return Ok((
                SyncExecutionResult {
                    success: true,
                    direction: SyncDirection::Upload,
                    changes_uploaded: 0,
                    changes_downloaded: 0,
                    conflicts_detected: 0,
                    duration_ms: start.elapsed().as_millis() as u64,
                    error_message: None,
                },
                vec![],
            ));
        }

        // 1. 上传变更数据
        self.upload_changes(storage, pending).await?;

        // 2. 上传清单
        self.upload_manifest(storage, local_manifest).await?;

        // 3. 返回需要标记的变更 ID
        let change_ids = pending.get_change_ids();
        let changes_count = pending.total_count;

        Ok((
            SyncExecutionResult {
                success: true,
                direction: SyncDirection::Upload,
                changes_uploaded: changes_count,
                changes_downloaded: 0,
                conflicts_detected: 0,
                duration_ms: start.elapsed().as_millis() as u64,
                error_message: None,
            },
            change_ids,
        ))
    }

    /// 执行完整的下载同步流程
    ///
    /// 1. 从云端下载清单
    /// 2. 检测冲突
    /// 3. 下载变更数据
    ///
    /// # 参数
    /// * `storage` - 云存储实例
    /// * `local_manifest` - 本地同步清单
    /// * `strategy` - 冲突合并策略
    ///
    /// # 返回
    /// * `(SyncExecutionResult, DownloadChangesResult)` - 同步执行结果和下载的变更数据（含完整记录）
    pub async fn execute_download(
        &self,
        storage: &dyn CloudStorage,
        local_manifest: &SyncManifest,
        strategy: MergeStrategy,
    ) -> Result<(SyncExecutionResult, DownloadChangesResult), SyncError> {
        let start = std::time::Instant::now();

        // 1. 下载云端清单
        let cloud_manifest = self.download_manifest(storage).await?;

        // 云端无清单事务时，仍兜底扫描 changes/，避免“变更已上传但清单缺失”导致不可见
        if cloud_manifest.sync_transaction_id.is_empty() {
            let per_db_since: HashMap<String, u64> = local_manifest
                .databases
                .iter()
                .map(|(name, state)| (name.clone(), state.data_version))
                .collect();
            let since_version = per_db_since.values().min().copied().unwrap_or(0);

            let downloaded = self
                .download_changes(storage, since_version, Some(&per_db_since))
                .await?;
            let warning = if downloaded.decode_failures.is_empty() {
                None
            } else {
                Some(format!(
                    "检测到 {} 个云端变更文件解析失败，已跳过并继续同步。",
                    downloaded.decode_failures.len()
                ))
            };

            return Ok((
                SyncExecutionResult {
                    success: true,
                    direction: SyncDirection::Download,
                    changes_uploaded: 0,
                    changes_downloaded: downloaded.changes.len(),
                    conflicts_detected: 0,
                    duration_ms: start.elapsed().as_millis() as u64,
                    error_message: warning,
                },
                downloaded,
            ));
        }

        // 2. 检测冲突
        let detection = Self::detect_conflicts(local_manifest, &cloud_manifest)?;

        if detection.needs_migration {
            return Err(SyncError::SchemaMismatch {
                local: detection
                    .database_conflicts
                    .first()
                    .and_then(|c| c.local_state.as_ref())
                    .map(|s| s.schema_version)
                    .unwrap_or(0),
                cloud: detection
                    .database_conflicts
                    .first()
                    .and_then(|c| c.cloud_state.as_ref())
                    .map(|s| s.schema_version)
                    .unwrap_or(0),
            });
        }

        // 3. 如果有冲突且是手动模式，返回错误
        if detection.has_conflicts && strategy == MergeStrategy::Manual {
            return Err(SyncError::ManualResolutionRequired {
                count: detection.total_conflicts(),
            });
        }

        // 4. 下载变更数据
        // 使用最小数据版本作为文件级过滤，并按库进一步过滤
        let per_db_since: HashMap<String, u64> = local_manifest
            .databases
            .iter()
            .map(|(name, state)| (name.clone(), state.data_version))
            .collect();
        let since_version = per_db_since.values().min().copied().unwrap_or(0);

        let downloaded = self
            .download_changes(storage, since_version, Some(&per_db_since))
            .await?;
        let warning = if downloaded.decode_failures.is_empty() {
            None
        } else {
            Some(format!(
                "检测到 {} 个云端变更文件解析失败，已跳过并继续同步。",
                downloaded.decode_failures.len()
            ))
        };

        let conflicts_count = if detection.has_conflicts {
            detection.total_conflicts()
        } else {
            0
        };

        Ok((
            SyncExecutionResult {
                success: true,
                direction: SyncDirection::Download,
                changes_uploaded: 0,
                changes_downloaded: downloaded.changes.len(),
                conflicts_detected: conflicts_count,
                duration_ms: start.elapsed().as_millis() as u64,
                error_message: warning,
            },
            downloaded,
        ))
    }

    /// 执行双向同步流程
    ///
    /// 1. 先执行下载同步
    /// 2. 再执行上传同步
    ///
    /// # 参数
    /// * `storage` - 云存储实例
    /// * `pending` - 待上传的变更数据（已从数据库获取）
    /// * `local_manifest` - 本地同步清单
    /// * `strategy` - 冲突合并策略
    ///
    /// # 返回
    /// * `(SyncExecutionResult, Vec<i64>, DownloadChangesResult)` - 同步结果、需要标记的变更 ID、下载的变更（含完整数据）
    ///
    /// **重要**：此方法只执行下载，**不执行上传**。
    /// 调用方需自行调用 `upload_enriched_changes` + `upload_manifest` 上传带完整数据的变更。
    /// 这避免了"内部 v1 上传 + 外部 v2 上传"导致的重复/覆盖问题。
    pub async fn execute_bidirectional(
        &self,
        storage: &dyn CloudStorage,
        pending: &PendingChanges,
        local_manifest: &SyncManifest,
        strategy: MergeStrategy,
    ) -> Result<(SyncExecutionResult, Vec<i64>, DownloadChangesResult), SyncError> {
        let start = std::time::Instant::now();

        // 1. 下载并应用云端变更
        let (download_result, downloaded_changes) = self
            .execute_download(storage, local_manifest, strategy)
            .await?;

        // 2. 上传由调用方负责（使用 enriched 数据），这里只返回需要标记的变更 ID
        let change_ids = pending.get_change_ids();
        let changes_count = pending.total_count;

        Ok((
            SyncExecutionResult {
                success: true,
                direction: SyncDirection::Bidirectional,
                changes_uploaded: changes_count,
                changes_downloaded: download_result.changes_downloaded,
                conflicts_detected: download_result.conflicts_detected,
                duration_ms: start.elapsed().as_millis() as u64,
                error_message: download_result.error_message,
            },
            change_ids,
            downloaded_changes,
        ))
    }

    // ========================================================================
    // 核心同步方法
    // ========================================================================

    /// 获取待同步的变更
    ///
    /// 查询 __change_log 表中 sync_version = 0 的所有记录。
    ///
    /// # 参数
    /// * `conn` - 数据库连接
    /// * `table_filter` - 可选的表名过滤器，为 None 时查询所有表
    /// * `limit` - 可选的返回数量限制
    ///
    /// # 返回
    /// * `PendingChanges` - 待同步的变更集合
    pub fn get_pending_changes(
        conn: &Connection,
        table_filter: Option<&str>,
        limit: Option<usize>,
    ) -> Result<PendingChanges, SyncError> {
        let has_field_deltas = Self::table_has_column(conn, "__change_log", "field_deltas_json");
        let mut sql =
            String::from("SELECT id, table_name, record_id, operation, changed_at, sync_version");
        if has_field_deltas {
            sql.push_str(", field_deltas_json");
        }
        sql.push_str(
            "
             FROM __change_log
             WHERE sync_version = 0",
        );

        if table_filter.is_some() {
            sql.push_str(" AND table_name = ?1");
        }

        sql.push_str(" ORDER BY changed_at ASC");

        if let Some(limit_val) = limit {
            sql.push_str(&format!(" LIMIT {}", limit_val));
        }

        let entries: Vec<ChangeLogEntry> = if let Some(table_name) = table_filter {
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| SyncError::Database(format!("准备查询语句失败: {}", e)))?;

            let rows = stmt
                .query_map(params![table_name], ChangeLogEntry::from_row)
                .map_err(|e| SyncError::Database(format!("执行查询失败: {}", e)))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| SyncError::Database(format!("解析结果失败: {}", e)))?
        } else {
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| SyncError::Database(format!("准备查询语句失败: {}", e)))?;

            let rows = stmt
                .query_map([], ChangeLogEntry::from_row)
                .map_err(|e| SyncError::Database(format!("执行查询失败: {}", e)))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| SyncError::Database(format!("解析结果失败: {}", e)))?
        };

        Ok(PendingChanges::from_entries(entries))
    }

    /// 按同步分类过滤待上传变更。
    ///
    /// `get_pending_changes` 是底层 change-log 读取函数，仍然允许 synthetic schema
    /// 和旧测试库直接读取任意表；真实云同步上传路径必须调用本函数，只发布
    /// registry 中声明为 RowSync 的表，避免派生表、运行态表和备份表被误上传。
    pub fn filter_pending_changes_for_database(
        pending: PendingChanges,
        database_name: &str,
    ) -> PendingChanges {
        let row_sync_tables: HashSet<&'static str> =
            classification::TableClassification::row_sync_tables()
                .into_iter()
                .filter(|entry| entry.database == database_name)
                .map(|entry| entry.table_name)
                .collect();

        PendingChanges::from_entries(
            pending
                .entries
                .into_iter()
                .filter(|entry| row_sync_tables.contains(entry.table_name.as_str()))
                .collect(),
        )
    }

    /// 标记变更已同步
    ///
    /// 更新 __change_log 表中指定记录的 sync_version 字段。
    ///
    /// # 参数
    /// * `conn` - 数据库连接
    /// * `change_ids` - 要标记的变更日志 ID 列表
    /// * `sync_version` - 同步版本号（通常使用时间戳或递增版本）
    ///
    /// # 返回
    /// * 更新的记录数量
    pub fn mark_synced(
        conn: &Connection,
        change_ids: &[i64],
        sync_version: i64,
    ) -> Result<usize, SyncError> {
        if change_ids.is_empty() {
            return Ok(0);
        }

        // [P0-9/C7] 分批更新，避免一次性 UPDATE ... IN (...) 超过 SQLite 变量上限
        // （默认 SQLITE_MAX_VARIABLE_NUMBER = 999 或 32766）导致整体失败 → 已上传
        // 的变更标记不成功 → 下轮重复上传死循环。单事务包裹保证要么全部标记成功、
        // 要么全部回滚，不留部分标记的中间态。
        const MARK_BATCH_SIZE: usize = 500;

        let tx = conn
            .unchecked_transaction()
            .map_err(|e| SyncError::Database(format!("开启标记事务失败: {}", e)))?;

        let mut updated = 0usize;
        for chunk in change_ids.chunks(MARK_BATCH_SIZE) {
            // 占位符从 ?2 开始（?1 留给 sync_version）
            let placeholders: Vec<String> =
                (0..chunk.len()).map(|i| format!("?{}", i + 2)).collect();
            let sql = format!(
                "UPDATE __change_log SET sync_version = ?1 WHERE id IN ({})",
                placeholders.join(", ")
            );

            let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::with_capacity(chunk.len() + 1);
            params_vec.push(Box::new(sync_version));
            for id in chunk {
                params_vec.push(Box::new(*id));
            }
            let params_refs: Vec<&dyn rusqlite::ToSql> =
                params_vec.iter().map(|b| b.as_ref()).collect();

            updated += tx
                .execute(&sql, params_refs.as_slice())
                .map_err(|e| SyncError::Database(format!("更新同步版本失败: {}", e)))?;
        }

        tx.commit()
            .map_err(|e| SyncError::Database(format!("提交标记事务失败: {}", e)))?;

        Ok(updated)
    }

    /// 批量标记变更已同步（使用当前时间戳作为版本）
    ///
    /// # 参数
    /// * `conn` - 数据库连接
    /// * `change_ids` - 要标记的变更日志 ID 列表
    ///
    /// # 返回
    /// * 更新的记录数量
    pub fn mark_synced_with_timestamp(
        conn: &Connection,
        change_ids: &[i64],
    ) -> Result<usize, SyncError> {
        // 使用秒级时间戳，与上传文件 key 版本保持同一版本空间
        let sync_version = chrono::Utc::now().timestamp();

        // 兼容修复：将历史毫秒级 sync_version 归一化为秒级，避免 data_version 卡在毫秒量级
        Self::normalize_existing_millis_sync_versions(conn);

        Self::mark_synced(conn, change_ids, sync_version)
    }

    /// 一次性修复历史毫秒级 sync_version 值
    ///
    /// 如果 __change_log 中存在 sync_version > 1e11 的记录，
    /// 将它们除以 1000 归一化为秒级，防止 data_version (MAX) 卡在毫秒量级。
    fn normalize_existing_millis_sync_versions(conn: &Connection) {
        const MILLIS_THRESHOLD: i64 = 100_000_000_000; // 1e11
        match conn.execute(
            "UPDATE __change_log SET sync_version = sync_version / 1000 WHERE sync_version > ?1",
            rusqlite::params![MILLIS_THRESHOLD],
        ) {
            Ok(count) if count > 0 => {
                tracing::info!("[sync] 归一化了 {} 条历史毫秒级 sync_version 到秒级", count);
            }
            Ok(_) => {} // 没有需要修复的记录
            Err(e) => {
                tracing::warn!("[sync] 归一化 sync_version 失败（非致命）: {}", e);
            }
        }
    }

    /// 清理已同步的变更日志
    ///
    /// 删除 sync_version > 0 且早于指定时间的变更日志记录。
    /// 这可以在同步完成后调用，以防止变更日志表无限增长。
    ///
    /// # 参数
    /// * `conn` - 数据库连接
    /// * `older_than` - 删除早于此时间的记录（ISO 8601 格式）
    ///
    /// # 返回
    /// * 删除的记录数量
    pub fn cleanup_synced_changes(conn: &Connection, older_than: &str) -> Result<usize, SyncError> {
        // changed_at 由 datetime('now') 写入（"YYYY-MM-DD HH:MM:SS"），而调用方
        // 传入的 older_than 通常是 RFC3339（含 'T' 与时区后缀）。直接字符串比较
        // 在同日期时 ' ' < 'T' 恒成立，会误删边界日的记录；用 datetime() 把两侧
        // 归一化为同一格式再比较。无法解析的 changed_at 得到 NULL，比较结果为
        // NULL（不删除），天然 fail-safe。
        let deleted = conn
            .execute(
                "DELETE FROM __change_log
                 WHERE sync_version > 0 AND datetime(changed_at) < datetime(?1)",
                params![older_than],
            )
            .map_err(|e| SyncError::Database(format!("清理变更日志失败: {}", e)))?;

        Ok(deleted)
    }

    /// 重建同步基线（用于 ZIP 备份恢复后）
    ///
    /// 从 ZIP 备份恢复数据后，`__change_log` 表的状态可能：
    /// - 完全缺失（老备份不包含变更日志）
    /// - 包含源设备的历史变更（sync_version 混合）
    ///
    /// 无论哪种情况，都需要把整个库视为"已同步"的快照，避免把恢复的数据
    /// 当作"新变更"再次推送到云端，产生时光倒流式的数据覆盖。
    ///
    /// 此函数执行以下操作：
    /// 1. 截断 `__change_log` 表（删除所有历史变更记录）
    /// 2. 更新所有业务表的 `sync_version = local_version`（所有现存记录标记为"已同步"）
    /// 3. 清除任何未解决的冲突记录（`__sync_conflicts` 表）
    ///
    /// 调用方需要**负责重新执行一次完整的 upload 同步**以发布设备清单，
    /// 否则云端仍会认为此设备的 data_version 是恢复前的状态。
    ///
    /// # 参数
    /// * `conn` - 已打开的数据库连接（应在事务内调用以确保原子性）
    ///
    /// # 返回
    /// * `(truncated_changes, reset_records)` - 清理的变更日志条数 + 重置 sync_version 的业务记录条数
    pub fn reset_sync_baseline_after_restore(
        conn: &Connection,
    ) -> Result<(usize, usize), SyncError> {
        // 注意步骤顺序：必须先 UPDATE 业务表（touch local_version），
        // 再 DELETE __change_log。因为业务表上通常装有 trg_upd 触发器，
        // UPDATE 会重新向 __change_log 写一批新条目——如果先清 __change_log 再 UPDATE，
        // 清理就白做了。

        // 1. 找出所有装配了同步字段的业务表，将 sync_version 对齐到 local_version。
        //    这样恢复后的数据会被视为"当前设备上的已同步快照"，不会把备份里原有记录
        //    误判为新的本地修改再次推送。
        let mut table_stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type='table'
                   AND name NOT LIKE 'sqlite_%'
                   AND name NOT LIKE '\\_\\_%' ESCAPE '\\'",
            )
            .map_err(|e| SyncError::Database(format!("查询业务表失败: {}", e)))?;

        let table_names: Vec<String> = table_stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| SyncError::Database(format!("扫描业务表失败: {}", e)))?
            .filter_map(|r| r.ok())
            .collect();
        drop(table_stmt);

        let mut reset_count = 0usize;
        for table in table_names {
            // 仅处理同时具备 local_version / sync_version 的业务表。
            let col_names: Vec<String> = match conn.prepare(&format!(
                "SELECT name FROM pragma_table_info('{}')",
                table.replace('\'', "''")
            )) {
                Ok(mut stmt) => stmt
                    .query_map([], |row| row.get::<_, String>(0))
                    .map(|iter| iter.filter_map(|r| r.ok()).collect())
                    .unwrap_or_default(),
                Err(_) => continue,
            };

            let has_local_version = col_names.iter().any(|c| c == "local_version");
            let has_sync_version = col_names.iter().any(|c| c == "sync_version");
            if !has_local_version || !has_sync_version {
                continue;
            }

            // 安全引用表名（仅允许标识符字符，双重保险）
            if !table.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                continue;
            }

            let sql = format!(
                "UPDATE \"{}\" \
                 SET sync_version = local_version \
                 WHERE local_version IS NOT NULL \
                   AND (sync_version IS NULL OR sync_version != local_version)",
                table
            );
            match conn.execute(&sql, []) {
                Ok(n) => reset_count += n,
                Err(e) => {
                    tracing::warn!(
                        "[sync] Touch local_version 失败（表 {}，非致命）: {}",
                        table,
                        e
                    );
                }
            }
        }

        // 2. 截断 __change_log（此步必须在 UPDATE 业务表之后，
        //    否则 trg_upd 触发器会把 UPDATE 重新记录进来）
        let truncated = conn
            .execute("DELETE FROM __change_log", [])
            .map_err(|e| SyncError::Database(format!("清理变更日志失败: {}", e)))?;

        // 3. 清除未解决的冲突记录（若表存在）
        let _ = conn.execute("DELETE FROM __sync_conflicts", []);
        let _ = conn.execute("DELETE FROM __sync_id_aliases", []);

        tracing::info!(
            "[sync] reset_sync_baseline_after_restore: cleaned __change_log {} rows, touched {} business records for re-upload",
            truncated,
            reset_count
        );

        Ok((truncated, reset_count))
    }

    /// 应用合并策略
    ///
    /// 根据指定的合并策略处理本地和云端的冲突记录，决定保留哪一方的数据。
    ///
    /// # 参数
    /// * `strategy` - 合并策略
    /// * `conflicts` - 冲突记录列表
    ///
    /// # 返回
    /// * `MergeApplicationResult` - 合并应用结果，包含需要推送/拉取的记录列表
    pub fn apply_merge_strategy(
        strategy: MergeStrategy,
        conflicts: &[ConflictRecord],
    ) -> Result<MergeApplicationResult, SyncError> {
        let mut kept_local = 0;
        let mut used_cloud = 0;
        let mut records_to_push = Vec::new();
        let mut records_to_pull = Vec::new();
        let mut errors = Vec::new();

        for conflict in conflicts {
            match strategy {
                MergeStrategy::KeepLocal => {
                    // 保留本地数据，需要将本地数据推送到云端
                    records_to_push.push(conflict.record_id.clone());
                    kept_local += 1;
                }
                MergeStrategy::UseCloud => {
                    // 使用云端数据，需要从云端拉取数据到本地
                    records_to_pull.push(conflict.record_id.clone());
                    used_cloud += 1;
                }
                MergeStrategy::KeepLatest => {
                    // 比较更新时间，保留最新的
                    let local_content =
                        serde_json::to_string(&conflict.local_data).unwrap_or_default();
                    let cloud_content =
                        serde_json::to_string(&conflict.cloud_data).unwrap_or_default();
                    let (local_dev, cloud_dev) = Self::lww_device_pair(
                        &conflict.local_data,
                        Some(&conflict.cloud_data),
                        None,
                    );
                    match Self::compare_lww_timestamps(
                        &conflict.local_updated_at,
                        local_dev,
                        &local_content,
                        &conflict.cloud_updated_at,
                        cloud_dev,
                        &cloud_content,
                    ) {
                        std::cmp::Ordering::Greater | std::cmp::Ordering::Equal => {
                            // 本地更新或相同，推送到云端
                            records_to_push.push(conflict.record_id.clone());
                            kept_local += 1;
                        }
                        std::cmp::Ordering::Less => {
                            // 云端更新，从云端拉取
                            records_to_pull.push(conflict.record_id.clone());
                            used_cloud += 1;
                        }
                    }
                }
                MergeStrategy::Manual => {
                    // 手动模式不自动处理，记录错误
                    errors.push(format!("记录 {} 需要手动处理", conflict.record_id));
                }
            }
        }

        if !errors.is_empty() && strategy == MergeStrategy::Manual {
            return Err(SyncError::ManualResolutionRequired {
                count: errors.len(),
            });
        }

        let mut result = MergeApplicationResult::success(kept_local, used_cloud);
        result.records_to_push = records_to_push;
        result.records_to_pull = records_to_pull;

        Ok(result)
    }

    fn compare_timestamps(local: &str, cloud: &str) -> std::cmp::Ordering {
        // 设备分量使用相同的中性值：纯时间戳比较的平局必须返回 Equal，
        // 而不是被评估方视角的常量（'l' > 'c'）扭曲成"本地恒胜"。
        Self::compare_lww_timestamps(local, "", "", cloud, "", "")
    }

    /// 灵活解析时间戳，兼容 RFC 3339 和 SQLite datetime('now') 格式
    fn parse_flexible_timestamp(s: &str) -> Option<chrono::DateTime<chrono::Utc>> {
        use chrono::{DateTime, NaiveDateTime, Utc};
        if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
            return Some(dt.with_timezone(&Utc));
        }
        if let Ok(naive) = NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S") {
            return Some(naive.and_utc());
        }
        if let Ok(naive) = NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S") {
            return Some(naive.and_utc());
        }
        None
    }

    fn canonical_lww_key(
        timestamp: &str,
        device_id: &str,
        content_tiebreaker: &str,
    ) -> (i64, u32, String, String) {
        if let Some(hlc) = hlc::Hlc::parse(timestamp) {
            let millis = i64::try_from(hlc.millis).unwrap_or(i64::MAX);
            return (
                millis,
                hlc.counter.into(),
                device_id.to_string(),
                content_tiebreaker.to_string(),
            );
        }

        let millis = parse_flexible_timestamp_public(timestamp)
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(i64::MIN);

        (
            millis,
            0,
            device_id.to_string(),
            if millis == i64::MIN {
                format!("{}|{}", timestamp, content_tiebreaker)
            } else {
                content_tiebreaker.to_string()
            },
        )
    }

    pub(crate) fn compare_lww_timestamps(
        local_timestamp: &str,
        local_device_id: &str,
        local_content_tiebreaker: &str,
        cloud_timestamp: &str,
        cloud_device_id: &str,
        cloud_content_tiebreaker: &str,
    ) -> std::cmp::Ordering {
        let local_key =
            Self::canonical_lww_key(local_timestamp, local_device_id, local_content_tiebreaker);
        let cloud_key =
            Self::canonical_lww_key(cloud_timestamp, cloud_device_id, cloud_content_tiebreaker);
        local_key.cmp(&cloud_key)
    }

    pub(crate) fn timestamp_value_to_lww_string(value: &serde_json::Value) -> Option<String> {
        match value {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Number(n) => Some(n.to_string()),
            _ => None,
        }
    }

    /// [P0 收敛性] 计算 LWW 平局比较使用的设备分量对 (local, cloud)。
    ///
    /// 设备分量必须是"数据的属性"（写入者 ID），绝不能是"评估方的属性"。
    /// 旧实现用 "local-unknown" / "cloud-unknown" 这类评估方视角的常量，
    /// 时间戳平局时每台设备都判"本地"获胜（'l' > 'c'），两台设备得出相反
    /// 结论，永不收敛。修复：仅当双方写入者都可知时才用真实 device_id；
    /// 任一侧未知则双方退化为相同的中性值，让平局交给内容 tiebreaker
    /// （内容随数据传播，所有设备可见一致）决定，保证全设备同判。
    pub(crate) fn lww_device_pair<'a>(
        local_data: &'a serde_json::Value,
        cloud_data: Option<&'a serde_json::Value>,
        cloud_device_hint: Option<&'a str>,
    ) -> (&'a str, &'a str) {
        let local = local_data
            .get("device_id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty());
        let cloud = cloud_device_hint
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                cloud_data
                    .and_then(|d| d.get("device_id"))
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.trim().is_empty())
            });
        match (local, cloud) {
            (Some(l), Some(c)) => (l, c),
            _ => ("", ""),
        }
    }

    pub(crate) fn lww_timestamp_millis(timestamp: &str) -> Option<i64> {
        if let Some(hlc) = hlc::Hlc::parse(timestamp) {
            return i64::try_from(hlc.millis).ok();
        }
        parse_flexible_timestamp_public(timestamp).map(|dt| dt.timestamp_millis())
    }

    /// 获取指定表的 UPSERT 冲突目标子句（不含 DO UPDATE SET 部分）。
    ///
    /// 用于处理业务唯一键冲突。当一张表除了主键 `id` 之外还有额外的 UNIQUE 约束
    /// （如 `resources.hash`、`review_plans.question_id`、`files.sha256`、
    /// `folder_items(folder_id,item_type,item_id)`），需使用对应的冲突目标来正确合并数据，
    /// 而非在插入新 `id` 时遭遇 UNIQUE 约束违反。

    /// 生成业务键冲突时的回落 UPSERT SQL。
    ///
    /// 当主 UPSERT（基于 id 或业务唯一键）因 UNIQUE 约束违反失败时，
    /// 根据表类型构造替代冲突目标的 UPSERT，确保数据正确合并：
    /// - `review_plans`：从 question_id 回落至 id
    /// - `resources`：从 id 回落至 hash（合并相同内容记录）
    /// - `files`：从 id 回落至 sha256
    /// - `folder_items`：从 id 回落至 (folder_id, item_type, item_id)
    fn registry_business_unique_columns(
        database_name: Option<&str>,
        table_name: &str,
    ) -> Vec<String> {
        if let Some(database) = database_name {
            return classification::TableClassification::get_business_unique_keys(
                database, table_name,
            );
        }

        let mut distinct = classification::sync_classification_registry()
            .into_iter()
            .filter(|c| c.table_name == table_name)
            .filter(|c| !c.business_unique_keys.trim().is_empty())
            .map(|c| c.business_unique_keys.trim().to_string())
            .collect::<Vec<_>>();
        distinct.sort();
        distinct.dedup();

        if distinct.len() == 1 {
            distinct[0]
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        } else {
            Vec::new()
        }
    }

    fn unique_index_column_groups(
        conn: &Connection,
        table_name: &str,
    ) -> Result<Vec<Vec<String>>, SyncError> {
        Self::ensure_table_allowed_and_exists(conn, table_name)?;
        let table_ident = Self::quote_identifier(table_name)?;
        let sql = format!("PRAGMA index_list({})", table_ident);
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| SyncError::Database(format!("查询唯一索引失败: {}", e)))?;

        let index_names: Vec<String> = stmt
            .query_map([], |row| {
                let name: String = row.get(1)?;
                let unique: i64 = row.get(2)?;
                Ok((name, unique))
            })
            .map_err(|e| SyncError::Database(format!("读取唯一索引失败: {}", e)))?
            .filter_map(log_and_skip_err)
            .filter_map(|(name, unique)| if unique != 0 { Some(name) } else { None })
            .collect();

        let mut groups = Vec::new();
        for index_name in index_names {
            let index_ident = Self::quote_identifier(&index_name)?;
            let index_sql = format!("PRAGMA index_info({})", index_ident);
            let mut index_stmt = conn
                .prepare(&index_sql)
                .map_err(|e| SyncError::Database(format!("查询唯一索引列失败: {}", e)))?;
            let cols: Vec<String> = index_stmt
                .query_map([], |row| {
                    let cid: i64 = row.get(1)?;
                    let name: Option<String> = row.get(2)?;
                    Ok((cid, name))
                })
                .map_err(|e| SyncError::Database(format!("读取唯一索引列失败: {}", e)))?
                .filter_map(log_and_skip_err)
                .filter_map(|(cid, name)| if cid >= 0 { name } else { None })
                .collect();
            if !cols.is_empty() && !groups.iter().any(|g| g == &cols) {
                groups.push(cols);
            }
        }

        Ok(groups)
    }

    fn business_unique_key_groups(
        conn: &Connection,
        database_name: Option<&str>,
        table_name: &str,
    ) -> Result<Vec<Vec<String>>, SyncError> {
        let registered = Self::registry_business_unique_columns(database_name, table_name);
        if registered.is_empty() {
            return Ok(Vec::new());
        }

        let registered_set: HashSet<&str> = registered.iter().map(|s| s.as_str()).collect();

        let mut groups: Vec<Vec<String>> = Self::unique_index_column_groups(conn, table_name)?
            .into_iter()
            .filter(|cols| cols.iter().all(|c| registered_set.contains(c.as_str())))
            .collect();

        groups.sort();
        groups.dedup();
        Ok(groups)
    }

    fn get_fallback_upsert_sql(
        conn: &Connection,
        database_name: Option<&str>,
        table_name: &str,
        table_ident: &str,
        columns: &str,
        placeholders: &str,
        columns_list: &[&str],
        pk_columns: &[String],
    ) -> Result<String, SyncError> {
        let business_key_groups =
            Self::business_unique_key_groups(conn, database_name, table_name)?;
        if business_key_groups.is_empty() {
            return Err(SyncError::Database(format!(
                "表 {} 没有已注册且可验证的业务唯一键，id 冲突需要人工处理",
                table_name
            )));
        }

        let _business_key_groups = business_key_groups;
        let mut protected_cols: HashSet<String> = HashSet::new();
        for pk in pk_columns {
            protected_cols.insert(pk.to_string());
        }

        let update_set = columns_list
            .iter()
            .filter(|c| {
                let raw = c.trim_matches('"').replace("\"\"", "\"");
                !protected_cols.contains(&raw)
            })
            .map(|c| {
                let quoted = (*c).to_string();
                format!("{}=excluded.{}", quoted, quoted)
            })
            .collect::<Vec<_>>()
            .join(", ");

        let action = if update_set.is_empty() {
            "DO NOTHING".to_string()
        } else {
            format!("DO UPDATE SET {}", update_set)
        };

        Ok(format!(
            "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT {}",
            table_ident, columns, placeholders, action
        ))
    }

    /// 应用单条记录到数据库
    ///
    /// 使用标准 UPSERT (`ON CONFLICT DO UPDATE`) 策略处理更新。
    /// 相比 `REPLACE`，它不会触发 DELETE 触发器，也不会改变 rowid，更加安全。
    ///
    /// ## NULL 字段语义
    ///
    /// - **payload 中出现的 null 字段**：作为 SQL NULL 写入（UPSERT `SET col = excluded.col`），
    ///   表示远端明确清空该列（[D11.1] 已弃用 COALESCE，否则置空无法跨设备传播）。
    ///   payload 中**未出现**的列不进入 UPSERT 列集，因而保留本地已有值——
    ///   这保护了"云端因 schema 差异或序列化缺字段"场景下本地数据不被误清。
    /// - **`deleted_at` 的显式 null**：表示"复活一条软删除记录"的明确意图，
    ///   在 UPSERT 之后再执行一条独立 `UPDATE SET deleted_at = NULL` 兜底。
    ///   这对应 scenarios_tests 中"Delete 后又 Insert 同 id" 的幂等性需求。

    /// 返回某表需要字段级合并的列清单（在 UPSERT 之前抓取原始本地值用）。
    /// 仅在本地行原先就存在时调用（INSERT 新行没有"原始本地值"这一说）。
    fn field_merge_column_picklist(table_name: &str) -> Vec<&'static str> {
        field_merge::field_merge_columns_for_table(table_name)
    }

    /// 应用单条下载变更到本地数据库。
    fn apply_single_record(
        conn: &Connection,
        table_name: &str,
        record_id: &str,
        data: &serde_json::Value,
        database_name: Option<&str>,
        allow_field_merge: bool,
    ) -> Result<(), SyncError> {
        Self::ensure_table_allowed_and_exists_for(conn, database_name, table_name)?;

        let table_ident = Self::quote_identifier(table_name)?;

        let mut obj = data
            .as_object()
            .ok_or_else(|| {
                SyncError::Database(format!("记录数据不是有效的 JSON 对象: {}", record_id))
            })?
            .clone();

        let field_deltas = match obj.remove(SYNC_FIELD_DELTAS_KEY) {
            Some(serde_json::Value::Object(map)) => Some(map),
            Some(serde_json::Value::Null) | None => None,
            Some(other) => {
                return Err(SyncError::Database(format!(
                    "字段增量元数据格式错误: {} = {}",
                    SYNC_FIELD_DELTAS_KEY, other
                )));
            }
        };

        if obj.is_empty() {
            return Err(SyncError::Database(format!("记录数据为空: {}", record_id)));
        }

        // deleted_at 的显式 null 是"复活意图"；其他 null 字段也会作为 SQL NULL 写入，
        // 因为 payload 中出现的 null 表示远端明确清空该列。
        let revive_record = matches!(obj.get("deleted_at"), Some(serde_json::Value::Null))
            && Self::table_has_column(conn, table_name, "deleted_at");

        let pk_columns = Self::primary_key_columns(conn, table_name)?;
        let pk_values = Self::parse_record_key_values(table_name, record_id, &pk_columns)?;
        let pk_predicate = Self::build_primary_key_predicate(&pk_columns)?;

        // [安全校验] payload 里的主键必须与 record_id 一致，避免恶意或损坏的 change
        // 用不匹配的 payload 覆盖另一条记录。
        let payload_key_values: Option<Vec<String>> = if pk_columns.len() == 1 {
            obj.get(&pk_columns[0]).map(|value| {
                vec![Self::json_value_to_alias_key(value).unwrap_or_else(|| value.to_string())]
            })
        } else if pk_columns.iter().all(|col| obj.contains_key(col)) {
            let mut values = Vec::with_capacity(pk_columns.len());
            for col in &pk_columns {
                let value = obj.get(col).expect("checked contains_key above");
                values.push(
                    Self::json_value_to_alias_key(value).unwrap_or_else(|| value.to_string()),
                );
            }
            Some(values)
        } else {
            None
        };
        if let Some(payload_values) = payload_key_values {
            if payload_values != pk_values {
                return Err(SyncError::Database(format!(
                    "payload 主键不一致: record_id='{}', payload_pk='{}'。这可能是云端数据损坏或重放攻击，已拒绝。",
                    record_id,
                    payload_values.join(":")
                )));
            }
        }

        let (columns, placeholders, values) = Self::build_insert_parts(&obj)?;
        let columns_list: Vec<&str> = columns.split(", ").collect();

        // 字段级合并准备：在 UPSERT 改写本地值之前，先读取字段级合并列的“原始本地值”。
        // 否则 UPSERT 的 `SET col = excluded.col` 会把远端值直接写进本地，local_val 读取到的
        // 就是“刚被改写后的值”（即 == remote_val），merge_field 永远检测不到冲突。
        let local_before: std::collections::HashMap<String, serde_json::Value> = {
            let picklist = Self::field_merge_column_picklist(table_name);
            let picklist: Vec<&'static str> = picklist
                .into_iter()
                .filter(|_| allow_field_merge)
                .filter(|col| Self::table_has_column(conn, table_name, col))
                .collect();
            let mut m = std::collections::HashMap::new();
            if picklist.is_empty() {
                m
            } else {
                let cols_sql: Vec<String> = picklist
                    .iter()
                    .map(|c| Self::quote_identifier(c))
                    .collect::<Result<Vec<_>, _>>()?;
                let read_sql = format!(
                    "SELECT {} FROM {} WHERE {}",
                    cols_sql.join(","),
                    table_ident,
                    pk_predicate
                );
                if let Ok(mut stmt) = conn.prepare(&read_sql) {
                    let params_refs: Vec<&dyn rusqlite::ToSql> = pk_values
                        .iter()
                        .map(|v| v as &dyn rusqlite::ToSql)
                        .collect();
                    if let Ok(Some(row)) = stmt
                        .query_row(params_refs.as_slice(), |row| -> rusqlite::Result<_> {
                            let mut map = std::collections::HashMap::new();
                            for (i, col) in picklist.iter().enumerate() {
                                map.insert(col.to_string(), Self::sqlite_value_to_json(row, i));
                            }
                            Ok(map)
                        })
                        .optional()
                    {
                        m = row;
                    }
                }
                m
            }
        };

        let upsert_sql = if table_name == "review_plans" {
            let pk_ident = Self::quote_identifier("id")?;
            let update_set = columns_list
                .iter()
                .filter(|c| **c != pk_ident.as_str())
                .map(|c| format!("{}=excluded.{}", c, c))
                .collect::<Vec<_>>()
                .join(", ");
            let action = if update_set.is_empty() {
                "DO NOTHING".to_string()
            } else {
                format!("DO UPDATE SET {}", update_set)
            };
            format!(
                "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT(question_id) WHERE question_id IS NOT NULL {}",
                table_ident, columns, placeholders, action
            )
        } else if table_name == "resources" {
            let pk_ident = Self::quote_identifier("id")?;
            let update_set = columns_list
                .iter()
                .filter(|c| **c != pk_ident.as_str())
                .map(|c| format!("{}=excluded.{}", c, c))
                .collect::<Vec<_>>()
                .join(", ");
            let action = if update_set.is_empty() {
                "DO NOTHING".to_string()
            } else {
                format!("DO UPDATE SET {}", update_set)
            };
            format!(
                "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT(id) {}",
                table_ident, columns, placeholders, action
            )
        } else if table_name == "folder_items" {
            let pk_ident = Self::quote_identifier("id")?;
            let update_set = columns_list
                .iter()
                .filter(|c| **c != pk_ident.as_str())
                .map(|c| format!("{}=excluded.{}", c, c))
                .collect::<Vec<_>>()
                .join(", ");
            let action = if update_set.is_empty() {
                "DO NOTHING".to_string()
            } else {
                format!("DO UPDATE SET {}", update_set)
            };
            format!(
                "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT(folder_id, item_type, item_id) WHERE deleted_at IS NULL {}",
                table_ident, columns, placeholders, action
            )
        } else {
            let pk_ident_list = pk_columns
                .iter()
                .map(|c| Self::quote_identifier(c))
                .collect::<Result<Vec<_>, _>>()?;
            let update_set = columns_list
                .iter()
                .filter(|c| {
                    let raw = c.trim_matches('"').replace("\"\"", "\"");
                    !pk_columns.iter().any(|pk| pk == &raw)
                })
                .map(|c| format!("{}=excluded.{}", c, c))
                .collect::<Vec<_>>()
                .join(", ");

            let action = if update_set.is_empty() {
                "DO NOTHING".to_string()
            } else {
                format!("DO UPDATE SET {}", update_set)
            };

            format!(
                "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT({}) {}",
                table_ident,
                columns,
                placeholders,
                pk_ident_list.join(", "),
                action
            )
        };

        let params_refs: Vec<&dyn rusqlite::ToSql> = values.iter().map(|v| v.as_ref()).collect();
        match conn.execute(&upsert_sql, params_refs.as_slice()) {
            Ok(_) => {}
            Err(e) => {
                let err_msg = e.to_string();
                if !err_msg.contains("UNIQUE constraint failed") {
                    return Err(SyncError::Database(format!(
                        "UPSERT (OnConflict) 记录失败: {}",
                        e
                    )));
                }

                let fallback_sql = Self::get_fallback_upsert_sql(
                    conn,
                    database_name,
                    table_name,
                    &table_ident,
                    &columns,
                    &placeholders,
                    &columns_list,
                    &pk_columns,
                )?;

                conn.execute("SAVEPOINT sp_upsert_fallback", [])
                    .map_err(|e| SyncError::Database(format!("创建 SAVEPOINT 失败: {}", e)))?;
                match conn.execute(&fallback_sql, params_refs.as_slice()) {
                    Ok(_) => {
                        conn.execute("RELEASE SAVEPOINT sp_upsert_fallback", [])
                            .map_err(|e| {
                                SyncError::Database(format!("释放 SAVEPOINT 失败: {}", e))
                            })?;
                    }
                    Err(e2) => {
                        let _ = conn.execute("ROLLBACK TO SAVEPOINT sp_upsert_fallback", []);
                        let _ = conn.execute("RELEASE SAVEPOINT sp_upsert_fallback", []);
                        return Err(SyncError::Database(format!(
                            "UPSERT (业务键回落) 记录失败: {}",
                            e2
                        )));
                    }
                }
            }
        }

        // 复活意图：清空 deleted_at
        //
        // **优化**：只在本地 deleted_at 实际非 NULL 时才运行 UPDATE。
        // 否则 trg_upd 触发器会产生无谓的 __change_log 条目（虽被回声抑制但仍污染日志表）。
        if revive_record {
            let null_sql = format!(
                "UPDATE {} SET \"deleted_at\" = NULL WHERE {} AND \"deleted_at\" IS NOT NULL",
                table_ident, pk_predicate
            );
            let pk_params: Vec<&dyn rusqlite::ToSql> = pk_values
                .iter()
                .map(|v| v as &dyn rusqlite::ToSql)
                .collect();
            conn.execute(&null_sql, pk_params.as_slice())
                .map_err(|e| SyncError::Database(format!("复活软删记录失败: {}", e)))?;
        }

        // 字段级合并策略（在 UPSERT 之后、使用 UPSERT 前保存的原始本地值）
        // UPSERT（`SET col = excluded.col`）已经把远端有值的列写入了本地。此步骤用 UPSERT
        // 之前抓取的本地值 (local_before) 与远端值做 domain-aware 合并，弥补行级覆盖无法
        // 表达的计数器、标签合集、布尔 OR 等可交换语义。
        if !local_before.is_empty() {
            for (col_name, original_local) in &local_before {
                let remote_val = match obj.get(col_name.as_str()) {
                    Some(v) if !v.is_null() => v,
                    _ => continue,
                };
                let (merged_val, was_merged, _conflict) =
                    if let Some(deltas) = field_deltas.as_ref() {
                        if field_merge::supports_counter_delta(table_name, col_name) {
                            if let Some(delta_value) = deltas.get(col_name) {
                                let local_count = original_local.as_i64().ok_or_else(|| {
                                    SyncError::Database(format!(
                                        "counter 字段不是整数: {}.{} = {}",
                                        table_name, col_name, original_local
                                    ))
                                })?;
                                let delta = delta_value.as_i64().ok_or_else(|| {
                                    SyncError::Database(format!(
                                        "counter delta 不是整数: {}.{} = {}",
                                        table_name, col_name, delta_value
                                    ))
                                })?;
                                let merged = local_count.saturating_add(delta).max(0);
                                (serde_json::Value::Number(merged.into()), delta != 0, false)
                            } else {
                                field_merge::merge_field(
                                    table_name,
                                    col_name,
                                    Some(original_local),
                                    Some(remote_val),
                                )
                            }
                        } else {
                            field_merge::merge_field(
                                table_name,
                                col_name,
                                Some(original_local),
                                Some(remote_val),
                            )
                        }
                    } else {
                        field_merge::merge_field(
                            table_name,
                            col_name,
                            Some(original_local),
                            Some(remote_val),
                        )
                    };

                if was_merged {
                    let merge_pk_predicate =
                        Self::build_primary_key_predicate_from(&pk_columns, 2)?;
                    let col_ident = Self::quote_identifier(col_name)?;
                    let merge_sql = format!(
                        "UPDATE {} SET {} = ?1 WHERE {}",
                        table_ident, col_ident, merge_pk_predicate
                    );
                    let Some(sql_value) = Self::json_value_to_sql_param(&merged_val) else {
                        continue;
                    };
                    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![sql_value];
                    for value in &pk_values {
                        params_vec.push(Box::new(value.clone()));
                    }
                    let params_refs: Vec<&dyn rusqlite::ToSql> =
                        params_vec.iter().map(|v| v.as_ref()).collect();
                    let affected =
                        conn.execute(&merge_sql, params_refs.as_slice())
                            .map_err(|e| {
                                SyncError::Database(format!(
                                    "字段级合并写入失败: {}.{} {}",
                                    table_name, col_name, e
                                ))
                            })?;
                    if affected == 0 {
                        return Err(SyncError::Database(format!(
                            "字段级合并未命中目标记录: {}.{} record_id={}",
                            table_name, col_name, record_id
                        )));
                    }
                }
            }
        }

        Ok(())
    }

    /// 从 JSON 对象构建 INSERT 语句的各部分
    ///
    /// # 返回
    /// * `(列名列表, 占位符列表, 参数值列表)`
    ///
    /// ## NULL 处理
    /// payload 中出现的 JSON `null` 是显式清空字段的同步意图，必须写入 SQL NULL。
    /// payload 中缺失的列不会进入 INSERT/UPSERT 列表，因此会自然保留本地值。
    fn build_insert_parts(
        obj: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(String, String, Vec<Box<dyn rusqlite::ToSql>>), SyncError> {
        let mut columns = Vec::new();
        let mut placeholders = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        for (idx, (key, value)) in obj.iter().enumerate() {
            let idx = idx + 1;
            columns.push(Self::quote_identifier(key)?);
            placeholders.push(format!("?{}", idx));

            let sql_value = Self::json_value_to_sql_param(value).ok_or_else(|| {
                SyncError::Database(format!("字段 {} 的 JSON 值无法转换为 SQLite 参数", key))
            })?;
            values.push(sql_value);
        }

        Ok((columns.join(", "), placeholders.join(", "), values))
    }

    /// 将不可信的表名/列名安全地用于 SQL（标识符引用）
    ///
    /// - 使用双引号引用标识符，并对内部 `"` 做转义（`""`）
    /// - 拒绝空标识符与包含 `\0` 的输入
    fn quote_identifier(identifier: &str) -> Result<String, SyncError> {
        let ident = identifier.trim();
        if ident.is_empty() {
            return Err(SyncError::Database("SQL 标识符不能为空".to_string()));
        }
        if ident.contains('\0') {
            return Err(SyncError::Database("SQL 标识符包含非法字符".to_string()));
        }
        Ok(format!("\"{}\"", ident.replace('"', "\"\"")))
    }

    /// 防御性约束：仅允许对“业务表”应用下载变更
    ///
    /// - 拒绝 `sqlite_*` 系统表
    /// - 拒绝 `__*` 内部元数据表（如 __change_log）
    /// - 要求表在本地数据库中存在
    fn ensure_table_allowed_and_exists(
        conn: &Connection,
        table_name: &str,
    ) -> Result<(), SyncError> {
        Self::ensure_table_allowed_and_exists_for(conn, None, table_name)
    }

    fn ensure_table_allowed_and_exists_for(
        conn: &Connection,
        database_name: Option<&str>,
        table_name: &str,
    ) -> Result<(), SyncError> {
        let t = table_name.trim();
        if t.starts_with("sqlite_") {
            return Err(SyncError::Database(format!(
                "禁止同步到系统表: {}",
                table_name
            )));
        }
        if t.starts_with("__") {
            return Err(SyncError::Database(format!(
                "禁止同步到内部元数据表: {}",
                table_name
            )));
        }

        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                params![t],
                |row| row.get(0),
            )
            .map_err(|e| SyncError::Database(format!("检查表是否存在失败: {}", e)))?;

        if !exists {
            return Err(SyncError::Database(format!("目标表不存在: {}", table_name)));
        }

        #[cfg(test)]
        if t.starts_with("test_") || t.ends_with("_records") || t == "resource_notes" {
            return Ok(());
        }
        // 集成测试（tests/sync_*）以非 cfg(test) 方式编译本库，其 fixture 表
        // （items/weird/a/b/big 等）需要放行。仅在 debug 构建生效：release
        // 构建保持 fail-close，防止未注册的真实业务表借同名 + id/updated_at
        // 形状绕过 RowSync 白名单校验。
        if cfg!(debug_assertions) && Self::looks_like_sync_test_fixture_table(conn, t) {
            return Ok(());
        }

        let is_row_sync = classification::sync_classification_registry()
            .into_iter()
            .any(|entry| {
                entry.table_name == t
                    && entry.category == SyncCategory::RowSync
                    && database_name.map_or(true, |db| entry.database == db)
            });

        if !is_row_sync {
            let scope = database_name.unwrap_or("*");
            return Err(SyncError::Database(format!(
                "禁止同步未注册为 RowSync 的表: {}.{}",
                scope, table_name
            )));
        }

        Ok(())
    }

    fn looks_like_sync_test_fixture_table(conn: &Connection, table_name: &str) -> bool {
        if !matches!(table_name, "items" | "notes" | "weird" | "a" | "b" | "big") {
            return false;
        }

        let table_ident = match Self::quote_identifier(table_name) {
            Ok(table_ident) => table_ident,
            Err(_) => return false,
        };
        let pragma = format!("PRAGMA table_info({})", table_ident);
        let mut stmt = match conn.prepare(&pragma) {
            Ok(stmt) => stmt,
            Err(_) => return false,
        };
        let mut rows = match stmt.query([]) {
            Ok(rows) => rows,
            Err(_) => return false,
        };
        let mut has_id = false;
        let mut has_updated_at = false;
        while let Ok(Some(row)) = rows.next() {
            let name = row.get::<_, String>(1).unwrap_or_default();
            has_id |= name == "id";
            has_updated_at |= name == "updated_at";
        }
        has_id && has_updated_at
    }

    fn collect_foreign_key_violations(
        conn: &Connection,
        limit: usize,
    ) -> Result<Vec<String>, SyncError> {
        let mut stmt = conn
            .prepare("PRAGMA foreign_key_check")
            .map_err(|e| SyncError::Database(format!("准备 foreign_key_check 失败: {}", e)))?;

        let rows = stmt
            .query_map([], |row| {
                let table: String = row.get(0)?;
                let rowid: rusqlite::types::Value = row.get(1)?;
                let parent: String = row.get(2)?;
                let fkid: rusqlite::types::Value = row.get(3)?;
                Ok(format!(
                    "table={}, rowid={:?}, parent={}, fkid={:?}",
                    table, rowid, parent, fkid
                ))
            })
            .map_err(|e| SyncError::Database(format!("执行 foreign_key_check 失败: {}", e)))?;

        let mut violations = Vec::new();
        for (idx, r) in rows.enumerate() {
            if idx >= limit {
                break;
            }
            violations
                .push(r.map_err(|e| SyncError::Database(format!("读取外键检查结果失败: {}", e)))?);
        }
        Ok(violations)
    }

    /// 收集指定表集合的外键违规（作用域化）。
    ///
    /// [PERF-1] 此前对**整库**执行 `PRAGMA foreign_key_check`，并在每条变更后重复一次，
    /// 大批量同步 = N+1 次全库扫描。改为仅检查本批触碰的表及其子表（见
    /// `fk_batch_check_tables`/`build_fk_child_map`），单次扫描成本与批次相关而非与库规模相关。
    /// 正确性不变：任何一条变更只可能在「它写入的表」或「引用它的子表」上引入新违规，
    /// 二者都包含在传入的 `tables` 中。
    fn collect_foreign_key_violation_set(
        conn: &Connection,
        tables: &[String],
    ) -> Result<ForeignKeyViolationSet, SyncError> {
        let mut violations = ForeignKeyViolationSet::new();
        for table in tables {
            let ident = match Self::quote_identifier(table) {
                Ok(id) => id,
                Err(_) => continue,
            };
            let sql = format!("PRAGMA foreign_key_check({})", ident);
            let mut stmt = match conn.prepare(&sql) {
                Ok(stmt) => stmt,
                // 表不存在（legacy / 子表尚未建）等：跳过，等同无违规
                Err(_) => continue,
            };
            let rows = stmt
                .query_map([], |row| {
                    let table: String = row.get(0)?;
                    let rowid: rusqlite::types::Value = row.get(1)?;
                    let parent: String = row.get(2)?;
                    let fkid: rusqlite::types::Value = row.get(3)?;
                    Ok(format!(
                        "table={}, rowid={:?}, parent={}, fkid={:?}",
                        table, rowid, parent, fkid
                    ))
                })
                .map_err(|e| SyncError::Database(format!("执行 foreign_key_check 失败: {}", e)))?;
            for row in rows {
                violations.insert(
                    row.map_err(|e| SyncError::Database(format!("读取外键检查结果失败: {}", e)))?,
                );
            }
        }
        Ok(violations)
    }

    /// 构建 parent_table -> [child_table...] 的反向外键依赖图（每次应用批构建一次）。
    ///
    /// 用于把「删除/改动某父表」可能波及的子表纳入外键检查作用域：删除父行后，
    /// 引用它的子表会出现悬挂外键，而 `PRAGMA foreign_key_check(child)` 才能查出。
    fn build_fk_child_map(conn: &Connection) -> Result<HashMap<String, Vec<String>>, SyncError> {
        let table_names: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
                )
                .map_err(|e| SyncError::Database(format!("列举表失败: {}", e)))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| SyncError::Database(format!("读取表名失败: {}", e)))?;
            rows.filter_map(|r| r.ok()).collect()
        };

        let mut map: HashMap<String, Vec<String>> = HashMap::new();
        for child in &table_names {
            let ident = match Self::quote_identifier(child) {
                Ok(id) => id,
                Err(_) => continue,
            };
            let sql = format!("PRAGMA foreign_key_list({})", ident);
            let mut stmt = match conn.prepare(&sql) {
                Ok(stmt) => stmt,
                Err(_) => continue,
            };
            // foreign_key_list 第 2 列（索引 2）是被引用的父表名
            let parents: Vec<String> = match stmt.query_map([], |row| row.get::<_, String>(2)) {
                Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
                Err(_) => continue,
            };
            for parent in parents {
                map.entry(parent).or_default().push(child.clone());
            }
        }
        Ok(map)
    }

    /// 计算本批应用需要纳入外键检查的表集合：每张被触碰的表 + 其全部子表。
    fn fk_batch_check_tables(
        changes: &[SyncChangeWithData],
        child_map: &HashMap<String, Vec<String>>,
    ) -> Vec<String> {
        let mut set: HashSet<String> = HashSet::new();
        for change in changes {
            set.insert(change.table_name.clone());
            if let Some(children) = child_map.get(&change.table_name) {
                for child in children {
                    set.insert(child.clone());
                }
            }
        }
        set.into_iter().collect()
    }

    fn foreign_key_columns(
        conn: &Connection,
        table_name: &str,
    ) -> Result<Vec<ForeignKeyColumn>, SyncError> {
        Self::ensure_table_allowed_and_exists(conn, table_name)?;
        let table_ident = Self::quote_identifier(table_name)?;
        let sql = format!("PRAGMA foreign_key_list({})", table_ident);
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| SyncError::Database(format!("查询外键失败: {}", e)))?;

        let mut columns: Vec<ForeignKeyColumn> = stmt
            .query_map([], |row| {
                Ok(ForeignKeyColumn {
                    parent_table: row.get(2)?,
                    child_column: row.get(3)?,
                    parent_column: row.get(4)?,
                })
            })
            .map_err(|e| SyncError::Database(format!("读取外键失败: {}", e)))?
            .filter_map(log_and_skip_err)
            .collect();

        // V20260709 shipped the FSRS relations as plain TEXT columns. ID alias
        // remapping is normally derived from PRAGMA foreign_key_list, so legacy
        // databases would otherwise keep review logs pointed at a losing
        // cross-device state UUID. Keep these logical relations explicit until
        // every supported database has physical foreign keys.
        let logical_relations: &[(&str, &str, &str)] = match table_name {
            "fsrs_card_states" => &[
                ("anki_card_id", "anki_cards", "id"),
                ("deck_id", "anki_decks", "id"),
            ],
            "fsrs_review_logs" => &[
                ("card_state_id", "fsrs_card_states", "id"),
                ("anki_card_id", "anki_cards", "id"),
            ],
            _ => &[],
        };
        let child_columns = Self::table_column_names(conn, table_name)?;
        for &(child_column, parent_table, parent_column) in logical_relations {
            if !child_columns.iter().any(|column| column == child_column)
                || Self::ensure_table_allowed_and_exists(conn, parent_table).is_err()
                || columns.iter().any(|fk| {
                    fk.child_column == child_column
                        && fk.parent_table == parent_table
                        && fk.parent_column == parent_column
                })
            {
                continue;
            }
            columns.push(ForeignKeyColumn {
                child_column: child_column.to_string(),
                parent_table: parent_table.to_string(),
                parent_column: parent_column.to_string(),
            });
        }

        Ok(columns)
    }

    fn primary_key_columns(conn: &Connection, table_name: &str) -> Result<Vec<String>, SyncError> {
        Self::ensure_table_allowed_and_exists(conn, table_name)?;
        let table_ident = Self::quote_identifier(table_name)?;
        let sql = format!("PRAGMA table_info({})", table_ident);
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| SyncError::Database(format!("查询主键列失败: {}", e)))?;

        let mut columns = stmt
            .query_map([], |row| {
                let name: String = row.get(1)?;
                let pk_order: i64 = row.get(5)?;
                Ok((pk_order, name))
            })
            .map_err(|e| SyncError::Database(format!("读取主键列失败: {}", e)))?
            .filter_map(log_and_skip_err)
            .filter(|(pk_order, _)| *pk_order > 0)
            .collect::<Vec<_>>();

        columns.sort_by_key(|(pk_order, _)| *pk_order);
        Ok(columns.into_iter().map(|(_, name)| name).collect())
    }

    fn json_value_to_alias_key(value: &serde_json::Value) -> Option<String> {
        match value {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Number(n) => Some(n.to_string()),
            serde_json::Value::Bool(b) => Some(b.to_string()),
            _ => None,
        }
    }

    fn json_value_to_sql_param(value: &serde_json::Value) -> Option<Box<dyn rusqlite::ToSql>> {
        match value {
            serde_json::Value::Null => Some(Box::new(rusqlite::types::Null)),
            serde_json::Value::Bool(b) => Some(Box::new(*b)),
            serde_json::Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    Some(Box::new(i))
                } else if let Some(u) = n.as_u64() {
                    if u <= i64::MAX as u64 {
                        Some(Box::new(u as i64))
                    } else {
                        None
                    }
                } else if let Some(f) = n.as_f64() {
                    Some(Box::new(f))
                } else {
                    None
                }
            }
            serde_json::Value::String(s) => Some(Box::new(s.clone())),
            serde_json::Value::Array(_) => Some(Box::new(serde_json::to_string(value).ok()?)),
            serde_json::Value::Object(obj) => {
                if obj.len() == 1 {
                    if let Some(serde_json::Value::String(encoded)) = obj.get("$dsblob") {
                        use base64::Engine;
                        let bytes = base64::engine::general_purpose::STANDARD
                            .decode(encoded)
                            .ok()?;
                        return Some(Box::new(bytes));
                    }
                }
                Some(Box::new(serde_json::to_string(value).ok()?))
            }
        }
    }

    fn resolve_alias(
        aliases: &IdAliasMap,
        table_name: &str,
        record_id: &str,
    ) -> Result<String, SyncError> {
        let mut current = record_id.to_string();
        let mut seen = HashSet::new();
        loop {
            if !seen.insert(current.clone()) {
                tracing::warn!(
                    "[sync] ID 别名存在循环，降级使用原始 record_id: {}.{}",
                    table_name,
                    record_id
                );
                return Ok(record_id.to_string());
            }
            match aliases.get(&(table_name.to_string(), current.clone())) {
                Some(next) => current = next.clone(),
                None => return Ok(current),
            }
        }
    }

    fn insert_alias(
        aliases: &mut IdAliasMap,
        table_name: &str,
        remote_id: &str,
        canonical_id: &str,
    ) -> Result<bool, SyncError> {
        if remote_id == canonical_id {
            return Ok(false);
        }

        let canonical_resolved = Self::resolve_alias(aliases, table_name, canonical_id)?;
        if canonical_resolved == remote_id {
            tracing::warn!(
                "[sync] 拒绝写入会形成循环的 ID 别名: {}.{} -> {}",
                table_name,
                remote_id,
                canonical_id
            );
            return Ok(false);
        }

        let key = (table_name.to_string(), remote_id.to_string());
        if let Some(existing) = aliases.get(&key) {
            if existing == &canonical_resolved {
                return Ok(false);
            }
            return Err(SyncError::Database(format!(
                "ID 别名冲突: {}.{} -> {} / {}",
                table_name, remote_id, existing, canonical_resolved
            )));
        }

        aliases.insert(key, canonical_resolved);
        Ok(true)
    }

    fn ensure_id_alias_table(conn: &Connection) -> Result<(), SyncError> {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS __sync_id_aliases (
                table_name TEXT NOT NULL,
                remote_id TEXT NOT NULL,
                canonical_id TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                PRIMARY KEY (table_name, remote_id)
            );
            CREATE INDEX IF NOT EXISTS idx__sync_id_aliases_canonical
                ON __sync_id_aliases(table_name, canonical_id);
            "#,
        )
        .map_err(|e| SyncError::Database(format!("创建 __sync_id_aliases 失败: {}", e)))
    }

    fn load_id_aliases(conn: &Connection) -> Result<IdAliasMap, SyncError> {
        Self::ensure_id_alias_table(conn)?;
        let mut stmt = conn
            .prepare("SELECT table_name, remote_id, canonical_id FROM __sync_id_aliases")
            .map_err(|e| SyncError::Database(format!("读取 __sync_id_aliases 失败: {}", e)))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| SyncError::Database(format!("扫描 __sync_id_aliases 失败: {}", e)))?;

        let mut aliases = IdAliasMap::new();
        for row in rows {
            let (table_name, remote_id, canonical_id) =
                row.map_err(|e| SyncError::Database(format!("读取 ID 别名失败: {}", e)))?;
            Self::insert_alias(&mut aliases, &table_name, &remote_id, &canonical_id)?;
        }
        Ok(aliases)
    }

    fn persist_id_aliases(conn: &Connection, aliases: &IdAliasMap) -> Result<(), SyncError> {
        Self::ensure_id_alias_table(conn)?;
        for ((table_name, remote_id), canonical_id) in aliases {
            conn.execute(
                "INSERT INTO __sync_id_aliases (table_name, remote_id, canonical_id)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(table_name, remote_id) DO UPDATE SET
                    canonical_id = excluded.canonical_id",
                params![table_name, remote_id, canonical_id],
            )
            .map_err(|e| SyncError::Database(format!("写入 ID 别名失败: {}", e)))?;
        }
        Ok(())
    }

    fn remap_foreign_keys_in_object(
        conn: &Connection,
        table_name: &str,
        obj: &mut serde_json::Map<String, serde_json::Value>,
        aliases: &IdAliasMap,
    ) -> Result<(), SyncError> {
        for fk in Self::foreign_key_columns(conn, table_name)? {
            let parent_pk = Self::primary_key_columns(conn, &fk.parent_table)?;
            if parent_pk.len() != 1 || parent_pk[0] != fk.parent_column {
                continue;
            }

            let current = match obj.get(&fk.child_column) {
                Some(value) => match Self::json_value_to_alias_key(value) {
                    Some(v) => v,
                    None => continue,
                },
                None => continue,
            };
            let canonical = Self::resolve_alias(aliases, &fk.parent_table, &current)?;
            if canonical != current {
                obj.insert(fk.child_column, serde_json::Value::String(canonical));
            }
        }
        Ok(())
    }

    fn find_canonical_id_by_business_key(
        conn: &Connection,
        database_name: Option<&str>,
        table_name: &str,
        id_column: &str,
        obj: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<Option<String>, SyncError> {
        let key_groups = Self::business_unique_key_groups(conn, database_name, table_name)?;
        if key_groups.is_empty() {
            return Ok(None);
        }

        let table_ident = Self::quote_identifier(table_name)?;
        let id_col_ident = Self::quote_identifier(id_column)?;

        for group in key_groups {
            let mut where_parts = Vec::new();
            let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            for col in &group {
                let value = match obj.get(col) {
                    Some(value) if !value.is_null() => value,
                    _ => {
                        values.clear();
                        break;
                    }
                };
                let Some(sql_value) = Self::json_value_to_sql_param(value) else {
                    values.clear();
                    break;
                };
                where_parts.push(format!("{} = ?", Self::quote_identifier(col)?));
                values.push(sql_value);
            }
            if values.len() != group.len() {
                continue;
            }

            let sql = format!(
                "SELECT {} FROM {} WHERE {} LIMIT 1",
                id_col_ident,
                table_ident,
                where_parts.join(" AND ")
            );
            let params_refs: Vec<&dyn rusqlite::ToSql> =
                values.iter().map(|v| v.as_ref()).collect();
            let canonical = conn
                .query_row(&sql, params_refs.as_slice(), |row| {
                    Ok(Self::json_value_to_alias_key(&Self::sqlite_value_to_json(
                        row, 0,
                    )))
                })
                .optional()
                .map_err(|e| SyncError::Database(format!("查询业务键 canonical id 失败: {}", e)))?
                .flatten();

            if canonical.is_some() {
                return Ok(canonical);
            }
        }

        Ok(None)
    }

    fn business_key_fingerprints(
        conn: &Connection,
        database_name: Option<&str>,
        table_name: &str,
        obj: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<Vec<String>, SyncError> {
        let key_groups = Self::business_unique_key_groups(conn, database_name, table_name)?;
        let mut fingerprints = Vec::new();

        for group in key_groups {
            let mut parts = Vec::with_capacity(group.len());
            let mut complete = true;
            for col in &group {
                let Some(value) = obj.get(col).filter(|value| !value.is_null()) else {
                    complete = false;
                    break;
                };
                let Some(key_value) = Self::json_value_to_alias_key(value) else {
                    complete = false;
                    break;
                };
                parts.push(format!("{}={}", col, key_value));
            }

            if complete && !parts.is_empty() {
                fingerprints.push(parts.join("\u{1f}"));
            }
        }

        Ok(fingerprints)
    }

    fn build_download_id_aliases(
        conn: &Connection,
        changes: &[SyncChangeWithData],
        id_column_map: Option<&HashMap<String, String>>,
    ) -> Result<IdAliasMap, SyncError> {
        let mut aliases = Self::load_id_aliases(conn)?;

        loop {
            let before = aliases.len();
            let mut batch_business_keys: HashMap<(String, String, String), String> = HashMap::new();
            for change in changes {
                if !matches!(
                    change.operation,
                    ChangeOperation::Insert | ChangeOperation::Update
                ) {
                    continue;
                }
                let Some(data) = &change.data else {
                    continue;
                };
                let Some(source_obj) = data.as_object() else {
                    continue;
                };

                if let Err(e) = Self::ensure_table_allowed_and_exists_for(
                    conn,
                    change.database_name.as_deref(),
                    &change.table_name,
                ) {
                    tracing::warn!(
                        "[sync] 构建 ID 别名时跳过不可同步表: {}.{} ({})",
                        change.database_name.as_deref().unwrap_or("*"),
                        change.table_name,
                        e
                    );
                    continue;
                }
                let id_column = id_column_map
                    .and_then(|m| m.get(&change.table_name))
                    .map(|s| s.as_str())
                    .unwrap_or("id");

                let mut obj = source_obj.clone();
                Self::remap_foreign_keys_in_object(conn, &change.table_name, &mut obj, &aliases)?;

                let scope = change.database_name.clone().unwrap_or_default();
                let remote_id =
                    Self::resolve_alias(&aliases, &change.table_name, &change.record_id)?;
                let fingerprints = Self::business_key_fingerprints(
                    conn,
                    change.database_name.as_deref(),
                    &change.table_name,
                    &obj,
                )?;

                if let Some(canonical_id) = Self::find_canonical_id_by_business_key(
                    conn,
                    change.database_name.as_deref(),
                    &change.table_name,
                    id_column,
                    &obj,
                )? {
                    Self::insert_alias(
                        &mut aliases,
                        &change.table_name,
                        &remote_id,
                        &canonical_id,
                    )?;
                    Self::insert_alias(
                        &mut aliases,
                        &change.table_name,
                        &change.record_id,
                        &canonical_id,
                    )?;

                    for fingerprint in fingerprints {
                        batch_business_keys.insert(
                            (scope.clone(), change.table_name.clone(), fingerprint),
                            canonical_id.clone(),
                        );
                    }
                    continue;
                }

                let mut matched_canonical: Option<String> = None;
                for fingerprint in &fingerprints {
                    let key = (
                        scope.clone(),
                        change.table_name.clone(),
                        fingerprint.clone(),
                    );
                    if let Some(existing_id) = batch_business_keys.get(&key) {
                        let canonical =
                            Self::resolve_alias(&aliases, &change.table_name, existing_id)?;
                        matched_canonical = Some(canonical);
                        break;
                    }
                }

                if let Some(canonical_id) = matched_canonical {
                    Self::insert_alias(
                        &mut aliases,
                        &change.table_name,
                        &remote_id,
                        &canonical_id,
                    )?;
                    Self::insert_alias(
                        &mut aliases,
                        &change.table_name,
                        &change.record_id,
                        &canonical_id,
                    )?;
                    for fingerprint in fingerprints {
                        batch_business_keys.insert(
                            (scope.clone(), change.table_name.clone(), fingerprint),
                            canonical_id.clone(),
                        );
                    }
                } else {
                    for fingerprint in fingerprints {
                        batch_business_keys.insert(
                            (scope.clone(), change.table_name.clone(), fingerprint),
                            remote_id.clone(),
                        );
                    }
                }
            }

            if aliases.len() == before {
                break;
            }
        }

        Ok(aliases)
    }

    fn remap_change_with_aliases(
        conn: &Connection,
        change: &SyncChangeWithData,
        id_column: &str,
        aliases: &IdAliasMap,
    ) -> Result<SyncChangeWithData, SyncError> {
        let mut remapped = change.clone();
        let canonical_record_id =
            Self::resolve_alias(aliases, &change.table_name, &change.record_id)?;

        if canonical_record_id != change.record_id {
            remapped.record_id = canonical_record_id.clone();
        }

        if let Some(serde_json::Value::Object(obj)) = remapped.data.as_mut() {
            if canonical_record_id != change.record_id && obj.contains_key(id_column) {
                obj.insert(
                    id_column.to_string(),
                    serde_json::Value::String(canonical_record_id),
                );
            }
            Self::remap_foreign_keys_in_object(conn, &change.table_name, obj, aliases)?;
        }

        Ok(remapped)
    }

    fn is_incomplete_upsert(change: &SyncChangeWithData) -> bool {
        matches!(
            change.operation,
            ChangeOperation::Insert | ChangeOperation::Update
        ) && change.data.is_none()
    }

    fn incomplete_upserts_shadowed_by_delete(
        changes: &[SyncChangeWithData],
    ) -> HashSet<(String, String)> {
        let deleted_keys: HashSet<(String, String)> = changes
            .iter()
            .filter(|change| change.operation == ChangeOperation::Delete)
            .map(|change| (change.table_name.clone(), change.record_id.clone()))
            .collect();

        changes
            .iter()
            .filter(|change| Self::is_incomplete_upsert(change))
            .map(|change| (change.table_name.clone(), change.record_id.clone()))
            .filter(|key| deleted_keys.contains(key))
            .collect()
    }

    fn should_skip_shadowed_incomplete_upsert(
        change: &SyncChangeWithData,
        shadowed_incomplete_upserts: &HashSet<(String, String)>,
    ) -> bool {
        Self::is_incomplete_upsert(change)
            && shadowed_incomplete_upserts
                .contains(&(change.table_name.clone(), change.record_id.clone()))
    }

    fn todo_parent_id(change: &SyncChangeWithData) -> Option<String> {
        if change.table_name != "todo_items"
            || !matches!(
                change.operation,
                ChangeOperation::Insert | ChangeOperation::Update
            )
        {
            return None;
        }

        change
            .data
            .as_ref()
            .and_then(|data| data.get("parent_id"))
            .and_then(|value| value.as_str())
            .filter(|parent_id| !parent_id.is_empty())
            .map(|parent_id| parent_id.to_string())
    }

    fn emit_dependency_ordered_change_index(
        index: usize,
        changes: &[SyncChangeWithData],
        todo_index_by_id: &HashMap<String, usize>,
        visiting: &mut HashSet<usize>,
        emitted: &mut HashSet<usize>,
        ordered: &mut Vec<usize>,
    ) {
        if emitted.contains(&index) {
            return;
        }

        if !visiting.insert(index) {
            tracing::warn!(
                "[sync] todo_items 父子依赖存在循环或重复路径，保持原始顺序: {}",
                changes[index].record_id
            );
            return;
        }

        if let Some(parent_id) = Self::todo_parent_id(&changes[index]) {
            if let Some(parent_index) = todo_index_by_id.get(&parent_id).copied() {
                if parent_index != index {
                    Self::emit_dependency_ordered_change_index(
                        parent_index,
                        changes,
                        todo_index_by_id,
                        visiting,
                        emitted,
                        ordered,
                    );
                }
            }
        }

        visiting.remove(&index);
        if emitted.insert(index) {
            ordered.push(index);
        }
    }

    fn ordered_changes_for_apply<'a>(
        changes: &'a [SyncChangeWithData],
    ) -> Vec<&'a SyncChangeWithData> {
        let mut todo_index_by_id = HashMap::new();
        for (index, change) in changes.iter().enumerate() {
            if change.table_name == "todo_items"
                && matches!(
                    change.operation,
                    ChangeOperation::Insert | ChangeOperation::Update
                )
                && change.data.is_some()
            {
                todo_index_by_id
                    .entry(change.record_id.clone())
                    .or_insert(index);
            }
        }

        let mut emitted = HashSet::new();
        let mut ordered = Vec::with_capacity(changes.len());

        if todo_index_by_id.is_empty() {
            ordered.extend(0..changes.len());
        } else {
            for index in 0..changes.len() {
                let mut visiting = HashSet::new();
                Self::emit_dependency_ordered_change_index(
                    index,
                    changes,
                    &todo_index_by_id,
                    &mut visiting,
                    &mut emitted,
                    &mut ordered,
                );
            }
        }

        let mut ordered_position_by_index = HashMap::new();
        for (position, index) in ordered.iter().enumerate() {
            ordered_position_by_index.insert(*index, position);
        }

        ordered.sort_by(|left, right| {
            let left_change = &changes[*left];
            let right_change = &changes[*right];
            let left_key = (
                Self::apply_dependency_rank(left_change),
                *ordered_position_by_index.get(left).unwrap_or(left),
            );
            let right_key = (
                Self::apply_dependency_rank(right_change),
                *ordered_position_by_index.get(right).unwrap_or(right),
            );
            left_key.cmp(&right_key)
        });

        ordered
            .into_iter()
            .map(|index| &changes[index])
            .collect::<Vec<_>>()
    }

    fn apply_dependency_rank(change: &SyncChangeWithData) -> i32 {
        let insert_rank = match change.table_name.as_str() {
            "resources" => 10,
            "blobs" => 20,
            "chat_v2_session_groups" => 30,
            "chat_v2_sessions" => 35,
            "folders" | "todo_lists" => 30,
            "mistakes" => 30,
            "chat_v2_messages" => 38,
            "document_tasks" | "review_sessions" | "review_analyses" => 38,
            "notes" | "files" | "exam_sheets" | "translations" | "essays" | "mindmaps"
            | "todo_items" => 40,
            "chat_v2_blocks" => 42,
            "questions" | "essay_sessions" | "pomodoro_records" => 50,
            "chat_messages" | "review_chat_messages" | "anki_cards" | "review_session_mistakes" => {
                55
            }
            "chat_v2_attachments" => 55,
            "chat_v2_session_mistakes" => 60,
            "answer_submissions" | "review_plans" | "folder_items" => 60,
            _ => 100,
        };

        if change.operation == ChangeOperation::Delete {
            1000 - insert_rank
        } else {
            insert_rank
        }
    }

    pub fn ensure_quarantine_table(conn: &Connection) -> Result<(), SyncError> {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS __sync_quarantine (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_device_id TEXT NOT NULL,
                source_seq INTEGER NOT NULL,
                table_name TEXT NOT NULL,
                record_id TEXT NOT NULL,
                operation TEXT NOT NULL,
                payload_json TEXT,
                error TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 1,
                first_seen TEXT NOT NULL DEFAULT (datetime('now')),
                last_attempt TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(source_device_id, source_seq, table_name, record_id, operation)
            );
            CREATE INDEX IF NOT EXISTS idx__sync_quarantine_last_attempt
                ON __sync_quarantine(last_attempt);
            "#,
        )
        .map_err(|e| SyncError::Database(format!("创建 __sync_quarantine 失败: {}", e)))
    }

    fn is_transient_apply_error(error: &SyncError) -> bool {
        match error {
            SyncError::Io(_) | SyncError::Network(_) => true,
            // 时钟漂移属于"暂时不可应用但必须保留"的变更：进隔离区（非 transient），
            // 由 replay_quarantined_changes 在后续同步中自动重放（wall clock 追上后即可成功）。
            SyncError::ClockDriftSuspected { .. } => false,
            SyncError::Database(message) => {
                let lower = message.to_ascii_lowercase();
                lower.contains("database is locked")
                    || lower.contains("database table is locked")
                    || lower.contains("sqlite_busy")
                    || lower.contains("disk i/o")
                    || lower.contains("database or disk is full")
                    || lower.contains("out of memory")
            }
            _ => false,
        }
    }

    fn source_device_for_quarantine(change: &SyncChangeWithData) -> String {
        change.source_device_id.clone().unwrap_or_else(|| {
            change
                .database_name
                .as_deref()
                .map(|db| format!("download:{}", db))
                .unwrap_or_else(|| "download:unknown".to_string())
        })
    }

    fn source_seq_for_quarantine(change: &SyncChangeWithData) -> i64 {
        change
            .source_seq
            .and_then(|seq| i64::try_from(seq).ok())
            .or(change.change_log_id)
            .unwrap_or(0)
    }

    fn quarantine_change(
        conn: &Connection,
        change: &SyncChangeWithData,
        error: &SyncError,
    ) -> Result<(), SyncError> {
        Self::ensure_quarantine_table(conn)?;
        let payload_json = serde_json::to_string(change).ok();
        conn.execute(
            "INSERT INTO __sync_quarantine
             (source_device_id, source_seq, table_name, record_id, operation, payload_json, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(source_device_id, source_seq, table_name, record_id, operation)
             DO UPDATE SET
                payload_json = excluded.payload_json,
                error = excluded.error,
                attempts = attempts + 1,
                last_attempt = datetime('now')",
            params![
                Self::source_device_for_quarantine(change),
                Self::source_seq_for_quarantine(change),
                &change.table_name,
                &change.record_id,
                change.operation.as_str(),
                payload_json,
                error.to_string(),
            ],
        )
        .map_err(|e| SyncError::Database(format!("写入 __sync_quarantine 失败: {}", e)))?;
        Ok(())
    }

    fn record_apply_failure(
        result: &mut ApplyChangesResult,
        change: &SyncChangeWithData,
        error: &SyncError,
    ) {
        result.failure_count += 1;
        result.failures.push(ApplyChangeFailure {
            table_name: change.table_name.clone(),
            record_id: change.record_id.clone(),
            operation: change.operation.as_str().to_string(),
            error: error.to_string(),
        });
    }

    /// 隔离区自动重放的重试上限：超过后仅保留给手动处理（UI 隔离区）。
    pub const QUARANTINE_AUTO_REPLAY_MAX_ATTEMPTS: i64 = 20;

    /// [P1] 自动重放隔离区中尚有重试余量的变更。
    ///
    /// 设计动机：隔离项中有一类是"暂时不可应用"而非"永久损坏"——
    /// 时钟漂移（wall clock 追上后即可应用）、偶发性 DB 错误等。
    /// 旧实现只有手动逐条重试入口，这类条目会无限期滞留。
    /// 本函数在每次同步的应用阶段后调用：逐条重放，成功即清除；
    /// 失败则 attempts 递增（由 quarantine_change 的 ON CONFLICT 或本函数负责），
    /// 超过 `max_attempts` 后不再自动重试，避免永久损坏条目空转。
    ///
    /// 返回成功重放并清除的条目数。
    pub fn replay_quarantined_changes(
        conn: &Connection,
        id_columns: Option<&HashMap<String, String>>,
        max_attempts: i64,
    ) -> Result<usize, SyncError> {
        let table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__sync_quarantine')",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !table_exists {
            return Ok(0);
        }

        let candidates: Vec<(i64, String)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT id, payload_json FROM __sync_quarantine
                     WHERE payload_json IS NOT NULL AND attempts <= ?1
                     ORDER BY id",
                )
                .map_err(|e| SyncError::Database(format!("准备隔离区重放查询失败: {}", e)))?;
            let rows = stmt
                .query_map(params![max_attempts], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| SyncError::Database(format!("执行隔离区重放查询失败: {}", e)))?;
            rows.filter_map(|r| r.ok()).collect()
        };

        if candidates.is_empty() {
            return Ok(0);
        }

        let mut replayed = 0usize;
        for (quarantine_id, payload_json) in candidates {
            let change: SyncChangeWithData = match serde_json::from_str(&payload_json) {
                Ok(c) => c,
                Err(e) => {
                    // payload 损坏：标记错误并跳出自动重放（保留人工处理）
                    let _ = conn.execute(
                        "UPDATE __sync_quarantine
                         SET attempts = attempts + 1,
                             error = ?1,
                             last_attempt = datetime('now')
                         WHERE id = ?2",
                        params![format!("payload 解析失败: {}", e), quarantine_id],
                    );
                    continue;
                }
            };
            match Self::apply_downloaded_changes(conn, &[change], id_columns) {
                Ok(result) if result.failure_count == 0 => {
                    let _ = conn.execute(
                        "DELETE FROM __sync_quarantine WHERE id = ?1",
                        params![quarantine_id],
                    );
                    replayed += 1;
                }
                Ok(_) => {
                    // 再次失败：apply 内部的 quarantine_change ON CONFLICT 已递增 attempts，
                    // 这里无需重复处理。
                }
                Err(e) => {
                    // transient 错误：本轮放弃，不再继续重放（环境性问题影响所有条目）
                    let _ = conn.execute(
                        "UPDATE __sync_quarantine
                         SET attempts = attempts + 1,
                             error = ?1,
                             last_attempt = datetime('now')
                         WHERE id = ?2",
                        params![e.to_string(), quarantine_id],
                    );
                    tracing::warn!("[sync] 隔离区自动重放遇到暂时性错误，本轮终止: {}", e);
                    break;
                }
            }
        }

        if replayed > 0 {
            tracing::info!("[sync] 隔离区自动重放成功 {} 条", replayed);
        }
        Ok(replayed)
    }

    fn validate_no_new_fk_violations(
        conn: &Connection,
        baseline: &ForeignKeyViolationSet,
        tables: &[String],
    ) -> Result<(), SyncError> {
        let current = Self::collect_foreign_key_violation_set(conn, tables)?;
        let new_violations = current
            .difference(baseline)
            .take(20)
            .cloned()
            .collect::<Vec<_>>();
        if !new_violations.is_empty() {
            return Err(SyncError::Database(format!(
                "新增外键约束违规（示例最多 20 条）: {}",
                new_violations.join("; ")
            )));
        }
        Ok(())
    }

    fn begin_apply_savepoint(conn: &Connection, index: usize) -> Result<String, SyncError> {
        let name = format!("sp_sync_apply_{}", index);
        conn.execute_batch(&format!("SAVEPOINT {}", name))
            .map_err(|e| SyncError::Database(format!("创建 SAVEPOINT 失败: {}", e)))?;
        Ok(name)
    }

    fn rollback_and_release_savepoint(conn: &Connection, name: &str) {
        let _ = conn.execute_batch(&format!("ROLLBACK TO SAVEPOINT {}", name));
        let _ = conn.execute_batch(&format!("RELEASE SAVEPOINT {}", name));
    }

    fn release_savepoint(conn: &Connection, name: &str) -> Result<(), SyncError> {
        conn.execute_batch(&format!("RELEASE SAVEPOINT {}", name))
            .map_err(|e| SyncError::Database(format!("释放 SAVEPOINT 失败: {}", e)))
    }

    fn collect_pending_local_change_keys(
        conn: &Connection,
    ) -> Result<HashSet<(String, String)>, SyncError> {
        let table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__change_log')",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !table_exists {
            return Ok(HashSet::new());
        }

        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT table_name, record_id
                 FROM __change_log
                 WHERE sync_version = 0",
            )
            .map_err(|e| SyncError::Database(format!("查询本地待同步变更失败: {}", e)))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| SyncError::Database(format!("读取本地待同步变更失败: {}", e)))?;

        let mut keys = HashSet::new();
        for row in rows {
            keys.insert(
                row.map_err(|e| SyncError::Database(format!("解析本地待同步变更失败: {}", e)))?,
            );
        }
        Ok(keys)
    }

    /// 应用下载的变更到数据库
    ///
    /// 批量应用从云端下载的变更，支持事务处理。
    ///
    /// # 参数
    /// * `conn` - 数据库连接
    /// * `changes` - 带完整数据的变更列表
    /// * `id_column_map` - 表名到主键列名的映射（默认使用 "id"）
    ///
    /// # 返回
    /// * `ApplyChangesResult` - 应用结果
    pub fn apply_downloaded_changes<C>(
        conn: &Connection,
        changes: C,
        id_column_map: Option<&HashMap<String, String>>,
    ) -> Result<ApplyChangesResult, SyncError>
    where
        C: AsRef<[SyncChangeWithData]>,
    {
        let changes = changes.as_ref();
        if changes.is_empty() {
            return Ok(ApplyChangesResult::empty());
        }

        let mut result = ApplyChangesResult::empty();

        // 原子性保证：任何错误都应回滚，避免“半套数据”落地。
        //
        // 同时为了避免跨表写入顺序导致的外键约束问题，这里在事务内临时关闭外键检查，
        // 写入完成后使用 `PRAGMA foreign_key_check` 做一次强校验，失败则回滚。
        let original_fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap_or(1);

        // 注意：SQLite 在事务内修改 foreign_keys 是无操作（no-op），
        // 必须在 BEGIN 之前修改，或者使用 defer_foreign_keys = ON。
        // [D5.4] 应用连接全程 foreign_keys=OFF，违规由作用域 foreign_key_check 差集守卫；
        // defer_foreign_keys 对 OFF 连接是空操作，已移除以免误导。

        conn.execute_batch("BEGIN IMMEDIATE;")
            .map_err(|e| SyncError::Database(format!("开始事务失败: {}", e)))?;

        let apply_result: Result<(), SyncError> = (|| {
            Self::ensure_quarantine_table(conn)?;
            let id_aliases = Self::build_download_id_aliases(conn, changes, id_column_map)?;
            let shadowed_incomplete_upserts = Self::incomplete_upserts_shadowed_by_delete(changes);
            let fk_child_map = Self::build_fk_child_map(conn)?;
            let fk_batch_tables = Self::fk_batch_check_tables(changes, &fk_child_map);
            let fk_baseline = Self::collect_foreign_key_violation_set(conn, &fk_batch_tables)?;
            let pending_local_change_keys = Self::collect_pending_local_change_keys(conn)?;

            let ordered_changes = Self::ordered_changes_for_apply(changes);
            for (index, change) in ordered_changes.into_iter().enumerate() {
                if Self::should_skip_shadowed_incomplete_upsert(
                    change,
                    &shadowed_incomplete_upserts,
                ) {
                    tracing::warn!(
                        "[sync] 跳过同批 DELETE 覆盖的缺数据 UPSERT: {}.{}",
                        change.table_name,
                        change.record_id
                    );
                    result.skipped_count += 1;
                    result.skipped_incomplete_count += 1;
                    continue;
                }

                let savepoint = Self::begin_apply_savepoint(conn, index)?;
                let result_before = result.clone();
                let single_result: Result<(), SyncError> = (|| {
                    let id_column = id_column_map
                        .and_then(|m| m.get(&change.table_name))
                        .map(|s| s.as_str())
                        .unwrap_or("id");
                    let change_to_apply =
                        Self::remap_change_with_aliases(conn, change, id_column, &id_aliases)?;

                    let suppress = change_to_apply.suppress_change_log.unwrap_or(false);

                    let pre_log_max_id = if suppress {
                        conn.query_row("SELECT COALESCE(MAX(id), 0) FROM __change_log", [], |row| {
                            row.get::<_, i64>(0)
                        })
                        .ok()
                    } else {
                        None
                    };

                    let allow_field_merge = pending_local_change_keys.contains(&(
                        change_to_apply.table_name.clone(),
                        change_to_apply.record_id.clone(),
                    ));
                    let applied = Self::apply_single_change(
                        conn,
                        &change_to_apply,
                        id_column,
                        allow_field_merge,
                    )?;
                    if applied {
                        result.success_count += 1;
                        result.applied_keys.insert((
                            change_to_apply.table_name.clone(),
                            change_to_apply.record_id.clone(),
                        ));
                    } else {
                        result.skipped_count += 1;
                        if matches!(
                            change_to_apply.operation,
                            ChangeOperation::Insert | ChangeOperation::Update
                        ) && change_to_apply.data.is_none()
                        {
                            result.skipped_incomplete_count += 1;
                        }
                    }

                    // 精确抑制：标记由本次回放产生的、匹配当前 table+record 的所有
                    // change_log 条目为已同步。
                    if let Some(max_id) = pre_log_max_id {
                        let sync_version = chrono::Utc::now().timestamp();
                        let _ = conn.execute(
                            "UPDATE __change_log SET sync_version = ?1 \
                             WHERE id > ?2 AND sync_version = 0 \
                             AND table_name = ?3 AND record_id = ?4",
                            params![
                                sync_version,
                                max_id,
                                &change_to_apply.table_name,
                                &change_to_apply.record_id,
                            ],
                        );
                    }

                    Self::validate_no_new_fk_violations(conn, &fk_baseline, &fk_batch_tables)?;
                    Ok(())
                })();

                match single_result {
                    Ok(()) => {
                        Self::release_savepoint(conn, &savepoint)?;
                    }
                    Err(e) if !Self::is_transient_apply_error(&e) => {
                        Self::rollback_and_release_savepoint(conn, &savepoint);
                        result = result_before;
                        Self::quarantine_change(conn, change, &e)?;
                        Self::record_apply_failure(&mut result, change, &e);
                        tracing::warn!(
                            "[sync] 单条变更已进入检疫，继续应用后续变更: {}.{} {}: {}",
                            change.table_name,
                            change.record_id,
                            change.operation.as_str(),
                            e
                        );
                    }
                    Err(e) => {
                        Self::rollback_and_release_savepoint(conn, &savepoint);
                        result = result_before;
                        return Err(e);
                    }
                }
            }

            Self::recompute_derived_ref_counts_if_relevant(conn, changes)?;
            Self::persist_id_aliases(conn, &id_aliases)?;
            Self::validate_no_new_fk_violations(conn, &fk_baseline, &fk_batch_tables)?;

            Ok(())
        })();

        match apply_result {
            Ok(()) => {
                if let Err(e) = conn.execute_batch("COMMIT;") {
                    let _ = conn.execute_batch("ROLLBACK;");
                    let _ = if original_fk == 0 {
                        conn.execute_batch("PRAGMA foreign_keys = OFF;")
                    } else {
                        conn.execute_batch("PRAGMA foreign_keys = ON;")
                    };
                    return Err(SyncError::Database(format!("提交事务失败: {}", e)));
                }
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                // 恢复外键开关（best-effort）
                let _ = if original_fk == 0 {
                    conn.execute_batch("PRAGMA foreign_keys = OFF;")
                } else {
                    conn.execute_batch("PRAGMA foreign_keys = ON;")
                };
                return Err(e);
            }
        }

        // 恢复外键开关（best-effort）
        let _ = if original_fk == 0 {
            conn.execute_batch("PRAGMA foreign_keys = OFF;")
        } else {
            conn.execute_batch("PRAGMA foreign_keys = ON;")
        };

        tracing::info!(
            "[sync] 变更应用完成: success={}, failed={}, skipped={}",
            result.success_count,
            result.failure_count,
            result.skipped_count
        );

        Ok(result)
    }

    /// [P3 perf] 仅当本批变更触及引用相关表时才重算派生计数。
    /// 大多数同步批次只动 notes/chat 等无关表，跳过两次全表聚合扫描。
    fn recompute_derived_ref_counts_if_relevant(
        conn: &Connection,
        changes: &[SyncChangeWithData],
    ) -> Result<(), SyncError> {
        if !Self::changes_affect_ref_counts(conn, changes) {
            return Ok(());
        }
        Self::recompute_derived_ref_counts(conn)
    }

    /// 判断变更批次是否触及 ref_count 的来源表或目标表：
    /// - `resources` / `blobs` 本身（包括 LWW 覆盖写入的 ref_count 旧值需要纠正）
    /// - 任何带 `resource_id` / `blob_hash` / `compressed_blob_hash` /
    ///   `image_blob_hash` 列的引用方表
    /// - 任何带 `preview_json` / `images_json` 列的表（JSON 内嵌 blob 引用，
    ///   见 `recompute_blob_ref_counts`）
    fn changes_affect_ref_counts(conn: &Connection, changes: &[SyncChangeWithData]) -> bool {
        let mut seen: HashSet<&str> = HashSet::new();
        for change in changes {
            let table = change.table_name.as_str();
            if !seen.insert(table) {
                continue;
            }
            if table == "resources" || table == "blobs" {
                return true;
            }
            if Self::table_has_column(conn, table, "resource_id")
                || Self::table_has_column(conn, table, "blob_hash")
                || Self::table_has_column(conn, table, "compressed_blob_hash")
                || Self::table_has_column(conn, table, "image_blob_hash")
                || Self::table_has_column(conn, table, "preview_json")
                || Self::table_has_column(conn, table, "images_json")
            {
                return true;
            }
        }
        false
    }

    fn recompute_derived_ref_counts(conn: &Connection) -> Result<(), SyncError> {
        let pre_log_max = Self::change_log_max_id(conn);

        Self::recompute_resource_ref_counts(conn)?;
        Self::recompute_blob_ref_counts(conn)?;

        if let Some(max_id) = pre_log_max {
            let sync_version = chrono::Utc::now().timestamp();
            let _ = conn.execute(
                "UPDATE __change_log SET sync_version = ?1
                 WHERE id > ?2
                   AND sync_version = 0
                   AND table_name IN ('resources', 'blobs')",
                params![sync_version, max_id],
            );
        }
        Ok(())
    }

    fn change_log_max_id(conn: &Connection) -> Option<i64> {
        conn.query_row("SELECT COALESCE(MAX(id), 0) FROM __change_log", [], |row| {
            row.get(0)
        })
        .ok()
    }

    fn user_tables_with_column(
        conn: &Connection,
        column_name: &str,
    ) -> Result<Vec<String>, SyncError> {
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type='table'
                   AND name NOT LIKE 'sqlite_%'
                   AND name NOT LIKE '\\_\\_%' ESCAPE '\\'",
            )
            .map_err(|e| SyncError::Database(format!("查询表清单失败: {}", e)))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| SyncError::Database(format!("扫描表清单失败: {}", e)))?;
        let mut tables = Vec::new();
        for row in rows {
            let table = row.map_err(|e| SyncError::Database(format!("读取表名失败: {}", e)))?;
            if Self::table_has_column(conn, &table, column_name) {
                tables.push(table);
            }
        }
        Ok(tables)
    }

    fn recompute_resource_ref_counts(conn: &Connection) -> Result<(), SyncError> {
        if !Self::table_has_column(conn, "resources", "ref_count") {
            return Ok(());
        }

        let mut subqueries = Vec::new();
        for table in Self::user_tables_with_column(conn, "resource_id")? {
            if table == "resources" {
                continue;
            }
            let table_ident = Self::quote_identifier(&table)?;
            let deleted_filter = if Self::table_has_column(conn, &table, "deleted_at") {
                " AND deleted_at IS NULL"
            } else {
                ""
            };
            subqueries.push(format!(
                "SELECT resource_id AS resource_id FROM {} WHERE resource_id IS NOT NULL{}",
                table_ident, deleted_filter
            ));
        }

        // [P2 churn] WHERE 限定只更新值实际变化的行：SQLite 对值未变的行同样
        // 触发 AFTER UPDATE 触发器，无条件全表 UPDATE 会在每轮同步向
        // __change_log 注入全表行数的日志（随后还要标记+归档），并在
        // BEGIN IMMEDIATE 排他事务内放大锁窗口。
        if subqueries.is_empty() {
            conn.execute(
                "UPDATE resources SET ref_count = 0 WHERE ref_count IS NOT 0",
                [],
            )
            .map_err(|e| SyncError::Database(format!("重算 resources.ref_count 失败: {}", e)))?;
            return Ok(());
        }

        let refs_union = subqueries.join(" UNION ALL ");
        // [P3 perf] UPDATE FROM（SQLite >= 3.33，bundled 3.42）单趟 GROUP BY 聚合；
        // 相关子查询版本对每行执行两次 UNION 全扫（SET + WHERE 各一次），大表退化为
        // O(N×M)。UPDATE FROM 是 inner-join 语义，引用归零的行需第二条语句补清零。
        let sql_update = format!(
            "UPDATE resources
             SET ref_count = rc.cnt
             FROM (
                 SELECT resource_id, COUNT(*) AS cnt
                 FROM ({refs_union}) refs
                 WHERE refs.resource_id IS NOT NULL
                 GROUP BY resource_id
             ) rc
             WHERE resources.id = rc.resource_id
               AND resources.ref_count IS NOT rc.cnt"
        );
        conn.execute(&sql_update, [])
            .map_err(|e| SyncError::Database(format!("重算 resources.ref_count 失败: {}", e)))?;
        let sql_zero = format!(
            "UPDATE resources
             SET ref_count = 0
             WHERE ref_count IS NOT 0
               AND id NOT IN (
                   SELECT refs.resource_id FROM ({refs_union}) refs
                   WHERE refs.resource_id IS NOT NULL
               )"
        );
        conn.execute(&sql_zero, [])
            .map_err(|e| SyncError::Database(format!("清零 resources.ref_count 失败: {}", e)))?;
        Ok(())
    }

    fn recompute_blob_ref_counts(conn: &Connection) -> Result<(), SyncError> {
        if !Self::table_has_column(conn, "blobs", "ref_count") {
            return Ok(());
        }

        let mut subqueries = Vec::new();
        if Self::table_has_column(conn, "files", "blob_hash") {
            subqueries.push(
                "SELECT blob_hash AS blob_hash FROM files WHERE blob_hash IS NOT NULL".to_string(),
            );
        }
        if Self::table_has_column(conn, "files", "compressed_blob_hash") {
            // "压缩不划算"路径会把 compressed_blob_hash 指向原始 blob_hash 而
            // 不额外 store_blob(+1)，purge 也对应跳过递减（见 file_repo purge 1.5），
            // 等值时不得重复计数。
            subqueries.push(
                "SELECT compressed_blob_hash AS blob_hash FROM files
                 WHERE compressed_blob_hash IS NOT NULL
                   AND compressed_blob_hash IS NOT blob_hash"
                    .to_string(),
            );
        }
        if Self::table_has_column(conn, "vfs_index_units", "image_blob_hash") {
            subqueries.push(
                "SELECT image_blob_hash AS blob_hash FROM vfs_index_units WHERE image_blob_hash IS NOT NULL"
                    .to_string(),
            );
        }

        // ★ 2026-06-12（P1 防数据丢失）：JSON 内嵌 blob 引用必须参与重算。
        // 旧实现只统计上面三个显式列，把仅存在于 JSON 中的引用（PDF/教材页图、
        // 试卷页图、题目图片）全部清零 → 启动时 cleanup_unreferenced 物理删除
        // 这些图片，并经 tombstone 把删除传播到云端与其他设备。
        // 提取口径与本地计数模型严格对齐（每出现一次计一次引用）：
        // - files.preview_json:    $.pages[*].blob_hash（page_rasterizer store_blob +1）
        //                          $.pages[*].compressed_blob_hash（页图压缩 store_blob +1）
        // - exam_sheets.preview_json: $.pages[*].blob_hash（试卷页图，
        //                          见 exam_repo::collect_exam_blob_hashes）
        // - questions.images_json: $[*].hash（题目图片，question_import store_blob +1；
        //                          含软删题目——purge 才递减）
        // json_valid 守卫：历史/外来数据可能存在非法 JSON，json_each 直接报错会
        // 中断整个同步事务；非法 JSON 行按"无引用"处理（与本地 serde 解析失败一致）。
        if Self::table_has_column(conn, "files", "preview_json") {
            subqueries.push(
                "SELECT json_extract(page.value, '$.blob_hash') AS blob_hash
                 FROM files, json_each(files.preview_json, '$.pages') AS page
                 WHERE files.preview_json IS NOT NULL
                   AND json_valid(files.preview_json)
                   AND json_extract(page.value, '$.blob_hash') IS NOT NULL
                   AND json_extract(page.value, '$.blob_hash') <> ''"
                    .to_string(),
            );
            // 页级"压缩不划算"路径同样把 compressed 指向原始页图而不 +1，
            // purge/copy 也按等值跳过（见 file_repo purge 第 2 步），口径一致。
            subqueries.push(
                "SELECT json_extract(page.value, '$.compressed_blob_hash') AS blob_hash
                 FROM files, json_each(files.preview_json, '$.pages') AS page
                 WHERE files.preview_json IS NOT NULL
                   AND json_valid(files.preview_json)
                   AND json_extract(page.value, '$.compressed_blob_hash') IS NOT NULL
                   AND json_extract(page.value, '$.compressed_blob_hash') <> ''
                   AND json_extract(page.value, '$.compressed_blob_hash')
                       IS NOT json_extract(page.value, '$.blob_hash')"
                    .to_string(),
            );
        }
        if Self::table_has_column(conn, "exam_sheets", "preview_json") {
            subqueries.push(
                "SELECT json_extract(page.value, '$.blob_hash') AS blob_hash
                 FROM exam_sheets, json_each(exam_sheets.preview_json, '$.pages') AS page
                 WHERE exam_sheets.preview_json IS NOT NULL
                   AND json_valid(exam_sheets.preview_json)
                   AND json_extract(page.value, '$.blob_hash') IS NOT NULL
                   AND json_extract(page.value, '$.blob_hash') <> ''"
                    .to_string(),
            );
        }
        if Self::table_has_column(conn, "questions", "images_json") {
            subqueries.push(
                "SELECT json_extract(img.value, '$.hash') AS blob_hash
                 FROM questions, json_each(questions.images_json) AS img
                 WHERE questions.images_json IS NOT NULL
                   AND json_valid(questions.images_json)
                   AND json_extract(img.value, '$.hash') IS NOT NULL
                   AND json_extract(img.value, '$.hash') <> ''"
                    .to_string(),
            );
        }

        // [P2 churn] 同 recompute_resource_ref_counts：只更新值实际变化的行。
        if subqueries.is_empty() {
            conn.execute(
                "UPDATE blobs SET ref_count = 0 WHERE ref_count IS NOT 0",
                [],
            )
            .map_err(|e| SyncError::Database(format!("重算 blobs.ref_count 失败: {}", e)))?;
            return Ok(());
        }

        let refs_union = subqueries.join(" UNION ALL ");
        // [P3 perf] 同 recompute_resource_ref_counts：UPDATE FROM 单趟聚合。
        let sql_update = format!(
            "UPDATE blobs
             SET ref_count = rc.cnt
             FROM (
                 SELECT blob_hash, COUNT(*) AS cnt
                 FROM ({refs_union}) refs
                 WHERE refs.blob_hash IS NOT NULL
                 GROUP BY blob_hash
             ) rc
             WHERE blobs.hash = rc.blob_hash
               AND blobs.ref_count IS NOT rc.cnt"
        );
        conn.execute(&sql_update, [])
            .map_err(|e| SyncError::Database(format!("重算 blobs.ref_count 失败: {}", e)))?;
        let sql_zero = format!(
            "UPDATE blobs
             SET ref_count = 0
             WHERE ref_count IS NOT 0
               AND hash NOT IN (
                   SELECT refs.blob_hash FROM ({refs_union}) refs
                   WHERE refs.blob_hash IS NOT NULL
               )"
        );
        conn.execute(&sql_zero, [])
            .map_err(|e| SyncError::Database(format!("清零 blobs.ref_count 失败: {}", e)))?;
        Ok(())
    }

    /// 强制应用已经由用户或冲突策略裁决的变更。
    ///
    /// 该入口专用于手动冲突解决：跳过 LWW 时间戳门、禁用字段级自动合并，
    /// 让用户选定的整行值精确落库；是否写入 `__change_log` 仍由
    /// `SyncChangeWithData::suppress_change_log` 决定。
    pub fn apply_downloaded_changes_force_exact(
        conn: &Connection,
        changes: &[SyncChangeWithData],
        id_column_map: Option<&HashMap<String, String>>,
    ) -> Result<ApplyChangesResult, SyncError> {
        if changes.is_empty() {
            return Ok(ApplyChangesResult::empty());
        }

        let original_fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap_or(1);
        // [D5.4] 应用连接全程 foreign_keys=OFF，违规由作用域 foreign_key_check 差集守卫；
        // defer_foreign_keys 对 OFF 连接是空操作，已移除以免误导。
        conn.execute_batch("BEGIN IMMEDIATE;")
            .map_err(|e| SyncError::Database(format!("开始事务失败: {}", e)))?;

        let mut result = ApplyChangesResult::empty();
        let apply_result: Result<(), SyncError> = (|| {
            Self::ensure_quarantine_table(conn)?;
            let id_aliases = Self::build_download_id_aliases(conn, changes, id_column_map)?;
            let fk_child_map = Self::build_fk_child_map(conn)?;
            let fk_batch_tables = Self::fk_batch_check_tables(changes, &fk_child_map);
            let fk_baseline = Self::collect_foreign_key_violation_set(conn, &fk_batch_tables)?;

            let ordered_changes = Self::ordered_changes_for_apply(changes);
            for (index, change) in ordered_changes.into_iter().enumerate() {
                let savepoint = Self::begin_apply_savepoint(conn, index)?;
                let result_before = result.clone();
                let single_result: Result<(), SyncError> = (|| {
                    let id_column = id_column_map
                        .and_then(|m| m.get(&change.table_name))
                        .map(|s| s.as_str())
                        .unwrap_or("id");
                    let change_to_apply =
                        Self::remap_change_with_aliases(conn, change, id_column, &id_aliases)?;

                    let suppress = change_to_apply.suppress_change_log.unwrap_or(false);
                    let pre_log_max_id = if suppress {
                        conn.query_row("SELECT COALESCE(MAX(id), 0) FROM __change_log", [], |row| {
                            row.get::<_, i64>(0)
                        })
                        .ok()
                    } else {
                        None
                    };

                    let applied =
                        Self::apply_single_change_force(conn, &change_to_apply, id_column, false)?;
                    if applied {
                        result.success_count += 1;
                        result.applied_keys.insert((
                            change_to_apply.table_name.clone(),
                            change_to_apply.record_id.clone(),
                        ));
                    } else {
                        result.skipped_count += 1;
                    }

                    if let Some(max_id) = pre_log_max_id {
                        let sync_version = chrono::Utc::now().timestamp();
                        let _ = conn.execute(
                            "UPDATE __change_log SET sync_version = ?1 \
                             WHERE id > ?2 AND sync_version = 0 \
                             AND table_name = ?3 AND record_id = ?4",
                            params![
                                sync_version,
                                max_id,
                                &change_to_apply.table_name,
                                &change_to_apply.record_id,
                            ],
                        );
                    }

                    Self::validate_no_new_fk_violations(conn, &fk_baseline, &fk_batch_tables)?;
                    Ok(())
                })();

                match single_result {
                    Ok(()) => Self::release_savepoint(conn, &savepoint)?,
                    Err(e) => {
                        Self::rollback_and_release_savepoint(conn, &savepoint);
                        result = result_before;
                        return Err(e);
                    }
                }
            }

            Self::recompute_derived_ref_counts_if_relevant(conn, changes)?;
            Self::persist_id_aliases(conn, &id_aliases)?;
            Self::validate_no_new_fk_violations(conn, &fk_baseline, &fk_batch_tables)?;
            Ok(())
        })();

        match apply_result {
            Ok(()) => {
                if let Err(e) = conn.execute_batch("COMMIT;") {
                    let _ = conn.execute_batch("ROLLBACK;");
                    let _ = if original_fk == 0 {
                        conn.execute_batch("PRAGMA foreign_keys = OFF;")
                    } else {
                        conn.execute_batch("PRAGMA foreign_keys = ON;")
                    };
                    return Err(SyncError::Database(format!("提交事务失败: {}", e)));
                }
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                let _ = if original_fk == 0 {
                    conn.execute_batch("PRAGMA foreign_keys = OFF;")
                } else {
                    conn.execute_batch("PRAGMA foreign_keys = ON;")
                };
                return Err(e);
            }
        }

        let _ = if original_fk == 0 {
            conn.execute_batch("PRAGMA foreign_keys = OFF;")
        } else {
            conn.execute_batch("PRAGMA foreign_keys = ON;")
        };

        Ok(result)
    }

    /// 以冲突感知方式应用变更（修复 #3 #4 #20）
    ///
    /// 与 `apply_downloaded_changes` 不同：
    /// 1. 对每条下载的变更，先用 `ConflictResolver::resolve_one` 判定是否冲突
    /// 2. 若冲突：
    ///    - 把败方数据写入 `__sync_conflicts` 表（永不丢失）
    ///    - 胜方是 Cloud → 正常应用云端变更到数据库
    ///    - 胜方是 Local → 跳过应用，但仍写胜方本地值到冲突表作为留痕
    /// 3. 无冲突：直接应用
    ///
    /// 使用一次事务保证要么全部成功要么回滚；若整体失败不写冲突表。
    pub fn apply_downloaded_changes_with_conflict_guard(
        conn: &Connection,
        changes: &[SyncChangeWithData],
        id_column_map: Option<&HashMap<String, String>>,
        policy: conflict_resolver::ConflictPolicy,
        cloud_device_id: Option<&str>,
        local_device_id: Option<&str>,
    ) -> Result<
        (
            ApplyChangesResult,
            conflict_resolver::ConflictAwareApplyResult,
        ),
        SyncError,
    > {
        use conflict_resolver::{ConflictResolver, ConflictSide};

        if changes.is_empty() {
            return Ok((
                ApplyChangesResult::empty(),
                conflict_resolver::ConflictAwareApplyResult::default(),
            ));
        }

        // 保证冲突表存在（幂等）
        ConflictResolver::ensure_conflict_table(conn)?;

        let original_fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap_or(1);
        // [D5.4] 应用连接全程 foreign_keys=OFF，违规由作用域 foreign_key_check 差集守卫；
        // defer_foreign_keys 对 OFF 连接是空操作，已移除以免误导。
        conn.execute_batch("BEGIN IMMEDIATE;")
            .map_err(|e| SyncError::Database(format!("开始事务失败: {}", e)))?;

        let resolver = ConflictResolver::new(policy);
        let mut apply_result = ApplyChangesResult::empty();
        let mut conflict_result = conflict_resolver::ConflictAwareApplyResult::default();

        let inner: Result<(), SyncError> = (|| {
            Self::ensure_quarantine_table(conn)?;
            let id_aliases = Self::build_download_id_aliases(conn, changes, id_column_map)?;
            let shadowed_incomplete_upserts = Self::incomplete_upserts_shadowed_by_delete(changes);
            let fk_child_map = Self::build_fk_child_map(conn)?;
            let fk_batch_tables = Self::fk_batch_check_tables(changes, &fk_child_map);
            let fk_baseline = Self::collect_foreign_key_violation_set(conn, &fk_batch_tables)?;
            let pending_local_change_keys = Self::collect_pending_local_change_keys(conn)?;

            let ordered_changes = Self::ordered_changes_for_apply(changes);
            for (index, change) in ordered_changes.into_iter().enumerate() {
                if Self::should_skip_shadowed_incomplete_upsert(
                    change,
                    &shadowed_incomplete_upserts,
                ) {
                    tracing::warn!(
                        "[sync] 跳过同批 DELETE 覆盖的缺数据 UPSERT: {}.{}",
                        change.table_name,
                        change.record_id
                    );
                    apply_result.skipped_count += 1;
                    apply_result.skipped_incomplete_count += 1;
                    continue;
                }

                let savepoint = Self::begin_apply_savepoint(conn, index)?;
                let apply_before = apply_result.clone();
                let conflict_before = conflict_result.clone();
                let single_result: Result<(), SyncError> = (|| {
                    let id_column = id_column_map
                        .and_then(|m| m.get(&change.table_name))
                        .map(|s| s.as_str())
                        .unwrap_or("id");

                    let change_to_apply =
                        Self::remap_change_with_aliases(conn, change, id_column, &id_aliases)?;

                    if matches!(
                        change_to_apply.operation,
                        ChangeOperation::Insert | ChangeOperation::Update
                    ) && Self::upsert_blocked_by_delete_version(
                        conn,
                        &change_to_apply,
                        id_column,
                    )? {
                        apply_result.skipped_count += 1;
                        tracing::debug!(
                            "[sync] 冲突判定前拒绝迟到 UPSERT: {}.{}",
                            change_to_apply.table_name,
                            change_to_apply.record_id
                        );
                        return Ok(());
                    }

                    match resolver.resolve_one(conn, &change_to_apply, id_column)? {
                        None => {
                            // 非冲突，正常 UPSERT
                            let suppress = change_to_apply.suppress_change_log.unwrap_or(false);
                            let pre_log_max_id = if suppress {
                                conn.query_row(
                                    "SELECT COALESCE(MAX(id), 0) FROM __change_log",
                                    [],
                                    |row| row.get::<_, i64>(0),
                                )
                                .ok()
                            } else {
                                None
                            };

                            let allow_field_merge = pending_local_change_keys.contains(&(
                                change_to_apply.table_name.clone(),
                                change_to_apply.record_id.clone(),
                            ));
                            let applied = Self::apply_single_change(
                                conn,
                                &change_to_apply,
                                id_column,
                                allow_field_merge,
                            )?;
                            if applied {
                                apply_result.success_count += 1;
                                apply_result.applied_keys.insert((
                                    change_to_apply.table_name.clone(),
                                    change_to_apply.record_id.clone(),
                                ));
                            } else {
                                apply_result.skipped_count += 1;
                                if matches!(
                                    change_to_apply.operation,
                                    ChangeOperation::Insert | ChangeOperation::Update
                                ) && change_to_apply.data.is_none()
                                {
                                    apply_result.skipped_incomplete_count += 1;
                                }
                            }

                            if let Some(max_id) = pre_log_max_id {
                                let sync_version = chrono::Utc::now().timestamp();
                                let _ = conn.execute(
                                    "UPDATE __change_log SET sync_version = ?1 \
                                     WHERE id > ?2 AND sync_version = 0 \
                                     AND table_name = ?3 AND record_id = ?4",
                                    params![
                                        sync_version,
                                        max_id,
                                        &change_to_apply.table_name,
                                        &change_to_apply.record_id,
                                    ],
                                );
                            }
                        }
                        Some(outcome) => {
                            // 落败方先进冲突表（两端都各存一份，便于 UI 三路展示）
                            let loser_inserted = ConflictResolver::save_conflict_record(
                                conn,
                                conflict_resolver::ConflictRecordToSave {
                                    table_name: &change_to_apply.table_name,
                                    record_id: &change_to_apply.record_id,
                                    side: outcome.loser,
                                    data: &outcome.loser_data,
                                    winning_device_id: if outcome.winner == ConflictSide::Cloud {
                                        cloud_device_id
                                    } else {
                                        local_device_id
                                    },
                                    losing_device_id: if outcome.loser == ConflictSide::Cloud {
                                        cloud_device_id
                                    } else {
                                        local_device_id
                                    },
                                },
                            )?;

                            // 同时把胜方的快照也记录一份（side=winner），方便 UI 同时看到两份
                            let winner_inserted = ConflictResolver::save_conflict_record(
                                conn,
                                conflict_resolver::ConflictRecordToSave {
                                    table_name: &change_to_apply.table_name,
                                    record_id: &change_to_apply.record_id,
                                    side: outcome.winner,
                                    data: &outcome.winner_data,
                                    winning_device_id: if outcome.winner == ConflictSide::Cloud {
                                        cloud_device_id
                                    } else {
                                        local_device_id
                                    },
                                    losing_device_id: if outcome.loser == ConflictSide::Cloud {
                                        cloud_device_id
                                    } else {
                                        local_device_id
                                    },
                                },
                            )?;

                            let inserted_rows =
                                usize::from(loser_inserted) + usize::from(winner_inserted);
                            conflict_result.conflicts_saved += inserted_rows;
                            if inserted_rows > 0 {
                                *conflict_result
                                    .conflicts_by_table
                                    .entry(change_to_apply.table_name.clone())
                                    .or_insert(0) += inserted_rows;
                            }

                            if outcome.winner == ConflictSide::Cloud {
                                // Cloud 胜，按云端数据写入本地（但要抑制回声）
                                let mut cloud_change = change_to_apply.clone();
                                cloud_change.suppress_change_log = Some(true);

                                let pre_log_max_id = conn
                                    .query_row(
                                        "SELECT COALESCE(MAX(id), 0) FROM __change_log",
                                        [],
                                        |row| row.get::<_, i64>(0),
                                    )
                                    .ok();

                                // 冲突已裁决为 Cloud 胜，绕过 LWW 门强制应用
                                let applied = Self::apply_single_change_force(
                                    conn,
                                    &cloud_change,
                                    id_column,
                                    false,
                                )?;
                                if applied {
                                    apply_result.success_count += 1;
                                    apply_result.applied_keys.insert((
                                        cloud_change.table_name.clone(),
                                        cloud_change.record_id.clone(),
                                    ));
                                    conflict_result.applied += 1;
                                } else {
                                    apply_result.skipped_count += 1;
                                    if matches!(
                                        cloud_change.operation,
                                        ChangeOperation::Insert | ChangeOperation::Update
                                    ) && cloud_change.data.is_none()
                                    {
                                        apply_result.skipped_incomplete_count += 1;
                                    }
                                }

                                if let Some(max_id) = pre_log_max_id {
                                    let sync_version = chrono::Utc::now().timestamp();
                                    let _ = conn.execute(
                                        "UPDATE __change_log SET sync_version = ?1 \
                                         WHERE id > ?2 AND sync_version = 0 \
                                         AND table_name = ?3 AND record_id = ?4",
                                        params![
                                            sync_version,
                                            max_id,
                                            &cloud_change.table_name,
                                            &cloud_change.record_id,
                                        ],
                                    );
                                }
                            } else {
                                // Local 胜，跳过应用云端变更；但记录为 rejected，上层会在下一轮把本地值上传
                                conflict_result.rejected += 1;
                                apply_result.skipped_count += 1;
                            }
                        }
                    }

                    Self::validate_no_new_fk_violations(conn, &fk_baseline, &fk_batch_tables)?;
                    Ok(())
                })();

                match single_result {
                    Ok(()) => {
                        Self::release_savepoint(conn, &savepoint)?;
                    }
                    Err(e) if !Self::is_transient_apply_error(&e) => {
                        Self::rollback_and_release_savepoint(conn, &savepoint);
                        apply_result = apply_before;
                        conflict_result = conflict_before;
                        Self::quarantine_change(conn, change, &e)?;
                        Self::record_apply_failure(&mut apply_result, change, &e);
                        tracing::warn!(
                            "[sync] 冲突感知路径单条变更已进入检疫，继续应用后续变更: {}.{} {}: {}",
                            change.table_name,
                            change.record_id,
                            change.operation.as_str(),
                            e
                        );
                    }
                    Err(e) => {
                        Self::rollback_and_release_savepoint(conn, &savepoint);
                        apply_result = apply_before;
                        conflict_result = conflict_before;
                        return Err(e);
                    }
                }
            }

            Self::recompute_derived_ref_counts_if_relevant(conn, changes)?;
            Self::persist_id_aliases(conn, &id_aliases)?;
            Self::validate_no_new_fk_violations(conn, &fk_baseline, &fk_batch_tables)?;

            Ok(())
        })();

        match inner {
            Ok(()) => {
                if let Err(e) = conn.execute_batch("COMMIT;") {
                    let _ = conn.execute_batch("ROLLBACK;");
                    let _ = if original_fk == 0 {
                        conn.execute_batch("PRAGMA foreign_keys = OFF;")
                    } else {
                        conn.execute_batch("PRAGMA foreign_keys = ON;")
                    };
                    return Err(SyncError::Database(format!("提交事务失败: {}", e)));
                }
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                let _ = if original_fk == 0 {
                    conn.execute_batch("PRAGMA foreign_keys = OFF;")
                } else {
                    conn.execute_batch("PRAGMA foreign_keys = ON;")
                };
                return Err(e);
            }
        }

        let _ = if original_fk == 0 {
            conn.execute_batch("PRAGMA foreign_keys = OFF;")
        } else {
            conn.execute_batch("PRAGMA foreign_keys = ON;")
        };

        tracing::info!(
            "[sync] 冲突感知应用完成: applied={}, rejected={}, conflicts_saved={}",
            conflict_result.applied,
            conflict_result.rejected,
            conflict_result.conflicts_saved
        );

        Ok((apply_result, conflict_result))
    }

    /// 检测"云端变更断层"：
    /// 返回 `true` 表示 `since_version` 所指向的变更文件在云端 `min_available_version` 之前
    /// 已被 prune 删除，**客户端无法只靠增量恢复到一致**。调用方应：
    /// - 引导用户走一次 full-snapshot 同步（重新拉取每张表的最新记录）
    /// - 或者退化到只同步"当前快照"而抛弃中间断层
    pub fn has_prune_gap(since_version: u64, min_available_version: Option<u64>) -> bool {
        match min_available_version {
            Some(min) => since_version > 0 && since_version < min,
            None => false,
        }
    }

    /// 获取云端当前可用的最小变更版本号（用于断层检测）
    pub async fn get_min_available_change_version(
        storage: &dyn CloudStorage,
    ) -> Result<Option<u64>, SyncError> {
        let list = storage
            .list_outcome(Self::CHANGES_PREFIX)
            .await
            .map_err(|e| SyncError::Network(format!("列出变更文件失败: {}", e)))?;
        if list.truncated {
            return Err(SyncError::Network(
                "云端变更列表被截断，无法安全判断最小可用版本".to_string(),
            ));
        }
        let files = list.files;

        let mut min_version: Option<u64> = None;
        for file in &files {
            if let Some(raw) = Self::parse_version_from_key(&file.key) {
                let v = Self::normalize_version_to_seconds(raw);
                min_version = Some(match min_version {
                    Some(cur) => cur.min(v),
                    None => v,
                });
            }
        }
        Ok(min_version)
    }

    /// 检查表是否拥有指定列
    fn table_has_column(conn: &Connection, table_name: &str, col_name: &str) -> bool {
        let table_ident = match Self::quote_identifier(table_name) {
            Ok(t) => t,
            Err(_) => return false,
        };
        let sql = format!("PRAGMA table_info({})", table_ident);
        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(_) => return false,
        };
        stmt.query_map([], |row| row.get::<_, String>(1))
            .map(|rows| rows.filter_map(|r| r.ok()).any(|name| name == col_name))
            .unwrap_or(false)
    }

    /// 获取列的声明类型（用于 tombstone 写入时选择 INTEGER vs TEXT）
    ///
    /// 返回 `PRAGMA table_info` 里的 type 列（原始声明，如 "TEXT" / "INTEGER" / ""）。
    /// SQLite 的 type affinity 规则：只要声明类型包含 "INT" 就是 INTEGER affinity。
    fn get_column_declared_type(
        conn: &Connection,
        table_name: &str,
        col_name: &str,
    ) -> Option<String> {
        let table_ident = Self::quote_identifier(table_name).ok()?;
        let sql = format!("PRAGMA table_info({})", table_ident);
        let mut stmt = conn.prepare(&sql).ok()?;
        let rows = stmt
            .query_map([], |row| {
                let name: String = row.get(1)?;
                let ty: String = row.get(2)?;
                Ok((name, ty))
            })
            .ok()?;
        for r in rows.flatten() {
            if r.0 == col_name {
                return Some(r.1);
            }
        }
        None
    }

    fn ensure_delete_versions_table(conn: &Connection) -> Result<(), SyncError> {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS __sync_delete_versions (
                table_name TEXT NOT NULL,
                record_id TEXT NOT NULL,
                changed_at TEXT NOT NULL,
                source_device_id TEXT NOT NULL,
                source_seq INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (table_name, record_id)
            );
            "#,
        )
        .map_err(|error| {
            SyncError::Database(format!("创建 __sync_delete_versions 失败: {}", error))
        })
    }

    fn compare_operation_versions(
        left: &DeleteVersion,
        right: &DeleteVersion,
    ) -> std::cmp::Ordering {
        let base = Self::compare_lww_timestamps(
            &left.changed_at,
            &left.source_device_id,
            "",
            &right.changed_at,
            &right.source_device_id,
            "",
        );
        if base == std::cmp::Ordering::Equal {
            left.source_seq.cmp(&right.source_seq)
        } else {
            base
        }
    }

    fn stored_delete_version(
        conn: &Connection,
        table_name: &str,
        record_id: &str,
    ) -> Result<Option<DeleteVersion>, SyncError> {
        Self::ensure_delete_versions_table(conn)?;
        conn.query_row(
            "SELECT changed_at, source_device_id, source_seq
             FROM __sync_delete_versions WHERE table_name=?1 AND record_id=?2",
            params![table_name, record_id],
            |row| {
                let seq: i64 = row.get(2)?;
                Ok(DeleteVersion {
                    changed_at: row.get(0)?,
                    source_device_id: row.get(1)?,
                    source_seq: seq.max(0) as u64,
                })
            },
        )
        .optional()
        .map_err(|error| SyncError::Database(format!("读取 DELETE 版本失败: {}", error)))
    }

    fn current_delete_version(
        conn: &Connection,
        table_name: &str,
        record_id: &str,
        id_column: &str,
    ) -> Result<Option<DeleteVersion>, SyncError> {
        if let Some(version) = Self::stored_delete_version(conn, table_name, record_id)? {
            return Ok(Some(version));
        }

        if Self::table_has_column(conn, table_name, "deleted_at") {
            if let Some(local) = Self::get_record_data(conn, table_name, record_id, id_column)? {
                if let Some(changed_at) = local
                    .get("deleted_at")
                    .and_then(Self::timestamp_value_to_lww_string)
                {
                    let source_device_id = local
                        .get("device_id")
                        .and_then(|value| value.as_str())
                        .filter(|value| !value.trim().is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(crate::cloud_storage::get_device_id);
                    return Ok(Some(DeleteVersion {
                        changed_at,
                        source_device_id,
                        source_seq: 0,
                    }));
                }
            }
        }

        let has_change_log: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__change_log')",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_change_log {
            return Ok(None);
        }
        conn.query_row(
            "SELECT changed_at FROM __change_log
             WHERE table_name=?1 AND record_id=?2 AND upper(operation)='DELETE'
             ORDER BY id DESC LIMIT 1",
            params![table_name, record_id],
            |row| {
                Ok(DeleteVersion {
                    changed_at: row.get(0)?,
                    source_device_id: crate::cloud_storage::get_device_id(),
                    source_seq: 0,
                })
            },
        )
        .optional()
        .map_err(|error| SyncError::Database(format!("读取本地 DELETE 日志失败: {}", error)))
    }

    fn change_version(change: &SyncChangeWithData) -> DeleteVersion {
        let changed_at = change
            .data
            .as_ref()
            .and_then(|data| data.get("updated_at"))
            .and_then(Self::timestamp_value_to_lww_string)
            .unwrap_or_else(|| change.changed_at.clone());
        DeleteVersion {
            changed_at,
            source_device_id: change
                .source_device_id
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(crate::cloud_storage::get_device_id),
            source_seq: change.source_seq.unwrap_or(0),
        }
    }

    fn upsert_blocked_by_delete_version(
        conn: &Connection,
        change: &SyncChangeWithData,
        id_column: &str,
    ) -> Result<bool, SyncError> {
        let Some(delete_version) =
            Self::current_delete_version(conn, &change.table_name, &change.record_id, id_column)?
        else {
            return Ok(false);
        };
        let upsert_version = Self::change_version(change);
        Ok(
            Self::compare_operation_versions(&delete_version, &upsert_version)
                != std::cmp::Ordering::Less,
        )
    }

    fn record_delete_version(
        conn: &Connection,
        change: &SyncChangeWithData,
    ) -> Result<(), SyncError> {
        Self::ensure_delete_versions_table(conn)?;
        let incoming = Self::change_version(change);
        if let Some(existing) =
            Self::stored_delete_version(conn, &change.table_name, &change.record_id)?
        {
            if Self::compare_operation_versions(&existing, &incoming) != std::cmp::Ordering::Less {
                return Ok(());
            }
        }
        conn.execute(
            "INSERT INTO __sync_delete_versions
             (table_name, record_id, changed_at, source_device_id, source_seq)
             VALUES(?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(table_name, record_id) DO UPDATE SET
               changed_at=excluded.changed_at,
               source_device_id=excluded.source_device_id,
               source_seq=excluded.source_seq",
            params![
                &change.table_name,
                &change.record_id,
                incoming.changed_at,
                incoming.source_device_id,
                i64::try_from(incoming.source_seq).unwrap_or(i64::MAX),
            ],
        )
        .map_err(|error| SyncError::Database(format!("写入 DELETE 版本失败: {}", error)))?;
        Ok(())
    }

    fn clear_delete_version(
        conn: &Connection,
        table_name: &str,
        record_id: &str,
    ) -> Result<(), SyncError> {
        Self::ensure_delete_versions_table(conn)?;
        conn.execute(
            "DELETE FROM __sync_delete_versions WHERE table_name=?1 AND record_id=?2",
            params![table_name, record_id],
        )
        .map_err(|error| SyncError::Database(format!("清理 DELETE 版本失败: {}", error)))?;
        Ok(())
    }

    /// Persist local DELETE operations before old change-log rows are archived.
    pub fn prepare_delete_versions_for_cleanup(
        conn: &Connection,
        local_device_id: &str,
    ) -> Result<(), SyncError> {
        Self::ensure_delete_versions_table(conn)?;
        let has_change_log: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__change_log')",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_change_log {
            return Ok(());
        }
        let mut stmt = conn
            .prepare(
                "SELECT table_name, record_id, changed_at
                 FROM __change_log WHERE upper(operation)='DELETE' ORDER BY id",
            )
            .map_err(|error| SyncError::Database(format!("准备 DELETE 版本回填失败: {}", error)))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| SyncError::Database(format!("查询 DELETE 版本回填失败: {}", error)))?;
        for row in rows {
            let (table_name, record_id, changed_at) = row.map_err(|error| {
                SyncError::Database(format!("读取 DELETE 版本回填失败: {}", error))
            })?;
            Self::record_delete_version(
                conn,
                &SyncChangeWithData {
                    table_name,
                    record_id,
                    operation: ChangeOperation::Delete,
                    data: None,
                    changed_at,
                    change_log_id: None,
                    database_name: None,
                    suppress_change_log: Some(true),
                    source_device_id: Some(local_device_id.to_string()),
                    source_seq: None,
                },
            )?;
        }
        Ok(())
    }

    /// 应用单条变更
    ///
    /// # 返回
    /// * `Ok(true)` - 成功应用
    /// * `Ok(false)` - 跳过（保留兼容语义，当前分支通常不使用）
    /// * `Err` - 应用失败
    fn apply_single_change(
        conn: &Connection,
        change: &SyncChangeWithData,
        id_column: &str,
        allow_field_merge: bool,
    ) -> Result<bool, SyncError> {
        Self::apply_single_change_inner(conn, change, id_column, false, allow_field_merge)
    }

    /// 同 `apply_single_change`，但跳过 LWW 时间戳门（用于 conflict_guard/手动解决已决策场景）
    fn apply_single_change_force(
        conn: &Connection,
        change: &SyncChangeWithData,
        id_column: &str,
        allow_field_merge: bool,
    ) -> Result<bool, SyncError> {
        Self::apply_single_change_inner(conn, change, id_column, true, allow_field_merge)
    }

    fn apply_single_change_inner(
        conn: &Connection,
        change: &SyncChangeWithData,
        id_column: &str,
        skip_lww: bool,
        allow_field_merge: bool,
    ) -> Result<bool, SyncError> {
        Self::ensure_delete_versions_table(conn)?;
        match change.operation {
            ChangeOperation::Delete => {
                Self::ensure_table_allowed_and_exists(conn, &change.table_name)?;
                let table_ident = Self::quote_identifier(&change.table_name)?;
                let has_tombstone = Self::table_has_column(conn, &change.table_name, "deleted_at");
                let pk_columns = Self::primary_key_columns(conn, &change.table_name)?;
                let pk_values = Self::parse_record_key_values(
                    &change.table_name,
                    &change.record_id,
                    &pk_columns,
                )?;
                let pk_predicate = Self::build_primary_key_predicate(&pk_columns)?;
                let pk_predicate_after_set_value =
                    Self::build_primary_key_predicate_from(&pk_columns, 2)?;

                // [LWW drift 保护 - DELETE]
                // 1. 如果云端 changed_at 超出 wall clock "未来 60 秒" → 疑似时钟漂移，
                //    进隔离区（可见、可重放），绝不静默跳过（INV-1：禁止无记录的数据丢弃）
                // 2. 如果本地记录的 updated_at 严格胜过云端 DELETE 的 changed_at → 跳过（LWW）
                if !skip_lww && has_tombstone {
                    if let Some(cloud_ms) = Self::lww_timestamp_millis(&change.changed_at) {
                        let now = chrono::Utc::now();
                        let drift_ms = cloud_ms - now.timestamp_millis();
                        if drift_ms > hlc::MAX_DRIFT_MS {
                            tracing::warn!(
                                "[sync] DELETE 时间戳漂移过大，转入隔离区: {}.{} = {}, drift_ms={}",
                                change.table_name,
                                id_column,
                                change.record_id,
                                drift_ms
                            );
                            return Err(SyncError::ClockDriftSuspected {
                                table: change.table_name.clone(),
                                record_id: change.record_id.clone(),
                                drift_ms,
                            });
                        }

                        if Self::table_has_column(conn, &change.table_name, "updated_at") {
                            let local_data_opt = Self::get_record_data(
                                conn,
                                &change.table_name,
                                &change.record_id,
                                id_column,
                            )?;

                            if let Some(local_data) = local_data_opt {
                                let local_ts = local_data
                                    .get("updated_at")
                                    .and_then(Self::timestamp_value_to_lww_string);
                                if local_ts.as_deref().is_some_and(|local_ts| {
                                    let (local_dev, cloud_dev) = Self::lww_device_pair(
                                        &local_data,
                                        None,
                                        change.source_device_id.as_deref(),
                                    );
                                    Self::compare_lww_timestamps(
                                        local_ts,
                                        local_dev,
                                        &local_data.to_string(),
                                        &change.changed_at,
                                        cloud_dev,
                                        "",
                                    ) == std::cmp::Ordering::Greater
                                }) {
                                    tracing::debug!(
                                        "[sync] LWW skip DELETE: {}.{} = {} (本地 update 更新)",
                                        change.table_name,
                                        id_column,
                                        change.record_id
                                    );
                                    return Ok(false);
                                }
                            }
                        }
                    }
                }

                let affected = if has_tombstone {
                    // [修复] deleted_at 列可能是 TEXT（ISO 字符串）或 INTEGER（毫秒时间戳）。
                    // 检测列的声明类型后用匹配的值写入，避免把 '2026-05-01T...' 写到 INTEGER 列
                    // 导致后续 `row.get::<_, i64>(...)` panic。
                    //
                    // [幂等性修复] 使用 `change.changed_at`（来自云端变更日志）而不是 `now()`，
                    // 确保同一 DELETE 变更被多次回放时写入相同时间戳（否则 checksum 每次都变）。
                    let col_type =
                        Self::get_column_declared_type(conn, &change.table_name, "deleted_at")
                            .unwrap_or_else(|| "TEXT".to_string());
                    let sql = format!(
                        "UPDATE {} SET \"deleted_at\" = ?1 WHERE {} AND \"deleted_at\" IS NULL",
                        table_ident, pk_predicate_after_set_value
                    );
                    let upper = col_type.to_uppercase();
                    if upper.contains("INT") {
                        // 尝试把 changed_at 解析成毫秒时间戳；失败则回落到当前时间
                        let ts_ms = chrono::DateTime::parse_from_rfc3339(&change.changed_at)
                            .map(|dt| dt.timestamp_millis())
                            .unwrap_or_else(|_| chrono::Utc::now().timestamp_millis());
                        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(ts_ms)];
                        for value in &pk_values {
                            params_vec.push(Box::new(value.clone()));
                        }
                        let params_refs: Vec<&dyn rusqlite::ToSql> =
                            params_vec.iter().map(|v| v.as_ref()).collect();
                        conn.execute(&sql, params_refs.as_slice())
                            .map_err(|e| SyncError::Database(format!("软删除记录失败: {}", e)))?
                    } else {
                        // 规范化为 RFC3339 字符串（保留 changed_at 来源但统一格式）
                        let ts = chrono::DateTime::parse_from_rfc3339(&change.changed_at)
                            .map(|dt| dt.with_timezone(&chrono::Utc).to_rfc3339())
                            .unwrap_or_else(|_| change.changed_at.clone());
                        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(ts)];
                        for value in &pk_values {
                            params_vec.push(Box::new(value.clone()));
                        }
                        let params_refs: Vec<&dyn rusqlite::ToSql> =
                            params_vec.iter().map(|v| v.as_ref()).collect();
                        conn.execute(&sql, params_refs.as_slice())
                            .map_err(|e| SyncError::Database(format!("软删除记录失败: {}", e)))?
                    }
                } else {
                    let sql = format!("DELETE FROM {} WHERE {}", table_ident, pk_predicate);
                    let params_refs: Vec<&dyn rusqlite::ToSql> = pk_values
                        .iter()
                        .map(|v| v as &dyn rusqlite::ToSql)
                        .collect();
                    conn.execute(&sql, params_refs.as_slice())
                        .map_err(|e| SyncError::Database(format!("删除记录失败: {}", e)))?
                };

                tracing::debug!(
                    "[sync] DELETE(tombstone={}) {}.{} = {}, affected={}",
                    has_tombstone,
                    change.table_name,
                    id_column,
                    change.record_id,
                    affected
                );
                Self::record_delete_version(conn, change)?;
                Ok(true)
            }
            ChangeOperation::Insert | ChangeOperation::Update => {
                // INSERT/UPDATE 操作：使用 UPSERT (ON CONFLICT DO UPDATE)
                let data = match &change.data {
                    Some(d) => d,
                    None => {
                        // 兼容旧版下载格式（v1）：仅含变更元数据，不含完整行数据。
                        // 对这类历史数据跳过而非失败，避免旧云端数据导致整次同步回滚。
                        if change.database_name.is_none() {
                            tracing::warn!(
                                "[sync] INSERT/UPDATE 缺少数据（旧格式兼容），跳过: {}.{} = {}",
                                change.table_name,
                                id_column,
                                change.record_id
                            );
                            return Ok(false);
                        }

                        return Err(SyncError::Database(format!(
                            "INSERT/UPDATE 缺少 data 字段: {}.{} = {}",
                            change.table_name, id_column, change.record_id
                        )));
                    }
                };

                if Self::upsert_blocked_by_delete_version(conn, change, id_column)? {
                    tracing::debug!(
                        "[sync] 独立 DELETE 版本阻止迟到 UPSERT: {}.{} = {}",
                        change.table_name,
                        id_column,
                        change.record_id
                    );
                    return Ok(false);
                }

                // [LWW 保护] 比较云端 payload 的 updated_at 和本地记录的 updated_at。
                // 若本地更新，跳过应用 —— 避免旧云端变更覆盖较新的本地值（这是 chaos test 暴露的
                // 核心收敛性 bug：没有时间戳门的 UPSERT 会让 "较早的云端 change 在较晚本地写入之后
                // 抵达" 的场景产生分叉）。
                //
                // 跳过的判定需要**双方的 updated_at 都能解析**，否则保持原有行为（直接 UPSERT）。
                if !skip_lww {
                    match Self::evaluate_cloud_upsert_freshness(
                        conn,
                        &change.table_name,
                        &change.record_id,
                        id_column,
                        data,
                        change.source_device_id.as_deref(),
                    ) {
                        UpsertFreshness::Proceed => {}
                        UpsertFreshness::SkipStale => {
                            tracing::debug!(
                                "[sync] LWW skip: {}.{} = {} (本地更新)",
                                change.table_name,
                                id_column,
                                change.record_id
                            );
                            return Ok(false);
                        }
                        UpsertFreshness::SuspectDrift { drift_ms } => {
                            // 疑似时钟漂移：进隔离区（可见、可重放），不静默丢弃。
                            return Err(SyncError::ClockDriftSuspected {
                                table: change.table_name.clone(),
                                record_id: change.record_id.clone(),
                                drift_ms,
                            });
                        }
                    }
                }

                if let Some(local_data) =
                    Self::get_record_data(conn, &change.table_name, &change.record_id, id_column)?
                {
                    if Self::records_semantically_equal_for_sync(&local_data, data) {
                        tracing::debug!(
                            "[sync] 幂等跳过等价变更: {}.{} = {}",
                            change.table_name,
                            id_column,
                            change.record_id
                        );
                        return Ok(false);
                    }
                }

                Self::apply_single_record(
                    conn,
                    &change.table_name,
                    &change.record_id,
                    data,
                    change.database_name.as_deref(),
                    allow_field_merge,
                )?;
                Self::clear_delete_version(conn, &change.table_name, &change.record_id)?;
                Ok(true)
            }
        }
    }

    /// 评估这条云端 UPSERT 的新鲜度
    ///
    /// 两道防线：
    /// 1. **HLC 漂移保护（防恶意超前时间戳）**：如果云端 `updated_at` 比本地 wall clock
    ///    晚超过 `hlc::MAX_DRIFT_MS`（60 秒），视为可疑漂移。注意：可疑漂移**不是**
    ///    静默跳过——调用方必须将其转入隔离区（可见、可重放），否则一台时钟超前
    ///    设备的所有写入会被其他设备永久静默丢弃。参考 CockroachDB / YugabyteDB
    ///    的 MAX_OFFSET 设计。
    /// 2. **LWW 比较（防过时变更覆盖较新本地值）**：如果本地 `updated_at` 严格晚于
    ///    云端 payload，跳过这条云端 change。这保证最终一致性收敛（chaos test 暴露的关键 bug）。
    fn evaluate_cloud_upsert_freshness(
        conn: &Connection,
        table_name: &str,
        record_id: &str,
        id_column: &str,
        cloud_data: &serde_json::Value,
        source_device_id: Option<&str>,
    ) -> UpsertFreshness {
        // 云端 payload 必须带 updated_at
        // 兼容 TEXT（ISO 8601 / HLC 串）和 INTEGER（毫秒时间戳）两种形式——
        // 项目里 resources / chat_v2_todo_lists 等表用的是 INTEGER ms。
        let cloud_str: String = match cloud_data.get("updated_at") {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Number(n)) => {
                // 数值 updated_at：统一转成字符串供下游解析
                n.to_string()
            }
            _ => return UpsertFreshness::Proceed,
        };
        let cloud_str = cloud_str.as_str();

        // ─── 防线 1：漂移 sanity check ───
        // 如果云端时间戳超出本地 wall clock "未来 60 秒"，交由调用方隔离。
        if let Some(cloud_ms) = Self::lww_timestamp_millis(cloud_str) {
            let drift_ms = cloud_ms - chrono::Utc::now().timestamp_millis();
            if drift_ms > hlc::MAX_DRIFT_MS {
                tracing::warn!(
                    "[sync] 云端变更时间戳漂移过大，转入隔离区: table={}, id={}, cloud_ts={}, drift_ms={}",
                    table_name,
                    record_id,
                    cloud_str,
                    drift_ms
                );
                return UpsertFreshness::SuspectDrift { drift_ms };
            }
        }

        // ─── 防线 2：LWW ───
        // 查本地当前 updated_at（要求该表也有 updated_at 列）
        if !Self::table_has_column(conn, table_name, "updated_at") {
            return UpsertFreshness::Proceed;
        }
        let local_data = match Self::get_record_data(conn, table_name, record_id, id_column)
            .ok()
            .flatten()
        {
            Some(data) => data,
            None => return UpsertFreshness::Proceed,
        };

        let local_ts = match local_data
            .get("updated_at")
            .and_then(Self::timestamp_value_to_lww_string)
        {
            Some(ts) => ts,
            None => return UpsertFreshness::Proceed,
        };

        let (local_dev, cloud_dev) =
            Self::lww_device_pair(&local_data, Some(cloud_data), source_device_id);
        if Self::compare_lww_timestamps(
            &local_ts,
            local_dev,
            &local_data.to_string(),
            cloud_str,
            cloud_dev,
            &cloud_data.to_string(),
        ) == std::cmp::Ordering::Greater
        {
            UpsertFreshness::SkipStale
        } else {
            UpsertFreshness::Proceed
        }
    }

    pub(crate) fn records_semantically_equal_for_sync(
        local: &serde_json::Value,
        cloud: &serde_json::Value,
    ) -> bool {
        let cloud_keys: HashSet<String> = match cloud {
            serde_json::Value::Object(obj) => obj.keys().cloned().collect(),
            _ => {
                return Self::canonicalize_sync_value_for_compare(local)
                    == Self::canonicalize_sync_value_for_compare(cloud);
            }
        };

        let local_subset = match local {
            serde_json::Value::Object(obj) => {
                let filtered: serde_json::Map<String, serde_json::Value> = obj
                    .iter()
                    .filter(|(k, _)| cloud_keys.contains(k.as_str()))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                serde_json::Value::Object(filtered)
            }
            _ => local.clone(),
        };

        Self::canonicalize_sync_value_for_compare(&local_subset)
            == Self::canonicalize_sync_value_for_compare(cloud)
    }

    fn canonicalize_sync_value_for_compare(value: &serde_json::Value) -> serde_json::Value {
        const STRIP_KEYS: &[&str] = &[
            "sync_version",
            "local_version",
            "updated_at",
            "last_synced_at",
            "last_attempt_at",
            "indexed_at",
            "mm_indexed_at",
            "remote_version",
            "remote_id",
            "sync_status",
            "content_hash",
        ];

        match value {
            serde_json::Value::Object(obj) => {
                let mut sorted: Vec<(String, serde_json::Value)> = obj
                    .iter()
                    .filter(|(k, _)| !STRIP_KEYS.contains(&k.as_str()))
                    .map(|(k, v)| (k.clone(), Self::canonicalize_sync_value_for_compare(v)))
                    .collect();
                sorted.sort_by(|a, b| a.0.cmp(&b.0));
                serde_json::Value::Object(sorted.into_iter().collect())
            }
            serde_json::Value::Array(arr) => serde_json::Value::Array(
                arr.iter()
                    .map(Self::canonicalize_sync_value_for_compare)
                    .collect(),
            ),
            serde_json::Value::String(s) => {
                let trimmed = s.trim_start();
                if trimmed.starts_with('{') || trimmed.starts_with('[') {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
                        return Self::canonicalize_sync_value_for_compare(&parsed);
                    }
                }
                serde_json::Value::String(s.clone())
            }
            other => other.clone(),
        }
    }

    /// 获取记录的完整数据
    ///
    /// 从指定表中获取记录的完整 JSON 数据。
    ///
    /// # 参数
    /// * `conn` - 数据库连接
    /// * `table_name` - 表名
    /// * `record_id` - 记录 ID
    /// * `id_column` - 主键列名
    ///
    /// # 返回
    /// * `Option<serde_json::Value>` - 记录数据（如果存在）
    pub fn get_record_data(
        conn: &Connection,
        table_name: &str,
        record_id: &str,
        id_column: &str,
    ) -> Result<Option<serde_json::Value>, SyncError> {
        let columns = Self::get_table_columns(conn, table_name)?;
        if columns.is_empty() {
            return Ok(None);
        }
        Self::get_record_data_with_columns(conn, table_name, record_id, id_column, &columns)
    }

    /// 内部辅助：使用预取的列信息查询单条记录，避免重复 PRAGMA 查询
    fn get_record_data_with_columns(
        conn: &Connection,
        table_name: &str,
        record_id: &str,
        _id_column: &str,
        columns: &[String],
    ) -> Result<Option<serde_json::Value>, SyncError> {
        Self::ensure_table_allowed_and_exists(conn, table_name)?;
        let table_ident = Self::quote_identifier(table_name)?;
        let columns_str = columns
            .iter()
            .map(|c| Self::quote_identifier(c))
            .collect::<Result<Vec<_>, _>>()?
            .join(", ");
        let pk_columns = Self::primary_key_columns(conn, table_name)?;
        let values = Self::parse_record_key_values(table_name, record_id, &pk_columns)?;
        let predicate = Self::build_primary_key_predicate(&pk_columns)?;
        let sql = format!(
            "SELECT {} FROM {} WHERE {}",
            columns_str, table_ident, predicate
        );

        let mut result: Option<serde_json::Value> = conn
            .query_row(&sql, rusqlite::params_from_iter(values.iter()), |row| {
                let mut obj = serde_json::Map::new();
                for (i, col) in columns.iter().enumerate() {
                    let value = Self::sqlite_value_to_json(row, i);
                    obj.insert(col.clone(), value);
                }
                Ok(serde_json::Value::Object(obj))
            })
            .optional()
            .map_err(|e| SyncError::Database(format!("查询记录失败: {}", e)))?;

        if result.is_none() && table_name == "questions" {
            let fallback_sql = format!(
                "SELECT {} FROM {} WHERE exam_id = ?1",
                columns_str, table_ident
            );

            let mut stmt = conn
                .prepare(&fallback_sql)
                .map_err(|e| SyncError::Database(format!("查询 questions 兼容记录失败: {}", e)))?;

            let mut rows = stmt
                .query(params![record_id])
                .map_err(|e| SyncError::Database(format!("查询 questions 兼容记录失败: {}", e)))?;

            if let Some(row) = rows
                .next()
                .map_err(|e| SyncError::Database(format!("读取 questions 兼容记录失败: {}", e)))?
            {
                let obj = {
                    let mut obj = serde_json::Map::new();
                    for (i, col) in columns.iter().enumerate() {
                        let value = Self::sqlite_value_to_json(row, i);
                        obj.insert(col.clone(), value);
                    }
                    obj
                };

                if rows
                    .next()
                    .map_err(|e| {
                        SyncError::Database(format!("读取 questions 兼容记录失败: {}", e))
                    })?
                    .is_none()
                {
                    result = Some(serde_json::Value::Object(obj));
                }
            }
        }

        Ok(result)
    }

    /// 获取表的所有列名
    fn get_table_columns(conn: &Connection, table_name: &str) -> Result<Vec<String>, SyncError> {
        Self::ensure_table_allowed_and_exists(conn, table_name)?;
        let table_ident = Self::quote_identifier(table_name)?;
        let sql = format!("PRAGMA table_info({})", table_ident);
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| SyncError::Database(format!("获取表结构失败: {}", e)))?;

        let columns: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| SyncError::Database(format!("查询列名失败: {}", e)))?
            .filter_map(log_and_skip_err)
            .collect();

        Ok(columns)
    }

    fn parse_llm_usage_daily_record_id(
        record_id: &str,
    ) -> Result<(String, String, String, String), SyncError> {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(record_id) {
            if let Some(obj) = value.as_object() {
                let date = obj
                    .get("date")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let caller_type = obj
                    .get("caller_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let model = obj
                    .get("model")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let provider = obj
                    .get("provider")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                if !date.is_empty()
                    && !caller_type.is_empty()
                    && !model.is_empty()
                    && !provider.is_empty()
                {
                    return Ok((date, caller_type, model, provider));
                }
            }
        }

        let parts: Vec<&str> = record_id.splitn(4, '_').collect();
        if parts.len() == 4 {
            return Ok((
                parts[0].to_string(),
                parts[1].to_string(),
                parts[2].to_string(),
                parts[3].to_string(),
            ));
        }

        Err(SyncError::Database(format!(
            "llm_usage_daily 记录ID格式无效: {}",
            record_id
        )))
    }

    fn parse_record_key_values(
        table_name: &str,
        record_id: &str,
        pk_columns: &[String],
    ) -> Result<Vec<String>, SyncError> {
        if pk_columns.is_empty() {
            return Err(SyncError::Database(format!(
                "表 {} 没有可用主键列",
                table_name
            )));
        }

        if pk_columns.len() == 1 {
            return Ok(vec![record_id.to_string()]);
        }

        if table_name == "llm_usage_daily" {
            if let Ok((date, caller_type, model, provider)) =
                Self::parse_llm_usage_daily_record_id(record_id)
            {
                return Ok(vec![date, caller_type, model, provider]);
            }
        }

        if let Ok(value) = serde_json::from_str::<serde_json::Value>(record_id) {
            if let Some(obj) = value.as_object() {
                let mut values = Vec::with_capacity(pk_columns.len());
                for col in pk_columns {
                    let Some(raw) = obj.get(col) else {
                        return Err(SyncError::Database(format!(
                            "复合主键 record_id 缺少字段: {}.{} -> {}",
                            table_name, col, record_id
                        )));
                    };
                    let value =
                        Self::json_value_to_alias_key(raw).unwrap_or_else(|| raw.to_string());
                    values.push(value);
                }
                return Ok(values);
            }

            if let Some(arr) = value.as_array() {
                if arr.len() == pk_columns.len() {
                    let mut values = Vec::with_capacity(pk_columns.len());
                    for raw in arr {
                        values.push(
                            Self::json_value_to_alias_key(raw).unwrap_or_else(|| raw.to_string()),
                        );
                    }
                    return Ok(values);
                }
            }
        }

        let parts: Vec<&str> = record_id.split(':').collect();
        if parts.len() == pk_columns.len() {
            return Ok(parts.into_iter().map(|s| s.to_string()).collect());
        }

        Err(SyncError::Database(format!(
            "复合主键 record_id 无法解析: {}.{} = {}",
            table_name,
            pk_columns.join(","),
            record_id
        )))
    }

    fn build_primary_key_predicate(pk_columns: &[String]) -> Result<String, SyncError> {
        Self::build_primary_key_predicate_from(pk_columns, 1)
    }

    fn build_primary_key_predicate_from(
        pk_columns: &[String],
        first_index: usize,
    ) -> Result<String, SyncError> {
        let mut parts = Vec::with_capacity(pk_columns.len());
        for (idx, col) in pk_columns.iter().enumerate() {
            parts.push(format!(
                "{} = ?{}",
                Self::quote_identifier(col)?,
                first_index + idx
            ));
        }
        Ok(parts.join(" AND "))
    }

    /// 将 SQLite 行值转换为 JSON
    fn sqlite_value_to_json(row: &Row, index: usize) -> serde_json::Value {
        // 尝试不同类型的提取
        if let Ok(v) = row.get::<_, i64>(index) {
            return serde_json::Value::Number(v.into());
        }
        if let Ok(v) = row.get::<_, f64>(index) {
            return serde_json::Number::from_f64(v)
                .map(serde_json::Value::Number)
                .unwrap_or(serde_json::Value::Null);
        }
        if let Ok(v) = row.get::<_, String>(index) {
            return serde_json::Value::String(v);
        }
        if let Ok(v) = row.get::<_, Vec<u8>>(index) {
            // BLOB 类型必须带类型标记，避免与普通 TEXT/base64 字符串混淆。
            use base64::Engine;
            let encoded = base64::engine::general_purpose::STANDARD.encode(&v);
            return serde_json::json!({ "$dsblob": encoded });
        }
        // 默认返回 null
        serde_json::Value::Null
    }

    /// 批量获取变更日志条目的完整记录数据
    ///
    /// 为每个变更日志条目获取其对应记录的完整数据。
    ///
    /// # 参数
    /// * `conn` - 数据库连接
    /// * `entries` - 变更日志条目列表
    /// * `id_column_map` - 表名到主键列名的映射
    ///
    /// # 返回
    /// * 带完整数据的变更列表
    pub fn enrich_changes_with_data(
        conn: &Connection,
        entries: &[ChangeLogEntry],
        id_column_map: Option<&HashMap<String, String>>,
    ) -> Result<Vec<SyncChangeWithData>, SyncError> {
        let mut result = Vec::with_capacity(entries.len());
        // Schema 缓存：避免对同一张表重复执行 PRAGMA table_info (N+1 → 1)
        let mut columns_cache: HashMap<String, Vec<String>> = HashMap::new();

        for entry in entries {
            let id_column = id_column_map
                .and_then(|m| m.get(&entry.table_name))
                .map(|s| s.as_str())
                .unwrap_or("id");

            let data = if entry.operation == ChangeOperation::Delete {
                None
            } else {
                let columns = if let Some(cached) = columns_cache.get(&entry.table_name) {
                    cached
                } else {
                    let cols = Self::get_table_columns(conn, &entry.table_name)?;
                    columns_cache
                        .entry(entry.table_name.clone())
                        .or_insert(cols)
                };

                if columns.is_empty() {
                    None
                } else {
                    Self::get_record_data_with_columns(
                        conn,
                        &entry.table_name,
                        &entry.record_id,
                        id_column,
                        columns,
                    )?
                }
            };

            result.push(SyncChangeWithData::from_entry_with_data(entry, data));
        }

        Ok(result)
    }

    /// 获取数据库的同步状态
    ///
    /// 计算数据库的当前同步状态，包括 schema 版本、数据版本和 checksum。
    ///
    /// # 参数
    /// * `conn` - 数据库连接
    /// * `database_name` - 数据库名称
    ///
    /// # 返回
    /// * `DatabaseSyncState` - 数据库同步状态
    pub fn get_database_sync_state(
        conn: &Connection,
        database_name: &str,
    ) -> Result<DatabaseSyncState, SyncError> {
        // 获取 schema 版本（从 refinery_schema_history 表——迁移系统的权威数据源）
        // 注意：历史版本曾使用 __schema_migrations 表，这里统一到 refinery 权威表，
        // 避免同步状态与迁移系统判定不一致导致伪冲突。
        let schema_version: u32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM refinery_schema_history",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        // 获取数据版本（基于 __change_log 的最大 sync_version，跨库可比较）
        let raw_data_version: u64 = conn
            .query_row(
                "SELECT COALESCE(MAX(sync_version), 0) FROM __change_log",
                [],
                |row| row.get::<_, i64>(0).map(|v| v as u64),
            )
            .unwrap_or(0);
        // 兼容：如果历史 sync_version 被写入了毫秒值（>1e12），归一化为秒
        let data_version = Self::normalize_version_to_seconds(raw_data_version);

        // 获取最后更新时间
        let last_updated_at: Option<String> = conn
            .query_row("SELECT MAX(changed_at) FROM __change_log", [], |row| {
                row.get(0)
            })
            .ok();

        // 计算稳定行流 checksum，用作跨设备漂移信号。
        let checksum = Self::calculate_drift_checksum_v2(conn, database_name)?;

        Ok(DatabaseSyncState {
            schema_version,
            data_version,
            checksum,
            last_updated_at,
        })
    }

    /// 计算数据库 checksum（跨 Rust 版本稳定）
    ///
    /// 对 registry 中参与同步的表按表名、主键、列名稳定排序，流式 hash 每行值。
    /// 这比旧的 COUNT+MAX(updated_at) 更适合作为漂移信号：条数不变、更新时间
    /// 不变但内容被篡改时也能检出。
    fn calculate_drift_checksum_v2(
        conn: &Connection,
        database_name: &str,
    ) -> Result<String, SyncError> {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(database_name.as_bytes());
        hasher.update(b"\n");

        let mut tables = classification::TableClassification::checksum_tables(database_name);
        tables.sort_by(|a, b| a.table_name.cmp(b.table_name));

        for table in &tables {
            let columns = Self::table_column_names(conn, table.table_name)?;
            if columns.is_empty() {
                continue;
            }

            let table_ident = Self::quote_identifier(table.table_name)?;
            let order_columns = Self::checksum_order_columns(table.primary_key, &columns);
            let select_exprs = columns
                .iter()
                .map(|column| {
                    Self::quote_identifier(column).map(|ident| format!("quote({})", ident))
                })
                .collect::<Result<Vec<_>, _>>()?;
            let order_expr = if order_columns.is_empty() {
                "rowid".to_string()
            } else {
                order_columns
                    .iter()
                    .map(|column| Self::quote_identifier(column))
                    .collect::<Result<Vec<_>, _>>()?
                    .join(", ")
            };
            let sql = format!(
                "SELECT {} FROM {} ORDER BY {}",
                select_exprs.join(", "),
                table_ident,
                order_expr
            );

            hasher.update(b"table:");
            hasher.update(table.table_name.as_bytes());
            hasher.update(b"\ncolumns:");
            hasher.update(columns.join(",").as_bytes());
            hasher.update(b"\n");

            let mut stmt = conn.prepare(&sql).map_err(|e| {
                SyncError::Database(format!(
                    "准备 checksum 查询失败 {}: {}",
                    table.table_name, e
                ))
            })?;
            let column_count = stmt.column_count();
            let mut rows = stmt.query([]).map_err(|e| {
                SyncError::Database(format!(
                    "执行 checksum 查询失败 {}: {}",
                    table.table_name, e
                ))
            })?;
            while let Some(row) = rows.next().map_err(|e| {
                SyncError::Database(format!("读取 checksum 行失败 {}: {}", table.table_name, e))
            })? {
                hasher.update(b"row");
                for idx in 0..column_count {
                    let value: String = row.get(idx).map_err(|e| {
                        SyncError::Database(format!(
                            "读取 checksum 列失败 {}[{}]: {}",
                            table.table_name, idx, e
                        ))
                    })?;
                    hasher.update(b"\x1f");
                    hasher.update(value.as_bytes());
                }
                hasher.update(b"\n");
            }
        }

        let hash = hasher.finalize();
        Ok(hex::encode(&hash[..16]))
    }

    fn table_column_names(conn: &Connection, table_name: &str) -> Result<Vec<String>, SyncError> {
        let table_ident = Self::quote_identifier(table_name)?;
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({})", table_ident))
            .map_err(|e| SyncError::Database(format!("查询表列失败 {}: {}", table_name, e)))?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| SyncError::Database(format!("读取表列失败 {}: {}", table_name, e)))?
            .filter_map(|r| r.ok())
            .collect::<Vec<_>>();
        Ok(columns)
    }

    fn checksum_order_columns(primary_key: &str, columns: &[String]) -> Vec<String> {
        let mut order_columns = primary_key
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty() && !s.starts_with('('))
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        order_columns.retain(|column| columns.iter().any(|c| c == column));
        order_columns
    }

    /// 获取变更日志统计信息
    pub fn get_change_log_stats(conn: &Connection) -> Result<ChangeLogStats, SyncError> {
        let total_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM __change_log", [], |row| row.get(0))
            .map_err(|e| SyncError::Database(format!("查询变更日志总数失败: {}", e)))?;

        let pending_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0",
                [],
                |row| row.get(0),
            )
            .map_err(|e| SyncError::Database(format!("查询待同步数量失败: {}", e)))?;

        let synced_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM __change_log WHERE sync_version > 0",
                [],
                |row| row.get(0),
            )
            .map_err(|e| SyncError::Database(format!("查询已同步数量失败: {}", e)))?;

        Ok(ChangeLogStats {
            total_count: total_count as usize,
            pending_count: pending_count as usize,
            synced_count: synced_count as usize,
        })
    }
}

/// 变更日志统计信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeLogStats {
    /// 总记录数
    pub total_count: usize,
    /// 待同步数量
    pub pending_count: usize,
    /// 已同步数量
    pub synced_count: usize,
}

/// 记录快照（用于冲突检测）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordSnapshot {
    /// 表名
    pub table_name: String,
    /// 记录 ID
    pub record_id: String,
    /// 本地版本
    pub local_version: u64,
    /// 同步版本
    pub sync_version: u64,
    /// 更新时间
    pub updated_at: String,
    /// 删除时间（tombstone）
    pub deleted_at: Option<String>,
    /// 记录数据（JSON）
    pub data: serde_json::Value,
}

/// 冲突解决方式
///
/// 注意：此类型包含 serde_json::Value，无法自动导出 TypeScript 类型。
/// 在 TypeScript 中手动定义为：
/// ```typescript
/// type ConflictResolution = "KeepLocal" | "UseCloud" | { Merge: any };
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ConflictResolution {
    /// 保留本地
    KeepLocal,
    /// 使用云端
    UseCloud,
    /// 手动合并的数据
    Merge(serde_json::Value),
}

/// 已解决的记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedRecord {
    /// 数据库名称
    pub database_name: String,
    /// 表名
    pub table_name: String,
    /// 记录 ID
    pub record_id: String,
    /// 解决后的数据
    pub resolved_data: serde_json::Value,
    /// 新版本号
    pub new_version: u64,
    /// 解决时间
    pub resolved_at: String,
    /// 解决设备 ID
    pub resolved_by: String,
}

/// 变更日志操作类型
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ChangeOperation {
    /// 插入
    Insert,
    /// 更新
    Update,
    /// 删除
    Delete,
}

impl ChangeOperation {
    /// 从字符串解析
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_uppercase().as_str() {
            "INSERT" => Some(Self::Insert),
            "UPDATE" => Some(Self::Update),
            "DELETE" => Some(Self::Delete),
            _ => None,
        }
    }

    /// 转换为字符串
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Insert => "INSERT",
            Self::Update => "UPDATE",
            Self::Delete => "DELETE",
        }
    }
}

/// 带完整数据的同步变更
///
/// 扩展 ChangeLogEntry，包含完整的记录数据，用于云同步时传输完整记录。
/// 上传时必须携带 `data`（INSERT/UPDATE），下载后可直接回放，无需再查库。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncChangeWithData {
    /// 表名
    pub table_name: String,
    /// 记录 ID
    pub record_id: String,
    /// 操作类型
    pub operation: ChangeOperation,
    /// 完整记录数据（JSON 格式）
    /// - INSERT/UPDATE: 包含完整记录
    /// - DELETE: None
    pub data: Option<serde_json::Value>,
    /// 变更时间
    pub changed_at: String,
    /// 变更日志 ID（可选，用于追踪）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change_log_id: Option<i64>,
    /// 来源数据库名称（用于多库同步时按库路由）
    /// 值为 DatabaseId::as_str()，如 "chat_v2"、"vfs"、"mistakes"、"llm_usage"
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub database_name: Option<String>,
    /// 回放时是否抑制写入 __change_log（防止下载回放形成回声同步）
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub suppress_change_log: Option<bool>,
    /// 云端变更文件的真实来源设备 ID（v3 payload 解包时填充）
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source_device_id: Option<String>,
    /// 云端变更文件的 per-device source seq（v3 payload 解包时填充）
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source_seq: Option<u64>,
}

impl SyncChangeWithData {
    /// 从 ChangeLogEntry 创建（不含数据，兼容旧链路）
    ///
    /// **注意**：此方法仅用于兼容旧格式下载数据。新上传链路应使用
    /// `enrich_changes_with_data` 确保 INSERT/UPDATE 携带完整数据。
    pub fn from_entry(entry: &ChangeLogEntry) -> Self {
        Self {
            table_name: entry.table_name.clone(),
            record_id: entry.record_id.clone(),
            operation: entry.operation,
            data: None,
            changed_at: entry.changed_at.clone(),
            change_log_id: Some(entry.id),
            database_name: None,
            suppress_change_log: None,
            source_device_id: None,
            source_seq: None,
        }
    }

    /// 从 ChangeLogEntry 创建并附加数据
    pub fn from_entry_with_data(entry: &ChangeLogEntry, data: Option<serde_json::Value>) -> Self {
        let mut data = data;
        if let Some(field_deltas) = entry.field_deltas_json.as_ref() {
            if let Some(serde_json::Value::Object(obj)) = data.as_mut() {
                obj.insert(SYNC_FIELD_DELTAS_KEY.to_string(), field_deltas.clone());
            }
        }

        Self {
            table_name: entry.table_name.clone(),
            record_id: entry.record_id.clone(),
            operation: entry.operation,
            data,
            changed_at: entry.changed_at.clone(),
            change_log_id: Some(entry.id),
            database_name: None,
            suppress_change_log: None,
            source_device_id: None,
            source_seq: None,
        }
    }
}

/// 应用变更的结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyChangesResult {
    /// 成功应用的变更数
    pub success_count: usize,
    /// 失败的变更数
    pub failure_count: usize,
    /// 跳过的变更数（保留字段，当前主要用于非致命跳过场景）
    pub skipped_count: usize,
    /// 因旧格式 INSERT/UPDATE 缺少完整 data payload 而跳过的变更数。
    /// 其他跳过（幂等重复、LWW 本地更新、KeepLocal 本地胜出）不应被当成数据不完整。
    pub skipped_incomplete_count: usize,
    /// 失败的详情
    pub failures: Vec<ApplyChangeFailure>,
    /// 实际成功落地的记录 key (table_name, record_id)
    /// 用于上层精确计算“已被云端覆盖”的本地待上传项
    pub applied_keys: std::collections::HashSet<(String, String)>,
}

impl ApplyChangesResult {
    /// 创建空结果
    pub fn empty() -> Self {
        Self {
            success_count: 0,
            failure_count: 0,
            skipped_count: 0,
            skipped_incomplete_count: 0,
            failures: Vec::new(),
            applied_keys: std::collections::HashSet::new(),
        }
    }

    /// 合并另一个结果
    pub fn merge(&mut self, other: ApplyChangesResult) {
        self.success_count += other.success_count;
        self.failure_count += other.failure_count;
        self.skipped_count += other.skipped_count;
        self.skipped_incomplete_count += other.skipped_incomplete_count;
        self.failures.extend(other.failures);
        self.applied_keys.extend(other.applied_keys);
    }
}

/// 单条变更应用失败的详情
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyChangeFailure {
    /// 表名
    pub table_name: String,
    /// 记录 ID
    pub record_id: String,
    /// 操作类型
    pub operation: String,
    /// 错误信息
    pub error: String,
}

/// 变更日志条目（来自 __change_log 表）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeLogEntry {
    /// 记录 ID（自增）
    pub id: i64,
    /// 表名
    pub table_name: String,
    /// 记录 ID
    pub record_id: String,
    /// 操作类型
    pub operation: ChangeOperation,
    /// 变更时间
    pub changed_at: String,
    /// 同步版本（0 表示未同步）
    pub sync_version: i64,
    /// 字段增量元数据（旧格式兼容；自动字段合并不再依赖 counter delta）
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub field_deltas_json: Option<serde_json::Value>,
}

impl ChangeLogEntry {
    /// 从数据库行解析
    pub fn from_row(row: &Row) -> Result<Self, rusqlite::Error> {
        let operation_str: String = row.get(3)?;
        let operation =
            ChangeOperation::from_str(&operation_str).unwrap_or(ChangeOperation::Update);

        Ok(Self {
            id: row.get(0)?,
            table_name: row.get(1)?,
            record_id: row.get(2)?,
            operation,
            changed_at: row.get(4)?,
            sync_version: row.get(5)?,
            field_deltas_json: if row.as_ref().column_count() > 6 {
                match row.get::<_, Option<String>>(6)? {
                    Some(raw) => Some(serde_json::from_str(&raw).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(6, Type::Text, Box::new(e))
                    })?),
                    None => None,
                }
            } else {
                None
            },
        })
    }
}

/// 云端变更载荷（v2 格式：含完整记录数据）
///
/// 上传/下载时使用的完整载荷，包含每条变更的实际行数据。
/// 相比旧的 `PendingChanges`（仅含 ChangeLogEntry 元数据），
/// 此格式确保下载端可以直接回放 INSERT/UPDATE 操作。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncChangesPayload {
    /// 带完整数据的变更列表
    pub changes: Vec<SyncChangeWithData>,
    /// 变更总数
    pub total_count: usize,
    /// 上传设备 ID
    pub device_id: String,
    /// 格式版本号（2 = 带完整数据）
    #[serde(default = "default_format_version")]
    pub format_version: u32,
    /// 上传设备内单调序号（v3）
    #[serde(default)]
    pub source_seq: u64,
    /// 上传设备 ID（v3，保留 device_id 兼容旧字段）
    #[serde(default)]
    pub source_device_id: String,
}

fn default_format_version() -> u32 {
    2
}

const SYNC_FIELD_DELTAS_KEY: &str = "__sync_field_deltas";

/// 待同步变更集合
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingChanges {
    /// 变更日志条目列表
    pub entries: Vec<ChangeLogEntry>,
    /// 按表名分组的变更数量
    pub changes_by_table: HashMap<String, usize>,
    /// 总变更数量
    pub total_count: usize,
    /// 最早的变更时间
    pub earliest_change: Option<String>,
    /// 最晚的变更时间
    pub latest_change: Option<String>,
}

impl PendingChanges {
    /// 创建空的待同步变更
    pub fn empty() -> Self {
        Self {
            entries: Vec::new(),
            changes_by_table: HashMap::new(),
            total_count: 0,
            earliest_change: None,
            latest_change: None,
        }
    }

    /// 从变更日志条目列表构建
    pub fn from_entries(entries: Vec<ChangeLogEntry>) -> Self {
        let mut changes_by_table: HashMap<String, usize> = HashMap::new();
        let mut earliest: Option<String> = None;
        let mut latest: Option<String> = None;

        for entry in &entries {
            *changes_by_table
                .entry(entry.table_name.clone())
                .or_insert(0) += 1;

            let changed_at = &entry.changed_at;
            match &earliest {
                None => earliest = Some(changed_at.clone()),
                Some(e) if changed_at < e => earliest = Some(changed_at.clone()),
                _ => {}
            }
            match &latest {
                None => latest = Some(changed_at.clone()),
                Some(l) if changed_at > l => latest = Some(changed_at.clone()),
                _ => {}
            }
        }

        let total_count = entries.len();

        Self {
            entries,
            changes_by_table,
            total_count,
            earliest_change: earliest,
            latest_change: latest,
        }
    }

    /// 是否有待同步的变更
    pub fn has_changes(&self) -> bool {
        self.total_count > 0
    }

    /// 获取指定表的变更条目
    pub fn get_table_changes(&self, table_name: &str) -> Vec<&ChangeLogEntry> {
        self.entries
            .iter()
            .filter(|e| e.table_name == table_name)
            .collect()
    }

    /// 获取所有变更记录的 ID 列表
    pub fn get_change_ids(&self) -> Vec<i64> {
        self.entries.iter().map(|e| e.id).collect()
    }
}

/// 合并应用结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergeApplicationResult {
    /// 是否成功
    pub success: bool,
    /// 保留本地的记录数
    pub kept_local: usize,
    /// 使用云端的记录数
    pub used_cloud: usize,
    /// 需要更新到云端的记录 ID 列表
    pub records_to_push: Vec<String>,
    /// 需要从云端拉取更新的记录 ID 列表
    pub records_to_pull: Vec<String>,
    /// 错误信息
    pub errors: Vec<String>,
}

impl MergeApplicationResult {
    /// 创建成功结果
    pub fn success(kept_local: usize, used_cloud: usize) -> Self {
        Self {
            success: true,
            kept_local,
            used_cloud,
            records_to_push: Vec::new(),
            records_to_pull: Vec::new(),
            errors: Vec::new(),
        }
    }

    /// 创建失败结果
    pub fn failure(errors: Vec<String>) -> Self {
        Self {
            success: false,
            kept_local: 0,
            used_cloud: 0,
            records_to_push: Vec::new(),
            records_to_pull: Vec::new(),
            errors,
        }
    }
}

/// 同步方向
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum SyncDirection {
    /// 仅上传（本地 -> 云端）
    Upload,
    /// 仅下载（云端 -> 本地）
    Download,
    /// 双向同步
    Bidirectional,
}

impl SyncDirection {
    /// 从字符串解析
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "upload" => Some(Self::Upload),
            "download" => Some(Self::Download),
            "bidirectional" | "both" => Some(Self::Bidirectional),
            _ => None,
        }
    }

    /// 转换为字符串
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Upload => "upload",
            Self::Download => "download",
            Self::Bidirectional => "bidirectional",
        }
    }
}

/// 同步执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncExecutionResult {
    /// 是否成功
    pub success: bool,
    /// 同步方向
    pub direction: SyncDirection,
    /// 上传的变更数量
    pub changes_uploaded: usize,
    /// 下载的变更数量
    pub changes_downloaded: usize,
    /// 检测到的冲突数量
    pub conflicts_detected: usize,
    /// 执行耗时（毫秒）
    pub duration_ms: u64,
    /// 错误信息（如果有）
    pub error_message: Option<String>,
}

impl SyncExecutionResult {
    /// 创建成功结果
    pub fn success(
        direction: SyncDirection,
        uploaded: usize,
        downloaded: usize,
        conflicts: usize,
        duration_ms: u64,
    ) -> Self {
        Self {
            success: true,
            direction,
            changes_uploaded: uploaded,
            changes_downloaded: downloaded,
            conflicts_detected: conflicts,
            duration_ms,
            error_message: None,
        }
    }

    /// 创建失败结果
    pub fn failure(direction: SyncDirection, error: String, duration_ms: u64) -> Self {
        Self {
            success: false,
            direction,
            changes_uploaded: 0,
            changes_downloaded: 0,
            conflicts_detected: 0,
            duration_ms,
            error_message: Some(error),
        }
    }
}

// [P0-2] 让 SyncManager 满足 tombstone 模块需要的 Codec 接口。
// 放在文件顶层（impl 块之外）以便 tombstone.rs 里的函数签名可以引用它。
#[cfg(feature = "data_governance")]
impl tombstone::PayloadCodec for SyncManager {
    fn encode(&self, plaintext: &[u8]) -> Result<Vec<u8>, SyncError> {
        self.encode_payload(plaintext)
    }
    fn decode(&self, data: &[u8]) -> Result<Vec<u8>, SyncError> {
        self.decode_payload(data)
    }
}

impl SyncManager {
    // ========================================================================
    // 文件级云同步：工作区数据库（ws_*.db）+ VFS blobs
    // ========================================================================

    const WORKSPACES_MANIFEST_KEY: &'static str = "data_governance/workspaces_manifest.json";
    const WORKSPACES_MANIFESTS_PREFIX: &'static str = "data_governance/file_manifests/workspaces";
    const WORKSPACES_CLOUD_PREFIX: &'static str = "data_governance/workspaces";
    const BLOBS_MANIFEST_KEY: &'static str = "data_governance/blobs_manifest.json";
    const BLOBS_MANIFESTS_PREFIX: &'static str = "data_governance/file_manifests/blobs";
    const BLOBS_CLOUD_PREFIX: &'static str = "data_governance/blobs";
    const ASSETS_MANIFEST_KEY: &'static str = "data_governance/assets_manifest.json";
    const ASSETS_MANIFESTS_PREFIX: &'static str = "data_governance/file_manifests/assets";
    const ASSETS_CLOUD_PREFIX: &'static str = "data_governance/assets";
    const ASSET_OBJECTS_PREFIX: &'static str = "data_governance/asset_objects";
    const DIVERGED_CHECKSUM_SENTINEL: &'static str = "__cloud_diverged_same_version__";
    const ACTIVE_ASSET_DIRS: [&'static str; 7] = [
        "images",
        "notes_assets",
        "documents",
        "subjects",
        "textbooks",
        "audio",
        "videos",
    ];

    fn file_mtime_rfc3339(path: &std::path::Path) -> String {
        std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .map(chrono::DateTime::<chrono::Utc>::from)
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339())
    }

    fn append_only_file_manifest_key(prefix: &str, device_id: &str) -> String {
        format!(
            "{}/{}/{}-{}.json",
            prefix,
            device_id,
            chrono::Utc::now().timestamp_millis(),
            uuid::Uuid::new_v4()
        )
    }

    async fn publish_file_manifest<T: Serialize>(
        &self,
        storage: &dyn CloudStorage,
        prefix: &str,
        manifest: &T,
        label: &str,
    ) -> Result<(), SyncError> {
        let json = serde_json::to_vec(manifest)
            .map_err(|error| SyncError::Database(format!("序列化{}清单失败: {}", label, error)))?;
        let payload = self.encode_payload(&json)?;
        let key = Self::append_only_file_manifest_key(prefix, &self.device_id);
        storage.put(&key, &payload).await.map_err(|error| {
            SyncError::Network(format!("发布{}清单失败 {}: {}", label, key, error))
        })
    }

    fn file_transfer_progress(
        progress: Option<&FileTransferProgressCallback>,
        item: String,
    ) -> Option<Box<dyn Fn(u64, u64) + Send + Sync>> {
        progress.cloned().map(|progress| {
            Box::new(move |done, total| {
                progress(item.clone(), done, total);
            }) as Box<dyn Fn(u64, u64) + Send + Sync>
        })
    }

    /// 文件级 LWW：本地文件是否胜过云端清单条目。
    ///
    /// [P0 收敛性] 设备分量必须中性（双方相同）：旧实现用 "local-file" vs
    /// "cloud-file"（'l' > 'c'），mtime 平局时每台设备都判本地获胜，导致
    /// 两台设备各自反复上传、永不收敛。平局改由内容哈希（随数据传播、
    /// 所有设备一致可见）决定，保证全设备得出同一结论。
    fn local_file_wins(
        local_updated_at: &str,
        cloud_updated_at: &str,
        local_content_hash: &str,
        cloud_content_hash: &str,
    ) -> bool {
        if cloud_updated_at.trim().is_empty() {
            return true;
        }
        Self::compare_lww_timestamps(
            local_updated_at,
            "",
            local_content_hash,
            cloud_updated_at,
            "",
            cloud_content_hash,
        ) == std::cmp::Ordering::Greater
    }

    fn timestamp_after(candidate: &str, reference: &str) -> bool {
        if candidate.trim().is_empty() || reference.trim().is_empty() {
            return false;
        }
        match (
            Self::parse_flexible_timestamp(candidate),
            Self::parse_flexible_timestamp(reference),
        ) {
            (Some(candidate), Some(reference)) => candidate > reference,
            _ => candidate > reference,
        }
    }

    fn quote_sql_string(value: &str) -> String {
        format!("'{}'", value.replace('\'', "''"))
    }

    fn create_workspace_upload_snapshot(
        path: &std::path::Path,
        ws_id: &str,
    ) -> Result<std::path::PathBuf, SyncError> {
        let snapshot = path.with_file_name(format!(
            "{}.sync-snapshot-{}.db",
            ws_id,
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let _ = std::fs::remove_file(&snapshot);
        let conn = rusqlite::Connection::open(path)
            .map_err(|e| SyncError::Database(format!("打开工作区数据库失败 {:?}: {}", path, e)))?;
        let _ = conn.execute_batch("PRAGMA busy_timeout = 5000;");
        let sql = format!(
            "VACUUM INTO {};",
            Self::quote_sql_string(&snapshot.to_string_lossy())
        );
        conn.execute_batch(&sql).map_err(|e| {
            let _ = std::fs::remove_file(&snapshot);
            SyncError::Database(format!("创建工作区数据库一致快照失败 {:?}: {}", path, e))
        })?;
        Ok(snapshot)
    }

    fn save_conflict_copy(path: &std::path::Path, device_id: &str) -> Result<(), SyncError> {
        if !path.exists() {
            return Ok(());
        }
        let ts = chrono::Utc::now().format("%Y%m%d%H%M%S%3f");
        let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("file");
        let conflict_name = format!("{}.conflict-{}-{}", file_name, device_id, ts);
        let dest = path.with_file_name(conflict_name);
        std::fs::copy(path, &dest)
            .map(|_| ())
            .map_err(|e| SyncError::Database(format!("保存冲突副本失败 {:?}: {}", dest, e)))
    }

    fn verify_sqlite_integrity(path: &std::path::Path) -> Result<(), SyncError> {
        let conn = rusqlite::Connection::open(path).map_err(|e| {
            SyncError::Database(format!("打开下载的 SQLite 文件失败 {:?}: {}", path, e))
        })?;
        let result: String = conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(|e| {
                SyncError::Database(format!("执行 integrity_check 失败 {:?}: {}", path, e))
            })?;
        if result.eq_ignore_ascii_case("ok") {
            Ok(())
        } else {
            Err(SyncError::Database(format!(
                "下载的 SQLite 文件完整性检查失败 {:?}: {}",
                path, result
            )))
        }
    }

    /// 同步工作区数据库（ws_*.db）与云端
    ///
    /// 策略：
    /// - 本地有，与云端 sha256 不同 → 上传（本地优先，保护运行中工作区）
    /// - 云端有，本地没有 → 下载
    /// - 失败不阻断主流程
    pub async fn sync_workspace_databases(
        &self,
        storage: &dyn CloudStorage,
        active_dir: &std::path::Path,
        direction: SyncDirection,
    ) -> Result<(), SyncError> {
        self.sync_workspace_databases_with_progress(storage, active_dir, direction, None)
            .await
    }

    pub async fn sync_workspace_databases_with_progress(
        &self,
        storage: &dyn CloudStorage,
        active_dir: &std::path::Path,
        direction: SyncDirection,
        progress: Option<FileTransferProgressCallback>,
    ) -> Result<(), SyncError> {
        let workspaces_dir = active_dir.join("workspaces");

        // 1. 下载云端清单，并先消费 workspace tombstone，防止已删工作区复活。
        let mut cloud_manifest = self.download_workspaces_manifest(storage).await?;
        let instance_id = self.ensure_remote_instance_id(storage).await?;
        let state_store = SyncStateStore::open_default()?;
        let (workspace_tombstones, workspace_tombstone_advances) =
            tombstone::download_workspace_tombstones_after(storage, self, |source| {
                state_store.get_tombstone_watermark(&instance_id, source, "workspaces")
            })
            .await?;
        if !workspace_tombstones.entries.is_empty() {
            let mut manifest_changed = false;
            for (ws_id, entry) in &workspace_tombstones.entries {
                let local_db = workspaces_dir.join(format!("{}.db", ws_id));
                if cloud_manifest.entries.get(ws_id).is_some_and(|cloud| {
                    Self::timestamp_after(&cloud.updated_at, &entry.deleted_at)
                }) {
                    tracing::info!(
                        "[sync] 跳过过期 workspace tombstone，云端数据库更新: {} cloud_updated_at>{}",
                        ws_id,
                        entry.deleted_at
                    );
                    continue;
                }
                if tombstone::path_modified_after(&local_db, &entry.deleted_at) {
                    tracing::info!(
                        "[sync] 跳过过期 workspace tombstone，本地数据库更新: {} deleted_at={}",
                        ws_id,
                        entry.deleted_at
                    );
                    continue;
                }
                if direction != SyncDirection::Download {
                    let key = cloud_manifest
                        .entries
                        .get(ws_id)
                        .and_then(|manifest| manifest.object_key.clone())
                        .unwrap_or_else(|| {
                            format!("{}/{}.db", Self::WORKSPACES_CLOUD_PREFIX, ws_id)
                        });
                    if let Err(e) = storage.delete(&key).await {
                        tracing::warn!("[sync] 删除云端工作区数据库失败（忽略）: {}: {}", key, e);
                    }
                }
                if local_db.exists() {
                    // [P2] tombstone 驱动的本地删除前保留冲突副本：
                    // "本设备在对端删除之前的未上传编辑" 不应被无备份清除。
                    if let Err(e) = Self::save_conflict_copy(&local_db, &self.device_id) {
                        tracing::warn!(
                            "[sync] tombstone 删除前保存工作区冲突副本失败: {}: {}",
                            ws_id,
                            e
                        );
                    }
                    let _ = std::fs::remove_file(&local_db);
                }
                let local_wal = workspaces_dir.join(format!("{}.db-wal", ws_id));
                if local_wal.exists() {
                    let _ = std::fs::remove_file(&local_wal);
                }
                let local_shm = workspaces_dir.join(format!("{}.db-shm", ws_id));
                if local_shm.exists() {
                    let _ = std::fs::remove_file(&local_shm);
                }
                // Always remove from this round's in-memory view. Download-only
                // must not rehydrate the just-deleted workspace from a stale
                // remote manifest later in the same call.
                if cloud_manifest.entries.remove(ws_id).is_some() {
                    manifest_changed = true;
                }
            }
            if direction != SyncDirection::Download && manifest_changed {
                cloud_manifest.updated_at = chrono::Utc::now().to_rfc3339();
                self.publish_file_manifest(
                    storage,
                    Self::WORKSPACES_MANIFESTS_PREFIX,
                    &cloud_manifest,
                    "工作区",
                )
                .await?;
            }
        }
        for advance in workspace_tombstone_advances {
            state_store.set_tombstone_watermark(
                &instance_id,
                &advance.source_device_id,
                "workspaces",
                advance.last_applied_offset,
            )?;
        }

        // 2. 扫描本地 ws_*.db
        let mut local_entries: HashMap<String, (std::path::PathBuf, String, u64, String)> =
            HashMap::new();
        if workspaces_dir.exists() {
            for entry in std::fs::read_dir(&workspaces_dir)
                .map_err(|e| SyncError::Database(format!("读取工作区目录失败: {}", e)))?
            {
                let entry =
                    entry.map_err(|e| SyncError::Database(format!("读取目录条目失败: {}", e)))?;
                let path = entry.path();
                let name = path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                if !name.starts_with("ws_") || !name.ends_with(".db") {
                    continue;
                }
                let ws_id = name.trim_end_matches(".db").to_string();
                // [P1 Fix] 使用 PASSIVE 模式代替 TRUNCATE，避免与并发写入者竞争。
                // PASSIVE 模式不会阻塞其他连接，也不会清空正在使用的 WAL 文件。
                // 设置 busy_timeout 防止在数据库被锁定时立即失败。
                if let Ok(conn) = rusqlite::Connection::open(&path) {
                    let _ = conn.execute_batch("PRAGMA busy_timeout = 1000");
                    let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE)");
                }
                let sha256 = crate::backup_common::calculate_file_hash(&path).map_err(|e| {
                    SyncError::Database(format!("计算工作区数据库校验和失败 {:?}: {}", path, e))
                })?;
                let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                let updated_at = Self::file_mtime_rfc3339(&path);
                local_entries.insert(ws_id, (path, sha256, size, updated_at));
            }
        }

        // 3. 上传本地新增或已修改的 ws_*.db
        let mut new_manifest = cloud_manifest.clone();
        let mut failures: Vec<String> = Vec::new();
        if direction != SyncDirection::Download {
            for (ws_id, (path, sha256, size, local_updated_at)) in &local_entries {
                let should_upload = match cloud_manifest.entries.get(ws_id) {
                    None => true,
                    Some(ce) => {
                        // 变更检测必须比较同一度量：本地活动文件哈希 vs 上次上传时的
                        // 源文件哈希（source_sha256）。与传输快照哈希（sha256，VACUUM
                        // 重写页布局后几乎必然不同）比较会导致每次同步都误判为已变更。
                        // 本地文件恰好是云端快照本身（刚下载所得）也视为未变更。
                        let unchanged = ce.source_sha256.as_deref() == Some(sha256.as_str())
                            || ce.sha256 == *sha256;
                        !unchanged
                            && Self::local_file_wins(
                                local_updated_at,
                                &ce.updated_at,
                                sha256,
                                ce.source_sha256.as_deref().unwrap_or(&ce.sha256),
                            )
                    }
                };
                if should_upload {
                    let snapshot = match Self::create_workspace_upload_snapshot(path, ws_id) {
                        Ok(snapshot) => snapshot,
                        Err(e) => {
                            tracing::warn!("[sync] 工作区数据库快照失败: {}: {}", ws_id, e);
                            failures.push(format!("{}: {}", ws_id, e));
                            continue;
                        }
                    };
                    let snapshot_hash = match crate::backup_common::calculate_file_hash(&snapshot) {
                        Ok(hash) => hash,
                        Err(e) => {
                            let _ = std::fs::remove_file(&snapshot);
                            failures.push(format!("{}: {}", ws_id, e));
                            continue;
                        }
                    };
                    let snapshot_size = std::fs::metadata(&snapshot)
                        .map(|m| m.len())
                        .unwrap_or(*size);
                    let key = format!(
                        "{}/{}/{}.db",
                        Self::WORKSPACES_CLOUD_PREFIX,
                        ws_id,
                        snapshot_hash
                    );
                    let transfer_progress = Self::file_transfer_progress(
                        progress.as_ref(),
                        format!("工作区数据库 {}", ws_id),
                    );
                    match storage.put_file(&key, &snapshot, transfer_progress).await {
                        Ok(_) => {
                            new_manifest.entries.insert(
                                ws_id.clone(),
                                WorkspaceEntry {
                                    sha256: snapshot_hash,
                                    size: snapshot_size,
                                    updated_at: local_updated_at.clone(),
                                    source_sha256: Some(sha256.clone()),
                                    device_id: Some(self.device_id.clone()),
                                    object_key: Some(key.clone()),
                                },
                            );
                            tracing::info!("[sync] 工作区数据库已上传: {}", ws_id);
                        }
                        Err(e) => {
                            tracing::warn!("[sync] 工作区数据库上传失败（跳过）: {}: {}", ws_id, e);
                            failures.push(format!("{}: {}", ws_id, e));
                        }
                    }
                    let _ = std::fs::remove_file(&snapshot);
                }
            }
        }

        // 4. 下载云端较新或本地缺失的 ws_*.db
        if direction != SyncDirection::Upload {
            if !workspaces_dir.exists() {
                let _ = std::fs::create_dir_all(&workspaces_dir);
            }
            for (ws_id, cloud_entry) in &cloud_manifest.entries {
                let should_download = match local_entries.get(ws_id) {
                    None => true,
                    Some((_path, sha256, _size, local_updated_at)) => {
                        // 与上传侧对称：本地活动文件与云端源哈希一致，或本地文件
                        // 本身就是该快照（之前下载所得），都视为未变更。
                        let unchanged = cloud_entry.source_sha256.as_deref()
                            == Some(sha256.as_str())
                            || *sha256 == cloud_entry.sha256;
                        !unchanged
                            && !Self::local_file_wins(
                                local_updated_at,
                                &cloud_entry.updated_at,
                                sha256,
                                cloud_entry
                                    .source_sha256
                                    .as_deref()
                                    .unwrap_or(&cloud_entry.sha256),
                            )
                    }
                };
                if should_download {
                    let dest = workspaces_dir.join(format!("{}.db", ws_id));
                    if dest.exists() {
                        if let Err(e) = Self::save_conflict_copy(&dest, &self.device_id) {
                            tracing::warn!("[sync] 保存工作区数据库冲突副本失败: {}: {}", ws_id, e);
                        }
                    }
                    let key = cloud_entry.object_key.clone().unwrap_or_else(|| {
                        format!("{}/{}.db", Self::WORKSPACES_CLOUD_PREFIX, ws_id)
                    });
                    let transfer_progress = Self::file_transfer_progress(
                        progress.as_ref(),
                        format!("工作区数据库 {}", ws_id),
                    );
                    match storage
                        .get_file(&key, &dest, Some(&cloud_entry.sha256), transfer_progress)
                        .await
                    {
                        Ok(_) => {
                            // 新主库文件已替换 dest，但旧库遗留的 -wal/-shm 还在：
                            // SQLite 打开时会尝试关联它们，旧 WAL 帧可能污染新库
                            // 或导致打开失败。必须在完整性校验前清掉。
                            for suffix in ["-wal", "-shm"] {
                                let side = workspaces_dir.join(format!("{}.db{}", ws_id, suffix));
                                if side.exists() {
                                    let _ = std::fs::remove_file(&side);
                                }
                            }
                            if let Err(e) = Self::verify_sqlite_integrity(&dest) {
                                let _ = std::fs::remove_file(&dest);
                                tracing::warn!(
                                    "[sync] 工作区数据库完整性检查失败（已删除）: {}: {}",
                                    ws_id,
                                    e
                                );
                                failures.push(format!("{}: {}", ws_id, e));
                                continue;
                            }
                            tracing::info!("[sync] 工作区数据库已下载: {}", ws_id);
                        }
                        Err(e) => {
                            tracing::warn!("[sync] 工作区数据库下载失败（跳过）: {}: {}", ws_id, e);
                            failures.push(format!("{}: {}", ws_id, e));
                        }
                    }
                }
            }
        }

        // 5. 仅在有上传时更新云端清单
        // [P2 D9-lite] 共享单文件清单存在多设备并发 read-modify-write 互相覆盖
        // 条目的竞态。写前重新拉取最新云端清单并做条目级合并（我们改动的条目
        // 按 LWW 与对端并发写入比较），把覆盖窗口从"整个同步过程"缩到毫秒级。
        if direction != SyncDirection::Download && new_manifest.entries != cloud_manifest.entries {
            let mut merged = match self.download_workspaces_manifest(storage).await {
                Ok(fresh) => fresh,
                Err(e) => {
                    tracing::warn!("[sync] 写前刷新工作区清单失败，退回本地视图: {}", e);
                    cloud_manifest.clone()
                }
            };
            for (ws_id, entry) in &new_manifest.entries {
                let ours_changed = cloud_manifest.entries.get(ws_id) != Some(entry);
                if !ours_changed {
                    continue;
                }
                let theirs_newer = merged.entries.get(ws_id).is_some_and(|theirs| {
                    Self::local_file_wins(
                        &theirs.updated_at,
                        &entry.updated_at,
                        &theirs.sha256,
                        &entry.sha256,
                    )
                });
                if !theirs_newer {
                    merged.entries.insert(ws_id.clone(), entry.clone());
                }
            }
            // 本轮显式移除的条目（tombstone 驱动）在合并结果中同样移除
            for ws_id in cloud_manifest.entries.keys() {
                if !new_manifest.entries.contains_key(ws_id) {
                    merged.entries.remove(ws_id);
                }
            }
            merged.updated_at = chrono::Utc::now().to_rfc3339();
            self.publish_file_manifest(
                storage,
                Self::WORKSPACES_MANIFESTS_PREFIX,
                &merged,
                "工作区",
            )
            .await?;
        }

        if !failures.is_empty() {
            return Err(SyncError::Network(format!(
                "工作区数据库同步部分失败: {}",
                failures.join("; ")
            )));
        }

        Ok(())
    }

    async fn download_workspaces_manifest(
        &self,
        storage: &dyn CloudStorage,
    ) -> Result<WorkspacesManifest, SyncError> {
        let mut manifests = Vec::new();
        if let Some(bytes) = storage
            .get(Self::WORKSPACES_MANIFEST_KEY)
            .await
            .map_err(|error| SyncError::Network(format!("获取旧工作区清单失败: {}", error)))?
        {
            let decoded = self.decode_payload(&bytes)?;
            manifests.push(
                serde_json::from_slice::<WorkspacesManifest>(&decoded).map_err(|error| {
                    SyncError::Database(format!("解析旧工作区清单失败: {}", error))
                })?,
            );
        }

        let listed = storage
            .list_outcome(Self::WORKSPACES_MANIFESTS_PREFIX)
            .await
            .map_err(|error| SyncError::Network(format!("列举工作区清单失败: {}", error)))?;
        if listed.truncated {
            return Err(SyncError::Network(
                "工作区清单列表被截断，无法安全合并".to_string(),
            ));
        }
        for file in listed.files {
            if !file.key.ends_with(".json") {
                continue;
            }
            let bytes = storage
                .get(&file.key)
                .await
                .map_err(|error| {
                    SyncError::Network(format!("读取工作区清单 {} 失败: {}", file.key, error))
                })?
                .ok_or_else(|| {
                    SyncError::Network(format!("已列举的工作区清单消失: {}", file.key))
                })?;
            let decoded = self.decode_payload(&bytes)?;
            manifests.push(
                serde_json::from_slice::<WorkspacesManifest>(&decoded).map_err(|error| {
                    SyncError::Database(format!("解析工作区清单 {} 失败: {}", file.key, error))
                })?,
            );
        }

        let mut merged = WorkspacesManifest::default();
        for manifest in manifests {
            if manifest.updated_at > merged.updated_at {
                merged.updated_at = manifest.updated_at;
            }
            for (workspace_id, entry) in manifest.entries {
                let replace = merged
                    .entries
                    .get(&workspace_id)
                    .map(|current| {
                        Self::local_file_wins(
                            &entry.updated_at,
                            &current.updated_at,
                            &entry.sha256,
                            &current.sha256,
                        )
                    })
                    .unwrap_or(true);
                if replace {
                    merged.entries.insert(workspace_id, entry);
                }
            }
        }

        let tombstones = tombstone::download_workspace_tombstones(storage, self).await?;
        for (workspace_id, tombstone) in tombstones.entries {
            let should_remove = merged
                .entries
                .get(&workspace_id)
                .map(|entry| !Self::timestamp_after(&entry.updated_at, &tombstone.deleted_at))
                .unwrap_or(false);
            if should_remove {
                merged.entries.remove(&workspace_id);
            }
        }
        Ok(merged)
    }

    /// 同步 VFS blobs（内容寻址，纯增量，无冲突）
    ///
    const BLOB_MAX_RETRIES: u32 = 3;
    const BLOB_RETRY_BASE_MS: u64 = 500;

    /// 策略：
    /// - 本地有但云端没有 → 上传
    /// - 云端有但本地没有 → 下载（带重试）
    /// - hash 即内容唯一标识，天然去重，无冲突问题
    ///
    /// 返回 `BlobSyncOutcome` 以便调用方区分完全成功与部分失败。
    pub async fn sync_vfs_blobs(
        &self,
        storage: &dyn CloudStorage,
        blobs_dir: &std::path::Path,
        direction: SyncDirection,
    ) -> Result<BlobSyncOutcome, SyncError> {
        self.sync_vfs_blobs_with_progress(storage, blobs_dir, direction, None)
            .await
    }

    pub async fn sync_vfs_blobs_with_progress(
        &self,
        storage: &dyn CloudStorage,
        blobs_dir: &std::path::Path,
        direction: SyncDirection,
        progress: Option<FileTransferProgressCallback>,
    ) -> Result<BlobSyncOutcome, SyncError> {
        self.sync_vfs_blobs_with_progress_excluding(
            storage,
            blobs_dir,
            direction,
            progress,
            &HashSet::new(),
            &HashMap::new(),
        )
        .await
    }

    async fn sync_vfs_blobs_with_progress_excluding(
        &self,
        storage: &dyn CloudStorage,
        blobs_dir: &std::path::Path,
        direction: SyncDirection,
        progress: Option<FileTransferProgressCallback>,
        excluded_hashes: &HashSet<String>,
        resurrection_timestamps: &HashMap<String, String>,
    ) -> Result<BlobSyncOutcome, SyncError> {
        if !blobs_dir.exists() {
            return Ok(BlobSyncOutcome::default());
        }

        let mut cloud_manifest = self.download_blobs_manifest(storage).await?;
        cloud_manifest
            .entries
            .retain(|hash, _| !excluded_hashes.contains(hash));

        let mut local_blobs: HashMap<String, std::path::PathBuf> = HashMap::new();
        Self::scan_blobs_dir(blobs_dir, &mut local_blobs)?;

        let mut new_manifest = cloud_manifest.clone();
        let mut uploaded = 0usize;
        let mut upload_failures: Vec<String> = Vec::new();

        if direction != SyncDirection::Download {
            for (hash, path) in &local_blobs {
                if cloud_manifest.entries.contains_key(hash.as_str()) {
                    continue;
                }
                let relative = path
                    .strip_prefix(blobs_dir)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let key = format!("{}/{}", Self::BLOBS_CLOUD_PREFIX, relative);
                let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                // A referenced blob can explicitly defeat an older tombstone. Its file mtime
                // may still predate that tombstone because content-addressed reuse does not
                // rewrite the file, so publish the causal resurrection time in that case.
                let updated_at = resurrection_timestamps
                    .get(hash)
                    .cloned()
                    .unwrap_or_else(|| Self::file_mtime_rfc3339(path));

                let mut last_err = String::new();
                let mut ok = false;
                for attempt in 0..Self::BLOB_MAX_RETRIES {
                    let transfer_progress = Self::file_transfer_progress(
                        progress.as_ref(),
                        format!("VFS blob {}", hash),
                    );
                    match storage.put_file(&key, path, transfer_progress).await {
                        Ok(_) => {
                            new_manifest.entries.insert(
                                hash.clone(),
                                BlobEntry {
                                    relative_path: relative.clone(),
                                    size,
                                    updated_at: updated_at.clone(),
                                },
                            );
                            uploaded += 1;
                            ok = true;
                            break;
                        }
                        Err(e) => {
                            last_err = e.to_string();
                            if attempt + 1 < Self::BLOB_MAX_RETRIES {
                                let delay = Self::BLOB_RETRY_BASE_MS * (1u64 << attempt);
                                tracing::warn!(
                                    "[sync] blob 上传重试 {}/{}: {}: {}",
                                    attempt + 1,
                                    Self::BLOB_MAX_RETRIES,
                                    hash,
                                    e
                                );
                                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                            }
                        }
                    }
                }
                if !ok {
                    tracing::error!("[sync] blob 上传最终失败: {}: {}", hash, last_err);
                    upload_failures.push(hash.clone());
                }
            }
        }

        let mut downloaded_count = 0usize;
        let mut download_failures: Vec<String> = Vec::new();

        if direction != SyncDirection::Upload {
            for (hash, cloud_entry) in &cloud_manifest.entries {
                if local_blobs.contains_key(hash.as_str()) {
                    continue;
                }
                let dest = blobs_dir.join(&cloud_entry.relative_path);
                if let Some(parent) = dest.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let key = format!("{}/{}", Self::BLOBS_CLOUD_PREFIX, cloud_entry.relative_path);

                let mut last_err = String::new();
                let mut ok = false;
                for attempt in 0..Self::BLOB_MAX_RETRIES {
                    let transfer_progress = Self::file_transfer_progress(
                        progress.as_ref(),
                        format!("VFS blob {}", hash),
                    );
                    match storage
                        .get_file(&key, &dest, Some(hash), transfer_progress)
                        .await
                    {
                        Ok(_) => {
                            let actual_size =
                                std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
                            if cloud_entry.size > 0 && actual_size != cloud_entry.size {
                                last_err = format!(
                                    "blob 大小不匹配: 期望 {} 字节, 实际 {} 字节",
                                    cloud_entry.size, actual_size
                                );
                                let _ = std::fs::remove_file(&dest);
                                if attempt + 1 < Self::BLOB_MAX_RETRIES {
                                    let delay = Self::BLOB_RETRY_BASE_MS * (1u64 << attempt);
                                    tracing::warn!(
                                        "[sync] blob 大小校验失败，重试 {}/{}: {}: {}",
                                        attempt + 1,
                                        Self::BLOB_MAX_RETRIES,
                                        hash,
                                        last_err
                                    );
                                    tokio::time::sleep(std::time::Duration::from_millis(delay))
                                        .await;
                                }
                                continue;
                            }
                            downloaded_count += 1;
                            ok = true;
                            break;
                        }
                        Err(e) => {
                            last_err = e.to_string();
                            // 清理可能写到一半的文件
                            let _ = std::fs::remove_file(&dest);
                            if attempt + 1 < Self::BLOB_MAX_RETRIES {
                                let delay = Self::BLOB_RETRY_BASE_MS * (1u64 << attempt);
                                tracing::warn!(
                                    "[sync] blob 下载重试 {}/{}: {}: {}",
                                    attempt + 1,
                                    Self::BLOB_MAX_RETRIES,
                                    hash,
                                    e
                                );
                                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                            }
                        }
                    }
                }
                if !ok {
                    tracing::error!("[sync] blob 下载最终失败: {}: {}", hash, last_err);
                    download_failures.push(hash.clone());
                }
            }
        }

        if uploaded > 0 || downloaded_count > 0 {
            tracing::info!(
                "[sync] blob 同步: 上传 {}, 下载 {}, 上传失败 {}, 下载失败 {}",
                uploaded,
                downloaded_count,
                upload_failures.len(),
                download_failures.len()
            );
        }

        if uploaded > 0 {
            // [P2 D9-lite] 写前重新拉取最新清单做并集合并：blob 内容寻址（同 hash
            // 必同内容），并集天然无冲突；避免并发设备的新增条目被本设备覆盖丢失。
            let mut merged = match self.download_blobs_manifest(storage).await {
                Ok(fresh) => fresh,
                Err(e) => {
                    tracing::warn!("[sync] 写前刷新 blob 清单失败，退回本地视图: {}", e);
                    cloud_manifest.clone()
                }
            };
            for (hash, entry) in &new_manifest.entries {
                merged
                    .entries
                    .entry(hash.clone())
                    .or_insert_with(|| entry.clone());
            }
            merged.updated_at = chrono::Utc::now().to_rfc3339();
            self.publish_file_manifest(storage, Self::BLOBS_MANIFESTS_PREFIX, &merged, "blob")
                .await?;
        }

        Ok(BlobSyncOutcome {
            uploaded,
            downloaded: downloaded_count,
            upload_failures,
            download_failures,
        })
    }

    async fn download_blobs_manifest(
        &self,
        storage: &dyn CloudStorage,
    ) -> Result<BlobsManifest, SyncError> {
        let mut manifests = Vec::new();
        if let Some(bytes) = storage
            .get(Self::BLOBS_MANIFEST_KEY)
            .await
            .map_err(|error| SyncError::Network(format!("获取旧 blob 清单失败: {}", error)))?
        {
            let decoded = self.decode_payload(&bytes)?;
            manifests.push(
                serde_json::from_slice::<BlobsManifest>(&decoded).map_err(|error| {
                    SyncError::Database(format!("解析旧 blob 清单失败: {}", error))
                })?,
            );
        }

        let listed = storage
            .list_outcome(Self::BLOBS_MANIFESTS_PREFIX)
            .await
            .map_err(|error| SyncError::Network(format!("列举 blob 清单失败: {}", error)))?;
        if listed.truncated {
            return Err(SyncError::Network(
                "blob 清单列表被截断，无法安全合并".to_string(),
            ));
        }
        for file in listed.files {
            if !file.key.ends_with(".json") {
                continue;
            }
            let bytes = storage
                .get(&file.key)
                .await
                .map_err(|error| {
                    SyncError::Network(format!("读取 blob 清单 {} 失败: {}", file.key, error))
                })?
                .ok_or_else(|| {
                    SyncError::Network(format!("已列举的 blob 清单消失: {}", file.key))
                })?;
            let decoded = self.decode_payload(&bytes)?;
            manifests.push(
                serde_json::from_slice::<BlobsManifest>(&decoded).map_err(|error| {
                    SyncError::Database(format!("解析 blob 清单 {} 失败: {}", file.key, error))
                })?,
            );
        }

        let mut merged = BlobsManifest::default();
        for manifest in manifests {
            if manifest.updated_at > merged.updated_at {
                merged.updated_at = manifest.updated_at;
            }
            for (hash, entry) in manifest.entries {
                let replace = merged
                    .entries
                    .get(&hash)
                    .map(|current| Self::timestamp_after(&entry.updated_at, &current.updated_at))
                    .unwrap_or(true);
                if replace {
                    merged.entries.insert(hash, entry);
                }
            }
        }
        let tombstones = tombstone::download_blob_tombstones(storage, self).await?;
        for (hash, tombstone) in tombstones.entries {
            let should_remove = merged
                .entries
                .get(&hash)
                .map(|entry| !Self::timestamp_after(&entry.updated_at, &tombstone.deleted_at))
                .unwrap_or(false);
            if should_remove {
                merged.entries.remove(&hash);
            }
        }
        Ok(merged)
    }

    /// 同步关键资产目录（除 vfs_blobs/workspaces 外）
    pub async fn sync_asset_directories(
        &self,
        storage: &dyn CloudStorage,
        active_dir: &std::path::Path,
        app_data_dir: &std::path::Path,
        direction: SyncDirection,
    ) -> Result<AssetSyncOutcome, SyncError> {
        self.sync_asset_directories_with_progress(
            storage,
            active_dir,
            app_data_dir,
            direction,
            None,
        )
        .await
    }

    pub async fn sync_asset_directories_with_progress(
        &self,
        storage: &dyn CloudStorage,
        active_dir: &std::path::Path,
        app_data_dir: &std::path::Path,
        direction: SyncDirection,
        progress: Option<FileTransferProgressCallback>,
    ) -> Result<AssetSyncOutcome, SyncError> {
        self.sync_asset_directories_with_progress_excluding(
            storage,
            active_dir,
            app_data_dir,
            direction,
            progress,
            &HashSet::new(),
        )
        .await
    }

    async fn sync_asset_directories_with_progress_excluding(
        &self,
        storage: &dyn CloudStorage,
        active_dir: &std::path::Path,
        app_data_dir: &std::path::Path,
        direction: SyncDirection,
        progress: Option<FileTransferProgressCallback>,
        excluded_keys: &HashSet<String>,
    ) -> Result<AssetSyncOutcome, SyncError> {
        let mut cloud_manifest = self.download_assets_manifest(storage).await?;
        cloud_manifest
            .entries
            .retain(|key, _| !excluded_keys.contains(key));

        let mut local_files: HashMap<String, (std::path::PathBuf, String, u64, String)> =
            HashMap::new();
        for dir_name in Self::ACTIVE_ASSET_DIRS {
            let dir = active_dir.join(dir_name);
            if !dir.exists() {
                continue;
            }
            Self::scan_asset_tree("active", dir_name, &dir, &dir, &mut local_files)?;
        }

        let app_side = app_data_dir.join("pdf_ocr_sessions");
        if app_side.exists() {
            Self::scan_asset_tree(
                "app_data",
                "pdf_ocr_sessions",
                &app_side,
                &app_side,
                &mut local_files,
            )?;
        }

        let mut new_manifest = cloud_manifest.clone();
        let mut uploaded = 0usize;
        let mut upload_failures = Vec::new();

        if direction != SyncDirection::Download {
            for (key, (path, sha256, size, local_updated_at)) in &local_files {
                let should_upload = match cloud_manifest.entries.get(key) {
                    None => true,
                    Some(entry) => {
                        (entry.sha256 != *sha256 || entry.size != *size)
                            && Self::local_file_wins(
                                local_updated_at,
                                &entry.updated_at,
                                sha256,
                                &entry.sha256,
                            )
                    }
                };
                if !should_upload {
                    continue;
                }
                let remote_key = format!("{}/{}", Self::ASSET_OBJECTS_PREFIX, sha256);
                let transfer_progress =
                    Self::file_transfer_progress(progress.as_ref(), format!("资产文件 {}", key));
                match storage.put_file(&remote_key, path, transfer_progress).await {
                    Ok(_) => {
                        new_manifest.entries.insert(
                            key.clone(),
                            AssetFileEntry {
                                sha256: sha256.clone(),
                                size: *size,
                                updated_at: local_updated_at.clone(),
                                object_key: Some(remote_key.clone()),
                            },
                        );
                        uploaded += 1;
                    }
                    Err(e) => {
                        tracing::warn!("[sync] 资产上传失败（跳过）: {}: {}", key, e);
                        upload_failures.push(key.clone());
                    }
                }
            }
        }

        let mut downloaded = 0usize;
        let mut download_failures = Vec::new();
        if direction != SyncDirection::Upload {
            for (key, entry) in &cloud_manifest.entries {
                let should_download = match local_files.get(key) {
                    None => true,
                    Some((_path, sha256, size, local_updated_at)) => {
                        (*sha256 != entry.sha256 || *size != entry.size)
                            && !Self::local_file_wins(
                                local_updated_at,
                                &entry.updated_at,
                                sha256,
                                &entry.sha256,
                            )
                    }
                };
                if !should_download {
                    continue;
                }
                let Some(dest) = Self::asset_local_path_from_key(active_dir, app_data_dir, key)
                else {
                    tracing::warn!("[sync] 非法资产键，跳过下载: {}", key);
                    continue;
                };
                if let Some(parent) = dest.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if dest.exists() {
                    if let Err(e) = Self::save_conflict_copy(&dest, &self.device_id) {
                        tracing::warn!("[sync] 保存资产冲突副本失败: {}: {}", key, e);
                    }
                }
                let remote_key = entry
                    .object_key
                    .clone()
                    .unwrap_or_else(|| format!("{}/{}", Self::ASSETS_CLOUD_PREFIX, key));
                let transfer_progress =
                    Self::file_transfer_progress(progress.as_ref(), format!("资产文件 {}", key));
                match storage
                    .get_file(&remote_key, &dest, Some(&entry.sha256), transfer_progress)
                    .await
                {
                    Ok(_) => downloaded += 1,
                    Err(e) => {
                        tracing::warn!("[sync] 资产下载失败（跳过）: {}: {}", key, e);
                        let _ = std::fs::remove_file(&dest);
                        download_failures.push(key.clone());
                    }
                }
            }
        }

        if direction != SyncDirection::Download && new_manifest.entries != cloud_manifest.entries {
            // [P2 D9-lite] 写前重新拉取最新清单做条目级合并，缩小多设备并发
            // read-modify-write 互相覆盖条目的竞态窗口。
            let mut merged = match self.download_assets_manifest(storage).await {
                Ok(fresh) => fresh,
                Err(e) => {
                    tracing::warn!("[sync] 写前刷新资产清单失败，退回本地视图: {}", e);
                    cloud_manifest.clone()
                }
            };
            for (key, entry) in &new_manifest.entries {
                let ours_changed = cloud_manifest.entries.get(key) != Some(entry);
                if !ours_changed {
                    continue;
                }
                let theirs_newer = merged.entries.get(key).is_some_and(|theirs| {
                    Self::local_file_wins(
                        &theirs.updated_at,
                        &entry.updated_at,
                        &theirs.sha256,
                        &entry.sha256,
                    )
                });
                if !theirs_newer {
                    merged.entries.insert(key.clone(), entry.clone());
                }
            }
            for key in cloud_manifest.entries.keys() {
                if !new_manifest.entries.contains_key(key) {
                    merged.entries.remove(key);
                }
            }
            merged.updated_at = chrono::Utc::now().to_rfc3339();
            self.publish_file_manifest(storage, Self::ASSETS_MANIFESTS_PREFIX, &merged, "资产")
                .await?;
        }

        Ok(AssetSyncOutcome {
            uploaded,
            downloaded,
            upload_failures,
            download_failures,
        })
    }

    async fn download_assets_manifest(
        &self,
        storage: &dyn CloudStorage,
    ) -> Result<AssetDirsManifest, SyncError> {
        let mut manifests = Vec::new();
        if let Some(bytes) = storage
            .get(Self::ASSETS_MANIFEST_KEY)
            .await
            .map_err(|error| SyncError::Network(format!("获取旧资产清单失败: {}", error)))?
        {
            let decoded = self.decode_payload(&bytes).map_err(|error| {
                SyncError::Database(format!(
                    "旧资产清单无法解密，已停止同步（请检查加密密码）: {}",
                    error
                ))
            })?;
            manifests.push(
                serde_json::from_slice::<AssetDirsManifest>(&decoded)
                    .map_err(|error| SyncError::Database(format!("旧资产清单损坏: {}", error)))?,
            );
        }

        let listed = storage
            .list_outcome(Self::ASSETS_MANIFESTS_PREFIX)
            .await
            .map_err(|error| SyncError::Network(format!("列举资产清单失败: {}", error)))?;
        if listed.truncated {
            return Err(SyncError::Network(
                "资产清单列表被截断，无法安全合并".to_string(),
            ));
        }
        for file in listed.files {
            if !file.key.ends_with(".json") {
                continue;
            }
            let bytes = storage
                .get(&file.key)
                .await
                .map_err(|error| {
                    SyncError::Network(format!("读取资产清单 {} 失败: {}", file.key, error))
                })?
                .ok_or_else(|| SyncError::Network(format!("已列举的资产清单消失: {}", file.key)))?;
            let decoded = self.decode_payload(&bytes).map_err(|error| {
                SyncError::Database(format!("资产清单 {} 无法解密: {}", file.key, error))
            })?;
            manifests.push(
                serde_json::from_slice::<AssetDirsManifest>(&decoded).map_err(|error| {
                    SyncError::Database(format!("资产清单 {} 损坏: {}", file.key, error))
                })?,
            );
        }

        let mut merged = AssetDirsManifest::default();
        for manifest in manifests {
            if manifest.updated_at > merged.updated_at {
                merged.updated_at = manifest.updated_at;
            }
            for (key, entry) in manifest.entries {
                let replace = merged
                    .entries
                    .get(&key)
                    .map(|current| {
                        Self::local_file_wins(
                            &entry.updated_at,
                            &current.updated_at,
                            &entry.sha256,
                            &current.sha256,
                        )
                    })
                    .unwrap_or(true);
                if replace {
                    merged.entries.insert(key, entry);
                }
            }
        }
        let tombstones = tombstone::download_asset_tombstones(storage, self).await?;
        for (key, tombstone) in tombstones.entries {
            let should_remove = merged
                .entries
                .get(&key)
                .map(|entry| !Self::timestamp_after(&entry.updated_at, &tombstone.deleted_at))
                .unwrap_or(false);
            if should_remove {
                merged.entries.remove(&key);
            }
        }
        Ok(merged)
    }

    fn scan_asset_tree(
        root_alias: &str,
        top_dir: &str,
        base_dir: &std::path::Path,
        current_dir: &std::path::Path,
        out: &mut HashMap<String, (std::path::PathBuf, String, u64, String)>,
    ) -> Result<(), SyncError> {
        for entry in std::fs::read_dir(current_dir)
            .map_err(|e| SyncError::Database(format!("读取资产目录失败: {}", e)))?
        {
            let entry =
                entry.map_err(|e| SyncError::Database(format!("读取资产条目失败: {}", e)))?;
            let path = entry.path();
            if path.is_dir() {
                Self::scan_asset_tree(root_alias, top_dir, base_dir, &path, out)?;
                continue;
            }
            if !path.is_file() {
                continue;
            }

            let rel = path
                .strip_prefix(base_dir)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let key = format!("{}/{}/{}", root_alias, top_dir, rel);
            let sha256 = crate::backup_common::calculate_file_hash(&path).map_err(|e| {
                SyncError::Database(format!("计算资产文件校验和失败 {:?}: {}", path, e))
            })?;
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let updated_at = Self::file_mtime_rfc3339(&path);
            out.insert(key, (path, sha256, size, updated_at));
        }
        Ok(())
    }

    fn asset_local_path_from_key(
        active_dir: &std::path::Path,
        app_data_dir: &std::path::Path,
        key: &str,
    ) -> Option<std::path::PathBuf> {
        let mut parts = key.splitn(3, '/');
        let root = parts.next()?;
        let top = parts.next()?;
        let rel = parts.next()?;
        let rel_path = std::path::PathBuf::from(rel);
        if rel_path.is_absolute()
            || rel_path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return None;
        }
        let base = match root {
            "active" => active_dir,
            "app_data" => app_data_dir,
            _ => return None,
        };
        Some(base.join(top).join(rel_path))
    }

    fn scan_blobs_dir(
        dir: &std::path::Path,
        result: &mut HashMap<String, std::path::PathBuf>,
    ) -> Result<(), SyncError> {
        for entry in std::fs::read_dir(dir)
            .map_err(|e| SyncError::Database(format!("读取 blobs 目录失败: {}", e)))?
        {
            let entry =
                entry.map_err(|e| SyncError::Database(format!("读取目录条目失败: {}", e)))?;
            let path = entry.path();
            if path.is_dir() {
                Self::scan_blobs_dir(&path, result)?;
            } else if path.is_file() {
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                if ext != "tmp" {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        result.insert(stem.to_string(), path);
                    }
                }
            }
        }
        Ok(())
    }

    // ========================================================================
    // 删除传播 (Tombstone) — 修复 #6
    // ========================================================================

    /// 标记 blob 已删除（本地调用）。后续 `sync_vfs_blobs_with_tombstones` 会把删除
    /// 传播到云端和其他设备。
    pub async fn mark_blob_deleted(
        &self,
        storage: &dyn CloudStorage,
        hash: &str,
        relative_path: Option<String>,
        size: Option<u64>,
    ) -> Result<(), SyncError> {
        // [P0-2] tombstone 清单也走 E2EE（self 实现了 PayloadCodec）
        let mut manifest =
            tombstone::download_blob_tombstones_for_device(storage, self, &self.device_id).await?;
        manifest.entries.insert(
            hash.to_string(),
            tombstone::BlobTombstoneEntry {
                deleted_at: chrono::Utc::now().to_rfc3339(),
                device_id: self.device_id.clone(),
                size,
                relative_path,
            },
        );
        tombstone::prune_tombstones(
            &mut manifest.entries,
            tombstone::DEFAULT_TOMBSTONE_RETENTION_DAYS,
            |entry| &entry.deleted_at,
        );
        tombstone::upload_blob_tombstones(storage, self, &self.device_id, manifest).await
    }

    pub async fn mark_blob_deletions(
        &self,
        storage: &dyn CloudStorage,
        entries: Vec<(String, Option<String>, Option<u64>, String)>,
    ) -> Result<(), SyncError> {
        if entries.is_empty() {
            return Ok(());
        }
        let mut manifest =
            tombstone::download_blob_tombstones_for_device(storage, self, &self.device_id).await?;
        for (hash, relative_path, size, deleted_at) in entries {
            manifest.entries.insert(
                hash,
                tombstone::BlobTombstoneEntry {
                    deleted_at,
                    device_id: self.device_id.clone(),
                    size,
                    relative_path,
                },
            );
        }
        tombstone::prune_tombstones(
            &mut manifest.entries,
            tombstone::DEFAULT_TOMBSTONE_RETENTION_DAYS,
            |entry| &entry.deleted_at,
        );
        tombstone::upload_blob_tombstones(storage, self, &self.device_id, manifest).await
    }

    /// 标记资产已删除
    pub async fn mark_asset_deleted(
        &self,
        storage: &dyn CloudStorage,
        key: &str,
        size: Option<u64>,
    ) -> Result<(), SyncError> {
        let mut manifest =
            tombstone::download_asset_tombstones_for_device(storage, self, &self.device_id).await?;
        manifest.entries.insert(
            key.to_string(),
            tombstone::AssetTombstoneEntry {
                deleted_at: chrono::Utc::now().to_rfc3339(),
                device_id: self.device_id.clone(),
                size,
            },
        );
        tombstone::prune_tombstones(
            &mut manifest.entries,
            tombstone::DEFAULT_TOMBSTONE_RETENTION_DAYS,
            |entry| &entry.deleted_at,
        );
        tombstone::upload_asset_tombstones(storage, self, &self.device_id, manifest).await
    }

    pub async fn mark_asset_deletions(
        &self,
        storage: &dyn CloudStorage,
        entries: Vec<(String, Option<u64>, String)>,
    ) -> Result<(), SyncError> {
        if entries.is_empty() {
            return Ok(());
        }
        let mut manifest =
            tombstone::download_asset_tombstones_for_device(storage, self, &self.device_id).await?;
        for (key, size, deleted_at) in entries {
            manifest.entries.insert(
                key,
                tombstone::AssetTombstoneEntry {
                    deleted_at,
                    device_id: self.device_id.clone(),
                    size,
                },
            );
        }
        tombstone::prune_tombstones(
            &mut manifest.entries,
            tombstone::DEFAULT_TOMBSTONE_RETENTION_DAYS,
            |entry| &entry.deleted_at,
        );
        tombstone::upload_asset_tombstones(storage, self, &self.device_id, manifest).await
    }

    pub async fn mark_workspace_deleted(
        &self,
        storage: &dyn CloudStorage,
        workspace_id: &str,
    ) -> Result<(), SyncError> {
        let mut manifest =
            tombstone::download_workspace_tombstones_for_device(storage, self, &self.device_id)
                .await?;
        let manifest_id = Self::workspace_manifest_id(workspace_id);
        manifest.entries.insert(
            manifest_id,
            tombstone::WorkspaceTombstoneEntry {
                deleted_at: chrono::Utc::now().to_rfc3339(),
                device_id: self.device_id.clone(),
            },
        );
        tombstone::prune_tombstones(
            &mut manifest.entries,
            tombstone::DEFAULT_TOMBSTONE_RETENTION_DAYS,
            |entry| &entry.deleted_at,
        );
        tombstone::upload_workspace_tombstones(storage, self, &self.device_id, manifest).await
    }

    pub async fn mark_workspace_deletions(
        &self,
        storage: &dyn CloudStorage,
        entries: Vec<(String, String)>,
    ) -> Result<(), SyncError> {
        if entries.is_empty() {
            return Ok(());
        }
        let mut manifest =
            tombstone::download_workspace_tombstones_for_device(storage, self, &self.device_id)
                .await?;
        for (workspace_id, deleted_at) in entries {
            let manifest_id = Self::workspace_manifest_id(&workspace_id);
            manifest.entries.insert(
                manifest_id,
                tombstone::WorkspaceTombstoneEntry {
                    deleted_at,
                    device_id: self.device_id.clone(),
                },
            );
        }
        tombstone::prune_tombstones(
            &mut manifest.entries,
            tombstone::DEFAULT_TOMBSTONE_RETENTION_DAYS,
            |entry| &entry.deleted_at,
        );
        tombstone::upload_workspace_tombstones(storage, self, &self.device_id, manifest).await
    }

    fn workspace_manifest_id(workspace_id: &str) -> String {
        if workspace_id.starts_with("ws_") {
            workspace_id.to_string()
        } else {
            format!("ws_{}", workspace_id)
        }
    }

    /// 同步 VFS blobs + 消费 tombstone（修复 #6）
    ///
    /// 与 `sync_vfs_blobs` 不同：先按 tombstone 清理本地与云端的已删 blob，
    /// 再走常规 "本地→上传 / 云端→下载" 流程。
    pub async fn sync_vfs_blobs_with_tombstones(
        &self,
        storage: &dyn CloudStorage,
        blobs_dir: &std::path::Path,
        direction: SyncDirection,
    ) -> Result<BlobSyncOutcome, SyncError> {
        self.sync_vfs_blobs_with_tombstones_and_progress(storage, blobs_dir, direction, None)
            .await
    }

    /// [P1 防数据丢失] 查询本地 vfs.db，返回给定 hash 集合中仍有 `ref_count > 0`
    /// 引用的 blob hash。
    ///
    /// vfs.db 路径按生产布局从 blobs 目录推导（`{active_dir}/vfs_blobs` →
    /// `{active_dir}/databases/vfs.db`）。数据库/表不存在（如纯文件级测试环境）
    /// 或查询失败时返回空集合——防线退化为原有行为，绝不阻塞同步。
    fn blob_hashes_with_local_refs<'a>(
        blobs_dir: &std::path::Path,
        hashes: impl Iterator<Item = &'a str>,
    ) -> HashSet<String> {
        let mut referenced = HashSet::new();
        let Some(active_dir) = blobs_dir.parent() else {
            return referenced;
        };
        let vfs_db = active_dir.join("databases").join("vfs.db");
        if !vfs_db.exists() {
            return referenced;
        }
        let conn = match Connection::open(&vfs_db) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("[sync] 无法打开 vfs.db 检查 blob 引用（防线跳过）: {}", e);
                return referenced;
            }
        };
        let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
        let table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='blobs')",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !table_exists {
            return referenced;
        }
        // [P3 perf] 分块 IN 批量查询（999 为 SQLite 默认绑定参数上限）
        let all_hashes: Vec<&str> = hashes.collect();
        for chunk in all_hashes.chunks(999) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql =
                format!("SELECT hash FROM blobs WHERE ref_count > 0 AND hash IN ({placeholders})");
            let mut stmt = match conn.prepare(&sql) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!("[sync] 查询 blobs.ref_count 失败（防线跳过）: {}", e);
                    return referenced;
                }
            };
            let rows = stmt.query_map(rusqlite::params_from_iter(chunk.iter()), |row| {
                row.get::<_, String>(0)
            });
            match rows {
                Ok(rows) => {
                    for hash in rows.flatten() {
                        referenced.insert(hash);
                    }
                }
                Err(e) => {
                    tracing::warn!("[sync] 扫描 blobs.ref_count 失败（防线跳过）: {}", e);
                    return referenced;
                }
            }
        }
        referenced
    }

    pub async fn sync_vfs_blobs_with_tombstones_and_progress(
        &self,
        storage: &dyn CloudStorage,
        blobs_dir: &std::path::Path,
        direction: SyncDirection,
        progress: Option<FileTransferProgressCallback>,
    ) -> Result<BlobSyncOutcome, SyncError> {
        // 1. 拉取 tombstone 并执行删除传播
        let instance_id = self.ensure_remote_instance_id(storage).await?;
        let state_store = SyncStateStore::open_default()?;
        let cloud_manifest = self.download_blobs_manifest(storage).await?;
        let (tombstones, tombstone_advances) =
            tombstone::download_blob_tombstones_after(storage, self, |source| {
                state_store.get_tombstone_watermark(&instance_id, source, "blobs")
            })
            .await?;
        let mut excluded_tombstone_hashes = HashSet::new();
        let mut resurrection_timestamps = HashMap::new();
        if !tombstones.entries.is_empty() {
            // [P1 防数据丢失] 第三道防线：本地 vfs.db 仍有 ref_count>0 引用的 blob，
            // 拒绝消费其 tombstone（本地引用胜过远端删除）。
            //
            // 竞态场景：设备 A 删除 blob 最后引用并发布 tombstone；设备 B 在消费该
            // tombstone 之前重新引用了相同内容（内容寻址去重路径不重写文件、不更新
            // mtime，mtime 防线失效）。若无此防线，B 的本地文件 + 云端文件都会被删，
            // 而 B 的行级引用照常同步，内容在全部设备上永久丢失。
            //
            // 被跳过的 tombstone 不进入 applied 集合（不摘 manifest 条目）；若云端
            // 文件/条目已被其他消费方删除，后续上传阶段会因"本地有文件、云端清单无
            // 条目"自动重新上传，实现 blob 复活。watermark 照常推进，本地引用存续
            // 期间该删除意图被永久否决。
            let locally_referenced = Self::blob_hashes_with_local_refs(
                blobs_dir,
                tombstones.entries.keys().map(String::as_str),
            );
            let mut effective_tombstones = tombstones.clone();
            effective_tombstones.entries.retain(|hash, entry| {
                if locally_referenced.contains(hash.as_str()) {
                    let now = chrono::Utc::now();
                    let causally_after_delete = parse_flexible_timestamp_public(&entry.deleted_at)
                        .and_then(|deleted_at| {
                            deleted_at.checked_add_signed(chrono::Duration::milliseconds(1))
                        })
                        .map(|after_delete| after_delete.max(now))
                        .unwrap_or(now)
                        .to_rfc3339();
                    resurrection_timestamps.insert(hash.clone(), causally_after_delete);
                    tracing::warn!(
                        "[sync] 拒绝消费 blob tombstone（本地仍有引用，blob 将在上传阶段复活）: {} deleted_at={}",
                        hash,
                        entry.deleted_at
                    );
                    return false;
                }
                let keep = match cloud_manifest.entries.get(hash) {
                    Some(cloud) => {
                        let cloud_updated_at = if cloud.updated_at.trim().is_empty() {
                            cloud_manifest.updated_at.as_str()
                        } else {
                            cloud.updated_at.as_str()
                        };
                        !Self::timestamp_after(cloud_updated_at, &entry.deleted_at)
                    }
                    None => true,
                };
                if !keep {
                    tracing::info!(
                        "[sync] 跳过过期 blob tombstone，云端清单更新: {} cloud_manifest_updated_at>{}",
                        hash,
                        entry.deleted_at
                    );
                }
                keep
            });
            let applied_tombstone_hashes = tombstone::apply_blob_tombstones(
                storage,
                &effective_tombstones,
                blobs_dir,
                Self::BLOBS_CLOUD_PREFIX,
                direction != SyncDirection::Download,
            )
            .await?;
            excluded_tombstone_hashes.extend(applied_tombstone_hashes.iter().cloned());

            // 同时从 blob manifest 里摘掉 tombstoned 条目
            // [P0-2] 读写都需要透明 encode/decode
            if direction != SyncDirection::Download {
                let mut mf = cloud_manifest.clone();
                let before = mf.entries.len();
                for hash in &applied_tombstone_hashes {
                    mf.entries.remove(hash);
                }
                if mf.entries.len() != before {
                    mf.updated_at = chrono::Utc::now().to_rfc3339();
                    self.publish_file_manifest(storage, Self::BLOBS_MANIFESTS_PREFIX, &mf, "blob")
                        .await?;
                }
            }
        }
        for advance in tombstone_advances {
            state_store.set_tombstone_watermark(
                &instance_id,
                &advance.source_device_id,
                "blobs",
                advance.last_applied_offset,
            )?;
        }

        // 2. 走标准上传/下载流程（现在云端/本地里已无 tombstoned 条目）
        self.sync_vfs_blobs_with_progress_excluding(
            storage,
            blobs_dir,
            direction,
            progress,
            &excluded_tombstone_hashes,
            &resurrection_timestamps,
        )
        .await
    }

    /// 同步资产目录 + 消费 asset tombstone
    ///
    /// 与 `sync_asset_directories` 不同：先按 tombstone 清理本地与云端的已删资产文件，
    /// 再走常规上传/下载流程。
    pub async fn sync_asset_directories_with_tombstones(
        &self,
        storage: &dyn CloudStorage,
        active_dir: &std::path::Path,
        app_data_dir: &std::path::Path,
        direction: SyncDirection,
    ) -> Result<AssetSyncOutcome, SyncError> {
        self.sync_asset_directories_with_tombstones_and_progress(
            storage,
            active_dir,
            app_data_dir,
            direction,
            None,
        )
        .await
    }

    pub async fn sync_asset_directories_with_tombstones_and_progress(
        &self,
        storage: &dyn CloudStorage,
        active_dir: &std::path::Path,
        app_data_dir: &std::path::Path,
        direction: SyncDirection,
        progress: Option<FileTransferProgressCallback>,
    ) -> Result<AssetSyncOutcome, SyncError> {
        // 1. 拉取 asset tombstone 并删除本地/云端对应文件
        let instance_id = self.ensure_remote_instance_id(storage).await?;
        let state_store = SyncStateStore::open_default()?;
        let cloud_manifest = self.download_assets_manifest(storage).await?;
        let (tombstones, tombstone_advances) =
            tombstone::download_asset_tombstones_after(storage, self, |source| {
                state_store.get_tombstone_watermark(&instance_id, source, "assets")
            })
            .await?;
        let mut excluded_tombstone_keys = HashSet::new();
        if !tombstones.entries.is_empty() {
            let mut applied_tombstone_keys = Vec::new();
            for (key, entry) in &tombstones.entries {
                if cloud_manifest.entries.get(key).is_some_and(|cloud| {
                    Self::timestamp_after(&cloud.updated_at, &entry.deleted_at)
                }) {
                    tracing::info!(
                        "[sync] 跳过过期 asset tombstone，云端文件更新: {} cloud_updated_at>{}",
                        key,
                        entry.deleted_at
                    );
                    continue;
                }
                let local_path = Self::asset_local_path_from_key(active_dir, app_data_dir, key);
                if local_path
                    .as_ref()
                    .is_some_and(|local| tombstone::path_modified_after(local, &entry.deleted_at))
                {
                    tracing::info!(
                        "[sync] 跳过过期 asset tombstone，本地文件更新: {} deleted_at={}",
                        key,
                        entry.deleted_at
                    );
                    continue;
                }
                // 云端删除
                if direction != SyncDirection::Download {
                    let remote_key = cloud_manifest
                        .entries
                        .get(key)
                        .and_then(|manifest| manifest.object_key.clone())
                        .unwrap_or_else(|| format!("{}/{}", Self::ASSETS_CLOUD_PREFIX, key));
                    if let Err(e) = storage.delete(&remote_key).await {
                        tracing::warn!("[sync] 删除云端资产失败（忽略）: {}: {}", remote_key, e);
                    }
                }
                // 本地删除
                if let Some(local) = local_path {
                    if local.exists() {
                        let _ = std::fs::remove_file(&local);
                    }
                }
                applied_tombstone_keys.push(key.clone());
            }
            excluded_tombstone_keys.extend(applied_tombstone_keys.iter().cloned());

            // 从云端资产清单摘掉 tombstoned 条目
            // [P0-2] 同样需要透明 encode/decode
            if direction != SyncDirection::Download {
                let mut mf = cloud_manifest.clone();
                let before = mf.entries.len();
                for key in &applied_tombstone_keys {
                    mf.entries.remove(key);
                }
                if mf.entries.len() != before {
                    mf.updated_at = chrono::Utc::now().to_rfc3339();
                    self.publish_file_manifest(storage, Self::ASSETS_MANIFESTS_PREFIX, &mf, "资产")
                        .await?;
                }
            }
        }
        for advance in tombstone_advances {
            state_store.set_tombstone_watermark(
                &instance_id,
                &advance.source_device_id,
                "assets",
                advance.last_applied_offset,
            )?;
        }

        // 2. 走标准同步流程
        self.sync_asset_directories_with_progress_excluding(
            storage,
            active_dir,
            app_data_dir,
            direction,
            progress,
            &excluded_tombstone_keys,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn create_test_manifest(
        device_id: &str,
        databases: Vec<(&str, u32, u64, &str)>,
    ) -> SyncManifest {
        let mut db_map = HashMap::new();
        for (name, schema_ver, data_ver, checksum) in databases {
            db_map.insert(
                name.to_string(),
                DatabaseSyncState {
                    schema_version: schema_ver,
                    data_version: data_ver,
                    checksum: checksum.to_string(),
                    last_updated_at: None,
                },
            );
        }
        SyncManifest {
            sync_transaction_id: "test-tx".to_string(),
            databases: db_map,
            status: SyncTransactionStatus::Complete,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            device_id: device_id.to_string(),
            format_version: 3,
            published_max_seq: 0,
            cursors: HashMap::new(),
            superseded_by: None,
            snapshot_seen: HashMap::new(),
        }
    }

    #[test]
    fn test_parse_version_from_key_with_nonce() {
        let key = "data_governance/changes/device-1/12345-acde.json";
        assert_eq!(SyncManager::parse_version_from_key(key), Some(12345));
    }

    #[test]
    fn test_parse_version_from_key_legacy_no_nonce() {
        // Legacy 文件没有 nonce（纯秒级时间戳）
        let key = "data_governance/changes/device-1/1707500000.json";
        assert_eq!(SyncManager::parse_version_from_key(key), Some(1707500000));
    }

    #[test]
    fn test_parse_version_from_key_seconds_with_nonce() {
        // 旧格式 .json：秒级时间戳 + UUID nonce
        let key =
            "data_governance/changes/device-1/1707500000-550e8400-e29b-41d4-a716-446655440000.json";
        assert_eq!(SyncManager::parse_version_from_key(key), Some(1707500000));
    }

    #[test]
    fn regression_c1_v3_change_key_parses_seq_and_timestamp() {
        let manager = SyncManager::new("device-1".to_string());
        let key = manager.build_change_key_v3(42, 1_707_500_000);

        assert_eq!(
            SyncManager::parse_version_from_key(&key),
            Some(1_707_500_000)
        );
        assert!(matches!(
            SyncManager::parse_change_key(&key),
            Some(ParsedChangeKey::V3 {
                device_id,
                seq: 42,
                version: 1_707_500_000,
            }) if device_id == "device-1"
        ));
    }

    // ==================== Phase 0 回归测试 ====================

    fn make_change(record: &str, data: serde_json::Value) -> SyncChangeWithData {
        SyncChangeWithData {
            table_name: "items".to_string(),
            record_id: record.to_string(),
            operation: ChangeOperation::Update,
            data: Some(data),
            changed_at: "2024-01-01T00:00:00Z".to_string(),
            change_log_id: None,
            database_name: Some("vfs".to_string()),
            suppress_change_log: None,
            source_device_id: None,
            source_seq: None,
        }
    }

    #[test]
    fn regression_c4_dedupe_keeps_last() {
        // 序列 x=1 → x=2 → x=1：keep-first 会丢掉最后的 x=1，终态错为 x=2。
        // keep-last 必须保留顺序上最后一条 x=1，终态为 x=1。
        let changes = vec![
            (1u64, make_change("r1", json!({ "x": 1 }))),
            (2u64, make_change("r1", json!({ "x": 2 }))),
            (3u64, make_change("r1", json!({ "x": 1 }))),
        ];
        let deduped = SyncManager::dedupe_downloaded_changes(changes);
        // x=1 的两条指纹相同，仅保留最后一条；x=2 保留 → 共 2 条
        assert_eq!(deduped.len(), 2, "应去掉一条重复的 x=1");
        // 顺序保持升序，最后应用的一条必须是 x=1（版本 3）
        let last = deduped.last().unwrap();
        assert_eq!(last.0, 3, "保留的 x=1 应是版本 3 那条");
        assert_eq!(last.1.data.as_ref().unwrap()["x"], json!(1));
        // 中间一条是 x=2
        assert_eq!(deduped[0].1.data.as_ref().unwrap()["x"], json!(2));
    }

    #[test]
    fn regression_c4_dedupe_distinct_kept() {
        // 内容各异的变更全部保留，顺序不变
        let changes = vec![
            (1u64, make_change("r1", json!({ "x": 1 }))),
            (2u64, make_change("r2", json!({ "x": 1 }))),
            (3u64, make_change("r1", json!({ "x": 2 }))),
        ];
        let deduped = SyncManager::dedupe_downloaded_changes(changes);
        assert_eq!(deduped.len(), 3);
        assert_eq!(deduped[0].0, 1);
        assert_eq!(deduped[1].0, 2);
        assert_eq!(deduped[2].0, 3);
    }

    #[test]
    fn regression_c6_normalize_version_to_seconds() {
        // 毫秒时间戳归一化为秒；秒级保持不变
        assert_eq!(
            SyncManager::normalize_version_to_seconds(1_707_500_000_123),
            1_707_500_000
        );
        assert_eq!(
            SyncManager::normalize_version_to_seconds(1_707_500_000),
            1_707_500_000
        );
        // 阈值边界：恰好 1e11 视为秒级保留
        assert_eq!(
            SyncManager::normalize_version_to_seconds(100_000_000_000),
            100_000_000_000
        );
    }

    #[test]
    fn regression_c7_mark_synced_batches_over_variable_limit() {
        // 一次标记 > SQLite 变量上限（默认 999/32766）的变更，分批后必须全部成功。
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE __change_log (id INTEGER PRIMARY KEY, sync_version INTEGER NOT NULL DEFAULT 0);",
        )
        .unwrap();

        let n = 1500i64;
        {
            let tx = conn.unchecked_transaction().unwrap();
            for i in 1..=n {
                tx.execute(
                    "INSERT INTO __change_log (id, sync_version) VALUES (?1, 0)",
                    [i],
                )
                .unwrap();
            }
            tx.commit().unwrap();
        }

        let ids: Vec<i64> = (1..=n).collect();
        let updated = SyncManager::mark_synced(&conn, &ids, 12345).unwrap();
        assert_eq!(updated as i64, n, "应全部标记成功");

        let marked: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM __change_log WHERE sync_version = 12345",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(marked, n, "全部行的 sync_version 应被更新");
    }

    #[test]
    fn regression_c8_upload_path_verifies_size() {
        let source = include_str!("mod.rs");
        assert!(source.contains("verify_uploaded_size"));
        assert!(source.contains("put_change_with_verify_retry"));
        assert!(
            source.contains("storage.stat(&key).await"),
            "PUT 后必须 stat 回验对象大小"
        );
        assert!(
            source.contains("Ok(Some(info)) if info.size == expected"),
            "size 与期望不符时必须拒绝推进 mark"
        );
    }

    #[test]
    fn test_parse_version_from_key_zst_with_nonce() {
        // 新格式 .json.zst：秒级时间戳 + UUID nonce + zstd 压缩
        let key = "data_governance/changes/device-1/1707500000-550e8400-e29b-41d4-a716-446655440000.json.zst";
        assert_eq!(SyncManager::parse_version_from_key(key), Some(1707500000));
    }

    #[test]
    fn test_parse_version_from_key_zst_legacy_no_nonce() {
        // .json.zst 无 nonce
        let key = "data_governance/changes/device-1/1707500000.json.zst";
        assert_eq!(SyncManager::parse_version_from_key(key), Some(1707500000));
    }

    #[test]
    fn test_parse_version_from_key_invalid() {
        assert_eq!(SyncManager::parse_version_from_key(""), None);
        assert_eq!(SyncManager::parse_version_from_key("no-slash"), None);
        assert_eq!(
            SyncManager::parse_version_from_key("data_governance/changes/device-1/notanumber.json"),
            None
        );
        assert_eq!(
            SyncManager::parse_version_from_key("data_governance/changes/device-1/abc.json.zst"),
            None
        );
    }

    #[test]
    fn test_version_space_compatibility_seconds() {
        // 验证新旧版本空间兼容：legacy 用秒级时间戳，新代码也用秒级
        // 新变更 version = 当前时间秒 > 旧的 since_version 秒 → 会被下载
        // 旧变更 version = 更早的秒 < 新的 since_version 秒 → 会被跳过（正确）
        let old_version: u64 = 1707500000; // legacy 设备上传
        let new_since: u64 = 1707400000; // 本地已同步到的版本
        assert!(
            old_version > new_since,
            "旧设备新变更应大于本地 since，被下载"
        );

        let stale_version: u64 = 1707300000; // 更早的变更
        assert!(stale_version < new_since, "过时变更应被跳过");
    }

    #[test]
    fn test_build_change_key_unique() {
        let manager = SyncManager::new("device-1".to_string());
        let key1 = manager.build_change_key(1707500000);
        let key2 = manager.build_change_key(1707500000);
        // 同一秒生成的 key 不应相同（UUID nonce 不同）
        assert_ne!(key1, key2, "同版本号的 key 应因 nonce 不同而不同");
        // 但版本号应可正确解析
        assert_eq!(SyncManager::parse_version_from_key(&key1), Some(1707500000));
        assert_eq!(SyncManager::parse_version_from_key(&key2), Some(1707500000));
    }

    #[test]
    fn test_normalize_version_to_seconds() {
        // 秒级值不变
        assert_eq!(
            SyncManager::normalize_version_to_seconds(1707500000),
            1707500000
        );
        assert_eq!(SyncManager::normalize_version_to_seconds(0), 0);
        assert_eq!(SyncManager::normalize_version_to_seconds(42), 42);
        // 毫秒级值被除以 1000
        assert_eq!(
            SyncManager::normalize_version_to_seconds(1707500000000),
            1707500000
        );
        assert_eq!(
            SyncManager::normalize_version_to_seconds(1707600000123),
            1707600000
        );
    }

    #[test]
    fn test_same_second_download_not_skipped() {
        // 验证 >= 语义：同秒版本不被跳过
        let since_version: u64 = 1707500000;
        let file_version: u64 = 1707500000; // 同秒
        assert!(file_version >= since_version, "同秒版本应通过 >= 过滤");
    }

    #[test]
    fn test_detect_no_conflicts() {
        let local = create_test_manifest("device-1", vec![("chat_v2", 1, 100, "abc123")]);
        let cloud = create_test_manifest("device-2", vec![("chat_v2", 1, 100, "abc123")]);

        let result = SyncManager::detect_conflicts(&local, &cloud).unwrap();
        assert!(!result.has_conflicts);
        assert!(result.database_conflicts.is_empty());
    }

    #[test]
    fn test_detect_schema_mismatch() {
        let local = create_test_manifest("device-1", vec![("chat_v2", 1, 100, "abc123")]);
        let cloud = create_test_manifest("device-2", vec![("chat_v2", 2, 100, "abc123")]);

        let result = SyncManager::detect_conflicts(&local, &cloud).unwrap();
        assert!(result.has_conflicts);
        assert!(result.needs_migration);
        assert_eq!(result.database_conflicts.len(), 1);
        assert_eq!(
            result.database_conflicts[0].conflict_type,
            DatabaseConflictType::SchemaMismatch
        );
    }

    #[test]
    fn test_detect_data_conflict() {
        let local = create_test_manifest("device-1", vec![("chat_v2", 1, 101, "abc123")]);
        let cloud = create_test_manifest("device-2", vec![("chat_v2", 1, 102, "def456")]);

        let result = SyncManager::detect_conflicts(&local, &cloud).unwrap();
        assert!(result.has_conflicts);
        assert!(!result.needs_migration);
        assert_eq!(result.database_conflicts.len(), 1);
        assert_eq!(
            result.database_conflicts[0].conflict_type,
            DatabaseConflictType::DataConflict
        );
    }

    #[test]
    fn test_detect_local_only() {
        let local = create_test_manifest(
            "device-1",
            vec![("chat_v2", 1, 100, "abc123"), ("mistakes", 1, 50, "xyz789")],
        );
        let cloud = create_test_manifest("device-2", vec![("chat_v2", 1, 100, "abc123")]);

        let result = SyncManager::detect_conflicts(&local, &cloud).unwrap();
        assert!(result.has_conflicts);
        assert_eq!(result.database_conflicts.len(), 1);
        assert_eq!(
            result.database_conflicts[0].conflict_type,
            DatabaseConflictType::LocalOnly
        );
        assert_eq!(result.database_conflicts[0].database_name, "mistakes");
    }

    #[test]
    fn test_detect_cloud_only() {
        let local = create_test_manifest("device-1", vec![("chat_v2", 1, 100, "abc123")]);
        let cloud = create_test_manifest(
            "device-2",
            vec![
                ("chat_v2", 1, 100, "abc123"),
                ("llm_usage", 1, 200, "qwe456"),
            ],
        );

        let result = SyncManager::detect_conflicts(&local, &cloud).unwrap();
        assert!(result.has_conflicts);
        assert_eq!(result.database_conflicts.len(), 1);
        assert_eq!(
            result.database_conflicts[0].conflict_type,
            DatabaseConflictType::CloudOnly
        );
        assert_eq!(result.database_conflicts[0].database_name, "llm_usage");
    }

    #[test]
    fn test_sync_keep_local() {
        let manager = SyncManager::new("device-1".to_string());
        let result = ConflictDetectionResult::empty();

        let sync_result = manager.sync(MergeStrategy::KeepLocal, &result).unwrap();
        assert!(sync_result.success);
    }

    #[test]
    fn test_record_conflict_detection() {
        let local_records = vec![RecordSnapshot {
            table_name: "messages".to_string(),
            record_id: "msg-1".to_string(),
            local_version: 3,
            sync_version: 2,
            updated_at: "2024-01-01T10:00:00Z".to_string(),
            deleted_at: None,
            data: serde_json::json!({"content": "local edit"}),
        }];

        let cloud_records = vec![RecordSnapshot {
            table_name: "messages".to_string(),
            record_id: "msg-1".to_string(),
            local_version: 4,
            sync_version: 2,
            updated_at: "2024-01-01T11:00:00Z".to_string(),
            deleted_at: None,
            data: serde_json::json!({"content": "cloud edit"}),
        }];

        let conflicts =
            SyncManager::detect_record_conflicts("chat_v2", &local_records, &cloud_records);

        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].record_id, "msg-1");
        assert_eq!(conflicts[0].local_version, 3);
        assert_eq!(conflicts[0].cloud_version, 4);
    }

    // ========================================================================
    // 新增测试：核心同步方法
    // ========================================================================

    /// 创建测试用的内存数据库并初始化 __change_log 表
    fn create_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS __change_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                table_name TEXT NOT NULL,
                record_id TEXT NOT NULL,
                operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE')),
                changed_at TEXT NOT NULL DEFAULT (datetime('now')),
                sync_version INTEGER DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx__change_log_sync_version ON __change_log(sync_version);

            CREATE TABLE IF NOT EXISTS refinery_schema_history (
                version INTEGER PRIMARY KEY,
                name TEXT,
                applied_on TEXT,
                checksum TEXT
            );

            -- 插入测试用的 schema 版本（与 refinery 迁移系统权威表结构一致）
            INSERT INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (1, 'V1__init', '2024-01-01T00:00:00Z', 'abc');
            INSERT INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (2, 'V2__update', '2024-01-02T00:00:00Z', 'def');
            "#,
        )
        .unwrap();
        conn
    }

    #[test]
    fn test_checksum_detects_content_drift_without_updated_at_change() {
        let conn = create_test_db();
        conn.execute_batch(
            r#"
            CREATE TABLE notes (
                id TEXT PRIMARY KEY,
                title TEXT,
                body TEXT,
                updated_at TEXT,
                deleted_at TEXT
            );
            INSERT INTO notes (id, title, body, updated_at, deleted_at)
            VALUES ('note-1', 'Title', 'before', '2026-01-01T00:00:00Z', NULL);
            "#,
        )
        .unwrap();

        let before = SyncManager::calculate_drift_checksum_v2(&conn, "vfs").unwrap();
        conn.execute("UPDATE notes SET body = 'after' WHERE id = 'note-1'", [])
            .unwrap();
        let after = SyncManager::calculate_drift_checksum_v2(&conn, "vfs").unwrap();

        assert_ne!(
            before, after,
            "checksum must detect row content drift even when count and updated_at do not change"
        );
    }

    /// 插入测试用的变更日志
    fn insert_test_change_log(
        conn: &Connection,
        table_name: &str,
        record_id: &str,
        operation: &str,
        sync_version: i64,
    ) {
        conn.execute(
            "INSERT INTO __change_log (table_name, record_id, operation, sync_version)
             VALUES (?1, ?2, ?3, ?4)",
            params![table_name, record_id, operation, sync_version],
        )
        .unwrap();
    }

    #[test]
    fn test_get_pending_changes_empty() {
        let conn = create_test_db();

        let pending = SyncManager::get_pending_changes(&conn, None, None).unwrap();

        assert!(!pending.has_changes());
        assert_eq!(pending.total_count, 0);
        assert!(pending.entries.is_empty());
    }

    #[test]
    fn test_get_pending_changes_with_data() {
        let conn = create_test_db();

        // 插入一些待同步的变更
        insert_test_change_log(&conn, "messages", "msg-1", "INSERT", 0);
        insert_test_change_log(&conn, "messages", "msg-2", "UPDATE", 0);
        insert_test_change_log(&conn, "sessions", "sess-1", "INSERT", 0);
        // 这条已同步，不应该出现
        insert_test_change_log(&conn, "messages", "msg-3", "DELETE", 100);

        let pending = SyncManager::get_pending_changes(&conn, None, None).unwrap();

        assert!(pending.has_changes());
        assert_eq!(pending.total_count, 3);
        assert_eq!(pending.changes_by_table.get("messages"), Some(&2));
        assert_eq!(pending.changes_by_table.get("sessions"), Some(&1));
    }

    #[test]
    fn test_get_pending_changes_with_field_deltas_json() {
        let conn = create_test_db();
        conn.execute(
            "ALTER TABLE __change_log ADD COLUMN field_deltas_json TEXT",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO __change_log (table_name, record_id, operation, field_deltas_json, sync_version)
             VALUES ('resources', 'res-1', 'UPDATE', '{\"ref_count\":1}', 0)",
            [],
        )
        .unwrap();

        let pending = SyncManager::get_pending_changes(&conn, None, None).unwrap();
        assert_eq!(pending.total_count, 1);
        assert_eq!(
            pending.entries[0].field_deltas_json,
            Some(json!({"ref_count": 1}))
        );
    }

    #[test]
    fn test_from_entry_with_data_injects_field_deltas_metadata() {
        let entry = ChangeLogEntry {
            id: 1,
            table_name: "resources".to_string(),
            record_id: "res-1".to_string(),
            operation: ChangeOperation::Update,
            changed_at: "2024-01-01T10:00:00Z".to_string(),
            sync_version: 0,
            field_deltas_json: Some(json!({"ref_count": 1})),
        };

        let change = SyncChangeWithData::from_entry_with_data(
            &entry,
            Some(json!({
                "id": "res-1",
                "ref_count": 2,
                "updated_at": "2024-01-01T10:00:00Z"
            })),
        );

        let data = change.data.expect("data should be present");
        assert_eq!(data["__sync_field_deltas"], json!({"ref_count": 1}));
    }

    #[test]
    fn test_get_pending_changes_with_table_filter() {
        let conn = create_test_db();

        insert_test_change_log(&conn, "messages", "msg-1", "INSERT", 0);
        insert_test_change_log(&conn, "messages", "msg-2", "UPDATE", 0);
        insert_test_change_log(&conn, "sessions", "sess-1", "INSERT", 0);

        let pending = SyncManager::get_pending_changes(&conn, Some("messages"), None).unwrap();

        assert_eq!(pending.total_count, 2);
        assert!(pending.entries.iter().all(|e| e.table_name == "messages"));
    }

    #[test]
    fn test_get_pending_changes_with_limit() {
        let conn = create_test_db();

        for i in 0..10 {
            insert_test_change_log(&conn, "messages", &format!("msg-{}", i), "INSERT", 0);
        }

        let pending = SyncManager::get_pending_changes(&conn, None, Some(5)).unwrap();

        assert_eq!(pending.total_count, 5);
    }

    #[test]
    fn test_mark_synced() {
        let conn = create_test_db();

        insert_test_change_log(&conn, "messages", "msg-1", "INSERT", 0);
        insert_test_change_log(&conn, "messages", "msg-2", "UPDATE", 0);
        insert_test_change_log(&conn, "messages", "msg-3", "DELETE", 0);

        // 标记前两条为已同步
        let updated = SyncManager::mark_synced(&conn, &[1, 2], 1000).unwrap();
        assert_eq!(updated, 2);

        // 验证只剩一条待同步
        let pending = SyncManager::get_pending_changes(&conn, None, None).unwrap();
        assert_eq!(pending.total_count, 1);
        assert_eq!(pending.entries[0].record_id, "msg-3");
    }

    #[test]
    fn test_mark_synced_empty() {
        let conn = create_test_db();

        let updated = SyncManager::mark_synced(&conn, &[], 1000).unwrap();
        assert_eq!(updated, 0);
    }

    #[test]
    fn test_mark_synced_with_timestamp() {
        let conn = create_test_db();

        insert_test_change_log(&conn, "messages", "msg-1", "INSERT", 0);

        let updated = SyncManager::mark_synced_with_timestamp(&conn, &[1]).unwrap();
        assert_eq!(updated, 1);

        // 验证已同步
        let pending = SyncManager::get_pending_changes(&conn, None, None).unwrap();
        assert!(!pending.has_changes());
    }

    #[test]
    fn test_cleanup_synced_changes() {
        let conn = create_test_db();

        // 插入变更并标记为已同步
        conn.execute(
            "INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
             VALUES ('messages', 'msg-1', 'INSERT', '2024-01-01T00:00:00Z', 100)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
             VALUES ('messages', 'msg-2', 'UPDATE', '2024-01-15T00:00:00Z', 100)",
            [],
        )
        .unwrap();
        // 这条未同步，不应该被删除
        conn.execute(
            "INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
             VALUES ('messages', 'msg-3', 'DELETE', '2024-01-01T00:00:00Z', 0)",
            [],
        )
        .unwrap();

        // 清理 2024-01-10 之前的已同步记录
        let deleted = SyncManager::cleanup_synced_changes(&conn, "2024-01-10T00:00:00Z").unwrap();
        assert_eq!(deleted, 1);

        // 验证还剩两条记录
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM __change_log", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn test_compare_timestamps_hlc_fast_path() {
        // 两端都是 HLC，应走 HLC 序比较（更精确，同毫秒 counter 决胜）
        let earlier = hlc::Hlc::new(1_700_000_000_000, 0).to_string();
        let later = hlc::Hlc::new(1_700_000_000_000, 1).to_string();

        // counter 1 > counter 0 → Greater
        assert_eq!(
            SyncManager::compare_timestamps(&later, &earlier),
            std::cmp::Ordering::Greater
        );
        assert_eq!(
            SyncManager::compare_timestamps(&earlier, &later),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            SyncManager::compare_timestamps(&earlier, &earlier),
            std::cmp::Ordering::Equal,
            "纯时间戳比较使用中性设备分量：平局必须对称地返回 Equal，\
             不能被评估方视角扭曲成本地恒胜（否则两端各自判赢、永不收敛）"
        );
    }

    #[test]
    fn test_compare_timestamps_mixed_hlc_and_iso() {
        // 只有一端是 HLC → 回落到 timestamp 比较路径（都解析失败或部分失败走 None 分支）
        let hlc_str = hlc::Hlc::new(1_700_000_000_000, 0).to_string();
        let iso_str = "2024-01-01T00:00:00Z";

        // HLC 格式 Hlc::parse 成功，ISO 格式 Hlc::parse 失败 → 降级到 timestamp path
        // HLC 的 `015-05` 固定宽度不是有效 RFC3339，parse_flexible_timestamp 会返回 None
        // 于是落到 (None, Some) → Less
        let r = SyncManager::compare_timestamps(&hlc_str, iso_str);
        assert_eq!(r, std::cmp::Ordering::Less);
    }

    #[test]
    fn test_reset_sync_baseline_after_restore() {
        let conn = create_test_db();

        // 创建一张业务表，带同步列
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS notes (
                id TEXT PRIMARY KEY,
                content TEXT,
                device_id TEXT,
                local_version INTEGER DEFAULT 0,
                sync_version INTEGER DEFAULT 0,
                updated_at TEXT,
                deleted_at TEXT
            );
            INSERT INTO notes (id, content, local_version, sync_version, updated_at)
            VALUES ('n1', 'hello', 5, 3, '2024-01-01T00:00:00Z'),
                   ('n2', 'world', 2, 2, '2024-01-02T00:00:00Z');",
        )
        .unwrap();

        // 插入 __change_log 历史条目（模拟源设备的残留）
        conn.execute(
            "INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
             VALUES ('notes', 'n1', 'UPDATE', '2024-01-01T00:00:00Z', 100)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
             VALUES ('notes', 'n2', 'INSERT', '2024-01-02T00:00:00Z', 0)",
            [],
        )
        .unwrap();

        let (truncated, reset) = SyncManager::reset_sync_baseline_after_restore(&conn).unwrap();
        assert_eq!(truncated, 2);
        // 优化后仅更新 "sync_version != local_version" 的行，避免不必要的 trigger。
        // n1 (lv=5, sv=3) 需要更新；n2 (lv=2, sv=2) 相等不需更新。
        assert_eq!(reset, 1);

        // __change_log 应为空
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM __change_log", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);

        // sync_version 应等于 local_version
        let (lv1, sv1): (i64, i64) = conn
            .query_row(
                "SELECT local_version, sync_version FROM notes WHERE id = 'n1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(lv1, 5);
        assert_eq!(sv1, 5); // 从 3 提升到 5
        let (lv2, sv2): (i64, i64) = conn
            .query_row(
                "SELECT local_version, sync_version FROM notes WHERE id = 'n2'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(lv2, 2);
        assert_eq!(sv2, 2); // 已经相等，无变化
    }

    #[test]
    fn test_apply_merge_strategy_keep_local() {
        let conflicts = vec![ConflictRecord {
            database_name: "chat_v2".to_string(),
            table_name: "messages".to_string(),
            record_id: "msg-1".to_string(),
            local_version: 3,
            cloud_version: 4,
            local_updated_at: "2024-01-01T10:00:00Z".to_string(),
            cloud_updated_at: "2024-01-01T11:00:00Z".to_string(),
            local_data: serde_json::json!({"content": "local"}),
            cloud_data: serde_json::json!({"content": "cloud"}),
        }];

        let result =
            SyncManager::apply_merge_strategy(MergeStrategy::KeepLocal, &conflicts).unwrap();

        assert!(result.success);
        assert_eq!(result.kept_local, 1);
        assert_eq!(result.used_cloud, 0);
        assert_eq!(result.records_to_push, vec!["msg-1"]);
        assert!(result.records_to_pull.is_empty());
    }

    #[test]
    fn test_apply_merge_strategy_use_cloud() {
        let conflicts = vec![ConflictRecord {
            database_name: "chat_v2".to_string(),
            table_name: "messages".to_string(),
            record_id: "msg-1".to_string(),
            local_version: 3,
            cloud_version: 4,
            local_updated_at: "2024-01-01T10:00:00Z".to_string(),
            cloud_updated_at: "2024-01-01T11:00:00Z".to_string(),
            local_data: serde_json::json!({"content": "local"}),
            cloud_data: serde_json::json!({"content": "cloud"}),
        }];

        let result =
            SyncManager::apply_merge_strategy(MergeStrategy::UseCloud, &conflicts).unwrap();

        assert!(result.success);
        assert_eq!(result.kept_local, 0);
        assert_eq!(result.used_cloud, 1);
        assert!(result.records_to_push.is_empty());
        assert_eq!(result.records_to_pull, vec!["msg-1"]);
    }

    #[test]
    fn test_apply_merge_strategy_keep_latest() {
        let conflicts = vec![
            // 云端更新
            ConflictRecord {
                database_name: "chat_v2".to_string(),
                table_name: "messages".to_string(),
                record_id: "msg-1".to_string(),
                local_version: 3,
                cloud_version: 4,
                local_updated_at: "2024-01-01T10:00:00Z".to_string(),
                cloud_updated_at: "2024-01-01T11:00:00Z".to_string(),
                local_data: serde_json::json!({"content": "local"}),
                cloud_data: serde_json::json!({"content": "cloud"}),
            },
            // 本地更新
            ConflictRecord {
                database_name: "chat_v2".to_string(),
                table_name: "messages".to_string(),
                record_id: "msg-2".to_string(),
                local_version: 5,
                cloud_version: 3,
                local_updated_at: "2024-01-01T12:00:00Z".to_string(),
                cloud_updated_at: "2024-01-01T09:00:00Z".to_string(),
                local_data: serde_json::json!({"content": "local new"}),
                cloud_data: serde_json::json!({"content": "cloud old"}),
            },
        ];

        let result =
            SyncManager::apply_merge_strategy(MergeStrategy::KeepLatest, &conflicts).unwrap();

        assert!(result.success);
        assert_eq!(result.kept_local, 1);
        assert_eq!(result.used_cloud, 1);
        assert_eq!(result.records_to_push, vec!["msg-2"]);
        assert_eq!(result.records_to_pull, vec!["msg-1"]);
    }

    #[test]
    fn regression_m3_keep_latest_uses_device_tiebreaker() {
        let conflicts = vec![ConflictRecord {
            database_name: "chat_v2".to_string(),
            table_name: "messages".to_string(),
            record_id: "msg-1".to_string(),
            local_version: 3,
            cloud_version: 4,
            local_updated_at: "2024-01-01T10:00:00Z".to_string(),
            cloud_updated_at: "2024-01-01T10:00:00Z".to_string(),
            local_data: serde_json::json!({"content": "local", "device_id": "device-a"}),
            cloud_data: serde_json::json!({"content": "cloud", "device_id": "device-b"}),
        }];

        let result =
            SyncManager::apply_merge_strategy(MergeStrategy::KeepLatest, &conflicts).unwrap();

        assert!(result.success);
        assert_eq!(result.kept_local, 0);
        assert_eq!(result.used_cloud, 1);
        assert!(result.records_to_push.is_empty());
        assert_eq!(result.records_to_pull, vec!["msg-1"]);
    }

    #[test]
    fn test_apply_merge_strategy_manual_error() {
        let conflicts = vec![ConflictRecord {
            database_name: "chat_v2".to_string(),
            table_name: "messages".to_string(),
            record_id: "msg-1".to_string(),
            local_version: 3,
            cloud_version: 4,
            local_updated_at: "2024-01-01T10:00:00Z".to_string(),
            cloud_updated_at: "2024-01-01T11:00:00Z".to_string(),
            local_data: serde_json::json!({"content": "local"}),
            cloud_data: serde_json::json!({"content": "cloud"}),
        }];

        let result = SyncManager::apply_merge_strategy(MergeStrategy::Manual, &conflicts);

        assert!(result.is_err());
        match result {
            Err(SyncError::ManualResolutionRequired { count }) => {
                assert_eq!(count, 1);
            }
            _ => panic!("Expected ManualResolutionRequired error"),
        }
    }

    #[test]
    fn test_get_change_log_stats() {
        let conn = create_test_db();

        // 插入混合状态的变更日志
        insert_test_change_log(&conn, "messages", "msg-1", "INSERT", 0);
        insert_test_change_log(&conn, "messages", "msg-2", "UPDATE", 0);
        insert_test_change_log(&conn, "messages", "msg-3", "DELETE", 100);
        insert_test_change_log(&conn, "sessions", "sess-1", "INSERT", 200);

        let stats = SyncManager::get_change_log_stats(&conn).unwrap();

        assert_eq!(stats.total_count, 4);
        assert_eq!(stats.pending_count, 2);
        assert_eq!(stats.synced_count, 2);
    }

    #[test]
    fn test_change_operation_from_str() {
        assert_eq!(
            ChangeOperation::from_str("INSERT"),
            Some(ChangeOperation::Insert)
        );
        assert_eq!(
            ChangeOperation::from_str("insert"),
            Some(ChangeOperation::Insert)
        );
        assert_eq!(
            ChangeOperation::from_str("UPDATE"),
            Some(ChangeOperation::Update)
        );
        assert_eq!(
            ChangeOperation::from_str("DELETE"),
            Some(ChangeOperation::Delete)
        );
        assert_eq!(ChangeOperation::from_str("INVALID"), None);
    }

    #[test]
    fn test_change_operation_as_str() {
        assert_eq!(ChangeOperation::Insert.as_str(), "INSERT");
        assert_eq!(ChangeOperation::Update.as_str(), "UPDATE");
        assert_eq!(ChangeOperation::Delete.as_str(), "DELETE");
    }

    #[test]
    fn test_pending_changes_get_table_changes() {
        let entries = vec![
            ChangeLogEntry {
                id: 1,
                table_name: "messages".to_string(),
                record_id: "msg-1".to_string(),
                operation: ChangeOperation::Insert,
                changed_at: "2024-01-01T10:00:00Z".to_string(),
                sync_version: 0,
                field_deltas_json: None,
            },
            ChangeLogEntry {
                id: 2,
                table_name: "sessions".to_string(),
                record_id: "sess-1".to_string(),
                operation: ChangeOperation::Insert,
                changed_at: "2024-01-01T11:00:00Z".to_string(),
                sync_version: 0,
                field_deltas_json: None,
            },
            ChangeLogEntry {
                id: 3,
                table_name: "messages".to_string(),
                record_id: "msg-2".to_string(),
                operation: ChangeOperation::Update,
                changed_at: "2024-01-01T12:00:00Z".to_string(),
                sync_version: 0,
                field_deltas_json: None,
            },
        ];

        let pending = PendingChanges::from_entries(entries);

        let message_changes = pending.get_table_changes("messages");
        assert_eq!(message_changes.len(), 2);

        let session_changes = pending.get_table_changes("sessions");
        assert_eq!(session_changes.len(), 1);

        let other_changes = pending.get_table_changes("other");
        assert!(other_changes.is_empty());
    }

    #[test]
    fn test_pending_changes_get_change_ids() {
        let entries = vec![
            ChangeLogEntry {
                id: 1,
                table_name: "messages".to_string(),
                record_id: "msg-1".to_string(),
                operation: ChangeOperation::Insert,
                changed_at: "2024-01-01T10:00:00Z".to_string(),
                sync_version: 0,
                field_deltas_json: None,
            },
            ChangeLogEntry {
                id: 5,
                table_name: "messages".to_string(),
                record_id: "msg-2".to_string(),
                operation: ChangeOperation::Update,
                changed_at: "2024-01-01T11:00:00Z".to_string(),
                sync_version: 0,
                field_deltas_json: None,
            },
        ];

        let pending = PendingChanges::from_entries(entries);
        let ids = pending.get_change_ids();

        assert_eq!(ids, vec![1, 5]);
    }

    #[test]
    fn test_pending_changes_time_range() {
        let entries = vec![
            ChangeLogEntry {
                id: 1,
                table_name: "messages".to_string(),
                record_id: "msg-1".to_string(),
                operation: ChangeOperation::Insert,
                changed_at: "2024-01-01T12:00:00Z".to_string(),
                sync_version: 0,
                field_deltas_json: None,
            },
            ChangeLogEntry {
                id: 2,
                table_name: "messages".to_string(),
                record_id: "msg-2".to_string(),
                operation: ChangeOperation::Update,
                changed_at: "2024-01-01T08:00:00Z".to_string(),
                sync_version: 0,
                field_deltas_json: None,
            },
            ChangeLogEntry {
                id: 3,
                table_name: "messages".to_string(),
                record_id: "msg-3".to_string(),
                operation: ChangeOperation::Delete,
                changed_at: "2024-01-01T15:00:00Z".to_string(),
                sync_version: 0,
                field_deltas_json: None,
            },
        ];

        let pending = PendingChanges::from_entries(entries);

        assert_eq!(
            pending.earliest_change,
            Some("2024-01-01T08:00:00Z".to_string())
        );
        assert_eq!(
            pending.latest_change,
            Some("2024-01-01T15:00:00Z".to_string())
        );
    }

    #[test]
    fn test_merge_application_result() {
        let success = MergeApplicationResult::success(3, 2);
        assert!(success.success);
        assert_eq!(success.kept_local, 3);
        assert_eq!(success.used_cloud, 2);

        let failure = MergeApplicationResult::failure(vec!["error1".to_string()]);
        assert!(!failure.success);
        assert_eq!(failure.errors, vec!["error1"]);
    }

    // ========================================================================
    // apply_downloaded_changes: data=None 跳过行为测试
    // ========================================================================

    /// 创建包含业务表的测试数据库（用于 apply 测试）
    fn create_test_db_with_business_table() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE test_records (
                id TEXT PRIMARY KEY,
                content TEXT,
                updated_at TEXT
            );
            CREATE TABLE IF NOT EXISTS __change_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                table_name TEXT NOT NULL,
                record_id TEXT NOT NULL,
                operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE')),
                changed_at TEXT NOT NULL DEFAULT (datetime('now')),
                sync_version INTEGER DEFAULT 0
            );
            "#,
        )
        .unwrap();
        conn
    }

    fn operation_change(
        operation: ChangeOperation,
        changed_at: &str,
        data: Option<serde_json::Value>,
        source_device_id: &str,
        source_seq: u64,
    ) -> SyncChangeWithData {
        SyncChangeWithData {
            table_name: "test_records".to_string(),
            record_id: "delete-version-record".to_string(),
            operation,
            data,
            changed_at: changed_at.to_string(),
            change_log_id: None,
            database_name: Some("vfs".to_string()),
            suppress_change_log: Some(true),
            source_device_id: Some(source_device_id.to_string()),
            source_seq: Some(source_seq),
        }
    }

    #[test]
    fn delete_version_blocks_delayed_older_upsert() {
        let conn = create_test_db_with_business_table();
        conn.execute(
            "INSERT INTO test_records(id, content, updated_at) VALUES(?1, ?2, ?3)",
            params![
                "delete-version-record",
                "before-delete",
                "2026-07-10T10:00:00Z"
            ],
        )
        .unwrap();

        let delete = operation_change(
            ChangeOperation::Delete,
            "2026-07-10T12:00:00Z",
            None,
            "device-delete",
            7,
        );
        let stale_upsert = operation_change(
            ChangeOperation::Update,
            "2026-07-10T11:00:00Z",
            Some(json!({
                "id": "delete-version-record",
                "content": "stale-resurrection",
                "updated_at": "2026-07-10T11:00:00Z"
            })),
            "device-offline",
            99,
        );

        let deleted = SyncManager::apply_downloaded_changes(&conn, &[delete], None).unwrap();
        assert_eq!(deleted.success_count, 1);
        let delayed = SyncManager::apply_downloaded_changes(&conn, &[stale_upsert], None).unwrap();
        assert_eq!(delayed.success_count, 0);
        assert_eq!(delayed.skipped_count, 1);
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM test_records WHERE id='delete-version-record'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "迟到的旧 UPSERT 不得复活已删除记录");
    }

    #[test]
    fn strictly_newer_upsert_can_resurrect_and_clears_delete_version() {
        let conn = create_test_db_with_business_table();
        let delete = operation_change(
            ChangeOperation::Delete,
            "2026-07-10T12:00:00Z",
            None,
            "device-delete",
            7,
        );
        let newer_upsert = operation_change(
            ChangeOperation::Insert,
            "2026-07-10T13:00:00Z",
            Some(json!({
                "id": "delete-version-record",
                "content": "intentional-resurrection",
                "updated_at": "2026-07-10T13:00:00Z"
            })),
            "device-newer",
            1,
        );

        SyncManager::apply_downloaded_changes(&conn, &[delete], None).unwrap();
        let applied = SyncManager::apply_downloaded_changes(&conn, &[newer_upsert], None).unwrap();
        assert_eq!(applied.success_count, 1);
        let content: String = conn
            .query_row(
                "SELECT content FROM test_records WHERE id='delete-version-record'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(content, "intentional-resurrection");
        let ledger_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM __sync_delete_versions
                 WHERE table_name='test_records' AND record_id='delete-version-record'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ledger_count, 0, "成功的新写入应清理旧 DELETE 版本");
    }

    #[test]
    fn regression_m5_apply_explicit_null_clears_column() {
        let conn = create_test_db_with_business_table();
        conn.execute(
            "INSERT INTO test_records(id, content, updated_at) VALUES(?1, ?2, ?3)",
            rusqlite::params!["rec-null", "keep-me", "2024-01-01T00:00:00Z"],
        )
        .unwrap();

        let changes = vec![SyncChangeWithData {
            table_name: "test_records".to_string(),
            record_id: "rec-null".to_string(),
            operation: ChangeOperation::Update,
            data: Some(json!({
                "id": "rec-null",
                "content": null,
                "updated_at": "2024-01-02T00:00:00Z",
            })),
            changed_at: "2024-01-02T00:00:00Z".to_string(),
            change_log_id: None,
            database_name: None,
            suppress_change_log: None,
            source_device_id: None,
            source_seq: None,
        }];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
        assert_eq!(result.success_count, 1);

        let content: Option<String> = conn
            .query_row(
                "SELECT content FROM test_records WHERE id='rec-null'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(content.is_none(), "显式 JSON null 必须传播为 SQL NULL");
    }

    #[test]
    fn regression_m1_single_sided_remote_tag_delete_is_not_field_merged_back() {
        let conn = create_test_db();
        conn.execute_batch(
            r#"
            CREATE TABLE notes (
                id TEXT PRIMARY KEY,
                tags TEXT,
                is_favorite INTEGER DEFAULT 0,
                updated_at TEXT
            );
            "#,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes(id, tags, updated_at) VALUES(?1, ?2, ?3)",
            rusqlite::params!["note-1", r#"["local"]"#, "2026-02-09T00:00:00Z"],
        )
        .unwrap();

        let changes = vec![SyncChangeWithData {
            table_name: "notes".to_string(),
            record_id: "note-1".to_string(),
            operation: ChangeOperation::Update,
            data: Some(json!({
                "id": "note-1",
                "tags": [],
                "updated_at": "2026-02-10T00:00:00Z",
            })),
            changed_at: "2026-02-10T00:00:00Z".to_string(),
            change_log_id: None,
            database_name: Some("vfs".to_string()),
            suppress_change_log: Some(true),
            source_device_id: None,
            source_seq: None,
        }];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
        assert_eq!(result.success_count, 1);

        let tags: String = conn
            .query_row("SELECT tags FROM notes WHERE id='note-1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(tags, "[]", "非并发远端删 tag 不能被本地旧 tag 复活");
    }

    #[test]
    fn regression_m1_pending_local_change_allows_field_merge() {
        let conn = create_test_db();
        conn.execute_batch(
            r#"
            CREATE TABLE notes (
                id TEXT PRIMARY KEY,
                tags TEXT,
                is_favorite INTEGER DEFAULT 0,
                updated_at TEXT
            );
            "#,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes(id, tags, updated_at) VALUES(?1, ?2, ?3)",
            rusqlite::params!["note-merge", r#"["local"]"#, "2026-02-09T00:00:00Z"],
        )
        .unwrap();
        insert_test_change_log(&conn, "notes", "note-merge", "UPDATE", 0);

        let changes = vec![SyncChangeWithData {
            table_name: "notes".to_string(),
            record_id: "note-merge".to_string(),
            operation: ChangeOperation::Update,
            data: Some(json!({
                "id": "note-merge",
                "tags": ["remote"],
                "updated_at": "2026-02-10T00:00:00Z",
            })),
            changed_at: "2026-02-10T00:00:00Z".to_string(),
            change_log_id: None,
            database_name: Some("vfs".to_string()),
            suppress_change_log: Some(true),
            source_device_id: None,
            source_seq: None,
        }];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
        assert_eq!(result.success_count, 1);

        let tags: String = conn
            .query_row("SELECT tags FROM notes WHERE id='note-merge'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            tags, r#"["local","remote"]"#,
            "本地存在 pending 修改时仍允许集合字段并发合并"
        );
    }

    #[test]
    fn test_apply_insert_with_data_none_is_skipped() {
        let conn = create_test_db_with_business_table();

        let changes = vec![SyncChangeWithData {
            table_name: "test_records".to_string(),
            record_id: "rec-1".to_string(),
            operation: ChangeOperation::Insert,
            data: None, // 旧格式：无数据
            changed_at: "2024-01-01T10:00:00Z".to_string(),
            change_log_id: None,
            database_name: None,
            suppress_change_log: None,
            source_device_id: None,
            source_seq: None,
        }];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

        assert_eq!(result.success_count, 0);
        assert_eq!(
            result.skipped_count, 1,
            "data=None INSERT should be skipped, not error"
        );
        assert_eq!(
            result.skipped_incomplete_count, 1,
            "data=None INSERT should be counted as incomplete skipped"
        );
        assert_eq!(result.failure_count, 0);

        // 验证记录不存在
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM test_records WHERE id = 'rec-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_apply_update_with_data_none_is_skipped() {
        let conn = create_test_db_with_business_table();

        // 先插入一条记录
        conn.execute(
            "INSERT INTO test_records (id, content) VALUES ('existing', 'original')",
            [],
        )
        .unwrap();

        let changes = vec![SyncChangeWithData {
            table_name: "test_records".to_string(),
            record_id: "existing".to_string(),
            operation: ChangeOperation::Update,
            data: None, // 旧格式：无数据
            changed_at: "2024-01-01T10:00:00Z".to_string(),
            change_log_id: None,
            database_name: None,
            suppress_change_log: None,
            source_device_id: None,
            source_seq: None,
        }];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

        assert_eq!(result.success_count, 0);
        assert_eq!(
            result.skipped_count, 1,
            "data=None UPDATE should be skipped"
        );
        assert_eq!(
            result.skipped_incomplete_count, 1,
            "data=None UPDATE should be counted as incomplete skipped"
        );
        assert_eq!(result.failure_count, 0);

        // 验证记录未被修改
        let content: String = conn
            .query_row(
                "SELECT content FROM test_records WHERE id = 'existing'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(content, "original");
    }

    #[test]
    fn test_apply_delete_without_data_succeeds() {
        let conn = create_test_db_with_business_table();

        conn.execute(
            "INSERT INTO test_records (id, content) VALUES ('to-delete', 'bye')",
            [],
        )
        .unwrap();

        let changes = vec![SyncChangeWithData {
            table_name: "test_records".to_string(),
            record_id: "to-delete".to_string(),
            operation: ChangeOperation::Delete,
            data: None, // DELETE 不需要数据
            changed_at: "2024-01-01T10:00:00Z".to_string(),
            change_log_id: None,
            database_name: None,
            suppress_change_log: None,
            source_device_id: None,
            source_seq: None,
        }];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

        assert_eq!(
            result.success_count, 1,
            "DELETE without data should succeed"
        );
        assert_eq!(result.skipped_count, 0);
        assert_eq!(result.skipped_incomplete_count, 0);

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM test_records WHERE id = 'to-delete'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_apply_mixed_data_none_and_valid() {
        let conn = create_test_db_with_business_table();

        let changes = vec![
            // 1. INSERT 无数据 → 跳过
            SyncChangeWithData {
                table_name: "test_records".to_string(),
                record_id: "no-data".to_string(),
                operation: ChangeOperation::Insert,
                data: None,
                changed_at: "2024-01-01T10:00:00Z".to_string(),
                change_log_id: None,
                database_name: None,
                suppress_change_log: None,
                source_device_id: None,
                source_seq: None,
            },
            // 2. INSERT 有数据 → 成功
            SyncChangeWithData {
                table_name: "test_records".to_string(),
                record_id: "has-data".to_string(),
                operation: ChangeOperation::Insert,
                data: Some(serde_json::json!({
                    "id": "has-data",
                    "content": "valid",
                    "updated_at": "2024-01-01"
                })),
                changed_at: "2024-01-01T10:00:01Z".to_string(),
                change_log_id: None,
                database_name: None,
                suppress_change_log: None,
                source_device_id: None,
                source_seq: None,
            },
        ];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

        assert_eq!(result.success_count, 1, "only valid INSERT should succeed");
        assert_eq!(
            result.skipped_count, 1,
            "data=None INSERT should be skipped"
        );
        assert_eq!(
            result.skipped_incomplete_count, 1,
            "only the data=None change should be counted as incomplete"
        );
        assert_eq!(result.failure_count, 0, "no failures expected");

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM test_records WHERE id = 'has-data'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "valid record should still be applied");
    }

    #[test]
    fn test_apply_semantically_equal_skip_is_not_incomplete() {
        let conn = create_test_db_with_business_table();

        conn.execute(
            "INSERT INTO test_records (id, content, updated_at) VALUES ('same', 'value', '2024-01-01')",
            [],
        )
        .unwrap();

        let changes = vec![SyncChangeWithData {
            table_name: "test_records".to_string(),
            record_id: "same".to_string(),
            operation: ChangeOperation::Update,
            data: Some(serde_json::json!({
                "id": "same",
                "content": "value",
                "updated_at": "2024-01-01"
            })),
            changed_at: "2024-01-01T10:00:00Z".to_string(),
            change_log_id: None,
            database_name: None,
            suppress_change_log: None,
            source_device_id: None,
            source_seq: None,
        }];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

        assert_eq!(result.success_count, 0);
        assert_eq!(result.skipped_count, 1);
        assert_eq!(
            result.skipped_incomplete_count, 0,
            "idempotent/equivalent replay should not surface as incomplete data"
        );
        assert_eq!(result.failure_count, 0);
    }

    #[test]
    fn test_get_record_data_composite_pk_with_json_record_id() {
        // 注：原测试针对 llm_usage_daily，但该表自 V20260525 起退出 RowSync
        // （派生聚合数据不再行级同步），get_record_data 会按白名单拒绝。
        // 此处改用测试白名单表验证"复合主键 + JSON record_id"解析能力。
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE test_usage_daily (
                date TEXT NOT NULL,
                caller_type TEXT NOT NULL,
                model TEXT NOT NULL,
                provider TEXT NOT NULL,
                request_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (date, caller_type, model, provider)
            );
            INSERT INTO test_usage_daily(date, caller_type, model, provider, request_count)
            VALUES('2026-02-10', 'chat', 'gpt-4o', 'openai', 7);
            "#,
        )
        .unwrap();

        let record_id = serde_json::json!({
            "date": "2026-02-10",
            "caller_type": "chat",
            "model": "gpt-4o",
            "provider": "openai"
        })
        .to_string();

        let data = SyncManager::get_record_data(&conn, "test_usage_daily", &record_id, "id")
            .unwrap()
            .expect("record should be found");

        assert_eq!(data["request_count"], serde_json::json!(7));
    }

    #[test]
    fn test_apply_downloaded_changes_can_suppress_change_log_echo() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE test_records (
                id TEXT PRIMARY KEY,
                content TEXT,
                updated_at TEXT
            );
            CREATE TABLE __change_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                table_name TEXT NOT NULL,
                record_id TEXT NOT NULL,
                operation TEXT NOT NULL,
                changed_at TEXT NOT NULL DEFAULT (datetime('now')),
                sync_version INTEGER DEFAULT 0
            );
            CREATE TRIGGER trg_echo_insert
            AFTER INSERT ON test_records
            BEGIN
                INSERT INTO __change_log(table_name, record_id, operation)
                VALUES('test_records', NEW.id, 'INSERT');
            END;
            "#,
        )
        .unwrap();

        let changes = vec![SyncChangeWithData {
            table_name: "test_records".to_string(),
            record_id: "r1".to_string(),
            operation: ChangeOperation::Insert,
            data: Some(serde_json::json!({
                "id": "r1",
                "content": "ok",
                "updated_at": "2026-02-10"
            })),
            changed_at: "2026-02-10T00:00:00Z".to_string(),
            change_log_id: None,
            database_name: Some("vfs".to_string()),
            suppress_change_log: Some(true),
            source_device_id: None,
            source_seq: None,
        }];

        SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

        let unsynced: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(unsynced, 0, "echo logs should be marked as synced");
    }

    #[test]
    fn test_apply_downloaded_changes_skips_equivalent_replay_without_new_echo_log() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE test_records (
                id TEXT PRIMARY KEY,
                content TEXT,
                updated_at TEXT
            );
            CREATE TABLE __change_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                table_name TEXT NOT NULL,
                record_id TEXT NOT NULL,
                operation TEXT NOT NULL,
                changed_at TEXT NOT NULL DEFAULT (datetime('now')),
                sync_version INTEGER DEFAULT 0
            );
            CREATE TRIGGER trg_echo_insert
            AFTER INSERT ON test_records
            BEGIN
                INSERT INTO __change_log(table_name, record_id, operation)
                VALUES('test_records', NEW.id, 'INSERT');
            END;
            CREATE TRIGGER trg_echo_update
            AFTER UPDATE ON test_records
            BEGIN
                INSERT INTO __change_log(table_name, record_id, operation)
                VALUES('test_records', NEW.id, 'UPDATE');
            END;
            "#,
        )
        .unwrap();

        let changes = vec![SyncChangeWithData {
            table_name: "test_records".to_string(),
            record_id: "r1".to_string(),
            operation: ChangeOperation::Insert,
            data: Some(serde_json::json!({
                "id": "r1",
                "content": "same",
                "updated_at": "2026-02-10T00:00:00Z"
            })),
            changed_at: "2026-02-10T00:00:00Z".to_string(),
            change_log_id: None,
            database_name: Some("vfs".to_string()),
            suppress_change_log: Some(true),
            source_device_id: None,
            source_seq: None,
        }];

        SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
        SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

        let log_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM __change_log", [], |r| r.get(0))
            .unwrap();
        let unsynced: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(
            log_count, 1,
            "equivalent replay must not generate another local echo log"
        );
        assert_eq!(unsynced, 0);
    }

    #[test]
    fn test_dedupe_downloaded_changes_collapses_equivalent_payloads() {
        let first = SyncChangeWithData {
            table_name: "test_records".to_string(),
            record_id: "r1".to_string(),
            operation: ChangeOperation::Update,
            data: Some(serde_json::json!({
                "id": "r1",
                "content": "same",
                "updated_at": "2026-02-10T00:00:00Z"
            })),
            changed_at: "2026-02-10T00:00:00Z".to_string(),
            change_log_id: Some(1),
            database_name: Some("vfs".to_string()),
            suppress_change_log: None,
            source_device_id: None,
            source_seq: None,
        };
        let mut duplicate = first.clone();
        duplicate.changed_at = "2026-02-10T00:00:05Z".to_string();
        duplicate.change_log_id = Some(99);

        let deduped = SyncManager::dedupe_downloaded_changes(vec![(1, first), (2, duplicate)]);

        assert_eq!(
            deduped.len(),
            1,
            "same final payload from multiple remote packages should apply once"
        );
    }

    #[test]
    fn test_detect_record_conflicts_with_diverged_sync_versions() {
        let local_records = vec![RecordSnapshot {
            table_name: "messages".to_string(),
            record_id: "msg-1".to_string(),
            local_version: 12,
            sync_version: 10,
            updated_at: "2026-02-10T10:00:00Z".to_string(),
            deleted_at: None,
            data: serde_json::json!({"content": "local edit"}),
        }];
        let cloud_records = vec![RecordSnapshot {
            table_name: "messages".to_string(),
            record_id: "msg-1".to_string(),
            local_version: 21,
            sync_version: 20,
            updated_at: "2026-02-10T10:01:00Z".to_string(),
            deleted_at: None,
            data: serde_json::json!({"content": "cloud edit"}),
        }];

        let conflicts =
            SyncManager::detect_record_conflicts("chat_v2", &local_records, &cloud_records);
        assert_eq!(
            conflicts.len(),
            1,
            "diverged sync_version should still detect conflict"
        );
    }

    #[test]
    fn test_detect_record_conflicts_same_data_not_conflict() {
        let local_records = vec![RecordSnapshot {
            table_name: "messages".to_string(),
            record_id: "msg-1".to_string(),
            local_version: 12,
            sync_version: 10,
            updated_at: "2026-02-10T10:00:00Z".to_string(),
            deleted_at: None,
            data: serde_json::json!({"content": "same"}),
        }];
        let cloud_records = vec![RecordSnapshot {
            table_name: "messages".to_string(),
            record_id: "msg-1".to_string(),
            local_version: 21,
            sync_version: 20,
            updated_at: "2026-02-10T10:01:00Z".to_string(),
            deleted_at: None,
            data: serde_json::json!({"content": "same"}),
        }];

        let conflicts =
            SyncManager::detect_record_conflicts("chat_v2", &local_records, &cloud_records);
        assert!(
            conflicts.is_empty(),
            "same payload should not be treated as conflict even when both modified"
        );
    }

    #[test]
    fn test_apply_delete_uses_tombstone_when_column_exists() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE test_records (
                id TEXT PRIMARY KEY,
                content TEXT,
                deleted_at TEXT
            );
            INSERT INTO test_records (id, content, deleted_at)
            VALUES ('r1', 'alive', NULL);
            "#,
        )
        .unwrap();

        let changes = vec![SyncChangeWithData {
            table_name: "test_records".to_string(),
            record_id: "r1".to_string(),
            operation: ChangeOperation::Delete,
            data: None,
            changed_at: "2026-02-10T00:00:00Z".to_string(),
            change_log_id: None,
            database_name: None,
            suppress_change_log: None,
            source_device_id: None,
            source_seq: None,
        }];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
        assert_eq!(result.success_count, 1);

        let row_state: (i64, Option<String>) = conn
            .query_row(
                "SELECT COUNT(*), MAX(deleted_at) FROM test_records WHERE id = 'r1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(row_state.0, 1, "tombstone delete should keep row");
        assert!(row_state.1.is_some(), "deleted_at should be set");
    }

    #[test]
    fn test_apply_skips_incomplete_upsert_shadowed_by_batch_delete() {
        let conn = create_test_db_with_business_table();

        let changes = vec![
            SyncChangeWithData {
                table_name: "test_records".to_string(),
                record_id: "hard-deleted".to_string(),
                operation: ChangeOperation::Insert,
                data: None,
                changed_at: "2026-02-10T00:00:00Z".to_string(),
                change_log_id: Some(1),
                database_name: Some("vfs".to_string()),
                suppress_change_log: Some(true),
                source_device_id: None,
                source_seq: None,
            },
            SyncChangeWithData {
                table_name: "test_records".to_string(),
                record_id: "hard-deleted".to_string(),
                operation: ChangeOperation::Delete,
                data: None,
                changed_at: "2026-02-10T00:00:01Z".to_string(),
                change_log_id: Some(2),
                database_name: Some("vfs".to_string()),
                suppress_change_log: Some(true),
                source_device_id: None,
                source_seq: None,
            },
        ];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

        assert_eq!(result.success_count, 1, "DELETE should still be applied");
        assert_eq!(result.skipped_count, 1);
        assert_eq!(result.skipped_incomplete_count, 1);
        assert_eq!(result.failure_count, 0);
    }

    #[test]
    fn test_conflict_guard_skips_incomplete_upsert_shadowed_by_batch_delete() {
        let conn = create_test_db_with_business_table();

        let changes = vec![
            SyncChangeWithData {
                table_name: "test_records".to_string(),
                record_id: "hard-deleted".to_string(),
                operation: ChangeOperation::Insert,
                data: None,
                changed_at: "2026-02-10T00:00:00Z".to_string(),
                change_log_id: Some(1),
                database_name: Some("vfs".to_string()),
                suppress_change_log: Some(true),
                source_device_id: None,
                source_seq: None,
            },
            SyncChangeWithData {
                table_name: "test_records".to_string(),
                record_id: "hard-deleted".to_string(),
                operation: ChangeOperation::Delete,
                data: None,
                changed_at: "2026-02-10T00:00:01Z".to_string(),
                change_log_id: Some(2),
                database_name: Some("vfs".to_string()),
                suppress_change_log: Some(true),
                source_device_id: None,
                source_seq: None,
            },
        ];

        let (result, conflict_result) = SyncManager::apply_downloaded_changes_with_conflict_guard(
            &conn,
            &changes,
            None,
            conflict_resolver::ConflictPolicy::KeepLatest,
            Some("cloud-device"),
            Some("local-device"),
        )
        .unwrap();

        assert_eq!(result.success_count, 1, "DELETE should still be applied");
        assert_eq!(result.skipped_count, 1);
        assert_eq!(result.skipped_incomplete_count, 1);
        assert_eq!(result.failure_count, 0);
        assert_eq!(conflict_result.conflicts_saved, 0);
    }

    #[test]
    fn test_apply_downloaded_changes_rolls_back_on_fk_violation() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            CREATE TABLE parent_records (
                id TEXT PRIMARY KEY
            );
            CREATE TABLE child_records (
                id TEXT PRIMARY KEY,
                parent_id TEXT NOT NULL,
                FOREIGN KEY(parent_id) REFERENCES parent_records(id)
            );
            CREATE TABLE test_records (
                id TEXT PRIMARY KEY,
                content TEXT
            );
            "#,
        )
        .unwrap();

        let changes = vec![
            SyncChangeWithData {
                table_name: "test_records".to_string(),
                record_id: "safe-1".to_string(),
                operation: ChangeOperation::Insert,
                data: Some(serde_json::json!({
                    "id": "safe-1",
                    "content": "should rollback"
                })),
                changed_at: "2026-02-10T00:00:00Z".to_string(),
                change_log_id: None,
                database_name: None,
                suppress_change_log: None,
                source_device_id: None,
                source_seq: None,
            },
            SyncChangeWithData {
                table_name: "child_records".to_string(),
                record_id: "child-1".to_string(),
                operation: ChangeOperation::Insert,
                data: Some(serde_json::json!({
                    "id": "child-1",
                    "parent_id": "missing-parent"
                })),
                changed_at: "2026-02-10T00:00:01Z".to_string(),
                change_log_id: None,
                database_name: None,
                suppress_change_log: None,
                source_device_id: None,
                source_seq: None,
            },
        ];

        // 2026-06 语义更新：FK 违规属于非瞬态错误，违规的单条变更回滚到
        // SAVEPOINT 并进入检疫表，批次继续应用（不再整批失败）——
        // 与 regression_m10_poison_payload_is_quarantined_without_blocking_batch 一致。
        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None)
            .expect("fk violation should be quarantined, not fail the batch");
        assert_eq!(result.success_count, 1, "safe record should be applied");
        assert_eq!(
            result.failure_count, 1,
            "violating record should be recorded as failure"
        );

        let test_records_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM test_records", [], |row| row.get(0))
            .unwrap();
        let child_records_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM child_records", [], |row| row.get(0))
            .unwrap();
        assert_eq!(test_records_count, 1, "safe record should be committed");
        assert_eq!(
            child_records_count, 0,
            "fk-violating record must not be committed"
        );

        // 违规记录应进入检疫表
        let quarantined: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM __sync_quarantine WHERE record_id = 'child-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(quarantined, 1, "violating record should be quarantined");
    }

    #[test]
    fn regression_m10_poison_payload_is_quarantined_without_blocking_batch() {
        let conn = create_test_db_with_business_table();

        let changes = vec![
            SyncChangeWithData {
                table_name: "test_records".to_string(),
                record_id: "bad-id".to_string(),
                operation: ChangeOperation::Insert,
                data: Some(json!({
                    "id": "different-id",
                    "content": "poison",
                    "updated_at": "2026-02-10T00:00:00Z"
                })),
                changed_at: "2026-02-10T00:00:00Z".to_string(),
                change_log_id: Some(1),
                database_name: None,
                suppress_change_log: Some(true),
                source_device_id: None,
                source_seq: None,
            },
            SyncChangeWithData {
                table_name: "test_records".to_string(),
                record_id: "good-id".to_string(),
                operation: ChangeOperation::Insert,
                data: Some(json!({
                    "id": "good-id",
                    "content": "applied",
                    "updated_at": "2026-02-10T00:00:01Z"
                })),
                changed_at: "2026-02-10T00:00:01Z".to_string(),
                change_log_id: Some(2),
                database_name: None,
                suppress_change_log: Some(true),
                source_device_id: None,
                source_seq: None,
            },
        ];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

        assert_eq!(result.success_count, 1);
        assert_eq!(result.failure_count, 1);
        assert_eq!(result.failures[0].record_id, "bad-id");

        let good_content: String = conn
            .query_row(
                "SELECT content FROM test_records WHERE id = 'good-id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(good_content, "applied");

        let quarantine_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM __sync_quarantine", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(quarantine_count, 1);
    }

    #[test]
    fn regression_m20_unregistered_table_payload_is_quarantined() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE evil_payloads (
                id TEXT PRIMARY KEY,
                content TEXT
            );
            "#,
        )
        .unwrap();

        let changes = vec![SyncChangeWithData {
            table_name: "evil_payloads".to_string(),
            record_id: "evil-1".to_string(),
            operation: ChangeOperation::Insert,
            data: Some(json!({
                "id": "evil-1",
                "content": "must not be written"
            })),
            changed_at: "2026-02-10T00:00:00Z".to_string(),
            change_log_id: None,
            database_name: Some("vfs".to_string()),
            suppress_change_log: None,
            source_device_id: None,
            source_seq: None,
        }];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

        assert_eq!(result.success_count, 0);
        assert_eq!(result.failure_count, 1);
        assert!(
            result.failures[0]
                .error
                .contains("禁止同步未注册为 RowSync 的表"),
            "unexpected failure: {:?}",
            result.failures[0]
        );

        let evil_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM evil_payloads", [], |row| row.get(0))
            .unwrap();
        let quarantine_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM __sync_quarantine", [], |row| {
                row.get(0)
            })
            .unwrap();

        assert_eq!(evil_count, 0);
        assert_eq!(quarantine_count, 1);
    }

    fn create_todo_constraint_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE todo_lists (
                id TEXT PRIMARY KEY,
                title TEXT,
                updated_at TEXT
            );
            CREATE TABLE todo_items (
                id TEXT PRIMARY KEY,
                todo_list_id TEXT NOT NULL,
                title TEXT,
                status TEXT NOT NULL,
                priority TEXT NOT NULL,
                parent_id TEXT,
                updated_at TEXT,
                deleted_at TEXT
            );
            -- 与 V20260614 迁移保持一致：INSERT 要求 parent 行存在且同清单
            -- （软删除不影响）；UPDATE 仅在 parent 行物理存在时校验同清单。
            CREATE TRIGGER trg_todo_items_validate_insert
            BEFORE INSERT ON todo_items
            FOR EACH ROW
            BEGIN
                SELECT RAISE(ABORT, 'todo_items.parent_id must belong to the same list')
                WHERE NEW.parent_id IS NOT NULL
                  AND (
                    SELECT todo_list_id
                    FROM todo_items
                    WHERE id = NEW.parent_id
                  ) IS NOT NEW.todo_list_id;
            END;
            CREATE TRIGGER trg_todo_items_validate_update
            BEFORE UPDATE ON todo_items
            FOR EACH ROW
            BEGIN
                SELECT RAISE(ABORT, 'todo_items.parent_id must belong to the same list')
                WHERE NEW.parent_id IS NOT NULL
                  AND EXISTS (SELECT 1 FROM todo_items WHERE id = NEW.parent_id)
                  AND (
                    SELECT todo_list_id
                    FROM todo_items
                    WHERE id = NEW.parent_id
                  ) IS NOT NEW.todo_list_id;
            END;
            "#,
        )
        .unwrap();
        conn
    }

    fn todo_list_change() -> SyncChangeWithData {
        SyncChangeWithData {
            table_name: "todo_lists".to_string(),
            record_id: "list-1".to_string(),
            operation: ChangeOperation::Insert,
            data: Some(serde_json::json!({
                "id": "list-1",
                "title": "List",
                "updated_at": "2026-05-31T00:00:00Z"
            })),
            changed_at: "2026-05-31T00:00:00Z".to_string(),
            change_log_id: Some(1),
            database_name: Some("vfs".to_string()),
            suppress_change_log: Some(true),
            source_device_id: None,
            source_seq: None,
        }
    }

    fn todo_parent_change() -> SyncChangeWithData {
        SyncChangeWithData {
            table_name: "todo_items".to_string(),
            record_id: "todo-parent".to_string(),
            operation: ChangeOperation::Insert,
            data: Some(serde_json::json!({
                "id": "todo-parent",
                "todo_list_id": "list-1",
                "title": "Parent",
                "status": "pending",
                "priority": "high",
                "parent_id": null,
                "updated_at": "2026-05-31T00:00:00Z",
                "deleted_at": null
            })),
            changed_at: "2026-05-31T00:00:00Z".to_string(),
            change_log_id: Some(3),
            database_name: Some("vfs".to_string()),
            suppress_change_log: Some(true),
            source_device_id: None,
            source_seq: None,
        }
    }

    fn todo_child_change() -> SyncChangeWithData {
        SyncChangeWithData {
            table_name: "todo_items".to_string(),
            record_id: "todo-child".to_string(),
            operation: ChangeOperation::Insert,
            data: Some(serde_json::json!({
                "id": "todo-child",
                "todo_list_id": "list-1",
                "title": "Child",
                "status": "pending",
                "priority": "medium",
                "parent_id": "todo-parent",
                "updated_at": "2026-05-31T00:00:00Z",
                "deleted_at": null
            })),
            changed_at: "2026-05-31T00:00:00Z".to_string(),
            change_log_id: Some(2),
            database_name: Some("vfs".to_string()),
            suppress_change_log: Some(true),
            source_device_id: None,
            source_seq: None,
        }
    }

    fn assert_todo_parent_child_applied(conn: &Connection) {
        let child: (String, String) = conn
            .query_row(
                "SELECT parent_id, todo_list_id FROM todo_items WHERE id = 'todo-child'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(child.0, "todo-parent");
        assert_eq!(child.1, "list-1");

        let parent_list: String = conn
            .query_row(
                "SELECT todo_list_id FROM todo_items WHERE id = 'todo-parent'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(parent_list, "list-1");
    }

    #[test]
    fn test_apply_downloaded_changes_orders_todo_parent_before_child() {
        let conn = create_todo_constraint_test_db();
        let changes = vec![
            todo_list_change(),
            todo_child_change(),
            todo_parent_change(),
        ];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

        assert_eq!(result.success_count, 3);
        assert_todo_parent_child_applied(&conn);
    }

    #[test]
    fn test_conflict_guard_orders_todo_parent_before_child() {
        let conn = create_todo_constraint_test_db();
        let changes = vec![
            todo_list_change(),
            todo_child_change(),
            todo_parent_change(),
        ];

        let (result, conflict_result) = SyncManager::apply_downloaded_changes_with_conflict_guard(
            &conn,
            &changes,
            None,
            conflict_resolver::ConflictPolicy::KeepLatest,
            Some("cloud-device"),
            Some("local-device"),
        )
        .unwrap();

        assert_eq!(result.success_count, 3);
        assert_eq!(conflict_result.conflicts_saved, 0);
        assert_todo_parent_child_applied(&conn);
    }

    fn create_vfs_blob_fk_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            CREATE TABLE blobs (
                hash TEXT PRIMARY KEY,
                relative_path TEXT NOT NULL,
                size INTEGER NOT NULL,
                mime_type TEXT,
                ref_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE files (
                id TEXT PRIMARY KEY,
                blob_hash TEXT,
                sha256 TEXT NOT NULL UNIQUE,
                file_name TEXT NOT NULL,
                size INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(blob_hash) REFERENCES blobs(hash)
            );
            "#,
        )
        .unwrap();
        conn
    }

    fn blob_metadata_change() -> SyncChangeWithData {
        SyncChangeWithData {
            table_name: "blobs".to_string(),
            record_id: "blob-hash-1".to_string(),
            operation: ChangeOperation::Insert,
            data: Some(serde_json::json!({
                "hash": "blob-hash-1",
                "relative_path": "bl/ob/blob-hash-1.md",
                "size": 12,
                "mime_type": "text/markdown",
                "ref_count": 1,
                "created_at": 1780225200000i64
            })),
            changed_at: "2026-05-31T00:00:01Z".to_string(),
            change_log_id: Some(2),
            database_name: Some("vfs".to_string()),
            suppress_change_log: Some(true),
            source_device_id: None,
            source_seq: None,
        }
    }

    fn blob_file_change() -> SyncChangeWithData {
        SyncChangeWithData {
            table_name: "files".to_string(),
            record_id: "file-1".to_string(),
            operation: ChangeOperation::Insert,
            data: Some(serde_json::json!({
                "id": "file-1",
                "blob_hash": "blob-hash-1",
                "sha256": "sha256-file-1",
                "file_name": "blob-backed.md",
                "size": 12,
                "created_at": "2026-05-31T00:00:00Z",
                "updated_at": "2026-05-31T00:00:00Z"
            })),
            changed_at: "2026-05-31T00:00:00Z".to_string(),
            change_log_id: Some(1),
            database_name: Some("vfs".to_string()),
            suppress_change_log: Some(true),
            source_device_id: None,
            source_seq: None,
        }
    }

    fn assert_blob_file_applied(conn: &Connection) {
        let row: (String, String) = conn
            .query_row(
                "SELECT files.blob_hash, blobs.relative_path
                 FROM files JOIN blobs ON blobs.hash = files.blob_hash
                 WHERE files.id = 'file-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(row.0, "blob-hash-1");
        assert_eq!(row.1, "bl/ob/blob-hash-1.md");
    }

    #[test]
    fn test_quarantine_source_uses_v3_metadata() {
        let change = SyncChangeWithData {
            table_name: "notes".to_string(),
            record_id: "note-1".to_string(),
            operation: ChangeOperation::Update,
            data: None,
            changed_at: "2026-06-01T00:00:00Z".to_string(),
            change_log_id: Some(7),
            database_name: Some("vfs".to_string()),
            suppress_change_log: Some(true),
            source_device_id: Some("device-a".to_string()),
            source_seq: Some(42),
        };

        assert_eq!(
            SyncManager::source_device_for_quarantine(&change),
            "device-a"
        );
        assert_eq!(SyncManager::source_seq_for_quarantine(&change), 42);
    }

    #[test]
    fn test_apply_downloaded_changes_orders_blob_metadata_before_files() {
        let conn = create_vfs_blob_fk_test_db();
        let changes = vec![blob_file_change(), blob_metadata_change()];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

        assert_eq!(result.success_count, 2);
        assert_blob_file_applied(&conn);
    }

    #[test]
    fn regression_ref_count_is_recomputed_after_download_apply() {
        let conn = create_vfs_blob_fk_test_db();
        let mut blob = blob_metadata_change();
        if let Some(serde_json::Value::Object(obj)) = blob.data.as_mut() {
            obj.insert("ref_count".to_string(), serde_json::json!(99));
        }
        let changes = vec![blob_file_change(), blob];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

        assert_eq!(result.success_count, 2);
        let ref_count: i64 = conn
            .query_row(
                "SELECT ref_count FROM blobs WHERE hash='blob-hash-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ref_count, 1);
    }

    /// ★ 2026-06-12（P1 防数据丢失）回归：仅存在于 JSON 中的 blob 引用
    /// （PDF 页图/压缩页图、试卷页图、题目图片）不得被重算清零。
    /// 修复前 recompute 只统计三个显式列，这些 blob 会被清零 → 启动清扫物理删除。
    #[test]
    fn regression_recompute_counts_json_embedded_blob_refs() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE blobs (
                hash TEXT PRIMARY KEY,
                ref_count INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE files (
                id TEXT PRIMARY KEY,
                blob_hash TEXT,
                compressed_blob_hash TEXT,
                preview_json TEXT
            );
            CREATE TABLE exam_sheets (
                id TEXT PRIMARY KEY,
                preview_json TEXT
            );
            CREATE TABLE questions (
                id TEXT PRIMARY KEY,
                images_json TEXT
            );
            "#,
        )
        .unwrap();

        // 6 个 blob：主文件、PDF 页图、压缩页图、试卷页图、题目图片、
        // "压缩不划算"去重 blob。初始 ref_count 全部写成错误值，验证重算后恢复正确。
        for hash in [
            "main-blob",
            "page-blob",
            "page-compressed-blob",
            "exam-page-blob",
            "question-img-blob",
            "dedup-blob",
        ] {
            conn.execute(
                "INSERT INTO blobs(hash, ref_count) VALUES (?1, 99)",
                rusqlite::params![hash],
            )
            .unwrap();
        }

        conn.execute(
            r#"INSERT INTO files(id, blob_hash, compressed_blob_hash, preview_json) VALUES (
                'file-1', 'main-blob', NULL,
                '{"pages":[{"page_index":0,"blob_hash":"page-blob","compressed_blob_hash":"page-compressed-blob"}]}'
            )"#,
            [],
        )
        .unwrap();
        // "压缩不划算"：文件级与页级 compressed 均指向原始 blob，
        // 本地只 +1（store 一次），重算必须按等值排除避免双计。
        conn.execute(
            r#"INSERT INTO files(id, blob_hash, compressed_blob_hash, preview_json) VALUES (
                'file-2', 'dedup-blob', 'dedup-blob',
                '{"pages":[{"page_index":0,"blob_hash":"dedup-blob","compressed_blob_hash":"dedup-blob"}]}'
            )"#,
            [],
        )
        .unwrap();
        conn.execute(
            r#"INSERT INTO exam_sheets(id, preview_json) VALUES (
                'exam-1', '{"pages":[{"page_index":0,"blob_hash":"exam-page-blob"}]}'
            )"#,
            [],
        )
        .unwrap();
        // 两道题引用同一张图：引用计数应为出现次数 2
        conn.execute(
            r#"INSERT INTO questions(id, images_json) VALUES
                ('q-1', '[{"id":"att_1","hash":"question-img-blob"}]'),
                ('q-2', '[{"id":"att_2","hash":"question-img-blob"}]')"#,
            [],
        )
        .unwrap();
        // 非法 JSON 行不得让重算报错（按无引用处理）
        conn.execute(
            "INSERT INTO files(id, blob_hash, preview_json) VALUES ('file-bad', NULL, '{not json')",
            [],
        )
        .unwrap();

        SyncManager::recompute_blob_ref_counts(&conn).unwrap();

        let count_of = |hash: &str| -> i64 {
            conn.query_row(
                "SELECT ref_count FROM blobs WHERE hash = ?1",
                rusqlite::params![hash],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert_eq!(count_of("main-blob"), 1, "显式列引用");
        assert_eq!(count_of("page-blob"), 1, "preview_json 页图引用不得清零");
        assert_eq!(
            count_of("page-compressed-blob"),
            1,
            "preview_json 压缩页图引用不得清零"
        );
        assert_eq!(
            count_of("exam-page-blob"),
            1,
            "exam_sheets.preview_json 页图引用不得清零"
        );
        assert_eq!(
            count_of("question-img-blob"),
            2,
            "questions.images_json 按出现次数计数"
        );
        // file-2：files.blob_hash(+1) + 页图 blob_hash(+1)；
        // 文件级/页级 compressed 与原始等值 → 不重复计数（本地未额外 store）
        assert_eq!(
            count_of("dedup-blob"),
            2,
            "压缩不划算（compressed==原始）不得双计"
        );
    }

    /// JSON 引用表（questions/exam_sheets）变更也必须触发重算门控
    #[test]
    fn regression_changes_to_json_ref_tables_trigger_recompute_gate() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE questions (id TEXT PRIMARY KEY, images_json TEXT);
            CREATE TABLE exam_sheets (id TEXT PRIMARY KEY, preview_json TEXT);
            CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT);
            "#,
        )
        .unwrap();

        let change_for = |table: &str| SyncChangeWithData {
            table_name: table.to_string(),
            record_id: "r1".to_string(),
            operation: ChangeOperation::Update,
            data: None,
            changed_at: "2026-06-12T00:00:00Z".to_string(),
            change_log_id: Some(1),
            database_name: Some("vfs".to_string()),
            suppress_change_log: Some(true),
            source_device_id: None,
            source_seq: None,
        };

        assert!(SyncManager::changes_affect_ref_counts(
            &conn,
            &[change_for("questions")]
        ));
        assert!(SyncManager::changes_affect_ref_counts(
            &conn,
            &[change_for("exam_sheets")]
        ));
        assert!(!SyncManager::changes_affect_ref_counts(
            &conn,
            &[change_for("notes")]
        ));
    }

    #[test]
    fn test_conflict_guard_orders_blob_metadata_before_files() {
        let conn = create_vfs_blob_fk_test_db();
        let changes = vec![blob_file_change(), blob_metadata_change()];

        let (result, conflict_result) = SyncManager::apply_downloaded_changes_with_conflict_guard(
            &conn,
            &changes,
            None,
            conflict_resolver::ConflictPolicy::KeepLatest,
            Some("cloud-device"),
            Some("local-device"),
        )
        .unwrap();

        assert_eq!(result.success_count, 2);
        assert_eq!(conflict_result.conflicts_saved, 0);
        assert_blob_file_applied(&conn);
    }

    #[test]
    fn regression_p3_5_files_same_sha_is_aliased_to_existing_file() {
        let conn = create_vfs_blob_fk_test_db();
        conn.execute(
            "INSERT INTO blobs(hash, relative_path, size, mime_type, ref_count, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                "blob-hash-1",
                "bl/ob/blob-hash-1.md",
                12i64,
                "text/markdown",
                1i64,
                1780225200000i64
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files(id, blob_hash, sha256, file_name, size, created_at, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                "file-1",
                "blob-hash-1",
                "same-sha",
                "original.md",
                12i64,
                "2026-05-31T00:00:00Z",
                "2026-05-31T00:00:00Z"
            ],
        )
        .unwrap();

        let changes = vec![SyncChangeWithData {
            table_name: "files".to_string(),
            record_id: "file-2".to_string(),
            operation: ChangeOperation::Insert,
            data: Some(serde_json::json!({
                "id": "file-2",
                "blob_hash": "blob-hash-1",
                "sha256": "same-sha",
                "file_name": "must-not-merge.md",
                "size": 12,
                "created_at": "2026-06-01T00:00:00Z",
                "updated_at": "2026-06-01T00:00:00Z"
            })),
            changed_at: "2026-06-01T00:00:00Z".to_string(),
            change_log_id: Some(42),
            database_name: Some("vfs".to_string()),
            suppress_change_log: Some(true),
            source_device_id: None,
            source_seq: None,
        }];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

        assert_eq!(result.success_count, 1);
        assert_eq!(result.failure_count, 0);

        let original_name: String = conn
            .query_row("SELECT file_name FROM files WHERE id='file-1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        let file_2_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM files WHERE id='file-2'", [], |row| {
                row.get(0)
            })
            .unwrap();
        let quarantine_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM __sync_quarantine", [], |row| {
                row.get(0)
            })
            .unwrap();
        let alias_canonical: String = conn
            .query_row(
                "SELECT canonical_id FROM __sync_id_aliases
                 WHERE table_name='files' AND remote_id='file-2'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(original_name, "must-not-merge.md");
        assert_eq!(file_2_count, 0);
        assert_eq!(quarantine_count, 0);
        assert_eq!(alias_canonical, "file-1");
    }

    #[test]
    fn regression_m15_sqlite_text_json_string_is_not_reserialized() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE docs (
                id TEXT PRIMARY KEY,
                body TEXT
            );
            INSERT INTO docs (id, body)
            VALUES ('d1', '{"b":2, "a":1}');
            "#,
        )
        .unwrap();

        let body = conn
            .query_row("SELECT body FROM docs WHERE id='d1'", [], |row| {
                Ok(SyncManager::sqlite_value_to_json(row, 0))
            })
            .unwrap();

        assert_eq!(body, serde_json::json!("{\"b\":2, \"a\":1}"));
    }

    #[test]
    fn regression_m15_sqlite_blob_is_typed_dsblob_payload() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE docs (
                id TEXT PRIMARY KEY,
                payload BLOB
            );
            INSERT INTO docs (id, payload)
            VALUES ('d1', x'000102ff');
            "#,
        )
        .unwrap();

        let payload = conn
            .query_row("SELECT payload FROM docs WHERE id='d1'", [], |row| {
                Ok(SyncManager::sqlite_value_to_json(row, 0))
            })
            .unwrap();

        assert_eq!(payload, serde_json::json!({ "$dsblob": "AAEC/w==" }));
        let param = SyncManager::json_value_to_sql_param(&payload).unwrap();
        let restored: Vec<u8> = conn
            .query_row("SELECT ?1", [&param.as_ref()], |row| row.get(0))
            .unwrap();
        assert_eq!(restored, vec![0, 1, 2, 255]);
    }

    fn create_resource_alias_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            CREATE TABLE resources (
                id TEXT PRIMARY KEY,
                hash TEXT NOT NULL UNIQUE,
                body TEXT,
                updated_at TEXT
            );
            CREATE TABLE resource_notes (
                id TEXT PRIMARY KEY,
                resource_id TEXT NOT NULL,
                note TEXT,
                updated_at TEXT,
                FOREIGN KEY(resource_id) REFERENCES resources(id)
            );
            INSERT INTO resources (id, hash, body, updated_at)
            VALUES ('local-res', 'same-business-hash', 'local body', '2024-01-01T00:00:00Z');
            "#,
        )
        .unwrap();
        conn
    }

    fn resource_alias_parent_change() -> SyncChangeWithData {
        SyncChangeWithData {
            table_name: "resources".to_string(),
            record_id: "remote-res".to_string(),
            operation: ChangeOperation::Insert,
            data: Some(serde_json::json!({
                "id": "remote-res",
                "hash": "same-business-hash",
                "body": "cloud body",
                "updated_at": "2024-01-02T00:00:00Z"
            })),
            changed_at: "2024-01-02T00:00:00Z".to_string(),
            change_log_id: None,
            database_name: Some("vfs".to_string()),
            suppress_change_log: None,
            source_device_id: None,
            source_seq: None,
        }
    }

    fn resource_alias_child_change() -> SyncChangeWithData {
        SyncChangeWithData {
            table_name: "resource_notes".to_string(),
            record_id: "note-remote".to_string(),
            operation: ChangeOperation::Insert,
            data: Some(serde_json::json!({
                "id": "note-remote",
                "resource_id": "remote-res",
                "note": "child uses remote id",
                "updated_at": "2024-01-02T00:00:01Z"
            })),
            changed_at: "2024-01-02T00:00:01Z".to_string(),
            change_log_id: None,
            database_name: Some("vfs".to_string()),
            suppress_change_log: None,
            source_device_id: None,
            source_seq: None,
        }
    }

    fn assert_resource_alias_result(conn: &Connection) {
        let resource_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM resources", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            resource_count, 1,
            "business-key conflict should reuse local row"
        );

        let remote_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM resources WHERE id = 'remote-res'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            remote_count, 0,
            "remote id should be an alias, not a new row"
        );

        let body: String = conn
            .query_row(
                "SELECT body FROM resources WHERE id = 'local-res'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(body, "cloud body");

        let child_fk: String = conn
            .query_row(
                "SELECT resource_id FROM resource_notes WHERE id = 'note-remote'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(child_fk, "local-res", "child FK should be remapped");

        let violations = SyncManager::collect_foreign_key_violations(conn, 20).unwrap();
        assert!(
            violations.is_empty(),
            "foreign keys should pass: {:?}",
            violations
        );
    }

    #[test]
    fn test_business_key_alias_remaps_child_fk_when_child_arrives_first() {
        let conn = create_resource_alias_test_db();
        let changes = vec![
            resource_alias_child_change(),
            resource_alias_parent_change(),
        ];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

        assert_eq!(result.success_count, 2);
        assert_resource_alias_result(&conn);
    }

    #[test]
    fn test_business_key_alias_reuses_canonical_id_when_parent_arrives_first() {
        let conn = create_resource_alias_test_db();
        let changes = vec![
            resource_alias_parent_change(),
            resource_alias_child_change(),
        ];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

        assert_eq!(result.success_count, 2);
        assert_resource_alias_result(&conn);
    }

    #[test]
    fn fsrs_child_first_log_remaps_duplicate_state_id_without_physical_fk() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE __change_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                table_name TEXT NOT NULL,
                record_id TEXT NOT NULL,
                operation TEXT NOT NULL,
                changed_at TEXT NOT NULL DEFAULT (datetime('now')),
                sync_version INTEGER DEFAULT 0
            );
            CREATE TABLE anki_cards (
                id TEXT PRIMARY KEY,
                updated_at TEXT NOT NULL,
                deleted_at TEXT
            );
            CREATE TABLE anki_decks (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                updated_at TEXT NOT NULL,
                deleted_at TEXT
            );
            CREATE TABLE fsrs_card_states (
                id TEXT PRIMARY KEY,
                anki_card_id TEXT NOT NULL UNIQUE,
                deck_id TEXT,
                state INTEGER NOT NULL,
                due_ms INTEGER NOT NULL,
                fsrs_params_version TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT
            );
            CREATE TABLE fsrs_review_logs (
                id TEXT PRIMARY KEY,
                card_state_id TEXT NOT NULL,
                anki_card_id TEXT NOT NULL,
                rating INTEGER NOT NULL,
                state_before INTEGER NOT NULL,
                state_after INTEGER NOT NULL,
                review_ms INTEGER NOT NULL,
                fsrs_params_version TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT
            );

            INSERT INTO anki_cards(id, updated_at)
            VALUES ('card-shared', '2026-07-11T00:00:00Z');
            INSERT INTO anki_decks(id, name, updated_at)
            VALUES ('deck-local', 'Default', '2026-07-11T00:00:00Z');
            INSERT INTO fsrs_card_states(
                id, anki_card_id, deck_id, state, due_ms, fsrs_params_version,
                created_at, updated_at
            ) VALUES (
                'state-local', 'card-shared', 'deck-local', 0, 0, 'rs-fsrs-test',
                '2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z'
            );
            "#,
        )
        .unwrap();

        let child_first = SyncChangeWithData {
            table_name: "fsrs_review_logs".to_string(),
            record_id: "log-remote".to_string(),
            operation: ChangeOperation::Insert,
            data: Some(serde_json::json!({
                "id": "log-remote",
                "card_state_id": "state-remote",
                "anki_card_id": "card-shared",
                "rating": 3,
                "state_before": 0,
                "state_after": 1,
                "review_ms": 1783728000000_i64,
                "fsrs_params_version": "rs-fsrs-test",
                "created_at": "2026-07-11T00:00:02Z",
                "updated_at": "2026-07-11T00:00:02Z"
            })),
            changed_at: "2026-07-11T00:00:02Z".to_string(),
            change_log_id: None,
            database_name: Some("mistakes".to_string()),
            suppress_change_log: Some(true),
            source_device_id: Some("remote-device".to_string()),
            source_seq: Some(2),
        };
        let duplicate_parent = SyncChangeWithData {
            table_name: "fsrs_card_states".to_string(),
            record_id: "state-remote".to_string(),
            operation: ChangeOperation::Insert,
            data: Some(serde_json::json!({
                "id": "state-remote",
                "anki_card_id": "card-shared",
                "deck_id": "deck-local",
                "state": 1,
                "due_ms": 1783728600000_i64,
                "fsrs_params_version": "rs-fsrs-test",
                "created_at": "2026-07-11T00:00:01Z",
                "updated_at": "2026-07-11T00:00:01Z"
            })),
            changed_at: "2026-07-11T00:00:01Z".to_string(),
            change_log_id: None,
            database_name: Some("mistakes".to_string()),
            suppress_change_log: Some(true),
            source_device_id: Some("remote-device".to_string()),
            source_seq: Some(1),
        };

        let result =
            SyncManager::apply_downloaded_changes(&conn, &[child_first, duplicate_parent], None)
                .unwrap();

        assert_eq!(result.success_count, 2);
        assert_eq!(result.failure_count, 0);
        let (state_id, joined): (String, i64) = conn
            .query_row(
                "SELECT l.card_state_id,
                        COUNT(s.id)
                 FROM fsrs_review_logs l
                 LEFT JOIN fsrs_card_states s ON s.id = l.card_state_id
                 WHERE l.id = 'log-remote'
                 GROUP BY l.card_state_id",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(state_id, "state-local");
        assert_eq!(joined, 1, "stats JOIN must retain the remapped review log");
        let canonical: String = conn
            .query_row(
                "SELECT canonical_id FROM __sync_id_aliases
                 WHERE table_name = 'fsrs_card_states' AND remote_id = 'state-remote'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(canonical, "state-local");
    }

    #[test]
    fn regression_m9_same_batch_business_key_alias_remaps_later_child_fk() {
        let conn = create_resource_alias_test_db();
        conn.execute("DELETE FROM resource_notes", []).unwrap();
        conn.execute("DELETE FROM resources", []).unwrap();

        let parent_a = SyncChangeWithData {
            table_name: "resources".to_string(),
            record_id: "remote-res-a".to_string(),
            operation: ChangeOperation::Insert,
            data: Some(serde_json::json!({
                "id": "remote-res-a",
                "hash": "same-batch-hash",
                "body": "first parent",
                "updated_at": "2024-01-02T00:00:00Z"
            })),
            changed_at: "2024-01-02T00:00:00Z".to_string(),
            change_log_id: None,
            database_name: Some("vfs".to_string()),
            suppress_change_log: None,
            source_device_id: None,
            source_seq: None,
        };
        let parent_b = SyncChangeWithData {
            table_name: "resources".to_string(),
            record_id: "remote-res-b".to_string(),
            operation: ChangeOperation::Insert,
            data: Some(serde_json::json!({
                "id": "remote-res-b",
                "hash": "same-batch-hash",
                "body": "second parent",
                "updated_at": "2024-01-02T00:00:01Z"
            })),
            changed_at: "2024-01-02T00:00:01Z".to_string(),
            change_log_id: None,
            database_name: Some("vfs".to_string()),
            suppress_change_log: None,
            source_device_id: None,
            source_seq: None,
        };
        let child = SyncChangeWithData {
            table_name: "resource_notes".to_string(),
            record_id: "note-remote-b".to_string(),
            operation: ChangeOperation::Insert,
            data: Some(serde_json::json!({
                "id": "note-remote-b",
                "resource_id": "remote-res-b",
                "note": "child references duplicate parent",
                "updated_at": "2024-01-02T00:00:02Z"
            })),
            changed_at: "2024-01-02T00:00:02Z".to_string(),
            change_log_id: None,
            database_name: Some("vfs".to_string()),
            suppress_change_log: None,
            source_device_id: None,
            source_seq: None,
        };

        let result =
            SyncManager::apply_downloaded_changes(&conn, &[parent_a, parent_b, child], None)
                .unwrap();

        assert_eq!(result.success_count, 3);
        assert_eq!(result.failure_count, 0);
        let resource_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM resources", [], |row| row.get(0))
            .unwrap();
        let child_fk: String = conn
            .query_row(
                "SELECT resource_id FROM resource_notes WHERE id='note-remote-b'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let alias_canonical: String = conn
            .query_row(
                "SELECT canonical_id FROM __sync_id_aliases
                 WHERE table_name='resources' AND remote_id='remote-res-b'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(resource_count, 1);
        assert_eq!(child_fk, "remote-res-a");
        assert_eq!(alias_canonical, "remote-res-a");
        assert!(SyncManager::collect_foreign_key_violations(&conn, 20)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn test_conflict_guard_business_key_alias_remaps_child_fk() {
        let conn = create_resource_alias_test_db();
        let changes = vec![
            resource_alias_child_change(),
            resource_alias_parent_change(),
        ];

        let (result, conflict_result) = SyncManager::apply_downloaded_changes_with_conflict_guard(
            &conn,
            &changes,
            None,
            conflict_resolver::ConflictPolicy::KeepLatest,
            Some("cloud-device"),
            Some("local-device"),
        )
        .unwrap();

        assert_eq!(result.success_count, 2);
        assert_eq!(conflict_result.conflicts_saved, 0);
        assert_resource_alias_result(&conn);
    }

    #[test]
    fn test_suppress_change_log_does_not_mark_existing_user_update() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE test_records (
                id TEXT PRIMARY KEY,
                content TEXT,
                updated_at TEXT
            );
            CREATE TABLE __change_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                table_name TEXT NOT NULL,
                record_id TEXT NOT NULL,
                operation TEXT NOT NULL,
                changed_at TEXT NOT NULL DEFAULT (datetime('now')),
                sync_version INTEGER DEFAULT 0
            );
            CREATE TRIGGER trg_echo_insert
            AFTER INSERT ON test_records
            BEGIN
                INSERT INTO __change_log(table_name, record_id, operation)
                VALUES('test_records', NEW.id, 'INSERT');
            END;
            CREATE TRIGGER trg_echo_update
            AFTER UPDATE ON test_records
            BEGIN
                INSERT INTO __change_log(table_name, record_id, operation)
                VALUES('test_records', NEW.id, 'UPDATE');
            END;
            "#,
        )
        .unwrap();

        // 首次云端回放：应只抑制回放引入的 echo 记录
        let replay_insert = vec![SyncChangeWithData {
            table_name: "test_records".to_string(),
            record_id: "r1".to_string(),
            operation: ChangeOperation::Insert,
            data: Some(serde_json::json!({
                "id": "r1",
                "content": "cloud",
                "updated_at": "2026-02-10T00:00:00Z"
            })),
            changed_at: "2026-02-10T00:00:00Z".to_string(),
            change_log_id: None,
            database_name: None,
            suppress_change_log: Some(true),
            source_device_id: None,
            source_seq: None,
        }];
        SyncManager::apply_downloaded_changes(&conn, &replay_insert, None).unwrap();

        // 本地用户编辑，产生 UPDATE 日志（应该保持未同步）
        conn.execute(
            "UPDATE test_records SET content = 'local-edit' WHERE id = 'r1'",
            [],
        )
        .unwrap();
        let user_update_log_id: i64 = conn
            .query_row(
                "SELECT id FROM __change_log WHERE operation = 'UPDATE' ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();

        // 再次回放同一个 INSERT，验证不会误标记用户 UPDATE 记录
        SyncManager::apply_downloaded_changes(&conn, &replay_insert, None).unwrap();

        let user_sync_version: i64 = conn
            .query_row(
                "SELECT sync_version FROM __change_log WHERE id = ?1",
                params![user_update_log_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            user_sync_version, 0,
            "existing user update log must not be marked as synced by replay suppression"
        );
    }
}
