//! 题目集识别内容格式化模块
//!
//! 将题目集识别的 preview_json 格式化为上下文注入所需的 ContentBlock[] 格式。
//! 支持两种模式：
//! - 多模态模式：图片 + 文本交替（用于支持多模态的 AI 模型）
//! - 文本模式：纯 XML 格式文本（用于不支持多模态的 AI 模型）
//!
//! ## 使用示例
//! ```rust
//! let blocks = format_exam_for_context(&vfs_db, &exam_id, true).await?;
//! ```

use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

use crate::chat_v2::resource_types::ContentBlock;
use crate::models::{ExamCardPreview, ExamSheetPreviewResult};
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{VfsBlobRepo, VfsExamRepo};

/// 格式化题目集识别内容为 ContentBlock[]
///
/// ## 参数
/// - `vfs_db`: VFS 数据库实例
/// - `exam_id`: 题目集识别 ID
/// - `is_multimodal`: 是否为多模态模式
///
/// ## 返回
/// - 多模态模式：`ContentBlock[]`（图片 + 文本交替）
/// - 文本模式：`ContentBlock[]`（仅包含 XML 格式文本）
pub async fn format_exam_for_context(
    vfs_db: &Arc<VfsDatabase>,
    exam_id: &str,
    is_multimodal: bool,
) -> Result<Vec<ContentBlock>, String> {
    // 1. 获取题目集数据
    let exam = VfsExamRepo::get_exam_sheet(vfs_db, exam_id)
        .map_err(|e| format!("获取题目集数据失败: {}", e))?
        .ok_or_else(|| format!("题目集不存在: {}", exam_id))?;

    // 2. 解析 preview_json
    let preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json.clone())
        .map_err(|e| format!("解析 preview_json 失败: {}", e))?;

    // 3. 根据模式格式化
    if is_multimodal {
        format_multimodal(vfs_db, &preview).await
    } else {
        Ok(format_text_only(&preview))
    }
}

/// 多模态模式：图片 + 文本交替
///
/// 输出格式（按顺序）：
/// 1. `<attached_exam_sheet exam_name='xxx'>` 开始标签
/// 2. 每页：
///    - `<page index='N'>` 开始标签
///    - 页面图片（ImageContentBlock）
///    - 每题：`<question label='xxx' bbox='...'>OCR内容</question>`
///    - `</page>` 结束标签
/// 3. `</attached_exam_sheet>` 结束标签
async fn format_multimodal(
    vfs_db: &Arc<VfsDatabase>,
    preview: &ExamSheetPreviewResult,
) -> Result<Vec<ContentBlock>, String> {
    let mut blocks: Vec<ContentBlock> = Vec::new();

    // 开始标签
    blocks.push(ContentBlock::text(format!(
        "<attached_exam_sheet exam_name='{}'>",
        preview.exam_name.as_deref().unwrap_or("未命名试卷")
    )));

    // 遍历每一页
    for page in &preview.pages {
        // 页面开始标签
        blocks.push(ContentBlock::text(format!(
            "\n<page index='{}'>",
            page.page_index
        )));

        // 尝试获取页面图片
        if let Some(ref blob_hash) = page.blob_hash {
            // 新数据：从 VFS blobs 获取图片
            match get_blob_base64(vfs_db, blob_hash).await {
                Ok((base64, mime_type)) => {
                    blocks.push(ContentBlock::image(mime_type, base64));
                }
                Err(e) => {
                    log::warn!(
                        "[exam_formatter] 获取页面 {} 图片失败: {}",
                        page.page_index,
                        e
                    );
                    // 图片获取失败时添加占位文本
                    blocks.push(ContentBlock::text(format!(
                        "[页面 {} 图片加载失败]",
                        page.page_index
                    )));
                }
            }
        } else if !page.original_image_path.is_empty() {
            // 旧数据：添加提示（兼容处理）
            blocks.push(ContentBlock::text(format!(
                "[页面 {} 图片使用旧存储格式，需要迁移]",
                page.page_index
            )));
        }

        // 格式化题目内容
        let questions_xml = format_page_questions(&page.cards);
        if !questions_xml.is_empty() {
            blocks.push(ContentBlock::text(questions_xml));
        }

        // 页面结束标签
        blocks.push(ContentBlock::text("</page>".to_string()));
    }

    // 结束标签
    blocks.push(ContentBlock::text("\n</attached_exam_sheet>".to_string()));

    Ok(blocks)
}

/// 文本模式：纯 XML 格式
///
/// 输出格式：
/// ```xml
/// <attached_exam_sheet exam_name='xxx'>
///   <page index='0'>
///     <question label='1' bbox='0.1,0.2,0.3,0.4'>题目内容</question>
///     ...
///   </page>
///   ...
/// </attached_exam_sheet>
/// ```
fn format_text_only(preview: &ExamSheetPreviewResult) -> Vec<ContentBlock> {
    let mut xml = String::new();

    // 开始标签
    xml.push_str(&format!(
        "<attached_exam_sheet exam_name='{}'>\n",
        escape_xml(preview.exam_name.as_deref().unwrap_or("未命名试卷"))
    ));

    // 遍历每一页
    for page in &preview.pages {
        xml.push_str(&format!("  <page index='{}'>\n", page.page_index));

        // 格式化题目
        for card in &page.cards {
            let bbox_str = format!(
                "{:.3},{:.3},{:.3},{:.3}",
                card.bbox.x, card.bbox.y, card.bbox.width, card.bbox.height
            );
            xml.push_str(&format!(
                "    <question label='{}' bbox='{}'>{}</question>\n",
                escape_xml(&card.question_label),
                bbox_str,
                escape_xml(&card.ocr_text)
            ));
        }

        xml.push_str("  </page>\n");
    }

    // 结束标签
    xml.push_str("</attached_exam_sheet>");

    vec![ContentBlock::text(xml)]
}

