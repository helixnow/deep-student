//! DSTU 路径解析器（文档 28 - Prompt 2 重构）
//!
//! 本模块负责解析 DSTU 真实文件夹路径为结构化数据。
//!
//! ## 路径格式
//! ```text
//! /{folder_path}/{resource_id}
//!
//! 示例：
//! - /高考复习/函数/note_abc123    ← 在“高考复习/函数”文件夹下的笔记
//! - /我的教材/tb_xyz789           ← 在“我的教材”文件夹下的教材
//! - /exam_sheet_001               ← 根目录下的题目集（无文件夹）
//! - /                             ← 根目录
//! - /@trash                       ← 回收站（虚拟路径）
//! - /@recent                      ← 最近使用（虚拟路径）
//! ```
//!
//! ## 资源 ID 前缀规范
//! - `note_xxx` → 笔记
//! - `tb_xxx` → 教材
//! - `exam_xxx` → 题目集
//! - `tr_xxx` → 翻译
//! - `essay_xxx` → 作文
//! - `fld_xxx` → 文件夹
//! - `att_xxx` → 附件

use super::error::{DstuError, DstuResult};
use super::path_types::{
    get_resource_type_from_id, is_virtual_path_type, ParsedPath as NewParsedPath,
    MAX_RESOURCE_ID_LENGTH,
};

// 重导出类型供外部使用
pub use super::path_types::is_valid_resource_id;

pub use super::path_types::{
    get_resource_type_from_id as get_resource_type, ParsedPath as RealParsedPath,
    RESOURCE_ID_PREFIXES, VIRTUAL_PATH_TYPES,
};

// ============================================================================
// 新路径解析 API（契约 B/C1 实现）
// ============================================================================

/// 解析真实文件夹路径（新 API）
///
/// 支持新格式和旧格式路径的解析。
///
/// # 新格式路径
/// ```text
/// /{folder_path}/{resource_id}
/// 示例：/高考复习/函数/note_abc123
/// ```
///
/// # 旧格式路径（向后兼容）
/// ```text
/// /{subject}/{type}/{id}
/// 示例：/数学/notes/note_123
/// ```
///
/// # 虚拟路径
/// ```text
/// /@trash, /@recent, /@favorites
/// ```
pub fn parse_real_path(path: &str) -> DstuResult<NewParsedPath> {
    // 处理空路径
    if path.is_empty() {
        return Ok(NewParsedPath::root());
    }

    // 规范化路径
    let normalized = normalize_path(path);

    // 根路径
    if normalized == "/" {
        return Ok(NewParsedPath::root());
    }

    // 检查虚拟路径（以 /@ 开头）
    if normalized.starts_with("/@") {
        let virtual_type = &normalized[2..]; // 移除 /@
        if is_virtual_path_type(virtual_type) {
            return Ok(NewParsedPath::virtual_path(virtual_type));
        }
        // 不是有效的虚拟路径类型，当作普通路径处理
    }

    // 分割路径段
    let segments: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();

    if segments.is_empty() {
        return Ok(NewParsedPath::root());
    }

    // 检查最后一段是否是资源 ID
    // 使用安全的模式匹配避免潜在panic
    let last_segment = match segments.last() {
        Some(s) => *s,
        None => return Ok(NewParsedPath::root()),
    };

    // [PATH-006] 检查资源 ID 长度限制
    if last_segment.len() > MAX_RESOURCE_ID_LENGTH {
        return Err(DstuError::invalid_path(format!(
            "资源ID长度超限: {} 字符（最大 {}）",
            last_segment.len(),
            MAX_RESOURCE_ID_LENGTH
        )));
    }

    // 新格式路径解析（旧格式已废弃，统一解析为普通路径）
    if is_valid_resource_id(last_segment) {
        // 最后一段是资源 ID
        let resource_id = last_segment.to_string();
        let resource_type = get_resource_type_from_id(last_segment);

        let folder_path = if segments.len() > 1 {
            let folder_segments = &segments[..segments.len() - 1];
            Some(format!("/{}", folder_segments.join("/")))
        } else {
            None
        };

        Ok(NewParsedPath {
            full_path: normalized,
            folder_path,
            resource_id: Some(resource_id),
            resource_type,
            is_root: false,
            is_virtual: false,
            virtual_type: None,
        })
    } else {
        // 最后一段不是资源 ID，这是纯文件夹路径
        Ok(NewParsedPath::folder(&normalized))
    }
}

