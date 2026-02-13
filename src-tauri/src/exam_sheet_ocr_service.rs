/// DeepSeek-OCR 题目集识别服务
/// 负责：OCR 识别 + LLM 二次分组
use crate::file_manager::FileManager;
use crate::llm_manager::ExamSegmentationCard;
use crate::models::{AppError, ExamCardBBox};
type Result<T> = std::result::Result<T, AppError>;
// L6 note: 保留旧解析器引用以维持 debug 日志中的类型化字段访问
// 新代码应优先使用 crate::ocr_adapters::DeepSeekOcrAdapter::parse_response
use crate::deepseek_ocr_parser::{parse_deepseek_grounding, project_to_pixels};
use crate::utils::text::safe_truncate_chars;
use serde_json::json;
use std::sync::Arc;

pub struct ExamSheetOcrService {
    file_manager: Arc<FileManager>,
}

impl ExamSheetOcrService {
    pub fn new(file_manager: Arc<FileManager>) -> Self {
        Self { file_manager }
    }

    /// 解析单页 DeepSeek-OCR grounding 输出
    pub async fn parse_ocr_page(
        &self,
        content: &str,
        page_image_path: &str,
        page_index: usize,
        emit_debug: impl Fn(&str, &str, usize, &str, Option<serde_json::Value>),
    ) -> Result<Vec<ExamSegmentationCard>> {
        // 读取图片尺寸
        let abs_path = self.file_manager.resolve_image_path(page_image_path);
        let (img_w, img_h) = tokio::task::spawn_blocking({
            let path = abs_path.clone();
            move || -> Result<(u32, u32)> {
                image::image_dimensions(&path)
                    .map_err(|e| AppError::file_system(format!("读取图片尺寸失败: {}", e)))
            }
        })
        .await
        .map_err(|e| AppError::file_system(format!("读取图片尺寸任务失败: {:?}", e)))??;

        // 解析 grounding 片段
        emit_debug("info", "parse", page_index, "开始解析 grounding 标记", None);
        emit_debug(
            "debug",
            "parse",
            page_index,
            "content 前 500 字符",
            Some(json!({
                "preview": if content.chars().count() > 500 {
                    format!("{}...", safe_truncate_chars(content, 500))
                } else {
                    content.to_string()
                }
            })),
        );

        let spans = parse_deepseek_grounding(content);
        emit_debug(
            "info",
            "parse",
            page_index,
            &format!("解析结果: {} 个 spans", spans.len()),
            None,
        );

        // 输出所有 span（详细）
        if spans.is_empty() {
            emit_debug(
                "warn",
                "parse",
                page_index,
                "⚠️ 未解析到任何 grounding 标记！",
                None,
            );
            emit_debug(
                "warn",
                "parse",
                page_index,
                "请检查: 1. content 是否包含 <|ref|>...<|/ref|><|det|>...</|det|> 格式",
                None,
            );
            emit_debug(
                "warn",
                "parse",
                page_index,
                "请检查: 2. 解析器正则表达式是否正确",
                None,
            );
        } else {
            for (i, span) in spans.iter().enumerate() {
                emit_debug(
                    "debug",
                    "parse",
                    page_index,
                    &format!("Span {}", i),
                    Some(json!({
                        "label": span.label,
                        "bbox_0_999_xyxy": span.bbox_0_999_xyxy,
                        "raw_text_preview": if span.raw_text.len() > 100 { &span.raw_text[..100] } else { &span.raw_text }
                    })),
                );
            }
        }

        // 坐标转换
        emit_debug(
            "info",
            "convert",
            page_index,
            &format!("图片尺寸: {}x{}", img_w, img_h),
            None,
        );
        let regions = project_to_pixels(&spans, img_w, img_h);
        emit_debug(
            "info",
            "convert",
            page_index,
            &format!("转换结果: {} 个 regions", regions.len()),
            None,
        );

        // 输出所有 region（详细）
        for (i, region) in regions.iter().enumerate() {
            emit_debug(
                "debug",
                "convert",
                page_index,
                &format!("Region {}", i),
                Some(json!({
                    "label": region.label,
                    "text_preview": if region.text.len() > 50 { &region.text[..50] } else { &region.text },
                    "bbox_0_1_xywh": region.bbox_0_1_xywh,
                    "bbox_px_xywh": region.bbox_px_xywh
                })),
            );
        }

        // 转换为 ExamSegmentationCard（使用 label 作为题号，text 作为 ocr_text）
        let mut cards = Vec::new();
        for (idx, region) in regions.iter().enumerate() {
            let card_id = format!("ds_p{}_r{}", page_index, idx);

            // 从 Vec<f64> 提取 xywh
            if region.bbox_0_1_xywh.len() != 4 {
                println!(
                    "[DeepSeek-OCR] 跳过无效的 bbox，长度: {}",
                    region.bbox_0_1_xywh.len()
                );
                continue;
            }
            let nx = region.bbox_0_1_xywh[0];
            let ny = region.bbox_0_1_xywh[1];
            let nw = region.bbox_0_1_xywh[2];
            let nh = region.bbox_0_1_xywh[3];

            cards.push(ExamSegmentationCard {
                question_label: if region.label.is_empty() {
                    format!("区域{}", idx)
                } else {
                    region.label.clone()
                },
                bbox: ExamCardBBox {
                    x: nx as f32,
                    y: ny as f32,
                    width: nw as f32,
                    height: nh as f32,
                },
                ocr_text: Some(region.text.clone()),
                tags: vec![],
                extra_metadata: None,
                card_id,
            });
        }

        emit_debug(
            "info",
            "result",
            page_index,
            &format!("DeepSeek-OCR 识别到 {} 个原始区域", cards.len()),
            Some(json!({
                "raw_regions_count": cards.len(),
            })),
        );

        Ok(cards)
    }