/// 格式化单页的题目内容为 XML
fn format_page_questions(cards: &[ExamCardPreview]) -> String {
    let mut xml = String::new();

    for card in cards {
        let bbox_str = format!(
            "{:.3},{:.3},{:.3},{:.3}",
            card.bbox.x, card.bbox.y, card.bbox.width, card.bbox.height
        );
        xml.push_str(&format!(
            "\n<question label='{}' bbox='{}'>{}</question>",
            escape_xml(&card.question_label),
            bbox_str,
            escape_xml(&card.ocr_text)
        ));
    }

    xml
}

/// 从 VFS blobs 获取图片的 base64 数据
async fn get_blob_base64(
    vfs_db: &Arc<VfsDatabase>,
    blob_hash: &str,
) -> Result<(String, String), String> {
    // 获取 blob 元数据
    let blob = VfsBlobRepo::get_blob(vfs_db, blob_hash)
        .map_err(|e| format!("获取 blob 元数据失败: {}", e))?
        .ok_or_else(|| format!("Blob 不存在: {}", blob_hash))?;

    // 获取 blob 文件路径
    let blob_path = VfsBlobRepo::get_blob_path(vfs_db, blob_hash)
        .map_err(|e| format!("获取 blob 路径失败: {}", e))?
        .ok_or_else(|| format!("Blob 文件路径不存在: {}", blob_hash))?;

    // 读取文件内容
    let file_data = std::fs::read(&blob_path).map_err(|e| format!("读取 blob 文件失败: {}", e))?;

    // 转换为 base64
    let base64_data = BASE64.encode(&file_data);
    let mime_type = blob.mime_type.unwrap_or_else(|| "image/jpeg".to_string());

    Ok((base64_data, mime_type))
}

/// XML 转义
fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\'', "&apos;")
        .replace('"', "&quot;")
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ExamCardBBox, ExamSheetPreviewPage};

    fn create_test_preview() -> ExamSheetPreviewResult {
        ExamSheetPreviewResult {
            temp_id: "test_temp_id".to_string(),
            exam_name: Some("期末考试".to_string()),
            pages: vec![ExamSheetPreviewPage {
                page_index: 0,
                blob_hash: Some("abc123".to_string()),
                width: Some(800),
                height: Some(1200),
                original_image_path: String::new(),
                cards: vec![
                    ExamCardPreview {
                        card_id: "card_1".to_string(),
                        page_index: 0,
                        question_label: "1".to_string(),
                        bbox: ExamCardBBox {
                            x: 0.1,
                            y: 0.2,
                            width: 0.3,
                            height: 0.1,
                        },
                        resolved_bbox: None,
                        cropped_image_path: String::new(),
                        ocr_text: "求 x + 2 = 5 的解".to_string(),
                        tags: vec!["代数".to_string()],
                        extra_metadata: None,
                        linked_mistake_ids: None,
                        ..Default::default()
                    },
                    ExamCardPreview {
                        card_id: "card_2".to_string(),
                        page_index: 0,
                        question_label: "2".to_string(),
                        bbox: ExamCardBBox {
                            x: 0.1,
                            y: 0.4,
                            width: 0.3,
                            height: 0.15,
                        },
                        resolved_bbox: None,
                        cropped_image_path: String::new(),
                        ocr_text: "计算 3 × 4".to_string(),
                        tags: vec!["算术".to_string()],
                        extra_metadata: None,
                        linked_mistake_ids: None,
                        ..Default::default()
                    },
                ],
            }],
            raw_model_response: None,
            instructions: None,
            session_id: Some("session_test".to_string()),
        }
    }

    #[test]
    fn test_format_text_only() {
        let preview = create_test_preview();
        let blocks = format_text_only(&preview);

        assert_eq!(blocks.len(), 1);
        match &blocks[0] {
            ContentBlock::Text { text } => {
                assert!(text.contains("<attached_exam_sheet"));
                assert!(text.contains("exam_name='期末考试'"));
                assert!(text.contains("<question label='1'"));
                assert!(text.contains("求 x + 2 = 5 的解"));
                assert!(text.contains("</attached_exam_sheet>"));
            }
            _ => panic!("Expected Text block"),
        }
    }

    #[test]
    fn test_escape_xml() {
        assert_eq!(escape_xml("a < b"), "a &lt; b");
        assert_eq!(escape_xml("a > b"), "a &gt; b");
        assert_eq!(escape_xml("a & b"), "a &amp; b");
        assert_eq!(escape_xml("a 'b' c"), "a &apos;b&apos; c");
        assert_eq!(escape_xml("a \"b\" c"), "a &quot;b&quot; c");
    }

    #[test]
    fn test_format_page_questions() {
        let cards = vec![ExamCardPreview {
            card_id: "card_1".to_string(),
            page_index: 0,
            question_label: "1".to_string(),
            bbox: ExamCardBBox {
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.1,
            },
            resolved_bbox: None,
            cropped_image_path: String::new(),
            ocr_text: "测试题目".to_string(),
            tags: vec![],
            extra_metadata: None,
            linked_mistake_ids: None,
            ..Default::default()
        }];

        let xml = format_page_questions(&cards);
        assert!(xml.contains("<question label='1'"));
        assert!(xml.contains("bbox='0.100,0.200,0.300,0.100'"));
        assert!(xml.contains("测试题目"));
    }
}
