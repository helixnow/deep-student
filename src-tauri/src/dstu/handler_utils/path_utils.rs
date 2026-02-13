//! 路径工具函数
//!
//! 提供 DSTU 路径解析和资源类型推断功能

use super::super::error::DstuError;
use super::super::path_parser::parse_real_path;

/// 从简化路径中提取 ID
///
/// 支持格式：
/// - `/{id}` 如 `/note_abc123`
/// - `{id}` 如 `note_abc123`
/// - 纯 UUID 格式（文件夹）如 `b11cf4a3-9ef0-4580-8fca-f9f8d09dffbf`
///
/// 通过检查路径段数量和 ID 前缀来判断是否是简化路径
pub fn extract_simple_id(path: &str) -> Option<String> {
    let trimmed = path.trim().trim_start_matches('/');

    // 简化路径应该只有一个段且包含已知的 ID 前缀
    if trimmed.contains('/') {
        return None; // 多段路径，不是简化格式
    }

    // 检查是否有已知的 ID 前缀
    // ★ 2026-01-22: 添加 res_ 前缀支持（VFS 资源 ID）
    // ★ 2026-01-24: 添加 file_ 前缀支持（统一文件存储）
    let known_prefixes = [
        "note_",
        "tb_",
        "file_",
        "tr_",
        "exam_",
        "essay_session_",
        "essay_",
        "att_",
        "fld_",
        "mm_",
        "res_",
    ];
    for prefix in known_prefixes.iter() {
        if trimmed.starts_with(prefix) {
            return Some(trimmed.to_string());
        }
    }

    // 检查是否是纯 UUID 格式（文件夹）
    if is_uuid_format(trimmed) {
        return Some(trimmed.to_string());
    }

    None
}

/// 检查是否是 UUID 格式
///
/// 公开导出以供 handlers.rs 中的 UUID 回退查找使用
pub fn is_uuid_format(s: &str) -> bool {
    // UUID 格式：xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (36字符)
    if s.len() != 36 {
        return false;
    }
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 5 {
        return false;
    }
    // 检查每个部分的长度
    if parts[0].len() != 8
        || parts[1].len() != 4
        || parts[2].len() != 4
        || parts[3].len() != 4
        || parts[4].len() != 12
    {
        return false;
    }
    // 检查是否都是十六进制字符
    s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// 根据 ID 前缀推断资源类型
///
/// ## ID 前缀映射
/// - `note_` → notes
/// - `file_` / `tb_` / `att_` → files（统一文件存储）
/// - `tr_` → translations
/// - `exam_` → exams
/// - `essay_` / `essay_session_` → essays
/// - `fld_` → folders
/// - 纯 UUID 格式 → folders（文件夹使用 UUID 作为 ID）
pub fn infer_resource_type_from_id(id: &str) -> &'static str {
    if id.starts_with("note_") {
        "notes"
    } else if id.starts_with("file_") || id.starts_with("tb_") || id.starts_with("att_") {
        "files"
    } else if id.starts_with("tr_") {
        "translations"
    } else if id.starts_with("exam_") {
        "exams"
    } else if id.starts_with("essay_session_") || id.starts_with("essay_") {
        "essays"
    } else if id.starts_with("fld_") || is_uuid_format(id) {
        "folders"
    } else if id.starts_with("mm_") {
        "mindmaps"
    } else if id.starts_with("res_") {
        "resources"
    } else {
        "unknown"
    }
}

/// 统一路径解析：从任意路径格式提取 (resource_type, resource_id)
///
/// 支持的格式：
/// - 简化 ID: `note_abc123` 或 `/note_abc123`
/// - 新格式路径: `/{folder_path}/{resource_id}` 如 `/高考复习/note_abc123`
///
/// 返回 (resource_type, resource_id)，其中 resource_type 使用复数形式 (notes, textbooks 等)
pub fn extract_resource_info(path: &str) -> Result<(String, String), DstuError> {
    // 尝试简化 ID 格式
    if let Some(id) = extract_simple_id(path) {
        let resource_type = infer_resource_type_from_id(&id);
        if resource_type == "unknown" {
            return Err(DstuError::invalid_path(format!(
                "Cannot infer resource type from ID: {}",
                id
            )));
        }
        return Ok((resource_type.to_string(), id));
    }

    // 使用新格式路径解析
    let parsed = parse_real_path(path)?;

    // 必须有资源 ID
    let resource_id = parsed.resource_id.ok_or_else(|| {
        DstuError::invalid_path(format!("Path must contain a resource ID: {}", path))
    })?;

    // 从 ID 推断类型（使用复数形式）
    let resource_type = infer_resource_type_from_id(&resource_id);
    if resource_type == "unknown" {
        return Err(DstuError::invalid_path(format!(
            "Cannot infer resource type from ID: {}",
            resource_id
        )));
    }

    Ok((resource_type.to_string(), resource_id))
}
