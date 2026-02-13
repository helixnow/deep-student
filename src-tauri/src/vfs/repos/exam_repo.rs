//! VFS 题目集识别表 CRUD 操作
//!
//! 题目集识别元数据管理，内容通过 `resource_id` 关联 `resources` 表。
//!
//! ## 核心方法
//! - `list_exam_sheets`: 列出题目集识别
//! - `get_exam_sheet`: 获取题目集识别
//! - `search_exam_sheets`: 搜索题目集识别

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use tracing::{debug, info, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};

/// Log row-parse errors instead of silently discarding them.
fn log_and_skip_err<T>(result: Result<T, rusqlite::Error>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("[VFS::ExamRepo] Row parse error (skipped): {}", e);
            None
        }
    }
}
use crate::vfs::ocr_utils::parse_ocr_pages_json;
use crate::vfs::repos::folder_repo::VfsFolderRepo;
use crate::vfs::repos::resource_repo::VfsResourceRepo;
use crate::vfs::types::{
    ResourceLocation, VfsCreateExamSheetParams, VfsExamSheet, VfsFolderItem, VfsResourceType,
};

/// VFS 题目集识别表 Repo
pub struct VfsExamRepo;

impl VfsExamRepo {
    // ========================================================================
    // 列表查询
    // ========================================================================

    /// 列出题目集识别
    pub fn list_exam_sheets(
        db: &VfsDatabase,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsExamSheet>> {
        let conn = db.get_conn_safe()?;
        Self::list_exam_sheets_with_conn(&conn, search, limit, offset)
    }

    /// 列出题目集识别（使用现有连接）
    pub fn list_exam_sheets_with_conn(
        conn: &Connection,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsExamSheet>> {
        let mut sql = String::from(
            r#"
            SELECT id, resource_id, exam_name, status, temp_id,
                   metadata_json, preview_json, linked_mistake_ids, is_favorite, created_at, updated_at
            FROM exam_sheets
            WHERE deleted_at IS NULL
            "#,
        );

        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        let mut param_idx = 1;

        // 搜索过滤（在 exam_name 中搜索）
        if let Some(q) = search {
            sql.push_str(&format!(" AND exam_name LIKE ?{}", param_idx));
            let search_pattern = format!("%{}%", q);
            params_vec.push(Box::new(search_pattern));
            param_idx += 1;
        }

        sql.push_str(&format!(
            " ORDER BY updated_at DESC LIMIT ?{} OFFSET ?{}",
            param_idx,
            param_idx + 1
        ));
        params_vec.push(Box::new(limit));
        params_vec.push(Box::new(offset));

        let mut stmt = conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(params_refs.as_slice(), Self::row_to_exam_sheet)?;

        let exam_sheets: Vec<VfsExamSheet> = rows.filter_map(log_and_skip_err).collect();
        debug!("[VFS::ExamRepo] Listed {} exam sheets", exam_sheets.len());
        Ok(exam_sheets)
    }

    // ========================================================================
    // 查询单个
    // ========================================================================

    /// 根据 ID 获取题目集识别
    pub fn get_exam_sheet(db: &VfsDatabase, exam_id: &str) -> VfsResult<Option<VfsExamSheet>> {
        let conn = db.get_conn_safe()?;
        Self::get_exam_sheet_with_conn(&conn, exam_id)
    }

    /// 根据 ID 获取题目集识别（使用现有连接）
    pub fn get_exam_sheet_with_conn(
        conn: &Connection,
        exam_id: &str,
    ) -> VfsResult<Option<VfsExamSheet>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, exam_name, status, temp_id,
                   metadata_json, preview_json, linked_mistake_ids, is_favorite, created_at, updated_at
            FROM exam_sheets
            WHERE id = ?1
            "#,
        )?;

        let exam_sheet = stmt
            .query_row(params![exam_id], Self::row_to_exam_sheet)
            .optional()?;

        Ok(exam_sheet)
    }

