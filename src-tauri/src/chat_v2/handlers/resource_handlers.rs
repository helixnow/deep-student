//! ⚠️ DEPRECATED: 前端已迁移到 VFS 统一资源管理（vfs_* 命令）。
//! 此模块中的 resource_* Tauri 命令不再被前端调用。
//! 计划在下一次大版本中移除。参见 P1-#9 审计发现。
//!
//! ---
//!
//! 资源库 Tauri 命令处理器
//!
//! 提供资源库（ResourceStore）的 Tauri 命令，供前端调用。
//! 资源库用于统一存储所有上下文内容（图片、附件、笔记快照、题目快照等），
//! 基于内容哈希自动去重和版本管理。
//!
//! ## 命令命名约定
//! 所有命令以 `resource_` 前缀命名。
//!
//! ## 大文件限制
//! - 图片：< 10MB
//! - 文件：< 50MB

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::error::ChatV2Error;
use crate::chat_v2::resource_repo::ResourceRepo;
use crate::chat_v2::resource_types::{
    CreateResourceParams, CreateResourceResult, Resource, ResourceMetadata, ResourceType,
};
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{VfsEssayRepo, VfsExamRepo, VfsNoteRepo, VfsTextbookRepo};

// ============================================================================
// 前端参数类型（接收前端的 JSON 输入）
// ============================================================================

/// 前端传入的创建资源参数
///
/// 注意：前端传入的 `type` 是字符串，需要转换为 `ResourceType`
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateResourceInput {
    /// 资源类型（字符串）
    #[serde(rename = "type")]
    pub resource_type: String,

    /// 实际内容（文本或 Base64 编码）
    pub data: String,

    /// 原始数据 ID（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,

    /// 元数据（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ResourceMetadata>,
}

// ============================================================================
// 工具函数
// ============================================================================

/// 获取资源类型的大文件限制（字节）
fn get_max_size_bytes(resource_type: &ResourceType) -> usize {
    match resource_type {
        ResourceType::Image => 10 * 1024 * 1024,       // 10MB
        ResourceType::File => 50 * 1024 * 1024,        // 50MB
        ResourceType::Note => 50 * 1024 * 1024,        // 50MB（笔记可能很长）
        ResourceType::Card => 10 * 1024 * 1024,        // 10MB
        ResourceType::Retrieval => 10 * 1024 * 1024,   // 10MB
        ResourceType::Exam => 50 * 1024 * 1024,        // 50MB（题目集识别结果）
        ResourceType::Textbook => 50 * 1024 * 1024,    // 50MB（教材页面）
        ResourceType::Essay => 50 * 1024 * 1024,       // 50MB（作文批改）
        ResourceType::Translation => 50 * 1024 * 1024, // 50MB（翻译）
        ResourceType::Folder => 50 * 1024 * 1024,      // 50MB（文件夹引用列表）
    }
}

