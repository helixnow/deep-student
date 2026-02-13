//! Chat V2 - 资源库类型定义
//!
//! 本模块定义统一上下文注入系统的资源相关类型。
//! 所有上下文内容存入 ResourceStore，消息只存引用。
//!
//! ## 核心概念
//! - `Resource`: 资源实体，存储实际内容，基于 hash 去重
//! - `ContextRef`: 上下文引用，只包含 resourceId + hash + typeId
//! - `SendContextRef`: 发送时的引用，包含 formattedBlocks
//! - `ContentBlock`: 内容块，兼容 OpenAI/Anthropic/Gemini

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ★ 2026-02 修复：引入资源注入模式类型，用于重试时恢复用户选择
use crate::vfs::types::ResourceInjectModes;

// ============================================================================
// 资源类型枚举
// ============================================================================

/// 资源类型枚举
///
/// 定义资源库支持的资源类型，序列化为小写字符串。
/// 迁移 006 后数据库已移除 CHECK 约束，支持任意类型。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ResourceType {
    /// 图片资源
    Image,
    /// 文件附件
    File,
    /// 笔记快照
    Note,
    /// 题目卡片快照
    Card,
    /// 检索结果
    Retrieval,
    /// 题目集识别结果
    Exam,
    /// 教材页面
    Textbook,
    /// 作文批改
    Essay,
    /// 翻译
    Translation,
    /// 文件夹（包含多个资源的引用）
    Folder,
}

impl std::fmt::Display for ResourceType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResourceType::Image => write!(f, "image"),
            ResourceType::File => write!(f, "file"),
            ResourceType::Note => write!(f, "note"),
            ResourceType::Card => write!(f, "card"),
            ResourceType::Retrieval => write!(f, "retrieval"),
            ResourceType::Exam => write!(f, "exam"),
            ResourceType::Textbook => write!(f, "textbook"),
            ResourceType::Essay => write!(f, "essay"),
            ResourceType::Translation => write!(f, "translation"),
            ResourceType::Folder => write!(f, "folder"),
        }
    }
}

impl ResourceType {
    /// 从字符串解析资源类型
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "image" => Some(ResourceType::Image),
            "file" => Some(ResourceType::File),
            "note" => Some(ResourceType::Note),
            "card" => Some(ResourceType::Card),
            "retrieval" => Some(ResourceType::Retrieval),
            "exam" => Some(ResourceType::Exam),
            "textbook" => Some(ResourceType::Textbook),
            "essay" => Some(ResourceType::Essay),
            "translation" => Some(ResourceType::Translation),
            "folder" => Some(ResourceType::Folder),
            _ => None,
        }
    }
}

// ============================================================================
// 资源元数据
// ============================================================================

/// 资源元数据
///
/// 存储资源的附加信息，如文件名、MIME 类型等。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResourceMetadata {
    /// 资源名称（文件名等）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    /// MIME 类型
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,

    /// 文件大小（字节）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,

    /// 标题（笔记/卡片等）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    /// 检索来源（rag/memory/graph/web）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,

    /// 其他扩展字段
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<Value>,
}

// ============================================================================
// 资源实体
// ============================================================================

/// 资源实体（存储在资源库中）
///
/// 资源是统一上下文注入系统的核心存储单元。
/// 通过内容哈希实现自动去重和版本管理。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    /// 资源 ID（格式：`res_{nanoid(10)}`）
    pub id: String,

    /// 内容哈希（sha256，唯一标识版本，用于去重）
    pub hash: String,

    /// 资源类型
    #[serde(rename = "type")]
    pub resource_type: ResourceType,

    /// 原始数据 ID（noteId, cardId 等，用于跳转定位）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,

    /// 实际内容（文本格式，图片为 base64）
    pub data: String,

    /// 元数据
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ResourceMetadata>,

    /// 引用计数
    pub ref_count: i32,

    /// 创建时间戳（毫秒）
    pub created_at: i64,
}

impl Resource {
    /// 生成资源 ID
    ///
    /// 格式：res_{nanoid(10)}，符合文档要求
    pub fn generate_id() -> String {
        format!("res_{}", nanoid::nanoid!(10))
    }

    /// 创建新资源
    pub fn new(
        resource_type: ResourceType,
        data: String,
        hash: String,
        source_id: Option<String>,
        metadata: Option<ResourceMetadata>,
    ) -> Self {
        Self {
            id: Self::generate_id(),
            hash,
            resource_type,
            source_id,
            data,
            metadata,
            ref_count: 0,
            created_at: chrono::Utc::now().timestamp_millis(),
        }
    }
}