    /// 获取题目集预览内容
    ///
    /// 从关联的 resource.data 获取内容（SSOT）
    pub fn get_exam_sheet_content(db: &VfsDatabase, exam_id: &str) -> VfsResult<Option<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_exam_sheet_content_with_conn(&conn, exam_id)
    }

    /// 获取题目集预览内容（使用现有连接）
    pub fn get_exam_sheet_content_with_conn(
        conn: &Connection,
        exam_id: &str,
    ) -> VfsResult<Option<String>> {
        let content: Option<String> = conn
            .query_row(
                r#"
                SELECT r.data
                FROM exam_sheets e
                JOIN resources r ON e.resource_id = r.id
                WHERE e.id = ?1
                "#,
                params![exam_id],
                |row| row.get(0),
            )
            .optional()?;

        Ok(content)
    }

    // ========================================================================
    // 搜索
    // ========================================================================

    /// 搜索题目集识别（用于全局搜索）
    ///
    pub fn search_exam_sheets(
        db: &VfsDatabase,
        query: &str,
        limit: u32,
    ) -> VfsResult<Vec<VfsExamSheet>> {
        let conn = db.get_conn_safe()?;
        Self::search_exam_sheets_with_conn(&conn, query, limit)
    }

    /// 搜索题目集识别（使用现有连接）
    pub fn search_exam_sheets_with_conn(
        conn: &Connection,
        query: &str,
        limit: u32,
    ) -> VfsResult<Vec<VfsExamSheet>> {
        Self::list_exam_sheets_with_conn(conn, Some(query), limit, 0)
    }

    // ========================================================================
    // 创建
    // ========================================================================

    /// 创建题目集识别记录（参数结构体版本）
    pub fn create_exam_sheet(
        db: &VfsDatabase,
        params: VfsCreateExamSheetParams,
    ) -> VfsResult<VfsExamSheet> {
        let conn = db.get_conn_safe()?;
        Self::create_exam_sheet_with_conn(&conn, params)
    }

    /// 创建题目集识别记录（使用现有连接，参数结构体版本）
    ///
    /// ## 流程
    /// 1. 将 preview_json 序列化为字符串存入 resources.data（SSOT）
    /// 2. 创建题目集元数据记录
    /// 3. 更新资源的 source_id
    /// 4. 可选：添加到文件夹
    ///
    /// ★ M-078 修复：使用 SAVEPOINT 事务保护多步操作，防止部分失败导致孤儿资源
    pub fn create_exam_sheet_with_conn(
        conn: &Connection,
        params: VfsCreateExamSheetParams,
    ) -> VfsResult<VfsExamSheet> {
        // 序列化操作（纯计算，不需要事务保护）
        let preview_content = serde_json::to_string(&params.preview_json)
            .map_err(|e| VfsError::Serialization(e.to_string()))?;

        // ★ SAVEPOINT 事务保护：包裹 create_or_reuse / INSERT exam_sheets / UPDATE resources 多步操作
        conn.execute("SAVEPOINT create_exam", []).map_err(|e| {
            warn!(
                "[VFS::ExamRepo] Failed to create savepoint for create_exam: {}",
                e
            );
            VfsError::Database(format!("Failed to create savepoint: {}", e))
        })?;

        let result = (|| -> VfsResult<VfsExamSheet> {
            // 1. 将 preview_json 序列化为内容存入 resources（SSOT）
            let resource_result = VfsResourceRepo::create_or_reuse_with_conn(
                conn,
                VfsResourceType::Exam,
                &preview_content,
                None, // source_id 稍后更新
                Some("exam_sheets"),
                None,
            )?;

            // 2. 创建题目集记录
            let exam_id = VfsExamSheet::generate_id();
            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
            let metadata_str = serde_json::to_string(&params.metadata_json)
                .map_err(|e| VfsError::Serialization(e.to_string()))?;
            let preview_str = serde_json::to_string(&params.preview_json)
                .map_err(|e| VfsError::Serialization(e.to_string()))?;

            conn.execute(
                r#"
                INSERT INTO exam_sheets (id, resource_id, exam_name, status, temp_id,
                                         metadata_json, preview_json, linked_mistake_ids, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9)
                "#,
                params![
                    exam_id,
                    resource_result.resource_id,
                    params.exam_name,
                    params.status,
                    params.temp_id,
                    metadata_str,
                    preview_str,
                    now,
                    now,
                ],
            )?;

            // 3. 更新资源的 source_id
            conn.execute(
                "UPDATE resources SET source_id = ?1 WHERE id = ?2",
                params![exam_id, resource_result.resource_id],
            )?;

            // 4. ★ 如果指定了 folder_id，将题目集添加到文件夹
            if let Some(ref folder_id) = params.folder_id {
                use crate::vfs::repos::folder_repo::VfsFolderRepo;
                use crate::vfs::types::VfsFolderItem;

                let folder_item = VfsFolderItem::new(
                    Some(folder_id.clone()),
                    "exam".to_string(),
                    exam_id.clone(),
                );
                if let Err(e) = VfsFolderRepo::add_item_to_folder_with_conn(conn, &folder_item) {
                    warn!(
                        "[VFS::ExamRepo] Failed to add exam to folder {}: {}",
                        folder_id, e
                    );
                } else {
                    info!(
                        "[VFS::ExamRepo] Added exam {} to folder {}",
                        exam_id, folder_id
                    );
                }
            }

            info!(
                "[VFS::ExamRepo] Created exam sheet: {} (resource: {}, temp_id: {})",
                exam_id, resource_result.resource_id, params.temp_id
            );

            Ok(VfsExamSheet {
                id: exam_id,
                resource_id: Some(resource_result.resource_id),
                exam_name: params.exam_name,
                status: params.status,
                temp_id: params.temp_id,
                metadata_json: params.metadata_json,
                preview_json: params.preview_json,
                linked_mistake_ids: None,
                is_favorite: false,
                created_at: now.clone(),
                updated_at: now,
            })
        })();

        match result {
            Ok(exam) => {
                conn.execute("RELEASE create_exam", []).map_err(|e| {
                    warn!(
                        "[VFS::ExamRepo] Failed to release savepoint create_exam: {}",
                        e
                    );
                    VfsError::Database(format!("Failed to release savepoint: {}", e))
                })?;
                Ok(exam)
            }
            Err(e) => {
                // 回滚到 savepoint，忽略回滚本身的错误
                let _ = conn.execute("ROLLBACK TO create_exam", []);
                // 释放 savepoint（即使回滚后也需要释放，否则 savepoint 会残留）
                let _ = conn.execute("RELEASE create_exam", []);
                Err(e)
            }
        }
    }

    /// 创建题目集识别记录（兼容旧 API）
    #[deprecated(note = "请使用 create_exam_sheet(params) 版本")]
    pub fn create_exam_sheet_legacy(
        db: &VfsDatabase,
        exam_name: Option<&str>,
        _subject: Option<&str>, // subject 已废弃
        temp_id: &str,
        status: &str,
        metadata_json: &Value,
        preview_json: &Value,
    ) -> VfsResult<VfsExamSheet> {
        Self::create_exam_sheet(
            db,
            VfsCreateExamSheetParams {
                exam_name: exam_name.map(|s| s.to_string()),
                temp_id: temp_id.to_string(),
                metadata_json: metadata_json.clone(),
                preview_json: preview_json.clone(),
                status: status.to_string(),
                folder_id: None,
            },
        )
    }

    // ========================================================================
    // 更新
    // ========================================================================

    /// 创建或更新题目集识别记录（upsert）
    ///
    /// 如果 exam_id 已存在则更新，否则创建新记录
    pub fn upsert_exam_sheet(
        db: &VfsDatabase,
        params: VfsCreateExamSheetParams,
        exam_id: Option<&str>,
    ) -> VfsResult<VfsExamSheet> {
        let conn = db.get_conn_safe()?;
        Self::upsert_exam_sheet_with_conn(&conn, params, exam_id)
    }

    /// 创建或更新题目集识别记录（使用现有连接）
    pub fn upsert_exam_sheet_with_conn(
        conn: &Connection,
        params: VfsCreateExamSheetParams,
        exam_id: Option<&str>,
    ) -> VfsResult<VfsExamSheet> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        // 检查是否已存在
        let existing = if let Some(id) = exam_id {
            Self::get_exam_sheet_with_conn(conn, id)?
        } else {
            // 根据 temp_id 查找
            let mut stmt = conn.prepare("SELECT id FROM exam_sheets WHERE temp_id = ?1 LIMIT 1")?;
            let existing_id: Option<String> = stmt
                .query_row(params![params.temp_id], |row| row.get(0))
                .ok();
            existing_id.and_then(|id| Self::get_exam_sheet_with_conn(conn, &id).ok().flatten())
        };

        if let Some(existing) = existing {
            // 更新现有记录
            let metadata_str = serde_json::to_string(&params.metadata_json)
                .map_err(|e| VfsError::Serialization(e.to_string()))?;
            let preview_str = serde_json::to_string(&params.preview_json)
                .map_err(|e| VfsError::Serialization(e.to_string()))?;

            conn.execute(
                r#"
                UPDATE exam_sheets
                SET exam_name = ?1, status = ?2, metadata_json = ?3, preview_json = ?4, updated_at = ?5
                WHERE id = ?6
                "#,
                params![
                    params.exam_name,
                    params.status,
                    metadata_str,
                    preview_str,
                    now,
                    existing.id,
                ],
            )?;

            // 更新资源内容（SSOT）
            if let Some(ref resource_id) = existing.resource_id {
                let preview_content = serde_json::to_string(&params.preview_json)
                    .map_err(|e| VfsError::Serialization(e.to_string()))?;
                // resources 表的 updated_at 使用整数时间戳（毫秒），不是 TEXT
                let now_millis = chrono::Utc::now().timestamp_millis();
                conn.execute(
                    "UPDATE resources SET data = ?1, updated_at = ?2 WHERE id = ?3",
                    params![preview_content, now_millis, resource_id],
                )?;
            }

            info!("[VFS::ExamRepo] Updated exam sheet: {}", existing.id);

            Ok(VfsExamSheet {
                id: existing.id,
                resource_id: existing.resource_id,
                exam_name: params.exam_name,
                status: params.status,
                temp_id: params.temp_id,
                metadata_json: params.metadata_json,
                preview_json: params.preview_json,
                linked_mistake_ids: existing.linked_mistake_ids,
                is_favorite: existing.is_favorite,
                created_at: existing.created_at,
                updated_at: now,
            })
        } else {
            // 创建新记录
            Self::create_exam_sheet_with_conn(conn, params)
        }
    }

    /// 更新题目集关联的错题 ID
    pub fn update_linked_mistakes(
        db: &VfsDatabase,
        exam_id: &str,
        linked_mistake_ids: Option<Vec<String>>,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let linked_str = linked_mistake_ids
            .map(|ids| serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string()));

        let updated = conn.execute(
            "UPDATE exam_sheets SET linked_mistake_ids = ?1, updated_at = ?2 WHERE id = ?3",
            params![linked_str, now, exam_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "ExamSheet".to_string(),
                id: exam_id.to_string(),
            });
        }

        info!(
            "[VFS::ExamRepo] Updated exam sheet linked_mistake_ids: {}",
            exam_id
        );
        Ok(())
    }

    /// 更新题目集名称（重命名）
    pub fn update_exam_name(
        db: &VfsDatabase,
        exam_id: &str,
        new_name: &str,
    ) -> VfsResult<VfsExamSheet> {
        let conn = db.get_conn_safe()?;
        Self::update_exam_name_with_conn(&conn, exam_id, new_name)
    }

    /// 更新题目集名称（使用现有连接）
    pub fn update_exam_name_with_conn(
        conn: &Connection,
        exam_id: &str,
        new_name: &str,
    ) -> VfsResult<VfsExamSheet> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE exam_sheets SET exam_name = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_name, now, exam_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "ExamSheet".to_string(),
                id: exam_id.to_string(),
            });
        }

        info!(
            "[VFS::ExamRepo] Renamed exam sheet: {} -> {}",
            exam_id, new_name
        );
        Self::get_exam_sheet_with_conn(conn, exam_id)?.ok_or_else(|| VfsError::NotFound {
            resource_type: "ExamSheet".to_string(),
            id: exam_id.to_string(),
        })
    }

    // update_exam_subject 方法已删除，subject 字段已从 VfsExamSheet 移除

    /// 收藏/取消收藏题目集
    pub fn set_favorite(db: &VfsDatabase, exam_id: &str, favorite: bool) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::set_favorite_with_conn(&conn, exam_id, favorite)
    }

    /// 收藏/取消收藏题目集（使用现有连接）
    pub fn set_favorite_with_conn(
        conn: &Connection,
        exam_id: &str,
        favorite: bool,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE exam_sheets SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3",
            params![favorite as i32, now, exam_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "ExamSheet".to_string(),
                id: exam_id.to_string(),
            });
        }

        info!(
            "[VFS::ExamRepo] Set exam favorite: {} -> {}",
            exam_id, favorite
        );
        Ok(())
    }

    /// 更新题目集识别状态
    pub fn update_status(db: &VfsDatabase, exam_id: &str, status: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::update_status_with_conn(&conn, exam_id, status)
    }

    /// 更新题目集识别状态（使用现有连接）
    pub fn update_status_with_conn(
        conn: &Connection,
        exam_id: &str,
        status: &str,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE exam_sheets SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status, now, exam_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "ExamSheet".to_string(),
                id: exam_id.to_string(),
            });
        }

        info!(
            "[VFS::ExamRepo] Updated exam sheet status: {} -> {}",
            exam_id, status
        );
        Ok(())
    }

    // ========================================================================
    // 删除（软删除）
    // ========================================================================

    /// 删除题目集识别记录（软删除，移到回收站）
    ///
    /// ★ 2025-12-11: 统一语义，delete = 软删除，purge = 永久删除
    pub fn delete_exam_sheet(db: &VfsDatabase, exam_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_exam_sheet_with_conn(&conn, exam_id)
    }

    /// 删除题目集识别记录（软删除，使用现有连接）
    pub fn delete_exam_sheet_with_conn(conn: &Connection, exam_id: &str) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE exam_sheets SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![now, exam_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "ExamSheet".to_string(),
                id: exam_id.to_string(),
            });
        }

        info!("[VFS::ExamRepo] Soft deleted exam: {}", exam_id);
        Ok(())
    }

    // ========================================================================
    // 永久删除（purge）
    // ========================================================================

    /// 永久删除题目集识别记录（从数据库彻底删除，不可恢复）
    ///
    /// ★ 2025-12-11: 统一语义，purge = 永久删除
    pub fn purge_exam_sheet(db: &VfsDatabase, exam_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::purge_exam_sheet_with_conn(&conn, exam_id)
    }

    /// 永久删除题目集识别记录（使用现有连接）
    pub fn purge_exam_sheet_with_conn(conn: &Connection, exam_id: &str) -> VfsResult<()> {
        let deleted = conn.execute("DELETE FROM exam_sheets WHERE id = ?1", params![exam_id])?;

        if deleted == 0 {
            return Err(VfsError::NotFound {
                resource_type: "ExamSheet".to_string(),
                id: exam_id.to_string(),
            });
        }

        info!("[VFS::ExamRepo] Purged exam sheet: {}", exam_id);
        Ok(())
    }

    // ========================================================================
    // 恢复
    // ========================================================================

    /// 软删除题目集识别（兼容旧调用，等同于 delete_exam_sheet）
    #[deprecated(note = "使用 delete_exam_sheet 替代")]
    pub fn soft_delete_exam(db: &VfsDatabase, exam_id: &str) -> VfsResult<()> {
        Self::delete_exam_sheet(db, exam_id)
    }

    /// 软删除题目集识别（兼容旧调用，使用现有连接）
    #[deprecated(note = "使用 delete_exam_sheet_with_conn 替代")]
    pub fn soft_delete_exam_with_conn(conn: &Connection, exam_id: &str) -> VfsResult<()> {
        Self::delete_exam_sheet_with_conn(conn, exam_id)
    }

    /// 恢复软删除的题目集识别
    pub fn restore_exam(db: &VfsDatabase, exam_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::restore_exam_with_conn(&conn, exam_id)
    }

    /// 恢复软删除的题目集识别（使用现有连接）
    ///
    /// ★ P0 修复：恢复题目集时同步恢复 folder_items 记录，
    /// 确保恢复后的题目集在 Learning Hub 中可见
    ///
    /// ★ 2026-02: 新增恢复关联题目，与删除操作对应
    ///
    /// 注意：使用 SAVEPOINT 以支持事务保护和嵌套调用
    pub fn restore_exam_with_conn(conn: &Connection, exam_id: &str) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let now_ms = chrono::Utc::now().timestamp_millis();

        // 使用 SAVEPOINT 以确保原子性
        let savepoint_name = format!("restore_exam_{}", exam_id.replace("-", "_"));
        conn.execute(&format!("SAVEPOINT {}", savepoint_name), [])?;

        let result = (|| -> VfsResult<(usize, usize)> {
            // 1. 恢复题目集识别
            let updated = conn.execute(
                "UPDATE exam_sheets SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NOT NULL",
                params![now, exam_id],
            )?;

            if updated == 0 {
                return Err(VfsError::NotFound {
                    resource_type: "ExamSheet".to_string(),
                    id: exam_id.to_string(),
                });
            }

            // 2. ★ P0 修复：恢复 folder_items 记录
            let folder_items_restored = conn.execute(
                "UPDATE folder_items SET deleted_at = NULL, updated_at = ?1 WHERE item_type = 'exam' AND item_id = ?2 AND deleted_at IS NOT NULL",
                params![now_ms, exam_id],
            )?;

            // 3. ★ 2026-02: 恢复关联的题目
            let questions_restored = conn.execute(
                "UPDATE questions SET deleted_at = NULL, updated_at = ?1 WHERE exam_id = ?2 AND deleted_at IS NOT NULL",
                params![now, exam_id],
            )?;

            Ok((folder_items_restored, questions_restored))
        })();

        match result {
            Ok((folder_items_restored, questions_restored)) => {
                conn.execute(&format!("RELEASE {}", savepoint_name), [])?;
                info!(
                    "[VFS::ExamRepo] Restored exam: {}, folder_items restored: {}, questions restored: {}",
                    exam_id, folder_items_restored, questions_restored
                );
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute(&format!("ROLLBACK TO {}", savepoint_name), []);
                let _ = conn.execute(&format!("RELEASE {}", savepoint_name), []);
                warn!(
                    "[VFS::ExamRepo] Restore exam {} failed, rolled back: {}",
                    exam_id, e
                );
                Err(e)
            }
        }
    }

    /// 列出已删除的题目集识别（回收站）
    pub fn list_deleted_exams(
        db: &VfsDatabase,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsExamSheet>> {
        let conn = db.get_conn_safe()?;
        Self::list_deleted_exams_with_conn(&conn, limit, offset)
    }

    /// 列出已删除的题目集识别（使用现有连接）
    pub fn list_deleted_exams_with_conn(
        conn: &Connection,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsExamSheet>> {
        let sql = r#"
            SELECT id, resource_id, exam_name, status, temp_id,
                   metadata_json, preview_json, linked_mistake_ids, is_favorite, created_at, updated_at
            FROM exam_sheets
            WHERE deleted_at IS NOT NULL
            ORDER BY deleted_at DESC LIMIT ?1 OFFSET ?2
        "#;

        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![limit, offset], Self::row_to_exam_sheet)?;

        let exams: Vec<VfsExamSheet> = rows.filter_map(log_and_skip_err).collect();
        debug!("[VFS::ExamRepo] Listed {} deleted exams", exams.len());
        Ok(exams)
    }

    // ========================================================================
    // 迁移支持方法
    // ========================================================================

    /// ★ 文档25：列出所有题目集记录（用于迁移）
    pub fn list_all_exam_sheets(db: &VfsDatabase) -> VfsResult<Vec<VfsExamSheet>> {
        let conn = db.get_conn_safe()?;
        Self::list_all_exam_sheets_with_conn(&conn)
    }

    /// 列出所有题目集记录（使用现有连接）
    pub fn list_all_exam_sheets_with_conn(conn: &Connection) -> VfsResult<Vec<VfsExamSheet>> {
        let sql = r#"
            SELECT id, resource_id, exam_name, status, temp_id,
                   metadata_json, preview_json, linked_mistake_ids, is_favorite, created_at, updated_at
            FROM exam_sheets
            ORDER BY created_at ASC
        "#;

        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map([], Self::row_to_exam_sheet)?;
        let exam_sheets: Vec<VfsExamSheet> = rows.filter_map(log_and_skip_err).collect();
        debug!(
            "[VFS::ExamRepo] Listed all {} exam sheets for migration",
            exam_sheets.len()
        );
        Ok(exam_sheets)
    }

    /// ★ 文档25：更新 preview_json（用于迁移）
    pub fn update_preview_json(
        db: &VfsDatabase,
        exam_id: &str,
        preview_json: Value,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::update_preview_json_with_conn(&conn, exam_id, preview_json)
    }

    /// 更新 preview_json（使用现有连接）
    pub fn update_preview_json_with_conn(
        conn: &Connection,
        exam_id: &str,
        preview_json: Value,
    ) -> VfsResult<()> {
        let sql = r#"
            UPDATE exam_sheets
            SET preview_json = ?, updated_at = datetime('now')
            WHERE id = ?
        "#;

        let preview_str = serde_json::to_string(&preview_json).map_err(|e| {
            VfsError::Serialization(format!("Failed to serialize preview_json: {}", e))
        })?;

        let affected = conn.execute(sql, params![preview_str, exam_id])?;
        if affected == 0 {
            return Err(VfsError::NotFound {
                resource_type: "ExamSheet".to_string(),
                id: exam_id.to_string(),
            });
        }

        info!("[VFS::ExamRepo] Updated preview_json for exam {}", exam_id);
        Ok(())
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    /// 从行数据构建 VfsExamSheet
    fn row_to_exam_sheet(row: &rusqlite::Row) -> rusqlite::Result<VfsExamSheet> {
        let metadata_str: String = row.get(5)?;
        let preview_str: String = row.get(6)?;
        let linked_ids_str: Option<String> = row.get(7)?;

        let metadata_json: Value = serde_json::from_str(&metadata_str).unwrap_or(Value::Null);
        let preview_json: Value = serde_json::from_str(&preview_str).unwrap_or(Value::Null);
        let linked_mistake_ids: Option<Vec<String>> =
            linked_ids_str.and_then(|s| serde_json::from_str(&s).ok());

        Ok(VfsExamSheet {
            id: row.get(0)?,
            resource_id: row.get(1)?,
            exam_name: row.get(2)?,
            status: row.get(3)?,
            temp_id: row.get(4)?,
            metadata_json,
            preview_json,
            linked_mistake_ids,
            is_favorite: row.get::<_, i32>(8)? != 0,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        })
    }

    // ========================================================================
    // ★ Prompt 4: 不依赖 subject 的新方法
    // ========================================================================

    /// 在指定文件夹中创建题目集识别
    ///
    /// ★ Prompt 4: 新增方法，创建题目集同时自动创建 folder_items 记录
    pub fn create_exam_sheet_in_folder(
        db: &VfsDatabase,
        params: VfsCreateExamSheetParams,
        folder_id: Option<&str>,
    ) -> VfsResult<VfsExamSheet> {
        let conn = db.get_conn_safe()?;
        Self::create_exam_sheet_in_folder_with_conn(&conn, params, folder_id)
    }

    /// 在指定文件夹中创建题目集识别（使用现有连接）
    ///
    /// ★ CONC-01 修复：使用事务保护，防止步骤 2 成功但步骤 3 失败导致"孤儿资源"
    pub fn create_exam_sheet_in_folder_with_conn(
        conn: &Connection,
        params: VfsCreateExamSheetParams,
        folder_id: Option<&str>,
    ) -> VfsResult<VfsExamSheet> {
        // 开始事务
        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<VfsExamSheet> {
            // 1. 检查文件夹存在性
            if let Some(fid) = folder_id {
                if !VfsFolderRepo::folder_exists_with_conn(conn, fid)? {
                    return Err(VfsError::NotFound {
                        resource_type: "Folder".to_string(),
                        id: fid.to_string(),
                    });
                }
            }

            // 2. 创建题目集识别
            let exam = Self::create_exam_sheet_with_conn(conn, params.clone())?;

            // 3. 创建 folder_items 记录
            let folder_item = VfsFolderItem::new(
                folder_id.map(|s| s.to_string()),
                "exam".to_string(),
                exam.id.clone(),
            );
            VfsFolderRepo::add_item_to_folder_with_conn(conn, &folder_item)?;

            debug!(
                "[VFS::ExamRepo] Created exam {} in folder {:?}",
                exam.id, folder_id
            );

            Ok(exam)
        })();

        match result {
            Ok(exam) => {
                conn.execute("COMMIT", [])?;
                Ok(exam)
            }
            Err(e) => {
                // 回滚事务，忽略回滚本身的错误
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// 删除题目集识别（同时删除 folder_items 记录）
    ///
    /// ★ Prompt 4: 新增方法，删除题目集时自动清理 folder_items
    pub fn delete_exam_sheet_with_folder_item(db: &VfsDatabase, exam_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_exam_sheet_with_folder_item_with_conn(&conn, exam_id)
    }

    /// 删除题目集识别（使用现有连接，同时软删除 folder_items 记录和关联题目）
    ///
    /// ★ P0 修复：将 folder_items 的硬删除改为软删除，
    /// 确保恢复题目集时可以同步恢复 folder_items 记录
    ///
    /// ★ 2026-02: 新增软删除关联题目，防止孤儿数据
    ///
    /// 注意：使用 SAVEPOINT 以支持在外部事务中调用（如批量删除场景）
    pub fn delete_exam_sheet_with_folder_item_with_conn(
        conn: &Connection,
        exam_id: &str,
    ) -> VfsResult<()> {
        let now_str = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let now_ms = chrono::Utc::now().timestamp_millis();

        // 使用 SAVEPOINT 以支持嵌套事务（在外部事务中调用时不会出错）
        let savepoint_name = format!("delete_exam_{}", exam_id.replace("-", "_"));
        conn.execute(&format!("SAVEPOINT {}", savepoint_name), [])?;

        let result = (|| -> VfsResult<usize> {
            // 1. 软删除关联的题目（questions 表）
            let questions_deleted = conn.execute(
                "UPDATE questions SET deleted_at = ?1, updated_at = ?1 WHERE exam_id = ?2 AND deleted_at IS NULL",
                params![now_str, exam_id],
            )?;

            // 2. 软删除题目集识别
            Self::delete_exam_sheet_with_conn(conn, exam_id)?;

            // 3. 软删除 folder_items 记录（而不是硬删除）
            conn.execute(
                "UPDATE folder_items SET deleted_at = ?1, updated_at = ?1 WHERE item_type = 'exam' AND item_id = ?2 AND deleted_at IS NULL",
                params![now_ms, exam_id],
            )?;

            Ok(questions_deleted)
        })();

        match result {
            Ok(questions_deleted) => {
                conn.execute(&format!("RELEASE {}", savepoint_name), [])?;
                debug!(
                    "[VFS::ExamRepo] Soft deleted exam {}, its folder_items, and {} questions",
                    exam_id, questions_deleted
                );
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute(&format!("ROLLBACK TO {}", savepoint_name), []);
                let _ = conn.execute(&format!("RELEASE {}", savepoint_name), []);
                warn!(
                    "[VFS::ExamRepo] Delete exam {} failed, rolled back: {}",
                    exam_id, e
                );
                Err(e)
            }
        }
    }

    /// 按文件夹列出题目集识别
    ///
    /// ★ Prompt 4: 新增方法，通过 folder_items 查询题目集，不依赖 subject
    pub fn list_exam_sheets_by_folder(
        db: &VfsDatabase,
        folder_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsExamSheet>> {
        let conn = db.get_conn_safe()?;
        Self::list_exam_sheets_by_folder_with_conn(&conn, folder_id, limit, offset)
    }

    /// 按文件夹列出题目集识别（使用现有连接）
    pub fn list_exam_sheets_by_folder_with_conn(
        conn: &Connection,
        folder_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsExamSheet>> {
        let sql = r#"
            SELECT e.id, e.resource_id, e.exam_name, e.status, e.temp_id,
                   e.metadata_json, e.preview_json, e.linked_mistake_ids, e.created_at, e.updated_at
            FROM exam_sheets e
            JOIN folder_items fi ON fi.item_type = 'exam' AND fi.item_id = e.id
            WHERE fi.folder_id IS ?1 AND e.deleted_at IS NULL
            ORDER BY fi.sort_order ASC, e.updated_at DESC
            LIMIT ?2 OFFSET ?3
        "#;

        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![folder_id, limit, offset], Self::row_to_exam_sheet)?;

        let exams: Vec<VfsExamSheet> = rows.filter_map(log_and_skip_err).collect();
        debug!(
            "[VFS::ExamRepo] list_exam_sheets_by_folder({:?}): {} exams",
            folder_id,
            exams.len()
        );
        Ok(exams)
    }

    /// 获取题目集的 ResourceLocation
    ///
    /// ★ Prompt 4: 新增方法，获取题目集在 VFS 中的完整路径信息
    pub fn get_exam_sheet_location(
        db: &VfsDatabase,
        exam_id: &str,
    ) -> VfsResult<Option<ResourceLocation>> {
        let conn = db.get_conn_safe()?;
        Self::get_exam_sheet_location_with_conn(&conn, exam_id)
    }

    /// 获取题目集的 ResourceLocation（使用现有连接）
    pub fn get_exam_sheet_location_with_conn(
        conn: &Connection,
        exam_id: &str,
    ) -> VfsResult<Option<ResourceLocation>> {
        VfsFolderRepo::get_resource_location_with_conn(conn, "exam", exam_id)
    }

    // ========================================================================
    // 页级 OCR 存储
    // ========================================================================

    /// 保存题目集的页级 OCR 文本
    ///
    /// ## 参数
    /// - `exam_id`: 题目集 ID
    /// - `ocr_pages`: 按页索引的 OCR 文本数组，null 表示该页未 OCR 或失败
    pub fn save_ocr_pages(
        db: &VfsDatabase,
        exam_id: &str,
        ocr_pages: &[Option<String>],
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::save_ocr_pages_with_conn(&conn, exam_id, ocr_pages)
    }

    pub fn save_ocr_pages_with_conn(
        conn: &Connection,
        exam_id: &str,
        ocr_pages: &[Option<String>],
    ) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let ocr_json =
            serde_json::to_string(ocr_pages).map_err(|e| VfsError::Serialization(e.to_string()))?;

        let updated = conn.execute(
            "UPDATE exam_sheets SET ocr_pages_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![ocr_json, now, exam_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "ExamSheet".to_string(),
                id: exam_id.to_string(),
            });
        }

        debug!(
            "[VFS::ExamRepo] Saved {} OCR pages for exam {}",
            ocr_pages.len(),
            exam_id
        );
        Ok(())
    }

    /// 保存单页 OCR 文本
    pub fn save_page_ocr(
        db: &VfsDatabase,
        exam_id: &str,
        page_index: usize,
        ocr_text: &str,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::save_page_ocr_with_conn(&conn, exam_id, page_index, ocr_text)
    }

    pub fn save_page_ocr_with_conn(
        conn: &Connection,
        exam_id: &str,
        page_index: usize,
        ocr_text: &str,
    ) -> VfsResult<()> {
        // 获取现有 OCR 页面数组
        let existing: Option<String> = conn
            .query_row(
                "SELECT ocr_pages_json FROM exam_sheets WHERE id = ?1",
                params![exam_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();

        let mut pages: Vec<Option<String>> = existing
            .as_deref()
            .map(parse_ocr_pages_json)
            .unwrap_or_default();

        // 扩展数组以容纳新页
        while pages.len() <= page_index {
            pages.push(None);
        }
        pages[page_index] = Some(ocr_text.to_string());

        Self::save_ocr_pages_with_conn(conn, exam_id, &pages)
    }

    /// 获取题目集的页级 OCR 文本
    pub fn get_ocr_pages(db: &VfsDatabase, exam_id: &str) -> VfsResult<Vec<Option<String>>> {
        let conn = db.get_conn_safe()?;
        Self::get_ocr_pages_with_conn(&conn, exam_id)
    }

    pub fn get_ocr_pages_with_conn(
        conn: &Connection,
        exam_id: &str,
    ) -> VfsResult<Vec<Option<String>>> {
        let ocr_json: Option<String> = conn
            .query_row(
                "SELECT ocr_pages_json FROM exam_sheets WHERE id = ?1",
                params![exam_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();

        let pages: Vec<Option<String>> = ocr_json
            .as_deref()
            .map(parse_ocr_pages_json)
            .unwrap_or_default();

        Ok(pages)
    }

    /// 获取单页 OCR 文本
    pub fn get_page_ocr(
        db: &VfsDatabase,
        exam_id: &str,
        page_index: usize,
    ) -> VfsResult<Option<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_page_ocr_with_conn(&conn, exam_id, page_index)
    }

    pub fn get_page_ocr_with_conn(
        conn: &Connection,
        exam_id: &str,
        page_index: usize,
    ) -> VfsResult<Option<String>> {
        let pages = Self::get_ocr_pages_with_conn(conn, exam_id)?;
        Ok(pages.get(page_index).cloned().flatten())
    }

    // ========================================================================
    // 多模态索引状态管理（已废弃 - 使用 vfs_index_units 替代）
    // ========================================================================

    /// 获取题目集的多模态索引状态
    ///
    /// ⚠️ 已废弃：请使用 `VfsIndexService::get_resource_units` 替代
    #[deprecated(
        since = "2026.1",
        note = "使用 VfsIndexService::get_resource_units 替代"
    )]
    pub fn get_mm_index_state(db: &VfsDatabase, exam_id: &str) -> VfsResult<Option<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_mm_index_state_with_conn(&conn, exam_id)
    }

    /// ⚠️ 已废弃
    #[deprecated(
        since = "2026.1",
        note = "使用 VfsIndexService::get_resource_units 替代"
    )]
    #[allow(deprecated)]
    pub fn get_mm_index_state_with_conn(
        conn: &Connection,
        exam_id: &str,
    ) -> VfsResult<Option<String>> {
        let state: Option<String> = conn
            .query_row(
                "SELECT mm_index_state FROM exam_sheets WHERE id = ?1",
                params![exam_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        Ok(state)
    }

    /// 设置题目集的多模态索引状态
    ///
    /// ⚠️ 已废弃：请使用 `VfsIndexService` 替代
    #[deprecated(since = "2026.1", note = "使用 VfsIndexService 替代")]
    pub fn set_mm_index_state(
        db: &VfsDatabase,
        exam_id: &str,
        state: &str,
        error: Option<&str>,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::set_mm_index_state_with_conn(&conn, exam_id, state, error)
    }

    /// ⚠️ 已废弃
    #[deprecated(since = "2026.1", note = "使用 VfsIndexService 替代")]
    #[allow(deprecated)]
    pub fn set_mm_index_state_with_conn(
        conn: &Connection,
        exam_id: &str,
        state: &str,
        error: Option<&str>,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE exam_sheets SET mm_index_state = ?1, mm_index_error = ?2, updated_at = ?3 WHERE id = ?4",
            params![state, error, now, exam_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "ExamSheet".to_string(),
                id: exam_id.to_string(),
            });
        }

        debug!(
            "[VFS::ExamRepo] Set mm_index_state for {}: {}",
            exam_id, state
        );
        Ok(())
    }

    /// 保存题目集的多模态索引页面状态和元数据
    ///
    /// ⚠️ 已废弃：请使用 `VfsIndexService::sync_resource_units` 替代
    #[deprecated(
        since = "2026.1",
        note = "使用 VfsIndexService::sync_resource_units 替代"
    )]
    pub fn save_mm_index_metadata(
        db: &VfsDatabase,
        exam_id: &str,
        indexed_pages_json: &str,
        embedding_dim: i32,
        indexing_mode: &str,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::save_mm_index_metadata_with_conn(
            &conn,
            exam_id,
            indexed_pages_json,
            embedding_dim,
            indexing_mode,
        )
    }

    /// ⚠️ 已废弃
    #[deprecated(
        since = "2026.1",
        note = "使用 VfsIndexService::sync_resource_units 替代"
    )]
    #[allow(deprecated)]
    pub fn save_mm_index_metadata_with_conn(
        conn: &Connection,
        exam_id: &str,
        indexed_pages_json: &str,
        embedding_dim: i32,
        indexing_mode: &str,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let now_str = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        conn.execute(
            r#"UPDATE exam_sheets
               SET mm_indexed_pages_json = ?1, mm_embedding_dim = ?2, mm_indexing_mode = ?3,
                   mm_indexed_at = ?4, mm_index_state = 'indexed', updated_at = ?5
               WHERE id = ?6"#,
            params![
                indexed_pages_json,
                embedding_dim,
                indexing_mode,
                now,
                now_str,
                exam_id
            ],
        )?;

        info!(
            "[VFS::ExamRepo] Saved mm index metadata for exam {}: dim={}, mode={}",
            exam_id, embedding_dim, indexing_mode
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_exam_sheet_id_generation() {
        let id = VfsExamSheet::generate_id();
        assert!(id.starts_with("exam_"));
        assert_eq!(id.len(), 15); // "exam_" + 10 chars
    }
}
