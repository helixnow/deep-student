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
            "disabled" => IndexState::Disabled,
            other => {
                // ★ P1-6：未知值说明账本已被脏数据污染。静默映射为 Disabled 会让
                // Unit 无声地退出调度（状态漂移），至少留下告警便于定位数据来源。
                log::warn!(
                    "[IndexUnitRepo] Unknown index state '{}' in vfs_index_units; treating as disabled",
                    other
                );
                IndexState::Disabled
            }
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
    pub text_profile_id: Option<String>,
    pub text_generation: i64,
    pub mm_required: bool,
    pub mm_state: IndexState,
    pub mm_error: Option<String>,
    pub mm_indexed_at: Option<i64>,
    pub mm_embedding_dim: Option<i32>,
    pub mm_profile_id: Option<String>,
    pub mm_generation: i64,
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
    /// 本次同步失效的 LanceDB lance_row_ids。
    ///
    /// ★ P1-5：这些 row IDs 已在 `sync_units` 内部（同一连接/事务）写入
    /// `__lance_orphan_queue`，由后台 drain 兜底删除。此字段仅供调用方
    /// 记录日志/观测，**不再要求调用方自行入队**。
    pub orphaned_lance_row_ids: Vec<String>,
}

/// 多模态页面清单同步结果。
#[derive(Debug, Clone)]
pub struct SyncMultimodalUnitsResult {
    /// 当前页面对应的 Units（顺序与输入一致）。
    pub units: Vec<VfsIndexUnit>,
    /// 已写入 `__lance_orphan_queue` 的历史 Lance row IDs。
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
        text_profile_id: row.get("text_profile_id").ok(),
        text_generation: row.get("text_generation").unwrap_or(0),
        mm_required: row.get::<_, i32>("mm_required")? != 0,
        mm_state: IndexState::from_str(&row.get::<_, String>("mm_state")?),
        mm_error: row.get("mm_error")?,
        mm_indexed_at: row.get("mm_indexed_at")?,
        mm_embedding_dim: row.get("mm_embedding_dim")?,
        mm_profile_id: row.get("mm_profile_id").ok(),
        mm_generation: row.get("mm_generation").unwrap_or(0),
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
            text_profile_id = ?19,
            text_generation = ?20,
            mm_required = ?13,
            mm_state = ?14,
            mm_error = ?15,
            mm_indexed_at = ?16,
            mm_embedding_dim = ?17,
            mm_profile_id = ?21,
            mm_generation = ?22,
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
            unit.text_profile_id,
            unit.text_generation,
            unit.mm_profile_id,
            unit.mm_generation,
        ],
    )?;
    Ok(())
}

/// Persist the vector-space identity used by a Unit.  Segment creation reads
/// this value automatically, keeping existing CreateSegmentInput call sites
/// source-compatible.
pub fn set_index_profile(
    conn: &Connection,
    unit_id: &str,
    modality: &str,
    profile_id: &str,
    generation: i64,
) -> Result<(), VfsError> {
    if generation < 0 {
        return Err(VfsError::InvalidArgument {
            param: "generation".to_string(),
            reason: "Generation must be non-negative".to_string(),
        });
    }
    let (profile_column, generation_column) = match modality {
        "text" => ("text_profile_id", "text_generation"),
        "image" | "multimodal" => ("mm_profile_id", "mm_generation"),
        _ => {
            return Err(VfsError::InvalidArgument {
                param: "modality".to_string(),
                reason: format!("Unsupported modality: {}", modality),
            })
        }
    };
    let writable: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1
            FROM vfs_index_profiles p
            JOIN vfs_embedding_dims d
              ON d.active_profile_id = p.id
             AND d.dimension = p.dimension
             AND d.modality = p.modality
            WHERE p.id = ?1
              AND p.modality = ?2
              AND p.state IN ('active', 'building')
        )",
        params![
            profile_id,
            if modality == "image" {
                "multimodal"
            } else {
                modality
            }
        ],
        |row| row.get(0),
    )?;
    if !writable {
        return Err(VfsError::InvalidState {
            message: format!(
                "Index profile {} is no longer writable for modality {}",
                profile_id, modality
            ),
        });
    }
    let sql = format!(
        "UPDATE vfs_index_units SET {} = ?2, {} = ?3, updated_at = ?4 WHERE id = ?1",
        profile_column, generation_column
    );
    let updated = conn.execute(&sql, params![unit_id, profile_id, generation, now_ms()])?;
    if updated == 0 {
        return Err(VfsError::NotFound {
            resource_type: "IndexUnit".to_string(),
            id: unit_id.to_string(),
        });
    }
    Ok(())
}

