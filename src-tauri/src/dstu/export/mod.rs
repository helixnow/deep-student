//! DSTU 统一资源导出模块
//!
//! 为所有资源类型提供统一的导出接口，每种资源类型通过独立的适配器实现导出逻辑。
//!
//! ## 架构
//!
//! - `ResourceExportAdapter` trait：定义导出适配器的统一接口
//! - `ExportRegistry`：适配器注册表，按资源类型分发导出请求
//! - `dstu_export` / `dstu_export_formats`：Tauri 命令入口
//!
//! ## 导出格式
//!
//! - `markdown`：Markdown 文本（.md），适用于笔记、翻译、作文等文本资源
//! - `original`：原始格式（PDF/图片/JSON），保持资源的原始二进制或文本形态
//! - `zip`：ZIP 包（含附件和元数据），适用于需要打包导出的场景

pub mod essay_adapter;
pub mod exam_adapter;
pub mod file_adapter;
pub mod image_adapter;
pub mod mindmap_adapter;
pub mod note_adapter;
pub mod textbook_adapter;
pub mod translation_adapter;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::dstu::error::DstuError;
use crate::dstu::handler_utils::extract_resource_info;
use crate::dstu::types::DstuNodeType;
use crate::vfs::VfsDatabase;

// ============================================================================
// 导出格式与结果类型
// ============================================================================

/// 导出格式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    /// Markdown 文本（.md）
    Markdown,
    /// 原始格式（PDF/图片/JSON 等）
    Original,
    /// ZIP 包（含附件和元数据）
    Zip,
}

impl ExportFormat {
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "markdown" | "md" => Some(ExportFormat::Markdown),
            "original" | "raw" => Some(ExportFormat::Original),
            "zip" => Some(ExportFormat::Zip),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            ExportFormat::Markdown => "markdown",
            ExportFormat::Original => "original",
            ExportFormat::Zip => "zip",
        }
    }
}

/// 导出结果负载
#[derive(Debug)]
pub enum ExportPayload {
    /// 文本内容（Markdown / JSON 等），前端通过 saveTextFile 保存
    Text {
        content: String,
        suggested_filename: String,
        mime_type: String,
    },
    /// 二进制内容，前端通过 saveBinaryFile 保存
    Binary {
        data: Vec<u8>,
        suggested_filename: String,
        mime_type: String,
    },
    /// 后端已写入磁盘的文件（ZIP / 大 PDF），返回临时路径
    FilePath {
        temp_path: PathBuf,
        suggested_filename: String,
        mime_type: String,
    },
}

/// 返回给前端的导出结果（可序列化）
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DstuExportResult {
    /// 导出类型："text" | "binary" | "file"
    pub payload_type: String,
    /// 建议的文件名
    pub suggested_filename: String,
    /// MIME 类型
    pub mime_type: String,
    /// 文本内容（payload_type == "text" 时有值）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Base64 编码的二进制内容（payload_type == "binary" 时有值）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_base64: Option<String>,
    /// 临时文件路径（payload_type == "file" 时有值）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temp_path: Option<String>,
}

impl From<ExportPayload> for DstuExportResult {
    fn from(payload: ExportPayload) -> Self {
        match payload {
            ExportPayload::Text {
                content,
                suggested_filename,
                mime_type,
            } => DstuExportResult {
                payload_type: "text".to_string(),
                suggested_filename,
                mime_type,
                content: Some(content),
                data_base64: None,
                temp_path: None,
            },
            ExportPayload::Binary {
                data,
                suggested_filename,
                mime_type,
            } => {
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                DstuExportResult {
                    payload_type: "binary".to_string(),
                    suggested_filename,
                    mime_type,
                    content: None,
                    data_base64: Some(b64),
                    temp_path: None,
                }
            }
            ExportPayload::FilePath {
                temp_path,
                suggested_filename,
                mime_type,
            } => DstuExportResult {
                payload_type: "file".to_string(),
                suggested_filename,
                mime_type,
                content: None,
                data_base64: None,
                temp_path: Some(temp_path.to_string_lossy().to_string()),
            },
        }
    }
}

// ============================================================================
// 导出适配器 trait
// ============================================================================

/// 统一资源导出适配器
///
/// 每种资源类型实现此 trait，提供导出能力。
pub trait ResourceExportAdapter: Send + Sync {
    /// 该适配器支持的资源类型
    fn resource_type(&self) -> DstuNodeType;

    /// 该资源类型支持的导出格式列表
    fn supported_formats(&self) -> Vec<ExportFormat>;

    /// 执行导出
    fn export(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        resource_id: &str,
        format: ExportFormat,
    ) -> Result<ExportPayload, DstuError>;
}

// ============================================================================
// 导出注册表
// ============================================================================

/// 导出适配器注册表
pub struct ExportRegistry {
    adapters: HashMap<DstuNodeType, Box<dyn ResourceExportAdapter>>,
}

