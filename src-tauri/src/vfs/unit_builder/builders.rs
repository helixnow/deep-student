//! 具体的 Unit Builder 实现

use super::trait_def::{UnitBuildInput, UnitBuildOutput, UnitBuilder};
use crate::vfs::ocr_utils::parse_ocr_pages_json;
use crate::vfs::repos::index_unit_repo::CreateUnitInput;

/// 笔记 Builder
///
/// 笔记是纯文本资源，产生 1 个 Unit
pub struct NoteBuilder;

impl UnitBuilder for NoteBuilder {
    fn resource_type(&self) -> &'static str {
        "note"
    }

    fn build(&self, input: &UnitBuildInput) -> UnitBuildOutput {
        let text_content = input.data.clone();

        UnitBuildOutput {
            units: vec![CreateUnitInput {
                resource_id: input.resource_id.clone(),
                unit_index: 0,
                image_blob_hash: None,
                image_mime_type: None,
                text_content,
                text_source: Some("native".to_string()),
            }],
        }
    }
}

/// 教材 Builder
///
/// PDF 教材是多页资源，每页产生 1 个 Unit
///
/// ★ P1 修复：支持 extracted_text（无 OCR 时生成单页文本 Unit）
/// 适用于 csv/json/xml 等纯文本格式的教材
pub struct TextbookBuilder;

impl UnitBuilder for TextbookBuilder {
    fn resource_type(&self) -> &'static str {
        "textbook"
    }

    fn build(&self, input: &UnitBuildInput) -> UnitBuildOutput {
        let page_count = input.page_count.unwrap_or(1) as usize;

        // 解析 OCR 页面 JSON
        let mut ocr_pages: Vec<Option<String>> = input
            .ocr_pages_json
            .as_deref()
            .map(parse_ocr_pages_json)
            .unwrap_or_default();
        if ocr_pages.len() < page_count {
            ocr_pages.resize(page_count, None);
        }

        // ★ P1 修复：检查是否有有效的 OCR 内容
        let has_ocr_content = ocr_pages
            .iter()
            .any(|p| p.as_ref().map(|t| !t.trim().is_empty()).unwrap_or(false));

        // ★ 如果没有 OCR 内容但有 extracted_text，生成单页文本 Unit
        if !has_ocr_content {
            if let Some(ref text) = input.extracted_text {
                if !text.trim().is_empty() {
                    return UnitBuildOutput {
                        units: vec![CreateUnitInput {
                            resource_id: input.resource_id.clone(),
                            unit_index: 0,
                            image_blob_hash: None,
                            image_mime_type: None,
                            text_content: Some(text.clone()),
                            text_source: Some("native".to_string()),
                        }],
                    };
                }
            }
        }

        // 解析预览 JSON 获取页面图片 hash
        let preview_pages: Vec<Option<String>> =
            parse_preview_hashes(&input.preview_json, page_count);

        let mut units = Vec::with_capacity(page_count);

        for i in 0..page_count {
            let text_content = ocr_pages.get(i).cloned().flatten();
            let image_blob_hash = preview_pages.get(i).cloned().flatten();

            let text_source = if text_content.is_some() {
                Some("ocr".to_string())
            } else {
                None
            };

            units.push(CreateUnitInput {
                resource_id: input.resource_id.clone(),
                unit_index: i as i32,
                image_blob_hash,
                image_mime_type: Some("image/png".to_string()),
                text_content,
                text_source,
            });
        }

        UnitBuildOutput { units }
    }
}

/// 图片 Builder
///
/// 单张图片产生 1 个 Unit
pub struct ImageBuilder;

impl UnitBuilder for ImageBuilder {
    fn resource_type(&self) -> &'static str {
        "image"
    }

    fn build(&self, input: &UnitBuildInput) -> UnitBuildOutput {
        let text_content = input.ocr_text.clone();
        let text_source = if text_content.is_some() {
            Some("ocr".to_string())
        } else {
            None
        };

        UnitBuildOutput {
            units: vec![CreateUnitInput {
                resource_id: input.resource_id.clone(),
                unit_index: 0,
                image_blob_hash: input.blob_hash.clone(),
                image_mime_type: Some("image/png".to_string()),
                text_content,
                text_source,
            }],
        }
    }
}

/// 题目集识别 Builder
///
/// 试卷是多页资源，每页产生 1 个 Unit
pub struct ExamBuilder;

