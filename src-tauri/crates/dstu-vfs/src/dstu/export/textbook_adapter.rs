//! 教材导出适配器
//!
//! 支持格式：
//! - Original：复制原始 PDF 文件
//! - Markdown：导出解析提取的文本（extracted_text）

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
                "教材不支持 {} 格式导出",
                format.as_str()
            ))),
        }
    }
}

impl TextbookExportAdapter {
    /// ★ 导出解析提取的文本为 Markdown（files.extracted_text）
    fn export_markdown(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        resource_id: &str,
    ) -> Result<ExportPayload, DstuError> {
        let textbook = VfsTextbookRepo::get_textbook(vfs_db, resource_id)
            .map_err(|e| DstuError::Internal(format!("获取教材失败: {}", e)))?
            .ok_or_else(|| DstuError::not_found(resource_id))?;

        // VfsTextbook 结构体不携带 extracted_text，直接查 files 行
        let conn = vfs_db
            .get_conn_safe()
            .map_err(|e| DstuError::Internal(format!("获取数据库连接失败: {}", e)))?;
        let extracted_text: Option<String> = conn
            .query_row(
                "SELECT extracted_text FROM files WHERE id = ?1",
                rusqlite::params![resource_id],
                |row| row.get(0),
            )
            .unwrap_or(None);

        let text = extracted_text
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .ok_or_else(|| {
                DstuError::NotSupported(format!(
                    "教材 {} 没有可导出的提取文本（可能尚未完成解析/OCR）",
                    textbook.file_name
                ))
            })?;

        let content = format!("# {}\n\n{}\n", textbook.file_name, text);

        let stem = std::path::Path::new(&textbook.file_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&textbook.file_name);
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
        // 获取教材元数据
        let textbook = VfsTextbookRepo::get_textbook(vfs_db, resource_id)
            .map_err(|e| DstuError::Internal(format!("获取教材失败: {}", e)))?
            .ok_or_else(|| DstuError::not_found(resource_id))?;

        // 通过 blob_hash 获取 PDF 文件的磁盘路径
        let blob_hash = textbook
            .blob_hash
            .as_deref()
            .ok_or_else(|| DstuError::Internal(format!("教材 {} 没有关联的 blob", resource_id)))?;

        let blob_path = VfsBlobRepo::get_blob_path(vfs_db, blob_hash)
            .map_err(|e| DstuError::Internal(format!("获取 blob 路径失败: {}", e)))?
            .ok_or_else(|| DstuError::Internal(format!("blob {} 文件不存在", blob_hash)))?;

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