    /// 根据 LLM 分组结果合并区域
    pub fn merge_regions_by_groups(
        &self,
        regions: &[ExamSegmentationCard],
        groups: Vec<Vec<usize>>,
        page_index: usize,
    ) -> Vec<ExamSegmentationCard> {
        let mut grouped_cards = Vec::new();

        for (group_idx, indices) in groups.iter().enumerate() {
            if indices.is_empty() {
                continue;
            }

            // 收集该组的所有区域
            let mut group_regions: Vec<&ExamSegmentationCard> = Vec::new();
            for &idx in indices {
                if idx < regions.len() {
                    group_regions.push(&regions[idx]);
                }
            }

            if group_regions.is_empty() {
                continue;
            }

            // 合并 bbox（取包围盒）
            let mut min_x = f32::MAX;
            let mut min_y = f32::MAX;
            let mut max_x = f32::MIN;
            let mut max_y = f32::MIN;

            for region in &group_regions {
                let bbox = &region.bbox;
                min_x = min_x.min(bbox.x);
                min_y = min_y.min(bbox.y);
                max_x = max_x.max(bbox.x + bbox.width);
                max_y = max_y.max(bbox.y + bbox.height);
            }

            // 合并 OCR 文本
            let merged_text = group_regions
                .iter()
                .filter_map(|r| r.ocr_text.as_ref())
                .map(|t| t.trim())
                .collect::<Vec<_>>()
                .join("\n");

            // 提取题号（从第一个区域的文本中）
            let question_label = Self::extract_question_number(&merged_text)
                .unwrap_or_else(|| format!("题目{}", group_idx + 1));

            grouped_cards.push(ExamSegmentationCard {
                question_label,
                bbox: ExamCardBBox {
                    x: min_x,
                    y: min_y,
                    width: max_x - min_x,
                    height: max_y - min_y,
                },
                ocr_text: Some(merged_text),
                tags: vec![],
                extra_metadata: Some(json!({
                    "merged_from_regions": indices,
                    "region_count": group_regions.len(),
                })),
                card_id: format!("ds_p{}_q{}", page_index, group_idx),
            });
        }

        grouped_cards
    }

    /// 从文本中提取题号（例如："1. " -> "1"）
    fn extract_question_number(text: &str) -> Option<String> {
        use regex::Regex;
        let re = Regex::new(r"^(\d+)[\.\.\)、]").ok()?;
        re.captures(text)
            .and_then(|caps| caps.get(1))
            .map(|m| m.as_str().to_string())
    }

