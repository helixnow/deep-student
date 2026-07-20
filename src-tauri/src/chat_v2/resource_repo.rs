//! ⚠️ DEPRECATED: 资源存储已迁移到 VFS (vfs.db)。
//! 此模块操作 chat_v2.db 中的 resources 表，已被 vfs/repos/resource_repo.rs 替代。
//! 计划在下一次大版本中移除。参见 P1-#9 审计发现。
//!
//! ---
//!
//! 资源库数据存取层
//!
//! 提供 ResourceStore 的数据库 CRUD 操作。
//! 支持基于哈希的去重、引用计数管理和孤立资源清理。
//!
//! ## 核心概念
//! - `Resource`: 资源实体，存储实际内容，基于 hash 去重
//! - `CreateResourceResult`: 创建结果，返回 resourceId、hash 和 isNew
//!
//! ## 注意事项
//! - 所有方法均提供 `_with_conn` 版本，避免死锁
//! - createOrReuse 先查 hash，存在则返回已有资源（去重）
//! - ⚠️ 资源永久保留，不会自动清理（防止数据丢失）

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use tracing::{debug, info, warn};

use super::database::ChatV2Database;
use super::error::{ChatV2Error, ChatV2Result};
use super::resource_types::{
    CreateResourceParams, CreateResourceResult, Resource, ResourceMetadata, ResourceType,
};

// ============================================================================
// 资源库数据存取层
// ============================================================================

/// Log row-parse errors instead of silently discarding them.
fn log_and_skip_err<T>(result: Result<T, rusqlite::Error>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            log::warn!("[ResourceRepo] Row parse error (skipped): {}", e);
            None
        }
    }
}

/// 资源库 Repo
pub struct ResourceRepo;

impl ResourceRepo {
    // ========================================================================
    // 核心方法
    // ========================================================================

    /// 创建或复用资源（基于哈希去重）
    ///
    /// ## 逻辑
    /// 1. 计算内容哈希
    /// 2. 查询是否存在相同哈希的资源
    /// 3. 存在则返回已有资源，不存在则创建新资源
    ///
    /// ## 注意
    /// - 创建新资源时 ref_count = 0（待使用）
    /// - 复用已有资源时 ref_count 不变
    pub fn create_or_reuse(
        db: &ChatV2Database,
        params: CreateResourceParams,
    ) -> ChatV2Result<CreateResourceResult> {
        let conn = db.get_conn_safe()?;
        Self::create_or_reuse_with_conn(&conn, params)
    }