/// 构建真实文件夹路径（新 API）
///
/// # 参数
/// - `folder_path`: 文件夹路径（None 表示根目录）
/// - `resource_id`: 资源 ID
///
/// # 返回
/// 完整路径字符串
///
/// # 示例
/// ```rust
/// let path = build_real_path(Some("/高考复习/函数"), "note_abc123");
/// assert_eq!(path, "/高考复习/函数/note_abc123");
///
/// let path = build_real_path(None, "note_abc123");
/// assert_eq!(path, "/note_abc123");
/// ```
pub fn build_real_path(folder_path: Option<&str>, resource_id: &str) -> String {
    match folder_path {
        Some(fp) if !fp.is_empty() && fp != "/" => {
            let normalized_fp = if fp.starts_with('/') {
                fp.to_string()
            } else {
                format!("/{}", fp)
            };
            // 移除尾部斜杠
            let fp_trimmed = normalized_fp.trim_end_matches('/');
            format!("{}/{}", fp_trimmed, resource_id)
        }
        _ => format!("/{}", resource_id),
    }
}

/// 验证路径格式是否有效
///
/// # 规则
/// 1. 路径必须以 `/` 开头
/// 2. 路径不能包含连续的 `/`
/// 3. 路径不能以 `/` 结尾（除了根目录）
/// 4. 路径段不能是 `.` 或 `..`（禁止路径遍历）
pub fn is_valid_path(path: &str) -> bool {
    if path.is_empty() {
        return false;
    }

    // 根路径
    if path == "/" {
        return true;
    }

    // 必须以 / 开头
    if !path.starts_with('/') {
        return false;
    }

    // 不能以 / 结尾
    if path.len() > 1 && path.ends_with('/') {
        return false;
    }

    // 不能包含连续的 /
    if path.contains("//") {
        return false;
    }

    // 不能包含空段
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() && path != "/" {
        return false;
    }

    // 检查每个路径段：禁止路径遍历攻击
    for segment in &segments {
        // 禁止 "." 和 ".." 路径段
        if *segment == ".." || *segment == "." {
            return false;
        }
    }

    true
}

/// 从路径中提取资源 ID（如果有的话）
///
/// 返回路径最后一段（如果它是有效的资源 ID）
pub fn extract_resource_id(path: &str) -> Option<String> {
    let normalized = normalize_path(path);
    if normalized == "/" {
        return None;
    }

    let last_segment = normalized.rsplit('/').next()?;
    if is_valid_resource_id(last_segment) {
        Some(last_segment.to_string())
    } else {
        None
    }
}

/// 从路径中提取文件夹部分
///
/// 如果路径最后一段是资源 ID，返回资源 ID 之前的部分
/// 否则返回整个路径
pub fn extract_folder_path(path: &str) -> Option<String> {
    let normalized = normalize_path(path);
    if normalized == "/" {
        return None;
    }

    let last_segment = normalized.rsplit('/').next()?;
    if is_valid_resource_id(last_segment) {
        // 最后一段是资源 ID，返回之前的部分
        match normalized.rfind('/') {
            Some(0) => None, // 资源在根目录
            Some(idx) => Some(normalized[..idx].to_string()),
            None => None,
        }
    } else {
        // 最后一段不是资源 ID，整个路径都是文件夹路径
        Some(normalized)
    }
}

