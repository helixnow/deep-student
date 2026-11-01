//! VFS 资源表 CRUD 操作
//!
//! 资源表是 VFS 的核心，`data` 字段是内容的 SSOT。
//! 基于 SHA-256 哈希实现全局去重。
//!
//! ## 核心方法
//! - `create_or_reuse`: 创建或复用资源（基于 hash 去重）
//! - `get_resource`: 获取资源
//! - `increment_ref` / `decrement_ref`: 引用计数管理

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use tracing::{debug, info, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::types::{
    StorageMode, VfsCreateResourceResult, VfsResource, VfsResourceMetadata, VfsResourceType,
};

/// Log row-parse errors instead of silently discarding them.
fn log_and_skip_err<T>(result: Result<T, rusqlite::Error>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("[VFS::ResourceRepo] Row parse error (skipped): {}", e);
            None
        }
    }
}

/// VFS 资源表 Repo
pub struct VfsResourceRepo;

impl VfsResourceRepo {
    // ========================================================================
    // 创建/复用资源
    // ========================================================================

    /// 创建或复用资源（基于 hash 去重）
    ///
    /// ## 去重逻辑
    /// 1. 计算内容的 SHA-256 哈希
    /// 2. 查询是否存在相同 hash 的资源
    /// 3. 存在则复用，不存在则创建
    ///
    /// ## 参数
    /// - `resource_type`: 资源类型
    /// - `data`: 资源内容（文本或 base64）
    /// - `source_id`: 原始数据 ID（可选）
    /// - `source_table`: 原始表名（可选）
    /// - `metadata`: 元数据（可选）
    ///
    pub fn create_or_reuse(
        db: &VfsDatabase,
        resource_type: VfsResourceType,
        data: &str,
        source_id: Option<&str>,
        source_table: Option<&str>,
        metadata: Option<&VfsResourceMetadata>,
    ) -> VfsResult<VfsCreateResourceResult> {
        let conn = db.get_conn_safe()?;
        Self::create_or_reuse_with_conn(
            &conn,
            resource_type,
            data,
            source_id,
            source_table,
            metadata,
        )
    }

    /// 创建或复用资源（使用现有连接）
    ///
    /// ## 并发安全设计
    ///
    /// 该方法通过数据库的 UNIQUE 约束和 INSERT OR IGNORE 语法实现并发安全：
    ///
    /// 1. **问题场景**：
    ///    - 线程 A 和 B 同时检查 hash 不存在
    ///    - 两者都尝试创建新资源
    ///    - 违反 UNIQUE(hash) 约束，导致错误
    ///
    /// 2. **修复方案**：
    ///    - 使用 `INSERT OR IGNORE` 尝试插入
    ///    - 如果 hash 已存在，插入被忽略（affected_rows = 0）
    ///    - 再次查询获取现有资源
    ///    - 整个操作依赖数据库的 UNIQUE 约束保证原子性
    ///
    /// 3. **关键点**：
    ///    - `hash TEXT NOT NULL UNIQUE` 约束确保同一 hash 只能存在一份
    ///    - `INSERT OR IGNORE` 在冲突时不会抛出错误
    ///    - 即使多线程并发插入相同 hash，也只有一个会成功
    ///
    pub fn create_or_reuse_with_conn(
        conn: &Connection,
        resource_type: VfsResourceType,
        data: &str,
        source_id: Option<&str>,
        source_table: Option<&str>,
        metadata: Option<&VfsResourceMetadata>,
    ) -> VfsResult<VfsCreateResourceResult> {
        let hash = Self::compute_hash(data);
        Self::create_or_reuse_with_conn_and_hash(
            conn,
            resource_type,
            data,
            &hash,
            source_id,
            source_table,
            metadata,
        )
    }

    /// 创建或复用资源（使用指定 hash）
    ///
    /// 用于需要自定义 hash 策略的资源（如笔记使用 note_id 作为盐值）。
    pub fn create_or_reuse_with_conn_and_hash(
        conn: &Connection,
        resource_type: VfsResourceType,
        data: &str,
        hash: &str,
        source_id: Option<&str>,
        source_table: Option<&str>,
        metadata: Option<&VfsResourceMetadata>,
    ) -> VfsResult<VfsCreateResourceResult> {
        // 1. 使用指定 hash
        debug!("[VFS::ResourceRepo] Content hash: {}", hash);

        // 2. 准备资源数据
        let resource_id = VfsResource::generate_id();
        let now = chrono::Utc::now().timestamp_millis();
        let type_str = resource_type.to_string();
        let metadata_json = metadata
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| VfsError::Serialization(e.to_string()))?;

