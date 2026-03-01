//! 知识导图导出适配器
//!
//! 支持格式：
//! - Markdown：大纲模式（树形结构转 Markdown 列表）
//! - Original：原始 MindMapDocument JSON

use std::sync::Arc;

use crate::dstu::error::DstuError;
use crate::dstu::types::DstuNodeType;
use crate::vfs::{VfsDatabase, VfsMindMapRepo};

use super::{sanitize_filename, ExportFormat, ExportPayload, ResourceExportAdapter};

pub struct MindMapExportAdapter;

impl ResourceExportAdapter for MindMapExportAdapter {
    fn resource_type(&self) -> DstuNodeType {
        DstuNodeType::MindMap
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
                "知识导图不支持 {} 格式导出",
                format.as_str()
            ))),
        }
    }
}

impl MindMapExportAdapter {
    fn get_mindmap_meta(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        resource_id: &str,
    ) -> Result<crate::vfs::VfsMindMap, DstuError> {
        VfsMindMapRepo::get_mindmap(vfs_db, resource_id)
            .map_err(|e| DstuError::Internal(format!("获取知识导图失败: {}", e)))?
            .ok_or_else(|| DstuError::not_found(resource_id))
    }

    fn get_content_str(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        resource_id: &str,
    ) -> Result<String, DstuError> {
        VfsMindMapRepo::get_mindmap_content(vfs_db, resource_id)
            .map_err(|e| DstuError::Internal(format!("获取知识导图内容失败: {}", e)))?
            .ok_or_else(|| DstuError::Internal("知识导图内容为空".to_string()))
    }

    fn export_markdown(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        resource_id: &str,
    ) -> Result<ExportPayload, DstuError> {
        let mindmap = self.get_mindmap_meta(vfs_db, resource_id)?;
        let content_str = self.get_content_str(vfs_db, resource_id)?;

        let mut md = String::new();
        md.push_str("---\n");
        md.push_str(&format!("id: {}\n", mindmap.id));
        md.push_str(&format!("title: \"{}\"\n", mindmap.title.replace('"', "\\\"")));
        if let Some(ref desc) = mindmap.description {
            md.push_str(&format!("description: \"{}\"\n", desc.replace('"', "\\\"")));
        }
        md.push_str(&format!("created: {}\n", mindmap.created_at));
        md.push_str(&format!("updated: {}\n", mindmap.updated_at));
        md.push_str("---\n\n");
        md.push_str(&format!("# {}\n\n", mindmap.title));

        // 解析 JSON 并转换为 Markdown 大纲
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content_str) {
            if let Some(root) = json.get("root") {
                render_node_to_markdown(root, &mut md, 0);
            }
        } else {
            // 无法解析时输出原始内容
            md.push_str("```json\n");
            md.push_str(&content_str);
            md.push_str("\n```\n");
        }

        let safe_title = sanitize_filename(&mindmap.title);
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
        let mindmap = self.get_mindmap_meta(vfs_db, resource_id)?;
        let content_str = self.get_content_str(vfs_db, resource_id)?;

        // 尝试美化 JSON
        let pretty = if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content_str) {
            serde_json::to_string_pretty(&v).unwrap_or(content_str)
        } else {
            content_str
        };

        let safe_title = sanitize_filename(&mindmap.title);
        let filename = format!("{}.json", safe_title);

        Ok(ExportPayload::Text {
            content: pretty,
            suggested_filename: filename,
            mime_type: "application/json".to_string(),
        })
    }
}

/// 递归渲染导图节点为 Markdown 缩进列表
fn render_node_to_markdown(node: &serde_json::Value, md: &mut String, depth: usize) {
    let text = node
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("(空节点)");

    let indent = "  ".repeat(depth);
    md.push_str(&format!("{}- {}\n", indent, text));

    if let Some(children) = node.get("children").and_then(|v| v.as_array()) {
        for child in children {
            render_node_to_markdown(child, md, depth + 1);
        }
    }
}
