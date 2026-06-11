/// ⚠️ PARTIALLY DEPRECATED (L6 fix): 新代码应使用 `crate::ocr_adapters::DeepSeekOcrAdapter`
///
/// 本模块的解析逻辑已在 `ocr_adapters/deepseek.rs` 中有等价实现。
/// 保留此模块仅因 `exam_engine.rs` 中的兼容回退路径仍在引用。
/// 后续应逐步将调用方迁移到 adapter 统一接口。
///
/// DeepSeek-OCR Grounding 解析器
///
/// DeepSeek-OCR 输出格式：
/// ```text
/// 普通文本...
/// <|ref|>标签文本<|/ref|><|det|>[[x1,y1,x2,y2],...]<|/det|>
/// 更多文本...
/// ```
///
/// 坐标系统：
/// - DeepSeek-OCR 输出 0-999 归一化 xyxy 坐标
/// - (0,0) 在左上角，x 向右递增，y 向下递增
/// - 转换为像素：x_px = round(x * W / 999), y_px = round(y * H / 999)
/// - 转换为 xywh: width = x2 - x1, height = y2 - y1
use serde::{Deserialize, Serialize};

/// DeepSeek-OCR 原始 Grounding 片段（0-999归一化坐标）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeepseekGroundingSpan {
    pub label: String,             // <|ref|> 标签文本
    pub bbox_0_999_xyxy: Vec<f64>, // [x1,y1,x2,y2] 归一化到 0-999
    pub raw_text: String,          // 原始 <|ref|>...<|/det|> 片段（不含后续文本）
    pub following_text: String,    // <|/det|> 之后、下一个 <|ref|> 之前的文本
}

/// 转换后的像素坐标区域
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeepseekRegion {
    pub label: String,
    pub text: String,            // OCR识别的文本内容
    pub bbox_0_1_xywh: Vec<f64>, // [x, y, width, height] 归一化到 0-1
    pub bbox_px_xywh: Vec<f64>,  // [x, y, width, height] 像素坐标
}

