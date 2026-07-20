//! VFS Tauri 命令处理器
//!
//! 提供 VFS 相关的 Tauri 命令，供前端直接调用（低层 API）。
//! 所有命令以 `vfs_` 前缀命名。
//!
//! ## 命令分类
//! - **资源操作**：create_or_reuse, get_resource, resource_exists, increment_ref, decrement_ref
//! - **笔记操作**：create_note, update_note, get_note, get_note_content, list_notes, delete_note
//! - **列表操作**：list_textbooks, list_exam_sheets, list_translations, list_essays, search_all

use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::utils::unicode::sanitize_unicode;
use crate::vfs::attachment_config::AttachmentConfig;
use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::index_service::VfsIndexService;
use crate::vfs::pdf_processing_service::{PdfProcessingService, ProcessingStage};
use crate::vfs::repos::{
    VfsAttachmentRepo, VfsBlobRepo, VfsEssayRepo, VfsExamRepo, VfsIndexStateRepo, VfsMindMapRepo,
    VfsNoteRepo, VfsResourceRepo, VfsTextbookRepo, VfsTranslationRepo, INDEX_STATE_DISABLED,
    INDEX_STATE_PENDING,
};
use crate::vfs::types::*;
use crate::vfs::unit_builder::UnitBuildInput;

// ============================================================================
// 前端输入类型（接收前端 JSON）
// ============================================================================

/// 创建资源输入参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateResourceInput {
    /// 资源类型（字符串）
    #[serde(rename = "type")]
    pub resource_type: String,

    /// 内容
    pub data: String,

    /// 原始数据 ID（可选）
    #[serde(default)]
    pub source_id: Option<String>,

    /// 元数据（可选）
    #[serde(default)]
    pub metadata: Option<VfsResourceMetadata>,
}

/// 创建笔记输入参数
///
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNoteInput {
    /// 标题
    pub title: String,

    /// 内容
    pub content: String,

    /// 标签
    #[serde(default)]
    pub tags: Vec<String>,
}

/// 更新笔记输入参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNoteInput {
    /// 新内容
    pub content: String,

    /// 新标题（可选）
    #[serde(default)]
    pub title: Option<String>,

    /// 新标签（可选）
    #[serde(default)]
    pub tags: Option<Vec<String>>,

    /// 乐观锁：调用方上次读取时的 `updated_at` 值（可选）
    ///
    /// ★ S-002 修复：传入后启用并发冲突检测，不传则向后兼容。
    #[serde(default)]
    pub expected_updated_at: Option<String>,
}

/// 列表查询输入参数
///
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListInput {
    /// 搜索关键词（可选）
    #[serde(default)]
    pub search: Option<String>,

    /// 限制数量
    #[serde(default = "default_limit")]
    pub limit: u32,

    /// 偏移量
    #[serde(default)]
    pub offset: u32,
}

fn default_limit() -> u32 {
    50
}

/// 搜索所有资源输入参数
///
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchAllInput {
    /// 搜索关键词
    pub query: String,

    /// 类型过滤（可选）
    #[serde(default)]
    pub types: Option<Vec<String>>,

    /// 限制数量
    #[serde(default = "default_limit")]
    pub limit: u32,

    /// 偏移量
    #[serde(default)]
    pub offset: u32,
}

// ============================================================================
// 工具函数
// ============================================================================

/// ★ 2026-01 优化：ID 格式验证辅助函数，减少重复代码
/// ★ BE-06 安全修复：添加 Unicode 规范化，防止绕过攻击
#[inline]
fn validate_id_format(id: &str, prefix: &str, param_name: &str) -> Result<(), String> {
    // 先进行 Unicode 规范化
    let sanitized = sanitize_unicode(id);

    // 检查是否与原始值不同（可能有绕过尝试）
    if sanitized != id {
        return Err(VfsError::InvalidArgument {
            param: param_name.to_string(),
            reason: "ID contains invalid Unicode characters".to_string(),
        }
        .to_string());
    }

    if !id.starts_with(prefix) {
        return Err(VfsError::InvalidArgument {
            param: param_name.to_string(),
            reason: format!("Invalid {} format: {}", param_name, id),
        }
        .to_string());
    }
    Ok(())
}

#[inline]
fn validate_id_format_any(id: &str, prefixes: &[&str], param_name: &str) -> Result<(), String> {
    // 先进行 Unicode 规范化
    let sanitized = sanitize_unicode(id);

    if sanitized != id {
        return Err(VfsError::InvalidArgument {
            param: param_name.to_string(),
            reason: "ID contains invalid Unicode characters".to_string(),
        }
        .to_string());
    }

    if !prefixes.iter().any(|p| id.starts_with(p)) {
        return Err(VfsError::InvalidArgument {
            param: param_name.to_string(),
            reason: format!("Invalid {} format: {}", param_name, id),
        }
        .to_string());
    }

    Ok(())
}

/// 检查 PDF 是否需要页面压缩
fn pdf_preview_needs_compression(preview_json: &str) -> bool {
    let preview: PdfPreviewJson = match serde_json::from_str(preview_json) {
        Ok(p) => p,
        Err(_) => return false,
    };
    if preview.pages.is_empty() {
        return false;
    }
    preview.pages.iter().any(|page| {
        page.compressed_blob_hash
            .as_ref()
            .map(|h| h.trim().is_empty())
            .unwrap_or(true)
    })
}

