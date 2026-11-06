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

use base64::Engine as _;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::path::{Path, PathBuf};
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
use crate::vfs::file_reclassify::{
    detect_file_identity, mime_is_generic, read_bounded_header, resolve_file_identity,
    sha256_matches_blob_pointer, structure_tail_bytes, validate_detected_structure,
    validate_detected_structure_bytes, validate_png_structure_bytes, verify_file_sha256,
    DetectedFileIdentity, FileReclassifyStatus,
};
use crate::vfs::ocr_utils::parse_ocr_pages_json;
use crate::vfs::repos::blob_repo::{acquire_blob_mutation_guard, BlobMutationGuard, VfsBlobRepo};
use crate::vfs::repos::folder_repo::VfsFolderRepo;
use crate::vfs::types::{PdfPreviewJson, VfsFile, VfsFolderItem};

/// A3 重识别结果：状态 + 当前文件记录（缺失时无记录）。
#[derive(Debug, Clone)]
pub struct FileReclassifyOutcome {
    pub status: FileReclassifyStatus,
    pub file: Option<VfsFile>,
}

/// A3 verified folder 创建结果：created=false 表示命中去重旧条目，
/// 调用方应补偿本次 store_blob 的引用计数。
#[derive(Debug, Clone)]
pub struct VerifiedFileFolderOutcome {
    pub file: VfsFile,
    pub created: bool,
}

/// inline 文件内容上限：与附件存储的 `INLINE_SIZE_THRESHOLD`（1 MiB）一致。
const MAX_INLINE_FILE_BYTES: usize = 1024 * 1024;

/// inline `resources.data`（base64）允许读取的最大字符串长度。
const MAX_INLINE_BASE64_LEN: i64 = ((MAX_INLINE_FILE_BYTES + 2) / 3 * 4) as i64;

/// 资源镜像中需要同步的 type/metadata 字段及其旧值快照。
#[derive(Debug)]
struct ResourceMirrorPlan {
    resource_id: String,
    old_type: String,
    old_metadata_json: Option<String>,
    new_type: String,
    new_metadata_json: Option<String>,
}

/// 文件类别/资源镜像的同步计划；只有全部一致时才允许零写入。
#[derive(Debug)]
struct MetadataSyncPlan {
    file_id: String,
    target_mime: String,
    target_file_type: String,
    folder_changed: bool,
    resource_mirror: Option<ResourceMirrorPlan>,
}

/// 只更新 metadata_json 的 `mimeType`，保留其余所有字段（含 name/size/自定义键）。
///
/// 返回 `None` 仅表示无法安全改写（metadata 不是 JSON object），调用方应保留原值。
fn merge_resource_metadata_mime(raw: Option<&str>, target_mime: &str) -> Option<String> {
    match raw {
        Some(text) if !text.trim().is_empty() => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(mut map)) => {
                let target = Value::String(target_mime.to_string());
                if map.get("mimeType") == Some(&target) {
                    return Some(text.to_string());
                }
                map.insert("mimeType".to_string(), target);
                Some(Value::Object(map).to_string())
            }
            _ => None,
        },
        _ => Some(serde_json::json!({ "mimeType": target_mime }).to_string()),
    }
}

/// 计算 resources 镜像是否落后于文件记录，不写库。
fn plan_resource_mirror_with_conn(
    conn: &Connection,
    file: &VfsFile,
    target_mime: &str,
    target_file_type: &str,
) -> VfsResult<Option<ResourceMirrorPlan>> {
    let Some(resource_id) = file.resource_id.as_deref() else {
        return Ok(None);
    };
    let row: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT type, metadata_json FROM resources WHERE id = ?1",
            params![resource_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((old_type, old_metadata_json)) = row else {
        return Ok(None);
    };

    let desired_type = if target_file_type == "image" {
        "image"
    } else {
        "file"
    };
    // 只纠正 file/image 资源；其他资源类型不越权改写。
    let new_type =
        if old_type.eq_ignore_ascii_case("file") || old_type.eq_ignore_ascii_case("image") {
            desired_type.to_string()
        } else {
            old_type.clone()
        };
    let new_metadata_json = merge_resource_metadata_mime(old_metadata_json.as_deref(), target_mime)
        .or_else(|| old_metadata_json.clone());

    if old_type == new_type && old_metadata_json == new_metadata_json {
        return Ok(None);
    }
    Ok(Some(ResourceMirrorPlan {
        resource_id: resource_id.to_string(),
        old_type,
        old_metadata_json,
        new_type,
        new_metadata_json,
    }))
}

fn plan_metadata_sync_with_conn(
    conn: &Connection,
    existing: &VfsFile,
    target_mime: &str,
    target_file_type: &str,
) -> VfsResult<MetadataSyncPlan> {
    let folder_item_type = if target_file_type == "image" {
        "image"
    } else {
        "file"
    };
    let folder_changed: i64 = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM folder_items WHERE item_id = ?1 AND item_type IN ('file', 'image') AND item_type != ?2)",
        params![existing.id, folder_item_type],
        |row| row.get(0),
    )?;
    let resource_mirror =
        plan_resource_mirror_with_conn(conn, existing, target_mime, target_file_type)?;
    Ok(MetadataSyncPlan {
        file_id: existing.id.clone(),
        target_mime: target_mime.to_string(),
        target_file_type: target_file_type.to_string(),
        folder_changed: folder_changed != 0,
        resource_mirror,
    })
}

fn metadata_sync_is_consistent(existing: &VfsFile, plan: &MetadataSyncPlan) -> bool {
    existing.mime_type.as_deref() == Some(plan.target_mime.as_str())
        && existing.file_type == plan.target_file_type
        && !plan.folder_changed
        && plan.resource_mirror.is_none()
}

/// 在调用方 SAVEPOINT 内同步 folder_items 与 resources 镜像；files 行由调用方
/// 用自己的 CAS 更新。任一镜像 CAS 失败即返回错误，由调用方整体回滚。
fn apply_metadata_sync_plan(
    conn: &Connection,
    plan: &MetadataSyncPlan,
    now_ms: i64,
) -> VfsResult<()> {
    if plan.folder_changed {
        let folder_item_type = if plan.target_file_type == "image" {
            "image"
        } else {
            "file"
        };
        conn.execute(
            "UPDATE folder_items SET item_type = ?1, updated_at = ?2 WHERE item_id = ?3 AND item_type IN ('file', 'image')",
            params![folder_item_type, now_ms, plan.file_id],
        )?;
    }
    if let Some(mirror) = &plan.resource_mirror {
        let updated = conn.execute(
            r#"UPDATE resources SET type = ?1, metadata_json = ?2, updated_at = ?3
               WHERE id = ?4 AND type = ?5 AND metadata_json IS ?6"#,
            params![
                mirror.new_type,
                mirror.new_metadata_json,
                now_ms,
                mirror.resource_id,
                mirror.old_type,
                mirror.old_metadata_json,
            ],
        )?;
        if updated == 0 {
            warn!(
                "[VFS::FileRepo] Resource mirror CAS lost for {}; state changed concurrently",
                mirror.resource_id
            );
            return Err(VfsError::Conflict {
                key: "resources.mirror_conflict".to_string(),
                message: format!(
                    "Resource {} mirror changed concurrently",
                    mirror.resource_id
                ),
            });
        }
    }
    Ok(())
}

