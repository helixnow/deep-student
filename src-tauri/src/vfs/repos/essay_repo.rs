//! VFS 作文批改表 CRUD 操作
//!
//! 作文元数据管理，作文内容通过 `resource_id` 关联 `resources` 表。
//!
//! ## 核心方法
//! - `list_essays`: 列出作文
//! - `get_essay`: 获取作文
//! - `search_essays`: 搜索作文

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use tracing::{debug, info, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::repos::folder_repo::VfsFolderRepo;
use crate::vfs::repos::resource_repo::VfsResourceRepo;
use crate::vfs::types::{
    ResourceLocation, VfsCreateEssayParams, VfsCreateEssaySessionParams, VfsEssay, VfsEssaySession,
    VfsFolderItem, VfsResourceType,
};

/// Log row-parse errors instead of silently discarding them.
fn log_and_skip_err<T>(result: Result<T, rusqlite::Error>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("Row parse error (essay_repo): {}", e);
            None
        }
    }
}

/// VFS 作文批改表 Repo
pub struct VfsEssayRepo;

impl VfsEssayRepo {
    // ========================================================================
    // 列表查询
    // ========================================================================

    /// 列出作文
    pub fn list_essays(
        db: &VfsDatabase,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsEssay>> {
        let conn = db.get_conn_safe()?;
        Self::list_essays_with_conn(&conn, search, limit, offset)
    }

    /// 列出作文（使用现有连接）
    pub fn list_essays_with_conn(
        conn: &Connection,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsEssay>> {
        let mut sql = String::from(
            r#"
            SELECT e.id, e.resource_id, e.title, e.essay_type,
                   e.grading_result_json, e.score, e.session_id, e.round_number,
                   e.grade_level, e.custom_prompt, e.dimension_scores_json,
                   e.is_favorite, e.created_at, e.updated_at
            FROM essays e
            WHERE 1=1 AND e.deleted_at IS NULL
            "#,
        );

        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        let mut param_idx = 1;

        // 搜索过滤（在 title 和 resources.data 中搜索）
        if let Some(q) = search {
            sql.push_str(&format!(
                " AND (e.title LIKE ?{} OR EXISTS (SELECT 1 FROM resources r WHERE r.id = e.resource_id AND r.data LIKE ?{}))",
                param_idx, param_idx + 1
            ));
            let search_pattern = format!("%{}%", q);
            params_vec.push(Box::new(search_pattern.clone()));
            params_vec.push(Box::new(search_pattern));
            param_idx += 2;
        }

        sql.push_str(&format!(
            " ORDER BY e.updated_at DESC LIMIT ?{} OFFSET ?{}",
            param_idx,
            param_idx + 1
        ));
        params_vec.push(Box::new(limit));
        params_vec.push(Box::new(offset));

        let mut stmt = conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(params_refs.as_slice(), Self::row_to_essay)?;

        let essays: Vec<VfsEssay> = rows.filter_map(log_and_skip_err).collect();
        debug!("[VFS::EssayRepo] Listed {} essays", essays.len());
        Ok(essays)
    }

    /// ★ 2026-01-26 新增：按会话 ID 列出作文
    ///
    /// 用于获取某个作文会话下的所有轮次
    pub fn list_essays_by_session(db: &VfsDatabase, session_id: &str) -> VfsResult<Vec<VfsEssay>> {
        let conn = db.get_conn_safe()?;
        Self::list_essays_by_session_with_conn(&conn, session_id)
    }

    /// 按会话 ID 列出作文（使用现有连接）
    pub fn list_essays_by_session_with_conn(
        conn: &Connection,
        session_id: &str,
    ) -> VfsResult<Vec<VfsEssay>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, title, essay_type,
                   grading_result_json, score, session_id, round_number,
                   grade_level, custom_prompt, dimension_scores_json,
                   is_favorite, created_at, updated_at
            FROM essays
            WHERE session_id = ?1 AND deleted_at IS NULL
            ORDER BY round_number ASC, created_at ASC
            "#,
        )?;

        let rows = stmt.query_map(params![session_id], Self::row_to_essay)?;
        let essays: Vec<VfsEssay> = rows.filter_map(log_and_skip_err).collect();
        debug!(
            "[VFS::EssayRepo] Listed {} essays for session {}",
            essays.len(),
            session_id
        );
        Ok(essays)
    }

    // ========================================================================
    // 查询单个
    // ========================================================================

    /// 根据 ID 获取作文
    pub fn get_essay(db: &VfsDatabase, essay_id: &str) -> VfsResult<Option<VfsEssay>> {
        let conn = db.get_conn_safe()?;
        Self::get_essay_with_conn(&conn, essay_id)
    }

