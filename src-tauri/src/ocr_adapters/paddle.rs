//! PaddleOCR-VL 适配器
//!
//! 实现 PaddleOCR-VL 的 prompt 构建和响应解析。
//!
//! ## PaddleOCR-VL 1.5 特点
//!
//! - 百度开源的文档解析 VLM，支持 109 种语言
//! - 在硅基流动平台上通过 OpenAI 兼容 API 调用
//! - 模型名称：`PaddlePaddle/PaddleOCR-VL-1.5`
//! - 支持版面检测和元素级识别（文本、表格、公式、图表）
//! - 1.5 版本新增：异形框定位、印章识别、文本检测识别
//! - 精度达 94.5%（OmniDocBench v1.5）
//!
//! ## 输出格式
//!
//! PaddleOCR-VL 默认输出 Markdown 格式文本，也可以通过 prompt 控制输出结构化结果。
//! 当使用版面检测时，会输出带有 block_bbox 的结构化数据。
//!
//! ## Prompt 类型
//!
//! - `ocr`: 通用 OCR 识别
//! - `formula`: 公式识别
//! - `table`: 表格识别
//! - `chart`: 图表解析
//! - `seal`: 印章识别（1.5 新增）
//! - `spotting`: 文本检测识别（1.5 新增）

use super::{OcrAdapter, OcrEngineType, OcrError, OcrMode, OcrPageResult, OcrRegion};
use async_trait::async_trait;

/// PaddleOCR-VL 适配器
pub struct PaddleOcrVlAdapter;

impl PaddleOcrVlAdapter {
    pub fn new() -> Self {
        Self
    }
}

impl Default for PaddleOcrVlAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl OcrAdapter for PaddleOcrVlAdapter {
    fn engine_type(&self) -> OcrEngineType {
        OcrEngineType::PaddleOcrVl
    }

    fn supports_mode(&self, mode: OcrMode) -> bool {
        // PaddleOCR-VL 支持所有模式
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
        // PaddleOCR-VL 使用官方标准的任务前缀作为 prompt
        // 参考官方文档：https://paddlepaddle.github.io/PaddleOCR/main/en/version3.x/pipeline_usage/PaddleOCR-VL.html
        // 官方标准格式：OCR:, Table Recognition:, Formula Recognition:, Chart Recognition:
        match mode {
            OcrMode::Grounding => {
                // 结构化输出：要求 JSON blocks（包含 bbox）
                "OCR: Please return JSON only with a top-level object {\"blocks\": [{\"type\": \"text\", \"content\": \"...\", \"bbox\": [x1,y1,x2,y2], \"score\": 0.0}], \"markdown\": \"...\"}.".to_string()
            }
            OcrMode::FreeOcr => {
                // 官方标准 OCR 任务 prompt
                "OCR:".to_string()
            }
            OcrMode::Formula => "Formula Recognition:".to_string(),
            OcrMode::Table => "Table Recognition:".to_string(),
            OcrMode::Chart => "Chart Recognition:".to_string(),
        }
    }

    /// 获取推荐的 repetition_penalty 参数
    ///
    /// 官方文档建议使用此参数来避免重复输出问题
    fn recommended_repetition_penalty(&self) -> Option<f64> {
        Some(1.1)
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
            OcrMode::Grounding => {
                // 尝试解析 JSON 格式的结构化输出
                if let Ok(parsed) = parse_paddle_json_response(response, image_width, image_height)
                {
                    return Ok(OcrPageResult {
                        page_index,
                        image_path: image_path.to_string(),
                        image_width,
                        image_height,
                        regions: parsed.regions,
                        markdown_text: parsed.markdown,
                        engine: OcrEngineType::PaddleOcrVl,
                        mode,
                        processing_time_ms: None,
                    });
                }

                // 如果 JSON 解析失败，尝试解析类似 DeepSeek 的 grounding 格式
                // （某些版本的 PaddleOCR-VL 可能使用类似格式）
                if response.contains("<|ref|>") && response.contains("<|det|>") {
                    return parse_deepseek_style_response(
                        response,
                        image_width,
                        image_height,
                        page_index,
                        image_path,
                        mode,
                    );
                }

                // 回退：作为纯文本处理
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
                    engine: OcrEngineType::PaddleOcrVl,
                    mode,
                    processing_time_ms: None,
                })
            }
            _ => {
                // 非 grounding 模式，直接返回文本
                Ok(OcrPageResult {
                    page_index,
                    image_path: image_path.to_string(),
                    image_width,
                    image_height,
                    regions: vec![OcrRegion {
                        label: match mode {
                            OcrMode::Formula => "formula",
                            OcrMode::Table => "table",
                            OcrMode::Chart => "chart",
                            _ => "document",
                        }
                        .to_string(),
                        text: response.trim().to_string(),
                        bbox_normalized: None,
                        bbox_pixels: None,
                        confidence: None,
                        raw_output: Some(response.to_string()),
                    }],
                    markdown_text: Some(response.trim().to_string()),
                    engine: OcrEngineType::PaddleOcrVl,
                    mode,
                    processing_time_ms: None,
                })
            }
        }
    }

    fn recommended_max_tokens(&self, mode: OcrMode) -> u32 {
        match mode {
            OcrMode::Grounding => 8000,
            _ => 4096,
        }
    }
}

