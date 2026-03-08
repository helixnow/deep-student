//! VFS 核心类型定义
//!
//! 本模块定义 VFS 相关的核心数据结构和类型。
//! 所有结构体使用 camelCase 序列化，与前端保持一致。
//!
//! ## 核心概念
//! - `VfsResource`: 资源实体，内容 SSOT
//! - `VfsNote`: 笔记元数据（内容存 resources）
//! - `VfsTextbook`: 教材元数据
//! - `VfsExamSheet`: 题目集识别元数据
//! - `VfsTranslation`: 翻译元数据
//! - `VfsEssay`: 作文批改元数据
//! - `VfsBlob`: 大文件外部存储

use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;

// ============================================================================
// 序列化辅助函数
// ============================================================================

/// 将 Option<String> 序列化为字符串（None 输出空字符串）
///
/// ★ 2025-01-01: 确保前端收到的 JSON 字段始终是 string 类型
fn serialize_option_string_as_string<S>(
    value: &Option<String>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    match value {
        Some(s) => serializer.serialize_str(s),
        None => serializer.serialize_str(""),
    }
}

// ============================================================================
// 存储模式
// ============================================================================

/// 存储模式枚举
///
/// - `Inline`: 内容直接存储在 resources.data
/// - `External`: 内容存储在外部文件，通过 blobs 表索引
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StorageMode {
    /// 内嵌存储
    Inline,
    /// 外部存储（大文件）
    External,
}

impl Default for StorageMode {
    fn default() -> Self {
        StorageMode::Inline
    }
}

impl std::fmt::Display for StorageMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StorageMode::Inline => write!(f, "inline"),
            StorageMode::External => write!(f, "external"),
        }
    }
}

impl StorageMode {
    /// 从字符串解析
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "inline" => Some(StorageMode::Inline),
            "external" => Some(StorageMode::External),
            _ => None,
        }
    }
}

// ============================================================================
// 资源类型
// ============================================================================

/// VFS 资源类型枚举
///
/// 定义 VFS 支持的所有资源类型，序列化为小写字符串。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VfsResourceType {
    /// 笔记
    Note,
    /// 教材
    Textbook,
    /// 题目集识别
    Exam,
    /// 翻译
    Translation,
    /// 作文批改
    Essay,
    /// 图片
    Image,
    /// 文件附件
    File,
    /// 检索结果
    Retrieval,
    /// 知识导图
    MindMap,
}

impl std::fmt::Display for VfsResourceType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VfsResourceType::Note => write!(f, "note"),
            VfsResourceType::Textbook => write!(f, "textbook"),
            VfsResourceType::Exam => write!(f, "exam"),
            VfsResourceType::Translation => write!(f, "translation"),
            VfsResourceType::Essay => write!(f, "essay"),
            VfsResourceType::Image => write!(f, "image"),
            VfsResourceType::File => write!(f, "file"),
            VfsResourceType::Retrieval => write!(f, "retrieval"),
            VfsResourceType::MindMap => write!(f, "mindmap"),
        }
    }
}

impl VfsResourceType {
    /// 从字符串解析资源类型
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "note" => Some(VfsResourceType::Note),
            "textbook" => Some(VfsResourceType::Textbook),
            "exam" => Some(VfsResourceType::Exam),
            "translation" => Some(VfsResourceType::Translation),
            "essay" => Some(VfsResourceType::Essay),
            "image" => Some(VfsResourceType::Image),
            "file" => Some(VfsResourceType::File),
            "retrieval" => Some(VfsResourceType::Retrieval),
            "mindmap" => Some(VfsResourceType::MindMap),
            _ => None,
        }
    }

    /// 获取所有资源类型
    pub fn all() -> Vec<Self> {
        vec![
            VfsResourceType::Note,
            VfsResourceType::Textbook,
            VfsResourceType::Exam,
            VfsResourceType::Translation,
            VfsResourceType::Essay,
            VfsResourceType::Image,
            VfsResourceType::File,
            VfsResourceType::Retrieval,
            VfsResourceType::MindMap,
        ]
    }
}

// ============================================================================
// 资源元数据
// ============================================================================

/// VFS 资源元数据
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VfsResourceMetadata {
    /// 资源名称
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    /// 标题
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    /// MIME 类型
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,

    /// 文件大小（字节）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,

    /// 来源
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,

    /// 扩展字段
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<Value>,
}

// ============================================================================
// VFS 资源实体
// ============================================================================

/// VFS 资源实体（resources 表）
///
/// 资源是 VFS 的核心存储单元，`data` 字段是内容的 SSOT。
/// 通过内容哈希实现全局去重和版本管理。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsResource {
    /// 资源 ID（格式：`res_{nanoid(10)}`）
    pub id: String,

    /// 内容哈希（SHA-256，全局唯一，用于去重）
    pub hash: String,

    /// 资源类型
    #[serde(rename = "type")]
    pub resource_type: VfsResourceType,

    /// 原始数据 ID（note_id, textbook_id 等）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,

    /// 原始表名（notes, textbooks 等）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_table: Option<String>,

    /// 存储模式
    pub storage_mode: StorageMode,

    /// 内嵌内容（inline 模式）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,

    /// 外部文件哈希（external 模式，指向 blobs）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_hash: Option<String>,

    /// 元数据 JSON
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<VfsResourceMetadata>,

    /// 引用计数
    pub ref_count: i32,

    /// 创建时间（毫秒时间戳）
    pub created_at: i64,

    /// 更新时间（毫秒时间戳）
    pub updated_at: i64,
}

impl VfsResource {
    /// 生成资源 ID
    ///
    /// 格式：res_{nanoid(10)}
    pub fn generate_id() -> String {
        format!("res_{}", nanoid::nanoid!(10))
    }

    /// 创建新资源
    pub fn new(
        resource_type: VfsResourceType,
        hash: String,
        storage_mode: StorageMode,
        data: Option<String>,
        external_hash: Option<String>,
        source_id: Option<String>,
        source_table: Option<String>,
        metadata: Option<VfsResourceMetadata>,
    ) -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        Self {
            id: Self::generate_id(),
            hash,
            resource_type,
            source_id,
            source_table,
            storage_mode,
            data,
            external_hash,
            metadata,
            ref_count: 0,
            created_at: now,
            updated_at: now,
        }
    }
}

// ============================================================================
// 创建资源结果
// ============================================================================

/// 创建资源的返回结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsCreateResourceResult {
    /// 资源 ID
    pub resource_id: String,

    /// 内容哈希
    pub hash: String,

    /// 是否新创建（false 表示复用已有资源）
    pub is_new: bool,
}

// ============================================================================
// 笔记元数据
// ============================================================================

/// VFS 笔记元数据（notes 表）
///
/// 内容存储在 resources.data，本表只存元数据。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsNote {
    /// 笔记 ID（格式：`note_{nanoid(10)}`）
    pub id: String,

    /// 资源 ID（内容存 resources）
    pub resource_id: String,

    /// 标题
    pub title: String,

    /// 标签
    #[serde(default)]
    pub tags: Vec<String>,

    /// 是否收藏
    #[serde(default)]
    pub is_favorite: bool,

    /// 创建时间
    pub created_at: String,

    /// 更新时间
    pub updated_at: String,

    /// 删除时间（软删除）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
}

impl VfsNote {
    /// 生成笔记 ID
    pub fn generate_id() -> String {
        format!("note_{}", nanoid::nanoid!(10))
    }
}

// ============================================================================
// 教材元数据
// ============================================================================

/// VFS 教材元数据（textbooks 表）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsTextbook {
    /// 教材 ID（格式：`tb_{nanoid(10)}`）
    pub id: String,

    /// 资源 ID（元信息资源）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,

    /// Blob 哈希（PDF 内容指向 blobs）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob_hash: Option<String>,

    /// 文件哈希（去重用）
    pub sha256: String,

    /// 文件名
    pub file_name: String,

    /// 原始导入路径
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,

    /// 文件大小（字节）
    pub size: i64,

    /// 页数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_count: Option<i32>,

    /// 标签
    #[serde(default)]
    pub tags: Vec<String>,

    /// 是否收藏
    #[serde(default)]
    pub is_favorite: bool,

    /// 最后打开时间
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_opened_at: Option<String>,

    /// 最后阅读页
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_page: Option<i32>,

    /// 书签
    #[serde(default)]
    pub bookmarks: Vec<Value>,

    /// 封面缓存键
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_key: Option<String>,

    /// 状态
    #[serde(default = "default_status")]
    pub status: String,

    /// 创建时间
    pub created_at: String,

    /// 更新时间
    pub updated_at: String,
}

fn default_status() -> String {
    "active".to_string()
}

