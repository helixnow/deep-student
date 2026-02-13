//! VFS 嵌入存储模块
//!
//! ⚠️ **已废弃**：此模块操作的 `vfs_embeddings` 表已在迁移 028 中删除。
//! 新代码应使用 `vfs_index_units` 和 `vfs_index_segments` 表（新架构）。
//! 相关 repo: `index_unit_repo`, `index_segment_repo`, `embedding_dim_repo`
//!
//! 将向量化能力内化为 VFS 的索引层，取消独立的 RAG 知识库概念。

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::{debug, error, info, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsEmbedding {
    pub id: String,
    pub resource_id: String,
    pub chunk_index: i32,
    pub chunk_text: String,
    pub embedding_dim: i32,
    pub modality: String,
    pub start_pos: Option<i32>,
    pub end_pos: Option<i32>,
    pub metadata_json: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl VfsEmbedding {
    /// 生成嵌入向量 ID
    ///
    /// ## 格式
    /// `emb_xxxxxxxxxx`（emb_ 前缀 + 10位 nanoid）
    ///
    /// ## 用途
    /// - 作为 LanceDB 中 `embedding_id` 列的值
    /// - 同步到 SQLite `vfs_index_segments.lance_row_id` 列
    /// - 用于在 LanceDB 和 SQLite 之间建立一一对应关系
    ///
    /// ## 生命周期
    /// 1. 在 `VfsEmbeddingService::chunks_to_lance_rows` 中生成
    /// 2. 写入 LanceDB 的 `embedding_id` 列
    /// 3. 返回给调用方（通过 `IndexChunksResult.embedding_ids`）
    /// 4. 调用方写入 SQLite 的 `vfs_index_segments.lance_row_id`
    /// 5. 删除时通过此 ID 定位 LanceDB 记录
    ///
    /// ## 注意
    /// - ⚠️ 不要使用 `seg_` 前缀的 ID 作为 `lance_row_id`
    /// - ⚠️ `lance_row_id` 必须对应实际存在于 LanceDB 中的记录
    pub fn generate_id() -> String {
        format!("emb_{}", nanoid::nanoid!(10))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsEmbeddingDimension {
    pub dimension: i32,
    pub modality: String,
    pub record_count: i32,
    pub lance_table_name: String,
    pub created_at: i64,
    pub last_used_at: i64,
    /// 绑定的模型配置 ID
    pub model_config_id: Option<String>,
    /// 绑定的模型名称
    pub model_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexState {
    pub state: String,
    pub hash: Option<String>,
    pub error: Option<String>,
    pub indexed_at: Option<i64>,
    pub retry_count: i32,
}

impl Default for IndexState {
    fn default() -> Self {
        Self {
            state: "pending".to_string(),
            hash: None,
            error: None,
            indexed_at: None,
            retry_count: 0,
        }
    }
}

pub const INDEX_STATE_PENDING: &str = "pending";
pub const INDEX_STATE_INDEXING: &str = "indexing";
pub const INDEX_STATE_INDEXED: &str = "indexed";
pub const INDEX_STATE_FAILED: &str = "failed";
pub const INDEX_STATE_DISABLED: &str = "disabled";

/// 文本模态
pub const MODALITY_TEXT: &str = "text";

/// 多模态（图片/PDF 页面等视觉内容）
/// ★ 2026-01：VFS 统一管理多模态索引
pub const MODALITY_MULTIMODAL: &str = "multimodal";

pub const VFS_EMB_TABLE_PREFIX: &str = "vfs_emb_";

// ============================================================================
// ❗ VfsEmbeddingRepo 已废弃并删除（2026-01-20）
// 新代码应使用 index_unit_repo 和 index_segment_repo
// ============================================================================

/// Log row-parse errors instead of silently discarding them.
fn log_and_skip_err<T>(result: Result<T, rusqlite::Error>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("Row parse error (embedding_repo): {}", e);
            None
        }
    }
}

pub struct VfsDimensionRepo;

impl VfsDimensionRepo {
    pub fn register_dimension(
        db: &VfsDatabase,
        dimension: i32,
        modality: &str,
        _model_config_id: Option<&str>,
    ) -> VfsResult<String> {
        let conn = db.get_conn_safe()?;
        Self::register_dimension_with_conn(&conn, dimension, modality)
    }

    /// 注册维度并绑定模型
    pub fn register_dimension_with_model(
        db: &VfsDatabase,
        dimension: i32,
        modality: &str,
        model_config_id: Option<&str>,
        model_name: Option<&str>,
    ) -> VfsResult<String> {
        let conn = db.get_conn_safe()?;
        Self::register_dimension_with_model_conn(
            &conn,
            dimension,
            modality,
            model_config_id,
            model_name,
        )
    }

    pub fn register_dimension_with_conn(
        conn: &Connection,
        dimension: i32,
        modality: &str,
    ) -> VfsResult<String> {
        Self::register_dimension_with_model_conn(conn, dimension, modality, None, None)
    }

    pub fn register_dimension_with_model_conn(
        conn: &Connection,
        dimension: i32,
        modality: &str,
        model_config_id: Option<&str>,
        model_name: Option<&str>,
    ) -> VfsResult<String> {
        let table_name = format!("{}{}_{}", VFS_EMB_TABLE_PREFIX, modality, dimension);
        let now = chrono::Utc::now().timestamp_millis();

        conn.execute(
            r#"
            INSERT INTO vfs_embedding_dims (dimension, modality, lance_table_name, record_count, created_at, last_used_at, model_config_id, model_name)
            VALUES (?1, ?2, ?3, 0, ?4, ?4, ?5, ?6)
            ON CONFLICT(dimension, modality) DO UPDATE SET
                last_used_at = ?4,
                model_config_id = COALESCE(?5, model_config_id),
                model_name = COALESCE(?6, model_name)
            "#,
            params![dimension, modality, table_name, now, model_config_id, model_name],
        )?;

        debug!(
            "[VfsDimensionRepo] Registered dimension {} for modality {} (model: {:?})",
            dimension, modality, model_config_id
        );

        Ok(table_name)
    }

    pub fn get_dimension(
        db: &VfsDatabase,
        dimension: i32,
        modality: &str,
    ) -> VfsResult<Option<VfsEmbeddingDimension>> {
        let conn = db.get_conn_safe()?;
        Self::get_dimension_with_conn(&conn, dimension, modality)
    }

    pub fn get_dimension_with_conn(
        conn: &Connection,
        dimension: i32,
        modality: &str,
    ) -> VfsResult<Option<VfsEmbeddingDimension>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT dimension, modality, record_count, lance_table_name, created_at, last_used_at, model_config_id, model_name
            FROM vfs_embedding_dims
            WHERE dimension = ?1 AND modality = ?2
            "#,
        )?;

        let dim = stmt
            .query_row(params![dimension, modality], Self::row_to_dimension)
            .optional()?;

        Ok(dim)
    }

    pub fn list_dimensions(db: &VfsDatabase) -> VfsResult<Vec<VfsEmbeddingDimension>> {
        let conn = db.get_conn_safe()?;
        Self::list_dimensions_with_conn(&conn)
    }

    pub fn list_dimensions_with_conn(conn: &Connection) -> VfsResult<Vec<VfsEmbeddingDimension>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT dimension, modality, record_count, lance_table_name, created_at, last_used_at, model_config_id, model_name
            FROM vfs_embedding_dims
            ORDER BY last_used_at DESC
            "#,
        )?;

        let rows = stmt.query_map([], Self::row_to_dimension)?;
        let dimensions: Vec<VfsEmbeddingDimension> = rows.filter_map(log_and_skip_err).collect();
        Ok(dimensions)
    }

    /// 查询所有有模型绑定的维度（用于跨维度检索）
    pub fn list_dimensions_with_model_binding(
        db: &VfsDatabase,
    ) -> VfsResult<Vec<VfsEmbeddingDimension>> {
        let conn = db.get_conn_safe()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT dimension, modality, record_count, lance_table_name, created_at, last_used_at, model_config_id, model_name
            FROM vfs_embedding_dims
            WHERE model_config_id IS NOT NULL AND record_count > 0
            ORDER BY last_used_at DESC
            "#,
        )?;

        let rows = stmt.query_map([], Self::row_to_dimension)?;
        let dimensions: Vec<VfsEmbeddingDimension> = rows.filter_map(log_and_skip_err).collect();
        Ok(dimensions)
    }

    pub fn update_record_count(
        db: &VfsDatabase,
        dimension: i32,
        modality: &str,
        count: i32,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        let now = chrono::Utc::now().timestamp_millis();

        conn.execute(
            "UPDATE vfs_embedding_dims SET record_count = ?1, last_used_at = ?2 WHERE dimension = ?3 AND modality = ?4",
            params![count, now, dimension, modality],
        )?;

        Ok(())
    }

    pub fn increment_record_count(
        db: &VfsDatabase,
        dimension: i32,
        modality: &str,
        delta: i32,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        let now = chrono::Utc::now().timestamp_millis();

        conn.execute(
            "UPDATE vfs_embedding_dims SET record_count = record_count + ?1, last_used_at = ?2 WHERE dimension = ?3 AND modality = ?4",
            params![delta, now, dimension, modality],
        )?;

        Ok(())
    }

    fn row_to_dimension(row: &rusqlite::Row) -> rusqlite::Result<VfsEmbeddingDimension> {
        Ok(VfsEmbeddingDimension {
            dimension: row.get(0)?,
            modality: row.get(1)?,
            record_count: row.get(2)?,
            lance_table_name: row.get(3)?,
            created_at: row.get(4)?,
            last_used_at: row.get(5)?,
            model_config_id: row.get(6).ok(),
            model_name: row.get(7).ok(),
        })
    }

    /// 获取 LanceDB 表名
    pub fn get_lance_table_name(dimension: i32, modality: &str) -> String {
        format!("{}{}_{}", VFS_EMB_TABLE_PREFIX, modality, dimension)
    }

    /// 为维度分配模型（配置项，非数据绑定）
    ///
    /// 用于跨维度检索时选择使用哪个模型生成查询向量。
    /// 用户可以随时更改分配，不影响已索引的数据。
    pub fn update_model_assignment(
        db: &VfsDatabase,
        dimension: i32,
        modality: &str,
        model_config_id: &str,
        model_name: &str,
    ) -> VfsResult<bool> {
        let conn = db.get_conn_safe()?;
        let now = chrono::Utc::now().timestamp_millis();

        let rows = conn.execute(
            r#"
            UPDATE vfs_embedding_dims
            SET model_config_id = ?1, model_name = ?2, last_used_at = ?3
            WHERE dimension = ?4 AND modality = ?5
            "#,
            params![model_config_id, model_name, now, dimension, modality],
        )?;

        if rows > 0 {
            info!(
                "[VfsDimensionRepo] Assigned model {} ({}) to dimension {} (modality={})",
                model_name, model_config_id, dimension, modality
            );
        }

        Ok(rows > 0)
    }
}

