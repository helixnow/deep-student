//! VFS 文件夹表 CRUD 操作
//!
//! 提供文件夹层级结构的管理，包括：
//! - 文件夹 CRUD 操作
//! - 文件夹内容（folder_items）管理
//! - 递归查询（用于上下文注入）
//!
//! ## 核心方法
//! - `get_folder_ids_recursive`: 递归获取文件夹及子文件夹 ID
//! - `get_items_by_folders`: 批量获取文件夹内容
//! - `get_all_resources`: 聚合文件夹内所有资源（上下文注入用）

use rusqlite::{params, types::ValueRef, Connection, OptionalExtension};
use tracing::{debug, info, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::repos::path_cache_repo::VfsPathCacheRepo;
use crate::vfs::types::{
    FolderResourceInfo, FolderResourcesResult, FolderTreeNode, ResourceLocation, VfsFolder,
    VfsFolderItem,
};

/// 最大文件夹深度限制（契约 F）
const MAX_FOLDER_DEPTH: usize = 10;

/// 最大文件夹数量（契约 F）
const MAX_FOLDERS_COUNT: usize = 500;

/// 批量注入最大资源数（契约 F）
const MAX_INJECT_RESOURCES: usize = 50;

/// 批量SQL操作最大批次大小（HIGH-R001修复：防止SQL过长导致性能问题）
const MAX_BATCH_SIZE: usize = 100;

/// VFS 文件夹表 Repo
pub struct VfsFolderRepo;

fn parse_timestamp_text_to_millis(raw: &str) -> Option<i64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(v) = trimmed.parse::<i64>() {
        // 兼容秒级时间戳
        return Some(if v.abs() < 1_000_000_000_000 {
            v.saturating_mul(1000)
        } else {
            v
        });
    }

    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(trimmed) {
        return Some(dt.timestamp_millis());
    }

    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S") {
        return Some(dt.and_utc().timestamp_millis());
    }

    if let Ok(date) = chrono::NaiveDate::parse_from_str(trimmed, "%Y-%m-%d") {
        return date
            .and_hms_opt(0, 0, 0)
            .map(|dt| dt.and_utc().timestamp_millis());
    }

    None
}

fn read_folder_item_timestamp(
    row: &rusqlite::Row,
    idx: usize,
    column_name: &'static str,
) -> rusqlite::Result<i64> {
    match row.get_ref(idx)? {
        ValueRef::Integer(v) => Ok(v),
        ValueRef::Real(v) => Ok(v as i64),
        ValueRef::Text(bytes) => {
            let raw = std::str::from_utf8(bytes).unwrap_or_default();
            if let Some(ts) = parse_timestamp_text_to_millis(raw) {
                Ok(ts)
            } else {
                warn!(
                    "[VFS::FolderRepo] Invalid {} value in folder_items, fallback to 0: {:?}",
                    column_name, raw
                );
                Ok(0)
            }
        }
        ValueRef::Null => {
            warn!(
                "[VFS::FolderRepo] NULL {} value in folder_items, fallback to 0",
                column_name
            );
            Ok(0)
        }
        ValueRef::Blob(_) => {
            warn!(
                "[VFS::FolderRepo] BLOB {} value in folder_items, fallback to 0",
                column_name
            );
            Ok(0)
        }
    }
}

// ============================================================================
// 批量操作辅助函数
// ============================================================================

/// 分批执行 UPDATE 操作（使用 IN 子句）
///
/// 当数据量超过 MAX_BATCH_SIZE 时自动分批执行，避免 SQL 过长。
///
/// ## 参数
/// - `conn`: 数据库连接
/// - `ids`: 要操作的 ID 列表
/// - `sql_template`: SQL 模板，使用 `{}` 作为 IN 子句占位符
///   例如: `"UPDATE folder_items SET cached_path = NULL WHERE folder_id IN ({})"`
///
/// ## 返回
/// 总共影响的行数
fn execute_update_in_batches(
    conn: &Connection,
    ids: &[String],
    sql_template: &str,
) -> VfsResult<usize> {
    if ids.is_empty() {
        return Ok(0);
    }

    let mut total_affected = 0usize;

    for chunk in ids.chunks(MAX_BATCH_SIZE) {
        let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{}", i)).collect();
        let in_clause = placeholders.join(", ");
        let sql = sql_template.replace("{}", &in_clause);

        let params: Vec<&dyn rusqlite::ToSql> =
            chunk.iter().map(|id| id as &dyn rusqlite::ToSql).collect();

        let affected = conn.execute(&sql, params.as_slice())?;
        total_affected += affected;
    }

    Ok(total_affected)
}

/// 分批执行 SELECT 查询（使用 IN 子句）
///
/// 当 ID 列表超过 MAX_BATCH_SIZE 时自动分批查询并合并结果。
///
/// ## 参数
/// - `conn`: 数据库连接
/// - `ids`: 要查询的 ID 列表
/// - `sql_template`: SQL 模板，使用 `{}` 作为 IN 子句占位符
/// - `row_mapper`: 行映射函数
///
/// ## 返回
/// 合并后的查询结果
fn query_in_batches<T, F>(
    conn: &Connection,
    ids: &[String],
    sql_template: &str,
    row_mapper: F,
) -> VfsResult<Vec<T>>
where
    F: Fn(&rusqlite::Row) -> rusqlite::Result<T>,
{
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut results = Vec::new();

    for chunk in ids.chunks(MAX_BATCH_SIZE) {
        let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{}", i)).collect();
        let in_clause = placeholders.join(", ");
        let sql = sql_template.replace("{}", &in_clause);

        let mut stmt = conn.prepare(&sql)?;

        let params: Vec<&dyn rusqlite::ToSql> =
            chunk.iter().map(|id| id as &dyn rusqlite::ToSql).collect();

        let batch_results = stmt
            .query_map(params.as_slice(), &row_mapper)?
            .collect::<Result<Vec<_>, _>>()?;

        results.extend(batch_results);
    }

    Ok(results)
}

/// 分批执行 DELETE 操作（使用 IN 子句）
///
/// 当数据量超过 MAX_BATCH_SIZE 时自动分批执行，避免 SQL 过长。
///
/// ## 参数
/// - `conn`: 数据库连接
/// - `ids`: 要删除的 ID 列表
/// - `sql_template`: SQL 模板，使用 `{}` 作为 IN 子句占位符
///   例如: `"DELETE FROM folder_items WHERE id IN ({})"`
///
/// ## 返回
/// 总共删除的行数
fn execute_delete_in_batches(
    conn: &Connection,
    ids: &[String],
    sql_template: &str,
) -> VfsResult<usize> {
    if ids.is_empty() {
        return Ok(0);
    }

    let mut total_deleted = 0usize;

    for chunk in ids.chunks(MAX_BATCH_SIZE) {
        let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{}", i)).collect();
        let in_clause = placeholders.join(", ");
        let sql = sql_template.replace("{}", &in_clause);

        let params: Vec<&dyn rusqlite::ToSql> =
            chunk.iter().map(|id| id as &dyn rusqlite::ToSql).collect();

        let deleted = conn.execute(&sql, params.as_slice())?;
        total_deleted += deleted;
    }

    Ok(total_deleted)
}

/// 分批执行带有索引的更新操作（用于 reorder 等需要索引的场景）
///
/// ## 参数
/// - `conn`: 数据库连接
/// - `items`: (id, sort_order) 元组列表
/// - `sql`: UPDATE 语句，如 "UPDATE folders SET sort_order = ?1, updated_at = ?2 WHERE id = ?3"
/// - `now`: 当前时间戳
fn execute_reorder_in_batches(
    conn: &Connection,
    items: &[(String, i32)],
    table: &str,
    now: i64,
) -> VfsResult<usize> {
    if items.is_empty() {
        return Ok(0);
    }

    let mut total_affected = 0usize;

    // 如果数量较少，使用单条 UPDATE 更高效
    if items.len() <= MAX_BATCH_SIZE {
        for (id, sort_order) in items {
            let affected = conn.execute(
                &format!(
                    "UPDATE {} SET sort_order = ?1, updated_at = ?2 WHERE id = ?3",
                    table
                ),
                params![sort_order, now, id],
            )?;
            total_affected += affected;
        }
    } else {
        // 大量数据时使用 CASE WHEN 批量更新
        for chunk in items.chunks(MAX_BATCH_SIZE) {
            // 构建 CASE WHEN 语句
            let mut case_parts = Vec::with_capacity(chunk.len());
            let mut ids = Vec::with_capacity(chunk.len());

            for (id, sort_order) in chunk {
                case_parts.push(format!(
                    "WHEN '{}' THEN {}",
                    id.replace('\'', "''"),
                    sort_order
                ));
                ids.push(format!("'{}'", id.replace('\'', "''")));
            }

            let sql = format!(
                "UPDATE {} SET sort_order = CASE id {} END, updated_at = ?1 WHERE id IN ({})",
                table,
                case_parts.join(" "),
                ids.join(", ")
            );

            let affected = conn.execute(&sql, params![now])?;
            total_affected += affected;
        }
    }

    Ok(total_affected)
}

impl VfsFolderRepo {
    // ========================================================================
    // 文件夹 CRUD
    // ========================================================================