impl VfsTextbook {
    /// 生成教材 ID
    pub fn generate_id() -> String {
        format!("tb_{}", nanoid::nanoid!(10))
    }
}

// ============================================================================
// 题目集识别元数据
// ============================================================================

/// VFS 题目集识别元数据（exam_sheets 表）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsExamSheet {
    /// 题目集 ID（格式：`exam_{nanoid(10)}`）
    pub id: String,

    /// 资源 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,

    /// 考试名称
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exam_name: Option<String>,

    /// 状态（pending | processing | completed | failed）
    pub status: String,

    /// 临时会话 ID
    pub temp_id: String,

    /// 识别元数据
    pub metadata_json: Value,

    /// 预览数据
    pub preview_json: Value,

    /// 关联的错题 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_mistake_ids: Option<Vec<String>>,

    /// 是否收藏
    #[serde(default)]
    pub is_favorite: bool,

    /// 创建时间
    pub created_at: String,

    /// 更新时间
    pub updated_at: String,
}

impl VfsExamSheet {
    /// 生成题目集 ID
    pub fn generate_id() -> String {
        format!("exam_{}", nanoid::nanoid!(10))
    }
}

// ============================================================================
// 翻译元数据
// ============================================================================

/// VFS 翻译元数据（translations 表）
///
/// 翻译内容（source + translated）存在 resources.data（JSON 格式）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsTranslation {
    /// 翻译 ID（格式：`tr_{nanoid(10)}`）
    pub id: String,

    /// 资源 ID（内容存 resources）
    pub resource_id: String,

    /// 翻译标题/名称（用于重命名）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    /// 源语言
    #[serde(default = "default_src_lang")]
    pub src_lang: String,

    /// 目标语言
    #[serde(default = "default_tgt_lang")]
    pub tgt_lang: String,

    /// 翻译引擎
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,

    /// 使用的模型
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,

    /// 是否收藏
    #[serde(default)]
    pub is_favorite: bool,

    /// 质量评分（1-5）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality_rating: Option<i32>,

    /// 创建时间
    pub created_at: String,

    /// 更新时间
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,

    /// 元数据
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,

    /// 🔧 P0-08 修复: 源文本（从 resources.data 中解析）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_text: Option<String>,

    /// 🔧 P0-08 修复: 译文（从 resources.data 中解析）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translated_text: Option<String>,
}

fn default_src_lang() -> String {
    "auto".to_string()
}

fn default_tgt_lang() -> String {
    "zh".to_string()
}

impl VfsTranslation {
    /// 生成翻译 ID
    pub fn generate_id() -> String {
        format!("tr_{}", nanoid::nanoid!(10))
    }
}

// ============================================================================
// 作文批改元数据
// ============================================================================

// ============================================================================
// 知识导图元数据
// ============================================================================

/// VFS 知识导图元数据（mindmaps 表）
///
/// 知识导图内容（MindMapDocument JSON）存在 resources.data
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsMindMap {
    /// 知识导图 ID（格式：`mm_{nanoid(10)}`）
    pub id: String,

    /// 资源 ID（内容存 resources）
    pub resource_id: String,

    /// 标题
    pub title: String,

    /// 描述/摘要
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// 是否收藏
    #[serde(default)]
    pub is_favorite: bool,

    /// 默认视图：'outline' | 'mindmap'
    #[serde(default = "default_mindmap_view")]
    pub default_view: String,

    /// 主题标识
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,

    /// 其他设置（JSON）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<Value>,

    /// 创建时间
    pub created_at: String,

    /// 更新时间
    pub updated_at: String,

    /// 软删除时间
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
}

fn default_mindmap_view() -> String {
    "mindmap".to_string()
}

impl VfsMindMap {
    /// 生成知识导图 ID
    pub fn generate_id() -> String {
        format!("mm_{}", nanoid::nanoid!(10))
    }
}

// ============================================================================
// 思维导图版本
// ============================================================================

/// VFS 思维导图版本（mindmap_versions 表）
///
/// 记录思维导图的历史版本，版本内容通过 resource_id 关联到 resources 表。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsMindMapVersion {
    /// 版本 ID（格式：mv_{nanoid(10)}）
    pub version_id: String,

    /// 思维导图 ID
    pub mindmap_id: String,

    /// 关联的资源 ID（★ 版本内容存 resources.data）
    pub resource_id: String,

    /// 当时的标题
    pub title: String,

    /// 版本标签（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,

    /// 来源：'chat_update' | 'chat_edit_nodes' | 'manual' | 'auto'
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,

    /// 创建时间
    pub created_at: String,
}

impl VfsMindMapVersion {
    /// 生成版本 ID
    pub fn generate_id() -> String {
        format!("mv_{}", nanoid::nanoid!(10))
    }
}

/// 创建知识导图参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsCreateMindMapParams {
    /// 标题
    pub title: String,

    /// 描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// 初始内容（MindMapDocument JSON）
    #[serde(default = "default_mindmap_content")]
    pub content: String,

    /// 默认视图
    #[serde(default = "default_mindmap_view")]
    pub default_view: String,

    /// 主题
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
}

fn default_mindmap_content() -> String {
    r#"{"version":"1.0","root":{"id":"root","text":"根节点","children":[]}}"#.to_string()
}

/// 更新知识导图参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsUpdateMindMapParams {
    /// 新标题
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    /// 新描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// 新内容（MindMapDocument JSON）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,

    /// 新默认视图
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_view: Option<String>,

    /// 新主题
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,

    /// 新设置
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<Value>,

    /// 乐观并发控制：期望的 updated_at（ISO8601）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_updated_at: Option<String>,

    /// 版本来源标记（仅用于版本快照记录，不影响导图本身）
    /// 可选值：'chat_update' | 'chat_edit_nodes' | 'manual' | 'auto'
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_source: Option<String>,
}

// ============================================================================
// 待办列表元数据
// ============================================================================

/// VFS 待办列表元数据（todo_lists 表）
///
/// 每个 TodoList 对应 DSTU 中的一个 "todo" 类型文件，
/// 类比 Todoist 的"项目"概念。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsTodoList {
    /// 待办列表 ID（格式：`tdl_{nanoid(10)}`）
    pub id: String,

    /// 资源 ID（内容存 resources，JSON 摘要）
    pub resource_id: String,

    /// 列表名称
    pub title: String,

    /// 描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// 列表图标
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,

    /// 列表颜色
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,

    /// 排序序号
    #[serde(default)]
    pub sort_order: i32,

    /// 是否为默认收件箱
    #[serde(default)]
    pub is_default: bool,

    /// 是否收藏
    #[serde(default)]
    pub is_favorite: bool,

    /// 创建时间（ISO 8601）
    pub created_at: String,

    /// 更新时间（ISO 8601）
    pub updated_at: String,

    /// 软删除时间
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
}

impl VfsTodoList {
    /// 生成待办列表 ID
    pub fn generate_id() -> String {
        format!("tdl_{}", nanoid::nanoid!(10))
    }
}

/// 待办项（todo_items 表）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsTodoItem {
    /// 待办项 ID（格式：`ti_{nanoid(10)}`）
    pub id: String,

    /// 所属列表 ID
    pub todo_list_id: String,

    /// 标题
    pub title: String,

    /// 详细描述（Markdown）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// 状态：pending | completed | cancelled
    #[serde(default = "default_todo_status")]
    pub status: String,

    /// 优先级：none | low | medium | high | urgent
    #[serde(default = "default_todo_priority")]
    pub priority: String,

    /// 截止日期（YYYY-MM-DD）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,

    /// 截止时间（HH:mm）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_time: Option<String>,

    /// 提醒时间（ISO 8601）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reminder: Option<String>,

    /// 标签列表（JSON 数组）
    #[serde(default = "default_empty_json_array")]
    pub tags_json: String,

    /// 排序序号
    #[serde(default)]
    pub sort_order: i32,

    /// 父任务 ID（子任务支持）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,

    /// 完成时间（ISO 8601）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,

    /// 重复任务配置（JSON）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repeat_json: Option<String>,

    /// 关联 DSTU 资源 ID（JSON 数组）
    #[serde(default = "default_empty_json_array")]
    pub attachments_json: String,

    /// 创建时间（ISO 8601）
    pub created_at: String,

    /// 更新时间（ISO 8601）
    pub updated_at: String,

    /// 软删除时间
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
}

fn default_todo_status() -> String {
    "pending".to_string()
}

fn default_todo_priority() -> String {
    "none".to_string()
}

fn default_empty_json_array() -> String {
    "[]".to_string()
}

impl VfsTodoItem {
    /// 生成待办项 ID
    pub fn generate_id() -> String {
        format!("ti_{}", nanoid::nanoid!(10))
    }
}

