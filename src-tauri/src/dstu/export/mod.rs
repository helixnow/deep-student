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
    _vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<String>, String> {
    log::info!("[DSTU::export] dstu_export_formats: path={}", path);

    // 验证路径合法性
    let _ = extract_resource_info(&path).map_err(|e| e.to_string())?;

    let node_type = infer_node_type_from_path(&path)?;

    // ★ 文件夹：批量打包导出（遍历子资源打 ZIP）
    if node_type == DstuNodeType::Folder {
        return Ok(vec![ExportFormat::Zip.as_str().to_string()]);
    }

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
        // ★ 文件夹：批量打包导出（遍历子资源，复用既有单资源 Original 导出）
        if node_type == DstuNodeType::Folder {
            if export_format != ExportFormat::Zip {
                return Err(DstuError::NotSupported(format!(
                    "文件夹仅支持 zip 格式导出，收到: {}",
                    export_format.as_str()
                )));
            }
            return export_folder_zip(&registry, &vfs_db_inner, &id_owned);
        }
        registry.export(&vfs_db_inner, node_type, &id_owned, export_format)
    })
    .await
    .map_err(|e| format!("导出任务失败: {}", e))?
    .map_err(|e| e.to_string())?;

    Ok(DstuExportResult::from(payload))
}

// ============================================================================
// 文件夹 ZIP 批量导出
// ============================================================================

/// 文件夹递归深度上限（防环/防深层嵌套失控）
const FOLDER_EXPORT_MAX_DEPTH: usize = 16;
/// 单次文件夹导出的资源数量上限
const FOLDER_EXPORT_MAX_ENTRIES: usize = 2_000;

/// 从资源 ID 前缀推断节点类型（与 infer_node_type_from_path 同一规则）
fn infer_node_type_from_id(id: &str) -> Option<DstuNodeType> {
    if id.starts_with("note_") {
        Some(DstuNodeType::Note)
    } else if id.starts_with("tb_") {
        Some(DstuNodeType::Textbook)
    } else if id.starts_with("exam_") {
        Some(DstuNodeType::Exam)
    } else if id.starts_with("tr_") {
        Some(DstuNodeType::Translation)
    } else if id.starts_with("essay_") {
        Some(DstuNodeType::Essay)
    } else if id.starts_with("img_") {
        Some(DstuNodeType::Image)
    } else if id.starts_with("file_") || id.starts_with("att_") {
        Some(DstuNodeType::File)
    } else if id.starts_with("mm_") {
        Some(DstuNodeType::MindMap)
    } else {
        None
    }
}

/// ZIP 内条目名去重（同名追加 _N 序号）
fn dedup_zip_entry_name(used: &mut std::collections::HashSet<String>, name: &str) -> String {
    if used.insert(name.to_string()) {
        return name.to_string();
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => {
            (stem.to_string(), Some(ext.to_string()))
        }
        _ => (name.to_string(), None),
    };
    for attempt in 1..1000 {
        let candidate = match &ext {
            Some(e) => format!("{}_{}.{}", stem, attempt, e),
            None => format!("{}_{}", stem, attempt),
        };
        if used.insert(candidate.clone()) {
            return candidate;
        }
    }
    format!("{}_{}", stem, chrono::Utc::now().timestamp_millis())
}

/// 递归收集文件夹下所有资源（相对目录前缀 + 资源 ID）
fn collect_folder_resources(
    vfs_db: &Arc<VfsDatabase>,
    folder_id: &str,
    prefix: &str,
    depth: usize,
    out: &mut Vec<(String, String)>,
) -> Result<(), DstuError> {
    use crate::vfs::VfsFolderRepo;

    if depth > FOLDER_EXPORT_MAX_DEPTH {
        return Ok(());
    }
    if out.len() >= FOLDER_EXPORT_MAX_ENTRIES {
        return Ok(());
    }

    let items = VfsFolderRepo::list_items_by_folder(vfs_db, Some(folder_id))
        .map_err(|e| DstuError::Internal(format!("读取文件夹内容失败: {}", e)))?;
    for item in items {
        if out.len() >= FOLDER_EXPORT_MAX_ENTRIES {
            break;
        }
        out.push((prefix.to_string(), item.item_id));
    }

    let subfolders = VfsFolderRepo::list_folders_by_parent(vfs_db, Some(folder_id))
        .map_err(|e| DstuError::Internal(format!("读取子文件夹失败: {}", e)))?;
    for folder in subfolders {
        let sub_prefix = format!("{}{}/", prefix, sanitize_filename(&folder.title));
        collect_folder_resources(vfs_db, &folder.id, &sub_prefix, depth + 1, out)?;
    }

    Ok(())
}