    /// 创建或复用资源（使用现有连接）
    ///
    /// 🔧 P0 修复：原实现「先 find_by_hash 再 INSERT」存在 TOCTOU 竞态——
    /// 两个连接并发写入同一内容时，后到的 INSERT 会撞 `UNIQUE(hash)` 直接报错。
    /// 现改为 `INSERT ... ON CONFLICT(hash) DO NOTHING` + 冲突后回读，
    /// 无论并发顺序如何都能拿到同一条资源，且不依赖外层事务。
    pub fn create_or_reuse_with_conn(
        conn: &Connection,
        params: CreateResourceParams,
    ) -> ChatV2Result<CreateResourceResult> {
        // 1. 计算哈希（基于字符串数据的字节）
        let hash = Self::calculate_hash(params.data.as_bytes());
        debug!("[ResourceRepo] Calculated hash: {}", &hash[..16]);

        // 2. 快路径：已存在则直接复用（避免为重复内容白白生成 id / 序列化 metadata）
        if let Some(resource) = Self::find_by_hash_with_conn(conn, &hash)? {
            debug!(
                "[ResourceRepo] Found existing resource by hash: {}",
                resource.id
            );
            return Ok(CreateResourceResult {
                resource_id: resource.id,
                hash: resource.hash,
                is_new: false,
            });
        }

        // 3. 原子插入：并发同 hash 时 ON CONFLICT DO NOTHING 保证恰好一方插入成功
        let resource_id = Self::generate_id();
        let metadata_json = params
            .metadata
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let created_at = Utc::now().timestamp_millis();

        // data 已经是字符串（文本或 base64），直接存储。
        // 注意：storage_mode 列从未存在于当前迁移系列（V20260130 init 起），
        // 不可引用；updated_at 由 V20260523 补充（TEXT，无默认值），需要在
        // INSERT 时显式写入毫秒时间戳，否则同步冲突解析拿到 NULL 无法比较
        // 新旧（sync 的 parse_flexible_timestamp 支持纯数字毫秒串）。
        let inserted = conn.execute(
            r#"
            INSERT INTO resources (id, hash, type, source_id, data, metadata_json, ref_count, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8)
            ON CONFLICT(hash) DO NOTHING
            "#,
            params![
                resource_id,
                hash,
                params.resource_type.to_string(),
                params.source_id,
                params.data,
                metadata_json,
                created_at,
                created_at.to_string(),
            ],
        )?;

        if inserted == 0 {
            // 竞态输家：另一连接在快路径检查之后插入了同 hash 的资源，回读复用
            let resource = Self::find_by_hash_with_conn(conn, &hash)?.ok_or_else(|| {
                ChatV2Error::Database(format!(
                    "resources upsert race: hash {} conflicted but row not found",
                    &hash[..16.min(hash.len())]
                ))
            })?;
            debug!(
                "[ResourceRepo] Lost insert race, reusing existing resource: {}",
                resource.id
            );
            return Ok(CreateResourceResult {
                resource_id: resource.id,
                hash: resource.hash,
                is_new: false,
            });
        }

        info!("[ResourceRepo] Created new resource: {}", resource_id);

        Ok(CreateResourceResult {
            resource_id,
            hash,
            is_new: true,
        })
    }

    /// 通过 ID + hash 获取资源（精确版本）
    pub fn get_resource(
        db: &ChatV2Database,
        resource_id: &str,
        hash: &str,
    ) -> ChatV2Result<Option<Resource>> {
        let conn = db.get_conn_safe()?;
        Self::get_resource_with_conn(&conn, resource_id, hash)
    }

