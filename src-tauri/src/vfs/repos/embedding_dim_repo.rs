//! VFS 向量维度注册仓库
//!
//! 管理 vfs_embedding_dims 表的 CRUD 操作
//!
//! ## 2026-01 配置化维度管理
//! - 支持手动创建新维度（维度范围 64-8192）
//! - 支持级联删除维度及其关联数据
//! - 移除硬编码维度列表，改为数据库驱动

use crate::vfs::error::VfsError;
use rusqlite::{params, Connection, OptionalExtension, Row};

/// 维度值范围常量
pub const MIN_DIMENSION: i32 = 64;
pub const MAX_DIMENSION: i32 = 8192;

/// 预置常用维度（用于 UI 快捷选择）
pub const PRESET_DIMENSIONS: &[i32] = &[256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096];

/// 维度注册记录
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsEmbeddingDim {
    pub dimension: i32,
    pub modality: String, // "text" | "multimodal"
    pub lance_table_name: String,
    pub record_count: i64,
    pub created_at: i64,
    pub last_used_at: i64,
    /// 绑定的模型配置 ID
    pub model_config_id: Option<String>,
    /// 绑定的模型名称（用于显示）
    pub model_name: Option<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn row_to_dim(row: &Row) -> rusqlite::Result<VfsEmbeddingDim> {
    Ok(VfsEmbeddingDim {
        dimension: row.get("dimension")?,
        modality: row.get("modality")?,
        lance_table_name: row.get("lance_table_name")?,
        record_count: row.get("record_count")?,
        created_at: row.get("created_at")?,
        last_used_at: row.get("last_used_at")?,
        model_config_id: row.get("model_config_id").ok(),
        model_name: row.get("model_name").ok(),
    })
}

/// 生成 LanceDB 表名
///
/// ★ 2026-01 修复：统一使用 vfs_emb_ 前缀，与 VfsLanceStore 保持一致
pub fn generate_lance_table_name(modality: &str, dimension: i32) -> String {
    format!("vfs_emb_{}_{}", modality, dimension)
}

/// 注册新维度（如果已存在则仅更新 last_used_at，保留已有的模型绑定）
pub fn register(
    conn: &Connection,
    dimension: i32,
    modality: &str,
) -> Result<VfsEmbeddingDim, VfsError> {
    let now = now_ms();
    let table_name = generate_lance_table_name(modality, dimension);

    // 与 register_with_model 不同：此版本在 CONFLICT 时仅更新 last_used_at，
    // 不修改 model_config_id 和 model_name（保留已有绑定）
    conn.execute(
        "INSERT INTO vfs_embedding_dims (
            dimension, modality, lance_table_name, record_count, created_at, last_used_at, model_config_id, model_name
        ) VALUES (?1, ?2, ?3, 0, ?4, ?4, NULL, NULL)
        ON CONFLICT(dimension, modality) DO UPDATE SET
            last_used_at = ?4",
        params![dimension, modality, table_name, now],
    )?;

    get_by_key(conn, dimension, modality)?.ok_or_else(|| VfsError::NotFound {
        resource_type: "EmbeddingDim".to_string(),
        id: format!("{}:{}", dimension, modality),
    })
}

/// 注册新维度并绑定模型
pub fn register_with_model(
    conn: &Connection,
    dimension: i32,
    modality: &str,
    model_config_id: Option<&str>,
    model_name: Option<&str>,
) -> Result<VfsEmbeddingDim, VfsError> {
    let now = now_ms();
    let table_name = generate_lance_table_name(modality, dimension);

    // M1 fix: None 保留旧值（COALESCE），非 None 更新新值。
    // 显式解绑请使用 update_model_binding 传空字符串，或新增 clear_model_binding 方法。
    conn.execute(
        "INSERT INTO vfs_embedding_dims (
            dimension, modality, lance_table_name, record_count, created_at, last_used_at, model_config_id, model_name
        ) VALUES (?1, ?2, ?3, 0, ?4, ?4, ?5, ?6)
        ON CONFLICT(dimension, modality) DO UPDATE SET
            last_used_at = ?4,
            model_config_id = COALESCE(?5, model_config_id),
            model_name = COALESCE(?6, model_name)",
        params![dimension, modality, table_name, now, model_config_id, model_name],
    )?;

    get_by_key(conn, dimension, modality)?.ok_or_else(|| VfsError::NotFound {
        resource_type: "EmbeddingDim".to_string(),
        id: format!("{}:{}", dimension, modality),
    })
}

/// 按主键查询
pub fn get_by_key(
    conn: &Connection,
    dimension: i32,
    modality: &str,
) -> Result<Option<VfsEmbeddingDim>, VfsError> {
    let result = conn
        .query_row(
            "SELECT * FROM vfs_embedding_dims WHERE dimension = ?1 AND modality = ?2",
            params![dimension, modality],
            row_to_dim,
        )
        .optional()?;
    Ok(result)
}

