//! VFS 索引分块仓库
//!
//! 管理 vfs_index_segments 表的 CRUD 操作
//!
//! ## lance_row_id 约定
//!
//! `lance_row_id` 字段用于关联 SQLite 元数据与 LanceDB 向量记录。
//!
//! ### ID 格式约定
//! | 前缀 | 含义 | 示例 |
//! |------|------|------|
//! | `emb_` | 正常索引，对应 LanceDB 中的实际记录 | `emb_abc123xyz0` |
//! | `migrated_` | 迁移数据，可能没有对应的 LanceDB 记录 | `migrated_seg_abc123xyz0` |
//! | `placeholder_no_lance_` | 废弃方法生成，没有 LanceDB 记录 | `placeholder_no_lance_abc123xyz0` |
//!
//! ### 生成方式
//! - 正常索引：由 `VfsEmbedding::generate_id()` 生成，在 `VfsFullIndexingService::index_resource` 中使用
//! - 迁移数据：由 `rag_migration` 模块生成
//! - 占位符：由废弃的 `VfsIndexingService::index_resource` 生成（不推荐使用）
//!
//! ### 注意事项
//! - 只有 `emb_` 前缀的 ID 才能在 LanceDB 中找到对应的向量记录
//! - 删除索引时，应同时删除 SQLite 记录和 LanceDB 向量（如存在）
//!
//! ### 2026-02 修复
//! - 修复了 `VfsFullIndexingService::index_resource` 中的 fallback 逻辑
//! - 之前：fallback 使用 `seg_` 前缀（错误，无法在 LanceDB 中找到对应记录）
//! - 现在：fallback 使用 `VfsEmbedding::generate_id()`（正确，生成 `emb_` 前缀）
//! - 添加了 count 验证和详细的警告日志

use crate::vfs::error::VfsError;
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::collections::HashSet;