// ============================================================================
// PaddleOCR-VL 响应解析
// ============================================================================

/// 解析后的结果
struct ParsedPaddleResponse {
    regions: Vec<OcrRegion>,
    markdown: Option<String>,
}

/// 尝试解析 JSON 格式的 PaddleOCR-VL 响应
fn parse_paddle_json_response(
    response: &str,
    image_width: u32,
    image_height: u32,
) -> Result<ParsedPaddleResponse, OcrError> {
    // 尝试提取 JSON 部分（可能被包裹在 markdown 代码块中）
    let json_str = extract_json_from_response(response);

    let json: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| OcrError::Parse(format!("JSON 解析失败: {}", e)))?;

    let mut regions = Vec::new();
    let w = image_width as f64;
    let h = image_height as f64;

    // 解析 blocks 数组
    if let Some(blocks) = json.get("blocks").and_then(|v| v.as_array()) {
        for block in blocks {
            let block_type = block
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("text")
                .to_string();

            let content = block
                .get("content")
                .and_then(|v| v.as_str())
                .or_else(|| block.get("text").and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_string();

            // 解析 bbox（像素坐标或归一化坐标）
            let (bbox_normalized, bbox_pixels) =
                if let Some(bbox) = block.get("bbox").or_else(|| block.get("block_bbox")) {
                    parse_bbox_value(bbox, w, h)
                } else {
                    (None, None)
                };

            let confidence = block.get("score").and_then(|v| v.as_f64());

            regions.push(OcrRegion {
                label: block_type,
                text: content,
                bbox_normalized,
                bbox_pixels,
                confidence,
                raw_output: None,
            });
        }
    }

    // 提取完整的 markdown 文本
    let markdown = json
        .get("markdown")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Ok(ParsedPaddleResponse { regions, markdown })
}

/// 从响应中提取 JSON 字符串
fn extract_json_from_response(response: &str) -> String {
    let response = response.trim();

    // 如果被 markdown 代码块包裹
    if response.starts_with("```json") {
        if let Some(end) = response.rfind("```") {
            let start = response.find('\n').map(|i| i + 1).unwrap_or(7);
            if start < end {
                return response[start..end].trim().to_string();
            }
        }
    }

    if response.starts_with("```") {
        if let Some(end) = response.rfind("```") {
            let start = response.find('\n').map(|i| i + 1).unwrap_or(3);
            if start < end {
                return response[start..end].trim().to_string();
            }
        }
    }

    // 尝试找到 JSON 对象的开始和结束
    if let Some(start) = response.find('{') {
        if let Some(end) = response.rfind('}') {
            if start < end {
                return response[start..=end].to_string();
            }
        }
    }

    response.to_string()
}