// ============================================================================
// 创建资源结果
// ============================================================================

/// 创建资源的返回结果
///
/// 用于 createOrReuse 操作，返回资源 ID、哈希和是否新建。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateResourceResult {
    /// 资源 ID
    pub resource_id: String,

    /// 内容哈希
    pub hash: String,

    /// 是否新创建（false 表示复用已有资源）
    pub is_new: bool,
}

// ============================================================================
// 内容块
// ============================================================================

/// 内容块（兼容 OpenAI/Anthropic/Gemini）
///
/// 用于格式化资源内容，支持文本和图片两种类型。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ContentBlock {
    /// 文本内容块
    Text {
        /// 文本内容
        text: String,
    },
    /// 图片内容块
    Image {
        /// MIME 类型（如 image/png, image/jpeg）
        #[serde(rename = "mediaType")]
        media_type: String,
        /// Base64 编码的图片数据
        base64: String,
    },
}

impl ContentBlock {
    /// 创建文本内容块
    pub fn text(text: impl Into<String>) -> Self {
        ContentBlock::Text { text: text.into() }
    }

    /// 创建图片内容块
    pub fn image(media_type: impl Into<String>, base64: impl Into<String>) -> Self {
        ContentBlock::Image {
            media_type: media_type.into(),
            base64: base64.into(),
        }
    }
}

// ============================================================================
// 上下文引用
// ============================================================================

/// 上下文引用（消息中只存这个，不存实际内容）
///
/// 通过 resourceId + hash 精确定位任意版本的资源。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextRef {
    /// 资源 ID
    pub resource_id: String,

    /// 内容哈希（精确定位版本）
    pub hash: String,

    /// 类型 ID（用于获取格式化方法）
    pub type_id: String,

    /// 显示名称（可选，用于 UI 显示）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,

    /// ★ 2026-02 修复：用户选择的注入模式（重试时恢复用户选择）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inject_modes: Option<ResourceInjectModes>,
}

impl ContextRef {
    /// 创建新的上下文引用
    pub fn new(
        resource_id: impl Into<String>,
        hash: impl Into<String>,
        type_id: impl Into<String>,
    ) -> Self {
        Self {
            resource_id: resource_id.into(),
            hash: hash.into(),
            type_id: type_id.into(),
            display_name: None,
            inject_modes: None,
        }
    }

    pub fn with_display_name(mut self, name: impl Into<String>) -> Self {
        self.display_name = Some(name.into());
        self
    }

    /// ★ 2026-02 修复：设置注入模式
    pub fn with_inject_modes(mut self, inject_modes: Option<ResourceInjectModes>) -> Self {
        self.inject_modes = inject_modes;
        self
    }
}

// ============================================================================
// 发送时的上下文引用
// ============================================================================

/// 发送时的上下文引用（含格式化内容）
///
/// 在发送消息时，前端会将 ContextRef 扩展为 SendContextRef，
/// 包含格式化后的内容块，后端直接使用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendContextRef {
    /// 资源 ID
    pub resource_id: String,

    /// 内容哈希
    pub hash: String,

    /// 类型 ID
    pub type_id: String,

    /// 格式化后的内容块（发送时填充，后端直接使用）
    pub formatted_blocks: Vec<ContentBlock>,

    /// 显示名称（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,

    /// ★ 2026-02 修复：用户选择的注入模式（重试时恢复用户选择）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inject_modes: Option<ResourceInjectModes>,
}

impl SendContextRef {
    /// 从 ContextRef 创建 SendContextRef
    pub fn from_context_ref(context_ref: &ContextRef, formatted_blocks: Vec<ContentBlock>) -> Self {
        Self {
            resource_id: context_ref.resource_id.clone(),
            hash: context_ref.hash.clone(),
            type_id: context_ref.type_id.clone(),
            formatted_blocks,
            display_name: context_ref.display_name.clone(),
            inject_modes: context_ref.inject_modes.clone(),
        }
    }

    /// 转换为 ContextRef（丢弃 formattedBlocks，但保留 inject_modes）
    /// ★ 2026-02 修复：保留 inject_modes，确保重试时能恢复用户选择
    pub fn to_context_ref(&self) -> ContextRef {
        ContextRef {
            resource_id: self.resource_id.clone(),
            hash: self.hash.clone(),
            type_id: self.type_id.clone(),
            display_name: self.display_name.clone(),
            inject_modes: self.inject_modes.clone(),
        }
    }
}

// ============================================================================
// 上下文快照
// ============================================================================

