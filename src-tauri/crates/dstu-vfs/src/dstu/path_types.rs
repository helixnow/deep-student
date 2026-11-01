//! DSTU 路径类型定义（契约 C1）
//!
//! 本模块定义 DSTU 真实路径架构的核心类型，支持文件夹层级路径。
//!
//! ## 新路径格式（契约 B）
//! ```text
//! /{folder_path}/{resource_id}
//!
//! 示例：
//! - /高考复习/函数/note_abc123    ← 在"高考复习/函数"文件夹下的笔记
//! - /我的教材/tb_xyz789           ← 在"我的教材"文件夹下的教材
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
//! - `mm_xxx` → 思维导图

use serde::{Deserialize, Serialize};

// ============================================================================
// 路径和资源 ID 长度限制
// ============================================================================

/// 资源 ID 最大长度
///
/// [PATH-006] 安全限制：防止超长资源 ID 导致的性能问题和潜在攻击
/// 与前端 types/path.ts 保持一致
pub const MAX_RESOURCE_ID_LENGTH: usize = 128;

// ============================================================================
// C1: 路径解析结果
// ============================================================================

/// 解析后的 DSTU 路径（契约 C1）
///
/// 表示真实文件夹层级路径的解析结果。
///
/// # 示例
/// ```text
/// 路径: /高考复习/函数/note_abc123
/// 解析结果:
///   full_path: "/高考复习/函数/note_abc123"
///   folder_path: Some("/高考复习/函数")
///   resource_id: Some("note_abc123")
///   resource_type: Some("note")
///   is_root: false
///   is_virtual: false
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedPath {
    /// 完整路径
    pub full_path: String,

    /// 文件夹部分（不含资源 ID）
    /// - `/高考复习/函数/note_abc` → Some("/高考复习/函数")
    /// - `/note_abc` → None（根目录）
    /// - `/` → None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_path: Option<String>,

    /// 资源 ID（最后一段，符合 ID 前缀规范）
    /// - `/高考复习/note_abc` → Some("note_abc")
    /// - `/高考复习` → None（是文件夹路径）
    /// - `/` → None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,

    /// 资源类型（从 ID 前缀推断）
    /// - `note_xxx` → Some("note")
    /// - `tb_xxx` → Some("textbook")
    /// - 非资源路径 → None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_type: Option<String>,

    /// 是否为根目录
    pub is_root: bool,

    /// 是否为虚拟路径（@trash, @recent, @favorites）
    pub is_virtual: bool,

    /// 虚拟路径类型（仅当 is_virtual 为 true 时有效）
    /// - `/@trash` → Some("trash")
    /// - `/@recent` → Some("recent")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub virtual_type: Option<String>,
}

impl ParsedPath {
    /// 创建根目录路径
    pub fn root() -> Self {
        Self {
            full_path: "/".to_string(),
            folder_path: None,
            resource_id: None,
            resource_type: None,
            is_root: true,
            is_virtual: false,
            virtual_type: None,
        }
    }

    /// 创建虚拟路径
    pub fn virtual_path(virtual_type: &str) -> Self {
        Self {
            full_path: format!("/@{}", virtual_type),
            folder_path: None,
            resource_id: None,
            resource_type: None,
            is_root: false,
            is_virtual: true,
            virtual_type: Some(virtual_type.to_string()),
        }
    }

    /// 创建文件夹路径（无资源）
    pub fn folder(folder_path: &str) -> Self {
        let full_path = if folder_path.is_empty() || folder_path == "/" {
            "/".to_string()
        } else if folder_path.starts_with('/') {
            folder_path.to_string()
        } else {
            format!("/{}", folder_path)
        };

        let is_root = full_path == "/";
        Self {
            folder_path: if is_root {
                None
            } else {
                Some(full_path.clone())
            },
            full_path,
            resource_id: None,
            resource_type: None,
            is_root,
            is_virtual: false,
            virtual_type: None,
        }
    }

