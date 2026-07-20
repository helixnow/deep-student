//! VFS 文件表 CRUD 操作
//!
//! 统一文件元数据管理，支持 document/image/audio/video 类型。
//!
//! ## 核心方法
//! - `create_file`: 创建文件记录
//! - `get_file`: 获取文件元数据
//! - `list_files`: 列出文件
//! - `list_files_by_folder`: 按文件夹列出文件
//! - `list_files_by_type`: 按类型列出文件

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::path::Path;
use tracing::{debug, error, info, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};

/// Log row-parse errors instead of silently discarding them.
fn log_and_skip_err<T>(result: Result<T, rusqlite::Error>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("[VFS::FileRepo] Row parse error (skipped): {}", e);
            None
        }
    }
}
use crate::vfs::ocr_utils::parse_ocr_pages_json;
use crate::vfs::repos::blob_repo::VfsBlobRepo;
use crate::vfs::repos::folder_repo::VfsFolderRepo;
use crate::vfs::types::{PdfPreviewJson, VfsFile, VfsFolderItem};

pub struct VfsFileRepo;

impl VfsFileRepo {
    // ========================================================================
    // 创建文件
    // ========================================================================

    pub fn create_file(
        db: &VfsDatabase,
        sha256: &str,
        file_name: &str,
        size: i64,
        file_type: &str,
        mime_type: Option<&str>,
        blob_hash: Option<&str>,
        original_path: Option<&str>,
    ) -> VfsResult<VfsFile> {
        let conn = db.get_conn_safe()?;
        Self::create_file_with_conn(
            &conn,
            sha256,
            file_name,
            size,
            file_type,
            mime_type,
            blob_hash,
            original_path,
        )
    }

    /// 创建文件（使用现有连接）
    ///
    /// ★ 2026-02-08 修复：使用 SAVEPOINT 事务保护，确保 INSERT resources + INSERT files 两步操作的原子性。
    /// SAVEPOINT 可安全嵌套在外层 BEGIN IMMEDIATE 事务内（如 create_file_in_folder_with_conn）。
    pub fn create_file_with_conn(
        conn: &Connection,
        sha256: &str,
        file_name: &str,
        size: i64,
        file_type: &str,
        mime_type: Option<&str>,
        blob_hash: Option<&str>,
        original_path: Option<&str>,
    ) -> VfsResult<VfsFile> {
        // 去重检查（只读，不需要事务保护）
        if let Some(existing) = Self::get_by_sha256_with_conn(conn, sha256)? {
            debug!(
                "[VFS::FileRepo] File with same sha256 already exists: {} (status: {:?})",
                existing.id, existing.status
            );
            if existing.status != "active" {
                info!(
                    "[VFS::FileRepo] Restoring soft-deleted file: {} from status {:?} to active",
                    existing.id, existing.status
                );
                let now = chrono::Utc::now()
                    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                    .to_string();
                conn.execute(
                    "UPDATE files SET status = 'active', deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
                    params![now, existing.id],
                )?;
                return Self::get_file_with_conn(conn, &existing.id)?.ok_or_else(|| {
                    VfsError::Database(format!("File {} not found after restore", existing.id))
                });
            }
            return Ok(existing);
        }

        // ★ SAVEPOINT 事务保护：包裹 INSERT resources + INSERT files 两步操作
        conn.execute("SAVEPOINT create_file", []).map_err(|e| {
            error!(
                "[VFS::FileRepo] Failed to create savepoint for create_file: {}",
                e
            );
            VfsError::Database(format!("Failed to create savepoint: {}", e))
        })?;

        let result = (|| -> VfsResult<VfsFile> {
            let file_id = VfsFile::generate_id();
            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
            let now_ms = chrono::Utc::now().timestamp_millis();

            let resource_id = format!("res_{}", nanoid::nanoid!(10));
            conn.execute(
                r#"
                INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data, ref_count, created_at, updated_at)
                VALUES (?1, ?2, 'file', ?3, 'files', 'inline', '', 0, ?4, ?5)
                "#,
                params![resource_id, sha256, file_id, now_ms, now_ms],
            )?;

            conn.execute(
                r#"
                INSERT INTO files (id, resource_id, blob_hash, sha256, file_name, original_path, size, "type", mime_type, tags_json, is_favorite, status, created_at, updated_at, processing_status, processing_progress, processing_error, processing_started_at, processing_completed_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '[]', 0, 'active', ?10, ?11, NULL, NULL, NULL, NULL, NULL)
                "#,
                params![
                    file_id,
                    resource_id,
                    blob_hash,
                    sha256,
                    file_name,
                    original_path,
                    size,
                    file_type,
                    mime_type,
                    now,
                    now,
                ],
            )?;

            info!(
                "[VFS::FileRepo] Created file: {} with resource: {} (name: {}, type: {})",
                file_id, resource_id, file_name, file_type
            );

            Ok(VfsFile {
                id: file_id,
                resource_id: Some(resource_id),
                blob_hash: blob_hash.map(|s| s.to_string()),
                sha256: sha256.to_string(),
                file_name: file_name.to_string(),
                original_path: original_path.map(|s| s.to_string()),
                size,
                page_count: None,
                file_type: file_type.to_string(),
                mime_type: mime_type.map(|s| s.to_string()),
                tags: vec![],
                is_favorite: false,
                last_opened_at: None,
                last_page: None,
                bookmarks: vec![],
                cover_key: None,
                extracted_text: None,
                preview_json: None,
                ocr_pages_json: None,
                description: None,
                status: "active".to_string(),
                created_at: now.clone(),
                updated_at: now,
                deleted_at: None,
                // PDF 预处理流水线字段（初始为 None）
                processing_status: None,
                processing_progress: None,
                processing_error: None,
                processing_started_at: None,
                processing_completed_at: None,
                compressed_blob_hash: None,
            })
        })();