/// 去重命中旧条目时，用**已验证字节**识别出的可靠 MIME 回填类型。
///
/// 仅供上传入口/重识别等持有真实 bytes 的路径调用；普通 `create_file` 的
/// 字符串 MIME 不可信，不在这里升级。所有写入放在嵌套安全 SAVEPOINT 内并用
/// CAS 限定旧状态，失败不产生部分修改。
fn upgrade_deduped_file_metadata_from_verified_mime(
    conn: &Connection,
    existing: VfsFile,
    caller_mime: Option<&str>,
    detected: Option<&DetectedFileIdentity>,
) -> VfsResult<VfsFile> {
    let Some(detected) = detected else {
        return Ok(existing);
    };

    // Canonical Ink 文档的 MIME/类别由 ink 命令维护，内容检测不得覆盖。
    if super::ink_repo::VfsInkRepo::is_ink_file_candidate_with_conn(conn, &existing.id)? {
        return Err(VfsError::InvalidOperation {
            operation: "upgrade_verified_ink_file".to_string(),
            reason: "Ink documents must be changed through ink commands".to_string(),
        });
    }

    // 共享纠正规则：强内容优先；弱文本不覆盖具体 MIME；generic 可按名称映射。
    let resolved = resolve_file_identity(
        existing.mime_type.as_deref().or(caller_mime),
        &existing.file_type,
        &existing.file_name,
        Some(detected),
    );
    let existing_generic = mime_is_generic(existing.mime_type.as_deref());
    let target_mime = if resolved.strong || existing_generic {
        resolved.mime_type.clone()
    } else {
        existing
            .mime_type
            .clone()
            .unwrap_or_else(|| resolved.mime_type.clone())
    };
    let mime_upgraded = existing_generic && !mime_is_generic(Some(&target_mime));
    let target_file_type = if resolved.strong || mime_upgraded {
        resolved.file_type.clone()
    } else {
        existing.file_type.clone()
    };

    let plan = plan_metadata_sync_with_conn(conn, &existing, &target_mime, &target_file_type)?;
    if metadata_sync_is_consistent(&existing, &plan) {
        return Ok(existing);
    }

    conn.execute("SAVEPOINT upgrade_deduped_file_metadata", [])
        .map_err(|e| {
            error!(
                "[VFS::FileRepo] Failed to create savepoint for dedup upgrade: {}",
                e
            );
            VfsError::Database(format!("Failed to create savepoint: {}", e))
        })?;

    let result = (|| -> VfsResult<VfsFile> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let now_ms = chrono::Utc::now().timestamp_millis();
        let updated = conn.execute(
            r#"UPDATE files SET mime_type = ?1, "type" = ?2, updated_at = ?3
               WHERE id = ?4 AND mime_type IS ?5 AND "type" = ?6"#,
            params![
                plan.target_mime,
                plan.target_file_type,
                &now,
                existing.id,
                existing.mime_type.as_deref(),
                existing.file_type.as_str(),
            ],
        )?;
        if updated == 0 {
            return Ok(existing);
        }
        apply_metadata_sync_plan(conn, &plan, now_ms)?;
        info!(
            "[VFS::FileRepo] Upgraded deduped file metadata from verified content: {} (mime: {:?} -> {}, type: {} -> {})",
            existing.id, existing.mime_type, plan.target_mime, existing.file_type, plan.target_file_type
        );
        VfsFileRepo::get_file_with_conn(conn, &existing.id)?.ok_or_else(|| {
            VfsError::Database(format!("File {} not found after reclassify", existing.id))
        })
    })();

    match result {
        Ok(file) => {
            conn.execute("RELEASE upgrade_deduped_file_metadata", [])
                .map_err(|e| {
                    error!(
                        "[VFS::FileRepo] Failed to release dedup upgrade savepoint: {}",
                        e
                    );
                    VfsError::Database(format!("Failed to release savepoint: {}", e))
                })?;
            Ok(file)
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK TO upgrade_deduped_file_metadata", []);
            let _ = conn.execute("RELEASE upgrade_deduped_file_metadata", []);
            Err(e)
        }
    }
}

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

    /// A3: 校验 data ↔ sha/size/blob 元组；失败在任何写之前返回。
    fn validate_verified_bytes_tuple(
        conn: &Connection,
        sha256: &str,
        size: i64,
        blob_hash: Option<&str>,
        data: &[u8],
    ) -> VfsResult<()> {
        let actual_hash = VfsBlobRepo::compute_hash(data);
        if !actual_hash.eq_ignore_ascii_case(sha256) {
            return Err(VfsError::InvalidArgument {
                param: "data".to_string(),
                reason: "verified content bytes do not match sha256".to_string(),
            });
        }
        if size < 0 || size as usize != data.len() {
            return Err(VfsError::InvalidArgument {
                param: "size".to_string(),
                reason: "size does not match verified content bytes".to_string(),
            });
        }
        if let Some(blob_hash) = blob_hash {
            if !blob_hash.eq_ignore_ascii_case(sha256) {
                return Err(VfsError::InvalidArgument {
                    param: "blob_hash".to_string(),
                    reason: "blob hash does not match verified content hash".to_string(),
                });
            }
            let blob_size: Option<i64> = conn
                .query_row(
                    "SELECT size FROM blobs WHERE hash = ?1",
                    params![blob_hash],
                    |row| row.get(0),
                )
                .optional()?;
            match blob_size {
                Some(blob_size) if blob_size == size => {}
                Some(_) => {
                    return Err(VfsError::InvalidArgument {
                        param: "blob_hash".to_string(),
                        reason: "blob size does not match verified content size".to_string(),
                    })
                }
                None => {
                    return Err(VfsError::NotFound {
                        resource_type: "Blob".to_string(),
                        id: blob_hash.to_string(),
                    })
                }
            }
        }
        Ok(())
    }

    /// A3: 已验证 bytes 创建/复用文件；返回 created 以便调用方补偿 blob ref。
    fn create_file_from_verified_bytes_outcome(
        conn: &Connection,
        sha256: &str,
        file_name: &str,
        size: i64,
        file_type: &str,
        mime_type: Option<&str>,
        blob_hash: Option<&str>,
        original_path: Option<&str>,
        data: &[u8],
    ) -> VfsResult<(VfsFile, bool)> {
        Self::validate_verified_bytes_tuple(conn, sha256, size, blob_hash, data)?;
        conn.execute("SAVEPOINT create_verified_bytes", [])?;
        let result = (|| -> VfsResult<(VfsFile, bool)> {
            let created = Self::get_by_sha256_with_conn(conn, sha256)?.is_none();
            let detected = detect_file_identity(&data[..data.len().min(64 * 1024)]);
            // 共享纠正规则：强内容优先；弱文本不覆盖具体声明；generic 可按名称映射。
            let resolved =
                resolve_file_identity(mime_type, file_type, file_name, detected.as_ref());
            let file = Self::create_file_with_conn(
                conn,
                sha256,
                file_name,
                size,
                &resolved.file_type,
                Some(&resolved.mime_type),
                blob_hash,
                original_path,
            )?;
            let file = if detected.is_some() {
                upgrade_deduped_file_metadata_from_verified_mime(
                    conn,
                    file,
                    mime_type,
                    detected.as_ref(),
                )?
            } else {
                file
            };
            Ok((file, created))
        })();

        match result {
            Ok(outcome) => {
                conn.execute("RELEASE create_verified_bytes", [])?;
                Ok(outcome)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO create_verified_bytes", []);
                let _ = conn.execute("RELEASE create_verified_bytes", []);
                Err(e)
            }
        }
    }

    /// A3: 使用已验证的原始字节创建/复用文件记录。
    ///
    /// 与普通 `create_file` 的区别：调用方必须提供真实字节，且 data/sha/size/
    /// blob 元组必须一致。去重命中旧通用 MIME 条目时，用共享纠正规则回填。
    pub fn create_file_from_verified_bytes_with_conn(
        conn: &Connection,
        sha256: &str,
        file_name: &str,
        size: i64,
        file_type: &str,
        mime_type: Option<&str>,
        blob_hash: Option<&str>,
        original_path: Option<&str>,
        data: &[u8],
    ) -> VfsResult<VfsFile> {
        Self::create_file_from_verified_bytes_outcome(
            conn,
            sha256,
            file_name,
            size,
            file_type,
            mime_type,
            blob_hash,
            original_path,
            data,
        )
        .map(|(file, _created)| file)
    }

    /// A3: 用已验证的原始字节升级既有文件条目；bytes/hash/size/Ink 全部先校验。
    pub(crate) fn upgrade_existing_file_from_verified_bytes_with_conn(
        conn: &Connection,
        file_id: &str,
        data: &[u8],
    ) -> VfsResult<VfsFile> {
        let Some(existing) = Self::get_file_with_conn(conn, file_id)? else {
            return Err(VfsError::NotFound {
                resource_type: "File".to_string(),
                id: file_id.to_string(),
            });
        };
        let actual_hash = VfsBlobRepo::compute_hash(data);
        if !actual_hash.eq_ignore_ascii_case(&existing.sha256) {
            return Err(VfsError::InvalidArgument {
                param: "data".to_string(),
                reason: "verified content bytes do not match file sha256".to_string(),
            });
        }
        if existing.size < 0 || existing.size as usize != data.len() {
            return Err(VfsError::InvalidArgument {
                param: "size".to_string(),
                reason: "verified content size does not match file size".to_string(),
            });
        }
        if super::ink_repo::VfsInkRepo::is_ink_file_candidate_with_conn(conn, file_id)? {
            return Err(VfsError::InvalidOperation {
                operation: "upgrade_verified_ink_file".to_string(),
                reason: "Ink documents must be changed through ink commands".to_string(),
            });
        }
        let detected = detect_file_identity(&data[..data.len().min(64 * 1024)]);
        upgrade_deduped_file_metadata_from_verified_mime(conn, existing, None, detected.as_ref())
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

    /// A3: 用已验证 bytes 在文件夹内创建/复用文件，category 按最终内容类别落库。
    ///
    /// 只做纯内容检测与 SQL，不读取 blob、不获取 blob mutation guard；调用方
    /// 必须在进入本方法前用同一 effective MIME 写入 blob。SAVEPOINT 可安全
    /// 嵌套在已有事务内，失败时连同 files/resources/folder_items 一起回滚。
    #[allow(clippy::too_many_arguments)]
    pub fn create_file_in_folder_from_verified_bytes_with_conn(
        conn: &Connection,
        sha256: &str,
        file_name: &str,
        size: i64,
        file_type: &str,
        mime_type: Option<&str>,
        blob_hash: Option<&str>,
        original_path: Option<&str>,
        folder_id: Option<&str>,
        data: &[u8],
    ) -> VfsResult<VerifiedFileFolderOutcome> {
        conn.execute("SAVEPOINT create_verified_file_in_folder", [])?;
        let result = (|| -> VfsResult<VerifiedFileFolderOutcome> {
            if let Some(fid) = folder_id {
                if !VfsFolderRepo::folder_exists_with_conn(conn, fid)? {
                    return Err(VfsError::NotFound {
                        resource_type: "Folder".to_string(),
                        id: fid.to_string(),
                    });
                }
            }

            let (file, created) = Self::create_file_from_verified_bytes_outcome(
                conn,
                sha256,
                file_name,
                size,
                file_type,
                mime_type,
                blob_hash,
                original_path,
                data,
            )?;

            // 新 ID 若命中 Ink authority（.dsink / INK_MIME / preview ink），
            // 不得作为普通文件落库；整个 SAVEPOINT 回滚。
            if super::ink_repo::VfsInkRepo::is_ink_file_candidate_with_conn(conn, &file.id)? {
                return Err(VfsError::InvalidOperation {
                    operation: "create_verified_ink_file".to_string(),
                    reason: "Ink documents must be created through ink commands".to_string(),
                });
            }

            let item_type = if file.file_type == "image" {
                "image"
            } else {
                "file"
            };
            let folder_item = VfsFolderItem::new(
                folder_id.map(|s| s.to_string()),
                item_type.to_string(),
                file.id.clone(),
            );
            VfsFolderRepo::add_item_to_folder_with_conn(conn, &folder_item)?;

            debug!(
                "[VFS::FileRepo] Created verified file {} in folder {:?} (type: {}, created: {})",
                file.id, folder_id, file.file_type, created
            );
            Ok(VerifiedFileFolderOutcome { file, created })
        })();

        match result {
            Ok(outcome) => {
                conn.execute("RELEASE create_verified_file_in_folder", [])?;
                Ok(outcome)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO create_verified_file_in_folder", []);
                let _ = conn.execute("RELEASE create_verified_file_in_folder", []);
                Err(e)
            }
        }
    }

    /// A3: `create_file_in_folder_from_verified_bytes_with_conn` 的自取连接入口。
    #[allow(clippy::too_many_arguments)]
    pub fn create_file_in_folder_from_verified_bytes(
        db: &VfsDatabase,
        sha256: &str,
        file_name: &str,
        size: i64,
        file_type: &str,
        mime_type: Option<&str>,
        blob_hash: Option<&str>,
        original_path: Option<&str>,
        folder_id: Option<&str>,
        data: &[u8],
    ) -> VfsResult<VerifiedFileFolderOutcome> {
        let conn = db.get_conn_safe()?;
        Self::create_file_in_folder_from_verified_bytes_with_conn(
            &conn,
            sha256,
            file_name,
            size,
            file_type,
            mime_type,
            blob_hash,
            original_path,
            folder_id,
            data,
        )
    }

    /// A3: 从既有 blob 受控重识别文件类型。
    ///
    /// 先取得 blob mutation guard，再在嵌套安全的 SAVEPOINT 内重读文件状态。
    /// blob 路径只读取有界头部做格式检测、流式校验整个 blob 的 SHA-256；
    /// inline 路径只从受控 `resources.data`（base64，<= 1 MiB）取内容并校验
    /// 内容/资源 hash。`unknown` / `missing` / `corrupt` 均不写库；canonical
    /// Ink 文档显式拒绝；已识别且类型未变化时不产生 updated_at 抖动。
    pub fn reclassify_existing_file_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        file_id: &str,
    ) -> VfsResult<FileReclassifyOutcome> {
        if !conn.is_autocommit() {
            return Err(VfsError::InvalidState {
                message: "reclassify_existing_file_with_conn requires an autocommit connection; \
                          call reclassify_existing_file_with_conn_guarded from an existing writer"
                    .to_string(),
            });
        }
        let guard = acquire_blob_mutation_guard()?;
        Self::reclassify_existing_file_with_conn_guarded(conn, blobs_dir, file_id, &guard)
    }

    /// 供已持有 blob mutation guard 的调用方复用，避免重复加锁导致死锁。
    pub(crate) fn reclassify_existing_file_with_conn_guarded(
        conn: &Connection,
        blobs_dir: &Path,
        file_id: &str,
        _guard: &BlobMutationGuard,
    ) -> VfsResult<FileReclassifyOutcome> {
        conn.execute("SAVEPOINT reclassify_file", []).map_err(|e| {
            error!(
                "[VFS::FileRepo] Failed to create savepoint for reclassify_file: {}",
                e
            );
            VfsError::Database(format!("Failed to create savepoint: {}", e))
        })?;

        let result = (|| -> VfsResult<FileReclassifyOutcome> {
            // 在事务内重读，锁定本次 CAS 期望状态。
            let existing = match Self::get_file_with_conn(conn, file_id)? {
                Some(file) => file,
                None => {
                    return Ok(FileReclassifyOutcome {
                        status: FileReclassifyStatus::Missing,
                        file: None,
                    })
                }
            };

            // 用户显式重识别只针对活跃资源；软删/trash 行必须原样保留，
            // 否则改 category 会让 restore 只按 file 类别恢复时丢失目录归属。
            if existing.status != "active" || existing.deleted_at.is_some() {
                return Ok(FileReclassifyOutcome {
                    status: FileReclassifyStatus::Missing,
                    file: Some(existing),
                });
            }

            // Ink canonical 文档不能用通用重识别改写 MIME/类别。
            if super::ink_repo::VfsInkRepo::is_ink_file_candidate_with_conn(conn, file_id)? {
                return Err(VfsError::InvalidArgument {
                    param: "id".to_string(),
                    reason: "Ink documents must be changed through ink commands; reclassify is unsupported"
                        .to_string(),
                });
            }

            enum ReclassifySource {
                Blob {
                    path: PathBuf,
                    blob_hash: String,
                },
                Inline {
                    bytes: Vec<u8>,
                    resource_id: String,
                    resource_hash: String,
                    base64_data: String,
                },
            }

            let source = if let Some(blob_hash) = existing.blob_hash.clone() {
                if !sha256_matches_blob_pointer(&existing.sha256, &blob_hash) {
                    warn!(
                        "[VFS::FileRepo] Reclassify pointer mismatch for {} (sha256={}, blob={})",
                        file_id, existing.sha256, blob_hash
                    );
                    return Ok(FileReclassifyOutcome {
                        status: FileReclassifyStatus::Corrupt,
                        file: Some(existing),
                    });
                }

                let Some(blob_path) =
                    VfsBlobRepo::get_blob_path_with_conn(conn, blobs_dir, &blob_hash)?
                else {
                    return Ok(FileReclassifyOutcome {
                        status: FileReclassifyStatus::Missing,
                        file: Some(existing),
                    });
                };

                ReclassifySource::Blob {
                    path: blob_path,
                    blob_hash,
                }
            } else {
                // inline：只接受受控 storage_mode=inline 且 data 为 base64 的资源。
                // 先用 SQL 读长度做上限判断，避免把超大 data 取进内存。
                let Some(resource_id) = existing.resource_id.clone() else {
                    return Ok(FileReclassifyOutcome {
                        status: FileReclassifyStatus::Missing,
                        file: Some(existing),
                    });
                };
                let resource_meta: Option<(String, String, Option<i64>)> = conn
                    .query_row(
                        "SELECT storage_mode, hash, length(data) FROM resources WHERE id = ?1",
                        params![&resource_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()?;
                let Some((storage_mode, resource_hash, Some(base64_len))) = resource_meta else {
                    return Ok(FileReclassifyOutcome {
                        status: FileReclassifyStatus::Missing,
                        file: Some(existing),
                    });
                };
                if storage_mode != "inline" {
                    warn!(
                        "[VFS::FileRepo] Inline reclassify rejected for {} (mode={})",
                        file_id, storage_mode
                    );
                    return Ok(FileReclassifyOutcome {
                        status: FileReclassifyStatus::Missing,
                        file: Some(existing),
                    });
                }
                if base64_len > MAX_INLINE_BASE64_LEN {
                    warn!(
                        "[VFS::FileRepo] Inline data exceeds reclassify budget for {} (base64_len={})",
                        file_id, base64_len
                    );
                    return Err(VfsError::InvalidArgument {
                        param: "inline_data".to_string(),
                        reason: format!(
                            "inline data length {} exceeds reclassify limit {}",
                            base64_len, MAX_INLINE_BASE64_LEN
                        ),
                    });
                }
                // 空 data 只有与 0 字节文件记录一致时才可继续；其余是内容缺失，
                // 不能误报成 corrupt。
                if base64_len == 0 && existing.size != 0 {
                    warn!(
                        "[VFS::FileRepo] Inline content missing for {} (size={})",
                        file_id, existing.size
                    );
                    return Ok(FileReclassifyOutcome {
                        status: FileReclassifyStatus::Missing,
                        file: Some(existing),
                    });
                }

                // 二次查询把 identity/hash/长度快照一起锁定，后续 CAS 再守一次。
                let base64_data: Option<String> = conn
                    .query_row(
                        "SELECT data FROM resources WHERE id = ?1 AND storage_mode = 'inline' AND hash = ?2 AND length(data) = ?3",
                        params![&resource_id, &resource_hash, base64_len],
                        |row| row.get(0),
                    )
                    .optional()?;
                let Some(base64_data) = base64_data else {
                    return Ok(FileReclassifyOutcome {
                        status: FileReclassifyStatus::Missing,
                        file: Some(existing),
                    });
                };

                let computed_resource_hash =
                    crate::vfs::repos::resource_repo::VfsResourceRepo::compute_hash(&base64_data);
                if !computed_resource_hash.eq_ignore_ascii_case(&resource_hash) {
                    warn!(
                        "[VFS::FileRepo] Inline resource hash mismatch for {} (stored={}, computed={})",
                        file_id, resource_hash, computed_resource_hash
                    );
                    return Ok(FileReclassifyOutcome {
                        status: FileReclassifyStatus::Corrupt,
                        file: Some(existing),
                    });
                }

                let bytes = match base64::engine::general_purpose::STANDARD.decode(&base64_data) {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        warn!(
                            "[VFS::FileRepo] Inline base64 decode failed for {}: {}",
                            file_id, error
                        );
                        return Ok(FileReclassifyOutcome {
                            status: FileReclassifyStatus::Corrupt,
                            file: Some(existing),
                        });
                    }
                };
                if bytes.len() > MAX_INLINE_FILE_BYTES {
                    warn!(
                        "[VFS::FileRepo] Inline decoded size exceeds limit for {} ({} bytes)",
                        file_id,
                        bytes.len()
                    );
                    return Err(VfsError::InvalidArgument {
                        param: "inline_data".to_string(),
                        reason: format!(
                            "decoded inline data length {} exceeds limit {}",
                            bytes.len(),
                            MAX_INLINE_FILE_BYTES
                        ),
                    });
                }
                if !VfsBlobRepo::compute_hash(&bytes).eq_ignore_ascii_case(&existing.sha256) {
                    warn!(
                        "[VFS::FileRepo] Inline content hash mismatch for {} (record sha256={})",
                        file_id, existing.sha256
                    );
                    return Ok(FileReclassifyOutcome {
                        status: FileReclassifyStatus::Corrupt,
                        file: Some(existing),
                    });
                }

                ReclassifySource::Inline {
                    bytes,
                    resource_id,
                    resource_hash,
                    base64_data,
                }
            };

            let header = match &source {
                ReclassifySource::Blob { path, .. } => match read_bounded_header(path) {
                    Ok(Some(header)) => header,
                    Ok(None) => {
                        return Ok(FileReclassifyOutcome {
                            status: FileReclassifyStatus::Missing,
                            file: Some(existing),
                        })
                    }
                    Err(error) => {
                        warn!(
                            "[VFS::FileRepo] Reclassify read failed for {}: {}",
                            file_id, error
                        );
                        return Ok(FileReclassifyOutcome {
                            status: FileReclassifyStatus::Corrupt,
                            file: Some(existing),
                        });
                    }
                },
                ReclassifySource::Inline { bytes, .. } => {
                    bytes[..bytes.len().min(64 * 1024)].to_vec()
                }
            };

            // blob 路径保留原有的“先确认可读、再流式校验内容 hash”顺序，
            // 让物理缺失保持 Missing、内容损坏才是 Corrupt。
            if let ReclassifySource::Blob { path, blob_hash } = &source {
                match verify_file_sha256(path, blob_hash) {
                    Ok(true) => {}
                    Ok(false) => {
                        warn!(
                            "[VFS::FileRepo] Reclassify hash mismatch for {} (expected {})",
                            file_id, blob_hash
                        );
                        return Ok(FileReclassifyOutcome {
                            status: FileReclassifyStatus::Corrupt,
                            file: Some(existing),
                        });
                    }
                    Err(error) => {
                        warn!(
                            "[VFS::FileRepo] Reclassify hash verification failed for {}: {}",
                            file_id, error
                        );
                        return Ok(FileReclassifyOutcome {
                            status: FileReclassifyStatus::Corrupt,
                            file: Some(existing),
                        });
                    }
                }
            }

            let Some(detected) = detect_file_identity(&header) else {
                return Ok(FileReclassifyOutcome {
                    status: FileReclassifyStatus::Unknown,
                    file: Some(existing),
                });
            };

            // 头部命中不代表完整可用：对有明确收尾结构的格式做有界校验。
            let structure_ok = match &source {
                ReclassifySource::Blob { path, .. } => {
                    match validate_detected_structure(path, &detected.extension, &header) {
                        Ok(ok) => ok,
                        Err(error) => {
                            warn!(
                                "[VFS::FileRepo] Reclassify structure read failed for {}: {}",
                                file_id, error
                            );
                            return Ok(FileReclassifyOutcome {
                                status: FileReclassifyStatus::Corrupt,
                                file: Some(existing),
                            });
                        }
                    }
                }
                ReclassifySource::Inline { bytes, .. } => {
                    if detected.extension.eq_ignore_ascii_case("png") {
                        match validate_png_structure_bytes(bytes) {
                            Ok(ok) => ok,
                            Err(error) => {
                                warn!(
                                    "[VFS::FileRepo] Reclassify PNG structure failed for {}: {}",
                                    file_id, error
                                );
                                return Ok(FileReclassifyOutcome {
                                    status: FileReclassifyStatus::Corrupt,
                                    file: Some(existing),
                                });
                            }
                        }
                    } else {
                        let tail_len = structure_tail_bytes(&detected.extension);
                        let tail_start = bytes.len().saturating_sub(tail_len);
                        validate_detected_structure_bytes(
                            &detected.extension,
                            &header,
                            &bytes[tail_start..],
                        )
                    }
                }
            };
            if !structure_ok {
                warn!(
                    "[VFS::FileRepo] Reclassify structure check failed for {} (ext={})",
                    file_id, detected.extension
                );
                return Ok(FileReclassifyOutcome {
                    status: FileReclassifyStatus::Corrupt,
                    file: Some(existing),
                });
            }

            let resolved = resolve_file_identity(
                existing.mime_type.as_deref(),
                &existing.file_type,
                &existing.file_name,
                Some(&detected),
            );
            let existing_generic = mime_is_generic(existing.mime_type.as_deref());
            let target_mime = if resolved.strong || existing_generic {
                resolved.mime_type.clone()
            } else {
                existing
                    .mime_type
                    .clone()
                    .unwrap_or_else(|| resolved.mime_type.clone())
            };
            let mime_upgraded = existing_generic && !mime_is_generic(Some(&target_mime));
            let target_file_type = if resolved.strong || mime_upgraded {
                resolved.file_type.clone()
            } else {
                existing.file_type.clone()
            };
            let plan =
                plan_metadata_sync_with_conn(conn, &existing, &target_mime, &target_file_type)?;
            if metadata_sync_is_consistent(&existing, &plan) {
                return Ok(FileReclassifyOutcome {
                    status: FileReclassifyStatus::Recognized,
                    file: Some(existing),
                });
            }

            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
            let now_ms = chrono::Utc::now().timestamp_millis();
            let updated = match &source {
                ReclassifySource::Blob { .. } => conn.execute(
                    r#"UPDATE files SET mime_type = ?1, "type" = ?2, updated_at = ?3
                       WHERE id = ?4 AND blob_hash IS ?5 AND sha256 = ?6
                         AND mime_type IS ?7 AND "type" = ?8"#,
                    params![
                        plan.target_mime,
                        plan.target_file_type,
                        &now,
                        file_id,
                        existing.blob_hash.as_deref(),
                        existing.sha256.as_str(),
                        existing.mime_type.as_deref(),
                        existing.file_type.as_str(),
                    ],
                )?,
                ReclassifySource::Inline {
                    resource_id,
                    resource_hash,
                    base64_data,
                    ..
                } => conn.execute(
                    // 资源 identity/data/hash 快照必须与读取时一致，避免并发改写后
                    // 用旧内容识别结果覆盖新状态。
                    r#"UPDATE files SET mime_type = ?1, "type" = ?2, updated_at = ?3
                       WHERE id = ?4 AND blob_hash IS NULL AND sha256 = ?5
                         AND mime_type IS ?6 AND "type" = ?7
                         AND resource_id = ?8
                         AND EXISTS (
                             SELECT 1 FROM resources r
                             WHERE r.id = ?8 AND r.storage_mode = 'inline'
                               AND r.hash = ?9 AND r.data = ?10
                         )"#,
                    params![
                        plan.target_mime,
                        plan.target_file_type,
                        &now,
                        file_id,
                        existing.sha256.as_str(),
                        existing.mime_type.as_deref(),
                        existing.file_type.as_str(),
                        resource_id.as_str(),
                        resource_hash.as_str(),
                        base64_data.as_str(),
                    ],
                )?,
            };
            if updated == 0 {
                warn!(
                    "[VFS::FileRepo] Reclassify CAS lost for {}; state changed concurrently",
                    file_id
                );
                return Ok(FileReclassifyOutcome {
                    status: FileReclassifyStatus::Unknown,
                    file: Self::get_file_with_conn(conn, file_id)?,
                });
            }

            apply_metadata_sync_plan(conn, &plan, now_ms)?;

            let file = Self::get_file_with_conn(conn, file_id)?.ok_or_else(|| {
                VfsError::Database(format!("File {} not found after reclassify", file_id))
            })?;
            info!(
                "[VFS::FileRepo] Reclassified file {}: mime={}, type={}, ext={}",
                file_id, detected.mime_type, detected.file_type, detected.extension
            );
            Ok(FileReclassifyOutcome {
                status: FileReclassifyStatus::Recognized,
                file: Some(file),
            })
        })();

        match result {
            Ok(outcome) => {
                conn.execute("RELEASE reclassify_file", []).map_err(|e| {
                    error!(
                        "[VFS::FileRepo] Failed to release savepoint reclassify_file: {}",
                        e
                    );
                    VfsError::Database(format!("Failed to release savepoint: {}", e))
                })?;
                Ok(outcome)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO reclassify_file", []);
                let _ = conn.execute("RELEASE reclassify_file", []);
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
        if super::ink_repo::VfsInkRepo::is_ink_file_candidate_with_conn(conn, src_file_id)? {
            return Err(VfsError::InvalidOperation {
                operation: "copy_ink_file".to_owned(),
                reason: "Ink documents must be copied through VfsInkRepo with a blob directory"
                    .to_owned(),
            });
        }
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
            // Small uploads have no preceding blob write. Acquire the write
            // lock before folder/dedup reads so this deferred SAVEPOINT cannot
            // become a stale read snapshot while other uploads commit.
            // Keep this inside the closure so failure follows rollback/release.
            conn.execute("UPDATE files SET id = id WHERE 0", [])?;

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
        let file = Self::get_file_with_conn(conn, file_id)?.ok_or_else(|| VfsError::NotFound {
            resource_type: "File".to_string(),
            id: file_id.to_string(),
        })?;
        if file.mime_type.as_deref() == Some(crate::vfs::ink::INK_MIME) {
            return Err(VfsError::InvalidOperation {
                operation: "rename Ink document with generic file updater".to_owned(),
                reason: "Ink title and canonical filename must be renamed through VfsInkRepo"
                    .to_owned(),
            });
        }

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
        let ink_purged = rollback_on_error!(
            super::ink_repo::VfsInkRepo::purge_file_refs_with_conn(conn, blobs_dir, file_id),
            "Failed to release Ink blob references"
        );

        // 1. 处理文件自身的 blob_hash（大文件外部存储）
        if !ink_purged {
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
                        match VfsBlobRepo::decrement_ref_with_conn(conn, blobs_dir, &page.blob_hash)
                        {
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
            WHERE status = 'deleted' AND id NOT LIKE 'tb_%'
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
            .prepare("SELECT id FROM files WHERE status = 'deleted' AND id NOT LIKE 'tb_%'")?
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;

        let count = file_ids.len();

        for file_id in &file_ids {
            Self::purge_file_with_conn(conn, blobs_dir, file_id)?;
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
    use crate::vfs::repos::folder_repo::VfsFolderRepo;
    use tempfile::TempDir;

    fn setup_test_db() -> (TempDir, VfsDatabase) {
        crate::vfs::database::setup_migrated_test_db()
    }

    #[test]
    fn generic_copy_rejects_ink_without_creating_shared_manifest_copy() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().unwrap();
        let ink = super::super::ink_repo::VfsInkRepo::create_blank_with_conn(
            &conn,
            db.blobs_dir(),
            "Ink copy guard",
            crate::vfs::ink::InkRuling::Blank,
            100.0,
            100.0,
            "copy-guard-create",
            None,
        )
        .unwrap();
        let before: (i64, i64) = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM files), (SELECT COALESCE(SUM(ref_count), 0) FROM blobs)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert!(
            VfsFileRepo::copy_file_with_conn(&conn, &ink.document_id, "Generic copy.dsink")
                .is_err()
        );
        let after: (i64, i64) = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM files), (SELECT COALESCE(SUM(ref_count), 0) FROM blobs)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(after, before);
    }

    #[test]
    fn generic_rename_rejects_ink_documents_without_changing_manifest_or_filename() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().unwrap();
        let manifest = super::super::ink_repo::VfsInkRepo::create_blank_with_conn(
            &conn,
            db.blobs_dir(),
            "Canonical Ink title",
            crate::vfs::ink::InkRuling::Blank,
            100.0,
            100.0,
            "rename-guard-create",
            None,
        )
        .unwrap();

        let result = VfsFileRepo::update_file_name_with_conn(
            &conn,
            &manifest.document_id,
            "different-title.txt",
        );

        assert!(
            result.is_err(),
            "generic file rename must reject Ink documents"
        );
        let stored = VfsFileRepo::get_file_with_conn(&conn, &manifest.document_id)
            .unwrap()
            .unwrap();
        assert_eq!(stored.file_name, "Canonical Ink title.dsink");
        let reopened = super::super::ink_repo::VfsInkRepo::get_manifest_with_conn(
            &conn,
            db.blobs_dir(),
            &manifest.document_id,
        )
        .unwrap();
        assert_eq!(reopened.title, "Canonical Ink title");
        assert_eq!(reopened.revision, manifest.revision);
    }

    #[test]
    fn generic_rename_still_renames_ordinary_files() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().unwrap();
        let file = VfsFileRepo::create_file_with_conn(
            &conn,
            "rename-ordinary-file-sha",
            "ordinary.txt",
            12,
            "document",
            Some("text/plain"),
            None,
            None,
        )
        .unwrap();

        let renamed = VfsFileRepo::update_file_name_with_conn(&conn, &file.id, "renamed.txt")
            .expect("ordinary file rename remains supported");

        assert_eq!(renamed.file_name, "renamed.txt");
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

    // ★ A3: 去重命中旧 octet-stream 条目时，新的可靠类型必须回填 MIME，
    // 同时不得改动用户可见名称、ID、hash、收藏、目录归属或引用计数。
    #[test]
    fn reclassify_dedup_octet_stream_to_pdf_updates_mime_only() {
        use crate::vfs::repos::resource_repo::VfsResourceRepo;
        use crate::vfs::types::VfsFolder;

        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().unwrap();

        let folder = VfsFolder::new("导入文档".to_string(), None, None, None);
        VfsFolderRepo::create_folder_with_conn(&conn, &folder).unwrap();

        let pdf_bytes = b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n";
        let pdf_sha = VfsBlobRepo::compute_hash(pdf_bytes);
        let initial = VfsFileRepo::create_file_in_folder_with_conn(
            &conn,
            &pdf_sha,
            "Thesis Draft",
            pdf_bytes.len() as i64,
            "document",
            Some("application/octet-stream"),
            None,
            None,
            Some(&folder.id),
        )
        .unwrap();
        VfsFileRepo::set_favorite_with_conn(&conn, &initial.id, true).unwrap();
        let resource_id = initial.resource_id.as_deref().unwrap();
        assert_eq!(
            VfsResourceRepo::increment_ref_with_conn(&conn, resource_id).unwrap(),
            1
        );

        let reimported = VfsFileRepo::create_file_from_verified_bytes_with_conn(
            &conn,
            &pdf_sha,
            "Thesis Draft",
            pdf_bytes.len() as i64,
            "document",
            Some("application/pdf"),
            None,
            None,
            pdf_bytes,
        )
        .unwrap();

        assert_eq!(
            reimported.mime_type.as_deref(),
            Some("application/pdf"),
            "去重命中旧 octet-stream 条目时必须回填可靠 MIME，而不是返回旧 metadata"
        );
        assert_eq!(reimported.id, initial.id, "A3 必须保留原文件 ID");
        assert_eq!(reimported.sha256, initial.sha256, "A3 必须保留内容 hash");
        assert_eq!(
            reimported.file_name, "Thesis Draft",
            "A3 不得默认改用户名称"
        );
        assert!(reimported.is_favorite, "A3 必须保留收藏状态");
        let membership =
            VfsFolderRepo::get_folder_item_by_item_id_with_conn(&conn, "file", &initial.id)
                .unwrap()
                .expect("A3 必须保留目录归属");
        assert_eq!(membership.folder_id.as_deref(), Some(folder.id.as_str()));
        let ref_count: i32 = conn
            .query_row(
                "SELECT ref_count FROM resources WHERE id = ?1",
                params![resource_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ref_count, 1, "A3 必须保留引用计数");
    }

    #[test]
    fn reclassify_dedup_octet_stream_to_png_updates_mime_only() {
        use crate::vfs::repos::resource_repo::VfsResourceRepo;
        use crate::vfs::types::VfsFolder;

        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().unwrap();

        let folder = VfsFolder::new("导入图片".to_string(), None, None, None);
        VfsFolderRepo::create_folder_with_conn(&conn, &folder).unwrap();

        let png_bytes = real_png_fixture();
        let png_sha = VfsBlobRepo::compute_hash(&png_bytes);
        let initial = VfsFileRepo::create_file_in_folder_with_conn(
            &conn,
            &png_sha,
            "Whiteboard Capture",
            png_bytes.len() as i64,
            "document",
            Some("application/octet-stream"),
            None,
            None,
            Some(&folder.id),
        )
        .unwrap();
        VfsFileRepo::set_favorite_with_conn(&conn, &initial.id, true).unwrap();
        let resource_id = initial.resource_id.as_deref().unwrap();
        assert_eq!(
            VfsResourceRepo::increment_ref_with_conn(&conn, resource_id).unwrap(),
            1
        );

        let reimported = VfsFileRepo::create_file_from_verified_bytes_with_conn(
            &conn,
            &png_sha,
            "Whiteboard Capture",
            png_bytes.len() as i64,
            "image",
            Some("image/png"),
            None,
            None,
            &png_bytes,
        )
        .unwrap();

        assert_eq!(
            reimported.mime_type.as_deref(),
            Some("image/png"),
            "去重命中旧 octet-stream 条目时必须回填可靠 MIME，而不是返回旧 metadata"
        );
        assert_eq!(reimported.id, initial.id, "A3 必须保留原文件 ID");
        assert_eq!(reimported.sha256, initial.sha256, "A3 必须保留内容 hash");
        assert_eq!(
            reimported.file_name, "Whiteboard Capture",
            "A3 不得默认改用户名称"
        );
        assert!(reimported.is_favorite, "A3 必须保留收藏状态");
        // 类别从 document 修正为 image 时 folder_items.item_type 同步为 image；
        // 目录归属本身（folder_id）必须保持不变。
        let membership =
            VfsFolderRepo::get_folder_item_by_item_id_with_conn(&conn, "image", &initial.id)
                .unwrap()
                .expect("A3 必须保留目录归属");
        assert_eq!(membership.folder_id.as_deref(), Some(folder.id.as_str()));
        let ref_count: i32 = conn
            .query_row(
                "SELECT ref_count FROM resources WHERE id = ?1",
                params![resource_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ref_count, 1, "A3 必须保留引用计数");
    }

    // ★ A3: 真实迁移库上的显式重识别：保留全部身份字段、幂等、未知/损坏零写入。
    #[test]
    fn reclassify_existing_file_preserves_identity_and_zero_writes_for_unknown_or_corrupt() {
        use crate::vfs::file_reclassify::FileReclassifyStatus;
        use crate::vfs::repos::blob_repo::VfsBlobRepo;
        use crate::vfs::repos::resource_repo::VfsResourceRepo;
        use crate::vfs::types::VfsFolder;

        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().unwrap();
        let folder = VfsFolder::new("重识别".to_string(), None, None, None);
        VfsFolderRepo::create_folder_with_conn(&conn, &folder).unwrap();

        // 真实可解码的极简 PNG：签名 + IHDR/IDAT/IEND。
        let png = real_png_fixture();
        let png_blob =
            VfsBlobRepo::store_blob(&db, &png, Some("application/octet-stream"), Some("bin"))
                .unwrap();

        let file = VfsFileRepo::create_file_in_folder_with_conn(
            &conn,
            &png_blob.hash,
            "Whiteboard Capture",
            png.len() as i64,
            "document",
            Some("application/octet-stream"),
            Some(&png_blob.hash),
            None,
            Some(&folder.id),
        )
        .unwrap();
        VfsFileRepo::set_favorite_with_conn(&conn, &file.id, true).unwrap();
        let resource_id = file.resource_id.as_deref().unwrap();
        VfsResourceRepo::increment_ref_with_conn(&conn, resource_id).unwrap();
        let before = VfsFileRepo::get_file_with_conn(&conn, &file.id)
            .unwrap()
            .unwrap();

        let first =
            VfsFileRepo::reclassify_existing_file_with_conn(&conn, db.blobs_dir(), &file.id)
                .unwrap();
        assert_eq!(first.status, FileReclassifyStatus::Recognized);
        let reclassified = first.file.unwrap();
        assert_eq!(reclassified.mime_type.as_deref(), Some("image/png"));
        assert_eq!(reclassified.file_type, "image");
        assert_eq!(reclassified.id, before.id);
        assert_eq!(reclassified.sha256, before.sha256);
        assert_eq!(reclassified.blob_hash, before.blob_hash);
        assert_eq!(reclassified.file_name, "Whiteboard Capture");
        assert!(reclassified.is_favorite);
        let membership =
            VfsFolderRepo::get_folder_item_by_item_id_with_conn(&conn, "image", &file.id)
                .unwrap()
                .expect("类别同步后目录项仍必须存在");
        assert_eq!(membership.folder_id.as_deref(), Some(folder.id.as_str()));
        let ref_count: i32 = conn
            .query_row(
                "SELECT ref_count FROM resources WHERE id = ?1",
                params![resource_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ref_count, 1);
        assert_eq!(membership.item_type, "image");

        // 幂等：第二次识别不产生 updated_at 抖动。
        let second =
            VfsFileRepo::reclassify_existing_file_with_conn(&conn, db.blobs_dir(), &file.id)
                .unwrap();
        assert_eq!(second.status, FileReclassifyStatus::Recognized);
        assert_eq!(second.file.unwrap().updated_at, reclassified.updated_at);

        // 未知内容：状态 Unknown 且零写入。
        let unknown_blob =
            VfsBlobRepo::store_blob(&db, b"hello\0world\x01", None, Some("bin")).unwrap();
        let unknown = VfsFileRepo::create_file_with_conn(
            &conn,
            &unknown_blob.hash,
            "Unknown Payload",
            12,
            "document",
            None,
            Some(&unknown_blob.hash),
            None,
        )
        .unwrap();
        let unknown_before = VfsFileRepo::get_file_with_conn(&conn, &unknown.id)
            .unwrap()
            .unwrap();
        let unknown_result =
            VfsFileRepo::reclassify_existing_file_with_conn(&conn, db.blobs_dir(), &unknown.id)
                .unwrap();
        assert_eq!(unknown_result.status, FileReclassifyStatus::Unknown);
        let unknown_after = VfsFileRepo::get_file_with_conn(&conn, &unknown.id)
            .unwrap()
            .unwrap();
        assert_eq!(unknown_after.mime_type, unknown_before.mime_type);
        assert_eq!(unknown_after.file_type, unknown_before.file_type);
        assert_eq!(unknown_after.updated_at, unknown_before.updated_at);

        // 内容损坏（hash 不一致）：状态 Corrupt 且零写入。
        let corrupt_blob =
            VfsBlobRepo::store_blob(&db, &png, Some("image/png"), Some("png")).unwrap();
        let corrupt = VfsFileRepo::create_file_with_conn(
            &conn,
            "sha_a3_corrupt_pointer",
            "Corrupt Payload",
            png.len() as i64,
            "document",
            Some("application/octet-stream"),
            Some(&corrupt_blob.hash),
            None,
        )
        .unwrap();
        let corrupt_before = VfsFileRepo::get_file_with_conn(&conn, &corrupt.id)
            .unwrap()
            .unwrap();
        let corrupt_path = VfsBlobRepo::get_blob_path(&db, &corrupt_blob.hash)
            .unwrap()
            .expect("blob path must exist");
        std::fs::write(&corrupt_path, b"tampered bytes").unwrap();
        let corrupt_result =
            VfsFileRepo::reclassify_existing_file_with_conn(&conn, db.blobs_dir(), &corrupt.id)
                .unwrap();
        assert_eq!(corrupt_result.status, FileReclassifyStatus::Corrupt);
        let corrupt_after = VfsFileRepo::get_file_with_conn(&conn, &corrupt.id)
            .unwrap()
            .unwrap();
        assert_eq!(corrupt_after.mime_type, corrupt_before.mime_type);
        assert_eq!(corrupt_after.file_type, corrupt_before.file_type);
        assert_eq!(corrupt_after.updated_at, corrupt_before.updated_at);
    }

    /// 生成真实可解码的 PNG（带 IHDR/IDAT/IEND），避免签名+IEND 假样本。
    fn real_png_fixture_with_color(pixel: [u8; 4]) -> Vec<u8> {
        use image::{ColorType, ImageEncoder};

        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(&pixel, 1, 1, ColorType::Rgba8)
            .expect("encode real PNG fixture");
        bytes
    }

    fn real_png_fixture() -> Vec<u8> {
        real_png_fixture_with_color([12, 34, 56, 255])
    }

    /// 真实可解析的 SVG（XML 头部 + svg 根）；内容检测只能得到弱 xml/txt，
    /// 不得覆盖名称/声明给出的 SVG 身份。
    fn real_svg_fixture() -> Vec<u8> {
        br#"<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>"#.to_vec()
    }

    // ★ A3: 现有 inline 资源（file.blob_hash=None）必须从 resources.data 的
    // 内嵌字节重识别；不得要求 blob，也不得改 ID/sha/名称/目录/收藏/引用。
    #[test]
    fn reclassify_inline_attachment_uses_embedded_bytes_and_preserves_identity() {
        use crate::vfs::repos::resource_repo::VfsResourceRepo;
        use crate::vfs::types::{StorageMode, VfsFolder, VfsResourceMetadata, VfsResourceType};
        use base64::{engine::general_purpose::STANDARD, Engine as _};

        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().unwrap();

        let png = real_png_fixture();
        let raw_hash = VfsBlobRepo::compute_hash(&png);
        let inline_base64 = STANDARD.encode(&png);
        // 真实 inline 资源 hash 基于 base64 data，而不是原始内容 hash。
        let resource_hash = VfsResourceRepo::compute_hash(&inline_base64);
        assert_ne!(
            resource_hash, raw_hash,
            "inline resources.hash 必须按真实资源实现计算，不能等于 raw hash"
        );

        let metadata = VfsResourceMetadata {
            name: Some("Legacy Inline Scan".to_string()),
            mime_type: Some("application/octet-stream".to_string()),
            size: Some(png.len() as u64),
            ..Default::default()
        };
        let created_resource = VfsResourceRepo::create_or_reuse_with_conn(
            &conn,
            VfsResourceType::File,
            &inline_base64,
            None,
            None,
            Some(&metadata),
        )
        .unwrap();
        let resource_id = created_resource.resource_id.clone();
        assert_eq!(created_resource.hash, resource_hash);

        let file_id = "file_a3_inline_reclassify";
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        conn.execute(
            r#"INSERT INTO files (
                id, resource_id, blob_hash, type, name, mime_type, size,
                content_hash, sha256, file_name, created_at, updated_at
            ) VALUES (?1, ?2, NULL, 'file', ?3, 'application/octet-stream', ?4, ?5, ?5, ?3, ?6, ?6)"#,
            params![
                file_id,
                &resource_id,
                "Legacy Inline Scan",
                png.len() as i64,
                &raw_hash,
                &now,
            ],
        )
        .unwrap();

        let folder = VfsFolder::new("A3 Inline Folder".to_string(), None, None, None);
        VfsFolderRepo::create_folder_with_conn(&conn, &folder).unwrap();
        let item = VfsFolderItem::new(
            Some(folder.id.clone()),
            "file".to_string(),
            file_id.to_string(),
        );
        VfsFolderRepo::add_item_to_folder_with_conn(&conn, &item).unwrap();
        VfsFileRepo::set_favorite_with_conn(&conn, file_id, true).unwrap();
        assert_eq!(
            VfsResourceRepo::increment_ref_with_conn(&conn, &resource_id).unwrap(),
            1
        );

        let before_file = VfsFileRepo::get_file_with_conn(&conn, file_id)
            .unwrap()
            .expect("inline file row must exist");
        let before_resource = VfsResourceRepo::get_resource_with_conn(&conn, &resource_id)
            .unwrap()
            .expect("inline resource must exist");
        assert!(before_file.blob_hash.is_none());
        assert_eq!(before_resource.storage_mode, StorageMode::Inline);
        assert_eq!(
            before_resource.data.as_deref(),
            Some(inline_base64.as_str()),
            "inline bytes 必须保存在 resources.data"
        );
        let before_item =
            VfsFolderRepo::get_folder_item_by_item_id_with_conn(&conn, "file", file_id)
                .unwrap()
                .expect("file folder membership must exist");
        let blobs_before: i64 = conn
            .query_row("SELECT COUNT(*) FROM blobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(blobs_before, 0);

        let outcome =
            VfsFileRepo::reclassify_existing_file_with_conn(&conn, db.blobs_dir(), file_id)
                .expect("inline attachment reclassify must succeed");
        assert_eq!(
            outcome.status,
            FileReclassifyStatus::Recognized,
            "inline attachment must be recognized from resources.data, not reported missing"
        );
        let after_file = outcome
            .file
            .expect("recognized inline file must return the current record");
        assert_eq!(after_file.id, before_file.id);
        assert_eq!(after_file.sha256, before_file.sha256);
        assert_eq!(after_file.file_name, before_file.file_name);
        assert_eq!(after_file.mime_type.as_deref(), Some("image/png"));
        assert_eq!(after_file.file_type, "image");
        assert!(after_file.is_favorite);
        assert!(
            after_file.blob_hash.is_none(),
            "inline reclassify must not create a blob pointer"
        );

        let after_resource = VfsResourceRepo::get_resource_with_conn(&conn, &resource_id)
            .unwrap()
            .expect("inline resource must remain");
        assert_eq!(after_resource.id, before_resource.id);
        assert_eq!(after_resource.hash, before_resource.hash);
        assert_eq!(after_resource.data, before_resource.data);
        assert_eq!(after_resource.storage_mode, before_resource.storage_mode);
        assert_eq!(after_resource.ref_count, before_resource.ref_count);
        assert!(
            VfsResourceRepo::get_by_hash_with_conn(&conn, &raw_hash)
                .unwrap()
                .is_none(),
            "canonical inline resource hash must not be replaced by raw content hash"
        );

        let after_item =
            VfsFolderRepo::get_folder_item_by_item_id_with_conn(&conn, "image", file_id)
                .unwrap()
                .expect("category mirror must move the folder item to image");
        assert_eq!(
            after_item.folder_id.as_deref(),
            before_item.folder_id.as_deref()
        );
        let active_items: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM folder_items WHERE item_id = ?1 AND deleted_at IS NULL",
                params![file_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            active_items, 1,
            "inline reclassify must not duplicate membership"
        );

        let blobs_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM blobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            blobs_after, blobs_before,
            "inline reclassify must not create a blob"
        );
    }

    // ★ A3: canonical Ink 文档必须显式拒绝重识别，且拒绝后 manifest 仍可读。
    #[test]
    fn reclassify_rejects_ink_canonical_document_without_mutation() {
        use crate::vfs::ink::InkRuling;

        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().unwrap();
        let manifest = super::super::ink_repo::VfsInkRepo::create_blank_with_conn(
            &conn,
            db.blobs_dir(),
            "A3 Ink guard",
            InkRuling::Blank,
            100.0,
            100.0,
            "a3-reclassify-ink-create",
            None,
        )
        .unwrap();

        let before_file = VfsFileRepo::get_file_with_conn(&conn, &manifest.document_id)
            .unwrap()
            .expect("Ink file row must exist");
        let resource_id = before_file
            .resource_id
            .as_deref()
            .expect("Ink file must have a resource");
        let before_resource =
            crate::vfs::repos::resource_repo::VfsResourceRepo::get_resource_with_conn(
                &conn,
                resource_id,
            )
            .unwrap()
            .expect("Ink resource must exist");

        let err = VfsFileRepo::reclassify_existing_file_with_conn(
            &conn,
            db.blobs_dir(),
            &manifest.document_id,
        )
        .expect_err("reclassify must reject canonical Ink documents");
        assert!(
            matches!(
                &err,
                VfsError::InvalidArgument { .. } | VfsError::InvalidState { .. }
            ),
            "Ink rejection must be an explicit InvalidArgument/InvalidState, got {err:?}"
        );

        let after_file = VfsFileRepo::get_file_with_conn(&conn, &manifest.document_id)
            .unwrap()
            .expect("Ink file row must remain");
        assert_eq!(after_file.mime_type, before_file.mime_type);
        assert_eq!(after_file.sha256, before_file.sha256);
        assert_eq!(after_file.blob_hash, before_file.blob_hash);
        assert_eq!(after_file.updated_at, before_file.updated_at);

        let after_resource =
            crate::vfs::repos::resource_repo::VfsResourceRepo::get_resource_with_conn(
                &conn,
                resource_id,
            )
            .unwrap()
            .expect("Ink resource must remain");
        assert_eq!(after_resource.hash, before_resource.hash);

        let reopened = super::super::ink_repo::VfsInkRepo::get_manifest_with_conn(
            &conn,
            db.blobs_dir(),
            &manifest.document_id,
        )
        .expect("Ink manifest must remain readable after rejected reclassify");
        assert_eq!(reopened.revision, manifest.revision);
        assert_eq!(reopened.title, manifest.title);
    }

    /// 构造真实 inline PNG 文件与资源；返回 resource_id。资源 hash 是
    /// base64 data 的 hash，files.sha256 是 raw bytes hash。
    fn seed_inline_png_file(conn: &rusqlite::Connection, file_id: &str) -> String {
        seed_inline_png_bytes(conn, file_id, real_png_fixture())
    }

    fn seed_inline_png_bytes(conn: &rusqlite::Connection, file_id: &str, png: Vec<u8>) -> String {
        use crate::vfs::repos::resource_repo::VfsResourceRepo;
        use crate::vfs::types::{VfsResourceMetadata, VfsResourceType};
        use base64::{engine::general_purpose::STANDARD, Engine as _};

        let raw_hash = VfsBlobRepo::compute_hash(&png);
        let inline_base64 = STANDARD.encode(&png);
        let metadata = VfsResourceMetadata {
            name: Some("Inline Mirror".to_string()),
            mime_type: Some("application/octet-stream".to_string()),
            size: Some(png.len() as u64),
            extra: Some(serde_json::json!({ "customKey": "customValue" })),
            ..Default::default()
        };
        let created = VfsResourceRepo::create_or_reuse_with_conn(
            conn,
            VfsResourceType::File,
            &inline_base64,
            None,
            None,
            Some(&metadata),
        )
        .unwrap();
        let resource_id = created.resource_id;
        assert_eq!(
            created.hash,
            VfsResourceRepo::compute_hash(&inline_base64),
            "inline resource hash must be the base64 data hash"
        );

        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        conn.execute(
            r#"INSERT INTO files (
                id, resource_id, blob_hash, type, name, mime_type, size,
                content_hash, sha256, file_name, created_at, updated_at
            ) VALUES (?1, ?2, NULL, 'file', ?3, 'application/octet-stream', ?4, ?5, ?5, ?3, ?6, ?6)"#,
            params![
                file_id,
                &resource_id,
                "Inline Mirror",
                png.len() as i64,
                &raw_hash,
                &now,
            ],
        )
        .unwrap();
        assert_eq!(
            VfsResourceRepo::increment_ref_with_conn(conn, &resource_id).unwrap(),
            1
        );
        resource_id
    }

    // ★ A3: 公开重识别入口必须拒绝调用方已持有的写事务，避免“先开事务再取
    // blob guard”的死锁；拒绝必须发生在任何写之前。
    #[test]
    fn reclassify_public_fails_fast_inside_caller_write_transaction() {
        use crate::vfs::repos::resource_repo::VfsResourceRepo;

        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().unwrap();
        let png = real_png_fixture();
        let blob =
            VfsBlobRepo::store_blob(&db, &png, Some("application/octet-stream"), Some("bin"))
                .unwrap();
        let file = VfsFileRepo::create_file_with_conn(
            &conn,
            &blob.hash,
            "Transaction Guard",
            png.len() as i64,
            "file",
            Some("application/octet-stream"),
            Some(&blob.hash),
            None,
        )
        .unwrap();
        let resource_id = file.resource_id.clone().expect("file resource");
        let before_file = VfsFileRepo::get_file_with_conn(&conn, &file.id)
            .unwrap()
            .unwrap();
        let before_resource = VfsResourceRepo::get_resource_with_conn(&conn, &resource_id)
            .unwrap()
            .unwrap();
        let before_blobs: i64 = conn
            .query_row("SELECT COUNT(*) FROM blobs", [], |row| row.get(0))
            .unwrap();

        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        assert!(!conn.is_autocommit());
        let err = VfsFileRepo::reclassify_existing_file_with_conn(&conn, db.blobs_dir(), &file.id)
            .expect_err("public reclassify must fail fast when caller owns a write transaction");
        assert!(
            matches!(&err, VfsError::InvalidState { .. }),
            "expected InvalidState for caller-owned transaction, got {err:?}"
        );

        conn.execute_batch("ROLLBACK").unwrap();
        assert!(conn.is_autocommit());

        let after_file = VfsFileRepo::get_file_with_conn(&conn, &file.id)
            .unwrap()
            .unwrap();
        assert_eq!(after_file.mime_type, before_file.mime_type);
        assert_eq!(after_file.file_type, before_file.file_type);
        assert_eq!(after_file.updated_at, before_file.updated_at);
        let after_resource = VfsResourceRepo::get_resource_with_conn(&conn, &resource_id)
            .unwrap()
            .unwrap();
        assert_eq!(after_resource.hash, before_resource.hash);
        assert_eq!(after_resource.data, before_resource.data);
        assert_eq!(after_resource.ref_count, before_resource.ref_count);
        let after_blobs: i64 = conn
            .query_row("SELECT COUNT(*) FROM blobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(after_blobs, before_blobs);
    }

    // ★ A3: inline 重识别正确后，resources 镜像的 type/mime 也必须同步；
    // 其他 metadata、identity、data 与 ref 保持不变。
    #[test]
    fn reclassify_inline_updates_resource_type_and_metadata_mirror() {
        use crate::vfs::repos::resource_repo::VfsResourceRepo;
        use crate::vfs::types::VfsResourceType;

        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().unwrap();
        let file_id = "file_a3_inline_mirror";
        let resource_id = seed_inline_png_file(&conn, file_id);

        let before_resource = VfsResourceRepo::get_resource_with_conn(&conn, &resource_id)
            .unwrap()
            .unwrap();
        let before_meta = before_resource
            .metadata
            .clone()
            .expect("inline resource must keep metadata");
        assert_eq!(before_resource.resource_type, VfsResourceType::File);
        assert_eq!(
            before_meta.mime_type.as_deref(),
            Some("application/octet-stream")
        );

        let outcome =
            VfsFileRepo::reclassify_existing_file_with_conn(&conn, db.blobs_dir(), file_id)
                .expect("inline reclassify must succeed");
        assert_eq!(outcome.status, FileReclassifyStatus::Recognized);
        let after_file = outcome.file.expect("recognized inline file");
        assert_eq!(after_file.mime_type.as_deref(), Some("image/png"));
        assert_eq!(after_file.file_type, "image");

        let after_resource = VfsResourceRepo::get_resource_with_conn(&conn, &resource_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            after_resource.resource_type,
            VfsResourceType::Image,
            "resource type mirror must follow the corrected file category"
        );
        let after_meta = after_resource
            .metadata
            .clone()
            .expect("inline resource metadata must remain");
        assert_eq!(
            after_meta.mime_type.as_deref(),
            Some("image/png"),
            "resource metadata mimeType mirror must follow the corrected file mime"
        );
        assert_eq!(after_meta.name, before_meta.name);
        assert_eq!(after_meta.size, before_meta.size);
        assert_eq!(after_meta.extra, before_meta.extra);
        assert_eq!(after_resource.hash, before_resource.hash);
        assert_eq!(after_resource.data, before_resource.data);
        assert_eq!(after_resource.ref_count, before_resource.ref_count);
    }

    // ★ A3: 自洽 hash 的“签名 + 零长 IEND”垃圾 PNG 不是有效 PNG；显式
    // 重识别必须 Corrupt，且 files/resources/folder/updated_at 全部不变。
    #[test]
    fn reclassify_signature_only_png_is_corrupt_and_leaves_state_untouched() {
        use crate::vfs::types::VfsFolder;

        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().unwrap();

        let mut garbage = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        garbage.extend_from_slice(b"\x00\x00\x00\x00IEND\xaeB`\x82");
        assert!(!garbage.windows(4).any(|w| w == &b"IHDR"[..]));
        assert!(!garbage.windows(4).any(|w| w == &b"IDAT"[..]));

        let blob =
            VfsBlobRepo::store_blob(&db, &garbage, Some("application/octet-stream"), Some("png"))
                .unwrap();
        let folder = VfsFolder::new("A3 Garbage PNG".to_string(), None, None, None);
        VfsFolderRepo::create_folder_with_conn(&conn, &folder).unwrap();
        let file = VfsFileRepo::create_file_in_folder_with_conn(
            &conn,
            &blob.hash,
            "Signature Only",
            garbage.len() as i64,
            "file",
            Some("application/octet-stream"),
            Some(&blob.hash),
            None,
            Some(&folder.id),
        )
        .unwrap();
        let resource_id = file.resource_id.clone().expect("file resource");

        let before_file = VfsFileRepo::get_file_with_conn(&conn, &file.id)
            .unwrap()
            .unwrap();
        let before_resource: (String, Option<String>, i64, String) = conn
            .query_row(
                "SELECT type, metadata_json, updated_at, hash FROM resources WHERE id = ?1",
                params![&resource_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        let before_item =
            VfsFolderRepo::get_folder_item_by_item_id_with_conn(&conn, "file", &file.id)
                .unwrap()
                .expect("file folder membership must exist");

        let outcome =
            VfsFileRepo::reclassify_existing_file_with_conn(&conn, db.blobs_dir(), &file.id)
                .expect("reclassify must return an outcome");
        assert_eq!(
            outcome.status,
            FileReclassifyStatus::Corrupt,
            "signature + IEND without IHDR/IDAT must not be recognized as a PNG"
        );

        let after_file = VfsFileRepo::get_file_with_conn(&conn, &file.id)
            .unwrap()
            .unwrap();
        assert_eq!(after_file.mime_type, before_file.mime_type);
        assert_eq!(after_file.file_type, before_file.file_type);
        assert_eq!(after_file.updated_at, before_file.updated_at);
        let after_resource: (String, Option<String>, i64, String) = conn
            .query_row(
                "SELECT type, metadata_json, updated_at, hash FROM resources WHERE id = ?1",
                params![&resource_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(after_resource, before_resource);
        let after_item =
            VfsFolderRepo::get_folder_item_by_item_id_with_conn(&conn, "file", &file.id)
                .unwrap()
                .expect("folder membership must remain a file");
        assert_eq!(after_item.folder_id, before_item.folder_id);
        assert!(
            VfsFolderRepo::get_folder_item_by_item_id_with_conn(&conn, "image", &file.id)
                .unwrap()
                .is_none(),
            "corrupt PNG must not move folder membership to image"
        );
    }

    // ★ A3: inline 坏 base64 与 raw hash 不匹配都必须 Corrupt，且零写。
    #[test]
    fn reclassify_inline_corrupt_payloads_return_corrupt_without_mutation() {
        use crate::vfs::repos::resource_repo::VfsResourceRepo;
        use crate::vfs::types::VfsFolder;

        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().unwrap();
        let folder = VfsFolder::new("A3 Corrupt Inline".to_string(), None, None, None);
        VfsFolderRepo::create_folder_with_conn(&conn, &folder).unwrap();

        let bad_base64_file = "file_a3_inline_bad_base64";
        let bad_base64_resource = seed_inline_png_file(&conn, bad_base64_file);
        let mismatch_file = "file_a3_inline_raw_mismatch";
        let mismatch_resource = seed_inline_png_bytes(
            &conn,
            mismatch_file,
            real_png_fixture_with_color([99, 88, 77, 255]),
        );
        for file_id in [bad_base64_file, mismatch_file] {
            let item = VfsFolderItem::new(
                Some(folder.id.clone()),
                "file".to_string(),
                file_id.to_string(),
            );
            VfsFolderRepo::add_item_to_folder_with_conn(&conn, &item).unwrap();
        }

        let file_state = |file_id: &str| -> (Option<String>, String, String) {
            let file = VfsFileRepo::get_file_with_conn(&conn, file_id)
                .unwrap()
                .expect("file must exist");
            (file.mime_type, file.file_type, file.updated_at)
        };
        let resource_state =
            |resource_id: &str| -> (String, Option<String>, i64, String, Option<String>) {
                conn.query_row(
                "SELECT type, metadata_json, updated_at, hash, data FROM resources WHERE id = ?1",
                params![resource_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .unwrap()
            };

        // 1) 资源 hash 正确但 data 不是合法 base64。
        let invalid_base64 = "@@@not-base64@@@";
        conn.execute(
            "UPDATE resources SET data = ?1, hash = ?2 WHERE id = ?3",
            params![
                invalid_base64,
                VfsResourceRepo::compute_hash(invalid_base64),
                &bad_base64_resource,
            ],
        )
        .unwrap();
        let before_file = file_state(bad_base64_file);
        let before_resource = resource_state(&bad_base64_resource);
        let outcome =
            VfsFileRepo::reclassify_existing_file_with_conn(&conn, db.blobs_dir(), bad_base64_file)
                .expect("reclassify must return an outcome");
        assert_eq!(outcome.status, FileReclassifyStatus::Corrupt);
        assert_eq!(file_state(bad_base64_file), before_file);
        assert_eq!(resource_state(&bad_base64_resource), before_resource);
        let item =
            VfsFolderRepo::get_folder_item_by_item_id_with_conn(&conn, "file", bad_base64_file)
                .unwrap()
                .expect("folder membership must remain a file");
        assert_eq!(item.folder_id.as_deref(), Some(folder.id.as_str()));
        assert!(VfsFolderRepo::get_folder_item_by_item_id_with_conn(
            &conn,
            "image",
            bad_base64_file
        )
        .unwrap()
        .is_none());

        // 2) 内容/base64 正常，但 files.sha256 与 raw bytes 不一致。
        let wrong_hash = VfsBlobRepo::compute_hash(b"a3 inline raw mismatch sentinel");
        conn.execute(
            "UPDATE files SET sha256 = ?1 WHERE id = ?2",
            params![wrong_hash, mismatch_file],
        )
        .unwrap();
        let before_file = file_state(mismatch_file);
        let before_resource = resource_state(&mismatch_resource);
        let outcome =
            VfsFileRepo::reclassify_existing_file_with_conn(&conn, db.blobs_dir(), mismatch_file)
                .expect("reclassify must return an outcome");
        assert_eq!(outcome.status, FileReclassifyStatus::Corrupt);
        assert_eq!(file_state(mismatch_file), before_file);
        assert_eq!(resource_state(&mismatch_resource), before_resource);
        let item =
            VfsFolderRepo::get_folder_item_by_item_id_with_conn(&conn, "file", mismatch_file)
                .unwrap()
                .expect("folder membership must remain a file");
        assert_eq!(item.folder_id.as_deref(), Some(folder.id.as_str()));
        assert!(
            VfsFolderRepo::get_folder_item_by_item_id_with_conn(&conn, "image", mismatch_file)
                .unwrap()
                .is_none()
        );
    }

    // ★ A3: 无内容来源（无 blob 且无 resource）必须 Missing 且零写。
    #[test]
    fn reclassify_missing_inline_resource_returns_missing_without_mutation() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().unwrap();
        let file_id = "file_a3_missing_resource";
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        conn.execute(
            r#"INSERT INTO files (
                id, resource_id, blob_hash, type, name, mime_type, size,
                content_hash, sha256, file_name, created_at, updated_at
            ) VALUES (?1, NULL, NULL, 'file', ?2, 'application/octet-stream', 1, NULL, ?3, ?2, ?4, ?4)"#,
            params![file_id, "Missing Inline", "sha_a3_missing_resource", &now],
        )
        .unwrap();

        let before = VfsFileRepo::get_file_with_conn(&conn, file_id)
            .unwrap()
            .expect("file row must exist");
        let resources_before: i64 = conn
            .query_row("SELECT COUNT(*) FROM resources", [], |row| row.get(0))
            .unwrap();
        let blobs_before: i64 = conn
            .query_row("SELECT COUNT(*) FROM blobs", [], |row| row.get(0))
            .unwrap();

        let outcome =
            VfsFileRepo::reclassify_existing_file_with_conn(&conn, db.blobs_dir(), file_id)
                .expect("reclassify must return an outcome");
        assert_eq!(outcome.status, FileReclassifyStatus::Missing);
        let returned = outcome
            .file
            .expect("missing status keeps the current record");
        assert_eq!(returned.id, before.id);
        assert_eq!(returned.mime_type, before.mime_type);
        assert_eq!(returned.file_type, before.file_type);
        assert_eq!(returned.updated_at, before.updated_at);

        let after = VfsFileRepo::get_file_with_conn(&conn, file_id)
            .unwrap()
            .expect("file row must remain");
        assert_eq!(after.mime_type, before.mime_type);
        assert_eq!(after.file_type, before.file_type);
        assert_eq!(after.updated_at, before.updated_at);
        let resources_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM resources", [], |row| row.get(0))
            .unwrap();
        let blobs_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM blobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(resources_after, resources_before);
        assert_eq!(blobs_after, blobs_before);
    }

    /// Test seam for the A3 import sequence (blob write + file/folder record).
    ///
    /// Blob is stored from verified content with `verified_*`; the record path
    /// is now the verified-folder API, which re-detects from `data` and must
    /// override the deliberately wrong `declared_*` fallback. The prior RED
    /// used `create_file_in_folder_with_conn` here; only this body was replaced
    /// (interface substitution), never the tests' assertions.
    fn import_verified_file_into_folder(
        db: &VfsDatabase,
        folder_id: &str,
        file_name: &str,
        data: &[u8],
        verified_mime: &str,
        verified_extension: &str,
        declared_mime: &str,
        declared_file_type: &str,
    ) -> VfsResult<VfsFile> {
        let blob =
            VfsBlobRepo::store_blob(db, data, Some(verified_mime), Some(verified_extension))?;
        let result = VfsFileRepo::create_file_in_folder_from_verified_bytes(
            db,
            &blob.hash,
            file_name,
            data.len() as i64,
            declared_file_type,
            Some(declared_mime),
            Some(&blob.hash),
            None,
            Some(folder_id),
            data,
        );
        match &result {
            Ok(outcome) if outcome.created => {}
            // 与生产 handler 一致：命中去重条目或失败时归还本次 store_blob 引用。
            _ => {
                let _ = VfsBlobRepo::decrement_ref(db, &blob.hash);
            }
        }
        result.map(|outcome| outcome.file)
    }

    #[test]
    fn import_verified_png_into_folder_corrects_files_resources_and_folder_category() {
        use crate::vfs::types::VfsFolder;

        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().unwrap();
        let folder = VfsFolder::new("A3 新导入图片".to_string(), None, None, None);
        VfsFolderRepo::create_folder_with_conn(&conn, &folder).unwrap();

        let png = real_png_fixture();
        let expected_sha = VfsBlobRepo::compute_hash(&png);
        let imported = import_verified_file_into_folder(
            &db,
            &folder.id,
            "Opaque Capture",
            &png,
            "image/png",
            "png",
            "application/octet-stream",
            "file",
        )
        .expect("verified import must create the file row");

        assert_eq!(
            imported.sha256, expected_sha,
            "内容 hash 必须来自真实 bytes"
        );
        assert_eq!(imported.file_name, "Opaque Capture");
        assert_eq!(imported.size, png.len() as i64);
        assert_eq!(
            imported.mime_type.as_deref(),
            Some("image/png"),
            "识别出的 MIME 必须写回 files.mime_type，不能沿用调用方 octet-stream"
        );
        assert_eq!(
            imported.file_type, "image",
            "识别出的类别必须写回 files.type，不能沿用调用方 file"
        );

        let resource_id = imported
            .resource_id
            .as_deref()
            .expect("new file must have a resources mirror");
        let (resource_type, metadata_json): (String, Option<String>) = conn
            .query_row(
                "SELECT type, metadata_json FROM resources WHERE id = ?1",
                params![resource_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            resource_type, "image",
            "resources 镜像类别必须与 files.type 一致"
        );
        let metadata: serde_json::Value =
            serde_json::from_str(metadata_json.as_deref().unwrap_or("{}")).unwrap();
        assert_eq!(
            metadata.get("mimeType").and_then(|value| value.as_str()),
            Some("image/png"),
            "resources.metadata_json 必须镜像识别出的 MIME"
        );

        let image_item =
            VfsFolderRepo::get_folder_item_by_item_id_with_conn(&conn, "image", &imported.id)
                .unwrap()
                .expect("新导入图片必须落在 image 目录项");
        assert_eq!(image_item.folder_id.as_deref(), Some(folder.id.as_str()));
        assert!(
            VfsFolderRepo::get_folder_item_by_item_id_with_conn(&conn, "file", &imported.id)
                .unwrap()
                .is_none(),
            "不得同时留下 file 目录项"
        );
        let folder_item_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM folder_items WHERE item_id = ?1",
                params![imported.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(folder_item_count, 1, "同一文件只能有一个目录项");
    }

    #[test]
    fn generic_mime_svg_name_never_falls_back_to_weak_text_or_xml() {
        use crate::vfs::types::VfsFolder;

        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().unwrap();
        let folder = VfsFolder::new("A3 SVG 弱文本".to_string(), None, None, None);
        VfsFolderRepo::create_folder_with_conn(&conn, &folder).unwrap();

        let svg = real_svg_fixture();
        let imported = import_verified_file_into_folder(
            &db,
            &folder.id,
            "x.svg",
            &svg,
            "application/octet-stream",
            "bin",
            "application/octet-stream",
            "file",
        )
        .expect("generic-MIME SVG import must create the file row");

        // 允许保持 generic file，或按名称映射为 svg/image；绝不能被弱文本
        // 启发式改成 text/plain 或 application/xml。
        assert_ne!(
            imported.mime_type.as_deref(),
            Some("text/plain"),
            "弱文本检测不得覆盖 .svg 名称"
        );
        assert_ne!(
            imported.mime_type.as_deref(),
            Some("application/xml"),
            "弱 XML 检测不得覆盖 .svg 名称"
        );
        assert!(
            matches!(
                imported.mime_type.as_deref(),
                Some("image/svg+xml") | Some("application/octet-stream") | None
            ),
            "SVG 只能保持 generic file 或映射为 svg/image，got {:?}",
            imported.mime_type
        );
        assert!(
            imported.file_type == "file" || imported.file_type == "image",
            "弱文本不得把 SVG 落成 document，got {}",
            imported.file_type
        );
        assert_eq!(imported.file_name, "x.svg", "不得改用户名称");
    }

    #[test]
    fn reclassify_image_svg_is_not_downgraded_by_weak_text_detection() {
        use crate::vfs::file_reclassify::FileReclassifyStatus;
        use crate::vfs::repos::resource_repo::VfsResourceRepo;
        use crate::vfs::types::VfsFolder;

        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().unwrap();
        let folder = VfsFolder::new("A3 SVG 重识别".to_string(), None, None, None);
        VfsFolderRepo::create_folder_with_conn(&conn, &folder).unwrap();

        let svg = real_svg_fixture();
        let svg_sha = VfsBlobRepo::compute_hash(&svg);
        let blob = VfsBlobRepo::store_blob(&db, &svg, Some("image/svg+xml"), Some("svg")).unwrap();
        let file = VfsFileRepo::create_file_in_folder_with_conn(
            &conn,
            &svg_sha,
            "vector.svg",
            svg.len() as i64,
            "image",
            Some("image/svg+xml"),
            Some(&blob.hash),
            None,
            Some(&folder.id),
        )
        .unwrap();
        // create_file_in_folder 的目录项固定为 file；先校准成已有的正确 image 状态。
        conn.execute(
            "UPDATE folder_items SET item_type = 'image' WHERE item_id = ?1",
            params![file.id.as_str()],
        )
        .unwrap();
        VfsFileRepo::set_favorite_with_conn(&conn, &file.id, true).unwrap();
        let resource_id = file.resource_id.clone().unwrap();
        assert_eq!(
            VfsResourceRepo::increment_ref_with_conn(&conn, &resource_id).unwrap(),
            1
        );
        let before = VfsFileRepo::get_file_with_conn(&conn, &file.id)
            .unwrap()
            .unwrap();

        let outcome =
            VfsFileRepo::reclassify_existing_file_with_conn(&conn, db.blobs_dir(), &file.id)
                .expect("reclassify must return an outcome");
        assert_eq!(outcome.status, FileReclassifyStatus::Recognized);
        let reclassified = outcome.file.expect("recognized keeps the file");

        assert_eq!(
            reclassified.mime_type.as_deref(),
            Some("image/svg+xml"),
            "既有 image/svg+xml 不得被弱 xml/txt 检测降级"
        );
        assert_eq!(reclassified.file_type, "image", "SVG 类别必须保持 image");
        assert_eq!(reclassified.id, before.id);
        assert_eq!(reclassified.sha256, before.sha256);
        assert_eq!(reclassified.blob_hash, before.blob_hash);
        assert_eq!(reclassified.size, before.size);
        assert_eq!(reclassified.file_name, "vector.svg");
        assert!(reclassified.is_favorite);
        let membership =
            VfsFolderRepo::get_folder_item_by_item_id_with_conn(&conn, "image", &file.id)
                .unwrap()
                .expect("原目录项必须保持 image");
        assert_eq!(membership.folder_id.as_deref(), Some(folder.id.as_str()));
        assert!(
            VfsFolderRepo::get_folder_item_by_item_id_with_conn(&conn, "file", &file.id)
                .unwrap()
                .is_none(),
            "不得新增 file 目录项"
        );
        let ref_count: i32 = conn
            .query_row(
                "SELECT ref_count FROM resources WHERE id = ?1",
                params![resource_id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ref_count, 1, "重识别必须保留资源引用计数");
    }

    #[test]
    fn low_level_verified_bytes_rejects_size_and_blob_mismatch_without_writes() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().unwrap();
        let png = real_png_fixture();
        let blob = VfsBlobRepo::store_blob(&db, &png, Some("image/png"), Some("png")).unwrap();
        let row_counts = |conn: &rusqlite::Connection| -> (i64, i64) {
            (
                conn.query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
                    .unwrap(),
                conn.query_row("SELECT COUNT(*) FROM resources", [], |row| row.get(0))
                    .unwrap(),
            )
        };
        let before = row_counts(&conn);

        let size_mismatch = VfsFileRepo::create_file_from_verified_bytes_with_conn(
            &conn,
            &blob.hash,
            "x.png",
            png.len() as i64 + 1,
            "image",
            Some("image/png"),
            Some(&blob.hash),
            None,
            &png,
        );
        assert!(size_mismatch.is_err(), "size 与 data 不一致必须拒绝");
        assert_eq!(row_counts(&conn), before, "size 校验失败必须零写");

        let blob_mismatch = VfsFileRepo::create_file_from_verified_bytes_with_conn(
            &conn,
            &blob.hash,
            "x.png",
            png.len() as i64,
            "image",
            Some("image/png"),
            Some("deadbeef"),
            None,
            &png,
        );
        assert!(
            blob_mismatch.is_err(),
            "blob_hash 与 data/sha 不一致必须拒绝"
        );
        assert_eq!(row_counts(&conn), before, "blob 元组校验失败必须零写");
    }

    #[test]
    fn import_verified_png_dedups_legacy_generic_file_and_preserves_identity() {
        use crate::vfs::repos::resource_repo::VfsResourceRepo;
        use crate::vfs::types::VfsFolder;

        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().unwrap();
        let folder = VfsFolder::new("A3 旧 generic 条目".to_string(), None, None, None);
        VfsFolderRepo::create_folder_with_conn(&conn, &folder).unwrap();

        let png = real_png_fixture();
        let png_sha = VfsBlobRepo::compute_hash(&png);
        let legacy_blob =
            VfsBlobRepo::store_blob(&db, &png, Some("application/octet-stream"), Some("bin"))
                .unwrap();
        let legacy = VfsFileRepo::create_file_in_folder_with_conn(
            &conn,
            &png_sha,
            "Whiteboard Capture",
            png.len() as i64,
            "file",
            Some("application/octet-stream"),
            Some(&legacy_blob.hash),
            None,
            Some(&folder.id),
        )
        .unwrap();
        VfsFileRepo::set_favorite_with_conn(&conn, &legacy.id, true).unwrap();
        let resource_id = legacy.resource_id.clone().unwrap();
        assert_eq!(
            VfsResourceRepo::increment_ref_with_conn(&conn, &resource_id).unwrap(),
            1
        );
        let before = VfsFileRepo::get_file_with_conn(&conn, &legacy.id)
            .unwrap()
            .unwrap();

        let reimported = import_verified_file_into_folder(
            &db,
            &folder.id,
            "Whiteboard Capture",
            &png,
            "image/png",
            "png",
            "application/octet-stream",
            "file",
        )
        .expect("verified dedup must return the existing file");

        assert_eq!(reimported.id, before.id, "A3 必须保留原文件 ID");
        assert_eq!(reimported.sha256, before.sha256, "A3 必须保留内容 hash");
        assert_eq!(reimported.blob_hash, before.blob_hash);
        let blob_ref_count: i32 = conn
            .query_row(
                "SELECT ref_count FROM blobs WHERE hash = ?1",
                params![png_sha.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(blob_ref_count, 1, "重复导入同一内容不得让 blob ref 每次 +1");
        assert_eq!(
            reimported.file_name, before.file_name,
            "A3 不得默认改用户名称"
        );
        assert!(reimported.is_favorite, "A3 必须保留收藏状态");
        assert_eq!(
            reimported.resource_id.as_deref(),
            Some(resource_id.as_str()),
            "A3 必须保留 resources 身份"
        );
        assert_eq!(
            reimported.mime_type.as_deref(),
            Some("image/png"),
            "去重命中旧 generic 条目时必须用已验证 bytes 回填 MIME"
        );
        assert_eq!(
            reimported.file_type, "image",
            "去重命中旧 generic 条目时必须同步文件类别"
        );

        let (resource_type, metadata_json): (String, Option<String>) = conn
            .query_row(
                "SELECT type, metadata_json FROM resources WHERE id = ?1",
                params![resource_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(resource_type, "image", "resources 镜像类别必须同步");
        let metadata: serde_json::Value =
            serde_json::from_str(metadata_json.as_deref().unwrap_or("{}")).unwrap();
        assert_eq!(
            metadata.get("mimeType").and_then(|value| value.as_str()),
            Some("image/png"),
            "resources.metadata_json 必须镜像识别出的 MIME"
        );
        let ref_count: i32 = conn
            .query_row(
                "SELECT ref_count FROM resources WHERE id = ?1",
                params![resource_id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ref_count, 1, "A3 必须保留引用计数");

        let image_item =
            VfsFolderRepo::get_folder_item_by_item_id_with_conn(&conn, "image", &before.id)
                .unwrap()
                .expect("类别同步后目录项必须为 image");
        assert_eq!(
            image_item.folder_id.as_deref(),
            Some(folder.id.as_str()),
            "A3 必须保留目录归属"
        );
        assert!(
            VfsFolderRepo::get_folder_item_by_item_id_with_conn(&conn, "file", &before.id)
                .unwrap()
                .is_none(),
            "类别同步后不得残留 file 目录项"
        );
        let folder_item_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM folder_items WHERE item_id = ?1",
                params![before.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(folder_item_count, 1, "去重重导入不得复制目录项");
    }

    #[test]
    fn verified_folder_api_rejects_unverified_tuple_and_ink_without_writes() {
        use crate::vfs::types::VfsFolder;

        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().unwrap();
        let folder = VfsFolder::new("A3 验证失败".to_string(), None, None, None);
        VfsFolderRepo::create_folder_with_conn(&conn, &folder).unwrap();
        let row_counts = |conn: &rusqlite::Connection| -> (i64, i64, i64) {
            (
                conn.query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
                    .unwrap(),
                conn.query_row("SELECT COUNT(*) FROM resources", [], |row| row.get(0))
                    .unwrap(),
                conn.query_row("SELECT COUNT(*) FROM folder_items", [], |row| row.get(0))
                    .unwrap(),
            )
        };

        let png = real_png_fixture();
        let blob = VfsBlobRepo::store_blob(&db, &png, Some("image/png"), Some("png")).unwrap();
        let before = row_counts(&conn);

        let bad_sha = VfsFileRepo::create_file_in_folder_from_verified_bytes_with_conn(
            &conn,
            "deadbeef",
            "Opaque Capture",
            png.len() as i64,
            "image",
            Some("image/png"),
            Some(&blob.hash),
            None,
            Some(&folder.id),
            &png,
        );
        assert!(bad_sha.is_err(), "sha 与 data 不一致必须拒绝");
        assert_eq!(
            row_counts(&conn),
            before,
            "校验失败不得写入 files/resources/folder_items"
        );

        let bad_size = VfsFileRepo::create_file_in_folder_from_verified_bytes_with_conn(
            &conn,
            &blob.hash,
            "Opaque Capture",
            png.len() as i64 + 1,
            "image",
            Some("image/png"),
            Some(&blob.hash),
            None,
            Some(&folder.id),
            &png,
        );
        assert!(bad_size.is_err(), "size 与 data 不一致必须拒绝");

        let unstored = b"no blob row for these verified bytes";
        let unstored_hash = VfsBlobRepo::compute_hash(unstored);
        let missing_blob = VfsFileRepo::create_file_in_folder_from_verified_bytes_with_conn(
            &conn,
            &unstored_hash,
            "Missing Blob",
            unstored.len() as i64,
            "file",
            Some("application/octet-stream"),
            Some(&unstored_hash),
            None,
            Some(&folder.id),
            unstored,
        );
        assert!(missing_blob.is_err(), "blob tuple 缺失必须拒绝");
        assert_eq!(row_counts(&conn), before, "blob 校验失败不得写入三张表");

        let ink_bytes = br#"{"ink":{"pages":[]}}"#;
        let ink_blob = VfsBlobRepo::store_blob(
            &db,
            ink_bytes,
            Some("application/octet-stream"),
            Some("bin"),
        )
        .unwrap();
        let ink = VfsFileRepo::create_file_in_folder_from_verified_bytes_with_conn(
            &conn,
            &ink_blob.hash,
            "note.dsink",
            ink_bytes.len() as i64,
            "file",
            Some("application/octet-stream"),
            Some(&ink_blob.hash),
            None,
            Some(&folder.id),
            ink_bytes,
        );
        assert!(ink.is_err(), "新 ID Ink candidate 必须拒绝");
        assert_eq!(
            row_counts(&conn),
            before,
            "Ink 拒绝必须回滚 files/resources/folder_items"
        );
    }

    fn png_crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for &byte in bytes {
            crc ^= byte as u32;
            for _ in 0..8 {
                let mask = (crc & 1).wrapping_neg();
                crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
            }
        }
        !crc
    }

    /// 在真实 PNG 的 IHDR 后插入一个 >64KiB 的合法 tEXt chunk（CRC 正确）。
    fn real_png_with_large_ancillary_chunk() -> Vec<u8> {
        let base = real_png_fixture();
        assert_eq!(
            &base[..8],
            &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A][..]
        );
        assert_eq!(&base[12..16], &b"IHDR"[..]);
        let ihdr_len = u32::from_be_bytes([base[8], base[9], base[10], base[11]]) as usize;
        assert_eq!(ihdr_len, 13);
        let ihdr_end = 8 + 12 + ihdr_len;

        let mut payload = b"Comment\0".to_vec();
        payload.extend(std::iter::repeat(b'A').take(70 * 1024));
        let chunk_type = [b't', b'E', b'X', b't'];
        let mut crc_input = Vec::with_capacity(4 + payload.len());
        crc_input.extend_from_slice(&chunk_type[..]);
        crc_input.extend_from_slice(&payload);

        let mut out = base[..ihdr_end].to_vec();
        out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        out.extend_from_slice(&chunk_type[..]);
        out.extend_from_slice(&payload);
        out.extend_from_slice(&png_crc32(&crc_input).to_be_bytes());
        out.extend_from_slice(&base[ihdr_end..]);
        assert!(out.len() > 64 * 1024);
        out
    }

    // ★ A3: 真实 PNG 带 >64KiB 合法 chunk 时，头部 64KiB 会被截断；
    // 流式 chunk 遍历仍必须识别为有效，不得误拒。
    #[test]
    fn reclassify_accepts_valid_png_with_chunk_larger_than_header_window() {
        use crate::vfs::types::VfsFolder;

        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().unwrap();
        let png = real_png_with_large_ancillary_chunk();
        assert!(
            crate::vfs::file_reclassify::validate_png_structure_bytes(&png).unwrap(),
            "large-chunk fixture must be structurally valid"
        );
        let blob =
            VfsBlobRepo::store_blob(&db, &png, Some("application/octet-stream"), Some("png"))
                .unwrap();
        let folder = VfsFolder::new("A3 Large Chunk".to_string(), None, None, None);
        VfsFolderRepo::create_folder_with_conn(&conn, &folder).unwrap();
        let file = VfsFileRepo::create_file_in_folder_with_conn(
            &conn,
            &blob.hash,
            "Large Chunk",
            png.len() as i64,
            "file",
            Some("application/octet-stream"),
            Some(&blob.hash),
            None,
            Some(&folder.id),
        )
        .unwrap();

        let outcome =
            VfsFileRepo::reclassify_existing_file_with_conn(&conn, db.blobs_dir(), &file.id)
                .expect("valid large-chunk PNG must be recognized");
        assert_eq!(outcome.status, FileReclassifyStatus::Recognized);
        let file = outcome.file.expect("recognized file");
        assert_eq!(file.mime_type.as_deref(), Some("image/png"));
        assert_eq!(file.file_type, "image");
    }

    // ★ A3: 软删除文件不得被通用重识别改写类别；否则 folder_items 从
    // file 变 image 后，restore 只恢复 file 类别会丢失目录归属。
    #[test]
    fn reclassify_rejects_soft_deleted_file_without_touching_membership() {
        use crate::vfs::types::VfsFolder;

        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn_safe().unwrap();
        let png = real_png_fixture();
        let blob =
            VfsBlobRepo::store_blob(&db, &png, Some("application/octet-stream"), Some("png"))
                .unwrap();
        let folder = VfsFolder::new("A3 Trash Guard".to_string(), None, None, None);
        VfsFolderRepo::create_folder_with_conn(&conn, &folder).unwrap();
        let file = VfsFileRepo::create_file_in_folder_with_conn(
            &conn,
            &blob.hash,
            "Trashed Image",
            png.len() as i64,
            "file",
            Some("application/octet-stream"),
            Some(&blob.hash),
            None,
            Some(&folder.id),
        )
        .unwrap();
        let resource_id = file.resource_id.clone().expect("file resource");
        VfsFileRepo::delete_file_with_conn(&conn, &file.id).unwrap();

        let file_before: (Option<String>, String, String, Option<String>, String) = conn
            .query_row(
                "SELECT mime_type, type, status, deleted_at, updated_at FROM files WHERE id = ?1",
                params![&file.id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        let item_before: (String, Option<String>, Option<String>, Option<i64>, i32, Option<String>) =
            conn.query_row(
                "SELECT item_type, folder_id, deleted_at, updated_at, sort_order, cached_path FROM folder_items WHERE item_id = ?1",
                params![&file.id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        let resource_before: (String, Option<String>, i64, String, Option<String>) = conn
            .query_row(
                "SELECT type, metadata_json, updated_at, hash, data FROM resources WHERE id = ?1",
                params![&resource_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(file_before.2, "deleted");

        let result =
            VfsFileRepo::reclassify_existing_file_with_conn(&conn, db.blobs_dir(), &file.id);
        match result {
            Ok(outcome) => assert_eq!(
                outcome.status,
                FileReclassifyStatus::Missing,
                "soft-deleted file must be Missing, not reclassified"
            ),
            Err(err) => assert!(
                matches!(&err, VfsError::InvalidState { .. }),
                "soft-deleted file must be Missing or explicitly refused with InvalidState, got {err:?}"
            ),
        }

        let file_after: (Option<String>, String, String, Option<String>, String) = conn
            .query_row(
                "SELECT mime_type, type, status, deleted_at, updated_at FROM files WHERE id = ?1",
                params![&file.id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        let item_after: (String, Option<String>, Option<String>, Option<i64>, i32, Option<String>) =
            conn.query_row(
                "SELECT item_type, folder_id, deleted_at, updated_at, sort_order, cached_path FROM folder_items WHERE item_id = ?1",
                params![&file.id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        let resource_after: (String, Option<String>, i64, String, Option<String>) = conn
            .query_row(
                "SELECT type, metadata_json, updated_at, hash, data FROM resources WHERE id = ?1",
                params![&resource_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(file_after, file_before);
        assert_eq!(item_after, item_before);
        assert_eq!(resource_after, resource_before);

        VfsFileRepo::restore_file_with_conn(&conn, &file.id).unwrap();
        let restored = VfsFolderRepo::get_folder_item_by_item_id_with_conn(&conn, "file", &file.id)
            .unwrap()
            .expect("restore must keep the file membership");
        assert_eq!(restored.folder_id.as_deref(), Some(folder.id.as_str()));
    }
}