    /// 创建资源路径
    pub fn resource(folder_path: Option<&str>, resource_id: &str, resource_type: &str) -> Self {
        let full_path = match folder_path {
            Some(fp) if !fp.is_empty() && fp != "/" => {
                let normalized_fp = if fp.starts_with('/') {
                    fp.to_string()
                } else {
                    format!("/{}", fp)
                };
                format!("{}/{}", normalized_fp, resource_id)
            }
            _ => format!("/{}", resource_id),
        };

        Self {
            full_path,
            folder_path: folder_path
                .filter(|fp| !fp.is_empty() && *fp != "/")
                .map(|fp| {
                    if fp.starts_with('/') {
                        fp.to_string()
                    } else {
                        format!("/{}", fp)
                    }
                }),
            resource_id: Some(resource_id.to_string()),
            resource_type: Some(resource_type.to_string()),
            is_root: false,
            is_virtual: false,
            virtual_type: None,
        }
    }

    /// 是否是资源路径（有 resource_id）
    pub fn is_resource(&self) -> bool {
        self.resource_id.is_some()
    }

    /// 是否是纯文件夹路径（无 resource_id，非根目录，非虚拟）
    pub fn is_folder_only(&self) -> bool {
        self.resource_id.is_none() && !self.is_root && !self.is_virtual
    }

    /// 获取路径的最后一段（名称）
    pub fn get_name(&self) -> &str {
        if self.is_root {
            return "/";
        }
        self.full_path.rsplit('/').next().unwrap_or(&self.full_path)
    }
}

impl Default for ParsedPath {
    fn default() -> Self {
        Self::root()
    }
}

// ============================================================================
// 资源类型推断
// ============================================================================

/// 资源 ID 前缀映射表
pub const RESOURCE_ID_PREFIXES: &[(&str, &str)] = &[
    ("note_", "note"),
    ("tb_", "textbook"),
    ("exam_", "exam"),
    ("tr_", "translation"),
    ("essay_", "essay"),
    ("fld_", "folder"),
    ("att_", "attachment"),
    ("img_", "image"),
    ("file_", "file"),
    ("mm_", "mindmap"),
];

/// 从资源 ID 推断资源类型
///
/// # 参数
/// - `id`: 资源 ID，如 "note_abc123"
///
/// # 返回
/// 资源类型字符串，如 Some("note")；无法识别返回 None
pub fn get_resource_type_from_id(id: &str) -> Option<String> {
    for (prefix, resource_type) in RESOURCE_ID_PREFIXES {
        if id.starts_with(prefix) {
            return Some(resource_type.to_string());
        }
    }
    None
}

/// 检查字符串是否是有效的资源 ID（符合前缀规范和长度限制）
///
/// [PATH-006] 添加长度限制检查：最大 128 字符
pub fn is_valid_resource_id(id: &str) -> bool {
    // [PATH-006] 检查长度限制
    if id.len() > MAX_RESOURCE_ID_LENGTH {
        return false;
    }
    get_resource_type_from_id(id).is_some()
}

// ============================================================================
// 虚拟路径类型
// ============================================================================

/// 支持的虚拟路径类型
pub const VIRTUAL_PATH_TYPES: &[&str] = &["trash", "recent", "favorites", "all"];