/// 查询所有已注册维度
pub fn list_all(conn: &Connection) -> Result<Vec<VfsEmbeddingDim>, VfsError> {
    let mut stmt = conn.prepare("SELECT * FROM vfs_embedding_dims ORDER BY modality, dimension")?;
    let dims = stmt
        .query_map([], row_to_dim)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(dims)
}

/// 按模态查询已注册维度
pub fn list_by_modality(
    conn: &Connection,
    modality: &str,
) -> Result<Vec<VfsEmbeddingDim>, VfsError> {
    let mut stmt =
        conn.prepare("SELECT * FROM vfs_embedding_dims WHERE modality = ?1 ORDER BY dimension")?;
    let dims = stmt
        .query_map(params![modality], row_to_dim)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(dims)
}

/// 更新记录数
pub fn update_count(
    conn: &Connection,
    dimension: i32,
    modality: &str,
    count: i64,
) -> Result<(), VfsError> {
    let now = now_ms();
    conn.execute(
        "UPDATE vfs_embedding_dims SET
            record_count = ?3,
            last_used_at = ?4
        WHERE dimension = ?1 AND modality = ?2",
        params![dimension, modality, count, now],
    )?;
    Ok(())
}

/// 增加记录数
pub fn increment_count(
    conn: &Connection,
    dimension: i32,
    modality: &str,
    delta: i64,
) -> Result<(), VfsError> {
    let now = now_ms();
    conn.execute(
        "UPDATE vfs_embedding_dims SET
            record_count = record_count + ?3,
            last_used_at = ?4
        WHERE dimension = ?1 AND modality = ?2",
        params![dimension, modality, delta, now],
    )?;
    Ok(())
}

/// 减少记录数
pub fn decrement_count(
    conn: &Connection,
    dimension: i32,
    modality: &str,
    delta: i64,
) -> Result<(), VfsError> {
    let now = now_ms();
    conn.execute(
        "UPDATE vfs_embedding_dims SET
            record_count = MAX(0, record_count - ?3),
            last_used_at = ?4
        WHERE dimension = ?1 AND modality = ?2",
        params![dimension, modality, delta, now],
    )?;
    Ok(())
}

/// 删除维度记录
pub fn delete(conn: &Connection, dimension: i32, modality: &str) -> Result<bool, VfsError> {
    let rows = conn.execute(
        "DELETE FROM vfs_embedding_dims WHERE dimension = ?1 AND modality = ?2",
        params![dimension, modality],
    )?;
    Ok(rows > 0)
}

/// 创建新维度（配置化入口）
///
/// 校验维度范围 [MIN_DIMENSION, MAX_DIMENSION]，如果维度已存在则返回现有记录
pub fn create_dimension(
    conn: &Connection,
    dimension: i32,
    modality: &str,
    model_config_id: Option<&str>,
    model_name: Option<&str>,
) -> Result<VfsEmbeddingDim, VfsError> {
    if dimension < MIN_DIMENSION || dimension > MAX_DIMENSION {
        return Err(VfsError::InvalidArgument {
            param: "dimension".to_string(),
            reason: format!(
                "Dimension {} out of valid range [{}, {}]",
                dimension, MIN_DIMENSION, MAX_DIMENSION
            ),
        });
    }

    register_with_model(conn, dimension, modality, model_config_id, model_name)
}

/// 级联删除维度及其关联数据（事务保护）
///
/// 删除顺序：
/// 1. vfs_index_segments 中该维度的所有记录
/// 2. 重置受影响的 vfs_index_units 状态（避免孤儿 units）
/// 3. vfs_embedding_dims 中的维度记录
///
/// S3 fix: 使用事务包裹，确保原子性
/// ★ 审计修复：删除 segments 后重置受影响 units 的状态，防止孤儿 units
///
/// 返回删除的 segment 数量
pub fn delete_dimension_cascade(
    conn: &Connection,
    dimension: i32,
    modality: &str,
) -> Result<usize, VfsError> {
    let tx = conn.unchecked_transaction()?;

    let deleted_segments: usize = tx.execute(
        "DELETE FROM vfs_index_segments WHERE embedding_dim = ?1 AND modality = ?2",
        params![dimension, modality],
    )?;

    // ★ 审计修复：重置受影响 units 的状态，防止孤儿 units
    // 找到不再有任何同模态 segments 的 units，重置其状态为 pending
    let now = now_ms();
    if modality == "multimodal" {
        tx.execute(
            "UPDATE vfs_index_units SET
                mm_state = 'pending',
                mm_embedding_dim = NULL,
                mm_error = NULL,
                updated_at = ?1
            WHERE mm_embedding_dim = ?2
            AND id NOT IN (
                SELECT DISTINCT unit_id FROM vfs_index_segments WHERE modality = 'multimodal'
            )",
            params![now, dimension],
        )?;
    } else {
        tx.execute(
            "UPDATE vfs_index_units SET
                text_state = 'pending',
                text_embedding_dim = NULL,
                text_chunk_count = 0,
                text_error = NULL,
                updated_at = ?1
            WHERE text_embedding_dim = ?2
            AND id NOT IN (
                SELECT DISTINCT unit_id FROM vfs_index_segments WHERE modality = 'text'
            )",
            params![now, dimension],
        )?;
    }

    tx.execute(
        "DELETE FROM vfs_embedding_dims WHERE dimension = ?1 AND modality = ?2",
        params![dimension, modality],
    )?;

    tx.commit()?;

    Ok(deleted_segments)
}

