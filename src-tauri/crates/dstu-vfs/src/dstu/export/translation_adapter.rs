//! 翻译导出适配器
//!
//! 支持格式：
//! - Markdown：双语对照格式
//! - Original：原始 JSON（source + translated）

use std::sync::Arc;

use crate::dstu::error::DstuError;
use crate::dstu::types::DstuNodeType;
use crate::vfs::{VfsDatabase, VfsTranslationRepo};

use super::{sanitize_filename, ExportFormat, ExportPayload, ResourceExportAdapter};

pub struct TranslationExportAdapter;

impl ResourceExportAdapter for TranslationExportAdapter {
    fn resource_type(&self) -> DstuNodeType {
        DstuNodeType::Translation
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
                "翻译不支持 {} 格式导出",
                format.as_str()
            ))),
        }
    }
}

impl TranslationExportAdapter {
    fn export_markdown(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        resource_id: &str,
    ) -> Result<ExportPayload, DstuError> {
        let translation = VfsTranslationRepo::get_translation(vfs_db, resource_id)
            .map_err(|e| DstuError::Internal(format!("获取翻译失败: {}", e)))?
            .ok_or_else(|| DstuError::not_found(resource_id))?;

        let title = translation.title.as_deref().unwrap_or("未命名翻译");

        // 获取翻译内容（JSON 格式）
        let content_str = VfsTranslationRepo::get_translation_content(vfs_db, resource_id)
            .map_err(|e| DstuError::Internal(format!("获取翻译内容失败: {}", e)))?
            .unwrap_or_default();

        // 解析 JSON 获取 source 和 translated
        let (source, translated) =
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content_str) {
                let src = json
                    .get("source")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let tgt = json
                    .get("translated")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                (src, tgt)
            } else {
                // 非 JSON 格式，整体作为翻译内容
                (String::new(), content_str)
            };

        let mut md = String::new();
        md.push_str("---\n");
        md.push_str(&format!("id: {}\n", translation.id));
        md.push_str(&format!("title: \"{}\"\n", title.replace('"', "\\\"")));
        md.push_str(&format!("src_lang: {}\n", translation.src_lang));
        md.push_str(&format!("tgt_lang: {}\n", translation.tgt_lang));
        if let Some(ref engine) = translation.engine {
            md.push_str(&format!("engine: {}\n", engine));
        }
        md.push_str(&format!("created: {}\n", translation.created_at));
        md.push_str("---\n\n");
        md.push_str(&format!("# {}\n\n", title));

        if !source.is_empty() {
            md.push_str("## 原文\n\n");
            md.push_str(&source);
            md.push_str("\n\n");
        }
        if !translated.is_empty() {
            md.push_str("## 译文\n\n");
            md.push_str(&translated);
            md.push('\n');
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
        let translation = VfsTranslationRepo::get_translation(vfs_db, resource_id)
            .map_err(|e| DstuError::Internal(format!("获取翻译失败: {}", e)))?
            .ok_or_else(|| DstuError::not_found(resource_id))?;

        let title = translation.title.as_deref().unwrap_or("未命名翻译");

        let content_str = VfsTranslationRepo::get_translation_content(vfs_db, resource_id)
            .map_err(|e| DstuError::Internal(format!("获取翻译内容失败: {}", e)))?
            .unwrap_or_default();

        let safe_title = sanitize_filename(title);
        let filename = format!("{}.json", safe_title);

        Ok(ExportPayload::Text {
            content: content_str,
            suggested_filename: filename,
            mime_type: "application/json".to_string(),
        })
    }
}