impl UnitBuilder for ExamBuilder {
    fn resource_type(&self) -> &'static str {
        "exam"
    }

    fn build(&self, input: &UnitBuildInput) -> UnitBuildOutput {
        // 解析 OCR 页面 JSON（兼容多格式）
        let ocr_pages: Vec<Option<String>> = input
            .ocr_pages_json
            .as_deref()
            .map(parse_ocr_pages_json)
            .unwrap_or_default();

        let page_count = if ocr_pages.is_empty() {
            input.page_count.unwrap_or(1) as usize
        } else {
            ocr_pages.len()
        };

        // 解析预览 JSON 获取页面图片 hash
        let preview_pages: Vec<Option<String>> =
            parse_preview_hashes(&input.preview_json, page_count);

        let mut units = Vec::with_capacity(page_count);

        for i in 0..page_count {
            let text_content = ocr_pages.get(i).cloned().flatten();
            let image_blob_hash = preview_pages.get(i).cloned().flatten();

            let text_source = if text_content.is_some() {
                Some("ocr".to_string())
            } else {
                None
            };

            units.push(CreateUnitInput {
                resource_id: input.resource_id.clone(),
                unit_index: i as i32,
                image_blob_hash,
                image_mime_type: Some("image/png".to_string()),
                text_content,
                text_source,
            });
        }

        UnitBuildOutput { units }
    }
}

/// 翻译 Builder
///
/// 翻译产生 1 个 Unit（原文+译文合并）
pub struct TranslationBuilder;

impl UnitBuilder for TranslationBuilder {
    fn resource_type(&self) -> &'static str {
        "translation"
    }

    fn build(&self, input: &UnitBuildInput) -> UnitBuildOutput {
        // data 格式: JSON { "source": "...", "translated": "..." }
        let text_content = input
            .data
            .as_ref()
            .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
            .map(|v| {
                let source = v.get("source").and_then(|s| s.as_str()).unwrap_or("");
                let translated = v.get("translated").and_then(|s| s.as_str()).unwrap_or("");
                format!("{}\n\n---\n\n{}", source, translated)
            });

        UnitBuildOutput {
            units: vec![CreateUnitInput {
                resource_id: input.resource_id.clone(),
                unit_index: 0,
                image_blob_hash: None,
                image_mime_type: None,
                text_content,
                text_source: Some("native".to_string()),
            }],
        }
    }
}

/// 作文 Builder
///
/// 作文产生 1 个 Unit
pub struct EssayBuilder;

impl UnitBuilder for EssayBuilder {
    fn resource_type(&self) -> &'static str {
        "essay"
    }

    fn build(&self, input: &UnitBuildInput) -> UnitBuildOutput {
        let text_content = input.data.clone();

        UnitBuildOutput {
            units: vec![CreateUnitInput {
                resource_id: input.resource_id.clone(),
                unit_index: 0,
                image_blob_hash: None,
                image_mime_type: None,
                text_content,
                text_source: Some("native".to_string()),
            }],
        }
    }
}

/// 思维导图 Builder
///
/// 思维导图产生 1 个 Unit（节点文本合并）
pub struct MindmapBuilder;

impl UnitBuilder for MindmapBuilder {
    fn resource_type(&self) -> &'static str {
        "mindmap"
    }

    fn build(&self, input: &UnitBuildInput) -> UnitBuildOutput {
        // data 是思维导图的 JSON 结构，提取所有节点文本
        let text_content = input
            .data
            .as_ref()
            .and_then(|json| extract_mindmap_text(json));

        UnitBuildOutput {
            units: vec![CreateUnitInput {
                resource_id: input.resource_id.clone(),
                unit_index: 0,
                image_blob_hash: None,
                image_mime_type: None,
                text_content,
                text_source: Some("native".to_string()),
            }],
        }
    }
}

/// 通用文件 Builder
///
/// 文件可产生 1~2 个 Unit：
/// - 当同时存在 extracted_text 和 ocr_text 时，生成 2 个 Unit 分别索引
/// - 否则只生成 1 个 Unit
pub struct FileBuilder;