    /// 创建文件夹
    pub fn create_folder(db: &VfsDatabase, folder: &VfsFolder) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::create_folder_with_conn(&conn, folder)
    }

    /// 创建文件夹（使用现有连接）
    pub fn create_folder_with_conn(conn: &Connection, folder: &VfsFolder) -> VfsResult<()> {
        // 检查父文件夹存在性
        if let Some(ref parent_id) = folder.parent_id {
            if !Self::folder_exists_with_conn(conn, parent_id)? {
                return Err(VfsError::InvalidParent {
                    folder_id: parent_id.clone(),
                    reason: "Parent folder does not exist".to_string(),
                });
            }

            // 检查深度限制
            let depth = Self::get_folder_depth_with_conn(conn, parent_id)?;
            if depth >= MAX_FOLDER_DEPTH {
                return Err(VfsError::FolderDepthExceeded {
                    folder_id: folder.id.clone(),
                    current_depth: depth + 1,
                    max_depth: MAX_FOLDER_DEPTH,
                });
            }
        }

        // 检查数量限制
        let count = Self::count_all_folders_with_conn(conn)?;
        if count >= MAX_FOLDERS_COUNT {
            return Err(VfsError::FolderCountExceeded {
                current_count: count,
                max_count: MAX_FOLDERS_COUNT,
            });
        }

        conn.execute(
            r#"
            INSERT INTO folders (id, parent_id, title, icon, color, is_expanded, sort_order, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                folder.id,
                folder.parent_id,
                folder.title,
                folder.icon,
                folder.color,
                folder.is_expanded as i32,
                folder.sort_order,
                folder.created_at,
                folder.updated_at,
            ],
        )?;

        info!("[VFS::FolderRepo] Created folder: {}", folder.id);
        Ok(())
    }

    /// 获取文件夹
    pub fn get_folder(db: &VfsDatabase, folder_id: &str) -> VfsResult<Option<VfsFolder>> {
        let conn = db.get_conn_safe()?;
        Self::get_folder_with_conn(&conn, folder_id)
    }

    /// 获取文件夹（使用现有连接）
    /// ★ P0 修复：使用 CASE typeof() 兼容处理 updated_at/created_at 可能存储为 TEXT 的历史数据
    /// 此函数可能读取已软删除的文件夹（如 restore 路径），需要兼容旧版本写入的 TEXT 类型
    pub fn get_folder_with_conn(
        conn: &Connection,
        folder_id: &str,
    ) -> VfsResult<Option<VfsFolder>> {
        let folder = conn
            .query_row(
                r#"
                SELECT id, parent_id, title, icon, color, is_expanded, is_favorite, sort_order,
                       CASE typeof(created_at) WHEN 'text' THEN CAST(strftime('%s', created_at) AS INTEGER) * 1000 ELSE created_at END,
                       CASE typeof(updated_at) WHEN 'text' THEN CAST(strftime('%s', updated_at) AS INTEGER) * 1000 ELSE updated_at END
                FROM folders
                WHERE id = ?1
                "#,
                params![folder_id],
                |row| {
                    Ok(VfsFolder {
                        id: row.get(0)?,
                        parent_id: row.get(1)?,
                        title: row.get(2)?,
                        icon: row.get(3)?,
                        color: row.get(4)?,
                        is_expanded: row.get::<_, i32>(5)? != 0,
                        is_favorite: row.get::<_, i32>(6)? != 0,
                        sort_order: row.get(7)?,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                    })
                },
            )
            .optional()?;

        Ok(folder)
    }

    /// 检查文件夹是否存在
    pub fn folder_exists(db: &VfsDatabase, folder_id: &str) -> VfsResult<bool> {
        let conn = db.get_conn_safe()?;
        Self::folder_exists_with_conn(&conn, folder_id)
    }

    /// 检查文件夹是否存在（使用现有连接）
    /// ★ 修复：排除已删除的文件夹，防止移动到回收站中的文件夹
    pub fn folder_exists_with_conn(conn: &Connection, folder_id: &str) -> VfsResult<bool> {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM folders WHERE id = ?1 AND deleted_at IS NULL",
            params![folder_id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// 获取文件夹深度
    pub fn get_folder_depth(db: &VfsDatabase, folder_id: &str) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        Self::get_folder_depth_with_conn(&conn, folder_id)
    }

    /// 获取文件夹深度（使用现有连接）
    pub fn get_folder_depth_with_conn(conn: &Connection, folder_id: &str) -> VfsResult<usize> {
        // 使用 CTE 递归计算深度
        let depth: i64 = conn
            .query_row(
                r#"
                WITH RECURSIVE folder_path AS (
                    SELECT id, parent_id, 1 as depth
                    FROM folders WHERE id = ?1
                    UNION ALL
                    SELECT f.id, f.parent_id, fp.depth + 1
                    FROM folders f JOIN folder_path fp ON f.id = fp.parent_id
                    WHERE fp.depth < ?2
                )
                SELECT COALESCE(MAX(depth), 0) FROM folder_path
                "#,
                params![folder_id, MAX_FOLDER_DEPTH + 1],
                |row| row.get(0),
            )
            .unwrap_or(0);

        Ok(depth as usize)
    }

    /// 统计所有文件夹数量
    pub fn count_all_folders(db: &VfsDatabase) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        Self::count_all_folders_with_conn(&conn)
    }

    /// 统计所有文件夹数量（使用现有连接）
    pub fn count_all_folders_with_conn(conn: &Connection) -> VfsResult<usize> {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM folders WHERE deleted_at IS NULL",
            [],
            |row| row.get(0),
        )?;
        Ok(count as usize)
    }

    // ========================================================================
    // ★ Prompt 4: 不依赖 subject 的新方法
    // ========================================================================

    /// 列出所有文件夹（不按 subject 过滤）
    ///
    /// ★ Prompt 4: 新增方法，替代 list_folders_by_subject
    pub fn list_all_folders(db: &VfsDatabase) -> VfsResult<Vec<VfsFolder>> {
        let conn = db.get_conn_safe()?;
        Self::list_all_folders_with_conn(&conn)
    }

    /// 列出所有文件夹（使用现有连接）
    pub fn list_all_folders_with_conn(conn: &Connection) -> VfsResult<Vec<VfsFolder>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, parent_id, title, icon, color, is_expanded, is_favorite, sort_order,
                   CASE typeof(created_at) WHEN 'text' THEN CAST(strftime('%s', created_at) AS INTEGER) * 1000 ELSE created_at END,
                   CASE typeof(updated_at) WHEN 'text' THEN CAST(strftime('%s', updated_at) AS INTEGER) * 1000 ELSE updated_at END
            FROM folders
            WHERE deleted_at IS NULL
            ORDER BY sort_order ASC, created_at ASC
            "#,
        )?;

        let folders = stmt
            .query_map([], |row| {
                Ok(VfsFolder {
                    id: row.get(0)?,
                    parent_id: row.get(1)?,
                    title: row.get(2)?,
                    icon: row.get(3)?,
                    color: row.get(4)?,
                    is_expanded: row.get::<_, i32>(5)? != 0,
                    is_favorite: row.get::<_, i32>(6)? != 0,
                    sort_order: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        debug!(
            "[VFS::FolderRepo] list_all_folders: {} folders",
            folders.len()
        );
        Ok(folders)
    }

    /// 列出指定父文件夹下的子文件夹（不依赖 subject）
    ///
    /// ★ Prompt 4: 新增方法，按父文件夹查询，不依赖 subject
    pub fn list_folders_by_parent(
        db: &VfsDatabase,
        parent_id: Option<&str>,
    ) -> VfsResult<Vec<VfsFolder>> {
        let conn = db.get_conn_safe()?;
        Self::list_folders_by_parent_with_conn(&conn, parent_id)
    }

    /// 列出指定父文件夹下的子文件夹（使用现有连接）
    pub fn list_folders_by_parent_with_conn(
        conn: &Connection,
        parent_id: Option<&str>,
    ) -> VfsResult<Vec<VfsFolder>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, parent_id, title, icon, color, is_expanded, is_favorite, sort_order,
                   CASE typeof(created_at) WHEN 'text' THEN CAST(strftime('%s', created_at) AS INTEGER) * 1000 ELSE created_at END,
                   CASE typeof(updated_at) WHEN 'text' THEN CAST(strftime('%s', updated_at) AS INTEGER) * 1000 ELSE updated_at END
            FROM folders
            WHERE parent_id IS ?1 AND deleted_at IS NULL
            ORDER BY sort_order ASC, created_at ASC
            "#,
        )?;

        let folders = stmt
            .query_map(params![parent_id], |row| {
                Ok(VfsFolder {
                    id: row.get(0)?,
                    parent_id: row.get(1)?,
                    title: row.get(2)?,
                    icon: row.get(3)?,
                    color: row.get(4)?,
                    is_expanded: row.get::<_, i32>(5)? != 0,
                    is_favorite: row.get::<_, i32>(6)? != 0,
                    sort_order: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        debug!(
            "[VFS::FolderRepo] list_folders_by_parent({:?}): {} folders",
            parent_id,
            folders.len()
        );
        Ok(folders)
    }

    /// 获取资源在 VFS 中的定位信息（契约 C3）
    ///
    /// ★ Prompt 4: 核心新增方法，通过 folder_items 定位资源位置
    ///
    /// ## 参数
    /// - `item_type`: 资源类型（note, textbook, exam, translation, essay）
    /// - `item_id`: 资源 ID（如 note_xxx, tb_xxx）
    ///
    /// ## 返回
    /// `ResourceLocation` 包含资源的完整路径信息，如果资源不在 folder_items 中则返回 None
    pub fn get_resource_location(
        db: &VfsDatabase,
        item_type: &str,
        item_id: &str,
    ) -> VfsResult<Option<ResourceLocation>> {
        let conn = db.get_conn_safe()?;
        Self::get_resource_location_with_conn(&conn, item_type, item_id)
    }

    /// 获取资源定位信息（使用现有连接）
    pub fn get_resource_location_with_conn(
        conn: &Connection,
        item_type: &str,
        item_id: &str,
    ) -> VfsResult<Option<ResourceLocation>> {
        // 1. 从 folder_items 查找资源
        let folder_item: Option<VfsFolderItem> = conn
            .query_row(
                r#"
                SELECT id, folder_id, item_type, item_id, sort_order, created_at, cached_path
                FROM folder_items
                WHERE item_type = ?1 AND item_id = ?2 AND deleted_at IS NULL
                "#,
                params![item_type, item_id],
                |row| {
                    Ok(VfsFolderItem {
                        id: row.get(0)?,
                        folder_id: row.get(1)?,
                        item_type: row.get(2)?,
                        item_id: row.get(3)?,
                        sort_order: row.get(4)?,
                        created_at: read_folder_item_timestamp(row, 5, "created_at")?,
                        cached_path: row.get(6)?,
                    })
                },
            )
            .optional()?;

        let folder_item = match folder_item {
            Some(item) => item,
            None => return Ok(None),
        };

        // 2. 获取资源名称
        let name = Self::get_item_title_with_conn(conn, item_type, item_id)?;

        // 3. 获取资源哈希（如有）
        let hash = Self::get_item_hash_with_conn(conn, item_type, item_id)?;

        // 4. 构建路径信息
        let (folder_path, full_path) = if let Some(ref folder_id) = folder_item.folder_id {
            let folder_path = Self::build_folder_path_with_conn(conn, folder_id)?;
            let full_path = if folder_path.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", folder_path, name)
            };
            (folder_path, full_path)
        } else {
            // 根目录
            (String::new(), name.clone())
        };

        Ok(Some(ResourceLocation {
            id: item_id.to_string(),
            resource_type: item_type.to_string(),
            folder_id: folder_item.folder_id,
            folder_path,
            full_path,
            hash,
        }))
    }

    /// 获取资源的内容哈希（用于 ResourceLocation）
    fn get_item_hash_with_conn(
        conn: &Connection,
        item_type: &str,
        item_id: &str,
    ) -> VfsResult<Option<String>> {
        let hash: Option<String> = match item_type {
            "note" => conn
                .query_row(
                    "SELECT r.hash FROM notes n JOIN resources r ON n.resource_id = r.id WHERE n.id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()?,
            "textbook" => conn
                .query_row(
                    "SELECT sha256 FROM files WHERE id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()?,
            "file" => conn
                .query_row(
                    "SELECT sha256 FROM files WHERE id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()?,
            "exam" => conn
                .query_row(
                    "SELECT r.hash FROM exam_sheets e JOIN resources r ON e.resource_id = r.id WHERE e.id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()
                .ok()
                .flatten(),
            "translation" => conn
                .query_row(
                    "SELECT r.hash FROM translations t JOIN resources r ON t.resource_id = r.id WHERE t.id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()?,
            "essay" => conn
                .query_row(
                    "SELECT r.hash FROM essays e JOIN resources r ON e.resource_id = r.id WHERE e.id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()?,
            "mindmap" => conn
                .query_row(
                    "SELECT r.hash FROM mindmaps m JOIN resources r ON m.resource_id = r.id WHERE m.id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()?,
            _ => {
                warn!("[VfsFolderRepo] Unknown item_type for hash: {}", item_type);
                None
            }
        };
        Ok(hash)
    }

    /// 通过 item_id 获取 folder_item（不依赖 subject）
    ///
    /// ★ Prompt 4: 新增方法，替代需要 subject 参数的版本
    pub fn get_folder_item_by_item_id(
        db: &VfsDatabase,
        item_type: &str,
        item_id: &str,
    ) -> VfsResult<Option<VfsFolderItem>> {
        let conn = db.get_conn_safe()?;
        Self::get_folder_item_by_item_id_with_conn(&conn, item_type, item_id)
    }

    /// 通过 item_id 获取 folder_item（使用现有连接）
    ///
    /// ★ 批判性检查修复：添加 deleted_at IS NULL 过滤，排除软删除的项
    pub fn get_folder_item_by_item_id_with_conn(
        conn: &Connection,
        item_type: &str,
        item_id: &str,
    ) -> VfsResult<Option<VfsFolderItem>> {
        let item = conn
            .query_row(
                r#"
                SELECT id, folder_id, item_type, item_id, sort_order, created_at, cached_path
                FROM folder_items
                WHERE item_type = ?1 AND item_id = ?2 AND deleted_at IS NULL
                "#,
                params![item_type, item_id],
                |row| {
                    Ok(VfsFolderItem {
                        id: row.get(0)?,
                        folder_id: row.get(1)?,
                        item_type: row.get(2)?,
                        item_id: row.get(3)?,
                        sort_order: row.get(4)?,
                        created_at: read_folder_item_timestamp(row, 5, "created_at")?,
                        cached_path: row.get(6)?,
                    })
                },
            )
            .optional()?;
        Ok(item)
    }

    /// ★ 2025-12-26: 通过 cached_path（真实路径）查找 folder_item
    ///
    /// 用于支持通过用户在 Learning Hub 中看到的路径查找资源
    pub fn get_folder_item_by_cached_path(
        db: &VfsDatabase,
        cached_path: &str,
    ) -> VfsResult<Option<VfsFolderItem>> {
        let conn = db.get_conn_safe()?;
        Self::get_folder_item_by_cached_path_with_conn(&conn, cached_path)
    }

    /// ★ 2025-12-26: 通过 cached_path（真实路径）查找 folder_item（使用现有连接）
    ///
    /// ★ 批判性检查修复：添加 deleted_at IS NULL 过滤，排除软删除的项
    pub fn get_folder_item_by_cached_path_with_conn(
        conn: &Connection,
        cached_path: &str,
    ) -> VfsResult<Option<VfsFolderItem>> {
        let item = conn
            .query_row(
                r#"
                SELECT id, folder_id, item_type, item_id, sort_order, created_at, cached_path
                FROM folder_items
                WHERE cached_path = ?1 AND deleted_at IS NULL
                "#,
                params![cached_path],
                |row| {
                    Ok(VfsFolderItem {
                        id: row.get(0)?,
                        folder_id: row.get(1)?,
                        item_type: row.get(2)?,
                        item_id: row.get(3)?,
                        sort_order: row.get(4)?,
                        created_at: read_folder_item_timestamp(row, 5, "created_at")?,
                        cached_path: row.get(6)?,
                    })
                },
            )
            .optional()?;
        Ok(item)
    }

    /// 通过 item_id 删除 folder_item（不依赖 subject）
    ///
    /// ★ Prompt 4: 新增方法，替代 remove_item_from_folder
    pub fn remove_item_by_item_id(
        db: &VfsDatabase,
        item_type: &str,
        item_id: &str,
    ) -> VfsResult<bool> {
        let conn = db.get_conn_safe()?;
        Self::remove_item_by_item_id_with_conn(&conn, item_type, item_id)
    }

    /// 通过 item_id 删除 folder_item（使用现有连接）
    pub fn remove_item_by_item_id_with_conn(
        conn: &Connection,
        item_type: &str,
        item_id: &str,
    ) -> VfsResult<bool> {
        let deleted = conn.execute(
            "DELETE FROM folder_items WHERE item_type = ?1 AND item_id = ?2",
            params![item_type, item_id],
        )?;

        if deleted > 0 {
            debug!(
                "[VFS::FolderRepo] Removed folder_item by item_id: {} ({})",
                item_id, item_type
            );
        }
        Ok(deleted > 0)
    }

    /// 获取文件夹内容项（不依赖 subject）
    ///
    /// ★ Prompt 4: 新增方法，只按 folder_id 查询
    pub fn list_items_by_folder(
        db: &VfsDatabase,
        folder_id: Option<&str>,
    ) -> VfsResult<Vec<VfsFolderItem>> {
        let conn = db.get_conn_safe()?;
        Self::list_items_by_folder_with_conn(&conn, folder_id)
    }

    /// 获取文件夹内容项（使用现有连接）
    ///
    /// ★ 批判性检查修复：添加 deleted_at IS NULL 过滤，排除软删除的项
    pub fn list_items_by_folder_with_conn(
        conn: &Connection,
        folder_id: Option<&str>,
    ) -> VfsResult<Vec<VfsFolderItem>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, folder_id, item_type, item_id, sort_order, created_at, cached_path
            FROM folder_items
            WHERE folder_id IS ?1 AND deleted_at IS NULL
            ORDER BY sort_order ASC, created_at ASC
            "#,
        )?;

        let items = stmt
            .query_map(params![folder_id], |row| {
                Ok(VfsFolderItem {
                    id: row.get(0)?,
                    folder_id: row.get(1)?,
                    item_type: row.get(2)?,
                    item_id: row.get(3)?,
                    sort_order: row.get(4)?,
                    created_at: read_folder_item_timestamp(row, 5, "created_at")?,
                    cached_path: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        debug!(
            "[VFS::FolderRepo] list_items_by_folder({:?}): {} items",
            folder_id,
            items.len()
        );
        Ok(items)
    }

    /// 获取所有已分配到文件夹的资源 ID（包括所有文件夹，不只是根级别）
    ///
    /// ★ 用于在根目录列表时排除已分配到任何文件夹的资源
    /// ★ P1-2 修复：过滤 deleted_at IS NULL，避免软删除的资源仍被排除在根目录列表外
    pub fn list_all_assigned_item_ids(
        db: &VfsDatabase,
    ) -> VfsResult<std::collections::HashSet<String>> {
        let conn = db.get_conn_safe()?;
        let mut stmt =
            conn.prepare(r#"SELECT DISTINCT item_id FROM folder_items WHERE deleted_at IS NULL"#)?;

        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<std::collections::HashSet<_>, _>>()?;

        debug!(
            "[VFS::FolderRepo] list_all_assigned_item_ids: {} items",
            ids.len()
        );
        Ok(ids)
    }

    /// 移动内容项到另一个文件夹（不依赖 subject）
    ///
    /// ★ Prompt 4: 新增方法，替代 move_item_to_folder
    pub fn move_item_by_item_id(
        db: &VfsDatabase,
        item_type: &str,
        item_id: &str,
        new_folder_id: Option<&str>,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::move_item_by_item_id_with_conn(&conn, item_type, item_id, new_folder_id)
    }

    /// 移动内容项（使用现有连接，不依赖 subject）
    pub fn move_item_by_item_id_with_conn(
        conn: &Connection,
        item_type: &str,
        item_id: &str,
        new_folder_id: Option<&str>,
    ) -> VfsResult<()> {
        // 检查目标文件夹存在性
        if let Some(folder_id) = new_folder_id {
            if !Self::folder_exists_with_conn(conn, folder_id)? {
                return Err(VfsError::FolderNotFound {
                    folder_id: folder_id.to_string(),
                });
            }
        }

        // 移动时同时清空 cached_path
        let affected = conn.execute(
            "UPDATE folder_items SET folder_id = ?1, cached_path = NULL WHERE item_type = ?2 AND item_id = ?3",
            params![new_folder_id, item_type, item_id],
        )?;

        if affected == 0 {
            return Err(VfsError::ItemNotFound {
                item_type: item_type.to_string(),
                item_id: item_id.to_string(),
            });
        }

        debug!(
            "[VFS::FolderRepo] Moved item {} ({}) to folder {:?}",
            item_id, item_type, new_folder_id
        );
        Ok(())
    }

    /// 批量移动多个内容项到目标文件夹（不依赖 subject）
    ///
    /// ★ HIGH-R001修复：新增批量移动方法，支持大量内容项移动
    ///
    /// ## 参数
    /// - `items`: 要移动的 (item_type, item_id) 列表
    /// - `new_folder_id`: 目标文件夹 ID（None 表示移到根级）
    ///
    /// ## 返回
    /// 成功移动的项数
    pub fn move_items_batch(
        db: &VfsDatabase,
        items: &[(String, String)], // (item_type, item_id)
        new_folder_id: Option<&str>,
    ) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        Self::move_items_batch_with_conn(&conn, items, new_folder_id)
    }

    /// 批量移动多个内容项（使用现有连接）
    pub fn move_items_batch_with_conn(
        conn: &Connection,
        items: &[(String, String)], // (item_type, item_id)
        new_folder_id: Option<&str>,
    ) -> VfsResult<usize> {
        if items.is_empty() {
            return Ok(0);
        }

        // 检查目标文件夹存在性
        if let Some(folder_id) = new_folder_id {
            if !Self::folder_exists_with_conn(conn, folder_id)? {
                return Err(VfsError::FolderNotFound {
                    folder_id: folder_id.to_string(),
                });
            }
        }

        let mut total_affected = 0usize;

        // 按 item_type 分组以优化批量更新
        let mut items_by_type: std::collections::HashMap<&str, Vec<&str>> =
            std::collections::HashMap::new();
        for (item_type, item_id) in items {
            items_by_type
                .entry(item_type.as_str())
                .or_default()
                .push(item_id.as_str());
        }

        // 对每种类型分批执行更新
        for (item_type, item_ids) in items_by_type {
            // 将 &str 转换为 String 以满足 execute_update_in_batches 的要求
            let item_ids_owned: Vec<String> = item_ids.iter().map(|s| s.to_string()).collect();

            for chunk in item_ids_owned.chunks(MAX_BATCH_SIZE) {
                let placeholders: Vec<String> = (1..=chunk.len())
                    .map(|i| format!("?{}", i + 2)) // 从 ?3 开始，?1 是 folder_id，?2 是 item_type
                    .collect();
                let in_clause = placeholders.join(", ");

                let sql = format!(
                    "UPDATE folder_items SET folder_id = ?1, cached_path = NULL WHERE item_type = ?2 AND item_id IN ({})",
                    in_clause
                );

                let mut params: Vec<&dyn rusqlite::ToSql> = vec![
                    &new_folder_id as &dyn rusqlite::ToSql,
                    &item_type as &dyn rusqlite::ToSql,
                ];
                for id in chunk {
                    params.push(id as &dyn rusqlite::ToSql);
                }

                let affected = conn.execute(&sql, params.as_slice())?;
                total_affected += affected;
            }
        }

        debug!(
            "[VFS::FolderRepo] Batch moved {} items to folder {:?} (affected: {})",
            items.len(),
            new_folder_id,
            total_affected
        );

        Ok(total_affected)
    }

    /// 更新文件夹
    pub fn update_folder(db: &VfsDatabase, folder: &VfsFolder) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::update_folder_with_conn(&conn, folder)
    }

    /// 更新文件夹（使用现有连接）
    pub fn update_folder_with_conn(conn: &Connection, folder: &VfsFolder) -> VfsResult<()> {
        let now = chrono::Utc::now().timestamp_millis();

        let affected = conn.execute(
            r#"
            UPDATE folders
            SET parent_id = ?1, title = ?2, icon = ?3, color = ?4, is_expanded = ?5, sort_order = ?6, updated_at = ?7
            WHERE id = ?8
            "#,
            params![
                folder.parent_id,
                folder.title,
                folder.icon,
                folder.color,
                folder.is_expanded as i32,
                folder.sort_order,
                now,
                folder.id,
            ],
        )?;

        if affected == 0 {
            return Err(VfsError::FolderNotFound {
                folder_id: folder.id.clone(),
            });
        }

        // ★ 27-DSTU统一虚拟路径架构改造：更新文件夹（可能涉及重命名）后清空子项的 cached_path
        // 获取该文件夹及所有子文件夹的 ID
        let folder_ids = Self::get_folder_ids_recursive_with_conn(conn, &folder.id)?;
        if !folder_ids.is_empty() {
            // ★ HIGH-R001修复：使用分批处理，支持大型文件夹树
            let cleared = execute_update_in_batches(
                conn,
                &folder_ids,
                "UPDATE folder_items SET cached_path = NULL WHERE folder_id IN ({})",
            )?;
            debug!(
                "[VFS::FolderRepo] Cleared cached_path for {} items after folder update (batched, {} folders)",
                cleared,
                folder_ids.len()
            );

            // ★ 双缓存同步修复：同步清理 path_cache 表（使用批量方法）
            // 如果失败，记录警告但不阻止主操作
            if let Err(e) =
                VfsPathCacheRepo::invalidate_by_folders_batch_with_conn(conn, &folder_ids)
            {
                warn!(
                    "[VFS::FolderRepo] Failed to invalidate path_cache for {} folders: {}",
                    folder_ids.len(),
                    e
                );
            }
        }

        debug!(
            "[VFS::FolderRepo] Updated folder: {} (cached_path cleared for subtree)",
            folder.id
        );
        Ok(())
    }

    /// 删除文件夹（软删除，移到回收站）
    ///
    /// ★ 2025-12-11: 统一语义，delete = 软删除，purge = 永久删除
    /// 设置 deleted_at 字段，文件夹进入回收站。
    /// 级联软删除子文件夹和 folder_items。
    pub fn delete_folder(db: &VfsDatabase, folder_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_folder_with_conn(&conn, folder_id)
    }

    /// 删除文件夹（软删除，使用现有连接）
    /// 🔧 P0-10 修复: 级联软删除子文件夹和内容项
    /// 🔒 事务保证：任一步骤失败都会回滚，避免部分更新
    pub fn delete_folder_with_conn(conn: &Connection, folder_id: &str) -> VfsResult<()> {
        conn.execute_batch("SAVEPOINT vfs_folder_delete_tx")?;

        let result: VfsResult<()> = (|| {
            // ★ P0 修复：deleted_at 是 TEXT 列，updated_at 是 INTEGER 列，必须分开处理
            let now_str = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
            let now_ms = chrono::Utc::now().timestamp_millis();

            // 1. 软删除文件夹本身
            let affected = conn.execute(
                "UPDATE folders SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
                params![now_str, now_ms, folder_id],
            )?;

            if affected == 0 {
                // ★ P0 修复：幂等处理 - 检查文件夹是否已被软删除
                let already_deleted: bool = conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM folders WHERE id = ?1 AND deleted_at IS NOT NULL)",
                        params![folder_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(false);

                if already_deleted {
                    info!(
                        "[VFS::FolderRepo] Folder already deleted (idempotent): {}",
                        folder_id
                    );
                    return Ok(());
                } else {
                    return Err(VfsError::FolderNotFound {
                        folder_id: folder_id.to_string(),
                    });
                }
            }

            // 2. 递归软删除所有子文件夹
            conn.execute(
                r#"
                WITH RECURSIVE descendants AS (
                    SELECT id FROM folders WHERE parent_id = ?1 AND deleted_at IS NULL
                    UNION ALL
                    SELECT f.id FROM folders f
                    INNER JOIN descendants d ON f.parent_id = d.id
                    WHERE f.deleted_at IS NULL
                )
                UPDATE folders SET deleted_at = ?2, updated_at = ?3
                WHERE id IN (SELECT id FROM descendants)
                "#,
                params![folder_id, now_str, now_ms],
            )?;

            // 3. 软删除该文件夹及其所有子文件夹中的内容项（folder_items）
            conn.execute(
                r#"
                WITH RECURSIVE all_folders AS (
                    SELECT ?1 as id
                    UNION ALL
                    SELECT f.id FROM folders f
                    INNER JOIN all_folders af ON f.parent_id = af.id
                )
                UPDATE folder_items SET deleted_at = ?2, updated_at = ?3
                WHERE folder_id IN (SELECT id FROM all_folders) AND deleted_at IS NULL
                "#,
                params![folder_id, now_str, now_ms],
            )?;

            Ok(())
        })();

        match result {
            Ok(()) => {
                conn.execute_batch("RELEASE SAVEPOINT vfs_folder_delete_tx")?;
                info!(
                    "[VFS::FolderRepo] Soft deleted folder with cascade: {}",
                    folder_id
                );
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK TO SAVEPOINT vfs_folder_delete_tx; RELEASE SAVEPOINT vfs_folder_delete_tx;");
                Err(e)
            }
        }
    }

    // ========================================================================
    // 永久删除（purge）
    // ========================================================================

    /// 永久删除文件夹（从数据库彻底删除，不可恢复）
    ///
    /// ★ 2025-12-11: 统一语义，purge = 永久删除
    /// 级联删除子文件夹（由数据库外键约束处理）。
    /// folder_items 中的 folder_id 会被置为 NULL（移到根级）。
    pub fn purge_folder(db: &VfsDatabase, folder_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::purge_folder_with_conn(&conn, folder_id)
    }

    /// 永久删除文件夹（使用现有连接）
    pub fn purge_folder_with_conn(conn: &Connection, folder_id: &str) -> VfsResult<()> {
        let affected = conn.execute("DELETE FROM folders WHERE id = ?1", params![folder_id])?;

        if affected == 0 {
            return Err(VfsError::FolderNotFound {
                folder_id: folder_id.to_string(),
            });
        }

        info!("[VFS::FolderRepo] Purged folder: {}", folder_id);
        Ok(())
    }

    // ========================================================================
    // 兼容别名与恢复（回收站）
    // ========================================================================

    /// 软删除文件夹（兼容旧调用，等同于 delete_folder）
    #[deprecated(note = "使用 delete_folder 替代")]
    pub fn soft_delete_folder(db: &VfsDatabase, folder_id: &str) -> VfsResult<()> {
        Self::delete_folder(db, folder_id)
    }

    /// 软删除文件夹（兼容旧调用，使用现有连接）
    #[deprecated(note = "使用 delete_folder_with_conn 替代")]
    pub fn soft_delete_folder_with_conn(conn: &Connection, folder_id: &str) -> VfsResult<()> {
        Self::delete_folder_with_conn(conn, folder_id)
    }

    /// 恢复软删除的文件夹
    pub fn restore_folder(db: &VfsDatabase, folder_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::restore_folder_with_conn(&conn, folder_id)
    }

    /// 恢复软删除的文件夹（使用现有连接）
    ///
    /// ★ P0-4 修复：级联恢复子文件夹和 folder_items，与 delete_folder_with_conn 语义对称
    /// ★ 批判性检查修复：如果父文件夹仍被删除，将文件夹移到根级避免成为"孤儿"
    /// 如果恢复位置存在同名文件夹，会自动重命名为 "原名 (1)", "原名 (2)" 等
    /// 🔒 事务保证：任一步骤失败都会回滚，避免部分恢复
    pub fn restore_folder_with_conn(conn: &Connection, folder_id: &str) -> VfsResult<()> {
        conn.execute_batch("SAVEPOINT vfs_folder_restore_tx")?;

        let result: VfsResult<()> = (|| {
            let now_ts = chrono::Utc::now().timestamp_millis();

            // 1. 获取要恢复的文件夹信息
            let folder = Self::get_folder_with_conn(conn, folder_id)?.ok_or_else(|| {
                VfsError::FolderNotFound {
                    folder_id: folder_id.to_string(),
                }
            })?;

            // 2. ★ 批判性检查修复：检查父文件夹是否仍被删除
            let target_parent_id = if let Some(ref parent_id) = folder.parent_id {
                let parent_exists_and_active: bool = conn
                    .query_row(
                        "SELECT 1 FROM folders WHERE id = ?1 AND deleted_at IS NULL",
                        params![parent_id],
                        |_| Ok(true),
                    )
                    .optional()?
                    .unwrap_or(false);

                if parent_exists_and_active {
                    Some(parent_id.as_str())
                } else {
                    info!(
                        "[VFS::FolderRepo] Parent folder {} is deleted, moving {} to root",
                        parent_id, folder_id
                    );
                    None
                }
            } else {
                None
            };

            // 3. 检查命名冲突并生成唯一名称（在目标位置检查）
            let new_title = Self::generate_unique_folder_title_with_conn(
                conn,
                &folder.title,
                target_parent_id,
                Some(folder_id),
            )?;

            // 4. 恢复当前文件夹（同时更新标题和 parent_id 如果需要）
            // ★ P0 修复：updated_at 是 INTEGER 列，使用 now_ts（毫秒时间戳）
            let affected = conn.execute(
                "UPDATE folders SET deleted_at = NULL, title = ?1, parent_id = ?2, updated_at = ?3 WHERE id = ?4 AND deleted_at IS NOT NULL",
                params![new_title, target_parent_id, now_ts, folder_id],
            )?;

            if affected == 0 {
                return Err(VfsError::FolderNotFound {
                    folder_id: folder_id.to_string(),
                });
            }

            // 5. 级联恢复所有子文件夹
            // ★ P0 修复：updated_at 是 INTEGER 列，使用 now_ts
            conn.execute(
                r#"
                WITH RECURSIVE descendants AS (
                    SELECT id FROM folders WHERE parent_id = ?1 AND deleted_at IS NOT NULL
                    UNION ALL
                    SELECT f.id FROM folders f
                    INNER JOIN descendants d ON f.parent_id = d.id
                    WHERE f.deleted_at IS NOT NULL
                )
                UPDATE folders SET deleted_at = NULL, updated_at = ?2
                WHERE id IN (SELECT id FROM descendants)
                "#,
                params![folder_id, now_ts],
            )?;

            // 6. 级联恢复该文件夹及其子文件夹中的内容项
            conn.execute(
                r#"
                WITH RECURSIVE all_folders AS (
                    SELECT ?1 as id
                    UNION ALL
                    SELECT f.id FROM folders f
                    INNER JOIN all_folders af ON f.parent_id = af.id
                )
                UPDATE folder_items SET deleted_at = NULL, updated_at = ?2
                WHERE folder_id IN (SELECT id FROM all_folders) AND deleted_at IS NOT NULL
                "#,
                params![folder_id, now_ts],
            )?;

            if new_title != folder.title {
                info!(
                    "[VFS::FolderRepo] Restored folder with cascade and rename: {} -> {} ({})",
                    folder.title, new_title, folder_id
                );
            } else {
                info!(
                    "[VFS::FolderRepo] Restored folder with cascade: {}",
                    folder_id
                );
            }

            Ok(())
        })();

        match result {
            Ok(()) => {
                conn.execute_batch("RELEASE SAVEPOINT vfs_folder_restore_tx")?;
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK TO SAVEPOINT vfs_folder_restore_tx; RELEASE SAVEPOINT vfs_folder_restore_tx;");
                Err(e)
            }
        }
    }

    /// 生成唯一的文件夹标题（避免同名冲突）
    ///
    /// 如果 base_title 已存在，会尝试 "base_title (1)", "base_title (2)" 等
    pub fn generate_unique_folder_title_with_conn(
        conn: &Connection,
        base_title: &str,
        parent_id: Option<&str>,
        exclude_id: Option<&str>,
    ) -> VfsResult<String> {
        // 检查原始标题是否可用
        if !Self::folder_title_exists_with_conn(conn, base_title, parent_id, exclude_id)? {
            return Ok(base_title.to_string());
        }

        // 尝试添加后缀
        for i in 1..100 {
            let new_title = format!("{} ({})", base_title, i);
            if !Self::folder_title_exists_with_conn(conn, &new_title, parent_id, exclude_id)? {
                return Ok(new_title);
            }
        }

        // 极端情况：使用时间戳
        let timestamp = chrono::Utc::now().timestamp_millis();
        Ok(format!("{} ({})", base_title, timestamp))
    }

    /// 检查文件夹标题是否已存在（同一父文件夹下）
    fn folder_title_exists_with_conn(
        conn: &Connection,
        title: &str,
        parent_id: Option<&str>,
        exclude_id: Option<&str>,
    ) -> VfsResult<bool> {
        // ★ 28-DSTU真实路径架构重构：科目不再用于唯一性检查
        // 只检查同一 parent_id 下是否有同名文件夹
        let count: i64 = if let Some(pid) = parent_id {
            if let Some(eid) = exclude_id {
                conn.query_row(
                    "SELECT COUNT(*) FROM folders WHERE title = ?1 AND parent_id = ?2 AND deleted_at IS NULL AND id != ?3",
                    params![title, pid, eid],
                    |row| row.get(0),
                )?
            } else {
                conn.query_row(
                    "SELECT COUNT(*) FROM folders WHERE title = ?1 AND parent_id = ?2 AND deleted_at IS NULL",
                    params![title, pid],
                    |row| row.get(0),
                )?
            }
        } else {
            // 根目录（parent_id IS NULL）
            if let Some(eid) = exclude_id {
                conn.query_row(
                    "SELECT COUNT(*) FROM folders WHERE title = ?1 AND parent_id IS NULL AND deleted_at IS NULL AND id != ?2",
                    params![title, eid],
                    |row| row.get(0),
                )?
            } else {
                conn.query_row(
                    "SELECT COUNT(*) FROM folders WHERE title = ?1 AND parent_id IS NULL AND deleted_at IS NULL",
                    params![title],
                    |row| row.get(0),
                )?
            }
        };
        Ok(count > 0)
    }

    /// 列出已删除的文件夹（回收站）
    pub fn list_deleted_folders(
        db: &VfsDatabase,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsFolder>> {
        let conn = db.get_conn_safe()?;
        Self::list_deleted_folders_with_conn(&conn, limit, offset)
    }

    /// 列出已删除的文件夹（使用现有连接）
    ///
    /// ★ P0 修复：使用 CASE typeof() 兼容处理 updated_at/created_at 可能存储为 TEXT 的历史数据
    pub fn list_deleted_folders_with_conn(
        conn: &Connection,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsFolder>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, parent_id, title, icon, color, is_expanded, is_favorite, sort_order,
                   CASE typeof(created_at) WHEN 'text' THEN CAST(strftime('%s', created_at) AS INTEGER) * 1000 ELSE created_at END,
                   CASE typeof(updated_at) WHEN 'text' THEN CAST(strftime('%s', updated_at) AS INTEGER) * 1000 ELSE updated_at END
            FROM folders
            WHERE deleted_at IS NOT NULL
            ORDER BY deleted_at DESC LIMIT ?1 OFFSET ?2
            "#,
        )?;

        let folders = stmt
            .query_map(params![limit, offset], |row| {
                Ok(VfsFolder {
                    id: row.get(0)?,
                    parent_id: row.get(1)?,
                    title: row.get(2)?,
                    icon: row.get(3)?,
                    color: row.get(4)?,
                    is_expanded: row.get::<_, i32>(5)? != 0,
                    is_favorite: row.get::<_, i32>(6)? != 0,
                    sort_order: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(folders)
    }

    /// 永久删除已软删除的文件夹（清空回收站）
    ///
    /// ★ 2025-12-11: 统一命名规范，purge = 永久删除
    pub fn purge_deleted_folders(db: &VfsDatabase) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        Self::purge_deleted_folders_with_conn(&conn)
    }

    /// 永久删除已软删除的文件夹（使用现有连接）
    pub fn purge_deleted_folders_with_conn(conn: &Connection) -> VfsResult<usize> {
        let deleted = conn.execute("DELETE FROM folders WHERE deleted_at IS NOT NULL", [])?;

        info!("[VFS::FolderRepo] Purged {} deleted folders", deleted);

        Ok(deleted)
    }

    /// 设置文件夹展开状态
    pub fn set_folder_expanded(
        db: &VfsDatabase,
        folder_id: &str,
        is_expanded: bool,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::set_folder_expanded_with_conn(&conn, folder_id, is_expanded)
    }

    /// 设置文件夹展开状态（使用现有连接）
    pub fn set_folder_expanded_with_conn(
        conn: &Connection,
        folder_id: &str,
        is_expanded: bool,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now().timestamp_millis();

        let affected = conn.execute(
            "UPDATE folders SET is_expanded = ?1, updated_at = ?2 WHERE id = ?3",
            params![is_expanded as i32, now, folder_id],
        )?;

        if affected == 0 {
            return Err(VfsError::FolderNotFound {
                folder_id: folder_id.to_string(),
            });
        }

        debug!(
            "[VFS::FolderRepo] Set folder {} expanded: {}",
            folder_id, is_expanded
        );
        Ok(())
    }

    /// 收藏/取消收藏文件夹
    pub fn set_favorite(db: &VfsDatabase, folder_id: &str, favorite: bool) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::set_favorite_with_conn(&conn, folder_id, favorite)
    }

    /// 收藏/取消收藏文件夹（使用现有连接）
    pub fn set_favorite_with_conn(
        conn: &Connection,
        folder_id: &str,
        favorite: bool,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now().timestamp_millis();

        let affected = conn.execute(
            "UPDATE folders SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3",
            params![favorite as i32, now, folder_id],
        )?;

        if affected == 0 {
            return Err(VfsError::FolderNotFound {
                folder_id: folder_id.to_string(),
            });
        }

        info!(
            "[VFS::FolderRepo] Set folder {} favorite: {}",
            folder_id, favorite
        );
        Ok(())
    }

    /// 移动文件夹到新的父文件夹
    pub fn move_folder(
        db: &VfsDatabase,
        folder_id: &str,
        new_parent_id: Option<&str>,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::move_folder_with_conn(&conn, folder_id, new_parent_id)
    }

    /// 移动文件夹到新的父文件夹（使用现有连接）
    pub fn move_folder_with_conn(
        conn: &Connection,
        folder_id: &str,
        new_parent_id: Option<&str>,
    ) -> VfsResult<()> {
        // 1. 检查文件夹存在
        let _folder = Self::get_folder_with_conn(conn, folder_id)?.ok_or_else(|| {
            VfsError::FolderNotFound {
                folder_id: folder_id.to_string(),
            }
        })?;

        // 2. 检查新父文件夹存在性
        if let Some(parent_id) = new_parent_id {
            if !Self::folder_exists_with_conn(conn, parent_id)? {
                return Err(VfsError::InvalidParent {
                    folder_id: parent_id.to_string(),
                    reason: "Target parent folder does not exist".to_string(),
                });
            }

            // 3. 防止循环引用（不能移动到自己的子文件夹下）
            let descendant_ids = Self::get_folder_ids_recursive_with_conn(conn, folder_id)?;
            if descendant_ids.contains(&parent_id.to_string()) {
                return Err(VfsError::InvalidParent {
                    folder_id: parent_id.to_string(),
                    reason: "Cannot move folder to its own descendant".to_string(),
                });
            }

            // 4. 检查移动后深度
            let parent_depth = Self::get_folder_depth_with_conn(conn, parent_id)?;
            let subtree_depth = Self::get_subtree_depth_with_conn(conn, folder_id)?;
            if parent_depth + subtree_depth >= MAX_FOLDER_DEPTH {
                return Err(VfsError::FolderDepthExceeded {
                    folder_id: folder_id.to_string(),
                    current_depth: parent_depth + subtree_depth,
                    max_depth: MAX_FOLDER_DEPTH,
                });
            }
        }

        // 5. 更新
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE folders SET parent_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_parent_id, now, folder_id],
        )?;

        // ★ 27-DSTU统一虚拟路径架构改造：移动文件夹后清空该文件夹及其子文件夹下所有 folder_items 的 cached_path
        // 获取该文件夹及所有子文件夹的 ID
        let folder_ids = Self::get_folder_ids_recursive_with_conn(conn, folder_id)?;
        if !folder_ids.is_empty() {
            // ★ HIGH-R001修复：使用分批处理，支持大型文件夹树
            let cleared = execute_update_in_batches(
                conn,
                &folder_ids,
                "UPDATE folder_items SET cached_path = NULL WHERE folder_id IN ({})",
            )?;
            debug!(
                "[VFS::FolderRepo] Cleared cached_path for {} items in moved folder subtree (batched, {} folders)",
                cleared,
                folder_ids.len()
            );

            // ★ 双缓存同步修复：同步清理 path_cache 表（使用批量方法）
            // 如果失败，记录警告但不阻止主操作
            if let Err(e) =
                VfsPathCacheRepo::invalidate_by_folders_batch_with_conn(conn, &folder_ids)
            {
                warn!(
                    "[VFS::FolderRepo] Failed to invalidate path_cache for {} folders: {}",
                    folder_ids.len(),
                    e
                );
            }
        }

        info!(
            "[VFS::FolderRepo] Moved folder {} to parent {:?} (cached_path cleared for subtree)",
            folder_id, new_parent_id
        );
        Ok(())
    }

    /// 获取子树深度（从指定文件夹到最深子文件夹的层级数）
    fn get_subtree_depth_with_conn(conn: &Connection, folder_id: &str) -> VfsResult<usize> {
        let depth: i64 = conn
            .query_row(
                r#"
                WITH RECURSIVE folder_tree AS (
                    SELECT id, parent_id, 1 as depth
                    FROM folders WHERE id = ?1
                    UNION ALL
                    SELECT f.id, f.parent_id, ft.depth + 1
                    FROM folders f JOIN folder_tree ft ON f.parent_id = ft.id
                    WHERE ft.depth < ?2
                )
                SELECT COALESCE(MAX(depth), 1) FROM folder_tree
                "#,
                params![folder_id, MAX_FOLDER_DEPTH + 1],
                |row| row.get(0),
            )
            .unwrap_or(1);

        Ok(depth as usize)
    }

    // ========================================================================
    // 递归查询（Prompt 4 核心功能）
    // ========================================================================

    /// 递归获取文件夹及其所有子文件夹的 ID
    ///
    /// 使用 CTE 递归查询，限制最大深度为 10 层。
    ///
    /// ## 参数
    /// - `conn`: 数据库连接
    /// - `folder_id`: 起始文件夹 ID
    ///
    /// ## 返回
    /// 文件夹 ID 列表（包含起始文件夹）
    pub fn get_folder_ids_recursive(db: &VfsDatabase, folder_id: &str) -> VfsResult<Vec<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_folder_ids_recursive_with_conn(&conn, folder_id)
    }

    /// 递归获取文件夹 ID（使用现有连接）
    pub fn get_folder_ids_recursive_with_conn(
        conn: &Connection,
        folder_id: &str,
    ) -> VfsResult<Vec<String>> {
        // 使用 CTE 递归查询
        let mut stmt = conn.prepare(
            r#"
            WITH RECURSIVE folder_tree AS (
                SELECT id, parent_id, title, 0 as depth
                FROM folders WHERE id = ?1 AND deleted_at IS NULL
                UNION ALL
                SELECT f.id, f.parent_id, f.title, ft.depth + 1
                FROM folders f JOIN folder_tree ft ON f.parent_id = ft.id
                WHERE ft.depth < ?2 AND f.deleted_at IS NULL
            )
            SELECT id FROM folder_tree
            "#,
        )?;

        let ids = stmt
            .query_map(params![folder_id, MAX_FOLDER_DEPTH], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;

        debug!(
            "[VFS::FolderRepo] get_folder_ids_recursive: {} -> {} folders",
            folder_id,
            ids.len()
        );

        Ok(ids)
    }

    /// 批量获取多个文件夹下的所有内容项
    ///
    /// ## 参数
    /// - `conn`: 数据库连接
    /// - `folder_ids`: 文件夹 ID 列表
    ///
    /// ## 返回
    /// 内容项列表
    pub fn get_items_by_folders(
        db: &VfsDatabase,
        folder_ids: &[String],
    ) -> VfsResult<Vec<VfsFolderItem>> {
        let conn = db.get_conn_safe()?;
        Self::get_items_by_folders_with_conn(&conn, folder_ids)
    }

    /// 批量获取文件夹内容项（使用现有连接）
    ///
    /// ★ HIGH-R001修复：使用分批查询，支持大量文件夹 ID
    pub fn get_items_by_folders_with_conn(
        conn: &Connection,
        folder_ids: &[String],
    ) -> VfsResult<Vec<VfsFolderItem>> {
        if folder_ids.is_empty() {
            return Ok(Vec::new());
        }

        // 使用分批查询辅助函数
        let mut items = query_in_batches(
            conn,
            folder_ids,
            r#"
            SELECT id, folder_id, item_type, item_id, sort_order, created_at, cached_path
            FROM folder_items
            WHERE folder_id IN ({})
              AND deleted_at IS NULL
            "#,
            |row| {
                Ok(VfsFolderItem {
                    id: row.get(0)?,
                    folder_id: row.get(1)?,
                    item_type: row.get(2)?,
                    item_id: row.get(3)?,
                    sort_order: row.get(4)?,
                    created_at: read_folder_item_timestamp(row, 5, "created_at")?,
                    cached_path: row.get(6)?,
                })
            },
        )?;

        // 对合并结果排序（因为分批查询可能打乱顺序）
        items.sort_by(|a, b| {
            a.sort_order
                .cmp(&b.sort_order)
                .then_with(|| a.created_at.cmp(&b.created_at))
        });

        debug!(
            "[VFS::FolderRepo] get_items_by_folders: {} folders -> {} items (batched)",
            folder_ids.len(),
            items.len()
        );

        Ok(items)
    }

    /// 构建文件夹路径
    ///
    /// 从指定文件夹向上追溯到根，构建完整路径字符串。
    ///
    /// ## 返回
    /// 如 "高考复习/函数/一元二次"
    pub fn build_folder_path(db: &VfsDatabase, folder_id: &str) -> VfsResult<String> {
        let conn = db.get_conn_safe()?;
        Self::build_folder_path_with_conn(&conn, folder_id)
    }

    /// 构建文件夹路径（使用现有连接）
    pub fn build_folder_path_with_conn(conn: &Connection, folder_id: &str) -> VfsResult<String> {
        // 使用 CTE 向上追溯到根
        let mut stmt = conn.prepare(
            r#"
            WITH RECURSIVE folder_path AS (
                SELECT id, parent_id, title, 1 as depth
                FROM folders WHERE id = ?1
                UNION ALL
                SELECT f.id, f.parent_id, f.title, fp.depth + 1
                FROM folders f JOIN folder_path fp ON f.id = fp.parent_id
                WHERE fp.depth < ?2
            )
            SELECT title FROM folder_path ORDER BY depth DESC
            "#,
        )?;

        let titles: Vec<String> = stmt
            .query_map(params![folder_id, MAX_FOLDER_DEPTH + 1], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;

        Ok(titles.join("/"))
    }

    /// 构建资源在文件夹树中的完整路径
    ///
    /// ## 参数
    /// - `conn`: 数据库连接
    /// - `item`: 文件夹内容项
    ///
    /// ## 返回
    /// 资源路径，如 "高考复习/函数/笔记标题"
    pub fn build_resource_path(db: &VfsDatabase, item: &VfsFolderItem) -> VfsResult<String> {
        let conn = db.get_conn_safe()?;
        Self::build_resource_path_with_conn(&conn, item)
    }

    /// 构建资源路径（使用现有连接）
    pub fn build_resource_path_with_conn(
        conn: &Connection,
        item: &VfsFolderItem,
    ) -> VfsResult<String> {
        // 获取资源标题
        let title = Self::get_item_title_with_conn(conn, &item.item_type, &item.item_id)?;

        // 获取文件夹路径
        if let Some(ref folder_id) = item.folder_id {
            let folder_path = Self::build_folder_path_with_conn(conn, folder_id)?;
            Ok(format!("{}/{}", folder_path, title))
        } else {
            Ok(title)
        }
    }

    /// 获取资源标题
    fn get_item_title_with_conn(
        conn: &Connection,
        item_type: &str,
        item_id: &str,
    ) -> VfsResult<String> {
        let title: Option<String> = match item_type {
            "note" => conn
                .query_row(
                    "SELECT title FROM notes WHERE id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()?,
            "textbook" => conn
                .query_row(
                    "SELECT file_name FROM files WHERE id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()?,
            "file" => conn
                .query_row(
                    "SELECT file_name FROM files WHERE id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()?,
            "exam" => conn
                .query_row(
                    "SELECT COALESCE(exam_name, id) FROM exam_sheets WHERE id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()?,
            "translation" => conn
                .query_row(
                    "SELECT COALESCE(title, id) FROM translations WHERE id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()?,
            "essay" => conn
                .query_row(
                    "SELECT COALESCE(title, id) FROM essays WHERE id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()?,
            "mindmap" => conn
                .query_row(
                    "SELECT title FROM mindmaps WHERE id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()?,
            _ => {
                warn!("[VfsFolderRepo] Unknown item_type: {}", item_type);
                Some(item_id.to_string())
            }
        };

        Ok(title.unwrap_or_else(|| item_id.to_string()))
    }

    // ========================================================================
    // 聚合查询（上下文注入用）
    // ========================================================================

    /// 获取文件夹内所有资源（用于 Chat V2 上下文注入）
    ///
    /// ## 参数
    /// - `folder_id`: 文件夹 ID
    /// - `include_subfolders`: 是否包含子文件夹
    /// - `include_content`: 是否加载资源内容
    ///
    /// ## 返回
    /// `FolderResourcesResult` 包含文件夹路径和资源列表
    pub fn get_all_resources(
        db: &VfsDatabase,
        folder_id: &str,
        include_subfolders: bool,
        include_content: bool,
    ) -> VfsResult<FolderResourcesResult> {
        let conn = db.get_conn_safe()?;
        Self::get_all_resources_with_conn(&conn, folder_id, include_subfolders, include_content)
    }

    /// 获取文件夹内所有资源（使用现有连接）
    pub fn get_all_resources_with_conn(
        conn: &Connection,
        folder_id: &str,
        include_subfolders: bool,
        include_content: bool,
    ) -> VfsResult<FolderResourcesResult> {
        // 1. 获取文件夹信息
        let folder =
            Self::get_folder_with_conn(conn, folder_id)?.ok_or_else(|| VfsError::NotFound {
                resource_type: "Folder".to_string(),
                id: folder_id.to_string(),
            })?;

        // 2. 构建文件夹路径
        let folder_path = Self::build_folder_path_with_conn(conn, folder_id)?;

        // 3. 获取文件夹 ID 列表
        let folder_ids = if include_subfolders {
            Self::get_folder_ids_recursive_with_conn(conn, folder_id)?
        } else {
            vec![folder_id.to_string()]
        };

        // 4. 获取所有内容项
        let items = Self::get_items_by_folders_with_conn(conn, &folder_ids)?;

        // 5. 检查资源数量限制
        if items.len() > MAX_INJECT_RESOURCES {
            warn!(
                "[VFS::FolderRepo] Folder {} contains {} resources, exceeds limit {}",
                folder_id,
                items.len(),
                MAX_INJECT_RESOURCES
            );
            // 返回结果但标记超限（不截断，让前端决定如何处理）
        }

        // 6. 构建资源信息列表
        let mut resources = Vec::with_capacity(items.len());
        for item in &items {
            let resource_info = Self::build_resource_info_with_conn(conn, item, include_content)?;
            resources.push(resource_info);
        }

        info!(
            "[VFS::FolderRepo] get_all_resources: {} -> {} resources",
            folder_id,
            resources.len()
        );

        Ok(FolderResourcesResult {
            folder_id: folder_id.to_string(),
            folder_title: folder.title,
            path: folder_path,
            total_count: resources.len(),
            resources,
        })
    }

    /// 构建单个资源信息
    fn build_resource_info_with_conn(
        conn: &Connection,
        item: &VfsFolderItem,
        include_content: bool,
    ) -> VfsResult<FolderResourceInfo> {
        let title = Self::get_item_title_with_conn(conn, &item.item_type, &item.item_id)?;
        let path = Self::build_resource_path_with_conn(conn, item)?;

        // 获取 resource_id
        let resource_id =
            Self::get_item_resource_id_with_conn(conn, &item.item_type, &item.item_id)?;

        // 获取内容（如果需要）
        let content = if include_content {
            Self::get_item_content_with_conn(
                conn,
                &item.item_type,
                &item.item_id,
                resource_id.as_deref(),
            )?
        } else {
            None
        };

        Ok(FolderResourceInfo {
            item_type: item.item_type.clone(),
            item_id: item.item_id.clone(),
            resource_id,
            title,
            path,
            content,
        })
    }

    /// 获取资源的 resource_id
    fn get_item_resource_id_with_conn(
        conn: &Connection,
        item_type: &str,
        item_id: &str,
    ) -> VfsResult<Option<String>> {
        let resource_id: Option<String> = match item_type {
            "note" => conn
                .query_row(
                    "SELECT resource_id FROM notes WHERE id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()?,
            "textbook" => conn
                .query_row(
                    "SELECT resource_id FROM files WHERE id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()
                .ok()
                .flatten(),
            "file" => conn
                .query_row(
                    "SELECT resource_id FROM files WHERE id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()
                .ok()
                .flatten(),
            "exam" => conn
                .query_row(
                    "SELECT resource_id FROM exam_sheets WHERE id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()
                .ok()
                .flatten(),
            "translation" => conn
                .query_row(
                    "SELECT resource_id FROM translations WHERE id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()?,
            "essay" => conn
                .query_row(
                    "SELECT resource_id FROM essays WHERE id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()?,
            "mindmap" => conn
                .query_row(
                    "SELECT resource_id FROM mindmaps WHERE id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()?,
            _ => {
                warn!(
                    "[VfsFolderRepo] Unknown item_type for resource_id: {}",
                    item_type
                );
                None
            }
        };

        Ok(resource_id)
    }

    /// 获取资源内容
    fn get_item_content_with_conn(
        conn: &Connection,
        item_type: &str,
        item_id: &str,
        resource_id: Option<&str>,
    ) -> VfsResult<Option<String>> {
        // 优先从 resources 表获取内容
        // ★ 2026-01-30 修复：显式处理 NULL 值，避免 "Invalid column type Null" 错误
        if let Some(res_id) = resource_id {
            let content: Option<String> = conn
                .query_row(
                    "SELECT data FROM resources WHERE id = ?1",
                    params![res_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten();

            if content.is_some() {
                return Ok(content);
            }
        }

        // 根据类型获取内容
        let content: Option<String> = match item_type {
            "note" => None,
            "textbook" => conn
                .query_row(
                    "SELECT file_name || ' (PDF)' FROM files WHERE id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()?,
            "file" => conn
                .query_row(
                    "SELECT file_name || ' (file)' FROM files WHERE id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()?,
            "exam" => conn
                .query_row(
                    "SELECT preview_json FROM exam_sheets WHERE id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()?,
            "translation" => None,
            "essay" => None,
            "mindmap" => None,
            _ => {
                warn!(
                    "[VfsFolderRepo] Unknown item_type for content: {}",
                    item_type
                );
                None
            }
        };

        Ok(content)
    }

    // ========================================================================
    // 内容项管理
    // ========================================================================

    /// 添加内容项到文件夹
    pub fn add_item_to_folder(db: &VfsDatabase, item: &VfsFolderItem) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::add_item_to_folder_with_conn(&conn, item)
    }

    /// 添加内容项（使用现有连接）
    pub fn add_item_to_folder_with_conn(conn: &Connection, item: &VfsFolderItem) -> VfsResult<()> {
        // 位置唯一性：同一个 (item_type, item_id) 在任意时刻只能属于一个 folder_id
        // - 兼容历史迁移中唯一索引缺失/错误导致的重复记录
        // - 与 get_folder_item_by_item_id_with_conn 的“单行假设”保持一致
        conn.execute(
            "DELETE FROM folder_items WHERE item_type = ?1 AND item_id = ?2",
            params![item.item_type, item.item_id],
        )?;

        conn.execute(
            r#"
            INSERT OR REPLACE INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, cached_path)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "#,
            params![
                item.id,
                item.folder_id,
                item.item_type,
                item.item_id,
                item.sort_order,
                item.created_at,
                item.cached_path,
            ],
        )?;

        debug!(
            "[VFS::FolderRepo] Added item {} to folder {:?}",
            item.item_id, item.folder_id
        );
        Ok(())
    }

    // ========================================================================
    // 排序
    // ========================================================================

    /// 重新排序文件夹
    pub fn reorder_folders(db: &VfsDatabase, folder_ids: &[String]) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::reorder_folders_with_conn(&conn, folder_ids)
    }

    /// 重新排序文件夹（使用现有连接）
    ///
    /// ★ HIGH-R001修复：使用分批处理，支持大量文件夹排序
    pub fn reorder_folders_with_conn(conn: &Connection, folder_ids: &[String]) -> VfsResult<()> {
        let now = chrono::Utc::now().timestamp_millis();

        // 构建 (id, sort_order) 列表
        let items: Vec<(String, i32)> = folder_ids
            .iter()
            .enumerate()
            .map(|(index, id)| (id.clone(), index as i32))
            .collect();

        let affected = execute_reorder_in_batches(conn, &items, "folders", now)?;

        debug!(
            "[VFS::FolderRepo] Reordered {} folders (affected: {})",
            folder_ids.len(),
            affected
        );
        Ok(())
    }

    /// 重新排序文件夹内容项
    pub fn reorder_items(
        db: &VfsDatabase,
        _folder_id: Option<&str>,
        item_ids: &[String],
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::reorder_items_with_conn(&conn, _folder_id, item_ids)
    }

    /// 重新排序文件夹内容项（使用现有连接）
    ///
    /// ★ HIGH-R001修复：使用分批处理，支持大量内容项排序
    pub fn reorder_items_with_conn(
        conn: &Connection,
        _folder_id: Option<&str>,
        item_ids: &[String],
    ) -> VfsResult<()> {
        let now = chrono::Utc::now().timestamp_millis();

        // 构建 (id, sort_order) 列表
        let items: Vec<(String, i32)> = item_ids
            .iter()
            .enumerate()
            .map(|(index, id)| (id.clone(), index as i32))
            .collect();

        let affected = execute_reorder_in_batches(conn, &items, "folder_items", now)?;

        debug!(
            "[VFS::FolderRepo] Reordered {} items (affected: {})",
            item_ids.len(),
            affected
        );
        Ok(())
    }

    // ========================================================================
    // 统计
    // ========================================================================

    /// 统计文件夹内的内容数量
    ///
    pub fn count_items_in_folder(db: &VfsDatabase, folder_id: Option<&str>) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        Self::count_items_in_folder_with_conn(&conn, folder_id)
    }

    /// 统计文件夹内的内容数量（使用现有连接）
    pub fn count_items_in_folder_with_conn(
        conn: &Connection,
        folder_id: Option<&str>,
    ) -> VfsResult<usize> {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM folder_items WHERE folder_id IS ?1",
            params![folder_id],
            |row| row.get(0),
        )?;
        Ok(count as usize)
    }

    /// 获取文件夹树
    ///
    pub fn get_folder_tree(db: &VfsDatabase) -> VfsResult<Vec<FolderTreeNode>> {
        let conn = db.get_conn_safe()?;
        Self::get_folder_tree_with_conn(&conn)
    }

    /// 获取文件夹树（使用现有连接）
    pub fn get_folder_tree_with_conn(conn: &Connection) -> VfsResult<Vec<FolderTreeNode>> {
        // 获取所有根级文件夹（parent_id 为 NULL）
        let folders = Self::list_folders_by_parent_with_conn(conn, None)?;

        // 构建树结构
        let root_nodes = Self::build_tree_recursive(&folders, None, conn)?;

        Ok(root_nodes)
    }

    /// 递归构建树结构
    fn build_tree_recursive(
        all_folders: &[VfsFolder],
        parent_id: Option<&str>,
        conn: &Connection,
    ) -> VfsResult<Vec<FolderTreeNode>> {
        let mut nodes = Vec::new();

        for folder in all_folders {
            let folder_parent = folder.parent_id.as_deref();
            if folder_parent == parent_id {
                // 递归获取子节点
                let children = Self::build_tree_recursive(all_folders, Some(&folder.id), conn)?;

                // 获取文件夹内容
                let items = Self::list_items_by_folder_with_conn(conn, Some(&folder.id))?;

                nodes.push(FolderTreeNode {
                    folder: folder.clone(),
                    children,
                    items,
                });
            }
        }

        // 按 sort_order 排序
        nodes.sort_by(|a, b| a.folder.sort_order.cmp(&b.folder.sort_order));

        Ok(nodes)
    }

    // ========================================================================
    // ========================================================================

    /// 获取所有文件夹树（不按 subject 过滤）
    ///
    pub fn get_folder_tree_all(db: &VfsDatabase) -> VfsResult<Vec<FolderTreeNode>> {
        let conn = db.get_conn_safe()?;
        Self::get_folder_tree_all_with_conn(&conn)
    }

    /// 获取所有文件夹树（使用现有连接）
    pub fn get_folder_tree_all_with_conn(conn: &Connection) -> VfsResult<Vec<FolderTreeNode>> {
        // 获取所有文件夹
        let folders = Self::list_all_folders_with_conn(conn)?;

        // 构建树结构
        let root_nodes = Self::build_tree_recursive_all(&folders, None, conn)?;

        Ok(root_nodes)
    }

    /// 递归构建树结构（不按 subject 过滤）
    fn build_tree_recursive_all(
        all_folders: &[VfsFolder],
        parent_id: Option<&str>,
        conn: &Connection,
    ) -> VfsResult<Vec<FolderTreeNode>> {
        let mut nodes = Vec::new();

        for folder in all_folders {
            let folder_parent = folder.parent_id.as_deref();
            if folder_parent == parent_id {
                // 递归获取子节点
                let children = Self::build_tree_recursive_all(all_folders, Some(&folder.id), conn)?;

                // 获取文件夹内容（不按 subject 过滤）
                let items = Self::get_folder_items_all_with_conn(conn, Some(&folder.id))?;

                nodes.push(FolderTreeNode {
                    folder: folder.clone(),
                    children,
                    items,
                });
            }
        }

        // 按 sort_order 排序
        nodes.sort_by(|a, b| a.folder.sort_order.cmp(&b.folder.sort_order));

        Ok(nodes)
    }

    /// 获取文件夹内容项（不按 subject 过滤）
    ///
    pub fn get_folder_items_all(
        db: &VfsDatabase,
        folder_id: Option<&str>,
    ) -> VfsResult<Vec<VfsFolderItem>> {
        let conn = db.get_conn_safe()?;
        Self::get_folder_items_all_with_conn(&conn, folder_id)
    }

    /// 获取文件夹内容项（使用现有连接）
    ///
    /// ★ 批判性检查修复：添加 deleted_at IS NULL 过滤，排除软删除的项
    pub fn get_folder_items_all_with_conn(
        conn: &Connection,
        folder_id: Option<&str>,
    ) -> VfsResult<Vec<VfsFolderItem>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, item_type, item_id, folder_id, sort_order, cached_path, created_at
            FROM folder_items
            WHERE folder_id IS ?1 AND deleted_at IS NULL
            ORDER BY sort_order ASC
            "#,
        )?;

        let items = stmt
            .query_map(params![folder_id], |row| {
                Ok(VfsFolderItem {
                    id: row.get(0)?,
                    item_type: row.get(1)?,
                    item_id: row.get(2)?,
                    folder_id: row.get(3)?,
                    sort_order: row.get(4)?,
                    cached_path: row.get(5)?,
                    created_at: read_folder_item_timestamp(row, 6, "created_at")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(items)
    }

    /// 从文件夹移除内容项
    ///
    /// ★ 迁移011：替代旧的 remove_item_from_folder
    pub fn remove_item_from_folder(
        db: &VfsDatabase,
        item_type: &str,
        item_id: &str,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::remove_item_with_conn(&conn, item_type, item_id)
    }

    /// 移除内容项（使用现有连接）
    pub fn remove_item_with_conn(
        conn: &Connection,
        item_type: &str,
        item_id: &str,
    ) -> VfsResult<()> {
        conn.execute(
            "DELETE FROM folder_items WHERE item_type = ?1 AND item_id = ?2",
            params![item_type, item_id],
        )?;

        debug!("[VFS::FolderRepo] Removed item {} ({})", item_id, item_type);
        Ok(())
    }

    /// 移动内容项到另一个文件夹
    ///
    /// ★ 迁移011：替代旧的 move_item_to_folder
    pub fn move_item_to_folder(
        db: &VfsDatabase,
        item_type: &str,
        item_id: &str,
        new_folder_id: Option<&str>,
    ) -> VfsResult<()> {
        debug!(
            "[VFS::FolderRepo] move_item_to_folder: acquiring db lock for item {}",
            item_id
        );
        let conn = db.get_conn_safe()?;
        debug!(
            "[VFS::FolderRepo] move_item_to_folder: acquired db lock for item {}",
            item_id
        );
        Self::move_item_with_conn(&conn, item_type, item_id, new_folder_id)
    }

    /// 移动内容项（使用现有连接）
    ///
    /// ★ 迁移011：移动后清空 cached_path，下次查询时重新计算
    pub fn move_item_with_conn(
        conn: &Connection,
        item_type: &str,
        item_id: &str,
        new_folder_id: Option<&str>,
    ) -> VfsResult<()> {
        // 检查目标文件夹存在性
        if let Some(folder_id) = new_folder_id {
            if !Self::folder_exists_with_conn(conn, folder_id)? {
                return Err(VfsError::FolderNotFound {
                    folder_id: folder_id.to_string(),
                });
            }
        }

        // ★ 移动时同时清空 cached_path，让其在下次查询时重新计算
        let affected = conn.execute(
            "UPDATE folder_items SET folder_id = ?1, cached_path = NULL WHERE item_type = ?2 AND item_id = ?3",
            params![new_folder_id, item_type, item_id],
        )?;

        if affected == 0 {
            // ★ 修复：根级别的资源可能不在 folder_items 表中
            // 此时应该创建新记录，而不是报错
            debug!(
                "[VFS::FolderRepo] Item {} not in folder_items, inserting new record",
                item_id
            );
            let now = chrono::Utc::now().timestamp_millis();
            // 生成唯一 ID（格式：fi_随机字符串）
            let fi_id = crate::vfs::VfsFolderItem::generate_id();
            conn.execute(
                "INSERT INTO folder_items (id, item_type, item_id, folder_id, sort_order, cached_path, created_at) VALUES (?1, ?2, ?3, ?4, 0, NULL, ?5)",
                params![fi_id, item_type, item_id, new_folder_id, now],
            )?;
        }

        debug!(
            "[VFS::FolderRepo] Moved item {} to folder {:?} (cached_path cleared)",
            item_id, new_folder_id
        );
        Ok(())
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// 创建测试数据库（使用 VfsDatabase::new 自动执行迁移）
    fn setup_test_db() -> (TempDir, VfsDatabase) {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db = VfsDatabase::new(temp_dir.path()).expect("Failed to create database");
        // VfsDatabase::new 已经执行了所有迁移，包括 011_remove_subject
        (temp_dir, db)
    }

    #[test]
    fn test_create_folder() {
        let (_temp_dir, db) = setup_test_db();

        let folder = VfsFolder::new("测试文件夹".to_string(), None, None, None);

        VfsFolderRepo::create_folder(&db, &folder).expect("Failed to create folder");

        // 验证文件夹存在
        let exists = VfsFolderRepo::folder_exists(&db, &folder.id).expect("Failed to check");
        assert!(exists);
    }

    #[test]
    fn test_get_folder() {
        let (_temp_dir, db) = setup_test_db();

        let folder = VfsFolder::new(
            "获取测试".to_string(),
            None,
            Some("📁".to_string()),
            Some("#FF0000".to_string()),
        );

        VfsFolderRepo::create_folder(&db, &folder).expect("Failed to create");

        let retrieved = VfsFolderRepo::get_folder(&db, &folder.id)
            .expect("Failed to get")
            .expect("Folder not found");

        assert_eq!(retrieved.title, "获取测试");
        assert_eq!(retrieved.icon, Some("📁".to_string()));
    }

    #[test]
    fn test_nested_folders_recursive() {
        let (_temp_dir, db) = setup_test_db();

        // 创建嵌套文件夹结构
        let root = VfsFolder::new("根目录".to_string(), None, None, None);
        VfsFolderRepo::create_folder(&db, &root).expect("Failed to create root");

        let child1 = VfsFolder {
            id: VfsFolder::generate_id(),
            parent_id: Some(root.id.clone()),
            title: "子文件夹1".to_string(),
            icon: None,
            color: None,
            is_expanded: true,
            is_favorite: false,
            sort_order: 0,
            created_at: chrono::Utc::now().timestamp_millis(),
            updated_at: chrono::Utc::now().timestamp_millis(),
        };
        VfsFolderRepo::create_folder(&db, &child1).expect("Failed to create child1");

        let grandchild = VfsFolder {
            id: VfsFolder::generate_id(),
            parent_id: Some(child1.id.clone()),
            title: "孙文件夹".to_string(),
            icon: None,
            color: None,
            is_expanded: true,
            is_favorite: false,
            sort_order: 0,
            created_at: chrono::Utc::now().timestamp_millis(),
            updated_at: chrono::Utc::now().timestamp_millis(),
        };
        VfsFolderRepo::create_folder(&db, &grandchild).expect("Failed to create grandchild");

        // 递归查询
        let folder_ids = VfsFolderRepo::get_folder_ids_recursive(&db, &root.id)
            .expect("Failed to get recursive");

        assert_eq!(folder_ids.len(), 3);
        assert!(folder_ids.contains(&root.id));
        assert!(folder_ids.contains(&child1.id));
        assert!(folder_ids.contains(&grandchild.id));
    }

    #[test]
    fn test_build_folder_path() {
        let (_temp_dir, db) = setup_test_db();

        // 创建嵌套文件夹
        let root = VfsFolder::new("高考复习".to_string(), None, None, None);
        VfsFolderRepo::create_folder(&db, &root).expect("Failed");

        let child = VfsFolder {
            id: VfsFolder::generate_id(),
            parent_id: Some(root.id.clone()),
            title: "函数".to_string(),
            icon: None,
            color: None,
            is_expanded: true,
            is_favorite: false,
            sort_order: 0,
            created_at: chrono::Utc::now().timestamp_millis(),
            updated_at: chrono::Utc::now().timestamp_millis(),
        };
        VfsFolderRepo::create_folder(&db, &child).expect("Failed");

        let path = VfsFolderRepo::build_folder_path(&db, &child.id).expect("Failed to build path");
        assert_eq!(path, "高考复习/函数");
    }

    #[test]
    fn test_folder_depth_limit() {
        let (_temp_dir, db) = setup_test_db();

        // 创建深度为 10 的嵌套结构
        let mut parent_id: Option<String> = None;
        for i in 0..MAX_FOLDER_DEPTH {
            let folder = VfsFolder {
                id: VfsFolder::generate_id(),
                parent_id: parent_id.clone(),
                title: format!("层级{}", i + 1),
                icon: None,
                color: None,
                is_expanded: true,
                is_favorite: false,
                sort_order: 0,
                created_at: chrono::Utc::now().timestamp_millis(),
                updated_at: chrono::Utc::now().timestamp_millis(),
            };
            VfsFolderRepo::create_folder(&db, &folder).expect("Failed to create");
            parent_id = Some(folder.id);
        }

        // 尝试创建第 11 层应该失败
        let deep_folder = VfsFolder {
            id: VfsFolder::generate_id(),
            parent_id: parent_id.clone(),
            title: "超深层级".to_string(),
            icon: None,
            color: None,
            is_expanded: true,
            is_favorite: false,
            sort_order: 0,
            created_at: chrono::Utc::now().timestamp_millis(),
            updated_at: chrono::Utc::now().timestamp_millis(),
        };

        let result = VfsFolderRepo::create_folder(&db, &deep_folder);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("FOLDER_DEPTH_EXCEEDED"));
    }

    #[test]
    fn test_get_all_resources_empty() {
        let (_temp_dir, db) = setup_test_db();

        let folder = VfsFolder::new("空文件夹".to_string(), None, None, None);
        VfsFolderRepo::create_folder(&db, &folder).expect("Failed");

        let result =
            VfsFolderRepo::get_all_resources(&db, &folder.id, false, false).expect("Failed");

        assert_eq!(result.folder_id, folder.id);
        assert_eq!(result.folder_title, "空文件夹");
        assert_eq!(result.total_count, 0);
        assert!(result.resources.is_empty());
    }

    #[test]
    fn test_folder_item_crud() {
        let (_temp_dir, db) = setup_test_db();

        // 创建文件夹
        let folder = VfsFolder::new("笔记文件夹".to_string(), None, None, None);
        VfsFolderRepo::create_folder(&db, &folder).expect("Failed");

        // 添加内容项
        let item = VfsFolderItem::new(
            Some(folder.id.clone()),
            "note".to_string(),
            "note_test123".to_string(),
        );
        VfsFolderRepo::add_item_to_folder(&db, &item).expect("Failed to add item");

        // 获取内容项（使用不依赖 subject 的方法）
        let items = VfsFolderRepo::list_items_by_folder(&db, Some(&folder.id)).expect("Failed");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_id, "note_test123");

        // 移动到根级（使用不依赖 subject 的方法）
        VfsFolderRepo::move_item_by_item_id(&db, "note", "note_test123", None)
            .expect("Failed to move");

        let items_after =
            VfsFolderRepo::list_items_by_folder(&db, Some(&folder.id)).expect("Failed");
        assert!(items_after.is_empty());

        // 删除内容项（使用不依赖 subject 的方法）
        VfsFolderRepo::remove_item_by_item_id(&db, "note", "note_test123")
            .expect("Failed to remove");
    }

    #[test]
    fn test_list_items_by_folder_handles_text_created_at() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().expect("Failed to get db connection");

        let folder = VfsFolder::new("附件".to_string(), None, None, None);
        VfsFolderRepo::create_folder_with_conn(&conn, &folder).expect("Failed to create folder");

        conn.execute(
            r#"
            INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, cached_path)
            VALUES (?1, ?2, 'file', 'file_legacy', 0, ?3, '/附件/file_legacy')
            "#,
            rusqlite::params!["fi_legacy_text_ts", folder.id, "2026-03-02T00:00:00.000Z"],
        )
        .expect("Failed to insert legacy folder item");

        let items = VfsFolderRepo::list_items_by_folder_with_conn(&conn, Some(&folder.id))
            .expect("Should read legacy timestamp text");

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_id, "file_legacy");
        assert!(items[0].created_at > 0);
    }
}
