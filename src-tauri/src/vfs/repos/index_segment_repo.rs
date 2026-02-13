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
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 创建 Segment
pub fn create(conn: &Connection, input: CreateSegmentInput) -> Result<VfsIndexSegment, VfsError> {
    let id = generate_segment_id();
    let now = now_ms();

    conn.execute(
        "INSERT INTO vfs_index_segments (
            id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
            content_text, content_hash, start_pos, end_pos, metadata_json,
            created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
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