        match result {
            Ok(file) => {
                conn.execute("RELEASE create_file", []).map_err(|e| {
                    error!(
                        "[VFS::FileRepo] Failed to release savepoint create_file: {}",
                        e
                    );
                    VfsError::Database(format!("Failed to release savepoint: {}", e))
                })?;
                Ok(file)
            }
            Err(e) => {
                // 回滚到 savepoint，忽略回滚本身的错误
                let _ = conn.execute("ROLLBACK TO create_file", []);
                // 释放 savepoint（即使回滚后也需要释放，否则 savepoint 会残留）
                let _ = conn.execute("RELEASE create_file", []);
                Err(e)
            }
        }
    }

    pub fn create_file_in_folder(
        db: &VfsDatabase,
        sha256: &str,
        file_name: &str,
        size: i64,
        file_type: &str,
        mime_type: Option<&str>,
        blob_hash: Option<&str>,
        original_path: Option<&str>,
        folder_id: Option<&str>,
    ) -> VfsResult<VfsFile> {
        let conn = db.get_conn_safe()?;
        Self::create_file_in_folder_with_conn(
            &conn,
            sha256,
            file_name,
            size,
            file_type,
            mime_type,
            blob_hash,
            original_path,
            folder_id,
        )
    }

    /// ★ CONC-01 修复：使用事务保护，防止文件创建成功但 folder_items 失败导致"孤儿资源"
    pub fn create_file_in_folder_with_conn(
        conn: &Connection,
        sha256: &str,
        file_name: &str,
        size: i64,
        file_type: &str,
        mime_type: Option<&str>,
        blob_hash: Option<&str>,
        original_path: Option<&str>,
        folder_id: Option<&str>,
    ) -> VfsResult<VfsFile> {
        // 开始事务
        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<VfsFile> {
            // 1. 检查文件夹存在性
            if let Some(fid) = folder_id {
                if !VfsFolderRepo::folder_exists_with_conn(conn, fid)? {
                    return Err(VfsError::NotFound {
                        resource_type: "Folder".to_string(),
                        id: fid.to_string(),
                    });
                }
            }

            // 2. 创建文件
            let file = Self::create_file_with_conn(
                conn,
                sha256,
                file_name,
                size,
                file_type,
                mime_type,
                blob_hash,
                original_path,
            )?;

            // 3. 创建 folder_items 记录
            let folder_item = VfsFolderItem::new(
                folder_id.map(|s| s.to_string()),
                "file".to_string(),
                file.id.clone(),
            );
            VfsFolderRepo::add_item_to_folder_with_conn(conn, &folder_item)?;

            debug!(
                "[VFS::FileRepo] Created file {} in folder {:?}",
                file.id, folder_id
            );

            Ok(file)
        })();

        match result {
            Ok(file) => {
                conn.execute("COMMIT", [])?;
                Ok(file)
            }
            Err(e) => {
                // 回滚事务，忽略回滚本身的错误
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// 复制文件/图片附件（共享 blob 并正确维护引用计数）
    ///
    /// ★ 2026-06-12（第二轮审阅）：取代 DSTU 层"伪 sha256 + 直接复用 blob_hash"
    /// 的复制逻辑。旧实现的缺陷与教材复制（审阅问题 S3）相同：
    /// 1. 副本指向原 blob 但不递增引用计数 → 删除任一副本，物理文件被清扫，
    ///    另一副本数据丢失；
    /// 2. 不复制 preview_json/extracted_text/ocr_pages_json/compressed_blob_hash
    ///    → PDF/图片副本丢失预览、OCR 与压缩产物。
    pub fn copy_file_with_conn(
        conn: &Connection,
        src_file_id: &str,
        new_file_name: &str,
    ) -> VfsResult<VfsFile> {
        // 1. 读取源文件完整数据
        let src =
            Self::get_file_with_conn(conn, src_file_id)?.ok_or_else(|| VfsError::NotFound {
                resource_type: "File".to_string(),
                id: src_file_id.to_string(),
            })?;

        let (processing_status, processing_progress): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT processing_status, processing_progress FROM files WHERE id = ?1",
                params![src_file_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .unwrap_or((None, None));

        // 2. 收集需要共享引用的 blob 哈希
        let mut shared_hashes: Vec<String> = Vec::new();
        if let Some(ref h) = src.blob_hash {
            shared_hashes.push(h.clone());
        }
        if let Some(ref ch) = src.compressed_blob_hash {
            if src.blob_hash.as_deref() != Some(ch.as_str()) {
                shared_hashes.push(ch.clone());
            }
        }
        if let Some(ref pj) = src.preview_json {
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

        conn.execute("SAVEPOINT copy_file", [])?;

        let result = (|| -> VfsResult<VfsFile> {
            for hash in &shared_hashes {
                VfsBlobRepo::increment_ref_with_conn(conn, hash)?;
            }

            let file_id = VfsFile::generate_id();
            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
            let now_ms = chrono::Utc::now().timestamp_millis();

            let resource_id = format!("res_{}", nanoid::nanoid!(10));
            conn.execute(
                r#"
                INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data, ref_count, created_at, updated_at)
                VALUES (?1, ?2, 'file', ?3, 'files', 'inline', ?4, 0, ?5, ?6)
                "#,
                params![
                    resource_id,
                    new_sha256,
                    file_id,
                    src.extracted_text.clone().unwrap_or_default(),
                    now_ms,
                    now_ms,
                ],
            )?;

            conn.execute(
                r#"
                INSERT INTO files (id, resource_id, blob_hash, sha256, file_name, original_path, size,
                                   page_count, "type", mime_type, tags_json, is_favorite, status,
                                   created_at, updated_at, preview_json, extracted_text, ocr_pages_json,
                                   compressed_blob_hash, processing_status, processing_progress)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, '[]', 0, 'active', ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
                "#,
                params![
                    file_id,
                    resource_id,
                    src.blob_hash,
                    new_sha256,
                    new_file_name,
                    src.original_path,
                    src.size,
                    src.page_count,
                    src.file_type,
                    src.mime_type,
                    now,
                    now,
                    src.preview_json,
                    src.extracted_text,
                    src.ocr_pages_json,
                    src.compressed_blob_hash,
                    processing_status,
                    processing_progress,
                ],
            )?;

            Self::get_file_with_conn(conn, &file_id)?
                .ok_or_else(|| VfsError::Database(format!("File {} not found after copy", file_id)))
        })();

        match result {
            Ok(file) => {
                conn.execute("RELEASE copy_file", [])?;
                info!(
                    "[VFS::FileRepo] Copied file {} -> {} ({} shared blobs ref+1)",
                    src_file_id,
                    file.id,
                    shared_hashes.len()
                );
                Ok(file)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO copy_file", []);
                let _ = conn.execute("RELEASE copy_file", []);
                error!("[VFS::FileRepo] Failed to copy file {}: {}", src_file_id, e);
                Err(e)
            }
        }
    }

    /// 创建文件记录（带文档处理数据）
    ///
    /// ★ P2-1 修复：支持存储 PDF 预渲染和文本提取结果
    /// ★ 2026-02-08 修复：使用 SAVEPOINT 事务保护，确保 5 步操作（检查文件夹、检查去重、
    ///   INSERT resources、INSERT files、INSERT folder_items）的原子性，
    ///   防止部分写入导致孤儿资源或数据不一致。
    pub fn create_file_with_doc_data_in_folder(
        conn: &Connection,
        sha256: &str,
        file_name: &str,
        size: i64,
        file_type: &str,
        mime_type: Option<&str>,
        blob_hash: Option<&str>,
        original_path: Option<&str>,
        folder_id: Option<&str>,
        preview_json: Option<&str>,
        extracted_text: Option<&str>,
        page_count: Option<i32>,
    ) -> VfsResult<VfsFile> {
        Self::create_file_with_doc_data_in_folder_outcome(
            conn,
            sha256,
            file_name,
            size,
            file_type,
            mime_type,
            blob_hash,
            original_path,
            folder_id,
            preview_json,
            extracted_text,
            page_count,
        )
        .map(|(file, _created)| file)
    }

    /// 同 [`Self::create_file_with_doc_data_in_folder`]，另返回 `created` 标记：
    ///
    /// - `true`：本次调用新建了 resources/files/folder_items 行；
    /// - `false`：sha256 去重命中，返回的是已存在（或被恢复的软删除）文件，
    ///   **没有**新建行。
    ///
    /// ★ TD-03：上传 saga 依赖该标记决定 blob 引用归属——去重命中时调用方
    /// 在本次 `store_blob` 中做出的 ref_count +1 没有被任何新文件行接管，
    /// 必须补偿回退，否则该 blob 的引用计数将永久虚高、无法被清扫。
    pub fn create_file_with_doc_data_in_folder_outcome(
        conn: &Connection,
        sha256: &str,
        file_name: &str,
        size: i64,
        file_type: &str,
        mime_type: Option<&str>,
        blob_hash: Option<&str>,
        original_path: Option<&str>,
        folder_id: Option<&str>,
        preview_json: Option<&str>,
        extracted_text: Option<&str>,
        page_count: Option<i32>,
    ) -> VfsResult<(VfsFile, bool)> {
        // ★ SAVEPOINT 事务保护：包裹所有写操作
        conn.execute("SAVEPOINT create_file_doc", []).map_err(|e| {
            error!(
                "[VFS::FileRepo] Failed to create savepoint for create_file_doc: {}",
                e
            );
            VfsError::Database(format!("Failed to create savepoint: {}", e))
        })?;

        let result = (|| -> VfsResult<(VfsFile, bool)> {
            // 1. 检查文件夹存在性
            if let Some(fid) = folder_id {
                if !VfsFolderRepo::folder_exists_with_conn(conn, fid)? {
                    return Err(VfsError::NotFound {
                        resource_type: "Folder".to_string(),
                        id: fid.to_string(),
                    });
                }
            }

            // 2. 检查是否已存在相同 sha256（去重）
            if let Some(existing) = Self::get_by_sha256_with_conn(conn, sha256)? {
                debug!(
                    "[VFS::FileRepo] File with same sha256 already exists: {} (status: {:?})",
                    existing.id, existing.status
                );
                let ensure_folder_assignment = |file_id: &str| -> VfsResult<()> {
                    let folder_item = VfsFolderItem::new(
                        folder_id.map(|s| s.to_string()),
                        "file".to_string(),
                        file_id.to_string(),
                    );
                    VfsFolderRepo::add_item_to_folder_with_conn(conn, &folder_item)
                };

                if existing.status != "active" {
                    info!(
                        "[VFS::FileRepo] Restoring soft-deleted file: {} from status {:?} to active",
                        existing.id, existing.status
                    );
                    let now = chrono::Utc::now()
                        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                        .to_string();
                    conn.execute(
                        "UPDATE files SET status = 'active', deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
                        params![now, existing.id],
                    )?;
                    ensure_folder_assignment(&existing.id)?;
                    let restored =
                        Self::get_file_with_conn(conn, &existing.id)?.ok_or_else(|| {
                            VfsError::Database(format!(
                                "File {} not found after restore",
                                existing.id
                            ))
                        })?;
                    return Ok((restored, false));
                }

                ensure_folder_assignment(&existing.id)?;
                return Ok((existing, false));
            }

            let file_id = VfsFile::generate_id();
            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
            let now_ms = chrono::Utc::now().timestamp_millis();

            // 3. 创建 resource 记录
            let resource_id = format!("res_{}", nanoid::nanoid!(10));
            conn.execute(
                r#"
                INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data, ref_count, created_at, updated_at)
                VALUES (?1, ?2, 'file', ?3, 'files', 'inline', '', 0, ?4, ?5)
                "#,
                params![resource_id, sha256, file_id, now_ms, now_ms],
            )?;

            // ★ PDF 预处理流水线状态（迁移 V20260204）
            // 由于已经调用了 render_pdf_preview()，Stage 1（文本提取）和 Stage 2（页面渲染）已完成
            let is_pdf = mime_type.map(|m| m == "application/pdf").unwrap_or(false)
                || file_name.to_lowercase().ends_with(".pdf");

            let (processing_status, processing_progress, processing_started_at): (
                Option<&str>,
                Option<String>,
                Option<i64>,
            ) = if is_pdf {
                let has_text = extracted_text
                    .as_ref()
                    .map(|t| !t.trim().is_empty())
                    .unwrap_or(false);
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

            // 4. 创建 files 记录（包含文档处理数据）
            conn.execute(
                r#"
                INSERT INTO files (id, resource_id, blob_hash, sha256, file_name, original_path, size, "type", mime_type,
                                  tags_json, is_favorite, status, created_at, updated_at, preview_json, extracted_text, page_count,
                                  processing_status, processing_progress, processing_started_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '[]', 0, 'active', ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
                "#,
                params![
                    file_id,
                    resource_id,
                    blob_hash,
                    sha256,
                    file_name,
                    original_path,
                    size,
                    file_type,
                    mime_type,
                    now,
                    now,
                    preview_json,
                    extracted_text,
                    page_count,
                    processing_status,
                    processing_progress,
                    processing_started_at,
                ],
            )?;

            // 5. 添加到文件夹
            let folder_item = VfsFolderItem::new(
                folder_id.map(|s| s.to_string()),
                "file".to_string(),
                file_id.clone(),
            );
            VfsFolderRepo::add_item_to_folder_with_conn(conn, &folder_item)?;

            info!(
                "[VFS::FileRepo] Created file with doc data: {} (name: {}, type: {}, has_text: {}, has_preview: {})",
                file_id, file_name, file_type, extracted_text.is_some(), preview_json.is_some()
            );

            Ok((
                VfsFile {
                    id: file_id,
                    resource_id: Some(resource_id),
                    blob_hash: blob_hash.map(|s| s.to_string()),
                    sha256: sha256.to_string(),
                    file_name: file_name.to_string(),
                    original_path: original_path.map(|s| s.to_string()),
                    size,
                    page_count,
                    file_type: file_type.to_string(),
                    mime_type: mime_type.map(|s| s.to_string()),
                    tags: vec![],
                    is_favorite: false,
                    last_opened_at: None,
                    last_page: None,
                    bookmarks: vec![],
                    cover_key: None,
                    extracted_text: extracted_text.map(|s| s.to_string()),
                    preview_json: preview_json.map(|s| s.to_string()),
                    ocr_pages_json: None,
                    description: None,
                    status: "active".to_string(),
                    created_at: now.clone(),
                    updated_at: now,
                    deleted_at: None,
                    // PDF 预处理流水线字段
                    processing_status: processing_status.map(|s| s.to_string()),
                    processing_progress,
                    processing_error: None,
                    processing_started_at,
                    processing_completed_at: None,
                    compressed_blob_hash: None,
                },
                true,
            ))
        })();

        match result {
            Ok(file) => {
                conn.execute("RELEASE create_file_doc", []).map_err(|e| {
                    error!(
                        "[VFS::FileRepo] Failed to release savepoint create_file_doc: {}",
                        e
                    );
                    VfsError::Database(format!("Failed to release savepoint: {}", e))
                })?;
                Ok(file)
            }
            Err(e) => {
                // 回滚到 savepoint，忽略回滚本身的错误
                let _ = conn.execute("ROLLBACK TO create_file_doc", []);
                // 释放 savepoint（即使回滚后也需要释放，否则 savepoint 会残留）
                let _ = conn.execute("RELEASE create_file_doc", []);
                Err(e)
            }
        }
    }

    // ========================================================================
    // 查询文件
    // ========================================================================

    pub fn get_file(db: &VfsDatabase, file_id: &str) -> VfsResult<Option<VfsFile>> {
        let conn = db.get_conn_safe()?;
        Self::get_file_with_conn(&conn, file_id)
    }

    pub fn get_file_with_conn(conn: &Connection, file_id: &str) -> VfsResult<Option<VfsFile>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, blob_hash, sha256, file_name, original_path, size, page_count,
                   "type", mime_type, tags_json, is_favorite, last_opened_at, last_page, bookmarks_json,
                   cover_key, extracted_text, preview_json, ocr_pages_json, description,
                   status, created_at, updated_at, deleted_at,
                   processing_status, processing_progress, processing_error,
                   processing_started_at, processing_completed_at,
                   compressed_blob_hash
            FROM files
            WHERE id = ?1
            "#,
        )?;

        let file = stmt
            .query_row(params![file_id], Self::row_to_file)
            .optional()?;

        Ok(file)
    }

    pub fn get_by_sha256(db: &VfsDatabase, sha256: &str) -> VfsResult<Option<VfsFile>> {
        let conn = db.get_conn_safe()?;
        Self::get_by_sha256_with_conn(&conn, sha256)
    }

    pub fn get_by_sha256_with_conn(conn: &Connection, sha256: &str) -> VfsResult<Option<VfsFile>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, blob_hash, sha256, file_name, original_path, size, page_count,
                   "type", mime_type, tags_json, is_favorite, last_opened_at, last_page, bookmarks_json,
                   cover_key, extracted_text, preview_json, ocr_pages_json, description,
                   status, created_at, updated_at, deleted_at,
                   processing_status, processing_progress, processing_error,
                   processing_started_at, processing_completed_at,
                   compressed_blob_hash
            FROM files
            WHERE sha256 = ?1
            "#,
        )?;

        let file = stmt
            .query_row(params![sha256], Self::row_to_file)
            .optional()?;

        Ok(file)
    }

    // ========================================================================
    // 列表查询
    // ========================================================================

    pub fn list_files(db: &VfsDatabase, limit: u32, offset: u32) -> VfsResult<Vec<VfsFile>> {
        let conn = db.get_conn_safe()?;
        Self::list_files_with_conn(&conn, limit, offset)
    }

    pub fn list_files_with_conn(
        conn: &Connection,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsFile>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, blob_hash, sha256, file_name, original_path, size, page_count,
                   "type", mime_type, tags_json, is_favorite, last_opened_at, last_page, bookmarks_json,
                   cover_key, extracted_text, preview_json, ocr_pages_json, description,
                   status, created_at, updated_at, deleted_at,
                   processing_status, processing_progress, processing_error,
                   processing_started_at, processing_completed_at,
                   compressed_blob_hash
            FROM files
            WHERE status = 'active'
            ORDER BY updated_at DESC
            LIMIT ?1 OFFSET ?2
            "#,
        )?;

        let rows = stmt.query_map(params![limit, offset], Self::row_to_file)?;
        let files: Vec<VfsFile> = rows.filter_map(log_and_skip_err).collect();
        Ok(files)
    }

    pub fn list_files_by_folder(
        db: &VfsDatabase,
        folder_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsFile>> {
        let conn = db.get_conn_safe()?;
        Self::list_files_by_folder_with_conn(&conn, folder_id, limit, offset)
    }

    pub fn list_files_by_folder_with_conn(
        conn: &Connection,
        folder_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsFile>> {
        let sql = r#"
            SELECT f.id, f.resource_id, f.blob_hash, f.sha256, f.file_name, f.original_path, f.size, f.page_count,
                   f."type", f.mime_type, f.tags_json, f.is_favorite, f.last_opened_at, f.last_page, f.bookmarks_json,
                   f.cover_key, f.extracted_text, f.preview_json, f.ocr_pages_json, f.description,
                   f.status, f.created_at, f.updated_at, f.deleted_at,
                   f.processing_status, f.processing_progress, f.processing_error,
                   f.processing_started_at, f.processing_completed_at,
                   f.compressed_blob_hash
            FROM files f
            JOIN folder_items fi ON fi.item_type = 'file' AND fi.item_id = f.id
            WHERE fi.folder_id IS ?1 AND f.status = 'active'
            ORDER BY fi.sort_order ASC, f.updated_at DESC
            LIMIT ?2 OFFSET ?3
        "#;

        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![folder_id, limit, offset], Self::row_to_file)?;

        let files: Vec<VfsFile> = rows.filter_map(log_and_skip_err).collect();
        debug!(
            "[VFS::FileRepo] list_files_by_folder({:?}): {} files",
            folder_id,
            files.len()
        );
        Ok(files)
    }

    pub fn list_files_by_type(
        db: &VfsDatabase,
        file_type: &str,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsFile>> {
        let conn = db.get_conn_safe()?;
        Self::list_files_by_type_with_conn(&conn, file_type, limit, offset)
    }

    pub fn list_files_by_type_with_conn(
        conn: &Connection,
        file_type: &str,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsFile>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, blob_hash, sha256, file_name, original_path, size, page_count,
                   "type", mime_type, tags_json, is_favorite, last_opened_at, last_page, bookmarks_json,
                   cover_key, extracted_text, preview_json, ocr_pages_json, description,
                   status, created_at, updated_at, deleted_at,
                   processing_status, processing_progress, processing_error,
                   processing_started_at, processing_completed_at,
                   compressed_blob_hash
            FROM files
            WHERE "type" = ?1 AND status = 'active'
            ORDER BY updated_at DESC
            LIMIT ?2 OFFSET ?3
            "#,
        )?;

        let rows = stmt.query_map(params![file_type, limit, offset], Self::row_to_file)?;
        let files: Vec<VfsFile> = rows.filter_map(log_and_skip_err).collect();
        debug!(
            "[VFS::FileRepo] list_files_by_type({}): {} files",
            file_type,
            files.len()
        );
        Ok(files)
    }

    // ========================================================================
    // 更新文件
    // ========================================================================

    pub fn update_file_name(db: &VfsDatabase, file_id: &str, new_name: &str) -> VfsResult<VfsFile> {
        let conn = db.get_conn_safe()?;
        Self::update_file_name_with_conn(&conn, file_id, new_name)
    }

    pub fn update_file_name_with_conn(
        conn: &Connection,
        file_id: &str,
        new_name: &str,
    ) -> VfsResult<VfsFile> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE files SET file_name = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_name, now, file_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "File".to_string(),
                id: file_id.to_string(),
            });
        }

        info!("[VFS::FileRepo] Renamed file: {} -> {}", file_id, new_name);
        Self::get_file_with_conn(conn, file_id)?.ok_or_else(|| VfsError::NotFound {
            resource_type: "File".to_string(),
            id: file_id.to_string(),
        })
    }

    pub fn set_favorite(db: &VfsDatabase, file_id: &str, favorite: bool) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::set_favorite_with_conn(&conn, file_id, favorite)
    }

    pub fn set_favorite_with_conn(
        conn: &Connection,
        file_id: &str,
        favorite: bool,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        conn.execute(
            "UPDATE files SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3",
            params![favorite as i32, now, file_id],
        )?;

        Ok(())
    }

    // ========================================================================
    // 删除文件
    // ========================================================================

    pub fn delete_file(db: &VfsDatabase, file_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_file_with_conn(&conn, file_id)
    }

    /// ★ CONC-02 修复：软删除文件时同步软删除 folder_items 中的关联记录
    pub fn delete_file_with_conn(conn: &Connection, file_id: &str) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE files SET status = 'deleted', deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND status = 'active'",
            params![now, file_id],
        )?;

        if updated == 0 {
            // ★ P0 修复：幂等处理 - 检查文件是否已被软删除
            // 如果文件已 status='deleted'，视为幂等成功，避免批量删除事务回滚
            let already_deleted: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM files WHERE id = ?1 AND status = 'deleted')",
                    params![file_id],
                    |row| row.get(0),
                )
                .unwrap_or(false);

            if already_deleted {
                info!(
                    "[VFS::FileRepo] File already deleted (idempotent): {}",
                    file_id
                );
            } else {
                return Err(VfsError::NotFound {
                    resource_type: "File".to_string(),
                    id: file_id.to_string(),
                });
            }
        }

        // ★ CONC-02 修复：软删除 folder_items 中的关联记录
        // ★ P0 修复：deleted_at 是 TEXT 列，updated_at 是 INTEGER 列，必须分开处理
        let now_str = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let now_ms = chrono::Utc::now().timestamp_millis();
        let fi_updated = conn.execute(
            "UPDATE folder_items SET deleted_at = ?1, updated_at = ?2 WHERE item_type = 'file' AND item_id = ?3 AND deleted_at IS NULL",
            params![now_str, now_ms, file_id],
        )?;

        info!(
            "[VFS::FileRepo] Soft deleted file: {} (folder_items updated: {})",
            file_id, fi_updated
        );
        Ok(())
    }

    pub fn restore_file(db: &VfsDatabase, file_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::restore_file_with_conn(&conn, file_id)
    }

    /// ★ CONC-02 修复：恢复文件时同步恢复 folder_items 中的关联记录
    pub fn restore_file_with_conn(conn: &Connection, file_id: &str) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE files SET status = 'active', deleted_at = NULL, updated_at = ?1 WHERE id = ?2 AND status = 'deleted'",
            params![now, file_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "File".to_string(),
                id: file_id.to_string(),
            });
        }

        // ★ CONC-02 修复：恢复 folder_items 中的关联记录
        let now_ms = chrono::Utc::now().timestamp_millis();
        let fi_updated = conn.execute(
            "UPDATE folder_items SET deleted_at = NULL, updated_at = ?1 WHERE item_type = 'file' AND item_id = ?2 AND deleted_at IS NOT NULL",
            params![now_ms, file_id],
        )?;

        info!(
            "[VFS::FileRepo] Restored file: {} (folder_items updated: {})",
            file_id, fi_updated
        );
        Ok(())
    }

    pub fn purge_file(db: &VfsDatabase, file_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::purge_file_with_conn(&conn, db.blobs_dir(), file_id)?;
        // ★ 2026-06-10（审阅问题 A2）：事务提交后清扫 ref_count=0 的 blob（两阶段删除的第二阶段）
        if let Err(e) = VfsBlobRepo::cleanup_unreferenced_with_conn(&conn, db.blobs_dir()) {
            warn!(
                "[VFS::FileRepo] Post-purge blob sweep failed (will retry on next sweep): {}",
                e
            );
        }
        Ok(())
    }

    /// 永久删除文件（带事务保护）
    ///
    /// ★ 2026-02-01 修复：递减 blob 引用计数，处理 PDF 预渲染页面 blob
    /// 使用事务确保所有删除操作的原子性，防止数据不一致
    pub fn purge_file_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        file_id: &str,
    ) -> VfsResult<()> {
        info!("[VFS::FileRepo] Purging file: {}", file_id);

        // 先获取文件信息，确认存在（在事务外检查，减少事务持有时间）
        let file = match Self::get_file_with_conn(conn, file_id)? {
            Some(f) => {
                debug!(
                    "[VFS::FileRepo] Found file: id={}, name={}, blob_hash={:?}",
                    f.id, f.file_name, f.blob_hash
                );
                f
            }
            None => {
                // ★ 文件在 files 表中不存在，但可能在 folder_items 中有记录
                // 尝试删除 folder_items 中的记录（兼容旧数据）
                warn!(
                    "[VFS::FileRepo] File not found in files table: {}, trying folder_items cleanup",
                    file_id
                );
                let fi_deleted = conn.execute(
                    "DELETE FROM folder_items WHERE item_id = ?1",
                    params![file_id],
                )?;
                if fi_deleted > 0 {
                    info!(
                        "[VFS::FileRepo] Deleted {} orphan folder_items for: {}",
                        fi_deleted, file_id
                    );
                    return Ok(());
                }
                return Err(VfsError::NotFound {
                    resource_type: "File".to_string(),
                    id: file_id.to_string(),
                });
            }
        };

        // 保存 resource_id 以便稍后删除
        let resource_id_to_delete = file.resource_id.clone();

        // ★ 使用 SAVEPOINT 包装所有删除操作，确保原子性
        // ★ 2026-06-10 修复（审阅问题 A2 关联）：改 BEGIN IMMEDIATE 为 SAVEPOINT。
        // 本函数会被 folder_repo::purge_folder_tree_resources_with_conn 在外层
        // SAVEPOINT 事务内嵌套调用，BEGIN 会报 "cannot start a transaction within
        // a transaction" 导致含文件的文件夹永远无法清空。SAVEPOINT 可安全嵌套。
        conn.execute_batch("SAVEPOINT vfs_file_purge_tx")
            .map_err(|e| {
                error!("[VFS::FileRepo] Failed to begin savepoint for purge: {}", e);
                VfsError::Database(format!("Failed to begin savepoint: {}", e))
            })?;

        // 定义回滚宏
        macro_rules! rollback_on_error {
            ($result:expr, $msg:expr) => {
                match $result {
                    Ok(v) => v,
                    Err(e) => {
                        error!("[VFS::FileRepo] {}: {}", $msg, e);
                        let _ = conn.execute_batch(
                            "ROLLBACK TO SAVEPOINT vfs_file_purge_tx; RELEASE SAVEPOINT vfs_file_purge_tx;",
                        );
                        return Err(VfsError::Database(format!("{}: {}", $msg, e)));
                    }
                }
            };
        }

        // ★ 删除 folder_items 中的关联记录（必须先删除，否则前端仍会显示）
        let fi_deleted = rollback_on_error!(
            conn.execute(
                "DELETE FROM folder_items WHERE item_id = ?1",
                params![file_id]
            ),
            "Failed to delete folder_items"
        );
        info!(
            "[VFS::FileRepo] Deleted {} folder_items for file: {}",
            fi_deleted, file_id
        );

        // ★ P0修复：减少 blob 引用计数（文件的 blob_hash + PDF 预渲染页面的 blob_hash）
        // 必须在删除文件记录之前处理，因为需要读取 file 信息

        // 1. 处理文件自身的 blob_hash（大文件外部存储）
        if let Some(ref blob_hash) = file.blob_hash {
            match VfsBlobRepo::decrement_ref_with_conn(conn, blobs_dir, blob_hash) {
                Ok(new_count) => {
                    info!(
                        "[VFS::FileRepo] Decremented blob ref for file: {} -> {}",
                        blob_hash, new_count
                    );
                }
                Err(e) => {
                    // blob 不存在时仅警告，不阻止删除
                    warn!(
                        "[VFS::FileRepo] Failed to decrement blob ref {}: {}",
                        blob_hash, e
                    );
                }
            }
        }

        // 1.5 处理文件自身的压缩 blob（仅当与原始 blob 不同）
        if let Some(ref compressed_hash) = file.compressed_blob_hash {
            let is_same_as_original = file
                .blob_hash
                .as_ref()
                .map(|h| h == compressed_hash)
                .unwrap_or(false);
            if !is_same_as_original {
                match VfsBlobRepo::decrement_ref_with_conn(conn, blobs_dir, compressed_hash) {
                    Ok(new_count) => {
                        info!(
                            "[VFS::FileRepo] Decremented compressed blob ref for file: {} -> {}",
                            compressed_hash, new_count
                        );
                    }
                    Err(e) => {
                        warn!(
                            "[VFS::FileRepo] Failed to decrement compressed blob ref {}: {}",
                            compressed_hash, e
                        );
                    }
                }
            }
        }

        // 2. 处理 PDF 预渲染页面的 blob_hash
        if let Some(ref preview_json_str) = file.preview_json {
            if let Ok(preview) = serde_json::from_str::<PdfPreviewJson>(preview_json_str) {
                for page in &preview.pages {
                    match VfsBlobRepo::decrement_ref_with_conn(conn, blobs_dir, &page.blob_hash) {
                        Ok(new_count) => {
                            debug!(
                                "[VFS::FileRepo] Decremented PDF page blob ref: page={}, hash={} -> {}",
                                page.page_index, page.blob_hash, new_count
                            );
                        }
                        Err(e) => {
                            // 页面 blob 不存在时仅警告
                            warn!(
                                "[VFS::FileRepo] Failed to decrement PDF page blob {}: {}",
                                page.blob_hash, e
                            );
                        }
                    }

                    // 同时处理压缩后的页面 blob（仅当与原始 blob 不同）
                    if let Some(ref compressed_hash) = page.compressed_blob_hash {
                        if compressed_hash != &page.blob_hash {
                            match VfsBlobRepo::decrement_ref_with_conn(
                                conn,
                                blobs_dir,
                                compressed_hash,
                            ) {
                                Ok(new_count) => {
                                    debug!(
                                        "[VFS::FileRepo] Decremented PDF compressed page blob ref: page={}, hash={} -> {}",
                                        page.page_index, compressed_hash, new_count
                                    );
                                }
                                Err(e) => {
                                    warn!(
                                        "[VFS::FileRepo] Failed to decrement PDF compressed page blob {}: {}",
                                        compressed_hash, e
                                    );
                                }
                            }
                        }
                    }
                }
                info!(
                    "[VFS::FileRepo] Processed {} PDF preview page blobs for file: {}",
                    preview.pages.len(),
                    file_id
                );
            }
        }

        // ★ 删除文件记录
        info!(
            "[VFS::FileRepo] Executing DELETE FROM files WHERE id = {}",
            file_id
        );
        let deleted = rollback_on_error!(
            conn.execute("DELETE FROM files WHERE id = ?1", params![file_id]),
            "Failed to delete file"
        );

        if deleted == 0 {
            // ★ 如果没有删除任何记录，回滚并返回错误
            error!(
                "[VFS::FileRepo] CRITICAL: File record disappeared during deletion: {}",
                file_id
            );
            let _ = conn.execute_batch(
                "ROLLBACK TO SAVEPOINT vfs_file_purge_tx; RELEASE SAVEPOINT vfs_file_purge_tx;",
            );
            return Err(VfsError::Other(format!(
                "File record disappeared during deletion: {}. This may indicate a race condition.",
                file_id
            )));
        }

        info!(
            "[VFS::FileRepo] Successfully deleted file record: {} (deleted {} record(s))",
            file_id, deleted
        );

        // ★ 最后删除关联的 resource
        if let Some(resource_id) = resource_id_to_delete {
            info!(
                "[VFS::FileRepo] Deleting associated resource: {}",
                resource_id
            );
            // ★ 2026-06-12（第二轮审阅）：清理索引产物（units/segments/Lance 向量入列）
            rollback_on_error!(
                super::index_unit_repo::purge_index_artifacts_by_resource(conn, &resource_id),
                "Failed to delete index artifacts"
            );
            let res_deleted = rollback_on_error!(
                conn.execute("DELETE FROM resources WHERE id = ?1", params![&resource_id]),
                "Failed to delete resource"
            );
            info!(
                "[VFS::FileRepo] Deleted {} resources for file: {}",
                res_deleted, file_id
            );
        }

        // ★ 提交（释放保存点；若存在外层事务则随外层一起提交）
        conn.execute_batch("RELEASE SAVEPOINT vfs_file_purge_tx")
            .map_err(|e| {
                error!("[VFS::FileRepo] Failed to release purge savepoint: {}", e);
                let _ = conn.execute_batch(
                    "ROLLBACK TO SAVEPOINT vfs_file_purge_tx; RELEASE SAVEPOINT vfs_file_purge_tx;",
                );
                VfsError::Database(format!("Failed to release savepoint: {}", e))
            })?;

        info!(
            "[VFS::FileRepo] Successfully completed file deletion: {}",
            file_id
        );

        Ok(())
    }

    pub fn list_deleted_files(
        db: &VfsDatabase,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsFile>> {
        let conn = db.get_conn_safe()?;
        Self::list_deleted_files_with_conn(&conn, limit, offset)
    }

    pub fn list_deleted_files_with_conn(
        conn: &Connection,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsFile>> {
        let sql = r#"
            SELECT id, resource_id, blob_hash, sha256, file_name, original_path, size, page_count,
                   "type", mime_type, tags_json, is_favorite, last_opened_at, last_page, bookmarks_json,
                   cover_key, extracted_text, preview_json, ocr_pages_json, description,
                   status, created_at, updated_at, deleted_at,
                   processing_status, processing_progress, processing_error,
                   processing_started_at, processing_completed_at,
                   compressed_blob_hash
            FROM files
            WHERE status = 'deleted'
            ORDER BY deleted_at DESC
            LIMIT ?1 OFFSET ?2
        "#;

        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![limit, offset], Self::row_to_file)?;
        let files: Vec<VfsFile> = rows.filter_map(log_and_skip_err).collect();
        Ok(files)
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    fn row_to_file(row: &rusqlite::Row) -> rusqlite::Result<VfsFile> {
        let tags_json: Option<String> = row.get(10)?;
        let bookmarks_json: Option<String> = row.get(14)?;

        let tags: Vec<String> = tags_json
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let bookmarks: Vec<Value> = bookmarks_json
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        Ok(VfsFile {
            id: row.get(0)?,
            resource_id: row.get(1)?,
            blob_hash: row.get(2)?,
            sha256: row.get(3)?,
            file_name: row.get(4)?,
            original_path: row.get(5)?,
            size: row.get(6)?,
            page_count: row.get(7)?,
            file_type: row.get(8)?,
            mime_type: row.get(9)?,
            tags,
            is_favorite: row.get::<_, i32>(11)? != 0,
            last_opened_at: row.get(12)?,
            last_page: row.get(13)?,
            bookmarks,
            cover_key: row.get(15)?,
            extracted_text: row.get(16)?,
            preview_json: row.get(17)?,
            ocr_pages_json: row.get(18)?,
            description: row.get(19)?,
            status: row.get(20)?,
            created_at: row.get(21)?,
            updated_at: row.get(22)?,
            deleted_at: row.get(23)?,
            // PDF 预处理流水线字段（迁移 V20260204）
            processing_status: row.get(24)?,
            processing_progress: row.get(25)?,
            processing_error: row.get(26)?,
            processing_started_at: row.get(27)?,
            processing_completed_at: row.get(28)?,
            // ★ P0 架构改造：压缩图片字段
            compressed_blob_hash: row.get(29)?,
        })
    }

    // ========================================================================
    // 获取文件内容
    // ========================================================================

    pub fn get_content(db: &VfsDatabase, file_id: &str) -> VfsResult<Option<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_content_with_conn(&conn, db.blobs_dir(), file_id)
    }

    pub fn get_content_with_conn(
        conn: &Connection,
        blobs_dir: &std::path::Path,
        file_id: &str,
    ) -> VfsResult<Option<String>> {
        use crate::vfs::repos::blob_repo::VfsBlobRepo;
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;

        tracing::info!(
            "[PDF_DEBUG] VfsFileRepo::get_content_with_conn: file_id={}",
            file_id
        );

        let file = match Self::get_file_with_conn(conn, file_id)? {
            Some(f) => f,
            None => {
                tracing::info!(
                    "[PDF_DEBUG] VfsFileRepo: file not found in files table, file_id={}",
                    file_id
                );
                return Ok(None);
            }
        };

        tracing::info!("[PDF_DEBUG] VfsFileRepo: file found, resource_id={:?}, blob_hash={:?}, original_path={:?}, compressed_blob_hash={:?}",
                       file.resource_id, file.blob_hash, file.original_path, file.compressed_blob_hash);

        // ★ P0 架构改造：图片类型优先读取压缩版本
        // 如果文件类型是 image 且有 compressed_blob_hash，优先使用压缩版本
        if file.file_type == "image" {
            if let Some(compressed_hash) = &file.compressed_blob_hash {
                tracing::info!(
                    "[PDF_DEBUG] VfsFileRepo: Image type - trying compressed_blob_hash={}",
                    compressed_hash
                );
                if let Some(blob_path) =
                    VfsBlobRepo::get_blob_path_with_conn(conn, blobs_dir, compressed_hash)?
                {
                    let data = std::fs::read(&blob_path).map_err(|e| {
                        VfsError::Io(format!("Failed to read compressed blob file: {}", e))
                    })?;
                    tracing::info!(
                        "[PDF_DEBUG] VfsFileRepo: Image compressed blob read success, raw_len={}",
                        data.len()
                    );
                    return Ok(Some(STANDARD.encode(data)));
                } else {
                    tracing::warn!(
                        "[PDF_DEBUG] VfsFileRepo: Compressed blob not found for image {}: {}",
                        file_id,
                        compressed_hash
                    );
                    // 回退到原始版本
                }
            }
        }

        if let Some(resource_id) = &file.resource_id {
            tracing::info!(
                "[PDF_DEBUG] VfsFileRepo: trying resources table with resource_id={}",
                resource_id
            );
            // ★ 2026-01-30 修复：显式指定 Option<String> 类型，确保正确处理 NULL 值
            let data: Option<String> = conn
                .query_row(
                    "SELECT data FROM resources WHERE id = ?1",
                    params![resource_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten();
            tracing::info!(
                "[PDF_DEBUG] VfsFileRepo: resources table result, has_data={}, data_len={}",
                data.is_some(),
                data.as_ref().map(|d| d.len()).unwrap_or(0)
            );

            // ★ 修复：如果 resources.data 为空，回退到 original_path 或 blob_hash
            if let Some(ref d) = data {
                if !d.is_empty() {
                    return Ok(data);
                }
                tracing::info!("[PDF_DEBUG] VfsFileRepo: resources.data is empty, falling back to original_path/blob_hash");
            }
            // 继续尝试其他方式
        }

        if let Some(blob_hash) = &file.blob_hash {
            tracing::info!(
                "[PDF_DEBUG] VfsFileRepo: trying blob with blob_hash={}",
                blob_hash
            );
            if let Some(blob_path) =
                VfsBlobRepo::get_blob_path_with_conn(conn, blobs_dir, blob_hash)?
            {
                tracing::info!("[PDF_DEBUG] VfsFileRepo: blob_path={:?}", blob_path);
                let data = std::fs::read(&blob_path)
                    .map_err(|e| VfsError::Io(format!("Failed to read blob file: {}", e)))?;
                tracing::info!(
                    "[PDF_DEBUG] VfsFileRepo: blob read success, raw_len={}",
                    data.len()
                );
                return Ok(Some(STANDARD.encode(data)));
            } else {
                tracing::warn!(
                    "[PDF_DEBUG] VfsFileRepo: Blob not found for file {}: {}",
                    file_id,
                    blob_hash
                );
                // 继续尝试 original_path
            }
        }

        // ★ 修复：尝试从 original_path 读取文件
        if let Some(original_path) = &file.original_path {
            tracing::info!(
                "[PDF_DEBUG] VfsFileRepo: trying original_path={}",
                original_path
            );
            // content:// 等虚拟 URI 无法通过 std::fs 读取（需要 Tauri Window 上下文）
            if crate::unified_file_manager::is_virtual_uri(original_path) {
                tracing::warn!(
                    "[PDF_DEBUG] VfsFileRepo: original_path is a virtual URI, skipping std::fs read: {}",
                    original_path
                );
            } else {
                let path = std::path::Path::new(original_path);
                if path.exists() {
                    match std::fs::read(path) {
                        Ok(data) => {
                            tracing::info!(
                                "[PDF_DEBUG] VfsFileRepo: original_path read success, raw_len={}",
                                data.len()
                            );
                            return Ok(Some(STANDARD.encode(data)));
                        }
                        Err(e) => {
                            tracing::warn!(
                                "[PDF_DEBUG] VfsFileRepo: Failed to read original_path: {}",
                                e
                            );
                        }
                    }
                } else {
                    tracing::warn!(
                        "[PDF_DEBUG] VfsFileRepo: original_path does not exist: {}",
                        original_path
                    );
                }
            }
        }

        tracing::warn!(
            "[PDF_DEBUG] VfsFileRepo: File {} has no valid content source (resource_id empty, no blob_hash, original_path not accessible)",
            file_id
        );
        Ok(None)
    }

    // ========================================================================
    // OCR 和索引状态管理
    // ========================================================================

    pub fn get_ocr_pages(db: &VfsDatabase, file_id: &str) -> VfsResult<Vec<Option<String>>> {
        let conn = db.get_conn_safe()?;
        Self::get_ocr_pages_with_conn(&conn, file_id)
    }

    pub fn get_ocr_pages_with_conn(
        conn: &Connection,
        file_id: &str,
    ) -> VfsResult<Vec<Option<String>>> {
        let ocr_json: Option<String> = conn
            .query_row(
                "SELECT ocr_pages_json FROM files WHERE id = ?1",
                params![file_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();

        match ocr_json {
            Some(json) => Ok(parse_ocr_pages_json(&json)),
            None => Ok(vec![]),
        }
    }

    pub fn get_page_ocr(
        db: &VfsDatabase,
        file_id: &str,
        page_index: usize,
    ) -> VfsResult<Option<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_page_ocr_with_conn(&conn, file_id, page_index)
    }

    pub fn get_page_ocr_with_conn(
        conn: &Connection,
        file_id: &str,
        page_index: usize,
    ) -> VfsResult<Option<String>> {
        let pages = Self::get_ocr_pages_with_conn(conn, file_id)?;
        Ok(pages.get(page_index).cloned().flatten())
    }

    pub fn save_page_ocr(
        db: &VfsDatabase,
        file_id: &str,
        page_index: usize,
        ocr_text: &str,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::save_page_ocr_with_conn(&conn, file_id, page_index, ocr_text)
    }

    pub fn save_page_ocr_with_conn(
        conn: &Connection,
        file_id: &str,
        page_index: usize,
        ocr_text: &str,
    ) -> VfsResult<()> {
        let mut pages = Self::get_ocr_pages_with_conn(conn, file_id)?;

        while pages.len() <= page_index {
            pages.push(None);
        }
        pages[page_index] = Some(ocr_text.to_string());

        let json = serde_json::to_string(&pages)
            .map_err(|e| VfsError::Database(format!("Failed to serialize OCR pages: {}", e)))?;

        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        conn.execute(
            "UPDATE files SET ocr_pages_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![json, now, file_id],
        )?;

        Ok(())
    }

    pub fn purge_deleted_files(db: &VfsDatabase) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        let count = Self::purge_deleted_files_with_conn(&conn, db.blobs_dir())?;
        // ★ 2026-06-10（审阅问题 A2）：批量 purge 完成后统一清扫 ref_count=0 的 blob
        if let Err(e) = VfsBlobRepo::cleanup_unreferenced_with_conn(&conn, db.blobs_dir()) {
            warn!(
                "[VFS::FileRepo] Post-batch-purge blob sweep failed (will retry on next sweep): {}",
                e
            );
        }
        Ok(count)
    }

    pub fn purge_deleted_files_with_conn(conn: &Connection, blobs_dir: &Path) -> VfsResult<usize> {
        let file_ids: Vec<String> = conn
            .prepare("SELECT id FROM files WHERE status = 'deleted'")?
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;

        let count = file_ids.len();

        for file_id in &file_ids {
            if let Err(e) = Self::purge_file_with_conn(conn, blobs_dir, file_id) {
                warn!(
                    "[VFS::FileRepo] Failed to purge deleted file {}: {}",
                    file_id, e
                );
            }
        }

        info!("[VFS::FileRepo] Purged {} deleted files", count);
        Ok(count)
    }

    pub fn file_exists(db: &VfsDatabase, file_id: &str) -> VfsResult<bool> {
        let conn = db.get_conn_safe()?;
        Self::file_exists_with_conn(&conn, file_id)
    }

    pub fn file_exists_with_conn(conn: &Connection, file_id: &str) -> VfsResult<bool> {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM files WHERE id = ?1)",
            params![file_id],
            |row| row.get(0),
        )?;
        Ok(exists)
    }

    // ========================================================================
    // ★ M-12 修复：获取文件的 resource_id（用于删除向量索引）
    // ========================================================================

    /// 获取文件的 resource_id
    ///
    /// 在软删除前调用此方法获取 resource_id，然后用于删除 LanceDB 向量索引。
    ///
    /// ## 使用示例
    /// ```ignore
    /// // 1. 获取 resource_id
    /// let resource_id = VfsFileRepo::get_resource_id_by_file_id(&db, &file_id)?;
    /// // 2. 删除向量索引（如果存在）
    /// if let Some(rid) = resource_id {
    ///     index_service.delete_resource_index_full(&rid, &lance_store).await?;
    /// }
    /// // 3. 执行软删除
    /// VfsFileRepo::delete_file(&db, &file_id)?;
    /// ```
    pub fn get_resource_id_by_file_id(
        db: &VfsDatabase,
        file_id: &str,
    ) -> VfsResult<Option<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_resource_id_by_file_id_with_conn(&conn, file_id)
    }

    pub fn get_resource_id_by_file_id_with_conn(
        conn: &Connection,
        file_id: &str,
    ) -> VfsResult<Option<String>> {
        let resource_id: Option<String> = conn
            .query_row(
                "SELECT resource_id FROM files WHERE id = ?1",
                params![file_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        Ok(resource_id)
    }

    /// 软删除文件并清理向量索引
    ///
    /// ★ M-12 修复：软删除时同步删除 LanceDB 向量索引，确保已删除资源不会在 RAG 检索中返回。
    ///
    /// ## 数据一致性保证
    /// 1. 先删除向量索引（允许失败，仅记录警告）
    /// 2. 再执行软删除
    /// 3. 如果软删除失败，向量索引已被删除，但文件仍存在（可重新索引）
    pub async fn delete_file_with_index_cleanup(
        db: &VfsDatabase,
        file_id: &str,
        index_service: &crate::vfs::index_service::VfsIndexService,
        lance_store: &crate::vfs::lance_store::VfsLanceStore,
    ) -> VfsResult<()> {
        // 1. 获取 resource_id
        let resource_id = Self::get_resource_id_by_file_id(db, file_id)?;

        // 2. 删除向量索引（如果存在）
        if let Some(ref rid) = resource_id {
            match index_service
                .delete_resource_index_full(rid, lance_store)
                .await
            {
                Ok(result) => {
                    if result.deleted_unit_count > 0 || !result.lance_row_ids.is_empty() {
                        tracing::info!(
                            "[VfsFileRepo] Cleaned up index for file {}: {} units, {} vectors",
                            file_id,
                            result.deleted_unit_count,
                            result.lance_row_ids.len()
                        );
                    }
                }
                Err(e) => {
                    // 索引删除失败不应阻止软删除，仅记录警告
                    tracing::warn!(
                        "[VfsFileRepo] Failed to cleanup index for file {} (resource {}): {}",
                        file_id,
                        rid,
                        e
                    );
                }
            }
        }

        // 3. 执行软删除
        Self::delete_file(db, file_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_test_db() -> (TempDir, VfsDatabase) {
        crate::vfs::database::setup_migrated_test_db()
    }

    #[test]
    fn test_create_file() {
        let (_temp_dir, db) = setup_test_db();

        let file = VfsFileRepo::create_file(
            &db,
            "sha256_hash_123",
            "document.pdf",
            1024000,
            "document",
            Some("application/pdf"),
            None,
            Some("/path/to/file.pdf"),
        )
        .expect("Create file should succeed");

        assert!(!file.id.is_empty());
        assert!(file.id.starts_with("file_"));
        assert_eq!(file.file_name, "document.pdf");
        assert_eq!(file.sha256, "sha256_hash_123");
        assert_eq!(file.file_type, "document");
        assert_eq!(file.status, "active");
    }

    #[test]
    fn test_file_dedup_by_sha256() {
        let (_temp_dir, db) = setup_test_db();

        let file1 = VfsFileRepo::create_file(
            &db,
            "sha256_same",
            "file1.pdf",
            1024,
            "document",
            None,
            None,
            None,
        )
        .expect("First create should succeed");

        let file2 = VfsFileRepo::create_file(
            &db,
            "sha256_same",
            "file2.pdf",
            2048,
            "document",
            None,
            None,
            None,
        )
        .expect("Second create should succeed");

        assert_eq!(file1.id, file2.id, "Should return same file");
    }

    #[test]
    fn test_list_files() {
        let (_temp_dir, db) = setup_test_db();

        VfsFileRepo::create_file(&db, "sha1", "file1.pdf", 1024, "document", None, None, None)
            .unwrap();
        VfsFileRepo::create_file(
            &db,
            "sha2",
            "image.png",
            1024,
            "image",
            Some("image/png"),
            None,
            None,
        )
        .unwrap();
        VfsFileRepo::create_file(
            &db,
            "sha3",
            "audio.mp3",
            1024,
            "audio",
            Some("audio/mpeg"),
            None,
            None,
        )
        .unwrap();

        let all = VfsFileRepo::list_files(&db, 10, 0).expect("List should succeed");
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn test_list_files_by_type() {
        let (_temp_dir, db) = setup_test_db();

        VfsFileRepo::create_file(&db, "sha1", "doc1.pdf", 1024, "document", None, None, None)
            .unwrap();
        VfsFileRepo::create_file(&db, "sha2", "doc2.pdf", 1024, "document", None, None, None)
            .unwrap();
        VfsFileRepo::create_file(
            &db,
            "sha3",
            "image.png",
            1024,
            "image",
            Some("image/png"),
            None,
            None,
        )
        .unwrap();

        let docs =
            VfsFileRepo::list_files_by_type(&db, "document", 10, 0).expect("List should succeed");
        assert_eq!(docs.len(), 2);

        let images =
            VfsFileRepo::list_files_by_type(&db, "image", 10, 0).expect("List should succeed");
        assert_eq!(images.len(), 1);
    }

    #[test]
    fn test_soft_delete_and_restore() {
        let (_temp_dir, db) = setup_test_db();

        let file = VfsFileRepo::create_file(
            &db,
            "sha256_123",
            "test.pdf",
            1024,
            "document",
            None,
            None,
            None,
        )
        .expect("Create should succeed");

        VfsFileRepo::delete_file(&db, &file.id).expect("Delete should succeed");

        let deleted = VfsFileRepo::get_file(&db, &file.id)
            .expect("Get should succeed")
            .expect("File should exist");
        assert_eq!(deleted.status, "deleted");

        VfsFileRepo::restore_file(&db, &file.id).expect("Restore should succeed");

        let restored = VfsFileRepo::get_file(&db, &file.id)
            .expect("Get should succeed")
            .expect("File should exist");
        assert_eq!(restored.status, "active");
    }

    // ★ 2026-06-12（第二轮审阅）回归测试：copy_file 必须共享 blob 并正确递增引用计数

    fn blob_ref(db: &VfsDatabase, hash: &str) -> Option<i32> {
        let conn = db.get_conn_safe().unwrap();
        conn.query_row(
            "SELECT ref_count FROM blobs WHERE hash = ?1",
            rusqlite::params![hash],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
    }

    #[test]
    fn test_copy_file_shares_blobs_and_survives_source_purge() {
        use crate::vfs::repos::blob_repo::VfsBlobRepo;

        let (_tmp, db) = setup_test_db();

        // 1. 准备主 blob、压缩 blob、页图 blob、页图压缩 blob（store_blob 初始 ref=1）
        let main_blob =
            VfsBlobRepo::store_blob(&db, b"copy-file-main", Some("application/pdf"), Some("pdf"))
                .unwrap();
        let compressed_blob = VfsBlobRepo::store_blob(
            &db,
            b"copy-file-compressed",
            Some("image/webp"),
            Some("webp"),
        )
        .unwrap();
        let page_blob =
            VfsBlobRepo::store_blob(&db, b"copy-file-page", Some("image/jpeg"), Some("jpg"))
                .unwrap();
        let page_compressed =
            VfsBlobRepo::store_blob(&db, b"copy-file-page-c", Some("image/webp"), Some("webp"))
                .unwrap();

        // 2. 创建源文件并补充 preview/压缩/OCR 元数据
        let src = VfsFileRepo::create_file(
            &db,
            "sha_copy_src",
            "source.pdf",
            4096,
            "document",
            Some("application/pdf"),
            Some(&main_blob.hash),
            None,
        )
        .unwrap();
        let preview_json = serde_json::json!({
            "pages": [{
                "pageIndex": 0,
                "blobHash": page_blob.hash,
                "width": 100,
                "height": 100,
                "mimeType": "image/jpeg",
                "compressedBlobHash": page_compressed.hash,
            }],
            "renderDpi": 144,
            "totalPages": 1,
            "renderedAt": "2026-06-12T00:00:00Z",
        })
        .to_string();
        {
            let conn = db.get_conn_safe().unwrap();
            conn.execute(
                "UPDATE files SET preview_json = ?1, compressed_blob_hash = ?2,
                        extracted_text = 'hello text', ocr_pages_json = '[]' WHERE id = ?3",
                rusqlite::params![preview_json, compressed_blob.hash, src.id],
            )
            .unwrap();
        }

        // 3. 复制 → 所有共享 blob 引用计数应为 2
        let copy = {
            let conn = db.get_conn_safe().unwrap();
            VfsFileRepo::copy_file_with_conn(&conn, &src.id, "source (副本).pdf").unwrap()
        };
        assert_ne!(copy.id, src.id);
        assert_ne!(copy.sha256, src.sha256, "副本必须有独立 sha256");
        assert_eq!(copy.blob_hash.as_deref(), Some(main_blob.hash.as_str()));
        assert_eq!(
            copy.compressed_blob_hash.as_deref(),
            Some(compressed_blob.hash.as_str())
        );
        assert_eq!(copy.extracted_text.as_deref(), Some("hello text"));
        assert!(
            copy.preview_json
                .as_deref()
                .unwrap_or("")
                .contains(&page_blob.hash),
            "副本必须继承 preview_json"
        );
        for (label, hash) in [
            ("main", &main_blob.hash),
            ("compressed", &compressed_blob.hash),
            ("page", &page_blob.hash),
            ("page_compressed", &page_compressed.hash),
        ] {
            assert_eq!(
                blob_ref(&db, hash),
                Some(2),
                "{} blob 复制后引用计数必须为 2",
                label
            );
        }

        // 4. purge 源文件 → 副本仍然完整，blob 引用计数回到 1
        VfsFileRepo::purge_file(&db, &src.id).unwrap();
        assert!(VfsFileRepo::get_file(&db, &copy.id).unwrap().is_some());
        for (label, hash) in [
            ("main", &main_blob.hash),
            ("compressed", &compressed_blob.hash),
            ("page", &page_blob.hash),
            ("page_compressed", &page_compressed.hash),
        ] {
            assert_eq!(
                blob_ref(&db, hash),
                Some(1),
                "{} blob 在源 purge 后引用计数必须为 1（副本仍持有）",
                label
            );
        }

        // 5. purge 副本 → 引用计数归零（blob 行被清扫或 ref=0）
        VfsFileRepo::purge_file(&db, &copy.id).unwrap();
        for (label, hash) in [
            ("main", &main_blob.hash),
            ("compressed", &compressed_blob.hash),
            ("page", &page_blob.hash),
            ("page_compressed", &page_compressed.hash),
        ] {
            let rc = blob_ref(&db, hash);
            assert!(
                rc.is_none() || rc == Some(0),
                "{} blob 在副本 purge 后必须归零，got {:?}",
                label,
                rc
            );
        }
    }
}
