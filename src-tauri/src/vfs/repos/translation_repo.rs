//! VFS 翻译表 CRUD 操作
//!
//! 翻译元数据管理，内容通过 `resource_id` 关联 `resources` 表。
//! 翻译内容格式：JSON { "source": "...", "translated": "..." }
//!
//! 支持：
//! - title: 翻译标题（用于重命名）
//!
//! ## 核心方法
//! - `list_translations`: 列出翻译
//! - `get_translation`: 获取翻译
//! - `search_translations`: 搜索翻译

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use tracing::{debug, info, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::repos::folder_repo::VfsFolderRepo;
use crate::vfs::repos::resource_repo::VfsResourceRepo;
use crate::vfs::types::{
    ResourceLocation, VfsCreateTranslationParams, VfsFolderItem, VfsResourceType, VfsTranslation,
};

/// Log row-parse errors instead of silently discarding them.
fn log_and_skip_err<T>(result: Result<T, rusqlite::Error>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("[VFS::TranslationRepo] Row parse error (skipped): {}", e);
            None
        }
    }
}

/// VFS 翻译表 Repo
pub struct VfsTranslationRepo;

impl VfsTranslationRepo {
    // ========================================================================
    // 列表查询
    // ========================================================================

    /// 列出翻译
    ///
    /// 注意：翻译无科目，`subject` 参数被忽略
    pub fn list_translations(
        db: &VfsDatabase,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsTranslation>> {
        let conn = db.get_conn_safe()?;
        Self::list_translations_with_conn(&conn, search, limit, offset)
    }

    /// 列出翻译（使用现有连接）
    /// 🔧 P0-08 修复: JOIN resources 表获取 source_text 和 translated_text
    pub fn list_translations_with_conn(
        conn: &Connection,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsTranslation>> {
        let mut sql = String::from(
            r#"
            SELECT t.id, t.resource_id, t.title, t.src_lang, t.tgt_lang, t.engine, t.model,
                   t.is_favorite, t.quality_rating, t.created_at, t.updated_at, t.metadata_json,
                   r.data as content_json
            FROM translations t
            LEFT JOIN resources r ON t.resource_id = r.id
            WHERE 1=1
            "#,
        );

        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        let mut param_idx = 1;

        // 搜索过滤（在 resources.data 中搜索）
        if let Some(q) = search {
            sql.push_str(&format!(
                " AND EXISTS (SELECT 1 FROM resources r WHERE r.id = t.resource_id AND r.data LIKE ?{})",
                param_idx
            ));
            let search_pattern = format!("%{}%", q);
            params_vec.push(Box::new(search_pattern));
            param_idx += 1;
        }

        sql.push_str(&format!(
            " ORDER BY t.created_at DESC LIMIT ?{} OFFSET ?{}",
            param_idx,
            param_idx + 1
        ));
        params_vec.push(Box::new(limit));
        params_vec.push(Box::new(offset));

        let mut stmt = conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(params_refs.as_slice(), Self::row_to_translation)?;

        let translations: Vec<VfsTranslation> = rows.filter_map(log_and_skip_err).collect();
        debug!(
            "[VFS::TranslationRepo] Listed {} translations",
            translations.len()
        );
        Ok(translations)
    }

    // ========================================================================
    // 查询单个
    // ========================================================================

    /// 根据 ID 获取翻译
    pub fn get_translation(
        db: &VfsDatabase,
        translation_id: &str,
    ) -> VfsResult<Option<VfsTranslation>> {
        let conn = db.get_conn_safe()?;
        Self::get_translation_with_conn(&conn, translation_id)
    }

    /// 根据 ID 获取翻译（使用现有连接）
    /// 🔧 P0-08 修复: JOIN resources 表获取 source_text 和 translated_text
    pub fn get_translation_with_conn(
        conn: &Connection,
        translation_id: &str,
    ) -> VfsResult<Option<VfsTranslation>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT t.id, t.resource_id, t.title, t.src_lang, t.tgt_lang, t.engine, t.model,
                   t.is_favorite, t.quality_rating, t.created_at, t.updated_at, t.metadata_json,
                   r.data as content_json
            FROM translations t
            LEFT JOIN resources r ON t.resource_id = r.id
            WHERE t.id = ?1
            "#,
        )?;

        let translation = stmt
            .query_row(params![translation_id], Self::row_to_translation)
            .optional()?;

        Ok(translation)
    }

