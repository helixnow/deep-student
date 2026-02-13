//! VFS 路径缓存表 CRUD 操作
//!
//! 实现 path_cache 表的管理，提供快速的路径查询和缓存更新机制。
//!
//! ## 核心功能
//! - `get_path`: 从缓存获取路径
//! - `set_path`: 更新缓存条目
//! - `invalidate`: 使缓存失效
//! - `invalidate_by_folder`: 使文件夹下所有缓存失效
//! - `rebuild_all`: 全量重建缓存
//! - `rebuild_folder`: 重建指定文件夹的缓存
//!
//! ## 设计原则（契约 A4, C2）
//! - 路径缓存表独立于 folder_items，支持所有资源类型
//! - 缓存未命中时实时计算路径
//! - 使用 `_with_conn` 版本避免死锁
//! - 批量操作使用事务

use rusqlite::{params, Connection, OptionalExtension};
use tracing::{debug, info, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::repos::folder_repo::VfsFolderRepo;

/// 最大路径长度（约束 D）
const MAX_PATH_LENGTH: usize = 1000;

/// 最大文件夹深度
const MAX_FOLDER_DEPTH: usize = 10;

// ============================================================================
// 契约 C2: 路径缓存条目
// ============================================================================

/// 路径缓存条目（契约 C2）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathCacheEntry {
    /// 资源类型（note, textbook, exam, translation, essay, folder）
    pub item_type: String,
    /// 资源 ID
    pub item_id: String,
    /// 完整路径（如 "/高考复习/函数/note_abc"）
    pub full_path: String,
    /// 文件夹路径（如 "/高考复习/函数"）
    pub folder_path: String,
    /// 缓存更新时间（ISO 8601 格式）
    pub updated_at: String,
}

/// VFS 路径缓存表 Repo
pub struct VfsPathCacheRepo;

impl VfsPathCacheRepo {
    // ========================================================================
    // 表管理（确保表存在）
    // ========================================================================

