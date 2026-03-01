//! 教材导出适配器
//!
//! 支持格式：
//! - Original：复制原始 PDF 文件

use std::sync::Arc;

use crate::dstu::error::DstuError;
use crate::dstu::types::DstuNodeType;
use crate::vfs::{VfsBlobRepo, VfsDatabase, VfsTextbookRepo};

use super::{sanitize_filename, ExportFormat, ExportPayload, ResourceExportAdapter};

pub struct TextbookExportAdapter;

impl ResourceExportAdapter for TextbookExportAdapter {
    fn resource_type(&self) -> DstuNodeType {
        DstuNodeType::Textbook
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
                "教材不支持 {} 格式导出",
                format.as_str()
            ))),
        }
    }
}

impl TextbookExportAdapter {
    fn export_original(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        resource_id: &str,
    ) -> Result<ExportPayload, DstuError> {
        // 获取教材元数据
        let textbook = VfsTextbookRepo::get_textbook(vfs_db, resource_id)
            .map_err(|e| DstuError::Internal(format!("获取教材失败: {}", e)))?
            .ok_or_else(|| DstuError::not_found(resource_id))?;

        // 通过 blob_hash 获取 PDF 文件的磁盘路径
        let blob_hash = textbook.blob_hash.as_deref().ok_or_else(|| {
            DstuError::Internal(format!("教材 {} 没有关联的 blob", resource_id))
        })?;

        let blob_path = VfsBlobRepo::get_blob_path(vfs_db, blob_hash)
            .map_err(|e| DstuError::Internal(format!("获取 blob 路径失败: {}", e)))?
            .ok_or_else(|| {
                DstuError::Internal(format!("blob {} 文件不存在", blob_hash))
            })?;

        // 验证文件存在
        if !blob_path.exists() {
            return Err(DstuError::Internal(format!(
                "PDF 文件不存在: {}",
                blob_path.display()
            )));
        }

        let filename = sanitize_filename(&textbook.file_name);
        let filename = if filename.is_empty() {
            format!("{}.pdf", resource_id)
        } else {
            filename
        };

        // 使用 FilePath 避免大文件加载到内存
        Ok(ExportPayload::FilePath {
            temp_path: blob_path,
            suggested_filename: filename,
            mime_type: "application/pdf".to_string(),
        })
    }
}