/// 删除 Unit
///
/// ★ P1（2026-07 修复）：删除路径单一化——裸删除默认把 Unit 名下全部
/// segment 的 lance_row_id 写入 `__lance_orphan_queue`（同连接/事务），
/// 再删除 Unit（segments 由 FK CASCADE 级联删除）。入队幂等；若 Lance 行
/// 已被调用方删除，drain 对不存在的行删除为 no-op。
/// 明确保证 Lance 已删且想避免队列噪音的调用方可用 [`delete_unsafe`]。
pub fn delete(conn: &Connection, id: &str) -> Result<bool, VfsError> {
    super::index_segment_repo::enqueue_lance_orphans_by_unit(conn, id, None)?;
    delete_unsafe(conn, id)
}

/// 删除 Unit（不入孤儿队列）。
///
/// ⚠️ 仅允许在"对应 Lance 行已删除或已登记删除意图"的前提下调用。
pub fn delete_unsafe(conn: &Connection, id: &str) -> Result<bool, VfsError> {
    let rows = conn.execute("DELETE FROM vfs_index_units WHERE id = ?1", params![id])?;
    Ok(rows > 0)
}

/// 删除资源的所有 Units
///
/// ★ P1（2026-07 修复）：与 [`purge_index_artifacts_by_resource`] 语义合流——
/// 裸删除默认先把资源名下全部 segment 的 lance_row_id 入孤儿队列。
/// 明确保证 Lance 已删的调用方可用 [`delete_by_resource_unsafe`]。
pub fn delete_by_resource(conn: &Connection, resource_id: &str) -> Result<i64, VfsError> {
    purge_index_artifacts_by_resource(conn, resource_id)
}

/// 删除资源的所有 Units（不入孤儿队列）。
///
/// ⚠️ 仅允许在"对应 Lance 行已删除或已登记删除意图"的前提下调用。
pub fn delete_by_resource_unsafe(conn: &Connection, resource_id: &str) -> Result<i64, VfsError> {
    let rows = conn.execute(
        "DELETE FROM vfs_index_units WHERE resource_id = ?1",
        params![resource_id],
    )?;
    Ok(rows as i64)
}

/// 彻底清理资源的全部索引产物（units + segments + LanceDB 向量入列）
///
/// ★ 2026-06-12（第二轮审阅）：purge 业务记录时必须调用本函数。
/// 旧实现各 repo 直接 `DELETE FROM vfs_index_units`（或根本不删），导致：
/// 1. essay/translation/textbook/exam purge 后 units/segments 永久残留；
/// 2. 所有 purge 链路的 LanceDB 向量从不删除 → 语义检索还能命中已删除内容。
///
/// 本函数先把 segments 的 lance_row_id 写入 `__lance_orphan_queue`
/// （与业务删除同事务），由后台索引循环 drain 后真正删除向量，
/// 然后删除 units（FK CASCADE 自动清掉 segments）。
pub fn purge_index_artifacts_by_resource(
    conn: &Connection,
    resource_id: &str,
) -> Result<i64, VfsError> {
    conn.execute(
        r#"INSERT INTO __lance_orphan_queue (lance_row_id, resource_id)
           SELECT s.lance_row_id, u.resource_id
           FROM vfs_index_segments s
           JOIN vfs_index_units u ON s.unit_id = u.id
           WHERE u.resource_id = ?1
           ON CONFLICT(lance_row_id) DO UPDATE SET
               resource_id = excluded.resource_id,
               enqueued_at = excluded.enqueued_at,
               next_retry_at = 0,
               last_error = NULL"#,
        params![resource_id],
    )?;
    delete_by_resource_unsafe(conn, resource_id)
}

