//! 笔记导出适配器
//!
//! 支持格式：
//! - Markdown：笔记内容 + YAML frontmatter
//! - Zip：复用现有 NotesExporter 的单笔记导出

use std::sync::Arc;

use crate::dstu::error::DstuError;
use crate::dstu::types::DstuNodeType;
use crate::vfs::{VfsDatabase, VfsNoteRepo};

use super::{sanitize_filename, ExportFormat, ExportPayload, ResourceExportAdapter};

pub struct NoteExportAdapter;

impl ResourceExportAdapter for NoteExportAdapter {
    fn resource_type(&self) -> DstuNodeType {
        DstuNodeType::Note
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
                "笔记不支持 {} 格式导出",
                format.as_str()
            ))),
        }
    }
}

impl NoteExportAdapter {
    fn export_markdown(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        resource_id: &str,
    ) -> Result<ExportPayload, DstuError> {
        // 获取笔记元数据
        let note = VfsNoteRepo::get_note(vfs_db, resource_id)
            .map_err(|e| DstuError::Internal(format!("获取笔记失败: {}", e)))?
            .ok_or_else(|| DstuError::not_found(resource_id))?;

        // 获取笔记内容
        let content = VfsNoteRepo::get_note_content(vfs_db, resource_id)
            .map_err(|e| DstuError::Internal(format!("获取笔记内容失败: {}", e)))?
            .unwrap_or_default();

        // 构建 YAML frontmatter + 内容
        let mut md = String::new();
        md.push_str("---\n");
        md.push_str(&format!("id: {}\n", note.id));
        md.push_str(&format!("title: \"{}\"\n", note.title.replace('"', "\\\"")));
        md.push_str(&format!("created: {}\n", note.created_at));
        md.push_str(&format!("updated: {}\n", note.updated_at));
        if note.is_favorite {
            md.push_str("favorite: true\n");
        }
        if !note.tags.is_empty() {
            md.push_str("tags:\n");
            for tag in &note.tags {
                md.push_str(&format!("  - \"{}\"\n", tag.replace('"', "\\\"")));
            }
        }
        md.push_str("---\n\n");
        md.push_str(&content);

        let safe_title = sanitize_filename(&note.title);
        let filename = if safe_title.is_empty() {
            format!("{}.md", resource_id)
        } else {
            format!("{}.md", safe_title)
        };

        Ok(ExportPayload::Text {
            content: md,
            suggested_filename: filename,
            mime_type: "text/markdown".to_string(),
        })
    }
}