/// 解析 bbox 值（支持多种格式）
fn parse_bbox_value(
    bbox: &serde_json::Value,
    image_width: f64,
    image_height: f64,
) -> (Option<Vec<f64>>, Option<Vec<f64>>) {
    fn resolve_xywh(values: &[f64], max_w: f64, max_h: f64) -> Option<(f64, f64, f64, f64)> {
        if values.len() != 4 {
            return None;
        }
        let x = values[0];
        let y = values[1];
        let a = values[2];
        let b = values[3];

        let eps = 1e-6;
        let xywh = (x, y, a, b);
        let xyxy = (x, y, a - x, b - y);

        let valid_xywh = a > 0.0
            && b > 0.0
            && x >= 0.0
            && y >= 0.0
            && x + a <= max_w + eps
            && y + b <= max_h + eps;
        let valid_xyxy = (a - x) > 0.0
            && (b - y) > 0.0
            && x >= 0.0
            && y >= 0.0
            && a <= max_w + eps
            && b <= max_h + eps;

        match (valid_xyxy, valid_xywh) {
            (true, false) => Some(xyxy),
            (false, true) => Some(xywh),
            (true, true) => Some(xyxy),
            _ => None,
        }
    }

    if let Some(arr) = bbox.as_array() {
        if arr.len() >= 4 {
            let values: Vec<f64> = arr.iter().take(4).filter_map(|v| v.as_f64()).collect();

            if values.len() == 4 {
                let is_normalized = values.iter().all(|&v| v >= 0.0 && v <= 1.0);
                if is_normalized {
                    if let Some((x, y, w, h)) = resolve_xywh(&values, 1.0, 1.0) {
                        let bbox_pixels = vec![
                            x * image_width,
                            y * image_height,
                            w * image_width,
                            h * image_height,
                        ];
                        return (Some(vec![x, y, w, h]), Some(bbox_pixels));
                    }
                } else if let Some((x, y, w, h)) = resolve_xywh(&values, image_width, image_height)
                {
                    let bbox_normalized = vec![
                        x / image_width,
                        y / image_height,
                        w / image_width,
                        h / image_height,
                    ];
                    return (Some(bbox_normalized), Some(vec![x, y, w, h]));
                }
            }
        }
    }

    (None, None)
}

/// 解析类似 DeepSeek 格式的响应（兼容某些版本）
fn parse_deepseek_style_response(
    response: &str,
    image_width: u32,
    image_height: u32,
    page_index: usize,
    image_path: &str,
    mode: OcrMode,
) -> Result<OcrPageResult, OcrError> {
    // 复用 DeepSeek 适配器的解析逻辑
    let adapter = super::DeepSeekOcrAdapter::new();
    let mut result = adapter.parse_response(
        response,
        image_width,
        image_height,
        page_index,
        image_path,
        mode,
    )?;

    // 更新引擎类型
    result.engine = OcrEngineType::PaddleOcrVl;

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_paddle_adapter_prompt() {
        let adapter = PaddleOcrVlAdapter::new();

        // 官方标准 prompt 格式
        let prompt = adapter.build_prompt(OcrMode::FreeOcr);
        assert_eq!(prompt, "OCR:");

        let prompt = adapter.build_prompt(OcrMode::Grounding);
        assert!(prompt.starts_with("OCR:"));

        let prompt = adapter.build_prompt(OcrMode::Formula);
        assert_eq!(prompt, "Formula Recognition:");

        let prompt = adapter.build_prompt(OcrMode::Table);
        assert_eq!(prompt, "Table Recognition:");

        let prompt = adapter.build_prompt(OcrMode::Chart);
        assert_eq!(prompt, "Chart Recognition:");
    }

    #[test]
    fn test_repetition_penalty() {
        let adapter = PaddleOcrVlAdapter::new();
        // PaddleOCR-VL 应该设置 repetition_penalty 来避免重复输出
        assert!(adapter.recommended_repetition_penalty().is_some());
        assert_eq!(adapter.recommended_repetition_penalty(), Some(1.1));
    }

    #[test]
    fn test_parse_json_response() {
        let response = r#"```json
{
  "blocks": [
    {
      "type": "text",
      "content": "Hello World",
      "bbox": [0.1, 0.2, 0.3, 0.4]
    }
  ],
  "markdown": "Hello World"
}
```"#;

        let result = parse_paddle_json_response(response, 1000, 800).unwrap();
        assert_eq!(result.regions.len(), 1);
        assert_eq!(result.regions[0].text, "Hello World");
        assert!(result.regions[0].bbox_normalized.is_some());
    }

    #[test]
    fn test_extract_json() {
        let response = "```json\n{\"test\": true}\n```";
        let json = extract_json_from_response(response);
        assert_eq!(json, "{\"test\": true}");

        let response = "Some text {\"test\": true} more text";
        let json = extract_json_from_response(response);
        assert_eq!(json, "{\"test\": true}");
    }

    #[test]
    fn test_parse_free_ocr_response() {
        let adapter = PaddleOcrVlAdapter::new();
        let response = "# Title\n\nThis is some text content.";

        let result = adapter
            .parse_response(response, 1000, 800, 0, "/test.png", OcrMode::FreeOcr)
            .unwrap();

        assert_eq!(result.regions.len(), 1);
        assert!(result.markdown_text.is_some());
        assert!(result.markdown_text.unwrap().contains("Title"));
    }
}
