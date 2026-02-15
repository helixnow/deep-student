//! VFS 教材表 CRUD 操作
//!
//! 教材元数据管理，PDF 内容通过 `blob_hash` 指向 `blobs` 表。
//!
//! ## 核心方法
//! - `create_textbook`: 创建教材记录
//! - `get_textbook`: 获取教材元数据
//! - `list_textbooks`: 列出教材

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::path::Path;
use tracing::{debug, error, info, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::ocr_utils::parse_ocr_pages_json;
use crate::vfs::repos::folder_repo::VfsFolderRepo;
use crate::vfs::repos::VfsBlobRepo;
use crate::vfs::types::{PdfPreviewJson, ResourceLocation, VfsFile, VfsFolderItem, VfsTextbook};

/// Log row-parse errors instead of silently discarding them.
fn log_and_skip_err<T>(result: Result<T, rusqlite::Error>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("[VFS::TextbookRepo] Row parse error (skipped): {}", e);
            None
        }
    }
}

/// VFS 教材表 Repo
pub struct VfsTextbookRepo;

/// 页面索引元数据（多模态索引）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PageIndexMeta {
    pub page_index: i32,
    pub blob_hash: String,
    pub embedding_dim: i32,
    pub indexing_mode: String,
    pub indexed_at: String,
}

impl VfsTextbookRepo {
    // ========================================================================
    // 创建教材
    // ========================================================================

    /// 创建教材记录
    ///
    /// ## 参数
    /// - `sha256`: 文件哈希（用于去重）
    /// - `file_name`: 文件名
    /// - `size`: 文件大小（字节）
    /// - `blob_hash`: Blob 哈希（可选，PDF 内容）
    pub fn create_textbook(
        db: &VfsDatabase,
        sha256: &str,
        file_name: &str,
        size: i64,
        blob_hash: Option<&str>,
        original_path: Option<&str>,
    ) -> VfsResult<VfsTextbook> {
        let conn = db.get_conn_safe()?;
        Self::create_textbook_with_conn(&conn, sha256, file_name, size, blob_hash, original_path)
    }

    /// 创建教材记录（使用现有连接）
    pub fn create_textbook_with_conn(
        conn: &Connection,
        sha256: &str,
        file_name: &str,
        size: i64,
        blob_hash: Option<&str>,
        original_path: Option<&str>,
    ) -> VfsResult<VfsTextbook> {
        Self::create_textbook_with_preview(
            conn,
            sha256,
            file_name,
            size,
            blob_hash,
            original_path,
            None,
            None,
            None,
        )
    }

    /// 创建教材记录（带 PDF 预渲染数据）
    ///
    /// ## 参数
    /// - `preview_json`: PDF 预渲染 JSON（可选）
    /// - `extracted_text`: 提取的文本内容（可选）
    /// - `page_count`: 页数（可选）
    pub fn create_textbook_with_preview(
        conn: &Connection,
        sha256: &str,
        file_name: &str,
        size: i64,
        blob_hash: Option<&str>,
        original_path: Option<&str>,
        preview_json: Option<&str>,
        extracted_text: Option<&str>,
        page_count: Option<i32>,
    ) -> VfsResult<VfsTextbook> {
        // 检查是否已存在相同 sha256
        if let Some(existing) = Self::get_by_sha256_with_conn(conn, sha256)? {
            debug!(
                "[VFS::TextbookRepo] Textbook with same sha256 already exists: {} (status: {:?})",
                existing.id, existing.status
            );
            // ★ 修复：如果已存在的记录不是 active 状态，恢复它
            if existing.status != "active" {
                info!(
                    "[VFS::TextbookRepo] Restoring soft-deleted textbook: {} from status {:?} to active",
                    existing.id, existing.status
                );
                let now = chrono::Utc::now()
                    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                    .to_string();
                conn.execute(
                    "UPDATE files SET status = 'active', updated_at = ?1 WHERE id = ?2",
                    params![now, existing.id],
                )?;
                // 返回更新后的记录
                return Self::get_textbook_with_conn(conn, &existing.id)?.ok_or_else(|| {
                    VfsError::Database(format!("Textbook {} not found after restore", existing.id))
                });
            }
            return Ok(existing);
        }

        // ★ 文档28/Migration032：使用 file_ 前缀保持与迁移后数据一致
        let textbook_id = VfsFile::generate_id();
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let now_ms = chrono::Utc::now().timestamp_millis();

        // ★ M-078 修复：SAVEPOINT 事务保护，包裹 INSERT resources + INSERT files 两步操作
        conn.execute("SAVEPOINT create_textbook", []).map_err(|e| {
            error!(
                "[VFS::TextbookRepo] Failed to create savepoint for create_textbook: {}",
                e
            );
            VfsError::Database(format!("Failed to create savepoint: {}", e))
        })?;

        let result = (|| -> VfsResult<VfsTextbook> {
            // ★ 1. 先在 resources 表创建记录（用于向量化索引）
            let resource_id = format!("res_{}", nanoid::nanoid!(10));
            conn.execute(
                r#"
                INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data, ref_count, created_at, updated_at)
                VALUES (?1, ?2, 'file', ?3, 'files', 'inline', ?4, 0, ?5, ?6)
                "#,
                params![
                    resource_id,
                    sha256,
                    textbook_id,
                    extracted_text.unwrap_or(""), // 使用提取的文本作为 data
                    now_ms,
                    now_ms,
                ],
            )?;

            // ★ PDF 预处理流水线状态（迁移 V20260204）
            // 教材导入时已完成 render_pdf_preview_with_progress，Stage 1+2 完成
            let is_pdf = file_name.to_lowercase().ends_with(".pdf");
            let (processing_status, processing_progress, processing_started_at): (
                Option<&str>,
                Option<String>,
                Option<i64>,
            ) = if is_pdf {
                let has_text = extracted_text.is_some();
                let _has_preview = preview_json.is_some();

                // 构建 ready_modes
                let mut ready_modes = vec![];
                if has_text {
                    ready_modes.push("text".to_string());
                }
                let progress = serde_json::json!({
                    "stage": "page_rendering",
                    "percent": 25.0,
                    "readyModes": ready_modes
                });

                (
                    Some("page_rendering"),
                    Some(progress.to_string()),
                    Some(now_ms),
                )
            } else {
                (None, None, None)
            };

            // ★ 2. 在 textbooks 表创建记录，关联 resource_id
            // ★ M-fix: 根据文件扩展名推断 mime_type 和 type，避免 PDF pipeline 因 NULL mime_type 失败
            let (file_type, mime_type) = {
                let ext = file_name.rsplit('.').next().unwrap_or("").to_lowercase();
                match ext.as_str() {
                    "pdf" => ("pdf", "application/pdf"),
                    "pptx" => (
                        "pptx",
                        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                    ),
                    "ppt" => ("ppt", "application/vnd.ms-powerpoint"),
                    "docx" => (
                        "docx",
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    ),
                    "doc" => ("doc", "application/msword"),
                    "epub" => ("epub", "application/epub+zip"),
                    "jpg" | "jpeg" => ("image", "image/jpeg"),
                    "png" => ("image", "image/png"),
                    _ => ("other", "application/octet-stream"),
                }
            };
            conn.execute(
                r#"
                INSERT INTO files (id, resource_id, blob_hash, sha256, file_name, original_path, size, "type", mime_type, page_count, tags_json, is_favorite, status, created_at, updated_at, preview_json, extracted_text,
                                  processing_status, processing_progress, processing_started_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, '[]', 0, 'active', ?11, ?12, ?13, ?14, ?15, ?16, ?17)
                "#,
                params![
                    textbook_id,
                    resource_id,
                    blob_hash,
                    sha256,
                    file_name,
                    original_path,
                    size,
                    file_type,
                    mime_type,
                    page_count,
                    now,
                    now,
                    preview_json,
                    extracted_text,
                    processing_status,
                    processing_progress,
                    processing_started_at,
                ],
            )?;

            info!(
                "[VFS::TextbookRepo] Created textbook: {} with resource: {} (file: {}, pages: {:?}, has_preview: {})",
                textbook_id, resource_id, file_name, page_count, preview_json.is_some()
            );

            Ok(VfsTextbook {
                id: textbook_id,
                resource_id: Some(resource_id),
                blob_hash: blob_hash.map(|s| s.to_string()),
                sha256: sha256.to_string(),
                file_name: file_name.to_string(),
                original_path: original_path.map(|s| s.to_string()),
                size,
                page_count,
                tags: vec![],
                is_favorite: false,
                last_opened_at: None,
                last_page: None,
                bookmarks: vec![],
                cover_key: None,
                status: "active".to_string(),
                created_at: now.clone(),
                updated_at: now,
            })
        })();

