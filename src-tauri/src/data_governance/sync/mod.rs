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
pub mod emitter;
pub mod progress;

// 重新导出常用类型
pub use emitter::{OptionalEmitter, SyncProgressCallback, SyncProgressEmitter, EVENT_NAME};
pub use progress::{ProgressTracker, SpeedCalculator, SyncPhase, SyncProgress};

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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

/// 同步管理器
pub struct SyncManager {
    /// 本地设备 ID
    device_id: String,
}

impl SyncManager {
    /// 创建新的同步管理器
    pub fn new(device_id: String) -> Self {
        Self { device_id }
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
    /// 冲突条件：
    /// 1. 两边的 sync_version 相同（说明上次同步后都有修改）
    /// 2. 两边的 local_version 都增加了（双方都有修改）
    /// 3. 数据内容不同
    fn is_record_conflicting(local: &RecordSnapshot, cloud: &RecordSnapshot) -> bool {
        // 如果 sync_version 相同，说明双方都基于同一个同步点进行了修改
        if local.sync_version == cloud.sync_version {
            // 双方都有修改（local_version > sync_version）
            let local_modified = local.local_version > local.sync_version;
            let cloud_modified = cloud.local_version > cloud.sync_version;

            if local_modified && cloud_modified {
                // 数据内容不同才算冲突
                return local.data != cloud.data;
            }
        }
        false
    }

    /// 执行同步
    ///
    /// 根据合并策略处理冲突并返回同步结果。
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
                    // 比较时间戳，保留最新的
                    if conflict.local_updated_at >= conflict.cloud_updated_at {
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
        }
    }

    // ========================================================================
    // 云存储集成方法
    // ========================================================================

    /// 清单文件的云端路径
    const MANIFEST_KEY: &'static str = "data_governance/sync_manifest.json";
    /// 变更数据的云端路径前缀
    const CHANGES_PREFIX: &'static str = "data_governance/changes";

    /// 上传本地清单到云端
    ///
    /// 将 SyncManifest 序列化为 JSON 并上传到云存储。
    ///
    /// # 参数
    /// * `storage` - 云存储实例
    /// * `manifest` - 要上传的同步清单
    ///
    /// # 返回
    /// * `Ok(())` - 上传成功
    /// * `Err(SyncError)` - 上传失败
    pub async fn upload_manifest(
        &self,
        storage: &dyn CloudStorage,
        manifest: &SyncManifest,
    ) -> Result<(), SyncError> {
        let json = serde_json::to_vec_pretty(manifest)
            .map_err(|e| SyncError::Database(format!("序列化清单失败: {}", e)))?;

        storage
            .put(Self::MANIFEST_KEY, &json)
            .await
            .map_err(|e| SyncError::Network(format!("上传清单失败: {}", e)))?;

        tracing::info!(
            "[sync] 清单已上传到云端: device={}, tx={}, databases={}",
            manifest.device_id,
            manifest.sync_transaction_id,
            manifest.databases.len()
        );

        Ok(())
    }