impl ExportRegistry {
    /// 创建注册表并注册所有内置适配器
    pub fn new() -> Self {
        let mut adapters: HashMap<DstuNodeType, Box<dyn ResourceExportAdapter>> = HashMap::new();

        adapters.insert(
            DstuNodeType::Note,
            Box::new(note_adapter::NoteExportAdapter),
        );
        adapters.insert(
            DstuNodeType::Textbook,
            Box::new(textbook_adapter::TextbookExportAdapter),
        );
        adapters.insert(
            DstuNodeType::Exam,
            Box::new(exam_adapter::ExamExportAdapter),
        );
        adapters.insert(
            DstuNodeType::Translation,
            Box::new(translation_adapter::TranslationExportAdapter),
        );
        adapters.insert(
            DstuNodeType::Essay,
            Box::new(essay_adapter::EssayExportAdapter),
        );
        adapters.insert(
            DstuNodeType::Image,
            Box::new(image_adapter::ImageExportAdapter),
        );
        adapters.insert(
            DstuNodeType::File,
            Box::new(file_adapter::FileExportAdapter),
        );
        adapters.insert(
            DstuNodeType::MindMap,
            Box::new(mindmap_adapter::MindMapExportAdapter),
        );

        Self { adapters }
    }

    /// 获取资源类型支持的导出格式
    pub fn supported_formats(&self, node_type: DstuNodeType) -> Vec<ExportFormat> {
        self.adapters
            .get(&node_type)
            .map(|a| a.supported_formats())
            .unwrap_or_default()
    }

    /// 执行导出
    pub fn export(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        node_type: DstuNodeType,
        resource_id: &str,
        format: ExportFormat,
    ) -> Result<ExportPayload, DstuError> {
        let adapter = self
            .adapters
            .get(&node_type)
            .ok_or_else(|| DstuError::NotSupported(format!("资源类型 {} 不支持导出", node_type)))?;

        if !adapter.supported_formats().contains(&format) {
            return Err(DstuError::NotSupported(format!(
                "资源类型 {} 不支持 {} 格式导出",
                node_type,
                format.as_str()
            )));
        }

        adapter.export(vfs_db, resource_id, format)
    }
}

// ============================================================================
// Tauri 命令
// ============================================================================

/// 查询资源支持的导出格式
#[tauri::command]
pub async fn dstu_export_formats(
    path: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<String>, String> {
    log::info!("[DSTU::export] dstu_export_formats: path={}", path);

    // 验证路径合法性
    let _ = extract_resource_info(&path).map_err(|e| e.to_string())?;

    let node_type = infer_node_type_from_path(&path)?;

    let registry = ExportRegistry::new();
    let formats = registry
        .supported_formats(node_type)
        .iter()
        .map(|f| f.as_str().to_string())
        .collect();

    Ok(formats)
}

/// 执行资源导出
#[tauri::command]
pub async fn dstu_export(
    path: String,
    format: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<DstuExportResult, String> {
    log::info!(
        "[DSTU::export] dstu_export: path={}, format={}",
        path,
        format
    );

    let export_format =
        ExportFormat::from_str(&format).ok_or_else(|| format!("不支持的导出格式: {}", format))?;

    let (_resource_type_str, id) = extract_resource_info(&path).map_err(|e| e.to_string())?;
    let node_type = infer_node_type_from_path(&path)?;

    let registry = ExportRegistry::new();

    let vfs_db_inner = vfs_db.inner().clone();
    let id_owned = id.to_string();

    let payload = tokio::task::spawn_blocking(move || {
        registry.export(&vfs_db_inner, node_type, &id_owned, export_format)
    })
    .await
    .map_err(|e| format!("导出任务失败: {}", e))?
    .map_err(|e| e.to_string())?;

    Ok(DstuExportResult::from(payload))
}

// ============================================================================
// 辅助函数
// ============================================================================

/// 从路径推断资源节点类型
fn infer_node_type_from_path(path: &str) -> Result<DstuNodeType, String> {
    // 从路径末尾提取 resource_id，根据前缀判断类型
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let id = segments.last().ok_or("路径为空")?;

    if id.starts_with("note_") {
        Ok(DstuNodeType::Note)
    } else if id.starts_with("tb_") {
        Ok(DstuNodeType::Textbook)
    } else if id.starts_with("exam_") {
        Ok(DstuNodeType::Exam)
    } else if id.starts_with("tr_") {
        Ok(DstuNodeType::Translation)
    } else if id.starts_with("essay_session_") || id.starts_with("essay_") {
        Ok(DstuNodeType::Essay)
    } else if id.starts_with("img_") {
        Ok(DstuNodeType::Image)
    } else if id.starts_with("file_") || id.starts_with("att_") {
        Ok(DstuNodeType::File)
    } else if id.starts_with("mm_") {
        Ok(DstuNodeType::MindMap)
    } else if id.starts_with("tdl_") {
        Ok(DstuNodeType::Todo)
    } else if id.starts_with("fld_") {
        Ok(DstuNodeType::Folder)
    } else {
        Err(format!("无法从 ID '{}' 推断资源类型", id))
    }
}

/// 清理文件名中的非法字符
pub(crate) fn sanitize_filename(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == ' ' || ch == '.' {
            out.push(ch);
        } else if !ch.is_ascii() {
            // 保留非 ASCII 字符（中文等）
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        "untitled".to_string()
    } else {
        out
    }
}
