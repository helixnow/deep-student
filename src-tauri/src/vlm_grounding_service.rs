//! VLM Grounding Service — VLM 一体化页面分析
//!
//! 使用视觉语言模型 (GLM-4.6V / Qwen3-VL) 对试卷页面图片进行一体化分析：
//! 1. 题目切分 — 识别页面中所有题目的边界
//! 2. OCR — 提取每道题目的完整文本（含选项、LaTeX 公式）
//! 3. 图文关联 — 检测配图/插图并语义关联到对应题目
//!
//! 所有信息来自单次 VLM 调用，天然对齐，无需跨模型匹配。

use image::GenericImageView;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tracing::{info, warn};

use crate::llm_manager::LLMManager;
use crate::models::AppError;

// ============================================================================
// 数据类型
// ============================================================================

/// VLM 单页分析结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VlmPageAnalysis {
    /// 该页识别出的所有题目
    pub questions: Vec<VlmQuestion>,
}

/// VLM 识别出的单道题目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VlmQuestion {
    /// 题号标签（"1", "2", "5-8" 等）
    #[serde(default)]
    pub label: String,
    /// 题目区域归一化边界框 [x1, y1, x2, y2]，值域 0.0-1.0，
    /// 对齐 GLM-4.6V 原生 bbox_2d 格式
    #[serde(default = "default_bbox")]
    pub bbox: [f64; 4],
    /// VLM OCR 的完整题目文本（含选项、LaTeX 公式）
    #[serde(default)]
    pub raw_text: String,
    /// 是否为共享配图的题组
    #[serde(default)]
    pub is_group: bool,
    /// 题组子题号 ["5","6","7","8"]
    #[serde(default)]
    pub sub_questions: Vec<String>,
    /// 该题关联的所有图片/配图
    #[serde(default)]
    pub figures: Vec<VlmFigure>,
}

/// VLM 识别出的图片/配图
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VlmFigure {
    /// 图片区域归一化边界框 [x1, y1, x2, y2]，值域 0.0-1.0，
    /// 对齐 GLM-4.6V 原生 bbox_2d 格式
    #[serde(default = "default_bbox")]
    pub bbox: [f64; 4],
    /// 图片标签 ("图1", "配图", "选项图" 等)
    #[serde(default)]
    pub fig_label: String,
}

fn default_bbox() -> [f64; 4] {
    [0.0, 0.0, 0.0, 0.0]
}

// ============================================================================
// Service
// ============================================================================

/// VLM Grounding Service
pub struct VlmGroundingService {
    llm_manager: Arc<LLMManager>,
}

impl VlmGroundingService {
    pub fn new(llm_manager: Arc<LLMManager>) -> Self {
        Self { llm_manager }
    }

    /// 分析单个页面图片
    ///
    /// 使用 VLM 一体化分析页面中的题目、文本和配图。
    /// `image_data_url` 为 `data:image/jpeg;base64,...` 格式。
    pub async fn analyze_exam_page(
        &self,
        image_data_url: &str,
    ) -> Result<VlmPageAnalysis, AppError> {
        let config = self.get_vlm_config().await?;
        let api_key = self.llm_manager.decrypt_api_key_if_needed(&config.api_key)?;

        let prompt = Self::build_analysis_prompt();

        let messages = vec![json!({
            "role": "user",
            "content": [
                { "type": "image_url", "image_url": { "url": image_data_url, "detail": "high" } },
                { "type": "text", "text": prompt }
            ]
        })];

        let max_tokens = crate::llm_manager::effective_max_tokens(
            config.max_output_tokens,
            config.max_tokens_limit,
        )
        .max(4096)
        .min(16384);

        let request_body = json!({
            "model": config.model,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": max_tokens,
            "stream": false,
        });

        let provider: Box<dyn crate::providers::ProviderAdapter> =
            match config.model_adapter.as_str() {
                "google" | "gemini" => {
                    Box::new(crate::providers::GeminiAdapter::new())
                }
                "anthropic" | "claude" => {
                    Box::new(crate::providers::AnthropicAdapter::new())
                }
                _ => Box::new(crate::providers::OpenAIAdapter),
            };

        let preq = provider
            .build_request(&config.base_url, &api_key, &config.model, &request_body)
            .map_err(|e| AppError::llm(format!("VLM 请求构建失败: {:?}", e)))?;

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| AppError::internal(format!("创建 HTTP 客户端失败: {}", e)))?;