        match result {
            Ok(textbook) => {
                conn.execute("RELEASE create_textbook", []).map_err(|e| {
                    error!(
                        "[VFS::TextbookRepo] Failed to release savepoint create_textbook: {}",
                        e
                    );
                    VfsError::Database(format!("Failed to release savepoint: {}", e))
                })?;
                Ok(textbook)
            }
            Err(e) => {
                // 回滚到 savepoint，忽略回滚本身的错误
                let _ = conn.execute("ROLLBACK TO create_textbook", []);
                // 释放 savepoint（即使回滚后也需要释放，否则 savepoint 会残留）
                let _ = conn.execute("RELEASE create_textbook", []);
                Err(e)
            }
        }
    }

    // ========================================================================
    // 查询教材
    // ========================================================================

    /// 根据 ID 获取教材
    pub fn get_textbook(db: &VfsDatabase, textbook_id: &str) -> VfsResult<Option<VfsTextbook>> {
        let conn = db.get_conn_safe()?;
        Self::get_textbook_with_conn(&conn, textbook_id)
    }

    /// 根据 ID 获取教材（使用现有连接）
    pub fn get_textbook_with_conn(
        conn: &Connection,
        textbook_id: &str,
    ) -> VfsResult<Option<VfsTextbook>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, blob_hash, sha256, file_name, original_path, size, page_count,
                   tags_json, is_favorite, last_opened_at, last_page, bookmarks_json,
                   cover_key, status, created_at, updated_at
            FROM files
            WHERE id = ?1
            "#,
        )?;

        let textbook = stmt
            .query_row(params![textbook_id], Self::row_to_textbook)
            .optional()?;

        Ok(textbook)
    }

    /// 根据 SHA256 获取教材
    pub fn get_by_sha256(db: &VfsDatabase, sha256: &str) -> VfsResult<Option<VfsTextbook>> {
        let conn = db.get_conn_safe()?;
        Self::get_by_sha256_with_conn(&conn, sha256)
    }

    /// 根据 SHA256 获取教材（使用现有连接）
    pub fn get_by_sha256_with_conn(
        conn: &Connection,
        sha256: &str,
    ) -> VfsResult<Option<VfsTextbook>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, blob_hash, sha256, file_name, original_path, size, page_count,
                   tags_json, is_favorite, last_opened_at, last_page, bookmarks_json,
                   cover_key, status, created_at, updated_at
            FROM files
            WHERE sha256 = ?1
            "#,
        )?;

        let textbook = stmt
            .query_row(params![sha256], Self::row_to_textbook)
            .optional()?;

        Ok(textbook)
    }

    // ========================================================================
    // 列表查询
    // ========================================================================

    /// 列出教材
    pub fn list_textbooks(
        db: &VfsDatabase,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsTextbook>> {
        let conn = db.get_conn_safe()?;
        Self::list_textbooks_with_conn(&conn, limit, offset)
    }

    /// 列出教材（使用现有连接）
    pub fn list_textbooks_with_conn(
        conn: &Connection,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsTextbook>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, blob_hash, sha256, file_name, original_path, size, page_count,
                   tags_json, is_favorite, last_opened_at, last_page, bookmarks_json,
                   cover_key, status, created_at, updated_at
            FROM files
            WHERE status = 'active'
            ORDER BY updated_at DESC
            LIMIT ?1 OFFSET ?2
            "#,
        )?;

        let rows = stmt.query_map(params![limit, offset], Self::row_to_textbook)?;
        let textbooks: Vec<VfsTextbook> = rows.filter_map(log_and_skip_err).collect();
        Ok(textbooks)
    }

    // ========================================================================
    // 更新教材
    // ========================================================================

    /// 更新阅读进度
    pub fn update_reading_progress(
        db: &VfsDatabase,
        textbook_id: &str,
        last_page: i32,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::update_reading_progress_with_conn(&conn, textbook_id, last_page)
    }

    /// 更新阅读进度（使用现有连接）
    pub fn update_reading_progress_with_conn(
        conn: &Connection,
        textbook_id: &str,
        last_page: i32,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        conn.execute(
            "UPDATE files SET last_page = ?1, last_opened_at = ?2, updated_at = ?2 WHERE id = ?3",
            params![last_page, now, textbook_id],
        )?;

        Ok(())
    }

    /// 更新页数
    pub fn update_page_count(
        db: &VfsDatabase,
        textbook_id: &str,
        page_count: i32,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::update_page_count_with_conn(&conn, textbook_id, page_count)
    }

    /// 更新页数（使用现有连接）
    pub fn update_page_count_with_conn(
        conn: &Connection,
        textbook_id: &str,
        page_count: i32,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        conn.execute(
            "UPDATE files SET page_count = ?1, updated_at = ?2 WHERE id = ?3",
            params![page_count, now, textbook_id],
        )?;

        Ok(())
    }

    /// 更新教材文件名（重命名）
    pub fn update_file_name(
        db: &VfsDatabase,
        textbook_id: &str,
        new_name: &str,
    ) -> VfsResult<VfsTextbook> {
        let conn = db.get_conn_safe()?;
        Self::update_file_name_with_conn(&conn, textbook_id, new_name)
    }

    /// 更新教材文件名（使用现有连接）
    pub fn update_file_name_with_conn(
        conn: &Connection,
        textbook_id: &str,
        new_name: &str,
    ) -> VfsResult<VfsTextbook> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE files SET file_name = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_name, now, textbook_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "Textbook".to_string(),
                id: textbook_id.to_string(),
            });
        }

        tracing::info!(
            "[VFS::TextbookRepo] Renamed textbook: {} -> {}",
            textbook_id,
            new_name
        );
        Self::get_textbook_with_conn(conn, textbook_id)?.ok_or_else(|| VfsError::NotFound {
            resource_type: "Textbook".to_string(),
            id: textbook_id.to_string(),
        })
    }

    // update_subject 方法已删除，subject 字段已从 VfsTextbook 移除

    /// 收藏/取消收藏教材
    pub fn set_favorite(db: &VfsDatabase, textbook_id: &str, favorite: bool) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::set_favorite_with_conn(&conn, textbook_id, favorite)
    }

    /// 收藏/取消收藏教材（使用现有连接）
    pub fn set_favorite_with_conn(
        conn: &Connection,
        textbook_id: &str,
        favorite: bool,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        conn.execute(
            "UPDATE files SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3",
            params![favorite as i32, now, textbook_id],
        )?;

        Ok(())
    }

    /// 更新书签
    pub fn update_bookmarks(
        db: &VfsDatabase,
        textbook_id: &str,
        bookmarks: &[Value],
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::update_bookmarks_with_conn(&conn, textbook_id, bookmarks)
    }

    /// 更新书签（使用现有连接）
    pub fn update_bookmarks_with_conn(
        conn: &Connection,
        textbook_id: &str,
        bookmarks: &[Value],
    ) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let bookmarks_json =
            serde_json::to_string(bookmarks).map_err(|e| VfsError::Serialization(e.to_string()))?;

        conn.execute(
            "UPDATE files SET bookmarks_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![bookmarks_json, now, textbook_id],
        )?;

        Ok(())
    }

    // ========================================================================
    // 删除教材
    // ========================================================================

    /// 软删除教材
    pub fn delete_textbook(db: &VfsDatabase, textbook_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_textbook_with_conn(&conn, textbook_id)
    }

    /// 软删除教材（使用现有连接）
    pub fn delete_textbook_with_conn(conn: &Connection, textbook_id: &str) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE files SET status = 'deleted', updated_at = ?1 WHERE id = ?2 AND status = 'active'",
            params![now, textbook_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "Textbook".to_string(),
                id: textbook_id.to_string(),
            });
        }

        info!("[VFS::TextbookRepo] Soft deleted textbook: {}", textbook_id);
        Ok(())
    }

    /// 恢复软删除的教材
    pub fn restore_textbook(db: &VfsDatabase, textbook_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::restore_textbook_with_conn(&conn, textbook_id)
    }

    /// 恢复软删除的教材（使用现有连接）
    ///
    /// ★ P0 修复：恢复教材时同步恢复 folder_items 记录，
    /// 确保恢复后的教材在 Learning Hub 中可见
    pub fn restore_textbook_with_conn(conn: &Connection, textbook_id: &str) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let now_ms = chrono::Utc::now().timestamp_millis();

        // 1. 恢复教材
        let updated = conn.execute(
            "UPDATE files SET status = 'active', updated_at = ?1 WHERE id = ?2 AND status = 'deleted'",
            params![now, textbook_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "Textbook".to_string(),
                id: textbook_id.to_string(),
            });
        }

        // 2. ★ P0 修复：恢复 folder_items 记录
        // Migration032 后统一使用 'file' 类型
        let folder_items_restored = conn.execute(
            "UPDATE folder_items SET deleted_at = NULL, updated_at = ?1 WHERE item_type = 'file' AND item_id = ?2 AND deleted_at IS NOT NULL",
            params![now_ms, textbook_id],
        )?;

        info!(
            "[VFS::TextbookRepo] Restored textbook: {}, folder_items restored: {}",
            textbook_id, folder_items_restored
        );
        Ok(())
    }

    /// 永久删除教材
    pub fn purge_textbook(db: &VfsDatabase, textbook_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::purge_textbook_with_conn(&conn, db.blobs_dir(), textbook_id)
    }

    /// 永久删除教材（使用现有连接）
    ///
    /// ★ 2026-02-01 修复：递减 blob 引用计数
    /// - 教材自身的 blob_hash（PDF 原文件）
    /// - preview_json 中各页面的 blob_hash（预渲染图片）
    ///
    /// 使用事务确保所有操作的原子性
    pub fn purge_textbook_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        textbook_id: &str,
    ) -> VfsResult<()> {
        info!("[VFS::TextbookRepo] Purging textbook: {}", textbook_id);

        // ★ 开启事务
        conn.execute("BEGIN IMMEDIATE", []).map_err(|e| {
            error!(
                "[VFS::TextbookRepo] Failed to begin transaction for purge: {}",
                e
            );
            VfsError::Database(format!("Failed to begin transaction: {}", e))
        })?;

        let result = (|| -> VfsResult<()> {
            // 1. 获取 blob_hash 和 preview_json
            let (blob_hash, preview_json, resource_id): (
                Option<String>,
                Option<String>,
                Option<String>,
            ) = conn
                .query_row(
                    "SELECT blob_hash, preview_json, resource_id FROM files WHERE id = ?1",
                    params![textbook_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(|e| {
                    if matches!(e, rusqlite::Error::QueryReturnedNoRows) {
                        VfsError::NotFound {
                            resource_type: "Textbook".to_string(),
                            id: textbook_id.to_string(),
                        }
                    } else {
                        VfsError::Database(format!("Failed to query textbook: {}", e))
                    }
                })?;

            debug!(
                "[VFS::TextbookRepo] Found textbook: id={}, blob_hash={:?}, has_preview={}, resource_id={:?}",
                textbook_id,
                blob_hash,
                preview_json.is_some(),
                resource_id
            );

            // 2. 递减教材自身的 blob 引用（PDF 原文件）
            if let Some(ref hash) = blob_hash {
                match VfsBlobRepo::decrement_ref_with_conn(conn, blobs_dir, hash) {
                    Ok(new_count) => {
                        info!(
                            "[VFS::TextbookRepo] Decremented blob ref for textbook: {} -> {}",
                            hash, new_count
                        );
                    }
                    Err(e) => {
                        // blob 不存在时仅警告，不阻止删除
                        warn!(
                            "[VFS::TextbookRepo] Failed to decrement blob ref {}: {}",
                            hash, e
                        );
                    }
                }
            }

            // 3. 处理 preview_json 中的 PDF 页面 blob
            if let Some(ref json_str) = preview_json {
                if let Ok(preview) = serde_json::from_str::<PdfPreviewJson>(json_str) {
                    for page in &preview.pages {
                        match VfsBlobRepo::decrement_ref_with_conn(conn, blobs_dir, &page.blob_hash)
                        {
                            Ok(new_count) => {
                                debug!(
                                    "[VFS::TextbookRepo] Decremented PDF page blob ref: page={}, hash={} -> {}",
                                    page.page_index, page.blob_hash, new_count
                                );
                            }
                            Err(e) => {
                                // 页面 blob 不存在时仅警告
                                warn!(
                                    "[VFS::TextbookRepo] Failed to decrement PDF page blob {}: {}",
                                    page.blob_hash, e
                                );
                            }
                        }
                    }
                    info!(
                        "[VFS::TextbookRepo] Processed {} PDF preview page blobs for textbook: {}",
                        preview.pages.len(),
                        textbook_id
                    );
                }
            }

            // 4. 删除教材记录
            let deleted = conn.execute("DELETE FROM files WHERE id = ?1", params![textbook_id])?;

            if deleted == 0 {
                return Err(VfsError::NotFound {
                    resource_type: "Textbook".to_string(),
                    id: textbook_id.to_string(),
                });
            }

            // 5. 删除关联的 resources 表记录
            if let Some(ref res_id) = resource_id {
                let res_deleted =
                    conn.execute("DELETE FROM resources WHERE id = ?1", params![res_id])?;
                debug!(
                    "[VFS::TextbookRepo] Deleted {} resource record(s) for textbook: {}",
                    res_deleted, textbook_id
                );
            }

            Ok(())
        })();

        // ★ 根据结果提交或回滚事务
        match result {
            Ok(_) => {
                conn.execute("COMMIT", []).map_err(|e| {
                    error!(
                        "[VFS::TextbookRepo] Failed to commit purge transaction: {}",
                        e
                    );
                    let _ = conn.execute("ROLLBACK", []);
                    VfsError::Database(format!("Failed to commit transaction: {}", e))
                })?;
                info!(
                    "[VFS::TextbookRepo] Permanently deleted textbook: {}",
                    textbook_id
                );
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                error!("[VFS::TextbookRepo] Purge failed, rolled back: {}", e);
                Err(e)
            }
        }
    }

    /// 列出已删除的教材（回收站）
    pub fn list_deleted_textbooks(
        db: &VfsDatabase,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsTextbook>> {
        let conn = db.get_conn_safe()?;
        Self::list_deleted_textbooks_with_conn(&conn, limit, offset)
    }

    /// 列出已删除的教材（使用现有连接）
    pub fn list_deleted_textbooks_with_conn(
        conn: &Connection,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsTextbook>> {
        let sql = r#"
            SELECT id, resource_id, blob_hash, sha256, file_name, original_path, size, page_count,
                   tags_json, is_favorite, last_opened_at, last_page, bookmarks_json,
                   cover_key, status, created_at, updated_at
            FROM files
            WHERE status = 'deleted'
            ORDER BY updated_at DESC
            LIMIT ?1 OFFSET ?2
        "#;

        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![limit, offset], Self::row_to_textbook)?;
        let textbooks: Vec<VfsTextbook> = rows.filter_map(log_and_skip_err).collect();
        Ok(textbooks)
    }

    /// 清空回收站（永久删除所有已删除的教材）
    pub fn purge_deleted_textbooks(db: &VfsDatabase) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        Self::purge_deleted_textbooks_with_conn(&conn, db.blobs_dir())
    }

    /// 清空回收站（使用现有连接）
    ///
    /// ★ 2026-02-01 修复：逐个删除以正确处理 blob 引用计数
    pub fn purge_deleted_textbooks_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
    ) -> VfsResult<usize> {
        // 先获取所有待删除教材的 ID
        let textbook_ids: Vec<String> = conn
            .prepare("SELECT id FROM files WHERE status = 'deleted'")?
            .query_map([], |row| row.get(0))?
            .filter_map(log_and_skip_err)
            .collect();

        let count = textbook_ids.len();

        // 逐个永久删除（复用 purge_textbook_with_conn 以正确处理 blob 引用计数）
        for textbook_id in &textbook_ids {
            if let Err(e) = Self::purge_textbook_with_conn(conn, blobs_dir, textbook_id) {
                warn!(
                    "[VFS::TextbookRepo] Failed to purge textbook {}: {}",
                    textbook_id, e
                );
            }
        }

        info!("[VFS::TextbookRepo] Purged {} deleted textbooks", count);
        Ok(count)
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    /// 从行数据构建 VfsTextbook
    fn row_to_textbook(row: &rusqlite::Row) -> rusqlite::Result<VfsTextbook> {
        let tags_json: String = row.get(8)?;
        let bookmarks_json: String = row.get(12)?;

        let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
        let bookmarks: Vec<Value> = serde_json::from_str(&bookmarks_json).unwrap_or_default();

        Ok(VfsTextbook {
            id: row.get(0)?,
            resource_id: row.get(1)?,
            blob_hash: row.get(2)?,
            sha256: row.get(3)?,
            file_name: row.get(4)?,
            original_path: row.get(5)?,
            size: row.get(6)?,
            page_count: row.get(7)?,
            tags,
            is_favorite: row.get::<_, i32>(9)? != 0,
            last_opened_at: row.get(10)?,
            last_page: row.get(11)?,
            bookmarks,
            cover_key: row.get(13)?,
            status: row.get(14)?,
            created_at: row.get(15)?,
            updated_at: row.get(16)?,
        })
    }

    // ========================================================================
    // ★ Prompt 4: 不依赖 subject 的新方法
    // ========================================================================

    /// 在指定文件夹中创建教材
    ///
    /// ★ Prompt 4: 新增方法，创建教材同时自动创建 folder_items 记录
    pub fn create_textbook_in_folder(
        db: &VfsDatabase,
        sha256: &str,
        file_name: &str,
        size: i64,
        blob_hash: Option<&str>,
        original_path: Option<&str>,
        folder_id: Option<&str>,
    ) -> VfsResult<VfsTextbook> {
        let conn = db.get_conn_safe()?;
        Self::create_textbook_in_folder_with_conn(
            &conn,
            sha256,
            file_name,
            size,
            blob_hash,
            original_path,
            folder_id,
        )
    }

    /// 在指定文件夹中创建教材（使用现有连接）
    ///
    /// ★ CONC-01 修复：使用事务保护，防止教材创建成功但 folder_items 失败导致"孤儿资源"
    pub fn create_textbook_in_folder_with_conn(
        conn: &Connection,
        sha256: &str,
        file_name: &str,
        size: i64,
        blob_hash: Option<&str>,
        original_path: Option<&str>,
        folder_id: Option<&str>,
    ) -> VfsResult<VfsTextbook> {
        // 开始事务
        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<VfsTextbook> {
            // 1. 检查文件夹存在性
            if let Some(fid) = folder_id {
                if !VfsFolderRepo::folder_exists_with_conn(conn, fid)? {
                    return Err(VfsError::NotFound {
                        resource_type: "Folder".to_string(),
                        id: fid.to_string(),
                    });
                }
            }

            // 2. 创建教材
            let textbook = Self::create_textbook_with_conn(
                conn,
                sha256,
                file_name,
                size,
                blob_hash,
                original_path,
            )?;

            // 3. 创建 folder_items 记录（Migration032 后统一使用 'file' 类型）
            let folder_item = VfsFolderItem::new(
                folder_id.map(|s| s.to_string()),
                "file".to_string(),
                textbook.id.clone(),
            );
            VfsFolderRepo::add_item_to_folder_with_conn(conn, &folder_item)?;

            debug!(
                "[VFS::TextbookRepo] Created textbook {} in folder {:?}",
                textbook.id, folder_id
            );

            Ok(textbook)
        })();

        match result {
            Ok(textbook) => {
                conn.execute("COMMIT", [])?;
                Ok(textbook)
            }
            Err(e) => {
                // 回滚事务，忽略回滚本身的错误
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// 删除教材（同时删除 folder_items 记录）
    ///
    /// ★ Prompt 4: 新增方法，删除教材时自动清理 folder_items
    pub fn delete_textbook_with_folder_item(db: &VfsDatabase, textbook_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_textbook_with_folder_item_with_conn(&conn, textbook_id)
    }

    /// 删除教材（使用现有连接，同时软删除 folder_items 记录）
    ///
    /// ★ P0 修复：将 folder_items 的硬删除改为软删除，
    /// 确保恢复教材时可以同步恢复 folder_items 记录
    pub fn delete_textbook_with_folder_item_with_conn(
        conn: &Connection,
        textbook_id: &str,
    ) -> VfsResult<()> {
        // 1. 软删除教材
        Self::delete_textbook_with_conn(conn, textbook_id)?;

        // 2. 软删除 folder_items 记录（而不是硬删除）
        // Migration032 后统一使用 'file' 类型
        // ★ P0 修复：deleted_at 是 TEXT 列，updated_at 是 INTEGER 列，必须分开处理
        let now_str = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        let now_ms = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE folder_items SET deleted_at = ?1, updated_at = ?2 WHERE item_type = 'file' AND item_id = ?3 AND deleted_at IS NULL",
            params![now_str, now_ms, textbook_id],
        )?;

        debug!(
            "[VFS::TextbookRepo] Soft deleted textbook {} and its folder_items",
            textbook_id
        );

        Ok(())
    }

    /// 永久删除教材（同时删除 folder_items 记录）
    ///
    /// ★ Prompt 4: 新增方法，永久删除教材时自动清理 folder_items
    pub fn purge_textbook_with_folder_item(db: &VfsDatabase, textbook_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::purge_textbook_with_folder_item_with_conn(&conn, db.blobs_dir(), textbook_id)
    }

    /// 永久删除教材（使用现有连接，同时删除 folder_items 记录）
    pub fn purge_textbook_with_folder_item_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        textbook_id: &str,
    ) -> VfsResult<()> {
        // 1. 永久删除教材（内部已包含事务和 blob 引用计数处理）
        Self::purge_textbook_with_conn(conn, blobs_dir, textbook_id)?;

        // 2. 删除 folder_items 记录（Migration032 后统一使用 'file' 类型）
        VfsFolderRepo::remove_item_by_item_id_with_conn(conn, "file", textbook_id)?;

        Ok(())
    }

    /// 按文件夹列出教材
    ///
    /// ★ Prompt 4: 新增方法，通过 folder_items 查询教材，不依赖 subject
    pub fn list_textbooks_by_folder(
        db: &VfsDatabase,
        folder_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsTextbook>> {
        let conn = db.get_conn_safe()?;
        Self::list_textbooks_by_folder_with_conn(&conn, folder_id, limit, offset)
    }

    /// 按文件夹列出教材（使用现有连接）
    pub fn list_textbooks_by_folder_with_conn(
        conn: &Connection,
        folder_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsTextbook>> {
        let sql = r#"
            SELECT t.id, t.resource_id, t.blob_hash, t.sha256, t.file_name, t.original_path, t.size, t.page_count,
                   t.tags_json, t.is_favorite, t.last_opened_at, t.last_page, t.bookmarks_json,
                   t.cover_key, t.status, t.created_at, t.updated_at
            FROM files t
            JOIN folder_items fi ON fi.item_type = 'file' AND fi.item_id = t.id
            WHERE fi.folder_id IS ?1 AND t.status = 'active'
            ORDER BY fi.sort_order ASC, t.updated_at DESC
            LIMIT ?2 OFFSET ?3
        "#;

        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![folder_id, limit, offset], Self::row_to_textbook)?;

        let textbooks: Vec<VfsTextbook> = rows.filter_map(log_and_skip_err).collect();
        debug!(
            "[VFS::TextbookRepo] list_textbooks_by_folder({:?}): {} textbooks",
            folder_id,
            textbooks.len()
        );
        Ok(textbooks)
    }

    /// 获取教材的 ResourceLocation
    ///
    /// ★ Prompt 4: 新增方法，获取教材在 VFS 中的完整路径信息
    pub fn get_textbook_location(
        db: &VfsDatabase,
        textbook_id: &str,
    ) -> VfsResult<Option<ResourceLocation>> {
        let conn = db.get_conn_safe()?;
        Self::get_textbook_location_with_conn(&conn, textbook_id)
    }

    /// 获取教材的 ResourceLocation（使用现有连接）
    pub fn get_textbook_location_with_conn(
        conn: &Connection,
        textbook_id: &str,
    ) -> VfsResult<Option<ResourceLocation>> {
        // ★ Migration032 后 item_type 统一为 'file'
        VfsFolderRepo::get_resource_location_with_conn(conn, "file", textbook_id)
    }

    /// 列出所有教材（不按 subject 过滤）
    ///
    /// ★ Prompt 4: 新增方法，替代 list_textbooks 中按 subject 过滤的场景
    pub fn list_all_textbooks(
        db: &VfsDatabase,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsTextbook>> {
        let conn = db.get_conn_safe()?;
        Self::list_all_textbooks_with_conn(&conn, limit, offset)
    }

    /// 列出所有教材（使用现有连接）
    pub fn list_all_textbooks_with_conn(
        conn: &Connection,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsTextbook>> {
        Self::list_textbooks_with_conn(conn, limit, offset)
    }

    // ========================================================================
    // OCR 文本存储
    // ========================================================================

    /// 保存教材单页 OCR 文本
    ///
    /// ## 参数
    /// - `textbook_id`: 教材 ID
    /// - `page_index`: 页码索引（0-based）
    /// - `ocr_text`: OCR 文本内容
    pub fn save_page_ocr(
        db: &VfsDatabase,
        textbook_id: &str,
        page_index: usize,
        ocr_text: &str,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::save_page_ocr_with_conn(&conn, textbook_id, page_index, ocr_text)
    }

    /// 保存教材单页 OCR 文本（使用现有连接）
    pub fn save_page_ocr_with_conn(
        conn: &Connection,
        textbook_id: &str,
        page_index: usize,
        ocr_text: &str,
    ) -> VfsResult<()> {
        // 获取现有的 OCR 数组（处理 NULL 值）
        let existing: Option<String> = conn
            .query_row(
                "SELECT ocr_pages_json FROM files WHERE id = ?1",
                params![textbook_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();

        // 解析或创建新数组
        let mut ocr_pages: Vec<Option<String>> = existing
            .as_deref()
            .map(parse_ocr_pages_json)
            .unwrap_or_default();

        // 扩展数组到需要的长度
        while ocr_pages.len() <= page_index {
            ocr_pages.push(None);
        }

        // 设置指定页的 OCR
        ocr_pages[page_index] = Some(ocr_text.to_string());

        // 序列化并保存
        let json = serde_json::to_string(&ocr_pages)
            .map_err(|e| VfsError::Database(format!("序列化 OCR 数组失败: {}", e)))?;

        conn.execute(
            "UPDATE files SET ocr_pages_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![
                json,
                chrono::Utc::now()
                    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                    .to_string(),
                textbook_id
            ],
        )?;

        debug!(
            "[VFS::TextbookRepo] Saved OCR for textbook {} page {}",
            textbook_id, page_index
        );
        Ok(())
    }

    /// 批量保存教材 OCR 文本
    ///
    /// ## 参数
    /// - `textbook_id`: 教材 ID
    /// - `ocr_pages`: OCR 文本数组，索引对应页码，None 表示该页无 OCR
    pub fn save_ocr_pages(
        db: &VfsDatabase,
        textbook_id: &str,
        ocr_pages: &[Option<String>],
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::save_ocr_pages_with_conn(&conn, textbook_id, ocr_pages)
    }

    /// 批量保存教材 OCR 文本（使用现有连接）
    pub fn save_ocr_pages_with_conn(
        conn: &Connection,
        textbook_id: &str,
        ocr_pages: &[Option<String>],
    ) -> VfsResult<()> {
        let json = serde_json::to_string(ocr_pages)
            .map_err(|e| VfsError::Database(format!("序列化 OCR 数组失败: {}", e)))?;

        conn.execute(
            "UPDATE files SET ocr_pages_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![
                json,
                chrono::Utc::now()
                    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                    .to_string(),
                textbook_id
            ],
        )?;

        info!(
            "[VFS::TextbookRepo] Saved {} OCR pages for textbook {}",
            ocr_pages.len(),
            textbook_id
        );
        Ok(())
    }

    /// 获取教材单页 OCR 文本
    pub fn get_page_ocr(
        db: &VfsDatabase,
        textbook_id: &str,
        page_index: usize,
    ) -> VfsResult<Option<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_page_ocr_with_conn(&conn, textbook_id, page_index)
    }

    /// 获取教材单页 OCR 文本（使用现有连接）
    pub fn get_page_ocr_with_conn(
        conn: &Connection,
        textbook_id: &str,
        page_index: usize,
    ) -> VfsResult<Option<String>> {
        let json: Option<String> = conn
            .query_row(
                "SELECT ocr_pages_json FROM files WHERE id = ?1",
                params![textbook_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();

        if let Some(json_str) = json {
            let ocr_pages: Vec<Option<String>> = parse_ocr_pages_json(&json_str);

            Ok(ocr_pages.get(page_index).cloned().flatten())
        } else {
            Ok(None)
        }
    }

    /// 获取教材所有 OCR 文本
    pub fn get_all_ocr_pages(
        db: &VfsDatabase,
        textbook_id: &str,
    ) -> VfsResult<Vec<Option<String>>> {
        let conn = db.get_conn_safe()?;
        Self::get_all_ocr_pages_with_conn(&conn, textbook_id)
    }

    /// 获取教材所有 OCR 文本（使用现有连接）
    pub fn get_all_ocr_pages_with_conn(
        conn: &Connection,
        textbook_id: &str,
    ) -> VfsResult<Vec<Option<String>>> {
        let json: Option<String> = conn
            .query_row(
                "SELECT ocr_pages_json FROM files WHERE id = ?1",
                params![textbook_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();

        if let Some(json_str) = json {
            Ok(parse_ocr_pages_json(&json_str))
        } else {
            Ok(Vec::new())
        }
    }

    /// 检查教材指定页是否已有 OCR
    pub fn has_page_ocr(db: &VfsDatabase, textbook_id: &str, page_index: usize) -> VfsResult<bool> {
        Ok(Self::get_page_ocr(db, textbook_id, page_index)?.is_some())
    }

    // ========================================================================
    // 多模态索引元数据（已废弃 - 使用 vfs_index_units 替代）
    // ========================================================================

    /// 保存单页的多模态索引元数据
    ///
    /// ⚠️ 已废弃：请使用 `VfsIndexService::sync_resource_units` 替代
    #[deprecated(
        since = "2026.1",
        note = "使用 VfsIndexService::sync_resource_units 替代"
    )]
    pub fn save_page_mm_index(
        db: &VfsDatabase,
        textbook_id: &str,
        meta: &PageIndexMeta,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::save_page_mm_index_with_conn(&conn, textbook_id, meta)
    }

    /// 保存单页的多模态索引元数据（使用现有连接）
    ///
    /// ⚠️ 已废弃：请使用 `VfsIndexService::sync_resource_units` 替代
    #[deprecated(
        since = "2026.1",
        note = "使用 VfsIndexService::sync_resource_units 替代"
    )]
    #[allow(deprecated)]
    pub fn save_page_mm_index_with_conn(
        conn: &Connection,
        textbook_id: &str,
        meta: &PageIndexMeta,
    ) -> VfsResult<()> {
        // 获取现有的索引数组（处理 NULL）
        let existing: Option<String> = conn
            .query_row(
                "SELECT mm_indexed_pages_json FROM files WHERE id = ?1",
                params![textbook_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();

        // 解析或创建新数组
        let mut pages: Vec<PageIndexMeta> = existing
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        // 更新或添加指定页的元数据
        if let Some(pos) = pages.iter().position(|p| p.page_index == meta.page_index) {
            pages[pos] = meta.clone();
        } else {
            pages.push(meta.clone());
        }

        // 序列化并保存
        let json = serde_json::to_string(&pages)
            .map_err(|e| VfsError::Database(format!("序列化索引元数据失败: {}", e)))?;

        conn.execute(
            "UPDATE files SET mm_indexed_pages_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![
                json,
                chrono::Utc::now()
                    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                    .to_string(),
                textbook_id
            ],
        )?;

        debug!(
            "[VFS::TextbookRepo] Saved MM index for textbook {} page {}",
            textbook_id, meta.page_index
        );
        Ok(())
    }

    /// 获取教材所有页面的多模态索引元数据
    ///
    /// ⚠️ 已废弃：请使用 `VfsIndexService::get_resource_units` 替代
    #[deprecated(
        since = "2026.1",
        note = "使用 VfsIndexService::get_resource_units 替代"
    )]
    pub fn get_mm_indexed_pages(
        db: &VfsDatabase,
        textbook_id: &str,
    ) -> VfsResult<Vec<PageIndexMeta>> {
        let conn = db.get_conn_safe()?;
        Self::get_mm_indexed_pages_with_conn(&conn, textbook_id)
    }

    /// 获取教材所有页面的多模态索引元数据（使用现有连接）
    ///
    /// ⚠️ 已废弃：请使用 `VfsIndexService::get_resource_units` 替代
    #[deprecated(
        since = "2026.1",
        note = "使用 VfsIndexService::get_resource_units 替代"
    )]
    #[allow(deprecated)]
    pub fn get_mm_indexed_pages_with_conn(
        conn: &Connection,
        textbook_id: &str,
    ) -> VfsResult<Vec<PageIndexMeta>> {
        let json: Option<String> = conn
            .query_row(
                "SELECT mm_indexed_pages_json FROM files WHERE id = ?1",
                params![textbook_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();

        if let Some(json_str) = json {
            let pages: Vec<PageIndexMeta> = serde_json::from_str(&json_str)
                .map_err(|e| VfsError::Database(format!("解析索引元数据失败: {}", e)))?;
            Ok(pages)
        } else {
            Ok(Vec::new())
        }
    }

    /// 获取已索引页面的 blob_hash 映射（用于增量索引检测）
    ///
    /// ⚠️ 已废弃：请使用 `VfsIndexService` 替代
    #[deprecated(since = "2026.1", note = "使用 VfsIndexService 替代")]
    #[allow(deprecated)]
    pub fn get_mm_indexed_blob_hashes(
        db: &VfsDatabase,
        textbook_id: &str,
    ) -> VfsResult<std::collections::HashMap<i32, String>> {
        let pages = Self::get_mm_indexed_pages(db, textbook_id)?;
        let mut map = std::collections::HashMap::new();
        for p in pages {
            map.insert(p.page_index, p.blob_hash);
        }
        Ok(map)
    }

    /// 删除教材的多模态索引元数据
    ///
    /// ⚠️ 已废弃：请使用 `VfsIndexService::delete_resource_index` 替代
    #[deprecated(
        since = "2026.1",
        note = "使用 VfsIndexService::delete_resource_index 替代"
    )]
    pub fn clear_mm_index(db: &VfsDatabase, textbook_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        conn.execute(
            "UPDATE files SET mm_indexed_pages_json = NULL, updated_at = ?1 WHERE id = ?2",
            params![
                chrono::Utc::now()
                    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                    .to_string(),
                textbook_id
            ],
        )?;
        info!(
            "[VFS::TextbookRepo] Cleared MM index for textbook {}",
            textbook_id
        );
        Ok(())
    }

    // ========================================================================
    // 多模态索引状态管理（已废弃 - 使用 vfs_index_units 替代）
    // ========================================================================

    /// 获取教材的多模态索引状态
    ///
    /// ⚠️ 已废弃：请使用 `VfsIndexService::get_resource_units` 替代
    #[deprecated(
        since = "2026.1",
        note = "使用 VfsIndexService::get_resource_units 替代"
    )]
    pub fn get_mm_index_state(db: &VfsDatabase, textbook_id: &str) -> VfsResult<Option<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_mm_index_state_with_conn(&conn, textbook_id)
    }

    /// ⚠️ 已废弃
    #[deprecated(
        since = "2026.1",
        note = "使用 VfsIndexService::get_resource_units 替代"
    )]
    #[allow(deprecated)]
    pub fn get_mm_index_state_with_conn(
        conn: &Connection,
        textbook_id: &str,
    ) -> VfsResult<Option<String>> {
        let state: Option<String> = conn
            .query_row(
                "SELECT mm_index_state FROM files WHERE id = ?1",
                params![textbook_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        Ok(state)
    }

    /// 设置教材的多模态索引状态
    ///
    /// ⚠️ 已废弃：请使用 `VfsIndexService` 替代
    #[deprecated(since = "2026.1", note = "使用 VfsIndexService 替代")]
    pub fn set_mm_index_state(
        db: &VfsDatabase,
        textbook_id: &str,
        state: &str,
        error: Option<&str>,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::set_mm_index_state_with_conn(&conn, textbook_id, state, error)
    }

    /// ⚠️ 已废弃
    #[deprecated(since = "2026.1", note = "使用 VfsIndexService 替代")]
    #[allow(deprecated)]
    pub fn set_mm_index_state_with_conn(
        conn: &Connection,
        textbook_id: &str,
        state: &str,
        error: Option<&str>,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE files SET mm_index_state = ?1, mm_index_error = ?2, updated_at = ?3 WHERE id = ?4",
            params![state, error, now, textbook_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "textbook".to_string(),
                id: textbook_id.to_string(),
            });
        }

        debug!(
            "[VFS::TextbookRepo] Set mm_index_state for {}: {}",
            textbook_id, state
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

    fn setup_test_db() -> (TempDir, VfsDatabase) {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db = VfsDatabase::new(temp_dir.path()).expect("Failed to create database");
        (temp_dir, db)
    }

    #[test]
    fn test_create_textbook() {
        let (_temp_dir, db) = setup_test_db();

        let textbook = VfsTextbookRepo::create_textbook(
            &db,
            "sha256_hash_123",
            "数学教材.pdf",
            1024000,
            None,
            Some("/path/to/file.pdf"),
        )
        .expect("Create textbook should succeed");

        assert!(!textbook.id.is_empty());
        assert_eq!(textbook.file_name, "数学教材.pdf");
        assert_eq!(textbook.sha256, "sha256_hash_123");
        assert_eq!(textbook.status, "active");
    }

    #[test]
    fn test_textbook_dedup_by_sha256() {
        let (_temp_dir, db) = setup_test_db();

        // 创建第一个教材
        let textbook1 =
            VfsTextbookRepo::create_textbook(&db, "sha256_same", "教材1.pdf", 1024, None, None)
                .expect("First create should succeed");

        // 使用相同 sha256 创建（应该返回已有记录）
        let textbook2 =
            VfsTextbookRepo::create_textbook(&db, "sha256_same", "教材2.pdf", 2048, None, None)
                .expect("Second create should succeed");

        assert_eq!(textbook1.id, textbook2.id, "Should return same textbook");
    }

    #[test]
    fn test_update_reading_progress() {
        let (_temp_dir, db) = setup_test_db();

        let textbook =
            VfsTextbookRepo::create_textbook(&db, "sha256_123", "教材.pdf", 1024, None, None)
                .expect("Create should succeed");

        // 更新阅读进度
        VfsTextbookRepo::update_reading_progress(&db, &textbook.id, 42)
            .expect("Update should succeed");

        // 验证
        let updated = VfsTextbookRepo::get_textbook(&db, &textbook.id)
            .expect("Get should succeed")
            .expect("Textbook should exist");

        assert_eq!(updated.last_page, Some(42));
        assert!(updated.last_opened_at.is_some());
    }

    #[test]
    fn test_list_textbooks() {
        let (_temp_dir, db) = setup_test_db();

        // 创建多个教材
        VfsTextbookRepo::create_textbook(&db, "sha1", "教材1.pdf", 1024, None, None).unwrap();
        VfsTextbookRepo::create_textbook(&db, "sha2", "教材2.pdf", 1024, None, None).unwrap();
        VfsTextbookRepo::create_textbook(&db, "sha3", "教材3.pdf", 1024, None, None).unwrap();

        // 查询所有
        let all = VfsTextbookRepo::list_textbooks(&db, 10, 0).expect("List should succeed");
        assert_eq!(all.len(), 3);
    }
}