/// 上下文快照（只存引用）
///
/// 存储在 Message._meta 中，记录消息发送时的上下文状态。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextSnapshot {
    /// 用户提供的上下文引用
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub user_refs: Vec<ContextRef>,

    /// 系统检索的上下文引用
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub retrieval_refs: Vec<ContextRef>,

    /// ★ 文档28 Prompt10：资源 ID -> 真实路径 的映射
    /// 用于 UI 显示资源的文件夹路径
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub path_map: std::collections::HashMap<String, String>,
}

impl ContextSnapshot {
    /// 创建空的上下文快照
    pub fn new() -> Self {
        Self::default()
    }

    /// 检查是否有任何上下文引用
    pub fn has_refs(&self) -> bool {
        !self.user_refs.is_empty() || !self.retrieval_refs.is_empty()
    }

    /// 获取所有引用的 resourceId 列表（用于引用计数）
    pub fn all_resource_ids(&self) -> Vec<&str> {
        self.user_refs
            .iter()
            .chain(self.retrieval_refs.iter())
            .map(|r| r.resource_id.as_str())
            .collect()
    }

    /// 添加用户上下文引用
    pub fn add_user_ref(&mut self, context_ref: ContextRef) {
        self.user_refs.push(context_ref);
    }

    /// 添加检索上下文引用
    pub fn add_retrieval_ref(&mut self, context_ref: ContextRef) {
        self.retrieval_refs.push(context_ref);
    }
}

// ============================================================================
// 创建资源参数
// ============================================================================