pub struct VfsIndexStateRepo;

impl VfsIndexStateRepo {
    pub fn get_index_state(db: &VfsDatabase, resource_id: &str) -> VfsResult<Option<IndexState>> {
        let conn = db.get_conn_safe()?;
        Self::get_index_state_with_conn(&conn, resource_id)
    }

    pub fn get_index_state_with_conn(
        conn: &Connection,
        resource_id: &str,
    ) -> VfsResult<Option<IndexState>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT index_state, index_hash, index_error, indexed_at, index_retry_count
            FROM resources
            WHERE id = ?1
            "#,
        )?;

        let state = stmt
            .query_row(params![resource_id], |row| {
                Ok(IndexState {
                    state: row
                        .get::<_, Option<String>>(0)?
                        .unwrap_or_else(|| INDEX_STATE_PENDING.to_string()),
                    hash: row.get(1)?,
                    error: row.get(2)?,
                    indexed_at: row.get(3)?,
                    retry_count: row.get::<_, Option<i32>>(4)?.unwrap_or(0),
                })
            })
            .optional()?;

        Ok(state)
    }

    pub fn set_index_state(
        db: &VfsDatabase,
        resource_id: &str,
        state: &str,
        hash: Option<&str>,
        error: Option<&str>,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::set_index_state_with_conn(&conn, resource_id, state, hash, error)
    }

    pub fn set_index_state_with_conn(
        conn: &Connection,
        resource_id: &str,
        state: &str,
        hash: Option<&str>,
        error: Option<&str>,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let indexed_at = if state == INDEX_STATE_INDEXED {
            Some(now)
        } else {
            None
        };

        conn.execute(
            r#"
            UPDATE resources
            SET index_state = ?1, index_hash = ?2, index_error = ?3, indexed_at = ?4, updated_at = ?5
            WHERE id = ?6
            "#,
            params![state, hash, error, indexed_at, now, resource_id],
        )?;

        debug!(
            "[VfsIndexStateRepo] Set index state for {}: {}",
            resource_id, state
        );

        Ok(())
    }

    pub fn mark_pending(db: &VfsDatabase, resource_id: &str) -> VfsResult<()> {
        Self::set_index_state(db, resource_id, INDEX_STATE_PENDING, None, None)
    }

    pub fn mark_indexing(db: &VfsDatabase, resource_id: &str) -> VfsResult<()> {
        Self::set_index_state(db, resource_id, INDEX_STATE_INDEXING, None, None)
    }

    pub fn mark_indexed(db: &VfsDatabase, resource_id: &str, hash: &str) -> VfsResult<()> {
        Self::set_index_state(db, resource_id, INDEX_STATE_INDEXED, Some(hash), None)
    }

    pub fn mark_failed(db: &VfsDatabase, resource_id: &str, error: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        let now = chrono::Utc::now().timestamp_millis();

        conn.execute(
            r#"
            UPDATE resources
            SET index_state = ?1, index_error = ?2, index_retry_count = COALESCE(index_retry_count, 0) + 1, updated_at = ?3
            WHERE id = ?4
            "#,
            params![INDEX_STATE_FAILED, error, now, resource_id],
        )?;

        Ok(())
    }

    pub fn mark_disabled(db: &VfsDatabase, resource_id: &str) -> VfsResult<()> {
        Self::set_index_state(db, resource_id, INDEX_STATE_DISABLED, None, None)
    }

    /// 标记资源为不可索引，并记录原因
    pub fn mark_disabled_with_reason(
        db: &VfsDatabase,
        resource_id: &str,
        reason: &str,
    ) -> VfsResult<()> {
        Self::set_index_state(db, resource_id, INDEX_STATE_DISABLED, None, Some(reason))
    }

    pub fn get_pending_resources(
        db: &VfsDatabase,
        limit: u32,
        max_retries: i32,
    ) -> VfsResult<Vec<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_pending_resources_with_conn(&conn, limit, max_retries)
    }

    /// 原子 claim 一批待索引资源并立即置为 indexing，避免并发重复处理。
    pub fn claim_pending_resources(
        db: &VfsDatabase,
        limit: u32,
        max_retries: i32,
    ) -> VfsResult<Vec<String>> {
        let mut conn = db.get_conn_safe()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let ids = Self::get_pending_resources_with_conn(&tx, limit, max_retries)?;
        if ids.is_empty() {
            tx.commit()?;
            return Ok(ids);
        }

        let now = chrono::Utc::now().timestamp_millis();
        for resource_id in &ids {
            tx.execute(
                r#"
                UPDATE resources
                SET index_state = ?1, index_error = NULL, updated_at = ?2
                WHERE id = ?3
                "#,
                params![INDEX_STATE_INDEXING, now, resource_id],
            )?;
        }

        tx.commit()?;
        Ok(ids)
    }

    pub fn get_pending_resources_with_conn(
        conn: &Connection,
        limit: u32,
        max_retries: i32,
    ) -> VfsResult<Vec<String>> {
        // 查询待索引资源（不包含 disabled 状态，避免队列污染）
        // - pending/NULL: 新资源，需要索引
        // - failed: 失败资源，重试次数未超限时重新索引
        // - indexed 但无 unit: 索引元数据丢失，需要重新索引（使用新架构 vfs_index_units）
        // 注意：disabled 资源不在此查询中，需通过 get_disabled_resources 显式获取
        let mut stmt = conn.prepare(
            r#"
            SELECT id FROM resources r
            WHERE (r.index_state = 'pending' OR r.index_state IS NULL)
               OR (r.index_state = 'failed' AND COALESCE(r.index_retry_count, 0) < ?1)
               OR (r.index_state = 'indexed' AND NOT EXISTS (SELECT 1 FROM vfs_index_units WHERE resource_id = r.id))
            ORDER BY r.updated_at DESC
            LIMIT ?2
            "#,
        )?;

        let rows = stmt.query_map(params![max_retries, limit], |row| row.get::<_, String>(0))?;
        let ids: Vec<String> = rows.filter_map(log_and_skip_err).collect();
        Ok(ids)
    }

    /// Get disabled resources for explicit retry.
    /// This is separate from the normal pending queue to prevent queue pollution.
    pub fn get_disabled_resources(db: &VfsDatabase, limit: u32) -> VfsResult<Vec<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_disabled_resources_with_conn(&conn, limit)
    }

    /// Get disabled resources for explicit retry (with raw connection).
    /// This is separate from the normal pending queue to prevent queue pollution.
    pub fn get_disabled_resources_with_conn(
        conn: &Connection,
        limit: u32,
    ) -> VfsResult<Vec<String>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id FROM resources r
            WHERE r.index_state = 'disabled'
            ORDER BY r.updated_at DESC
            LIMIT ?1
            "#,
        )?;
        let rows = stmt.query_map(params![limit], |row| row.get::<_, String>(0))?;
        let ids: Vec<String> = rows.filter_map(log_and_skip_err).collect();
        Ok(ids)
    }

    pub fn get_resources_needing_reindex(
        db: &VfsDatabase,
        limit: u32,
    ) -> VfsResult<Vec<(String, String)>> {
        let conn = db.get_conn_safe()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT id, hash FROM resources
            WHERE index_state = 'indexed' AND index_hash != hash
            ORDER BY updated_at DESC
            LIMIT ?1
            "#,
        )?;

        let rows = stmt.query_map(params![limit], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let results: Vec<(String, String)> = rows.filter_map(log_and_skip_err).collect();
        Ok(results)
    }

    // ========================================================================
    // 多模态索引状态管理
    // ========================================================================

    /// 获取资源的多模态索引状态
    pub fn get_mm_index_state(
        db: &VfsDatabase,
        resource_id: &str,
    ) -> VfsResult<Option<IndexState>> {
        let conn = db.get_conn_safe()?;
        Self::get_mm_index_state_with_conn(&conn, resource_id)
    }

    pub fn get_mm_index_state_with_conn(
        conn: &Connection,
        resource_id: &str,
    ) -> VfsResult<Option<IndexState>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT mm_index_state, NULL, mm_index_error, mm_indexed_at, mm_index_retry_count
            FROM resources
            WHERE id = ?1
            "#,
        )?;

        let state = stmt
            .query_row(params![resource_id], |row| {
                Ok(IndexState {
                    state: row
                        .get::<_, Option<String>>(0)?
                        .unwrap_or_else(|| INDEX_STATE_PENDING.to_string()),
                    hash: row.get(1)?,
                    error: row.get(2)?,
                    indexed_at: row.get(3)?,
                    retry_count: row.get::<_, Option<i32>>(4)?.unwrap_or(0),
                })
            })
            .optional()?;

        Ok(state)
    }

    /// 设置资源的多模态索引状态
    pub fn set_mm_index_state(
        db: &VfsDatabase,
        resource_id: &str,
        state: &str,
        error: Option<&str>,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::set_mm_index_state_with_conn(&conn, resource_id, state, error)
    }

    pub fn set_mm_index_state_with_conn(
        conn: &Connection,
        resource_id: &str,
        state: &str,
        error: Option<&str>,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let indexed_at = if state == INDEX_STATE_INDEXED {
            Some(now)
        } else {
            None
        };

        conn.execute(
            r#"
            UPDATE resources
            SET mm_index_state = ?1, mm_index_error = ?2, mm_indexed_at = COALESCE(?3, mm_indexed_at), updated_at = ?4
            WHERE id = ?5
            "#,
            params![state, error, indexed_at, now, resource_id],
        )?;

        debug!(
            "[VfsIndexStateRepo] Set mm_index_state for {}: {}",
            resource_id, state
        );

        Ok(())
    }

    pub fn mark_mm_pending(db: &VfsDatabase, resource_id: &str) -> VfsResult<()> {
        Self::set_mm_index_state(db, resource_id, INDEX_STATE_PENDING, None)
    }

    pub fn mark_mm_indexing(db: &VfsDatabase, resource_id: &str) -> VfsResult<()> {
        Self::set_mm_index_state(db, resource_id, INDEX_STATE_INDEXING, None)
    }

    pub fn mark_mm_indexed(db: &VfsDatabase, resource_id: &str) -> VfsResult<()> {
        Self::set_mm_index_state(db, resource_id, INDEX_STATE_INDEXED, None)
    }

    pub fn mark_mm_failed(db: &VfsDatabase, resource_id: &str, error: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        let now = chrono::Utc::now().timestamp_millis();

        conn.execute(
            r#"
            UPDATE resources
            SET mm_index_state = ?1, mm_index_error = ?2, mm_index_retry_count = COALESCE(mm_index_retry_count, 0) + 1, updated_at = ?3
            WHERE id = ?4
            "#,
            params![INDEX_STATE_FAILED, error, now, resource_id],
        )?;

        Ok(())
    }

    pub fn mark_mm_disabled(db: &VfsDatabase, resource_id: &str) -> VfsResult<()> {
        Self::set_mm_index_state(db, resource_id, INDEX_STATE_DISABLED, None)
    }

    /// 获取待进行多模态索引的资源
    pub fn get_mm_pending_resources(
        db: &VfsDatabase,
        limit: u32,
        max_retries: i32,
    ) -> VfsResult<Vec<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_mm_pending_resources_with_conn(&conn, limit, max_retries)
    }

    pub fn get_mm_pending_resources_with_conn(
        conn: &Connection,
        limit: u32,
        max_retries: i32,
    ) -> VfsResult<Vec<String>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id FROM resources r
            WHERE r.type IN ('image', 'textbook', 'file', 'exam')
              AND ((r.mm_index_state = 'pending' OR r.mm_index_state IS NULL)
                   OR (r.mm_index_state = 'failed' AND COALESCE(r.mm_index_retry_count, 0) < ?1))
            ORDER BY r.updated_at DESC
            LIMIT ?2
            "#,
        )?;

        let rows = stmt.query_map(params![max_retries, limit], |row| row.get::<_, String>(0))?;
        let ids: Vec<String> = rows.filter_map(log_and_skip_err).collect();
        Ok(ids)
    }
}

