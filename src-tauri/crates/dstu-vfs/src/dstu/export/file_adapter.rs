//! 通用文件导出适配器
//!
//! 支持格式：
//! - Original：原始文件复制（从 blob 存储读取）
//! - Markdown：导出解析提取的文本（extracted_text，如 docx/pptx/epub/音频转写）

use std::sync::Arc;

use crate::dstu::error::DstuError;
use crate::dstu::types::DstuNodeType;
use crate::vfs::{VfsBlobRepo, VfsDatabase, VfsFileRepo};

use super::{sanitize_filename, ExportFormat, ExportPayload, ResourceExportAdapter};

pub struct FileExportAdapter;

impl ResourceExportAdapter for FileExportAdapter {
    fn resource_type(&self) -> DstuNodeType {
        DstuNodeType::File
    }

    fn supported_formats(&self) -> Vec<ExportFormat> {
        vec![ExportFormat::Original, ExportFormat::Markdown]
    }

    fn export(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        resource_id: &str,
        format: ExportFormat,
    ) -> Result<ExportPayload, DstuError> {
        match format {
            ExportFormat::Original => self.export_original(vfs_db, resource_id),
            ExportFormat::Markdown => self.export_markdown(vfs_db, resource_id),
            _ => Err(DstuError::NotSupported(format!(
                "文件不支持 {} 格式导出",
                format.as_str()
            ))),
        }
    }
}

impl FileExportAdapter {
    /// ★ 导出解析提取的文本为 Markdown（extracted_text）
    fn export_markdown(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        resource_id: &str,
    ) -> Result<ExportPayload, DstuError> {
        let file = VfsFileRepo::get_file(vfs_db, resource_id)
            .map_err(|e| DstuError::Internal(format!("获取文件失败: {}", e)))?
            .ok_or_else(|| DstuError::not_found(resource_id))?;

        let text = file
            .extracted_text
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .ok_or_else(|| {
                DstuError::NotSupported(format!(
                    "文件 {} 没有可导出的提取文本（仅支持已解析出文本的文档）",
                    file.file_name
                ))
            })?;

        let content = format!("# {}\n\n{}\n", file.file_name, text);

        let stem = std::path::Path::new(&file.file_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&file.file_name);
        let filename = sanitize_filename(&format!("{}.md", stem));

        Ok(ExportPayload::Text {
            content,
            suggested_filename: filename,
            mime_type: "text/markdown".to_string(),
        })
    }

    fn export_original(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        resource_id: &str,
    ) -> Result<ExportPayload, DstuError> {
        let file = VfsFileRepo::get_file(vfs_db, resource_id)
            .map_err(|e| DstuError::Internal(format!("获取文件失败: {}", e)))?
            .ok_or_else(|| DstuError::not_found(resource_id))?;

        let mime = file
            .mime_type
            .as_deref()
            .unwrap_or("application/octet-stream")
            .to_string();
        let filename = sanitize_filename(&file.file_name);
        let filename = if filename.is_empty() {
            format!("{}.bin", resource_id)
        } else {
            filename
        };

        // 优先通过 blob 路径直接返回文件路径（避免大文件加载到内存）
        if let Some(ref blob_hash) = file.blob_hash {
            if let Ok(Some(blob_path)) = VfsBlobRepo::get_blob_path(vfs_db, blob_hash) {
                if blob_path.exists() {
                    return Ok(ExportPayload::FilePath {
                        temp_path: blob_path,
                        suggested_filename: filename,
                        mime_type: mime,
                    });
                }
            }
        }

        // 回退：通过 get_content 获取 base64 内容并解码
        // 仅用于无 blob 的小文件
        let base64_content = VfsFileRepo::get_content(vfs_db, resource_id)
            .map_err(|e| DstuError::Internal(format!("获取文件内容失败: {}", e)))?
            .ok_or_else(|| DstuError::Internal("文件内容为空".to_string()))?;

        use base64::Engine;
        let data = base64::engine::general_purpose::STANDARD
            .decode(&base64_content)
            .map_err(|e| DstuError::Internal(format!("解码 base64 失败: {}", e)))?;

        Ok(ExportPayload::Binary {
            data,
            suggested_filename: filename,
            mime_type: mime,
        })
    }
}