/// 创建待办列表参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsCreateTodoListParams {
    /// 列表名称
    pub title: String,

    /// 描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// 图标
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,

    /// 颜色
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,

    /// 是否为默认列表
    #[serde(default)]
    pub is_default: bool,
}

/// 更新待办列表参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsUpdateTodoListParams {
    /// 新标题
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    /// 新描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// 新图标
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,

    /// 新颜色
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// 创建待办项参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsCreateTodoItemParams {
    /// 所属列表 ID
    pub todo_list_id: String,

    /// 标题
    pub title: String,

    /// 描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// 优先级
    #[serde(default = "default_todo_priority")]
    pub priority: String,

    /// 截止日期
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,

    /// 截止时间
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_time: Option<String>,

    /// 标签
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,

    /// 父任务 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,

    /// 关联资源 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<String>>,
}

/// 更新待办项参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsUpdateTodoItemParams {
    /// 新标题
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    /// 新描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// 新状态
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,

    /// 新优先级
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,

    /// 新截止日期
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,

    /// 新截止时间
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_time: Option<String>,

    /// 新提醒时间
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reminder: Option<String>,

    /// 新标签
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,

    /// 新父任务
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,

    /// 新关联资源
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<String>>,

    /// 新重复配置
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repeat_json: Option<String>,
}

/// 活跃待办摘要（用于 System Prompt 注入）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoActiveSummary {
    /// 今日到期的待办
    pub today_items: Vec<TodoSummaryItem>,
    /// 已过期未完成的待办
    pub overdue_items: Vec<TodoSummaryItem>,
    /// 近 3 天到期的高优先级待办
    pub upcoming_high_priority: Vec<TodoSummaryItem>,
    /// 统计
    pub stats: TodoStats,
}

/// 待办摘要条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoSummaryItem {
    pub id: String,
    pub title: String,
    pub priority: String,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub list_title: String,
}

/// 待办统计
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoStats {
    /// 总未完成数
    pub total_pending: usize,
    /// 今日到期数
    pub today_due: usize,
    /// 已过期数
    pub overdue_count: usize,
    /// 今日已完成数
    pub today_completed: usize,
}

// ============================================================================
// 文件夹相关类型（契约 B）
// ============================================================================

/// VFS 文件夹实体（folders 表）
///
/// 用于在 VFS 中维护真实的文件夹层级结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsFolder {
    /// 文件夹 ID（格式：`fld_{nanoid(10)}`）
    pub id: String,

    /// 父文件夹 ID（NULL 表示根级）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,

    /// 标题
    pub title: String,

    /// 可选图标标识
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,

    /// 可选颜色标识
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,

    /// 展开状态
    pub is_expanded: bool,

    /// 是否收藏
    #[serde(default)]
    pub is_favorite: bool,

    /// 同级排序
    pub sort_order: i32,

    /// 创建时间（毫秒时间戳）
    pub created_at: i64,

    /// 更新时间（毫秒时间戳）
    pub updated_at: i64,
}

impl VfsFolder {
    /// 生成文件夹 ID
    pub fn generate_id() -> String {
        format!("fld_{}", nanoid::nanoid!(10))
    }

    /// 创建新文件夹
    ///
    /// # Arguments
    /// * `title` - 文件夹标题
    /// * `parent_id` - 父文件夹 ID
    /// * `icon` - 图标
    /// * `color` - 颜色
    pub fn new(
        title: String,
        parent_id: Option<String>,
        icon: Option<String>,
        color: Option<String>,
    ) -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        Self {
            id: Self::generate_id(),
            parent_id,
            title,
            icon,
            color,
            is_expanded: true,
            is_favorite: false,
            sort_order: 0,
            created_at: now,
            updated_at: now,
        }
    }
}

/// VFS 文件夹内容项（folder_items 表）
///
/// 关联文件夹与资源内容。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsFolderItem {
    /// 内容项 ID（格式：`fi_{nanoid(10)}`）
    pub id: String,

    /// 所属文件夹（NULL 表示根级）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,

    /// 资源类型：'note'|'textbook'|'exam'|'translation'|'essay'
    pub item_type: String,

    /// 资源 ID（note_xxx, tb_xxx 等）
    pub item_id: String,

    /// 排序
    pub sort_order: i32,

    /// 创建时间（毫秒时间戳）
    pub created_at: i64,

    /// ★ 缓存的完整路径（格式："/根文件夹/子文件夹/资源名称"）
    /// 迁移 005 新增，用于支持路径缓存和快速查询
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_path: Option<String>,
}

impl VfsFolderItem {
    /// 生成内容项 ID
    pub fn generate_id() -> String {
        format!("fi_{}", nanoid::nanoid!(10))
    }

    /// 创建新内容项
    ///
    /// # 参数
    /// - `folder_id`: 所属文件夹 ID（None 表示根级）
    /// - `item_type`: 资源类型（note, textbook, exam, translation, essay）
    /// - `item_id`: 资源 ID
    pub fn new(folder_id: Option<String>, item_type: String, item_id: String) -> Self {
        Self {
            id: Self::generate_id(),
            folder_id,
            item_type,
            item_id,
            sort_order: 0,
            created_at: chrono::Utc::now().timestamp_millis(),
            cached_path: None,
        }
    }

    /// 创建新内容项（带缓存路径）
    ///
    /// # 参数
    /// - `folder_id`: 所属文件夹 ID（None 表示根级）
    /// - `item_type`: 资源类型（note, textbook, exam, translation, essay）
    /// - `item_id`: 资源 ID
    /// - `cached_path`: 缓存的完整路径
    pub fn new_with_path(
        folder_id: Option<String>,
        item_type: String,
        item_id: String,
        cached_path: Option<String>,
    ) -> Self {
        Self {
            id: Self::generate_id(),
            folder_id,
            item_type,
            item_id,
            sort_order: 0,
            created_at: chrono::Utc::now().timestamp_millis(),
            cached_path,
        }
    }
}

/// VFS 文件夹树节点（含子文件夹和内容）
///
/// 用于构建和返回完整的文件夹树结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTreeNode {
    /// 文件夹信息
    pub folder: VfsFolder,

    /// 子文件夹
    pub children: Vec<FolderTreeNode>,

    /// 文件夹内容项
    pub items: Vec<VfsFolderItem>,
}

/// 文件夹资源聚合结果（上下文注入用）
///
/// 用于 Chat V2 上下文注入，包含文件夹内所有资源的详细信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderResourcesResult {
    /// 文件夹 ID
    pub folder_id: String,

    /// 文件夹标题
    pub folder_title: String,

    /// 文件夹完整路径，如 "高考复习/函数"
    pub path: String,

    /// 资源总数
    pub total_count: usize,

    /// 资源列表
    pub resources: Vec<FolderResourceInfo>,
}

/// 文件夹内的资源信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderResourceInfo {
    /// 资源类型
    pub item_type: String,

    /// 资源 ID
    pub item_id: String,

    /// resources 表 ID（如有）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,

    /// 标题
    pub title: String,

    /// 资源在文件夹树中的路径
    pub path: String,

    /// 资源内容（按需加载）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

impl FolderTreeNode {
    /// 创建新树节点
    pub fn new(folder: VfsFolder) -> Self {
        Self {
            folder,
            children: Vec::new(),
            items: Vec::new(),
        }
    }
}

// ============================================================================
// 迁移结果（契约 B5）
// ============================================================================

/// 文件夹迁移结果
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FolderMigrationResult {
    /// 迁移的文件夹数量
    pub folders_migrated: usize,

    /// 迁移的内容项数量
    pub items_migrated: usize,

    /// 迁移的引用节点数量
    pub references_migrated: usize,

    /// 错误列表
    pub errors: Vec<String>,
}

/// 迁移状态检查结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderMigrationStatus {
    /// 是否需要迁移
    pub needs_migration: bool,

    /// Preference 中是否有旧数据
    pub has_old_data: bool,

    /// VFS 中是否已有数据
    pub has_new_data: bool,

    /// 旧文件夹数量
    pub old_folder_count: usize,

    /// 旧内容数量
    pub old_item_count: usize,
}

// ============================================================================
// 作文批改元数据
// ============================================================================

/// VFS 作文批改元数据（essays 表）
///
/// 作文原文存 resources.data，批改结果存本表。
/// 支持多轮迭代：同一会话的多轮通过 session_id 关联。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsEssay {
    /// 作文 ID（格式：`essay_{nanoid(10)}`）
    pub id: String,

    /// 资源 ID（内容存 resources）
    pub resource_id: String,

    /// 标题
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    /// 作文类型
    #[serde(skip_serializing_if = "Option::is_none")]
    pub essay_type: Option<String>,

    /// 批改结果（JSON）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grading_result: Option<Value>,

    /// 分数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<i32>,

    // ★ 会话相关字段（2025-12-07）
    /// 会话 ID（关联多轮）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,

    /// 轮次编号
    #[serde(default = "default_round_number")]
    pub round_number: i32,

    /// 学段（middle_school, high_school, college）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grade_level: Option<String>,

    /// 自定义 Prompt
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_prompt: Option<String>,

    /// 是否收藏
    #[serde(default)]
    pub is_favorite: bool,

    /// 维度评分（JSON）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dimension_scores: Option<Value>,

    /// 创建时间
    pub created_at: String,

    /// 更新时间
    pub updated_at: String,
}

