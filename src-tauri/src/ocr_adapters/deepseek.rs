//! DeepSeek-OCR 适配器
//!
//! 实现 DeepSeek-OCR 的 prompt 构建和响应解析。
//!
//! ## DeepSeek-OCR 特点
//!
//! - 支持 grounding 模式，输出带坐标的结构化结果
//! - 坐标格式：`<|ref|>标签<|/ref|><|det|>[[x1,y1,x2,y2]]<|/det|>`
//! - 坐标系统：0-999 归一化 xyxy 坐标
//!
//! ## 官方支持的 Prompt
//!
//! - 文档转Markdown（带坐标）：`<|grounding|>Convert the document to markdown.`
//! - 通用OCR（带坐标）：`<|grounding|>OCR this image.`
//! - 无布局提取：`Free OCR.`
//! - 图表解析：`Parse the figure.`
//! - 图像描述：`Describe this image in detail.`

use super::{OcrAdapter, OcrEngineType, OcrError, OcrMode, OcrPageResult, OcrRegion};
use async_trait::async_trait;

/// DeepSeek-OCR 适配器
pub struct DeepSeekOcrAdapter;

impl DeepSeekOcrAdapter {
    pub fn new() -> Self {
        Self
    }
}

impl Default for DeepSeekOcrAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl OcrAdapter for DeepSeekOcrAdapter {
    fn engine_type(&self) -> OcrEngineType {
        OcrEngineType::DeepSeekOcr
    }

    fn supports_mode(&self, mode: OcrMode) -> bool {
        // DeepSeek-OCR 支持所有模式
        matches!(
            mode,
            OcrMode::Grounding
                | OcrMode::FreeOcr
                | OcrMode::Formula
                | OcrMode::Table
                | OcrMode::Chart
        )
    }

    fn build_prompt(&self, mode: OcrMode) -> String {
        match mode {
            OcrMode::Grounding => "<|grounding|>Convert the document to markdown.".to_string(),
            OcrMode::FreeOcr => "Free OCR.".to_string(),
            OcrMode::Formula => "Parse the figure.".to_string(), // 公式也用这个
            OcrMode::Table => "<|grounding|>Convert the document to markdown.".to_string(),
            OcrMode::Chart => "Parse the figure.".to_string(),
        }
    }

    fn build_custom_prompt(&self, custom_prompt: &str, mode: OcrMode) -> String {
        // 如果用户提供的 prompt 已经包含 grounding 标记，直接使用
        if custom_prompt.contains("<|grounding|>") {
            return custom_prompt.to_string();
        }

        // 否则根据模式添加 grounding 标记
        match mode {
            OcrMode::Grounding | OcrMode::Table => {
                format!("<|grounding|>{}", custom_prompt)
            }
            _ => custom_prompt.to_string(),
        }
    }

    fn parse_response(
        &self,
        response: &str,
        image_width: u32,
        image_height: u32,
        page_index: usize,
        image_path: &str,
        mode: OcrMode,
    ) -> Result<OcrPageResult, OcrError> {
        match mode {
            OcrMode::Grounding | OcrMode::Table => {
                // 解析 grounding 格式
                let spans = parse_deepseek_grounding(response);
                let regions = project_to_unified_format(&spans, image_width, image_height);

                Ok(OcrPageResult {
                    page_index,
                    image_path: image_path.to_string(),
                    image_width,
                    image_height,
                    regions,
                    markdown_text: Some(extract_markdown_text(response)),
                    engine: OcrEngineType::DeepSeekOcr,
                    mode,
                    processing_time_ms: None,
                })
            }
            _ => {
                // Free OCR 或其他模式，直接返回文本
                Ok(OcrPageResult {
                    page_index,
                    image_path: image_path.to_string(),
                    image_width,
                    image_height,
                    regions: vec![OcrRegion {
                        label: "document".to_string(),
                        text: response.trim().to_string(),
                        bbox_normalized: None,
                        bbox_pixels: None,
                        confidence: None,
                        raw_output: Some(response.to_string()),
                    }],
                    markdown_text: Some(response.trim().to_string()),
                    engine: OcrEngineType::DeepSeekOcr,
                    mode,
                    processing_time_ms: None,
                })
            }
        }
    }

    fn recommended_max_tokens(&self, mode: OcrMode) -> u32 {
        match mode {
            OcrMode::Grounding => 8000, // grounding 模式需要更多 token
            _ => 4096,
        }
    }
}

