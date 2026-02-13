//! # Schema Registry (结构演进状态模块)
//!
//! 记录所有数据库的版本状态、依赖关系、迁移历史。
//!
//! ## 设计原则
//!
//! **派生视图，非文件源**：
//! - 权威数据源：各数据库内的 `refinery_schema_history` 表
//! - SchemaRegistry：启动时从各数据库实时聚合，作为缓存视图
//! - 不单独持久化 registry.json，避免双源不一致
//!
//! ## 职责
//!
//! - 查询各数据库的当前版本、兼容版本范围
//! - 追踪数据库间的依赖关系
//! - 统一执行跨库迁移状态检查
//! - 区分 schema version、data contract version、API version
//!
//! ## Refinery 表结构
//!
//! Refinery 自动创建的 `refinery_schema_history` 表：
//! - `version`: INTEGER - 迁移版本号
//! - `name`: TEXT - 迁移名称（如 V20260130_001__init）
//! - `applied_on`: TEXT - 应用时间（ISO 8601 格式）
//! - `checksum`: TEXT - SQL 内容的校验和

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tracing::{debug, info, warn};

/// 数据库标识（治理范围内的数据库）
///
/// ## 治理边界声明
///
/// 以下数据库纳入治理（迁移 + 备份 + 同步）：
/// - `Vfs` — 虚拟文件系统（核心数据）
/// - `ChatV2` — 聊天记录（核心数据）
/// - `Mistakes` — 主数据库（历史命名，核心数据）
/// - `LlmUsage` — LLM 使用统计（重要数据）
///
/// 以下数据库**明确豁免**，不纳入数据治理系统：
/// - `message_queue.db` — 持久化消息队列（运行时临时队列，重启后自动重建，无需迁移/备份/同步）
/// - `ws_*.db` — 工作空间独立数据库（生命周期由工作空间管理，随工作空间创建/删除）
/// - `resources.db` — 兼容期资源数据库（已废弃，仅用于旧数据兼容读取，不再写入新数据）
///
/// 如果未来需要纳管上述豁免数据库，需在此枚举中新增变体，
/// 并同步更新 `all_ordered()`、`dependencies()`、前端 `dataGovernance.ts` 中的类型声明、
/// 以及 `MigrationCoordinator::get_database_path()` 中的路径映射。
#[derive(Debug, Clone, Hash, Eq, PartialEq, Serialize, Deserialize)]
pub enum DatabaseId {
    Vfs,
    ChatV2,
    Mistakes,
    LlmUsage,
}

impl DatabaseId {
    pub fn as_str(&self) -> &'static str {
        match self {
            DatabaseId::Vfs => "vfs",
            DatabaseId::ChatV2 => "chat_v2",
            DatabaseId::Mistakes => "mistakes",
            DatabaseId::LlmUsage => "llm_usage",
        }
    }

    /// 返回此数据库依赖的其他数据库（必须先迁移）
    pub fn dependencies(&self) -> &[DatabaseId] {
        match self {
            DatabaseId::Vfs => &[],
            DatabaseId::ChatV2 => &[DatabaseId::Vfs], // Chat V2 可能引用 VFS 资源
            DatabaseId::Mistakes => &[DatabaseId::Vfs],
            DatabaseId::LlmUsage => &[], // 独立，无依赖
        }
    }

    /// 返回所有数据库 ID（按依赖顺序排序）
    pub fn all_ordered() -> Vec<DatabaseId> {
        // 拓扑排序：无依赖的先执行
        vec![
            DatabaseId::Vfs,
            DatabaseId::LlmUsage,
            DatabaseId::ChatV2,
            DatabaseId::Mistakes,
        ]
    }
}

/// 数据库状态
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseStatus {
    /// 数据库标识
    pub id: DatabaseId,
    /// 当前 schema 版本
    pub schema_version: u32,
    /// 最小兼容版本
    pub min_compatible_version: u32,
    /// 最大兼容版本
    pub max_compatible_version: u32,
    /// 数据契约版本（映射自 schema_version）
    pub data_contract_version: String,
    /// 迁移历史
    pub migration_history: Vec<MigrationRecord>,
    /// 当前 schema 的 checksum
    pub checksum: String,
    /// 最后更新时间
    pub updated_at: String,
}