impl UnitBuilder for FileBuilder {
    fn resource_type(&self) -> &'static str {
        "file"
    }

    fn build(&self, input: &UnitBuildInput) -> UnitBuildOutput {
        let has_extracted = input
            .extracted_text
            .as_ref()
            .map(|t| !t.trim().is_empty())
            .unwrap_or(false);
        let has_ocr = input
            .ocr_text
            .as_ref()
            .map(|t| !t.trim().is_empty())
            .unwrap_or(false);

        let mut units = Vec::new();

        if has_extracted && has_ocr {
            // 双来源：分别创建 unit
            units.push(CreateUnitInput {
                resource_id: input.resource_id.clone(),
                unit_index: 0,
                image_blob_hash: input.blob_hash.clone(),
                image_mime_type: None,
                text_content: input.extracted_text.clone(),
                text_source: Some("native".to_string()),
            });
            units.push(CreateUnitInput {
                resource_id: input.resource_id.clone(),
                unit_index: 1,
                image_blob_hash: None,
                image_mime_type: None,
                text_content: input.ocr_text.clone(),
                text_source: Some("ocr".to_string()),
            });
        } else if has_extracted {
            units.push(CreateUnitInput {
                resource_id: input.resource_id.clone(),
                unit_index: 0,
                image_blob_hash: input.blob_hash.clone(),
                image_mime_type: None,
                text_content: input.extracted_text.clone(),
                text_source: Some("native".to_string()),
            });
        } else if has_ocr {
            units.push(CreateUnitInput {
                resource_id: input.resource_id.clone(),
                unit_index: 0,
                image_blob_hash: input.blob_hash.clone(),
                image_mime_type: None,
                text_content: input.ocr_text.clone(),
                text_source: Some("ocr".to_string()),
            });
        } else {
            // 无文本，仍创建占位 unit
            units.push(CreateUnitInput {
                resource_id: input.resource_id.clone(),
                unit_index: 0,
                image_blob_hash: input.blob_hash.clone(),
                image_mime_type: None,
                text_content: None,
                text_source: None,
            });
        }

        UnitBuildOutput { units }
    }
}

/// 附件 Builder
///
/// 附件可能是单页或多页
pub struct AttachmentBuilder;

impl UnitBuilder for AttachmentBuilder {
    fn resource_type(&self) -> &'static str {
        "attachment"
    }

    fn build(&self, input: &UnitBuildInput) -> UnitBuildOutput {
        let page_count = input.page_count.unwrap_or(1) as usize;

        if page_count <= 1 {
            // 单页附件 - 与 FileBuilder 一致的双来源逻辑
            let has_extracted = input
                .extracted_text
                .as_ref()
                .map(|t| !t.trim().is_empty())
                .unwrap_or(false);
            let has_ocr = input
                .ocr_text
                .as_ref()
                .map(|t| !t.trim().is_empty())
                .unwrap_or(false);

            let mut units = Vec::new();

            if has_extracted && has_ocr {
                units.push(CreateUnitInput {
                    resource_id: input.resource_id.clone(),
                    unit_index: 0,
                    image_blob_hash: input.blob_hash.clone(),
                    image_mime_type: None,
                    text_content: input.extracted_text.clone(),
                    text_source: Some("native".to_string()),
                });
                units.push(CreateUnitInput {
                    resource_id: input.resource_id.clone(),
                    unit_index: 1,
                    image_blob_hash: None,
                    image_mime_type: None,
                    text_content: input.ocr_text.clone(),
                    text_source: Some("ocr".to_string()),
                });
            } else if has_extracted {
                units.push(CreateUnitInput {
                    resource_id: input.resource_id.clone(),
                    unit_index: 0,
                    image_blob_hash: input.blob_hash.clone(),
                    image_mime_type: None,
                    text_content: input.extracted_text.clone(),
                    text_source: Some("native".to_string()),
                });
            } else if has_ocr {
                units.push(CreateUnitInput {
                    resource_id: input.resource_id.clone(),
                    unit_index: 0,
                    image_blob_hash: input.blob_hash.clone(),
                    image_mime_type: None,
                    text_content: input.ocr_text.clone(),
                    text_source: Some("ocr".to_string()),
                });
            } else {
                units.push(CreateUnitInput {
                    resource_id: input.resource_id.clone(),
                    unit_index: 0,
                    image_blob_hash: input.blob_hash.clone(),
                    image_mime_type: None,
                    text_content: None,
                    text_source: None,
                });
            }

            return UnitBuildOutput { units };
        }

        // 多页附件（PDF）
        let mut ocr_pages: Vec<Option<String>> = input
            .ocr_pages_json
            .as_deref()
            .map(parse_ocr_pages_json)
            .unwrap_or_default();
        if ocr_pages.len() < page_count {
            ocr_pages.resize(page_count, None);
        }

        let preview_pages: Vec<Option<String>> =
            parse_preview_hashes(&input.preview_json, page_count);

        let mut units = Vec::with_capacity(page_count);

        for i in 0..page_count {
            let text_content = ocr_pages.get(i).cloned().flatten();
            let image_blob_hash = preview_pages.get(i).cloned().flatten();

            let text_source = if text_content.is_some() {
                Some("ocr".to_string())
            } else {
                None
            };

            units.push(CreateUnitInput {
                resource_id: input.resource_id.clone(),
                unit_index: i as i32,
                image_blob_hash,
                image_mime_type: Some("image/png".to_string()),
                text_content,
                text_source,
            });
        }

        UnitBuildOutput { units }
    }
}