fn default_round_number() -> i32 {
    1
}

impl VfsEssay {
    /// 生成作文 ID
    pub fn generate_id() -> String {
        format!("essay_{}", nanoid::nanoid!(10))
    }

    /// 生成会话 ID
    pub fn generate_session_id() -> String {
        format!("essay_session_{}", nanoid::nanoid!(10))
    }
}

/// VFS 作文会话元数据（essay_sessions 表）
///
/// 记录会话级别的汇总信息，便于列表展示。
/// 注意：使用 snake_case 序列化以匹配前端 GradingSession 类型
///
/// ★ 2025-01-01: essay_type 和 grade_level 始终序列化为字符串（空字符串或有值），
///   确保前端类型匹配。custom_prompt 仍然使用 Option（前端期望 string | null）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct VfsEssaySession {
    /// 会话 ID
    pub id: String,

    /// 会话标题
    pub title: String,

    /// 作文类型（始终输出，默认空字符串）
    #[serde(default, serialize_with = "serialize_option_string_as_string")]
    pub essay_type: Option<String>,

    /// 学段（始终输出，默认空字符串）
    #[serde(default, serialize_with = "serialize_option_string_as_string")]
    pub grade_level: Option<String>,

    /// 自定义 Prompt（可选，前端期望 string | null）
    pub custom_prompt: Option<String>,

    /// 总轮次数
    pub total_rounds: i32,

    /// 最新分数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_score: Option<i32>,

    /// 是否收藏
    #[serde(default)]
    pub is_favorite: bool,

    /// 创建时间
    pub created_at: String,

    /// 更新时间
    pub updated_at: String,

    /// 软删除时间（回收站）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
}

/// 更新作文会话参数（仅包含可变字段，避免前端传递完整 VfsEssaySession）
///
/// ★ M-061 修复：前端只需传递 id + 要修改的字段，不再需要 created_at / updated_at / total_rounds 等只读字段
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct VfsUpdateEssaySessionParams {
    /// 会话 ID（必需）
    pub id: String,

    /// 会话标题
    #[serde(default)]
    pub title: Option<String>,

    /// 是否收藏
    #[serde(default)]
    pub is_favorite: Option<bool>,

    /// 作文类型
    #[serde(default)]
    pub essay_type: Option<String>,

    /// 学段
    #[serde(default)]
    pub grade_level: Option<String>,

    /// 自定义 Prompt
    #[serde(default)]
    pub custom_prompt: Option<String>,
}

/// 创建作文会话参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsCreateEssaySessionParams {
    /// 会话标题
    pub title: String,

    /// 作文类型
    #[serde(skip_serializing_if = "Option::is_none")]
    pub essay_type: Option<String>,

    /// 学段
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grade_level: Option<String>,

    /// 自定义 Prompt
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_prompt: Option<String>,
}

// ============================================================================
// 大文件元数据
// ============================================================================

/// VFS 大文件元数据（blobs 表）
///
/// 大文件（如 PDF）的实际内容存储在文件系统，本表存储元数据。
/// 存储路径：`app_data_dir/vfs_blobs/{sha256_prefix}/{sha256}.{ext}`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsBlob {
    /// SHA-256 哈希（主键）
    pub hash: String,

    /// 相对路径（相对于 vfs_blobs 目录）
    pub relative_path: String,

    /// 文件大小（字节）
    pub size: i64,

    /// MIME 类型
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,

    /// 引用计数
    pub ref_count: i32,

    /// 创建时间（毫秒时间戳）
    pub created_at: i64,
}

impl VfsBlob {
    /// 根据哈希生成相对路径
    ///
    /// 格式：`{hash[0..2]}/{hash}.{ext}`
    pub fn generate_relative_path(hash: &str, extension: Option<&str>) -> String {
        let prefix = if hash.len() >= 2 { &hash[0..2] } else { hash };
        match extension {
            Some(ext) => format!("{}/{}.{}", prefix, hash, ext),
            None => format!("{}/{}", prefix, hash),
        }
    }
}

// ============================================================================
// 附件元数据
// ============================================================================

/// VFS 附件元数据（attachments 表）
///
/// 用于存储图片和文档附件。支持两种存储模式：
/// - 小文件（<1MB）：内容存储在 resources.data
/// - 大文件（>=1MB）：内容存储在 blobs 表
///
/// 基于 content_hash 实现去重：相同内容只存储一次。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsAttachment {
    /// 附件 ID（格式：`att_{nanoid(10)}`）
    pub id: String,

    /// 资源 ID（小文件内容存 resources，inline 模式）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,

    /// Blob 哈希（大文件内容指向 blobs，external 模式）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob_hash: Option<String>,

    /// 附件类型：'image' | 'file'
    #[serde(rename = "type")]
    pub attachment_type: String,

    /// 文件名
    pub name: String,

    /// MIME 类型
    pub mime_type: String,

    /// 文件大小（字节）
    pub size: i64,

    /// 内容哈希（SHA-256，用于去重）
    pub content_hash: String,

    /// 是否收藏
    #[serde(default)]
    pub is_favorite: bool,

    /// 创建时间
    pub created_at: String,

    /// 更新时间
    pub updated_at: String,

    // ========================================================================
    // PDF 预渲染字段（迁移 015）
    // ========================================================================
    /// PDF 预渲染数据（JSON 格式，存储每页图片的 blob_hash）
    /// 参考 exam_sheets.preview_json 结构
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_json: Option<String>,

    /// PDF 提取的文本内容（用于文本模式上下文注入）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extracted_text: Option<String>,

    /// PDF 总页数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_count: Option<i32>,

    // ========================================================================
    // 软删除字段（迁移 016）
    // ========================================================================
    /// 🔧 P0-12 修复：软删除时间戳（ISO 8601 格式）
    /// 非空时表示已删除，可通过 restore 恢复
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
}

impl VfsAttachment {
    /// 生成附件 ID
    pub fn generate_id() -> String {
        format!("att_{}", nanoid::nanoid!(10))
    }
}

// ============================================================================
// 统一文件类型（合并 VfsTextbook 和 VfsAttachment）
// ============================================================================

/// 文件类型枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileType {
    Document,
    Image,
    Audio,
    Video,
}

impl FileType {
    pub fn as_str(&self) -> &'static str {
        match self {
            FileType::Document => "document",
            FileType::Image => "image",
            FileType::Audio => "audio",
            FileType::Video => "video",
        }
    }
}

/// VFS 统一文件元数据（合并 textbooks 和 attachments）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsFile {
    /// 文件 ID（格式：`file_{nanoid(10)}`）
    pub id: String,

    /// 资源 ID（元信息资源）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,

    /// Blob 哈希（大文件内容指向 blobs）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob_hash: Option<String>,

    /// 内容哈希（SHA-256，用于去重）
    pub sha256: String,

    /// 文件名
    pub file_name: String,

    /// 原始导入路径
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,

    /// 文件大小（字节）
    pub size: i64,

    /// 页数（PDF/文档类型）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_count: Option<i32>,

    /// 文件类型：document/image/audio/video
    pub file_type: String,

    /// MIME 类型
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,

    /// 标签
    #[serde(default)]
    pub tags: Vec<String>,

    /// 是否收藏
    #[serde(default)]
    pub is_favorite: bool,

    /// 最后打开时间
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_opened_at: Option<String>,

    /// 最后阅读页
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_page: Option<i32>,

    /// 书签
    #[serde(default)]
    pub bookmarks: Vec<Value>,

    /// 封面缓存键
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_key: Option<String>,

    /// 提取的文本内容
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extracted_text: Option<String>,

    /// 预览数据（JSON 格式）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_json: Option<String>,

    /// OCR 页面数据（JSON 格式）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ocr_pages_json: Option<String>,

    /// 描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// 状态
    #[serde(default = "default_status")]
    pub status: String,

    /// 创建时间
    pub created_at: String,

    /// 更新时间
    pub updated_at: String,

    /// 软删除时间戳
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,

    // ========================================================================
    // PDF 预处理流水线字段（迁移 V20260204）
    // ========================================================================
    /// 处理状态
    /// 可选值: pending | text_extraction | page_rendering | ocr_processing | vector_indexing | completed | error
    #[serde(skip_serializing_if = "Option::is_none")]
    pub processing_status: Option<String>,

    /// 处理进度 JSON
    /// 格式: {"stage":"page_rendering","current_page":10,"total_pages":50,"percent":20.0,"ready_modes":["text"]}
    #[serde(skip_serializing_if = "Option::is_none")]
    pub processing_progress: Option<String>,

    /// 处理错误信息（error 状态时填充）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub processing_error: Option<String>,

    /// 处理开始时间戳（毫秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub processing_started_at: Option<i64>,

    /// 处理完成时间戳（毫秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub processing_completed_at: Option<i64>,

    // ========================================================================
    // 压缩图片字段（P0 架构改造）
    // ========================================================================
    /// 压缩后的 Blob 哈希
    /// 预处理阶段生成的低质量压缩版本，发送时直接使用此版本
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compressed_blob_hash: Option<String>,
}