/// 检查是否有正在索引的 units 使用了指定维度
///
/// S8 fix: 删除维度前检查，避免产生孤儿向量数据
pub fn has_indexing_units_for_dimension(
    conn: &Connection,
    dimension: i32,
    modality: &str,
) -> Result<bool, VfsError> {
    let is_multimodal = modality == "multimodal";
    let count: i64 = if is_multimodal {
        conn.query_row(
            "SELECT COUNT(*) FROM vfs_index_units
             WHERE mm_state = 'indexing' AND EXISTS (
                 SELECT 1 FROM vfs_index_segments
                 WHERE vfs_index_segments.unit_id = vfs_index_units.id
                 AND vfs_index_segments.embedding_dim = ?1
                 AND vfs_index_segments.modality = ?2
             )",
            params![dimension, modality],
            |row| row.get(0),
        )?
    } else {
        conn.query_row(
            "SELECT COUNT(*) FROM vfs_index_units
             WHERE text_state = 'indexing' AND EXISTS (
                 SELECT 1 FROM vfs_index_segments
                 WHERE vfs_index_segments.unit_id = vfs_index_units.id
                 AND vfs_index_segments.embedding_dim = ?1
                 AND vfs_index_segments.modality = ?2
             )",
            params![dimension, modality],
            |row| row.get(0),
        )?
    };

    // 也检查 embedding_dim 匹配但还没有 segments 的 indexing units
    let count2: i64 = if is_multimodal {
        conn.query_row(
            "SELECT COUNT(*) FROM vfs_index_units
             WHERE mm_state = 'indexing' AND mm_embedding_dim = ?1",
            params![dimension],
            |row| row.get(0),
        )?
    } else {
        conn.query_row(
            "SELECT COUNT(*) FROM vfs_index_units
             WHERE text_state = 'indexing' AND text_embedding_dim = ?1",
            params![dimension],
            |row| row.get(0),
        )?
    };

    Ok(count > 0 || count2 > 0)
}

/// 获取所有 LanceDB 表名
pub fn list_lance_table_names(conn: &Connection) -> Result<Vec<String>, VfsError> {
    let mut stmt = conn.prepare("SELECT lance_table_name FROM vfs_embedding_dims")?;
    let names = stmt
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(names)
}

/// 更新维度的模型绑定
pub fn update_model_binding(
    conn: &Connection,
    dimension: i32,
    modality: &str,
    model_config_id: &str,
    model_name: &str,
) -> Result<bool, VfsError> {
    let now = now_ms();
    let rows = conn.execute(
        "UPDATE vfs_embedding_dims SET
            model_config_id = ?3,
            model_name = ?4,
            last_used_at = ?5
        WHERE dimension = ?1 AND modality = ?2",
        params![dimension, modality, model_config_id, model_name, now],
    )?;
    Ok(rows > 0)
}

/// M1 fix: 清除维度的模型绑定（设为 NULL）
///
/// 用于显式解绑模型，与 register_with_model 的 COALESCE 行为互补。
pub fn clear_model_binding(
    conn: &Connection,
    dimension: i32,
    modality: &str,
) -> Result<bool, VfsError> {
    let now = now_ms();
    let rows = conn.execute(
        "UPDATE vfs_embedding_dims SET
            model_config_id = NULL,
            model_name = NULL,
            last_used_at = ?3
        WHERE dimension = ?1 AND modality = ?2",
        params![dimension, modality, now],
    )?;
    Ok(rows > 0)
}

/// 按模型配置 ID 查询维度
pub fn list_by_model(
    conn: &Connection,
    model_config_id: &str,
) -> Result<Vec<VfsEmbeddingDim>, VfsError> {
    let mut stmt = conn.prepare(
        "SELECT * FROM vfs_embedding_dims WHERE model_config_id = ?1 ORDER BY modality, dimension",
    )?;
    let dims = stmt
        .query_map(params![model_config_id], row_to_dim)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(dims)
}