/// 最小检索单位（对应 LanceDB 中的一条向量记录）
#[derive(Debug, Clone)]
pub struct VfsIndexSegment {
    pub id: String,
    pub unit_id: String,
    pub segment_index: i32,
    pub modality: String, // "text" | "image"
    pub embedding_dim: i32,
    /// LanceDB 中的记录 ID
    ///
    /// ## 格式约定
    /// - `emb_xxxxxxxxxx`: 正常索引，对应 LanceDB `embedding_id` 列
    /// - `migrated_seg_xxxxxxxxxx`: 迁移数据，可能无对应 LanceDB 记录
    /// - `placeholder_no_lance_xxxxxxxxxx`: 废弃方法产生，无 LanceDB 记录
    ///
    /// ## 使用
    /// - 用于在 LanceDB 中定位向量记录
    /// - 删除时通过此 ID 同步删除 LanceDB 数据
    pub lance_row_id: String,
    pub content_text: Option<String>,
    pub content_hash: Option<String>,
    pub start_pos: Option<i32>,
    pub end_pos: Option<i32>,
    pub metadata_json: Option<String>,
    pub index_profile_id: Option<String>,
    pub generation: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 创建 Segment 的输入数据
#[derive(Debug, Clone)]
pub struct CreateSegmentInput {
    pub unit_id: String,
    pub segment_index: i32,
    pub modality: String,
    pub embedding_dim: i32,
    /// LanceDB 记录 ID（应使用 `VfsEmbedding::generate_id()` 生成）
    pub lance_row_id: String,
    pub content_text: Option<String>,
    pub content_hash: Option<String>,
    pub start_pos: Option<i32>,
    pub end_pos: Option<i32>,
    pub metadata_json: Option<String>,
}

fn generate_segment_id() -> String {
    format!("seg_{}", nanoid::nanoid!(10))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// Persist a Lance deletion intent and make an existing deferred entry due
/// immediately again.  Re-enqueueing means the row has just lost a live
/// SQLite reference, so an earlier backoff must not delay the new cleanup.
pub fn enqueue_lance_orphan(
    conn: &Connection,
    lance_row_id: &str,
    resource_id: Option<&str>,
) -> Result<(), VfsError> {
    conn.execute(
        "INSERT INTO __lance_orphan_queue (lance_row_id, resource_id)
         VALUES (?1, ?2)
         ON CONFLICT(lance_row_id) DO UPDATE SET
             resource_id = COALESCE(excluded.resource_id, resource_id),
             enqueued_at = excluded.enqueued_at,
             next_retry_at = 0,
             last_error = NULL",
        params![lance_row_id, resource_id],
    )?;
    Ok(())
}

fn row_to_segment(row: &Row) -> rusqlite::Result<VfsIndexSegment> {
    Ok(VfsIndexSegment {
        id: row.get("id")?,
        unit_id: row.get("unit_id")?,
        segment_index: row.get("segment_index")?,
        modality: row.get("modality")?,
        embedding_dim: row.get("embedding_dim")?,
        lance_row_id: row.get("lance_row_id")?,
        content_text: row.get("content_text")?,
        content_hash: row.get("content_hash")?,
        start_pos: row.get("start_pos")?,
        end_pos: row.get("end_pos")?,
        metadata_json: row.get("metadata_json")?,
        index_profile_id: row.get("index_profile_id").ok(),
        generation: row.get("generation").unwrap_or(0),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 创建 Segment
pub fn create(conn: &Connection, input: CreateSegmentInput) -> Result<VfsIndexSegment, VfsError> {
    let id = generate_segment_id();
    let now = now_ms();
    let unit_profile: Option<(Option<String>, i64)> = conn
        .query_row(
            "SELECT
                CASE WHEN ?2 IN ('image', 'multimodal') THEN mm_profile_id ELSE text_profile_id END,
                CASE WHEN ?2 IN ('image', 'multimodal') THEN mm_generation ELSE text_generation END
             FROM vfs_index_units WHERE id = ?1",
            params![input.unit_id, input.modality],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (mut index_profile_id, generation) = unit_profile.unwrap_or((None, 0));
    if index_profile_id.is_none() {
        index_profile_id = conn
            .query_row(
                "SELECT active_profile_id FROM vfs_embedding_dims
                 WHERE dimension = ?1 AND modality = ?2",
                params![input.embedding_dim, input.modality],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
    }

    conn.execute(
        "INSERT INTO vfs_index_segments (
            id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
            content_text, content_hash, start_pos, end_pos, metadata_json,
            index_profile_id, generation, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            id,
            input.unit_id,
            input.segment_index,
            input.modality,
            input.embedding_dim,
            input.lance_row_id,
            input.content_text,
            input.content_hash,
            input.start_pos,
            input.end_pos,
            input.metadata_json,
            index_profile_id,
            generation,
            now,
            now,
        ],
    )?;

    get_by_id(conn, &id)?.ok_or_else(|| VfsError::NotFound {
        resource_type: "Segment".to_string(),
        id: id.clone(),
    })
}

/// 批量创建 Segments
pub fn batch_create(
    conn: &Connection,
    inputs: Vec<CreateSegmentInput>,
) -> Result<Vec<VfsIndexSegment>, VfsError> {
    let mut segments = Vec::with_capacity(inputs.len());
    for input in inputs {
        let segment = create(conn, input)?;
        segments.push(segment);
    }
    Ok(segments)
}

/// 按 ID 查询 Segment
pub fn get_by_id(conn: &Connection, id: &str) -> Result<Option<VfsIndexSegment>, VfsError> {
    let result = conn
        .query_row(
            "SELECT * FROM vfs_index_segments WHERE id = ?1",
            params![id],
            row_to_segment,
        )
        .optional()?;
    Ok(result)
}

/// 按 Unit ID 查询所有 Segments
pub fn get_by_unit(conn: &Connection, unit_id: &str) -> Result<Vec<VfsIndexSegment>, VfsError> {
    let mut stmt = conn.prepare(
        "SELECT * FROM vfs_index_segments WHERE unit_id = ?1 ORDER BY segment_index ASC",
    )?;
    let segments = stmt
        .query_map(params![unit_id], row_to_segment)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(segments)
}

/// 按 Unit ID 和模态查询 Segments
pub fn get_by_unit_and_modality(
    conn: &Connection,
    unit_id: &str,
    modality: &str,
) -> Result<Vec<VfsIndexSegment>, VfsError> {
    let mut stmt = conn.prepare(
        "SELECT * FROM vfs_index_segments
         WHERE unit_id = ?1 AND modality = ?2
         ORDER BY segment_index ASC",
    )?;
    let segments = stmt
        .query_map(params![unit_id, modality], row_to_segment)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(segments)
}

/// 删除 Unit 的所有 Segments
pub fn delete_by_unit(conn: &Connection, unit_id: &str) -> Result<i64, VfsError> {
    let rows = conn.execute(
        "DELETE FROM vfs_index_segments WHERE unit_id = ?1",
        params![unit_id],
    )?;
    Ok(rows as i64)
}

/// 删除 Unit 指定模态的 Segments
pub fn delete_by_unit_and_modality(
    conn: &Connection,
    unit_id: &str,
    modality: &str,
) -> Result<i64, VfsError> {
    let rows = conn.execute(
        "DELETE FROM vfs_index_segments WHERE unit_id = ?1 AND modality = ?2",
        params![unit_id, modality],
    )?;
    Ok(rows as i64)
}

/// 原子替换 Unit 在指定模态下的 Segments，并将不再使用的 Lance 行写入补偿队列。
///
/// 调用方应在自己的 transaction/savepoint 中调用本函数。Lance 写入先于本函数完成；
/// SQLite 提交后，即使进程在 Lance 清理前退出，`__lance_orphan_queue` 也能保证旧行最终删除。
pub fn replace_by_unit_and_modality(
    conn: &Connection,
    resource_id: &str,
    unit_id: &str,
    modality: &str,
    inputs: Vec<CreateSegmentInput>,
) -> Result<Vec<VfsIndexSegment>, VfsError> {
    if inputs
        .iter()
        .any(|input| input.unit_id != unit_id || input.modality != modality)
    {
        return Err(VfsError::Other(format!(
            "segment replacement scope mismatch: unit={}, modality={}",
            unit_id, modality
        )));
    }

    let keep_ids: HashSet<&str> = inputs
        .iter()
        .map(|input| input.lance_row_id.as_str())
        .collect();
    // 同一个稳定 row ID 可能在“页面删除后很快恢复”时重新变成 live row。
    // 先撤销该 ID 的旧删除意图，避免队列稍后误删刚写入的新向量。
    for keep_id in &keep_ids {
        conn.execute(
            "DELETE FROM __lance_orphan_queue WHERE lance_row_id = ?1",
            params![keep_id],
        )?;
    }
    for old_id in list_lance_row_ids_by_unit_and_modality(conn, unit_id, modality)? {
        if !keep_ids.contains(old_id.as_str()) {
            enqueue_lance_orphan(conn, &old_id, Some(resource_id))?;
        }
    }

    delete_by_unit_and_modality(conn, unit_id, modality)?;
    batch_create(conn, inputs)
}

/// 清除资源指定模态的 Segment，并把对应 Lance 行写入补偿队列。
///
/// 该操作不会删除 Unit，因此文本索引和 OCR 派生内容不受影响。
pub fn enqueue_and_delete_by_resource_and_modality(
    conn: &Connection,
    resource_id: &str,
    modality: &str,
) -> Result<i64, VfsError> {
    conn.execute(
        r#"INSERT INTO __lance_orphan_queue (lance_row_id, resource_id)
           SELECT s.lance_row_id, u.resource_id
           FROM vfs_index_segments s
           JOIN vfs_index_units u ON u.id = s.unit_id
           WHERE u.resource_id = ?1 AND s.modality = ?2
           ON CONFLICT(lance_row_id) DO UPDATE SET
               resource_id = excluded.resource_id,
               enqueued_at = excluded.enqueued_at,
               next_retry_at = 0,
               last_error = NULL"#,
        params![resource_id, modality],
    )?;
    let rows = conn.execute(
        r#"DELETE FROM vfs_index_segments
           WHERE modality = ?2
             AND unit_id IN (SELECT id FROM vfs_index_units WHERE resource_id = ?1)"#,
        params![resource_id, modality],
    )?;
    Ok(rows as i64)
}

/// 按 lance_row_id 删除 Segment
pub fn delete_by_lance_row_id(conn: &Connection, lance_row_id: &str) -> Result<bool, VfsError> {
    let rows = conn.execute(
        "DELETE FROM vfs_index_segments WHERE lance_row_id = ?1",
        params![lance_row_id],
    )?;
    Ok(rows > 0)
}

/// 按 ID 删除 Segment
pub fn delete(conn: &Connection, id: &str) -> Result<bool, VfsError> {
    let rows = conn.execute("DELETE FROM vfs_index_segments WHERE id = ?1", params![id])?;
    Ok(rows > 0)
}

/// 获取指定模态和维度的 Segment 数量
pub fn count_by_modality_and_dim(
    conn: &Connection,
    modality: &str,
    embedding_dim: i32,
) -> Result<i64, VfsError> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vfs_index_segments WHERE modality = ?1 AND embedding_dim = ?2",
        params![modality, embedding_dim],
        |row| row.get(0),
    )?;
    Ok(count)
}

/// 获取所有 lance_row_ids（用于清理 LanceDB）
pub fn list_lance_row_ids_by_unit(
    conn: &Connection,
    unit_id: &str,
) -> Result<Vec<String>, VfsError> {
    let mut stmt =
        conn.prepare("SELECT lance_row_id FROM vfs_index_segments WHERE unit_id = ?1")?;
    let ids = stmt
        .query_map(params![unit_id], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

/// 获取 Unit 的所有模态维度组合的 lance_row_ids
pub fn list_lance_row_ids_by_unit_and_modality(
    conn: &Connection,
    unit_id: &str,
    modality: &str,
) -> Result<Vec<String>, VfsError> {
    let mut stmt = conn.prepare(
        "SELECT lance_row_id FROM vfs_index_segments WHERE unit_id = ?1 AND modality = ?2",
    )?;
    let ids = stmt
        .query_map(params![unit_id, modality], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

/// 获取 Segment 的模态维度分布
#[derive(Debug, Clone)]
pub struct ModalityDimStats {
    pub modality: String,
    pub embedding_dim: i32,
    pub count: i64,
}

pub fn get_modality_dim_stats(conn: &Connection) -> Result<Vec<ModalityDimStats>, VfsError> {
    let mut stmt = conn.prepare(
        "SELECT modality, embedding_dim, COUNT(*) as count
         FROM vfs_index_segments
         GROUP BY modality, embedding_dim",
    )?;
    let stats = stmt
        .query_map([], |row| {
            Ok(ModalityDimStats {
                modality: row.get(0)?,
                embedding_dim: row.get(1)?,
                count: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::repos::{embedding_dim_repo, MODALITY_MULTIMODAL};

    fn seed_unit(conn: &Connection) -> (String, String) {
        let resource_id = "res_mm_segment_test".to_string();
        let unit_id = "unit_mm_segment_test".to_string();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
             VALUES (?1, 'hash_mm_segment_test', 'file', 'inline', '', 0, ?2, ?2)",
            params![resource_id, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vfs_index_units
             (id, resource_id, unit_index, image_blob_hash, mm_required, mm_state, created_at, updated_at)
             VALUES (?1, ?2, 0, 'blob_page_0', 1, 'indexing', ?3, ?3)",
            params![unit_id, resource_id, now],
        )
        .unwrap();
        (resource_id, unit_id)
    }

    fn segment_input(unit_id: &str, lance_row_id: &str) -> CreateSegmentInput {
        CreateSegmentInput {
            unit_id: unit_id.to_string(),
            segment_index: 0,
            modality: MODALITY_MULTIMODAL.to_string(),
            embedding_dim: 1024,
            lance_row_id: lance_row_id.to_string(),
            content_text: None,
            content_hash: Some("content_hash".to_string()),
            start_pos: None,
            end_pos: None,
            metadata_json: Some(
                r#"{"page_index":0,"blob_hash":"blob_page_0","unit_id":"unit_mm_segment_test"}"#
                    .to_string(),
            ),
        }
    }

    #[test]
    fn replace_is_idempotent_and_removal_is_durable() {
        let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (resource_id, unit_id) = seed_unit(&conn);

        replace_by_unit_and_modality(
            &conn,
            &resource_id,
            &unit_id,
            MODALITY_MULTIMODAL,
            vec![segment_input(&unit_id, "mm_row_stable")],
        )
        .unwrap();
        replace_by_unit_and_modality(
            &conn,
            &resource_id,
            &unit_id,
            MODALITY_MULTIMODAL,
            vec![segment_input(&unit_id, "mm_row_stable")],
        )
        .unwrap();

        let segment_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM vfs_index_segments WHERE unit_id = ?1 AND modality = ?2",
                params![unit_id, MODALITY_MULTIMODAL],
                |row| row.get(0),
            )
            .unwrap();
        let queued_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM __lance_orphan_queue", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(segment_count, 1);
        assert_eq!(
            queued_count, 0,
            "stable replacement must not delete the live row"
        );

        // 同页换图会生成新的 content/generation row ID；旧行必须持久入队。
        replace_by_unit_and_modality(
            &conn,
            &resource_id,
            &unit_id,
            MODALITY_MULTIMODAL,
            vec![segment_input(&unit_id, "mm_row_new_image")],
        )
        .unwrap();
        let old_image_queued: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM __lance_orphan_queue WHERE lance_row_id = 'mm_row_stable'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(old_image_queued, 1);

        embedding_dim_repo::register(&conn, 1024, MODALITY_MULTIMODAL).unwrap();
        embedding_dim_repo::refresh_counts_from_segments(&conn).unwrap();
        let count_before: i64 = conn
            .query_row(
                "SELECT record_count FROM vfs_embedding_dims WHERE dimension = 1024 AND modality = ?1",
                params![MODALITY_MULTIMODAL],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count_before, 1);

        replace_by_unit_and_modality(
            &conn,
            &resource_id,
            &unit_id,
            MODALITY_MULTIMODAL,
            Vec::new(),
        )
        .unwrap();
        embedding_dim_repo::refresh_counts_from_segments(&conn).unwrap();

        let queued_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM __lance_orphan_queue WHERE lance_row_id = 'mm_row_new_image'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let count_after: i64 = conn
            .query_row(
                "SELECT record_count FROM vfs_embedding_dims WHERE dimension = 1024 AND modality = ?1",
                params![MODALITY_MULTIMODAL],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queued_count, 1);
        assert_eq!(count_after, 0);

        // 页面在队列 drain 前恢复时，同一个稳定 ID 必须撤销旧删除意图。
        replace_by_unit_and_modality(
            &conn,
            &resource_id,
            &unit_id,
            MODALITY_MULTIMODAL,
            vec![segment_input(&unit_id, "mm_row_new_image")],
        )
        .unwrap();
        let queued_after_restore: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM __lance_orphan_queue WHERE lance_row_id = 'mm_row_new_image'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queued_after_restore, 0);
    }

    #[test]
    fn reenqueue_makes_a_high_retry_orphan_due_immediately() {
        let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        conn.execute(
            "INSERT INTO __lance_orphan_queue
             (lance_row_id, resource_id, retry_count, next_retry_at, last_error)
             VALUES ('emb_deferred', 'res_old', 99, ?1, 'old failure')",
            params![chrono::Utc::now().timestamp_millis() + 3_600_000],
        )
        .unwrap();

        enqueue_lance_orphan(&conn, "emb_deferred", Some("res_new")).unwrap();
        let state: (String, i32, i64, Option<String>) = conn
            .query_row(
                "SELECT resource_id, retry_count, next_retry_at, last_error
                 FROM __lance_orphan_queue WHERE lance_row_id = 'emb_deferred'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(state, ("res_new".to_string(), 99, 0, None));
    }
}
