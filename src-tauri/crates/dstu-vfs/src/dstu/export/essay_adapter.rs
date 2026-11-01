//! 作文导出适配器
//!
//! 支持格式：
//! - Markdown：作文内容 + 批改结果汇总
//!
//! 支持两种 ID：
//! - essay_session_*：导出整个会话（所有轮次）
//! - essay_*：导出单个轮次

use std::sync::Arc;

use crate::dstu::error::DstuError;
use crate::dstu::types::DstuNodeType;
use crate::vfs::{VfsDatabase, VfsEssayRepo};

use super::{sanitize_filename, ExportFormat, ExportPayload, ResourceExportAdapter};

pub struct EssayExportAdapter;

impl ResourceExportAdapter for EssayExportAdapter {
    fn resource_type(&self) -> DstuNodeType {
        DstuNodeType::Essay
    }

    fn supported_formats(&self) -> Vec<ExportFormat> {
        vec![ExportFormat::Markdown]
    }

    fn export(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        resource_id: &str,
        format: ExportFormat,
    ) -> Result<ExportPayload, DstuError> {
        match format {
            ExportFormat::Markdown => self.export_markdown(vfs_db, resource_id),
            _ => Err(DstuError::NotSupported(format!(
                "作文不支持 {} 格式导出",
                format.as_str()
            ))),
        }
    }
}

impl EssayExportAdapter {
    fn export_markdown(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        resource_id: &str,
    ) -> Result<ExportPayload, DstuError> {
        if resource_id.starts_with("essay_session_") {
            self.export_session_markdown(vfs_db, resource_id)
        } else {
            self.export_single_markdown(vfs_db, resource_id)
        }
    }

    fn export_session_markdown(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        session_id: &str,
    ) -> Result<ExportPayload, DstuError> {
        let session = VfsEssayRepo::get_session(vfs_db, session_id)
            .map_err(|e| DstuError::Internal(format!("获取作文会话失败: {}", e)))?
            .ok_or_else(|| DstuError::not_found(session_id))?;

        let essays = VfsEssayRepo::list_essays_by_session(vfs_db, session_id)
            .map_err(|e| DstuError::Internal(format!("获取作文轮次失败: {}", e)))?;

        let title = if session.title.is_empty() {
            "未命名作文"
        } else {
            &session.title
        };

        let mut md = String::new();
        md.push_str("---\n");
        md.push_str(&format!("id: {}\n", session.id));
        md.push_str(&format!("title: \"{}\"\n", title.replace('"', "\\\"")));
        if let Some(ref essay_type) = session.essay_type {
            if !essay_type.is_empty() {
                md.push_str(&format!("essay_type: {}\n", essay_type));
            }
        }
        if let Some(ref grade_level) = session.grade_level {
            if !grade_level.is_empty() {
                md.push_str(&format!("grade_level: {}\n", grade_level));
            }
        }
        md.push_str(&format!("total_rounds: {}\n", session.total_rounds));
        if let Some(score) = session.latest_score {
            md.push_str(&format!("latest_score: {}\n", score));
        }
        md.push_str(&format!("created: {}\n", session.created_at));
        md.push_str(&format!("updated: {}\n", session.updated_at));
        md.push_str("---\n\n");
        md.push_str(&format!("# {}\n\n", title));

        for (i, essay) in essays.iter().enumerate() {
            md.push_str(&format!("## 第 {} 轮", i + 1));
            if let Some(score) = essay.score {
                md.push_str(&format!("（得分: {}）", score));
            }
            md.push_str("\n\n");

            // 获取作文内容
            if let Ok(Some(content)) = VfsEssayRepo::get_essay_content(vfs_db, &essay.id) {
                md.push_str(&content);
                md.push_str("\n\n");
            }

            // 批改结果摘要
            if let Some(ref grading) = essay.grading_result {
                if let Some(summary) = grading.get("summary").and_then(|v| v.as_str()) {
                    md.push_str("### 批改意见\n\n");
                    md.push_str(summary);
                    md.push_str("\n\n");
                }
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

    fn export_single_markdown(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        essay_id: &str,
    ) -> Result<ExportPayload, DstuError> {
        let essay = VfsEssayRepo::get_essay(vfs_db, essay_id)
            .map_err(|e| DstuError::Internal(format!("获取作文失败: {}", e)))?
            .ok_or_else(|| DstuError::not_found(essay_id))?;

        let title = essay.title.as_deref().unwrap_or("未命名作文");

        let content = VfsEssayRepo::get_essay_content(vfs_db, essay_id)
            .map_err(|e| DstuError::Internal(format!("获取作文内容失败: {}", e)))?
            .unwrap_or_default();

        let mut md = String::new();
        md.push_str("---\n");
        md.push_str(&format!("id: {}\n", essay.id));
        md.push_str(&format!("title: \"{}\"\n", title.replace('"', "\\\"")));
        if let Some(ref essay_type) = essay.essay_type {
            md.push_str(&format!("essay_type: {}\n", essay_type));
        }
        if let Some(score) = essay.score {
            md.push_str(&format!("score: {}\n", score));
        }
        md.push_str(&format!("round: {}\n", essay.round_number));
        md.push_str(&format!("created: {}\n", essay.created_at));
        md.push_str("---\n\n");
        md.push_str(&format!("# {}\n\n", title));
        md.push_str(&content);

        if let Some(ref grading) = essay.grading_result {
            if let Some(summary) = grading.get("summary").and_then(|v| v.as_str()) {
                md.push_str("\n\n## 批改意见\n\n");
                md.push_str(summary);
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
}