impl VfsFile {
    /// 生成文件 ID
    pub fn generate_id() -> String {
        format!("file_{}", nanoid::nanoid!(10))
    }

    /// 根据 MIME 类型推断文件类型
    pub fn infer_file_type(mime_type: &str) -> &'static str {
        if mime_type.starts_with("image/") {
            "image"
        } else if mime_type.starts_with("audio/") {
            "audio"
        } else if mime_type.starts_with("video/") {
            "video"
        } else {
            "document"
        }
    }
}

/// 上传附件参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsUploadAttachmentParams {
    /// 文件名
    pub name: String,

    /// MIME 类型
    pub mime_type: String,

    /// Base64 编码的文件内容
    pub base64_content: String,

    /// 附件类型：'image' | 'file'（可选，自动推断）
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub attachment_type: Option<String>,
}

/// 上传附件结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsUploadAttachmentResult {
    /// 附件 ID（sourceId）
    pub source_id: String,

    /// 资源哈希（用于版本标识）
    pub resource_hash: String,

    /// 是否新创建（false 表示复用已有附件）
    pub is_new: bool,

    /// 附件元数据
    pub attachment: VfsAttachment,

    /// 处理状态（用于 PDF/图片预处理流水线）
    /// v2.1 新增：返回实际处理状态，避免前端设置错误的初始状态
    #[serde(skip_serializing_if = "Option::is_none")]
    pub processing_status: Option<String>,

    /// 处理进度百分比
    #[serde(skip_serializing_if = "Option::is_none")]
    pub processing_percent: Option<f32>,

    /// 已就绪的模式列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ready_modes: Option<Vec<String>>,
}

// ============================================================================
// 预览类型
// ============================================================================

/// 预览类型枚举
///
/// ★ T09 扩展：添加富文档预览类型（docx/xlsx/pptx/text）
/// ★ 2026-01-30 扩展：添加音视频预览类型（audio/video）
/// 与前端 `ResourceListItem['previewType']` 保持一致
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreviewType {
    /// Markdown 预览
    Markdown,
    /// PDF 预览
    Pdf,
    /// 卡片预览
    Card,
    /// 图片预览
    Image,
    /// Word 文档预览（docx）
    Docx,
    /// Excel 表格预览（xlsx/xls/ods）
    Xlsx,
    /// PowerPoint 演示文稿预览（pptx）
    Pptx,
    /// 纯文本预览（txt/md/html/csv/json 等）
    Text,
    /// 音频预览（mp3/wav/ogg/m4a/flac/aac）
    Audio,
    /// 视频预览（mp4/webm/mov/avi/mkv）
    Video,
    /// 无预览
    None,
}

impl Default for PreviewType {
    fn default() -> Self {
        PreviewType::None
    }
}

impl std::fmt::Display for PreviewType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PreviewType::Markdown => write!(f, "markdown"),
            PreviewType::Pdf => write!(f, "pdf"),
            PreviewType::Card => write!(f, "card"),
            PreviewType::Image => write!(f, "image"),
            PreviewType::Docx => write!(f, "docx"),
            PreviewType::Xlsx => write!(f, "xlsx"),
            PreviewType::Pptx => write!(f, "pptx"),
            PreviewType::Text => write!(f, "text"),
            PreviewType::Audio => write!(f, "audio"),
            PreviewType::Video => write!(f, "video"),
            PreviewType::None => write!(f, "none"),
        }
    }
}

impl PreviewType {
    /// 从文件扩展名推断预览类型
    ///
    /// ★ T09 新增：统一的扩展名到预览类型映射
    /// ★ 2026-01-30 扩展：添加音视频扩展名支持
    pub fn from_extension(ext: &str) -> Self {
        match ext.to_lowercase().as_str() {
            // PDF
            "pdf" => PreviewType::Pdf,
            // Word 文档
            "docx" => PreviewType::Docx,
            // Excel 表格
            "xlsx" | "xls" | "ods" | "xlsb" => PreviewType::Xlsx,
            // PowerPoint 演示文稿
            "pptx" => PreviewType::Pptx,
            // 图片
            "jpg" | "jpeg" | "png" | "gif" | "webp" | "svg" | "bmp" => PreviewType::Image,
            // 音频
            "mp3" | "wav" | "ogg" | "m4a" | "flac" | "aac" | "wma" | "opus" => PreviewType::Audio,
            // 视频
            "mp4" | "webm" | "mov" | "avi" | "mkv" | "m4v" | "wmv" | "flv" => PreviewType::Video,
            // 文本类型
            "txt" | "md" | "markdown" | "html" | "htm" | "csv" | "json" | "xml" | "rtf"
            | "epub" => PreviewType::Text,
            // 默认无预览
            _ => PreviewType::None,
        }
    }

    /// 从文件名推断预览类型
    pub fn from_filename(filename: &str) -> Self {
        filename
            .rsplit('.')
            .next()
            .map(|ext| Self::from_extension(ext))
            .unwrap_or(PreviewType::None)
    }
}

// ============================================================================
// 列表项统一格式
// ============================================================================

/// VFS 列表项（统一格式）
///
/// 用于 Learning Hub 等列表展示。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsListItem {
    /// 原始数据 ID
    pub id: String,

    /// 资源 ID
    pub resource_id: String,

    /// 资源类型
    #[serde(rename = "type")]
    pub resource_type: VfsResourceType,

    /// 标题
    pub title: String,

    /// 预览类型
    pub preview_type: PreviewType,

    /// 创建时间（毫秒时间戳）
    pub created_at: i64,

    /// 更新时间（毫秒时间戳）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,

    /// 元数据
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<VfsResourceMetadata>,
}

// ============================================================================
// 输入参数类型
// ============================================================================

/// 创建笔记参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsCreateNoteParams {
    /// 标题
    pub title: String,

    /// 内容
    pub content: String,

    /// 标签
    #[serde(default)]
    pub tags: Vec<String>,
}

/// 更新笔记参数
///
/// 所有字段都是可选的，允许部分更新（只更新提供的字段）。
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VfsUpdateNoteParams {
    /// 新内容（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,

    /// 新标题（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    /// 新标签（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,

    /// 乐观锁：调用方上次读取时的 `updated_at` 值（可选）
    ///
    /// ★ S-002 修复：如果提供此字段且非空，`update_note` 会在写入前检查当前记录的
    /// `updated_at` 是否与之匹配。不匹配则返回 `VfsError::Conflict`，防止后写覆盖先写。
    /// 不提供或为空时行为不变（向后兼容）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_updated_at: Option<String>,
}

/// 创建资源参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsCreateResourceParams {
    /// 资源类型
    #[serde(rename = "type")]
    pub resource_type: String,

    /// 内容
    pub data: String,

    /// 原始数据 ID（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,

    /// 元数据（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<VfsResourceMetadata>,
}

/// 列表查询参数
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VfsListParams {
    /// 资源类型过滤（可选）
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub resource_type: Option<VfsResourceType>,

    /// 搜索关键词（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
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

/// 搜索所有资源参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsSearchAllParams {
    /// 搜索关键词
    pub query: String,

    /// 类型过滤（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub types: Option<Vec<String>>,

    /// 限制数量
    #[serde(default = "default_limit")]
    pub limit: u32,

    /// 偏移量
    #[serde(default)]
    pub offset: u32,
}

/// 创建题目集识别参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsCreateExamSheetParams {
    /// 考试名称（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exam_name: Option<String>,

    /// 临时会话 ID
    pub temp_id: String,

    /// 识别元数据（JSON）
    pub metadata_json: Value,

    /// 预览数据（JSON，存入 resources.data）
    pub preview_json: Value,

    /// 状态（默认 pending）
    #[serde(default = "default_exam_status")]
    pub status: String,

    /// ★ VFS 文件夹 ID（可选，用于添加到文件夹）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
}

fn default_exam_status() -> String {
    "pending".to_string()
}