/// 规范化路径
///
/// - 确保以 / 开头
/// - 移除尾部斜杠（除了根路径）
/// - 处理多余的斜杠
fn normalize_path(path: &str) -> String {
    let trimmed = path.trim();

    if trimmed.is_empty() {
        return "/".to_string();
    }

    // 确保以 / 开头
    let with_slash = if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{}", trimmed)
    };

    // 移除尾部斜杠（除非是根路径）
    if with_slash.len() > 1 && with_slash.ends_with('/') {
        with_slash[..with_slash.len() - 1].to_string()
    } else {
        with_slash
    }
}

/// 构建简单资源路径
///
/// 新的路径格式：`/{resource_id}`
/// 真实的文件夹路径应从 folder_items 表获取。
///
/// ## 参数
/// - `id`: 资源 ID（如 "note_abc123"）
///
/// ## 返回
/// 简单路径字符串（如 "/note_abc123"）
pub fn build_simple_resource_path(id: &str) -> String {
    format!("/{}", id)
}

/// 判断路径是否是另一个路径的父路径
pub fn is_parent_path(parent: &str, child: &str) -> bool {
    let parent_normalized = normalize_path(parent);
    let child_normalized = normalize_path(child);

    if parent_normalized == "/" {
        return child_normalized != "/";
    }

    child_normalized.starts_with(&parent_normalized)
        && child_normalized.len() > parent_normalized.len()
        && child_normalized
            .chars()
            .nth(parent_normalized.len())
            .map(|c| c == '/')
            .unwrap_or(false)
}

/// 获取父路径
pub fn get_parent_path(path: &str) -> Option<String> {
    let normalized = normalize_path(path);

    if normalized == "/" {
        return None;
    }

    match normalized.rfind('/') {
        Some(0) => Some("/".to_string()),
        Some(idx) => Some(normalized[..idx].to_string()),
        None => Some("/".to_string()),
    }
}