        // 3. 使用 INSERT OR IGNORE 尝试插入（处理并发竞态条件）
        //
        // 如果 hash 已存在（由其他线程创建），插入会被忽略，不会报错
        let affected_rows = conn.execute(
            r#"
            INSERT OR IGNORE INTO resources (id, hash, type, source_id, source_table, storage_mode, data, metadata_json, ref_count, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10)
            "#,
            params![
                resource_id,
                hash,
                type_str,
                source_id,
                source_table,
                "inline",
                data,
                metadata_json,
                now,
                now,
            ],
        )?;

        // 4. 判断是新建还是复用
        if affected_rows > 0 {
            // 插入成功，说明是新资源
            info!(
                "[VFS::ResourceRepo] Created new resource: {} (type: {})",
                resource_id, type_str
            );

            Ok(VfsCreateResourceResult {
                resource_id,
                hash: hash.to_string(),
                is_new: true,
            })
        } else {
            // 插入被忽略，说明 hash 已存在（可能由其他线程创建）
            // 查询现有资源并返回
            debug!(
                "[VFS::ResourceRepo] Hash collision detected, querying existing resource for hash: {}",
                hash
            );

            let existing =
                Self::get_by_hash_with_conn(conn, hash)?.ok_or_else(|| VfsError::NotFound {
                    resource_type: "Resource".to_string(),
                    id: format!(
                        "hash={} (race condition edge case: should exist but not found)",
                        hash
                    ),
                })?;

            debug!(
                "[VFS::ResourceRepo] Reusing existing resource: {}",
                existing.id
            );

            Ok(VfsCreateResourceResult {
                resource_id: existing.id,
                hash: hash.to_string(),
                is_new: false,
            })
        }
    }

    // ========================================================================
    // 创建/复用外部资源（external 模式）
    // ========================================================================

    /// 创建或复用外部资源（基于 hash 去重）
    ///
    /// ## 说明
    /// - external 模式资源不存 data，内容由 external_hash 指向 blobs
    /// - hash 使用内容哈希（如附件 content_hash）
    pub fn create_or_reuse_external(
        db: &VfsDatabase,
        resource_type: VfsResourceType,
        content_hash: &str,
        external_hash: &str,
        source_id: Option<&str>,
        source_table: Option<&str>,
        metadata: Option<&VfsResourceMetadata>,
    ) -> VfsResult<VfsCreateResourceResult> {
        let conn = db.get_conn_safe()?;
        Self::create_or_reuse_external_with_conn(
            &conn,
            resource_type,
            content_hash,
            external_hash,
            source_id,
            source_table,
            metadata,
        )
    }

    pub fn create_or_reuse_external_with_conn(
        conn: &Connection,
        resource_type: VfsResourceType,
        content_hash: &str,
        external_hash: &str,
        source_id: Option<&str>,
        source_table: Option<&str>,
        metadata: Option<&VfsResourceMetadata>,
    ) -> VfsResult<VfsCreateResourceResult> {
        let resource_id = VfsResource::generate_id();
        let now = chrono::Utc::now().timestamp_millis();
        let type_str = resource_type.to_string();
        let metadata_json = metadata
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| VfsError::Serialization(e.to_string()))?;

        let affected_rows = conn.execute(
            r#"
            INSERT OR IGNORE INTO resources (
                id, hash, type, source_id, source_table, storage_mode, data, external_hash, metadata_json, ref_count, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, 'external', NULL, ?6, ?7, 0, ?8, ?9)
            "#,
            params![
                resource_id,
                content_hash,
                type_str,
                source_id,
                source_table,
                external_hash,
                metadata_json,
                now,
                now,
            ],
        )?;

        if affected_rows > 0 {
            info!(
                "[VFS::ResourceRepo] Created external resource: {} (type: {})",
                resource_id, type_str
            );

            Ok(VfsCreateResourceResult {
                resource_id,
                hash: content_hash.to_string(),
                is_new: true,
            })
        } else {
            let existing = Self::get_by_hash_with_conn(conn, content_hash)?.ok_or_else(|| {
                VfsError::NotFound {
                    resource_type: "Resource".to_string(),
                    id: format!(
                        "hash={} (race condition edge case: should exist but not found)",
                        content_hash
                    ),
                }
            })?;

            debug!(
                "[VFS::ResourceRepo] Reusing existing external resource: {}",
                existing.id
            );

            Ok(VfsCreateResourceResult {
                resource_id: existing.id,
                hash: content_hash.to_string(),
                is_new: false,
            })
        }
    }

    // ========================================================================
    // 查询资源
    // ========================================================================

    /// 根据 ID 获取资源
    pub fn get_resource(db: &VfsDatabase, resource_id: &str) -> VfsResult<Option<VfsResource>> {
        let conn = db.get_conn_safe()?;
        Self::get_resource_with_conn(&conn, resource_id)
    }

    /// 根据 ID 获取资源（使用现有连接）
    pub fn get_resource_with_conn(
        conn: &Connection,
        resource_id: &str,
    ) -> VfsResult<Option<VfsResource>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, hash, type, source_id, source_table, storage_mode, data, external_hash, metadata_json, ref_count, created_at, updated_at
            FROM resources
            WHERE id = ?1
            "#,
        )?;

        let resource = stmt
            .query_row(params![resource_id], Self::row_to_resource)
            .optional()?;

        Ok(resource)
    }

    /// 根据 hash 获取资源
    pub fn get_by_hash(db: &VfsDatabase, hash: &str) -> VfsResult<Option<VfsResource>> {
        let conn = db.get_conn_safe()?;
        Self::get_by_hash_with_conn(&conn, hash)
    }

    /// 根据 hash 获取资源（使用现有连接）
    pub fn get_by_hash_with_conn(conn: &Connection, hash: &str) -> VfsResult<Option<VfsResource>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, hash, type, source_id, source_table, storage_mode, data, external_hash, metadata_json, ref_count, created_at, updated_at
            FROM resources
            WHERE hash = ?1
            "#,
        )?;

        let resource = stmt
            .query_row(params![hash], Self::row_to_resource)
            .optional()?;

        Ok(resource)
    }

    /// 检查资源是否存在
    pub fn exists(db: &VfsDatabase, resource_id: &str) -> VfsResult<bool> {
        let conn = db.get_conn_safe()?;
        Self::exists_with_conn(&conn, resource_id)
    }

    /// 检查资源是否存在（使用现有连接）
    pub fn exists_with_conn(conn: &Connection, resource_id: &str) -> VfsResult<bool> {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM resources WHERE id = ?1",
            params![resource_id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    // ========================================================================
    // 引用计数管理
    // ========================================================================

    /// 增加引用计数
    pub fn increment_ref(db: &VfsDatabase, resource_id: &str) -> VfsResult<i32> {
        let conn = db.get_conn_safe()?;
        Self::increment_ref_with_conn(&conn, resource_id)
    }

    /// 增加引用计数（使用现有连接）
    pub fn increment_ref_with_conn(conn: &Connection, resource_id: &str) -> VfsResult<i32> {
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE resources SET ref_count = ref_count + 1, updated_at = ?2 WHERE id = ?1",
            params![resource_id, now],
        )?;

        let new_count: i32 = conn.query_row(
            "SELECT ref_count FROM resources WHERE id = ?1",
            params![resource_id],
            |row| row.get(0),
        )?;

        debug!(
            "[VFS::ResourceRepo] Incremented ref_count for {}: {}",
            resource_id, new_count
        );

        Ok(new_count)
    }

    /// 减少引用计数
    pub fn decrement_ref(db: &VfsDatabase, resource_id: &str) -> VfsResult<i32> {
        let conn = db.get_conn_safe()?;
        Self::decrement_ref_with_conn(&conn, resource_id)
    }

    /// 减少引用计数（使用现有连接）
    pub fn decrement_ref_with_conn(conn: &Connection, resource_id: &str) -> VfsResult<i32> {
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE resources SET ref_count = MAX(0, ref_count - 1), updated_at = ?2 WHERE id = ?1",
            params![resource_id, now],
        )?;

        let new_count: i32 = conn.query_row(
            "SELECT ref_count FROM resources WHERE id = ?1",
            params![resource_id],
            |row| row.get(0),
        )?;

        debug!(
            "[VFS::ResourceRepo] Decremented ref_count for {}: {}",
            resource_id, new_count
        );

        Ok(new_count)
    }

    /// 批量减少引用计数
    pub fn decrement_refs(db: &VfsDatabase, resource_ids: &[String]) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::decrement_refs_with_conn(&conn, resource_ids)
    }

    /// 批量减少引用计数（使用现有连接）
    pub fn decrement_refs_with_conn(conn: &Connection, resource_ids: &[String]) -> VfsResult<()> {
        for resource_id in resource_ids {
            // 忽略单个资源的错误，继续处理其他资源
            if let Err(e) = Self::decrement_ref_with_conn(conn, resource_id) {
                log::warn!(
                    "[VFS::ResourceRepo] Failed to decrement ref for {}: {}",
                    resource_id,
                    e
                );
            }
        }
        Ok(())
    }

    // ========================================================================
    // 未引用资源清扫
    // ========================================================================

    /// 清扫长期无引用的检索资源（retrieval）
    ///
    /// ## 背景
    /// 检索资源（RAG/记忆/网页来源）由聊天 pipeline 创建（ref_count=0），
    /// 消息保存后 +1，消息/会话删除后 -1。归零后资源行没有其他持有者，
    /// 但 `resources` 表没有任何针对 retrieval 的删除路径，会无限累积。
    ///
    /// ## 宽限期
    /// "创建 → 消息保存 increment" 之间存在 ref_count=0 的窗口，
    /// 因此只清理 `updated_at` 早于 `grace_period_ms` 的行（increment/decrement
    /// 都会刷新 updated_at，活跃资源不会被误删）。
    ///
    /// ## 级联
    /// 同步删除可能存在的 `vfs_index_units`（segments 经 FK CASCADE 删除）。
    /// resources 表的 DELETE 触发器会自动写入 change_log 墓碑，云同步可正常传播。
    ///
    /// ## 返回
    /// 被清理的资源数量
    pub fn cleanup_unreferenced_retrievals(
        conn: &Connection,
        grace_period_ms: i64,
    ) -> VfsResult<u32> {
        let cutoff = chrono::Utc::now().timestamp_millis() - grace_period_ms;

        // 先删孤儿索引单元（retrieval 正常不进索引，此处为防御性清理）
        // ★ 2026-06-12（第二轮审阅）：Lance 向量先入列孤儿队列再删 units
        conn.execute(
            r#"
            INSERT INTO __lance_orphan_queue (lance_row_id, resource_id)
            SELECT s.lance_row_id, u.resource_id
            FROM vfs_index_segments s
            JOIN vfs_index_units u ON s.unit_id = u.id
            WHERE u.resource_id IN (
                SELECT id FROM resources
                WHERE type = 'retrieval' AND ref_count = 0 AND updated_at < ?1
            )
            ON CONFLICT(lance_row_id) DO UPDATE SET
                resource_id = excluded.resource_id,
                enqueued_at = excluded.enqueued_at,
                next_retry_at = 0,
                last_error = NULL
            "#,
            params![cutoff],
        )?;
        conn.execute(
            r#"
            DELETE FROM vfs_index_units
            WHERE resource_id IN (
                SELECT id FROM resources
                WHERE type = 'retrieval' AND ref_count = 0 AND updated_at < ?1
            )
            "#,
            params![cutoff],
        )?;

        let deleted = conn.execute(
            "DELETE FROM resources WHERE type = 'retrieval' AND ref_count = 0 AND updated_at < ?1",
            params![cutoff],
        )?;

        if deleted > 0 {
            info!(
                "[VFS::ResourceRepo] Swept {} unreferenced retrieval resources",
                deleted
            );
        }

        Ok(deleted as u32)
    }

    /// 清扫孤儿笔记/导图资源（历史泄漏数据）
    ///
    /// ## 背景（审阅问题 S5）
    /// 修复前的实现中：
    /// - 笔记每次内容编辑都会创建新资源并切换指针，旧资源无人回收；
    /// - 导图 purge 只递减主资源计数，资源行从不删除。
    ///
    /// 本清扫器在启动时回收这些历史遗留的孤儿行（修复后的代码路径已即时清理）。
    ///
    /// ## 安全条件
    /// - note 资源：无任何 notes 行引用；
    /// - mindmap 资源：无任何 mindmaps / mindmap_versions 行引用；
    /// - 均要求 `updated_at` 早于宽限期（避开"先建资源后建记录"的创建窗口）。
    pub fn cleanup_orphan_note_mindmap_resources(
        conn: &Connection,
        grace_period_ms: i64,
    ) -> VfsResult<u32> {
        let cutoff = chrono::Utc::now().timestamp_millis() - grace_period_ms;

        let note_filter = r#"
            type = 'note'
            AND updated_at < ?1
            AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.resource_id = resources.id)
        "#;
        let mindmap_filter = r#"
            type = 'mindmap'
            AND updated_at < ?1
            AND NOT EXISTS (SELECT 1 FROM mindmaps m WHERE m.resource_id = resources.id)
            AND NOT EXISTS (SELECT 1 FROM mindmap_versions mv WHERE mv.resource_id = resources.id)
        "#;

        let mut total = 0u32;
        for filter in [note_filter, mindmap_filter] {
            // ★ 2026-06-12（第二轮审阅）：Lance 向量先入列孤儿队列再删 units
            conn.execute(
                &format!(
                    r#"INSERT INTO __lance_orphan_queue (lance_row_id, resource_id)
                       SELECT s.lance_row_id, u.resource_id
                       FROM vfs_index_segments s
                       JOIN vfs_index_units u ON s.unit_id = u.id
                       WHERE u.resource_id IN (SELECT id FROM resources WHERE {})
                       ON CONFLICT(lance_row_id) DO UPDATE SET
                           resource_id = excluded.resource_id,
                           enqueued_at = excluded.enqueued_at,
                           next_retry_at = 0,
                           last_error = NULL"#,
                    filter
                ),
                params![cutoff],
            )?;
            conn.execute(
                &format!(
                    "DELETE FROM vfs_index_units WHERE resource_id IN (SELECT id FROM resources WHERE {})",
                    filter
                ),
                params![cutoff],
            )?;
            let deleted = conn.execute(
                &format!("DELETE FROM resources WHERE {}", filter),
                params![cutoff],
            )?;
            total += deleted as u32;
        }

        if total > 0 {
            info!(
                "[VFS::ResourceRepo] Swept {} orphan note/mindmap resources",
                total
            );
        }

        Ok(total)
    }

    // ========================================================================
    // 按原始 ID 查询
    // ========================================================================

    /// 根据 source_id 获取资源
    pub fn get_by_source_id(db: &VfsDatabase, source_id: &str) -> VfsResult<Option<VfsResource>> {
        let conn = db.get_conn_safe()?;
        Self::get_by_source_id_with_conn(&conn, source_id)
    }

    /// 根据 source_id 获取资源（使用现有连接）
    pub fn get_by_source_id_with_conn(
        conn: &Connection,
        source_id: &str,
    ) -> VfsResult<Option<VfsResource>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, hash, type, source_id, source_table, storage_mode, data, external_hash, metadata_json, ref_count, created_at, updated_at
            FROM resources
            WHERE source_id = ?1
            ORDER BY created_at DESC
            LIMIT 1
            "#,
        )?;

        let resource = stmt
            .query_row(params![source_id], Self::row_to_resource)
            .optional()?;

        Ok(resource)
    }

    // ========================================================================
    // 列表查询
    // ========================================================================

    /// 按类型列出资源
    ///
    /// ## 参数
    /// - `resource_type`: 类型过滤（可选）
    /// - `limit`: 数量限制
    /// - `offset`: 偏移量
    ///
    pub fn list_by_type(
        db: &VfsDatabase,
        resource_type: Option<VfsResourceType>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsResource>> {
        let conn = db.get_conn_safe()?;
        Self::list_by_type_with_conn(&conn, resource_type, limit, offset)
    }

    /// 按类型列出资源（使用现有连接）
    pub fn list_by_type_with_conn(
        conn: &Connection,
        resource_type: Option<VfsResourceType>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsResource>> {
        let mut sql = String::from(
            r#"
            SELECT id, hash, type, source_id, source_table, storage_mode, data, external_hash, metadata_json, ref_count, created_at, updated_at
            FROM resources
            WHERE 1=1
            "#,
        );

        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        let mut param_idx = 1;

        // 类型过滤
        if let Some(t) = resource_type {
            sql.push_str(&format!(" AND type = ?{}", param_idx));
            params_vec.push(Box::new(t.to_string()));
            param_idx += 1;
        }

        sql.push_str(&format!(
            " ORDER BY created_at DESC LIMIT ?{} OFFSET ?{}",
            param_idx,
            param_idx + 1
        ));
        params_vec.push(Box::new(limit));
        params_vec.push(Box::new(offset));

        let mut stmt = conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(params_refs.as_slice(), Self::row_to_resource)?;

        let resources: Vec<VfsResource> = rows.filter_map(log_and_skip_err).collect();
        Ok(resources)
    }

    /// 搜索资源
    ///
    pub fn search(
        db: &VfsDatabase,
        query: &str,
        types: Option<Vec<VfsResourceType>>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsResource>> {
        let conn = db.get_conn_safe()?;
        Self::search_with_conn(&conn, query, types, limit, offset)
    }

    /// 搜索资源（使用现有连接）
    pub fn search_with_conn(
        conn: &Connection,
        query: &str,
        types: Option<Vec<VfsResourceType>>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsResource>> {
        let mut sql = String::from(
            r#"
            SELECT id, hash, type, source_id, source_table, storage_mode, data, external_hash, metadata_json, ref_count, created_at, updated_at
            FROM resources
            WHERE data LIKE ?1 ESCAPE '\'
            "#,
        );

        let search_pattern = format!("%{}%", crate::vfs::repos::escape_like_pattern(query));
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(search_pattern)];
        let mut param_idx = 2;

        // 类型过滤
        if let Some(ts) = types {
            if !ts.is_empty() {
                let type_placeholders: Vec<String> = ts
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("?{}", param_idx + i))
                    .collect();
                sql.push_str(&format!(" AND type IN ({})", type_placeholders.join(",")));
                for t in ts {
                    params_vec.push(Box::new(t.to_string()));
                    param_idx += 1;
                }
            }
        }

        sql.push_str(&format!(
            " ORDER BY created_at DESC LIMIT ?{} OFFSET ?{}",
            param_idx,
            param_idx + 1
        ));
        params_vec.push(Box::new(limit));
        params_vec.push(Box::new(offset));

        let mut stmt = conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(params_refs.as_slice(), Self::row_to_resource)?;

        let resources: Vec<VfsResource> = rows.filter_map(log_and_skip_err).collect();
        Ok(resources)
    }

    // ========================================================================
    // 更新资源内容（用于 1:1 关系的资源如导图）
    // ========================================================================

    /// 更新资源的 data 字段（原地更新，不创建新资源）
    ///
    /// ## 适用场景
    /// - 导图等 1:1 关系的资源，不需要去重复用
    /// - 更新后需要重新索引
    ///
    /// ## 返回
    /// - `Ok(true)` - 内容有变化，已更新
    /// - `Ok(false)` - 内容无变化，未更新
    pub fn update_resource_data_with_conn(
        conn: &Connection,
        resource_id: &str,
        new_data: &str,
    ) -> VfsResult<bool> {
        // 1. 计算新哈希
        let mut new_hash = Self::compute_hash(new_data);

        // 2. 获取当前资源检查哈希是否变化
        let current =
            Self::get_resource_with_conn(conn, resource_id)?.ok_or_else(|| VfsError::NotFound {
                resource_type: "Resource".to_string(),
                id: resource_id.to_string(),
            })?;

        // 加盐哈希命中（同一行此前已退避）也视为无变化
        let salted_current = Self::compute_hash_with_salt(new_data, resource_id);
        if new_hash == current.hash || salted_current == current.hash {
            debug!(
                "[VFS::ResourceRepo] Resource {} data unchanged (hash: {})",
                resource_id, new_hash
            );
            return Ok(false);
        }

        // ★ 2026-06-12（审阅问题 M 类）：hash 列有 UNIQUE 约束。
        // 若新内容的无盐哈希已被其他资源行占用（内容恰好与他人相同），
        // 直接 UPDATE 会触发 UNIQUE 冲突导致保存失败。
        // 此时退避为加盐哈希（盐 = resource_id，全局唯一，不可能再冲突）。
        let hash_taken: bool = conn
            .query_row(
                "SELECT 1 FROM resources WHERE hash = ?1 AND id != ?2",
                params![&new_hash, resource_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if hash_taken {
            new_hash = salted_current;
        }

        // 3. 更新 data 和 hash
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE resources SET data = ?1, hash = ?2, updated_at = ?3,
                index_state = 'pending', index_error = NULL,
                index_retry_count = 0, index_next_retry_at = 0
             WHERE id = ?4",
            params![new_data, new_hash, now, resource_id],
        )?;

        info!(
            "[VFS::ResourceRepo] Updated resource {} data (old_hash: {}, new_hash: {})",
            resource_id, current.hash, new_hash
        );

        Ok(true)
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    /// 计算内容的 SHA-256 哈希
    pub fn compute_hash(data: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data.as_bytes());
        let result = hasher.finalize();
        hex::encode(result)
    }

    /// 计算带盐值的 SHA-256 哈希（用于避免跨资源去重冲突）
    pub fn compute_hash_with_salt(data: &str, salt: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(salt.as_bytes());
        hasher.update(b":");
        hasher.update(data.as_bytes());
        let result = hasher.finalize();
        hex::encode(result)
    }

    /// 从行数据构建 VfsResource
    ///
    /// 列顺序：id, hash, type, source_id, source_table, storage_mode, data, external_hash, metadata_json, ref_count, created_at, updated_at
    fn row_to_resource(row: &rusqlite::Row) -> rusqlite::Result<VfsResource> {
        let id: String = row.get(0)?;
        let hash: String = row.get(1)?;
        let type_str: String = row.get(2)?;
        let source_id: Option<String> = row.get(3)?;
        let source_table: Option<String> = row.get(4)?;
        let storage_mode_str: String = row.get(5)?;
        let data: Option<String> = row.get(6)?;
        let external_hash: Option<String> = row.get(7)?;
        let metadata_json: Option<String> = row.get(8)?;
        let ref_count: i32 = row.get(9)?;
        // 兼容处理：尝试读取 i64，如果失败则尝试解析 TEXT 格式的时间戳
        let created_at: i64 = row.get::<_, i64>(10).unwrap_or_else(|_| {
            row.get::<_, String>(10)
                .ok()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
                .map(|dt| dt.timestamp_millis())
                .unwrap_or(0)
        });
        let updated_at: i64 = row.get::<_, i64>(11).unwrap_or_else(|_| {
            row.get::<_, String>(11)
                .ok()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
                .map(|dt| dt.timestamp_millis())
                .unwrap_or(0)
        });

        let resource_type = VfsResourceType::from_str(&type_str).unwrap_or(VfsResourceType::File);

        let storage_mode = StorageMode::from_str(&storage_mode_str).unwrap_or(StorageMode::Inline);

        let metadata: Option<VfsResourceMetadata> = metadata_json
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok());

        Ok(VfsResource {
            id,
            hash,
            resource_type,
            source_id,
            source_table,
            storage_mode,
            data,
            external_hash,
            metadata,
            ref_count,
            created_at,
            updated_at,
        })
    }

    // ========================================================================
    // OCR 文本存储（用于图片等单页资源）
    // ========================================================================

    /// 保存资源的 OCR 文本
    ///
    /// ## 参数
    /// - `resource_id`: 资源 ID
    /// - `ocr_text`: OCR 文本内容
    pub fn save_ocr_text(db: &VfsDatabase, resource_id: &str, ocr_text: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::save_ocr_text_with_conn(&conn, resource_id, ocr_text)
    }

    /// 保存资源的 OCR 文本（使用现有连接）
    pub fn save_ocr_text_with_conn(
        conn: &Connection,
        resource_id: &str,
        ocr_text: &str,
    ) -> VfsResult<()> {
        let now_ms = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE resources SET ocr_text = ?1, updated_at = ?2 WHERE id = ?3",
            params![ocr_text, now_ms, resource_id],
        )?;

        debug!("[VFS::ResourceRepo] Saved OCR for resource {}", resource_id);
        Ok(())
    }

    /// 获取资源的 OCR 文本
    pub fn get_ocr_text(db: &VfsDatabase, resource_id: &str) -> VfsResult<Option<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_ocr_text_with_conn(&conn, resource_id)
    }

    /// 获取资源的 OCR 文本（使用现有连接）
    pub fn get_ocr_text_with_conn(
        conn: &Connection,
        resource_id: &str,
    ) -> VfsResult<Option<String>> {
        let ocr_text: Option<String> = conn
            .query_row(
                "SELECT ocr_text FROM resources WHERE id = ?1",
                params![resource_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();

        Ok(ocr_text)
    }

    /// 检查资源是否已有 OCR
    pub fn has_ocr_text(db: &VfsDatabase, resource_id: &str) -> VfsResult<bool> {
        Ok(Self::get_ocr_text(db, resource_id)?.is_some())
    }

    /// 通过 source_id 和 source_table 获取 OCR 文本
    pub fn get_ocr_text_by_source(
        db: &VfsDatabase,
        source_id: &str,
        source_table: &str,
    ) -> VfsResult<Option<String>> {
        let conn = db.get_conn_safe()?;
        let ocr_text: Option<String> = conn
            .query_row(
                "SELECT ocr_text FROM resources WHERE source_id = ?1 AND source_table = ?2",
                params![source_id, source_table],
                |row| row.get(0),
            )
            .optional()?
            .flatten();

        Ok(ocr_text)
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_test_db() -> (TempDir, VfsDatabase) {
        crate::vfs::database::setup_migrated_test_db()
    }

    #[test]
    fn test_create_or_reuse_dedup() {
        let (_temp_dir, db) = setup_test_db();

        // 创建第一个资源
        let result1 = VfsResourceRepo::create_or_reuse(
            &db,
            VfsResourceType::Note,
            "test content",
            Some("note_123"),
            Some("notes"),
            None,
        )
        .expect("First create should succeed");

        assert!(result1.is_new, "First create should be new");

        // 使用相同内容创建第二个资源（应该复用）
        let result2 = VfsResourceRepo::create_or_reuse(
            &db,
            VfsResourceType::Note,
            "test content",
            Some("note_456"),
            Some("notes"),
            None,
        )
        .expect("Second create should succeed");

        assert!(!result2.is_new, "Second create should reuse");
        assert_eq!(
            result1.resource_id, result2.resource_id,
            "Should have same resource_id"
        );
        assert_eq!(result1.hash, result2.hash, "Should have same hash");
    }

    #[test]
    fn test_get_resource() {
        let (_temp_dir, db) = setup_test_db();

        // 创建资源
        let result = VfsResourceRepo::create_or_reuse(
            &db,
            VfsResourceType::Note,
            "test content",
            Some("note_123"),
            Some("notes"),
            None,
        )
        .expect("Create should succeed");

        // 获取资源
        let resource = VfsResourceRepo::get_resource(&db, &result.resource_id)
            .expect("Get should succeed")
            .expect("Resource should exist");

        assert_eq!(resource.id, result.resource_id);
        assert_eq!(resource.hash, result.hash);
        assert_eq!(resource.data, Some("test content".to_string()));
    }

    #[test]
    fn test_ref_count() {
        let (_temp_dir, db) = setup_test_db();

        // 创建资源
        let result = VfsResourceRepo::create_or_reuse(
            &db,
            VfsResourceType::Note,
            "test content",
            None,
            None,
            None,
        )
        .expect("Create should succeed");

        // 初始引用计数为 0
        let resource = VfsResourceRepo::get_resource(&db, &result.resource_id)
            .expect("Get should succeed")
            .expect("Resource should exist");
        assert_eq!(resource.ref_count, 0);

        // 增加引用计数
        let new_count = VfsResourceRepo::increment_ref(&db, &result.resource_id)
            .expect("Increment should succeed");
        assert_eq!(new_count, 1);

        // 再次增加
        let new_count = VfsResourceRepo::increment_ref(&db, &result.resource_id)
            .expect("Increment should succeed");
        assert_eq!(new_count, 2);

        // 减少引用计数
        let new_count = VfsResourceRepo::decrement_ref(&db, &result.resource_id)
            .expect("Decrement should succeed");
        assert_eq!(new_count, 1);

        // 减少到 0
        let new_count = VfsResourceRepo::decrement_ref(&db, &result.resource_id)
            .expect("Decrement should succeed");
        assert_eq!(new_count, 0);

        // 不能减少到负数
        let new_count = VfsResourceRepo::decrement_ref(&db, &result.resource_id)
            .expect("Decrement should succeed");
        assert_eq!(new_count, 0, "Should not go below 0");
    }

    #[test]
    fn test_list_by_type() {
        let (_temp_dir, db) = setup_test_db();

        // 创建不同类型的资源
        VfsResourceRepo::create_or_reuse(
            &db,
            VfsResourceType::Note,
            "math content",
            None,
            None,
            None,
        )
        .unwrap();

        VfsResourceRepo::create_or_reuse(
            &db,
            VfsResourceType::Note,
            "physics content",
            None,
            None,
            None,
        )
        .unwrap();

        VfsResourceRepo::create_or_reuse(
            &db,
            VfsResourceType::Translation,
            "translation content",
            None,
            None,
            None,
        )
        .unwrap();

        // 查询所有
        let all_resources =
            VfsResourceRepo::list_by_type(&db, None, 10, 0).expect("List should succeed");
        assert_eq!(all_resources.len(), 3);

        // 按类型过滤
        let notes = VfsResourceRepo::list_by_type(&db, Some(VfsResourceType::Note), 10, 0)
            .expect("List should succeed");
        assert_eq!(notes.len(), 2);
    }

    #[test]
    fn test_compute_hash() {
        let hash1 = VfsResourceRepo::compute_hash("test content");
        let hash2 = VfsResourceRepo::compute_hash("test content");
        let hash3 = VfsResourceRepo::compute_hash("different content");

        assert_eq!(hash1, hash2, "Same content should have same hash");
        assert_ne!(hash1, hash3, "Different content should have different hash");
        assert_eq!(hash1.len(), 64, "SHA-256 should be 64 hex chars");
    }

    /// 测试并发安全性：多线程同时创建相同 hash 的资源
    ///
    /// 该测试验证 INSERT OR IGNORE 能正确处理并发竞态条件
    #[test]
    fn test_concurrent_create_same_hash() {
        use std::sync::Arc;
        use std::thread;

        let (_temp_dir, db) = setup_test_db();
        let db = Arc::new(db);

        let test_content = "concurrent test content";
        let expected_hash = VfsResourceRepo::compute_hash(test_content);

        // 启动 10 个线程同时创建相同内容的资源
        let handles: Vec<_> = (0..10)
            .map(|i| {
                let db_clone = Arc::clone(&db);
                let content = test_content.to_string();

                thread::spawn(move || {
                    VfsResourceRepo::create_or_reuse(
                        &db_clone,
                        VfsResourceType::Note,
                        &content,
                        Some(&format!("note_{}", i)),
                        Some("notes"),
                        None,
                    )
                })
            })
            .collect();

        // 等待所有线程完成
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();

        // 验证所有操作都成功
        assert_eq!(results.len(), 10, "All threads should complete");
        for result in &results {
            assert!(result.is_ok(), "All creates should succeed without error");
        }

        // 验证所有线程得到相同的 resource_id 和 hash
        let unwrapped_results: Vec<_> = results.iter().map(|r| r.as_ref().unwrap()).collect();
        let first_result = unwrapped_results[0];

        for result in &unwrapped_results {
            assert_eq!(
                result.resource_id, first_result.resource_id,
                "All threads should get the same resource_id"
            );
            assert_eq!(
                result.hash, expected_hash,
                "Hash should match expected value"
            );
        }

        // 验证只有一个资源被创建（is_new 应该只有一个 true）
        let new_count = unwrapped_results.iter().filter(|r| r.is_new).count();
        assert_eq!(new_count, 1, "Only one thread should create the resource");

        // 验证数据库中只有一条记录
        let conn = db.get_conn_safe().unwrap();
        let count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM resources WHERE hash = ?1",
                params![expected_hash],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(count, 1, "Only one resource should exist in database");
    }
}