pub struct VfsIndexingConfigRepo;

impl VfsIndexingConfigRepo {
    pub fn get_config(db: &VfsDatabase, key: &str) -> VfsResult<Option<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_config_with_conn(&conn, key)
    }

    pub fn get_config_with_conn(conn: &Connection, key: &str) -> VfsResult<Option<String>> {
        let value: Option<String> = conn
            .query_row(
                "SELECT value FROM vfs_indexing_config WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        Ok(value)
    }

    pub fn set_config(db: &VfsDatabase, key: &str, value: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::set_config_with_conn(&conn, key, value)
    }

    pub fn set_config_with_conn(conn: &Connection, key: &str, value: &str) -> VfsResult<()> {
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            r#"
            INSERT OR REPLACE INTO vfs_indexing_config (key, value, updated_at)
            VALUES (?1, ?2, ?3)
            "#,
            params![key, value, now],
        )?;
        Ok(())
    }

    pub fn get_bool(db: &VfsDatabase, key: &str, default: bool) -> VfsResult<bool> {
        match Self::get_config(db, key)? {
            Some(v) => Ok(v.to_lowercase() == "true" || v == "1"),
            None => Ok(default),
        }
    }

    pub fn get_i32(db: &VfsDatabase, key: &str, default: i32) -> VfsResult<i32> {
        match Self::get_config(db, key)? {
            Some(v) => Ok(v.parse().unwrap_or(default)),
            None => Ok(default),
        }
    }

    pub fn get_f64(db: &VfsDatabase, key: &str, default: f64) -> VfsResult<f64> {
        match Self::get_config(db, key)? {
            Some(v) => Ok(v.parse().unwrap_or(default)),
            None => Ok(default),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_test_db() -> (TempDir, VfsDatabase) {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db = VfsDatabase::new(temp_dir.path()).expect("Failed to create database");
        (temp_dir, db)
    }

    #[test]
    fn test_register_dimension() {
        let (_temp_dir, db) = setup_test_db();

        let table_name = VfsDimensionRepo::register_dimension(&db, 768, MODALITY_TEXT, None)
            .expect("Register should succeed");

        assert_eq!(table_name, "vfs_emb_text_768");

        let dim = VfsDimensionRepo::get_dimension(&db, 768, MODALITY_TEXT)
            .expect("Get should succeed")
            .expect("Dimension should exist");

        assert_eq!(dim.dimension, 768);
        assert_eq!(dim.modality, MODALITY_TEXT);
    }

    #[test]
    fn test_index_state() {
        let (_temp_dir, db) = setup_test_db();

        let conn = db.get_conn_safe().unwrap();
        conn.execute(
            "INSERT INTO resources (id, hash, type, storage_mode, data, created_at, updated_at) VALUES ('res_test', 'hash123', 'note', 'inline', 'test', 0, 0)",
            [],
        ).unwrap();

        VfsIndexStateRepo::mark_pending(&db, "res_test").expect("Mark pending should succeed");

        let state = VfsIndexStateRepo::get_index_state(&db, "res_test")
            .expect("Get should succeed")
            .expect("State should exist");
        assert_eq!(state.state, INDEX_STATE_PENDING);

        VfsIndexStateRepo::mark_indexed(&db, "res_test", "hash123")
            .expect("Mark indexed should succeed");

        let state = VfsIndexStateRepo::get_index_state(&db, "res_test")
            .expect("Get should succeed")
            .expect("State should exist");
        assert_eq!(state.state, INDEX_STATE_INDEXED);
        assert_eq!(state.hash, Some("hash123".to_string()));
    }
}