// ============================================================================
// 以下是从 deepseek_ocr_parser.rs 迁移的解析逻辑
// ============================================================================

/// DeepSeek-OCR 原始 Grounding 片段（0-999 归一化坐标）
#[derive(Debug, Clone)]
struct DeepseekGroundingSpan {
    label: String,
    bbox_0_999_xyxy: Vec<f64>,
    #[allow(dead_code)]
    raw_text: String,
    following_text: String,
}

/// 解析 DeepSeek-OCR 的 grounding 输出
fn parse_deepseek_grounding(raw: &str) -> Vec<DeepseekGroundingSpan> {
    let mut spans = Vec::new();
    let mut pos = 0;
    let text = raw.as_bytes();

    while pos < text.len() {
        // 查找 <|ref|>
        if let Some(ref_start) = find_substr(text, b"<|ref|>", pos) {
            let label_start = ref_start + 7; // len("<|ref|>") = 7

            // 查找 <|/ref|>
            if let Some(ref_end) = find_substr(text, b"<|/ref|>", label_start) {
                let label = safe_slice(raw, label_start, ref_end).to_string();

                // 查找 <|det|>
                let det_search_start = ref_end + 8; // len("<|/ref|>") = 8
                if let Some(det_start) = find_substr(text, b"<|det|>", det_search_start) {
                    let coords_start = det_start + 7; // len("<|det|>") = 7

                    // 查找 <|/det|>
                    if let Some(det_end) = find_substr(text, b"<|/det|>", coords_start) {
                        let coords_str = safe_slice(raw, coords_start, det_end);

                        // 解析坐标
                        if let Ok(bbox) = parse_bbox_array(coords_str) {
                            let raw_text = safe_slice(raw, ref_start, det_end + 8).to_string();

                            // 采集跟随文本
                            let after_det_start = det_end + 8;
                            let next_ref = find_substr(text, b"<|ref|>", after_det_start)
                                .unwrap_or(text.len());
                            let following_text = safe_slice(raw, after_det_start, next_ref)
                                .trim()
                                .to_string();

                            spans.push(DeepseekGroundingSpan {
                                label,
                                bbox_0_999_xyxy: bbox,
                                raw_text,
                                following_text,
                            });
                        }

                        pos = det_end + 8;
                        continue;
                    }
                }
            }
        }

        pos += 1;
    }

    spans
}

/// 将 DeepSeek 格式转换为统一的 OcrRegion 格式
fn project_to_unified_format(
    spans: &[DeepseekGroundingSpan],
    image_width: u32,
    image_height: u32,
) -> Vec<OcrRegion> {
    if image_width == 0 || image_height == 0 {
        return vec![];
    }

    let w = image_width as f64;
    let h = image_height as f64;

    spans
        .iter()
        .filter_map(|span| {
            if span.bbox_0_999_xyxy.len() != 4 {
                return None;
            }

            let x1_999 = span.bbox_0_999_xyxy[0];
            let y1_999 = span.bbox_0_999_xyxy[1];
            let x2_999 = span.bbox_0_999_xyxy[2];
            let y2_999 = span.bbox_0_999_xyxy[3];

            // 转换为像素坐标
            let x1_px = (x1_999 * w / 999.0).round();
            let y1_px = (y1_999 * h / 999.0).round();
            let x2_px = (x2_999 * w / 999.0).round();
            let y2_px = (y2_999 * h / 999.0).round();

            let width_px = (x2_px - x1_px).max(1.0);
            let height_px = (y2_px - y1_px).max(1.0);

            // 转换为 0-1 归一化 xywh
            let x_0_1 = x1_px / w;
            let y_0_1 = y1_px / h;
            let width_0_1 = width_px / w;
            let height_0_1 = height_px / h;

            // 文本内容：优先使用跟随文本，否则使用 label
            let text = {
                let t = span.following_text.trim();
                if t.is_empty() {
                    span.label.clone()
                } else {
                    t.to_string()
                }
            };

            Some(OcrRegion {
                label: span.label.clone(),
                text,
                bbox_normalized: Some(vec![x_0_1, y_0_1, width_0_1, height_0_1]),
                bbox_pixels: Some(vec![x1_px, y1_px, width_px, height_px]),
                confidence: None,
                raw_output: None,
            })
        })
        .collect()
}