    /// 确保 path_cache 表存在
    ///
    /// 此方法在使用缓存前调用，确保表已创建（兼容迁移未执行的情况）
    pub fn ensure_table_exists(conn: &Connection) -> VfsResult<()> {
        conn.execute(
            r#"
            CREATE TABLE IF NOT EXISTS path_cache (
                item_type TEXT NOT NULL,
                item_id TEXT NOT NULL,
                full_path TEXT NOT NULL,
                folder_path TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (item_type, item_id)
            )
            "#,
            [],
        )?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_path_cache_path ON path_cache(full_path)",
            [],
        )?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_path_cache_folder ON path_cache(folder_path)",
            [],
        )?;

        Ok(())
    }

    // ========================================================================
    // 缓存读取
    // ========================================================================

    /// 从缓存获取路径
    pub fn get_path(
        db: &VfsDatabase,
        item_type: &str,
        item_id: &str,
    ) -> VfsResult<Option<PathCacheEntry>> {
        let conn = db.get_conn_safe()?;
        Self::get_path_with_conn(&conn, item_type, item_id)
    }

    /// 从缓存获取路径（使用现有连接）
    pub fn get_path_with_conn(
        conn: &Connection,
        item_type: &str,
        item_id: &str,
    ) -> VfsResult<Option<PathCacheEntry>> {
        // 确保表存在
        Self::ensure_table_exists(conn)?;

        let entry = conn
            .query_row(
                r#"
                SELECT item_type, item_id, full_path, folder_path, updated_at
                FROM path_cache
                WHERE item_type = ?1 AND item_id = ?2
                "#,
                params![item_type, item_id],
                |row| {
                    Ok(PathCacheEntry {
                        item_type: row.get(0)?,
                        item_id: row.get(1)?,
                        full_path: row.get(2)?,
                        folder_path: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .optional()?;

        if entry.is_some() {
            debug!("[VFS::PathCacheRepo] Cache hit: {}/{}", item_type, item_id);
        }

        Ok(entry)
    }

    /// 通过完整路径获取缓存条目
    pub fn get_by_full_path(
        db: &VfsDatabase,
        full_path: &str,
    ) -> VfsResult<Option<PathCacheEntry>> {
        let conn = db.get_conn_safe()?;
        Self::get_by_full_path_with_conn(&conn, full_path)
    }

    /// 通过完整路径获取缓存条目（使用现有连接）
    pub fn get_by_full_path_with_conn(
        conn: &Connection,
        full_path: &str,
    ) -> VfsResult<Option<PathCacheEntry>> {
        Self::ensure_table_exists(conn)?;

        let entry = conn
            .query_row(
                r#"
                SELECT item_type, item_id, full_path, folder_path, updated_at
                FROM path_cache
                WHERE full_path = ?1
                "#,
                params![full_path],
                |row| {
                    Ok(PathCacheEntry {
                        item_type: row.get(0)?,
                        item_id: row.get(1)?,
                        full_path: row.get(2)?,
                        folder_path: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .optional()?;

        Ok(entry)
    }

    // ========================================================================
    // 缓存写入
    // ========================================================================

    /// 更新缓存条目
    pub fn set_path(db: &VfsDatabase, entry: &PathCacheEntry) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::set_path_with_conn(&conn, entry)
    }

    /// 更新缓存条目（使用现有连接）
    pub fn set_path_with_conn(conn: &Connection, entry: &PathCacheEntry) -> VfsResult<()> {
        // 确保表存在
        Self::ensure_table_exists(conn)?;

        // 验证路径长度
        if entry.full_path.len() > MAX_PATH_LENGTH {
            return Err(VfsError::InvalidArgument {
                param: "full_path".to_string(),
                reason: format!(
                    "Path too long: {} chars (max {})",
                    entry.full_path.len(),
                    MAX_PATH_LENGTH
                ),
            });
        }

        conn.execute(
            r#"
            INSERT INTO path_cache (item_type, item_id, full_path, folder_path, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(item_type, item_id) DO UPDATE SET
                full_path = excluded.full_path,
                folder_path = excluded.folder_path,
                updated_at = excluded.updated_at
            "#,
            params![
                entry.item_type,
                entry.item_id,
                entry.full_path,
                entry.folder_path,
                entry.updated_at,
            ],
        )?;

        debug!(
            "[VFS::PathCacheRepo] Set cache: {}/{} -> {}",
            entry.item_type, entry.item_id, entry.full_path
        );

        Ok(())
    }

    /// 批量更新缓存条目
    pub fn set_paths_batch(db: &VfsDatabase, entries: &[PathCacheEntry]) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        Self::set_paths_batch_with_conn(&conn, entries)
    }

    /// 批量更新缓存条目（使用现有连接）
    ///
    /// 注意：此方法使用事务保证原子性
    pub fn set_paths_batch_with_conn(
        conn: &Connection,
        entries: &[PathCacheEntry],
    ) -> VfsResult<usize> {
        if entries.is_empty() {
            return Ok(0);
        }

        Self::ensure_table_exists(conn)?;

        // 开始事务
        conn.execute("BEGIN TRANSACTION", [])?;

        let result = (|| -> VfsResult<usize> {
            let mut count = 0;
            for entry in entries {
                if entry.full_path.len() <= MAX_PATH_LENGTH {
                    conn.execute(
                        r#"
                        INSERT INTO path_cache (item_type, item_id, full_path, folder_path, updated_at)
                        VALUES (?1, ?2, ?3, ?4, ?5)
                        ON CONFLICT(item_type, item_id) DO UPDATE SET
                            full_path = excluded.full_path,
                            folder_path = excluded.folder_path,
                            updated_at = excluded.updated_at
                        "#,
                        params![
                            entry.item_type,
                            entry.item_id,
                            entry.full_path,
                            entry.folder_path,
                            entry.updated_at,
                        ],
                    )?;
                    count += 1;
                }
            }
            Ok(count)
        })();

        match result {
            Ok(count) => {
                conn.execute("COMMIT", [])?;
                debug!("[VFS::PathCacheRepo] Batch set {} cache entries", count);
                Ok(count)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    // ========================================================================
    // 缓存失效
    // ========================================================================

    /// 使缓存失效
    pub fn invalidate(db: &VfsDatabase, item_type: &str, item_id: &str) -> VfsResult<bool> {
        let conn = db.get_conn_safe()?;
        Self::invalidate_with_conn(&conn, item_type, item_id)
    }

    /// 使缓存失效（使用现有连接）
    pub fn invalidate_with_conn(
        conn: &Connection,
        item_type: &str,
        item_id: &str,
    ) -> VfsResult<bool> {
        Self::ensure_table_exists(conn)?;

        let affected = conn.execute(
            "DELETE FROM path_cache WHERE item_type = ?1 AND item_id = ?2",
            params![item_type, item_id],
        )?;

        if affected > 0 {
            debug!(
                "[VFS::PathCacheRepo] Invalidated cache: {}/{}",
                item_type, item_id
            );
        }

        Ok(affected > 0)
    }

    /// 使文件夹下所有缓存失效
    ///
    /// 通过查询 folder_items 表获取文件夹下的所有资源，然后删除对应的缓存
    pub fn invalidate_by_folder(db: &VfsDatabase, folder_id: &str) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        Self::invalidate_by_folder_with_conn(&conn, folder_id)
    }

    /// 使文件夹下所有缓存失效（使用现有连接）
    ///
    /// ★ HIGH-R001修复：使用分批处理，支持大型文件夹树
    pub fn invalidate_by_folder_with_conn(conn: &Connection, folder_id: &str) -> VfsResult<usize> {
        Self::ensure_table_exists(conn)?;

        // 1. 获取文件夹及其所有子文件夹的 ID
        let folder_ids = VfsFolderRepo::get_folder_ids_recursive_with_conn(conn, folder_id)?;

        if folder_ids.is_empty() {
            return Ok(0);
        }

        // ★ HIGH-R001修复：使用批量方法处理
        let total_deleted = Self::invalidate_by_folders_batch_with_conn(conn, &folder_ids)?;

        info!(
            "[VFS::PathCacheRepo] Invalidated {} cache entries for folder {}",
            total_deleted, folder_id
        );

        Ok(total_deleted)
    }

    /// 批量使多个文件夹下所有缓存失效
    ///
    /// ★ HIGH-R001新增：支持一次性处理多个文件夹的缓存失效
    pub fn invalidate_by_folders_batch(
        db: &VfsDatabase,
        folder_ids: &[String],
    ) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        Self::invalidate_by_folders_batch_with_conn(&conn, folder_ids)
    }

    /// 批量使多个文件夹下所有缓存失效（使用现有连接）
    ///
    /// ★ HIGH-R001修复：分批处理，避免SQL过长
    pub fn invalidate_by_folders_batch_with_conn(
        conn: &Connection,
        folder_ids: &[String],
    ) -> VfsResult<usize> {
        const BATCH_SIZE: usize = 100;

        if folder_ids.is_empty() {
            return Ok(0);
        }

        Self::ensure_table_exists(conn)?;

        let mut total_deleted = 0usize;

        // 1. 分批删除文件夹自身的缓存
        for chunk in folder_ids.chunks(BATCH_SIZE) {
            let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{}", i)).collect();
            let in_clause = placeholders.join(", ");

            let sql = format!(
                "DELETE FROM path_cache WHERE item_type = 'folder' AND item_id IN ({})",
                in_clause
            );
            let params: Vec<&dyn rusqlite::ToSql> =
                chunk.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
            let deleted = conn.execute(&sql, params.as_slice())?;
            total_deleted += deleted;
        }

        // 2. 分批获取并删除资源的缓存
        for chunk in folder_ids.chunks(BATCH_SIZE) {
            let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{}", i)).collect();
            let in_clause = placeholders.join(", ");

            // 获取该批次文件夹下的所有资源
            let sql = format!(
                "SELECT item_type, item_id FROM folder_items WHERE folder_id IN ({})",
                in_clause
            );
            let params: Vec<&dyn rusqlite::ToSql> =
                chunk.iter().map(|id| id as &dyn rusqlite::ToSql).collect();

            let mut stmt = conn.prepare(&sql)?;
            let items: Vec<(String, String)> = stmt
                .query_map(params.as_slice(), |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;

            // 按 item_type 分组以优化删除
            let mut items_by_type: std::collections::HashMap<String, Vec<String>> =
                std::collections::HashMap::new();
            for (item_type, item_id) in items {
                items_by_type.entry(item_type).or_default().push(item_id);
            }

            // 分批删除每种类型的资源缓存
            for (item_type, item_ids) in items_by_type {
                for item_chunk in item_ids.chunks(BATCH_SIZE) {
                    let placeholders: Vec<String> = (1..=item_chunk.len())
                        .map(|i| format!("?{}", i + 1)) // 从 ?2 开始，?1 是 item_type
                        .collect();
                    let in_clause = placeholders.join(", ");

                    let sql = format!(
                        "DELETE FROM path_cache WHERE item_type = ?1 AND item_id IN ({})",
                        in_clause
                    );

                    let mut params: Vec<&dyn rusqlite::ToSql> =
                        vec![&item_type as &dyn rusqlite::ToSql];
                    for id in item_chunk {
                        params.push(id as &dyn rusqlite::ToSql);
                    }

                    let deleted = conn.execute(&sql, params.as_slice())?;
                    total_deleted += deleted;
                }
            }
        }

        debug!(
            "[VFS::PathCacheRepo] Batch invalidated {} cache entries for {} folders",
            total_deleted,
            folder_ids.len()
        );

        Ok(total_deleted)
    }

    /// 通过路径前缀使缓存失效
    pub fn invalidate_by_path_prefix(db: &VfsDatabase, path_prefix: &str) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        Self::invalidate_by_path_prefix_with_conn(&conn, path_prefix)
    }

    /// 通过路径前缀使缓存失效（使用现有连接）
    pub fn invalidate_by_path_prefix_with_conn(
        conn: &Connection,
        path_prefix: &str,
    ) -> VfsResult<usize> {
        Self::ensure_table_exists(conn)?;

        // 使用 LIKE 匹配前缀
        let pattern = format!("{}%", path_prefix);
        let affected = conn.execute(
            "DELETE FROM path_cache WHERE full_path LIKE ?1 OR folder_path LIKE ?1",
            params![pattern],
        )?;

        info!(
            "[VFS::PathCacheRepo] Invalidated {} cache entries with prefix: {}",
            affected, path_prefix
        );

        Ok(affected)
    }

    // ========================================================================
    // 缓存重建
    // ========================================================================

    /// 全量重建缓存
    ///
    /// 遍历所有 folder_items 和 folders，重建完整的路径缓存
    pub fn rebuild_all(db: &VfsDatabase) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        Self::rebuild_all_with_conn(&conn)
    }

    /// 全量重建缓存（使用现有连接）
    ///
    /// 注意：此方法使用事务保证原子性
    pub fn rebuild_all_with_conn(conn: &Connection) -> VfsResult<usize> {
        Self::ensure_table_exists(conn)?;

        info!("[VFS::PathCacheRepo] Starting full cache rebuild...");

        // 开始事务
        conn.execute("BEGIN TRANSACTION", [])?;

        let result = (|| -> VfsResult<usize> {
            // 1. 清空现有缓存
            conn.execute("DELETE FROM path_cache", [])?;

            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
            let mut total_count = 0;

            // 2. 重建文件夹缓存
            let folder_count = Self::rebuild_folders_cache_with_conn(conn, &now)?;
            total_count += folder_count;

            // 3. 重建资源缓存
            let resource_count = Self::rebuild_resources_cache_with_conn(conn, &now)?;
            total_count += resource_count;

            Ok(total_count)
        })();

        match result {
            Ok(total_count) => {
                conn.execute("COMMIT", [])?;
                info!(
                    "[VFS::PathCacheRepo] Full cache rebuild complete: {} entries",
                    total_count
                );
                Ok(total_count)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                warn!(
                    "[VFS::PathCacheRepo] Full cache rebuild failed, rolled back: {}",
                    e
                );
                Err(e)
            }
        }
    }

    /// 重建指定文件夹的缓存
    pub fn rebuild_folder(db: &VfsDatabase, folder_id: &str) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        Self::rebuild_folder_with_conn(&conn, folder_id)
    }

    /// 重建指定文件夹的缓存（使用现有连接）
    pub fn rebuild_folder_with_conn(conn: &Connection, folder_id: &str) -> VfsResult<usize> {
        Self::ensure_table_exists(conn)?;

        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        // 1. 获取文件夹及其所有子文件夹的 ID
        let folder_ids = VfsFolderRepo::get_folder_ids_recursive_with_conn(conn, folder_id)?;

        if folder_ids.is_empty() {
            warn!(
                "[VFS::PathCacheRepo] Folder not found or empty: {}",
                folder_id
            );
            return Ok(0);
        }

        let mut total_count = 0;

        // 2. 重建文件夹自身的缓存
        for fid in &folder_ids {
            if let Ok(Some(_folder)) = VfsFolderRepo::get_folder_with_conn(conn, fid) {
                let folder_path = Self::compute_folder_path_with_conn(conn, fid)?;
                let full_path = format!("/{}", folder_path);

                // 提取父路径
                let parent_path = if let Some(pos) = folder_path.rfind('/') {
                    format!("/{}", &folder_path[..pos])
                } else {
                    "/".to_string()
                };

                let entry = PathCacheEntry {
                    item_type: "folder".to_string(),
                    item_id: fid.clone(),
                    full_path,
                    folder_path: parent_path,
                    updated_at: now.clone(),
                };

                Self::set_path_with_conn(conn, &entry)?;
                total_count += 1;
            }
        }

        // 3. 重建文件夹下资源的缓存（只处理未删除的资源）
        let placeholders: Vec<String> = (1..=folder_ids.len()).map(|i| format!("?{}", i)).collect();
        let in_clause = placeholders.join(", ");

        // 通过 LEFT JOIN 各资源表检查 deleted_at 字段，只为未删除的资源创建缓存
        let sql = format!(
            r#"
            SELECT fi.item_type, fi.item_id, fi.folder_id
            FROM folder_items fi
            LEFT JOIN notes n ON fi.item_type = 'note' AND fi.item_id = n.id
            LEFT JOIN files f ON fi.item_type = 'textbook' AND fi.item_id = f.id
            LEFT JOIN exam_sheets e ON fi.item_type = 'exam' AND fi.item_id = e.id
            LEFT JOIN translations t ON fi.item_type = 'translation' AND fi.item_id = t.id
            LEFT JOIN essays es ON fi.item_type = 'essay' AND fi.item_id = es.id
            WHERE fi.folder_id IN ({}) AND (
                (fi.item_type = 'note' AND n.id IS NOT NULL AND (n.deleted_at IS NULL OR n.deleted_at = '')) OR
                (fi.item_type = 'textbook' AND f.id IS NOT NULL AND (f.deleted_at IS NULL OR f.deleted_at = '')) OR
                (fi.item_type = 'exam' AND e.id IS NOT NULL AND (e.deleted_at IS NULL OR e.deleted_at = '')) OR
                (fi.item_type = 'translation' AND t.id IS NOT NULL AND (t.deleted_at IS NULL OR t.deleted_at = '')) OR
                (fi.item_type = 'essay' AND es.id IS NOT NULL AND (es.deleted_at IS NULL OR es.deleted_at = ''))
            )
            "#,
            in_clause
        );

        let params: Vec<&dyn rusqlite::ToSql> = folder_ids
            .iter()
            .map(|id| id as &dyn rusqlite::ToSql)
            .collect();

        let mut stmt = conn.prepare(&sql)?;
        let items: Vec<(String, String, Option<String>)> = stmt
            .query_map(params.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        for (item_type, item_id, item_folder_id) in items {
            if let Ok(entry) = Self::compute_resource_cache_entry_with_conn(
                conn,
                &item_type,
                &item_id,
                item_folder_id.as_deref(),
                &now,
            ) {
                Self::set_path_with_conn(conn, &entry)?;
                total_count += 1;
            }
        }

        info!(
            "[VFS::PathCacheRepo] Rebuilt {} cache entries for folder {}",
            total_count, folder_id
        );

        Ok(total_count)
    }

    // ========================================================================
    // 内部辅助方法
    // ========================================================================

    /// 重建所有文件夹的缓存
    fn rebuild_folders_cache_with_conn(conn: &Connection, now: &str) -> VfsResult<usize> {
        // 获取所有文件夹
        let mut stmt = conn.prepare("SELECT id FROM folders WHERE deleted_at IS NULL")?;

        let folder_ids: Vec<String> = stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;

        let mut count = 0;
        for folder_id in folder_ids {
            let folder_path = Self::compute_folder_path_with_conn(conn, &folder_id)?;
            let full_path = format!("/{}", folder_path);

            // 提取父路径
            let parent_path = if let Some(pos) = folder_path.rfind('/') {
                format!("/{}", &folder_path[..pos])
            } else {
                "/".to_string()
            };

            let entry = PathCacheEntry {
                item_type: "folder".to_string(),
                item_id: folder_id,
                full_path,
                folder_path: parent_path,
                updated_at: now.to_string(),
            };

            if entry.full_path.len() <= MAX_PATH_LENGTH {
                Self::set_path_with_conn(conn, &entry)?;
                count += 1;
            }
        }

        Ok(count)
    }

    /// 重建所有资源的缓存
    fn rebuild_resources_cache_with_conn(conn: &Connection, now: &str) -> VfsResult<usize> {
        // 获取所有未删除的资源的 folder_items
        // 通过 LEFT JOIN 各资源表检查 deleted_at 字段，只为未删除的资源创建缓存
        let mut stmt = conn.prepare(
            r#"
            SELECT fi.item_type, fi.item_id, fi.folder_id
            FROM folder_items fi
            LEFT JOIN notes n ON fi.item_type = 'note' AND fi.item_id = n.id
            LEFT JOIN files f ON fi.item_type = 'textbook' AND fi.item_id = f.id
            LEFT JOIN exam_sheets e ON fi.item_type = 'exam' AND fi.item_id = e.id
            LEFT JOIN translations t ON fi.item_type = 'translation' AND fi.item_id = t.id
            LEFT JOIN essays es ON fi.item_type = 'essay' AND fi.item_id = es.id
            WHERE
                (fi.item_type = 'note' AND n.id IS NOT NULL AND (n.deleted_at IS NULL OR n.deleted_at = '')) OR
                (fi.item_type = 'textbook' AND f.id IS NOT NULL AND (f.deleted_at IS NULL OR f.deleted_at = '')) OR
                (fi.item_type = 'exam' AND e.id IS NOT NULL AND (e.deleted_at IS NULL OR e.deleted_at = '')) OR
                (fi.item_type = 'translation' AND t.id IS NOT NULL AND (t.deleted_at IS NULL OR t.deleted_at = '')) OR
                (fi.item_type = 'essay' AND es.id IS NOT NULL AND (es.deleted_at IS NULL OR es.deleted_at = ''))
            "#
        )?;

        let items: Vec<(String, String, Option<String>)> = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut count = 0;
        for (item_type, item_id, folder_id) in items {
            if let Ok(entry) = Self::compute_resource_cache_entry_with_conn(
                conn,
                &item_type,
                &item_id,
                folder_id.as_deref(),
                now,
            ) {
                if entry.full_path.len() <= MAX_PATH_LENGTH {
                    Self::set_path_with_conn(conn, &entry)?;
                    count += 1;
                }
            }
        }

        Ok(count)
    }

    /// 计算文件夹路径
    fn compute_folder_path_with_conn(conn: &Connection, folder_id: &str) -> VfsResult<String> {
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

    /// 计算资源的缓存条目
    fn compute_resource_cache_entry_with_conn(
        conn: &Connection,
        item_type: &str,
        item_id: &str,
        folder_id: Option<&str>,
        now: &str,
    ) -> VfsResult<PathCacheEntry> {
        // 获取资源标题（用于日志，路径使用 item_id）
        let _title = Self::get_resource_title_with_conn(conn, item_type, item_id)?;

        // 计算文件夹路径
        let folder_path = if let Some(fid) = folder_id {
            let path = Self::compute_folder_path_with_conn(conn, fid)?;
            format!("/{}", path)
        } else {
            "/".to_string()
        };

        // 构建完整路径
        let full_path = if folder_path == "/" {
            format!("/{}", item_id)
        } else {
            format!("{}/{}", folder_path, item_id)
        };

        Ok(PathCacheEntry {
            item_type: item_type.to_string(),
            item_id: item_id.to_string(),
            full_path,
            folder_path,
            updated_at: now.to_string(),
        })
    }

    /// 获取资源标题
    fn get_resource_title_with_conn(
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
            _ => Some(item_id.to_string()),
        };

        Ok(title.unwrap_or_else(|| item_id.to_string()))
    }

    // ========================================================================
    // 缓存查询（带自动计算）
    // ========================================================================

    /// 获取路径，缓存未命中时自动计算并缓存
    pub fn get_or_compute_path(
        db: &VfsDatabase,
        item_type: &str,
        item_id: &str,
    ) -> VfsResult<PathCacheEntry> {
        let conn = db.get_conn_safe()?;
        Self::get_or_compute_path_with_conn(&conn, item_type, item_id)
    }

    /// 获取路径，缓存未命中时自动计算并缓存（使用现有连接）
    pub fn get_or_compute_path_with_conn(
        conn: &Connection,
        item_type: &str,
        item_id: &str,
    ) -> VfsResult<PathCacheEntry> {
        // 1. 尝试从缓存获取
        if let Some(entry) = Self::get_path_with_conn(conn, item_type, item_id)? {
            return Ok(entry);
        }

        debug!(
            "[VFS::PathCacheRepo] Cache miss, computing path for {}/{}",
            item_type, item_id
        );

        // 2. 缓存未命中，实时计算
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let entry = if item_type == "folder" {
            // 计算文件夹路径
            let folder_path = Self::compute_folder_path_with_conn(conn, item_id)?;
            let full_path = format!("/{}", folder_path);

            // 提取父路径
            let parent_path = if let Some(pos) = folder_path.rfind('/') {
                format!("/{}", &folder_path[..pos])
            } else {
                "/".to_string()
            };

            PathCacheEntry {
                item_type: item_type.to_string(),
                item_id: item_id.to_string(),
                full_path,
                folder_path: parent_path,
                updated_at: now,
            }
        } else {
            // 计算资源路径
            // 先查询 folder_items 获取所在文件夹
            let folder_id: Option<String> = conn
                .query_row(
                    "SELECT folder_id FROM folder_items WHERE item_type = ?1 AND item_id = ?2",
                    params![item_type, item_id],
                    |row| row.get(0),
                )
                .optional()?
                .flatten();

            Self::compute_resource_cache_entry_with_conn(
                conn,
                item_type,
                item_id,
                folder_id.as_deref(),
                &now,
            )?
        };

        // 3. 缓存计算结果
        if entry.full_path.len() <= MAX_PATH_LENGTH {
            Self::set_path_with_conn(conn, &entry)?;
        }

        Ok(entry)
    }

    // ========================================================================
    // 统计与调试
    // ========================================================================

    /// 获取缓存统计信息
    pub fn get_stats(db: &VfsDatabase) -> VfsResult<PathCacheStats> {
        let conn = db.get_conn_safe()?;
        Self::get_stats_with_conn(&conn)
    }

    /// 获取缓存统计信息（使用现有连接）
    pub fn get_stats_with_conn(conn: &Connection) -> VfsResult<PathCacheStats> {
        Self::ensure_table_exists(conn)?;

        let total_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM path_cache", [], |row| row.get(0))
            .unwrap_or(0);

        let folder_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM path_cache WHERE item_type = 'folder'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let resource_count = total_count - folder_count;

        Ok(PathCacheStats {
            total_count: total_count as usize,
            folder_count: folder_count as usize,
            resource_count: resource_count as usize,
        })
    }
}

/// 路径缓存统计信息
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathCacheStats {
    /// 总缓存条目数
    pub total_count: usize,
    /// 文件夹缓存条目数
    pub folder_count: usize,
    /// 资源缓存条目数
    pub resource_count: usize,
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("Failed to create in-memory database");

        // 创建必要的表
        conn.execute(
            r#"
            CREATE TABLE folders (
                id TEXT PRIMARY KEY,
                parent_id TEXT,
                title TEXT NOT NULL,
                icon TEXT,
                color TEXT,
                is_expanded INTEGER DEFAULT 1,
                sort_order INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT
            )
            "#,
            [],
        )
        .expect("Failed to create folders table");

        conn.execute(
            r#"
            CREATE TABLE folder_items (
                id TEXT PRIMARY KEY,
                folder_id TEXT,
                item_type TEXT NOT NULL,
                item_id TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL,
                cached_path TEXT
            )
            "#,
            [],
        )
        .expect("Failed to create folder_items table");

        conn.execute(
            r#"
            CREATE TABLE notes (
                id TEXT PRIMARY KEY,
                resource_id TEXT NOT NULL,
                title TEXT NOT NULL,
                tags TEXT,
                is_favorite INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT
            )
            "#,
            [],
        )
        .expect("Failed to create notes table");

        conn
    }

    #[test]
    fn test_ensure_table_exists() {
        let conn = setup_test_db();
        VfsPathCacheRepo::ensure_table_exists(&conn).expect("Failed to ensure table exists");

        // 验证表存在
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='path_cache'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check table");
        assert_eq!(count, 1);
    }

    #[test]
    fn test_set_and_get_path() {
        let conn = setup_test_db();
        VfsPathCacheRepo::ensure_table_exists(&conn).unwrap();

        let entry = PathCacheEntry {
            item_type: "note".to_string(),
            item_id: "note_abc123".to_string(),
            full_path: "/高考复习/函数/note_abc123".to_string(),
            folder_path: "/高考复习/函数".to_string(),
            updated_at: "2024-01-01T00:00:00.000Z".to_string(),
        };

        // 设置缓存
        VfsPathCacheRepo::set_path_with_conn(&conn, &entry).expect("Failed to set path");

        // 获取缓存
        let result = VfsPathCacheRepo::get_path_with_conn(&conn, "note", "note_abc123")
            .expect("Failed to get path");

        assert!(result.is_some());
        let cached = result.unwrap();
        assert_eq!(cached.full_path, "/高考复习/函数/note_abc123");
        assert_eq!(cached.folder_path, "/高考复习/函数");
    }

    #[test]
    fn test_invalidate() {
        let conn = setup_test_db();
        VfsPathCacheRepo::ensure_table_exists(&conn).unwrap();

        let entry = PathCacheEntry {
            item_type: "note".to_string(),
            item_id: "note_xyz".to_string(),
            full_path: "/test/note_xyz".to_string(),
            folder_path: "/test".to_string(),
            updated_at: "2024-01-01T00:00:00.000Z".to_string(),
        };

        VfsPathCacheRepo::set_path_with_conn(&conn, &entry).unwrap();

        // 验证缓存存在
        let result = VfsPathCacheRepo::get_path_with_conn(&conn, "note", "note_xyz").unwrap();
        assert!(result.is_some());

        // 使缓存失效
        let invalidated =
            VfsPathCacheRepo::invalidate_with_conn(&conn, "note", "note_xyz").unwrap();
        assert!(invalidated);

        // 验证缓存不存在
        let result = VfsPathCacheRepo::get_path_with_conn(&conn, "note", "note_xyz").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_cache_miss() {
        let conn = setup_test_db();
        VfsPathCacheRepo::ensure_table_exists(&conn).unwrap();

        // 查询不存在的缓存
        let result = VfsPathCacheRepo::get_path_with_conn(&conn, "note", "nonexistent").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_get_by_full_path() {
        let conn = setup_test_db();
        VfsPathCacheRepo::ensure_table_exists(&conn).unwrap();

        let entry = PathCacheEntry {
            item_type: "textbook".to_string(),
            item_id: "tb_123".to_string(),
            full_path: "/教材/数学/tb_123".to_string(),
            folder_path: "/教材/数学".to_string(),
            updated_at: "2024-01-01T00:00:00.000Z".to_string(),
        };

        VfsPathCacheRepo::set_path_with_conn(&conn, &entry).unwrap();

        // 通过完整路径查询
        let result =
            VfsPathCacheRepo::get_by_full_path_with_conn(&conn, "/教材/数学/tb_123").unwrap();

        assert!(result.is_some());
        let cached = result.unwrap();
        assert_eq!(cached.item_type, "textbook");
        assert_eq!(cached.item_id, "tb_123");
    }

    #[test]
    fn test_batch_set() {
        let conn = setup_test_db();
        VfsPathCacheRepo::ensure_table_exists(&conn).unwrap();

        let entries = vec![
            PathCacheEntry {
                item_type: "note".to_string(),
                item_id: "note_1".to_string(),
                full_path: "/test/note_1".to_string(),
                folder_path: "/test".to_string(),
                updated_at: "2024-01-01T00:00:00.000Z".to_string(),
            },
            PathCacheEntry {
                item_type: "note".to_string(),
                item_id: "note_2".to_string(),
                full_path: "/test/note_2".to_string(),
                folder_path: "/test".to_string(),
                updated_at: "2024-01-01T00:00:00.000Z".to_string(),
            },
        ];

        let count = VfsPathCacheRepo::set_paths_batch_with_conn(&conn, &entries).unwrap();
        assert_eq!(count, 2);

        // 验证都已缓存
        let r1 = VfsPathCacheRepo::get_path_with_conn(&conn, "note", "note_1").unwrap();
        let r2 = VfsPathCacheRepo::get_path_with_conn(&conn, "note", "note_2").unwrap();
        assert!(r1.is_some());
        assert!(r2.is_some());
    }

    #[test]
    fn test_stats() {
        let conn = setup_test_db();
        VfsPathCacheRepo::ensure_table_exists(&conn).unwrap();

        // 添加一些缓存条目
        let entries = vec![
            PathCacheEntry {
                item_type: "folder".to_string(),
                item_id: "fld_1".to_string(),
                full_path: "/test".to_string(),
                folder_path: "/".to_string(),
                updated_at: "2024-01-01T00:00:00.000Z".to_string(),
            },
            PathCacheEntry {
                item_type: "note".to_string(),
                item_id: "note_1".to_string(),
                full_path: "/test/note_1".to_string(),
                folder_path: "/test".to_string(),
                updated_at: "2024-01-01T00:00:00.000Z".to_string(),
            },
            PathCacheEntry {
                item_type: "textbook".to_string(),
                item_id: "tb_1".to_string(),
                full_path: "/test/tb_1".to_string(),
                folder_path: "/test".to_string(),
                updated_at: "2024-01-01T00:00:00.000Z".to_string(),
            },
        ];

        VfsPathCacheRepo::set_paths_batch_with_conn(&conn, &entries).unwrap();

        let stats = VfsPathCacheRepo::get_stats_with_conn(&conn).unwrap();
        assert_eq!(stats.total_count, 3);
        assert_eq!(stats.folder_count, 1);
        assert_eq!(stats.resource_count, 2);
    }
}