/// 创建翻译参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsCreateTranslationParams {
    /// 翻译标题/名称（可选，用于重命名）
    /// ★ 2025-12-25: 添加 title 字段，修复名称不匹配问题
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    /// 源文本
    pub source: String,

    /// 译文
    pub translated: String,

    /// 源语言（默认 auto）
    #[serde(default = "default_src_lang")]
    pub src_lang: String,

    /// 目标语言（默认 zh）
    #[serde(default = "default_tgt_lang")]
    pub tgt_lang: String,

    /// 翻译引擎（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,

    /// 使用的模型（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// 创建作文参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsCreateEssayParams {
    /// 标题（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    /// 作文类型（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub essay_type: Option<String>,

    /// 作文内容
    pub content: String,

    /// 批改结果（可选，JSON）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grading_result: Option<Value>,

    /// 分数（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<i32>,

    // ★ 会话相关字段（2025-12-07）
    /// 会话 ID（可选，用于多轮关联）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,

    /// 轮次编号（默认 1）
    #[serde(default = "default_round_number")]
    pub round_number: i32,

    /// 学段
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grade_level: Option<String>,

    /// 自定义 Prompt
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_prompt: Option<String>,

    /// 维度评分（JSON）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dimension_scores: Option<Value>,
}

// ============================================================================
// 引用模式类型（契约 B - Prompt 2）
// ============================================================================

/// 图片注入模式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageInjectMode {
    /// 注入原始图片（多模态模型可用）
    Image,
    /// 注入 OCR 识别的文本
    Ocr,
}

/// PDF 注入模式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PdfInjectMode {
    /// 注入解析提取的文本
    Text,
    /// 注入 OCR 识别的文本（按页）
    Ocr,
    /// 注入页面图片（多模态模型可用）
    Image,
}

/// 资源注入模式配置
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceInjectModes {
    /// 图片注入模式（支持多选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<Vec<ImageInjectMode>>,
    /// PDF 注入模式（支持多选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf: Option<Vec<PdfInjectMode>>,
}

// ============================================================================
// ★ 3.3 修复：统一默认注入模式策略（SSOT）
//
// ref_handlers.rs 和 vfs_resolver.rs 共享同一默认值，
// 确保首次发送与编辑重发的行为一致。
// 默认最大化策略：给模型尽可能多的信息。
// ============================================================================

/// 解析图片注入模式，返回 (include_image, include_ocr, downgraded_non_multimodal)
///
/// 当用户未显式选择模式时，使用最大化默认值 (image + ocr)。
/// 非多模态模型自动降级：移除 image 模式。
pub fn resolve_image_inject_modes(
    image_modes: Option<&Vec<ImageInjectMode>>,
    is_multimodal: bool,
) -> (bool, bool, bool) {
    let (mut include_image, include_ocr) = match image_modes {
        Some(modes) if !modes.is_empty() => (
            modes.contains(&ImageInjectMode::Image),
            modes.contains(&ImageInjectMode::Ocr),
        ),
        // 默认最大化：图片 + OCR 同时注入
        _ => (true, true),
    };

    let downgraded_non_multimodal = !is_multimodal && include_image;
    if downgraded_non_multimodal {
        include_image = false;
    }
    (include_image, include_ocr, downgraded_non_multimodal)
}

/// 解析 PDF 注入模式，返回 (include_text, include_ocr, include_image, downgraded_non_multimodal)
///
/// 当用户未显式选择模式时，使用最大化默认值 (text + ocr + image)。
/// 非多模态模型自动降级：移除 image 模式。
pub fn resolve_pdf_inject_modes(
    pdf_modes: Option<&Vec<PdfInjectMode>>,
    is_multimodal: bool,
) -> (bool, bool, bool, bool) {
    let (include_text, include_ocr, mut include_image) = match pdf_modes {
        Some(modes) if !modes.is_empty() => (
            modes.contains(&PdfInjectMode::Text),
            modes.contains(&PdfInjectMode::Ocr),
            modes.contains(&PdfInjectMode::Image),
        ),
        // 默认最大化：text + ocr + image
        _ => (true, true, true),
    };

    let downgraded_non_multimodal = !is_multimodal && include_image;
    if downgraded_non_multimodal {
        include_image = false;
    }
    (
        include_text,
        include_ocr,
        include_image,
        downgraded_non_multimodal,
    )
}

/// VFS 资源引用（用于引用模式上下文注入）
///
/// 存储 sourceId + resourceHash 的轻量级引用，发送时动态解析。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsResourceRef {
    /// 稳定业务 ID（note_xxx, tb_xxx, exam_xxx 等）
    pub source_id: String,

    /// 资源内容哈希（用于版本追踪）
    pub resource_hash: String,

    /// 资源类型
    #[serde(rename = "type")]
    pub resource_type: VfsResourceType,

    /// 资源名称/标题
    pub name: String,

    /// 可选的资源主键（res_xxx），用于 source_id 不可解析时兜底
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,

    /// 可选检索片段（retrieval 兜底注入）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,

    /// 用户选择的注入模式（可选，不传则使用默认模式）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inject_modes: Option<ResourceInjectModes>,
}

/// VFS 上下文引用数据（批量引用的容器）
///
/// 用于前端发送多个资源引用到后端。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsContextRefData {
    /// 资源引用列表
    pub refs: Vec<VfsResourceRef>,

    /// 是否被截断（超过 max_items 时为 true）
    #[serde(default)]
    pub truncated: bool,

    /// 原始请求的资源数量
    #[serde(default)]
    pub total_count: usize,
}

impl Default for VfsContextRefData {
    fn default() -> Self {
        Self {
            refs: Vec::new(),
            truncated: false,
            total_count: 0,
        }
    }
}

/// 解析后的资源（发送时动态获取）
///
/// 包含资源的完整路径和内容。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedResource {
    /// 稳定业务 ID
    pub source_id: String,

    /// 资源内容哈希
    pub resource_hash: String,

    /// 资源类型
    #[serde(rename = "type")]
    pub resource_type: VfsResourceType,

    /// 资源名称/标题
    pub name: String,

    /// 资源在文件夹树中的完整路径（如 "高考复习/函数/笔记标题"）
    pub path: String,

    /// 资源内容
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,

    /// 资源是否存在（true = 找到，false = 已删除/不存在）
    pub found: bool,

    /// 资源解析警告信息（如 PDF 文本提取失败等非致命错误）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,

    /// ★ 多模态内容块（文档25扩展）
    ///
    /// 对于题目集识别（exam）类型，如果请求多模态内容，这里存储图文交替的 ContentBlock[]。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multimodal_blocks: Option<Vec<MultimodalContentBlock>>,
}

/// 多模态内容块（用于 ResolvedResource 的图文混合内容）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultimodalContentBlock {
    /// 内容类型：text 或 image
    #[serde(rename = "type")]
    pub block_type: String,
    /// 文本内容（type=text 时）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// 图片 MIME 类型（type=image 时）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    /// 图片 base64 数据（type=image 时）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
}

impl MultimodalContentBlock {
    /// 创建文本块
    pub fn text(content: String) -> Self {
        Self {
            block_type: "text".to_string(),
            text: Some(content),
            media_type: None,
            base64: None,
        }
    }

    /// 创建图片块
    pub fn image(media_type: String, base64: String) -> Self {
        Self {
            block_type: "image".to_string(),
            text: None,
            media_type: Some(media_type),
            base64: Some(base64),
        }
    }
}

/// 获取资源引用的输入参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetResourceRefsInput {
    /// 资源 ID 列表（sourceId 格式，如 note_xxx, tb_xxx）
    pub source_ids: Vec<String>,

    /// 是否包含文件夹内容（如果 sourceId 是文件夹 ID）
    #[serde(default)]
    pub include_folder_contents: bool,

    /// 最大返回项数（默认 50）
    #[serde(default = "default_max_items")]
    pub max_items: u32,
}

fn default_max_items() -> u32 {
    50
}

// ============================================================================
// 文件夹错误码（契约 H）
// ============================================================================

/// 文件夹相关错误码
pub mod folder_errors {
    /// 文件夹不存在
    pub const NOT_FOUND: &str = "FOLDER_NOT_FOUND";
    /// 文件夹已存在（幂等检查）
    pub const ALREADY_EXISTS: &str = "FOLDER_ALREADY_EXISTS";
    /// 超过最大深度
    pub const DEPTH_EXCEEDED: &str = "FOLDER_DEPTH_EXCEEDED";
    /// 内容项不存在
    pub const ITEM_NOT_FOUND: &str = "FOLDER_ITEM_NOT_FOUND";
    /// 迁移失败
    pub const MIGRATION_FAILED: &str = "MIGRATION_FAILED";
    /// 无效的父文件夹
    pub const INVALID_PARENT: &str = "INVALID_PARENT";
    /// 文件夹数量超限
    pub const COUNT_EXCEEDED: &str = "FOLDER_COUNT_EXCEEDED";
}