/// 创建资源的输入参数
///
/// 用于 resource_create_or_reuse 命令。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateResourceParams {
    /// 资源类型
    #[serde(rename = "type")]
    pub resource_type: ResourceType,

    /// 资源内容（文本或 base64）
    pub data: String,

    /// 原始数据 ID（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,

    /// 元数据（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ResourceMetadata>,
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resource_type_serialization() {
        // 验证 ResourceType 序列化为小写字符串
        assert_eq!(
            serde_json::to_string(&ResourceType::Image).unwrap(),
            "\"image\""
        );
        assert_eq!(
            serde_json::to_string(&ResourceType::File).unwrap(),
            "\"file\""
        );
        assert_eq!(
            serde_json::to_string(&ResourceType::Note).unwrap(),
            "\"note\""
        );
        assert_eq!(
            serde_json::to_string(&ResourceType::Card).unwrap(),
            "\"card\""
        );
        assert_eq!(
            serde_json::to_string(&ResourceType::Retrieval).unwrap(),
            "\"retrieval\""
        );
        assert_eq!(
            serde_json::to_string(&ResourceType::Exam).unwrap(),
            "\"exam\""
        );
        assert_eq!(
            serde_json::to_string(&ResourceType::Textbook).unwrap(),
            "\"textbook\""
        );
        assert_eq!(
            serde_json::to_string(&ResourceType::Essay).unwrap(),
            "\"essay\""
        );
        assert_eq!(
            serde_json::to_string(&ResourceType::Translation).unwrap(),
            "\"translation\""
        );
        assert_eq!(
            serde_json::to_string(&ResourceType::Folder).unwrap(),
            "\"folder\""
        );
    }

    #[test]
    fn test_resource_type_deserialization() {
        // 验证从小写字符串反序列化
        assert_eq!(
            serde_json::from_str::<ResourceType>("\"image\"").unwrap(),
            ResourceType::Image
        );
        assert_eq!(
            serde_json::from_str::<ResourceType>("\"note\"").unwrap(),
            ResourceType::Note
        );
    }

    #[test]
    fn test_create_resource_result_camel_case() {
        // 验证 CreateResourceResult 序列化为 camelCase
        let result = CreateResourceResult {
            resource_id: "res_abc123".to_string(),
            hash: "sha256_hash".to_string(),
            is_new: true,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"resourceId\""));
        assert!(json.contains("\"isNew\""));
        assert!(!json.contains("\"resource_id\""));
        assert!(!json.contains("\"is_new\""));
    }

    #[test]
    fn test_content_block_text_serialization() {
        // 验证文本内容块序列化
        let block = ContentBlock::text("Hello, world!");
        let json = serde_json::to_string(&block).unwrap();
        assert!(json.contains("\"type\":\"text\""));
        assert!(json.contains("\"text\":\"Hello, world!\""));
    }

    #[test]
    fn test_content_block_image_serialization() {
        // 验证图片内容块序列化
        let block = ContentBlock::image("image/png", "base64data");
        let json = serde_json::to_string(&block).unwrap();
        assert!(json.contains("\"type\":\"image\""));
        assert!(json.contains("\"mediaType\":\"image/png\""));
        assert!(json.contains("\"base64\":\"base64data\""));
    }

    #[test]
    fn test_context_ref_serialization() {
        // 验证 ContextRef 序列化为 camelCase
        let ctx_ref = ContextRef::new("res_abc123", "sha256_hash", "note");
        let json = serde_json::to_string(&ctx_ref).unwrap();
        assert!(json.contains("\"resourceId\""));
        assert!(json.contains("\"typeId\""));
        assert!(!json.contains("\"resource_id\""));
        assert!(!json.contains("\"type_id\""));
    }

    #[test]
    fn test_send_context_ref_serialization() {
        // 验证 SendContextRef 序列化
        let send_ref = SendContextRef {
            resource_id: "res_abc123".to_string(),
            hash: "sha256_hash".to_string(),
            type_id: "note".to_string(),
            formatted_blocks: vec![ContentBlock::text("content")],
            display_name: None,
            inject_modes: None,
        };
        let json = serde_json::to_string(&send_ref).unwrap();
        assert!(json.contains("\"resourceId\""));
        assert!(json.contains("\"formattedBlocks\""));
    }

    #[test]
    fn test_context_snapshot_serialization() {
        // 验证 ContextSnapshot 序列化
        let mut snapshot = ContextSnapshot::new();
        snapshot.add_user_ref(ContextRef::new("res_1", "hash_1", "note"));
        snapshot.add_retrieval_ref(ContextRef::new("res_2", "hash_2", "retrieval"));

        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(json.contains("\"userRefs\""));
        assert!(json.contains("\"retrievalRefs\""));
    }

    #[test]
    fn test_context_snapshot_empty_skip() {
        // 验证空数组跳过序列化
        let snapshot = ContextSnapshot::new();
        let json = serde_json::to_string(&snapshot).unwrap();
        // 空数组应该被跳过
        assert_eq!(json, "{}");
    }

    #[test]
    fn test_resource_serialization() {
        // 验证 Resource 序列化
        let resource = Resource::new(
            ResourceType::Note,
            "note content".to_string(),
            "sha256_hash".to_string(),
            Some("note_123".to_string()),
            Some(ResourceMetadata {
                title: Some("My Note".to_string()),
                ..Default::default()
            }),
        );
        let json = serde_json::to_string(&resource).unwrap();
        assert!(json.contains("\"type\":\"note\""));
        assert!(json.contains("\"sourceId\""));
        assert!(json.contains("\"refCount\""));
        assert!(json.contains("\"createdAt\""));
    }

    #[test]
    fn test_context_snapshot_all_resource_ids() {
        // 验证获取所有资源 ID
        let mut snapshot = ContextSnapshot::new();
        snapshot.add_user_ref(ContextRef::new("res_1", "hash_1", "note"));
        snapshot.add_user_ref(ContextRef::new("res_2", "hash_2", "file"));
        snapshot.add_retrieval_ref(ContextRef::new("res_3", "hash_3", "retrieval"));

        let ids = snapshot.all_resource_ids();
        assert_eq!(ids.len(), 3);
        assert!(ids.contains(&"res_1"));
        assert!(ids.contains(&"res_2"));
        assert!(ids.contains(&"res_3"));
    }

    #[test]
    fn test_send_context_ref_conversion() {
        // 验证 SendContextRef 与 ContextRef 转换
        let ctx_ref = ContextRef::new("res_abc", "hash_xyz", "note");
        let send_ref = SendContextRef::from_context_ref(
            &ctx_ref,
            vec![ContentBlock::text("formatted content")],
        );

        assert_eq!(send_ref.resource_id, "res_abc");
        assert_eq!(send_ref.type_id, "note");
        assert_eq!(send_ref.formatted_blocks.len(), 1);

        let back_to_ref = send_ref.to_context_ref();
        assert_eq!(back_to_ref, ctx_ref);
    }

    #[test]
    fn test_create_resource_params_serialization() {
        // 验证 CreateResourceParams 序列化
        let params = CreateResourceParams {
            resource_type: ResourceType::Image,
            data: "base64data".to_string(),
            source_id: None,
            metadata: Some(ResourceMetadata {
                name: Some("image.png".to_string()),
                mime_type: Some("image/png".to_string()),
                size: Some(1024),
                ..Default::default()
            }),
        };
        let json = serde_json::to_string(&params).unwrap();
        assert!(json.contains("\"type\":\"image\""));
        assert!(json.contains("\"mimeType\""));
    }
}
