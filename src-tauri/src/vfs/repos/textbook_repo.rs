//! VFS 教材表 CRUD 操作
//!
//! 教材元数据管理，PDF 内容通过 `blob_hash` 指向 `blobs` 表。
//!
//! ## 核心方法
//! - `create_textbook`: 创建教材记录
//! - `get_textbook`: 获取教材元数据
//! - `list_textbooks`: 列出教材

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
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
                    "UPDATE files SET status = 'active', deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
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
                highlights: vec![],
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
    // 复制教材
    // ========================================================================

    /// 复制教材（共享 blob 并正确维护引用计数）
    ///
    /// ★ 2026-06-12（审阅问题 S3）：取代调用方手写的"伪 sha256 + 直接复用 blob_hash"
    /// 复制逻辑。旧实现的两个缺陷：
    /// 1. 副本 files 行直接指向原 blob 但未递增引用计数 → 删除任一副本时
    ///    `purge_file` 将 blob ref_count 减到 0，物理文件被清扫，**另一副本数据丢失**。
    /// 2. 不复制 preview_json → 副本没有页图预览，且 processing_status 永久停留
    ///    在 page_rendering（没有任何 pipeline 会拾取它）。
    ///
    /// 本实现：
    /// - 在同一 SAVEPOINT 内递增所有共享 blob（原文件 + 预渲染页图原始/压缩）的引用，
    ///   再插入副本行；任何失败回滚即可原子撤销引用增量。
    /// - 复制 preview_json / extracted_text / page_count，副本立即可预览。
    /// - sha256 列附加 `_copy_{nanoid}` 后缀以绕过 UNIQUE 去重（副本语义上
    ///   是独立文件记录，不应与原件合并）。
    pub fn copy_textbook(
        db: &VfsDatabase,
        src_textbook_id: &str,
        new_file_name: &str,
    ) -> VfsResult<VfsTextbook> {
        let conn = db.get_conn_safe()?;
        Self::copy_textbook_with_conn(&conn, src_textbook_id, new_file_name)
    }

    /// 复制教材（使用现有连接）
    pub fn copy_textbook_with_conn(
        conn: &Connection,
        src_textbook_id: &str,
        new_file_name: &str,
    ) -> VfsResult<VfsTextbook> {
        // 1. 读取源教材（含 preview_json / extracted_text，VfsTextbook 不携带这两列）
        let src = Self::get_textbook_with_conn(conn, src_textbook_id)?.ok_or_else(|| {
            VfsError::NotFound {
                resource_type: "Textbook".to_string(),
                id: src_textbook_id.to_string(),
            }
        })?;

        let (preview_json, extracted_text): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT preview_json, extracted_text FROM files WHERE id = ?1",
                params![src_textbook_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .unwrap_or((None, None));

        // 2. 收集需要共享引用的 blob 哈希
        let mut shared_hashes: Vec<String> = Vec::new();
        if let Some(ref h) = src.blob_hash {
            shared_hashes.push(h.clone());
        }
        if let Some(ref pj) = preview_json {
            if let Ok(preview) = serde_json::from_str::<PdfPreviewJson>(pj) {
                for page in &preview.pages {
                    shared_hashes.push(page.blob_hash.clone());
                    if let Some(ref ch) = page.compressed_blob_hash {
                        if ch != &page.blob_hash {
                            shared_hashes.push(ch.clone());
                        }
                    }
                }
            }
        }

        let new_sha256 = format!("{}_copy_{}", src.sha256, nanoid::nanoid!(8));

        // 3. SAVEPOINT 内：递增引用 + 插入副本行（失败回滚原子撤销引用增量）
        conn.execute("SAVEPOINT copy_textbook", [])?;

        let result = (|| -> VfsResult<VfsTextbook> {
            for hash in &shared_hashes {
                // blobs_dir 参数已不再用于物理删除，传空路径即可
                VfsBlobRepo::increment_ref_with_conn(conn, hash)?;
            }

            Self::create_textbook_with_preview(
                conn,
                &new_sha256,
                new_file_name,
                src.size,
                src.blob_hash.as_deref(),
                src.original_path.as_deref(),
                preview_json.as_deref(),
                extracted_text.as_deref(),
                src.page_count,
            )
        })();

        match result {
            Ok(textbook) => {
                conn.execute("RELEASE copy_textbook", [])?;
                info!(
                    "[VFS::TextbookRepo] Copied textbook {} -> {} ({} shared blobs ref+1)",
                    src_textbook_id,
                    textbook.id,
                    shared_hashes.len()
                );
                Ok(textbook)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO copy_textbook", []);
                let _ = conn.execute("RELEASE copy_textbook", []);
                error!(
                    "[VFS::TextbookRepo] Failed to copy textbook {}: {}",
                    src_textbook_id, e
                );
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
            SELECT f.id, f.resource_id, f.blob_hash, f.sha256, f.file_name, f.original_path, f.size, f.page_count,
                   f.tags_json, f.is_favorite, f.last_opened_at, f.last_page, f.bookmarks_json,
                   f.cover_key, f.status, f.created_at, f.updated_at, r.metadata_json
            FROM files f
            LEFT JOIN resources r ON r.id = f.resource_id
            WHERE f.id = ?1
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
            SELECT f.id, f.resource_id, f.blob_hash, f.sha256, f.file_name, f.original_path, f.size, f.page_count,
                   f.tags_json, f.is_favorite, f.last_opened_at, f.last_page, f.bookmarks_json,
                   f.cover_key, f.status, f.created_at, f.updated_at, r.metadata_json
            FROM files f
            LEFT JOIN resources r ON r.id = f.resource_id
            WHERE f.sha256 = ?1
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
            SELECT f.id, f.resource_id, f.blob_hash, f.sha256, f.file_name, f.original_path, f.size, f.page_count,
                   f.tags_json, f.is_favorite, f.last_opened_at, f.last_page, f.bookmarks_json,
                   f.cover_key, f.status, f.created_at, f.updated_at, r.metadata_json
            FROM files f
            LEFT JOIN resources r ON r.id = f.resource_id
            WHERE f.status = 'active'
            ORDER BY f.updated_at DESC
            LIMIT ?1 OFFSET ?2
            "#,
        )?;

        let rows = stmt.query_map(params![limit, offset], Self::row_to_textbook)?;
        let textbooks: Vec<VfsTextbook> = rows.filter_map(log_and_skip_err).collect();
        Ok(textbooks)
    }

    /// 按关键词列出教材（文件名/原始路径模糊匹配）
    pub fn search_textbooks(
        db: &VfsDatabase,
        search: &str,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsTextbook>> {
        let conn = db.get_conn_safe()?;
        Self::search_textbooks_with_conn(&conn, search, limit, offset)
    }

    /// 按关键词列出教材（使用现有连接）
    pub fn search_textbooks_with_conn(
        conn: &Connection,
        search: &str,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsTextbook>> {
        let pattern = format!(
            "%{}%",
            crate::vfs::repos::escape_like_pattern(search.trim())
        );
        let mut stmt = conn.prepare(
            r#"
            SELECT f.id, f.resource_id, f.blob_hash, f.sha256, f.file_name, f.original_path, f.size, f.page_count,
                   f.tags_json, f.is_favorite, f.last_opened_at, f.last_page, f.bookmarks_json,
                   f.cover_key, f.status, f.created_at, f.updated_at, r.metadata_json
            FROM files f
            LEFT JOIN resources r ON r.id = f.resource_id
            WHERE f.status = 'active'
              AND (f.file_name LIKE ?1 ESCAPE '\' OR COALESCE(f.original_path, '') LIKE ?1 ESCAPE '\')
            ORDER BY f.updated_at DESC
            LIMIT ?2 OFFSET ?3
            "#,
        )?;

        let rows = stmt.query_map(params![pattern, limit, offset], Self::row_to_textbook)?;
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

    /// 以教材 `updated_at` 为 OCC 基线原子替换书签列表。
    pub fn replace_bookmarks_if_version(
        db: &VfsDatabase,
        textbook_id: &str,
        bookmarks: &[Value],
        expected_updated_at: &str,
    ) -> VfsResult<VfsTextbook> {
        let mut conn = db.get_conn_safe()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current =
            Self::get_textbook_with_conn(&tx, textbook_id)?.ok_or_else(|| VfsError::NotFound {
                resource_type: "Textbook".to_string(),
                id: textbook_id.to_string(),
            })?;
        ensure_annotation_revision(&current, expected_updated_at)?;

        let bookmarks_json = serde_json::to_string(bookmarks)
            .map_err(|error| VfsError::Serialization(error.to_string()))?;
        let next_updated_at = next_annotation_revision(&current.updated_at);
        let changed = tx.execute(
            "UPDATE files SET bookmarks_json = ?1, updated_at = ?2 WHERE id = ?3 AND updated_at = ?4",
            params![bookmarks_json, next_updated_at, textbook_id, current.updated_at],
        )?;
        if changed != 1 {
            return Err(VfsError::Conflict {
                key: "textbooks.annotations_conflict".to_string(),
                message: "The textbook annotations changed before the bookmark update committed."
                    .to_string(),
            });
        }

        let updated =
            Self::get_textbook_with_conn(&tx, textbook_id)?.ok_or_else(|| VfsError::NotFound {
                resource_type: "Textbook".to_string(),
                id: textbook_id.to_string(),
            })?;
        tx.commit()?;
        Ok(updated)
    }

    /// 以教材 `updated_at` 为 OCC 基线，把高亮写入 DSTU resource metadata。
    pub fn replace_highlights_if_version(
        db: &VfsDatabase,
        textbook_id: &str,
        highlights: &[Value],
        expected_updated_at: &str,
    ) -> VfsResult<VfsTextbook> {
        const MAX_ANNOTATION_METADATA_BYTES: usize = 512 * 1024;

        let mut conn = db.get_conn_safe()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current =
            Self::get_textbook_with_conn(&tx, textbook_id)?.ok_or_else(|| VfsError::NotFound {
                resource_type: "Textbook".to_string(),
                id: textbook_id.to_string(),
            })?;
        ensure_annotation_revision(&current, expected_updated_at)?;
        let resource_id = current
            .resource_id
            .as_deref()
            .ok_or_else(|| VfsError::InvalidState {
                message: format!("Textbook {} has no associated VFS resource", textbook_id),
            })?;

        let raw_metadata: Option<Option<String>> = tx
            .query_row(
                "SELECT metadata_json FROM resources WHERE id = ?1",
                params![resource_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?;
        let raw_metadata = raw_metadata.ok_or_else(|| VfsError::NotFound {
            resource_type: "Resource".to_string(),
            id: resource_id.to_string(),
        })?;
        let mut metadata = match raw_metadata {
            Some(raw) => serde_json::from_str::<Value>(&raw)
                .map_err(|error| VfsError::Serialization(error.to_string()))?,
            None => serde_json::json!({}),
        };
        let metadata_object = metadata.as_object_mut().ok_or_else(|| {
            VfsError::Serialization("Textbook resource metadata must be a JSON object".to_string())
        })?;
        let extra = metadata_object
            .entry("extra")
            .or_insert_with(|| serde_json::json!({}));
        let extra_object = extra.as_object_mut().ok_or_else(|| {
            VfsError::Serialization(
                "Textbook resource metadata.extra must be a JSON object".to_string(),
            )
        })?;
        extra_object.insert("highlights".to_string(), Value::Array(highlights.to_vec()));

        let serialized = serde_json::to_string(&metadata)
            .map_err(|error| VfsError::Serialization(error.to_string()))?;
        if serialized.len() > MAX_ANNOTATION_METADATA_BYTES {
            return Err(VfsError::InvalidArgument {
                param: "highlights".to_string(),
                reason: format!(
                    "serialized annotation metadata exceeds {} bytes",
                    MAX_ANNOTATION_METADATA_BYTES
                ),
            });
        }

        let next_updated_at = next_annotation_revision(&current.updated_at);
        let now_ms = chrono::DateTime::parse_from_rfc3339(&next_updated_at)
            .map(|value| value.timestamp_millis())
            .unwrap_or_else(|_| chrono::Utc::now().timestamp_millis());
        let resource_changed = tx.execute(
            "UPDATE resources SET metadata_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![serialized, now_ms, resource_id],
        )?;
        if resource_changed != 1 {
            return Err(VfsError::NotFound {
                resource_type: "Resource".to_string(),
                id: resource_id.to_string(),
            });
        }
        let file_changed = tx.execute(
            "UPDATE files SET updated_at = ?1 WHERE id = ?2 AND updated_at = ?3",
            params![next_updated_at, textbook_id, current.updated_at],
        )?;
        if file_changed != 1 {
            return Err(VfsError::Conflict {
                key: "textbooks.annotations_conflict".to_string(),
                message: "The textbook annotations changed before the highlight update committed."
                    .to_string(),
            });
        }

        let updated =
            Self::get_textbook_with_conn(&tx, textbook_id)?.ok_or_else(|| VfsError::NotFound {
                resource_type: "Textbook".to_string(),
                id: textbook_id.to_string(),
            })?;
        tx.commit()?;
        Ok(updated)
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
            "UPDATE files SET status = 'deleted', deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND status = 'active'",
            params![now, textbook_id],
        )?;

        if updated == 0 {
            // ★ P0 修复：幂等处理 - 检查是否已被软删除
            let already_deleted: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM files WHERE id = ?1 AND status = 'deleted')",
                    params![textbook_id],
                    |row| row.get(0),
                )
                .unwrap_or(false);

            if already_deleted {
                info!(
                    "[VFS::TextbookRepo] Textbook already deleted (idempotent): {}",
                    textbook_id
                );
            } else {
                return Err(VfsError::NotFound {
                    resource_type: "Textbook".to_string(),
                    id: textbook_id.to_string(),
                });
            }
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
            "UPDATE files SET status = 'active', deleted_at = NULL, updated_at = ?1 WHERE id = ?2 AND status = 'deleted'",
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

    /// ★ 2026-06-12（审阅问题 R1/M7）：重新导入命中去重时，
    /// 将记录的显示名更新为本次导入的文件名（用户语义上是"重新上传了这个文件"）。
    /// 仅在名称确实变化时更新，避免无意义的 updated_at 抖动。
    pub fn rename_textbook_with_conn(
        conn: &Connection,
        textbook_id: &str,
        new_file_name: &str,
    ) -> VfsResult<bool> {
        let trimmed = new_file_name.trim();
        if trimmed.is_empty() {
            return Ok(false);
        }
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let updated = conn.execute(
            "UPDATE files SET file_name = ?1, name = ?1, updated_at = ?2 WHERE id = ?3 AND file_name != ?1",
            params![trimmed, now, textbook_id],
        )?;
        Ok(updated > 0)
    }

    /// ★ 2026-06-12（审阅问题 R1）：为缺失 blob 的教材补存内容（自愈）。
    ///
    /// 历史版本的 `textbooks_add` 只记录 original_path 不复制文件内容，
    /// 原文件被移动/删除后资源永久失效。本方法在以下时机调用：
    /// - 重新导入同一文件命中 sha256 去重时（顺手把内容补进 VFS）
    /// - 用户手动"重新关联"失联文件时
    ///
    /// 仅当记录当前没有 blob_hash 时才写入；返回是否实际补存。
    pub fn attach_blob_if_missing_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        textbook_id: &str,
        data: &[u8],
        mime_type: Option<&str>,
        extension: Option<&str>,
    ) -> VfsResult<bool> {
        let current: Option<Option<String>> = conn
            .query_row(
                "SELECT blob_hash FROM files WHERE id = ?1",
                params![textbook_id],
                |row| row.get(0),
            )
            .optional()?;

        match current {
            None => Err(VfsError::NotFound {
                resource_type: "Textbook".to_string(),
                id: textbook_id.to_string(),
            }),
            Some(Some(_)) => Ok(false),
            Some(None) => {
                let blob =
                    VfsBlobRepo::store_blob_with_conn(conn, blobs_dir, data, mime_type, extension)?;
                let now = chrono::Utc::now()
                    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                    .to_string();
                conn.execute(
                    "UPDATE files SET blob_hash = ?1, updated_at = ?2 WHERE id = ?3",
                    params![blob.hash, now, textbook_id],
                )?;
                info!(
                    "[VFS::TextbookRepo] Healed missing blob for textbook {}: {}",
                    textbook_id, blob.hash
                );
                Ok(true)
            }
        }
    }

    /// 永久删除教材
    pub fn purge_textbook(db: &VfsDatabase, textbook_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::purge_textbook_with_conn(&conn, db.blobs_dir(), textbook_id)?;
        // ★ 2026-06-10（审阅问题 A2）：事务提交后清扫 ref_count=0 的 blob
        if let Err(e) = VfsBlobRepo::cleanup_unreferenced_with_conn(&conn, db.blobs_dir()) {
            warn!(
                "[VFS::TextbookRepo] Post-purge blob sweep failed (will retry on next sweep): {}",
                e
            );
        }
        Ok(())
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

        // ★ 开启保存点事务
        // ★ 2026-06-10 修复（审阅问题 A2 关联）：改 BEGIN IMMEDIATE 为 SAVEPOINT，
        // 支持在外层事务（如文件夹树 purge）内嵌套调用。
        conn.execute_batch("SAVEPOINT vfs_textbook_purge_tx")
            .map_err(|e| {
                error!(
                    "[VFS::TextbookRepo] Failed to begin savepoint for purge: {}",
                    e
                );
                VfsError::Database(format!("Failed to begin savepoint: {}", e))
            })?;

        let result = (|| -> VfsResult<()> {
            // 1. 获取 blob_hash 和 preview_json
            // ★ 2026-06-12（第二轮审阅）：补查 compressed_blob_hash。
            // 旧实现 purge 教材时不递减文件级/页级压缩 blob 的引用计数，
            // 而 purge_file 链路是处理的 → 教材删除后压缩页图永久泄漏。
            let (blob_hash, preview_json, resource_id, compressed_blob_hash): (
                Option<String>,
                Option<String>,
                Option<String>,
                Option<String>,
            ) = conn
                .query_row(
                    "SELECT blob_hash, preview_json, resource_id, compressed_blob_hash FROM files WHERE id = ?1",
                    params![textbook_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
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

            // 2.5 ★ 递减文件级压缩 blob 引用（仅当与原始 blob 不同）
            if let Some(ref compressed_hash) = compressed_blob_hash {
                let same_as_original = blob_hash
                    .as_ref()
                    .map(|h| h == compressed_hash)
                    .unwrap_or(false);
                if !same_as_original {
                    if let Err(e) =
                        VfsBlobRepo::decrement_ref_with_conn(conn, blobs_dir, compressed_hash)
                    {
                        warn!(
                            "[VFS::TextbookRepo] Failed to decrement compressed blob ref {}: {}",
                            compressed_hash, e
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

                        // ★ 2026-06-12（第二轮审阅）：同时递减压缩页图 blob（与 purge_file 对齐）
                        if let Some(ref compressed_hash) = page.compressed_blob_hash {
                            if compressed_hash != &page.blob_hash {
                                if let Err(e) = VfsBlobRepo::decrement_ref_with_conn(
                                    conn,
                                    blobs_dir,
                                    compressed_hash,
                                ) {
                                    warn!(
                                        "[VFS::TextbookRepo] Failed to decrement PDF compressed page blob {}: {}",
                                        compressed_hash, e
                                    );
                                }
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

            // 4. ★ P0 修复：删除 folder_items 中的关联记录（防止孤儿记录）
            conn.execute(
                "DELETE FROM folder_items WHERE item_id = ?1",
                params![textbook_id],
            )?;

            // 5. 删除教材记录
            let deleted = conn.execute("DELETE FROM files WHERE id = ?1", params![textbook_id])?;

            if deleted == 0 {
                return Err(VfsError::NotFound {
                    resource_type: "Textbook".to_string(),
                    id: textbook_id.to_string(),
                });
            }

            // 5. 删除关联的 resources 表记录
            if let Some(ref res_id) = resource_id {
                // ★ 2026-06-12（第二轮审阅）：同时清理索引产物（units/segments/Lance 向量），
                // 否则语义检索仍会命中已删除教材的内容。
                super::index_unit_repo::purge_index_artifacts_by_resource(conn, res_id)?;
                let res_deleted =
                    conn.execute("DELETE FROM resources WHERE id = ?1", params![res_id])?;
                debug!(
                    "[VFS::TextbookRepo] Deleted {} resource record(s) for textbook: {}",
                    res_deleted, textbook_id
                );
            }

            Ok(())
        })();

        // ★ 根据结果提交或回滚保存点
        match result {
            Ok(_) => {
                conn.execute_batch("RELEASE SAVEPOINT vfs_textbook_purge_tx")
                    .map_err(|e| {
                        error!(
                            "[VFS::TextbookRepo] Failed to release purge savepoint: {}",
                            e
                        );
                        let _ = conn.execute_batch(
                            "ROLLBACK TO SAVEPOINT vfs_textbook_purge_tx; RELEASE SAVEPOINT vfs_textbook_purge_tx;",
                        );
                        VfsError::Database(format!("Failed to release savepoint: {}", e))
                    })?;
                info!(
                    "[VFS::TextbookRepo] Permanently deleted textbook: {}",
                    textbook_id
                );
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute_batch(
                    "ROLLBACK TO SAVEPOINT vfs_textbook_purge_tx; RELEASE SAVEPOINT vfs_textbook_purge_tx;",
                );
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
            SELECT f.id, f.resource_id, f.blob_hash, f.sha256, f.file_name, f.original_path, f.size, f.page_count,
                   f.tags_json, f.is_favorite, f.last_opened_at, f.last_page, f.bookmarks_json,
                   f.cover_key, f.status, f.created_at, f.updated_at, r.metadata_json
            FROM files f
            LEFT JOIN resources r ON r.id = f.resource_id
            WHERE f.status = 'deleted' AND f.id LIKE 'tb_%'
            ORDER BY f.updated_at DESC
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
        let count = Self::purge_deleted_textbooks_with_conn(&conn, db.blobs_dir())?;
        // ★ 2026-06-10（审阅问题 A2）：批量 purge 完成后统一清扫 ref_count=0 的 blob
        if let Err(e) = VfsBlobRepo::cleanup_unreferenced_with_conn(&conn, db.blobs_dir()) {
            warn!(
                "[VFS::TextbookRepo] Post-batch-purge blob sweep failed (will retry on next sweep): {}",
                e
            );
        }
        Ok(count)
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
            .prepare("SELECT id FROM files WHERE status = 'deleted' AND id LIKE 'tb_%'")?
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
        let resource_metadata_json: Option<String> = row.get(17)?;

        let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
        let bookmarks: Vec<Value> = serde_json::from_str(&bookmarks_json).unwrap_or_default();
        let highlights: Vec<Value> = resource_metadata_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|metadata| {
                metadata
                    .get("extra")?
                    .get("highlights")?
                    .as_array()
                    .cloned()
            })
            .unwrap_or_default();

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
            highlights,
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
        let now_str = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
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
                   t.cover_key, t.status, t.created_at, t.updated_at, r.metadata_json
            FROM files t
            LEFT JOIN resources r ON r.id = t.resource_id
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
        since = "0.9.2",
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
        since = "0.9.2",
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
        since = "0.9.2",
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
        since = "0.9.2",
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
    #[deprecated(since = "0.9.2", note = "使用 VfsIndexService 替代")]
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
        since = "0.9.2",
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
        since = "0.9.2",
        note = "使用 VfsIndexService::get_resource_units 替代"
    )]
    pub fn get_mm_index_state(db: &VfsDatabase, textbook_id: &str) -> VfsResult<Option<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_mm_index_state_with_conn(&conn, textbook_id)
    }

    /// ⚠️ 已废弃
    #[deprecated(
        since = "0.9.2",
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
    #[deprecated(since = "0.9.2", note = "使用 VfsIndexService 替代")]
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
    #[deprecated(since = "0.9.2", note = "使用 VfsIndexService 替代")]
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

fn ensure_annotation_revision(textbook: &VfsTextbook, expected_updated_at: &str) -> VfsResult<()> {
    if textbook.updated_at == expected_updated_at {
        return Ok(());
    }
    Err(VfsError::Conflict {
        key: "textbooks.annotations_conflict".to_string(),
        message: format!(
            "The textbook annotations changed (expected {}, current {}).",
            expected_updated_at, textbook.updated_at
        ),
    })
}

fn next_annotation_revision(current: &str) -> String {
    let now = chrono::Utc::now();
    let next = chrono::DateTime::parse_from_rfc3339(current)
        .map(|value| value.with_timezone(&chrono::Utc) + chrono::Duration::milliseconds(1))
        .map(|minimum| now.max(minimum))
        .unwrap_or(now);
    next.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_test_db() -> (TempDir, VfsDatabase) {
        crate::vfs::database::setup_migrated_test_db()
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

    // ★ 2026-06-12（审阅问题 S3 / 第二轮压缩 blob 泄漏）回归测试

    fn blob_ref_count(db: &VfsDatabase, hash: &str) -> Option<i32> {
        let conn = db.get_conn_safe().unwrap();
        conn.query_row(
            "SELECT ref_count FROM blobs WHERE hash = ?1",
            params![hash],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
    }

    /// 构造一个带页图 + 压缩页图的教材，返回 (textbook, 主hash, 页hash, 压缩页hash)
    fn create_textbook_with_blobs(db: &VfsDatabase) -> (VfsTextbook, String, String, String) {
        let main =
            VfsBlobRepo::store_blob(db, b"main-pdf-bytes", Some("application/pdf"), Some("pdf"))
                .unwrap();
        let page =
            VfsBlobRepo::store_blob(db, b"page-image-bytes", Some("image/jpeg"), Some("jpg"))
                .unwrap();
        let compressed = VfsBlobRepo::store_blob(
            db,
            b"compressed-page-bytes",
            Some("image/jpeg"),
            Some("jpg"),
        )
        .unwrap();

        let preview = serde_json::json!({
            "pages": [{
                "pageIndex": 0,
                "blobHash": page.hash,
                "width": 100,
                "height": 100,
                "mimeType": "image/jpeg",
                "compressedBlobHash": compressed.hash,
            }],
            "renderDpi": 150,
            "totalPages": 1,
            "renderedAt": "2026-06-12T00:00:00Z",
        });

        let conn = db.get_conn_safe().unwrap();
        let textbook = VfsTextbookRepo::create_textbook_with_preview(
            &conn,
            "sha-copy-test",
            "copy-test.pdf",
            1024,
            Some(&main.hash),
            None,
            Some(&preview.to_string()),
            Some("extracted text"),
            Some(1),
        )
        .unwrap();

        (textbook, main.hash, page.hash, compressed.hash)
    }

    /// 复制教材必须递增全部共享 blob 引用计数；删除原本后副本完整可用
    #[test]
    fn test_copy_textbook_shares_blobs_and_survives_source_purge() {
        let (_tmp, db) = setup_test_db();
        let (src, main_hash, page_hash, compressed_hash) = create_textbook_with_blobs(&db);

        let copy = VfsTextbookRepo::copy_textbook(&db, &src.id, "copy-test (副本).pdf").unwrap();
        assert_ne!(copy.id, src.id);
        assert_eq!(copy.blob_hash.as_deref(), Some(main_hash.as_str()));

        // 复制后引用计数 = 2
        assert_eq!(blob_ref_count(&db, &main_hash), Some(2), "main blob ref");
        assert_eq!(blob_ref_count(&db, &page_hash), Some(2), "page blob ref");
        assert_eq!(
            blob_ref_count(&db, &compressed_hash),
            Some(2),
            "compressed blob ref"
        );

        // 副本拥有自己的 preview_json
        let conn = db.get_conn_safe().unwrap();
        let copy_preview: Option<String> = conn
            .query_row(
                "SELECT preview_json FROM files WHERE id = ?1",
                params![copy.id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(copy_preview.unwrap_or_default().contains(&page_hash));
        drop(conn);

        // 删除原本：所有 blob 引用降为 1，行保留（副本仍可用）
        VfsTextbookRepo::purge_textbook(&db, &src.id).unwrap();
        assert_eq!(blob_ref_count(&db, &main_hash), Some(1));
        assert_eq!(blob_ref_count(&db, &page_hash), Some(1));
        assert_eq!(blob_ref_count(&db, &compressed_hash), Some(1));

        // 删除副本：全部归零并被清扫
        VfsTextbookRepo::purge_textbook(&db, &copy.id).unwrap();
        for h in [&main_hash, &page_hash, &compressed_hash] {
            let rc = blob_ref_count(&db, h);
            assert!(
                rc.is_none() || rc == Some(0),
                "blob {} should be unreferenced after both purges, got {:?}",
                h,
                rc
            );
        }
    }

    /// purge 教材必须递减文件级与页级压缩 blob 的引用计数（第二轮审阅修复）
    #[test]
    fn test_purge_textbook_decrements_compressed_blob_refs() {
        let (_tmp, db) = setup_test_db();
        let (textbook, main_hash, page_hash, compressed_hash) = create_textbook_with_blobs(&db);

        // 设置文件级压缩 blob（独立内容）
        let file_compressed = VfsBlobRepo::store_blob(
            &db,
            b"file-level-compressed",
            Some("image/jpeg"),
            Some("jpg"),
        )
        .unwrap();
        {
            let conn = db.get_conn_safe().unwrap();
            conn.execute(
                "UPDATE files SET compressed_blob_hash = ?1 WHERE id = ?2",
                params![file_compressed.hash, textbook.id],
            )
            .unwrap();
        }

        VfsTextbookRepo::purge_textbook(&db, &textbook.id).unwrap();

        for (label, h) in [
            ("main", &main_hash),
            ("page", &page_hash),
            ("page-compressed", &compressed_hash),
            ("file-compressed", &file_compressed.hash),
        ] {
            let rc = blob_ref_count(&db, h);
            assert!(
                rc.is_none() || rc == Some(0),
                "{} blob {} must be dereferenced on purge, got {:?}",
                label,
                h,
                rc
            );
        }
    }
}