// ============================================================================
// 文件夹约束常量（契约 F）
// ============================================================================

/// 最大文件夹深度
pub const MAX_FOLDER_DEPTH: usize = 10;

/// 最大文件夹数量
pub const MAX_FOLDERS_COUNT: usize = 500;

/// 单文件夹最大内容数
pub const MAX_ITEMS_PER_FOLDER: usize = 1000;

/// 文件夹名称最大长度
pub const MAX_FOLDER_TITLE_LENGTH: usize = 100;

/// 批量注入最大资源数
pub const MAX_BATCH_INJECT_RESOURCES: usize = 50;

// ============================================================================
// 资源定位类型（契约 C3 - Prompt 4）
// ============================================================================

/// 资源定位信息（契约 C3）
///
/// 用于获取资源在 VFS 文件夹树中的完整位置信息。
/// 此类型替代了基于 subject 的资源定位方式。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceLocation {
    /// 资源唯一 ID（note_xxx, tb_xxx, exam_xxx 等）
    pub id: String,

    /// 资源类型（note, textbook, exam, translation, essay）
    pub resource_type: String,

    /// 所在文件夹 ID（None 表示根目录）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,

    /// 文件夹路径（如 "高考复习/函数"，根目录为 ""）
    pub folder_path: String,

    /// 完整路径（如 "高考复习/函数/笔记标题"）
    pub full_path: String,

    /// 内容哈希（如有，用于版本追踪）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}

impl ResourceLocation {
    /// 创建根目录下的资源定位
    pub fn at_root(id: String, resource_type: String, name: String, hash: Option<String>) -> Self {
        Self {
            id,
            resource_type,
            folder_id: None,
            folder_path: String::new(),
            full_path: name,
            hash,
        }
    }

    /// 创建指定文件夹下的资源定位
    pub fn in_folder(
        id: String,
        resource_type: String,
        folder_id: String,
        folder_path: String,
        name: String,
        hash: Option<String>,
    ) -> Self {
        let full_path = if folder_path.is_empty() {
            name
        } else {
            format!("{}/{}", folder_path, name)
        };
        Self {
            id,
            resource_type,
            folder_id: Some(folder_id),
            folder_path,
            full_path,
            hash,
        }
    }
}

// ============================================================================
// 旧数据结构（契约 E 的 Rust 版本，迁移用）
// ============================================================================

/// 旧文件夹结构（存储在 Preference: notes_folders:{subject}）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OldFolderStructure {
    /// 文件夹映射
    pub folders: std::collections::HashMap<String, OldFolder>,

    /// 根级子项 ID 列表
    #[serde(rename = "rootChildren")]
    pub root_children: Vec<String>,

    /// 引用节点（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub references: Option<std::collections::HashMap<String, OldReferenceNode>>,
}

/// 旧文件夹数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OldFolder {
    /// 标题
    pub title: String,

    /// 子项 ID 列表
    pub children: Vec<String>,
}

/// 旧引用节点
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OldReferenceNode {
    /// 源数据库（"textbooks" | "mistakes" | "chat_v2"）
    pub source_db: String,

    /// 源 ID
    pub source_id: String,

    /// 标题
    pub title: String,

    /// 图标（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,

    /// 预览类型
    pub preview_type: String,

    /// 创建时间
    pub created_at: i64,
}

// ============================================================================
// PDF 预渲染类型（迁移 015）
// ============================================================================

/// PDF 预渲染数据（存储在 attachments.preview_json）
///
/// 参考 exam_sheets.preview_json 结构设计，用于支持 PDF 多模态上下文注入。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPreviewJson {
    /// 每页的预渲染数据
    pub pages: Vec<PdfPagePreview>,

    /// 渲染 DPI
    pub render_dpi: u32,

    /// PDF 总页数
    pub total_pages: usize,

    /// 渲染时间
    pub rendered_at: String,

    /// S-028 修复：是否因页数超限而截断渲染
    /// 当 total_pages > max_rendered_pages 时为 true，前端可据此显示截断提示
    #[serde(default)]
    pub is_truncated: bool,

    /// S-028 修复：本次渲染的最大页数上限
    /// 对应 PdfPreviewConfig.max_pages，前端可用此值显示 "仅渲染前 N 页"
    #[serde(default)]
    pub max_rendered_pages: usize,
}