/// 从 grounding 响应中提取纯 Markdown 文本
fn extract_markdown_text(response: &str) -> String {
    let mut clean = String::new();
    let mut pos = 0;
    let text = response.as_bytes();

    while pos < text.len() {
        if let Some(ref_start) = find_substr(text, b"<|ref|>", pos) {
            clean.push_str(safe_slice(response, pos, ref_start));

            if let Some(det_end) = find_substr(text, b"<|/det|>", ref_start) {
                pos = det_end + 8;
                continue;
            } else {
                clean.push_str(safe_slice(response, ref_start, text.len()));
                break;
            }
        }

        clean.push_str(safe_slice(response, pos, text.len()));
        break;
    }

    clean = clean.replace("<|grounding|>", "");
    clean.trim().to_string()
}

// ============================================================================
// 辅助函数
// ============================================================================

/// 安全的 UTF-8 字符串切片
fn safe_slice(s: &str, byte_start: usize, byte_end: usize) -> &str {
    let len = s.len();
    let mut start = byte_start.min(len);
    let mut end = byte_end.min(len);

    // 向前调整 start 到字符边界
    while start > 0 && !s.is_char_boundary(start) {
        start -= 1;
    }

    // 向后调整 end 到字符边界
    while end < len && !s.is_char_boundary(end) {
        end += 1;
    }

    if start > end {
        return "";
    }

    &s[start..end]
}

/// 在字节数组中查找子串
fn find_substr(haystack: &[u8], needle: &[u8], start: usize) -> Option<usize> {
    if start >= haystack.len() {
        return None;
    }

    haystack[start..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|pos| pos + start)
}

/// 解析 bbox 数组格式：[[x1,y1,x2,y2],...]
fn parse_bbox_array(s: &str) -> Result<Vec<f64>, String> {
    let s = s.trim();

    if !s.starts_with('[') || !s.ends_with(']') {
        return Err("bbox array must be enclosed in []".to_string());
    }

    let inner = &s[1..s.len() - 1].trim();

    if let Some(start) = inner.find('[') {
        if let Some(end) = inner[start..].find(']') {
            let bbox_str = &inner[start + 1..start + end];
            let nums: Result<Vec<f64>, _> = bbox_str
                .split(',')
                .map(|s| s.trim().parse::<f64>())
                .collect();

            match nums {
                Ok(v) if v.len() == 4 => Ok(v),
                Ok(v) => Err(format!("bbox must have 4 numbers, got {}", v.len())),
                Err(e) => Err(format!("failed to parse bbox numbers: {}", e)),
            }
        } else {
            Err("no closing ] found".to_string())
        }
    } else {
        Err("no opening [ found".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deepseek_adapter_prompt() {
        let adapter = DeepSeekOcrAdapter::new();

        let prompt = adapter.build_prompt(OcrMode::Grounding);
        assert!(prompt.contains("<|grounding|>"));

        let prompt = adapter.build_prompt(OcrMode::FreeOcr);
        assert_eq!(prompt, "Free OCR.");
    }

    #[test]
    fn test_parse_grounding() {
        let raw = "Some text before.\n<|ref|>问题1<|/ref|><|det|>[[100,200,300,400]]<|/det|>\nSome text after.";
        let spans = parse_deepseek_grounding(raw);

        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].label, "问题1");
        assert_eq!(spans[0].bbox_0_999_xyxy, vec![100.0, 200.0, 300.0, 400.0]);
    }

    #[test]
    fn test_parse_response() {
        let adapter = DeepSeekOcrAdapter::new();
        let raw = "<|ref|>题目<|/ref|><|det|>[[50,60,150,160]]<|/det|>这是题目内容";

        let result = adapter
            .parse_response(raw, 1000, 800, 0, "/path/to/image.png", OcrMode::Grounding)
            .unwrap();

        assert_eq!(result.page_index, 0);
        assert_eq!(result.regions.len(), 1);
        assert_eq!(result.regions[0].label, "题目");
        assert!(result.regions[0].bbox_pixels.is_some());
    }

    #[test]
    fn test_extract_markdown() {
        let raw =
            "<|grounding|>Normal text <|ref|>label<|/ref|><|det|>[[0,0,100,100]]<|/det|> more text";
        let markdown = extract_markdown_text(raw);

        assert!(!markdown.contains("<|"));
        assert!(markdown.contains("Normal text"));
        assert!(markdown.contains("more text"));
    }
}