/// ★ 文件夹批量导出：遍历子资源逐个按 Original 导出并打包为 ZIP
///
/// - 子文件夹递归打包为 ZIP 内目录结构；
/// - 单个资源导出失败不阻塞整体，失败原因写入 ZIP 内的「导出说明.txt」。
fn export_folder_zip(
    registry: &ExportRegistry,
    vfs_db: &Arc<VfsDatabase>,
    folder_id: &str,
) -> Result<ExportPayload, DstuError> {
    use crate::vfs::VfsFolderRepo;
    use std::io::Write;

    let folder = VfsFolderRepo::get_folder(vfs_db, folder_id)
        .map_err(|e| DstuError::Internal(format!("获取文件夹失败: {}", e)))?
        .ok_or_else(|| DstuError::not_found(folder_id))?;

    let mut resources: Vec<(String, String)> = Vec::new();
    collect_folder_resources(vfs_db, folder_id, "", 0, &mut resources)?;

    if resources.is_empty() {
        return Err(DstuError::NotSupported(format!(
            "文件夹「{}」内没有可导出的资源",
            folder.title
        )));
    }

    let temp_path = std::env::temp_dir().join(format!(
        "dstu_folder_export_{}_{}.zip",
        folder_id,
        chrono::Utc::now().timestamp_millis()
    ));
    let zip_file = std::fs::File::create(&temp_path)
        .map_err(|e| DstuError::Internal(format!("创建导出临时文件失败: {}", e)))?;
    let mut writer = zip::ZipWriter::new(zip_file);
    let options = zip::write::FileOptions::default();

    let mut used_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut exported_count = 0usize;

    for (prefix, resource_id) in &resources {
        let Some(node_type) = infer_node_type_from_id(resource_id) else {
            skipped.push(format!("{}: 无法识别的资源类型", resource_id));
            continue;
        };

        // 优先原始格式；不支持时回退该资源支持的第一个格式（如笔记的 markdown）
        let formats = registry.supported_formats(node_type);
        let format = if formats.contains(&ExportFormat::Original) {
            ExportFormat::Original
        } else if let Some(first) = formats.first() {
            *first
        } else {
            skipped.push(format!("{}: 该资源类型不支持导出", resource_id));
            continue;
        };

        match registry.export(vfs_db, node_type, resource_id, format) {
            Ok(payload) => {
                let (data_result, suggested) = match payload {
                    ExportPayload::Text {
                        content,
                        suggested_filename,
                        ..
                    } => (Ok(content.into_bytes()), suggested_filename),
                    ExportPayload::Binary {
                        data,
                        suggested_filename,
                        ..
                    } => (Ok(data), suggested_filename),
                    ExportPayload::FilePath {
                        temp_path,
                        suggested_filename,
                        ..
                    } => (
                        std::fs::read(&temp_path).map_err(|e| format!("读取源文件失败: {}", e)),
                        suggested_filename,
                    ),
                };
                match data_result {
                    Ok(data) => {
                        let entry_name = dedup_zip_entry_name(
                            &mut used_names,
                            &format!("{}{}", prefix, sanitize_filename(&suggested)),
                        );
                        if let Err(e) = writer
                            .start_file(entry_name.as_str(), options)
                            .map_err(|e| e.to_string())
                            .and_then(|_| writer.write_all(&data).map_err(|e| e.to_string()))
                        {
                            skipped.push(format!("{}: 写入 ZIP 失败 ({})", suggested, e));
                        } else {
                            exported_count += 1;
                        }
                    }
                    Err(e) => skipped.push(format!("{}: {}", suggested, e)),
                }
            }
            Err(e) => skipped.push(format!("{}: {}", resource_id, e)),
        }
    }

    if !skipped.is_empty() {
        let note = format!(
            "以下 {} 个资源未包含在导出包中：\n{}\n",
            skipped.len(),
            skipped.join("\n")
        );
        let entry_name = dedup_zip_entry_name(&mut used_names, "导出说明.txt");
        let _ = writer
            .start_file(entry_name.as_str(), options)
            .and_then(|_| {
                writer
                    .write_all(note.as_bytes())
                    .map_err(zip::result::ZipError::Io)
            });
    }

    writer
        .finish()
        .map_err(|e| DstuError::Internal(format!("完成 ZIP 写入失败: {}", e)))?;

    if exported_count == 0 {
        let _ = std::fs::remove_file(&temp_path);
        return Err(DstuError::NotSupported(format!(
            "文件夹「{}」内没有成功导出的资源：{}",
            folder.title,
            skipped.join("; ")
        )));
    }

    let filename = sanitize_filename(&format!("{}.zip", folder.title));
    Ok(ExportPayload::FilePath {
        temp_path,
        suggested_filename: filename,
        mime_type: "application/zip".to_string(),
    })
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