    /// 通过 ID + hash 获取资源（使用现有连接）
    pub fn get_resource_with_conn(
        conn: &Connection,
        resource_id: &str,
        hash: &str,
    ) -> ChatV2Result<Option<Resource>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, hash, type, source_id, data, metadata_json, ref_count, created_at
            FROM resources
            WHERE id = ?1 AND hash = ?2
            "#,
        )?;

        let resource = stmt
            .query_row(params![resource_id, hash], Self::row_to_resource)
            .optional()?;

        Ok(resource)
    }

    /// 获取资源的最新版本（用于版本失效时回退）
    pub fn get_latest_resource(
        db: &ChatV2Database,
        resource_id: &str,
    ) -> ChatV2Result<Option<Resource>> {
        let conn = db.get_conn_safe()?;
        Self::get_latest_resource_with_conn(&conn, resource_id)
    }

    /// 获取资源的最新版本（使用现有连接）
    pub fn get_latest_resource_with_conn(
        conn: &Connection,
        resource_id: &str,
    ) -> ChatV2Result<Option<Resource>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, hash, type, source_id, data, metadata_json, ref_count, created_at
            FROM resources
            WHERE id = ?1
            ORDER BY created_at DESC
            LIMIT 1
            "#,
        )?;

        let resource = stmt
            .query_row(params![resource_id], Self::row_to_resource)
            .optional()?;

        Ok(resource)
    }

    /// 检查资源是否存在
    pub fn resource_exists(db: &ChatV2Database, resource_id: &str) -> ChatV2Result<bool> {
        let conn = db.get_conn_safe()?;
        Self::resource_exists_with_conn(&conn, resource_id)
    }

    /// 检查资源是否存在（使用现有连接）
    pub fn resource_exists_with_conn(conn: &Connection, resource_id: &str) -> ChatV2Result<bool> {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM resources WHERE id = ?1",
            params![resource_id],
            |row| row.get(0),
        )?;

        Ok(count > 0)
    }

    /// 通过 hash 查找资源
    pub fn find_by_hash(db: &ChatV2Database, hash: &str) -> ChatV2Result<Option<Resource>> {
        let conn = db.get_conn_safe()?;
        Self::find_by_hash_with_conn(&conn, hash)
    }

    /// 通过 hash 查找资源（使用现有连接）
    pub fn find_by_hash_with_conn(conn: &Connection, hash: &str) -> ChatV2Result<Option<Resource>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, hash, type, source_id, data, metadata_json, ref_count, created_at
            FROM resources
            WHERE hash = ?1
            "#,
        )?;

        let resource = stmt
            .query_row(params![hash], Self::row_to_resource)
            .optional()?;

        Ok(resource)
    }

    // ========================================================================
    // 引用计数管理
    // ========================================================================

    /// 增加引用计数（消息保存时调用）
    pub fn increment_ref(db: &ChatV2Database, resource_id: &str) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::increment_ref_with_conn(&conn, resource_id)
    }

    /// 增加引用计数（使用现有连接）
    pub fn increment_ref_with_conn(conn: &Connection, resource_id: &str) -> ChatV2Result<()> {
        let rows_affected = conn.execute(
            "UPDATE resources SET ref_count = ref_count + 1 WHERE id = ?1",
            params![resource_id],
        )?;

        if rows_affected == 0 {
            warn!(
                "[ResourceRepo] Resource not found for increment_ref: {}",
                resource_id
            );
            return Err(ChatV2Error::ResourceNotFound(resource_id.to_string()));
        }

        debug!("[ResourceRepo] Incremented ref_count for: {}", resource_id);
        Ok(())
    }

    /// 减少引用计数（消息删除时调用）
    pub fn decrement_ref(db: &ChatV2Database, resource_id: &str) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::decrement_ref_with_conn(&conn, resource_id)
    }

    /// 减少引用计数（使用现有连接）
    pub fn decrement_ref_with_conn(conn: &Connection, resource_id: &str) -> ChatV2Result<()> {
        let rows_affected = conn.execute(
            "UPDATE resources SET ref_count = ref_count - 1 WHERE id = ?1 AND ref_count > 0",
            params![resource_id],
        )?;

        if rows_affected == 0 {
            warn!(
                "[ResourceRepo] Resource not found or ref_count already 0: {}",
                resource_id
            );
            // 不返回错误，幂等处理
        }

        debug!("[ResourceRepo] Decremented ref_count for: {}", resource_id);
        Ok(())
    }

    /// 批量增加引用计数
    pub fn increment_refs(db: &ChatV2Database, resource_ids: &[String]) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::increment_refs_with_conn(&conn, resource_ids)
    }

    /// 批量增加引用计数（使用现有连接）
    ///
    /// 🔧 P1 修复：原实现循环单条 UPDATE 且无事务，中途失败会留下「部分 +1」。
    /// 现用 SAVEPOINT 包裹（可嵌套在外层事务中），失败整体回滚；
    /// 并复用同一条预编译语句，避免逐条重新解析 SQL。
    /// 保留逐 id 语义：同一 id 出现 N 次即 +N（与调用方引用次数一致）。
    pub fn increment_refs_with_conn(
        conn: &Connection,
        resource_ids: &[String],
    ) -> ChatV2Result<()> {
        if resource_ids.is_empty() {
            return Ok(());
        }
        Self::with_savepoint(conn, "resource_incr_refs", |conn| {
            let mut stmt =
                conn.prepare("UPDATE resources SET ref_count = ref_count + 1 WHERE id = ?1")?;
            for resource_id in resource_ids {
                let rows_affected = stmt.execute(params![resource_id])?;
                if rows_affected == 0 {
                    warn!(
                        "[ResourceRepo] Resource not found for increment_ref: {}",
                        resource_id
                    );
                    return Err(ChatV2Error::ResourceNotFound(resource_id.to_string()));
                }
            }
            Ok(())
        })
    }

    /// 批量减少引用计数
    pub fn decrement_refs(db: &ChatV2Database, resource_ids: &[String]) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::decrement_refs_with_conn(&conn, resource_ids)
    }

    /// 批量减少引用计数（使用现有连接）
    ///
    /// 🔧 P1 修复：SAVEPOINT 保证原子性（单条失败整体回滚，不留部分 -1）。
    /// 单条语义与 decrement_ref 一致：不存在或已为 0 时幂等跳过。
    pub fn decrement_refs_with_conn(
        conn: &Connection,
        resource_ids: &[String],
    ) -> ChatV2Result<()> {
        if resource_ids.is_empty() {
            return Ok(());
        }
        Self::with_savepoint(conn, "resource_decr_refs", |conn| {
            let mut stmt = conn.prepare(
                "UPDATE resources SET ref_count = ref_count - 1 WHERE id = ?1 AND ref_count > 0",
            )?;
            for resource_id in resource_ids {
                let rows_affected = stmt.execute(params![resource_id])?;
                if rows_affected == 0 {
                    warn!(
                        "[ResourceRepo] Resource not found or ref_count already 0: {}",
                        resource_id
                    );
                    // 与 decrement_ref 一致：幂等处理，不报错
                }
            }
            Ok(())
        })
    }

    /// SAVEPOINT 包裹执行：可安全嵌套于外层事务；失败时回滚到保存点。
    fn with_savepoint<T>(
        conn: &Connection,
        name: &str,
        f: impl FnOnce(&Connection) -> ChatV2Result<T>,
    ) -> ChatV2Result<T> {
        conn.execute_batch(&format!("SAVEPOINT {}", name))?;
        match f(conn) {
            Ok(value) => {
                conn.execute_batch(&format!("RELEASE SAVEPOINT {}", name))?;
                Ok(value)
            }
            Err(e) => {
                let _ = conn.execute_batch(&format!(
                    "ROLLBACK TO SAVEPOINT {0}; RELEASE SAVEPOINT {0}",
                    name
                ));
                Err(e)
            }
        }
    }

    // ========================================================================
    // 版本和来源查询
    // ========================================================================

    /// 获取某原始数据的所有版本
    pub fn get_versions_by_source(
        db: &ChatV2Database,
        source_id: &str,
    ) -> ChatV2Result<Vec<Resource>> {
        let conn = db.get_conn_safe()?;
        Self::get_versions_by_source_with_conn(&conn, source_id)
    }

    /// 获取某原始数据的所有版本（使用现有连接）
    pub fn get_versions_by_source_with_conn(
        conn: &Connection,
        source_id: &str,
    ) -> ChatV2Result<Vec<Resource>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, hash, type, source_id, data, metadata_json, ref_count, created_at
            FROM resources
            WHERE source_id = ?1
            ORDER BY created_at DESC
            "#,
        )?;

        let rows = stmt.query_map(params![source_id], Self::row_to_resource)?;
        let resources: Vec<Resource> = rows.filter_map(log_and_skip_err).collect();

        Ok(resources)
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    /// 生成资源 ID
    fn generate_id() -> String {
        format!("res_{}", nanoid::nanoid!(10))
    }

    /// 计算内容哈希（SHA-256）
    pub fn calculate_hash(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        let result = hasher.finalize();
        hex::encode(result)
    }

    /// 从数据库行转换为 Resource
    ///
    /// 列顺序（与 V20260130 init 的 resources 表对齐）：
    /// id, hash, type, source_id, data, metadata_json, ref_count, created_at
    fn row_to_resource(row: &rusqlite::Row) -> rusqlite::Result<Resource> {
        let id: String = row.get(0)?;
        let hash: String = row.get(1)?;
        let type_str: String = row.get(2)?;
        let source_id: Option<String> = row.get(3)?;
        // data 字段是 TEXT 类型，直接读取为 String
        let data: Option<String> = row.get(4)?;
        let metadata_json: Option<String> = row.get(5)?;
        let ref_count: i32 = row.get(6)?;
        let created_at: i64 = row.get(7)?;

        let resource_type = ResourceType::from_str(&type_str).unwrap_or(ResourceType::File);

        // 解析 metadata JSON 为 ResourceMetadata
        let metadata: Option<ResourceMetadata> = metadata_json
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok());

        Ok(Resource {
            id,
            hash,
            resource_type,
            source_id,
            data: data.unwrap_or_default(), // Resource.data 是 String，不是 Option
            metadata,
            ref_count,
            created_at,
        })
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// 创建测试数据库（已应用全部 chat_v2 迁移，含 resources 表）
    fn setup_test_db() -> (TempDir, ChatV2Database) {
        use crate::data_governance::migration::coordinator::MigrationCoordinator;
        use crate::data_governance::schema_registry::DatabaseId;

        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let mut coordinator =
            MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("ChatV2 migrations should apply cleanly");
        let db = ChatV2Database::new(temp_dir.path()).expect("Failed to create database");
        (temp_dir, db)
    }

    #[test]
    fn test_create_or_reuse_new_resource() {
        let (_temp_dir, db) = setup_test_db();

        let params = CreateResourceParams {
            resource_type: ResourceType::Note,
            data: "Test note content".to_string(),
            source_id: Some("note_123".to_string()),
            metadata: Some(ResourceMetadata {
                title: Some("Test Note".to_string()),
                ..Default::default()
            }),
        };

        let result = ResourceRepo::create_or_reuse(&db, params).expect("Failed to create resource");

        assert!(result.resource_id.starts_with("res_"));
        assert!(!result.hash.is_empty());
        assert!(result.is_new);
    }

    #[test]
    fn test_create_or_reuse_dedup() {
        let (_temp_dir, db) = setup_test_db();

        let data = "Same content".to_string();

        // 第一次创建
        let params1 = CreateResourceParams {
            resource_type: ResourceType::File,
            data: data.clone(),
            source_id: None,
            metadata: None,
        };
        let result1 =
            ResourceRepo::create_or_reuse(&db, params1).expect("Failed to create resource 1");
        assert!(result1.is_new);

        // 第二次创建相同内容
        let params2 = CreateResourceParams {
            resource_type: ResourceType::File,
            data,
            source_id: None,
            metadata: None,
        };
        let result2 =
            ResourceRepo::create_or_reuse(&db, params2).expect("Failed to create resource 2");

        // 应该返回已有资源
        assert!(!result2.is_new);
        assert_eq!(result1.resource_id, result2.resource_id);
        assert_eq!(result1.hash, result2.hash);
    }

    #[test]
    fn test_get_resource() {
        let (_temp_dir, db) = setup_test_db();

        let params = CreateResourceParams {
            resource_type: ResourceType::Image,
            data: "image data".to_string(),
            source_id: None,
            metadata: None,
        };
        let created =
            ResourceRepo::create_or_reuse(&db, params).expect("Failed to create resource");

        // 获取资源
        let resource = ResourceRepo::get_resource(&db, &created.resource_id, &created.hash)
            .expect("Failed to get resource")
            .expect("Resource not found");

        assert_eq!(resource.id, created.resource_id);
        assert_eq!(resource.hash, created.hash);
        assert_eq!(resource.resource_type, ResourceType::Image);
        assert_eq!(resource.ref_count, 0);
    }

    #[test]
    fn test_increment_decrement_ref() {
        let (_temp_dir, db) = setup_test_db();

        let params = CreateResourceParams {
            resource_type: ResourceType::Note,
            data: "test".to_string(),
            source_id: None,
            metadata: None,
        };
        let created =
            ResourceRepo::create_or_reuse(&db, params).expect("Failed to create resource");

        // 初始 ref_count = 0
        let resource = ResourceRepo::get_resource(&db, &created.resource_id, &created.hash)
            .expect("Failed to get resource")
            .expect("Resource not found");
        assert_eq!(resource.ref_count, 0);

        // 增加引用计数
        ResourceRepo::increment_ref(&db, &created.resource_id).expect("Failed to increment ref");
        let resource = ResourceRepo::get_resource(&db, &created.resource_id, &created.hash)
            .expect("Failed to get resource")
            .expect("Resource not found");
        assert_eq!(resource.ref_count, 1);

        // 再次增加
        ResourceRepo::increment_ref(&db, &created.resource_id).expect("Failed to increment ref");
        let resource = ResourceRepo::get_resource(&db, &created.resource_id, &created.hash)
            .expect("Failed to get resource")
            .expect("Resource not found");
        assert_eq!(resource.ref_count, 2);

        // 减少引用计数
        ResourceRepo::decrement_ref(&db, &created.resource_id).expect("Failed to decrement ref");
        let resource = ResourceRepo::get_resource(&db, &created.resource_id, &created.hash)
            .expect("Failed to get resource")
            .expect("Resource not found");
        assert_eq!(resource.ref_count, 1);
    }

    #[test]
    fn test_get_versions_by_source() {
        let (_temp_dir, db) = setup_test_db();

        let source_id = "note_456";

        // 创建多个版本（不同内容）
        for i in 0..3 {
            let params = CreateResourceParams {
                resource_type: ResourceType::Note,
                data: format!("Version {}", i),
                source_id: Some(source_id.to_string()),
                metadata: None,
            };
            ResourceRepo::create_or_reuse(&db, params).expect("Failed to create resource");
        }

        // 获取所有版本
        let versions =
            ResourceRepo::get_versions_by_source(&db, source_id).expect("Failed to get versions");

        assert_eq!(versions.len(), 3);
        for version in &versions {
            assert_eq!(version.source_id, Some(source_id.to_string()));
        }
    }

    #[test]
    fn test_get_latest_resource() {
        let (_temp_dir, db) = setup_test_db();

        // 创建资源
        let params = CreateResourceParams {
            resource_type: ResourceType::Card,
            data: "card content".to_string(),
            source_id: Some("card_789".to_string()),
            metadata: None,
        };
        let created =
            ResourceRepo::create_or_reuse(&db, params).expect("Failed to create resource");

        // 获取最新版本
        let latest = ResourceRepo::get_latest_resource(&db, &created.resource_id)
            .expect("Failed to get latest")
            .expect("Latest not found");

        assert_eq!(latest.id, created.resource_id);
        assert_eq!(latest.hash, created.hash);
    }

    #[test]
    fn test_resource_exists() {
        let (_temp_dir, db) = setup_test_db();

        // 不存在
        let exists =
            ResourceRepo::resource_exists(&db, "res_nonexistent").expect("Failed to check exists");
        assert!(!exists);

        // 创建资源
        let params = CreateResourceParams {
            resource_type: ResourceType::File,
            data: "test".to_string(),
            source_id: None,
            metadata: None,
        };
        let created =
            ResourceRepo::create_or_reuse(&db, params).expect("Failed to create resource");

        // 存在
        let exists = ResourceRepo::resource_exists(&db, &created.resource_id)
            .expect("Failed to check exists");
        assert!(exists);
    }

    #[test]
    fn test_find_by_hash() {
        let (_temp_dir, db) = setup_test_db();

        let data = "unique content for hash test".to_string();
        let expected_hash = ResourceRepo::calculate_hash(data.as_bytes());

        // 创建资源
        let params = CreateResourceParams {
            resource_type: ResourceType::Retrieval,
            data,
            source_id: None,
            metadata: None,
        };
        let created =
            ResourceRepo::create_or_reuse(&db, params).expect("Failed to create resource");
        assert_eq!(created.hash, expected_hash);

        // 通过 hash 查找
        let found = ResourceRepo::find_by_hash(&db, &expected_hash)
            .expect("Failed to find by hash")
            .expect("Resource not found");

        assert_eq!(found.id, created.resource_id);
        assert_eq!(found.hash, expected_hash);
    }

    #[test]
    fn test_increment_refs_atomic_rollback() {
        let (_temp_dir, db) = setup_test_db();

        let params = CreateResourceParams {
            resource_type: ResourceType::Note,
            data: "batch ref test".to_string(),
            source_id: None,
            metadata: None,
        };
        let created =
            ResourceRepo::create_or_reuse(&db, params).expect("Failed to create resource");

        // 批量中含不存在的 id：应整体失败，且已存在资源的 ref_count 不残留 +1
        let ids = vec![created.resource_id.clone(), "res_missing".to_string()];
        let result = ResourceRepo::increment_refs(&db, &ids);
        assert!(result.is_err(), "missing resource should fail the batch");

        let resource = ResourceRepo::get_resource(&db, &created.resource_id, &created.hash)
            .expect("Failed to get resource")
            .expect("Resource not found");
        assert_eq!(
            resource.ref_count, 0,
            "partial increment must be rolled back"
        );

        // 全部存在时正常生效
        ResourceRepo::increment_refs(&db, &[created.resource_id.clone()])
            .expect("Failed to increment refs");
        let resource = ResourceRepo::get_resource(&db, &created.resource_id, &created.hash)
            .expect("Failed to get resource")
            .expect("Resource not found");
        assert_eq!(resource.ref_count, 1);
    }

    #[test]
    fn test_create_or_reuse_conflict_insert_reuses_existing() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().expect("conn");

        // 模拟并发竞态：另一连接已插入同 hash 的资源（绕过快路径检查）
        let data = "raced content".to_string();
        let hash = ResourceRepo::calculate_hash(data.as_bytes());
        conn.execute(
            "INSERT INTO resources (id, hash, type, source_id, data, metadata_json, ref_count, created_at, updated_at)
             VALUES ('res_winner', ?1, 'note', NULL, ?2, NULL, 0, 1, '1')",
            params![hash, data],
        )
        .expect("seed winner row");

        // ON CONFLICT DO NOTHING 路径：直接执行 upsert SQL 验证不报错且不覆盖
        let inserted = conn
            .execute(
                r#"
                INSERT INTO resources (id, hash, type, source_id, data, metadata_json, ref_count, created_at, updated_at)
                VALUES ('res_loser', ?1, 'note', NULL, ?2, NULL, 0, 2, '2')
                ON CONFLICT(hash) DO NOTHING
                "#,
                params![hash, data],
            )
            .expect("conflicting insert must not error");
        assert_eq!(inserted, 0, "conflicting insert should be a no-op");

        // create_or_reuse 复用已有行
        let result = ResourceRepo::create_or_reuse_with_conn(
            &conn,
            CreateResourceParams {
                resource_type: ResourceType::Note,
                data,
                source_id: None,
                metadata: None,
            },
        )
        .expect("create_or_reuse should reuse existing");
        assert!(!result.is_new);
        assert_eq!(result.resource_id, "res_winner");
    }

    #[test]
    fn test_calculate_hash_consistency() {
        let data = b"test data for hashing";
        let hash1 = ResourceRepo::calculate_hash(data);
        let hash2 = ResourceRepo::calculate_hash(data);

        // 相同内容应该得到相同的哈希
        assert_eq!(hash1, hash2);

        // 不同内容应该得到不同的哈希
        let hash3 = ResourceRepo::calculate_hash(b"different data");
        assert_ne!(hash1, hash3);
    }
}