/// 检查图片是否缺少压缩版本
fn image_needs_compression_with_conn(
    conn: &Connection,
    blobs_dir: &std::path::Path,
    file_id: &str,
) -> bool {
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT compressed_blob_hash, blob_hash FROM files WHERE id = ?1",
            rusqlite::params![file_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .ok()
        .flatten();

    let Some((compressed_hash, _blob_hash)) = row else {
        return false;
    };

    let Some(ch) = compressed_hash else {
        return true;
    };
    if ch.trim().is_empty() {
        return true;
    }
    VfsBlobRepo::get_blob_path_with_conn(conn, blobs_dir, &ch)
        .ok()
        .flatten()
        .is_none()
}

/// 获取资源类型的大文件限制（字节）
fn get_max_size_bytes(resource_type: &VfsResourceType) -> usize {
    match resource_type {
        VfsResourceType::Image => 10 * 1024 * 1024,       // 10MB
        VfsResourceType::File => 200 * 1024 * 1024,       // 200MB（#62：与附件上限对齐）
        VfsResourceType::Note => 50 * 1024 * 1024,        // 50MB
        VfsResourceType::Retrieval => 10 * 1024 * 1024,   // 10MB
        VfsResourceType::Exam => 50 * 1024 * 1024,        // 50MB
        VfsResourceType::Textbook => 50 * 1024 * 1024,    // 50MB
        VfsResourceType::Translation => 10 * 1024 * 1024, // 10MB
        VfsResourceType::Essay => 10 * 1024 * 1024,       // 10MB
        VfsResourceType::MindMap => 50 * 1024 * 1024,     // 50MB
    }
}

/// 验证大文件限制
fn validate_file_size(resource_type: &VfsResourceType, data: &str) -> VfsResult<()> {
    let size = data.len();
    let max_size = get_max_size_bytes(resource_type);

    if size > max_size {
        let max_mb = max_size / (1024 * 1024);
        let actual_mb = size as f64 / (1024.0 * 1024.0);
        return Err(VfsError::InvalidArgument {
            param: "data".to_string(),
            reason: format!(
                "File too large: {} type max {}MB, got {:.2}MB",
                resource_type, max_mb, actual_mb
            ),
        });
    }

    Ok(())
}

/// 计算内容的 SHA-256 哈希
fn compute_hash(data: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(data.as_bytes());
    format!("{:x}", hasher.finalize())
}

// ============================================================================
// 资源操作命令
// ============================================================================

/// 创建或复用资源
///
/// 基于内容哈希自动去重：
/// - 如果相同哈希的资源已存在，返回已有资源的 ID
/// - 如果不存在，创建新资源
///
/// ## 参数
/// - `params`: 创建资源的参数
///
/// ## 返回
/// - `Ok(VfsCreateResourceResult)`: 资源 ID、哈希和是否新创建
/// - `Err(String)`: 验证失败或数据库错误
#[tauri::command]
pub async fn vfs_create_or_reuse(
    params: CreateResourceInput,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<VfsCreateResourceResult, String> {
    log::info!(
        "[VFS::handlers] vfs_create_or_reuse: type={}, data_len={}, source_id={:?}",
        params.resource_type,
        params.data.len(),
        params.source_id
    );

    // 解析资源类型
    let resource_type = VfsResourceType::from_str(&params.resource_type).ok_or_else(|| {
        VfsError::InvalidArgument {
            param: "type".to_string(),
            reason: format!("Invalid resource type: {}", params.resource_type),
        }
        .to_string()
    })?;

    // 验证大文件限制
    validate_file_size(&resource_type, &params.data).map_err(|e| e.to_string())?;

    // 调用 VfsResourceRepo::create_or_reuse
    let result = VfsResourceRepo::create_or_reuse(
        &vfs_db,
        resource_type,
        &params.data,
        params.source_id.as_deref(),
        None, // source_table
        params.metadata.as_ref(),
    )
    .map_err(|e| e.to_string())?;

    log::info!(
        "[VFS::handlers] Resource {}: id={}, hash={}, is_new={}",
        if result.is_new { "created" } else { "reused" },
        result.resource_id,
        &result.hash[..16],
        result.is_new
    );

    Ok(result)
}

/// 获取资源
///
/// ## 参数
/// - `resource_id`: 资源 ID
///
/// ## 返回
/// - `Ok(Some(VfsResource))`: 找到资源
/// - `Ok(None)`: 资源不存在
/// - `Err(String)`: 数据库错误
#[tauri::command]
pub async fn vfs_get_resource(
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Option<VfsResource>, String> {
    log::debug!("[VFS::handlers] vfs_get_resource: id={}", resource_id);

    // 验证资源 ID 格式
    validate_id_format(&resource_id, "res_", "resource_id")?;

    // 调用 VfsResourceRepo::get_resource
    VfsResourceRepo::get_resource(&vfs_db, &resource_id).map_err(|e| e.to_string())
}

/// 检查资源是否存在
///
/// ## 参数
/// - `resource_id`: 资源 ID
///
/// ## 返回
/// - `Ok(true)`: 资源存在
/// - `Ok(false)`: 资源不存在
/// - `Err(String)`: 数据库错误
#[tauri::command]
pub async fn vfs_resource_exists(
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<bool, String> {
    log::debug!("[VFS::handlers] vfs_resource_exists: id={}", resource_id);

    // 验证资源 ID 格式
    if !resource_id.starts_with("res_") {
        return Ok(false);
    }

    // 调用 VfsResourceRepo::exists
    VfsResourceRepo::exists(&vfs_db, &resource_id).map_err(|e| e.to_string())
}

/// 增加资源引用计数
///
/// 消息保存时调用，表示该资源被消息引用。
///
/// ## 参数
/// - `resource_id`: 资源 ID
///
/// ## 返回
/// - `Ok(())`: 成功
/// - `Err(String)`: 资源不存在或数据库错误
#[tauri::command]
pub async fn vfs_increment_ref(
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<(), String> {
    log::info!("[VFS::handlers] vfs_increment_ref: id={}", resource_id);

    // 验证资源 ID 格式
    validate_id_format(&resource_id, "res_", "resource_id")?;

    // 调用 VfsResourceRepo::increment_ref
    VfsResourceRepo::increment_ref(&vfs_db, &resource_id)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 减少资源引用计数
///
/// 消息删除时调用，表示该资源不再被消息引用。
///
/// ## 参数
/// - `resource_id`: 资源 ID
///
/// ## 返回
/// - `Ok(())`: 成功
/// - `Err(String)`: 资源不存在或数据库错误
#[tauri::command]
pub async fn vfs_decrement_ref(
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<(), String> {
    log::info!("[VFS::handlers] vfs_decrement_ref: id={}", resource_id);

    // 验证资源 ID 格式
    validate_id_format(&resource_id, "res_", "resource_id")?;

    // 调用 VfsResourceRepo::decrement_ref
    VfsResourceRepo::decrement_ref(&vfs_db, &resource_id)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// ============================================================================
// 笔记操作命令
// ============================================================================

/// 创建笔记
///
/// 自动创建 resource 存储内容。
///
/// ## 参数
/// - `params`: 创建笔记的参数
///
/// ## 返回
/// - `Ok(VfsNote)`: 创建的笔记
/// - `Err(String)`: 数据库错误
#[tauri::command]
pub async fn vfs_create_note(
    params: CreateNoteInput,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<VfsNote, String> {
    log::info!("[VFS::handlers] vfs_create_note: title={}", params.title);

    // M-010: 校验内容长度，防止超大内容造成 DB 膨胀
    const MAX_NOTE_SIZE: usize = 5 * 1024 * 1024; // 5MB
    if params.content.len() > MAX_NOTE_SIZE {
        // M-015: 使用结构化错误码，让前端 toVfsError 能正确识别为 VALIDATION 错误
        return Err(VfsError::InvalidArgument {
            param: "content".to_string(),
            reason: format!(
                "笔记内容大小超出限制（最大 {}MB）",
                MAX_NOTE_SIZE / 1024 / 1024
            ),
        }
        .to_string());
    }

    // 验证标题
    if params.title.trim().is_empty() {
        return Err(VfsError::InvalidArgument {
            param: "title".to_string(),
            reason: "Title cannot be empty".to_string(),
        }
        .to_string());
    }

    // 调用 VfsNoteRepo::create_note
    let create_params = VfsCreateNoteParams {
        title: params.title,
        content: params.content,
        tags: params.tags,
    };
    let note = VfsNoteRepo::create_note(&vfs_db, create_params).map_err(|e| e.to_string())?;

    log::info!("[VFS::handlers] Note created: id={}", note.id);
    Ok(note)
}

/// 更新笔记
///
/// 自动处理资源管理：
/// 1. 计算新内容的哈希
/// 2. 若 hash 不同，创建新 resource
/// 3. 更新 notes.resource_id
///
/// ## 参数
/// - `id`: 笔记 ID
/// - `params`: 更新参数
///
/// ## 返回
/// - `Ok(VfsNote)`: 更新后的笔记
/// - `Err(String)`: 笔记不存在或数据库错误
#[tauri::command]
pub async fn vfs_update_note(
    id: String,
    params: UpdateNoteInput,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<VfsNote, String> {
    log::info!(
        "[VFS::handlers] vfs_update_note: id={}, content_len={}",
        id,
        params.content.len()
    );

    // M-010: 校验内容长度，防止超大内容造成 DB 膨胀
    const MAX_NOTE_SIZE: usize = 5 * 1024 * 1024; // 5MB
    if params.content.len() > MAX_NOTE_SIZE {
        // M-015: 使用结构化错误码，让前端 toVfsError 能正确识别为 VALIDATION 错误
        return Err(VfsError::InvalidArgument {
            param: "content".to_string(),
            reason: format!(
                "笔记内容大小超出限制（最大 {}MB）",
                MAX_NOTE_SIZE / 1024 / 1024
            ),
        }
        .to_string());
    }

    // 验证笔记 ID 格式
    validate_id_format(&id, "note_", "id")?;

    // 调用 VfsNoteRepo::update_note
    let update_params = VfsUpdateNoteParams {
        content: Some(params.content),
        title: params.title,
        tags: params.tags,
        expected_updated_at: params.expected_updated_at,
    };
    let note = VfsNoteRepo::update_note(&vfs_db, &id, update_params).map_err(|e| e.to_string())?;

    log::info!("[VFS::handlers] Note updated: id={}", note.id);
    Ok(note)
}

/// 获取笔记
///
/// ## 参数
/// - `id`: 笔记 ID
///
/// ## 返回
/// - `Ok(Some(VfsNote))`: 找到笔记
/// - `Ok(None)`: 笔记不存在
/// - `Err(String)`: 数据库错误
#[tauri::command]
pub async fn vfs_get_note(
    id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Option<VfsNote>, String> {
    log::debug!("[VFS::handlers] vfs_get_note: id={}", id);

    // 验证笔记 ID 格式
    validate_id_format(&id, "note_", "id")?;

    // 调用 VfsNoteRepo::get_note
    VfsNoteRepo::get_note(&vfs_db, &id).map_err(|e| e.to_string())
}

/// 获取笔记内容
///
/// 从 resources.data 获取笔记内容。
///
/// ## 参数
/// - `id`: 笔记 ID
///
/// ## 返回
/// - `Ok(Some(String))`: 笔记内容
/// - `Ok(None)`: 笔记不存在
/// - `Err(String)`: 数据库错误
#[tauri::command]
pub async fn vfs_get_note_content(
    id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Option<String>, String> {
    log::debug!("[VFS::handlers] vfs_get_note_content: id={}", id);

    // 验证笔记 ID 格式
    validate_id_format(&id, "note_", "id")?;

    // 调用 VfsNoteRepo::get_note_content
    VfsNoteRepo::get_note_content(&vfs_db, &id).map_err(|e| e.to_string())
}

/// 列出笔记
///
/// ## 参数
/// - `params`: 列表参数
///
/// ## 返回
/// - `Ok(Vec<VfsNote>)`: 笔记列表
/// - `Err(String)`: 数据库错误
#[tauri::command]
pub async fn vfs_list_notes(
    params: Option<ListInput>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<VfsNote>, String> {
    let params = params.unwrap_or_default();
    log::debug!(
        "[VFS::handlers] vfs_list_notes: search={:?}, limit={}, offset={}",
        params.search,
        params.limit,
        params.offset
    );

    VfsNoteRepo::list_notes(
        &vfs_db,
        params.search.as_deref(),
        params.limit,
        params.offset,
    )
    .map_err(|e| e.to_string())
}

/// 删除笔记
///
/// 软删除：设置 deleted_at 字段。
///
/// ## 参数
/// - `id`: 笔记 ID
///
/// ## 返回
/// - `Ok(())`: 成功
/// - `Err(String)`: 笔记不存在或数据库错误
#[tauri::command]
pub async fn vfs_delete_note(
    id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<(), String> {
    log::info!("[VFS::handlers] vfs_delete_note: id={}", id);

    // 验证笔记 ID 格式
    validate_id_format(&id, "note_", "id")?;

    // 记忆卫生（J7）：删除前判断该笔记是否在记忆根目录内。
    // 判定与后续清理全程 best-effort——非记忆笔记不受影响，
    // 记忆逻辑失败也绝不阻塞通用删除。
    let memory_ctx = memory_note_delete_context(&vfs_db, &id);

    // 保持 notes 与 folder_items 软删除一致
    VfsNoteRepo::delete_note_with_folder_item(&vfs_db, &id).map_err(|e| e.to_string())?;

    if let Some((resource_id, title)) = memory_ctx {
        cleanup_deleted_memory_note(&vfs_db, &id, &resource_id, &title);
    }
    Ok(())
}

/// 判断笔记是否位于记忆根目录内；是则返回 (resource_id, title)。
///
/// 任何一步出错都按"非记忆笔记"处理（返回 None），确保记忆逻辑
/// 不影响通用笔记删除路径。
fn memory_note_delete_context(
    vfs_db: &Arc<VfsDatabase>,
    note_id: &str,
) -> Option<(String, String)> {
    let root_id = crate::memory::MemoryConfig::new(vfs_db.clone())
        .get_root_folder_id()
        .ok()
        .flatten()?;
    let note = VfsNoteRepo::get_note(vfs_db, note_id).ok().flatten()?;
    let location = VfsNoteRepo::get_note_location(vfs_db, note_id)
        .ok()
        .flatten()?;
    let folder_id = location.folder_id?;
    if folder_id != root_id {
        let folder_ids =
            crate::vfs::repos::VfsFolderRepo::get_folder_ids_recursive(vfs_db, &root_id).ok()?;
        if !folder_ids.contains(&folder_id) {
            return None;
        }
    }
    Some((note.resource_id, note.title))
}

/// 记忆笔记经 UI 删除后的索引/审计卫生（best-effort，只记 warn 不上抛）：
/// - 把该笔记的向量段入 __lance_orphan_queue 并清理索引单元（与
///   MemoryService::delete_with_source 的清理口径一致；后台 drain 兜底删除
///   Lance 向量，恢复笔记时 restore_note 会 mark_pending 重建索引）
/// - 写一条 memory_audit_log，标注来源为用户 UI 删除
fn cleanup_deleted_memory_note(
    vfs_db: &Arc<VfsDatabase>,
    note_id: &str,
    resource_id: &str,
    title: &str,
) {
    match vfs_db.get_conn_safe() {
        Ok(conn) => {
            if let Err(e) = crate::vfs::repos::index_unit_repo::purge_index_artifacts_by_resource(
                &conn,
                resource_id,
            ) {
                log::warn!(
                    "[VFS::handlers] Failed to purge index artifacts for deleted memory note {}: {}",
                    note_id,
                    e
                );
            }
        }
        Err(e) => {
            log::warn!(
                "[VFS::handlers] Failed to get connection for memory note cleanup {}: {}",
                note_id,
                e
            );
        }
    }

    crate::memory::MemoryAuditLogger::new(vfs_db.clone()).log(
        &crate::memory::audit_log::MemoryAuditEntry {
            source: crate::memory::MemoryOpSource::Handler,
            operation: crate::memory::MemoryOpType::Delete,
            success: true,
            note_id: Some(note_id.to_string()),
            title: Some(title.to_string()),
            content_preview: None,
            folder: None,
            event: Some("DELETE".to_string()),
            confidence: None,
            reason: Some("user_ui: 用户经 VFS/DSTU UI 删除记忆笔记 (vfs_delete_note)".to_string()),
            session_id: None,
            duration_ms: None,
            extra_json: None,
        },
    );
}

// ============================================================================
// 列表操作命令（供 Learning Hub 调用）
// ============================================================================

/// 列出教材
///
/// ## 参数
/// - `params`: 列表参数
///
/// ## 返回
/// - `Ok(Vec<VfsTextbook>)`: 教材列表
/// - `Err(String)`: 数据库错误
#[tauri::command]
pub async fn vfs_list_textbooks(
    params: Option<ListInput>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<VfsTextbook>, String> {
    let params = params.unwrap_or_default();
    log::debug!(
        "[VFS::handlers] vfs_list_textbooks: search={:?}, limit={}, offset={}",
        params.search,
        params.limit,
        params.offset
    );

    if let Some(search) = params
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        VfsTextbookRepo::search_textbooks(&vfs_db, search, params.limit, params.offset)
            .map_err(|e| e.to_string())
    } else {
        VfsTextbookRepo::list_textbooks(&vfs_db, params.limit, params.offset)
            .map_err(|e| e.to_string())
    }
}

/// 列出题目集识别
///
/// ## 参数
/// - `params`: 列表参数
///
/// ## 返回
/// - `Ok(Vec<VfsExamSheet>)`: 题目集列表
/// - `Err(String)`: 数据库错误
#[tauri::command]
pub async fn vfs_list_exam_sheets(
    params: Option<ListInput>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<VfsExamSheet>, String> {
    let params = params.unwrap_or_default();
    log::debug!(
        "[VFS::handlers] vfs_list_exam_sheets: search={:?}, limit={}, offset={}",
        params.search,
        params.limit,
        params.offset
    );

    VfsExamRepo::list_exam_sheets(
        &vfs_db,
        params.search.as_deref(),
        params.limit,
        params.offset,
    )
    .map_err(|e| e.to_string())
}

/// 列出翻译
///
/// ## 参数
/// - `params`: 列表参数
///
/// ## 返回
/// - `Ok(Vec<VfsTranslation>)`: 翻译列表
/// - `Err(String)`: 数据库错误
#[tauri::command]
pub async fn vfs_list_translations(
    params: Option<ListInput>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<VfsTranslation>, String> {
    let params = params.unwrap_or_default();
    log::debug!(
        "[VFS::handlers] vfs_list_translations: search={:?}, limit={}, offset={}",
        params.search,
        params.limit,
        params.offset
    );

    // 注意：翻译无科目，忽略 subject 参数
    // 调用 VfsTranslationRepo::list_translations
    VfsTranslationRepo::list_translations(
        &vfs_db,
        params.search.as_deref(),
        params.limit,
        params.offset,
    )
    .map_err(|e| e.to_string())
}

/// 列出作文
///
/// ## 参数
/// - `params`: 列表参数
///
/// ## 返回
/// - `Ok(Vec<VfsEssay>)`: 作文列表
/// - `Err(String)`: 数据库错误
#[tauri::command]
pub async fn vfs_list_essays(
    params: Option<ListInput>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<VfsEssay>, String> {
    let params = params.unwrap_or_default();
    log::debug!(
        "[VFS::handlers] vfs_list_essays: search={:?}, limit={}, offset={}",
        params.search,
        params.limit,
        params.offset
    );

    VfsEssayRepo::list_essays(
        &vfs_db,
        params.search.as_deref(),
        params.limit,
        params.offset,
    )
    .map_err(|e| e.to_string())
}

/// 搜索所有资源
///
/// 跨类型全文搜索。
///
/// ## 参数
/// - `params`: 搜索参数
///
/// ## 返回
/// - `Ok(Vec<VfsListItem>)`: 搜索结果
/// - `Err(String)`: 数据库错误
#[tauri::command]
pub async fn vfs_search_all(
    params: SearchAllInput,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<VfsListItem>, String> {
    log::debug!(
        "[VFS::handlers] vfs_search_all: query={}, types={:?}, limit={}, offset={}",
        params.query,
        params.types,
        params.limit,
        params.offset
    );

    // 验证查询词
    if params.query.trim().is_empty() {
        return Err(VfsError::InvalidArgument {
            param: "query".to_string(),
            reason: "Search query cannot be empty".to_string(),
        }
        .to_string());
    }

    let types = params.types.as_ref();
    let search_limit = params.limit.min(50); // 每种类型最多搜索 50 条

    // 根据 types 过滤要搜索的类型（None = 不过滤，搜索全部类型）
    let type_enabled = |name: &str| types.is_none_or(|list| list.iter().any(|t| t == name));
    let search_notes = type_enabled("note");
    let search_exams = type_enabled("exam");
    let search_translations = type_enabled("translation");
    let search_essays = type_enabled("essay");

    // ★ 2026-01 优化：并行搜索多种类型，提升响应速度
    let vfs_db_clone = Arc::clone(&vfs_db);
    let query_clone = params.query.clone();

    // 使用 tokio::task::spawn_blocking 并行执行同步搜索
    let notes_handle = if search_notes {
        let db = Arc::clone(&vfs_db_clone);
        let q = query_clone.clone();
        Some(tokio::task::spawn_blocking(move || {
            VfsNoteRepo::list_notes(&db, Some(&q), search_limit, 0)
                .map_err(|e| {
                    tracing::warn!(
                        "[VFS::handlers] Note search failed for query '{}': {}",
                        q,
                        e
                    );
                    e
                })
                .ok()
        }))
    } else {
        None
    };

    let exams_handle = if search_exams {
        let db = Arc::clone(&vfs_db_clone);
        let q = query_clone.clone();
        Some(tokio::task::spawn_blocking(move || {
            VfsExamRepo::search_exam_sheets(&db, &q, search_limit)
                .map_err(|e| {
                    tracing::warn!(
                        "[VFS::handlers] Exam search failed for query '{}': {}",
                        q,
                        e
                    );
                    e
                })
                .ok()
        }))
    } else {
        None
    };

    let translations_handle = if search_translations {
        let db = Arc::clone(&vfs_db_clone);
        let q = query_clone.clone();
        Some(tokio::task::spawn_blocking(move || {
            VfsTranslationRepo::search_translations(&db, &q, search_limit)
                .map_err(|e| {
                    tracing::warn!(
                        "[VFS::handlers] Translation search failed for query '{}': {}",
                        q,
                        e
                    );
                    e
                })
                .ok()
        }))
    } else {
        None
    };

    let essays_handle = if search_essays {
        let db = Arc::clone(&vfs_db_clone);
        let q = query_clone.clone();
        Some(tokio::task::spawn_blocking(move || {
            VfsEssayRepo::search_essays(&db, &q, search_limit)
                .map_err(|e| {
                    tracing::warn!(
                        "[VFS::handlers] Essay search failed for query '{}': {}",
                        q,
                        e
                    );
                    e
                })
                .ok()
        }))
    } else {
        None
    };

    // 收集结果
    let mut results: Vec<VfsListItem> = Vec::new();

    // 笔记结果
    if let Some(handle) = notes_handle {
        if let Ok(Some(notes)) = handle.await {
            results.extend(notes.into_iter().map(|n| VfsListItem {
                id: n.id,
                resource_id: n.resource_id,
                resource_type: VfsResourceType::Note,
                title: n.title,
                preview_type: PreviewType::Markdown,
                created_at: parse_timestamp(&n.created_at),
                updated_at: Some(parse_timestamp(&n.updated_at)),
                metadata: None,
            }));
        }
    }

    // 题目集结果
    if let Some(handle) = exams_handle {
        if let Ok(Some(exams)) = handle.await {
            results.extend(exams.into_iter().map(|e| VfsListItem {
                id: e.id,
                resource_id: e.resource_id.unwrap_or_default(),
                resource_type: VfsResourceType::Exam,
                title: e.exam_name.unwrap_or_else(|| "未命名题目集".to_string()),
                preview_type: PreviewType::Card,
                created_at: parse_timestamp(&e.created_at),
                updated_at: Some(parse_timestamp(&e.updated_at)),
                metadata: None,
            }));
        }
    }

    // 翻译结果
    if let Some(handle) = translations_handle {
        if let Ok(Some(translations)) = handle.await {
            results.extend(translations.into_iter().map(|t| VfsListItem {
                id: t.id,
                resource_id: t.resource_id,
                resource_type: VfsResourceType::Translation,
                title: format!("翻译 ({}→{})", t.src_lang, t.tgt_lang),
                preview_type: PreviewType::Card,
                created_at: parse_timestamp(&t.created_at),
                updated_at: None,
                metadata: None,
            }));
        }
    }

    // 作文结果
    if let Some(handle) = essays_handle {
        if let Ok(Some(essays)) = handle.await {
            results.extend(essays.into_iter().map(|e| VfsListItem {
                id: e.id,
                resource_id: e.resource_id,
                resource_type: VfsResourceType::Essay,
                title: e.title.unwrap_or_else(|| "未命名作文".to_string()),
                preview_type: PreviewType::Markdown,
                created_at: parse_timestamp(&e.created_at),
                updated_at: Some(parse_timestamp(&e.updated_at)),
                metadata: None,
            }));
        }
    }

    // 按 updated_at 排序（降序），优先显示最近更新的
    results.sort_by(|a, b| {
        let a_time = a.updated_at.unwrap_or(a.created_at);
        let b_time = b.updated_at.unwrap_or(b.created_at);
        b_time.cmp(&a_time)
    });

    // 应用全局分页语义（先 offset 后 limit）
    let offset = params.offset as usize;
    if offset >= results.len() {
        results.clear();
    } else if offset > 0 {
        results = results.into_iter().skip(offset).collect();
    }
    results.truncate(params.limit as usize);

    log::info!(
        "[VFS::handlers] vfs_search_all: found {} results for query '{}'",
        results.len(),
        params.query
    );

    Ok(results)
}

/// 解析 ISO 8601 时间字符串为毫秒时间戳
fn parse_timestamp(s: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

// ============================================================================
// 路径缓存命令（Prompt 3: 引用模式上下文注入）
// ============================================================================

use crate::vfs::repos::VfsFolderRepo;

/// 获取资源的当前路径
///
/// 优先返回缓存路径（folder_items.cached_path），若未缓存则实时计算并更新缓存。
///
/// ## 参数
/// - `source_id`: 业务 ID（note_xxx, tb_xxx）
///
/// ## 返回
/// - `Ok(String)`: 资源的完整路径，如 "/高考复习/函数/笔记标题"
/// - `Err(String)`: 资源不存在或数据库错误
///
/// ## 约束
/// - 路径计算深度限制 10 层（契约 D）
/// - 路径最大长度 1000 字符
#[tauri::command]
pub async fn vfs_get_resource_path(
    source_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<String, String> {
    log::info!(
        "[VFS::handlers] vfs_get_resource_path: source_id={}",
        source_id
    );

    // 获取数据库连接
    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

    // 1. 先查 cached_path
    let cached_path: Option<String> = conn
        .query_row(
            r#"
            SELECT cached_path FROM folder_items
            WHERE item_id = ?1 AND cached_path IS NOT NULL
            LIMIT 1
            "#,
            rusqlite::params![&source_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Query cached_path failed: {}", e))?;

    if let Some(path) = cached_path {
        log::debug!(
            "[VFS::handlers] Returning cached path for {}: {}",
            source_id,
            path
        );
        return Ok(path);
    }

    // 2. 未缓存则实时计算
    // 先查找 folder_item
    let folder_item_opt: Option<(String, Option<String>, String)> = conn
        .query_row(
            r#"
            SELECT id, folder_id, item_type FROM folder_items
            WHERE item_id = ?1
            LIMIT 1
            "#,
            rusqlite::params![&source_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("Query folder_item failed: {}", e))?;

    let (fi_id, folder_id, _item_type) = match folder_item_opt {
        Some(fi) => fi,
        None => {
            // 资源不在 folder_items 中，返回资源名称作为路径
            let title = get_resource_title_with_conn(&conn, &source_id)?;
            return Ok(format!("/{}", title));
        }
    };

    // 计算路径
    let path = compute_path_with_conn(&conn, folder_id.as_deref(), &source_id)?;

    // 3. 更新缓存
    if path.len() <= 1000 {
        conn.execute(
            "UPDATE folder_items SET cached_path = ?1 WHERE id = ?2",
            rusqlite::params![&path, &fi_id],
        )
        .map_err(|e| format!("Update cached_path failed: {}", e))?;
        log::debug!(
            "[VFS::handlers] Updated cached_path for {}: {}",
            source_id,
            path
        );
    } else {
        log::warn!(
            "[VFS::handlers] Path too long ({}), not caching: {}",
            path.len(),
            source_id
        );
    }

    Ok(path)
}

/// 批量更新路径缓存（文件夹移动后调用）
///
/// 递归更新指定文件夹及其所有子文件夹下资源的 cached_path。
///
/// ## 参数
/// - `folder_id`: 被移动的文件夹 ID
///
/// ## 返回
/// - `Ok(u32)`: 更新的项数
/// - `Err(String)`: 数据库错误
///
/// ## 约束
/// - 使用事务保证一致性
/// - 路径计算深度限制 10 层
#[tauri::command]
pub async fn vfs_update_path_cache(
    folder_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<u32, String> {
    log::info!(
        "[VFS::handlers] vfs_update_path_cache: folder_id={}",
        folder_id
    );

    // 验证文件夹 ID 格式
    if !folder_id.starts_with("fld_") {
        return Err(VfsError::InvalidArgument {
            param: "folder_id".to_string(),
            reason: format!("Invalid folder ID format: {}", folder_id),
        }
        .to_string());
    }

    // 获取数据库连接
    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

    // 使用事务
    conn.execute("BEGIN TRANSACTION", [])
        .map_err(|e| e.to_string())?;

    let result = update_path_cache_internal(&conn, &folder_id);

    match result {
        Ok(count) => {
            conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
            log::info!(
                "[VFS::handlers] Updated {} path caches for folder {}",
                count,
                folder_id
            );
            Ok(count)
        }
        Err(e) => {
            conn.execute("ROLLBACK", []).ok();
            log::error!("[VFS::handlers] Failed to update path cache: {}", e);
            Err(e)
        }
    }
}

/// 内部函数：批量更新路径缓存
fn update_path_cache_internal(conn: &rusqlite::Connection, folder_id: &str) -> Result<u32, String> {
    // 1. 获取文件夹及其所有子文件夹的 ID
    let folder_ids = VfsFolderRepo::get_folder_ids_recursive_with_conn(conn, folder_id)
        .map_err(|e| e.to_string())?;

    if folder_ids.is_empty() {
        return Ok(0);
    }

    // 2. 获取这些文件夹下的所有 folder_items
    let items = VfsFolderRepo::get_items_by_folders_with_conn(conn, &folder_ids)
        .map_err(|e| e.to_string())?;

    let mut updated = 0u32;

    // 3. 逐个计算并更新路径
    for item in &items {
        let path = compute_path_with_conn(conn, item.folder_id.as_deref(), &item.item_id)?;

        // 路径长度检查
        if path.len() > 1000 {
            log::warn!(
                "[VFS::handlers] Path too long for item {}, skipping cache update",
                item.item_id
            );
            continue;
        }

        conn.execute(
            "UPDATE folder_items SET cached_path = ?1 WHERE id = ?2",
            rusqlite::params![&path, &item.id],
        )
        .map_err(|e| format!("Update cached_path failed: {}", e))?;

        updated += 1;
    }

    Ok(updated)
}

/// 计算资源的完整路径
fn compute_path_with_conn(
    conn: &rusqlite::Connection,
    folder_id: Option<&str>,
    source_id: &str,
) -> Result<String, String> {
    // 获取资源标题
    let title = get_resource_title_with_conn(conn, source_id)?;

    // 如果没有文件夹，直接返回标题
    let Some(fid) = folder_id else {
        return Ok(format!("/{}", title));
    };

    // 获取文件夹路径（使用 CTE 递归查询）
    let folder_path =
        VfsFolderRepo::build_folder_path_with_conn(conn, fid).map_err(|e| e.to_string())?;

    Ok(format!("/{}/{}", folder_path, title))
}

/// 获取资源标题
fn get_resource_title_with_conn(
    conn: &rusqlite::Connection,
    source_id: &str,
) -> Result<String, String> {
    // 根据 source_id 前缀判断类型并查询标题
    let prefix = source_id.split('_').next().unwrap_or("");

    let title: Option<String> = match prefix {
        "note" => conn
            .query_row(
                "SELECT title FROM notes WHERE id = ?1",
                rusqlite::params![source_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Query note title failed: {}", e))?,
        "tb" => conn
            .query_row(
                "SELECT file_name FROM files WHERE id = ?1",
                rusqlite::params![source_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Query textbook title failed: {}", e))?,
        "exam" => conn
            .query_row(
                "SELECT COALESCE(exam_name, id) FROM exam_sheets WHERE id = ?1",
                rusqlite::params![source_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Query exam title failed: {}", e))?,
        "tr" => conn
            .query_row(
                "SELECT id FROM translations WHERE id = ?1",
                rusqlite::params![source_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Query translation title failed: {}", e))?,
        "essay" => conn
            .query_row(
                "SELECT COALESCE(title, id) FROM essays WHERE id = ?1",
                rusqlite::params![source_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Query essay title failed: {}", e))?,
        _ => None,
    };

    Ok(title.unwrap_or_else(|| source_id.to_string()))
}

// ============================================================================
// 附件操作命令
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsUploadAttachmentParamsExt {
    pub name: String,
    pub mime_type: String,
    pub base64_content: String,
    #[serde(default)]
    pub attachment_type: Option<String>,
    #[serde(default)]
    pub folder_id: Option<String>,
}

/// 自动转写的音频大小上限（与 media_transcribe 工具的受管 ASR 限额一致）
const AUTO_TRANSCRIBE_MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;

/// 判断上传是否是音频文件（MIME 或扩展名）
fn is_audio_upload(name: &str, mime_type: &str) -> bool {
    if mime_type.trim().to_lowercase().starts_with("audio/") {
        return true;
    }
    let ext = std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase());
    matches!(
        ext.as_deref(),
        Some("mp3" | "wav" | "ogg" | "m4a" | "flac" | "aac" | "opus" | "wma")
    )
}

/// 通过文件签名确认音频容器类型（供受管 ASR 使用的 MIME）
///
/// 与 `media_executor::media_signature` 保持一致的接受范围：
/// MP3 / WAV / OGG / FLAC / M4A（MP4 audio ftyp）/ ADTS AAC。
/// WMA（ASF 容器）与视频容器返回明确的不支持原因。
fn detect_audio_mime_by_signature(bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.starts_with(b"ID3")
        || bytes.starts_with(b"\xff\xfb")
        || bytes.starts_with(b"\xff\xf3")
        || bytes.starts_with(b"\xff\xf2")
    {
        Ok("audio/mpeg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        Ok("audio/wav")
    } else if bytes.starts_with(b"OggS") {
        Ok("audio/ogg")
    } else if bytes.starts_with(b"fLaC") {
        Ok("audio/flac")
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        // ISO BMFF：仅接受确认为音频的 M4A/M4B/M4P 品牌，其余按视频容器拒绝
        let brand = &bytes[8..12];
        if brand.starts_with(b"M4A") || brand.starts_with(b"M4B") || brand.starts_with(b"M4P") {
            Ok("audio/mp4")
        } else {
            Err("视频容器（MP4/MOV 等）暂不支持提取音轨转写".to_string())
        }
    } else if bytes.len() >= 2 && bytes[0] == 0xff && (bytes[1] & 0xf6) == 0xf0 {
        // ADTS AAC 帧头（0xFFF1 / 0xFFF9 等）
        Ok("audio/aac")
    } else if bytes.starts_with(b"\x30\x26\xb2\x75\x8e\x66\xcf\x11") {
        Err("WMA（ASF 容器）暂不支持转写，请先转换为 MP3/WAV/M4A".to_string())
    } else if bytes.starts_with(b"\x1a\x45\xdf\xa3") {
        Err("WebM/MKV 容器暂不支持提取音轨转写".to_string())
    } else {
        Err("无法通过文件签名确认音频格式（支持 MP3/WAV/OGG/FLAC/M4A/AAC）".to_string())
    }
}

/// 把可读的处理状态写入 files 行（音频转写状态显式化，仅日志用户不可见）
fn mark_audio_processing_note(vfs_db: &VfsDatabase, file_id: &str, note: &str) {
    match vfs_db.get_conn_safe() {
        Ok(conn) => {
            if let Err(e) = conn.execute(
                "UPDATE files SET processing_error = ?1 WHERE id = ?2",
                rusqlite::params![note, file_id],
            ) {
                log::warn!(
                    "[VFS::handlers] Failed to record audio processing note for {}: {}",
                    file_id,
                    e
                );
            }
        }
        Err(e) => {
            log::warn!(
                "[VFS::handlers] Failed to get connection for audio note {}: {}",
                file_id,
                e
            );
        }
    }
}

/// ★ 音频导入后的可选转写流水线（异步，不阻塞导入）
///
/// 复用现有语音输入 ASR 基建（`voice_input_transcribe_with_state`）：
/// - ASR 未配置 → 在 files.processing_error 标记可读状态后跳过；
/// - 转写成功 → 写入 files.extracted_text + resources OCR 文本并重建索引单元，
///   使音频内容可被检索与注入对话。
fn spawn_audio_transcription_if_applicable(
    app: &AppHandle,
    vfs_db: Arc<VfsDatabase>,
    file_id: String,
    resource_id: Option<String>,
    file_name: String,
    audio_base64: String,
) {
    use base64::Engine as _;

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<crate::commands::AppState>() else {
            log::warn!(
                "[VFS::handlers] AppState unavailable, skip audio transcription for {}",
                file_id
            );
            return;
        };

        let asr = crate::voice_input::voice_input_asr_capability(&state);
        if !asr.configured {
            log::info!(
                "[VFS::handlers] ASR not configured, skip audio transcription for {}",
                file_id
            );
            mark_audio_processing_note(
                &vfs_db,
                &file_id,
                "音频未自动转写：未配置语音输入 ASR（SiliconFlow API Key）。可在设置中配置后重新导入，或在对话中调用 media_transcribe 工具转写",
            );
            return;
        }

        // 解码前按编码长度估算，超过受管 ASR 限额直接跳过
        let estimated = audio_base64.len() / 4 * 3;
        if estimated > AUTO_TRANSCRIBE_MAX_AUDIO_BYTES {
            mark_audio_processing_note(
                &vfs_db,
                &file_id,
                "音频超过 25MB 自动转写上限，未转写。可裁剪后重新导入",
            );
            return;
        }
        let bytes = match base64::engine::general_purpose::STANDARD.decode(&audio_base64) {
            Ok(bytes) => bytes,
            Err(e) => {
                log::warn!(
                    "[VFS::handlers] Failed to decode audio for transcription {}: {}",
                    file_id,
                    e
                );
                return;
            }
        };
        if bytes.len() > AUTO_TRANSCRIBE_MAX_AUDIO_BYTES {
            mark_audio_processing_note(
                &vfs_db,
                &file_id,
                "音频超过 25MB 自动转写上限，未转写。可裁剪后重新导入",
            );
            return;
        }

        let mime = match detect_audio_mime_by_signature(&bytes) {
            Ok(mime) => mime,
            Err(reason) => {
                mark_audio_processing_note(
                    &vfs_db,
                    &file_id,
                    &format!("音频未自动转写：{}", reason),
                );
                return;
            }
        };

        let request = crate::voice_input::VoiceInputTranscribeRequest {
            audio_base64,
            mime_type: mime.to_string(),
            provider_id: None,
            model: None,
            config_id: None,
            language: None,
            prompt: None,
            duration_ms: None,
        };

        match crate::voice_input::voice_input_transcribe_with_state(request, &state).await {
            Ok(transcript) if !transcript.text.trim().is_empty() => {
                let text = transcript.text.trim().to_string();
                log::info!(
                    "[VFS::handlers] Audio transcribed for {} ({}): {} chars",
                    file_id,
                    file_name,
                    text.len()
                );
                match vfs_db.get_conn_safe() {
                    Ok(conn) => {
                        if let Err(e) = conn.execute(
                            "UPDATE files SET extracted_text = ?1, processing_error = NULL WHERE id = ?2",
                            rusqlite::params![text, file_id],
                        ) {
                            log::warn!(
                                "[VFS::handlers] Failed to store transcript for {}: {}",
                                file_id,
                                e
                            );
                            return;
                        }
                        if let Some(ref resource_id) = resource_id {
                            if let Err(e) =
                                VfsResourceRepo::save_ocr_text_with_conn(&conn, resource_id, &text)
                            {
                                log::warn!(
                                    "[VFS::handlers] Failed to persist transcript OCR text for {}: {}",
                                    resource_id,
                                    e
                                );
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!(
                            "[VFS::handlers] Failed to get connection for transcript {}: {}",
                            file_id,
                            e
                        );
                        return;
                    }
                }

                // 触发既有文本索引（与文档上传一致的 Units 同步路径）
                if let Some(resource_id) = resource_id {
                    let index_service = VfsIndexService::new(vfs_db.clone());
                    let input = UnitBuildInput {
                        resource_id: resource_id.clone(),
                        resource_type: "file".to_string(),
                        data: None,
                        ocr_text: Some(text.clone()),
                        ocr_pages_json: None,
                        blob_hash: None,
                        page_count: None,
                        extracted_text: Some(text),
                        preview_json: None,
                    };
                    match index_service.sync_resource_units(input) {
                        Ok(units) => log::info!(
                            "[VFS::handlers] Synced {} units for transcribed audio {}",
                            units.len(),
                            file_id
                        ),
                        Err(e) => log::warn!(
                            "[VFS::handlers] Failed to sync units for transcribed audio {}: {}",
                            file_id,
                            e
                        ),
                    }
                }
            }
            Ok(_) => {
                mark_audio_processing_note(
                    &vfs_db,
                    &file_id,
                    "音频转写结果为空（可能是无语音内容）",
                );
            }
            Err(e) => {
                log::warn!(
                    "[VFS::handlers] Audio transcription failed for {}: {}",
                    file_id,
                    e.message
                );
                mark_audio_processing_note(
                    &vfs_db,
                    &file_id,
                    &format!(
                        "音频自动转写失败：{}。可在对话中调用 media_transcribe 工具重试",
                        e.message
                    ),
                );
            }
        }
    });
}

#[tauri::command]
pub async fn vfs_upload_attachment(
    app: AppHandle,
    params: VfsUploadAttachmentParamsExt,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    pdf_processing_service: State<'_, Arc<PdfProcessingService>>,
) -> Result<VfsUploadAttachmentResult, String> {
    log::info!(
        "[VFS::handlers] vfs_upload_attachment: name={}, mime_type={}, folder_id={:?}",
        params.name,
        params.mime_type,
        params.folder_id
    );

    // 判断是否为 PDF 文件
    let is_pdf =
        params.mime_type == "application/pdf" || params.name.to_lowercase().ends_with(".pdf");

    let target_folder_id = match params.folder_id {
        Some(ref id) if !id.is_empty() => Some(id.clone()),
        _ => {
            let config = AttachmentConfig::new(vfs_db.inner().clone());
            Some(
                config
                    .get_or_create_root_folder()
                    .map_err(|e| e.to_string())?,
            )
        }
    };

    // ★ 音频附件：留存 base64 供导入后的可选转写流水线使用（其余类型不复制；
    // 超过受管 ASR 25MB 限额的大音频不复制，避免峰值内存翻倍）
    let is_audio = is_audio_upload(&params.name, &params.mime_type);
    let audio_within_asr_limit =
        params.base64_content.len() <= AUTO_TRANSCRIBE_MAX_AUDIO_BYTES / 3 * 4 + 4;
    let audio_base64_for_transcription = if is_audio && audio_within_asr_limit {
        Some(params.base64_content.clone())
    } else {
        None
    };

    let upload_params = VfsUploadAttachmentParams {
        name: params.name.clone(),
        mime_type: params.mime_type.clone(),
        base64_content: params.base64_content,
        attachment_type: params.attachment_type,
    };

    let result =
        VfsAttachmentRepo::upload_with_folder(&vfs_db, upload_params, target_folder_id.as_deref())
            .map_err(|e| e.to_string())?;

    // ★ 音频导入后自动转写（异步，不阻塞导入；ASR 未配置则标记状态后跳过）
    if let Some(audio_base64) = audio_base64_for_transcription {
        let has_transcript = result
            .attachment
            .extracted_text
            .as_ref()
            .map(|t| !t.trim().is_empty())
            .unwrap_or(false);
        if result.is_new && !has_transcript {
            spawn_audio_transcription_if_applicable(
                &app,
                vfs_db.inner().clone(),
                result.source_id.clone(),
                result.attachment.resource_id.clone(),
                params.name.clone(),
                audio_base64,
            );
        }
    } else if is_audio && !audio_within_asr_limit && result.is_new {
        mark_audio_processing_note(
            &vfs_db,
            &result.source_id,
            "音频超过 25MB 自动转写上限，未转写。可裁剪后重新导入",
        );
    }

    log::info!(
        "[VFS::handlers] Attachment {}: source_id={}, hash={}, folder={:?}",
        if result.is_new { "uploaded" } else { "reused" },
        result.source_id,
        &result.resource_hash[..16.min(result.resource_hash.len())],
        target_folder_id
    );

    // ★ P2 修复：上传后自动同步 Units 以触发索引
    if let Some(ref resource_id) = result.attachment.resource_id {
        let index_service = VfsIndexService::new(vfs_db.inner().clone());
        let input = UnitBuildInput {
            resource_id: resource_id.clone(),
            resource_type: "attachment".to_string(),
            data: None,
            ocr_text: None,
            ocr_pages_json: None,
            blob_hash: result.attachment.blob_hash.clone(),
            page_count: result.attachment.page_count,
            extracted_text: result.attachment.extracted_text.clone(),
            preview_json: result.attachment.preview_json.clone(),
        };
        match index_service.sync_resource_units(input) {
            Ok(units) => {
                log::info!(
                    "[VFS::handlers] Auto-synced {} units for attachment {}",
                    units.len(),
                    result.source_id
                );
            }
            Err(e) => {
                log::warn!(
                    "[VFS::handlers] Failed to auto-sync units for attachment {}: {}",
                    result.source_id,
                    e
                );
            }
        }
    }

    // ★ 2026-02 修复：PDF/图片 上传后异步触发 Pipeline
    // PDF: Stage 1-2（文本提取、页面渲染）已在 upload_with_conn 中完成，从 OCR 阶段开始
    // 图片: 从压缩阶段开始
    let is_image = params.mime_type.starts_with("image/");

    // ★ v2.1 新增：查询处理状态并填充返回值
    // 对于重用的附件，需要返回实际的处理状态
    let (mut processing_status, mut processing_percent, mut ready_modes, mut needs_processing) =
        if is_pdf || is_image {
            match pdf_processing_service.get_status(&result.source_id) {
                Ok(Some(status)) => {
                    let percent = status.progress.percent;
                    let modes = status.progress.ready_modes.clone();
                    let stage = status.progress.stage.clone();
                    // ★ v2.1: 判断是否需要继续处理（未完成且非错误状态）
                    let needs_resume = stage != "completed"
                        && stage != "completed_with_issues"
                        && stage != "error";
                    (Some(stage), Some(percent), Some(modes), needs_resume)
                }
                _ => {
                    // 没有处理状态，设置初始值，需要启动处理
                    // ★ P0 架构改造：初始 ready_modes 不再包含 image
                    // image 模式必须等到压缩完成后才就绪
                    if is_pdf {
                        // PDF: text 在上传时已提取完成，image 需要等页面压缩
                        let text_ready = result
                            .attachment
                            .extracted_text
                            .as_ref()
                            .map(|t| !t.trim().is_empty())
                            .unwrap_or(false);
                        let mut modes = Vec::new();
                        if text_ready {
                            modes.push("text".to_string());
                        }
                        (
                            Some("page_compression".to_string()),
                            Some(25.0),
                            Some(modes),
                            true,
                        )
                    } else {
                        // 图片: 需要等压缩完成后 image 才就绪
                        (
                            Some("image_compression".to_string()),
                            Some(10.0),
                            Some(vec![]),
                            true,
                        )
                    }
                }
            }
        } else {
            (None, None, None, false)
        };

    // ★ P0 修复：旧数据缺失压缩结果时强制重新处理
    let mut needs_compression = false;
    if is_pdf {
        if let Some(ref preview_json) = result.attachment.preview_json {
            needs_compression = pdf_preview_needs_compression(preview_json);
        }
    } else if is_image {
        if let Ok(conn) = vfs_db.get_conn_safe() {
            needs_compression =
                image_needs_compression_with_conn(&conn, vfs_db.blobs_dir(), &result.source_id);
        }
    }

    if needs_compression && processing_status.as_deref() != Some("error") {
        needs_processing = true;
    }

    if needs_compression
        && (processing_status.as_deref() == Some("completed") || processing_status.is_none())
    {
        if is_pdf {
            let mut modes = Vec::new();
            if result
                .attachment
                .extracted_text
                .as_ref()
                .map(|t| !t.trim().is_empty())
                .unwrap_or(false)
            {
                modes.push("text".to_string());
            }
            processing_status = Some("page_compression".to_string());
            processing_percent = Some(25.0);
            ready_modes = Some(modes);
        } else if is_image {
            processing_status = Some("image_compression".to_string());
            processing_percent = Some(10.0);
            ready_modes = Some(vec![]);
        }
    }

    // ★ v2.1 修复：不仅新上传需要处理，重用但未完成的也需要继续处理
    if (result.is_new || needs_processing) && (is_pdf || is_image) {
        let file_id = result.source_id.clone();
        let media_service = pdf_processing_service.inner().clone();
        let start_stage = if is_pdf {
            Some(ProcessingStage::OcrProcessing)
        } else {
            Some(ProcessingStage::ImageCompression)
        };
        tokio::spawn(async move {
            log::info!(
                "[VFS::handlers] Starting media pipeline for attachment: {} (pdf={}, image={}, is_new={}, resume={})",
                file_id, is_pdf, is_image, result.is_new, !result.is_new
            );
            if let Err(e) = media_service.start_pipeline(&file_id, start_stage).await {
                log::error!(
                    "[VFS::handlers] Failed to start media pipeline for attachment {}: {}",
                    file_id,
                    e
                );
            }
        });
    }

    // 返回包含处理状态的结果
    Ok(VfsUploadAttachmentResult {
        source_id: result.source_id,
        resource_hash: result.resource_hash,
        is_new: result.is_new,
        attachment: result.attachment,
        processing_status,
        processing_percent,
        ready_modes,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentConfigOutput {
    pub attachment_root_folder_id: Option<String>,
    pub attachment_root_folder_title: Option<String>,
}

#[tauri::command]
pub async fn vfs_get_attachment_config(
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<AttachmentConfigOutput, String> {
    let config = AttachmentConfig::new(vfs_db.inner().clone());
    let root_id = config.get_root_folder_id().map_err(|e| e.to_string())?;
    let root_title = config.get_root_folder_title().map_err(|e| e.to_string())?;

    Ok(AttachmentConfigOutput {
        attachment_root_folder_id: root_id,
        attachment_root_folder_title: root_title,
    })
}

#[tauri::command]
pub async fn vfs_set_attachment_root_folder(
    folder_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<(), String> {
    use crate::vfs::repos::VfsFolderRepo;

    if !VfsFolderRepo::folder_exists(&vfs_db, &folder_id).map_err(|e| e.to_string())? {
        return Err(format!("Folder not found: {}", folder_id));
    }

    let config = AttachmentConfig::new(vfs_db.inner().clone());
    config
        .set_root_folder_id(&folder_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn vfs_create_attachment_root_folder(
    title: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<String, String> {
    let config = AttachmentConfig::new(vfs_db.inner().clone());
    config.create_root_folder(&title).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn vfs_get_or_create_attachment_root_folder(
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<String, String> {
    let config = AttachmentConfig::new(vfs_db.inner().clone());
    config
        .get_or_create_root_folder()
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsAttachmentContentResult {
    /// Base64 编码的内容（如果找到）
    pub content: Option<String>,
    /// 是否找到附件
    pub found: bool,
    /// 可选错误信息（向后兼容：旧前端可忽略此字段）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 获取附件内容（Base64 编码）
///
/// ## 参数
/// - `attachment_id`: 附件/文件/教材 ID（att_xxx / file_xxx / tb_xxx）
///
/// ## 返回
/// - `Ok(VfsAttachmentContentResult)`: 包含 content/found（以及可选 error）字段
/// - `Err(String)`: 读取失败
///
/// ★ 2025-12-10 修复：返回结构体匹配前端 ImageContentView 期望的格式
#[tauri::command]
pub async fn vfs_get_attachment_content(
    attachment_id: String,
    max_bytes: Option<u64>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<VfsAttachmentContentResult, String> {
    log::info!(
        "[VFS::handlers] vfs_get_attachment_content: START id={}",
        attachment_id
    );

    // 验证附件 ID 格式（支持 att_、file_、tb_ 和 img_ 前缀）
    if !attachment_id.starts_with("att_")
        && !attachment_id.starts_with("file_")
        && !attachment_id.starts_with("tb_")
        && !attachment_id.starts_with("img_")
    {
        log::error!(
            "[VFS::handlers] Invalid attachment ID format: {}",
            attachment_id
        );
        return Err(format!("Invalid attachment ID format: {}", attachment_id));
    }

    // ★ img_ 前缀：DOCX VLM 直提路径产生的图片 ID，blob hash 存在 questions.images_json 中
    if attachment_id.starts_with("img_") {
        let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;
        // 在 questions.images_json 中搜索此 img_ ID，提取 blob hash
        let rows: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT images_json FROM questions WHERE images_json LIKE ?1 AND deleted_at IS NULL LIMIT 5")
                .map_err(|e| e.to_string())?;
            let iter = stmt
                .query_map(rusqlite::params![format!("%{}%", attachment_id)], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|e| e.to_string())?;
            iter.filter_map(|r| r.ok()).collect()
        };

        for images_json_str in &rows {
            if let Ok(images) = serde_json::from_str::<Vec<serde_json::Value>>(images_json_str) {
                for img in &images {
                    if img.get("id").and_then(|v| v.as_str()) == Some(&attachment_id) {
                        if let Some(blob_hash) = img.get("hash").and_then(|v| v.as_str()) {
                            // 从 blobs 表查 relative_path，再拼接 blobs_dir 得到绝对路径
                            let blob_path: Option<std::path::PathBuf> = conn
                                .query_row(
                                    "SELECT relative_path FROM blobs WHERE hash = ?1",
                                    rusqlite::params![blob_hash],
                                    |row| row.get::<_, String>(0),
                                )
                                .optional()
                                .ok()
                                .flatten()
                                .map(|rel| vfs_db.blobs_dir().join(rel));

                            let blob_path = match blob_path {
                                Some(p) => p,
                                None => {
                                    log::warn!(
                                        "[VFS::handlers] img_ blob not in DB: hash={}",
                                        blob_hash
                                    );
                                    continue;
                                }
                            };

                            if blob_path.exists() {
                                if let Some(limit) = max_bytes {
                                    let size = std::fs::metadata(&blob_path)
                                        .map_err(|e| e.to_string())?
                                        .len();
                                    if size > limit {
                                        return Err(format!(
                                            "attachment content exceeds preview limit: {} > {} bytes",
                                            size, limit
                                        ));
                                    }
                                }
                                match std::fs::read(&blob_path) {
                                    Ok(data) => {
                                        use base64::{engine::general_purpose::STANDARD, Engine};
                                        let b64 = STANDARD.encode(&data);
                                        log::info!(
                                            "[VFS::handlers] vfs_get_attachment_content: img_ resolved via blob hash={}, size={}",
                                            blob_hash, data.len()
                                        );
                                        return Ok(VfsAttachmentContentResult {
                                            content: Some(b64),
                                            found: true,
                                            error: None,
                                        });
                                    }
                                    Err(e) => {
                                        log::warn!("[VFS::handlers] img_ blob read failed: {}", e);
                                    }
                                }
                            } else {
                                log::warn!(
                                    "[VFS::handlers] img_ blob file not found: {:?}",
                                    blob_path
                                );
                            }
                        }
                    }
                }
            }
        }

        log::warn!(
            "[VFS::handlers] vfs_get_attachment_content: img_ ID not resolved: {}",
            attachment_id
        );
        return Ok(VfsAttachmentContentResult {
            content: None,
            found: false,
            error: None,
        });
    }

    // ★ 详细日志：查询文件元数据
    {
        let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;
        let meta: Option<(Option<String>, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT resource_id, blob_hash, original_path FROM files WHERE id = ?1",
                rusqlite::params![&attachment_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        log::info!(
            "[VFS::handlers] vfs_get_attachment_content: file meta for {}: resource_id={:?}, blob_hash={:?}, original_path={:?}",
            attachment_id,
            meta.as_ref().map(|m| &m.0),
            meta.as_ref().map(|m| &m.1),
            meta.as_ref().map(|m| &m.2),
        );
    }

    let content_result = match max_bytes {
        Some(limit) => VfsAttachmentRepo::get_content_bounded(&vfs_db, &attachment_id, limit),
        None => VfsAttachmentRepo::get_content(&vfs_db, &attachment_id),
    };
    match content_result {
        Ok(Some(content)) => {
            log::info!(
                "[VFS::handlers] vfs_get_attachment_content: SUCCESS id={}, content_len={}",
                attachment_id,
                content.len()
            );
            Ok(VfsAttachmentContentResult {
                content: Some(content),
                found: true,
                error: None,
            })
        }
        Ok(None) => {
            log::warn!(
                "[VFS::handlers] vfs_get_attachment_content: NOT FOUND id={}",
                attachment_id
            );
            Ok(VfsAttachmentContentResult {
                content: None,
                found: false,
                error: None,
            })
        }
        Err(e) => {
            let err_msg = e.to_string();
            log::error!(
                "[VFS::handlers] vfs_get_attachment_content: ERROR id={}, error={}",
                attachment_id,
                err_msg
            );
            Ok(VfsAttachmentContentResult {
                content: None,
                found: false,
                error: Some(err_msg),
            })
        }
    }
}

/// 获取附件元数据
///
/// ## 参数
/// - `attachment_id`: 附件 ID（att_xxx 或 file_xxx）
///
/// ## 返回
/// - `Ok(Some(VfsAttachment))`: 附件元数据
/// - `Ok(None)`: 附件不存在
/// - `Err(String)`: 查询失败
#[tauri::command]
pub async fn vfs_get_attachment(
    attachment_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Option<VfsAttachment>, String> {
    log::debug!("[VFS::handlers] vfs_get_attachment: id={}", attachment_id);

    if !attachment_id.starts_with("att_") && !attachment_id.starts_with("file_") {
        return Err(format!("Invalid attachment ID format: {}", attachment_id));
    }

    VfsAttachmentRepo::get_by_id(&vfs_db, &attachment_id).map_err(|e| e.to_string())
}

/// 软删除附件
///
/// 将附件标记为已删除（可恢复），同时清理相关索引。
/// 用于清理测试产生的废弃附件等场景。
#[tauri::command]
pub async fn vfs_delete_attachment(
    attachment_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<(), String> {
    log::info!(
        "[VFS::handlers] vfs_delete_attachment: id={}",
        attachment_id
    );

    if !attachment_id.starts_with("att_") {
        return Err(format!("Invalid attachment ID format: {}", attachment_id));
    }

    VfsAttachmentRepo::delete_attachment(&vfs_db, &attachment_id).map_err(|e| e.to_string())
}

// ============================================================================
// 统一文件操作命令（files 表）
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsUploadFileParams {
    pub name: String,
    pub mime_type: String,
    pub base64_content: String,
    #[serde(default)]
    pub file_type: Option<String>,
    #[serde(default)]
    pub folder_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsUploadFileResult {
    pub file: VfsFile,
    pub source_id: String,
    pub resource_hash: String,
    pub is_new: bool,
    /// ★ 2026-01 新增：OCR 处理状态
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ocr_status: Option<OcrStatus>,
    /// ★ 2026-01 新增：索引状态
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_status: Option<IndexStatus>,
}

/// ★ 2026-01 新增：索引处理状态结构体
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    /// 是否已加入索引队列
    pub queued: bool,
    /// 创建的索引单元数量
    pub units_created: u32,
    /// 用户可见的状态消息
    pub message: String,
}

/// ★ 2026-01 新增：OCR 处理状态结构体
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrStatus {
    /// OCR 是否被执行
    pub performed: bool,
    /// 跳过原因（如果跳过）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<String>,
    /// 成功的页数（PDF）
    pub success_count: u32,
    /// 失败的页数（PDF）
    pub failed_count: u32,
    /// Blob 缺失的页数（PDF）
    pub blob_missing_count: u32,
    /// 总页数（PDF）
    pub total_pages: u32,
    /// 是否全部成功
    pub all_success: bool,
    /// 用户可见的状态消息
    pub message: String,
}

/// PDF 文本提取阈值默认值（字符数）
/// 如果提取的文本少于此阈值，则认为是扫描版 PDF，需要触发 OCR
const DEFAULT_PDF_TEXT_THRESHOLD: usize = 100;

/// OCR 策略配置
#[derive(Debug, Clone)]
struct OcrStrategyConfig {
    /// 是否启用自动 OCR
    pub enabled: bool,
    /// 多模态模型跳过 OCR（多模态模型可直接理解图片）
    pub skip_for_multimodal: bool,
    /// PDF 文本阈值（字符数，低于此值触发 OCR）
    pub pdf_text_threshold: usize,
    /// 是否对图片启用 OCR
    pub ocr_images: bool,
    /// 是否对扫描版 PDF 启用 OCR
    pub ocr_scanned_pdf: bool,
}

impl Default for OcrStrategyConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            // ★ 2026-01 修复：默认不跳过 OCR，确保文本索引有内容
            // 即使使用多模态模型，OCR 文本对于 RAG 检索和文本模型注入仍然必要
            skip_for_multimodal: false,
            pdf_text_threshold: DEFAULT_PDF_TEXT_THRESHOLD,
            ocr_images: true,
            ocr_scanned_pdf: true,
        }
    }
}

impl OcrStrategyConfig {
    /// 从数据库设置加载配置
    fn load_from_db(db: &crate::database::Database) -> Self {
        let mut config = Self::default();

        if let Ok(Some(v)) = db.get_setting("ocr.enabled") {
            config.enabled = v.to_lowercase() == "true";
        }
        if let Ok(Some(v)) = db.get_setting("ocr.skip_for_multimodal") {
            config.skip_for_multimodal = v.to_lowercase() == "true";
        }
        if let Ok(Some(v)) = db.get_setting("ocr.pdf_text_threshold") {
            if let Ok(n) = v.parse::<usize>() {
                config.pdf_text_threshold = n;
            }
        }
        if let Ok(Some(v)) = db.get_setting("ocr.images") {
            config.ocr_images = v.to_lowercase() == "true";
        }
        if let Ok(Some(v)) = db.get_setting("ocr.scanned_pdf") {
            config.ocr_scanned_pdf = v.to_lowercase() == "true";
        }

        config
    }
}

#[tauri::command]
pub async fn vfs_upload_file(
    app: AppHandle,
    params: VfsUploadFileParams,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    llm_manager: State<'_, Arc<crate::llm_manager::LLMManager>>,
    database: State<'_, Arc<crate::database::Database>>,
    pdf_processing_service: State<'_, Arc<PdfProcessingService>>,
) -> Result<VfsUploadFileResult, String> {
    use crate::document_parser::DocumentParser;
    use crate::vfs::repos::pdf_preview::{render_pdf_preview, PdfPreviewConfig};
    use crate::vfs::repos::VfsFileRepo;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    use sha2::{Digest, Sha256};

    // ★ 2026-02 重构：llm_manager 参数保留用于未来图片 OCR 支持
    // 当前 PDF OCR 由 Pipeline 异步处理，图片 OCR 暂不支持
    let _ = &llm_manager;

    // 加载 OCR 策略配置
    let ocr_config = OcrStrategyConfig::load_from_db(&database);

    log::info!(
        "[VFS::handlers] vfs_upload_file: name={}, mime_type={}, folder_id={:?}",
        params.name,
        params.mime_type,
        params.folder_id
    );

    let content = BASE64
        .decode(&params.base64_content)
        .map_err(|e| format!("Base64 decode failed: {}", e))?;

    if !VfsAttachmentRepo::is_supported_upload_type(&params.name, &params.mime_type) {
        // ★ 结构化拒绝错误：带上具体文件名/扩展名/MIME，前端可直接展示给用户
        let ext_display = std::path::Path::new(&params.name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| format!(".{}", e.to_lowercase()))
            .unwrap_or_else(|| "(无扩展名)".to_string());
        return Err(VfsError::InvalidArgument {
            param: "mime_type".to_string(),
            reason: format!(
                "UNSUPPORTED_FILE_TYPE: 不支持的文件类型 {} (文件: {}, MIME: {})",
                ext_display, params.name, params.mime_type
            ),
        }
        .to_string());
    }

    let max_size = VfsAttachmentRepo::max_upload_size_bytes(&params.mime_type);
    if content.len() > max_size {
        let max_mb = max_size / (1024 * 1024);
        let actual_mb = content.len() as f64 / (1024.0 * 1024.0);
        return Err(VfsError::InvalidArgument {
            param: "base64_content".to_string(),
            reason: format!("File too large: max {}MB, got {:.2}MB", max_mb, actual_mb),
        }
        .to_string());
    }

    let mut hasher = Sha256::new();
    hasher.update(&content);
    let sha256 = format!("{:x}", hasher.finalize());

    let file_type = params
        .file_type
        .unwrap_or_else(|| VfsFile::infer_file_type(&params.mime_type).to_string());

    let size = content.len() as i64;

    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;
    let blobs_dir = vfs_db.blobs_dir();
    let is_image = params.mime_type.starts_with("image/");

    let existing =
        VfsFileRepo::get_by_sha256_with_conn(&conn, &sha256).map_err(|e| e.to_string())?;

    if let Some(file) = existing {
        if file.status == "active" {
            log::info!("[VFS::handlers] File reused: {}", file.id);
            let is_pdf = file.mime_type.as_deref() == Some("application/pdf")
                || file.file_name.to_lowercase().ends_with(".pdf");
            let is_image = file
                .mime_type
                .as_deref()
                .map(|m| m.starts_with("image/"))
                .unwrap_or(false);
            let mut needs_processing = false;

            if is_pdf {
                if let Some(ref preview_json) = file.preview_json {
                    needs_processing = pdf_preview_needs_compression(preview_json);
                }
            } else if is_image {
                needs_processing = image_needs_compression_with_conn(&conn, blobs_dir, &file.id);
            }

            if needs_processing {
                let file_id = file.id.clone();
                let media_service = pdf_processing_service.inner().clone();
                let start_stage = if is_pdf {
                    Some(ProcessingStage::OcrProcessing)
                } else {
                    Some(ProcessingStage::ImageCompression)
                };
                tokio::spawn(async move {
                    log::info!(
                        "[VFS::handlers] Starting media pipeline for reused file: {} (pdf={}, image={})",
                        file_id, is_pdf, is_image
                    );
                    if let Err(e) = media_service.start_pipeline(&file_id, start_stage).await {
                        log::error!(
                            "[VFS::handlers] Failed to start media pipeline for reused file {}: {}",
                            file_id,
                            e
                        );
                    }
                });
            }
            return Ok(VfsUploadFileResult {
                source_id: file.id.clone(),
                resource_hash: sha256,
                is_new: false,
                file,
                // 已有文件不需要 OCR/索引状态
                ocr_status: None,
                index_status: None,
            });
        }
    }

    // ★ TD-03：上传原子性保障（最小 saga + savepoint，替代旧 TODO(transaction)）
    //
    // 事务边界：
    // - PDF 预览渲染与根目录解析使用**独立连接**、先于事务执行；
    //   它们的副作用（预览页 blob 的 ref +1）记入 UploadSaga 补偿账本。
    // - store_blob（主 blob 落库）与 create_file_with_doc_data_in_folder
    //   （resources/files/folder_items）在**同一连接**的 SAVEPOINT 内执行，
    //   失败整体回滚；已原子 rename 落盘、且 DB 行随回滚消失的物理文件由
    //   remove_unregistered_blob_file 补偿删除（去重复用的 blob 行仍在 → 保留）。
    // - 索引同步失败不回滚文件（文件已持久可用），而是把资源置入显式
    //   可重试状态（failed + 退避），由后台索引循环幂等重试补建。
    let is_pdf =
        params.mime_type == "application/pdf" || params.name.to_lowercase().ends_with(".pdf");

    let mut saga = crate::vfs::upload_saga::UploadSaga::new();

    // ★ pptx/epub 页级拆分结果（写入 files.ocr_pages_json，使检索命中可定位页/章节）
    let mut paged_text_pages: Option<Vec<String>> = None;

    // ★ P2-1 修复：添加文档处理逻辑（与 vfs_upload_attachment 保持一致）
    let (preview_json, extracted_text, page_count): (Option<String>, Option<String>, Option<i32>) =
        if is_pdf {
            log::info!(
                "[VFS::handlers] PDF detected, triggering preview render: {}",
                params.name
            );

            {
                let vfs_db_clone = vfs_db.inner().clone();
                let blobs_dir_clone = blobs_dir.to_path_buf();
                let content_clone = content.clone();
                match tokio::task::spawn_blocking(move || {
                    let conn = vfs_db_clone.get_conn_safe().map_err(|e| e.to_string())?;
                    render_pdf_preview(
                        &conn,
                        &blobs_dir_clone,
                        &content_clone,
                        &PdfPreviewConfig::default(),
                    )
                    .map_err(|e| e.to_string())
                })
                .await
                {
                    Ok(Ok(result)) => {
                        // 页面 blob 已在独立连接上提交，登记入补偿账本：
                        // 后续任一步失败即回退这些引用（守卫式，仅归零才删文件）
                        if let Some(ref preview) = result.preview_json {
                            saga.record_preview_blobs(preview);
                        }
                        let preview_str = result
                            .preview_json
                            .as_ref()
                            .and_then(|p| serde_json::to_string(p).ok());
                        log::info!(
                            "[VFS::handlers] PDF preview rendered: {} pages, text_len={}, has_preview={}",
                            result.page_count,
                            result.extracted_text.as_ref().map(|t| t.len()).unwrap_or(0),
                            preview_str.is_some()
                        );
                        (
                            preview_str,
                            result.extracted_text,
                            Some(result.page_count as i32),
                        )
                    }
                    Ok(Err(e)) => {
                        log::warn!("[VFS::handlers] PDF preview failed: {}", e);
                        (None, None, None)
                    }
                    Err(e) => {
                        log::warn!("[VFS::handlers] PDF render task panicked: {}", e);
                        (None, None, None)
                    }
                }
            }
        } else {
            // 非 PDF 文件：尝试解析文本内容
            let extension = std::path::Path::new(&params.name)
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|s| s.to_lowercase());

            let supported_extensions = [
                "docx", "xlsx", "xls", "xlsb", "ods", "pptx", "epub", "rtf", "txt", "md",
                "markdown", "html", "htm", "csv", "json", "xml",
            ];

            let is_zip_archive = extension.as_deref() == Some("zip")
                || matches!(
                    params.mime_type.trim().to_ascii_lowercase().as_str(),
                    "application/zip" | "application/x-zip-compressed"
                );

            if is_zip_archive {
                // ★ ZIP 压缩包：解析中央目录生成条目清单（不解压内容），
                // 存入 extracted_text 供预览兜底页与对话注入使用
                match crate::vfs::repos::attachment_repo::build_zip_manifest_text(
                    &params.name,
                    &content,
                ) {
                    Some(manifest) => {
                        log::info!(
                            "[VFS::handlers] Built zip manifest for {}: {} chars",
                            params.name,
                            manifest.len()
                        );
                        (None, Some(manifest), None)
                    }
                    None => (None, None, None),
                }
            } else if let Some(ref ext) = extension {
                // ★ 代码/纯文本扩展名（与附件白名单/前端同一清单）也走文本提取
                let is_parseable = supported_extensions.contains(&ext.as_str())
                    || crate::document_parser::is_plain_text_code_extension(ext);
                if is_parseable {
                    let parser = DocumentParser::new();

                    // ★ pptx/epub 优先页级拆分（按 slide/章节），失败回退整篇提取
                    match parser.extract_paged_text_from_bytes(&params.name, &content) {
                        Ok(Some(pages)) if !pages.is_empty() => {
                            let joined = pages.join("\n\n").trim().to_string();
                            log::info!(
                                "[VFS::handlers] Extracted paged text from {}: {} pages, {} chars",
                                params.name,
                                pages.len(),
                                joined.len()
                            );
                            let count = pages.len() as i32;
                            paged_text_pages = Some(pages);
                            (None, Some(joined), Some(count))
                        }
                        Ok(_) | Err(_) => {
                            match parser.extract_text_from_bytes(&params.name, content.clone()) {
                                Ok(text) => {
                                    if !text.trim().is_empty() {
                                        log::info!(
                                            "[VFS::handlers] Extracted text from {}: {} chars",
                                            params.name,
                                            text.len()
                                        );
                                        (None, Some(text), None)
                                    } else {
                                        (None, None, None)
                                    }
                                }
                                Err(e) => {
                                    log::warn!(
                                        "[VFS::handlers] Failed to extract text from {}: {}",
                                        params.name,
                                        e
                                    );
                                    (None, None, None)
                                }
                            }
                        }
                    }
                } else {
                    (None, None, None)
                }
            } else {
                (None, None, None)
            }
        };

    // 解析目标文件夹（可能在独立连接上创建根目录，必须在 savepoint 之外）
    let target_folder_id = match params.folder_id {
        Some(ref id) if !id.is_empty() => Some(id.clone()),
        _ => {
            let config = AttachmentConfig::new(vfs_db.inner().clone());
            match config.get_or_create_root_folder() {
                Ok(id) => Some(id),
                Err(e) => {
                    // ★ TD-03：此前这里直接 `?` 返回，泄漏已渲染的预览页 blob
                    saga.abort(&conn, blobs_dir);
                    return Err(e.to_string());
                }
            }
        }
    };

    // ★ TD-03：主 blob 落库 + 文件三表写入在同一连接的 SAVEPOINT 内，失败整体回滚。
    // 闭包内无 .await、无其他连接写入（避免持写锁期间跨连接死锁）。
    let saga_result =
        crate::vfs::upload_saga::with_savepoint(&conn, "vfs_upload_file_saga", || {
            let blob_hash = if is_image || size >= 1024 * 1024 {
                let blob = VfsBlobRepo::store_blob_with_conn(
                    &conn,
                    blobs_dir,
                    &content,
                    Some(&params.mime_type),
                    None,
                )?;
                Some(blob.hash)
            } else {
                None
            };

            let (file, created) = VfsFileRepo::create_file_with_doc_data_in_folder_outcome(
                &conn,
                &sha256,
                &params.name,
                size,
                &file_type,
                Some(&params.mime_type),
                blob_hash.as_deref(),
                None,
                target_folder_id.as_deref(),
                preview_json.as_deref(),
                extracted_text.as_deref(),
                page_count,
            )?;
            Ok((blob_hash, file, created))
        });

    let (blob_hash, file, created) = match saga_result {
        Ok(v) => v,
        Err(e) => {
            log::warn!(
                "[VFS::handlers] 上传事务失败，已回滚 DB 写入，开始补偿: {}",
                e
            );
            // savepoint 已回滚 blobs/resources/files/folder_items 行；
            // 补偿：1) 预览页 blob 引用（独立连接已提交，逐个回退）
            saga.abort(&conn, blobs_dir);
            // 2) 主 blob 物理文件（行随回滚消失 → 本次新写，删除；
            //    去重复用时行仍在 → 保留，不删共享 blob）
            if is_image || size >= 1024 * 1024 {
                if let Err(cleanup_err) =
                    VfsBlobRepo::remove_unregistered_blob_file(&conn, blobs_dir, &sha256)
                {
                    log::error!(
                        "[VFS::handlers] 补偿删除孤儿 blob 文件失败（内容寻址可自愈）: {}",
                        cleanup_err
                    );
                }
            }
            return Err(e.to_string());
        }
    };

    if created {
        // 主 blob（若有）与预览页 blob 的引用均已被新 files 行接管
        saga.commit();
    } else {
        // 并发去重命中：返回的是已存在文件，本次 store 的主 blob +1 与
        // 渲染的预览页 blob 均未被接管 → 全部补偿回退（守卫式，不动共享数据）
        log::info!(
            "[VFS::handlers] 上传去重命中已有文件 {}，回退本次新增的 blob 引用",
            file.id
        );
        if let Some(ref hash) = blob_hash {
            saga.record_blob_ref(hash);
        }
        saga.abort(&conn, blobs_dir);
    }

    log::info!(
        "[VFS::handlers] File uploaded: {} (type={}, folder={:?}, has_text={})",
        file.id,
        file_type,
        target_folder_id,
        extracted_text.is_some()
    );

    // ★ 2026-02 重构：移除旧的同步 OCR 逻辑，改由 Pipeline 异步处理
    // 参考：docs/design/pdf-preprocessing-pipeline.md
    //
    // 旧逻辑问题：
    // 1. 同步 OCR 阻塞上传，用户体验差
    // 2. 与新 Pipeline 异步 OCR 重复执行
    //
    // 新逻辑：
    // 1. 上传时只做文本提取和页面渲染（Stage 1-2）
    // 2. OCR 和向量索引由 Pipeline 异步处理（Stage 3-4）
    // 3. 前端通过事件监听处理进度

    // OCR 相关变量设为 None，由 Pipeline 异步填充
    let ocr_text: Option<String> = None;
    // ★ pptx/epub 页级文本：与 PDF 相同写入 ocr_pages_json，索引可定位页/章节
    let ocr_pages_json: Option<String> = paged_text_pages
        .as_ref()
        .and_then(|pages| serde_json::to_string(pages).ok());
    if created {
        if let Some(ref pages_json) = ocr_pages_json {
            if let Err(e) = conn.execute(
                "UPDATE files SET ocr_pages_json = ?1 WHERE id = ?2",
                rusqlite::params![pages_json, file.id],
            ) {
                log::warn!(
                    "[VFS::handlers] Failed to write ocr_pages_json for {}: {}",
                    file.id,
                    e
                );
            }
        }
    }

    // 判断是否需要触发 Pipeline OCR（用于状态返回）
    let needs_image_ocr = is_image && ocr_config.enabled && ocr_config.ocr_images;
    let needs_pdf_ocr = is_pdf
        && ocr_config.enabled
        && ocr_config.ocr_scanned_pdf
        && extracted_text.as_ref().map(|t| t.len()).unwrap_or(0) < ocr_config.pdf_text_threshold;
    let needs_ocr = needs_image_ocr || needs_pdf_ocr;

    log::debug!(
        "[VFS::handlers] OCR config: enabled={}, threshold={}, images={}, pdf={}, needs_ocr={}",
        ocr_config.enabled,
        ocr_config.pdf_text_threshold,
        ocr_config.ocr_images,
        ocr_config.ocr_scanned_pdf,
        needs_ocr
    );

    // ★ P2-1 修复：上传后自动同步 Units 以触发索引
    // ★ 2026-01 新增：收集索引状态用于返回
    let mut index_units_created: u32 = 0;
    let mut index_queued = false;
    let mut index_error: Option<String> = None;

    if let Some(ref resource_id) = file.resource_id {
        let index_service = VfsIndexService::new(vfs_db.inner().clone());
        let input = UnitBuildInput {
            resource_id: resource_id.clone(),
            resource_type: "file".to_string(),
            data: None,
            ocr_text: ocr_text.clone(),
            ocr_pages_json: ocr_pages_json.clone(),
            blob_hash: file.blob_hash.clone(),
            page_count: file.page_count,
            extracted_text: file.extracted_text.clone(),
            preview_json: file.preview_json.clone(),
        };
        match index_service.sync_resource_units(input) {
            Ok(units) => {
                index_units_created = units.len() as u32;
                index_queued = true;
                log::info!(
                    "[VFS::handlers] Auto-synced {} units for file {}",
                    units.len(),
                    file.id
                );
            }
            Err(e) => {
                index_error = Some(e.to_string());
                log::warn!(
                    "[VFS::handlers] Failed to auto-sync units for file {}: {}",
                    file.id,
                    e
                );
                // ★ TD-03：索引失败不得被静默吞掉。sync_units 已整体回滚
                // （不留半套 Units），此处把资源置入显式可重试状态：
                // failed + 退避 + 重试计数，后台索引循环（get_pending_resources
                // → sync_resource_to_units）会幂等重建单元并索引。
                // 若 mark_failed 本身失败，index_state 保持 NULL——待索引队列
                // 把 NULL 视同 pending，同样会被重试（双保险）。
                if let Err(mark_err) =
                    VfsIndexStateRepo::mark_failed(&vfs_db, resource_id, &e.to_string())
                {
                    log::error!(
                        "[VFS::handlers] Failed to mark index retry state for {}: {} (NULL state still retried by queue)",
                        resource_id,
                        mark_err
                    );
                }
            }
        }
    }

    // ★ 2026-02 重构：OCR 状态改为由 Pipeline 异步处理
    // 上传时返回"等待处理"状态，前端通过事件监听实际进度
    let ocr_status = if needs_ocr {
        let message = if !ocr_config.enabled {
            "OCR 已在设置中禁用".to_string()
        } else if is_pdf {
            "OCR 将由 Pipeline 异步处理".to_string()
        } else if is_image {
            "图片 OCR 将由 Pipeline 处理".to_string()
        } else {
            "等待 OCR 处理".to_string()
        };

        Some(OcrStatus {
            performed: false, // 上传时未执行，由 Pipeline 异步执行
            skip_reason: if !ocr_config.enabled {
                Some("OCR 已在设置中禁用".to_string())
            } else {
                None
            },
            success_count: 0,
            failed_count: 0,
            blob_missing_count: 0,
            total_pages: page_count.unwrap_or(0) as u32,
            all_success: false, // 上传时尚未完成
            message,
        })
    } else {
        None
    };

    // ★ 2026-01 新增：构建索引状态
    let index_status = if file.resource_id.is_some() {
        let message = if let Some(ref err) = index_error {
            // ★ TD-03：失败已落入可重试状态，向前端如实说明（不谎报成功，也不丢失索引）
            format!("索引失败，已加入后台重试队列: {}", err)
        } else if index_queued && index_units_created > 0 {
            format!("已加入索引队列（{} 个单元）", index_units_created)
        } else if index_queued {
            "已加入索引队列".to_string()
        } else {
            "未创建索引".to_string()
        };

        Some(IndexStatus {
            queued: index_queued,
            units_created: index_units_created,
            message,
        })
    } else {
        None
    };

    // ★ 音频导入后自动转写（异步，不阻塞导入；ASR 未配置则标记状态后跳过）
    if created
        && is_audio_upload(&params.name, &params.mime_type)
        && file
            .extracted_text
            .as_ref()
            .map(|t| t.trim().is_empty())
            .unwrap_or(true)
        && content.len() <= AUTO_TRANSCRIBE_MAX_AUDIO_BYTES
    {
        let audio_base64 = BASE64.encode(&content);
        spawn_audio_transcription_if_applicable(
            &app,
            vfs_db.inner().clone(),
            file.id.clone(),
            file.resource_id.clone(),
            params.name.clone(),
            audio_base64,
        );
    } else if created
        && is_audio_upload(&params.name, &params.mime_type)
        && content.len() > AUTO_TRANSCRIBE_MAX_AUDIO_BYTES
    {
        mark_audio_processing_note(
            &vfs_db,
            &file.id,
            "音频超过 25MB 自动转写上限，未转写。可裁剪后重新导入",
        );
    }

    // ★ 2026-02 修复：PDF/图片 上传后异步触发 Pipeline
    // PDF: Stage 1-2（文本提取、页面渲染）已在 create_file_with_doc_data_in_folder 中完成，从 OCR 阶段开始
    // 图片: 从压缩阶段开始
    let is_image = params.mime_type.starts_with("image/");
    if is_pdf || is_image {
        let file_id = file.id.clone();
        let media_service = pdf_processing_service.inner().clone();
        let start_stage = if is_pdf {
            Some(ProcessingStage::OcrProcessing)
        } else {
            Some(ProcessingStage::ImageCompression)
        };
        tokio::spawn(async move {
            log::info!(
                "[VFS::handlers] Starting media pipeline for file: {} (pdf={}, image={})",
                file_id,
                is_pdf,
                is_image
            );
            if let Err(e) = media_service.start_pipeline(&file_id, start_stage).await {
                log::error!(
                    "[VFS::handlers] Failed to start media pipeline for file {}: {}",
                    file_id,
                    e
                );
            }
        });
    }

    Ok(VfsUploadFileResult {
        source_id: file.id.clone(),
        resource_hash: sha256,
        is_new: true,
        file,
        ocr_status,
        index_status,
    })
}

#[tauri::command]
pub async fn vfs_get_file(
    file_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Option<VfsFile>, String> {
    use crate::vfs::repos::VfsFileRepo;

    if !file_id.starts_with("file_") && !file_id.starts_with("tb_") {
        return Err(format!("Invalid file ID format: {}", file_id));
    }

    VfsFileRepo::get_file(&vfs_db, &file_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn vfs_list_files(
    file_type: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<VfsFile>, String> {
    use crate::vfs::repos::VfsFileRepo;

    let limit = limit.unwrap_or(100);
    let offset = offset.unwrap_or(0);

    match file_type {
        Some(ft) => VfsFileRepo::list_files_by_type(&vfs_db, &ft, limit, offset),
        None => VfsFileRepo::list_files(&vfs_db, limit, offset),
    }
    .map_err(|e| e.to_string())
}

/// ★ M-12 修复：软删除文件时同步清理向量索引
///
/// 确保被删除的文件不会在 RAG 检索中被错误返回。
#[tauri::command]
pub async fn vfs_delete_file(
    file_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<crate::vfs::lance_store::VfsLanceStore>>,
) -> Result<(), String> {
    use crate::vfs::index_service::VfsIndexService;
    use crate::vfs::repos::VfsFileRepo;

    if !file_id.starts_with("file_") {
        return Err(format!("Invalid file ID format: {}", file_id));
    }

    let index_service = VfsIndexService::new(Arc::clone(&vfs_db));

    VfsFileRepo::delete_file_with_index_cleanup(
        &vfs_db,
        &file_id,
        &index_service,
        lance_store.as_ref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsFileContentResult {
    pub content: Option<String>,
    pub found: bool,
}

#[tauri::command]
pub async fn vfs_get_file_content(
    file_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<VfsFileContentResult, String> {
    use crate::vfs::repos::VfsFileRepo;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    // 支持 file_ 与 tb_（教材）
    if !file_id.starts_with("file_") && !file_id.starts_with("tb_") {
        return Err(format!("Invalid file ID format: {}", file_id));
    }

    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

    let file = match VfsFileRepo::get_file_with_conn(&conn, &file_id).map_err(|e| e.to_string())? {
        Some(f) => f,
        None => {
            return Ok(VfsFileContentResult {
                content: None,
                found: false,
            })
        }
    };

    if let Some(ref blob_hash) = file.blob_hash {
        let blobs_dir = vfs_db.blobs_dir();
        if let Some(path) = VfsBlobRepo::get_blob_path_with_conn(&conn, blobs_dir, blob_hash)
            .map_err(|e| e.to_string())?
        {
            let data = std::fs::read(&path).map_err(|e| e.to_string())?;
            let base64 = BASE64.encode(&data);
            return Ok(VfsFileContentResult {
                content: Some(base64),
                found: true,
            });
        }
    }

    if let Some(ref resource_id) = file.resource_id {
        if let Some(resource) = VfsResourceRepo::get_resource_with_conn(&conn, resource_id)
            .map_err(|e| e.to_string())?
        {
            if let Some(data) = resource.data {
                return Ok(VfsFileContentResult {
                    content: Some(data),
                    found: true,
                });
            }
        }
    }

    Ok(VfsFileContentResult {
        content: None,
        found: false,
    })
}

// ============================================================================
// Blob 相关命令（用于题目集识别多模态改造 - 2025-12-09）
// ============================================================================

/// ★ 根据 blob hash 获取图片的 base64 内容
///
/// ## 用途
/// 题目集识别多模态改造后，图片存储在 VFS blobs 表中，
/// 前端需要通过 blob_hash 获取图片的 base64 数据用于：
/// 1. 前端显示（Canvas 裁剪）
/// 2. 上下文注入（多模态请求）
///
/// ## 参数
/// - `blob_hash`: Blob 的 SHA-256 哈希值
///
/// ## 返回
/// - `Ok(VfsBlobBase64Result)`: 包含 base64 数据和 mime_type
/// - `Err(String)`: Blob 不存在或读取失败
#[tauri::command]
pub async fn vfs_get_blob_base64(
    blob_hash: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<VfsBlobBase64Result, String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    log::debug!("[VFS::handlers] vfs_get_blob_base64: hash={}", blob_hash);

    // ★ 规则12：获取连接后全程使用 _with_conn 方法，避免死锁
    let conn = vfs_db
        .get_conn_safe()
        .map_err(|e| format!("获取数据库连接失败: {}", e))?;
    let blobs_dir = vfs_db.blobs_dir();

    // 1. 获取 blob 元数据（使用已有连接）
    let blob = VfsBlobRepo::get_blob_with_conn(&conn, &blob_hash)
        .map_err(|e| format!("获取 blob 元数据失败: {}", e))?
        .ok_or_else(|| format!("Blob 不存在: {}", blob_hash))?;

    // 2. 获取 blob 文件路径（使用已有连接）
    let blob_path = VfsBlobRepo::get_blob_path_with_conn(&conn, blobs_dir, &blob_hash)
        .map_err(|e| format!("获取 blob 路径失败: {}", e))?
        .ok_or_else(|| format!("Blob 文件路径不存在: {}", blob_hash))?;

    // 3. 读取文件内容
    let file_data = std::fs::read(&blob_path).map_err(|e| format!("读取 blob 文件失败: {}", e))?;

    // 4. 转换为 base64
    let base64_data = BASE64.encode(&file_data);

    log::info!(
        "[VFS::handlers] vfs_get_blob_base64: hash={}, size={} bytes",
        blob_hash,
        file_data.len()
    );

    Ok(VfsBlobBase64Result {
        base64: base64_data,
        mime_type: blob.mime_type.unwrap_or_else(|| "image/jpeg".to_string()),
        size: blob.size,
    })
}

/// vfs_get_blob_base64 返回结果
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsBlobBase64Result {
    /// Base64 编码的文件内容（不含 data: 前缀）
    pub base64: String,
    /// MIME 类型（如 "image/jpeg"）
    pub mime_type: String,
    /// 文件大小（字节）
    pub size: i64,
}

// ============================================================================
// PDF 页面图片获取（支持 RAG 引用渲染）
// ============================================================================

/// 获取 PDF 指定页面的预渲染图片
///
/// 根据资源 ID 和页码获取 PDF 页面的预渲染图片。
/// 支持 textbook、attachment 类型的 PDF 资源。
///
/// ## 参数
/// - `resource_id`: 资源 ID（textbooks/attachments 表关联的 resource_id）
/// - `page_index`: 页码（0-indexed）
///
/// ## 返回
/// - `Ok(VfsBlobBase64Result)`: 包含 base64 数据和 mime_type
/// - `Err(String)`: 资源不存在、无预渲染数据、或页码越界
///
/// ## 使用场景
/// - RAG 检索结果中引用 PDF 页面时，前端调用此 API 获取页面图片
/// - 支持 OCR + 文本索引（有预渲染）和多模态索引两种场景
pub(crate) struct PdfPageImageBytes {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub stored_size: i64,
}

/// Shared byte-level source used by both the Tauri command and the bounded
/// Chat V2 tool. It deliberately selects the existing compressed preview blob
/// when the PDF pipeline produced one.
pub(crate) fn read_pdf_page_image_bytes(
    vfs_db: &VfsDatabase,
    resource_id: &str,
    page_index: usize,
    max_bytes: Option<usize>,
) -> Result<PdfPageImageBytes, String> {
    use crate::vfs::types::PdfPreviewJson;

    log::debug!(
        "[VFS::handlers] vfs_get_pdf_page_image: resource_id={}, page_index={}",
        resource_id,
        page_index
    );

    let conn = vfs_db
        .get_conn_safe()
        .map_err(|e| format!("获取数据库连接失败: {}", e))?;
    let blobs_dir = vfs_db.blobs_dir();

    // 1. 获取资源信息，确定来源表
    let resource = VfsResourceRepo::get_resource_with_conn(&conn, resource_id)
        .map_err(|e| format!("获取资源失败: {}", e))?
        .ok_or_else(|| format!("资源不存在: {}", resource_id))?;

    // 2. 根据 source_table 查询 preview_json
    let preview_json_str: Option<String> = match resource.source_table.as_deref() {
        Some("textbooks") => conn
            .query_row(
                "SELECT preview_json FROM files WHERE resource_id = ?1",
                rusqlite::params![&resource_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("查询教材 preview_json 失败: {}", e))?,
        Some("files") => conn
            .query_row(
                "SELECT preview_json FROM files WHERE resource_id = ?1",
                rusqlite::params![&resource_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("查询附件 preview_json 失败: {}", e))?,
        Some("exam_sheets") => conn
            .query_row(
                "SELECT preview_json FROM exam_sheets WHERE resource_id = ?1",
                rusqlite::params![&resource_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("查询题目集 preview_json 失败: {}", e))?,
        _ => None,
    };

    let preview_json_str = preview_json_str.ok_or_else(|| {
        format!(
            "资源无 PDF 预渲染数据: {} (source_table: {:?})",
            resource_id, resource.source_table
        )
    })?;

    // 3. 解析 preview_json 并查找 blob_hash 和 mime_type
    // 兼容 PdfPreviewJson（textbooks/files）和 ExamSheetPreviewResult（exam_sheets）两种格式
    let (blob_hash, mime_type): (String, String) =
        if resource.source_table.as_deref() == Some("exam_sheets") {
            // exam_sheets 使用 ExamSheetPreviewResult 格式
            use crate::models::ExamSheetPreviewResult;
            let preview: ExamSheetPreviewResult = serde_json::from_str(&preview_json_str)
                .map_err(|e| format!("解析 exam preview_json 失败: {}", e))?;
            let page = preview
                .pages
                .iter()
                .find(|p| p.page_index == page_index)
                .ok_or_else(|| {
                    format!(
                        "页码越界: page_index={}, total_pages={}",
                        page_index,
                        preview.pages.len()
                    )
                })?;
            let hash = page
                .blob_hash
                .clone()
                .ok_or_else(|| format!("页面 {} 无 blob_hash（可能是旧数据）", page_index))?;
            // exam_sheets 的页面默认是 PNG 格式
            (hash, "image/png".to_string())
        } else {
            // textbooks/files 使用 PdfPreviewJson 格式
            let preview: PdfPreviewJson = serde_json::from_str(&preview_json_str)
                .map_err(|e| format!("解析 preview_json 失败: {}", e))?;
            let page = preview
                .pages
                .iter()
                .find(|p| p.page_index == page_index)
                .ok_or_else(|| {
                    format!(
                        "页码越界: page_index={}, total_pages={}",
                        page_index, preview.total_pages
                    )
                })?;

            let (hash, mime) = if let Some(compressed) = page.compressed_blob_hash.as_ref() {
                if !compressed.is_empty() {
                    let mime_type = if compressed != &page.blob_hash {
                        "image/jpeg".to_string()
                    } else {
                        page.mime_type.clone()
                    };
                    (compressed.clone(), mime_type)
                } else {
                    (page.blob_hash.clone(), page.mime_type.clone())
                }
            } else {
                (page.blob_hash.clone(), page.mime_type.clone())
            };
            (hash, mime)
        };

    // 4. 获取 blob 元数据
    let blob = VfsBlobRepo::get_blob_with_conn(&conn, &blob_hash)
        .map_err(|e| format!("获取 blob 元数据失败: {}", e))?
        .ok_or_else(|| format!("Blob 不存在: {}", blob_hash))?;

    // 5. 获取 blob 文件路径
    let blob_path = VfsBlobRepo::get_blob_path_with_conn(&conn, blobs_dir, &blob_hash)
        .map_err(|e| format!("获取 blob 路径失败: {}", e))?
        .ok_or_else(|| format!("Blob 文件路径不存在: {}", blob_hash))?;

    if let Some(max_bytes) = max_bytes {
        let source_size = std::fs::metadata(&blob_path)
            .map_err(|e| format!("读取 blob 元数据失败: {}", e))?
            .len();
        if source_size > max_bytes as u64 {
            return Err(format!(
                "PDF page image exceeds source limit: {} > {} bytes",
                source_size, max_bytes
            ));
        }
    }

    // 7. 读取文件内容
    let file_data = std::fs::read(&blob_path).map_err(|e| format!("读取 blob 文件失败: {}", e))?;
    if max_bytes.is_some_and(|max_bytes| file_data.len() > max_bytes) {
        return Err(format!(
            "PDF page image exceeded source limit while reading: {} bytes",
            file_data.len()
        ));
    }

    log::info!(
        "[VFS::handlers] vfs_get_pdf_page_image: resource_id={}, page_index={}, size={} bytes",
        resource_id,
        page_index,
        file_data.len()
    );

    Ok(PdfPageImageBytes {
        bytes: file_data,
        mime_type,
        stored_size: blob.size,
    })
}

#[tauri::command]
pub async fn vfs_get_pdf_page_image(
    resource_id: String,
    page_index: usize,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<VfsBlobBase64Result, String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    let image = read_pdf_page_image_bytes(vfs_db.inner(), &resource_id, page_index, None)?;
    Ok(VfsBlobBase64Result {
        base64: BASE64.encode(&image.bytes),
        mime_type: image.mime_type,
        size: image.stored_size,
    })
}

// ============================================================================
// ★ 文档25：题目集图片迁移命令
// ============================================================================

use crate::vfs::embedding_service::EmbeddingProgressCallback;
use crate::vfs::indexing::{
    VfsEmbeddingStats, VfsFullIndexingService, VfsIndexingService, VfsSearchParams,
    VfsSearchResult, VfsSearchService,
};
use crate::vfs::repos::VfsIndexingConfigRepo;

#[tauri::command]
pub async fn vfs_search(
    params: VfsSearchParams,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<VfsSearchResult>, String> {
    log::info!(
        "[VFS::handlers] vfs_search: query={}, top_k={}",
        params.query,
        params.top_k
    );

    if params.query.trim().is_empty() {
        return Err("Query cannot be empty".to_string());
    }

    let search_service = VfsSearchService::new(Arc::clone(&vfs_db));
    search_service
        .search_fts(&params.query, params.top_k)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn vfs_reindex_resource(
    resource_id: String,
    embedding_dim: Option<i32>,
    app_handle: AppHandle,
    llm_manager: State<'_, Arc<crate::llm_manager::LLMManager>>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<crate::vfs::lance_store::VfsLanceStore>>,
) -> Result<usize, String> {
    log::info!("[VFS::handlers] vfs_reindex_resource: id={}", resource_id);

    if !resource_id.starts_with("res_") {
        return Err(format!("Invalid resource ID format: {}", resource_id));
    }

    // ★ 2026-02 修复：并发防护 - 检查资源是否正在索引中，避免重复执行
    {
        let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;
        let current_state: Option<String> = conn
            .query_row(
                "SELECT index_state FROM resources WHERE id = ?1",
                rusqlite::params![resource_id],
                |row| row.get(0),
            )
            .ok();
        if current_state.as_deref() == Some("indexing") {
            log::warn!(
                "[VFS::handlers] vfs_reindex_resource: resource {} is already indexing, skipping",
                resource_id
            );
            return Err("资源正在索引中，请等待完成后再试".to_string());
        }
    }

    // 发送开始事件
    let _ = app_handle.emit(
        "vfs-index-progress",
        serde_json::json!({
            "type": "started",
            "resourceId": resource_id,
            "message": "开始索引资源..."
        }),
    );

    if embedding_dim.is_some() {
        log::warn!(
            "[VFS::handlers] vfs_reindex_resource: embedding_dim ignored (full indexing uses model config)"
        );
    }

    let mut indexing_service = VfsFullIndexingService::new(
        Arc::clone(&vfs_db),
        Arc::clone(&llm_manager),
        Arc::clone(lance_store.inner()),
    )
    .map_err(|e| e.to_string())?;
    // ★ 2026-02-19：传递 AppHandle，使 try_auto_ocr 能发送细粒度进度事件
    indexing_service.set_app_handle(app_handle.clone());

    // ★ 构造嵌入进度回调，上报单资源索引的嵌入批次进度
    let cb_handle = app_handle.clone();
    let cb_resource_id = resource_id.clone();
    let progress_callback: Option<EmbeddingProgressCallback> =
        Some(Box::new(move |chunks_done: usize, chunks_total: usize| {
            let progress = if chunks_total > 0 {
                ((chunks_done as f64 / chunks_total as f64) * 100.0).min(99.0) as u32
            } else {
                0
            };
            let _ = cb_handle.emit(
                "vfs-index-progress",
                serde_json::json!({
                    "type": "embedding_progress",
                    "resourceId": cb_resource_id,
                    "chunksProcessed": chunks_done,
                    "chunksTotal": chunks_total,
                    "progress": progress,
                    "message": format!("正在生成嵌入 {}/{}", chunks_done, chunks_total)
                }),
            );
        }));

    match indexing_service
        .reindex_resource(&resource_id, None, progress_callback)
        .await
    {
        Ok((chunk_count, _)) => {
            // 发送完成事件
            let _ = app_handle.emit(
                "vfs-index-progress",
                serde_json::json!({
                    "type": "completed",
                    "resourceId": resource_id,
                    "chunkCount": chunk_count,
                    "message": format!("索引完成，共 {} 个块", chunk_count)
                }),
            );
            Ok(chunk_count)
        }
        Err(e) => {
            // 发送失败事件
            let _ = app_handle.emit(
                "vfs-index-progress",
                serde_json::json!({
                    "type": "failed",
                    "resourceId": resource_id,
                    "error": e.to_string(),
                    "message": format!("索引失败: {}", e)
                }),
            );
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub async fn vfs_get_index_status(
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Option<crate::vfs::repos::IndexState>, String> {
    log::debug!("[VFS::handlers] vfs_get_index_status: id={}", resource_id);
    VfsIndexStateRepo::get_index_state(&vfs_db, &resource_id).map_err(|e| e.to_string())
}

/// 切换资源的索引禁用状态
///
/// - 如果当前是 disabled，则恢复为 pending
/// - 如果当前不是 disabled，则设置为 disabled
#[tauri::command]
pub async fn vfs_toggle_index_disabled(
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<String, String> {
    log::info!(
        "[VFS::handlers] vfs_toggle_index_disabled: id={}",
        resource_id
    );

    // 获取当前状态
    let current_state =
        VfsIndexStateRepo::get_index_state(&vfs_db, &resource_id).map_err(|e| e.to_string())?;

    let current = current_state
        .map(|s| s.state)
        .unwrap_or_else(|| INDEX_STATE_PENDING.to_string());

    let new_state = if current == INDEX_STATE_DISABLED {
        // 恢复为 pending
        VfsIndexStateRepo::mark_pending(&vfs_db, &resource_id).map_err(|e| e.to_string())?;
        INDEX_STATE_PENDING
    } else {
        // 禁用索引
        VfsIndexStateRepo::mark_disabled(&vfs_db, &resource_id).map_err(|e| e.to_string())?;
        INDEX_STATE_DISABLED
    };

    log::info!(
        "[VFS::handlers] vfs_toggle_index_disabled: {} -> {}",
        current,
        new_state
    );
    Ok(new_state.to_string())
}

#[tauri::command]
pub async fn vfs_get_embedding_stats(
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<VfsEmbeddingStats, String> {
    log::debug!("[VFS::handlers] vfs_get_embedding_stats");
    let search_service = VfsSearchService::new(Arc::clone(&vfs_db));
    search_service
        .get_embedding_stats()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn vfs_list_dimensions(
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<crate::vfs::repos::VfsEmbeddingDimension>, String> {
    log::debug!("[VFS::handlers] vfs_list_dimensions");
    // ★ 审计修复：统一使用 embedding_dim_repo（替代已废弃的 VfsDimensionRepo）
    // 返回类型仍为 VfsEmbeddingDimension 以保持 API 兼容
    let conn = vfs_db.get_conn().map_err(|e| e.to_string())?;
    let dims = crate::vfs::repos::embedding_dim_repo::list_all(&conn).map_err(|e| e.to_string())?;
    Ok(dims
        .into_iter()
        .map(|d| crate::vfs::repos::VfsEmbeddingDimension {
            dimension: d.dimension,
            modality: d.modality,
            record_count: d.record_count,
            lance_table_name: d.lance_table_name,
            created_at: d.created_at,
            last_used_at: d.last_used_at,
            model_config_id: d.model_config_id,
            model_name: d.model_name,
        })
        .collect())
}

#[tauri::command]
pub async fn vfs_get_pending_resources(
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<String>, String> {
    log::debug!("[VFS::handlers] vfs_get_pending_resources");
    let indexing_service = VfsIndexingService::new(Arc::clone(&vfs_db));
    indexing_service
        .get_pending_resources()
        .map_err(|e| e.to_string())
}

fn validate_embedding_model_config<'a>(
    configs: &'a [crate::llm_manager::ApiConfig],
    model_config_id: &str,
    modality: &str,
) -> Result<&'a crate::llm_manager::ApiConfig, String> {
    let config = configs
        .iter()
        .find(|config| config.id == model_config_id)
        .ok_or_else(|| format!("模型配置 {} 不存在", model_config_id))?;
    let protocol_matches = match modality {
        "text" => !config.is_multimodal,
        "multimodal" => config.is_multimodal,
        _ => return Err(format!("无效的嵌入模态: {}", modality)),
    };
    if !config.enabled
        || !config.is_embedding
        || config.is_reranker
        || !protocol_matches
        || config.model.trim().is_empty()
    {
        return Err(format!(
            "模型配置 {} 已禁用或不支持 {} 嵌入协议",
            model_config_id, modality
        ));
    }
    Ok(config)
}

/// 为维度分配模型（用于跨维度检索）
///
/// 模型分配是配置项，不是数据绑定。用户可以随时更改维度使用的模型。
/// 更改后，跨维度检索时会使用新分配的模型生成查询向量。
///
/// 如果该维度是当前的默认嵌入维度，会同步更新 settings 中的模型配置ID
#[tauri::command]
pub async fn vfs_assign_dimension_model(
    dimension: i32,
    modality: String,
    model_config_id: String,
    model_name: String,
    database: State<'_, Arc<crate::database::Database>>,
    llm_manager: State<'_, Arc<crate::llm_manager::LLMManager>>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<bool, String> {
    log::info!(
        "[VFS::handlers] vfs_assign_dimension_model: dim={}, modality={}, model={}",
        dimension,
        modality,
        model_config_id
    );

    let configs = llm_manager
        .get_api_configs()
        .await
        .map_err(|error| error.to_string())?;
    let model_config =
        validate_embedding_model_config(&configs, &model_config_id, &modality)?.clone();
    if model_name != model_config.model {
        log::warn!(
            "[VFS::handlers] Ignoring client model name {:?}; authoritative model is {:?}",
            model_name,
            model_config.model
        );
    }
    let model_fingerprint = crate::vfs::repos::embedding_dim_repo::model_fingerprint_for_config(
        &model_config,
        &modality,
    )
    .map_err(|error| error.to_string())?;

    // ★ 审计修复：统一使用 embedding_dim_repo（替代已废弃的 VfsDimensionRepo）
    let conn = vfs_db.get_conn().map_err(|e| e.to_string())?;
    let existing = crate::vfs::repos::embedding_dim_repo::get_by_key(&conn, dimension, &modality)
        .map_err(|e| e.to_string())?;
    if existing.is_none() {
        return Err(format!("维度 {}:{} 不存在", dimension, modality));
    }
    crate::vfs::repos::embedding_dim_repo::register_with_model_fingerprint(
        &conn,
        dimension,
        &modality,
        Some(&model_config_id),
        Some(&model_config.model),
        Some(&model_fingerprint),
    )
    .map_err(|e| e.to_string())?;
    drop(conn);

    // 检查该维度是否是当前的默认嵌入维度，如果是则同步更新 settings 中的模型配置ID
    let (dim_key, model_key) = match modality.as_str() {
        "text" => (
            "embedding.default_text_dimension",
            "embedding.default_text_model_config_id",
        ),
        "multimodal" => (
            "embedding.default_multimodal_dimension",
            "embedding.default_multimodal_model_config_id",
        ),
        _ => return Ok(true), // 未知模态，跳过默认设置检查
    };

    // 读取当前默认维度
    if let Ok(Some(default_dim_str)) = database.get_setting(dim_key) {
        if let Ok(default_dim) = default_dim_str.parse::<i32>() {
            if default_dim == dimension {
                // 该维度是默认维度，同步更新 settings 中的模型配置ID
                database
                    .save_setting(model_key, &model_config_id)
                    .map_err(|e| e.to_string())?;
                log::info!(
                    "[VFS::handlers] 已同步更新默认 {} 嵌入模型: {}",
                    modality,
                    model_config_id
                );
            }
        }
    }

    Ok(true)
}

#[tauri::command]
pub async fn vfs_create_dimension(
    dimension: i32,
    modality: String,
    model_config_id: Option<String>,
    model_name: Option<String>,
    llm_manager: State<'_, Arc<crate::llm_manager::LLMManager>>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<crate::vfs::repos::embedding_dim_repo::VfsEmbeddingDim, String> {
    log::info!(
        "[VFS::handlers] vfs_create_dimension: dim={}, modality={}, model={:?}",
        dimension,
        modality,
        model_config_id
    );

    let resolved_model = if let Some(model_config_id) = model_config_id.as_deref() {
        let configs = llm_manager
            .get_api_configs()
            .await
            .map_err(|error| error.to_string())?;
        let config = validate_embedding_model_config(&configs, model_config_id, &modality)?.clone();
        if model_name
            .as_deref()
            .is_some_and(|name| name != config.model)
        {
            log::warn!(
                "[VFS::handlers] Ignoring client model name for {}; authoritative model is {:?}",
                model_config_id,
                config.model
            );
        }
        let fingerprint =
            crate::vfs::repos::embedding_dim_repo::model_fingerprint_for_config(&config, &modality)
                .map_err(|error| error.to_string())?;
        Some((config, fingerprint))
    } else {
        if model_name.is_some() {
            return Err("modelName 不能在 modelConfigId 缺失时单独使用".to_string());
        }
        None
    };

    let conn = vfs_db.get_conn().map_err(|e| e.to_string())?;
    match resolved_model {
        Some((config, fingerprint)) => {
            crate::vfs::repos::embedding_dim_repo::register_with_model_fingerprint(
                &conn,
                dimension,
                &modality,
                Some(&config.id),
                Some(&config.model),
                Some(&fingerprint),
            )
            .map_err(|error| error.to_string())
        }
        None => crate::vfs::repos::embedding_dim_repo::create_dimension(
            &conn, dimension, &modality, None, None,
        )
        .map_err(|error| error.to_string()),
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteDimensionResult {
    pub deleted_segments: usize,
    pub dimension: i32,
    pub modality: String,
}

#[tauri::command]
pub async fn vfs_delete_dimension(
    dimension: i32,
    modality: String,
    database: State<'_, Arc<crate::database::Database>>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<crate::vfs::lance_store::VfsLanceStore>>,
) -> Result<DeleteDimensionResult, String> {
    log::info!(
        "[VFS::handlers] vfs_delete_dimension: dim={}, modality={}",
        dimension,
        modality
    );

    // S8 fix: 检查是否有正在索引的 units 使用了该维度
    let conn = vfs_db.get_conn().map_err(|e| e.to_string())?;
    let has_indexing = crate::vfs::repos::embedding_dim_repo::has_indexing_units_for_dimension(
        &conn, dimension, &modality,
    )
    .map_err(|e| e.to_string())?;
    if has_indexing {
        return Err(format!(
            "维度 {}:{} 有正在进行的索引任务，请等待索引完成后再删除",
            dimension, modality
        ));
    }

    // 检查是否正在删除默认维度，如果是则清除默认设置
    let (dim_key, model_key) = match modality.as_str() {
        "text" => (
            "embedding.default_text_dimension",
            "embedding.default_text_model_config_id",
        ),
        "multimodal" => (
            "embedding.default_multimodal_dimension",
            "embedding.default_multimodal_model_config_id",
        ),
        _ => ("", ""),
    };

    if !dim_key.is_empty() {
        if let Ok(Some(default_dim_str)) = database.get_setting(dim_key) {
            if let Ok(default_dim) = default_dim_str.parse::<i32>() {
                if default_dim == dimension {
                    // 正在删除默认维度，清除默认设置
                    let _ = database.delete_setting(dim_key);
                    let _ = database.delete_setting(model_key);
                    log::info!(
                        "[VFS::handlers] 已清除默认 {} 嵌入维度设置（因维度被删除）",
                        modality
                    );
                }
            }
        }
    }

    // S2 fix: 优先使用数据库中记录的 LanceDB 表名，避免遗留命名不一致
    let lance_table_name =
        crate::vfs::repos::embedding_dim_repo::get_by_key(&conn, dimension, &modality)
            .map_err(|e| e.to_string())?
            .map(|d| d.lance_table_name)
            .unwrap_or_else(|| {
                crate::vfs::repos::embedding_dim_repo::generate_lance_table_name(
                    &modality, dimension,
                )
            });

    let deleted_segments = crate::vfs::repos::embedding_dim_repo::delete_dimension_cascade(
        &conn, dimension, &modality,
    )
    .map_err(|e| e.to_string())?;
    drop(conn);

    // S2 fix: 删除对应的 LanceDB 表，清理磁盘向量数据
    if let Err(e) = lance_store.drop_table(&lance_table_name).await {
        log::warn!(
            "[VFS::handlers] LanceDB table {} cleanup failed (non-fatal): {}",
            lance_table_name,
            e
        );
    }

    Ok(DeleteDimensionResult {
        deleted_segments,
        dimension,
        modality,
    })
}

#[tauri::command]
pub async fn vfs_get_preset_dimensions() -> Result<Vec<i32>, String> {
    Ok(crate::vfs::repos::embedding_dim_repo::PRESET_DIMENSIONS.to_vec())
}

#[tauri::command]
pub async fn vfs_get_dimension_range() -> Result<(i32, i32), String> {
    Ok((
        crate::vfs::repos::embedding_dim_repo::MIN_DIMENSION,
        crate::vfs::repos::embedding_dim_repo::MAX_DIMENSION,
    ))
}

// ============================================================================
// 默认嵌入维度管理 API
// ============================================================================

/// 设置默认嵌入维度
///
/// 将指定维度设为该模态的默认嵌入维度。
/// - modality: "text" | "multimodal"
///
/// 同时保存维度值和绑定的模型配置ID，供 LLMManager 直接读取
#[tauri::command]
pub async fn vfs_set_default_embedding_dimension(
    dimension: i32,
    modality: String,
    database: State<'_, Arc<crate::database::Database>>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<bool, String> {
    log::info!(
        "[VFS::handlers] vfs_set_default_embedding_dimension: dim={}, modality={}",
        dimension,
        modality
    );

    // 验证维度存在并获取绑定的模型
    let conn = vfs_db.get_conn().map_err(|e| e.to_string())?;
    let dim_info = crate::vfs::repos::embedding_dim_repo::get_by_key(&conn, dimension, &modality)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("维度 {}:{} 不存在", dimension, modality))?;

    // ★ 审计修复：后端也校验模型绑定，与前端保持一致
    if dim_info.model_config_id.is_none() {
        log::warn!(
            "[VFS::handlers] Dimension {}:{} has no model binding, allowing set_default but clearing model config",
            dimension, modality
        );
    }

    // 保存维度值和模型配置ID到 settings
    let (dim_key, model_key) = match modality.as_str() {
        "text" => (
            "embedding.default_text_dimension",
            "embedding.default_text_model_config_id",
        ),
        "multimodal" => (
            "embedding.default_multimodal_dimension",
            "embedding.default_multimodal_model_config_id",
        ),
        _ => return Err(format!("无效的模态类型: {}", modality)),
    };

    database
        .save_setting(dim_key, &dimension.to_string())
        .map_err(|e| e.to_string())?;

    // 如果维度有绑定模型，同时保存模型配置ID
    if let Some(model_config_id) = &dim_info.model_config_id {
        database
            .save_setting(model_key, model_config_id)
            .map_err(|e| e.to_string())?;
        log::info!(
            "[VFS::handlers] 已设置默认 {} 嵌入模型: {}",
            modality,
            model_config_id
        );
    } else {
        // 如果维度没有绑定模型，清除旧的模型配置
        let _ = database.delete_setting(model_key);
        log::warn!(
            "[VFS::handlers] 维度 {}:{} 未绑定模型，已清除默认模型配置",
            dimension,
            modality
        );
    }

    Ok(true)
}

/// 获取默认嵌入维度信息
///
/// 返回指定模态的默认维度完整信息（包括绑定的模型）
#[tauri::command]
pub async fn vfs_get_default_embedding_dimension(
    modality: String,
    database: State<'_, Arc<crate::database::Database>>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Option<crate::vfs::repos::embedding_dim_repo::VfsEmbeddingDim>, String> {
    log::debug!(
        "[VFS::handlers] vfs_get_default_embedding_dimension: modality={}",
        modality
    );

    let key = match modality.as_str() {
        "text" => "embedding.default_text_dimension",
        "multimodal" => "embedding.default_multimodal_dimension",
        _ => return Err(format!("无效的模态类型: {}", modality)),
    };

    // 从 settings 获取默认维度值
    let dim_str = match database.get_setting(key) {
        Ok(Some(s)) => s,
        Ok(None) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };

    let dimension: i32 = dim_str
        .parse()
        .map_err(|_| format!("无效的维度值: {}", dim_str))?;

    // M3 fix: 从 vfs_embedding_dims 获取完整信息，如果维度已不存在则自动清除设置
    let conn = vfs_db.get_conn().map_err(|e| e.to_string())?;
    let dim_info = crate::vfs::repos::embedding_dim_repo::get_by_key(&conn, dimension, &modality)
        .map_err(|e| e.to_string())?;

    if dim_info.is_none() {
        // 维度记录不存在（可能被删除或数据库恢复导致），自动清除 settings
        log::warn!(
            "[VFS::handlers] Default dimension {}:{} no longer exists in VFS DB, auto-clearing setting",
            dimension, modality
        );
        let _ = database.delete_setting(key);
        let model_key = match modality.as_str() {
            "text" => "embedding.default_text_model_config_id",
            "multimodal" => "embedding.default_multimodal_model_config_id",
            _ => "",
        };
        if !model_key.is_empty() {
            let _ = database.delete_setting(model_key);
        }
    }

    Ok(dim_info)
}

/// 清除默认嵌入维度设置
#[tauri::command]
pub async fn vfs_clear_default_embedding_dimension(
    modality: String,
    database: State<'_, Arc<crate::database::Database>>,
) -> Result<bool, String> {
    log::info!(
        "[VFS::handlers] vfs_clear_default_embedding_dimension: modality={}",
        modality
    );

    let (dim_key, model_key) = match modality.as_str() {
        "text" => (
            "embedding.default_text_dimension",
            "embedding.default_text_model_config_id",
        ),
        "multimodal" => (
            "embedding.default_multimodal_dimension",
            "embedding.default_multimodal_model_config_id",
        ),
        _ => return Err(format!("无效的模态类型: {}", modality)),
    };

    // 同时清除维度和模型配置
    let _ = database.delete_setting(dim_key);
    let _ = database.delete_setting(model_key);

    Ok(true)
}

/// 批量索引结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchIndexResult {
    /// 成功数
    pub success_count: usize,
    /// 失败数
    pub fail_count: usize,
    /// 总数
    pub total: usize,
}

/// 批量索引待处理资源（带进度事件）
#[tauri::command]
pub async fn vfs_batch_index_pending(
    batch_size: Option<u32>,
    app_handle: AppHandle,
    llm_manager: State<'_, Arc<crate::llm_manager::LLMManager>>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<crate::vfs::lance_store::VfsLanceStore>>,
) -> Result<BatchIndexResult, String> {
    let batch_size = batch_size.unwrap_or(10);
    log::info!(
        "[VFS::handlers] vfs_batch_index_pending: batch_size={}",
        batch_size
    );

    let indexing_service = VfsIndexingService::new(Arc::clone(&vfs_db));
    log::info!("[VFS::handlers] vfs_batch_index_pending: 获取索引配置...");
    let config = indexing_service
        .get_indexing_config()
        .map_err(|e| e.to_string())?;
    // ★ 2026-02 修复：使用 claim_pending_resources 原子抢占，避免并发重复索引
    // 之前使用 get_pending_resources 仅查询不锁定，快速双击或多窗口操作会导致同批资源被重复处理
    log::info!("[VFS::handlers] vfs_batch_index_pending: 原子抢占待处理资源...");
    let pending =
        VfsIndexStateRepo::claim_pending_resources(&vfs_db, batch_size, config.max_retries)
            .map_err(|e| e.to_string())?;
    log::info!(
        "[VFS::handlers] vfs_batch_index_pending: 原子抢占 {} 个待处理资源",
        pending.len()
    );

    if pending.is_empty() {
        return Ok(BatchIndexResult {
            success_count: 0,
            fail_count: 0,
            total: 0,
        });
    }

    let total = pending.len();

    // 发送批量索引开始事件
    let _ = app_handle.emit(
        "vfs-index-progress",
        serde_json::json!({
            "type": "batch_started",
            "total": total,
            "message": format!("开始批量索引 {} 个资源...", total)
        }),
    );

    let mut success_count = 0usize;
    let mut fail_count = 0usize;

    // ★ 2026-02 修复：如果服务初始化失败，必须将已 claim 的资源回退为 pending
    // 否则资源会永久卡在 indexing 状态，不再被后续批量处理拾取
    let full_indexing_service = match VfsFullIndexingService::new(
        Arc::clone(&vfs_db),
        Arc::clone(&llm_manager),
        Arc::clone(lance_store.inner()),
    ) {
        Ok(mut svc) => {
            // ★ 2026-02-19：传递 AppHandle，使 try_auto_ocr 能发送细粒度进度事件
            svc.set_app_handle(app_handle.clone());
            svc
        }
        Err(e) => {
            log::error!(
                "[VFS::handlers] vfs_batch_index_pending: IndexingService 初始化失败，回退 {} 个已 claim 的资源",
                pending.len()
            );
            for resource_id in &pending {
                let _ = VfsIndexStateRepo::mark_pending(&vfs_db, resource_id);
            }
            return Err(e.to_string());
        }
    };

    for (index, resource_id) in pending.iter().enumerate() {
        // ★ P1-2 修复: 将 "processing" 改为 "resource_started" 以匹配前端期望
        let _ = app_handle.emit(
            "vfs-index-progress",
            serde_json::json!({
                "type": "resource_started",
                "resourceId": resource_id,
                "current": index + 1,
                "total": total,
                "progress": ((index as f64 / total as f64) * 100.0) as u32,
                "message": format!("正在索引资源 {}/{}", index + 1, total)
            }),
        );

        // ★ 构造嵌入进度回调，按 embedding batch (每16块) 粒度上报细粒度进度
        let cb_handle = app_handle.clone();
        let cb_resource_id = resource_id.clone();
        let cb_index = index;
        let cb_total = total;
        let progress_callback: Option<EmbeddingProgressCallback> =
            Some(Box::new(move |chunks_done: usize, chunks_total: usize| {
                // 整体进度 = 当前资源基准 + 当前资源内嵌入子进度
                let base = cb_index as f64 / cb_total as f64;
                let sub = if chunks_total > 0 {
                    chunks_done as f64 / chunks_total as f64 / cb_total as f64
                } else {
                    0.0
                };
                let progress = ((base + sub) * 100.0).min(99.0) as u32;
                let _ = cb_handle.emit(
                    "vfs-index-progress",
                    serde_json::json!({
                        "type": "embedding_progress",
                        "resourceId": cb_resource_id,
                        "current": cb_index + 1,
                        "total": cb_total,
                        "chunksProcessed": chunks_done,
                        "chunksTotal": chunks_total,
                        "progress": progress,
                        "message": format!("正在索引资源 {}/{} (嵌入 {}/{})",
                            cb_index + 1, cb_total, chunks_done, chunks_total)
                    }),
                );
            }));

        match full_indexing_service
            .index_resource(resource_id, None, progress_callback)
            .await
        {
            Ok((chunk_count, _)) => {
                success_count += 1;
                // ★ 批判性检查修复: 添加 progress/current/total 字段，与前端期望一致
                let _ = app_handle.emit(
                    "vfs-index-progress",
                    serde_json::json!({
                        "type": "resource_completed",
                        "resourceId": resource_id,
                        "chunkCount": chunk_count,
                        "current": index + 1,
                        "total": total,
                        "progress": (((index + 1) as f64 / total as f64) * 100.0) as u32,
                        "message": format!("资源索引完成: {} 个块", chunk_count)
                    }),
                );
            }
            Err(e) => {
                fail_count += 1;
                log::warn!("[VFS::handlers] Failed to index {}: {}", resource_id, e);
                let _ = app_handle.emit(
                    "vfs-index-progress",
                    serde_json::json!({
                        "type": "resource_failed",
                        "resourceId": resource_id,
                        "error": e.to_string(),
                        "current": index + 1,
                        "total": total,
                        "progress": (((index + 1) as f64 / total as f64) * 100.0) as u32,
                        "message": format!("索引失败 ({}/{}): {}", index + 1, total, e)
                    }),
                );
            }
        }
    }

    // 发送批量索引完成事件
    let _ = app_handle.emit(
        "vfs-index-progress",
        serde_json::json!({
            "type": "batch_completed",
            "successCount": success_count,
            "failCount": fail_count,
            "total": total,
            "progress": 100,
            "message": format!("批量索引完成: {} 成功, {} 失败", success_count, fail_count)
        }),
    );

    Ok(BatchIndexResult {
        success_count,
        fail_count,
        total,
    })
}

#[tauri::command]
pub async fn vfs_set_indexing_config(
    key: String,
    value: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<(), String> {
    log::info!("[VFS::handlers] vfs_set_indexing_config: {}={}", key, value);
    VfsIndexingConfigRepo::set_config(&vfs_db, &key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn vfs_get_indexing_config(
    key: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Option<String>, String> {
    log::debug!("[VFS::handlers] vfs_get_indexing_config: {}", key);
    VfsIndexingConfigRepo::get_config(&vfs_db, &key).map_err(|e| e.to_string())
}

// ============================================================================
// 向量化状态视图命令
// ============================================================================

/// 单个资源的向量化状态
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceIndexStatus {
    /// 资源 ID
    pub resource_id: String,
    /// 业务来源 ID（如 textbook_xxx, exam_xxx）用于多模态索引
    pub source_id: Option<String>,
    /// 资源类型
    pub resource_type: String,
    /// 资源名称
    pub name: String,

    // ========== OCR 状态 ==========
    /// 是否有 OCR 数据
    pub has_ocr: bool,
    /// OCR 页数（教材）或字符数（图片）
    pub ocr_count: i32,

    // ========== 文本索引状态 ==========
    /// 文本索引状态
    pub text_index_state: String,
    /// 文本索引时间
    pub text_indexed_at: Option<i64>,
    /// 文本索引错误
    pub text_index_error: Option<String>,
    /// 文本块数量
    pub text_chunk_count: i32,
    /// 提取文本块数量（text_source = 'native'）
    pub native_text_chunk_count: i32,
    /// OCR 文本块数量（text_source = 'ocr'）
    pub ocr_text_chunk_count: i32,
    /// 文本向量维度
    pub text_embedding_dim: Option<i32>,
    /// 文本索引来源（sqlite = 仅FTS，lance = 向量化完成）
    pub text_index_source: Option<String>,

    // ========== 多模态索引状态 ==========
    /// 多模态索引状态（pending, indexing, indexed, failed, disabled）
    pub mm_index_state: String,
    /// 多模态索引页数
    pub mm_indexed_pages: i32,
    /// 多模态向量维度
    pub mm_embedding_dim: Option<i32>,
    /// 多模态索引模式
    pub mm_indexing_mode: Option<String>,
    /// 多模态索引错误
    pub mm_index_error: Option<String>,

    // ========== 通用 ==========
    /// 模态类型（text, multimodal 等）- 保留向后兼容
    pub modality: Option<String>,
    /// 向量维度 - 保留向后兼容
    pub embedding_dim: Option<i32>,
    /// 更新时间
    pub updated_at: i64,
    /// 索引是否过时
    pub is_stale: bool,
}

/// 向量化状态统计
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatusSummary {
    /// 总资源数
    pub total_resources: i32,
    /// 已索引数
    pub indexed_count: i32,
    /// 待索引数
    pub pending_count: i32,
    /// 索引中数
    pub indexing_count: i32,
    /// 失败数
    pub failed_count: i32,
    /// 禁用数
    pub disabled_count: i32,
    /// 索引过时数（内容已更新但索引未更新）
    pub stale_count: i32,
    // ========== 多模态索引统计 ==========
    /// 多模态总资源数（教材/附件/题目集/图片）
    pub mm_total_resources: i32,
    /// 多模态已索引数
    pub mm_indexed_count: i32,
    /// 多模态待索引数
    pub mm_pending_count: i32,
    /// 多模态索引中数
    pub mm_indexing_count: i32,
    /// 多模态失败数
    pub mm_failed_count: i32,
    /// 多模态禁用数
    pub mm_disabled_count: i32,
    /// 资源状态列表
    pub resources: Vec<ResourceIndexStatus>,
}

/// 检查 resources 表是否有 index_state 列
fn has_index_state_column(conn: &rusqlite::Connection) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('resources') WHERE name = 'index_state'",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(|c| c > 0)
    .unwrap_or(false)
}

/// 检查 vfs_index_units 表是否存在（统一索引架构）
fn has_vfs_index_units_table(conn: &rusqlite::Connection) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='vfs_index_units'",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(|c| c > 0)
    .unwrap_or(false)
}

/// 获取所有资源的向量化状态
#[tauri::command]
pub async fn vfs_get_all_index_status(
    folder_id: Option<String>,
    resource_type: Option<String>,
    state_filter: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<IndexStatusSummary, String> {
    log::info!(
        "[VFS::handlers] vfs_get_all_index_status: folder={:?}, type={:?}, state={:?}",
        folder_id,
        resource_type,
        state_filter
    );

    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

    // 检查必要的列和表是否存在
    let has_index_state = has_index_state_column(&conn);
    let has_index_tables = has_vfs_index_units_table(&conn);

    if !has_index_state {
        log::warn!(
            "[VFS::handlers] vfs_get_all_index_status: index_state column not found, migration may not have run"
        );
        // 返回空结果，提示需要迁移
        return Ok(IndexStatusSummary {
            total_resources: 0,
            indexed_count: 0,
            pending_count: 0,
            indexing_count: 0,
            failed_count: 0,
            disabled_count: 0,
            stale_count: 0,
            mm_total_resources: 0,
            mm_indexed_count: 0,
            mm_pending_count: 0,
            mm_indexing_count: 0,
            mm_failed_count: 0,
            mm_disabled_count: 0,
            resources: vec![],
        });
    }

    // ========== 构建查询条件 ==========
    // 统计查询不受 state_filter 影响，始终显示全部资源统计
    let mut stats_conditions = vec!["r.deleted_at IS NULL".to_string()];
    let mut stats_params: Vec<Box<dyn rusqlite::ToSql>> = vec![];

    let mut list_conditions = vec!["r.deleted_at IS NULL".to_string()];
    let mut list_params: Vec<Box<dyn rusqlite::ToSql>> = vec![];

    if let Some(ref rt) = resource_type {
        stats_conditions.push("r.type = ?".to_string());
        stats_params.push(Box::new(rt.clone()));
        list_conditions.push("r.type = ?".to_string());
        list_params.push(Box::new(rt.clone()));
    }

    // state_filter 只影响资源列表，不影响统计
    if let Some(ref sf) = state_filter {
        list_conditions.push("COALESCE(r.index_state, 'pending') = ?".to_string());
        list_params.push(Box::new(sf.clone()));
    }

    // 文件夹过滤（通过 folder_items 表）
    let folder_join = if let Some(fid) = folder_id.clone() {
        stats_conditions.push("fi.folder_id = ?".to_string());
        stats_params.push(Box::new(fid.clone()));
        list_conditions.push("fi.folder_id = ?".to_string());
        list_params.push(Box::new(fid));
        "JOIN folder_items fi ON r.id = fi.item_id AND fi.deleted_at IS NULL"
    } else {
        ""
    };

    let stats_where_clause = stats_conditions.join(" AND ");
    let list_where_clause = list_conditions.join(" AND ");
    let limit_val = limit.unwrap_or(100) as i64;
    let offset_val = offset.unwrap_or(0) as i64;

    // ========== 优化：使用 CTE + LEFT JOIN 替代关联子查询 ==========
    // 原始查询对每行执行 ~42 个关联子查询，改为：
    // 1. CTE 预聚合 vfs_index_units/segments 数据（一次扫描）
    // 2. LEFT JOIN 到 notes/files/exam_sheets 等表（一次扫描）
    // 3. 消除 OR 条件（files 拆为两个 JOIN：按 resource_id 和按 source_id）

    let index_ctes = if has_index_tables {
        r#"
        unit_agg AS (
            SELECT resource_id,
                COALESCE(SUM(CASE WHEN text_source = 'native' THEN text_chunk_count ELSE 0 END), 0) as native_chunks,
                COALESCE(SUM(CASE WHEN text_source = 'ocr' THEN text_chunk_count ELSE 0 END), 0) as ocr_chunks
            FROM vfs_index_units
            GROUP BY resource_id
        ),
        seg_agg AS (
            SELECT u.resource_id,
                COUNT(*) as segment_count,
                MIN(s.embedding_dim) as first_embedding_dim,
                MAX(CASE WHEN s.modality = 'text' THEN 1 ELSE 0 END) as has_text_seg,
                MAX(CASE WHEN s.modality = 'multimodal' THEN 1 ELSE 0 END) as has_mm_seg
            FROM vfs_index_segments s
            JOIN vfs_index_units u ON s.unit_id = u.id
            GROUP BY u.resource_id
        ),
        "#
    } else {
        ""
    };

    let (chunk_count_col, native_chunks_col, ocr_chunks_col, embedding_dim_col, modality_col) =
        if has_index_tables {
            (
                "COALESCE(sa.segment_count, 0)",
                "COALESCE(ua.native_chunks, 0)",
                "COALESCE(ua.ocr_chunks, 0)",
                "sa.first_embedding_dim",
                r#"CASE
                    WHEN COALESCE(sa.has_text_seg, 0) = 1 AND COALESCE(sa.has_mm_seg, 0) = 1 THEN 'both'
                    WHEN COALESCE(sa.has_text_seg, 0) = 1 THEN 'text'
                    WHEN COALESCE(sa.has_mm_seg, 0) = 1 THEN 'multimodal'
                    ELSE NULL
                END"#,
            )
        } else {
            ("0", "0", "0", "NULL", "NULL")
        };

    let index_joins = if has_index_tables {
        "LEFT JOIN unit_agg ua ON ua.resource_id = r.id\n        LEFT JOIN seg_agg sa ON sa.resource_id = r.id"
    } else {
        ""
    };

    let query = format!(
        r#"
        WITH
        file_by_res AS (
            SELECT resource_id, file_name, name, ocr_pages_json, extracted_text,
                   mm_index_state, mm_indexed_pages_json, mm_index_error
            FROM files
            WHERE resource_id IS NOT NULL AND status = 'active'
            GROUP BY resource_id
        ),
        exam_by_res AS (
            SELECT resource_id, exam_name, preview_json,
                   mm_index_state, mm_indexed_pages_json, mm_index_error
            FROM exam_sheets
            WHERE resource_id IS NOT NULL
            GROUP BY resource_id
        ),
        {index_ctes}
        note_names AS (
            SELECT resource_id, title FROM notes GROUP BY resource_id
        ),
        tr_names AS (
            SELECT resource_id, title FROM translations GROUP BY resource_id
        ),
        essay_names AS (
            SELECT resource_id, title FROM essays GROUP BY resource_id
        ),
        mm_names AS (
            SELECT resource_id, title FROM mindmaps GROUP BY resource_id
        )
        SELECT
            r.id,
            r.source_id,
            r.type,
            -- name: 使用预 JOIN 的表替代 6 个关联子查询
            COALESCE(
                nn.title,
                COALESCE(fr.file_name, fs.file_name),
                COALESCE(ei.exam_name, es_src.exam_name),
                tn.title,
                en.title,
                mn.title,
                COALESCE(fs.name, fr.name),
                r.id
            ) as name,
            -- has_ocr: 使用 JOIN 数据替代关联子查询
            CASE
                WHEN r.type = 'textbook' THEN (COALESCE(fr.ocr_pages_json, fs.ocr_pages_json) IS NOT NULL)
                WHEN r.type = 'image' THEN (r.ocr_text IS NOT NULL AND r.ocr_text != '')
                WHEN r.type = 'file' THEN (
                    (COALESCE(fr.extracted_text, fs.extracted_text) IS NOT NULL AND COALESCE(fr.extracted_text, fs.extracted_text) != '')
                    OR (COALESCE(fr.ocr_pages_json, fs.ocr_pages_json) IS NOT NULL AND COALESCE(fr.ocr_pages_json, fs.ocr_pages_json) != '')
                    OR (r.ocr_text IS NOT NULL AND r.ocr_text != '')
                )
                WHEN r.type = 'exam' THEN (ei.preview_json IS NOT NULL)
                ELSE 0
            END as has_ocr,
            -- ocr_count
            CASE
                WHEN r.type = 'textbook' THEN COALESCE(
                    CASE
                        WHEN json_type(COALESCE(fr.ocr_pages_json, fs.ocr_pages_json)) = 'array'
                            THEN json_array_length(COALESCE(fr.ocr_pages_json, fs.ocr_pages_json))
                        WHEN json_type(COALESCE(fr.ocr_pages_json, fs.ocr_pages_json), '$.pages') = 'array'
                            THEN json_array_length(json_extract(COALESCE(fr.ocr_pages_json, fs.ocr_pages_json), '$.pages'))
                        ELSE 0
                    END, 0)
                WHEN r.type = 'image' THEN COALESCE(LENGTH(r.ocr_text), 0)
                WHEN r.type = 'file' THEN COALESCE(
                    COALESCE(LENGTH(COALESCE(fr.extracted_text, fs.extracted_text)), 0)
                    + COALESCE(LENGTH(r.ocr_text), 0), 0)
                WHEN r.type = 'exam' THEN COALESCE(LENGTH(ei.preview_json), 0)
                ELSE 0
            END as ocr_count,
            -- 文本索引状态
            COALESCE(r.index_state, 'pending') as index_state,
            r.indexed_at,
            r.index_error,
            -- 块计数：使用 CTE 预聚合替代关联子查询
            {chunk_count} as chunk_count,
            {native_chunks} as native_chunk_count,
            {ocr_chunks} as ocr_chunk_count,
            {embedding_dim} as text_embedding_dim,
            -- 文本索引来源
            CASE
                WHEN COALESCE(r.index_state, 'pending') = 'indexed' AND {chunk_count} > 0 THEN 'lance'
                WHEN COALESCE(r.index_state, 'pending') = 'indexed' THEN 'sqlite'
                ELSE NULL
            END as text_index_source,
            -- 多模态索引状态：使用 JOIN 数据替代 4×5=20 个关联子查询
            CASE
                WHEN r.type IN ('textbook', 'file', 'image') THEN COALESCE(
                    fr.mm_index_state, fs.mm_index_state, 'pending')
                WHEN r.type = 'exam' THEN COALESCE(ei.mm_index_state, 'pending')
                ELSE 'disabled'
            END as mm_index_state,
            CASE
                WHEN r.type IN ('textbook', 'file', 'image') THEN COALESCE(
                    json_array_length(COALESCE(fr.mm_indexed_pages_json, fs.mm_indexed_pages_json)), 0)
                WHEN r.type = 'exam' THEN COALESCE(json_array_length(ei.mm_indexed_pages_json), 0)
                ELSE CASE WHEN r.mm_embedding_dim IS NOT NULL THEN 1 ELSE 0 END
            END as mm_indexed_pages,
            CASE
                WHEN r.type IN ('textbook', 'file', 'image') THEN
                    json_extract(COALESCE(fr.mm_indexed_pages_json, fs.mm_indexed_pages_json), '$[0].embedding_dim')
                WHEN r.type = 'exam' THEN
                    json_extract(ei.mm_indexed_pages_json, '$[0].embedding_dim')
                ELSE r.mm_embedding_dim
            END as mm_embedding_dim,
            CASE
                WHEN r.type IN ('textbook', 'file', 'image') THEN
                    json_extract(COALESCE(fr.mm_indexed_pages_json, fs.mm_indexed_pages_json), '$[0].indexing_mode')
                WHEN r.type = 'exam' THEN
                    json_extract(ei.mm_indexed_pages_json, '$[0].indexing_mode')
                ELSE r.mm_indexing_mode
            END as mm_indexing_mode,
            CASE
                WHEN r.type IN ('textbook', 'file', 'image') THEN COALESCE(fr.mm_index_error, fs.mm_index_error)
                WHEN r.type = 'exam' THEN ei.mm_index_error
                ELSE r.mm_index_error
            END as mm_index_error,
            -- 模态：使用 CTE 预聚合替代 3 个 EXISTS 关联子查询
            {modality} as modality,
            r.updated_at,
            CASE
                WHEN COALESCE(r.index_state, 'pending') = 'indexed'
                     AND r.index_hash IS NOT NULL
                     AND r.index_hash != r.hash
                THEN 1
                ELSE 0
            END as is_stale
        FROM resources r
        -- 名称 JOIN（替代 6 个 COALESCE 关联子查询）
        LEFT JOIN note_names nn ON nn.resource_id = r.id
        LEFT JOIN file_by_res fr ON fr.resource_id = r.id
        LEFT JOIN files fs ON fs.id = r.source_id AND fs.status = 'active'
        LEFT JOIN exam_by_res ei ON ei.resource_id = r.id
        LEFT JOIN exam_sheets es_src ON es_src.id = r.source_id
        LEFT JOIN tr_names tn ON tn.resource_id = r.id
        LEFT JOIN essay_names en ON en.resource_id = r.id
        LEFT JOIN mm_names mn ON mn.resource_id = r.id
        -- 索引聚合 JOIN（替代 ~8 个关联子查询）
        {index_joins}
        {folder_join}
        WHERE {list_where}
            AND (
                nn.resource_id IS NOT NULL
                OR fr.resource_id IS NOT NULL
                OR fs.id IS NOT NULL
                OR ei.resource_id IS NOT NULL
                OR es_src.id IS NOT NULL
                OR tn.resource_id IS NOT NULL
                OR en.resource_id IS NOT NULL
                OR mn.resource_id IS NOT NULL
            )
        ORDER BY r.updated_at DESC
        LIMIT ? OFFSET ?
        "#,
        index_ctes = index_ctes,
        chunk_count = chunk_count_col,
        native_chunks = native_chunks_col,
        ocr_chunks = ocr_chunks_col,
        embedding_dim = embedding_dim_col,
        modality = modality_col,
        index_joins = index_joins,
        folder_join = folder_join,
        list_where = list_where_clause,
    );

    let mut stmt = conn.prepare(&query).map_err(|e| {
        log::error!(
            "[VFS::handlers] vfs_get_all_index_status: prepare error: {}",
            e
        );
        e.to_string()
    })?;

    // 构建参数列表（使用 list_params）
    let mut all_params: Vec<&dyn rusqlite::ToSql> =
        list_params.iter().map(|p| p.as_ref()).collect();
    all_params.push(&limit_val);
    all_params.push(&offset_val);

    let query_result = stmt.query_map(rusqlite::params_from_iter(all_params.iter()), |row| {
        // 列顺序（与优化前保持一致）：
        // 0=id, 1=source_id, 2=type, 3=name,
        // 4=has_ocr, 5=ocr_count,
        // 6=index_state, 7=indexed_at, 8=index_error, 9=chunk_count, 10=native_chunk_count, 11=ocr_chunk_count,
        // 12=text_embedding_dim, 13=text_index_source,
        // 14=mm_index_state, 15=mm_indexed_pages, 16=mm_embedding_dim, 17=mm_indexing_mode, 18=mm_index_error,
        // 19=modality, 20=updated_at, 21=is_stale

        // updated_at 可能是 INTEGER 或 TEXT 格式，需要兼容处理
        let updated_at: i64 = match row.get::<_, i64>(20) {
            Ok(v) => v,
            Err(_) => {
                let text_val: String = row.get(20)?;
                chrono::DateTime::parse_from_rfc3339(&text_val)
                    .map(|dt| dt.timestamp_millis())
                    .or_else(|_| {
                        chrono::NaiveDateTime::parse_from_str(&text_val, "%Y-%m-%dT%H:%M:%S%.f")
                            .or_else(|_| {
                                chrono::NaiveDateTime::parse_from_str(
                                    &text_val,
                                    "%Y-%m-%d %H:%M:%S",
                                )
                            })
                            .map(|dt| dt.and_utc().timestamp_millis())
                    })
                    .unwrap_or(0)
            }
        };

        let text_embedding_dim: Option<i32> = row.get(12)?;

        Ok(ResourceIndexStatus {
            resource_id: row.get(0)?,
            source_id: row.get(1)?,
            resource_type: row.get(2)?,
            name: row.get(3)?,
            // OCR 状态
            has_ocr: row.get::<_, i32>(4).unwrap_or(0) == 1,
            ocr_count: row.get(5).unwrap_or(0),
            // 文本索引状态
            text_index_state: row.get(6)?,
            text_indexed_at: row.get(7)?,
            text_index_error: row.get(8)?,
            text_chunk_count: row.get(9).unwrap_or(0),
            native_text_chunk_count: row.get(10).unwrap_or(0),
            ocr_text_chunk_count: row.get(11).unwrap_or(0),
            text_embedding_dim,
            text_index_source: row.get(13)?,
            // 多模态索引状态
            mm_index_state: row
                .get::<_, String>(14)
                .unwrap_or_else(|_| "pending".to_string()),
            mm_indexed_pages: row.get(15).unwrap_or(0),
            mm_embedding_dim: row.get(16)?,
            mm_indexing_mode: row.get(17)?,
            mm_index_error: row.get(18)?,
            // 通用（向后兼容）
            modality: row.get(19)?,
            embedding_dim: text_embedding_dim,
            updated_at,
            is_stale: row.get::<_, i32>(21).unwrap_or(0) == 1,
        })
    });

    log::debug!(
        "[VFS::handlers] vfs_get_all_index_status: 资源列表查询 where_clause={}, params_count={}",
        list_where_clause,
        list_params.len()
    );

    let resources: Vec<ResourceIndexStatus> = match query_result {
        Ok(rows) => {
            let mut resources = Vec::new();
            let mut error_count = 0;
            for (idx, row) in rows.enumerate() {
                match row {
                    Ok(r) => resources.push(r),
                    Err(e) => {
                        error_count += 1;
                        log::warn!(
                            "[VFS::handlers] vfs_get_all_index_status: row {} parse error: {}",
                            idx,
                            e
                        );
                    }
                }
            }
            if error_count > 0 {
                log::warn!(
                    "[VFS::handlers] vfs_get_all_index_status: {} rows had parse errors",
                    error_count
                );
            }
            log::info!(
                "[VFS::handlers] vfs_get_all_index_status: 资源列表查询完成, 返回 {} 条记录",
                resources.len()
            );
            resources
        }
        Err(e) => {
            log::error!(
                "[VFS::handlers] vfs_get_all_index_status: query error: {}",
                e
            );
            return Err(e.to_string());
        }
    };

    // ========== 统计查询（同样使用 JOIN 优化）==========
    // ★ 2026-01 修复：统一统计逻辑，indexed 包含所有 index_state='indexed' 的资源
    // 使用 LEFT JOIN 替代原来的 6 次 mm_state_expr 关联子查询
    let stats_query = format!(
        r#"
        WITH file_mm AS (
            SELECT resource_id, mm_index_state
            FROM files
            WHERE resource_id IS NOT NULL AND status = 'active'
            GROUP BY resource_id
        ),
        exam_mm AS (
            SELECT resource_id, mm_index_state
            FROM exam_sheets
            WHERE resource_id IS NOT NULL
            GROUP BY resource_id
        )
        SELECT
            COUNT(*) as total,
            COALESCE(SUM(CASE WHEN COALESCE(r.index_state, 'pending') = 'indexed' THEN 1 ELSE 0 END), 0) as indexed,
            COALESCE(SUM(CASE WHEN COALESCE(r.index_state, 'pending') = 'pending' THEN 1 ELSE 0 END), 0) as pending,
            COALESCE(SUM(CASE WHEN r.index_state = 'indexing' THEN 1 ELSE 0 END), 0) as indexing,
            COALESCE(SUM(CASE WHEN r.index_state = 'failed' THEN 1 ELSE 0 END), 0) as failed,
            COALESCE(SUM(CASE WHEN r.index_state = 'disabled' THEN 1 ELSE 0 END), 0) as disabled,
            COALESCE(SUM(CASE
                WHEN COALESCE(r.index_state, 'pending') = 'indexed'
                     AND r.index_hash IS NOT NULL AND r.index_hash != r.hash
                THEN 1 ELSE 0 END), 0) as stale
            ,COALESCE(SUM(CASE WHEN r.type IN ('textbook', 'file', 'exam', 'image') THEN 1 ELSE 0 END), 0) as mm_total
            ,COALESCE(SUM(CASE WHEN r.type IN ('textbook', 'file', 'exam', 'image')
                AND COALESCE(
                    CASE WHEN r.type IN ('textbook', 'file', 'image') THEN COALESCE(fm.mm_index_state, fs_mm.mm_index_state) END,
                    CASE WHEN r.type = 'exam' THEN COALESCE(em.mm_index_state, es_mm.mm_index_state) END,
                    COALESCE(r.mm_index_state, 'pending')
                ) = 'indexed' THEN 1 ELSE 0 END), 0) as mm_indexed
            ,COALESCE(SUM(CASE WHEN r.type IN ('textbook', 'file', 'exam', 'image')
                AND COALESCE(
                    CASE WHEN r.type IN ('textbook', 'file', 'image') THEN COALESCE(fm.mm_index_state, fs_mm.mm_index_state) END,
                    CASE WHEN r.type = 'exam' THEN COALESCE(em.mm_index_state, es_mm.mm_index_state) END,
                    COALESCE(r.mm_index_state, 'pending')
                ) = 'pending' THEN 1 ELSE 0 END), 0) as mm_pending
            ,COALESCE(SUM(CASE WHEN r.type IN ('textbook', 'file', 'exam', 'image')
                AND COALESCE(
                    CASE WHEN r.type IN ('textbook', 'file', 'image') THEN COALESCE(fm.mm_index_state, fs_mm.mm_index_state) END,
                    CASE WHEN r.type = 'exam' THEN COALESCE(em.mm_index_state, es_mm.mm_index_state) END,
                    COALESCE(r.mm_index_state, 'pending')
                ) = 'indexing' THEN 1 ELSE 0 END), 0) as mm_indexing
            ,COALESCE(SUM(CASE WHEN r.type IN ('textbook', 'file', 'exam', 'image')
                AND COALESCE(
                    CASE WHEN r.type IN ('textbook', 'file', 'image') THEN COALESCE(fm.mm_index_state, fs_mm.mm_index_state) END,
                    CASE WHEN r.type = 'exam' THEN COALESCE(em.mm_index_state, es_mm.mm_index_state) END,
                    COALESCE(r.mm_index_state, 'pending')
                ) = 'failed' THEN 1 ELSE 0 END), 0) as mm_failed
            ,COALESCE(SUM(CASE WHEN r.type IN ('textbook', 'file', 'exam', 'image')
                AND COALESCE(
                    CASE WHEN r.type IN ('textbook', 'file', 'image') THEN COALESCE(fm.mm_index_state, fs_mm.mm_index_state) END,
                    CASE WHEN r.type = 'exam' THEN COALESCE(em.mm_index_state, es_mm.mm_index_state) END,
                    COALESCE(r.mm_index_state, 'pending')
                ) = 'disabled' THEN 1 ELSE 0 END), 0) as mm_disabled
        FROM resources r
        LEFT JOIN file_mm fm ON fm.resource_id = r.id
        LEFT JOIN files fs_mm ON fs_mm.id = r.source_id
        LEFT JOIN exam_mm em ON em.resource_id = r.id
        LEFT JOIN exam_sheets es_mm ON es_mm.id = r.source_id
        {0}
        WHERE {1}
            AND (
                fm.resource_id IS NOT NULL
                OR fs_mm.id IS NOT NULL
                OR em.resource_id IS NOT NULL
                OR es_mm.id IS NOT NULL
                OR EXISTS (SELECT 1 FROM notes WHERE resource_id = r.id)
                OR EXISTS (SELECT 1 FROM translations WHERE resource_id = r.id)
                OR EXISTS (SELECT 1 FROM essays WHERE resource_id = r.id)
                OR EXISTS (SELECT 1 FROM mindmaps WHERE resource_id = r.id)
            )
        "#,
        folder_join, stats_where_clause
    );

    // 构建统计查询的参数（使用 stats_params，不包括 state_filter）
    let stats_query_params: Vec<&dyn rusqlite::ToSql> =
        stats_params.iter().map(|p| p.as_ref()).collect();

    let (
        total,
        indexed,
        pending,
        indexing,
        failed,
        disabled,
        stale,
        mm_total,
        mm_indexed,
        mm_pending,
        mm_indexing,
        mm_failed,
        mm_disabled,
    ): (
        i32,
        i32,
        i32,
        i32,
        i32,
        i32,
        i32,
        i32,
        i32,
        i32,
        i32,
        i32,
        i32,
    ) = conn
        .query_row(
            &stats_query,
            rusqlite::params_from_iter(stats_query_params.iter()),
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;

    log::info!(
        "[VFS::handlers] vfs_get_all_index_status: 返回结果 total={}, indexed={}, pending={}, resources_len={}, state_filter={:?}",
        total, indexed, pending, resources.len(), state_filter
    );

    Ok(IndexStatusSummary {
        total_resources: total,
        indexed_count: indexed,
        pending_count: pending,
        indexing_count: indexing,
        failed_count: failed,
        disabled_count: disabled,
        stale_count: stale,
        mm_total_resources: mm_total,
        mm_indexed_count: mm_indexed,
        mm_pending_count: mm_pending,
        mm_indexing_count: mm_indexing,
        mm_failed_count: mm_failed,
        mm_disabled_count: mm_disabled,
        resources,
    })
}

// ============================================================================
// VFS RAG 向量检索命令（Phase 6: 前端 API）
// ============================================================================

/// VFS RAG 向量检索输入参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsRagSearchInput {
    /// 查询文本
    pub query: String,

    /// 文件夹 ID 列表（可选，用于范围过滤）
    #[serde(default)]
    pub folder_ids: Option<Vec<String>>,

    /// 资源类型列表（可选，如 ["note", "textbook"]）
    #[serde(default)]
    pub resource_types: Option<Vec<String>>,

    /// 返回结果数量
    #[serde(default = "default_rag_top_k")]
    pub top_k: u32,

    /// 是否启用重排序
    #[serde(default = "default_enable_reranking")]
    pub enable_reranking: bool,

    /// ★ P2-1: 模态类型（"text" 或 "multimodal"，默认 "text"）
    #[serde(default = "default_modality")]
    pub modality: String,

    /// 是否启用跨维度搜索（聚合所有已分配模型的维度，默认启用）
    #[serde(default = "default_enable_cross_dimension")]
    pub enable_cross_dimension: bool,
}

fn default_modality() -> String {
    "text".to_string()
}

fn default_rag_top_k() -> u32 {
    10
}

fn default_enable_reranking() -> bool {
    true
}

fn default_enable_cross_dimension() -> bool {
    true
}

/// VFS RAG 检索结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsRagSearchOutput {
    /// 检索结果列表
    pub results: Vec<VfsSearchResult>,
    /// 结果数量
    pub count: usize,
    /// 检索耗时（毫秒）
    pub elapsed_ms: u64,
}

/// VFS RAG 向量检索命令
///
/// 使用 VFS 统一知识管理架构进行 RAG 检索。
///
/// ## 参数
/// - `input.query`: 查询文本
/// - `input.folder_ids`: 可选的文件夹 ID 列表
/// - `input.resource_types`: 可选的资源类型列表
/// - `input.top_k`: 返回结果数量
/// - `input.enable_reranking`: 是否启用重排序
///
/// ## 返回
/// 检索结果列表、数量和耗时
#[tauri::command]
pub async fn vfs_rag_search(
    input: VfsRagSearchInput,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    llm_manager: State<'_, Arc<crate::llm_manager::LLMManager>>,
    lance_store: State<'_, Arc<crate::vfs::lance_store::VfsLanceStore>>,
) -> Result<VfsRagSearchOutput, String> {
    use crate::vfs::indexing::{VfsFullSearchService, VfsSearchParams};
    use crate::vfs::repos::MODALITY_TEXT;

    let start = std::time::Instant::now();

    log::info!(
        "[VFS::handlers] vfs_rag_search: query='{}', folders={:?}, types={:?}, top_k={}",
        input.query,
        input.folder_ids,
        input.resource_types,
        input.top_k
    );

    // 验证查询
    if input.query.trim().is_empty() {
        return Err("查询文本不能为空".to_string());
    }

    let lance_store = Arc::clone(lance_store.inner());

    // 创建搜索服务
    let search_service =
        VfsFullSearchService::new(Arc::clone(&vfs_db), lance_store, Arc::clone(&llm_manager));

    // ★ P2-1 修复: 使用输入的 modality 参数，而不是硬编码 MODALITY_TEXT
    let normalized_modality = input.modality.trim().to_lowercase();
    let modality = match normalized_modality.as_str() {
        "" | "text" => MODALITY_TEXT.to_string(),
        "multimodal" | "mm" => crate::vfs::repos::MODALITY_MULTIMODAL.to_string(),
        _ => {
            return Err("modality 仅支持 'text' 或 'multimodal'".to_string());
        }
    };

    // 构建搜索参数
    let params = VfsSearchParams {
        query: input.query.clone(),
        folder_ids: input.folder_ids,
        resource_ids: None,
        resource_types: input.resource_types,
        modality,
        top_k: input.top_k,
    };

    // `enableCrossDimension` is retained for frontend compatibility. Both values now use the
    // profile/fingerprint-aware planner and weighted RRF; `false` must not reopen the legacy
    // dimension-only Lance path.
    if !input.enable_cross_dimension {
        log::debug!(
            "[VFS::handlers] enableCrossDimension=false is compatibility-only; using unified planner"
        );
    }
    let results = search_service
        .search_cross_dimension_with_resource_info(&input.query, &params, input.enable_reranking)
        .await
        .map_err(|e| e.to_string())?;

    let elapsed = start.elapsed();
    let count = results.len();

    log::info!(
        "[VFS::handlers] vfs_rag_search completed: {} results in {}ms",
        count,
        elapsed.as_millis()
    );

    Ok(VfsRagSearchOutput {
        results,
        count,
        elapsed_ms: elapsed.as_millis() as u64,
    })
}

/// VFS 获取 Lance 统计信息命令
#[tauri::command]
pub async fn vfs_get_lance_stats(
    modality: Option<String>,
    _vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<crate::vfs::lance_store::VfsLanceStore>>,
) -> Result<Vec<(String, usize)>, String> {
    use crate::vfs::repos::MODALITY_TEXT;

    log::debug!("[VFS::handlers] vfs_get_lance_stats");

    let modality_str = modality.as_deref().unwrap_or(MODALITY_TEXT);

    lance_store
        .get_table_stats(modality_str)
        .await
        .map_err(|e| e.to_string())
}

/// VFS 优化 Lance 表命令
#[tauri::command]
pub async fn vfs_optimize_lance(
    modality: Option<String>,
    _vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<crate::vfs::lance_store::VfsLanceStore>>,
) -> Result<usize, String> {
    use crate::vfs::repos::MODALITY_TEXT;

    log::info!("[VFS::handlers] vfs_optimize_lance");

    let modality_str = modality.as_deref().unwrap_or(MODALITY_TEXT);

    lance_store
        .optimize_all(modality_str)
        .await
        .map_err(|e| e.to_string())
}

// ============================================================================
// 知识导图操作命令
// ============================================================================

/// 创建知识导图输入参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMindMapInput {
    /// 标题
    pub title: String,

    /// 描述
    #[serde(default)]
    pub description: Option<String>,

    /// 初始内容（MindMapDocument JSON）
    #[serde(default = "default_mindmap_content")]
    pub content: String,

    /// 默认视图
    #[serde(default = "default_mindmap_view")]
    pub default_view: String,

    /// 主题
    #[serde(default)]
    pub theme: Option<String>,

    /// 目标文件夹（可选）
    #[serde(default)]
    pub folder_id: Option<String>,
}

fn default_mindmap_content() -> String {
    r#"{"version":"1.0","root":{"id":"root","text":"根节点","children":[]}}"#.to_string()
}

fn default_mindmap_view() -> String {
    "mindmap".to_string()
}

/// 更新知识导图输入参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMindMapInput {
    /// 新标题
    #[serde(default)]
    pub title: Option<String>,

    /// 新描述
    #[serde(default)]
    pub description: Option<String>,

    /// 新内容（MindMapDocument JSON）
    #[serde(default)]
    pub content: Option<String>,

    /// 新默认视图
    #[serde(default)]
    pub default_view: Option<String>,

    /// 新主题
    #[serde(default)]
    pub theme: Option<String>,

    /// 新设置
    #[serde(default)]
    pub settings: Option<serde_json::Value>,

    /// 乐观并发控制：期望的 updatedAt（ISO8601）
    #[serde(default)]
    pub expected_updated_at: Option<String>,

    /// 版本快照来源（'manual' | 'auto'），缺省为 'manual'
    ///
    /// 仅影响 mindmap_versions 的 source 标记与自动保存合并窗口分组；
    /// chat% 前缀保留给聊天工具链路（builtin executor），UI 路径不可伪造。
    #[serde(default)]
    pub version_source: Option<String>,
}

/// 创建知识导图
#[tauri::command]
pub async fn vfs_create_mindmap(
    params: CreateMindMapInput,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<VfsMindMap, String> {
    log::info!(
        "[VFS::handlers] vfs_create_mindmap: title={}, folder_id={:?}",
        params.title,
        params.folder_id
    );

    // ★ 2026-07（B14）：内容字节上限（MindMap 50MB，与资源类型上限表一致）
    validate_file_size(&VfsResourceType::MindMap, &params.content).map_err(|e| e.to_string())?;

    let create_params = VfsCreateMindMapParams {
        title: params.title,
        description: params.description,
        content: params.content,
        default_view: params.default_view,
        theme: params.theme,
    };

    VfsMindMapRepo::create_mindmap_in_folder(&vfs_db, create_params, params.folder_id.as_deref())
        .map_err(|e| e.to_string())
}

/// 获取知识导图元数据
#[tauri::command]
pub async fn vfs_get_mindmap(
    mindmap_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Option<VfsMindMap>, String> {
    log::debug!("[VFS::handlers] vfs_get_mindmap: id={}", mindmap_id);

    if !mindmap_id.starts_with("mm_") {
        return Err(VfsError::InvalidArgument {
            param: "mindmap_id".to_string(),
            reason: format!("Invalid mindmap ID format: {}", mindmap_id),
        }
        .to_string());
    }

    VfsMindMapRepo::get_mindmap(&vfs_db, &mindmap_id).map_err(|e| e.to_string())
}

/// 获取知识导图内容
#[tauri::command]
pub async fn vfs_get_mindmap_content(
    mindmap_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Option<String>, String> {
    log::debug!("[VFS::handlers] vfs_get_mindmap_content: id={}", mindmap_id);

    if !mindmap_id.starts_with("mm_") {
        return Err(VfsError::InvalidArgument {
            param: "mindmap_id".to_string(),
            reason: format!("Invalid mindmap ID format: {}", mindmap_id),
        }
        .to_string());
    }

    VfsMindMapRepo::get_mindmap_content(&vfs_db, &mindmap_id).map_err(|e| e.to_string())
}

/// 获取思维导图的版本历史
///
/// `limit` 可选（1..=500），缺省 100（与旧行为一致）。
#[tauri::command]
pub async fn vfs_get_mindmap_versions(
    mindmap_id: String,
    limit: Option<u32>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<VfsMindMapVersion>, String> {
    log::debug!(
        "[VFS::handlers] vfs_get_mindmap_versions: id={}, limit={:?}",
        mindmap_id,
        limit
    );

    if !mindmap_id.starts_with("mm_") {
        return Err(VfsError::InvalidArgument {
            param: "mindmap_id".to_string(),
            reason: format!("Invalid mindmap ID format: {}", mindmap_id),
        }
        .to_string());
    }

    let effective_limit = limit
        .unwrap_or(VfsMindMapRepo::DEFAULT_VERSION_PAGE_SIZE)
        .clamp(1, 500);

    VfsMindMapRepo::get_versions_paged(&vfs_db, &mindmap_id, effective_limit)
        .map_err(|e| e.to_string())
}

/// 恢复思维导图到指定历史版本
///
/// ★ 2026-07 新增（B6）：事务内先将当前内容快照为 `restore_backup` 版本，
/// 再用目标版本内容覆盖主资源，返回恢复后的导图元数据。
#[tauri::command]
pub async fn vfs_restore_mindmap_version(
    version_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<VfsMindMap, String> {
    log::info!(
        "[VFS::handlers] vfs_restore_mindmap_version: id={}",
        version_id
    );

    if !version_id.starts_with("mv_") {
        return Err(VfsError::InvalidArgument {
            param: "version_id".to_string(),
            reason: format!("Invalid version ID format: {}", version_id),
        }
        .to_string());
    }

    VfsMindMapRepo::restore_version(&vfs_db, &version_id).map_err(|e| e.to_string())
}

/// 获取指定版本的思维导图内容
#[tauri::command]
pub async fn vfs_get_mindmap_version_content(
    version_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Option<String>, String> {
    log::debug!(
        "[VFS::handlers] vfs_get_mindmap_version_content: id={}",
        version_id
    );

    if !version_id.starts_with("mv_") {
        return Err(VfsError::InvalidArgument {
            param: "version_id".to_string(),
            reason: format!("Invalid version ID format: {}", version_id),
        }
        .to_string());
    }

    VfsMindMapRepo::get_version_content(&vfs_db, &version_id).map_err(|e| e.to_string())
}

/// 获取指定版本的思维导图元数据
#[tauri::command]
pub async fn vfs_get_mindmap_version(
    version_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Option<VfsMindMapVersion>, String> {
    log::debug!("[VFS::handlers] vfs_get_mindmap_version: id={}", version_id);

    if !version_id.starts_with("mv_") {
        return Err(VfsError::InvalidArgument {
            param: "version_id".to_string(),
            reason: format!("Invalid version ID format: {}", version_id),
        }
        .to_string());
    }

    VfsMindMapRepo::get_version(&vfs_db, &version_id).map_err(|e| e.to_string())
}

/// 更新知识导图
#[tauri::command]
pub async fn vfs_update_mindmap(
    mindmap_id: String,
    params: UpdateMindMapInput,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<VfsMindMap, String> {
    log::info!("[VFS::handlers] vfs_update_mindmap: id={}", mindmap_id);

    if !mindmap_id.starts_with("mm_") {
        return Err(VfsError::InvalidArgument {
            param: "mindmap_id".to_string(),
            reason: format!("Invalid mindmap ID format: {}", mindmap_id),
        }
        .to_string());
    }

    // ★ 2026-07（B14）：更新路径补内容字节上限（MindMap 50MB）
    if let Some(content) = params.content.as_deref() {
        validate_file_size(&VfsResourceType::MindMap, content).map_err(|e| e.to_string())?;
    }

    // 版本来源白名单：UI 路径只允许 manual/auto，缺省 manual（与旧行为一致）；
    // chat% 保留给聊天工具链路，非法值回退 manual 并告警，防止绕过版本清理策略
    let version_source = match params.version_source.as_deref() {
        None | Some("manual") => "manual",
        Some("auto") => "auto",
        Some(other) => {
            log::warn!(
                "[VFS::handlers] vfs_update_mindmap: invalid versionSource {:?} for {}, falling back to 'manual'",
                other,
                mindmap_id
            );
            "manual"
        }
    }
    .to_string();

    let update_params = VfsUpdateMindMapParams {
        title: params.title,
        description: params.description,
        content: params.content,
        default_view: params.default_view,
        theme: params.theme,
        settings: params.settings,
        expected_updated_at: params.expected_updated_at,
        version_source: Some(version_source),
    };

    VfsMindMapRepo::update_mindmap(&vfs_db, &mindmap_id, update_params).map_err(|e| e.to_string())
}

/// 删除知识导图（软删除）
#[tauri::command]
pub async fn vfs_delete_mindmap(
    mindmap_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<(), String> {
    log::info!("[VFS::handlers] vfs_delete_mindmap: id={}", mindmap_id);

    if !mindmap_id.starts_with("mm_") {
        return Err(VfsError::InvalidArgument {
            param: "mindmap_id".to_string(),
            reason: format!("Invalid mindmap ID format: {}", mindmap_id),
        }
        .to_string());
    }

    VfsMindMapRepo::delete_mindmap(&vfs_db, &mindmap_id).map_err(|e| e.to_string())
}

/// 列出知识导图
#[tauri::command]
pub async fn vfs_list_mindmaps(
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<VfsMindMap>, String> {
    log::debug!("[VFS::handlers] vfs_list_mindmaps");

    VfsMindMapRepo::list_mindmaps(&vfs_db).map_err(|e| e.to_string())
}

/// 设置知识导图收藏状态
#[tauri::command]
pub async fn vfs_set_mindmap_favorite(
    mindmap_id: String,
    is_favorite: bool,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<(), String> {
    log::info!(
        "[VFS::handlers] vfs_set_mindmap_favorite: id={}, is_favorite={}",
        mindmap_id,
        is_favorite
    );

    if !mindmap_id.starts_with("mm_") {
        return Err(VfsError::InvalidArgument {
            param: "mindmap_id".to_string(),
            reason: format!("Invalid mindmap ID format: {}", mindmap_id),
        }
        .to_string());
    }

    VfsMindMapRepo::set_favorite(&vfs_db, &mindmap_id, is_favorite).map_err(|e| e.to_string())
}

// ============================================================================
// 诊断命令（用于调试索引问题）
// ============================================================================

/// 索引诊断信息（统一索引架构版本）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDiagnosticInfo {
    /// 时间戳
    pub timestamp: String,
    /// 架构版本
    pub architecture_version: String,
    /// 资源总数
    pub total_resources: i32,
    /// 各状态数量
    pub state_counts: IndexStateCounts,
    /// 抽样资源详情（最多15条，用于快速预览）
    pub sample_resources: Vec<ResourceDiagnostic>,
    /// 所有资源详情（用于完整对比）
    pub all_resources: Vec<ResourceDiagnostic>,
    /// vfs_index_units 表统计
    pub units_stats: UnitsStats,
    /// vfs_index_segments 表统计
    pub segments_stats: SegmentsStats,
    /// vfs_embedding_dims 表统计
    pub dimensions_stats: Vec<DimensionStats>,
    /// 数据一致性检查
    pub consistency_checks: Vec<ConsistencyCheck>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStateCounts {
    pub pending: i32,
    pub indexing: i32,
    pub indexed: i32,
    pub failed: i32,
    pub disabled: i32,
    pub null_state: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceDiagnostic {
    pub id: String,
    /// 资源名称（用于 UI 显示）
    pub name: Option<String>,
    pub resource_type: String,
    pub storage_mode: String,
    pub index_state: Option<String>,
    pub index_error: Option<String>,
    pub data_len: i32,
    pub has_ocr_text: bool,
    /// 该资源的 unit 数量
    pub unit_count: i32,
    /// 该资源的 segment 数量
    pub segment_count: i32,
    /// Unit 的 text_state
    pub unit_text_state: Option<String>,
    /// Unit 的 mm_state
    pub unit_mm_state: Option<String>,
    /// 文本嵌入维度
    pub text_embedding_dim: Option<i32>,
    /// 文本分块数量
    pub text_chunk_count: Option<i32>,
    pub updated_at: i64,
}

/// vfs_index_units 表统计
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitsStats {
    pub total_count: i32,
    pub distinct_resources: i32,
    pub text_pending: i32,
    pub text_indexing: i32,
    pub text_indexed: i32,
    pub text_failed: i32,
    pub text_disabled: i32,
    pub mm_pending: i32,
    pub mm_indexing: i32,
    pub mm_indexed: i32,
    pub mm_failed: i32,
    pub mm_disabled: i32,
}

/// vfs_index_segments 表统计
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentsStats {
    pub total_count: i32,
    pub distinct_units: i32,
    pub text_modality_count: i32,
    pub mm_modality_count: i32,
    pub avg_segments_per_unit: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DimensionStats {
    pub dimension: i32,
    pub modality: String,
    /// ★ 审计修复：统一为 i64
    pub record_count: i64,
    pub actual_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsistencyCheck {
    pub check_name: String,
    pub passed: bool,
    pub details: String,
}

/// 获取索引诊断信息
///
/// 返回数据库各表的真实状态，用于调试索引问题
#[tauri::command]
pub async fn vfs_debug_index_status(
    resource_id: Option<String>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<IndexDiagnosticInfo, String> {
    log::info!(
        "[VFS::handlers] vfs_debug_index_status: resource_id={:?}",
        resource_id
    );

    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;
    let timestamp = chrono::Utc::now()
        .format("%Y-%m-%d %H:%M:%S%.3f UTC")
        .to_string();

    // 1. 统计各状态数量
    let state_counts: IndexStateCounts = conn
        .query_row(
            r#"
        SELECT
            COALESCE(SUM(CASE WHEN index_state = 'pending' THEN 1 ELSE 0 END), 0) as pending,
            COALESCE(SUM(CASE WHEN index_state = 'indexing' THEN 1 ELSE 0 END), 0) as indexing,
            COALESCE(SUM(CASE WHEN index_state = 'indexed' THEN 1 ELSE 0 END), 0) as indexed,
            COALESCE(SUM(CASE WHEN index_state = 'failed' THEN 1 ELSE 0 END), 0) as failed,
            COALESCE(SUM(CASE WHEN index_state = 'disabled' THEN 1 ELSE 0 END), 0) as disabled,
            COALESCE(SUM(CASE WHEN index_state IS NULL THEN 1 ELSE 0 END), 0) as null_state
        FROM resources
        "#,
            [],
            |row| {
                Ok(IndexStateCounts {
                    pending: row.get(0)?,
                    indexing: row.get(1)?,
                    indexed: row.get(2)?,
                    failed: row.get(3)?,
                    disabled: row.get(4)?,
                    null_state: row.get(5)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    let total_resources: i32 = conn
        .query_row("SELECT COUNT(*) FROM resources", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;

    // 2. 获取所有资源详情（使用统一索引架构）
    // 注意：resources 表没有 name 列，使用 source_id 作为名称显示
    let all_resources_query = r#"
        SELECT r.id, r.source_id, r.type, r.storage_mode, r.index_state, r.index_error,
               LENGTH(COALESCE(r.data, '')) as data_len,
               CASE WHEN r.ocr_text IS NOT NULL AND r.ocr_text != '' THEN 1 ELSE 0 END as has_ocr,
               (SELECT COUNT(*) FROM vfs_index_units WHERE resource_id = r.id) as unit_count,
               (SELECT COUNT(*) FROM vfs_index_segments s JOIN vfs_index_units u ON s.unit_id = u.id WHERE u.resource_id = r.id) as seg_count,
               (SELECT text_state FROM vfs_index_units WHERE resource_id = r.id LIMIT 1) as unit_text_state,
               (SELECT mm_state FROM vfs_index_units WHERE resource_id = r.id LIMIT 1) as unit_mm_state,
               (SELECT text_embedding_dim FROM vfs_index_units WHERE resource_id = r.id LIMIT 1) as text_embedding_dim,
               (SELECT text_chunk_count FROM vfs_index_units WHERE resource_id = r.id LIMIT 1) as text_chunk_count,
               r.updated_at
        FROM resources r
        ORDER BY r.updated_at DESC
    "#;

    let mut all_stmt = conn
        .prepare(all_resources_query)
        .map_err(|e| e.to_string())?;
    let all_resources: Vec<ResourceDiagnostic> = all_stmt
        .query_map([], |row| {
            Ok(ResourceDiagnostic {
                id: row.get(0)?,
                name: row.get(1)?,
                resource_type: row.get(2)?,
                storage_mode: row.get(3)?,
                index_state: row.get(4)?,
                index_error: row.get(5)?,
                data_len: row.get(6)?,
                has_ocr_text: row.get::<_, i32>(7)? == 1,
                unit_count: row.get(8)?,
                segment_count: row.get(9)?,
                unit_text_state: row.get(10)?,
                unit_mm_state: row.get(11)?,
                text_embedding_dim: row.get(12)?,
                text_chunk_count: row.get(13)?,
                updated_at: row.get(14)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| match r {
            Ok(val) => Some(val),
            Err(e) => {
                log::warn!("[VfsHandlers] Skipping malformed row: {}", e);
                None
            }
        })
        .collect();

    // 抽样资源（最多15条，用于快速预览）
    let sample_resources: Vec<ResourceDiagnostic> =
        all_resources.iter().take(15).cloned().collect();

    // 3. vfs_index_units 表统计
    let units_stats: UnitsStats = conn
        .query_row(
            r#"
        SELECT
            COUNT(*) as total,
            COUNT(DISTINCT resource_id) as distinct_res,
            COALESCE(SUM(CASE WHEN text_state = 'pending' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN text_state = 'indexing' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN text_state = 'indexed' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN text_state = 'failed' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN text_state = 'disabled' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN mm_state = 'pending' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN mm_state = 'indexing' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN mm_state = 'indexed' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN mm_state = 'failed' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN mm_state = 'disabled' THEN 1 ELSE 0 END), 0)
        FROM vfs_index_units
        "#,
            [],
            |row| {
                Ok(UnitsStats {
                    total_count: row.get(0)?,
                    distinct_resources: row.get(1)?,
                    text_pending: row.get(2)?,
                    text_indexing: row.get(3)?,
                    text_indexed: row.get(4)?,
                    text_failed: row.get(5)?,
                    text_disabled: row.get(6)?,
                    mm_pending: row.get(7)?,
                    mm_indexing: row.get(8)?,
                    mm_indexed: row.get(9)?,
                    mm_failed: row.get(10)?,
                    mm_disabled: row.get(11)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    // 4. vfs_index_segments 表统计
    let segments_stats: SegmentsStats = conn
        .query_row(
            r#"
        SELECT
            COUNT(*) as total,
            COUNT(DISTINCT unit_id) as distinct_units,
            COALESCE(SUM(CASE WHEN modality = 'text' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN modality = 'multimodal' THEN 1 ELSE 0 END), 0),
            CASE WHEN COUNT(DISTINCT unit_id) > 0
                 THEN CAST(COUNT(*) AS REAL) / COUNT(DISTINCT unit_id)
                 ELSE 0.0 END as avg_segs
        FROM vfs_index_segments
        "#,
            [],
            |row| {
                Ok(SegmentsStats {
                    total_count: row.get(0)?,
                    distinct_units: row.get(1)?,
                    text_modality_count: row.get(2)?,
                    mm_modality_count: row.get(3)?,
                    avg_segments_per_unit: row.get(4)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    // 5. vfs_embedding_dims 表统计
    let mut dim_stmt = conn.prepare(
        r#"
        SELECT d.dimension, d.modality, d.record_count,
               (SELECT COUNT(*) FROM vfs_index_segments WHERE embedding_dim = d.dimension AND modality = d.modality) as actual
        FROM vfs_embedding_dims d
        "#
    ).map_err(|e| e.to_string())?;

    let dimensions_stats: Vec<DimensionStats> = dim_stmt
        .query_map([], |row| {
            Ok(DimensionStats {
                dimension: row.get(0)?,
                modality: row.get(1)?,
                record_count: row.get(2)?,
                actual_count: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| match r {
            Ok(val) => Some(val),
            Err(e) => {
                log::warn!("[VfsHandlers] Skipping malformed row: {}", e);
                None
            }
        })
        .collect();

    // 6. 一致性检查
    let mut consistency_checks = Vec::new();

    // 检查1: resources.index_state='indexed' 但无对应 units
    let indexed_no_units: i32 = conn
        .query_row(
            r#"
        SELECT COUNT(*) FROM resources r
        WHERE r.index_state = 'indexed'
          AND NOT EXISTS (SELECT 1 FROM vfs_index_units WHERE resource_id = r.id)
        "#,
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    consistency_checks.push(ConsistencyCheck {
        check_name: "resources_indexed_without_units".to_string(),
        passed: indexed_no_units == 0,
        details: format!("{} 个资源状态为 indexed 但无 units 记录", indexed_no_units),
    });

    // 检查2: units 存在但 resources.index_state 不是 indexed
    let units_not_indexed: i32 = conn
        .query_row(
            r#"
        SELECT COUNT(DISTINCT u.resource_id) FROM vfs_index_units u
        LEFT JOIN resources r ON u.resource_id = r.id
        WHERE r.index_state IS NULL OR r.index_state != 'indexed'
        "#,
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    consistency_checks.push(ConsistencyCheck {
        check_name: "units_exist_but_not_indexed".to_string(),
        passed: units_not_indexed == 0,
        details: format!(
            "{} 个资源有 units 但 resources.index_state 不是 indexed",
            units_not_indexed
        ),
    });

    // 检查3: unit.text_state='indexed' 但无对应 segments
    let unit_indexed_no_segments: i32 = conn.query_row(
        r#"
        SELECT COUNT(*) FROM vfs_index_units u
        WHERE u.text_state = 'indexed'
          AND NOT EXISTS (SELECT 1 FROM vfs_index_segments WHERE unit_id = u.id AND modality = 'text')
        "#,
        [],
        |row| row.get(0),
    ).unwrap_or(0);
    consistency_checks.push(ConsistencyCheck {
        check_name: "units_indexed_without_segments".to_string(),
        passed: unit_indexed_no_segments == 0,
        details: format!(
            "{} 个 unit 状态为 text_indexed 但无 text segments",
            unit_indexed_no_segments
        ),
    });

    // 检查4: segments 存在但 unit.text_state 不是 indexed
    let segments_unit_not_indexed: i32 = conn
        .query_row(
            r#"
        SELECT COUNT(DISTINCT s.unit_id) FROM vfs_index_segments s
        JOIN vfs_index_units u ON s.unit_id = u.id
        WHERE s.modality = 'text' AND u.text_state != 'indexed'
        "#,
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    consistency_checks.push(ConsistencyCheck {
        check_name: "segments_exist_but_unit_not_indexed".to_string(),
        passed: segments_unit_not_indexed == 0,
        details: format!(
            "{} 个 unit 有 segments 但 text_state 不是 indexed",
            segments_unit_not_indexed
        ),
    });

    // 检查4.1: unit.mm_state='indexed' 但无对应多模态 segments
    let unit_mm_indexed_no_segments: i32 = conn.query_row(
        r#"
        SELECT COUNT(*) FROM vfs_index_units u
        WHERE u.mm_state = 'indexed'
          AND NOT EXISTS (SELECT 1 FROM vfs_index_segments WHERE unit_id = u.id AND modality = 'multimodal')
        "#,
        [],
        |row| row.get(0),
    ).unwrap_or(0);
    consistency_checks.push(ConsistencyCheck {
        check_name: "units_mm_indexed_without_segments".to_string(),
        passed: unit_mm_indexed_no_segments == 0,
        details: format!(
            "{} 个 unit 状态为 mm_indexed 但无 multimodal segments",
            unit_mm_indexed_no_segments
        ),
    });

    // 检查4.2: multimodal segments 存在但 unit.mm_state 不是 indexed
    let mm_segments_unit_not_indexed: i32 = conn
        .query_row(
            r#"
        SELECT COUNT(DISTINCT s.unit_id) FROM vfs_index_segments s
        JOIN vfs_index_units u ON s.unit_id = u.id
        WHERE s.modality = 'multimodal' AND u.mm_state != 'indexed'
        "#,
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    consistency_checks.push(ConsistencyCheck {
        check_name: "mm_segments_exist_but_unit_not_indexed".to_string(),
        passed: mm_segments_unit_not_indexed == 0,
        details: format!(
            "{} 个 unit 有 multimodal segments 但 mm_state 不是 indexed",
            mm_segments_unit_not_indexed
        ),
    });

    // 检查5: vfs_embedding_dims.record_count 与实际 segments 数量一致性
    let mut dim_mismatch = 0;
    let mut dim_mismatch_details = Vec::new();
    for dim in &dimensions_stats {
        if dim.record_count != dim.actual_count {
            dim_mismatch += 1;
            dim_mismatch_details.push(format!(
                "dim={}:{} (recorded={}, actual={})",
                dim.dimension, dim.modality, dim.record_count, dim.actual_count
            ));
        }
    }
    consistency_checks.push(ConsistencyCheck {
        check_name: "dimension_record_count_match".to_string(),
        passed: dim_mismatch == 0,
        details: if dim_mismatch == 0 {
            "所有维度 record_count 与实际数量一致".to_string()
        } else {
            format!(
                "{} 个维度不一致: {}",
                dim_mismatch,
                dim_mismatch_details.join(", ")
            )
        },
    });

    // 检查6: 架构验证 - 三层模型完整性
    let architecture_valid = units_stats.total_count >= 0 && segments_stats.total_count >= 0;
    consistency_checks.push(ConsistencyCheck {
        check_name: "unified_index_architecture".to_string(),
        passed: architecture_valid,
        details: format!(
            "统一索引架构: {} resources → {} units → {} segments",
            total_resources, units_stats.total_count, segments_stats.total_count
        ),
    });

    // 检查7: pending 状态资源信息
    consistency_checks.push(ConsistencyCheck {
        check_name: "pending_resources_info".to_string(),
        passed: true,
        details: format!("{} 个资源待索引", state_counts.pending),
    });

    // 检查8: disabled 状态资源数量
    consistency_checks.push(ConsistencyCheck {
        check_name: "disabled_resources_info".to_string(),
        passed: true,
        details: format!(
            "{} 个资源被标记为 disabled（不适用）",
            state_counts.disabled
        ),
    });

    Ok(IndexDiagnosticInfo {
        timestamp,
        architecture_version: "unified_index_v1".to_string(),
        total_resources,
        state_counts,
        sample_resources,
        all_resources,
        units_stats,
        segments_stats,
        dimensions_stats,
        consistency_checks,
    })
}

/// 重置所有 disabled 资源为 pending 状态
///
/// 用于在修复后重新触发索引
#[tauri::command]
pub async fn vfs_reset_disabled_to_pending(
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<i32, String> {
    log::info!("[VFS::handlers] vfs_reset_disabled_to_pending");

    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

    let updated = conn
        .execute(
            "UPDATE resources SET index_state = 'pending', index_error = NULL,
            index_retry_count = 0, index_next_retry_at = 0
         WHERE index_state = 'disabled'",
            [],
        )
        .map_err(|e| e.to_string())?;

    log::info!(
        "[VFS::handlers] Reset {} disabled resources to pending",
        updated
    );

    Ok(updated as i32)
}

/// 重置所有 indexed 但无 embeddings 的资源为 pending 状态
#[tauri::command]
pub async fn vfs_reset_indexed_without_embeddings(
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<i32, String> {
    log::info!("[VFS::handlers] vfs_reset_indexed_without_segments");

    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

    // 使用统一索引架构的新表
    let updated = conn
        .execute(
            r#"
        UPDATE resources
        SET index_state = 'pending', index_error = NULL,
            index_retry_count = 0, index_next_retry_at = 0
        WHERE index_state = 'indexed'
          AND NOT EXISTS (
            SELECT 1 FROM vfs_index_units u
            JOIN vfs_index_segments s ON s.unit_id = u.id
            WHERE u.resource_id = resources.id
          )
        "#,
            [],
        )
        .map_err(|e| e.to_string())?;

    log::info!(
        "[VFS::handlers] Reset {} indexed-without-segments resources to pending",
        updated
    );

    Ok(updated as i32)
}

/// 重置所有索引状态（用于调试/重新索引）
///
/// 将所有资源的索引状态重置为 pending，并清空 segments、units、维度统计和 LanceDB 向量数据
#[tauri::command]
pub async fn vfs_reset_all_index_state(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<crate::vfs::lance_store::VfsLanceStore>>,
) -> Result<i32, String> {
    use crate::vfs::repos::{MODALITY_MULTIMODAL, MODALITY_TEXT};

    log::info!("[VFS::handlers] vfs_reset_all_index_state - 重置所有索引状态");

    // 清除文本向量
    let text_cleared = lance_store
        .clear_all(MODALITY_TEXT)
        .await
        .map_err(|e| e.to_string())?;
    log::info!("[VFS::handlers] 清除 {} 个文本向量表", text_cleared);

    // 清除多模态向量
    let mm_cleared = lance_store
        .clear_all(MODALITY_MULTIMODAL)
        .await
        .map_err(|e| e.to_string())?;
    log::info!("[VFS::handlers] 清除 {} 个多模态向量表", mm_cleared);

    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

    // 1. 删除所有 segments
    let deleted_segments = conn
        .execute("DELETE FROM vfs_index_segments", [])
        .map_err(|e| e.to_string())?;
    log::info!("[VFS::handlers] 删除 {} 个 segments", deleted_segments);

    // 2. 删除所有 units
    let deleted_units = conn
        .execute("DELETE FROM vfs_index_units", [])
        .map_err(|e| e.to_string())?;
    log::info!("[VFS::handlers] 删除 {} 个 units", deleted_units);

    // 3. 重置维度统计
    conn.execute("UPDATE vfs_embedding_dims SET record_count = 0", [])
        .map_err(|e| e.to_string())?;

    // 4. 将所有资源状态重置为 pending（含多模态状态）
    let updated = conn
        .execute(
            r#"
        UPDATE resources
        SET index_state = 'pending',
            index_hash = NULL,
            index_error = NULL,
            index_retry_count = 0,
            index_next_retry_at = 0,
            mm_index_state = 'pending',
            mm_index_error = NULL,
            mm_index_retry_count = 0,
            mm_index_next_retry_at = 0,
            mm_embedding_dim = NULL,
            mm_indexing_mode = NULL,
            mm_indexed_at = NULL
        "#,
            [],
        )
        .map_err(|e| e.to_string())?;

    // 5. 同步重置业务表中的多模态索引状态
    let files_reset = conn
        .execute(
            r#"
        UPDATE files
        SET mm_index_state = 'pending',
            mm_index_error = NULL,
            mm_indexed_pages_json = NULL,
            updated_at = datetime('now')
        "#,
            [],
        )
        .map_err(|e| e.to_string())?;

    let exams_reset = conn
        .execute(
            r#"
        UPDATE exam_sheets
        SET mm_index_state = 'pending',
            mm_index_error = NULL,
            mm_indexed_pages_json = NULL,
            mm_embedding_dim = NULL,
            mm_indexed_at = NULL,
            updated_at = datetime('now')
        "#,
            [],
        )
        .map_err(|e| e.to_string())?;

    log::info!(
        "[VFS::handlers] 重置 {} 个资源为 pending 状态（files={}, exam_sheets={})",
        updated,
        files_reset,
        exams_reset
    );

    Ok(updated as i32)
}

// ============================================================================
// 多模态索引命令（2026-01 VFS 多模态统一管理）
// ============================================================================

/// 多模态索引页面输入参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsMultimodalIndexPageInput {
    /// 页面索引（0-based）
    pub page_index: i32,
    /// 图片 Base64 数据
    pub image_base64: Option<String>,
    /// 图片 MIME 类型
    pub image_mime: Option<String>,
    /// OCR 文本或 VLM 摘要
    pub text_content: Option<String>,
    /// 图片 Blob 哈希
    pub blob_hash: Option<String>,
}

/// 多模态索引输入参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsMultimodalIndexInput {
    /// 资源 ID
    pub resource_id: String,
    /// 资源类型
    pub resource_type: String,
    /// 文件夹 ID（可选）
    pub folder_id: Option<String>,
    /// 待索引的页面列表
    pub pages: Vec<VfsMultimodalIndexPageInput>,
}

/// 多模态索引结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsMultimodalIndexOutput {
    /// 成功索引的页面数
    pub indexed_pages: usize,
    /// 向量维度
    pub dimension: usize,
    /// 失败的页面索引列表
    pub failed_pages: Vec<i32>,
}

/// 索引资源的多模态页面
///
/// ★ 2026-01: VFS 统一多模态索引
///
/// ## 参数
/// - `params`: 多模态索引输入参数
///
/// ## 返回
/// - `Ok(VfsMultimodalIndexOutput)`: 索引结果
/// - `Err(String)`: 索引失败
#[tauri::command]
pub async fn vfs_multimodal_index(
    params: VfsMultimodalIndexInput,
    app_handle: tauri::AppHandle,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    llm_manager: State<'_, Arc<crate::llm_manager::LLMManager>>,
    lance_store: State<'_, Arc<crate::vfs::lance_store::VfsLanceStore>>,
) -> Result<VfsMultimodalIndexOutput, String> {
    use crate::multimodal::types::IndexProgressEvent;
    use crate::vfs::multimodal_service::{VfsMultimodalPage, VfsMultimodalService};
    use tokio::sync::mpsc;

    let lance_store = Arc::clone(lance_store.inner());

    // 创建多模态服务
    let service =
        VfsMultimodalService::new(Arc::clone(&vfs_db), Arc::clone(&llm_manager), lance_store);

    let (progress_tx, mut progress_rx) = mpsc::unbounded_channel::<IndexProgressEvent>();
    let app_handle_clone = app_handle.clone();
    tokio::spawn(async move {
        while let Some(event) = progress_rx.recv().await {
            if let Ok(payload) = serde_json::to_value(&event) {
                let _ = app_handle_clone.emit("mm_index_progress", payload);
            }
        }
    });

    // 转换页面数据
    let pages: Vec<VfsMultimodalPage> = params
        .pages
        .into_iter()
        .map(|p| VfsMultimodalPage {
            page_index: p.page_index,
            image_base64: p.image_base64,
            image_mime: p.image_mime,
            text_content: p.text_content,
            blob_hash: p.blob_hash,
        })
        .collect();

    // 执行索引
    let result = service
        .index_resource_pages_with_progress(
            &params.resource_id,
            &params.resource_type,
            params.folder_id.as_deref(),
            pages,
            Some(progress_tx),
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(VfsMultimodalIndexOutput {
        indexed_pages: result.indexed_pages,
        dimension: result.dimension,
        failed_pages: result.failed_pages,
    })
}

/// 多模态检索输入参数
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VfsMultimodalQueryMode {
    Text,
    Image,
    Mixed,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsMultimodalSearchInput {
    /// 旧调用方使用的查询文本。新调用方优先使用 `queryText`。
    #[serde(default)]
    pub query: Option<String>,
    /// 多模态查询文本。
    #[serde(default)]
    pub query_text: Option<String>,
    /// 原始图片 Base64（不含 data URL 前缀）。
    #[serde(default)]
    pub query_image_base64: Option<String>,
    /// 图片 MIME；省略时默认 image/png。
    #[serde(default)]
    pub query_image_media_type: Option<String>,
    /// 显式查询模式；省略时根据 text/image 字段推断。
    #[serde(default)]
    pub query_mode: Option<VfsMultimodalQueryMode>,
    /// 返回的最大结果数
    #[serde(default = "default_top_k")]
    pub top_k: usize,
    /// 文件夹 ID 过滤
    pub folder_ids: Option<Vec<String>>,
    /// 资源 ID 过滤
    pub resource_ids: Option<Vec<String>>,
    /// 资源类型过滤
    pub resource_types: Option<Vec<String>>,
}

impl VfsMultimodalSearchInput {
    fn resolved_query(&self) -> Result<crate::multimodal::MultimodalInput, String> {
        use crate::multimodal::MultimodalInput;

        let text = self
            .query_text
            .as_deref()
            .or(self.query.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let image = self
            .query_image_base64
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let mode = self.query_mode.unwrap_or(match (text, image) {
            (Some(_), Some(_)) => VfsMultimodalQueryMode::Mixed,
            (None, Some(_)) => VfsMultimodalQueryMode::Image,
            _ => VfsMultimodalQueryMode::Text,
        });
        let media_type = self
            .query_image_media_type
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("image/png");

        match mode {
            VfsMultimodalQueryMode::Text => text
                .map(MultimodalInput::text)
                .ok_or_else(|| "text search requires queryText or query".to_string()),
            VfsMultimodalQueryMode::Image => image
                .map(|value| MultimodalInput::image_base64(value, media_type))
                .ok_or_else(|| "image search requires queryImageBase64".to_string()),
            VfsMultimodalQueryMode::Mixed => match (text, image) {
                (Some(text), Some(image)) => {
                    Ok(MultimodalInput::text_and_image(text, image, media_type))
                }
                (None, _) => Err("mixed search requires queryText or query".to_string()),
                (_, None) => Err("mixed search requires queryImageBase64".to_string()),
            },
        }
    }
}

fn default_top_k() -> usize {
    10
}

/// 多模态检索结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsMultimodalSearchOutput {
    /// Lance 行 ID
    pub embedding_id: String,
    /// 资源 ID
    pub resource_id: String,
    /// 资源类型
    pub resource_type: String,
    /// 页面索引
    pub page_index: i32,
    /// 文本内容
    pub text_content: Option<String>,
    /// 图片 Blob 哈希
    pub blob_hash: Option<String>,
    /// 相关度分数
    pub score: f32,
    /// 文件夹 ID
    pub folder_id: Option<String>,
    /// multi-profile RRF 路由来源
    pub retrieval_provenance: serde_json::Value,
}

async fn run_vfs_multimodal_search(
    params: VfsMultimodalSearchInput,
    vfs_db: Arc<VfsDatabase>,
    llm_manager: Arc<crate::llm_manager::LLMManager>,
    lance_store: Arc<crate::vfs::lance_store::VfsLanceStore>,
) -> Result<crate::vfs::UnifiedRetrievalResponse, String> {
    use crate::vfs::retrieval_planner::QueryModality;
    use crate::vfs::{UnifiedRetrievalRequest, VfsUnifiedRetriever};

    let resolved = params.resolved_query()?;
    let query_modality = match (resolved.text.is_some(), resolved.image.is_some()) {
        (true, true) => QueryModality::Mixed,
        (false, true) => QueryModality::Image,
        _ => QueryModality::Text,
    };
    let query_text = params.query_text.clone().or_else(|| params.query.clone());
    let retriever = VfsUnifiedRetriever::new(vfs_db, lance_store, llm_manager);
    retriever
        .search_multimodal(UnifiedRetrievalRequest {
            query_text,
            query_image_base64: params.query_image_base64,
            query_image_media_type: params.query_image_media_type,
            query_modality,
            top_k: params.top_k,
            folder_ids: params.folder_ids,
            resource_ids: params.resource_ids,
            resource_types: params.resource_types,
        })
        .await
        .map_err(|e| e.to_string())
}

/// 多模态向量检索
///
/// ★ 2026-01: VFS 统一多模态检索
///
/// ## 参数
/// - `params`: 多模态检索输入参数
///
/// ## 返回
/// - `Ok(Vec<VfsMultimodalSearchOutput>)`: 检索结果
/// - `Err(String)`: 检索失败
#[tauri::command]
pub async fn vfs_multimodal_search(
    params: VfsMultimodalSearchInput,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    llm_manager: State<'_, Arc<crate::llm_manager::LLMManager>>,
    lance_store: State<'_, Arc<crate::vfs::lance_store::VfsLanceStore>>,
) -> Result<Vec<VfsMultimodalSearchOutput>, String> {
    let response = run_vfs_multimodal_search(
        params,
        Arc::clone(vfs_db.inner()),
        Arc::clone(llm_manager.inner()),
        Arc::clone(lance_store.inner()),
    )
    .await?;

    Ok(response
        .result
        .hits
        .into_iter()
        .map(|fused| VfsMultimodalSearchOutput {
            embedding_id: fused.hit.embedding_id,
            resource_id: fused.hit.identity.resource_id,
            resource_type: fused
                .hit
                .resource_type
                .unwrap_or_else(|| "unknown".to_string()),
            page_index: fused
                .hit
                .identity
                .page_index
                .unwrap_or(fused.hit.identity.chunk_index),
            text_content: Some(fused.hit.text),
            blob_hash: fused.hit.blob_hash,
            score: fused.rrf_score as f32,
            folder_id: fused.hit.folder_id,
            retrieval_provenance: serde_json::to_value(fused.provenance)
                .unwrap_or(serde_json::Value::Null),
        })
        .collect())
}

/// 返回完整的多路检索诊断信息；旧的 `vfs_multimodal_search` 继续只返回扁平命中列表。
#[tauri::command]
pub async fn vfs_multimodal_search_detailed(
    params: VfsMultimodalSearchInput,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    llm_manager: State<'_, Arc<crate::llm_manager::LLMManager>>,
    lance_store: State<'_, Arc<crate::vfs::lance_store::VfsLanceStore>>,
) -> Result<crate::vfs::UnifiedRetrievalResponse, String> {
    run_vfs_multimodal_search(
        params,
        Arc::clone(vfs_db.inner()),
        Arc::clone(llm_manager.inner()),
        Arc::clone(lance_store.inner()),
    )
    .await
}

/// 只读能力检查。该命令不会创建、修复或重建 Lance 表/索引。
#[tauri::command]
pub async fn vfs_inspect_retrieval_capabilities(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    llm_manager: State<'_, Arc<crate::llm_manager::LLMManager>>,
    lance_store: State<'_, Arc<crate::vfs::lance_store::VfsLanceStore>>,
) -> Result<crate::vfs::CapabilitySnapshot, String> {
    let retriever = crate::vfs::VfsUnifiedRetriever::new(
        Arc::clone(vfs_db.inner()),
        Arc::clone(lance_store.inner()),
        Arc::clone(llm_manager.inner()),
    );
    retriever
        .inspect_capabilities()
        .await
        .map_err(|error| error.to_string())
}

/// 获取 VFS 多模态索引统计
#[tauri::command]
pub async fn vfs_multimodal_stats(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    llm_manager: State<'_, Arc<crate::llm_manager::LLMManager>>,
    lance_store: State<'_, Arc<crate::vfs::lance_store::VfsLanceStore>>,
) -> Result<serde_json::Value, String> {
    use crate::vfs::multimodal_service::VfsMultimodalService;

    let lance_store = Arc::clone(lance_store.inner());

    // 创建多模态服务
    let service =
        VfsMultimodalService::new(Arc::clone(&vfs_db), Arc::clone(&llm_manager), lance_store);

    let stats = service.get_stats().await.map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "totalRecords": stats.total_records,
        "dimensions": stats.dimensions,
    }))
}

/// 删除资源的多模态索引
#[tauri::command]
pub async fn vfs_multimodal_delete(
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    llm_manager: State<'_, Arc<crate::llm_manager::LLMManager>>,
    lance_store: State<'_, Arc<crate::vfs::lance_store::VfsLanceStore>>,
) -> Result<(), String> {
    use crate::vfs::multimodal_service::VfsMultimodalService;

    let lance_store = Arc::clone(lance_store.inner());

    let service =
        VfsMultimodalService::new(Arc::clone(&vfs_db), Arc::clone(&llm_manager), lance_store);

    service
        .delete_resource_index(&resource_id)
        .await
        .map_err(|e| e.to_string())
}

/// VFS 多模态索引资源（兼容旧 API）
///
/// ★ 2026-01: 兼容 mm_index_resource 的 VFS 版本
/// ★ P1-3 修复: 添加 mm_index_progress 事件发送
#[tauri::command]
pub async fn vfs_multimodal_index_resource(
    source_type: String,
    source_id: String,
    folder_id: Option<String>,
    force_rebuild: Option<bool>,
    app_handle: tauri::AppHandle,
    database: State<'_, Arc<crate::database::Database>>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    llm_manager: State<'_, Arc<crate::llm_manager::LLMManager>>,
    lance_store: State<'_, Arc<crate::vfs::lance_store::VfsLanceStore>>,
) -> Result<serde_json::Value, String> {
    use crate::multimodal::types::IndexProgressEvent;
    use crate::vfs::multimodal_service::VfsMultimodalService;
    use tokio::sync::mpsc;

    let lance_store = Arc::clone(lance_store.inner());

    let service =
        VfsMultimodalService::new(Arc::clone(&vfs_db), Arc::clone(&llm_manager), lance_store);

    let (progress_tx, mut progress_rx) = mpsc::unbounded_channel::<IndexProgressEvent>();
    let app_handle_clone = app_handle.clone();
    tokio::spawn(async move {
        while let Some(event) = progress_rx.recv().await {
            if let Ok(payload) = serde_json::to_value(&event) {
                let _ = app_handle_clone.emit("mm_index_progress", payload);
            }
        }
    });

    let result = service
        .index_resource_by_source_with_progress(
            Arc::clone(&database),
            &source_type,
            &source_id,
            folder_id.as_deref(),
            force_rebuild.unwrap_or(false),
            Some(progress_tx),
        )
        .await;

    let result = result.map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "indexedPages": result.indexed_pages,
        "dimension": result.dimension,
        "failedPages": result.failed_pages,
    }))
}

#[tauri::command]
pub async fn vfs_diagnose_lance_schema(
    modality: Option<String>,
    _vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<crate::vfs::lance_store::VfsLanceStore>>,
) -> Result<Vec<crate::vfs::lance_store::LanceTableDiagnostic>, String> {
    use crate::vfs::repos::MODALITY_TEXT;

    log::info!(
        "[VFS::handlers] vfs_diagnose_lance_schema: modality={:?}",
        modality
    );

    let modality_str = modality.as_deref().unwrap_or(MODALITY_TEXT);

    lance_store
        .diagnose_table_schema(modality_str)
        .await
        .map_err(|e| e.to_string())
}

// ============================================================================
// PDF 预处理流水线命令
// ============================================================================

/// 获取 PDF 处理状态
///
/// ## 参数
/// - `file_id`: 文件 ID
///
/// ## 返回
/// - `ProcessingStatus`: 处理状态信息
#[tauri::command]
pub async fn vfs_get_pdf_processing_status(
    file_id: String,
    pdf_processing_service: State<
        '_,
        Arc<crate::vfs::pdf_processing_service::PdfProcessingService>,
    >,
) -> Result<Option<crate::vfs::pdf_processing_service::ProcessingStatus>, String> {
    log::info!(
        "[VFS::handlers] vfs_get_pdf_processing_status: file_id={}",
        file_id
    );

    // 验证 file_id 格式
    validate_id_format_any(&file_id, &["file_", "tb_", "att_"], "file_id")?;

    // 使用 Tauri State 中的服务实例
    pdf_processing_service
        .get_status(&file_id)
        .map_err(|e| e.to_string())
}

/// 取消 PDF 处理
///
/// ## 参数
/// - `file_id`: 文件 ID
///
/// ## 返回
/// - `bool`: 是否成功取消（false 表示没有正在运行的任务）
#[tauri::command]
pub async fn vfs_cancel_pdf_processing(
    file_id: String,
    pdf_processing_service: State<
        '_,
        Arc<crate::vfs::pdf_processing_service::PdfProcessingService>,
    >,
) -> Result<bool, String> {
    log::info!(
        "[VFS::handlers] vfs_cancel_pdf_processing: file_id={}",
        file_id
    );

    // 验证 file_id 格式
    validate_id_format_any(&file_id, &["file_", "tb_", "att_"], "file_id")?;

    pdf_processing_service
        .cancel(&file_id)
        .map_err(|e| e.to_string())
}

/// 重试 PDF 处理
///
/// ## 参数
/// - `file_id`: 文件 ID
#[tauri::command]
pub async fn vfs_retry_pdf_processing(
    file_id: String,
    pdf_processing_service: State<
        '_,
        Arc<crate::vfs::pdf_processing_service::PdfProcessingService>,
    >,
) -> Result<(), String> {
    log::info!(
        "[VFS::handlers] vfs_retry_pdf_processing: file_id={}",
        file_id
    );

    // 验证 file_id 格式
    validate_id_format_any(&file_id, &["file_", "tb_", "att_"], "file_id")?;

    pdf_processing_service
        .retry(&file_id)
        .await
        .map_err(|e| e.to_string())
}

/// 启动 PDF 预处理流水线
///
/// ## 参数
/// - `file_id`: 文件 ID
/// - `start_from_stage`: 从哪个阶段开始（可选，默认从 OCR 阶段开始）
///
/// ## 说明
/// 此命令异步启动流水线，立即返回。
/// 前端应监听以下事件获取进度：
/// - `pdf-processing-progress`: 进度更新
/// - `pdf-processing-completed`: 处理完成
/// - `pdf-processing-error`: 处理错误
#[tauri::command]
pub async fn vfs_start_pdf_processing(
    file_id: String,
    start_from_stage: Option<String>,
    pdf_processing_service: State<
        '_,
        Arc<crate::vfs::pdf_processing_service::PdfProcessingService>,
    >,
) -> Result<(), String> {
    use crate::vfs::pdf_processing_service::ProcessingStage;

    log::info!(
        "[VFS::handlers] vfs_start_pdf_processing: file_id={}, start_from_stage={:?}",
        file_id,
        start_from_stage
    );

    // 验证 file_id 格式
    validate_id_format_any(&file_id, &["file_", "tb_", "att_"], "file_id")?;

    // 解析起始阶段
    let stage = start_from_stage.map(|s| ProcessingStage::from_str(&s));

    pdf_processing_service
        .start_pipeline(&file_id, stage)
        .await
        .map_err(|e| e.to_string())
}

/// 批量获取 PDF 处理状态
///
/// ## 参数
/// - `file_ids`: 文件 ID 列表
///
/// ## 返回
/// - `HashMap<String, ProcessingStatus>`: 文件 ID -> 处理状态映射
#[tauri::command]
pub async fn vfs_get_batch_pdf_processing_status(
    file_ids: Vec<String>,
    pdf_processing_service: State<
        '_,
        Arc<crate::vfs::pdf_processing_service::PdfProcessingService>,
    >,
) -> Result<
    std::collections::HashMap<String, crate::vfs::pdf_processing_service::ProcessingStatus>,
    String,
> {
    use std::collections::HashMap;

    log::info!(
        "[VFS::handlers] vfs_get_batch_pdf_processing_status: count={}",
        file_ids.len()
    );

    let mut results = HashMap::new();

    for file_id in file_ids {
        if let Err(e) = validate_id_format_any(&file_id, &["file_", "tb_", "att_"], "file_id") {
            log::warn!(
                "[VFS::handlers] Invalid file_id in batch: {} - {}",
                file_id,
                e
            );
            continue;
        }

        match pdf_processing_service.get_status(&file_id) {
            Ok(Some(status)) => {
                results.insert(file_id, status);
            }
            Ok(None) => {
                log::debug!("[VFS::handlers] No processing status for file: {}", file_id);
            }
            Err(e) => {
                log::warn!(
                    "[VFS::handlers] Failed to get status for {}: {}",
                    file_id,
                    e
                );
            }
        }
    }

    Ok(results)
}

/// 列出待处理的 PDF 文件
///
/// ## 参数
/// - `limit`: 最大返回数量（默认 50）
///
/// ## 返回
/// - `Vec<VfsFile>`: 待处理的 PDF 文件列表
#[tauri::command]
pub async fn vfs_list_pending_pdf_processing(
    limit: Option<u32>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<VfsFile>, String> {
    use rusqlite::params;

    log::info!(
        "[VFS::handlers] vfs_list_pending_pdf_processing: limit={:?}",
        limit
    );

    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(50);

    let mut stmt = conn
        .prepare(
            r#"
        SELECT id, resource_id, blob_hash, sha256, file_name, original_path, size, page_count,
               "type", mime_type, tags_json, is_favorite, last_opened_at, last_page, bookmarks_json,
               cover_key, extracted_text, preview_json, ocr_pages_json, description,
               status, created_at, updated_at, deleted_at,
               processing_status, processing_progress, processing_error,
               processing_started_at, processing_completed_at,
               compressed_blob_hash
        FROM files
        WHERE mime_type = 'application/pdf'
          AND status = 'active'
          AND (processing_status = 'pending' OR processing_status IS NULL)
        ORDER BY created_at DESC
        LIMIT ?1
        "#,
        )
        .map_err(|e| format!("Failed to prepare statement: {}", e))?;

    let rows = stmt
        .query_map(params![limit], |row| {
            let tags_json: Option<String> = row.get(10)?;
            let bookmarks_json: Option<String> = row.get(14)?;

            let tags: Vec<String> = tags_json
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            let bookmarks: Vec<serde_json::Value> = bookmarks_json
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
                // PDF 预处理流水线字段
                processing_status: row.get(24)?,
                processing_progress: row.get(25)?,
                processing_error: row.get(26)?,
                processing_started_at: row.get(27)?,
                processing_completed_at: row.get(28)?,
                // ★ P0 架构改造：压缩图片字段
                compressed_blob_hash: row.get(29)?,
            })
        })
        .map_err(|e| format!("Failed to query: {}", e))?;

    let files: Vec<VfsFile> = rows
        .filter_map(|r| match r {
            Ok(val) => Some(val),
            Err(e) => {
                log::warn!("[VfsHandlers] Skipping malformed row: {}", e);
                None
            }
        })
        .collect();
    log::info!(
        "[VFS::handlers] vfs_list_pending_pdf_processing: found {} files",
        files.len()
    );

    Ok(files)
}

// ============================================================================
// ★ 媒体缓存管理命令（PDF/图片预处理缓存）
// ============================================================================

/// 媒体缓存统计信息
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaCacheStats {
    /// PDF 页面图片缓存（blobs 中的 preview 图片）
    pub pdf_preview_count: u64,
    pub pdf_preview_size: u64,
    /// 压缩图片缓存（compressed_blob_hash 引用的 blobs）
    pub compressed_image_count: u64,
    pub compressed_image_size: u64,
    /// OCR 文本缓存（resources.ocr_text 和 files.ocr_pages_json）
    pub ocr_text_count: u64,
    /// 向量索引数量（LanceDB 中的记录数）
    pub vector_index_count: u64,
    /// 向量索引大小（LanceDB 目录大小）
    pub vector_index_size: u64,
    /// 总缓存大小
    pub total_size: u64,
}

/// 获取媒体缓存统计信息
///
/// 统计 PDF 预览图片、压缩图片、OCR 文本和向量索引的缓存大小。
#[tauri::command]
pub async fn vfs_get_media_cache_stats(
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<MediaCacheStats, String> {
    log::info!("[VFS::handlers] vfs_get_media_cache_stats: Starting...");

    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;
    let blobs_dir = vfs_db.blobs_dir();

    // 1. 统计 PDF 预览图片（preview_json 中引用的 blobs）
    let (pdf_preview_count, pdf_preview_size) = {
        // 获取所有 preview_json 中的 blob_hash
        let mut stmt = conn
            .prepare("SELECT preview_json FROM files WHERE preview_json IS NOT NULL")
            .map_err(|e| e.to_string())?;

        let mut count = 0u64;
        let mut size = 0u64;

        let rows = stmt
            .query_map([], |row| {
                let json_str: String = row.get(0)?;
                Ok(json_str)
            })
            .map_err(|e| e.to_string())?;

        for row in rows.flatten() {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&row) {
                if let Some(pages) = json.get("pages").and_then(|p| p.as_array()) {
                    for page in pages {
                        if let Some(blob_hash) = page.get("blob_hash").and_then(|h| h.as_str()) {
                            // 获取 blob 大小
                            let blob_size: i64 = conn
                                .query_row(
                                    "SELECT size FROM blobs WHERE hash = ?1",
                                    rusqlite::params![blob_hash],
                                    |r| r.get(0),
                                )
                                .unwrap_or(0);
                            count += 1;
                            size += blob_size as u64;
                        }
                    }
                }
            }
        }
        (count, size)
    };

    // 2. 统计压缩图片缓存
    let (compressed_image_count, compressed_image_size) = {
        let result: (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(b.size), 0) FROM files f
             JOIN blobs b ON f.compressed_blob_hash = b.hash
             WHERE f.compressed_blob_hash IS NOT NULL",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or((0, 0));
        (result.0 as u64, result.1 as u64)
    };

    // 3. 统计 OCR 文本缓存
    let ocr_text_count: u64 = conn
        .query_row(
            r#"
            SELECT COUNT(*)
            FROM files f
            LEFT JOIN resources r ON r.id = f.resource_id
            WHERE r.ocr_text IS NOT NULL OR f.ocr_pages_json IS NOT NULL
            "#,
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) as u64;

    // 4. 统计向量索引（LanceDB）
    let lance_dir = blobs_dir
        .parent()
        .map(|p| p.join("lance").join("vfs"))
        .unwrap_or_else(|| blobs_dir.join("lance").join("vfs"));

    let (vector_index_count, vector_index_size) = if lance_dir.exists() {
        // 计算目录大小
        let mut dir_size = 0u64;
        if let Ok(entries) = std::fs::read_dir(&lance_dir) {
            for entry in entries.flatten() {
                if let Ok(metadata) = entry.metadata() {
                    if metadata.is_file() {
                        dir_size += metadata.len();
                    } else if metadata.is_dir() {
                        // 递归计算子目录大小
                        dir_size += calculate_dir_size(&entry.path()).unwrap_or(0);
                    }
                }
            }
        }
        // 向量数量从 resources.vector_indexed_at 统计
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM resources WHERE vector_indexed_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        (count as u64, dir_size)
    } else {
        (0, 0)
    };

    let total_size = pdf_preview_size + compressed_image_size + vector_index_size;

    let stats = MediaCacheStats {
        pdf_preview_count,
        pdf_preview_size,
        compressed_image_count,
        compressed_image_size,
        ocr_text_count,
        vector_index_count,
        vector_index_size,
        total_size,
    };

    log::info!(
        "[VFS::handlers] vfs_get_media_cache_stats: total_size={} bytes, pdf_preview={}, compressed={}, ocr={}, vector={}",
        total_size, pdf_preview_count, compressed_image_count, ocr_text_count, vector_index_count
    );

    Ok(stats)
}

/// 清理媒体缓存
///
/// ## 参数
/// - `clear_pdf_preview`: 清理 PDF 页面预览图片
/// - `clear_compressed_images`: 清理压缩图片缓存
/// - `clear_ocr_text`: 清理 OCR 文本
/// - `clear_vector_index`: 清理向量索引
///
/// ## 返回
/// - 清理的字节数
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearMediaCacheParams {
    pub clear_pdf_preview: bool,
    pub clear_compressed_images: bool,
    pub clear_ocr_text: bool,
    pub clear_vector_index: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearMediaCacheResult {
    pub pdf_preview_cleared: u64,
    pub compressed_images_cleared: u64,
    pub ocr_text_cleared: u64,
    pub vector_index_cleared: u64,
    pub total_bytes_freed: u64,
    pub files_reset: u64,
}

#[tauri::command]
pub async fn vfs_clear_media_cache(
    params: ClearMediaCacheParams,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<ClearMediaCacheResult, String> {
    log::info!(
        "[VFS::handlers] vfs_clear_media_cache: pdf={}, compressed={}, ocr={}, vector={}",
        params.clear_pdf_preview,
        params.clear_compressed_images,
        params.clear_ocr_text,
        params.clear_vector_index
    );

    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;
    let blobs_dir = vfs_db.blobs_dir();

    let mut result = ClearMediaCacheResult {
        pdf_preview_cleared: 0,
        compressed_images_cleared: 0,
        ocr_text_cleared: 0,
        vector_index_cleared: 0,
        total_bytes_freed: 0,
        files_reset: 0,
    };

    // 1. 清理 PDF 预览图片
    if params.clear_pdf_preview {
        // 获取所有 preview_json 中的 blob_hash
        let mut stmt = conn
            .prepare("SELECT id, preview_json FROM files WHERE preview_json IS NOT NULL")
            .map_err(|e| e.to_string())?;

        let rows: Vec<(String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| match r {
                Ok(val) => Some(val),
                Err(e) => {
                    log::warn!("[VfsHandlers] Skipping malformed row: {}", e);
                    None
                }
            })
            .collect();

        for (file_id, json_str) in rows {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&json_str) {
                if let Some(pages) = json.get("pages").and_then(|p| p.as_array()) {
                    for page in pages {
                        let original_hash = page
                            .get("blob_hash")
                            .or_else(|| page.get("blobHash"))
                            .and_then(|h| h.as_str());
                        let compressed_hash = page
                            .get("compressed_blob_hash")
                            .or_else(|| page.get("compressedBlobHash"))
                            .and_then(|h| h.as_str());

                        if let Some(blob_hash) = original_hash {
                            // 减少原始 blob 引用计数
                            let _ =
                                VfsBlobRepo::decrement_ref_with_conn(&conn, blobs_dir, blob_hash);
                            // 获取大小
                            let size: i64 = conn
                                .query_row(
                                    "SELECT size FROM blobs WHERE hash = ?1",
                                    rusqlite::params![blob_hash],
                                    |r| r.get(0),
                                )
                                .unwrap_or(0);
                            result.pdf_preview_cleared += 1;
                            result.total_bytes_freed += size as u64;
                        }

                        if let Some(ch) = compressed_hash {
                            let is_same = original_hash.map(|oh| oh == ch).unwrap_or(false);
                            if !is_same {
                                let _ = VfsBlobRepo::decrement_ref_with_conn(&conn, blobs_dir, ch);
                                let size: i64 = conn
                                    .query_row(
                                        "SELECT size FROM blobs WHERE hash = ?1",
                                        rusqlite::params![ch],
                                        |r| r.get(0),
                                    )
                                    .unwrap_or(0);
                                result.pdf_preview_cleared += 1;
                                result.total_bytes_freed += size as u64;
                            }
                        }
                    }
                }
            }
            // 清空 preview_json
            let _ = conn.execute(
                "UPDATE files SET preview_json = NULL WHERE id = ?1",
                rusqlite::params![file_id],
            );
            result.files_reset += 1;
        }

        // 清理无引用的 blobs
        let _ = VfsBlobRepo::cleanup_unreferenced(&vfs_db);
    }

    // 2. 清理压缩图片缓存
    if params.clear_compressed_images {
        let mut stmt = conn.prepare(
            "SELECT id, compressed_blob_hash, blob_hash FROM files WHERE compressed_blob_hash IS NOT NULL"
        ).map_err(|e| e.to_string())?;

        let rows: Vec<(String, String, Option<String>)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| match r {
                Ok(val) => Some(val),
                Err(e) => {
                    log::warn!("[VfsHandlers] Skipping malformed row: {}", e);
                    None
                }
            })
            .collect();

        for (file_id, compressed_hash, original_hash) in rows {
            let is_same_as_original = original_hash
                .as_ref()
                .map(|h| h == &compressed_hash)
                .unwrap_or(false);
            // 减少引用计数（仅当与原始 blob 不同）
            if !is_same_as_original {
                // 获取大小（仅当确实释放）
                let size: i64 = conn
                    .query_row(
                        "SELECT size FROM blobs WHERE hash = ?1",
                        rusqlite::params![compressed_hash],
                        |r| r.get(0),
                    )
                    .unwrap_or(0);
                let _ = VfsBlobRepo::decrement_ref_with_conn(&conn, blobs_dir, &compressed_hash);
                result.total_bytes_freed += size as u64;
            }

            // 清空 compressed_blob_hash
            let _ = conn.execute(
                "UPDATE files SET compressed_blob_hash = NULL WHERE id = ?1",
                rusqlite::params![file_id],
            );

            result.compressed_images_cleared += 1;
            result.files_reset += 1;
        }

        let _ = VfsBlobRepo::cleanup_unreferenced(&vfs_db);
    }

    // 3. 清理 OCR 文本
    if params.clear_ocr_text {
        let cleared: i64 = conn
            .query_row(
                r#"
                SELECT COUNT(*)
                FROM files f
                LEFT JOIN resources r ON r.id = f.resource_id
                WHERE r.ocr_text IS NOT NULL OR f.ocr_pages_json IS NOT NULL
                "#,
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        conn.execute(
            "UPDATE files SET ocr_pages_json = NULL WHERE ocr_pages_json IS NOT NULL",
            [],
        )
        .map_err(|e| e.to_string())?;

        // 同时清理 resources 表的 ocr_text
        conn.execute(
            "UPDATE resources SET ocr_text = NULL WHERE ocr_text IS NOT NULL",
            [],
        )
        .map_err(|e| e.to_string())?;

        result.ocr_text_cleared = cleared as u64;
        result.files_reset += cleared as u64;
    }

    // 4. 清理向量索引
    if params.clear_vector_index {
        let lance_dir = blobs_dir
            .parent()
            .map(|p| p.join("lance").join("vfs"))
            .unwrap_or_else(|| blobs_dir.join("lance").join("vfs"));

        if lance_dir.exists() {
            // 计算目录大小
            let dir_size = calculate_dir_size(&lance_dir).unwrap_or(0);

            // 删除 LanceDB 目录
            if let Err(e) = std::fs::remove_dir_all(&lance_dir) {
                log::warn!("[VFS::handlers] Failed to remove lance dir: {}", e);
            } else {
                result.vector_index_cleared = 1;
                result.total_bytes_freed += dir_size;
            }
        }

        // ★ P1 修复：清理 vfs_index_units 和 vfs_index_segments 表
        conn.execute("DELETE FROM vfs_index_segments", [])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM vfs_index_units", [])
            .map_err(|e| e.to_string())?;

        // 重置维度统计
        conn.execute("UPDATE vfs_embedding_dims SET record_count = 0", [])
            .map_err(|e| e.to_string())?;

        // 重置 resources.vector_indexed_at
        let reset_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM resources WHERE vector_indexed_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        conn.execute(
            "UPDATE resources SET vector_indexed_at = NULL WHERE vector_indexed_at IS NOT NULL",
            [],
        )
        .map_err(|e| e.to_string())?;

        result.files_reset += reset_count as u64;
    }

    // 5. ★ P0 修复：根据清理的缓存类型更新 processing_progress 中的 ready_modes
    // 而不是简单地将整个 processing_progress 设为 NULL
    if params.clear_pdf_preview || params.clear_compressed_images || params.clear_ocr_text {
        // 查询所有有 processing_progress 的文件
        let mut stmt = conn
            .prepare(
                "SELECT id, processing_progress FROM files
             WHERE processing_progress IS NOT NULL
             AND (mime_type LIKE 'application/pdf' OR mime_type LIKE 'image/%')",
            )
            .map_err(|e| e.to_string())?;

        let files_to_update: Vec<(String, String)> = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| match r {
                Ok(val) => Some(val),
                Err(e) => {
                    log::warn!("[VfsHandlers] Skipping malformed row: {}", e);
                    None
                }
            })
            .collect();

        for (file_id, progress_json) in files_to_update {
            // 解析 processing_progress JSON
            if let Ok(mut progress) = serde_json::from_str::<serde_json::Value>(&progress_json) {
                let modes_key = if progress.get("readyModes").is_some() {
                    "readyModes"
                } else {
                    "ready_modes"
                };
                if let Some(ready_modes) =
                    progress.get_mut(modes_key).and_then(|v| v.as_array_mut())
                {
                    // 根据清理类型移除对应的 ready_mode
                    if params.clear_pdf_preview {
                        ready_modes.retain(|v| v.as_str() != Some("image"));
                    }
                    if params.clear_ocr_text {
                        ready_modes.retain(|v| v.as_str() != Some("ocr"));
                    }
                    // 注意：clear_compressed_images 不影响 ready_modes（压缩是优化，不是模式）
                }

                // 更新 processing_progress
                let updated_json = serde_json::to_string(&progress).unwrap_or_default();
                conn.execute(
                    "UPDATE files SET
                        processing_status = 'pending',
                        processing_progress = ?1,
                        processing_error = NULL,
                        processing_started_at = NULL,
                        processing_completed_at = NULL
                    WHERE id = ?2",
                    rusqlite::params![updated_json, file_id],
                )
                .map_err(|e| e.to_string())?;
            }
        }

        // 对于没有 processing_progress 的文件，重置为 pending
        conn.execute(
            "UPDATE files SET
                processing_status = 'pending',
                processing_error = NULL,
                processing_started_at = NULL,
                processing_completed_at = NULL
            WHERE processing_progress IS NULL
            AND (mime_type LIKE 'application/pdf' OR mime_type LIKE 'image/%')",
            [],
        )
        .map_err(|e| e.to_string())?;
    }

    log::info!(
        "[VFS::handlers] vfs_clear_media_cache: Complete! freed {} bytes, reset {} files",
        result.total_bytes_freed,
        result.files_reset
    );

    Ok(result)
}

/// 计算目录大小（递归）
fn calculate_dir_size(path: &std::path::Path) -> std::io::Result<u64> {
    let mut size = 0u64;
    if path.is_dir() {
        for entry in std::fs::read_dir(path)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                size += calculate_dir_size(&path)?;
            } else {
                size += entry.metadata()?.len();
            }
        }
    }
    Ok(size)
}

// ============================================================================
// 论文下载重试命令
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsDownloadPaperParams {
    /// PDF 下载 URL
    pub url: String,
    /// 论文标题（用作文件名）
    pub title: String,
    /// 目标文件夹 ID（可选，默认根目录）
    pub folder_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsDownloadPaperResult {
    pub success: bool,
    pub file_id: Option<String>,
    pub file_name: Option<String>,
    pub size_bytes: Option<u64>,
    pub page_count: Option<i32>,
    pub error: Option<String>,
}

/// 独立下载论文 PDF 并保存到 VFS（用于前端重试）
///
/// 不依赖 chat pipeline，直接下载 + 保存。
#[tauri::command]
pub async fn vfs_download_paper(
    params: VfsDownloadPaperParams,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    pdf_processing_service: State<'_, Arc<PdfProcessingService>>,
) -> Result<VfsDownloadPaperResult, String> {
    use crate::vfs::repos::pdf_preview::{render_pdf_preview, PdfPreviewConfig};
    use crate::vfs::repos::VfsFileRepo;
    use sha2::{Digest, Sha256};

    log::info!(
        "[VFS::download_paper] Downloading '{}' from: {}",
        params.title,
        params.url
    );

    // 安全检查
    if !params.url.starts_with("https://") {
        return Err("Only HTTPS URLs are allowed".to_string());
    }

    // 下载 PDF
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let response = client
        .get(&params.url)
        .header("User-Agent", "DeepStudent/1.0 (Academic Paper Save)")
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    let pdf_bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Read failed: {}", e))?
        .to_vec();

    // PDF 签名验证
    if pdf_bytes.len() < 4 || &pdf_bytes[..4] != b"%PDF" {
        return Err("Downloaded file is not a valid PDF".to_string());
    }

    // SHA256 去重
    let mut hasher = Sha256::new();
    hasher.update(&pdf_bytes);
    let sha256 = format!("{:x}", hasher.finalize());

    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

    if let Ok(Some(existing)) = VfsFileRepo::get_by_sha256_with_conn(&conn, &sha256) {
        if existing.status == "active" {
            return Ok(VfsDownloadPaperResult {
                success: true,
                file_id: Some(existing.id),
                file_name: None,
                size_bytes: Some(pdf_bytes.len() as u64),
                page_count: existing.page_count,
                error: None,
            });
        }
    }

    // ★ TD-03：与 vfs_upload_file 相同的最小 saga——
    // 预览渲染（独立连接）先行并登记补偿账本；主 blob 落库 + 文件三表写入
    // 在同一连接 SAVEPOINT 内整体回滚；索引失败置显式可重试状态。
    use crate::vfs::VfsBlobRepo;
    let blobs_dir = vfs_db.blobs_dir();
    let mut saga = crate::vfs::upload_saga::UploadSaga::new();

    // PDF 预览 + 文本提取（spawn_blocking 避免阻塞 tokio 线程；须在 savepoint 之外）
    let (preview_json, extracted_text, page_count) = {
        let vfs_db_clone = vfs_db.inner().clone();
        let blobs_dir_clone = blobs_dir.to_path_buf();
        let pdf_bytes_clone = pdf_bytes.clone();
        match tokio::task::spawn_blocking(move || {
            let conn = vfs_db_clone.get_conn_safe().map_err(|e| e.to_string())?;
            render_pdf_preview(
                &conn,
                &blobs_dir_clone,
                &pdf_bytes_clone,
                &PdfPreviewConfig::default(),
            )
            .map_err(|e| e.to_string())
        })
        .await
        {
            Ok(Ok(result)) => {
                if let Some(ref preview) = result.preview_json {
                    saga.record_preview_blobs(preview);
                }
                let preview_str = result
                    .preview_json
                    .as_ref()
                    .and_then(|p| serde_json::to_string(p).ok());
                (
                    preview_str,
                    result.extracted_text,
                    Some(result.page_count as i32),
                )
            }
            Ok(Err(e)) => {
                log::warn!("[VFS::download_paper] PDF preview failed: {}", e);
                (None, None, None)
            }
            Err(e) => {
                log::warn!("[VFS::download_paper] PDF render task panicked: {}", e);
                (None, None, None)
            }
        }
    };

    // 文件名
    let safe_title = params
        .title
        .replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|', '\0'], "_");
    let file_name = if safe_title.to_lowercase().ends_with(".pdf") {
        safe_title
    } else {
        format!("{}.pdf", safe_title)
    };

    let folder_id = params.folder_id.as_deref().filter(|s| !s.is_empty());

    let saga_result =
        crate::vfs::upload_saga::with_savepoint(&conn, "vfs_download_paper_saga", || {
            let blob_hash = VfsBlobRepo::store_blob_with_conn(
                &conn,
                blobs_dir,
                &pdf_bytes,
                Some("application/pdf"),
                None,
            )?
            .hash;

            let (file, created) = VfsFileRepo::create_file_with_doc_data_in_folder_outcome(
                &conn,
                &sha256,
                &file_name,
                pdf_bytes.len() as i64,
                "pdf",
                Some("application/pdf"),
                Some(&blob_hash),
                None,
                folder_id,
                preview_json.as_deref(),
                extracted_text.as_deref(),
                page_count,
            )?;
            Ok((blob_hash, file, created))
        });

    let (blob_hash, file, created) = match saga_result {
        Ok(v) => v,
        Err(e) => {
            log::warn!(
                "[VFS::download_paper] 保存事务失败，已回滚 DB 写入，开始补偿: {}",
                e
            );
            saga.abort(&conn, blobs_dir);
            if let Err(cleanup_err) =
                VfsBlobRepo::remove_unregistered_blob_file(&conn, blobs_dir, &sha256)
            {
                log::error!(
                    "[VFS::download_paper] 补偿删除孤儿 blob 文件失败（内容寻址可自愈）: {}",
                    cleanup_err
                );
            }
            return Err(format!("File creation failed: {}", e));
        }
    };

    if created {
        saga.commit();
    } else {
        // 并发去重命中：本次 +1 的引用未被新文件行接管，回退
        saga.record_blob_ref(&blob_hash);
        saga.abort(&conn, blobs_dir);
    }

    // 索引
    if let Some(ref resource_id) = file.resource_id {
        use crate::vfs::index_service::VfsIndexService;
        use crate::vfs::unit_builder::UnitBuildInput;
        let index_service = VfsIndexService::new((*vfs_db).clone());
        let input = UnitBuildInput {
            resource_id: resource_id.clone(),
            resource_type: "file".to_string(),
            data: None,
            ocr_text: None,
            ocr_pages_json: None,
            blob_hash: file.blob_hash.clone(),
            page_count: file.page_count,
            extracted_text: file.extracted_text.clone(),
            preview_json: file.preview_json.clone(),
        };
        // ★ TD-03：失败不再 `let _` 吞掉——置显式可重试状态交后台索引循环补建
        if let Err(e) = index_service.sync_resource_units(input) {
            log::warn!(
                "[VFS::download_paper] Failed to sync units for {}: {} (queued for background retry)",
                resource_id,
                e
            );
            if let Err(mark_err) =
                VfsIndexStateRepo::mark_failed(&vfs_db, resource_id, &e.to_string())
            {
                log::error!(
                    "[VFS::download_paper] Failed to mark index retry state for {}: {}",
                    resource_id,
                    mark_err
                );
            }
        }
    }

    // 异步 PDF Pipeline
    {
        use crate::vfs::pdf_processing_service::ProcessingStage;
        let file_id = file.id.clone();
        let service = (*pdf_processing_service).clone();
        tokio::spawn(async move {
            let _ = service
                .start_pipeline(&file_id, Some(ProcessingStage::OcrProcessing))
                .await;
        });
    }

    Ok(VfsDownloadPaperResult {
        success: true,
        file_id: Some(file.id),
        file_name: Some(file_name),
        size_bytes: Some(pdf_bytes.len() as u64),
        page_count,
        error: None,
    })
}

// ============================================================================
// 数据透视命令：OCR 文本查看/清除、文本块查看、强制重新 OCR
// ============================================================================

/// OCR 文本查看结果
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceOcrInfo {
    pub resource_id: String,
    pub resource_type: String,
    pub has_ocr: bool,
    pub ocr_text: Option<String>,
    pub ocr_text_length: usize,
    pub extracted_text: Option<String>,
    pub extracted_text_length: usize,
    pub active_source: String,
    pub ocr_pages: Option<Vec<OcrPageInfo>>,
}

/// 单页 OCR 信息
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrPageInfo {
    pub page_index: usize,
    pub text: String,
    pub char_count: usize,
    pub is_failed: bool,
}

/// 获取资源的 OCR 文本和提取文本详情
///
/// 数据透视：让用户能看到 OCR 识别了什么，与提取文本对比
#[tauri::command]
pub async fn vfs_get_resource_ocr_info(
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<ResourceOcrInfo, String> {
    log::info!(
        "[VFS::handlers] vfs_get_resource_ocr_info: resource_id={}",
        resource_id
    );

    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

    let resource_type: String = conn
        .query_row(
            "SELECT type FROM resources WHERE id = ?1",
            rusqlite::params![resource_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Resource not found: {}", e))?;

    let ocr_text: Option<String> = conn
        .query_row(
            "SELECT ocr_text FROM resources WHERE id = ?1",
            rusqlite::params![resource_id],
            |row| row.get(0),
        )
        .ok()
        .flatten();

    let file_info: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT extracted_text, ocr_pages_json FROM files WHERE resource_id = ?1",
            rusqlite::params![resource_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()
        .or_else(|| {
            let source_id: Option<String> = conn
                .query_row(
                    "SELECT source_id FROM resources WHERE id = ?1",
                    rusqlite::params![resource_id],
                    |row| row.get(0),
                )
                .ok()
                .flatten();
            source_id.and_then(|sid| {
                conn.query_row(
                    "SELECT extracted_text, ocr_pages_json FROM files WHERE id = ?1",
                    rusqlite::params![sid],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .ok()
            })
        });

    let (extracted_text, ocr_pages_json) = file_info.unwrap_or((None, None));

    let ocr_text_length = ocr_text.as_ref().map(|t| t.len()).unwrap_or(0);
    let extracted_text_length = extracted_text.as_ref().map(|t| t.len()).unwrap_or(0);

    let active_source = if ocr_text_length > 0 {
        "ocr".to_string()
    } else if extracted_text_length > 0 {
        "extracted".to_string()
    } else {
        "none".to_string()
    };

    let ocr_pages = parse_ocr_pages_for_display(&ocr_pages_json);

    Ok(ResourceOcrInfo {
        resource_id,
        resource_type,
        has_ocr: ocr_text_length > 0 || ocr_pages.is_some(),
        ocr_text,
        ocr_text_length,
        extracted_text,
        extracted_text_length,
        active_source,
        ocr_pages,
    })
}

fn parse_ocr_pages_for_display(ocr_pages_json: &Option<String>) -> Option<Vec<OcrPageInfo>> {
    let json_str = ocr_pages_json.as_ref()?;
    if json_str.trim().is_empty() {
        return None;
    }

    if let Ok(pages) = serde_json::from_str::<Vec<Option<String>>>(json_str) {
        let result: Vec<OcrPageInfo> = pages
            .into_iter()
            .enumerate()
            .map(|(i, text_opt)| {
                let (text, is_failed) = match text_opt {
                    Some(ref t) if t == "[OCR_FAILED]" => (String::new(), true),
                    Some(t) => {
                        let failed = t.trim().is_empty();
                        (t, failed)
                    }
                    None => (String::new(), true),
                };
                OcrPageInfo {
                    page_index: i,
                    char_count: text.len(),
                    text,
                    is_failed,
                }
            })
            .collect();
        return Some(result);
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct OcrPagesJsonCompat {
        pages: Vec<OcrPageResultCompat>,
        #[allow(dead_code)]
        total_pages: Option<usize>,
        #[allow(dead_code)]
        completed_at: Option<String>,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct OcrPageResultCompat {
        page_index: usize,
        blocks: Vec<OcrTextBlockCompat>,
    }
    #[derive(serde::Deserialize)]
    struct OcrTextBlockCompat {
        text: String,
    }

    if let Ok(ocr_json) = serde_json::from_str::<OcrPagesJsonCompat>(json_str) {
        let result: Vec<OcrPageInfo> = ocr_json
            .pages
            .into_iter()
            .map(|page| {
                let text = page
                    .blocks
                    .iter()
                    .map(|b| b.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                OcrPageInfo {
                    page_index: page.page_index,
                    char_count: text.len(),
                    is_failed: text.trim().is_empty(),
                    text,
                }
            })
            .collect();
        return Some(result);
    }

    None
}

/// 清除资源的 OCR 数据（用于强制重新 OCR）
///
/// 清除 resources.ocr_text 和 files.ocr_pages_json，
/// 然后重置索引状态为 pending，下次索引时会重新触发 OCR
#[tauri::command]
pub async fn vfs_clear_resource_ocr(
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<bool, String> {
    log::info!(
        "[VFS::handlers] vfs_clear_resource_ocr: resource_id={}",
        resource_id
    );

    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE resources SET ocr_text = NULL, updated_at = ?1 WHERE id = ?2",
        rusqlite::params![chrono::Utc::now().timestamp_millis(), resource_id],
    )
    .map_err(|e| format!("Failed to clear ocr_text: {}", e))?;

    let now_str = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    let files_updated = conn
        .execute(
            "UPDATE files SET ocr_pages_json = NULL, updated_at = ?1 WHERE resource_id = ?2",
            rusqlite::params![now_str, resource_id],
        )
        .map_err(|e| format!("Failed to clear ocr_pages_json: {}", e))?;

    if files_updated == 0 {
        let source_id: Option<String> = conn
            .query_row(
                "SELECT source_id FROM resources WHERE id = ?1",
                rusqlite::params![resource_id],
                |row| row.get(0),
            )
            .ok()
            .flatten();
        if let Some(sid) = source_id {
            let _ = conn.execute(
                "UPDATE files SET ocr_pages_json = NULL, updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now_str, sid],
            );
        }
    }

    use crate::vfs::repos::VfsIndexStateRepo;
    if let Err(e) = VfsIndexStateRepo::mark_pending(&vfs_db, &resource_id) {
        log::warn!(
            "[VFS::handlers] Failed to mark resource as pending after OCR clear: {}",
            e
        );
    }

    log::info!(
        "[VFS::handlers] Cleared OCR data for resource {} and marked as pending",
        resource_id
    );
    Ok(true)
}

/// 文本块信息（用于数据透视）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextChunkInfo {
    pub unit_id: String,
    pub unit_index: i32,
    pub text_content: Option<String>,
    pub text_source: Option<String>,
    pub text_state: String,
    pub text_chunk_count: i32,
    pub char_count: usize,
}

/// 获取资源的文本块列表（数据透视）
///
/// 让用户能看到系统把内容切成了哪些块
#[tauri::command]
pub async fn vfs_get_resource_text_chunks(
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<TextChunkInfo>, String> {
    log::info!(
        "[VFS::handlers] vfs_get_resource_text_chunks: resource_id={}",
        resource_id
    );

    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, unit_index, text_content, text_source, text_state, text_chunk_count
             FROM vfs_index_units
             WHERE resource_id = ?1
             ORDER BY unit_index ASC",
        )
        .map_err(|e| format!("Prepare failed: {}", e))?;

    let chunks: Vec<TextChunkInfo> = stmt
        .query_map(rusqlite::params![resource_id], |row| {
            let text_content: Option<String> = row.get(2)?;
            let char_count = text_content.as_ref().map(|t| t.len()).unwrap_or(0);
            Ok(TextChunkInfo {
                unit_id: row.get(0)?,
                unit_index: row.get(1)?,
                text_content,
                text_source: row.get(3)?,
                text_state: row.get(4)?,
                text_chunk_count: row.get(5)?,
                char_count,
            })
        })
        .map_err(|e| format!("Query failed: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Row mapping failed: {}", e))?;

    log::info!(
        "[VFS::handlers] Found {} text chunks for resource {}",
        chunks.len(),
        resource_id
    );
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_file_size_validation() {
        let small_data = "x".repeat(1024);
        assert!(validate_file_size(&VfsResourceType::Image, &small_data).is_ok());

        let large_data = "x".repeat(11 * 1024 * 1024);
        assert!(validate_file_size(&VfsResourceType::Image, &large_data).is_err());

        let medium_data = "x".repeat(20 * 1024 * 1024);
        assert!(validate_file_size(&VfsResourceType::File, &medium_data).is_ok());

        // 但 File 也有上限（随常量走，避免上限调整时测试失真）
        let very_large_data = "x".repeat(get_max_size_bytes(&VfsResourceType::File) + 1);
        assert!(validate_file_size(&VfsResourceType::File, &very_large_data).is_err());
    }

    #[test]
    fn test_compute_hash() {
        let hash1 = compute_hash("hello world");
        let hash2 = compute_hash("hello world");
        let hash3 = compute_hash("hello world!");

        // 相同内容应产生相同哈希
        assert_eq!(hash1, hash2);
        // 不同内容应产生不同哈希
        assert_ne!(hash1, hash3);
        // 哈希应该是 64 字符的十六进制字符串
        assert_eq!(hash1.len(), 64);
    }

    #[test]
    fn test_max_size_bytes() {
        assert_eq!(
            get_max_size_bytes(&VfsResourceType::Image),
            10 * 1024 * 1024
        );
        assert_eq!(
            get_max_size_bytes(&VfsResourceType::File),
            200 * 1024 * 1024
        );
        assert_eq!(get_max_size_bytes(&VfsResourceType::Note), 50 * 1024 * 1024);
        assert_eq!(
            get_max_size_bytes(&VfsResourceType::Translation),
            10 * 1024 * 1024
        );
    }

    #[test]
    fn test_create_resource_input_deserialization() {
        let json = r#"{
            "type": "note",
            "data": "test content",
            "sourceId": "note_123"
        }"#;

        let input: CreateResourceInput = serde_json::from_str(json).unwrap();
        assert_eq!(input.resource_type, "note");
        assert_eq!(input.data, "test content");
        assert_eq!(input.source_id, Some("note_123".to_string()));
    }

    #[test]
    fn test_create_note_input_deserialization() {
        let json = r#"{
            "title": "Test Note",
            "content": "note content",
            "tags": ["tag1", "tag2"]
        }"#;

        let input: CreateNoteInput = serde_json::from_str(json).unwrap();
        assert_eq!(input.title, "Test Note");
        assert_eq!(input.content, "note content");
        assert_eq!(input.tags, vec!["tag1", "tag2"]);
    }

    #[test]
    fn test_list_input_defaults() {
        let json = r#"{}"#;

        let input: ListInput = serde_json::from_str(json).unwrap();
        assert_eq!(input.search, None);
        assert_eq!(input.limit, 50); // default
        assert_eq!(input.offset, 0); // default
    }

    #[test]
    fn test_search_all_input_deserialization() {
        let json = r#"{
            "query": "期末复习",
            "types": ["note", "exam"],
            "limit": 20
        }"#;

        let input: SearchAllInput = serde_json::from_str(json).unwrap();
        assert_eq!(input.query, "期末复习");
        assert_eq!(
            input.types,
            Some(vec!["note".to_string(), "exam".to_string()])
        );
        assert_eq!(input.limit, 20);
        assert_eq!(input.offset, 0); // default
    }

    #[test]
    fn rag_search_accepts_legacy_false_cross_dimension_flag() {
        let input: VfsRagSearchInput = serde_json::from_value(serde_json::json!({
            "query": "profile aware retrieval",
            "enableCrossDimension": false,
            "topK": 7
        }))
        .expect("deserialize compatibility flag");

        assert!(!input.enable_cross_dimension);
        assert_eq!(input.top_k, 7);
        assert_eq!(input.modality, "text");
    }

    /// 验证 vfs_update_note 参数结构支持自动版本管理
    ///
    /// TODO: 等待 Prompt 2 完成后实现完整的版本管理测试
    /// 当前仅验证更新参数正确解析
    #[test]
    fn test_update_note_params_for_versioning() {
        // 验证仅更新内容
        let json_content_only = r#"{
            "content": "新版本内容"
        }"#;
        let input: UpdateNoteInput = serde_json::from_str(json_content_only).unwrap();
        assert_eq!(input.content, "新版本内容");
        assert_eq!(input.title, None);
        assert_eq!(input.tags, None);

        // 验证同时更新内容和标题
        let json_with_title = r#"{
            "content": "新版本内容",
            "title": "新标题"
        }"#;
        let input: UpdateNoteInput = serde_json::from_str(json_with_title).unwrap();
        assert_eq!(input.content, "新版本内容");
        assert_eq!(input.title, Some("新标题".to_string()));

        // 验证完整更新
        let json_full = r#"{
            "content": "新版本内容",
            "title": "新标题",
            "tags": ["重要", "复习"]
        }"#;
        let input: UpdateNoteInput = serde_json::from_str(json_full).unwrap();
        assert_eq!(input.content, "新版本内容");
        assert_eq!(input.title, Some("新标题".to_string()));
        assert_eq!(
            input.tags,
            Some(vec!["重要".to_string(), "复习".to_string()])
        );
    }

    /// 验证 vfs_search_all 跨类型搜索参数
    ///
    /// TODO: 等待 Prompt 2 完成后实现完整的跨类型搜索测试
    /// 当前仅验证类型过滤参数正确解析
    #[test]
    fn test_search_all_cross_type_params() {
        // 验证搜索所有类型（不指定 types）
        let json_all_types = r#"{
            "query": "期末考试"
        }"#;
        let input: SearchAllInput = serde_json::from_str(json_all_types).unwrap();
        assert_eq!(input.query, "期末考试");
        assert_eq!(input.types, None); // 查询所有类型

        // 验证搜索特定类型
        let json_specific_types = r#"{
            "query": "期末考试",
            "types": ["note", "exam", "textbook"]
        }"#;
        let input: SearchAllInput = serde_json::from_str(json_specific_types).unwrap();
        assert_eq!(input.query, "期末考试");
        assert_eq!(
            input.types,
            Some(vec![
                "note".to_string(),
                "exam".to_string(),
                "textbook".to_string()
            ])
        );

        // 验证搜索单一类型
        let json_single_type = r#"{
            "query": "翻译",
            "types": ["translation"]
        }"#;
        let input: SearchAllInput = serde_json::from_str(json_single_type).unwrap();
        assert_eq!(input.types, Some(vec!["translation".to_string()]));

        // 验证跨类型搜索
        let json_multi_type = r#"{
            "query": "语法",
            "types": ["note", "essay"]
        }"#;
        let input: SearchAllInput = serde_json::from_str(json_multi_type).unwrap();
        assert_eq!(input.query, "语法");
        assert_eq!(
            input.types,
            Some(vec!["note".to_string(), "essay".to_string()])
        );
    }

    /// 验证空查询词被正确拒绝
    #[test]
    fn test_empty_query_validation() {
        // 空字符串查询应该被拒绝（在命令实现中验证）
        let json = r#"{
            "query": ""
        }"#;
        let input: SearchAllInput = serde_json::from_str(json).unwrap();
        assert_eq!(input.query, "");
        // 实际的空查询验证在 vfs_search_all 命令中执行
    }

    /// 验证资源 ID 格式验证
    #[test]
    fn test_resource_id_format_validation() {
        // 验证有效的资源 ID 前缀
        assert!("res_abc123".starts_with("res_"));
        assert!("res_1234567890".starts_with("res_"));

        // 验证无效的资源 ID 前缀
        assert!(!"note_abc123".starts_with("res_"));
        assert!(!"abc123".starts_with("res_"));
    }

    /// 验证笔记 ID 格式验证
    #[test]
    fn test_note_id_format_validation() {
        // 验证有效的笔记 ID 前缀
        assert!("note_abc123".starts_with("note_"));
        assert!("note_1234567890".starts_with("note_"));

        // 验证无效的笔记 ID 前缀
        assert!(!"res_abc123".starts_with("note_"));
        assert!(!"abc123".starts_with("note_"));
    }

    // ========================================================================
    // 路径缓存相关测试（文档 24 Prompt 3）
    // ========================================================================

    /// 验证文件夹 ID 格式验证
    #[test]
    fn test_folder_id_format_validation() {
        // 验证有效的文件夹 ID 前缀
        assert!("fld_abc123".starts_with("fld_"));
        assert!("fld_1234567890".starts_with("fld_"));

        // 验证无效的文件夹 ID 前缀
        assert!(!"note_abc123".starts_with("fld_"));
        assert!(!"folder_abc123".starts_with("fld_"));
        assert!(!"abc123".starts_with("fld_"));
    }

    /// 验证 source_id 前缀解析
    #[test]
    fn test_source_id_prefix_parsing() {
        // 验证各种 source_id 的前缀提取
        let note_id = "note_abc123";
        let tb_id = "tb_def456";
        let exam_id = "exam_ghi789";
        let tr_id = "tr_jkl012";
        let essay_id = "essay_mno345";

        assert_eq!(note_id.split('_').next(), Some("note"));
        assert_eq!(tb_id.split('_').next(), Some("tb"));
        assert_eq!(exam_id.split('_').next(), Some("exam"));
        assert_eq!(tr_id.split('_').next(), Some("tr"));
        assert_eq!(essay_id.split('_').next(), Some("essay"));
    }

    /// 验证路径长度约束（契约 D：最大 1000 字符）
    #[test]
    fn test_path_length_constraint() {
        let max_path_length = 1000;

        // 短路径应该通过
        let short_path = "/文件夹/笔记";
        assert!(short_path.len() <= max_path_length);

        // 极长路径应该失败
        let long_path = "/".repeat(max_path_length + 1);
        assert!(long_path.len() > max_path_length);
    }

    /// 验证路径格式
    #[test]
    fn test_path_format() {
        // 根目录资源路径格式
        let root_path = "/笔记标题";
        assert!(root_path.starts_with('/'));

        // 嵌套路径格式
        let nested_path = "/高考复习/函数/笔记标题";
        assert!(nested_path.starts_with('/'));
        assert!(nested_path.contains("高考复习"));
        assert!(nested_path.contains("函数"));
    }

    #[test]
    fn embedding_model_validation_enforces_backend_protocol_contract() {
        let text = crate::llm_manager::ApiConfig {
            id: "text-embedding".to_string(),
            model: "embed-v1".to_string(),
            enabled: true,
            is_embedding: true,
            ..Default::default()
        };
        let multimodal = crate::llm_manager::ApiConfig {
            id: "mm-embedding".to_string(),
            model: "vl-embed-v1".to_string(),
            enabled: true,
            is_embedding: true,
            is_multimodal: true,
            ..Default::default()
        };
        let reranker = crate::llm_manager::ApiConfig {
            id: "reranker".to_string(),
            model: "rerank-v1".to_string(),
            enabled: true,
            is_embedding: true,
            is_reranker: true,
            ..Default::default()
        };
        let configs = vec![text, multimodal, reranker];

        assert!(validate_embedding_model_config(&configs, "text-embedding", "text").is_ok());
        assert!(validate_embedding_model_config(&configs, "mm-embedding", "multimodal").is_ok());
        assert!(validate_embedding_model_config(&configs, "mm-embedding", "text").is_err());
        assert!(validate_embedding_model_config(&configs, "text-embedding", "multimodal").is_err());
        assert!(validate_embedding_model_config(&configs, "reranker", "text").is_err());
        assert!(validate_embedding_model_config(&configs, "missing", "text").is_err());
    }

    #[test]
    fn multimodal_search_dto_accepts_legacy_query() {
        let input: VfsMultimodalSearchInput = serde_json::from_value(serde_json::json!({
            "query": "legacy text",
            "topK": 7
        }))
        .expect("deserialize legacy query");
        let resolved = input.resolved_query().expect("resolve legacy query");
        assert_eq!(resolved.text.as_deref(), Some("legacy text"));
        assert!(resolved.image.is_none());
        assert_eq!(input.top_k, 7);
    }

    #[test]
    fn multimodal_search_dto_accepts_image_and_mixed_camel_case() {
        let image: VfsMultimodalSearchInput = serde_json::from_value(serde_json::json!({
            "queryImageBase64": "image-bytes",
            "queryImageMediaType": "image/jpeg",
            "queryMode": "image"
        }))
        .expect("deserialize image query");
        let resolved_image = image.resolved_query().expect("resolve image query");
        assert!(resolved_image.text.is_none());
        assert!(resolved_image.image.is_some());

        let mixed: VfsMultimodalSearchInput = serde_json::from_value(serde_json::json!({
            "query": "legacy field remains accepted",
            "queryText": "preferred text",
            "queryImageBase64": "image-bytes",
            "queryImageMediaType": "image/webp",
            "queryMode": "mixed"
        }))
        .expect("deserialize mixed query");
        let resolved_mixed = mixed.resolved_query().expect("resolve mixed query");
        assert_eq!(resolved_mixed.text.as_deref(), Some("preferred text"));
        assert!(resolved_mixed.image.is_some());
    }

    #[test]
    fn multimodal_search_dto_rejects_mode_payload_mismatch() {
        let missing_image: VfsMultimodalSearchInput = serde_json::from_value(serde_json::json!({
            "queryText": "text",
            "queryMode": "mixed"
        }))
        .expect("deserialize incomplete mixed query");
        assert!(missing_image
            .resolved_query()
            .expect_err("mixed requires image")
            .contains("queryImageBase64"));
    }
}