/// PDF 单页预渲染数据
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPagePreview {
    /// 页码（0-indexed）
    pub page_index: usize,

    /// 图片的 blob hash（指向 blobs 表）
    pub blob_hash: String,

    /// 图片宽度（像素）
    pub width: u32,

    /// 图片高度（像素）
    pub height: u32,

    /// 图片 MIME 类型
    pub mime_type: String,

    /// ★ P0 架构改造：压缩后的 blob hash
    /// 预处理阶段生成的低质量压缩版本，发送时优先使用此版本
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compressed_blob_hash: Option<String>,
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vfs_resource_type_serialization() {
        // 验证序列化为小写字符串
        assert_eq!(
            serde_json::to_string(&VfsResourceType::Note).unwrap(),
            "\"note\""
        );
        assert_eq!(
            serde_json::to_string(&VfsResourceType::Textbook).unwrap(),
            "\"textbook\""
        );
        assert_eq!(
            serde_json::to_string(&VfsResourceType::Translation).unwrap(),
            "\"translation\""
        );
    }

    #[test]
    fn test_vfs_resource_type_from_str() {
        assert_eq!(
            VfsResourceType::from_str("note"),
            Some(VfsResourceType::Note)
        );
        assert_eq!(
            VfsResourceType::from_str("TEXTBOOK"),
            Some(VfsResourceType::Textbook)
        );
        assert_eq!(VfsResourceType::from_str("invalid"), None);
    }

    #[test]
    fn test_storage_mode_serialization() {
        assert_eq!(
            serde_json::to_string(&StorageMode::Inline).unwrap(),
            "\"inline\""
        );
        assert_eq!(
            serde_json::to_string(&StorageMode::External).unwrap(),
            "\"external\""
        );
    }

    #[test]
    fn test_vfs_resource_camel_case() {
        let resource = VfsResource {
            id: "res_abc123".to_string(),
            hash: "sha256hash".to_string(),
            resource_type: VfsResourceType::Note,
            source_id: Some("note_123".to_string()),
            source_table: Some("notes".to_string()),
            storage_mode: StorageMode::Inline,
            data: Some("content".to_string()),
            external_hash: None,
            metadata: None,
            ref_count: 0,
            created_at: 1234567890,
            updated_at: 1234567890,
        };
        let json = serde_json::to_string(&resource).unwrap();
        assert!(json.contains("\"resourceType\"") || json.contains("\"type\""));
        assert!(json.contains("\"sourceId\""));
        assert!(json.contains("\"sourceTable\""));
        assert!(json.contains("\"storageMode\""));
        assert!(json.contains("\"refCount\""));
        assert!(json.contains("\"createdAt\""));
        assert!(json.contains("\"updatedAt\""));
    }

    #[test]
    fn test_vfs_create_resource_result_camel_case() {
        let result = VfsCreateResourceResult {
            resource_id: "res_abc123".to_string(),
            hash: "sha256hash".to_string(),
            is_new: true,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"resourceId\""));
        assert!(json.contains("\"isNew\""));
    }

    #[test]
    fn test_vfs_note_camel_case() {
        let note = VfsNote {
            id: "note_abc123".to_string(),
            resource_id: "res_xyz789".to_string(),
            title: "Test Note".to_string(),
            tags: vec!["tag1".to_string()],
            is_favorite: true,
            created_at: "2025-01-01".to_string(),
            updated_at: "2025-01-01".to_string(),
            deleted_at: None,
        };
        let json = serde_json::to_string(&note).unwrap();
        assert!(json.contains("\"resourceId\""));
        assert!(json.contains("\"isFavorite\""));
        assert!(json.contains("\"createdAt\""));
        assert!(json.contains("\"updatedAt\""));
    }

    #[test]
    fn test_option_skip_serializing() {
        let resource = VfsResource {
            id: "res_abc123".to_string(),
            hash: "sha256hash".to_string(),
            resource_type: VfsResourceType::Note,
            source_id: None,
            source_table: None,
            storage_mode: StorageMode::Inline,
            data: Some("content".to_string()),
            external_hash: None,
            metadata: None,
            ref_count: 0,
            created_at: 1234567890,
            updated_at: 1234567890,
        };
        let json = serde_json::to_string(&resource).unwrap();
        // None 字段应该被跳过
        assert!(!json.contains("\"sourceId\""));
        assert!(!json.contains("\"sourceTable\""));
        assert!(!json.contains("\"externalHash\""));
        assert!(!json.contains("\"metadata\""));
    }

    #[test]
    fn test_vfs_resource_type_all() {
        let all_types = VfsResourceType::all();
        assert_eq!(all_types.len(), 9);
        assert!(all_types.contains(&VfsResourceType::Note));
        assert!(all_types.contains(&VfsResourceType::Textbook));
        assert!(all_types.contains(&VfsResourceType::Exam));
        assert!(all_types.contains(&VfsResourceType::Translation));
        assert!(all_types.contains(&VfsResourceType::Essay));
        assert!(all_types.contains(&VfsResourceType::Image));
        assert!(all_types.contains(&VfsResourceType::File));
        assert!(all_types.contains(&VfsResourceType::Retrieval));
        assert!(all_types.contains(&VfsResourceType::MindMap));
    }

    #[test]
    fn test_preview_type_serialization() {
        assert_eq!(
            serde_json::to_string(&PreviewType::Markdown).unwrap(),
            "\"markdown\""
        );
        assert_eq!(serde_json::to_string(&PreviewType::Pdf).unwrap(), "\"pdf\"");
        assert_eq!(
            serde_json::to_string(&PreviewType::None).unwrap(),
            "\"none\""
        );
        // ★ T09 新增：富文档预览类型
        assert_eq!(
            serde_json::to_string(&PreviewType::Docx).unwrap(),
            "\"docx\""
        );
        assert_eq!(
            serde_json::to_string(&PreviewType::Xlsx).unwrap(),
            "\"xlsx\""
        );
        assert_eq!(
            serde_json::to_string(&PreviewType::Pptx).unwrap(),
            "\"pptx\""
        );
        assert_eq!(
            serde_json::to_string(&PreviewType::Text).unwrap(),
            "\"text\""
        );
        // ★ 2026-01-30 新增：音视频预览类型
        assert_eq!(
            serde_json::to_string(&PreviewType::Audio).unwrap(),
            "\"audio\""
        );
        assert_eq!(
            serde_json::to_string(&PreviewType::Video).unwrap(),
            "\"video\""
        );
    }

    #[test]
    fn test_preview_type_from_extension() {
        // PDF
        assert_eq!(PreviewType::from_extension("pdf"), PreviewType::Pdf);
        assert_eq!(PreviewType::from_extension("PDF"), PreviewType::Pdf);
        // Word
        assert_eq!(PreviewType::from_extension("docx"), PreviewType::Docx);
        // Excel
        assert_eq!(PreviewType::from_extension("xlsx"), PreviewType::Xlsx);
        assert_eq!(PreviewType::from_extension("xls"), PreviewType::Xlsx);
        assert_eq!(PreviewType::from_extension("ods"), PreviewType::Xlsx);
        // PowerPoint
        assert_eq!(PreviewType::from_extension("pptx"), PreviewType::Pptx);
        // 图片
        assert_eq!(PreviewType::from_extension("png"), PreviewType::Image);
        assert_eq!(PreviewType::from_extension("jpg"), PreviewType::Image);
        // 音频
        assert_eq!(PreviewType::from_extension("mp3"), PreviewType::Audio);
        assert_eq!(PreviewType::from_extension("wav"), PreviewType::Audio);
        assert_eq!(PreviewType::from_extension("ogg"), PreviewType::Audio);
        assert_eq!(PreviewType::from_extension("m4a"), PreviewType::Audio);
        assert_eq!(PreviewType::from_extension("flac"), PreviewType::Audio);
        assert_eq!(PreviewType::from_extension("aac"), PreviewType::Audio);
        // 视频
        assert_eq!(PreviewType::from_extension("mp4"), PreviewType::Video);
        assert_eq!(PreviewType::from_extension("webm"), PreviewType::Video);
        assert_eq!(PreviewType::from_extension("mov"), PreviewType::Video);
        assert_eq!(PreviewType::from_extension("avi"), PreviewType::Video);
        assert_eq!(PreviewType::from_extension("mkv"), PreviewType::Video);
        // 文本
        assert_eq!(PreviewType::from_extension("txt"), PreviewType::Text);
        assert_eq!(PreviewType::from_extension("md"), PreviewType::Text);
        assert_eq!(PreviewType::from_extension("json"), PreviewType::Text);
        // 未知
        assert_eq!(PreviewType::from_extension("unknown"), PreviewType::None);
    }

    #[test]
    fn test_preview_type_from_filename() {
        assert_eq!(PreviewType::from_filename("document.pdf"), PreviewType::Pdf);
        assert_eq!(PreviewType::from_filename("report.docx"), PreviewType::Docx);
        assert_eq!(PreviewType::from_filename("data.xlsx"), PreviewType::Xlsx);
        assert_eq!(PreviewType::from_filename("slides.pptx"), PreviewType::Pptx);
        assert_eq!(PreviewType::from_filename("image.png"), PreviewType::Image);
        assert_eq!(PreviewType::from_filename("readme.txt"), PreviewType::Text);
        assert_eq!(PreviewType::from_filename("config.json"), PreviewType::Text);
        assert_eq!(
            PreviewType::from_filename("no_extension"),
            PreviewType::None
        );
    }

    #[test]
    fn test_vfs_blob_generate_relative_path() {
        let path = VfsBlob::generate_relative_path("abcd1234567890", Some("pdf"));
        assert_eq!(path, "ab/abcd1234567890.pdf");

        let path_no_ext = VfsBlob::generate_relative_path("abcd1234567890", None);
        assert_eq!(path_no_ext, "ab/abcd1234567890");
    }

    #[test]
    fn test_vfs_list_item_serialization() {
        let item = VfsListItem {
            id: "note_abc123".to_string(),
            resource_id: "res_xyz789".to_string(),
            resource_type: VfsResourceType::Note,
            title: "Test Note".to_string(),
            preview_type: PreviewType::Markdown,
            created_at: 1234567890,
            updated_at: Some(1234567891),
            metadata: None,
        };
        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"resourceId\""));
        assert!(json.contains("\"previewType\":\"markdown\""));
        assert!(json.contains("\"type\":\"note\""));
    }

    #[test]
    fn test_vfs_translation_serialization() {
        let translation = VfsTranslation {
            id: "tr_abc123".to_string(),
            resource_id: "res_xyz789".to_string(),
            title: None,
            src_lang: "en".to_string(),
            tgt_lang: "zh".to_string(),
            engine: Some("deepl".to_string()),
            model: None,
            is_favorite: false,
            quality_rating: Some(5),
            created_at: "2025-01-01".to_string(),
            updated_at: None,
            metadata: None,
            // 🔧 P0-08 修复: 添加 source_text 和 translated_text 字段
            source_text: Some("Hello".to_string()),
            translated_text: Some("你好".to_string()),
        };
        let json = serde_json::to_string(&translation).unwrap();
        assert!(json.contains("\"srcLang\""));
        assert!(json.contains("\"tgtLang\""));
        assert!(json.contains("\"qualityRating\""));
    }

    #[test]
    fn test_vfs_essay_serialization() {
        let essay = VfsEssay {
            id: "essay_abc123".to_string(),
            resource_id: "res_xyz789".to_string(),
            title: Some("My Essay".to_string()),
            essay_type: Some("argumentative".to_string()),
            grading_result: None,
            score: Some(85),
            session_id: None,
            round_number: 1,
            grade_level: None,
            custom_prompt: None,
            is_favorite: false,
            dimension_scores: None,
            created_at: "2025-01-01".to_string(),
            updated_at: "2025-01-01".to_string(),
        };
        let json = serde_json::to_string(&essay).unwrap();
        assert!(json.contains("\"resourceId\""));
        assert!(json.contains("\"essayType\""));
    }

    #[test]
    fn test_vfs_textbook_serialization() {
        let textbook = VfsTextbook {
            id: "tb_abc123".to_string(),
            resource_id: None,
            blob_hash: Some("sha256hash".to_string()),
            sha256: "sha256hash".to_string(),
            file_name: "textbook.pdf".to_string(),
            original_path: Some("/path/to/file".to_string()),
            size: 1024000,
            page_count: Some(100),
            tags: vec!["高中".to_string()],
            is_favorite: true,
            last_opened_at: None,
            last_page: Some(50),
            bookmarks: vec![],
            cover_key: None,
            status: "active".to_string(),
            created_at: "2025-01-01".to_string(),
            updated_at: "2025-01-01".to_string(),
        };
        let json = serde_json::to_string(&textbook).unwrap();
        assert!(json.contains("\"blobHash\""));
        assert!(json.contains("\"fileName\""));
        assert!(json.contains("\"pageCount\""));
        assert!(json.contains("\"lastPage\""));
    }
}
