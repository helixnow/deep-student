//! VFS 笔记表 CRUD 操作
//!
//! 笔记内容存储在 `resources.data`，本模块只管理笔记元数据。
//!
//! ## 核心方法
//! - `create_note`: 创建笔记（同时创建关联资源）
//! - `update_note`: 更新笔记（内容变化时创建新资源）
//! - `get_note`: 获取笔记元数据
//! - `get_note_content`: 获取笔记内容

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};
use tracing::{debug, info, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::repos::embedding_repo::VfsIndexStateRepo;
use crate::vfs::repos::folder_repo::VfsFolderRepo;
use crate::vfs::repos::resource_repo::VfsResourceRepo;
use crate::vfs::types::{
    ResourceLocation, VfsCreateNoteParams, VfsFolderItem, VfsNote, VfsResourceType,
    VfsUpdateNoteParams,
};

/// VFS 笔记表 Repo
pub struct VfsNoteRepo;

impl VfsNoteRepo {
    // ========================================================================
    // 创建笔记
    // ========================================================================

    /// 创建笔记
    ///
    /// ## 流程
    /// 1. 创建或复用资源（基于内容 hash 去重）
    /// 2. 创建笔记元数据记录
    pub fn create_note(db: &VfsDatabase, params: VfsCreateNoteParams) -> VfsResult<VfsNote> {
        let conn = db.get_conn_safe()?;
        Self::create_note_with_conn(&conn, params)
    }

    /// 创建笔记（使用现有连接）
    ///
    /// ★ 2026-02-08 修复：使用 SAVEPOINT 事务保护，确保 3 步操作的原子性。
    /// SAVEPOINT 可安全嵌套在外层 BEGIN IMMEDIATE 事务内（如 create_note_in_folder_with_conn）。
    pub fn create_note_with_conn(
        conn: &Connection,
        params: VfsCreateNoteParams,
    ) -> VfsResult<VfsNote> {
        // ★ M-011 修复：拒绝空标题，返回验证错误
        if params.title.trim().is_empty() {
            return Err(VfsError::InvalidArgument {
                param: "title".to_string(),
                reason: "标题不能为空".to_string(),
            });
        }
        let final_title = params.title.clone();

        // 1. 预生成 note_id（用于资源 hash 盐值，避免跨笔记资源复用）
        let note_id = VfsNote::generate_id();
        let resource_hash = VfsResourceRepo::compute_hash_with_salt(&params.content, &note_id);

        // ★ SAVEPOINT 事务保护：包裹 create_or_reuse / INSERT notes / UPDATE resources 三步操作
        conn.execute("SAVEPOINT create_note", []).map_err(|e| {
            tracing::error!(
                "[VFS::NoteRepo] Failed to create savepoint for create_note: {}",
                e
            );
            VfsError::Database(format!("Failed to create savepoint: {}", e))
        })?;

        let result = (|| -> VfsResult<VfsNote> {
            // 2. 创建或复用资源（note_id 作为盐值，确保资源仅在本笔记内复用）
            let resource_result = VfsResourceRepo::create_or_reuse_with_conn_and_hash(
                conn,
                VfsResourceType::Note,
                &params.content,
                &resource_hash,
                Some(&note_id),
                Some("notes"),
                None,
            )?;

            // 3. 创建笔记记录
            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
            let tags_json = serde_json::to_string(&params.tags)
                .map_err(|e| VfsError::Serialization(e.to_string()))?;

            conn.execute(
                r#"
                INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)
                "#,
                params![
                    note_id,
                    resource_result.resource_id,
                    final_title,
                    tags_json,
                    now,
                    now,
                ],
            )?;

            // 4. 更新资源的 source_id（确保复用场景下 source_id 一致）
            conn.execute(
                "UPDATE resources SET source_id = ?1 WHERE id = ?2",
                params![note_id, resource_result.resource_id],
            )?;

            info!(
                "[VFS::NoteRepo] Created note: {} (resource: {})",
                note_id, resource_result.resource_id
            );

            Ok(VfsNote {
                id: note_id,
                resource_id: resource_result.resource_id,
                title: final_title,
                tags: params.tags,
                is_favorite: false,
                created_at: now.clone(),
                updated_at: now,
                deleted_at: None,
            })
        })();

        match result {
            Ok(note) => {
                conn.execute("RELEASE create_note", []).map_err(|e| {
                    tracing::error!(
                        "[VFS::NoteRepo] Failed to release savepoint create_note: {}",
                        e
                    );
                    VfsError::Database(format!("Failed to release savepoint: {}", e))
                })?;
                Ok(note)
            }
            Err(e) => {
                // 回滚到 savepoint，忽略回滚本身的错误
                let _ = conn.execute("ROLLBACK TO create_note", []);
                // 释放 savepoint（即使回滚后也需要释放，否则 savepoint 会残留）
                let _ = conn.execute("RELEASE create_note", []);
                Err(e)
            }
        }
    }

    // ========================================================================
    // 更新笔记
    // ========================================================================

    /// 更新笔记
    ///
    /// ## 资源管理逻辑
    /// 1. 如果内容变化，计算新 hash
    /// 2. 若 hash 不同，创建新 resource
    /// 3. 更新笔记的 resource_id 指向新资源
    pub fn update_note(
        db: &VfsDatabase,
        note_id: &str,
        params: VfsUpdateNoteParams,
    ) -> VfsResult<VfsNote> {
        let conn = db.get_conn_safe()?;
        Self::update_note_with_conn(&conn, note_id, params)
    }

    /// 更新笔记（使用现有连接）
    ///
    /// ★ 2026-02-09 修复：使用 SAVEPOINT 事务保护，确保 3 步操作（创建新资源、保存旧版本、更新 notes 表）的原子性。
    /// SAVEPOINT 可安全嵌套在外层事务内。
    pub fn update_note_with_conn(
        conn: &Connection,
        note_id: &str,
        params: VfsUpdateNoteParams,
    ) -> VfsResult<VfsNote> {
        // 1. 获取当前笔记（在 SAVEPOINT 外获取，减少事务持有时间）
        let current_note =
            Self::get_note_with_conn(conn, note_id)?.ok_or_else(|| VfsError::NotFound {
                resource_type: "Note".to_string(),
                id: note_id.to_string(),
            })?;

        // ★ S-002 修复：乐观锁冲突检测
        // 如果调用方提供了 expected_updated_at，则与当前记录的 updated_at 比较。
        // 不匹配说明记录在读取后被其他操作修改过，返回 Conflict 错误。
        if let Some(ref expected) = params.expected_updated_at {
            if !expected.is_empty() && *expected != current_note.updated_at {
                warn!(
                    "[VFS::NoteRepo] Optimistic lock conflict for note {}: expected updated_at='{}', actual='{}'",
                    note_id, expected, current_note.updated_at
                );
                return Err(VfsError::Conflict {
                    key: "notes.conflict".to_string(),
                    message: "The note has been updated elsewhere, please refresh.".to_string(),
                });
            }
        }

        // ★ SAVEPOINT 事务保护：包裹 create_or_reuse / create_version / UPDATE notes 三步操作
        conn.execute("SAVEPOINT update_note", []).map_err(|e| {
            tracing::error!(
                "[VFS::NoteRepo] Failed to create savepoint for update_note: {}",
                e
            );
            VfsError::Database(format!("Failed to create savepoint: {}", e))
        })?;

        let result = (|| -> VfsResult<VfsNote> {
            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();

            // 2. 处理内容更新（版本管理）
            let new_resource_id = if let Some(new_content) = &params.content {
                // 计算新 hash（使用 note_id 作为盐值，避免跨笔记资源复用）
                let new_hash = VfsResourceRepo::compute_hash_with_salt(new_content, note_id);
                let legacy_hash = VfsResourceRepo::compute_hash(new_content);
                let current_resource =
                    VfsResourceRepo::get_resource_with_conn(conn, &current_note.resource_id)?
                        .ok_or_else(|| VfsError::NotFound {
                            resource_type: "Resource".to_string(),
                            id: current_note.resource_id.clone(),
                        })?;

                if new_hash != current_resource.hash && legacy_hash != current_resource.hash {
                    // 内容变化，创建新资源
                    let new_resource_result = VfsResourceRepo::create_or_reuse_with_conn_and_hash(
                        conn,
                        VfsResourceType::Note,
                        new_content,
                        &new_hash,
                        Some(note_id),
                        Some("notes"),
                        None,
                    )?;

                    debug!(
                        "[VFS::NoteRepo] Updated note resource {}: {} -> {}",
                        note_id, current_note.resource_id, new_resource_result.resource_id
                    );

                    Some(new_resource_result.resource_id)
                } else {
                    None // hash 相同，无需创建新资源
                }
            } else {
                None
            };

            // ★ M-011 修复：拒绝空标题，返回验证错误
            if let Some(ref title) = params.title {
                if title.trim().is_empty() {
                    return Err(VfsError::InvalidArgument {
                        param: "title".to_string(),
                        reason: "标题不能为空".to_string(),
                    });
                }
            }

            // 3. 构建更新 SQL
            let new_title = params.title.as_ref().unwrap_or(&current_note.title);
            let new_tags = params.tags.as_ref().unwrap_or(&current_note.tags);
            let tags_json = serde_json::to_string(new_tags)
                .map_err(|e| VfsError::Serialization(e.to_string()))?;

            let final_resource_id = new_resource_id
                .as_ref()
                .unwrap_or(&current_note.resource_id);

            conn.execute(
                r#"
                UPDATE notes
                SET resource_id = ?1, title = ?2, tags = ?3, updated_at = ?4
                WHERE id = ?5
                "#,
                params![final_resource_id, new_title, tags_json, now, note_id],
            )?;

            info!("[VFS::NoteRepo] Updated note: {}", note_id);

            // 4. 返回更新后的笔记
            Ok(VfsNote {
                id: note_id.to_string(),
                resource_id: final_resource_id.clone(),
                title: new_title.clone(),
                tags: new_tags.clone(),
                is_favorite: current_note.is_favorite,
                created_at: current_note.created_at,
                updated_at: now,
                deleted_at: None,
            })
        })();

        match result {
            Ok(note) => {
                conn.execute("RELEASE update_note", []).map_err(|e| {
                    tracing::error!(
                        "[VFS::NoteRepo] Failed to release savepoint update_note: {}",
                        e
                    );
                    VfsError::Database(format!("Failed to release savepoint: {}", e))
                })?;
                Ok(note)
            }
            Err(e) => {
                // 回滚到 savepoint，忽略回滚本身的错误
                let _ = conn.execute("ROLLBACK TO update_note", []);
                // 释放 savepoint（即使回滚后也需要释放，否则 savepoint 会残留）
                let _ = conn.execute("RELEASE update_note", []);
                Err(e)
            }
        }
    }

    // ========================================================================
    // 查询笔记
    // ========================================================================

    /// 获取笔记元数据（排除软删除）
    pub fn get_note(db: &VfsDatabase, note_id: &str) -> VfsResult<Option<VfsNote>> {
        let conn = db.get_conn_safe()?;
        Self::get_note_with_conn(&conn, note_id)
    }

    /// 获取笔记元数据（使用现有连接，排除软删除）
    ///
    /// ★ M-008 修复：添加 `deleted_at IS NULL` 过滤，防止读取/更新软删除的笔记。
    /// 如需读取已删除笔记（恢复/清理场景），请使用 `get_note_including_deleted_with_conn`。
    pub fn get_note_with_conn(conn: &Connection, note_id: &str) -> VfsResult<Option<VfsNote>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at
            FROM notes
            WHERE id = ?1 AND deleted_at IS NULL
            "#,
        )?;

        let note = stmt
            .query_row(params![note_id], Self::row_to_note)
            .optional()?;

        Ok(note)
    }

    /// 获取笔记元数据（包含软删除的笔记）
    ///
    /// ★ M-008：专用方法，用于恢复（restore）和永久删除（purge）等需要访问已删除笔记的场景。
    pub fn get_note_including_deleted(
        db: &VfsDatabase,
        note_id: &str,
    ) -> VfsResult<Option<VfsNote>> {
        let conn = db.get_conn_safe()?;
        Self::get_note_including_deleted_with_conn(&conn, note_id)
    }

    /// 获取笔记元数据（使用现有连接，包含软删除的笔记）
    ///
    /// ★ M-008：专用方法，用于恢复（restore）和永久删除（purge）等需要访问已删除笔记的场景。
    pub fn get_note_including_deleted_with_conn(
        conn: &Connection,
        note_id: &str,
    ) -> VfsResult<Option<VfsNote>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at
            FROM notes
            WHERE id = ?1
            "#,
        )?;

        let note = stmt
            .query_row(params![note_id], Self::row_to_note)
            .optional()?;

        Ok(note)
    }

    /// 获取笔记内容
    ///
    /// 从关联的 resource.data 获取内容
    pub fn get_note_content(db: &VfsDatabase, note_id: &str) -> VfsResult<Option<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_note_content_with_conn(&conn, note_id)
    }

    /// 获取笔记内容（使用现有连接，排除软删除）
    ///
    /// ★ M-008 修复：添加 `deleted_at IS NULL` 过滤，防止读取软删除笔记的内容。
    /// 如果笔记存在但关联的资源不存在，会自动修复数据（创建空资源）
    pub fn get_note_content_with_conn(
        conn: &Connection,
        note_id: &str,
    ) -> VfsResult<Option<String>> {
        // 首先尝试通过 JOIN 获取内容（排除软删除）
        let content: Option<String> = conn
            .query_row(
                r#"
                SELECT r.data
                FROM notes n
                JOIN resources r ON n.resource_id = r.id
                WHERE n.id = ?1 AND n.deleted_at IS NULL
                "#,
                params![note_id],
                |row| row.get(0),
            )
            .optional()?;

        if content.is_some() {
            return Ok(content);
        }

        // JOIN 失败，检查笔记是否存在（用于诊断和自动修复，排除软删除）
        let note_info: Option<(String, String)> = conn
            .query_row(
                "SELECT id, resource_id FROM notes WHERE id = ?1 AND deleted_at IS NULL",
                params![note_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        if let Some((_id, resource_id)) = note_info {
            // 笔记存在，检查资源是否存在
            let resource_exists: bool = conn
                .query_row(
                    "SELECT 1 FROM resources WHERE id = ?1",
                    params![resource_id],
                    |_| Ok(true),
                )
                .unwrap_or(false);

            if !resource_exists {
                warn!(
                    "[VFS::NoteRepo] Missing resource for note {} (resource_id: {})",
                    note_id, resource_id
                );
                return Err(VfsError::Database(format!(
                    "Missing resource for note {}",
                    note_id
                )));
            }
        }

        // 笔记不存在，返回 None
        Ok(None)
    }

    /// 获取笔记及其内容
    pub fn get_note_with_content(
        db: &VfsDatabase,
        note_id: &str,
    ) -> VfsResult<Option<(VfsNote, String)>> {
        let conn = db.get_conn_safe()?;
        Self::get_note_with_content_with_conn(&conn, note_id)
    }

    /// 获取笔记及其内容（使用现有连接）
    pub fn get_note_with_content_with_conn(
        conn: &Connection,
        note_id: &str,
    ) -> VfsResult<Option<(VfsNote, String)>> {
        let note = Self::get_note_with_conn(conn, note_id)?;
        if let Some(n) = note {
            let content = Self::get_note_content_with_conn(conn, note_id)?.unwrap_or_default();
            Ok(Some((n, content)))
        } else {
            Ok(None)
        }
    }

    // ========================================================================
    // 列表查询
    // ========================================================================

    /// 转义 SQL LIKE 模式中的特殊字符
    ///
    /// CRITICAL-001修复: 防止SQL LIKE通配符注入
    /// 转义 `%` 和 `_` 字符，防止用户输入被误解为通配符
    fn escape_like_pattern(s: &str) -> String {
        s.replace('\\', r"\\") // 先转义反斜杠
            .replace('%', r"\%") // 转义百分号通配符
            .replace('_', r"\_") // 转义下划线通配符
    }

    /// 列出笔记
    pub fn list_notes(
        db: &VfsDatabase,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsNote>> {
        let conn = db.get_conn_safe()?;
        Self::list_notes_with_conn(&conn, search, limit, offset)
    }

    /// 列出笔记（使用现有连接）
    pub fn list_notes_with_conn(
        conn: &Connection,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsNote>> {
        let mut sql = String::from(
            r#"
            SELECT n.id, n.resource_id, n.title, n.tags, n.is_favorite, n.created_at, n.updated_at, n.deleted_at
            FROM notes n
            WHERE n.deleted_at IS NULL
            "#,
        );

        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        let mut param_idx = 1;

        // 搜索过滤 - CRITICAL-001修复: 转义LIKE通配符
        if let Some(q) = search {
            sql.push_str(&format!(
                " AND (n.title LIKE ?{} ESCAPE '\\' OR EXISTS (SELECT 1 FROM resources r WHERE r.id = n.resource_id AND r.data LIKE ?{} ESCAPE '\\'))",
                param_idx, param_idx + 1
            ));
            let escaped = Self::escape_like_pattern(q);
            let search_pattern = format!("%{}%", escaped);
            params_vec.push(Box::new(search_pattern.clone()));
            params_vec.push(Box::new(search_pattern));
            param_idx += 2;
        }

        sql.push_str(&format!(
            " ORDER BY n.updated_at DESC LIMIT ?{} OFFSET ?{}",
            param_idx,
            param_idx + 1
        ));
        params_vec.push(Box::new(limit));
        params_vec.push(Box::new(offset));

        let mut stmt = conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(params_refs.as_slice(), Self::row_to_note)?;
        let notes: Vec<VfsNote> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(notes)
    }

    /// 列出所有标签（按使用频次排序）
    pub fn list_tags(db: &VfsDatabase, limit: u32) -> VfsResult<Vec<String>> {
        let conn = db.get_conn_safe()?;
        Self::list_tags_with_conn(&conn, limit)
    }

    /// 列出所有标签（使用现有连接）
    pub fn list_tags_with_conn(conn: &Connection, limit: u32) -> VfsResult<Vec<String>> {
        let mut stmt = conn.prepare("SELECT tags FROM notes WHERE deleted_at IS NULL")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;

        let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for row in rows {
            let tags_json = row?;
            let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
            for tag in tags {
                let trimmed = tag.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let entry = counts.entry(trimmed.to_string()).or_insert(0);
                *entry += 1;
            }
        }

        let mut entries: Vec<(String, usize)> = counts.into_iter().collect();
        entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

        Ok(entries
            .into_iter()
            .take(limit as usize)
            .map(|(tag, _)| tag)
            .collect())
    }

    // ========================================================================
    // 删除笔记
    // ========================================================================

    /// 软删除笔记
    pub fn delete_note(db: &VfsDatabase, note_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_note_with_conn(&conn, note_id)
    }

    /// 软删除笔记（使用现有连接）
    ///
    /// ★ M-009 修复：软删除操作为幂等的。
    /// - 记录不存在 → 返回 NotFound
    /// - 记录存在但已删除 → 返回 Ok（幂等）
    /// - 记录存在且未删除 → 执行软删除
    pub fn delete_note_with_conn(conn: &Connection, note_id: &str) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE notes SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![now, note_id],
        )?;

        if updated == 0 {
            // M-009 fix: 区分「记录不存在」和「已删除（幂等）」
            let exists: bool = conn
                .query_row(
                    "SELECT 1 FROM notes WHERE id = ?1",
                    params![note_id],
                    |_| Ok(true),
                )
                .optional()?
                .unwrap_or(false);

            if exists {
                // 记录存在但 deleted_at IS NOT NULL —— 已删除，幂等成功
                info!(
                    "[VFS::NoteRepo] Note already soft-deleted (idempotent): {}",
                    note_id
                );
                return Ok(());
            } else {
                // 记录在 notes 表中不存在
                return Err(VfsError::NotFound {
                    resource_type: "Note".to_string(),
                    id: note_id.to_string(),
                });
            }
        }

        info!("[VFS::NoteRepo] Soft deleted note: {}", note_id);
        Ok(())
    }

    /// 恢复软删除的笔记
    ///
    /// ★ P1-04 修复：恢复笔记后标记资源需要重新索引
    pub fn restore_note(db: &VfsDatabase, note_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;

        // 1. 获取笔记的 resource_id（在恢复前获取，需要读取已删除笔记）
        let note =
            Self::get_note_including_deleted_with_conn(&conn, note_id)?.ok_or_else(|| {
                VfsError::NotFound {
                    resource_type: "Note".to_string(),
                    id: note_id.to_string(),
                }
            })?;

        // 2. 执行恢复操作
        Self::restore_note_with_conn(&conn, note_id)?;

        // 3. 标记资源需要重新索引
        if let Err(e) = VfsIndexStateRepo::mark_pending(db, &note.resource_id) {
            warn!(
                "[VfsNoteRepo] Failed to mark note for re-indexing after restore: {}",
                e
            );
        }

        Ok(())
    }

    /// 恢复软删除的笔记（使用现有连接）
    ///
    /// 如果恢复位置存在同名笔记，会自动重命名为 "原名 (1)", "原名 (2)" 等
    ///
    /// ★ CONC-02 修复：恢复笔记时同步恢复 folder_items 记录，
    /// 确保恢复后的笔记在 Learning Hub 中可见
    pub fn restore_note_with_conn(conn: &Connection, note_id: &str) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let now_ms = chrono::Utc::now().timestamp_millis();

        // 1. 获取要恢复的笔记信息（需要读取已删除笔记）
        let note = Self::get_note_including_deleted_with_conn(conn, note_id)?.ok_or_else(|| {
            VfsError::NotFound {
                resource_type: "Note".to_string(),
                id: note_id.to_string(),
            }
        })?;

        // 2. 检查命名冲突并生成唯一名称
        let new_title = Self::generate_unique_note_title_with_conn(
            conn,
            &note.title,
            Some(note_id), // 排除自身
        )?;

        // 3. 恢复笔记（同时更新标题如果有冲突）
        let updated = conn.execute(
            "UPDATE notes SET deleted_at = NULL, title = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NOT NULL",
            params![new_title, now, note_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "Note".to_string(),
                id: note_id.to_string(),
            });
        }

        // 4. ★ CONC-02 修复：恢复 folder_items 记录
        let folder_items_restored = conn.execute(
            "UPDATE folder_items SET deleted_at = NULL, updated_at = ?1 WHERE item_type = 'note' AND item_id = ?2 AND deleted_at IS NOT NULL",
            params![now_ms, note_id],
        )?;

        if new_title != note.title {
            info!(
                "[VFS::NoteRepo] Restored note with rename: {} -> {} ({}), folder_items restored: {}",
                note.title, new_title, note_id, folder_items_restored
            );
        } else {
            info!(
                "[VFS::NoteRepo] Restored note: {}, folder_items restored: {}",
                note_id, folder_items_restored
            );
        }
        Ok(())
    }

    /// 生成唯一的笔记标题（避免同名冲突）
    ///
    /// 如果 base_title 已存在，会尝试 "base_title (1)", "base_title (2)" 等
    ///
    pub fn generate_unique_note_title_with_conn(
        conn: &Connection,
        base_title: &str,
        exclude_id: Option<&str>,
    ) -> VfsResult<String> {
        // 检查原始标题是否可用
        if !Self::note_title_exists_with_conn(conn, base_title, exclude_id)? {
            return Ok(base_title.to_string());
        }

        // 尝试添加后缀
        for i in 1..100 {
            let new_title = format!("{} ({})", base_title, i);
            if !Self::note_title_exists_with_conn(conn, &new_title, exclude_id)? {
                return Ok(new_title);
            }
        }

        // 极端情况：使用时间戳
        let timestamp = chrono::Utc::now().timestamp_millis();
        Ok(format!("{} ({})", base_title, timestamp))
    }

    /// 检查笔记标题是否已存在
    ///
    fn note_title_exists_with_conn(
        conn: &Connection,
        title: &str,
        exclude_id: Option<&str>,
    ) -> VfsResult<bool> {
        let count: i64 = if let Some(eid) = exclude_id {
            conn.query_row(
                "SELECT COUNT(*) FROM notes WHERE title = ?1 AND deleted_at IS NULL AND id != ?2",
                params![title, eid],
                |row| row.get(0),
            )?
        } else {
            conn.query_row(
                "SELECT COUNT(*) FROM notes WHERE title = ?1 AND deleted_at IS NULL",
                params![title],
                |row| row.get(0),
            )?
        };
        Ok(count > 0)
    }

    /// 永久删除笔记
    pub fn purge_note(db: &VfsDatabase, note_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::purge_note_with_conn(&conn, note_id)
    }

    /// 永久删除笔记（带事务保护）
    ///
    /// ★ 2026-02-01 修复：删除关联的 folder_items 和 resources 记录
    /// 使用事务确保所有删除操作的原子性，防止数据不一致
    pub fn purge_note_with_conn(conn: &Connection, note_id: &str) -> VfsResult<()> {
        info!("[VFS::NoteRepo] Purging note: {}", note_id);

        // 先获取笔记信息，确认存在（在事务外检查，减少事务持有时间）
        // ★ M-008：使用 including_deleted 版本，因为 purge 操作需要读取已软删除的笔记
        let note = match Self::get_note_including_deleted_with_conn(conn, note_id)? {
            Some(n) => {
                debug!(
                    "[VFS::NoteRepo] Found note: id={}, title={}, resource_id={}",
                    n.id, n.title, n.resource_id
                );
                n
            }
            None => {
                // ★ 笔记在 notes 表中不存在，但可能在 folder_items 中有记录
                // 尝试删除 folder_items 中的记录（兼容旧数据）
                warn!(
                    "[VFS::NoteRepo] Note not found in notes table: {}, trying folder_items cleanup",
                    note_id
                );
                let fi_deleted = conn.execute(
                    "DELETE FROM folder_items WHERE item_id = ?1",
                    params![note_id],
                )?;
                if fi_deleted > 0 {
                    info!(
                        "[VFS::NoteRepo] Deleted {} orphan folder_items for: {}",
                        fi_deleted, note_id
                    );
                    return Ok(());
                }
                return Err(VfsError::NotFound {
                    resource_type: "Note".to_string(),
                    id: note_id.to_string(),
                });
            }
        };

        // 保存主 resource_id
        let main_resource_id = note.resource_id.clone();

        // ★ 使用事务包装所有删除操作，确保原子性
        conn.execute("BEGIN IMMEDIATE", []).map_err(|e| {
            tracing::error!(
                "[VFS::NoteRepo] Failed to begin transaction for purge: {}",
                e
            );
            VfsError::Database(format!("Failed to begin transaction: {}", e))
        })?;

        // 定义回滚宏
        macro_rules! rollback_on_error {
            ($result:expr, $msg:expr) => {
                match $result {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::error!("[VFS::NoteRepo] {}: {}", $msg, e);
                        let _ = conn.execute("ROLLBACK", []);
                        return Err(VfsError::Database(format!("{}: {}", $msg, e)));
                    }
                }
            };
        }

        // ★ 删除 folder_items 中的关联记录（必须先删除，否则前端仍会显示）
        let fi_deleted = rollback_on_error!(
            conn.execute(
                "DELETE FROM folder_items WHERE item_id = ?1",
                params![note_id]
            ),
            "Failed to delete folder_items"
        );
        info!(
            "[VFS::NoteRepo] Deleted {} folder_items for note: {}",
            fi_deleted, note_id
        );

        // ★ 删除笔记记录
        let deleted = rollback_on_error!(
            conn.execute("DELETE FROM notes WHERE id = ?1", params![note_id]),
            "Failed to delete note"
        );

        if deleted == 0 {
            // ★ 如果没有删除任何记录，回滚并返回错误
            tracing::error!(
                "[VFS::NoteRepo] CRITICAL: Note record disappeared during deletion: {}",
                note_id
            );
            let _ = conn.execute("ROLLBACK", []);
            return Err(VfsError::Other(format!(
                "Note record disappeared during deletion: {}. This may indicate a race condition.",
                note_id
            )));
        }

        info!(
            "[VFS::NoteRepo] Successfully deleted note record: {} (deleted {} record(s))",
            note_id, deleted
        );

        // ★ 删除资源前检查是否仍被其他笔记引用，避免误删共享资源
        let mut resource_ids: HashSet<String> = HashSet::new();
        resource_ids.insert(main_resource_id.clone());

        let mut deleted_resources = 0usize;
        for resource_id in resource_ids {
            let note_refs: i64 = rollback_on_error!(
                conn.query_row(
                    "SELECT COUNT(*) FROM notes WHERE resource_id = ?1",
                    params![&resource_id],
                    |row| row.get(0)
                ),
                "Failed to query notes resource refs"
            );
            if note_refs > 0 {
                debug!(
                    "[VFS::NoteRepo] Skip deleting resource {} (refs: notes={})",
                    resource_id, note_refs
                );
                continue;
            }

            let res_deleted = rollback_on_error!(
                conn.execute("DELETE FROM resources WHERE id = ?1", params![&resource_id]),
                "Failed to delete resource"
            );
            if res_deleted > 0 {
                deleted_resources += res_deleted as usize;
                debug!("[VFS::NoteRepo] Deleted resource: {}", resource_id);
            }
        }

        info!(
            "[VFS::NoteRepo] Deleted {} resource(s) for note: {}",
            deleted_resources, note_id
        );

        // ★ 提交事务
        conn.execute("COMMIT", []).map_err(|e| {
            tracing::error!("[VFS::NoteRepo] Failed to commit purge transaction: {}", e);
            let _ = conn.execute("ROLLBACK", []);
            VfsError::Database(format!("Failed to commit transaction: {}", e))
        })?;

        info!(
            "[VFS::NoteRepo] Successfully completed note deletion: {}",
            note_id
        );

        Ok(())
    }

    /// 收藏/取消收藏笔记
    pub fn set_favorite(db: &VfsDatabase, note_id: &str, is_favorite: bool) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::set_favorite_with_conn(&conn, note_id, is_favorite)
    }

    /// 收藏/取消收藏笔记（使用现有连接）
    pub fn set_favorite_with_conn(
        conn: &Connection,
        note_id: &str,
        is_favorite: bool,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        conn.execute(
            "UPDATE notes SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3",
            params![is_favorite as i32, now, note_id],
        )?;

        Ok(())
    }

    /// 列出已删除的笔记（回收站）
    ///
    pub fn list_deleted_notes(
        db: &VfsDatabase,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsNote>> {
        let conn = db.get_conn_safe()?;
        Self::list_deleted_notes_with_conn(&conn, limit, offset)
    }

    /// 列出已删除的笔记（使用现有连接）
    pub fn list_deleted_notes_with_conn(
        conn: &Connection,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsNote>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at
            FROM notes
            WHERE deleted_at IS NOT NULL
            ORDER BY deleted_at DESC
            LIMIT ?1 OFFSET ?2
            "#,
        )?;

        let rows = stmt.query_map(params![limit, offset], Self::row_to_note)?;
        let notes: Vec<VfsNote> = rows
            .filter_map(|r| match r {
                Ok(val) => Some(val),
                Err(e) => {
                    log::warn!("[NoteRepo] Skipping malformed row: {}", e);
                    None
                }
            })
            .collect();
        Ok(notes)
    }

    /// 统计已删除的笔记数量
    pub fn count_deleted_notes(db: &VfsDatabase) -> VfsResult<i64> {
        let conn = db.get_conn_safe()?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE deleted_at IS NOT NULL",
            [],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    /// 清空回收站（永久删除所有已删除的笔记）
    ///
    pub fn purge_deleted_notes(db: &VfsDatabase) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        Self::purge_deleted_notes_with_conn(&conn)
    }

    /// 清空回收站（使用现有连接）
    pub fn purge_deleted_notes_with_conn(conn: &Connection) -> VfsResult<usize> {
        let mut stmt = conn.prepare("SELECT id FROM notes WHERE deleted_at IS NOT NULL")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let note_ids: Vec<String> = rows.collect::<rusqlite::Result<Vec<_>>>()?;

        let mut deleted_count = 0usize;
        for note_id in note_ids {
            Self::purge_note_with_conn(conn, &note_id)?;
            deleted_count += 1;
        }

        info!("[VFS::NoteRepo] Purged {} deleted notes", deleted_count);
        Ok(deleted_count)
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    /// 从行数据构建 VfsNote
    ///
    /// 列顺序：id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at
    fn row_to_note(row: &rusqlite::Row) -> rusqlite::Result<VfsNote> {
        let tags_json: String = row.get(3)?;
        let note_id: String = row.get(0)?;
        let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_else(|e| {
            tracing::warn!(
                "[VFS::NoteRepo] Failed to parse tags JSON for note {}: {}, using empty array. Raw JSON: {}",
                note_id, e, tags_json
            );
            Vec::new()
        });

        Ok(VfsNote {
            id: note_id,
            resource_id: row.get(1)?,
            title: row.get(2)?,
            tags,
            is_favorite: row.get::<_, i32>(4)? != 0,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
            deleted_at: row.get(7)?,
        })
    }

    // ========================================================================
    // ★ Prompt 4: 不依赖 subject 的新方法
    // ========================================================================

    /// 在指定文件夹中创建笔记
    ///
    /// ★ Prompt 4: 新增方法，创建笔记同时自动创建 folder_items 记录
    ///
    /// ## 参数
    /// - `params`: 创建笔记的参数
    /// - `folder_id`: 目标文件夹 ID（None 表示根目录）
    pub fn create_note_in_folder(
        db: &VfsDatabase,
        params: VfsCreateNoteParams,
        folder_id: Option<&str>,
    ) -> VfsResult<VfsNote> {
        let conn = db.get_conn_safe()?;
        Self::create_note_in_folder_with_conn(&conn, params, folder_id)
    }

    /// 在指定文件夹中创建笔记（使用现有连接）
    ///
    /// ★ CONC-01 修复：使用事务保护，防止步骤 2 成功但步骤 3 失败导致"孤儿资源"
    pub fn create_note_in_folder_with_conn(
        conn: &Connection,
        params: VfsCreateNoteParams,
        folder_id: Option<&str>,
    ) -> VfsResult<VfsNote> {
        // 开始事务
        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<VfsNote> {
            // 1. 检查文件夹存在性
            if let Some(fid) = folder_id {
                if !VfsFolderRepo::folder_exists_with_conn(conn, fid)? {
                    return Err(VfsError::NotFound {
                        resource_type: "Folder".to_string(),
                        id: fid.to_string(),
                    });
                }
            }

            // 2. 创建笔记
            let note = Self::create_note_with_conn(conn, params)?;

            // 3. 创建 folder_items 记录
            let folder_item = VfsFolderItem::new(
                folder_id.map(|s| s.to_string()),
                "note".to_string(),
                note.id.clone(),
            );
            VfsFolderRepo::add_item_to_folder_with_conn(conn, &folder_item)?;

            debug!(
                "[VFS::NoteRepo] Created note {} in folder {:?}",
                note.id, folder_id
            );

            Ok(note)
        })();

        match result {
            Ok(note) => {
                conn.execute("COMMIT", [])?;
                Ok(note)
            }
            Err(e) => {
                // 回滚事务，忽略回滚本身的错误
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// 删除笔记（同时删除 folder_items 记录）
    ///
    /// ★ Prompt 4: 新增方法，删除笔记时自动清理 folder_items
    pub fn delete_note_with_folder_item(db: &VfsDatabase, note_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_note_with_folder_item_with_conn(&conn, note_id)
    }

    /// 删除笔记（使用现有连接，同时软删除 folder_items 记录）
    ///
    /// ★ CONC-02 修复：将 folder_items 的硬删除改为软删除，
    /// 确保恢复笔记时可以同步恢复 folder_items 记录
    pub fn delete_note_with_folder_item_with_conn(
        conn: &Connection,
        note_id: &str,
    ) -> VfsResult<()> {
        // 1. 软删除笔记
        Self::delete_note_with_conn(conn, note_id)?;

        // 2. 软删除 folder_items 记录（而不是硬删除）
        // ★ P0 修复：deleted_at 是 TEXT 列，updated_at 是 INTEGER 列，必须分开处理
        let now_str = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        let now_ms = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE folder_items SET deleted_at = ?1, updated_at = ?2 WHERE item_type = 'note' AND item_id = ?3 AND deleted_at IS NULL",
            params![now_str, now_ms, note_id],
        )?;

        // 3. 标记索引为 disabled，防止搜索命中已删除内容
        let resource_id: Option<String> = conn
            .query_row(
                "SELECT resource_id FROM notes WHERE id = ?1",
                params![note_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(ref rid) = resource_id {
            let disabled_count = conn.execute(
                "UPDATE vfs_index_units SET text_state = 'disabled', mm_state = 'disabled' WHERE resource_id = ?1",
                params![rid],
            ).unwrap_or(0);
            if disabled_count > 0 {
                info!(
                    "[VFS::NoteRepo] Disabled {} index units for soft-deleted note {} (resource={})",
                    disabled_count, note_id, rid
                );
            }
        }

        debug!(
            "[VFS::NoteRepo] Soft deleted note {} and its folder_items",
            note_id
        );

        Ok(())
    }

    /// 永久删除笔记（同时删除 folder_items 记录）
    ///
    /// ★ Prompt 4: 新增方法，永久删除笔记时自动清理 folder_items
    pub fn purge_note_with_folder_item(db: &VfsDatabase, note_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::purge_note_with_folder_item_with_conn(&conn, note_id)
    }

    /// 永久删除笔记（使用现有连接，同时删除 folder_items 记录）
    pub fn purge_note_with_folder_item_with_conn(
        conn: &Connection,
        note_id: &str,
    ) -> VfsResult<()> {
        // 1. 永久删除笔记
        Self::purge_note_with_conn(conn, note_id)?;

        // 2. 删除 folder_items 记录
        VfsFolderRepo::remove_item_by_item_id_with_conn(conn, "note", note_id)?;

        Ok(())
    }

    /// 按文件夹列出笔记
    ///
    /// ★ Prompt 4: 新增方法，通过 folder_items 查询笔记，不依赖 subject
    pub fn list_notes_by_folder(
        db: &VfsDatabase,
        folder_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsNote>> {
        let conn = db.get_conn_safe()?;
        Self::list_notes_by_folder_with_conn(&conn, folder_id, limit, offset)
    }

    /// 按文件夹列出笔记（使用现有连接）
    pub fn list_notes_by_folder_with_conn(
        conn: &Connection,
        folder_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsNote>> {
        let sql = r#"
            SELECT n.id, n.resource_id, n.title, n.tags, n.is_favorite, n.created_at, n.updated_at, n.deleted_at
            FROM notes n
            JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
            WHERE fi.folder_id IS ?1 AND n.deleted_at IS NULL
            ORDER BY fi.sort_order ASC, n.updated_at DESC
            LIMIT ?2 OFFSET ?3
        "#;

        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![folder_id, limit, offset], Self::row_to_note)?;

        let notes: Vec<VfsNote> = rows
            .filter_map(|r| match r {
                Ok(val) => Some(val),
                Err(e) => {
                    log::warn!("[NoteRepo] Skipping malformed row: {}", e);
                    None
                }
            })
            .collect();
        debug!(
            "[VFS::NoteRepo] list_notes_by_folder({:?}): {} notes",
            folder_id,
            notes.len()
        );
        Ok(notes)
    }

    /// 获取笔记的 ResourceLocation
    ///
    /// ★ Prompt 4: 新增方法，获取笔记在 VFS 中的完整路径信息
    pub fn get_note_location(
        db: &VfsDatabase,
        note_id: &str,
    ) -> VfsResult<Option<ResourceLocation>> {
        let conn = db.get_conn_safe()?;
        Self::get_note_location_with_conn(&conn, note_id)
    }

    /// 获取笔记的 ResourceLocation（使用现有连接）
    pub fn get_note_location_with_conn(
        conn: &Connection,
        note_id: &str,
    ) -> VfsResult<Option<ResourceLocation>> {
        VfsFolderRepo::get_resource_location_with_conn(conn, "note", note_id)
    }

    /// 列出所有笔记（不按 subject 过滤）
    ///
    /// ★ Prompt 4: 新增方法，替代 list_notes 中按 subject 过滤的场景
    pub fn list_all_notes(
        db: &VfsDatabase,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsNote>> {
        let conn = db.get_conn_safe()?;
        Self::list_all_notes_with_conn(&conn, search, limit, offset)
    }

    /// 列出所有笔记（使用现有连接）
    pub fn list_all_notes_with_conn(
        conn: &Connection,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsNote>> {
        Self::list_notes_with_conn(conn, search, limit, offset)
    }
}

// ============================================================================
// 单元测试
// ============================================================================

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
    fn test_create_note() {
        let (_temp_dir, db) = setup_test_db();

        let note = VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "测试笔记".to_string(),
                content: "# 测试内容\n\n这是一个测试笔记。".to_string(),
                tags: vec!["测试".to_string(), "数学".to_string()],
            },
        )
        .expect("Create note should succeed");

        assert!(!note.id.is_empty());
        assert_eq!(note.title, "测试笔记");
        assert_eq!(note.tags, vec!["测试", "数学"]);
        assert!(!note.is_favorite);
    }

    #[test]
    fn test_get_note_content() {
        let (_temp_dir, db) = setup_test_db();

        let note = VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "测试笔记".to_string(),
                content: "# 测试内容".to_string(),
                tags: vec![],
            },
        )
        .expect("Create note should succeed");

        let content = VfsNoteRepo::get_note_content(&db, &note.id)
            .expect("Get content should succeed")
            .expect("Content should exist");

        assert_eq!(content, "# 测试内容");
    }

    #[test]
    fn test_update_note_changes_resource_on_content_change() {
        let (_temp_dir, db) = setup_test_db();

        let note = VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "原始标题".to_string(),
                content: "原始内容".to_string(),
                tags: vec!["v1".to_string()],
            },
        )
        .expect("Create note should succeed");

        let original_resource_id = note.resource_id.clone();

        let updated_note = VfsNoteRepo::update_note(
            &db,
            &note.id,
            VfsUpdateNoteParams {
                content: Some("新内容".to_string()),
                title: Some("新标题".to_string()),
                tags: Some(vec!["v2".to_string()]),
                expected_updated_at: None,
            },
        )
        .expect("Update note should succeed");

        assert_ne!(
            updated_note.resource_id, original_resource_id,
            "Resource ID should change when content changes"
        );
        assert_eq!(updated_note.title, "新标题");
        assert_eq!(updated_note.tags, vec!["v2"]);

        let content = VfsNoteRepo::get_note_content(&db, &note.id)
            .expect("Get content should succeed")
            .expect("Content should exist");
        assert_eq!(content, "新内容");
    }

    #[test]
    fn test_update_note_keeps_resource_when_content_unchanged() {
        let (_temp_dir, db) = setup_test_db();

        let note = VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "标题".to_string(),
                content: "内容".to_string(),
                tags: vec![],
            },
        )
        .expect("Create note should succeed");

        let original_resource_id = note.resource_id.clone();

        let updated_note = VfsNoteRepo::update_note(
            &db,
            &note.id,
            VfsUpdateNoteParams {
                content: None,
                title: Some("新标题".to_string()),
                tags: None,
                expected_updated_at: None,
            },
        )
        .expect("Update note should succeed");

        assert_eq!(
            updated_note.resource_id, original_resource_id,
            "Resource ID should NOT change when only title changes"
        );
        assert_eq!(updated_note.title, "新标题");

        let content = VfsNoteRepo::get_note_content(&db, &note.id)
            .expect("Get content should succeed")
            .expect("Content should exist");
        assert_eq!(content, "内容", "Content should remain unchanged");
    }

    #[test]
    fn test_soft_delete_and_restore() {
        let (_temp_dir, db) = setup_test_db();

        // 创建笔记
        let note = VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "测试笔记".to_string(),
                content: "内容".to_string(),
                tags: vec![],
            },
        )
        .expect("Create note should succeed");

        // 软删除
        VfsNoteRepo::delete_note(&db, &note.id).expect("Delete should succeed");

        // ★ M-008: get_note 应该过滤软删除的笔记，返回 None
        let filtered_note = VfsNoteRepo::get_note(&db, &note.id).expect("Get should succeed");
        assert!(
            filtered_note.is_none(),
            "get_note should return None for soft-deleted notes"
        );

        // ★ M-008: get_note_including_deleted 应该仍能读取已删除笔记
        let deleted_note = VfsNoteRepo::get_note_including_deleted(&db, &note.id)
            .expect("Get including deleted should succeed")
            .expect("Note should exist when including deleted");
        assert!(deleted_note.deleted_at.is_some());

        // 恢复
        VfsNoteRepo::restore_note(&db, &note.id).expect("Restore should succeed");

        // 验证已恢复（get_note 应该能找到）
        let restored_note = VfsNoteRepo::get_note(&db, &note.id)
            .expect("Get should succeed")
            .expect("Restored note should be visible via get_note");
        assert!(restored_note.deleted_at.is_none());
    }

    #[test]
    fn test_list_all_notes() {
        let (_temp_dir, db) = setup_test_db();

        // 创建多个笔记
        VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "数学笔记".to_string(),
                content: "数学内容".to_string(),
                tags: vec![],
            },
        )
        .unwrap();

        VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "物理笔记".to_string(),
                content: "物理内容".to_string(),
                tags: vec![],
            },
        )
        .unwrap();

        // 查询所有笔记
        let all_notes = VfsNoteRepo::list_all_notes(&db, None, 10, 0).expect("List should succeed");
        assert_eq!(all_notes.len(), 2);
    }
}