/// 检查是否是虚拟路径类型
pub fn is_virtual_path_type(path_type: &str) -> bool {
    VIRTUAL_PATH_TYPES.contains(&path_type.to_lowercase().as_str())
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parsed_path_root() {
        let path = ParsedPath::root();
        assert!(path.is_root);
        assert!(!path.is_virtual);
        assert_eq!(path.full_path, "/");
        assert!(path.folder_path.is_none());
        assert!(path.resource_id.is_none());
    }

    #[test]
    fn test_parsed_path_virtual() {
        let path = ParsedPath::virtual_path("trash");
        assert!(path.is_virtual);
        assert!(!path.is_root);
        assert_eq!(path.full_path, "/@trash");
        assert_eq!(path.virtual_type, Some("trash".to_string()));
    }

    #[test]
    fn test_parsed_path_folder() {
        let path = ParsedPath::folder("/高考复习/函数");
        assert!(!path.is_root);
        assert!(!path.is_virtual);
        assert_eq!(path.full_path, "/高考复习/函数");
        assert_eq!(path.folder_path, Some("/高考复习/函数".to_string()));
        assert!(path.resource_id.is_none());
    }

    #[test]
    fn test_parsed_path_resource() {
        let path = ParsedPath::resource(Some("/高考复习/函数"), "note_abc123", "note");
        assert!(!path.is_root);
        assert!(!path.is_virtual);
        assert_eq!(path.full_path, "/高考复习/函数/note_abc123");
        assert_eq!(path.folder_path, Some("/高考复习/函数".to_string()));
        assert_eq!(path.resource_id, Some("note_abc123".to_string()));
        assert_eq!(path.resource_type, Some("note".to_string()));
    }

    #[test]
    fn test_parsed_path_resource_at_root() {
        let path = ParsedPath::resource(None, "note_abc123", "note");
        assert_eq!(path.full_path, "/note_abc123");
        assert!(path.folder_path.is_none());
        assert_eq!(path.resource_id, Some("note_abc123".to_string()));
    }

    #[test]
    fn test_get_resource_type_from_id() {
        assert_eq!(
            get_resource_type_from_id("note_abc123"),
            Some("note".to_string())
        );
        assert_eq!(
            get_resource_type_from_id("tb_xyz789"),
            Some("textbook".to_string())
        );
        assert_eq!(
            get_resource_type_from_id("exam_001"),
            Some("exam".to_string())
        );
        assert_eq!(
            get_resource_type_from_id("tr_123"),
            Some("translation".to_string())
        );
        assert_eq!(
            get_resource_type_from_id("essay_456"),
            Some("essay".to_string())
        );
        assert_eq!(
            get_resource_type_from_id("fld_folder1"),
            Some("folder".to_string())
        );
        assert_eq!(get_resource_type_from_id("unknown_id"), None);
        assert_eq!(get_resource_type_from_id("abc123"), None);
    }

    #[test]
    fn test_is_valid_resource_id() {
        assert!(is_valid_resource_id("note_abc"));
        assert!(is_valid_resource_id("tb_123"));
        assert!(is_valid_resource_id("fld_folder"));
        assert!(!is_valid_resource_id("abc123"));
        assert!(!is_valid_resource_id("数学"));
    }

    #[test]
    fn test_resource_id_length_limit() {
        // [PATH-006] 测试资源 ID 长度限制
        // 正好 128 字符的 ID 应该有效
        let valid_id = format!("note_{}", "a".repeat(123)); // note_ (5) + 123 = 128
        assert_eq!(valid_id.len(), 128);
        assert!(is_valid_resource_id(&valid_id));

        // 超过 128 字符的 ID 应该无效
        let invalid_id = format!("note_{}", "a".repeat(124)); // note_ (5) + 124 = 129
        assert_eq!(invalid_id.len(), 129);
        assert!(!is_valid_resource_id(&invalid_id));

        // 非常长的 ID 应该无效
        let very_long_id = format!("note_{}", "a".repeat(500));
        assert!(!is_valid_resource_id(&very_long_id));
    }

    #[test]
    fn test_is_virtual_path_type() {
        assert!(is_virtual_path_type("trash"));
        assert!(is_virtual_path_type("recent"));
        assert!(is_virtual_path_type("favorites"));
        assert!(is_virtual_path_type("all"));
        assert!(is_virtual_path_type("TRASH"));
        assert!(is_virtual_path_type("ALL"));
        assert!(!is_virtual_path_type("notes"));
    }

    #[test]
    fn test_parsed_path_get_name() {
        assert_eq!(ParsedPath::root().get_name(), "/");
        assert_eq!(ParsedPath::folder("/高考复习/函数").get_name(), "函数");
        assert_eq!(
            ParsedPath::resource(Some("/高考复习"), "note_abc", "note").get_name(),
            "note_abc"
        );
    }

    #[test]
    fn test_parsed_path_serialization() {
        let path = ParsedPath::resource(Some("/高考复习"), "note_abc", "note");
        let json = serde_json::to_string(&path).unwrap();
        assert!(json.contains("\"fullPath\""));
        assert!(json.contains("\"folderPath\""));
        assert!(json.contains("\"resourceId\""));
        assert!(json.contains("\"resourceType\""));
        assert!(json.contains("\"isRoot\":false"));
        assert!(json.contains("\"isVirtual\":false"));
    }
}