/// 验证大文件限制
fn validate_file_size(resource_type: &ResourceType, data: &str) -> Result<(), ChatV2Error> {
    let size = data.len();
    let max_size = get_max_size_bytes(resource_type);

    if size > max_size {
        let max_mb = max_size / (1024 * 1024);
        let actual_mb = size as f64 / (1024.0 * 1024.0);
        return Err(ChatV2Error::Validation(format!(
            "File too large: {} type max {}MB, got {:.2}MB",
            resource_type, max_mb, actual_mb
        )));
    }

    Ok(())
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// 创建或复用资源
///
/// 基于内容哈希自动去重：
/// - 如果相同哈希的资源已存在，返回已有资源的 ID
/// - 如果不存在，创建新资源
///
/// ## 参数
/// - `params`: 创建资源的参数
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(CreateResourceResult)`: 资源 ID、哈希和是否新创建
/// - `Err(String)`: 验证失败或数据库错误
///
/// ## 大文件限制
/// - 图片：< 10MB
/// - 文件：< 50MB
#[deprecated(note = "前端已迁移到 VFS (vfs_create_or_reuse)。参见 P1-#9。")]
#[tauri::command]
pub async fn resource_create_or_reuse(
    params: CreateResourceInput,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<CreateResourceResult, String> {
    log::info!(
        "[Resource::handlers] resource_create_or_reuse: type={}, data_len={}, source_id={:?}",
        params.resource_type,
        params.data.len(),
        params.source_id
    );

    // 解析资源类型
    let resource_type = ResourceType::from_str(&params.resource_type).ok_or_else(|| {
        ChatV2Error::Validation(format!("Invalid resource type: {}", params.resource_type))
            .to_string()
    })?;

    // 验证大文件限制
    validate_file_size(&resource_type, &params.data).map_err(|e| e.to_string())?;

    // 构建 CreateResourceParams
    let create_params = CreateResourceParams {
        resource_type,
        data: params.data,
        source_id: params.source_id,
        metadata: params.metadata,
    };

    // 调用 ResourceRepo 创建或复用资源
    let result = ResourceRepo::create_or_reuse(&db, create_params).map_err(|e| e.to_string())?;

    log::info!(
        "[Resource::handlers] Resource {}: id={}, hash={}, is_new={}",
        if result.is_new { "created" } else { "reused" },
        result.resource_id,
        &result.hash[..16],
        result.is_new
    );

    Ok(result)
}

/// 获取资源（精确版本）
///
/// 通过 resourceId + hash 精确定位特定版本的资源。
///
/// ## 参数
/// - `resource_id`: 资源 ID
/// - `hash`: 内容哈希
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(Some(Resource))`: 找到资源
/// - `Ok(None)`: 资源不存在
/// - `Err(String)`: 数据库错误
#[deprecated(note = "前端已迁移到 VFS (vfs_get_resource)。参见 P1-#9。")]
#[tauri::command]
pub async fn resource_get(
    resource_id: String,
    hash: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<Option<Resource>, String> {
    log::debug!(
        "[Resource::handlers] resource_get: id={}, hash={}",
        resource_id,
        hash
    );

    // 验证资源 ID 格式
    if !resource_id.starts_with("res_") {
        return Err(ChatV2Error::Validation(format!(
            "Invalid resource ID format: {}",
            resource_id
        ))
        .to_string());
    }

    ResourceRepo::get_resource(&db, &resource_id, &hash).map_err(|e| e.to_string())
}

/// 获取资源的最新版本
///
/// 当精确版本不存在时，可以尝试获取该资源的最新版本。
///
/// ## 参数
/// - `resource_id`: 资源 ID
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(Some(Resource))`: 找到资源
/// - `Ok(None)`: 资源不存在
/// - `Err(String)`: 数据库错误
#[deprecated(note = "前端已迁移到 VFS (vfs_get_resource)。参见 P1-#9。")]
#[tauri::command]
pub async fn resource_get_latest(
    resource_id: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<Option<Resource>, String> {
    log::debug!(
        "[Resource::handlers] resource_get_latest: id={}",
        resource_id
    );

    // 验证资源 ID 格式
    if !resource_id.starts_with("res_") {
        return Err(ChatV2Error::Validation(format!(
            "Invalid resource ID format: {}",
            resource_id
        ))
        .to_string());
    }

    ResourceRepo::get_latest_resource(&db, &resource_id).map_err(|e| e.to_string())
}

/// 检查资源是否存在
///
/// ## 参数
/// - `resource_id`: 资源 ID
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(true)`: 资源存在
/// - `Ok(false)`: 资源不存在
/// - `Err(String)`: 数据库错误
#[deprecated(note = "前端已迁移到 VFS (vfs_resource_exists)。参见 P1-#9。")]
#[tauri::command]
pub async fn resource_exists(
    resource_id: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<bool, String> {
    log::debug!("[Resource::handlers] resource_exists: id={}", resource_id);

    // 验证资源 ID 格式（与其他 handler 保持一致，非法 ID 返回错误而非 false）
    if !resource_id.starts_with("res_") {
        return Err(ChatV2Error::Validation(format!(
            "Invalid resource ID format: {}",
            resource_id
        ))
        .to_string());
    }

    ResourceRepo::resource_exists(&db, &resource_id).map_err(|e| e.to_string())
}

/// 增加资源引用计数
///
/// 消息保存时调用，表示该资源被消息引用。
///
/// ## 参数
/// - `resource_id`: 资源 ID
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(())`: 成功
/// - `Err(String)`: 资源不存在或数据库错误
#[deprecated(note = "前端已迁移到 VFS (vfs_increment_ref)。参见 P1-#9。")]
#[tauri::command]
pub async fn resource_increment_ref(
    resource_id: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<(), String> {
    log::info!(
        "[Resource::handlers] resource_increment_ref: id={}",
        resource_id
    );

    // 验证资源 ID 格式
    if !resource_id.starts_with("res_") {
        return Err(ChatV2Error::Validation(format!(
            "Invalid resource ID format: {}",
            resource_id
        ))
        .to_string());
    }

    ResourceRepo::increment_ref(&db, &resource_id).map_err(|e| e.to_string())
}

/// 减少资源引用计数
///
/// 消息删除时调用，表示该资源不再被消息引用。
/// 引用计数最小为 0。
///
/// ## 参数
/// - `resource_id`: 资源 ID
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(())`: 成功
/// - `Err(String)`: 资源不存在或数据库错误
#[deprecated(note = "前端已迁移到 VFS (vfs_decrement_ref)。参见 P1-#9。")]
#[tauri::command]
pub async fn resource_decrement_ref(
    resource_id: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<(), String> {
    log::info!(
        "[Resource::handlers] resource_decrement_ref: id={}",
        resource_id
    );

    // 验证资源 ID 格式
    if !resource_id.starts_with("res_") {
        return Err(ChatV2Error::Validation(format!(
            "Invalid resource ID format: {}",
            resource_id
        ))
        .to_string());
    }

    ResourceRepo::decrement_ref(&db, &resource_id).map_err(|e| e.to_string())
}

/// 获取某原始数据的所有版本
///
/// 通过 sourceId（如 noteId、cardId）获取该原始数据的所有版本。
/// 按创建时间降序排列（最新版本在前）。
///
/// ## 参数
/// - `source_id`: 原始数据 ID
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(Vec<Resource>)`: 所有版本列表
/// - `Err(String)`: 数据库错误
#[deprecated(note = "前端已迁移到 VFS。参见 P1-#9。")]
#[tauri::command]
pub async fn resource_get_versions_by_source(
    source_id: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<Vec<Resource>, String> {
    log::debug!(
        "[Resource::handlers] resource_get_versions_by_source: source_id={}",
        source_id
    );

    ResourceRepo::get_versions_by_source(&db, &source_id).map_err(|e| e.to_string())
}

// ============================================================================
// VFS 资源内容获取
// ============================================================================

/// VFS 资源内容获取结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsResourceContent {
    /// 内容类型（text/binary）
    pub content_type: String,
    /// 内容数据（文本或 base64）
    pub data: String,
    /// 元数据（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// 从 VFS 获取资源内容
///
/// 根据 resourceType 路由到对应的 VFS Repo：
/// - `note` → VfsNoteRepo::get_note_content()
/// - `textbook` → VfsTextbookRepo::get_textbook() + Blob（教材为 PDF，返回元数据）
/// - `exam` → VfsExamRepo::get_exam_sheet_content()
/// - `essay` → VfsEssayRepo::get_essay_content()
///
/// ## 参数
/// - `resource_type`: 资源类型（note/textbook/exam/essay）
/// - `source_id`: 原始数据 ID（noteId, textbookId, examId, essayId）
/// - `vfs_db`: VFS 数据库
///
/// ## 返回
/// - `Ok(VfsResourceContent)`: 资源内容
/// - `Err(String)`: 资源不存在或数据库错误
#[deprecated(note = "前端已迁移到 VFS (vfs_* 命令)。参见 P1-#9。")]
#[tauri::command]
pub async fn resource_get_content_from_vfs(
    resource_type: String,
    source_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<VfsResourceContent, String> {
    log::info!(
        "[Resource::handlers] resource_get_content_from_vfs: type={}, source_id={}",
        resource_type,
        source_id
    );

    match resource_type.to_lowercase().as_str() {
        "note" => get_note_content_from_vfs(&vfs_db, &source_id).await,
        "textbook" => get_textbook_content_from_vfs(&vfs_db, &source_id).await,
        "exam" => get_exam_content_from_vfs(&vfs_db, &source_id).await,
        "essay" => get_essay_content_from_vfs(&vfs_db, &source_id).await,
        _ => Err(format!(
            "Unsupported resource type for VFS: {}",
            resource_type
        )),
    }
}

/// 从 VFS 获取笔记内容
async fn get_note_content_from_vfs(
    vfs_db: &VfsDatabase,
    note_id: &str,
) -> Result<VfsResourceContent, String> {
    // 获取笔记元数据
    let note = VfsNoteRepo::get_note(vfs_db, note_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Note not found: {}", note_id))?;

    // 获取笔记内容
    let content = VfsNoteRepo::get_note_content(vfs_db, note_id)
        .map_err(|e| e.to_string())?
        .unwrap_or_default();

    // 构建元数据
    let metadata = serde_json::json!({
        "title": note.title,
        "tags": note.tags,
        "updatedAt": note.updated_at,
    });

    log::debug!(
        "[Resource::handlers] get_note_content_from_vfs: note_id={}, content_len={}",
        note_id,
        content.len()
    );

    Ok(VfsResourceContent {
        content_type: "text".to_string(),
        data: content,
        metadata: Some(metadata),
    })
}

/// 从 VFS 获取教材内容（教材为 PDF，返回元数据信息）
async fn get_textbook_content_from_vfs(
    vfs_db: &VfsDatabase,
    textbook_id: &str,
) -> Result<VfsResourceContent, String> {
    // 获取教材元数据
    let textbook = VfsTextbookRepo::get_textbook(vfs_db, textbook_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Textbook not found: {}", textbook_id))?;

    // 教材是 PDF 文件，内容存储在 blobs 表中
    // 这里返回教材的元数据信息，前端可用于展示
    // 如需实际 PDF 内容，需要通过 blob_hash 从 blobs 表获取
    let metadata = serde_json::json!({
        "fileName": textbook.file_name,
        "size": textbook.size,
        "pageCount": textbook.page_count,
        "blobHash": textbook.blob_hash,
        "sha256": textbook.sha256,
        "lastPage": textbook.last_page,
        "updatedAt": textbook.updated_at,
    });

    // 构建一个摘要文本用于上下文注入
    let summary = format!(
        "教材: {}\n页数: {}\n文件大小: {} 字节",
        textbook.file_name,
        textbook
            .page_count
            .map(|p| p.to_string())
            .unwrap_or("未知".to_string()),
        textbook.size
    );

    log::debug!(
        "[Resource::handlers] get_textbook_content_from_vfs: textbook_id={}, file_name={}",
        textbook_id,
        textbook.file_name
    );

    Ok(VfsResourceContent {
        content_type: "text".to_string(),
        data: summary,
        metadata: Some(metadata),
    })
}

/// 从 VFS 获取题目集识别内容
async fn get_exam_content_from_vfs(
    vfs_db: &VfsDatabase,
    exam_id: &str,
) -> Result<VfsResourceContent, String> {
    // 获取题目集元数据
    let exam = VfsExamRepo::get_exam_sheet(vfs_db, exam_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Exam sheet not found: {}", exam_id))?;

    // 获取题目集内容（从 resources.data）
    let content = VfsExamRepo::get_exam_sheet_content(vfs_db, exam_id)
        .map_err(|e| e.to_string())?
        .unwrap_or_default();

    // 构建元数据
    let metadata = serde_json::json!({
        "examName": exam.exam_name,
        "status": exam.status,
        "tempId": exam.temp_id,
        "updatedAt": exam.updated_at,
    });

    log::debug!(
        "[Resource::handlers] get_exam_content_from_vfs: exam_id={}, content_len={}",
        exam_id,
        content.len()
    );

    Ok(VfsResourceContent {
        content_type: "text".to_string(),
        data: content,
        metadata: Some(metadata),
    })
}

/// 从 VFS 获取作文内容
async fn get_essay_content_from_vfs(
    vfs_db: &VfsDatabase,
    essay_id: &str,
) -> Result<VfsResourceContent, String> {
    // 获取作文元数据
    let essay = VfsEssayRepo::get_essay(vfs_db, essay_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Essay not found: {}", essay_id))?;

    // 获取作文内容（从 resources.data）
    let content = VfsEssayRepo::get_essay_content(vfs_db, essay_id)
        .map_err(|e| e.to_string())?
        .unwrap_or_default();

    // 构建元数据
    let metadata = serde_json::json!({
        "title": essay.title,
        "essayType": essay.essay_type,
        "score": essay.score,
        "gradeLevel": essay.grade_level,
        "roundNumber": essay.round_number,
        "updatedAt": essay.updated_at,
    });

    log::debug!(
        "[Resource::handlers] get_essay_content_from_vfs: essay_id={}, content_len={}",
        essay_id,
        content.len()
    );

    Ok(VfsResourceContent {
        content_type: "text".to_string(),
        data: content,
        metadata: Some(metadata),
    })
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_file_size_validation() {
        // 小文件应该通过
        let small_data = "x".repeat(1024); // 1KB
        assert!(validate_file_size(&ResourceType::Image, &small_data).is_ok());

        // 大文件应该失败
        let large_data = "x".repeat(11 * 1024 * 1024); // 11MB
        assert!(validate_file_size(&ResourceType::Image, &large_data).is_err());

        // File 类型允许更大的文件
        let medium_data = "x".repeat(20 * 1024 * 1024); // 20MB
        assert!(validate_file_size(&ResourceType::File, &medium_data).is_ok());

        // 但 File 也有上限
        let very_large_data = "x".repeat(51 * 1024 * 1024); // 51MB
        assert!(validate_file_size(&ResourceType::File, &very_large_data).is_err());
    }

    #[test]
    fn test_max_size_bytes() {
        assert_eq!(get_max_size_bytes(&ResourceType::Image), 10 * 1024 * 1024);
        assert_eq!(get_max_size_bytes(&ResourceType::File), 50 * 1024 * 1024);
        assert_eq!(get_max_size_bytes(&ResourceType::Note), 50 * 1024 * 1024);
        assert_eq!(get_max_size_bytes(&ResourceType::Card), 10 * 1024 * 1024);
        assert_eq!(
            get_max_size_bytes(&ResourceType::Retrieval),
            10 * 1024 * 1024
        );
        assert_eq!(get_max_size_bytes(&ResourceType::Exam), 50 * 1024 * 1024);
        assert_eq!(
            get_max_size_bytes(&ResourceType::Textbook),
            50 * 1024 * 1024
        );
        assert_eq!(get_max_size_bytes(&ResourceType::Essay), 50 * 1024 * 1024);
        assert_eq!(
            get_max_size_bytes(&ResourceType::Translation),
            50 * 1024 * 1024
        );
        assert_eq!(get_max_size_bytes(&ResourceType::Folder), 50 * 1024 * 1024);
    }
}
