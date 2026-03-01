//! 通用文件导出适配器
//!
//! 支持格式：
//! - Original：原始文件复制（从 blob 存储读取）

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
                "文件不支持 {} 格式导出",
                format.as_str()
            ))),
        }
    }
}

impl FileExportAdapter {
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