// ============================================================================
// 辅助函数
// ============================================================================

/// 从 preview_json 解析页面图片 hash
fn parse_preview_hashes(preview_json: &Option<String>, page_count: usize) -> Vec<Option<String>> {
    preview_json
        .as_ref()
        .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
        .and_then(|v| {
            // 尝试解析 { "pages": [{"hash": "xxx"}, ...] } 格式
            v.get("pages")
                .and_then(|pages| pages.as_array())
                .map(|arr| {
                    arr.iter()
                        .map(|page| {
                            page.get("hash")
                                .or_else(|| page.get("blob_hash"))
                                .or_else(|| page.get("image_hash"))
                                .and_then(|h| h.as_str())
                                .map(|s| s.to_string())
                        })
                        .collect()
                })
        })
        .unwrap_or_else(|| vec![None; page_count])
}

/// 从思维导图 JSON 提取所有节点文本
fn extract_mindmap_text(json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .map(|v| {
            let mut texts = Vec::new();
            extract_texts_recursive(&v, &mut texts);
            texts.join("\n")
        })
        .filter(|s| !s.is_empty())
}

fn extract_texts_recursive(value: &serde_json::Value, texts: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(map) => {
            // 提取 text、label、title、content 等常见文本字段
            for key in ["text", "label", "title", "content", "name"] {
                if let Some(text) = map.get(key).and_then(|v| v.as_str()) {
                    if !text.is_empty() {
                        texts.push(text.to_string());
                    }
                }
            }
            // 递归处理子节点
            if let Some(children) = map.get("children").and_then(|v| v.as_array()) {
                for child in children {
                    extract_texts_recursive(child, texts);
                }
            }
            if let Some(nodes) = map.get("nodes").and_then(|v| v.as_array()) {
                for node in nodes {
                    extract_texts_recursive(node, texts);
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                extract_texts_recursive(item, texts);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_note_builder() {
        let builder = NoteBuilder;
        let input = UnitBuildInput {
            resource_id: "res_123".to_string(),
            resource_type: "note".to_string(),
            data: Some("Hello world".to_string()),
            ocr_text: None,
            ocr_pages_json: None,
            blob_hash: None,
            page_count: None,
            extracted_text: None,
            preview_json: None,
        };

        let output = builder.build(&input);
        assert_eq!(output.units.len(), 1);
        assert_eq!(
            output.units[0].text_content,
            Some("Hello world".to_string())
        );
        assert_eq!(output.units[0].text_source, Some("native".to_string()));
    }

    #[test]
    fn test_textbook_builder() {
        let builder = TextbookBuilder;
        let input = UnitBuildInput {
            resource_id: "res_456".to_string(),
            resource_type: "textbook".to_string(),
            data: None,
            ocr_text: None,
            ocr_pages_json: Some(r#"["Page 1 text", null, "Page 3 text"]"#.to_string()),
            blob_hash: None,
            page_count: Some(3),
            extracted_text: None,
            preview_json: None,
        };

        let output = builder.build(&input);
        assert_eq!(output.units.len(), 3);
        assert_eq!(
            output.units[0].text_content,
            Some("Page 1 text".to_string())
        );
        assert_eq!(output.units[1].text_content, None);
        assert_eq!(
            output.units[2].text_content,
            Some("Page 3 text".to_string())
        );
    }
}