/// 查询所有有模型绑定的维度（用于跨维度检索）
pub fn list_with_model_binding(conn: &Connection) -> Result<Vec<VfsEmbeddingDim>, VfsError> {
    let mut stmt = conn.prepare(
        "SELECT * FROM vfs_embedding_dims WHERE model_config_id IS NOT NULL AND record_count > 0 ORDER BY modality, dimension"
    )?;
    let dims = stmt
        .query_map([], row_to_dim)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(dims)
}

/// 根据资源从 Segments 统计并更新所有维度的 record_count
///
/// ★ 审计修复：仅在 record_count > 0 时更新 last_used_at，
/// 避免空维度的 last_used_at 被无意义地刷新
pub fn refresh_counts_from_segments(conn: &Connection) -> Result<(), VfsError> {
    let now = now_ms();

    // 更新所有维度的 record_count，仅在有数据时更新 last_used_at
    conn.execute(
        "UPDATE vfs_embedding_dims SET
            record_count = (
                SELECT COUNT(*) FROM vfs_index_segments
                WHERE vfs_index_segments.modality = vfs_embedding_dims.modality
                AND vfs_index_segments.embedding_dim = vfs_embedding_dims.dimension
            ),
            last_used_at = CASE
                WHEN (
                    SELECT COUNT(*) FROM vfs_index_segments
                    WHERE vfs_index_segments.modality = vfs_embedding_dims.modality
                    AND vfs_index_segments.embedding_dim = vfs_embedding_dims.dimension
                ) > 0 THEN ?1
                ELSE last_used_at
            END",
        params![now],
    )?;

    Ok(())
}

// ============================================================================
// 单元测试
// ============================================================================
#[cfg(test)]
mod tests {
    use super::has_indexing_units_for_dimension;
    use rusqlite::Connection;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("Failed to create in-memory database");
        conn.execute(
            r#"
            CREATE TABLE vfs_index_units (
                id TEXT PRIMARY KEY,
                text_state TEXT NOT NULL,
                text_embedding_dim INTEGER,
                mm_state TEXT NOT NULL,
                mm_embedding_dim INTEGER
            )
            "#,
            [],
        )
        .expect("Failed to create vfs_index_units table");
        conn.execute(
            r#"
            CREATE TABLE vfs_index_segments (
                id TEXT PRIMARY KEY,
                unit_id TEXT NOT NULL,
                modality TEXT NOT NULL,
                embedding_dim INTEGER NOT NULL
            )
            "#,
            [],
        )
        .expect("Failed to create vfs_index_segments table");
        conn
    }

    #[test]
    fn test_has_indexing_units_for_dimension_text() {
        let conn = setup_test_db();
        conn.execute(
            "INSERT INTO vfs_index_units (id, text_state, text_embedding_dim, mm_state, mm_embedding_dim)
             VALUES ('unit_text', 'indexing', NULL, 'disabled', NULL)",
            [],
        )
        .expect("Failed to insert text unit");
        conn.execute(
            "INSERT INTO vfs_index_segments (id, unit_id, modality, embedding_dim)
             VALUES ('seg_text', 'unit_text', 'text', 512)",
            [],
        )
        .expect("Failed to insert text segment");

        let has_text = has_indexing_units_for_dimension(&conn, 512, "text")
            .expect("Failed to query text indexing units");
        let has_mm = has_indexing_units_for_dimension(&conn, 512, "multimodal")
            .expect("Failed to query multimodal indexing units");

        assert!(has_text, "text indexing should be detected");
        assert!(
            !has_mm,
            "multimodal indexing should not be detected for text-only units"
        );
    }

    #[test]
    fn test_has_indexing_units_for_dimension_multimodal() {
        let conn = setup_test_db();
        conn.execute(
            "INSERT INTO vfs_index_units (id, text_state, text_embedding_dim, mm_state, mm_embedding_dim)
             VALUES ('unit_mm', 'disabled', NULL, 'indexing', NULL)",
            [],
        )
        .expect("Failed to insert multimodal unit");
        conn.execute(
            "INSERT INTO vfs_index_segments (id, unit_id, modality, embedding_dim)
             VALUES ('seg_mm', 'unit_mm', 'multimodal', 1024)",
            [],
        )
        .expect("Failed to insert multimodal segment");

        let has_mm = has_indexing_units_for_dimension(&conn, 1024, "multimodal")
            .expect("Failed to query multimodal indexing units");
        let has_text = has_indexing_units_for_dimension(&conn, 1024, "text")
            .expect("Failed to query text indexing units");

        assert!(has_mm, "multimodal indexing should be detected");
        assert!(
            !has_text,
            "text indexing should not be detected for multimodal-only units"
        );
    }

    // 不再基于未知维度进行阻断（避免全局删除受阻）
}