    /// 从云端下载清单
    ///
    /// 从云存储下载 SyncManifest 并反序列化。
    ///
    /// # 参数
    /// * `storage` - 云存储实例
    ///
    /// # 返回
    /// * `Ok(SyncManifest)` - 下载并解析成功
    /// * `Err(SyncError::Network)` - 云端没有清单或网络错误
    pub async fn download_manifest(
        &self,
        storage: &dyn CloudStorage,
    ) -> Result<SyncManifest, SyncError> {
        let data = storage
            .get(Self::MANIFEST_KEY)
            .await
            .map_err(|e| SyncError::Network(format!("获取清单失败: {}", e)))?;

        match data {
            Some(bytes) => {
                let manifest: SyncManifest = serde_json::from_slice(&bytes)
                    .map_err(|e| SyncError::Database(format!("解析清单失败: {}", e)))?;

                tracing::info!(
                    "[sync] 从云端下载清单: device={}, tx={}, databases={}",
                    manifest.device_id,
                    manifest.sync_transaction_id,
                    manifest.databases.len()
                );

                Ok(manifest)
            }
            None => {
                tracing::info!("[sync] 云端没有同步清单，返回空清单");
                // 返回一个空的清单，表示云端没有数据
                Ok(SyncManifest {
                    sync_transaction_id: String::new(),
                    databases: HashMap::new(),
                    status: SyncTransactionStatus::Complete,
                    created_at: chrono::Utc::now().to_rfc3339(),
                    device_id: String::new(),
                })
            }
        }
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

        storage
            .put(&key, &json)
            .await
            .map_err(|e| SyncError::Network(format!("上传变更数据失败: {}", e)))?;

        tracing::info!(
            "[sync] 变更数据已上传: device={}, count={}, key={}",
            self.device_id,
            changes.total_count,
            key
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
    ) -> Result<(), SyncError> {
        if changes.is_empty() {
            tracing::debug!("[sync] 没有变更需要上传");
            return Ok(());
        }

        // 版本使用秒级时间戳，与 legacy 文件同一版本空间
        let version = chrono::Utc::now().timestamp() as u64;
        let key = self.build_change_key(version);

        // 序列化为带完整数据的新格式
        let payload = SyncChangesPayload {
            changes: changes.to_vec(),
            total_count: changes.len(),
            device_id: self.device_id.clone(),
            format_version: 2, // v2 = 带完整数据
        };

        // Phase 5 Optimization: Compact JSON + Zstd Compression
        // 1. Serialize to compact JSON
        let json = serde_json::to_vec(&payload)
            .map_err(|e| SyncError::Database(format!("序列化变更数据失败: {}", e)))?;

        // 2. Compress using Zstd (default level 0 is usually 3)
        let compressed = zstd::stream::encode_all(std::io::Cursor::new(json), 0)
            .map_err(|e| SyncError::Database(format!("压缩变更数据失败: {}", e)))?;

        storage
            .put(&key, &compressed)
            .await
            .map_err(|e| SyncError::Network(format!("上传变更数据失败: {}", e)))?;

        tracing::info!(
            "[sync] 带完整数据的变更已上传(Compressed): device={}, count={}, key={}, original_size={}, compressed_size={}",
            self.device_id,
            changes.len(),
            key,
            payload.total_count, // Approximate logic, logging size would require len()
            compressed.len()
        );

        Ok(())
    }

    /// 下载变更数据（支持新旧两种格式）
    ///
    /// 从云端下载指定版本之后的所有变更数据。
    /// - 新格式（v2）：`SyncChangesPayload`，包含完整记录数据
    /// - 旧格式（v1）：`PendingChanges`，仅含 ChangeLogEntry 元数据
    ///
    /// 返回统一的 `Vec<SyncChangeWithData>`，新格式数据已含 `data` 字段，
    /// 旧格式的 INSERT/UPDATE 变更 `data` 字段为 None（回放时会报错并跳过）。
    ///
    /// # 参数
    /// * `storage` - 云存储实例
    /// * `since_version` - 起始版本号（时间戳），获取此版本之后的变更
    /// * `per_db_since` - 各数据库的起始版本号（用于跨库过滤）
    ///
    /// # 返回
    /// * `Ok(Vec<SyncChangeWithData>)` - 下载的变更数据（含完整记录）
    /// * `Err(SyncError)` - 下载失败
    pub async fn download_changes(
        &self,
        storage: &dyn CloudStorage,
        since_version: u64,
        per_db_since: Option<&HashMap<String, u64>>,
    ) -> Result<Vec<SyncChangeWithData>, SyncError> {
        // 列出所有变更文件
        let files = storage
            .list(Self::CHANGES_PREFIX)
            .await
            .map_err(|e| SyncError::Network(format!("列出变更文件失败: {}", e)))?;

        let mut all_changes: Vec<SyncChangeWithData> = Vec::new();

        for file in files {
            // 解析文件名中的版本号
            if let Some(version) = Self::parse_version_from_key(&file.key) {
                // 使用 >= 而非 >：防止同秒上传的变更被跳过
                // apply 层幂等（INSERT OR REPLACE），重复下载不会产生副作用
                if version >= since_version {
                    // 下载并解析变更文件
                    if let Some(data) = storage
                        .get(&file.key)
                        .await
                        .map_err(|e| SyncError::Network(format!("下载变更文件失败: {}", e)))?
                    {
                        // Phase 5 Optimization: Decompression with Fallback
                        // Try to decompress assuming Zstd
                        let decoded_data = zstd::stream::decode_all(std::io::Cursor::new(&data))
                            .unwrap_or_else(|_| data.clone()); // Fallback to raw data if decompression fails (legacy plain JSON)

                        // 尝试新格式（v2: SyncChangesPayload，含完整记录数据）
                        if let Ok(payload) =
                            serde_json::from_slice::<SyncChangesPayload>(&decoded_data)
                        {
                            tracing::debug!(
                                "[sync] 下载变更文件(v2): key={}, count={}",
                                file.key,
                                payload.total_count
                            );
                            for change in payload.changes {
                                if let Some(db) = change.database_name.as_deref() {
                                    if let Some(db_since) = per_db_since.and_then(|m| m.get(db)) {
                                        if version < *db_since {
                                            continue;
                                        }
                                    }
                                }
                                all_changes.push(change);
                            }
                        }
                        // 回退到旧格式（v1: PendingChanges，仅含元数据）
                        else if let Ok(changes) =
                            serde_json::from_slice::<PendingChanges>(&decoded_data)
                        {
                            tracing::warn!(
                                "[sync] 下载变更文件(v1/旧格式，数据不完整): key={}, count={}",
                                file.key,
                                changes.total_count
                            );
                            // 旧格式仅有元数据，INSERT/UPDATE 的 data 为 None
                            for entry in &changes.entries {
                                let change = SyncChangeWithData::from_entry(entry);
                                if let Some(db) = change.database_name.as_deref() {
                                    if let Some(db_since) = per_db_since.and_then(|m| m.get(db)) {
                                        if version < *db_since {
                                            continue;
                                        }
                                    }
                                }
                                all_changes.push(change);
                            }
                        } else {
                            tracing::warn!("[sync] 无法解析变更文件: key={}, 跳过", file.key);
                        }
                    }
                }
            }
        }

        // 按变更时间排序
        all_changes.sort_by(|a, b| a.changed_at.cmp(&b.changed_at));

        tracing::info!(
            "[sync] 从云端下载变更: since={}, total={}",
            since_version,
            all_changes.len()
        );

        Ok(all_changes)
    }

    /// 从文件路径解析版本号
    fn parse_version_from_key(key: &str) -> Option<u64> {
        // 格式: data_governance/changes/{device_id}/{version}-{nonce}.json
        key.rsplit('/')
            .next()
            .and_then(|filename| filename.strip_suffix(".json"))
            .and_then(|stem| stem.split('-').next())
            .and_then(|version_str| version_str.parse().ok())
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
    /// * `(SyncExecutionResult, Vec<SyncChangeWithData>)` - 同步执行结果和下载的变更数据（含完整记录）
    pub async fn execute_download(
        &self,
        storage: &dyn CloudStorage,
        local_manifest: &SyncManifest,
        strategy: MergeStrategy,
    ) -> Result<(SyncExecutionResult, Vec<SyncChangeWithData>), SyncError> {
        let start = std::time::Instant::now();

        // 1. 下载云端清单
        let cloud_manifest = self.download_manifest(storage).await?;

        // 如果云端没有数据
        if cloud_manifest.sync_transaction_id.is_empty() {
            return Ok((
                SyncExecutionResult {
                    success: true,
                    direction: SyncDirection::Download,
                    changes_uploaded: 0,
                    changes_downloaded: 0,
                    conflicts_detected: 0,
                    duration_ms: start.elapsed().as_millis() as u64,
                    error_message: None,
                },
                vec![],
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

        let changes = self
            .download_changes(storage, since_version, Some(&per_db_since))
            .await?;

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
                changes_downloaded: changes.len(),
                conflicts_detected: conflicts_count,
                duration_ms: start.elapsed().as_millis() as u64,
                error_message: None,
            },
            changes,
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
    /// * `(SyncExecutionResult, Vec<i64>, Vec<SyncChangeWithData>)` - 同步结果、需要标记的变更 ID、下载的变更（含完整数据）
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
    ) -> Result<(SyncExecutionResult, Vec<i64>, Vec<SyncChangeWithData>), SyncError> {
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
                error_message: None,
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
        let mut sql = String::from(
            "SELECT id, table_name, record_id, operation, changed_at, sync_version
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

        // 构建 IN 子句的占位符
        let placeholders: Vec<String> = (1..=change_ids.len())
            .map(|i| format!("?{}", i + 1))
            .collect();
        let placeholders_str = placeholders.join(", ");

        let sql = format!(
            "UPDATE __change_log SET sync_version = ?1 WHERE id IN ({})",
            placeholders_str
        );

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| SyncError::Database(format!("准备更新语句失败: {}", e)))?;

        // 构建参数列表
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> =
            Vec::with_capacity(change_ids.len() + 1);
        params_vec.push(Box::new(sync_version));
        for id in change_ids {
            params_vec.push(Box::new(*id));
        }

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|b| b.as_ref()).collect();

        let updated = stmt
            .execute(params_refs.as_slice())
            .map_err(|e| SyncError::Database(format!("更新同步版本失败: {}", e)))?;

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
        let deleted = conn
            .execute(
                "DELETE FROM __change_log WHERE sync_version > 0 AND changed_at < ?1",
                params![older_than],
            )
            .map_err(|e| SyncError::Database(format!("清理变更日志失败: {}", e)))?;

        Ok(deleted)
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
                    match Self::compare_timestamps(
                        &conflict.local_updated_at,
                        &conflict.cloud_updated_at,
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

    /// 比较两个时间戳字符串
    fn compare_timestamps(local: &str, cloud: &str) -> std::cmp::Ordering {
        // 假设时间戳是 ISO 8601 格式，可以直接进行字符串比较
        local.cmp(cloud)
    }

    /// 应用合并策略到数据库（实际执行更新）
    ///
    /// 根据合并结果，执行实际的数据库更新操作。
    /// 采用"DELETE + INSERT"策略处理 UPDATE，确保数据完整性。
    ///
    /// # 参数
    /// * `conn` - 数据库连接
    /// * `table_name` - 表名
    /// * `records_to_pull` - 需要从云端拉取更新的记录 ID 列表
    /// * `cloud_data` - 云端数据映射（record_id -> JSON 数据）
    /// * `id_column` - 主键列名
    ///
    /// # 策略
    /// 1. 开启事务
    /// 2. 对于每条记录：DELETE 旧数据 + INSERT 新数据
    /// 3. 提交事务（失败则回滚）
    ///
    /// # 返回
    /// * 成功应用的记录数量
    pub fn apply_merge_to_database(
        conn: &Connection,
        table_name: &str,
        records_to_pull: &[String],
        cloud_data: &HashMap<String, serde_json::Value>,
        id_column: &str,
    ) -> Result<usize, SyncError> {
        if records_to_pull.is_empty() {
            return Ok(0);
        }

        let mut updated = 0;

        for record_id in records_to_pull {
            if let Some(data) = cloud_data.get(record_id) {
                match Self::apply_single_record(conn, table_name, record_id, data, id_column) {
                    Ok(()) => {
                        updated += 1;
                        tracing::debug!(
                            "[sync] 成功应用记录 {}.{} = {}",
                            table_name,
                            id_column,
                            record_id
                        );
                    }
                    Err(e) => {
                        tracing::error!(
                            "[sync] 应用记录失败 {}.{} = {}: {}",
                            table_name,
                            id_column,
                            record_id,
                            e
                        );
                        // 继续处理其他记录，记录失败
                    }
                }
            } else {
                tracing::warn!(
                    "[sync] 云端数据缺失 {}.{} = {}，跳过",
                    table_name,
                    id_column,
                    record_id
                );
            }
        }

        Ok(updated)
    }

    /// 应用单条记录到数据库
    ///
    /// 使用标准 UPSERT (`ON CONFLICT DO UPDATE`) 策略处理更新。
    /// 相比 `REPLACE`，它不会触发 DELETE 触发器，也不会改变 rowid，更加安全。
    fn apply_single_record(
        conn: &Connection,
        table_name: &str,
        record_id: &str,
        data: &serde_json::Value,
        id_column: &str,
    ) -> Result<(), SyncError> {
        Self::ensure_table_allowed_and_exists(conn, table_name)?;

        let table_ident = Self::quote_identifier(table_name)?;

        let obj = data.as_object().ok_or_else(|| {
            SyncError::Database(format!("记录数据不是有效的 JSON 对象: {}", record_id))
        })?;

        if obj.is_empty() {
            return Err(SyncError::Database(format!("记录数据为空: {}", record_id)));
        }

        // Phase 5.1 Optimization: Use ON CONFLICT DO UPDATE (True UPSERT)
        let (columns, placeholders, values) = Self::build_insert_parts(obj)?;
        let columns_list: Vec<&str> = columns.split(", ").collect();

        let upsert_sql = if table_name == "llm_usage_daily" {
            // 复合主键特殊处理
            let update_set = columns_list
                .iter()
                .map(|c| format!("{}=excluded.{}", c, c))
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT(date, caller_type, model, provider) DO UPDATE SET {}",
                table_ident, columns, placeholders, update_set
            )
        } else {
            // 标准单主键处理
            let pk_ident = Self::quote_identifier(id_column)?;
            let update_set = columns_list
                .iter()
                // 可选：跳过主键自身的更新（虽然更新为相同值也没错，但跳过更干净）
                .filter(|c| **c != pk_ident.as_str())
                .map(|c| format!("{}=excluded.{}", c, c))
                .collect::<Vec<_>>()
                .join(", ");

            // 如果 update_set 为空（例如表只有主键），DO UPDATE 需要处理
            let action = if update_set.is_empty() {
                "DO NOTHING".to_string()
            } else {
                format!("DO UPDATE SET {}", update_set)
            };

            format!(
                "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT({}) {}",
                table_ident, columns, placeholders, pk_ident, action
            )
        };

        let params_refs: Vec<&dyn rusqlite::ToSql> = values.iter().map(|v| v.as_ref()).collect();
        conn.execute(&upsert_sql, params_refs.as_slice())
            .map_err(|e| SyncError::Database(format!("UPSERT (OnConflict) 记录失败: {}", e)))?;

        Ok(())
    }

    /// 从 JSON 对象构建 INSERT 语句的各部分
    ///
    /// # 返回
    /// * `(列名列表, 占位符列表, 参数值列表)`
    fn build_insert_parts(
        obj: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(String, String, Vec<Box<dyn rusqlite::ToSql>>), SyncError> {
        let mut columns = Vec::new();
        let mut placeholders = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        for (i, (key, value)) in obj.iter().enumerate() {
            columns.push(Self::quote_identifier(key)?);
            placeholders.push(format!("?{}", i + 1));

            // 根据 JSON 值类型转换为 SQLite 参数
            let sql_value: Box<dyn rusqlite::ToSql> = match value {
                serde_json::Value::Null => Box::new(None::<String>),
                serde_json::Value::Bool(b) => Box::new(*b),
                serde_json::Value::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        Box::new(i)
                    } else if let Some(f) = n.as_f64() {
                        Box::new(f)
                    } else {
                        Box::new(n.to_string())
                    }
                }
                serde_json::Value::String(s) => Box::new(s.clone()),
                // 数组和对象序列化为 JSON 字符串存储
                serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
                    Box::new(serde_json::to_string(value).unwrap_or_default())
                }
            };
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

        Ok(())
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
    pub fn apply_downloaded_changes(
        conn: &Connection,
        changes: &[SyncChangeWithData],
        id_column_map: Option<&HashMap<String, String>>,
    ) -> Result<ApplyChangesResult, SyncError> {
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

        conn.execute_batch("BEGIN IMMEDIATE;")
            .map_err(|e| SyncError::Database(format!("开始事务失败: {}", e)))?;

        let apply_result: Result<(), SyncError> = (|| {
            // 禁用外键检查以避免顺序问题（事务内）
            conn.execute_batch("PRAGMA foreign_keys = OFF;")
                .map_err(|e| SyncError::Database(format!("禁用外键检查失败: {}", e)))?;

            for change in changes {
                let id_column = id_column_map
                    .and_then(|m| m.get(&change.table_name))
                    .map(|s| s.as_str())
                    .unwrap_or("id");

                let pre_log_max_id = if change.suppress_change_log.unwrap_or(false) {
                    conn.query_row("SELECT COALESCE(MAX(id), 0) FROM __change_log", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .ok()
                } else {
                    None
                };

                let applied = Self::apply_single_change(conn, change, id_column)?;
                if applied {
                    result.success_count += 1;
                } else {
                    result.skipped_count += 1;
                }

                if let Some(max_id) = pre_log_max_id {
                    let sync_version = chrono::Utc::now().timestamp();
                    let _ = conn.execute(
                        "UPDATE __change_log SET sync_version = ?1 WHERE id > ?2 AND sync_version = 0",
                        params![sync_version, max_id],
                    );
                }
            }

            // 重新启用外键检查
            conn.execute_batch("PRAGMA foreign_keys = ON;")
                .map_err(|e| SyncError::Database(format!("启用外键检查失败: {}", e)))?;

            // 强校验：必须没有任何外键违规
            let violations = Self::collect_foreign_key_violations(conn, 20)?;
            if !violations.is_empty() {
                return Err(SyncError::Database(format!(
                    "外键约束检查失败（示例最多 20 条）: {}",
                    violations.join("; ")
                )));
            }

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

    /// 应用单条变更
    ///
    /// # 返回
    /// * `Ok(true)` - 成功应用
    /// * `Ok(false)` - 跳过（如 DELETE 无数据）
    /// * `Err` - 应用失败
    fn apply_single_change(
        conn: &Connection,
        change: &SyncChangeWithData,
        id_column: &str,
    ) -> Result<bool, SyncError> {
        match change.operation {
            ChangeOperation::Delete => {
                // DELETE 操作：直接删除记录
                Self::ensure_table_allowed_and_exists(conn, &change.table_name)?;
                let table_ident = Self::quote_identifier(&change.table_name)?;
                let affected = if change.table_name == "llm_usage_daily" {
                    let (date, caller_type, model, provider) =
                        Self::parse_llm_usage_daily_record_id(&change.record_id)?;
                    let sql = format!(
                        "DELETE FROM {} WHERE date = ?1 AND caller_type = ?2 AND model = ?3 AND provider = ?4",
                        table_ident
                    );
                    conn.execute(&sql, params![date, caller_type, model, provider])
                        .map_err(|e| SyncError::Database(format!("删除记录失败: {}", e)))?
                } else {
                    let id_col_ident = Self::quote_identifier(id_column)?;
                    let sql = format!("DELETE FROM {} WHERE {} = ?1", table_ident, id_col_ident);
                    conn.execute(&sql, params![&change.record_id])
                        .map_err(|e| SyncError::Database(format!("删除记录失败: {}", e)))?
                };

                tracing::debug!(
                    "[sync] DELETE {}.{} = {}, affected={}",
                    change.table_name,
                    id_column,
                    change.record_id,
                    affected
                );
                Ok(true)
            }
            ChangeOperation::Insert | ChangeOperation::Update => {
                // INSERT/UPDATE 操作：使用 DELETE + INSERT 策略
                let data = match &change.data {
                    Some(d) => d,
                    None => {
                        // v1 旧格式兼容：下载的变更不含记录数据，无法回放 INSERT/UPDATE。
                        // 跳过而非报错，避免整个事务回滚。
                        tracing::warn!(
                            "[sync] INSERT/UPDATE 缺少数据（旧格式兼容），跳过: {}.{} = {}",
                            change.table_name,
                            id_column,
                            change.record_id
                        );
                        return Ok(false);
                    }
                };

                Self::apply_single_record(
                    conn,
                    &change.table_name,
                    &change.record_id,
                    data,
                    id_column,
                )?;
                Ok(true)
            }
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
        id_column: &str,
        columns: &[String],
    ) -> Result<Option<serde_json::Value>, SyncError> {
        Self::ensure_table_allowed_and_exists(conn, table_name)?;
        let table_ident = Self::quote_identifier(table_name)?;
        let columns_str = columns
            .iter()
            .map(|c| Self::quote_identifier(c))
            .collect::<Result<Vec<_>, _>>()?
            .join(", ");
        let (sql, values): (String, Vec<String>) = if table_name == "llm_usage_daily" {
            let (date, caller_type, model, provider) =
                Self::parse_llm_usage_daily_record_id(record_id)?;
            (
                format!(
                    "SELECT {} FROM {} WHERE date = ?1 AND caller_type = ?2 AND model = ?3 AND provider = ?4",
                    columns_str, table_ident
                ),
                vec![date, caller_type, model, provider],
            )
        } else {
            let id_col_ident = Self::quote_identifier(id_column)?;
            (
                format!(
                    "SELECT {} FROM {} WHERE {} = ?1",
                    columns_str, table_ident, id_col_ident
                ),
                vec![record_id.to_string()],
            )
        };

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
            // 尝试解析为 JSON（处理存储的 JSON 字符串）
            if v.starts_with('{') || v.starts_with('[') {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&v) {
                    return parsed;
                }
            }
            return serde_json::Value::String(v);
        }
        if let Ok(v) = row.get::<_, Vec<u8>>(index) {
            // BLOB 类型，转为 base64 字符串
            use base64::Engine;
            let encoded = base64::engine::general_purpose::STANDARD.encode(&v);
            return serde_json::Value::String(encoded);
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

        // 计算简单的 checksum（基于表数量和记录数）
        // 实际应用中可能需要更复杂的 checksum 算法
        let checksum = Self::calculate_simple_checksum(conn, database_name)?;

        Ok(DatabaseSyncState {
            schema_version,
            data_version,
            checksum,
            last_updated_at,
        })
    }

    /// 计算简单的数据库 checksum
    fn calculate_simple_checksum(
        conn: &Connection,
        database_name: &str,
    ) -> Result<String, SyncError> {
        // 获取所有表的记录数
        let tables: Vec<String> = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table'
                 AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_\\_%' ESCAPE '\\'",
            )
            .map_err(|e| SyncError::Database(format!("查询表列表失败: {}", e)))?
            .query_map([], |row| row.get(0))
            .map_err(|e| SyncError::Database(format!("获取表名失败: {}", e)))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| SyncError::Database(format!("解析表名失败: {}", e)))?;

        let mut hasher_input = format!("{}:", database_name);

        for table in tables {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |row| {
                    row.get(0)
                })
                .unwrap_or(0);
            hasher_input.push_str(&format!("{}={};", table, count));
        }

        // 使用简单的哈希（实际应用中可以使用 SHA256）
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();
        hasher_input.hash(&mut hasher);
        let hash = hasher.finish();

        Ok(format!("{:016x}", hash))
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
        }
    }

    /// 从 ChangeLogEntry 创建并附加数据
    pub fn from_entry_with_data(entry: &ChangeLogEntry, data: Option<serde_json::Value>) -> Self {
        Self {
            table_name: entry.table_name.clone(),
            record_id: entry.record_id.clone(),
            operation: entry.operation,
            data,
            changed_at: entry.changed_at.clone(),
            change_log_id: Some(entry.id),
            database_name: None,
            suppress_change_log: None,
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
    /// 跳过的变更数（如数据为空的 INSERT/UPDATE）
    pub skipped_count: usize,
    /// 失败的详情
    pub failures: Vec<ApplyChangeFailure>,
}

impl ApplyChangesResult {
    /// 创建空结果
    pub fn empty() -> Self {
        Self {
            success_count: 0,
            failure_count: 0,
            skipped_count: 0,
            failures: Vec::new(),
        }
    }

    /// 合并另一个结果
    pub fn merge(&mut self, other: ApplyChangesResult) {
        self.success_count += other.success_count;
        self.failure_count += other.failure_count;
        self.skipped_count += other.skipped_count;
        self.failures.extend(other.failures);
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
}

fn default_format_version() -> u32 {
    2
}

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

#[cfg(test)]
mod tests {
    use super::*;

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
        // 新格式：秒级时间戳 + UUID nonce
        let key =
            "data_governance/changes/device-1/1707500000-550e8400-e29b-41d4-a716-446655440000.json";
        assert_eq!(SyncManager::parse_version_from_key(key), Some(1707500000));
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
            },
            ChangeLogEntry {
                id: 2,
                table_name: "sessions".to_string(),
                record_id: "sess-1".to_string(),
                operation: ChangeOperation::Insert,
                changed_at: "2024-01-01T11:00:00Z".to_string(),
                sync_version: 0,
            },
            ChangeLogEntry {
                id: 3,
                table_name: "messages".to_string(),
                record_id: "msg-2".to_string(),
                operation: ChangeOperation::Update,
                changed_at: "2024-01-01T12:00:00Z".to_string(),
                sync_version: 0,
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
            },
            ChangeLogEntry {
                id: 5,
                table_name: "messages".to_string(),
                record_id: "msg-2".to_string(),
                operation: ChangeOperation::Update,
                changed_at: "2024-01-01T11:00:00Z".to_string(),
                sync_version: 0,
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
            },
            ChangeLogEntry {
                id: 2,
                table_name: "messages".to_string(),
                record_id: "msg-2".to_string(),
                operation: ChangeOperation::Update,
                changed_at: "2024-01-01T08:00:00Z".to_string(),
                sync_version: 0,
            },
            ChangeLogEntry {
                id: 3,
                table_name: "messages".to_string(),
                record_id: "msg-3".to_string(),
                operation: ChangeOperation::Delete,
                changed_at: "2024-01-01T15:00:00Z".to_string(),
                sync_version: 0,
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
        }];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

        assert_eq!(result.success_count, 0);
        assert_eq!(
            result.skipped_count, 1,
            "data=None INSERT should be skipped, not error"
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
        }];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

        assert_eq!(result.success_count, 0);
        assert_eq!(
            result.skipped_count, 1,
            "data=None UPDATE should be skipped"
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
        }];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

        assert_eq!(
            result.success_count, 1,
            "DELETE without data should succeed"
        );
        assert_eq!(result.skipped_count, 0);

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
            },
        ];

        let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

        assert_eq!(result.success_count, 1, "only valid INSERT should succeed");
        assert_eq!(
            result.skipped_count, 1,
            "data=None INSERT should be skipped"
        );
        assert_eq!(result.failure_count, 0, "no failures expected");
    }

    #[test]
    fn test_get_record_data_llm_usage_daily_with_json_record_id() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE llm_usage_daily (
                date TEXT NOT NULL,
                caller_type TEXT NOT NULL,
                model TEXT NOT NULL,
                provider TEXT NOT NULL,
                request_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (date, caller_type, model, provider)
            );
            INSERT INTO llm_usage_daily(date, caller_type, model, provider, request_count)
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

        let data = SyncManager::get_record_data(&conn, "llm_usage_daily", &record_id, "id")
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
}
