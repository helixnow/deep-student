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
        let preview_pages: Vec<Option<(String, String)>> =
            parse_preview_pages(&input.preview_json, page_count);

        let mut units = Vec::with_capacity(page_count);

        for i in 0..page_count {
            let text_content = ocr_pages.get(i).cloned().flatten();
            let (image_blob_hash, image_mime_type) = preview_pages
                .get(i)
                .cloned()
                .flatten()
                .map(|(hash, mime)| (Some(hash), Some(mime)))
                .unwrap_or((None, None));

            let text_source = if text_content.is_some() {
                Some("ocr".to_string())
            } else {
                None
            };

            units.push(CreateUnitInput {
                resource_id: input.resource_id.clone(),
                unit_index: i as i32,
                image_blob_hash,
                image_mime_type,
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
        let preview_pages: Vec<Option<(String, String)>> =
            parse_preview_pages(&input.preview_json, page_count);

        let mut units = Vec::with_capacity(page_count);

        for i in 0..page_count {
            let text_content = ocr_pages.get(i).cloned().flatten();
            let (image_blob_hash, image_mime_type) = preview_pages
                .get(i)
                .cloned()
                .flatten()
                .map(|(hash, mime)| (Some(hash), Some(mime)))
                .unwrap_or((None, None));

            let text_source = if text_content.is_some() {
                Some("ocr".to_string())
            } else {
                None
            };

            units.push(CreateUnitInput {
                resource_id: input.resource_id.clone(),
                unit_index: i as i32,
                image_blob_hash,
                image_mime_type,
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

        // ★ 2026-09 修复（PDF bytes as image）：`input.blob_hash` 是文件本体 hash（PDF 即
        // `%PDF` 字节），而 `image_blob_hash` 的语义是"页图片 blob"。把文件本体写进
        // image 字段会让下游 canonical 图片解析把 PDF 字节当 PNG 发给多模态模型
        // （count_token_failed HTTP 500）。file 资源没有页图，保持 None。
        let image_blob_hash: Option<String> = None;

        if has_extracted && has_ocr {
            // 双来源：分别创建 unit
            units.push(CreateUnitInput {
                resource_id: input.resource_id.clone(),
                unit_index: 0,
                image_blob_hash: image_blob_hash.clone(),
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
                image_blob_hash,
                image_mime_type: None,
                text_content: input.extracted_text.clone(),
                text_source: Some("native".to_string()),
            });
        } else if has_ocr {
            units.push(CreateUnitInput {
                resource_id: input.resource_id.clone(),
                unit_index: 0,
                image_blob_hash,
                image_mime_type: None,
                text_content: input.ocr_text.clone(),
                text_source: Some("ocr".to_string()),
            });
        } else {
            // 无文本，仍创建占位 unit
            units.push(CreateUnitInput {
                resource_id: input.resource_id.clone(),
                unit_index: 0,
                image_blob_hash,
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

            // ★ 2026-09 修复（PDF bytes as image）：与 FileBuilder 相同——单页附件的
            // `input.blob_hash` 是文件本体 hash，不是页图片 blob，绝不写入 image 字段。
            let image_blob_hash: Option<String> = None;

            if has_extracted && has_ocr {
                units.push(CreateUnitInput {
                    resource_id: input.resource_id.clone(),
                    unit_index: 0,
                    image_blob_hash: image_blob_hash.clone(),
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
                    image_blob_hash,
                    image_mime_type: None,
                    text_content: input.extracted_text.clone(),
                    text_source: Some("native".to_string()),
                });
            } else if has_ocr {
                units.push(CreateUnitInput {
                    resource_id: input.resource_id.clone(),
                    unit_index: 0,
                    image_blob_hash,
                    image_mime_type: None,
                    text_content: input.ocr_text.clone(),
                    text_source: Some("ocr".to_string()),
                });
            } else {
                units.push(CreateUnitInput {
                    resource_id: input.resource_id.clone(),
                    unit_index: 0,
                    image_blob_hash,
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

        let preview_pages: Vec<Option<(String, String)>> =
            parse_preview_pages(&input.preview_json, page_count);

        let mut units = Vec::with_capacity(page_count);

        for i in 0..page_count {
            let text_content = ocr_pages.get(i).cloned().flatten();
            let (image_blob_hash, image_mime_type) = preview_pages
                .get(i)
                .cloned()
                .flatten()
                .map(|(hash, mime)| (Some(hash), Some(mime)))
                .unwrap_or((None, None));

            let text_source = if text_content.is_some() {
                Some("ocr".to_string())
            } else {
                None
            };

            units.push(CreateUnitInput {
                resource_id: input.resource_id.clone(),
                unit_index: i as i32,
                image_blob_hash,
                image_mime_type,
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
///
/// ★ 2026-09 修复（PDF bytes as image）：
/// - `PdfPagePreview` 序列化为 camelCase（`blobHash`/`compressedBlobHash`），旧实现只认
///   蛇形 `hash`/`blob_hash`/`image_hash`，导致真页图 hash 从未被提取，上游只能回退
///   到文件本体 hash；
/// - 压缩页图（`compressedBlobHash`）优先，与发送侧"优先低质量压缩版"的预算策略一致；
/// - 同时返回每页真实 mime，供 `image_mime_type` 落库，消费方不再猜 `image/png`。
fn parse_preview_pages(
    preview_json: &Option<String>,
    page_count: usize,
) -> Vec<Option<(String, String)>> {
    let mut pages: Vec<Option<(String, String)>> = preview_json
        .as_ref()
        .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
        .and_then(|v| {
            v.get("pages")
                .and_then(serde_json::Value::as_array)
                .cloned()
        })
        .map(|arr| {
            arr.iter()
                .map(|page| {
                    let hash = page
                        .get("compressedBlobHash")
                        .or_else(|| page.get("compressed_blob_hash"))
                        .or_else(|| page.get("blobHash"))
                        .or_else(|| page.get("blob_hash"))
                        .or_else(|| page.get("hash"))
                        .or_else(|| page.get("image_hash"))
                        .and_then(|h| h.as_str())
                        .filter(|h| !h.is_empty())
                        .map(|h| h.to_string());
                    let mime = page
                        .get("mimeType")
                        .or_else(|| page.get("mime_type"))
                        .and_then(|m| m.as_str())
                        .filter(|m| m.starts_with("image/"))
                        .unwrap_or("image/png")
                        .to_string();
                    hash.map(|h| (h, mime))
                })
                .collect()
        })
        .unwrap_or_default();
    if pages.len() < page_count {
        pages.resize(page_count, None);
    }
    pages
}

/// 思维导图文本提取最大深度（与 normalize 的 100 层上限一致，防栈溢出）
const MAX_MINDMAP_EXTRACT_DEPTH: usize = 100;

/// 从思维导图 JSON 提取所有节点文本（含备注，层级缩进）
///
/// ★ 2026-07 修复（E6）：
/// - 标准 MindMapDocument 的节点在 `root` 键下，旧实现不下钻 root 导致索引文本为空；
/// - 节点 `note` 备注一并纳入索引文本（缩进跟随所属节点，保持大纲可读）。
fn extract_mindmap_text(json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .map(|v| {
            let mut lines = Vec::new();
            // 标准 MindMapDocument 从 root 下钻；兼容直接传节点/数组的旧数据
            let start = v.get("root").unwrap_or(&v);
            extract_texts_recursive(start, 0, &mut lines);
            lines.join("\n")
        })
        .filter(|s| !s.is_empty())
}

fn extract_texts_recursive(value: &serde_json::Value, depth: usize, texts: &mut Vec<String>) {
    if depth > MAX_MINDMAP_EXTRACT_DEPTH {
        return;
    }
    match value {
        serde_json::Value::Object(map) => {
            let indent = "  ".repeat(depth);
            // 提取 text、label、title、content 等常见文本字段
            for key in ["text", "label", "title", "content", "name"] {
                if let Some(text) = map.get(key).and_then(|v| v.as_str()) {
                    if !text.is_empty() {
                        texts.push(format!("{}{}", indent, text));
                    }
                }
            }
            // 备注：多行备注逐行缩进到所属节点下一层
            if let Some(note) = map.get("note").and_then(|v| v.as_str()) {
                if !note.trim().is_empty() {
                    for note_line in note.trim().lines() {
                        texts.push(format!("{}  {}", indent, note_line));
                    }
                }
            }
            // 递归处理子节点
            if let Some(children) = map.get("children").and_then(|v| v.as_array()) {
                for child in children {
                    extract_texts_recursive(child, depth + 1, texts);
                }
            }
            if let Some(nodes) = map.get("nodes").and_then(|v| v.as_array()) {
                for node in nodes {
                    extract_texts_recursive(node, depth + 1, texts);
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                extract_texts_recursive(item, depth, texts);
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
    fn test_mindmap_builder_extracts_root_and_notes() {
        let builder = MindmapBuilder;
        let input = UnitBuildInput {
            resource_id: "res_789".to_string(),
            resource_type: "mindmap".to_string(),
            data: Some(
                r#"{"version":"1.0","root":{"id":"root","text":"主题","note":"根备注","children":[{"id":"n1","text":"子节点","note":"第一行\n第二行","children":[]}]}}"#
                    .to_string(),
            ),
            ocr_text: None,
            ocr_pages_json: None,
            blob_hash: None,
            page_count: None,
            extracted_text: None,
            preview_json: None,
        };

        let output = builder.build(&input);
        assert_eq!(output.units.len(), 1);
        let text = output.units[0].text_content.as_deref().unwrap();
        // root 下钻：节点文本必须出现
        assert!(text.contains("主题"));
        assert!(text.contains("子节点"));
        // 备注纳入索引文本（多行逐行保留）
        assert!(text.contains("根备注"));
        assert!(text.contains("第一行"));
        assert!(text.contains("第二行"));
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

    // ★ 2026-09 修复（PDF bytes as image）回归测试

    #[test]
    fn file_builder_never_writes_file_blob_into_image_field() {
        let builder = FileBuilder;
        let input = UnitBuildInput {
            resource_id: "res_file".to_string(),
            resource_type: "file".to_string(),
            data: None,
            ocr_text: None,
            ocr_pages_json: None,
            blob_hash: Some("8445c67bpdf-file-blob".to_string()),
            page_count: None,
            extracted_text: Some("native text".to_string()),
            preview_json: None,
        };

        let output = builder.build(&input);
        assert_eq!(output.units.len(), 1);
        assert_eq!(
            output.units[0].image_blob_hash, None,
            "file 本体 hash 绝不能写入 image_blob_hash"
        );
    }

    #[test]
    fn single_page_attachment_never_writes_file_blob_into_image_field() {
        let builder = AttachmentBuilder;
        let input = UnitBuildInput {
            resource_id: "res_att".to_string(),
            resource_type: "attachment".to_string(),
            data: None,
            ocr_text: None,
            ocr_pages_json: None,
            blob_hash: Some("8445c67bpdf-file-blob".to_string()),
            page_count: Some(1),
            extracted_text: Some("native text".to_string()),
            preview_json: None,
        };

        let output = builder.build(&input);
        assert_eq!(output.units.len(), 1);
        assert_eq!(output.units[0].image_blob_hash, None);
    }

    #[test]
    fn parse_preview_pages_reads_camel_case_hashes_and_mime() {
        let preview_json = r#"{"pages":[
            {"pageIndex":0,"blobHash":"5e26aaaa","compressedBlobHash":"d47abbbb","mimeType":"image/jpeg"},
            {"pageIndex":1,"blobHash":"aa11","mimeType":"image/png"}
        ]}"#;
        let pages = parse_preview_pages(&Some(preview_json.to_string()), 2);

        assert_eq!(pages.len(), 2);
        // 压缩页图优先
        assert_eq!(
            pages[0]
                .as_ref()
                .map(|(hash, mime)| (hash.as_str(), mime.as_str())),
            Some(("d47abbbb", "image/jpeg"))
        );
        assert_eq!(
            pages[1]
                .as_ref()
                .map(|(hash, mime)| (hash.as_str(), mime.as_str())),
            Some(("aa11", "image/png"))
        );
    }

    #[test]
    fn attachment_builder_uses_preview_page_hashes_not_file_blob() {
        let builder = AttachmentBuilder;
        let preview_json = r#"{"pages":[
            {"pageIndex":0,"blobHash":"5e26page0","mimeType":"image/jpeg"},
            {"pageIndex":1,"blobHash":"5e26page1","mimeType":"image/jpeg"}
        ]}"#;
        let input = UnitBuildInput {
            resource_id: "res_pdf".to_string(),
            resource_type: "attachment".to_string(),
            data: None,
            ocr_text: None,
            ocr_pages_json: None,
            blob_hash: Some("8445c67bpdf-file-blob".to_string()),
            page_count: Some(2),
            extracted_text: None,
            preview_json: Some(preview_json.to_string()),
        };

        let output = builder.build(&input);
        assert_eq!(output.units.len(), 2);
        assert_eq!(
            output.units[0].image_blob_hash.as_deref(),
            Some("5e26page0"),
            "unit 必须使用 preview 页图 hash，而非文件本体 hash"
        );
        assert_eq!(
            output.units[0].image_mime_type.as_deref(),
            Some("image/jpeg")
        );
        assert_eq!(
            output.units[1].image_blob_hash.as_deref(),
            Some("5e26page1")
        );
    }
}
