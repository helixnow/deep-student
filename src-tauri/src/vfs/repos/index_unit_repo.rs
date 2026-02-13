//! VFS 索引单元仓库
//!
//! 管理 vfs_index_units 表的 CRUD 操作

use crate::vfs::error::VfsError;
use rusqlite::{params, Connection, OptionalExtension, Row};

/// Unit 索引状态
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IndexState {
    Pending,
    Indexing,
    Indexed,
    Failed,
    Disabled,
}

impl IndexState {
    pub fn as_str(&self) -> &'static str {
        match self {
            IndexState::Pending => "pending",
            IndexState::Indexing => "indexing",
            IndexState::Indexed => "indexed",
            IndexState::Failed => "failed",
            IndexState::Disabled => "disabled",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "pending" => IndexState::Pending,
            "indexing" => IndexState::Indexing,
            "indexed" => IndexState::Indexed,
            "failed" => IndexState::Failed,
            _ => IndexState::Disabled,
        }
    }
}

/// 图片-文本组数据
#[derive(Debug, Clone)]
pub struct VfsIndexUnit {
    pub id: String,
    pub resource_id: String,
    pub unit_index: i32,
    pub image_blob_hash: Option<String>,
    pub image_mime_type: Option<String>,
    pub text_content: Option<String>,
    pub text_source: Option<String>,
    pub content_hash: Option<String>,
    pub text_required: bool,
    pub text_state: IndexState,
    pub text_error: Option<String>,
    pub text_indexed_at: Option<i64>,
    pub text_chunk_count: i32,
    pub text_embedding_dim: Option<i32>,
    pub mm_required: bool,
    pub mm_state: IndexState,
    pub mm_error: Option<String>,
    pub mm_indexed_at: Option<i64>,
    pub mm_embedding_dim: Option<i32>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 创建 Unit 的输入数据
#[derive(Debug, Clone)]
pub struct CreateUnitInput {
    pub resource_id: String,
    pub unit_index: i32,
    pub image_blob_hash: Option<String>,
    pub image_mime_type: Option<String>,
    pub text_content: Option<String>,
    pub text_source: Option<String>,
}

/// sync_units 的返回结果
#[derive(Debug, Clone)]
pub struct SyncUnitsResult {
    /// 同步后的 Units 列表
    pub units: Vec<VfsIndexUnit>,
    /// 被删除的 Units 关联的 LanceDB lance_row_ids（需要调用方清理 LanceDB）
    pub orphaned_lance_row_ids: Vec<String>,
}

/// Unit 统计数据
#[derive(Debug, Clone, Default)]
pub struct UnitStats {
    pub total: i64,
    pub text_pending: i64,
    pub text_indexing: i64,
    pub text_indexed: i64,
    pub text_failed: i64,
    pub text_disabled: i64,
    pub mm_pending: i64,
    pub mm_indexing: i64,
    pub mm_indexed: i64,
    pub mm_failed: i64,
    pub mm_disabled: i64,
}

fn generate_unit_id() -> String {
    format!("unit_{}", nanoid::nanoid!(10))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn compute_content_hash(image_hash: Option<&str>, text: Option<&str>) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    if let Some(h) = image_hash {
        hasher.update(h.as_bytes());
    }
    hasher.update(b"|");
    if let Some(t) = text {
        hasher.update(t.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn row_to_unit(row: &Row) -> rusqlite::Result<VfsIndexUnit> {
    Ok(VfsIndexUnit {
        id: row.get("id")?,
        resource_id: row.get("resource_id")?,
        unit_index: row.get("unit_index")?,
        image_blob_hash: row.get("image_blob_hash")?,
        image_mime_type: row.get("image_mime_type")?,
        text_content: row.get("text_content")?,
        text_source: row.get("text_source")?,
        content_hash: row.get("content_hash")?,
        text_required: row.get::<_, i32>("text_required")? != 0,
        text_state: IndexState::from_str(&row.get::<_, String>("text_state")?),
        text_error: row.get("text_error")?,
        text_indexed_at: row.get("text_indexed_at")?,
        text_chunk_count: row.get::<_, i32>("text_chunk_count").unwrap_or(0),
        text_embedding_dim: row.get("text_embedding_dim")?,
        mm_required: row.get::<_, i32>("mm_required")? != 0,
        mm_state: IndexState::from_str(&row.get::<_, String>("mm_state")?),
        mm_error: row.get("mm_error")?,
        mm_indexed_at: row.get("mm_indexed_at")?,
        mm_embedding_dim: row.get("mm_embedding_dim")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 创建 Unit
pub fn create(conn: &Connection, input: CreateUnitInput) -> Result<VfsIndexUnit, VfsError> {
    let id = generate_unit_id();
    let now = now_ms();

    let text_required = input
        .text_content
        .as_ref()
        .map(|t| !t.is_empty())
        .unwrap_or(false);
    let mm_required = input.image_blob_hash.is_some();

    let text_state = if text_required { "pending" } else { "disabled" };
    let mm_state = if mm_required { "pending" } else { "disabled" };

    let content_hash = compute_content_hash(
        input.image_blob_hash.as_deref(),
        input.text_content.as_deref(),
    );

    conn.execute(
        "INSERT INTO vfs_index_units (
            id, resource_id, unit_index, image_blob_hash, image_mime_type,
            text_content, text_source, content_hash,
            text_required, text_state, text_chunk_count,
            mm_required, mm_state,
            created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11, ?12, ?13, ?14)",
        params![
            id,
            input.resource_id,
            input.unit_index,
            input.image_blob_hash,
            input.image_mime_type,
            input.text_content,
            input.text_source,
            content_hash,
            text_required as i32,
            text_state,
            mm_required as i32,
            mm_state,
            now,
            now,
        ],
    )?;

    get_by_id(conn, &id)?.ok_or_else(|| VfsError::NotFound {
        resource_type: "Unit".to_string(),
        id: id.clone(),
    })
}

/// 按 ID 查询 Unit
pub fn get_by_id(conn: &Connection, id: &str) -> Result<Option<VfsIndexUnit>, VfsError> {
    let result = conn
        .query_row(
            "SELECT * FROM vfs_index_units WHERE id = ?1",
            params![id],
            row_to_unit,
        )
        .optional()?;
    Ok(result)
}

/// 按资源 ID 查询所有 Units
pub fn get_by_resource(
    conn: &Connection,
    resource_id: &str,
) -> Result<Vec<VfsIndexUnit>, VfsError> {
    let mut stmt = conn
        .prepare("SELECT * FROM vfs_index_units WHERE resource_id = ?1 ORDER BY unit_index ASC")?;
    let units = stmt
        .query_map(params![resource_id], row_to_unit)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(units)
}

/// 更新 Unit
pub fn update(conn: &Connection, unit: &VfsIndexUnit) -> Result<(), VfsError> {
    let now = now_ms();
    let content_hash = compute_content_hash(
        unit.image_blob_hash.as_deref(),
        unit.text_content.as_deref(),
    );

    conn.execute(
        "UPDATE vfs_index_units SET
            image_blob_hash = ?2,
            image_mime_type = ?3,
            text_content = ?4,
            text_source = ?5,
            content_hash = ?6,
            text_required = ?7,
            text_state = ?8,
            text_error = ?9,
            text_indexed_at = ?10,
            text_chunk_count = ?11,
            text_embedding_dim = ?12,
            mm_required = ?13,
            mm_state = ?14,
            mm_error = ?15,
            mm_indexed_at = ?16,
            mm_embedding_dim = ?17,
            updated_at = ?18
        WHERE id = ?1",
        params![
            unit.id,
            unit.image_blob_hash,
            unit.image_mime_type,
            unit.text_content,
            unit.text_source,
            content_hash,
            unit.text_required as i32,
            unit.text_state.as_str(),
            unit.text_error,
            unit.text_indexed_at,
            unit.text_chunk_count,
            unit.text_embedding_dim,
            unit.mm_required as i32,
            unit.mm_state.as_str(),
            unit.mm_error,
            unit.mm_indexed_at,
            unit.mm_embedding_dim,
            now,
        ],
    )?;
    Ok(())
}

/// 删除 Unit
pub fn delete(conn: &Connection, id: &str) -> Result<bool, VfsError> {
    let rows = conn.execute("DELETE FROM vfs_index_units WHERE id = ?1", params![id])?;
    Ok(rows > 0)
}

/// 删除资源的所有 Units
pub fn delete_by_resource(conn: &Connection, resource_id: &str) -> Result<i64, VfsError> {
    let rows = conn.execute(
        "DELETE FROM vfs_index_units WHERE resource_id = ?1",
        params![resource_id],
    )?;
    Ok(rows as i64)
}

/// 设置文本索引状态
pub fn set_text_state(
    conn: &Connection,
    id: &str,
    state: IndexState,
    error: Option<&str>,
) -> Result<(), VfsError> {
    let now = now_ms();
    let indexed_at = if state == IndexState::Indexed {
        Some(now)
    } else {
        None
    };

    conn.execute(
        "UPDATE vfs_index_units SET
            text_state = ?2,
            text_error = ?3,
            text_indexed_at = COALESCE(?4, text_indexed_at),
            updated_at = ?5
        WHERE id = ?1",
        params![id, state.as_str(), error, indexed_at, now],
    )?;
    Ok(())
}

/// 设置文本索引完成状态（含分块数和维度）
pub fn set_text_indexed(
    conn: &Connection,
    id: &str,
    chunk_count: i32,
    embedding_dim: i32,
) -> Result<(), VfsError> {
    let now = now_ms();
    conn.execute(
        "UPDATE vfs_index_units SET
            text_state = 'indexed',
            text_error = NULL,
            text_indexed_at = ?2,
            text_chunk_count = ?3,
            text_embedding_dim = ?4,
            updated_at = ?2
        WHERE id = ?1",
        params![id, now, chunk_count, embedding_dim],
    )?;
    Ok(())
}

/// 设置多模态索引状态
pub fn set_mm_state(
    conn: &Connection,
    id: &str,
    state: IndexState,
    error: Option<&str>,
) -> Result<(), VfsError> {
    let now = now_ms();
    let indexed_at = if state == IndexState::Indexed {
        Some(now)
    } else {
        None
    };

    conn.execute(
        "UPDATE vfs_index_units SET
            mm_state = ?2,
            mm_error = ?3,
            mm_indexed_at = COALESCE(?4, mm_indexed_at),
            updated_at = ?5
        WHERE id = ?1",
        params![id, state.as_str(), error, indexed_at, now],
    )?;
    Ok(())
}

/// 设置多模态索引完成状态（含维度）
pub fn set_mm_indexed(conn: &Connection, id: &str, embedding_dim: i32) -> Result<(), VfsError> {
    let now = now_ms();
    conn.execute(
        "UPDATE vfs_index_units SET
            mm_state = 'indexed',
            mm_error = NULL,
            mm_indexed_at = ?2,
            mm_embedding_dim = ?3,
            updated_at = ?2
        WHERE id = ?1",
        params![id, now, embedding_dim],
    )?;
    Ok(())
}

/// 查询待文本索引的 Units
pub fn list_pending_text(conn: &Connection, limit: i32) -> Result<Vec<VfsIndexUnit>, VfsError> {
    let mut stmt = conn.prepare(
        "SELECT * FROM vfs_index_units
         WHERE text_required = 1 AND text_state = 'pending'
         ORDER BY updated_at DESC
         LIMIT ?1",
    )?;
    let units = stmt
        .query_map(params![limit], row_to_unit)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(units)
}

/// 查询待多模态索引的 Units
pub fn list_pending_mm(conn: &Connection, limit: i32) -> Result<Vec<VfsIndexUnit>, VfsError> {
    let mut stmt = conn.prepare(
        "SELECT * FROM vfs_index_units
         WHERE mm_required = 1 AND mm_state = 'pending'
         ORDER BY updated_at DESC
         LIMIT ?1",
    )?;
    let units = stmt
        .query_map(params![limit], row_to_unit)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(units)
}

/// 获取统计数据
pub fn get_stats(conn: &Connection) -> Result<UnitStats, VfsError> {
    let mut stats = UnitStats::default();

    stats.total = conn.query_row("SELECT COUNT(*) FROM vfs_index_units", [], |row| row.get(0))?;

    // 文本索引统计
    let mut stmt =
        conn.prepare("SELECT text_state, COUNT(*) FROM vfs_index_units GROUP BY text_state")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    for row in rows {
        let (state, count) = row?;
        match state.as_str() {
            "pending" => stats.text_pending = count,
            "indexing" => stats.text_indexing = count,
            "indexed" => stats.text_indexed = count,
            "failed" => stats.text_failed = count,
            "disabled" => stats.text_disabled = count,
            _ => {}
        }
    }

    // 多模态索引统计
    let mut stmt =
        conn.prepare("SELECT mm_state, COUNT(*) FROM vfs_index_units GROUP BY mm_state")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    for row in rows {
        let (state, count) = row?;
        match state.as_str() {
            "pending" => stats.mm_pending = count,
            "indexing" => stats.mm_indexing = count,
            "indexed" => stats.mm_indexed = count,
            "failed" => stats.mm_failed = count,
            "disabled" => stats.mm_disabled = count,
            _ => {}
        }
    }

    Ok(stats)
}

/// 按资源 ID 和 unit_index 查询 Unit
pub fn get_by_resource_and_index(
    conn: &Connection,
    resource_id: &str,
    unit_index: i32,
) -> Result<Option<VfsIndexUnit>, VfsError> {
    let result = conn
        .query_row(
            "SELECT * FROM vfs_index_units WHERE resource_id = ?1 AND unit_index = ?2",
            params![resource_id, unit_index],
            row_to_unit,
        )
        .optional()?;
    Ok(result)
}

/// 批量创建 Units
pub fn batch_create(
    conn: &Connection,
    inputs: Vec<CreateUnitInput>,
) -> Result<Vec<VfsIndexUnit>, VfsError> {
    let mut units = Vec::with_capacity(inputs.len());
    for input in inputs {
        let unit = create(conn, input)?;
        units.push(unit);
    }
    Ok(units)
}

/// 同步资源的 Units（比较 content_hash，增量更新）
pub fn sync_units(
    conn: &Connection,
    resource_id: &str,
    inputs: Vec<CreateUnitInput>,
) -> Result<SyncUnitsResult, VfsError> {
    let existing = get_by_resource(conn, resource_id)?;
    let existing_map: std::collections::HashMap<i32, VfsIndexUnit> =
        existing.into_iter().map(|u| (u.unit_index, u)).collect();

    let mut result = Vec::with_capacity(inputs.len());
    let input_indices: std::collections::HashSet<i32> =
        inputs.iter().map(|i| i.unit_index).collect();

    for input in inputs {
        let new_hash = compute_content_hash(
            input.image_blob_hash.as_deref(),
            input.text_content.as_deref(),
        );

        if let Some(existing_unit) = existing_map.get(&input.unit_index) {
            // 比较 hash，如果相同则跳过
            if existing_unit.content_hash.as_deref() == Some(&new_hash) {
                result.push(existing_unit.clone());
            } else {
                // 内容变化，更新 Unit 并重置索引状态
                let text_required = input
                    .text_content
                    .as_ref()
                    .map(|t| !t.is_empty())
                    .unwrap_or(false);
                let mm_required = input.image_blob_hash.is_some();

                let mut updated = existing_unit.clone();
                updated.image_blob_hash = input.image_blob_hash;
                updated.image_mime_type = input.image_mime_type;
                updated.text_content = input.text_content;
                updated.text_source = input.text_source;
                updated.content_hash = Some(new_hash);
                updated.text_required = text_required;
                updated.text_state = if text_required {
                    IndexState::Pending
                } else {
                    IndexState::Disabled
                };
                updated.text_error = None;
                updated.text_chunk_count = 0;
                updated.mm_required = mm_required;
                updated.mm_state = if mm_required {
                    IndexState::Pending
                } else {
                    IndexState::Disabled
                };
                updated.mm_error = None;

                update(conn, &updated)?;
                result.push(updated);
            }
        } else {
            // 新增 Unit
            let unit = create(conn, input)?;
            result.push(unit);
        }
    }

    // 删除不再存在的 Units，收集孤立的 lance_row_ids
    let mut orphaned_lance_row_ids = Vec::new();
    for (index, existing_unit) in existing_map {
        if !input_indices.contains(&index) {
            // 收集该 unit 关联的 lance_row_ids（删除后 segments 会被 CASCADE 删除）
            if let Ok(ids) =
                super::index_segment_repo::list_lance_row_ids_by_unit(conn, &existing_unit.id)
            {
                orphaned_lance_row_ids.extend(ids);
            }
            delete(conn, &existing_unit.id)?;
        }
    }

    Ok(SyncUnitsResult {
        units: result,
        orphaned_lance_row_ids,
    })
}