        const MAX_RETRIES: u32 = 3;
        let mut last_error = String::new();

        for attempt in 0..=MAX_RETRIES {
            if attempt > 0 {
                let delay = std::time::Duration::from_secs(2u64.pow(attempt));
                warn!(
                    "[VLM-Grounding] 第 {} 次重试，等待 {}s",
                    attempt,
                    delay.as_secs()
                );
                tokio::time::sleep(delay).await;
            }

            let mut rb = client.post(&preq.url);
            for (k, v) in preq.headers.iter() {
                rb = rb.header(k.as_str(), v.as_str());
            }

            if attempt == 0 {
                info!(
                    "[VLM-Grounding] 发送分析请求: model={}, url={}",
                    config.model, preq.url
                );
            }

            let response = match rb.json(&preq.body).send().await {
                Ok(r) => r,
                Err(e) => {
                    last_error = format!("VLM 请求失败: {}", e);
                    if attempt < MAX_RETRIES {
                        continue;
                    }
                    return Err(AppError::network(last_error));
                }
            };

            let status = response.status();
            let body = response
                .text()
                .await
                .map_err(|e| AppError::network(format!("读取 VLM 响应失败: {}", e)))?;

            if status.as_u16() == 429
                || status.as_u16() == 502
                || status.as_u16() == 503
                || status.as_u16() == 504
            {
                last_error = format!(
                    "VLM API 返回 {}: {}",
                    status,
                    &body[..body.len().min(200)]
                );
                if attempt < MAX_RETRIES {
                    warn!("[VLM-Grounding] {}", last_error);
                    continue;
                }
                return Err(AppError::llm(last_error));
            }

            if !status.is_success() {
                return Err(AppError::llm(format!(
                    "VLM API 返回错误 {}: {}",
                    status,
                    &body[..body.len().min(500)]
                )));
            }

            let resp_json: Value = serde_json::from_str(&body)
                .map_err(|e| AppError::llm(format!("解析 VLM 响应 JSON 失败: {}", e)))?;

            let content = resp_json
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .ok_or_else(|| AppError::llm("VLM 响应格式错误：无法提取 content"))?;

            info!(
                "[VLM-Grounding] 收到响应: {} 字符{}",
                content.len(),
                if attempt > 0 {
                    format!(" (第 {} 次重试成功)", attempt)
                } else {
                    String::new()
                }
            );

            return Self::parse_vlm_response(content);
        }

