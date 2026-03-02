//! 题目集导出适配器
//!
//! 支持格式：
//! - Markdown：结构化预览（页 → 题目列表）
//! - Original：原始 preview_json（JSON 格式）

use std::sync::Arc;

use crate::dstu::error::DstuError;
use crate::dstu::types::DstuNodeType;
use crate::vfs::{VfsDatabase, VfsExamRepo};

use super::{sanitize_filename, ExportFormat, ExportPayload, ResourceExportAdapter};

pub struct ExamExportAdapter;

impl ResourceExportAdapter for ExamExportAdapter {
    fn resource_type(&self) -> DstuNodeType {
        DstuNodeType::Exam
    }

    fn supported_formats(&self) -> Vec<ExportFormat> {
        vec![ExportFormat::Markdown, ExportFormat::Original]
    }

    fn export(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        resource_id: &str,
        format: ExportFormat,
    ) -> Result<ExportPayload, DstuError> {
        match format {
            ExportFormat::Markdown => self.export_markdown(vfs_db, resource_id),
            ExportFormat::Original => self.export_json(vfs_db, resource_id),
            _ => Err(DstuError::NotSupported(format!(
                "题目集不支持 {} 格式导出",
                format.as_str()
            ))),
        }
    }
}

impl ExamExportAdapter {
    fn get_exam(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        resource_id: &str,
    ) -> Result<crate::vfs::VfsExamSheet, DstuError> {
        VfsExamRepo::get_exam_sheet(vfs_db, resource_id)
            .map_err(|e| DstuError::Internal(format!("获取题目集失败: {}", e)))?
            .ok_or_else(|| DstuError::not_found(resource_id))
    }

    fn export_markdown(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        resource_id: &str,
    ) -> Result<ExportPayload, DstuError> {
        let exam = self.get_exam(vfs_db, resource_id)?;
        let title = exam.exam_name.as_deref().unwrap_or("未命名题目集");

        let mut md = String::new();
        md.push_str("---\n");
        md.push_str(&format!("id: {}\n", exam.id));
        md.push_str(&format!("title: \"{}\"\n", title.replace('"', "\\\"")));
        md.push_str(&format!("status: {}\n", exam.status));
        md.push_str(&format!("created: {}\n", exam.created_at));
        md.push_str(&format!("updated: {}\n", exam.updated_at));
        md.push_str("---\n\n");
        md.push_str(&format!("# {}\n\n", title));

        // 解析 preview_json 生成结构化 Markdown
        if let Some(pages) = exam.preview_json.get("pages").and_then(|v| v.as_array()) {
            for (page_idx, page) in pages.iter().enumerate() {
                let cards = page
                    .get("cards")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                md.push_str(&format!(
                    "## 第 {} 页（{} 题）\n\n",
                    page_idx + 1,
                    cards.len()
                ));
                for card in &cards {
                    let label = card
                        .get("questionLabel")
                        .and_then(|v| v.as_str())
                        .unwrap_or("-");
                    let ocr = card
                        .get("ocrText")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim();
                    let status = card.get("status").and_then(|v| v.as_str()).unwrap_or("new");
                    if ocr.is_empty() {
                        md.push_str(&format!("- **{}** [{}]（无 OCR 文本）\n", label, status));
                    } else {
                        md.push_str(&format!("- **{}** [{}] {}\n", label, status, ocr));
                    }
                }
                md.push('\n');
            }
        }

        let safe_title = sanitize_filename(title);
        let filename = format!("{}.md", safe_title);

        Ok(ExportPayload::Text {
            content: md,
            suggested_filename: filename,
            mime_type: "text/markdown".to_string(),
        })
    }

    fn export_json(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        resource_id: &str,
    ) -> Result<ExportPayload, DstuError> {
        let exam = self.get_exam(vfs_db, resource_id)?;
        let title = exam.exam_name.as_deref().unwrap_or("未命名题目集");

        let json_str = serde_json::to_string_pretty(&exam.preview_json)
            .map_err(|e| DstuError::Internal(format!("序列化 JSON 失败: {}", e)))?;

        let safe_title = sanitize_filename(title);
        let filename = format!("{}.json", safe_title);

        Ok(ExportPayload::Text {
            content: json_str,
            suggested_filename: filename,
            mime_type: "application/json".to_string(),
        })
    }
}