    /// 根据 ID 获取作文（使用现有连接）
    pub fn get_essay_with_conn(conn: &Connection, essay_id: &str) -> VfsResult<Option<VfsEssay>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, title, essay_type,
                   grading_result_json, score, session_id, round_number,
                   grade_level, custom_prompt, dimension_scores_json,
                   is_favorite, created_at, updated_at
            FROM essays
            WHERE id = ?1 AND deleted_at IS NULL
            "#,
        )?;

        let essay = stmt
            .query_row(params![essay_id], Self::row_to_essay)
            .optional()?;

        Ok(essay)
    }

    /// 获取作文内容
    ///
    /// 从关联的 resource.data 获取内容
    pub fn get_essay_content(db: &VfsDatabase, essay_id: &str) -> VfsResult<Option<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_essay_content_with_conn(&conn, essay_id)
    }

    /// 获取作文内容（使用现有连接）
    pub fn get_essay_content_with_conn(
        conn: &Connection,
        essay_id: &str,
    ) -> VfsResult<Option<String>> {
        let content: Option<String> = conn
            .query_row(
                r#"
                SELECT r.data
                FROM essays e
                JOIN resources r ON e.resource_id = r.id
                WHERE e.id = ?1 AND e.deleted_at IS NULL
                "#,
                params![essay_id],
                |row| row.get(0),
            )
            .optional()?;

        Ok(content)
    }

    // ========================================================================
    // 搜索
    // ========================================================================

    /// 搜索作文（用于全局搜索）
    ///
    pub fn search_essays(db: &VfsDatabase, query: &str, limit: u32) -> VfsResult<Vec<VfsEssay>> {
        let conn = db.get_conn_safe()?;
        Self::search_essays_with_conn(&conn, query, limit)
    }

    /// 搜索作文（使用现有连接）
    pub fn search_essays_with_conn(
        conn: &Connection,
        query: &str,
        limit: u32,
    ) -> VfsResult<Vec<VfsEssay>> {
        Self::list_essays_with_conn(conn, Some(query), limit, 0)
    }

    // ========================================================================
    // 创建
    // ========================================================================

    /// 创建作文记录（参数结构体版本）
    ///
    /// ★ B-3 修复（2026-02-02）：此方法自动管理事务
    pub fn create_essay(db: &VfsDatabase, params: VfsCreateEssayParams) -> VfsResult<VfsEssay> {
        let conn = db.get_conn_safe()?;

        // ★ B-3: 在入口点管理事务
        conn.execute("BEGIN IMMEDIATE", [])?;
        let result = Self::create_essay_internal(&conn, params);
        match result {
            Ok(essay) => {
                conn.execute("COMMIT", [])?;
                Ok(essay)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// 创建作文记录（使用现有连接，参数结构体版本）
    ///
    /// ## 注意
    /// **此方法不管理事务**，调用方必须确保在事务内调用（如果需要原子性）。
    /// 如果需要自动事务管理，请使用 `create_essay`。
    ///
    /// ★ 二轮修复（2026-02-02）：移除内部事务管理，防止嵌套事务问题
    pub fn create_essay_with_conn(
        conn: &Connection,
        params: VfsCreateEssayParams,
    ) -> VfsResult<VfsEssay> {
        Self::create_essay_internal(conn, params)
    }

    /// 内部创建作文实现（不含事务管理）
    ///
    /// ## 流程
    /// 1. 将作文内容存入 resources.data（SSOT）
    /// 2. 创建作文元数据记录
    fn create_essay_internal(
        conn: &Connection,
        params: VfsCreateEssayParams,
    ) -> VfsResult<VfsEssay> {
        // ★ S-013 修复：幂等性保护 — 同一 session_id + round_number 不重复创建
        if let Some(ref sid) = params.session_id {
            let existing_id: Option<String> = conn
                .query_row(
                    "SELECT id FROM essays WHERE session_id = ?1 AND round_number = ?2 AND deleted_at IS NULL",
                    params![sid, params.round_number],
                    |row| row.get(0),
                )
                .optional()?;

            if let Some(essay_id) = existing_id {
                info!(
                    "[VFS::EssayRepo] S-013 idempotency: essay already exists for session={}, round={}, returning existing id={}",
                    sid, params.round_number, essay_id
                );
                if let Some(existing) = Self::get_essay_with_conn(conn, &essay_id)? {
                    return Ok(existing);
                }
                // 如果 get 返回 None（理论上不会，因为 SELECT 刚查到），继续创建
            }
        }

        // 1. 创建或复用资源
        let resource_result = VfsResourceRepo::create_or_reuse_with_conn(
            conn,
            VfsResourceType::Essay,
            &params.content,
            None,
            Some("essays"),
            None,
        )?;

        // 2. 创建作文记录
        let essay_id = VfsEssay::generate_id();
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let grading_str = params
            .grading_result
            .as_ref()
            .map(|g| serde_json::to_string(g).unwrap_or_default());
        let dimension_str = params
            .dimension_scores
            .as_ref()
            .map(|d| serde_json::to_string(d).unwrap_or_default());

        conn.execute(
            r#"
            INSERT INTO essays (id, resource_id, title, essay_type,
                               grading_result_json, score, session_id, round_number,
                               grade_level, custom_prompt, dimension_scores_json,
                               created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            "#,
            params![
                essay_id,
                resource_result.resource_id,
                params.title,
                params.essay_type,
                grading_str,
                params.score,
                params.session_id,
                params.round_number,
                params.grade_level,
                params.custom_prompt,
                dimension_str,
                now,
                now,
            ],
        )?;

        // 3. 更新资源的 source_id
        conn.execute(
            "UPDATE resources SET source_id = ?1 WHERE id = ?2",
            params![essay_id, resource_result.resource_id],
        )?;

        // 4. 如果有 session_id，更新会话统计
        if let Some(ref session_id) = params.session_id {
            Self::update_session_stats_with_conn(conn, session_id, params.score)?;
        }

        info!(
            "[VFS::EssayRepo] Created essay: {} (resource: {}, session: {:?}, round: {})",
            essay_id, resource_result.resource_id, params.session_id, params.round_number
        );

        Ok(VfsEssay {
            id: essay_id,
            resource_id: resource_result.resource_id,
            title: params.title,
            essay_type: params.essay_type,
            grading_result: params.grading_result,
            score: params.score,
            session_id: params.session_id,
            round_number: params.round_number,
            grade_level: params.grade_level,
            custom_prompt: params.custom_prompt,
            is_favorite: false,
            dimension_scores: params.dimension_scores,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    /// 更新会话统计信息
    fn update_session_stats_with_conn(
        conn: &Connection,
        session_id: &str,
        latest_score: Option<i32>,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        // 统计该会话的轮次数
        let total_rounds: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM essays WHERE session_id = ?1 AND deleted_at IS NULL",
                params![session_id],
                |row| row.get(0),
            )
            .unwrap_or(0);

        // 更新会话记录
        conn.execute(
            r#"
            UPDATE essay_sessions
            SET total_rounds = ?1, latest_score = COALESCE(?2, latest_score), updated_at = ?3
            WHERE id = ?4
            "#,
            params![total_rounds, latest_score, now, session_id],
        )?;

        Ok(())
    }

    // ========================================================================
    // 更新
    // ========================================================================

    /// 更新批改结果
    pub fn update_grading_result(
        db: &VfsDatabase,
        essay_id: &str,
        grading_result: &Value,
        score: Option<i32>,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::update_grading_result_with_conn(&conn, essay_id, grading_result, score)
    }

    /// 更新批改结果（使用现有连接）
    pub fn update_grading_result_with_conn(
        conn: &Connection,
        essay_id: &str,
        grading_result: &Value,
        score: Option<i32>,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let grading_str = serde_json::to_string(grading_result)
            .map_err(|e| VfsError::Serialization(e.to_string()))?;

        let updated = conn.execute(
            "UPDATE essays SET grading_result_json = ?1, score = ?2, updated_at = ?3 WHERE id = ?4",
            params![grading_str, score, now, essay_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "Essay".to_string(),
                id: essay_id.to_string(),
            });
        }

        info!(
            "[VFS::EssayRepo] Updated grading result for essay: {}",
            essay_id
        );
        Ok(())
    }

    /// 更新作文标题
    pub fn update_title(db: &VfsDatabase, essay_id: &str, title: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::update_title_with_conn(&conn, essay_id, title)
    }

    /// 更新作文标题（使用现有连接）
    pub fn update_title_with_conn(conn: &Connection, essay_id: &str, title: &str) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE essays SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, now, essay_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "Essay".to_string(),
                id: essay_id.to_string(),
            });
        }

        Ok(())
    }

    // ========================================================================
    // 删除（软删除）
    // ========================================================================

    /// 删除作文记录（软删除，移到回收站）
    ///
    /// ★ 2025-12-11: 统一语义，delete = 软删除，purge = 永久删除
    pub fn delete_essay(db: &VfsDatabase, essay_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_essay_with_conn(&conn, essay_id)
    }

    /// 删除作文记录（软删除，使用现有连接）
    pub fn delete_essay_with_conn(conn: &Connection, essay_id: &str) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE essays SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![now, essay_id],
        )?;

        if updated == 0 {
            // ★ P0 修复：幂等处理 - 检查是否已被软删除
            let already_deleted: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM essays WHERE id = ?1 AND deleted_at IS NOT NULL)",
                    params![essay_id],
                    |row| row.get(0),
                )
                .unwrap_or(false);

            if already_deleted {
                info!(
                    "[VFS::EssayRepo] Essay already deleted (idempotent): {}",
                    essay_id
                );
            } else {
                return Err(VfsError::NotFound {
                    resource_type: "Essay".to_string(),
                    id: essay_id.to_string(),
                });
            }
        }

        info!("[VFS::EssayRepo] Soft deleted essay: {}", essay_id);
        Ok(())
    }

    // ========================================================================
    // 永久删除（purge）
    // ========================================================================

    /// 永久删除作文记录（从数据库彻底删除，不可恢复）
    ///
    /// ★ 2025-12-11: 统一语义，purge = 永久删除
    /// ★ 二轮修复（2026-02-02）：添加事务保护
    pub fn purge_essay(db: &VfsDatabase, essay_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;

        // ★ 二轮修复：在入口点管理事务
        conn.execute("BEGIN IMMEDIATE", [])?;
        let result = Self::purge_essay_with_conn(&conn, essay_id);
        match result {
            Ok(()) => {
                conn.execute("COMMIT", [])?;
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// 永久删除作文记录（使用现有连接）
    ///
    /// ## 注意
    /// **此方法不管理事务**，调用方应确保在事务内调用（如果需要原子性）。
    ///
    /// ★ B-9 修复（2026-02-02）：同时清理关联的 resources 记录
    /// ★ 二轮修复：添加 folder_items 清理
    pub fn purge_essay_with_conn(conn: &Connection, essay_id: &str) -> VfsResult<()> {
        // ★ B-9: 先获取关联的 resource_id
        let resource_id: Option<String> = conn
            .query_row(
                "SELECT resource_id FROM essays WHERE id = ?1",
                params![essay_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();

        // 删除 essay 记录
        let deleted = conn.execute("DELETE FROM essays WHERE id = ?1", params![essay_id])?;

        if deleted == 0 {
            return Err(VfsError::NotFound {
                resource_type: "Essay".to_string(),
                id: essay_id.to_string(),
            });
        }

        // ★ 二轮修复：清理 folder_items 记录
        conn.execute(
            "DELETE FROM folder_items WHERE item_type = 'essay' AND item_id = ?1",
            params![essay_id],
        )?;

        // ★ B-9: 清理关联的 resource（如果存在且没有其他引用）
        if let Some(rid) = resource_id {
            // 检查该 resource 是否还被其他 essay 引用
            let ref_count: i32 = conn
                .query_row(
                    "SELECT COUNT(*) FROM essays WHERE resource_id = ?1",
                    params![&rid],
                    |row| row.get(0),
                )
                .unwrap_or(0);

            if ref_count == 0 {
                // 没有其他引用，可以安全删除 resource
                conn.execute("DELETE FROM resources WHERE id = ?1", params![&rid])?;
                debug!("[VFS::EssayRepo] Purged orphan resource: {}", rid);
            }
        }

        info!("[VFS::EssayRepo] Purged essay: {}", essay_id);
        Ok(())
    }

    // ========================================================================
    // 兼容别名与恢复
    // ========================================================================

    /// 软删除作文（兼容旧调用，等同于 delete_essay）
    #[deprecated(note = "使用 delete_essay 替代")]
    pub fn soft_delete_essay(db: &VfsDatabase, essay_id: &str) -> VfsResult<()> {
        Self::delete_essay(db, essay_id)
    }

    /// 软删除作文（兼容旧调用，使用现有连接）
    #[deprecated(note = "使用 delete_essay_with_conn 替代")]
    pub fn soft_delete_essay_with_conn(conn: &Connection, essay_id: &str) -> VfsResult<()> {
        Self::delete_essay_with_conn(conn, essay_id)
    }

    /// 恢复软删除的作文
    pub fn restore_essay(db: &VfsDatabase, essay_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::restore_essay_with_conn(&conn, essay_id)
    }

    /// 恢复软删除的作文（使用现有连接）
    ///
    /// ★ CONC-02 修复：同步恢复 folder_items 中的关联记录
    pub fn restore_essay_with_conn(conn: &Connection, essay_id: &str) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE essays SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NOT NULL",
            params![now, essay_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "Essay".to_string(),
                id: essay_id.to_string(),
            });
        }

        // ★ CONC-02 修复：恢复 folder_items 中的关联记录
        let now_ms = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE folder_items SET deleted_at = NULL, updated_at = ?1 WHERE item_type = 'essay' AND item_id = ?2 AND deleted_at IS NOT NULL",
            params![now_ms, essay_id],
        )?;

        info!("[VFS::EssayRepo] Restored essay: {}", essay_id);
        Ok(())
    }

    /// 列出已删除的作文（回收站）
    ///
    pub fn list_deleted_essays(
        db: &VfsDatabase,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsEssay>> {
        let conn = db.get_conn_safe()?;
        Self::list_deleted_essays_with_conn(&conn, limit, offset)
    }

    /// 列出已删除的作文（使用现有连接）
    pub fn list_deleted_essays_with_conn(
        conn: &Connection,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsEssay>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT e.id, e.resource_id, e.title, e.essay_type,
                   e.grading_result_json, e.score, e.session_id, e.round_number,
                   e.grade_level, e.custom_prompt, e.dimension_scores_json,
                   e.is_favorite, e.created_at, e.updated_at
            FROM essays e
            WHERE e.deleted_at IS NOT NULL
            ORDER BY e.deleted_at DESC
            LIMIT ?1 OFFSET ?2
            "#,
        )?;

        let rows = stmt.query_map(params![limit, offset], Self::row_to_essay)?;
        let essays: Vec<VfsEssay> = rows.filter_map(log_and_skip_err).collect();
        debug!("[VFS::EssayRepo] Listed {} deleted essays", essays.len());
        Ok(essays)
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    /// 从行数据构建 VfsEssay
    ///
    /// 列顺序：id(0), resource_id(1), title(2), essay_type(3), grading_result_json(4), score(5),
    ///         session_id(6), round_number(7), grade_level(8), custom_prompt(9),
    ///         dimension_scores_json(10), is_favorite(11), created_at(12), updated_at(13)
    fn row_to_essay(row: &rusqlite::Row) -> rusqlite::Result<VfsEssay> {
        let grading_str: Option<String> = row.get(4)?;
        let grading_result: Option<Value> = grading_str.and_then(|s| serde_json::from_str(&s).ok());
        let dimension_str: Option<String> = row.get(10).ok().flatten();
        let dimension_scores: Option<Value> =
            dimension_str.and_then(|s| serde_json::from_str(&s).ok());

        Ok(VfsEssay {
            id: row.get(0)?,
            resource_id: row.get(1)?,
            title: row.get(2)?,
            essay_type: row.get(3)?,
            grading_result,
            score: row.get(5)?,
            session_id: row.get(6).ok().flatten(),
            round_number: row.get(7).unwrap_or(1),
            grade_level: row.get(8).ok().flatten(),
            custom_prompt: row.get(9).ok().flatten(),
            is_favorite: row.get::<_, i32>(11).unwrap_or(0) != 0,
            dimension_scores,
            created_at: row.get(12)?,
            updated_at: row.get(13)?,
        })
    }

    // ========================================================================
    // 会话操作
    // ========================================================================

    /// 创建作文会话
    pub fn create_session(
        db: &VfsDatabase,
        params: VfsCreateEssaySessionParams,
    ) -> VfsResult<VfsEssaySession> {
        let conn = db.get_conn_safe()?;
        Self::create_session_with_conn(&conn, params)
    }

    /// 创建作文会话（使用现有连接）
    ///
    pub fn create_session_with_conn(
        conn: &Connection,
        params: VfsCreateEssaySessionParams,
    ) -> VfsResult<VfsEssaySession> {
        let session_id = VfsEssay::generate_session_id();
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        conn.execute(
            r#"
            INSERT INTO essay_sessions (id, title, essay_type, grade_level, custom_prompt,
                                        total_rounds, is_favorite, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6, ?7)
            "#,
            params![
                session_id,
                params.title,
                params.essay_type,
                params.grade_level,
                params.custom_prompt,
                now,
                now,
            ],
        )?;

        info!("[VFS::EssayRepo] Created essay session: {}", session_id);

        Ok(VfsEssaySession {
            id: session_id,
            title: params.title,
            essay_type: params.essay_type,
            grade_level: params.grade_level,
            custom_prompt: params.custom_prompt,
            total_rounds: 0,
            latest_score: None,
            is_favorite: false,
            created_at: now.clone(),
            updated_at: now,
            deleted_at: None,
        })
    }

    // ========================================================================
    // ★ Prompt 4: 不依赖 subject 的新方法（会话版）
    // ========================================================================

    /// 在指定文件夹中创建作文会话
    ///
    /// - `folder_id = None` 表示根目录（仍会创建 folder_items 记录，便于后续移动）
    pub fn create_session_in_folder(
        db: &VfsDatabase,
        params: VfsCreateEssaySessionParams,
        folder_id: Option<&str>,
    ) -> VfsResult<VfsEssaySession> {
        let conn = db.get_conn_safe()?;
        Self::create_session_in_folder_with_conn(&conn, params, folder_id)
    }

    /// 在指定文件夹中创建作文会话（使用现有连接）
    ///
    /// ★ CONC-01 修复：使用事务保护，防止会话创建成功但 folder_items 失败导致"孤儿资源"
    pub fn create_session_in_folder_with_conn(
        conn: &Connection,
        params: VfsCreateEssaySessionParams,
        folder_id: Option<&str>,
    ) -> VfsResult<VfsEssaySession> {
        // 开始事务
        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<VfsEssaySession> {
            // 1. 检查文件夹存在性
            if let Some(fid) = folder_id {
                if !VfsFolderRepo::folder_exists_with_conn(conn, fid)? {
                    return Err(VfsError::NotFound {
                        resource_type: "Folder".to_string(),
                        id: fid.to_string(),
                    });
                }
            }

            // 2. 创建会话
            let session = Self::create_session_with_conn(conn, params)?;

            // 3. 创建 folder_items 记录（item_type 使用 "essay"，item_id 使用 essay_session_*）
            let folder_item = VfsFolderItem::new(
                folder_id.map(|s| s.to_string()),
                "essay".to_string(),
                session.id.clone(),
            );
            VfsFolderRepo::add_item_to_folder_with_conn(conn, &folder_item)?;

            debug!(
                "[VFS::EssayRepo] Created essay session {} in folder {:?}",
                session.id, folder_id
            );

            Ok(session)
        })();

        match result {
            Ok(session) => {
                conn.execute("COMMIT", [])?;
                Ok(session)
            }
            Err(e) => {
                // 回滚事务，忽略回滚本身的错误
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// 获取作文会话
    pub fn get_session(db: &VfsDatabase, session_id: &str) -> VfsResult<Option<VfsEssaySession>> {
        let conn = db.get_conn_safe()?;
        Self::get_session_with_conn(&conn, session_id)
    }

    /// 获取作文会话（使用现有连接）
    pub fn get_session_with_conn(
        conn: &Connection,
        session_id: &str,
    ) -> VfsResult<Option<VfsEssaySession>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, title, essay_type, grade_level, custom_prompt,
                   total_rounds, latest_score, is_favorite, created_at, updated_at, deleted_at
            FROM essay_sessions
            WHERE id = ?1 AND deleted_at IS NULL
            "#,
        )?;

        let session = stmt
            .query_row(params![session_id], Self::row_to_session)
            .optional()?;

        Ok(session)
    }

    /// 列出作文会话
    pub fn list_sessions(
        db: &VfsDatabase,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsEssaySession>> {
        let conn = db.get_conn_safe()?;
        Self::list_sessions_with_conn(&conn, limit, offset)
    }

    /// 列出作文会话（使用现有连接）
    pub fn list_sessions_with_conn(
        conn: &Connection,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsEssaySession>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, title, essay_type, grade_level, custom_prompt,
                   total_rounds, latest_score, is_favorite, created_at, updated_at, deleted_at
            FROM essay_sessions
            WHERE deleted_at IS NULL
            ORDER BY updated_at DESC
            LIMIT ?1 OFFSET ?2
            "#,
        )?;

        let rows = stmt.query_map(params![limit, offset], Self::row_to_session)?;
        let sessions: Vec<VfsEssaySession> = rows.filter_map(log_and_skip_err).collect();

        Ok(sessions)
    }

    /// 更新会话信息
    pub fn update_session(
        db: &VfsDatabase,
        session_id: &str,
        title: Option<&str>,
        is_favorite: Option<bool>,
        essay_type: Option<&str>,
        grade_level: Option<&str>,
        custom_prompt: Option<&str>,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        // 先验证 session 存在，避免对不存在的 id 静默成功
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM essay_sessions WHERE id = ?1)",
                params![session_id],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !exists {
            return Err(VfsError::NotFound {
                resource_type: "EssaySession".to_string(),
                id: session_id.to_string(),
            });
        }

        if let Some(t) = title {
            conn.execute(
                "UPDATE essay_sessions SET title = ?1, updated_at = ?2 WHERE id = ?3",
                params![t, now, session_id],
            )?;
        }

        if let Some(fav) = is_favorite {
            conn.execute(
                "UPDATE essay_sessions SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3",
                params![fav as i32, now, session_id],
            )?;
        }

        if let Some(t) = essay_type {
            conn.execute(
                "UPDATE essay_sessions SET essay_type = ?1, updated_at = ?2 WHERE id = ?3",
                params![t, now, session_id],
            )?;
        }

        if let Some(level) = grade_level {
            conn.execute(
                "UPDATE essay_sessions SET grade_level = ?1, updated_at = ?2 WHERE id = ?3",
                params![level, now, session_id],
            )?;
        }

        if let Some(prompt) = custom_prompt {
            conn.execute(
                "UPDATE essay_sessions SET custom_prompt = ?1, updated_at = ?2 WHERE id = ?3",
                params![prompt, now, session_id],
            )?;
        }

        Ok(())
    }

    /// 永久删除会话及其所有轮次
    ///
    /// ★ 2025-12-11: 统一命名规范，purge = 永久删除
    /// ★ B-5 修复（2026-02-02）：同时清理关联的 resources 和 folder_items
    /// 注意：会话没有软删除机制，直接从数据库中删除。
    pub fn purge_session(db: &VfsDatabase, session_id: &str) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;

        // ★ B-5: 使用事务保护
        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<usize> {
            // ★ B-5: 先获取关联的 resource_ids
            let mut stmt = conn.prepare("SELECT resource_id FROM essays WHERE session_id = ?1")?;
            let resource_ids: Vec<String> = stmt
                .query_map(params![session_id], |row| row.get::<_, Option<String>>(0))?
                .filter_map(log_and_skip_err)
                .flatten()
                .collect();

            // 删除关联的作文
            let deleted_essays = conn.execute(
                "DELETE FROM essays WHERE session_id = ?1",
                params![session_id],
            )?;

            // 删除会话
            conn.execute(
                "DELETE FROM essay_sessions WHERE id = ?1",
                params![session_id],
            )?;

            // ★ B-5: 删除 folder_items 记录
            conn.execute(
                "DELETE FROM folder_items WHERE item_type = 'essay' AND item_id = ?1",
                params![session_id],
            )?;

            // ★ B-5: 清理 orphan resources（没有被其他 essay 引用的）
            for rid in &resource_ids {
                let ref_count: i32 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM essays WHERE resource_id = ?1",
                        params![rid],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);

                if ref_count == 0 {
                    conn.execute("DELETE FROM resources WHERE id = ?1", params![rid])?;
                    debug!("[VFS::EssayRepo] Purged orphan resource: {}", rid);
                }
            }

            info!(
                "[VFS::EssayRepo] Purged session {} with {} essays and {} resources",
                session_id,
                deleted_essays,
                resource_ids.len()
            );
            Ok(deleted_essays)
        })();

        // 提交或回滚
        match result {
            Ok(count) => {
                conn.execute("COMMIT", [])?;
                Ok(count)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    // ========================================================================
    // 回收站：会话软删除/恢复/列表
    // ========================================================================

    /// 软删除作文会话（回收站）
    pub fn delete_session(db: &VfsDatabase, session_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_session_with_conn(&conn, session_id)
    }

    /// 软删除作文会话（使用现有连接）
    pub fn delete_session_with_conn(conn: &Connection, session_id: &str) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let updated = conn.execute(
            "UPDATE essay_sessions SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![now, session_id],
        )?;
        if updated == 0 {
            // ★ P0 修复：幂等处理 - 检查是否已被软删除
            let already_deleted: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM essay_sessions WHERE id = ?1 AND deleted_at IS NOT NULL)",
                    params![session_id],
                    |row| row.get(0),
                )
                .unwrap_or(false);

            if already_deleted {
                info!(
                    "[VFS::EssayRepo] Essay session already deleted (idempotent): {}",
                    session_id
                );
            } else {
                return Err(VfsError::NotFound {
                    resource_type: "EssaySession".to_string(),
                    id: session_id.to_string(),
                });
            }
        }
        info!(
            "[VFS::EssayRepo] Soft deleted essay session: {}",
            session_id
        );
        Ok(())
    }

    /// 软删除作文会话，并清理 folder_items 记录（DSTU delete 使用）
    pub fn delete_session_with_folder_item(db: &VfsDatabase, session_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_session_with_folder_item_with_conn(&conn, session_id)
    }

    /// 软删除作文会话，并软删除 folder_items 记录（使用现有连接）
    ///
    /// ★ P0 修复：改为软删除 folder_items（而非硬删除），确保恢复时能同步恢复
    pub fn delete_session_with_folder_item_with_conn(
        conn: &Connection,
        session_id: &str,
    ) -> VfsResult<()> {
        Self::delete_session_with_conn(conn, session_id)?;
        // ★ P0 修复：deleted_at 是 TEXT 列，updated_at 是 INTEGER 列，必须分开处理
        let now_str = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        let now_ms = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE folder_items SET deleted_at = ?1, updated_at = ?2 WHERE item_type = 'essay' AND item_id = ?3 AND deleted_at IS NULL",
            params![now_str, now_ms, session_id],
        )?;
        Ok(())
    }

    /// 恢复作文会话
    pub fn restore_session(db: &VfsDatabase, session_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::restore_session_with_conn(&conn, session_id)
    }

    /// 恢复作文会话（使用现有连接）
    ///
    /// ★ P0 修复：同时恢复 folder_items 记录（配合软删除修复）
    pub fn restore_session_with_conn(conn: &Connection, session_id: &str) -> VfsResult<()> {
        let updated = conn.execute(
            "UPDATE essay_sessions SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL",
            params![session_id],
        )?;
        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "EssaySession".to_string(),
                id: session_id.to_string(),
            });
        }

        // ★ P0 修复：恢复 folder_items 中的关联记录
        let now_ms = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE folder_items SET deleted_at = NULL, updated_at = ?1 WHERE item_type = 'essay' AND item_id = ?2 AND deleted_at IS NOT NULL",
            params![now_ms, session_id],
        )?;

        info!("[VFS::EssayRepo] Restored essay session: {}", session_id);
        Ok(())
    }

    /// 列出已删除的作文会话（回收站）
    pub fn list_deleted_sessions(
        db: &VfsDatabase,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsEssaySession>> {
        let conn = db.get_conn_safe()?;
        Self::list_deleted_sessions_with_conn(&conn, limit, offset)
    }

    /// 列出已删除的作文会话（使用现有连接）
    pub fn list_deleted_sessions_with_conn(
        conn: &Connection,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsEssaySession>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, title, essay_type, grade_level, custom_prompt,
                   total_rounds, latest_score, is_favorite, created_at, updated_at, deleted_at
            FROM essay_sessions
            WHERE deleted_at IS NOT NULL
            ORDER BY deleted_at DESC
            LIMIT ?1 OFFSET ?2
            "#,
        )?;

        let rows = stmt.query_map(params![limit, offset], Self::row_to_session)?;
        let sessions: Vec<VfsEssaySession> = rows.filter_map(log_and_skip_err).collect();
        debug!(
            "[VFS::EssayRepo] Listed {} deleted essay sessions",
            sessions.len()
        );
        Ok(sessions)
    }

    /// 从行数据构建 VfsEssaySession
    ///
    /// 列顺序：id(0), title(1), essay_type(2), grade_level(3), custom_prompt(4),
    ///         total_rounds(5), latest_score(6), is_favorite(7), created_at(8), updated_at(9), deleted_at(10)
    fn row_to_session(row: &rusqlite::Row) -> rusqlite::Result<VfsEssaySession> {
        Ok(VfsEssaySession {
            id: row.get(0)?,
            title: row.get(1)?,
            essay_type: row.get(2)?,
            grade_level: row.get(3)?,
            custom_prompt: row.get(4)?,
            total_rounds: row.get(5)?,
            latest_score: row.get(6)?,
            is_favorite: row.get::<_, i32>(7)? != 0,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
            deleted_at: row.get(10)?,
        })
    }

    // ========================================================================
    // 轮次查询
    // ========================================================================

    /// 获取会话的所有轮次（按轮次编号排序）
    pub fn get_rounds_by_session(db: &VfsDatabase, session_id: &str) -> VfsResult<Vec<VfsEssay>> {
        let conn = db.get_conn_safe()?;
        Self::get_rounds_by_session_with_conn(&conn, session_id)
    }

    /// 获取会话的所有轮次（使用现有连接）
    pub fn get_rounds_by_session_with_conn(
        conn: &Connection,
        session_id: &str,
    ) -> VfsResult<Vec<VfsEssay>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, title, essay_type,
                   grading_result_json, score, session_id, round_number,
                   grade_level, custom_prompt, dimension_scores_json,
                   is_favorite, created_at, updated_at
            FROM essays
            WHERE session_id = ?1 AND deleted_at IS NULL
            ORDER BY round_number ASC, created_at ASC
            "#,
        )?;

        let rows = stmt.query_map(params![session_id], Self::row_to_essay)?;
        let essays: Vec<VfsEssay> = rows.filter_map(log_and_skip_err).collect();

        Ok(essays)
    }

    /// 获取会话的最新轮次编号
    pub fn get_latest_round_number(db: &VfsDatabase, session_id: &str) -> VfsResult<i32> {
        let conn = db.get_conn_safe()?;
        let round: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(round_number), 0) FROM essays WHERE session_id = ?1 AND deleted_at IS NULL",
                params![session_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        Ok(round)
    }

    /// 获取指定轮次
    pub fn get_round(
        db: &VfsDatabase,
        session_id: &str,
        round_number: i32,
    ) -> VfsResult<Option<VfsEssay>> {
        let conn = db.get_conn_safe()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, title, essay_type,
                   grading_result_json, score, session_id, round_number,
                   grade_level, custom_prompt, dimension_scores_json,
                   is_favorite, created_at, updated_at
            FROM essays
            WHERE session_id = ?1 AND round_number = ?2 AND deleted_at IS NULL
            "#,
        )?;

        let essay = stmt
            .query_row(params![session_id, round_number], Self::row_to_essay)
            .optional()?;

        Ok(essay)
    }

    /// 切换会话收藏状态
    pub fn toggle_session_favorite(db: &VfsDatabase, session_id: &str) -> VfsResult<bool> {
        let conn = db.get_conn_safe()?;
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        // 获取当前状态 — 不存在时返回 NotFound 而非静默默认值
        let current: i32 = conn
            .query_row(
                "SELECT is_favorite FROM essay_sessions WHERE id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => VfsError::NotFound {
                    resource_type: "EssaySession".to_string(),
                    id: session_id.to_string(),
                },
                _ => VfsError::from(e),
            })?;

        let new_state = current == 0;

        let updated = conn.execute(
            "UPDATE essay_sessions SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_state as i32, now, session_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "EssaySession".to_string(),
                id: session_id.to_string(),
            });
        }

        Ok(new_state)
    }

    // ========================================================================
    // ★ Prompt 4: 不依赖 subject 的新方法
    // ========================================================================

    /// 在指定文件夹中创建作文
    ///
    /// ★ Prompt 4: 新增方法，创建作文同时自动创建 folder_items 记录
    pub fn create_essay_in_folder(
        db: &VfsDatabase,
        params: VfsCreateEssayParams,
        folder_id: Option<&str>,
    ) -> VfsResult<VfsEssay> {
        let conn = db.get_conn_safe()?;
        Self::create_essay_in_folder_with_conn(&conn, params, folder_id)
    }

    /// 在指定文件夹中创建作文（使用现有连接）
    ///
    /// ★ CONC-01 修复：使用事务保护，防止作文创建成功但 folder_items 失败导致"孤儿资源"
    pub fn create_essay_in_folder_with_conn(
        conn: &Connection,
        params: VfsCreateEssayParams,
        folder_id: Option<&str>,
    ) -> VfsResult<VfsEssay> {
        // 开始事务
        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<VfsEssay> {
            // 1. 检查文件夹存在性
            if let Some(fid) = folder_id {
                if !VfsFolderRepo::folder_exists_with_conn(conn, fid)? {
                    return Err(VfsError::NotFound {
                        resource_type: "Folder".to_string(),
                        id: fid.to_string(),
                    });
                }
            }

            // 2. 创建作文
            let essay = Self::create_essay_with_conn(conn, params.clone())?;

            // 3. 创建 folder_items 记录
            let folder_item = VfsFolderItem::new(
                folder_id.map(|s| s.to_string()),
                "essay".to_string(),
                essay.id.clone(),
            );
            VfsFolderRepo::add_item_to_folder_with_conn(conn, &folder_item)?;

            debug!(
                "[VFS::EssayRepo] Created essay {} in folder {:?}",
                essay.id, folder_id
            );

            Ok(essay)
        })();

        match result {
            Ok(essay) => {
                conn.execute("COMMIT", [])?;
                Ok(essay)
            }
            Err(e) => {
                // 回滚事务，忽略回滚本身的错误
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// 删除作文（同时删除 folder_items 记录）
    ///
    /// ★ Prompt 4: 新增方法，删除作文时自动清理 folder_items
    pub fn delete_essay_with_folder_item(db: &VfsDatabase, essay_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_essay_with_folder_item_with_conn(&conn, essay_id)
    }

    /// 删除作文（使用现有连接，同时软删除 folder_items 记录）
    ///
    /// ★ CONC-02 修复：folder_items 改为软删除，支持恢复
    pub fn delete_essay_with_folder_item_with_conn(
        conn: &Connection,
        essay_id: &str,
    ) -> VfsResult<()> {
        // 1. 软删除作文
        Self::delete_essay_with_conn(conn, essay_id)?;

        // 2. 软删除 folder_items（而非硬删除）
        // ★ P0 修复：deleted_at 是 TEXT 列，updated_at 是 INTEGER 列，必须分开处理
        let now_str = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        let now_ms = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE folder_items SET deleted_at = ?1, updated_at = ?2 WHERE item_type = 'essay' AND item_id = ?3 AND deleted_at IS NULL",
            params![now_str, now_ms, essay_id],
        )?;

        info!(
            "[VFS::EssayRepo] Soft deleted essay with folder_item: {}",
            essay_id
        );
        Ok(())
    }

    /// 按文件夹列出作文
    ///
    /// ★ Prompt 4: 新增方法，通过 folder_items 查询作文，不依赖 subject
    pub fn list_essays_by_folder(
        db: &VfsDatabase,
        folder_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsEssay>> {
        let conn = db.get_conn_safe()?;
        Self::list_essays_by_folder_with_conn(&conn, folder_id, limit, offset)
    }

    /// 按文件夹列出作文（使用现有连接）
    pub fn list_essays_by_folder_with_conn(
        conn: &Connection,
        folder_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsEssay>> {
        let sql = r#"
            SELECT e.id, e.resource_id, e.title, e.essay_type, e.grading_result_json, e.score,
                   e.session_id, e.round_number, e.grade_level, e.custom_prompt, e.dimension_scores_json,
                   e.is_favorite, e.created_at, e.updated_at
            FROM essays e
            JOIN folder_items fi ON fi.item_type = 'essay' AND fi.item_id = e.id
            WHERE fi.folder_id IS ?1
            ORDER BY fi.sort_order ASC, e.updated_at DESC
            LIMIT ?2 OFFSET ?3
        "#;

        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![folder_id, limit, offset], Self::row_to_essay)?;

        let essays: Vec<VfsEssay> = rows.filter_map(log_and_skip_err).collect();
        debug!(
            "[VFS::EssayRepo] list_essays_by_folder({:?}): {} essays",
            folder_id,
            essays.len()
        );
        Ok(essays)
    }

    /// 获取作文的 ResourceLocation
    ///
    /// ★ Prompt 4: 新增方法，获取作文在 VFS 中的完整路径信息
    pub fn get_essay_location(
        db: &VfsDatabase,
        essay_id: &str,
    ) -> VfsResult<Option<ResourceLocation>> {
        let conn = db.get_conn_safe()?;
        Self::get_essay_location_with_conn(&conn, essay_id)
    }

    /// 获取作文的 ResourceLocation（使用现有连接）
    pub fn get_essay_location_with_conn(
        conn: &Connection,
        essay_id: &str,
    ) -> VfsResult<Option<ResourceLocation>> {
        VfsFolderRepo::get_resource_location_with_conn(conn, "essay", essay_id)
    }

    /// 列出所有作文（不按 subject 过滤）
    ///
    /// ★ Prompt 4: 新增方法，替代 list_essays 中按 subject 过滤的场景
    pub fn list_all_essays(
        db: &VfsDatabase,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsEssay>> {
        let conn = db.get_conn_safe()?;
        Self::list_all_essays_with_conn(&conn, search, limit, offset)
    }

    /// 列出所有作文（使用现有连接）
    pub fn list_all_essays_with_conn(
        conn: &Connection,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsEssay>> {
        Self::list_essays_with_conn(conn, search, limit, offset)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_essay_id_generation() {
        let id = VfsEssay::generate_id();
        assert!(id.starts_with("essay_"));
        assert_eq!(id.len(), 16); // "essay_" + 10 chars
    }
}