/// 解析 DeepSeek-OCR 的 grounding 输出
///
/// 输入：完整的 OCR 输出文本
/// 输出：所有识别到的 <|ref|>...<|/ref|><|det|>...</|det|> 片段
pub fn parse_deepseek_grounding(raw: &str) -> Vec<DeepseekGroundingSpan> {
    let mut spans = Vec::new();
    let mut pos = 0;
    let text = raw.as_bytes();

    while pos < text.len() {
        // 查找 <|ref|>
        if let Some(ref_start) = find_substr(text, b"<|ref|>", pos) {
            let label_start = ref_start + 7; // len("<|ref|>") = 7

            // 查找 <|/ref|>
            if let Some(ref_end) = find_substr(text, b"<|/ref|>", label_start) {
                // 安全切片：使用 safe_slice 替代直接字节索引，避免在UTF-8字符中间切割
                let label = safe_slice(raw, label_start, ref_end).to_string();

                // 查找 <|det|>
                let det_search_start = ref_end + 8; // len("<|/ref|>") = 8
                if let Some(det_start) = find_substr(text, b"<|det|>", det_search_start) {
                    let coords_start = det_start + 7; // len("<|det|>") = 7

                    // 查找 <|/det|> (注意是 <|/det|> 而不是 </|det|>)
                    if let Some(det_end) = find_substr(text, b"<|/det|>", coords_start) {
                        // 安全切片：提取坐标字符串
                        let coords_str = safe_slice(raw, coords_start, det_end);

                        // 解析坐标 [[x1,y1,x2,y2],...]
                        if let Ok(bbox) = parse_bbox_array(&coords_str) {
                            // 安全切片：提取完整的 <|ref|>...<|/det|> 原始文本
                            let raw_text = safe_slice(raw, ref_start, det_end + 8).to_string();

                            // 采集该检测框所对应的实际文本：从 <|/det|> 之后到下一个 <|ref|>（或文本末尾）
                            let after_det_start = det_end + 8; // 跳过 "<|/det|>"
                            let next_ref = find_substr(text, b"<|ref|>", after_det_start)
                                .unwrap_or(text.len());
                            // 安全切片：提取跟随文本
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

                        pos = det_end + 8; // len("<|/det|>") = 8
                        continue;
                    }
                }
            }
        }

        pos += 1;
    }

    spans
}

/// 安全的UTF-8字符串切片，确保不会在字符边界中间切割
///
/// # 参数
/// - `s`: 原始字符串
/// - `byte_start`: 起始字节索引
/// - `byte_end`: 结束字节索引
///
/// # 返回
/// 安全的字符串切片，自动调整到最近的字符边界
///
/// # 策略
/// - 如果 start 不在字符边界，向前回退到前一个字符边界
/// - 如果 end 不在字符边界，向后前进到下一个字符边界
/// - 确保返回的切片是有效的UTF-8字符串
fn safe_slice(s: &str, byte_start: usize, byte_end: usize) -> &str {
    let len = s.len();

    // 边界检查：确保索引不超出字符串长度
    let mut start = byte_start.min(len);
    let mut end = byte_end.min(len);

    // 向前调整 start 到字符边界（向前回退）
    while start > 0 && !s.is_char_boundary(start) {
        start -= 1;
    }

    // 向后调整 end 到字符边界（向后前进）
    while end < len && !s.is_char_boundary(end) {
        end += 1;
    }

    // 确保 start <= end，避免范围错误
    if start > end {
        return "";
    }

    &s[start..end]
}

/// 辅助函数：在字节数组中查找子串
fn find_substr(haystack: &[u8], needle: &[u8], start: usize) -> Option<usize> {
    if start >= haystack.len() {
        return None;
    }

    haystack[start..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|pos| pos + start)
}

/// 解析 DeepSeek-OCR 的 bbox 数组格式：[[x1,y1,x2,y2],...]
/// 注意：可能有多个框，我们只取第一个
fn parse_bbox_array(s: &str) -> Result<Vec<f64>, String> {
    let s = s.trim();

    // 移除最外层的 []
    if !s.starts_with('[') || !s.ends_with(']') {
        return Err("bbox array must be enclosed in []".to_string());
    }

    let inner = &s[1..s.len() - 1].trim();

    // 查找第一个内层 []
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

/// 将 0-999 归一化坐标转换为 0-1 归一化坐标和像素坐标
///
/// - `spans`: 解析出的 grounding 片段
/// - `image_width`: 原图宽度（像素）
/// - `image_height`: 原图高度（像素）
///
/// 返回：转换后的区域列表
pub fn project_to_pixels(
    spans: &[DeepseekGroundingSpan],
    image_width: u32,
    image_height: u32,
) -> Vec<DeepseekRegion> {
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

            Some(DeepseekRegion {
                label: span.label.clone(),
                // 优先使用 <|/det|> 后跟随文本；若为空则回退到 label
                text: {
                    let t = span.following_text.trim();
                    if t.is_empty() {
                        span.label.clone()
                    } else {
                        t.to_string()
                    }
                },
                bbox_0_1_xywh: vec![x_0_1, y_0_1, width_0_1, height_0_1],
                bbox_px_xywh: vec![x1_px, y1_px, width_px, height_px],
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_grounding() {
        let raw = "Some text before.\n<|ref|>问题1<|/ref|><|det|>[[100,200,300,400]]<|/det|>\nSome text after.";
        let spans = parse_deepseek_grounding(raw);

        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].label, "问题1");
        assert_eq!(spans[0].bbox_0_999_xyxy, vec![100.0, 200.0, 300.0, 400.0]);
    }

    #[test]
    fn test_parse_multiple_bboxes() {
        // DeepSeek-OCR 可能输出多个框，我们只取第一个
        let raw = "<|ref|>题目<|/ref|><|det|>[[50,60,150,160],[200,210,300,310]]<|/det|>";
        let spans = parse_deepseek_grounding(raw);

        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].bbox_0_999_xyxy, vec![50.0, 60.0, 150.0, 160.0]);
    }

    #[test]
    fn test_project_to_pixels() {
        let spans = vec![DeepseekGroundingSpan {
            label: "test".to_string(),
            bbox_0_999_xyxy: vec![0.0, 0.0, 999.0, 999.0],
            raw_text: "".to_string(),
            following_text: "hello".to_string(),
        }];

        let regions = project_to_pixels(&spans, 1000, 800);

        assert_eq!(regions.len(), 1);
        // (0, 0, 999, 999) 在 0-999 坐标系 -> (0, 0, 1000, 800) 像素坐标
        assert!((regions[0].bbox_px_xywh[0] - 0.0).abs() < 1.0);
        assert!((regions[0].bbox_px_xywh[1] - 0.0).abs() < 1.0);
        assert!((regions[0].bbox_px_xywh[2] - 1000.0).abs() < 2.0); // 允许舍入误差
        assert!((regions[0].bbox_px_xywh[3] - 800.0).abs() < 2.0);
    }

    #[test]
    fn test_safe_slice_utf8_boundaries() {
        // 测试中文字符边界安全性
        let s = "前<|ref|>问题A<|/ref|>后";

        // "问题A" 的字节位置：
        // "前" = 3 bytes (0xE5 0x89 0x8D)
        // "<|ref|>" = 7 bytes
        // "问" = 3 bytes (0xE9 0x97 0xAE)
        // "题" = 3 bytes (0xE9 0xA2 0x98)
        // "A" = 1 byte

        // 正常情况：正确的字符边界
        let slice = safe_slice(s, 10, 16); // "<|ref|>问题"
        assert_eq!(slice, "问题");

        // 危险情况1：start 在 UTF-8 字符中间（会自动向前回退到字符边界）
        let slice = safe_slice(s, 11, 16); // 11 是 "问" 的第二个字节
        assert_eq!(slice, "问题"); // start 回退到 10（"问" 起始），得到完整 "问题"（6 字节）

        // 危险情况2：end 在 UTF-8 字符中间（会自动向后调整）
        let slice = safe_slice(s, 10, 14); // 14 是 "题" 的第二个字节
        assert!(!slice.is_empty()); // 会前进到下一个字符边界

        // 边界情况：索引超出范围
        let slice = safe_slice(s, 0, 1000);
        assert_eq!(slice, s); // 会自动调整到字符串末尾

        // 边界情况：start > end
        let slice = safe_slice(s, 20, 10);
        assert_eq!(slice, ""); // 返回空字符串
    }

    #[test]
    fn test_parse_complex_chinese_content() {
        // 测试包含复杂中文内容的解析，确保不会panic
        let raw = r#"题目文本：
        <|ref|>下列关于分子结构的说法正确的是（ ）<|/ref|><|det|>[[50,100,800,150]]<|/det|>
        A. H₂O 分子是直线型
        <|ref|>选项A<|/ref|><|det|>[[100,200,300,250]]<|/det|>
        B. CO₂ 分子是弯曲型
        <|ref|>选项B<|/ref|><|det|>[[100,300,300,350]]<|/det|>
        这是后续文本"#;

        let spans = parse_deepseek_grounding(raw);

        // 验证解析结果
        assert_eq!(spans.len(), 3);

        // 验证第一个标签包含中文
        assert!(spans[0].label.contains("分子"));
        assert_eq!(spans[0].bbox_0_999_xyxy.len(), 4);

        // 验证第二个标签
        assert_eq!(spans[1].label, "选项A");

        // 验证第三个标签
        assert_eq!(spans[2].label, "选项B");

        // 验证跟随文本被正确提取
        assert!(spans[2].following_text.contains("这是后续文本"));
    }

    #[test]
    fn test_safe_slice_emoji_boundaries() {
        // 测试 emoji 等多字节字符（4字节UTF-8）
        let s = "前😀<|ref|>后";
        // "前" = 3 bytes
        // "😀" = 4 bytes (0xF0 0x9F 0x98 0x80)
        // "<|ref|>" = 7 bytes

        // 在 emoji 中间切割（会自动调整）
        let slice = safe_slice(s, 4, 10); // 4 是 emoji 的第二个字节
        assert!(!slice.is_empty());

        // 验证返回的字符串是有效的 UTF-8
        assert!(std::str::from_utf8(slice.as_bytes()).is_ok());
    }

    #[test]
    fn test_parse_grounding_with_mixed_content() {
        // 测试混合内容：中文、英文、数字、特殊符号
        let raw = "<|ref|>问题1：计算 √2 的值（保留2位小数）<|/ref|><|det|>[[10,20,30,40]]<|/det|>";
        let spans = parse_deepseek_grounding(raw);

        assert_eq!(spans.len(), 1);
        assert!(spans[0].label.contains("√"));
        assert!(spans[0].label.contains("问题"));
        assert_eq!(spans[0].bbox_0_999_xyxy, vec![10.0, 20.0, 30.0, 40.0]);
    }

    #[test]
    fn test_safe_slice_edge_cases() {
        let s = "测试";

        // 完全超出范围
        assert_eq!(safe_slice(s, 100, 200), "");

        // start = 0, end = 0
        assert_eq!(safe_slice(s, 0, 0), "");

        // 完整字符串
        assert_eq!(safe_slice(s, 0, s.len()), "测试");

        // 空字符串
        let empty = "";
        assert_eq!(safe_slice(empty, 0, 10), "");
    }
}