/// 清扫孤儿索引单元（resource 已被删除但 units 残留的历史数据）
///
/// ★ 2026-06-12（第二轮审阅）：启动时调用，回收历史版本遗留的索引产物。
/// 返回清理的 unit 行数。
pub fn sweep_orphan_index_units(conn: &Connection) -> Result<i64, VfsError> {
    conn.execute(
        r#"INSERT INTO __lance_orphan_queue (lance_row_id, resource_id)
           SELECT s.lance_row_id, u.resource_id
           FROM vfs_index_segments s
           JOIN vfs_index_units u ON s.unit_id = u.id
           WHERE NOT EXISTS (SELECT 1 FROM resources r WHERE r.id = u.resource_id)
           ON CONFLICT(lance_row_id) DO UPDATE SET
               resource_id = excluded.resource_id,
               enqueued_at = excluded.enqueued_at,
               next_retry_at = 0,
               last_error = NULL"#,
        [],
    )?;
    let rows = conn.execute(
        "DELETE FROM vfs_index_units WHERE NOT EXISTS (SELECT 1 FROM resources r WHERE r.id = vfs_index_units.resource_id)",
        [],
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
///
/// ★ P2（2026-07 优化）：改为真正批量——单个 SAVEPOINT + 预编译 INSERT，
/// 避免逐条 `create()` 每行一次隐式提交 + 一次回读。行为与逐条创建一致。
pub fn batch_create(
    conn: &Connection,
    inputs: Vec<CreateUnitInput>,
) -> Result<Vec<VfsIndexUnit>, VfsError> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    conn.execute_batch("SAVEPOINT vfs_unit_batch_create")?;
    let result = batch_create_inner(conn, inputs);
    match result {
        Ok(value) => {
            conn.execute_batch("RELEASE SAVEPOINT vfs_unit_batch_create")?;
            Ok(value)
        }
        Err(error) => {
            if let Err(rollback_error) = conn.execute_batch(
                "ROLLBACK TO SAVEPOINT vfs_unit_batch_create;
                 RELEASE SAVEPOINT vfs_unit_batch_create;",
            ) {
                return Err(VfsError::Database(format!(
                    "{}; unit batch rollback failed: {}",
                    error, rollback_error
                )));
            }
            Err(error)
        }
    }
}

fn batch_create_inner(
    conn: &Connection,
    inputs: Vec<CreateUnitInput>,
) -> Result<Vec<VfsIndexUnit>, VfsError> {
    let mut insert_stmt = conn.prepare(
        "INSERT INTO vfs_index_units (
            id, resource_id, unit_index, image_blob_hash, image_mime_type,
            text_content, text_source, content_hash,
            text_required, text_state, text_chunk_count,
            mm_required, mm_state,
            created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11, ?12, ?13, ?14)",
    )?;

    let mut units = Vec::with_capacity(inputs.len());
    for input in inputs {
        let id = generate_unit_id();
        let now = now_ms();
        let text_required = input
            .text_content
            .as_ref()
            .map(|t| !t.is_empty())
            .unwrap_or(false);
        let mm_required = input.image_blob_hash.is_some();
        let text_state = if text_required {
            IndexState::Pending
        } else {
            IndexState::Disabled
        };
        let mm_state = if mm_required {
            IndexState::Pending
        } else {
            IndexState::Disabled
        };
        let content_hash = compute_content_hash(
            input.image_blob_hash.as_deref(),
            input.text_content.as_deref(),
        );

        insert_stmt.execute(params![
            id,
            input.resource_id,
            input.unit_index,
            input.image_blob_hash,
            input.image_mime_type,
            input.text_content,
            input.text_source,
            content_hash,
            text_required as i32,
            text_state.as_str(),
            mm_required as i32,
            mm_state.as_str(),
            now,
            now,
        ])?;

        units.push(VfsIndexUnit {
            id,
            resource_id: input.resource_id,
            unit_index: input.unit_index,
            image_blob_hash: input.image_blob_hash,
            image_mime_type: input.image_mime_type,
            text_content: input.text_content,
            text_source: input.text_source,
            content_hash: Some(content_hash),
            text_required,
            text_state,
            text_error: None,
            text_indexed_at: None,
            text_chunk_count: 0,
            text_embedding_dim: None,
            text_profile_id: None,
            text_generation: 0,
            mm_required,
            mm_state,
            mm_error: None,
            mm_indexed_at: None,
            mm_embedding_dim: None,
            mm_profile_id: None,
            mm_generation: 0,
            created_at: now,
            updated_at: now,
        });
    }
    Ok(units)
}