    /// 构建 LLM 分组 prompt
    ///
    /// 参数：
    /// - regions: OCR区域列表
    /// - grouping_prompt: 外部自定义的合并提示词（若提供则优先拼接到规则顶部）
    /// - grouping_focus: 识别侧重点（若提供则附加到规则中）
    pub fn build_grouping_prompt(
        &self,
        regions: &[ExamSegmentationCard],
        grouping_prompt: Option<&str>,
        grouping_focus: Option<&str>,
    ) -> String {
        // 构建区域清单：包含编号、标签和文本（不截断，由外层控制 tokens）
        let regions_text = regions
            .iter()
            .enumerate()
            .map(|(idx, card)| {
                let text = card.ocr_text.as_ref().map(|t| t.trim()).unwrap_or("(空)");
                format!(
                    "区域{}:\n[label] {label}\n[text] {text}",
                    idx,
                    label = card.question_label,
                    text = text
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");

        // 构建基础规则
        let mut base_rules = r#"【判定准则（极其重要）】
1) 新题起始：区域文本以题号开头才视为题目起始。题号正则：^\s*\d{1,3}[\.．、\)]\s*
2) 选项识别：选项文本以 A/B/C/D 开头，格式包括：A. A． A、 （A） A ） A ）等（忽略中英文符号差异与空格）。
3) 分组边界：遇到下一条题号开头的区域，必须结束上一题的分组，禁止跨题合并。
4) 标题跳过：标题/副标题/说明性区域（如"高中化学试题""一、选择题"），不要分组；如果误识别在区域列表中，直接忽略。
5) 合理长度：一题通常包含 1 个题干 + 若干选项。若连续多个区域均不以题号/选项开头，默认只将紧跟在题号后的少量上下文（如换行延续的题干）并入同题，其余不要盲目扩展。
6) 缺失选项：若检测不到选项，仅保留题干对应的分组。
7) 顺序约束：严格保持由上到下顺序，不得调换区域次序。"#.to_string();

        // 如果提供了识别侧重点，附加到规则中
        if let Some(focus) = grouping_focus {
            let focus_trimmed = focus.trim();
            if !focus_trimmed.is_empty() {
                base_rules.push_str(&format!("\n8) 识别侧重点：{}", focus_trimmed));
            }
        }

        // 构建最终 prompt
        let mut final_prompt = String::new();

        // 若外部提供了自定义合并提示词，优先拼接到顶部
        if let Some(custom) = grouping_prompt {
            let custom_trimmed = custom.trim();
            if !custom_trimmed.is_empty() {
                final_prompt.push_str("【外部自定义规则】\n");
                final_prompt.push_str(custom_trimmed);
                final_prompt.push_str("\n\n");
            }
        }

        // 拼接主体 prompt
        final_prompt.push_str(&format!(
            r#"你是一个严格的"试题边界判定器"。下面给出按从上到下顺序排列的 OCR 区域：

{regions_list}

请仅根据"题号→题干→选项"的结构进行分组，返回每道题对应的区域编号数组。

{rules}

【输出格式（务必严格遵守）】
只输出"纯 JSON"，不要任何额外文本/解释/代码块标记：
{{
  "groups": [[i0,i1], [i2], [i3,i4,i5]]
}}

现在请输出 JSON。"#,
            regions_list = regions_text,
            rules = base_rules
        ));

        final_prompt
    }

    /// 解析 LLM 分组结果
    pub fn parse_grouping_result(&self, content: &str) -> Result<Vec<Vec<usize>>> {
        // 1. 去除可能的 markdown 代码块
        let mut json_str = content.trim();
        if json_str.starts_with("```") {
            json_str = json_str
                .trim_start_matches("```json")
                .trim_start_matches("```")
                .trim_end_matches("```")
                .trim();
        }

        // 2. 移除 JSON 中的注释（// 单行注释）
        let json_str_cleaned = json_str
            .lines()
            .map(|line| {
                // 移除 // 及其后面的内容
                if let Some(pos) = line.find("//") {
                    &line[..pos]
                } else {
                    line
                }
            })
            .collect::<Vec<_>>()
            .join("\n");

        #[derive(serde::Deserialize)]
        struct GroupResult {
            groups: Vec<Vec<usize>>,
        }

        let group_result: GroupResult = serde_json::from_str(&json_str_cleaned).map_err(|e| {
            AppError::llm(format!(
                "解析 DeepSeek-OCR 分组结果失败: {}，原始内容: {}",
                e, json_str
            ))
        })?;

        Ok(group_result.groups)
    }
}