        Err(AppError::llm(last_error))
    }

    /// 从 VLM 响应文本中提取结构化分析结果
    fn parse_vlm_response(content: &str) -> Result<VlmPageAnalysis, AppError> {
        // 先剥离 ```json ... ``` 代码围栏（VLM 最常见的包裹格式）
        let stripped = {
            let trimmed = content.trim();
            if let Some(rest) = trimmed.strip_prefix("```json") {
                rest.trim_start()
                    .strip_suffix("```")
                    .unwrap_or(rest)
                    .trim()
            } else if let Some(rest) = trimmed.strip_prefix("```") {
                rest.trim_start()
                    .strip_suffix("```")
                    .unwrap_or(rest)
                    .trim()
            } else {
                trimmed
            }
        };

        // 从剥离后的文本中定位 JSON 数组或对象
        let json_str = if let Some(start) = stripped.find('[') {
            if let Some(end) = stripped.rfind(']') {
                &stripped[start..=end]
            } else {
                stripped
            }
        } else if let Some(start) = stripped.find('{') {
            if let Some(end) = stripped.rfind('}') {
                &stripped[start..=end]
            } else {
                stripped
            }
        } else {
            stripped
        };

        // 尝试直接作为 VlmPageAnalysis 解析
        if let Ok(analysis) = serde_json::from_str::<VlmPageAnalysis>(json_str) {
            return Ok(analysis);
        }

        // 尝试作为 questions 数组解析
        if let Ok(questions) = serde_json::from_str::<Vec<VlmQuestion>>(json_str) {
            return Ok(VlmPageAnalysis { questions });
        }

        // 尝试作为包含 questions 字段的对象解析
        if let Ok(obj) = serde_json::from_str::<Value>(json_str) {
            if let Some(qs) = obj.get("questions").and_then(|v| v.as_array()) {
                if let Ok(questions) = serde_json::from_value::<Vec<VlmQuestion>>(Value::Array(qs.clone())) {
                    return Ok(VlmPageAnalysis { questions });
                }
            }
        }

        warn!(
            "[VLM-Grounding] 无法解析 VLM 响应为结构化数据，原始内容: {}",
            &json_str[..json_str.len().min(500)]
        );
        Err(AppError::llm("VLM 响应无法解析为题目分析结果"))
    }

    /// 构建 VLM 分析 prompt（坐标格式对齐 GLM-4.6V bbox_2d）
    fn build_analysis_prompt() -> String {
        r#"请分析这张试卷/题目页面图片，识别其中的所有题目和配图。

**任务**：
1. 识别页面中每道题目的完整内容（题号、题干、选项、答案、解析）
2. 识别页面中所有图片/配图/插图，并确定它们属于哪道题目
3. 给出每道题目和每张图片在页面中的位置坐标

**输出要求**：
请输出 JSON 数组，每个元素代表一道题目（只输出 JSON，不要其他内容）：

```json
[
  {
    "label": "1",
    "bbox": [0.05, 0.02, 0.95, 0.17],
    "raw_text": "1. 下列关于力的说法正确的是（  ）\nA. 力是物体...\nB. 力可以...\nC. ...\nD. ...",
    "is_group": false,
    "sub_questions": [],
    "figures": [
      {
        "bbox": [0.60, 0.03, 0.92, 0.15],
        "fig_label": "配图"
      }
    ]
  }
]
```

**字段说明**：
- `label`: 题号（如 "1", "2", "5-8"）
- `bbox`: 题目区域坐标 **[x1, y1, x2, y2]**，左上角 (x1,y1) 到右下角 (x2,y2)，归一化到 0-1
- `raw_text`: 题目的完整文本（含题号、题干、选项等），数学公式用 LaTeX 格式（行内 $...$，独立 $$...$$）
- `is_group`: 是否为题组（多道题共享一段材料或配图时为 true）
- `sub_questions`: 题组时的子题号列表
- `figures`: 该题关联的配图列表
  - `bbox`: 图片区域坐标 **[x1, y1, x2, y2]**，左上角到右下角，归一化到 0-1
  - `fig_label`: 图片标签（"图1", "配图", "选项图"等）

**重要规则**：
1. 所有数学公式必须用 LaTeX 格式：行内 $E=mc^2$，独立 $$\int_0^1 f(x)dx$$
2. 每道题的 raw_text 必须包含完整内容（题干+选项+答案+解析，如果页面上有的话）
3. 如果多道题共享一张配图（如阅读理解），将它们标记为 is_group=true
4. **bbox 坐标格式为 [x1, y1, x2, y2]**：(x1,y1) 是左上角，(x2,y2) 是右下角，值域 0-1
5. 如果题目没有配图，figures 留空数组
6. 注意区分题目配图和装饰性元素（页眉页脚、水印等不需要标记）"#.to_string()
    }

    /// 获取 VLM 模型配置（优先 GLM-4.6V → Qwen3-VL → 回退到默认多模态模型）
    async fn get_vlm_config(&self) -> Result<crate::llm_manager::ApiConfig, AppError> {
        let configs = self
            .llm_manager
            .get_api_configs()
            .await
            .map_err(|e| AppError::configuration(format!("获取模型配置失败: {}", e)))?;

        let glm_vision_regex =
            regex::Regex::new(r"(?i)glm-(?:4(?:\.\d+)?|5(?:\.\d+)?)v").unwrap();

        let vlm_model_priorities: Vec<Box<dyn Fn(&str) -> bool>> = vec![
            Box::new(move |m: &str| glm_vision_regex.is_match(m)),
            Box::new(|m: &str| m.contains("qwen3-vl")),
            Box::new(|m: &str| m.contains("qwen2.5-vl")),
            Box::new(|m: &str| m.contains("qwen-vl")),
        ];

        for matcher in &vlm_model_priorities {
            if let Some(config) = configs.iter().find(|c| {
                c.enabled && c.is_multimodal && matcher(&c.model.to_lowercase())
            }) {
                info!(
                    "[VLM-Grounding] 使用 VLM 模型: {} ({})",
                    config.model, config.name
                );
                return Ok(config.clone());
            }
        }

        // 回退：任何已启用的多模态模型
        if let Some(config) = configs.iter().find(|c| c.enabled && c.is_multimodal) {
            info!(
                "[VLM-Grounding] 回退使用多模态模型: {} ({})",
                config.model, config.name
            );
            return Ok(config.clone());
        }

        Err(AppError::configuration(
            "未找到可用的 VLM 模型（需要 GLM-4.6V / Qwen-VL 等多模态模型），请在设置中配置",
        ))
    }

    /// 按 `[x1, y1, x2, y2]` 归一化坐标从页面图片中裁切配图区域
    ///
    /// 坐标格式对齐 GLM-4.6V bbox_2d：(x1,y1) 左上角，(x2,y2) 右下角，值域 0.0-1.0。
    pub fn crop_figure_from_page(
        page_image_bytes: &[u8],
        figure_bbox: &[f64; 4],
    ) -> Result<Vec<u8>, AppError> {
        let img = image::load_from_memory(page_image_bytes)
            .map_err(|e| AppError::internal(format!("加载页面图片失败: {}", e)))?;

        let (img_w, img_h) = img.dimensions();

        // [x1, y1, x2, y2] → 排序确保 min/max 正确
        let x1 = figure_bbox[0].min(figure_bbox[2]).clamp(0.0, 1.0);
        let y1 = figure_bbox[1].min(figure_bbox[3]).clamp(0.0, 1.0);
        let x2 = figure_bbox[0].max(figure_bbox[2]).clamp(0.0, 1.0);
        let y2 = figure_bbox[1].max(figure_bbox[3]).clamp(0.0, 1.0);

        let px = (x1 * img_w as f64).round() as u32;
        let py = (y1 * img_h as f64).round() as u32;
        let pw = ((x2 - x1) * img_w as f64).round().max(1.0) as u32;
        let ph = ((y2 - y1) * img_h as f64).round().max(1.0) as u32;

        let px = px.min(img_w.saturating_sub(1));
        let py = py.min(img_h.saturating_sub(1));
        let pw = pw.min(img_w - px);
        let ph = ph.min(img_h - py);

        if pw == 0 || ph == 0 {
            return Err(AppError::validation("裁切区域无效：宽度或高度为 0"));
        }

        let cropped = image::imageops::crop_imm(&img, px, py, pw, ph).to_image();

        let mut buffer = std::io::Cursor::new(Vec::new());
        cropped
            .write_to(&mut buffer, image::ImageOutputFormat::Png)
            .map_err(|e| AppError::internal(format!("编码裁切图片失败: {}", e)))?;

        Ok(buffer.into_inner())
    }
}