/// 同步资源的 Units（比较 content_hash，增量更新）
///
/// ★ P0-2：内容变更的 Unit 不再"只置 pending、保留旧 segments/profile"。
/// 旧向量对应旧内容，若保留到重索引完成，检索会命中与已更新 `text_content`
/// 不一致的"幽灵结果"。本函数在变更时立即失效旧索引产物（见分支内注释）。
pub fn sync_units(
    conn: &Connection,
    resource_id: &str,
    inputs: Vec<CreateUnitInput>,
) -> Result<SyncUnitsResult, VfsError> {
    // ★ TD-03：整个增量同步包进 SAVEPOINT（可嵌套于外层事务）。
    // 旧实现逐条 create/update/delete 自动提交，中途失败会留下"半套 Units"
    // （部分新建、部分旧 segments 已失效），且孤儿队列写入与业务写不同步。
    // 现在任一步失败即整体回滚，重试从干净状态开始（同步本身按 content_hash
    // 比较，重复执行幂等）。
    conn.execute_batch("SAVEPOINT vfs_sync_units")?;
    match sync_units_inner(conn, resource_id, inputs) {
        Ok(value) => {
            conn.execute_batch("RELEASE SAVEPOINT vfs_sync_units")?;
            Ok(value)
        }
        Err(error) => {
            if let Err(rollback_error) = conn.execute_batch(
                "ROLLBACK TO SAVEPOINT vfs_sync_units;
                 RELEASE SAVEPOINT vfs_sync_units;",
            ) {
                return Err(VfsError::Database(format!(
                    "{}; sync_units rollback failed: {}",
                    error, rollback_error
                )));
            }
            Err(error)
        }
    }
}

fn sync_units_inner(
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
    let mut orphaned_lance_row_ids = Vec::new();

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
                // 内容变化：按模态增量失效。content_hash = hash(image_hash | text)，
                // 变化必然来自 text 侧或 image 侧之一；只失效变化的一侧，
                // 避免"改了一段文字导致整页图片重新过一遍 VL embedding"。
                let text_required = input
                    .text_content
                    .as_ref()
                    .map(|t| !t.is_empty())
                    .unwrap_or(false);
                let mm_required = input.image_blob_hash.is_some();
                let text_changed = existing_unit.text_content != input.text_content
                    || existing_unit.text_required != text_required;
                let image_changed = existing_unit.image_blob_hash != input.image_blob_hash
                    || existing_unit.mm_required != mm_required;

                let mut updated = existing_unit.clone();
                updated.image_blob_hash = input.image_blob_hash;
                updated.image_mime_type = input.image_mime_type;
                updated.text_content = input.text_content;
                updated.text_source = input.text_source;
                updated.content_hash = Some(new_hash);
                updated.text_required = text_required;
                updated.mm_required = mm_required;

                if text_changed {
                    // ★ P0-2：立即失效旧文本索引产物。
                    // - replace_by_unit_and_modality(…, vec![]) 删除旧 segments，
                    //   并把旧 Lance row IDs 同连接写入 __lance_orphan_queue（兜底物理删除）；
                    // - 摘除 text_profile_id 后，generation/profile 对齐检查
                    //   （retain_active_unit_generations）会立刻过滤掉尚未物理删除的旧行。
                    // 权衡：这会产生"重索引完成前该 Unit 文本检索无命中"的短暂空窗，
                    // 但后台 worker 周期为秒级，短空窗远优于长时间返回已过期内容。
                    // 注意 text_generation 保持单调不清零（next_unit_generation 依赖递增语义）。
                    orphaned_lance_row_ids.extend(
                        super::index_segment_repo::list_lance_row_ids_by_unit_and_modality(
                            conn,
                            &existing_unit.id,
                            super::embedding_repo::MODALITY_TEXT,
                        )?,
                    );
                    super::index_segment_repo::replace_by_unit_and_modality(
                        conn,
                        resource_id,
                        &existing_unit.id,
                        super::embedding_repo::MODALITY_TEXT,
                        Vec::new(),
                    )?;
                    updated.text_state = if text_required {
                        IndexState::Pending
                    } else {
                        IndexState::Disabled
                    };
                    updated.text_error = None;
                    updated.text_indexed_at = None;
                    updated.text_chunk_count = 0;
                    updated.text_embedding_dim = None;
                    updated.text_profile_id = None;
                }
                if image_changed {
                    // ★ P0-2 同理：图片变化时旧多模态向量立即失效。
                    // 与 sync_multimodal_units 的 generation 协议一致：
                    // mm_generation 只增不减，仅摘除 profile 指针使旧行不可检索。
                    orphaned_lance_row_ids.extend(
                        super::index_segment_repo::list_lance_row_ids_by_unit_and_modality(
                            conn,
                            &existing_unit.id,
                            super::embedding_repo::MODALITY_MULTIMODAL,
                        )?,
                    );
                    super::index_segment_repo::replace_by_unit_and_modality(
                        conn,
                        resource_id,
                        &existing_unit.id,
                        super::embedding_repo::MODALITY_MULTIMODAL,
                        Vec::new(),
                    )?;
                    updated.mm_state = if mm_required {
                        IndexState::Pending
                    } else {
                        IndexState::Disabled
                    };
                    updated.mm_error = None;
                    updated.mm_indexed_at = None;
                    updated.mm_embedding_dim = None;
                    updated.mm_profile_id = None;
                }

                update(conn, &updated)?;
                result.push(updated);
            }
        } else {
            // 新增 Unit
            let unit = create(conn, input)?;
            result.push(unit);
        }
    }

    // 删除不再存在的 Units。
    // ★ P1-5：孤立 lance_row_ids 直接在本函数内（同一连接/事务）写入
    // __lance_orphan_queue，不再依赖调用方处理返回值——调用方遗漏即孤儿向量。
    for (index, existing_unit) in existing_map {
        if !input_indices.contains(&index) {
            let ids =
                super::index_segment_repo::list_lance_row_ids_by_unit(conn, &existing_unit.id)?;
            for row_id in &ids {
                super::index_segment_repo::enqueue_lance_orphan(conn, row_id, Some(resource_id))?;
            }
            orphaned_lance_row_ids.extend(ids);
            // 上面已显式入队，这里走 unsafe 变体避免重复扫描/入队
            delete_unsafe(conn, &existing_unit.id)?;
        }
    }

    Ok(SyncUnitsResult {
        units: result,
        orphaned_lance_row_ids,
    })
}