/// 迁移记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationRecord {
    /// 版本号
    pub version: u32,
    /// 迁移名称
    pub name: String,
    /// SQL 内容的 checksum
    pub checksum: String,
    /// 应用时间
    pub applied_at: String,
    /// 执行耗时（毫秒）
    pub duration_ms: Option<u64>,
    /// 是否成功
    pub success: bool,
}

/// Schema 版本到数据契约版本的映射
pub const VERSION_MAPPING: &[(u32, &str)] = &[
    // (schema_version, data_contract_version)
    (1, "1.0.0"), // 初始版本（v1 锚定）
];

/// 根据 schema 版本获取数据契约版本
pub fn get_data_contract_version(schema_version: u32) -> String {
    for &(ver, contract) in VERSION_MAPPING.iter().rev() {
        if schema_version >= ver {
            return contract.to_string();
        }
    }
    "0.0.0".to_string()
}

/// Schema 注册表
///
/// **注意**：这是一个派生视图，从各数据库实时聚合生成。
/// 不再作为独立文件持久化，避免与数据库内记录不一致。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaRegistry {
    /// 各数据库状态
    pub databases: HashMap<DatabaseId, DatabaseStatus>,
    /// 全局版本戳（各库版本的最大值，表示整体最新迁移状态）
    pub global_version: u64,
    /// 聚合时间
    pub aggregated_at: String,
}

/// Refinery 迁移历史表名
const REFINERY_SCHEMA_HISTORY_TABLE: &str = "refinery_schema_history";

/// 从数据库读取的原始迁移记录
#[derive(Debug, Clone)]
struct RawMigrationRecord {
    version: i32,
    name: String,
    applied_on: String,
    checksum: String,
}