    /// 获取翻译内容
    ///
    /// 从关联的 resource.data 获取内容
    pub fn get_translation_content(
        db: &VfsDatabase,
        translation_id: &str,
    ) -> VfsResult<Option<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_translation_content_with_conn(&conn, translation_id)
    }

    /// 获取翻译内容（使用现有连接）
    ///
    /// ★ 2026-01-26 修复：使用 LEFT JOIN 并回退到 source_text/translated_text
    /// 解决 resources.data 为空时返回 None 的问题
    pub fn get_translation_content_with_conn(
        conn: &Connection,
        translation_id: &str,
    ) -> VfsResult<Option<String>> {
        // 首先尝试从 resources.data 获取
        let content: Option<String> = conn
            .query_row(
                r#"
                SELECT r.data
                FROM translations t
                LEFT JOIN resources r ON t.resource_id = r.id
                WHERE t.id = ?1
                "#,
                params![translation_id],
                |row| row.get(0),
            )
            .optional()?;

        // 如果 resources.data 有内容，直接返回
        if let Some(ref c) = content {
            if !c.is_empty() {
                return Ok(content);
            }
        }

        // ★ 回退：从 translation 记录中构造内容
        // 某些旧数据可能没有关联的 resources 记录
        if let Some(translation) = Self::get_translation_with_conn(conn, translation_id)? {
            let source = translation.source_text.unwrap_or_default();
            let translated = translation.translated_text.unwrap_or_default();

            if !source.is_empty() || !translated.is_empty() {
                let content_json = serde_json::json!({
                    "source": source,
                    "translated": translated
                });
                return Ok(Some(content_json.to_string()));
            }
        }

        Ok(None)
    }

    // ========================================================================
    // 搜索
    // ========================================================================

    /// 搜索翻译（用于全局搜索）
    pub fn search_translations(
        db: &VfsDatabase,
        query: &str,
        limit: u32,
    ) -> VfsResult<Vec<VfsTranslation>> {
        let conn = db.get_conn_safe()?;
        Self::search_translations_with_conn(&conn, query, limit)
    }

    /// 搜索翻译（使用现有连接）
    pub fn search_translations_with_conn(
        conn: &Connection,
        query: &str,
        limit: u32,
    ) -> VfsResult<Vec<VfsTranslation>> {
        Self::list_translations_with_conn(conn, Some(query), limit, 0)
    }

    // ========================================================================
    // 创建
    // ========================================================================

    /// 创建翻译记录（参数结构体版本）
    pub fn create_translation(
        db: &VfsDatabase,
        params: VfsCreateTranslationParams,
    ) -> VfsResult<VfsTranslation> {
        let conn = db.get_conn_safe()?;
        Self::create_translation_with_conn(&conn, params)
    }

    /// 创建翻译记录（使用现有连接，参数结构体版本）
    ///
    /// ## 流程
    /// 1. 将 source + translated 序列化为 JSON 存入 resources.data（SSOT）
    /// 2. 创建翻译元数据记录
    /// 3. 更新资源的 source_id
    ///
    /// ★ M-090 修复：使用 SAVEPOINT 事务保护三步操作，防止部分失败导致孤儿资源
    pub fn create_translation_with_conn(
        conn: &Connection,
        params: VfsCreateTranslationParams,
    ) -> VfsResult<VfsTranslation> {
        // 1. 创建内容 JSON（纯计算，不需要事务保护）
        let content = serde_json::json!({
            "source": params.source,
            "translated": params.translated
        });
        let content_str =
            serde_json::to_string(&content).map_err(|e| VfsError::Serialization(e.to_string()))?;

        // ★ SAVEPOINT 事务保护：包裹 create_or_reuse / INSERT translations / UPDATE resources 三步操作
        conn.execute("SAVEPOINT create_translation", [])
            .map_err(|e| {
                warn!(
                    "[VFS::TranslationRepo] Failed to create savepoint for create_translation: {}",
                    e
                );
                VfsError::Database(format!("Failed to create savepoint: {}", e))
            })?;

        let result = (|| -> VfsResult<VfsTranslation> {
            // 2. 创建或复用资源
            let resource_result = VfsResourceRepo::create_or_reuse_with_conn(
                conn,
                VfsResourceType::Translation,
                &content_str,
                None,
                Some("translations"),
                None,
            )?;

            // 3. 创建翻译记录
            let translation_id = VfsTranslation::generate_id();
            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();

            conn.execute(
                r#"
                INSERT INTO translations (id, resource_id, title, src_lang, tgt_lang, engine, model,
                                          is_favorite, quality_rating, created_at, updated_at, metadata_json)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, NULL, ?8, ?9, NULL)
                "#,
                params![
                    translation_id,
                    resource_result.resource_id,
                    params.title,
                    params.src_lang,
                    params.tgt_lang,
                    params.engine,
                    params.model,
                    now,
                    now,
                ],
            )?;

            // 4. 更新资源的 source_id
            conn.execute(
                "UPDATE resources SET source_id = ?1 WHERE id = ?2",
                params![translation_id, resource_result.resource_id],
            )?;

            info!(
                "[VFS::TranslationRepo] Created translation: {} (resource: {}), title: {:?}",
                translation_id, resource_result.resource_id, params.title
            );

            Ok(VfsTranslation {
                id: translation_id,
                resource_id: resource_result.resource_id,
                title: params.title,
                src_lang: params.src_lang.clone(),
                tgt_lang: params.tgt_lang.clone(),
                engine: params.engine,
                model: params.model,
                is_favorite: false,
                quality_rating: None,
                created_at: now.clone(),
                updated_at: Some(now),
                metadata: None,
                // 🔧 P0-08 修复: 返回源文本和译文
                source_text: Some(params.source),
                translated_text: Some(params.translated),
            })
        })();

        match result {
            Ok(translation) => {
                conn.execute("RELEASE create_translation", [])
                    .map_err(|e| {
                        warn!(
                            "[VFS::TranslationRepo] Failed to release savepoint create_translation: {}",
                            e
                        );
                        VfsError::Database(format!("Failed to release savepoint: {}", e))
                    })?;
                Ok(translation)
            }
            Err(e) => {
                // 回滚到 savepoint，忽略回滚本身的错误
                let _ = conn.execute("ROLLBACK TO create_translation", []);
                // 释放 savepoint（即使回滚后也需要释放，否则 savepoint 会残留）
                let _ = conn.execute("RELEASE create_translation", []);
                Err(e)
            }
        }
    }

    /// 创建翻译记录（兼容旧 API）
    #[deprecated(note = "请使用 create_translation(params) 版本")]
    pub fn create_translation_legacy(
        db: &VfsDatabase,
        source_text: &str,
        translated_text: &str,
        src_lang: &str,
        tgt_lang: &str,
        engine: Option<&str>,
        model: Option<&str>,
    ) -> VfsResult<VfsTranslation> {
        Self::create_translation(
            db,
            VfsCreateTranslationParams {
                title: None, // ★ 2025-12-25: 添加 title 字段
                source: source_text.to_string(),
                translated: translated_text.to_string(),
                src_lang: src_lang.to_string(),
                tgt_lang: tgt_lang.to_string(),
                engine: engine.map(|s| s.to_string()),
                model: model.map(|s| s.to_string()),
            },
        )
    }

    /// 创建翻译记录（使用现有连接，兼容旧 API）
    #[deprecated(note = "请使用 create_translation_with_conn(params) 版本")]
    pub fn create_translation_with_conn_legacy(
        conn: &Connection,
        source_text: &str,
        translated_text: &str,
        src_lang: &str,
        tgt_lang: &str,
        engine: Option<&str>,
        model: Option<&str>,
    ) -> VfsResult<VfsTranslation> {
        Self::create_translation_with_conn(
            conn,
            VfsCreateTranslationParams {
                title: None, // ★ 2025-12-25: 添加 title 字段
                source: source_text.to_string(),
                translated: translated_text.to_string(),
                src_lang: src_lang.to_string(),
                tgt_lang: tgt_lang.to_string(),
                engine: engine.map(|s| s.to_string()),
                model: model.map(|s| s.to_string()),
            },
        )
    }

    // ========================================================================
    // 更新
    // ========================================================================

    /// 收藏/取消收藏翻译
    pub fn set_favorite(db: &VfsDatabase, translation_id: &str, favorite: bool) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::set_favorite_with_conn(&conn, translation_id, favorite)
    }

    /// 收藏/取消收藏翻译（使用现有连接）
    pub fn set_favorite_with_conn(
        conn: &Connection,
        translation_id: &str,
        favorite: bool,
    ) -> VfsResult<()> {
        let updated = conn.execute(
            "UPDATE translations SET is_favorite = ?1 WHERE id = ?2",
            params![favorite as i32, translation_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "Translation".to_string(),
                id: translation_id.to_string(),
            });
        }

        Ok(())
    }

    /// 设置质量评分
    pub fn set_quality_rating(
        db: &VfsDatabase,
        translation_id: &str,
        rating: i32,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::set_quality_rating_with_conn(&conn, translation_id, rating)
    }

    /// 设置质量评分（使用现有连接）
    pub fn set_quality_rating_with_conn(
        conn: &Connection,
        translation_id: &str,
        rating: i32,
    ) -> VfsResult<()> {
        if !(1..=5).contains(&rating) {
            return Err(VfsError::InvalidArgument {
                param: "rating".to_string(),
                reason: "Rating must be between 1 and 5".to_string(),
            });
        }

        let updated = conn.execute(
            "UPDATE translations SET quality_rating = ?1 WHERE id = ?2",
            params![rating, translation_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "Translation".to_string(),
                id: translation_id.to_string(),
            });
        }

        Ok(())
    }

    // ========================================================================
    // 删除（软删除）
    // ========================================================================

    /// 删除翻译记录（软删除，移到回收站）
    ///
    /// ★ 2025-12-11: 统一语义，delete = 软删除，purge = 永久删除
    pub fn delete_translation(db: &VfsDatabase, translation_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_translation_with_conn(&conn, translation_id)
    }

    /// 删除翻译记录（软删除，使用现有连接）
    pub fn delete_translation_with_conn(conn: &Connection, translation_id: &str) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE translations SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![now, translation_id],
        )?;

        if updated == 0 {
            // ★ P0 修复：幂等处理 - 检查是否已被软删除
            let already_deleted: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM translations WHERE id = ?1 AND deleted_at IS NOT NULL)",
                    params![translation_id],
                    |row| row.get(0),
                )
                .unwrap_or(false);

            if already_deleted {
                info!(
                    "[VFS::TranslationRepo] Translation already deleted (idempotent): {}",
                    translation_id
                );
            } else {
                return Err(VfsError::NotFound {
                    resource_type: "Translation".to_string(),
                    id: translation_id.to_string(),
                });
            }
        }

        info!(
            "[VFS::TranslationRepo] Soft deleted translation: {}",
            translation_id
        );
        Ok(())
    }

    // ========================================================================
    // 永久删除（purge）
    // ========================================================================

    /// 永久删除翻译记录（从数据库彻底删除，不可恢复）
    ///
    /// ★ 2025-12-11: 统一语义，purge = 永久删除
    pub fn purge_translation(db: &VfsDatabase, translation_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::purge_translation_with_conn(&conn, translation_id)
    }

    /// 永久删除翻译记录（使用现有连接）
    ///
    /// ★ P0 修复：同时清理 folder_items 和 resources 记录
    pub fn purge_translation_with_conn(conn: &Connection, translation_id: &str) -> VfsResult<()> {
        // 1. 获取 resource_id（purge 后无法再查）
        let resource_id: Option<String> = conn
            .query_row(
                "SELECT resource_id FROM translations WHERE id = ?1",
                params![translation_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();

        // 2. ★ P0 修复：删除 folder_items（防止孤儿记录）
        conn.execute(
            "DELETE FROM folder_items WHERE item_type = 'translation' AND item_id = ?1",
            params![translation_id],
        )?;

        // 3. 删除 translations 记录
        let deleted = conn.execute(
            "DELETE FROM translations WHERE id = ?1",
            params![translation_id],
        )?;

        if deleted == 0 {
            return Err(VfsError::NotFound {
                resource_type: "Translation".to_string(),
                id: translation_id.to_string(),
            });
        }

        // 4. ★ P0 修复：清理关联的 resource（如果存在）
        if let Some(rid) = resource_id {
            conn.execute("DELETE FROM resources WHERE id = ?1", params![rid])?;
        }

        info!(
            "[VFS::TranslationRepo] Purged translation: {} (with folder_items, resources)",
            translation_id
        );
        Ok(())
    }

    // ========================================================================
    // 兼容别名与恢复
    // ========================================================================

    /// 软删除翻译（兼容旧调用，等同于 delete_translation）
    #[deprecated(note = "使用 delete_translation 替代")]
    pub fn soft_delete_translation(db: &VfsDatabase, translation_id: &str) -> VfsResult<()> {
        Self::delete_translation(db, translation_id)
    }

    /// 软删除翻译（兼容旧调用，使用现有连接）
    #[deprecated(note = "使用 delete_translation_with_conn 替代")]
    pub fn soft_delete_translation_with_conn(
        conn: &Connection,
        translation_id: &str,
    ) -> VfsResult<()> {
        Self::delete_translation_with_conn(conn, translation_id)
    }

    /// 恢复软删除的翻译
    pub fn restore_translation(db: &VfsDatabase, translation_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::restore_translation_with_conn(&conn, translation_id)
    }

    /// 恢复软删除的翻译（使用现有连接）
    ///
    /// ★ P0 修复：恢复翻译时同步恢复 folder_items 记录，
    /// 确保恢复后的翻译在 Learning Hub 中可见
    pub fn restore_translation_with_conn(conn: &Connection, translation_id: &str) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let now_ms = chrono::Utc::now().timestamp_millis();

        // 1. 恢复翻译
        let updated = conn.execute(
            "UPDATE translations SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NOT NULL",
            params![now, translation_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "Translation".to_string(),
                id: translation_id.to_string(),
            });
        }

        // 2. ★ P0 修复：恢复 folder_items 记录
        let folder_items_restored = conn.execute(
            "UPDATE folder_items SET deleted_at = NULL, updated_at = ?1 WHERE item_type = 'translation' AND item_id = ?2 AND deleted_at IS NOT NULL",
            params![now_ms, translation_id],
        )?;

        info!(
            "[VFS::TranslationRepo] Restored translation: {}, folder_items restored: {}",
            translation_id, folder_items_restored
        );
        Ok(())
    }

    /// 列出已删除的翻译（回收站）
    ///
    /// 注意：翻译无科目，不支持科目过滤
    pub fn list_deleted_translations(
        db: &VfsDatabase,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsTranslation>> {
        let conn = db.get_conn_safe()?;
        Self::list_deleted_translations_with_conn(&conn, limit, offset)
    }

    /// 列出已删除的翻译（使用现有连接）
    /// 🔧 P0-08 修复: JOIN resources 表获取 source_text 和 translated_text
    pub fn list_deleted_translations_with_conn(
        conn: &Connection,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsTranslation>> {
        let sql = r#"
            SELECT t.id, t.resource_id, t.title, t.src_lang, t.tgt_lang, t.engine, t.model,
                   t.is_favorite, t.quality_rating, t.created_at, t.updated_at, t.metadata_json,
                   r.data as content_json
            FROM translations t
            LEFT JOIN resources r ON t.resource_id = r.id
            WHERE t.deleted_at IS NOT NULL
            ORDER BY t.deleted_at DESC
            LIMIT ?1 OFFSET ?2
        "#;

        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![limit, offset], Self::row_to_translation)?;

        let translations: Vec<VfsTranslation> = rows.filter_map(log_and_skip_err).collect();
        debug!(
            "[VFS::TranslationRepo] Listed {} deleted translations",
            translations.len()
        );
        Ok(translations)
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    /// 从行数据构建 VfsTranslation
    ///
    /// 🔧 P0-08 修复: 新增第 12 列 content_json，解析出 source_text 和 translated_text
    /// 列顺序: id, resource_id, title, src_lang, tgt_lang, engine, model,
    ///        is_favorite, quality_rating, created_at, updated_at, metadata_json, content_json
    fn row_to_translation(row: &rusqlite::Row) -> rusqlite::Result<VfsTranslation> {
        let metadata_str: Option<String> = row.get(11)?;
        let metadata: Option<Value> = metadata_str.and_then(|s| serde_json::from_str(&s).ok());

        // 🔧 P0-08 修复: 解析 content_json 获取 source_text 和 translated_text
        let content_str: Option<String> = row.get(12)?;
        let (source_text, translated_text) = content_str
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .map(|json| {
                let source = json
                    .get("source")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let translated = json
                    .get("translated")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                (source, translated)
            })
            .unwrap_or((None, None));

        Ok(VfsTranslation {
            id: row.get(0)?,
            resource_id: row.get(1)?,
            title: row.get(2)?,
            src_lang: row.get(3)?,
            tgt_lang: row.get(4)?,
            engine: row.get(5)?,
            model: row.get(6)?,
            is_favorite: row.get::<_, i32>(7)? != 0,
            quality_rating: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
            metadata,
            source_text,
            translated_text,
        })
    }

    // ========================================================================
    // 更新操作
    // ========================================================================

    /// 更新翻译标题（重命名）
    pub fn update_title(
        db: &VfsDatabase,
        translation_id: &str,
        new_title: &str,
    ) -> VfsResult<VfsTranslation> {
        let conn = db.get_conn_safe()?;
        Self::update_title_with_conn(&conn, translation_id, new_title)
    }

    /// 更新翻译标题（使用现有连接）
    pub fn update_title_with_conn(
        conn: &Connection,
        translation_id: &str,
        new_title: &str,
    ) -> VfsResult<VfsTranslation> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE translations SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_title, now, translation_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "Translation".to_string(),
                id: translation_id.to_string(),
            });
        }

        info!(
            "[VFS::TranslationRepo] Renamed translation: {} -> {}",
            translation_id, new_title
        );
        Self::get_translation_with_conn(conn, translation_id)?.ok_or_else(|| VfsError::NotFound {
            resource_type: "Translation".to_string(),
            id: translation_id.to_string(),
        })
    }

    // update_subject 方法已删除，subject 字段已从 VfsTranslation 移除

    // ========================================================================
    // ★ Prompt 4: 不依赖 subject 的新方法
    // ========================================================================

    /// 在指定文件夹中创建翻译
    ///
    /// ★ Prompt 4: 新增方法，创建翻译同时自动创建 folder_items 记录
    pub fn create_translation_in_folder(
        db: &VfsDatabase,
        params: VfsCreateTranslationParams,
        folder_id: Option<&str>,
    ) -> VfsResult<VfsTranslation> {
        let conn = db.get_conn_safe()?;
        Self::create_translation_in_folder_with_conn(&conn, params, folder_id)
    }

    /// 在指定文件夹中创建翻译（使用现有连接）
    ///
    /// ★ CONC-01 修复：使用事务保护，防止步骤 2 成功但步骤 3 失败导致"孤儿资源"
    pub fn create_translation_in_folder_with_conn(
        conn: &Connection,
        params: VfsCreateTranslationParams,
        folder_id: Option<&str>,
    ) -> VfsResult<VfsTranslation> {
        // 开始事务
        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<VfsTranslation> {
            // 1. 检查文件夹存在性
            if let Some(fid) = folder_id {
                if !VfsFolderRepo::folder_exists_with_conn(conn, fid)? {
                    return Err(VfsError::NotFound {
                        resource_type: "Folder".to_string(),
                        id: fid.to_string(),
                    });
                }
            }

            // 2. 创建翻译
            let translation = Self::create_translation_with_conn(conn, params)?;

            // 3. 创建 folder_items 记录
            let folder_item = VfsFolderItem::new(
                folder_id.map(|s| s.to_string()),
                "translation".to_string(),
                translation.id.clone(),
            );
            VfsFolderRepo::add_item_to_folder_with_conn(conn, &folder_item)?;

            debug!(
                "[VFS::TranslationRepo] Created translation {} in folder {:?}",
                translation.id, folder_id
            );

            Ok(translation)
        })();

        match result {
            Ok(translation) => {
                conn.execute("COMMIT", [])?;
                Ok(translation)
            }
            Err(e) => {
                // 回滚事务，忽略回滚本身的错误
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// 删除翻译（同时删除 folder_items 记录）
    ///
    /// ★ Prompt 4: 新增方法，删除翻译时自动清理 folder_items
    pub fn delete_translation_with_folder_item(
        db: &VfsDatabase,
        translation_id: &str,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_translation_with_folder_item_with_conn(&conn, translation_id)
    }

    /// 删除翻译（使用现有连接，同时软删除 folder_items 记录）
    ///
    /// ★ P0 修复：将 folder_items 的硬删除改为软删除，
    /// 确保恢复翻译时可以同步恢复 folder_items 记录
    pub fn delete_translation_with_folder_item_with_conn(
        conn: &Connection,
        translation_id: &str,
    ) -> VfsResult<()> {
        // 1. 软删除翻译
        Self::delete_translation_with_conn(conn, translation_id)?;

        // 2. 软删除 folder_items 记录（而不是硬删除）
        // ★ P0 修复：deleted_at 是 TEXT 列，updated_at 是 INTEGER 列，必须分开处理
        let now_str = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let now_ms = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE folder_items SET deleted_at = ?1, updated_at = ?2 WHERE item_type = 'translation' AND item_id = ?3 AND deleted_at IS NULL",
            params![now_str, now_ms, translation_id],
        )?;

        debug!(
            "[VFS::TranslationRepo] Soft deleted translation {} and its folder_items",
            translation_id
        );

        Ok(())
    }

    /// 按文件夹列出翻译
    ///
    /// ★ Prompt 4: 新增方法，通过 folder_items 查询翻译，不依赖 subject
    pub fn list_translations_by_folder(
        db: &VfsDatabase,
        folder_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsTranslation>> {
        let conn = db.get_conn_safe()?;
        Self::list_translations_by_folder_with_conn(&conn, folder_id, limit, offset)
    }

    /// 按文件夹列出翻译（使用现有连接）
    /// 🔧 P0-08 修复: JOIN resources 表获取 source_text 和 translated_text
    pub fn list_translations_by_folder_with_conn(
        conn: &Connection,
        folder_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsTranslation>> {
        let sql = r#"
            SELECT t.id, t.resource_id, t.title, t.src_lang, t.tgt_lang, t.engine, t.model,
                   t.is_favorite, t.quality_rating, t.created_at, t.updated_at, t.metadata_json,
                   r.data as content_json
            FROM translations t
            LEFT JOIN resources r ON t.resource_id = r.id
            JOIN folder_items fi ON fi.item_type = 'translation' AND fi.item_id = t.id
            WHERE fi.folder_id IS ?1
            ORDER BY fi.sort_order ASC, t.created_at DESC
            LIMIT ?2 OFFSET ?3
        "#;

        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![folder_id, limit, offset], Self::row_to_translation)?;

        let translations: Vec<VfsTranslation> = rows.filter_map(log_and_skip_err).collect();
        debug!(
            "[VFS::TranslationRepo] list_translations_by_folder({:?}): {} translations",
            folder_id,
            translations.len()
        );
        Ok(translations)
    }

    /// 获取翻译的 ResourceLocation
    ///
    /// ★ Prompt 4: 新增方法，获取翻译在 VFS 中的完整路径信息
    pub fn get_translation_location(
        db: &VfsDatabase,
        translation_id: &str,
    ) -> VfsResult<Option<ResourceLocation>> {
        let conn = db.get_conn_safe()?;
        Self::get_translation_location_with_conn(&conn, translation_id)
    }

    /// 获取翻译的 ResourceLocation（使用现有连接）
    pub fn get_translation_location_with_conn(
        conn: &Connection,
        translation_id: &str,
    ) -> VfsResult<Option<ResourceLocation>> {
        VfsFolderRepo::get_resource_location_with_conn(conn, "translation", translation_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_translation_id_generation() {
        let id = VfsTranslation::generate_id();
        assert!(id.starts_with("tr_"));
        assert_eq!(id.len(), 13); // "tr_" + 10 chars
    }
}