/// 同步资源的多模态页面，不覆盖已有 OCR/原生文本派生物。
///
/// 与 `sync_units` 不同，本函数只拥有 Unit 的图片侧字段和 `mm_*` 状态：
/// - 页面图片变化或 `force_rebuild` 时将对应 Unit 置为 pending；
/// - 页面消失时仅禁用该 Unit 的多模态侧，并将旧 Segment 写入孤儿队列；
/// - Unit 的文本字段和文本索引状态始终保留。
pub fn sync_multimodal_units(
    conn: &Connection,
    resource_id: &str,
    inputs: Vec<CreateUnitInput>,
    force_rebuild: bool,
) -> Result<SyncMultimodalUnitsResult, VfsError> {
    let existing = get_by_resource(conn, resource_id)?;
    let existing_map: std::collections::HashMap<i32, VfsIndexUnit> =
        existing.into_iter().map(|u| (u.unit_index, u)).collect();
    let mut seen = std::collections::HashSet::new();
    let mut units = Vec::with_capacity(inputs.len());
    let mut orphaned_lance_row_ids = Vec::new();

    for input in inputs {
        if !seen.insert(input.unit_index) {
            return Err(VfsError::Other(format!(
                "duplicate multimodal page index {} for resource {}",
                input.unit_index, resource_id
            )));
        }
        if input.image_blob_hash.is_none() {
            return Err(VfsError::Other(format!(
                "multimodal page {} for resource {} is missing blob_hash",
                input.unit_index, resource_id
            )));
        }

        if let Some(existing_unit) = existing_map.get(&input.unit_index) {
            let image_changed = existing_unit.image_blob_hash != input.image_blob_hash
                || existing_unit.image_mime_type != input.image_mime_type;
            let mut updated = existing_unit.clone();
            updated.image_blob_hash = input.image_blob_hash;
            updated.image_mime_type = input.image_mime_type;
            updated.mm_required = true;
            if image_changed || force_rebuild {
                // ★ P0（2026-07 修复）：与 sync_units 的失效语义对齐。
                // 旧实现只置 mm_state=pending，保留旧 Segment 与 mm_profile_id——
                // 重索引完成前检索会命中旧图片的向量（幽灵结果）。现在：
                // - replace_by_unit_and_modality(…, vec![]) 删除旧 segments，
                //   并把旧 Lance row IDs 同连接写入 __lance_orphan_queue；
                // - 摘除 mm_profile_id 后，profile/generation 可见性门禁立刻
                //   过滤掉尚未物理删除的旧行；
                // - mm_generation 保持单调不清零（与 generation 协议一致）。
                orphaned_lance_row_ids.extend(
                    super::index_segment_repo::list_lance_row_ids_by_unit_and_modality(
                        conn,
                        &existing_unit.id,
                        super::embedding_repo::MODALITY_MULTIMODAL,
                    )?,
                );
                super::index_segment_repo::replace_by_unit_and_modality(
                    conn,
                    resource_id,
                    &existing_unit.id,
                    super::embedding_repo::MODALITY_MULTIMODAL,
                    Vec::new(),
                )?;
                updated.mm_state = IndexState::Pending;
                updated.mm_error = None;
                updated.mm_indexed_at = None;
                updated.mm_embedding_dim = None;
                updated.mm_profile_id = None;
            }
            update(conn, &updated)?;
            units.push(
                get_by_id(conn, &updated.id)?.ok_or_else(|| VfsError::NotFound {
                    resource_type: "Unit".to_string(),
                    id: updated.id.clone(),
                })?,
            );
        } else {
            units.push(create(conn, input)?);
        }
    }

    for (index, existing_unit) in existing_map {
        if seen.contains(&index) {
            continue;
        }
        let ids = super::index_segment_repo::list_lance_row_ids_by_unit_and_modality(
            conn,
            &existing_unit.id,
            super::embedding_repo::MODALITY_MULTIMODAL,
        )?;
        orphaned_lance_row_ids.extend(ids);
        super::index_segment_repo::replace_by_unit_and_modality(
            conn,
            resource_id,
            &existing_unit.id,
            super::embedding_repo::MODALITY_MULTIMODAL,
            Vec::new(),
        )?;

        let mut updated = existing_unit;
        updated.image_blob_hash = None;
        updated.image_mime_type = None;
        updated.mm_required = false;
        updated.mm_state = IndexState::Disabled;
        updated.mm_error = None;
        updated.mm_indexed_at = None;
        updated.mm_embedding_dim = None;
        update(conn, &updated)?;
    }

    Ok(SyncMultimodalUnitsResult {
        units,
        orphaned_lance_row_ids,
    })
}