impl SchemaRegistry {
    /// 创建空的注册表
    pub fn new() -> Self {
        Self {
            databases: HashMap::new(),
            global_version: 0,
            aggregated_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    /// 从各数据库实时聚合状态
    ///
    /// 这是获取 Registry 的推荐方式，确保与数据库状态一致。
    ///
    /// # Arguments
    /// * `connections` - 各数据库连接的迭代器，元素为 (DatabaseId, &Connection)
    ///
    /// # Returns
    /// 聚合后的 SchemaRegistry
    ///
    /// # 实现细节
    ///
    /// 1. 遍历所有数据库连接
    /// 2. 检查 `refinery_schema_history` 表是否存在
    /// 3. 读取迁移历史记录
    /// 4. 构建 DatabaseStatus
    /// 5. 计算全局版本戳
    pub fn aggregate_from_databases<'a, I>(connections: I) -> Result<Self, SchemaRegistryError>
    where
        I: Iterator<Item = (DatabaseId, &'a Connection)>,
    {
        let mut registry = Self::new();
        let now = chrono::Utc::now().to_rfc3339();

        for (db_id, conn) in connections {
            debug!("聚合数据库状态: {:?}", db_id);

            match Self::read_database_status(db_id.clone(), conn) {
                Ok(status) => {
                    info!(
                        "数据库 {:?} 当前版本: {}, 迁移记录数: {}",
                        db_id,
                        status.schema_version,
                        status.migration_history.len()
                    );
                    registry.databases.insert(db_id, status);
                }
                Err(SchemaRegistryError::TableNotFound { .. }) => {
                    // 表不存在表示数据库尚未进行过迁移，创建空状态
                    warn!(
                        "数据库 {:?} 的 {} 表不存在，使用初始状态",
                        db_id, REFINERY_SCHEMA_HISTORY_TABLE
                    );
                    let empty_status = DatabaseStatus {
                        id: db_id.clone(),
                        schema_version: 0,
                        min_compatible_version: 0,
                        max_compatible_version: 0,
                        data_contract_version: get_data_contract_version(0),
                        migration_history: vec![],
                        checksum: String::new(),
                        updated_at: now.clone(),
                    };
                    registry.databases.insert(db_id, empty_status);
                }
                Err(e) => {
                    return Err(e);
                }
            }
        }

        // 计算全局版本戳
        registry.global_version = registry.calculate_global_version();
        registry.aggregated_at = now;

        info!(
            "Schema Registry 聚合完成: {} 个数据库, 全局版本: {}",
            registry.databases.len(),
            registry.global_version
        );

        Ok(registry)
    }

    /// 从单个数据库连接读取状态
    fn read_database_status(
        db_id: DatabaseId,
        conn: &Connection,
    ) -> Result<DatabaseStatus, SchemaRegistryError> {
        // 1. 检查表是否存在
        if !Self::table_exists(conn, REFINERY_SCHEMA_HISTORY_TABLE)? {
            return Err(SchemaRegistryError::TableNotFound {
                database: db_id,
                table: REFINERY_SCHEMA_HISTORY_TABLE.to_string(),
            });
        }

        // 2. 读取所有迁移记录
        let raw_records = Self::read_migration_records(conn)?;

        // 3. 转换为 MigrationRecord
        let migration_history: Vec<MigrationRecord> = raw_records
            .iter()
            .map(|raw| MigrationRecord {
                version: raw.version as u32,
                name: raw.name.clone(),
                checksum: raw.checksum.clone(),
                applied_at: raw.applied_on.clone(),
                duration_ms: None, // Refinery 不记录执行时间
                success: true,     // 记录存在即表示成功
            })
            .collect();

        // 4. 计算当前版本（最大版本号）
        let schema_version = migration_history
            .iter()
            .map(|r| r.version)
            .max()
            .unwrap_or(0);

        // 5. 计算聚合 checksum（所有迁移 checksum 的哈希）
        let aggregated_checksum = Self::calculate_aggregated_checksum(&migration_history);

        // 6. 获取最后更新时间
        let updated_at = migration_history
            .iter()
            .map(|r| r.applied_at.as_str())
            .max()
            .unwrap_or("")
            .to_string();

        // 7. 构建状态对象
        let status = DatabaseStatus {
            id: db_id,
            schema_version,
            min_compatible_version: Self::calculate_min_compatible_version(schema_version),
            max_compatible_version: schema_version, // 最大兼容版本即当前版本
            data_contract_version: get_data_contract_version(schema_version),
            migration_history,
            checksum: aggregated_checksum,
            updated_at,
        };

        Ok(status)
    }

    /// 检查表是否存在
    fn table_exists(conn: &Connection, table_name: &str) -> Result<bool, SchemaRegistryError> {
        let sql = "SELECT name FROM sqlite_master WHERE type='table' AND name = ?1";
        let result: Option<String> = conn
            .query_row(sql, [table_name], |row| row.get(0))
            .optional()
            .map_err(|e| SchemaRegistryError::Database(e.to_string()))?;

        Ok(result.is_some())
    }

    /// 从 refinery_schema_history 表读取迁移记录
    fn read_migration_records(
        conn: &Connection,
    ) -> Result<Vec<RawMigrationRecord>, SchemaRegistryError> {
        let sql = format!(
            "SELECT version, name, applied_on, checksum FROM {} ORDER BY version ASC",
            REFINERY_SCHEMA_HISTORY_TABLE
        );

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| SchemaRegistryError::Database(e.to_string()))?;

        let records = stmt
            .query_map([], |row| {
                Ok(RawMigrationRecord {
                    version: row.get(0)?,
                    name: row.get(1)?,
                    applied_on: row.get(2)?,
                    checksum: row.get(3)?,
                })
            })
            .map_err(|e| SchemaRegistryError::Database(e.to_string()))?;

        let mut result = Vec::new();
        for record in records {
            result.push(record.map_err(|e| SchemaRegistryError::Database(e.to_string()))?);
        }

        Ok(result)
    }

    /// 计算聚合 checksum
    ///
    /// 将所有迁移的 checksum 按版本顺序拼接后计算 SHA-256
    fn calculate_aggregated_checksum(records: &[MigrationRecord]) -> String {
        if records.is_empty() {
            return String::new();
        }

        let mut sorted_records: Vec<_> = records.iter().collect();
        sorted_records.sort_by_key(|r| r.version);

        let combined: String = sorted_records
            .iter()
            .map(|r| format!("{}:{}", r.version, r.checksum))
            .collect::<Vec<_>>()
            .join("|");

        let mut hasher = Sha256::new();
        hasher.update(combined.as_bytes());
        let result = hasher.finalize();
        hex::encode(result)
    }

    /// 计算最小兼容版本
    ///
    /// 默认策略：最小兼容版本 = 当前版本
    /// 如果需要支持向后兼容，可在此处调整逻辑
    fn calculate_min_compatible_version(current_version: u32) -> u32 {
        // 目前采用严格策略：必须完全匹配
        // 未来可根据 VERSION_MAPPING 中的标记决定向后兼容性
        current_version
    }

    /// 获取数据库状态
    pub fn get_status(&self, id: &DatabaseId) -> Option<&DatabaseStatus> {
        self.databases.get(id)
    }

    /// 获取指定数据库的 schema 版本
    pub fn get_schema_version(&self, id: &DatabaseId) -> Option<u32> {
        self.databases.get(id).map(|s| s.schema_version)
    }

    /// 检查所有数据库是否满足依赖关系
    ///
    /// 遍历所有数据库，确保：
    /// 1. 依赖的数据库存在于 Registry 中
    /// 2. 依赖的数据库版本 >= 被依赖方的最小兼容版本（如果有依赖版本要求）
    pub fn check_dependencies(&self) -> Result<(), SchemaRegistryError> {
        for id in DatabaseId::all_ordered() {
            // 如果当前数据库不在 Registry 中，跳过检查（可能尚未初始化）
            let current_status = match self.databases.get(&id) {
                Some(s) => s,
                None => continue,
            };

            // 检查当前数据库的所有依赖
            for dep in id.dependencies() {
                match self.databases.get(dep) {
                    Some(dep_status) => {
                        // 检查依赖数据库是否已完成初始化（版本 > 0）
                        if dep_status.schema_version == 0 && current_status.schema_version > 0 {
                            return Err(SchemaRegistryError::DependencyNotSatisfied {
                                database: id.clone(),
                                missing_dependency: dep.clone(),
                            });
                        }
                        debug!(
                            "依赖检查通过: {:?} -> {:?} (版本 {})",
                            id, dep, dep_status.schema_version
                        );
                    }
                    None => {
                        return Err(SchemaRegistryError::DependencyNotSatisfied {
                            database: id.clone(),
                            missing_dependency: dep.clone(),
                        });
                    }
                }
            }
        }
        Ok(())
    }

    /// 计算全局版本戳
    ///
    /// 全局版本 = 所有数据库中的最大版本（表示整体最新迁移状态）
    /// 如果没有数据库，返回 0
    /// 用于展示当前系统的最新迁移版本
    pub fn calculate_global_version(&self) -> u64 {
        self.databases
            .values()
            .map(|s| s.schema_version as u64)
            .max()
            .unwrap_or(0)
    }

    /// 检查是否需要迁移
    ///
    /// 比较当前版本与目标版本，判断是否需要执行迁移
    pub fn needs_migration(&self, db_id: &DatabaseId, target_version: u32) -> bool {
        match self.databases.get(db_id) {
            Some(status) => status.schema_version < target_version,
            None => true, // 数据库不存在，需要初始化
        }
    }

    /// 获取所有数据库的状态摘要
    pub fn get_summary(&self) -> HashMap<String, u32> {
        self.databases
            .iter()
            .map(|(id, status)| (id.as_str().to_string(), status.schema_version))
            .collect()
    }

    /// 验证所有数据库的 checksum 一致性
    ///
    /// 用于检测数据库是否被非法修改
    pub fn verify_checksums<'a, I>(
        &self,
        connections: I,
    ) -> Result<Vec<ChecksumMismatch>, SchemaRegistryError>
    where
        I: Iterator<Item = (DatabaseId, &'a Connection)>,
    {
        let mut mismatches = Vec::new();

        for (db_id, conn) in connections {
            if let Some(cached_status) = self.databases.get(&db_id) {
                match Self::read_database_status(db_id.clone(), conn) {
                    Ok(current_status) => {
                        if cached_status.checksum != current_status.checksum {
                            mismatches.push(ChecksumMismatch {
                                database: db_id,
                                expected: cached_status.checksum.clone(),
                                actual: current_status.checksum,
                            });
                        }
                    }
                    Err(e) => {
                        warn!("验证数据库 {:?} checksum 失败: {}", db_id, e);
                    }
                }
            }
        }

        Ok(mismatches)
    }
}

/// Checksum 不匹配记录
#[derive(Debug, Clone)]
pub struct ChecksumMismatch {
    pub database: DatabaseId,
    pub expected: String,
    pub actual: String,
}

impl Default for SchemaRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Schema Registry 错误类型
#[derive(Debug, thiserror::Error)]
pub enum SchemaRegistryError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Database error: {0}")]
    Database(String),

    #[error("Database not found: {0:?}")]
    DatabaseNotFound(DatabaseId),

    #[error("Table not found: {database:?}.{table}")]
    TableNotFound { database: DatabaseId, table: String },

    #[error("Dependency not satisfied: {database:?} requires {missing_dependency:?}")]
    DependencyNotSatisfied {
        database: DatabaseId,
        missing_dependency: DatabaseId,
    },

    #[error("Checksum mismatch for database {database:?}: expected {expected}, got {actual}")]
    ChecksumMismatch {
        database: DatabaseId,
        expected: String,
        actual: String,
    },

    #[error("Version conflict: {database:?} at version {current}, expected {expected}")]
    VersionConflict {
        database: DatabaseId,
        current: u32,
        expected: u32,
    },

    #[error("Not implemented: {0}")]
    NotImplemented(String),
}

impl From<rusqlite::Error> for SchemaRegistryError {
    fn from(err: rusqlite::Error) -> Self {
        SchemaRegistryError::Database(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// 创建内存数据库并模拟 Refinery 迁移历史表
    fn create_test_db_with_migrations(records: &[(i32, &str, &str, &str)]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();

        // 创建 refinery_schema_history 表（模拟 Refinery 自动创建的表）
        conn.execute(
            "CREATE TABLE refinery_schema_history (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_on TEXT NOT NULL,
                checksum TEXT NOT NULL
            )",
            [],
        )
        .unwrap();

        // 插入测试数据
        for (version, name, applied_on, checksum) in records {
            conn.execute(
                "INSERT INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![version, name, applied_on, checksum],
            )
            .unwrap();
        }

        conn
    }

    /// 创建空数据库（无迁移历史表）
    fn create_empty_test_db() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    #[test]
    fn test_aggregate_from_single_database() {
        let conn = create_test_db_with_migrations(&[
            (1, "V1__init", "2026-01-30T10:00:00Z", "abc123"),
            (2, "V2__add_index", "2026-01-30T11:00:00Z", "def456"),
        ]);

        let connections = vec![(DatabaseId::Vfs, &conn)];
        let registry = SchemaRegistry::aggregate_from_databases(connections.into_iter()).unwrap();

        assert_eq!(registry.databases.len(), 1);

        let status = registry.get_status(&DatabaseId::Vfs).unwrap();
        assert_eq!(status.schema_version, 2);
        assert_eq!(status.migration_history.len(), 2);
        assert_eq!(status.migration_history[0].version, 1);
        assert_eq!(status.migration_history[1].version, 2);
    }

    #[test]
    fn test_aggregate_from_multiple_databases() {
        let vfs_conn = create_test_db_with_migrations(&[(
            1,
            "V1__vfs_init",
            "2026-01-30T10:00:00Z",
            "vfs123",
        )]);
        let chat_conn = create_test_db_with_migrations(&[
            (1, "V1__chat_init", "2026-01-30T10:00:00Z", "chat123"),
            (2, "V2__chat_index", "2026-01-30T11:00:00Z", "chat456"),
            (3, "V3__chat_update", "2026-01-30T12:00:00Z", "chat789"),
        ]);

        let connections = vec![
            (DatabaseId::Vfs, &vfs_conn),
            (DatabaseId::ChatV2, &chat_conn),
        ];
        let registry = SchemaRegistry::aggregate_from_databases(connections.into_iter()).unwrap();

        assert_eq!(registry.databases.len(), 2);
        assert_eq!(registry.global_version, 3); // max(1, 3)

        let vfs_status = registry.get_status(&DatabaseId::Vfs).unwrap();
        assert_eq!(vfs_status.schema_version, 1);

        let chat_status = registry.get_status(&DatabaseId::ChatV2).unwrap();
        assert_eq!(chat_status.schema_version, 3);
    }

    #[test]
    fn test_aggregate_with_empty_database() {
        let empty_conn = create_empty_test_db();

        let connections = vec![(DatabaseId::LlmUsage, &empty_conn)];
        let registry = SchemaRegistry::aggregate_from_databases(connections.into_iter()).unwrap();

        assert_eq!(registry.databases.len(), 1);

        let status = registry.get_status(&DatabaseId::LlmUsage).unwrap();
        assert_eq!(status.schema_version, 0);
        assert!(status.migration_history.is_empty());
    }

    #[test]
    fn test_check_dependencies_satisfied() {
        let vfs_conn = create_test_db_with_migrations(&[(
            1,
            "V1__vfs_init",
            "2026-01-30T10:00:00Z",
            "vfs123",
        )]);
        let chat_conn = create_test_db_with_migrations(&[(
            1,
            "V1__chat_init",
            "2026-01-30T10:00:00Z",
            "chat123",
        )]);

        let connections = vec![
            (DatabaseId::Vfs, &vfs_conn),
            (DatabaseId::ChatV2, &chat_conn),
        ];
        let registry = SchemaRegistry::aggregate_from_databases(connections.into_iter()).unwrap();

        // ChatV2 依赖 Vfs，Vfs 已初始化，应该通过
        assert!(registry.check_dependencies().is_ok());
    }

    #[test]
    fn test_check_dependencies_not_satisfied() {
        // ChatV2 依赖 Vfs，但 Vfs 未初始化（版本为 0）
        let vfs_conn = create_empty_test_db();
        let chat_conn = create_test_db_with_migrations(&[(
            1,
            "V1__chat_init",
            "2026-01-30T10:00:00Z",
            "chat123",
        )]);

        let connections = vec![
            (DatabaseId::Vfs, &vfs_conn),
            (DatabaseId::ChatV2, &chat_conn),
        ];
        let registry = SchemaRegistry::aggregate_from_databases(connections.into_iter()).unwrap();

        let result = registry.check_dependencies();
        assert!(result.is_err());

        if let Err(SchemaRegistryError::DependencyNotSatisfied {
            database,
            missing_dependency,
        }) = result
        {
            assert_eq!(database, DatabaseId::ChatV2);
            assert_eq!(missing_dependency, DatabaseId::Vfs);
        } else {
            panic!("Expected DependencyNotSatisfied error");
        }
    }

    #[test]
    fn test_calculate_global_version() {
        let vfs_conn = create_test_db_with_migrations(&[
            (1, "V1", "2026-01-30T10:00:00Z", "a"),
            (2, "V2", "2026-01-30T11:00:00Z", "b"),
        ]);
        let chat_conn = create_test_db_with_migrations(&[(1, "V1", "2026-01-30T10:00:00Z", "c")]);
        let llm_conn = create_test_db_with_migrations(&[
            (1, "V1", "2026-01-30T10:00:00Z", "d"),
            (2, "V2", "2026-01-30T11:00:00Z", "e"),
            (3, "V3", "2026-01-30T12:00:00Z", "f"),
        ]);

        let connections = vec![
            (DatabaseId::Vfs, &vfs_conn),
            (DatabaseId::ChatV2, &chat_conn),
            (DatabaseId::LlmUsage, &llm_conn),
        ];
        let registry = SchemaRegistry::aggregate_from_databases(connections.into_iter()).unwrap();

        // 全局版本 = max(2, 1, 3) = 3
        assert_eq!(registry.global_version, 3);
        assert_eq!(registry.calculate_global_version(), 3);
    }

    #[test]
    fn test_needs_migration() {
        let conn = create_test_db_with_migrations(&[(1, "V1", "2026-01-30T10:00:00Z", "a")]);

        let connections = vec![(DatabaseId::Vfs, &conn)];
        let registry = SchemaRegistry::aggregate_from_databases(connections.into_iter()).unwrap();

        // 当前版本 1，目标版本 2，需要迁移
        assert!(registry.needs_migration(&DatabaseId::Vfs, 2));

        // 当前版本 1，目标版本 1，不需要迁移
        assert!(!registry.needs_migration(&DatabaseId::Vfs, 1));

        // 数据库不存在，需要迁移
        assert!(registry.needs_migration(&DatabaseId::ChatV2, 1));
    }

    #[test]
    fn test_get_summary() {
        let vfs_conn = create_test_db_with_migrations(&[(1, "V1", "2026-01-30T10:00:00Z", "a")]);
        let chat_conn = create_test_db_with_migrations(&[
            (1, "V1", "2026-01-30T10:00:00Z", "b"),
            (2, "V2", "2026-01-30T11:00:00Z", "c"),
        ]);

        let connections = vec![
            (DatabaseId::Vfs, &vfs_conn),
            (DatabaseId::ChatV2, &chat_conn),
        ];
        let registry = SchemaRegistry::aggregate_from_databases(connections.into_iter()).unwrap();

        let summary = registry.get_summary();
        assert_eq!(summary.get("vfs"), Some(&1));
        assert_eq!(summary.get("chat_v2"), Some(&2));
    }

    #[test]
    fn test_aggregated_checksum_consistency() {
        let conn = create_test_db_with_migrations(&[
            (1, "V1", "2026-01-30T10:00:00Z", "checksum_a"),
            (2, "V2", "2026-01-30T11:00:00Z", "checksum_b"),
        ]);

        let connections = vec![(DatabaseId::Vfs, &conn)];
        let registry = SchemaRegistry::aggregate_from_databases(connections.into_iter()).unwrap();

        let status = registry.get_status(&DatabaseId::Vfs).unwrap();

        // 重新计算 checksum 验证一致性
        let records = &status.migration_history;
        let expected_checksum = SchemaRegistry::calculate_aggregated_checksum(records);

        assert_eq!(status.checksum, expected_checksum);
        assert!(!status.checksum.is_empty());
    }

    #[test]
    fn test_verify_checksums_match() {
        let conn =
            create_test_db_with_migrations(&[(1, "V1", "2026-01-30T10:00:00Z", "checksum_a")]);

        let connections1 = vec![(DatabaseId::Vfs, &conn)];
        let registry = SchemaRegistry::aggregate_from_databases(connections1.into_iter()).unwrap();

        // 验证 checksum（数据库未变化）
        let connections2 = vec![(DatabaseId::Vfs, &conn)];
        let mismatches = registry.verify_checksums(connections2.into_iter()).unwrap();

        assert!(mismatches.is_empty());
    }

    #[test]
    fn test_data_contract_version_mapping() {
        assert_eq!(get_data_contract_version(0), "0.0.0");
        assert_eq!(get_data_contract_version(1), "1.0.0");
        assert_eq!(get_data_contract_version(2), "1.0.0"); // 继承上一个映射
        assert_eq!(get_data_contract_version(100), "1.0.0");
    }

    #[test]
    fn test_database_id_dependencies() {
        // Vfs 无依赖
        assert!(DatabaseId::Vfs.dependencies().is_empty());

        // LlmUsage 无依赖
        assert!(DatabaseId::LlmUsage.dependencies().is_empty());

        // ChatV2 依赖 Vfs
        assert_eq!(DatabaseId::ChatV2.dependencies(), &[DatabaseId::Vfs]);

        // Mistakes 依赖 Vfs
        assert_eq!(DatabaseId::Mistakes.dependencies(), &[DatabaseId::Vfs]);
    }

    #[test]
    fn test_database_id_all_ordered() {
        let ordered = DatabaseId::all_ordered();

        // 确保所有数据库都在列表中
        assert_eq!(ordered.len(), 4);

        // 确保 Vfs 和 LlmUsage 在前面（无依赖）
        let vfs_pos = ordered
            .iter()
            .position(|id| *id == DatabaseId::Vfs)
            .unwrap();
        let llm_pos = ordered
            .iter()
            .position(|id| *id == DatabaseId::LlmUsage)
            .unwrap();
        let chat_pos = ordered
            .iter()
            .position(|id| *id == DatabaseId::ChatV2)
            .unwrap();
        let mistakes_pos = ordered
            .iter()
            .position(|id| *id == DatabaseId::Mistakes)
            .unwrap();

        // Vfs 必须在 ChatV2 和 Mistakes 之前
        assert!(vfs_pos < chat_pos);
        assert!(vfs_pos < mistakes_pos);
    }
}