/// 获取路径的最后一段（名称）
pub fn get_path_name(path: &str) -> String {
    let normalized = normalize_path(path);

    if normalized == "/" {
        return "/".to_string();
    }

    normalized.rsplit('/').next().unwrap_or("").to_string()
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // 辅助函数测试
    // ========================================================================

    #[test]
    fn test_normalize_path() {
        assert_eq!(normalize_path(""), "/");
        assert_eq!(normalize_path("/"), "/");
        assert_eq!(normalize_path("/数学"), "/数学");
        assert_eq!(normalize_path("/数学/"), "/数学");
        assert_eq!(normalize_path("数学"), "/数学");
        assert_eq!(normalize_path("  /数学/  "), "/数学");
    }

    #[test]
    fn test_is_parent_path() {
        assert!(is_parent_path("/", "/数学"));
        assert!(is_parent_path("/", "/数学/notes"));
        assert!(is_parent_path("/数学", "/数学/notes"));
        assert!(is_parent_path("/数学", "/数学/notes/note_123"));
        assert!(is_parent_path("/数学/notes", "/数学/notes/note_123"));

        assert!(!is_parent_path("/", "/"));
        assert!(!is_parent_path("/数学", "/数学"));
        assert!(!is_parent_path("/数学/notes", "/数学"));
        assert!(!is_parent_path("/物理", "/数学/notes"));
    }

    #[test]
    fn test_get_parent_path() {
        assert_eq!(get_parent_path("/"), None);
        assert_eq!(get_parent_path("/数学"), Some("/".to_string()));
        assert_eq!(get_parent_path("/数学/notes"), Some("/数学".to_string()));
        assert_eq!(
            get_parent_path("/数学/notes/note_123"),
            Some("/数学/notes".to_string())
        );
    }

    #[test]
    fn test_get_path_name() {
        assert_eq!(get_path_name("/"), "/");
        assert_eq!(get_path_name("/数学"), "数学");
        assert_eq!(get_path_name("/数学/notes"), "notes");
        assert_eq!(get_path_name("/数学/notes/note_123"), "note_123");
    }

    // ========================================================================
    // 便捷构建函数测试
    // ========================================================================

    #[test]
    fn test_build_simple_resource_path_func() {
        assert_eq!(build_simple_resource_path("note_123"), "/note_123");
        assert_eq!(build_simple_resource_path("tr_123"), "/tr_123");
    }

    // ========================================================================
    // 新 API 测试：parse_real_path（契约 B/C1）
    // ========================================================================

    #[test]
    fn test_parse_real_path_root() {
        // 根目录路径解析
        let parsed = parse_real_path("/").unwrap();
        assert!(parsed.is_root);
        assert!(!parsed.is_virtual);
        assert_eq!(parsed.full_path, "/");
        assert!(parsed.folder_path.is_none());
        assert!(parsed.resource_id.is_none());
    }

    #[test]
    fn test_parse_real_path_empty() {
        // 空路径当作根目录
        let parsed = parse_real_path("").unwrap();
        assert!(parsed.is_root);
    }

    #[test]
    fn test_parse_real_path_single_folder() {
        // 单层文件夹路径解析
        let parsed = parse_real_path("/高考复习").unwrap();
        assert!(!parsed.is_root);
        assert!(!parsed.is_virtual);
        assert_eq!(parsed.full_path, "/高考复习");
        assert_eq!(parsed.folder_path, Some("/高考复习".to_string()));
        assert!(parsed.resource_id.is_none());
    }

    #[test]
    fn test_parse_real_path_multi_folder() {
        // 多层文件夹路径解析
        let parsed = parse_real_path("/高考复习/函数/导数").unwrap();
        assert!(!parsed.is_root);
        assert_eq!(parsed.full_path, "/高考复习/函数/导数");
        assert_eq!(parsed.folder_path, Some("/高考复习/函数/导数".to_string()));
        assert!(parsed.resource_id.is_none());
    }

    #[test]
    fn test_parse_real_path_resource_at_root() {
        // 根目录下的资源
        let parsed = parse_real_path("/note_abc123").unwrap();
        assert!(!parsed.is_root);
        assert!(parsed.folder_path.is_none());
        assert_eq!(parsed.resource_id, Some("note_abc123".to_string()));
        assert_eq!(parsed.resource_type, Some("note".to_string()));
    }

    #[test]
    fn test_parse_real_path_resource_in_folder() {
        // 文件夹下的资源
        let parsed = parse_real_path("/高考复习/函数/note_abc123").unwrap();
        assert!(!parsed.is_root);
        assert_eq!(parsed.full_path, "/高考复习/函数/note_abc123");
        assert_eq!(parsed.folder_path, Some("/高考复习/函数".to_string()));
        assert_eq!(parsed.resource_id, Some("note_abc123".to_string()));
        assert_eq!(parsed.resource_type, Some("note".to_string()));
    }

    #[test]
    fn test_parse_real_path_all_resource_types() {
        // 测试所有资源类型前缀
        let test_cases = [
            ("note_abc", "note"),
            ("tb_xyz", "textbook"),
            ("exam_001", "exam"),
            ("tr_123", "translation"),
            ("essay_456", "essay"),
            ("fld_folder1", "folder"),
            ("att_file1", "attachment"),
        ];

        for (id, expected_type) in test_cases.iter() {
            let path = format!("/测试文件夹/{}", id);
            let parsed = parse_real_path(&path).unwrap();
            assert_eq!(parsed.resource_id, Some(id.to_string()));
            assert_eq!(parsed.resource_type, Some(expected_type.to_string()));
        }
    }

    #[test]
    fn test_parse_real_path_virtual_trash() {
        // 虚拟路径：回收站
        let parsed = parse_real_path("/@trash").unwrap();
        assert!(parsed.is_virtual);
        assert!(!parsed.is_root);
        assert_eq!(parsed.full_path, "/@trash");
        assert_eq!(parsed.virtual_type, Some("trash".to_string()));
    }

    #[test]
    fn test_parse_real_path_virtual_recent() {
        // 虚拟路径：最近
        let parsed = parse_real_path("/@recent").unwrap();
        assert!(parsed.is_virtual);
        assert_eq!(parsed.virtual_type, Some("recent".to_string()));
    }

    #[test]
    fn test_parse_real_path_virtual_favorites() {
        // 虚拟路径：收藏
        let parsed = parse_real_path("/@favorites").unwrap();
        assert!(parsed.is_virtual);
        assert_eq!(parsed.virtual_type, Some("favorites".to_string()));
    }

    #[test]
    fn test_parse_real_path_legacy_format() {
        // 旧格式路径已废弃，现在解析为文件夹路径
        let parsed = parse_real_path("/数学/notes/note_123").unwrap();
        // 旧格式路径现在解析为普通文件夹路径
        assert!(!parsed.is_root);
        assert!(!parsed.is_virtual);
    }

    #[test]
    fn test_parse_real_path_legacy_type_list() {
        // 旧格式类型列表已废弃，现在解析为文件夹路径
        let parsed = parse_real_path("/数学/notes").unwrap();
        assert!(!parsed.is_root);
        assert!(!parsed.is_virtual);
    }

    #[test]
    fn test_parse_real_path_legacy_global() {
        // 旧格式 _global 路径已废弃，现在解析为文件夹路径
        let parsed = parse_real_path("/_global/translations/tr_123").unwrap();
        assert!(!parsed.is_root);
        assert!(!parsed.is_virtual);
    }

    // ========================================================================
    // 新 API 测试：build_real_path
    // ========================================================================

    #[test]
    fn test_build_real_path_with_folder() {
        // 构建带文件夹的路径
        let path = build_real_path(Some("/高考复习/函数"), "note_abc123");
        assert_eq!(path, "/高考复习/函数/note_abc123");
    }

    #[test]
    fn test_build_real_path_at_root() {
        // 构建根目录下的路径
        let path = build_real_path(None, "note_abc123");
        assert_eq!(path, "/note_abc123");
    }

    #[test]
    fn test_build_real_path_empty_folder() {
        // 空文件夹路径等同于根目录
        let path = build_real_path(Some(""), "note_abc123");
        assert_eq!(path, "/note_abc123");
    }

    #[test]
    fn test_build_real_path_root_folder() {
        // "/" 文件夹路径等同于根目录
        let path = build_real_path(Some("/"), "note_abc123");
        assert_eq!(path, "/note_abc123");
    }

    #[test]
    fn test_build_real_path_without_leading_slash() {
        // 文件夹路径无前导斜杠
        let path = build_real_path(Some("高考复习/函数"), "note_abc123");
        assert_eq!(path, "/高考复习/函数/note_abc123");
    }

    #[test]
    fn test_build_real_path_with_trailing_slash() {
        // 文件夹路径有尾部斜杠
        let path = build_real_path(Some("/高考复习/函数/"), "note_abc123");
        assert_eq!(path, "/高考复习/函数/note_abc123");
    }

    // ========================================================================
    // 新 API 测试：is_valid_path
    // ========================================================================

    #[test]
    fn test_is_valid_path_root() {
        assert!(is_valid_path("/"));
    }

    #[test]
    fn test_is_valid_path_normal() {
        assert!(is_valid_path("/高考复习"));
        assert!(is_valid_path("/高考复习/函数"));
        assert!(is_valid_path("/高考复习/函数/note_abc"));
    }

    #[test]
    fn test_is_valid_path_empty() {
        assert!(!is_valid_path(""));
    }

    #[test]
    fn test_is_valid_path_no_leading_slash() {
        assert!(!is_valid_path("高考复习"));
    }

    #[test]
    fn test_is_valid_path_trailing_slash() {
        assert!(!is_valid_path("/高考复习/"));
    }

    #[test]
    fn test_is_valid_path_double_slash() {
        assert!(!is_valid_path("/高考复习//函数"));
    }

    #[test]
    fn test_is_valid_path_traversal_attack() {
        // 禁止路径遍历攻击
        assert!(!is_valid_path("/.."));
        assert!(!is_valid_path("/."));
        assert!(!is_valid_path("/高考复习/.."));
        assert!(!is_valid_path("/高考复习/../秘密文件"));
        assert!(!is_valid_path("/高考复习/./函数"));
        assert!(!is_valid_path("/../etc/passwd"));
        assert!(!is_valid_path("/高考复习/."));
    }

    // ========================================================================
    // 新 API 测试：extract_resource_id / extract_folder_path
    // ========================================================================

    #[test]
    fn test_extract_resource_id() {
        assert_eq!(
            extract_resource_id("/高考复习/note_abc"),
            Some("note_abc".to_string())
        );
        assert_eq!(
            extract_resource_id("/note_abc"),
            Some("note_abc".to_string())
        );
        assert_eq!(extract_resource_id("/高考复习"), None);
        assert_eq!(extract_resource_id("/"), None);
    }

    #[test]
    fn test_extract_folder_path() {
        assert_eq!(
            extract_folder_path("/高考复习/函数/note_abc"),
            Some("/高考复习/函数".to_string())
        );
        assert_eq!(extract_folder_path("/note_abc"), None);
        assert_eq!(
            extract_folder_path("/高考复习/函数"),
            Some("/高考复习/函数".to_string())
        );
        assert_eq!(extract_folder_path("/"), None);
    }

    // ========================================================================
    // 新 API 测试：get_resource_type
    // ========================================================================

    #[test]
    fn test_get_resource_type_all_prefixes() {
        assert_eq!(get_resource_type("note_abc"), Some("note".to_string()));
        assert_eq!(get_resource_type("tb_xyz"), Some("textbook".to_string()));
        assert_eq!(get_resource_type("exam_001"), Some("exam".to_string()));
        assert_eq!(get_resource_type("tr_123"), Some("translation".to_string()));
        assert_eq!(get_resource_type("essay_456"), Some("essay".to_string()));
        assert_eq!(get_resource_type("fld_folder"), Some("folder".to_string()));
        assert_eq!(
            get_resource_type("att_file"),
            Some("attachment".to_string())
        );
        assert_eq!(get_resource_type("img_pic"), Some("image".to_string()));
        assert_eq!(get_resource_type("file_doc"), Some("file".to_string()));
    }

    #[test]
    fn test_get_resource_type_invalid() {
        assert_eq!(get_resource_type("abc123"), None);
        assert_eq!(get_resource_type("unknown_id"), None);
        assert_eq!(get_resource_type("数学"), None);
    }

    // ========================================================================
    // 新 API 测试：is_valid_resource_id
    // ========================================================================

    #[test]
    fn test_is_valid_resource_id_true() {
        assert!(is_valid_resource_id("note_abc"));
        assert!(is_valid_resource_id("tb_123"));
        assert!(is_valid_resource_id("exam_001"));
    }

    #[test]
    fn test_is_valid_resource_id_false() {
        assert!(!is_valid_resource_id("abc"));
        assert!(!is_valid_resource_id("数学"));
        assert!(!is_valid_resource_id("notes"));
    }

    // ========================================================================
    // [PATH-006] 资源 ID 长度限制测试
    // ========================================================================

    #[test]
    fn test_parse_real_path_resource_id_length_limit() {
        // 正好 128 字符的资源 ID 应该能够解析
        let valid_id = format!("note_{}", "a".repeat(123)); // note_ (5) + 123 = 128
        let valid_path = format!("/{}", valid_id);
        let result = parse_real_path(&valid_path);
        assert!(result.is_ok());
        let parsed = result.unwrap();
        assert_eq!(parsed.resource_id, Some(valid_id));

        // 超过 128 字符的资源 ID 应该报错
        let invalid_id = format!("note_{}", "a".repeat(124)); // note_ (5) + 124 = 129
        let invalid_path = format!("/{}", invalid_id);
        let result = parse_real_path(&invalid_path);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("资源ID长度超限"));
    }
}