/// 清除资源的多模态索引账本，保留 Unit 的文本侧数据。
///
/// ★ P2（2026-07 修复）：不再把 mm_generation 清零。generation 协议要求
/// 单调递增（next_generation 依赖递增语义）；清零后一旦重新启用多模态索引，
/// 新写入的 generation 可能与残留的历史 Segment generation 撞号，
/// 使可见性门禁误放行旧行。摘除 mm_profile_id 已足以让旧行不可检索。
pub fn clear_multimodal_index(conn: &Connection, resource_id: &str) -> Result<i64, VfsError> {
    let removed = super::index_segment_repo::enqueue_and_delete_by_resource_and_modality(
        conn,
        resource_id,
        super::embedding_repo::MODALITY_MULTIMODAL,
    )?;
    let now = now_ms();
    conn.execute(
        "UPDATE vfs_index_units SET
            mm_required = 0,
            mm_state = 'disabled',
            mm_error = NULL,
            mm_indexed_at = NULL,
            mm_embedding_dim = NULL,
            mm_profile_id = NULL,
            updated_at = ?2
         WHERE resource_id = ?1",
        params![resource_id, now],
    )?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ★ 2026-06-12（第二轮审阅）回归测试：purge 索引产物必须级联 + 入列 Lance 队列

    fn setup() -> (tempfile::TempDir, crate::vfs::database::VfsDatabase) {
        crate::vfs::database::setup_migrated_test_db()
    }

    fn seed_resource_with_index(
        conn: &Connection,
        resource_id: &str,
        lance_row_id: &str,
    ) -> String {
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
             VALUES (?1, ?2, 'note', 'inline', 'content', 0, ?3, ?3)",
            params![resource_id, format!("hash_{}", resource_id), now],
        )
        .unwrap();
        let unit_id = format!("unit_{}", resource_id);
        conn.execute(
            "INSERT INTO vfs_index_units (id, resource_id, unit_index, text_content, created_at, updated_at)
             VALUES (?1, ?2, 0, 'text', ?3, ?3)",
            params![unit_id, resource_id, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vfs_index_segments (id, unit_id, segment_index, modality, embedding_dim, lance_row_id, created_at, updated_at)
             VALUES (?1, ?2, 0, 'text', 768, ?3, ?4, ?4)",
            params![format!("seg_{}", resource_id), unit_id, lance_row_id, now],
        )
        .unwrap();
        unit_id
    }

    #[test]
    fn test_purge_index_artifacts_cascades_and_enqueues_lance_rows() {
        let (_tmp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        seed_resource_with_index(&conn, "res_purge_1", "lance_row_a");

        let removed = purge_index_artifacts_by_resource(&conn, "res_purge_1").unwrap();
        assert_eq!(removed, 1, "one unit removed");

        let units: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM vfs_index_units WHERE resource_id = 'res_purge_1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let segments: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM vfs_index_segments WHERE lance_row_id = 'lance_row_a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let queued: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM __lance_orphan_queue WHERE lance_row_id = 'lance_row_a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(units, 0, "units must be deleted");
        assert_eq!(segments, 0, "segments must cascade");
        assert_eq!(queued, 1, "lance row must be enqueued for deletion");
    }

    #[test]
    fn test_sweep_orphan_index_units_only_removes_orphans() {
        let (_tmp, db) = setup();
        let conn = db.get_conn_safe().unwrap();

        // 活资源 + 孤儿资源各一
        seed_resource_with_index(&conn, "res_alive", "lance_alive");
        seed_resource_with_index(&conn, "res_orphan", "lance_orphan");
        // 模拟历史 purge 漏删 index units：直接删 resources 行
        conn.execute("DELETE FROM resources WHERE id = 'res_orphan'", [])
            .unwrap();

        let removed = sweep_orphan_index_units(&conn).unwrap();
        assert_eq!(removed, 1, "only the orphan unit is swept");

        let alive_units: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM vfs_index_units WHERE resource_id = 'res_alive'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(alive_units, 1, "live resource units must survive");

        let queued: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM __lance_orphan_queue WHERE lance_row_id = 'lance_orphan'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(queued, 1, "orphan lance row must be enqueued");
    }

    // ★ P0-2 回归测试：内容变更必须立即失效旧 segments 与 profile 指针
    #[test]
    fn sync_units_content_change_invalidates_stale_segments() {
        let (_tmp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let unit_id = seed_resource_with_index(&conn, "res_sync_change", "lance_stale_text");
        // 模拟"旧内容已完成索引"：indexed 状态 + profile 指针 + 旧 content_hash
        conn.execute(
            "UPDATE vfs_index_units SET text_required = 1, text_state = 'indexed',
                text_profile_id = 'profile_old', text_generation = 3,
                content_hash = 'stale_hash'
             WHERE id = ?1",
            params![unit_id],
        )
        .unwrap();

        let synced = sync_units(
            &conn,
            "res_sync_change",
            vec![CreateUnitInput {
                resource_id: "res_sync_change".to_string(),
                unit_index: 0,
                image_blob_hash: None,
                image_mime_type: None,
                text_content: Some("brand new text".to_string()),
                text_source: Some("native".to_string()),
            }],
        )
        .unwrap();

        let updated = &synced.units[0];
        assert_eq!(updated.text_state, IndexState::Pending);
        assert!(
            updated.text_profile_id.is_none(),
            "stale profile pointer must be removed so old vectors stop matching"
        );
        assert_eq!(
            updated.text_generation, 3,
            "generation counter must stay monotonic"
        );

        let segments: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM vfs_index_segments WHERE unit_id = ?1",
                params![unit_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(segments, 0, "stale segments must be deleted");
        let queued: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM __lance_orphan_queue WHERE lance_row_id = 'lance_stale_text'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(queued, 1, "stale lance row must be enqueued for deletion");
        assert!(synced
            .orphaned_lance_row_ids
            .contains(&"lance_stale_text".to_string()));
    }

    // ★ P0（2026-07）回归测试：图片变化/force_rebuild 必须立即失效旧多模态
    // 索引产物（segments 入孤儿队列 + 摘除 mm_profile_id + generation 单调）
    #[test]
    fn sync_multimodal_image_change_invalidates_stale_segments() {
        let (_tmp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
             VALUES ('res_mm_invalidate', 'hash_mm_invalidate', 'file', 'inline', '', 0, ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vfs_index_units
             (id, resource_id, unit_index, image_blob_hash, image_mime_type, mm_required,
              mm_state, mm_profile_id, mm_generation, created_at, updated_at)
             VALUES ('unit_mm_invalidate', 'res_mm_invalidate', 0, 'blob_old', 'image/png', 1,
                     'indexed', 'profile_old_mm', 2, ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vfs_index_segments
             (id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
              index_profile_id, generation, created_at, updated_at)
             VALUES ('seg_mm_invalidate', 'unit_mm_invalidate', 0, 'multimodal', 1024,
                     'lance_stale_mm', 'profile_old_mm', 2, ?1, ?1)",
            params![now],
        )
        .unwrap();

        let synced = sync_multimodal_units(
            &conn,
            "res_mm_invalidate",
            vec![CreateUnitInput {
                resource_id: "res_mm_invalidate".to_string(),
                unit_index: 0,
                image_blob_hash: Some("blob_new".to_string()),
                image_mime_type: Some("image/png".to_string()),
                text_content: None,
                text_source: None,
            }],
            false,
        )
        .unwrap();

        let updated = &synced.units[0];
        assert_eq!(updated.mm_state, IndexState::Pending);
        assert!(
            updated.mm_profile_id.is_none(),
            "stale mm profile pointer must be removed so old vectors stop matching"
        );
        assert_eq!(
            updated.mm_generation, 2,
            "mm generation must stay monotonic"
        );
        assert!(synced
            .orphaned_lance_row_ids
            .contains(&"lance_stale_mm".to_string()));

        let segments: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM vfs_index_segments WHERE unit_id = 'unit_mm_invalidate'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(segments, 0, "stale mm segments must be deleted");
        let queued: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM __lance_orphan_queue WHERE lance_row_id = 'lance_stale_mm'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            queued, 1,
            "stale mm lance row must be enqueued for deletion"
        );
    }

    // ★ P1（2026-07）回归测试：裸删除默认入孤儿队列
    #[test]
    fn bare_unit_delete_enqueues_lance_orphans() {
        let (_tmp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        seed_resource_with_index(&conn, "res_bare_delete", "lance_bare_delete");

        assert!(delete(&conn, "unit_res_bare_delete").unwrap());
        let queued: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM __lance_orphan_queue WHERE lance_row_id = 'lance_bare_delete'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(queued, 1, "bare unit delete must enqueue lance rows");
    }

    #[test]
    fn sync_multimodal_page_rehashes_image_and_preserves_text() {
        let (_tmp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
             VALUES ('res_mm_rehash', 'resource_hash', 'file', 'inline', '', 0, ?1, ?1)",
            params![now],
        )
        .unwrap();
        let created = create(
            &conn,
            CreateUnitInput {
                resource_id: "res_mm_rehash".to_string(),
                unit_index: 0,
                image_blob_hash: Some("blob_old".to_string()),
                image_mime_type: Some("image/png".to_string()),
                text_content: Some("preserved OCR".to_string()),
                text_source: Some("ocr".to_string()),
            },
        )
        .unwrap();
        let old_hash = created.content_hash.unwrap();

        let synced = sync_multimodal_units(
            &conn,
            "res_mm_rehash",
            vec![CreateUnitInput {
                resource_id: "res_mm_rehash".to_string(),
                unit_index: 0,
                image_blob_hash: Some("blob_new".to_string()),
                image_mime_type: Some("image/webp".to_string()),
                text_content: None,
                text_source: None,
            }],
            false,
        )
        .unwrap();
        let updated = &synced.units[0];
        assert_ne!(updated.content_hash.as_deref(), Some(old_hash.as_str()));
        assert_eq!(updated.text_content.as_deref(), Some("preserved OCR"));
        assert_eq!(updated.mm_state, IndexState::Pending);
    }
}
