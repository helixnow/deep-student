//! 图片导出适配器
//!
//! 支持格式：
//! - Original：原始图片文件（从 blob 存储读取）

use std::sync::Arc;

use crate::dstu::error::DstuError;
use crate::dstu::types::DstuNodeType;
use crate::vfs::{VfsBlobRepo, VfsDatabase, VfsFileRepo};

use super::{sanitize_filename, ExportFormat, ExportPayload, ResourceExportAdapter};

pub struct ImageExportAdapter;

impl ResourceExportAdapter for ImageExportAdapter {
    fn resource_type(&self) -> DstuNodeType {
        DstuNodeType::Image
    }

    fn supported_formats(&self) -> Vec<ExportFormat> {
        vec![ExportFormat::Original]
    }

    fn export(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        resource_id: &str,
        format: ExportFormat,
    ) -> Result<ExportPayload, DstuError> {
        match format {
            ExportFormat::Original => self.export_original(vfs_db, resource_id),
            _ => Err(DstuError::NotSupported(format!(
                "图片不支持 {} 格式导出",
                format.as_str()
            ))),
        }
    }
}

impl ImageExportAdapter {
    fn export_original(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        resource_id: &str,
    ) -> Result<ExportPayload, DstuError> {
        // 获取文件元数据
        let file = VfsFileRepo::get_file(vfs_db, resource_id)
            .map_err(|e| DstuError::Internal(format!("获取图片文件失败: {}", e)))?
            .ok_or_else(|| DstuError::not_found(resource_id))?;

        let mime = file.mime_type.as_deref().unwrap_or("image/png").to_string();
        let filename = sanitize_filename(&file.file_name);
        let filename = if filename.is_empty() {
            format!("{}.png", resource_id)
        } else {
            filename
        };

        // 优先通过 blob 路径直接返回文件路径（避免大图片加载到内存）
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

        // 回退：通过 VfsFileRepo::get_content 获取 base64 内容并解码
        // 仅用于无 blob 的小图片（如内联 base64 存储）
        let base64_content = VfsFileRepo::get_content(vfs_db, resource_id)
            .map_err(|e| DstuError::Internal(format!("获取图片内容失败: {}", e)))?
            .ok_or_else(|| DstuError::Internal("图片内容为空".to_string()))?;

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
