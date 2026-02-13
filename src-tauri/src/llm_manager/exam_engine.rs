//! 考试专用引擎
//!
//! 题目集分割、HTML 修复、QwenVL/DeepSeek OCR 适配

use super::parser;
use crate::models::{AppError, AppErrorType, ExamCardBBox};
use crate::providers::ProviderAdapter;
use base64::{engine::general_purpose, Engine as _};
use futures_util::StreamExt;
use image::imageops::FilterType;
use image::{GenericImageView, ImageOutputFormat};
use log::{debug, error, info, warn};
use serde_json::{json, Map, Value};
use std::io::Cursor;
use std::path::Path;
use tauri::{Emitter, Window};

use super::{
    ApiConfig, ExamSegmentationCard, ExamSegmentationOutput, ExamSegmentationPage, LLMManager,
    Result, EXAM_SEGMENT_MAX_DIMENSION, EXAM_SEGMENT_MAX_IMAGE_BYTES, EXAM_SEGMENT_MAX_PAGES,
};

impl LLMManager {
    pub async fn call_exam_sheet_segmentation(
        &self,
        page_image_paths: &[String],
        instructions: Option<&str>,
        output_format: Option<crate::models::ExamSheetOutputFormat>,
    ) -> Result<ExamSegmentationOutput> {
        if page_image_paths.is_empty() {
            return Err(AppError::validation("题目集识别的图片列表不能为空"));
        }

        if page_image_paths.len() > EXAM_SEGMENT_MAX_PAGES {
            return Err(AppError::validation(format!(
                "题目集识别最多支持 {} 张图片，请拆分后再尝试",
                EXAM_SEGMENT_MAX_PAGES
            )));
        }

        const MAX_PAGES_PER_REQUEST: usize = 6;

        if page_image_paths.len() <= MAX_PAGES_PER_REQUEST {
            return self
                .call_exam_sheet_segmentation_internal(
                    page_image_paths,
                    instructions,
                    0,
                    output_format.clone(),
                    None,
                    None,
                )
                .await;
        }

        let mut aggregated_pages = Vec::new();
        let mut raw_segments: Vec<Value> = Vec::new();

        for (chunk_idx, chunk) in page_image_paths.chunks(MAX_PAGES_PER_REQUEST).enumerate() {
            let offset = chunk_idx * MAX_PAGES_PER_REQUEST;
            let output = self
                .call_exam_sheet_segmentation_internal(
                    chunk,
                    instructions,
                    offset,
                    output_format.clone(),
                    None,
                    None,
                )
                .await?;
            if let Some(raw) = output.raw {
                raw_segments.push(raw);
            }
            aggregated_pages.extend(output.pages);
        }

        let raw = if raw_segments.is_empty() {
            None
        } else {
            Some(Value::Array(raw_segments))
        };

        Ok(ExamSegmentationOutput {
            pages: aggregated_pages,
            raw,
        })
    }

    pub async fn call_exam_sheet_segmentation_chunk(
        &self,
        page_image_paths: &[String],
        instructions: Option<&str>,
        page_offset: usize,
        output_format: Option<crate::models::ExamSheetOutputFormat>,
        grouping_prompt: Option<&str>,
        grouping_focus: Option<&str>,
    ) -> Result<ExamSegmentationOutput> {
        self.call_exam_sheet_segmentation_internal(
            page_image_paths,
            instructions,
            page_offset,
            output_format,
            grouping_prompt,
            grouping_focus,
        )
        .await
    }
    /// 流式版本：用于题目集分割的独立流式管线（仅上报 usage 等事件，不混用聊天流式）
    /// - window/stream_event 用于事件上报（如: `<event>_usage`）
    /// - 返回值为完整的最终文本解析为的分割结果
    pub async fn call_exam_sheet_segmentation_stream(
        &self,
        page_image_paths: &[String],
        instructions: Option<&str>,
        page_offset: usize,
        window: tauri::Window,
        stream_event: &str,
    ) -> Result<ExamSegmentationOutput> {
        let config = self.get_exam_segmentation_model_config().await?;

        // 构造与非流式一致的提示
        let system_prompt = r#"
             你是一个资深教研员，擅长将题目集试题切分成单题。
             请根据提供的试卷页面，输出严格的 JSON，包含每页的题目编号、题干文字，以及对应的归一化区域。
             规则同非流式版本，禁止输出JSON以外的内容。
        "#.to_string();

        let mut messages = Vec::new();
        messages.push(json!({ "role": "system", "content": system_prompt }));

        let mut user_content: Vec<Value> = Vec::new();
        let intro_text = format!(
            "共有 {} 张试卷页面，请识别并切分题目，务必直接输出纯 JSON。",
            page_image_paths.len()
        );
        user_content.push(json!({ "type": "text", "text": intro_text }));

        for (idx, path) in page_image_paths.iter().enumerate() {
            let mime = Self::infer_image_mime(path);
            let (data_url, _) = self.prepare_segmentation_image_data(path, mime).await?;
            user_content.push(json!({
                "type": "text",
                "text": format!("第{}页", page_offset + idx + 1)
            }));
            user_content.push(json!({
                "type": "image_url",
                "image_url": {
                    "url": data_url,
                    "detail": "high"
                }
            }));
        }

        if let Some(extra) = instructions {
            if !extra.trim().is_empty() {
                user_content.push(json!({
                    "type": "text",
                    "text": format!("补充说明：{}", extra.trim())
                }));
            }
        }

        messages.push(json!({ "role": "user", "content": user_content }));

        // 流式必须开启 stream，并尽量包含 usage
        let mut request_body = json!({
            "model": config.model,
            "messages": messages,
            "temperature": 0.1,
            "stream": true,
            // OpenAI Chat Completions 支持 stream_options.include_usage
            "stream_options": { "include_usage": true }
        });
        Self::apply_reasoning_config(&mut request_body, &config, None);

        let adapter: Box<dyn ProviderAdapter> = match config.model_adapter.as_str() {
            "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
            "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
            _ => Box::new(crate::providers::OpenAIAdapter),
        };

        let preq = adapter
            .build_request(
                &config.base_url,
                &config.api_key,
                &config.model,
                &request_body,
            )
            .map_err(|e| AppError::llm(format!("构建题目集分割流式请求失败: {}", e)))?;

        let client = self.get_http_client();
        let mut request_builder = client
            .post(&preq.url)
            .header("Accept", "text/event-stream, application/json")
            .header("Accept-Encoding", "identity")
            .header("Content-Type", "application/json");
        for (k, v) in preq.headers {
            request_builder = request_builder.header(k, v);
        }

        // 清理潜在遗留取消标记并注册取消通道
        let _ = self.take_cancellation_if_any(stream_event).await;
        let mut cancel_rx = self.register_cancel_channel(stream_event).await;

        let response = request_builder
            .json(&preq.body)
            .send()
            .await
            .map_err(|e| AppError::network(format!("题目集分割流式请求失败: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AppError::llm(format!(
                "题目集分割流式接口返回错误: {} - {}",
                status, error_text
            )));
        }

        let mut stream = response.bytes_stream();
        let mut sse_buffer = crate::utils::sse_buffer::SseLineBuffer::new();
        let mut full_content = String::new();
        let mut stream_ended = false;

        while !stream_ended {
            let next_item = tokio::select! {
                _ = cancel_rx.changed() => {
                    info!("[exam-sheet] 收到取消信号: {}", stream_event);
                    // 标记结束并退出循环
                    stream_ended = true;
                    continue; // 进入下一次判断并跳出
                },
                item = stream.next() => { item }
            };

            let Some(next) = next_item else {
                break;
            };
            let chunk = match next {
                Ok(b) => b,
                Err(e) => return Err(AppError::llm(format!("读取题目集流式响应失败: {}", e))),
            };
            let text = String::from_utf8_lossy(&chunk);
            let lines = sse_buffer.process_chunk(&text);
            for line in lines {
                if crate::utils::sse_buffer::SseLineBuffer::check_done_marker(&line) {
                    stream_ended = true;
                    break;
                }
                let events = adapter.parse_stream(&line);
                for ev in events {
                    match ev {
                        crate::providers::StreamEvent::ContentChunk(s) => {
                            full_content.push_str(&s);
                        }
                        crate::providers::StreamEvent::Usage(usage) => {
                            let _ = window.emit(&format!("{}_usage", stream_event), &usage);
                            if let Some(h) = self.get_hook(stream_event).await {
                                h.on_usage(&usage);
                            }
                        }
                        crate::providers::StreamEvent::Done => {
                            stream_ended = true;
                            break;
                        }
                        _ => {}
                    }
                }
                if stream_ended {
                    break;
                }
            }
            if stream_ended {
                break;
            }
        }

        if full_content.trim().is_empty() {
            return Err(AppError::llm("题目集流式响应为空"));
        }

        // 解析最终JSON
        let parsed = Self::parse_exam_segmentation_response(
            &full_content,
            page_image_paths.len(),
            page_offset,
        )?;
        Ok(parsed)
    }

    pub(crate) async fn call_exam_sheet_segmentation_internal(
        &self,
        page_image_paths: &[String],
        instructions: Option<&str>,
        page_offset: usize,
        output_format: Option<crate::models::ExamSheetOutputFormat>,
        grouping_prompt: Option<&str>,
        grouping_focus: Option<&str>,
    ) -> Result<ExamSegmentationOutput> {
        // 题目集识别使用当前配置的 OCR 引擎
        self.call_exam_sheet_deepseek_ocr(
            page_image_paths,
            instructions,
            page_offset,
            grouping_prompt,
            grouping_focus,
        )
        .await
    }

    pub async fn get_pdf_ocr_model_config(&self) -> Result<ApiConfig> {
        let engine_type = self.get_ocr_engine_type().await;
        let config = self.get_ocr_model_config().await?;
        debug!(
            "[OCR] PDF OCR 使用引擎 {}，模型: id={}, model={}",
            engine_type.as_str(),
            config.id,
            config.model
        );
        Ok(config)
    }

    pub(crate) async fn get_exam_segmentation_model_config(&self) -> Result<ApiConfig> {
        self.get_pdf_ocr_model_config().await
    }

    // === Exam sheet segmentation helpers ===

    fn preview_response(text: &str) -> String {
        let trimmed = text.trim();
        if trimmed.len() <= 200 {
            trimmed.to_string()
        } else {
            let mut end = 200;
            while end > 0 && !trimmed.is_char_boundary(end) {
                end -= 1;
            }
            format!("{}...", &trimmed[..end])
        }
    }

    pub(crate) async fn prepare_segmentation_image_data(
        &self,
        path: &str,
        default_mime: &str,
    ) -> Result<(String, usize)> {
        let abs_path = self.file_manager.resolve_image_path(path);
        let default_mime = default_mime.to_string();
        let result = tokio::task::spawn_blocking(move || -> Result<(String, usize)> {
            let data = std::fs::read(&abs_path)
                .map_err(|e| AppError::file_system(format!("读取试卷图片失败: {}", e)))?;

            if data.len() <= EXAM_SEGMENT_MAX_IMAGE_BYTES {
                let encoded = general_purpose::STANDARD.encode(&data);
                return Ok((
                    format!("data:{};base64,{}", default_mime, encoded),
                    data.len(),
                ));
            }

            let image = image::open(&abs_path)
                .map_err(|e| AppError::file_system(format!("加载试卷图片失败: {}", e)))?;
            let (width, height) = image.dimensions();
            let resized =
                if width <= EXAM_SEGMENT_MAX_DIMENSION && height <= EXAM_SEGMENT_MAX_DIMENSION {
                    image
                } else {
                    image.resize(
                        EXAM_SEGMENT_MAX_DIMENSION,
                        EXAM_SEGMENT_MAX_DIMENSION,
                        FilterType::Triangle,
                    )
                };

            let mut cursor = Cursor::new(Vec::new());
            resized
                .write_to(&mut cursor, ImageOutputFormat::Jpeg(85))
                .map_err(|e| AppError::file_system(format!("压缩试卷图片失败: {}", e)))?;
            let buffer = cursor.into_inner();
            let encoded = general_purpose::STANDARD.encode(&buffer);
            Ok((format!("data:image/jpeg;base64,{}", encoded), buffer.len()))
        })
        .await
        .map_err(|e| AppError::file_system(format!("处理试卷图片失败: {:?}", e)))??;

        Ok(result)
    }

    pub(crate) fn infer_image_mime(path: &str) -> &'static str {
        let ext = Path::new(path)
            .extension()
            .and_then(|v| v.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_else(|| "png".to_string());
        match ext.as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "gif" => "image/gif",
            _ => "image/png",
        }
    }

    /// 安全截取字符串（避免切断 UTF-8 字符边界）
    fn safe_truncate_str(s: &str, max_bytes: usize) -> &str {
        if s.len() <= max_bytes {
            s
        } else {
            s.char_indices()
                .take_while(|(idx, _)| *idx < max_bytes)
                .last()
                .map(|(idx, ch)| &s[..idx + ch.len_utf8()])
                .unwrap_or("")
        }
    }

    /// DeepSeek-OCR 调试日志发送（发送到前端调试面板）
    fn emit_deepseek_debug(
        &self,
        level: &str,
        stage: &str,
        page_index: usize,
        message: &str,
        data: Option<serde_json::Value>,
    ) {
        use tauri::Emitter;

        // 构造事件 payload
        let payload = serde_json::json!({
            "level": level,
            "stage": stage,
            "page_index": page_index,
            "message": message,
            "data": data,
        });

        // 同时输出到控制台（方便开发调试）
        let prefix = format!("[DeepSeek-OCR-Debug:{}:page-{}]", stage, page_index);
        debug!("{} [{}] {}", prefix, level.to_uppercase(), message);
        if let Some(d) = &data {
            if let Ok(json_str) = serde_json::to_string_pretty(d) {
                debug!("{}   data: {}", prefix, json_str);
            }
        }

        // 发送 Tauri 事件到前端
        if let Some(app_handle) = crate::get_global_app_handle() {
            if let Err(e) = app_handle.emit("deepseek_ocr_log", payload) {
                error!("[DeepSeek-OCR-Debug] 发送事件失败: {}", e);
            }
        }
    }

    /// 辅助函数：移除 HTML 标签，保留纯文本
    fn strip_html_tags(html: &str) -> String {
        use regex::Regex;
        let tag_pattern = Regex::new(r"<[^>]+>").unwrap();
        let without_tags = tag_pattern.replace_all(html, "");
        // 解码常见 HTML 实体
        without_tags
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&amp;", "&")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&nbsp;", " ")
    }
    /// 解析 QwenVL HTML 格式的响应，从 data-bbox 属性提取位置信息
    /// 优化：使用 spawn_blocking 异步读取图片尺寸，避免阻塞主线程
    async fn parse_qwenvl_html_response(
        &self,
        content: &str,
        page_image_paths: &[String],
        page_offset: usize,
    ) -> Result<ExamSegmentationOutput> {
        use regex::Regex;

        // ✅ 优化：使用 spawn_blocking 异步读取所有图片尺寸
        let paths = page_image_paths.to_vec();

        // 🎯 验证路径数组不为空
        if paths.is_empty() {
            return Err(AppError::validation("图片路径数组为空，无法解析试卷"));
        }

        let file_manager = self.file_manager.clone();
        let page_dimensions = tokio::task::spawn_blocking(move || -> Result<Vec<(u32, u32)>> {
            let mut dimensions = Vec::with_capacity(paths.len());
            for (index, path) in paths.iter().enumerate() {
                // 🎯 检查路径是否为空或无效
                if path.is_empty() {
                    return Err(AppError::validation(format!(
                        "图片路径 {} 为空字符串",
                        index
                    )));
                }

                // 🎯 解析为绝对路径（相对于应用数据目录的 images/ 子目录）
                let abs = file_manager.resolve_image_path(path);
                let abs_display = abs.to_string_lossy().to_string();
                if !abs.exists() {
                    return Err(AppError::file_system(format!(
                        "图片文件不存在 (索引: {}, 路径: {})",
                        index, abs_display
                    )));
                }

                let img = image::open(&abs).map_err(|e| {
                    AppError::file_system(format!(
                        "无法读取图片尺寸 (索引: {}, 路径: {}, 错误: {})",
                        index, abs_display, e
                    ))
                })?;
                dimensions.push(img.dimensions());
            }
            Ok(dimensions)
        })
        .await
        .map_err(|e| AppError::internal(format!("读取图片尺寸任务失败: {}", e)))??;

        // 移除 HTML 中的 ```html 围栏
        let html_content = content
            .trim()
            .trim_start_matches("```html")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();

        debug!(
            "[QwenVL HTML] 开始解析，共 {} 页，HTML 长度: {} 字符",
            page_image_paths.len(),
            html_content.len()
        );

        // 正则表达式匹配带有 data-bbox 的元素（支持多行内容）
        // 注意：Rust regex 不支持反向引用，因此不强制要求结束标签与开始标签完全匹配。
        // 这里采用近似匹配：抓取带 data-bbox 的元素及其内部内容，足够用于后续 bbox 与文本解析。
        let bbox_pattern =
            Regex::new(r#"<(?P<tag>\w+)[^>]*data-bbox\s*=\s*\"([^\"]+)\"[^>]*>(?s:(.*?))</[^>]+>"#)
                .map_err(|e| AppError::llm(format!("正则表达式编译失败: {}", e)))?;

        // 用于提取题目标签的正则（如 "1.", "2)", "第1题" 等）
        let question_label_pattern =
            Regex::new(r#"^\s*(?:第\s*)?(\d+|[一二三四五六七八九十]+)\s*[题\.、）)]\s*"#)
                .map_err(|e| AppError::llm(format!("题号正则编译失败: {}", e)))?;

        // 页面标记正则（支持 "Page 1", "第1页" 等）
        let page_marker_pattern = Regex::new(r#"(?i)(?:page|第)\s*(\d+)\s*(?:页)?"#)
            .map_err(|e| AppError::llm(format!("页面标记正则编译失败: {}", e)))?;

        // 第一步：收集所有带 data-bbox 的元素及其在文档中的位置
        #[derive(Debug)]
        struct BBoxElement {
            start_pos: usize,
            bbox: (f32, f32, f32, f32), // x, y, w, h (像素坐标)
            text: String,
            question_label: String,
        }

        let mut all_elements: Vec<BBoxElement> = Vec::new();
        let mut global_card_counter = 0;

        for cap in bbox_pattern.captures_iter(html_content) {
            let bbox_str = &cap[2];
            let inner_html = &cap[3];
            let start_pos = cap.get(0).unwrap().start();

            // 解析 bbox: "x y width height" (像素坐标)
            let coords: Vec<&str> = bbox_str.split_whitespace().collect();
            if coords.len() != 4 {
                warn!("[QwenVL HTML] 跳过格式不正确的 bbox: {}", bbox_str);
                continue;
            }

            let x: f32 = coords[0].parse().unwrap_or(0.0);
            let y: f32 = coords[1].parse().unwrap_or(0.0);
            let w: f32 = coords[2].parse().unwrap_or(0.0);
            let h: f32 = coords[3].parse().unwrap_or(0.0);

            // 清理 HTML 标签，提取纯文本
            let text = Self::strip_html_tags(inner_html);
            let trimmed_text = text.trim();

            if trimmed_text.is_empty() {
                continue;
            }

            // 尝试提取题目标签
            let question_label =
                if let Some(label_cap) = question_label_pattern.captures(trimmed_text) {
                    label_cap[1].to_string()
                } else {
                    global_card_counter += 1;
                    format!("Q{}", global_card_counter)
                };

            all_elements.push(BBoxElement {
                start_pos,
                bbox: (x, y, w, h),
                text: trimmed_text.to_string(),
                question_label,
            });
        }

        debug!(
            "[QwenVL HTML] 共找到 {} 个带 data-bbox 的元素",
            all_elements.len()
        );

        if all_elements.is_empty() {
            // 尝试降级：查找是否有其他可识别的题目结构
            let fallback_pattern =
                Regex::new(r#"(?i)(?:question|题目|问题)\s*(\d+|[一二三四五六七八九十]+)"#)
                    .unwrap_or_else(|_| Regex::new(r"impossible_pattern_xyz").unwrap());

            let fallback_matches: Vec<_> = fallback_pattern.captures_iter(html_content).collect();

            if !fallback_matches.is_empty() {
                warn!(
                    "[QwenVL HTML] 降级策略：虽然没有 data-bbox，但找到 {} 个题目标记",
                    fallback_matches.len()
                );
                return Err(AppError::with_details(
                    AppErrorType::LLM,
                    format!(
                        "QwenVL HTML 响应缺少 data-bbox 属性。检测到 {} 个题目标记，但无法提取位置信息。请检查模型是否正确遵循了 QwenVL HTML 格式要求。",
                        fallback_matches.len()
                    ),
                    json!({
                        "html_preview": Self::preview_response(html_content),
                        "detected_questions": fallback_matches.len(),
                        "hint": "请确保提示词中明确要求输出带 data-bbox 属性的 HTML"
                    }),
                ));
            }

            return Err(AppError::with_details(
                AppErrorType::LLM,
                "QwenVL HTML 响应中未找到有效的题目（缺少 data-bbox 属性）".to_string(),
                json!({
                    "html_preview": Self::preview_response(html_content),
                    "html_length": html_content.len(),
                    "hint": "请确保使用支持 QwenVL HTML 输出的模型（如 Qwen3-VL），并在提示词中明确要求该格式"
                }),
            ));
        }

        // 第二步：尝试根据页面标记分配元素到不同页面
        let mut page_markers: Vec<(usize, usize)> = Vec::new(); // (position, page_number)
        for cap in page_marker_pattern.captures_iter(html_content) {
            if let Ok(page_num) = cap[1].parse::<usize>() {
                let pos = cap.get(0).unwrap().start();
                page_markers.push((pos, page_num));
            }
        }

        page_markers.sort_by_key(|(pos, _)| *pos);
        debug!("[QwenVL HTML] 找到 {} 个页面标记", page_markers.len());

        // 第三步：分配元素到页面
        let mut pages: Vec<ExamSegmentationPage> = Vec::new();

        if !page_markers.is_empty() && page_markers.len() == page_image_paths.len() {
            // 情况1：有明确的页面标记，且数量匹配
            debug!("[QwenVL HTML] 使用页面标记进行分配");
            for (page_idx, &(img_width, img_height)) in page_dimensions.iter().enumerate() {
                let start_pos = if page_idx < page_markers.len() {
                    page_markers[page_idx].0
                } else {
                    0
                };
                let end_pos = if page_idx + 1 < page_markers.len() {
                    page_markers[page_idx + 1].0
                } else {
                    usize::MAX
                };

                let mut cards: Vec<ExamSegmentationCard> = Vec::new();
                for (idx, elem) in all_elements.iter().enumerate() {
                    if elem.start_pos >= start_pos && elem.start_pos < end_pos {
                        let (x, y, w, h) = elem.bbox;
                        let card_id = format!("qwenv_p{}_c{}", page_offset + page_idx, idx);
                        cards.push(ExamSegmentationCard {
                            question_label: elem.question_label.clone(),
                            bbox: ExamCardBBox {
                                x: (x / img_width as f32).clamp(0.0, 1.0),
                                y: (y / img_height as f32).clamp(0.0, 1.0),
                                width: (w / img_width as f32).clamp(0.0, 1.0),
                                height: (h / img_height as f32).clamp(0.0, 1.0),
                            },
                            ocr_text: Some(elem.text.clone()),
                            tags: Vec::new(),
                            extra_metadata: None,
                            card_id,
                        });
                    }
                }

                if !cards.is_empty() {
                    debug!(
                        "[QwenVL HTML] 页面 {} 分配了 {} 个题目",
                        page_idx + 1,
                        cards.len()
                    );
                    pages.push(ExamSegmentationPage {
                        page_index: page_offset + page_idx,
                        cards,
                    });
                }
            }
        } else {
            // 情况2：没有页面标记或数量不匹配，按题目数量平均分配
            debug!("[QwenVL HTML] 使用平均分配策略");
            let total_elements = all_elements.len();
            let elements_per_page =
                (total_elements + page_image_paths.len() - 1) / page_image_paths.len();

            for (page_idx, &(img_width, img_height)) in page_dimensions.iter().enumerate() {
                let start_idx = page_idx * elements_per_page;
                let end_idx = ((page_idx + 1) * elements_per_page).min(total_elements);

                if start_idx >= total_elements {
                    break;
                }

                let mut cards: Vec<ExamSegmentationCard> = Vec::new();
                for (idx, elem) in all_elements[start_idx..end_idx].iter().enumerate() {
                    let (x, y, w, h) = elem.bbox;
                    let card_id = format!("qwenv_p{}_c{}", page_offset + page_idx, start_idx + idx);
                    cards.push(ExamSegmentationCard {
                        question_label: elem.question_label.clone(),
                        bbox: ExamCardBBox {
                            x: (x / img_width as f32).clamp(0.0, 1.0),
                            y: (y / img_height as f32).clamp(0.0, 1.0),
                            width: (w / img_width as f32).clamp(0.0, 1.0),
                            height: (h / img_height as f32).clamp(0.0, 1.0),
                        },
                        ocr_text: Some(elem.text.clone()),
                        tags: Vec::new(),
                        extra_metadata: None,
                        card_id,
                    });
                }

                debug!(
                    "[QwenVL HTML] 页面 {} 分配了 {} 个题目 (索引 {}-{})",
                    page_idx + 1,
                    cards.len(),
                    start_idx,
                    end_idx - 1
                );
                pages.push(ExamSegmentationPage {
                    page_index: page_offset + page_idx,
                    cards,
                });
            }
        }

        if pages.is_empty() {
            return Err(AppError::with_details(
                AppErrorType::LLM,
                "QwenVL HTML 解析后未能生成有效页面".to_string(),
                json!({
                    "total_elements": all_elements.len(),
                    "page_markers": page_markers.len(),
                    "expected_pages": page_image_paths.len(),
                    "hint": "题目已识别但分配失败，可能是页面标记不匹配"
                }),
            ));
        }

        info!(
            "[QwenVL HTML] 解析完成，生成 {} 页，共 {} 个题目",
            pages.len(),
            pages.iter().map(|p| p.cards.len()).sum::<usize>()
        );

        Ok(ExamSegmentationOutput {
            pages,
            raw: Some(json!({ "html": html_content })),
        })
    }

    /// DeepSeek-OCR 题目集识别：并行单页调用，带指数回退重试
    async fn call_exam_sheet_deepseek_ocr(
        &self,
        page_image_paths: &[String],
        _instructions: Option<&str>,
        page_offset: usize,
        grouping_prompt: Option<&str>,
        grouping_focus: Option<&str>,
    ) -> Result<ExamSegmentationOutput> {
        let config = self.get_exam_segmentation_model_config().await?;

        info!(
            "[DeepSeek-OCR] 开始并行题目集识别: pages={}, offset={}",
            page_image_paths.len(),
            page_offset
        );

        // 克隆外部提供的 grouping_prompt 和 grouping_focus，以便在闭包中使用
        let grouping_prompt_owned = grouping_prompt.map(|s| s.to_string());
        let grouping_focus_owned = grouping_focus.map(|s| s.to_string());

        // 并行调用所有页面，每页带重试机制（不使用 tokio::spawn，避免 'static 约束）
        use futures::future::join_all;
        let tasks: Vec<_> = page_image_paths
            .iter()
            .enumerate()
            .map(|(local_idx, path)| {
                let page_index = page_offset + local_idx;
                let path_clone = path.clone();
                let config_clone = config.clone();
                let grouping_prompt_clone = grouping_prompt_owned.clone();
                let grouping_focus_clone = grouping_focus_owned.clone();
                async move {
                    self.call_single_page_deepseek_ocr_with_retry(
                        &config_clone,
                        &path_clone,
                        page_index,
                        grouping_prompt_clone.as_deref(),
                        grouping_focus_clone.as_deref(),
                    )
                    .await
                }
            })
            .collect();

        let results = join_all(tasks).await;
        let mut all_pages: Vec<ExamSegmentationPage> = Vec::new();
        for (idx, res) in results.into_iter().enumerate() {
            match res {
                Ok(page) => all_pages.push(page),
                Err(e) => {
                    return Err(AppError::llm(format!(
                        "页面 {} 识别失败: {}",
                        page_offset + idx,
                        e
                    )));
                }
            }
        }

        // 按页面索引排序（并行可能乱序）
        all_pages.sort_by_key(|p| p.page_index);

        info!(
            "[DeepSeek-OCR] 并行题目集识别完成，共 {} 页，{} 个区域",
            all_pages.len(),
            all_pages.iter().map(|p| p.cards.len()).sum::<usize>()
        );

        Ok(ExamSegmentationOutput {
            pages: all_pages,
            raw: Some(json!({ "format": "deepseek_ocr", "pages": page_image_paths.len() })),
        })
    }
    /// 单页 DeepSeek-OCR 调用，带指数回退重试
    async fn call_single_page_deepseek_ocr_with_retry(
        &self,
        config: &ApiConfig,
        page_path: &str,
        page_index: usize,
        grouping_prompt: Option<&str>,
        grouping_focus: Option<&str>,
    ) -> Result<ExamSegmentationPage> {
        const MAX_RETRIES: u32 = 5;
        const INITIAL_BACKOFF_MS: u64 = 1000;

        let mut retry_count = 0;
        let mut backoff_ms = INITIAL_BACKOFF_MS;

        loop {
            match self
                .call_single_page_deepseek_ocr(
                    config,
                    page_path,
                    page_index,
                    grouping_prompt,
                    grouping_focus,
                )
                .await
            {
                Ok(page) => return Ok(page),
                Err(e) => {
                    // 判断是否为速率限制错误
                    let is_rate_limit = e.to_string().contains("429")
                        || e.to_string().contains("rate limit")
                        || e.to_string().contains("too many requests");

                    if is_rate_limit && retry_count < MAX_RETRIES {
                        retry_count += 1;
                        warn!(
                            "[DeepSeek-OCR] 页面 {} 遇到速率限制，等待 {}ms 后重试 ({}/{})",
                            page_index, backoff_ms, retry_count, MAX_RETRIES
                        );

                        tokio::time::sleep(tokio::time::Duration::from_millis(backoff_ms)).await;
                        backoff_ms *= 2; // 指数回退
                        continue;
                    } else {
                        // 非速率限制错误，或重试次数耗尽
                        if retry_count > 0 {
                            error!(
                                "[DeepSeek-OCR] 页面 {} 重试 {} 次后仍失败: {}",
                                page_index, retry_count, e
                            );
                        }
                        return Err(e);
                    }
                }
            }
        }
    }

    /// 单页 DeepSeek-OCR 调用（不含重试）
    async fn call_single_page_deepseek_ocr(
        &self,
        config: &ApiConfig,
        page_path: &str,
        page_index: usize,
        grouping_prompt: Option<&str>,
        grouping_focus: Option<&str>,
    ) -> Result<ExamSegmentationPage> {
        let content = self
            .request_deepseek_ocr_content(config, page_path, page_index)
            .await?;

        self.parse_deepseek_ocr_page(
            &content,
            page_path,
            page_index,
            grouping_prompt,
            grouping_focus,
        )
        .await
    }

    async fn request_deepseek_ocr_content(
        &self,
        config: &ApiConfig,
        page_path: &str,
        page_index: usize,
    ) -> Result<String> {
        // S7 fix: 根据实际模型推断引擎类型，而非仅从全局设置获取
        // 确保 adapter/prompt 与实际使用的模型匹配
        let effective_engine =
            crate::ocr_adapters::OcrAdapterFactory::infer_engine_from_model(&config.model);
        let adapter = crate::ocr_adapters::OcrAdapterFactory::create(effective_engine);
        let engine_name = adapter.display_name();

        self.emit_deepseek_debug(
            "info",
            "request",
            page_index,
            &format!("开始调用 {} API", engine_name),
            None,
        );

        let mime = Self::infer_image_mime(page_path);
        let (data_url, _) = self
            .prepare_segmentation_image_data(page_path, mime)
            .await?;

        // 使用适配器构建 prompt（支持 DeepSeek-OCR、PaddleOCR-VL 等）
        let ocr_mode = crate::ocr_adapters::OcrMode::Grounding;
        let prompt_text = adapter.build_prompt(ocr_mode);
        let messages = vec![json!({
            "role": "user",
            "content": [
                { "type": "image_url", "image_url": { "url": data_url, "detail": if adapter.requires_high_detail() { "high" } else { "low" } } },
                { "type": "text", "text": prompt_text }
            ]
        })];

        self.emit_deepseek_debug(
            "debug",
            "request",
            page_index,
            &format!("使用的 prompt ({})", engine_name),
            Some(json!({ "prompt": prompt_text, "engine": adapter.engine_type().as_str() })),
        );

        let max_tokens = crate::llm_manager::effective_max_tokens(
            config.max_output_tokens,
            config.max_tokens_limit,
        )
        .min(adapter.recommended_max_tokens(ocr_mode))
        .max(2048)
        .min(8000);
        let mut request_body = json!({
            "model": config.model,
            "messages": messages,
            "temperature": adapter.recommended_temperature(),
            "max_tokens": max_tokens,
            "stream": false,
        });

        if let Some(extra) = adapter.get_extra_request_params() {
            if let Some(obj) = request_body.as_object_mut() {
                if let Some(extra_obj) = extra.as_object() {
                    for (k, v) in extra_obj {
                        obj.insert(k.to_string(), v.clone());
                    }
                } else {
                    obj.insert("extra_params".to_string(), extra);
                }
            }
        }

        if let Some(repetition_penalty) = adapter.recommended_repetition_penalty() {
            if let Some(obj) = request_body.as_object_mut() {
                obj.insert("repetition_penalty".to_string(), json!(repetition_penalty));
            }
        }

        let adapter: Box<dyn ProviderAdapter> = match config.model_adapter.as_str() {
            "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
            "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
            _ => Box::new(crate::providers::OpenAIAdapter),
        };

        let preq = adapter
            .build_request(
                &config.base_url,
                &config.api_key,
                &config.model,
                &request_body,
            )
            .map_err(|e| Self::provider_error("DeepSeek-OCR 请求构建失败", e))?;

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| AppError::network(format!("创建 HTTP 客户端失败: {}", e)))?;

        let mut header_map = reqwest::header::HeaderMap::new();
        for (k, v) in preq.headers.iter() {
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                reqwest::header::HeaderValue::from_str(v),
            ) {
                header_map.insert(name, val);
            }
        }

        let response = client
            .post(&preq.url)
            .headers(header_map)
            .json(&preq.body)
            .send()
            .await
            .map_err(|e| AppError::network(format!("DeepSeek-OCR 请求失败: {}", e)))?;

        let status = response.status();
        let retry_after_header = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|h| h.to_str().ok())
            .map(|s| s.to_string());

        let response_text = response
            .text()
            .await
            .map_err(|e| AppError::llm(format!("读取 DeepSeek-OCR 响应失败: {}", e)))?;

        if !status.is_success() {
            let mut detail = json!({
                "status": status.as_u16(),
                "body": response_text,
                "provider": "deepseek-ocr",
            });

            if let Some(value) = retry_after_header {
                if let Ok(seconds) = value.parse::<u64>() {
                    if let Some(map) = detail.as_object_mut() {
                        map.insert("retry_after_seconds".to_string(), json!(seconds));
                        map.insert(
                            "retry_after_ms".to_string(),
                            json!(seconds.saturating_mul(1000)),
                        );
                    }
                } else if let Some(map) = detail.as_object_mut() {
                    map.insert("retry_after_raw".to_string(), json!(value));
                }
            }

            return Err(AppError::with_details(
                AppErrorType::LLM,
                format!("DeepSeek-OCR 接口返回错误 {}", status),
                detail,
            ));
        }

        let response_json: Value = serde_json::from_str(&response_text).map_err(|e| {
            AppError::llm(format!(
                "解析 DeepSeek-OCR 响应 JSON 失败: {}, 原始内容: {}",
                e, response_text
            ))
        })?;

        let content = response_json["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| AppError::llm("DeepSeek-OCR 模型返回内容为空"))?
            .to_string();

        self.emit_deepseek_debug(
            "info",
            "response",
            page_index,
            &format!("响应状态: {}", status),
            None,
        );
        self.emit_deepseek_debug(
            "info",
            "response",
            page_index,
            &format!("content 长度: {} 字符", content.len()),
            None,
        );
        self.emit_deepseek_debug(
            "info",
            "response",
            page_index,
            "完整 content 内容",
            Some(json!({ "content": content })),
        );
        self.emit_deepseek_debug(
            "info",
            "response",
            page_index,
            "Token 使用情况",
            Some(response_json["usage"].clone()),
        );

        let approx_tokens_out = crate::utils::token_budget::estimate_tokens(&content);

        // 从 API 返回的 usage 数据中提取实际 token 数量
        let usage_value = response_json.get("usage");
        let prompt_tokens = usage_value
            .and_then(|u| u.get("prompt_tokens").or_else(|| u.get("input_tokens")))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        let completion_tokens = usage_value
            .and_then(|u| {
                u.get("completion_tokens")
                    .or_else(|| u.get("output_tokens"))
            })
            .and_then(|v| v.as_u64())
            .unwrap_or(approx_tokens_out as u64) as u32;

        crate::llm_usage::record_llm_usage(
            crate::llm_usage::CallerType::ExamSheet,
            &config.model,
            prompt_tokens,
            completion_tokens,
            None,
            None,
            None,
            None,
            true,
            None,
        );

        Ok(content)
    }

    pub async fn call_deepseek_ocr_page_raw(
        &self,
        config: &ApiConfig,
        page_path: &str,
        page_index: usize,
    ) -> Result<Vec<ExamSegmentationCard>> {
        use crate::exam_sheet_ocr_service::ExamSheetOcrService;

        // S7 fix: 根据实际模型推断引擎类型，传递给解析器
        let effective_engine =
            crate::ocr_adapters::OcrAdapterFactory::infer_engine_from_model(&config.model);

        let content = self
            .request_deepseek_ocr_content(config, page_path, page_index)
            .await?;

        let ocr_service = ExamSheetOcrService::new(self.file_manager.clone());
        let raw_regions = self
            .parse_ocr_regions_internal(
                &ocr_service,
                &content,
                page_path,
                page_index,
                Some(effective_engine),
            )
            .await?;

        Ok(raw_regions)
    }

    /// 解析单页 DeepSeek-OCR grounding 输出
    async fn parse_deepseek_ocr_page(
        &self,
        content: &str,
        page_image_path: &str,
        page_index: usize,
        grouping_prompt: Option<&str>,
        grouping_focus: Option<&str>,
    ) -> Result<ExamSegmentationPage> {
        use crate::exam_sheet_ocr_service::ExamSheetOcrService;

        // 创建 OCR 服务
        let ocr_service = ExamSheetOcrService::new(self.file_manager.clone());

        // 🎯 第一步：DeepSeek-OCR 识别所有文本区域
        self.emit_deepseek_debug("info", "parse", page_index, "开始解析 grounding 标记", None);

        // 使用闭包无法跨 await，直接传递 self 和 page_index
        let raw_regions = self
            .parse_ocr_regions_internal(&ocr_service, content, page_image_path, page_index, None)
            .await?;

        // 如果没有识别到任何区域，直接返回
        if raw_regions.is_empty() {
            return Ok(ExamSegmentationPage {
                page_index,
                cards: raw_regions,
            });
        }

        // 🎯 第二步：使用对话模型（原 Irec 文本模型）整理区域，按题目分组
        self.emit_deepseek_debug(
            "info",
            "grouping",
            page_index,
            "开始调用对话模型进行题目分组",
            None,
        );
        let grouped_cards = self
            .group_regions_by_llm(
                &raw_regions,
                page_index,
                &ocr_service,
                grouping_prompt,
                grouping_focus,
            )
            .await?;

        self.emit_deepseek_debug(
            "info",
            "result",
            page_index,
            &format!("最终生成 {} 个题目", grouped_cards.len()),
            Some(json!({
                "original_regions": raw_regions.len(),
                "grouped_questions": grouped_cards.len(),
            })),
        );

        Ok(ExamSegmentationPage {
            page_index,
            cards: grouped_cards,
        })
    }

    /// 内部函数：解析 OCR 区域（避免闭包生命周期问题）
    ///
    /// 支持多种 OCR 引擎的输出格式：
    /// - DeepSeek-OCR: `<|ref|>...<|det|>` 格式
    /// - PaddleOCR-VL: JSON 格式或纯 Markdown
    /// - 通用 VLM: 纯文本
    async fn parse_ocr_regions_internal(
        &self,
        ocr_service: &crate::exam_sheet_ocr_service::ExamSheetOcrService,
        content: &str,
        page_image_path: &str,
        page_index: usize,
        engine_override: Option<crate::ocr_adapters::OcrEngineType>,
    ) -> Result<Vec<ExamSegmentationCard>> {
        use crate::deepseek_ocr_parser::{parse_deepseek_grounding, project_to_pixels};
        use crate::ocr_adapters::{OcrAdapterFactory, OcrEngineType, OcrMode};

        // S7 fix: 优先使用调用方传入的有效引擎类型，否则回退到全局设置
        let engine_type = match engine_override {
            Some(e) => e,
            None => self.get_ocr_engine_type().await,
        };

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

        // 解析 grounding 片段（完整预览）
        self.emit_deepseek_debug(
            "debug",
            "parse",
            page_index,
            &format!("content 全量预览 (engine: {:?})", engine_type),
            Some(json!({
                "preview": content,
                "engine": engine_type.as_str()
            })),
        );

        let convert_regions_to_cards = |regions: Vec<crate::ocr_adapters::OcrRegion>| {
            let mut cards = Vec::new();
            let w = img_w as f64;
            let h = img_h as f64;

            for (idx, region) in regions.iter().enumerate() {
                let (nx, ny, nw, nh) = if let Some(bbox) = region.bbox_normalized.as_ref() {
                    if bbox.len() != 4 {
                        continue;
                    }
                    (bbox[0], bbox[1], bbox[2], bbox[3])
                } else if let Some(bbox) = region.bbox_pixels.as_ref() {
                    if bbox.len() != 4 || w == 0.0 || h == 0.0 {
                        continue;
                    }
                    (bbox[0] / w, bbox[1] / h, bbox[2] / w, bbox[3] / h)
                } else {
                    continue;
                };

                let nx = nx.clamp(0.0, 1.0) as f32;
                let ny = ny.clamp(0.0, 1.0) as f32;
                let nw = nw.clamp(0.0, 1.0) as f32;
                let nh = nh.clamp(0.0, 1.0) as f32;
                if nw <= 0.0 || nh <= 0.0 {
                    continue;
                }

                cards.push(ExamSegmentationCard {
                    question_label: if region.label.trim().is_empty() {
                        format!("区域{}", idx)
                    } else {
                        region.label.clone()
                    },
                    bbox: ExamCardBBox {
                        x: nx,
                        y: ny,
                        width: nw,
                        height: nh,
                    },
                    ocr_text: Some(region.text.clone()),
                    tags: vec![],
                    extra_metadata: Some(json!({
                        "engine": engine_type.as_str(),
                        "source": "ocr_adapter",
                    })),
                    card_id: format!("ocr_p{}_r{}", page_index, idx),
                });
            }

            cards
        };

        let fallback_full_page = |text: &str| {
            let trimmed = text.trim();
            if trimmed.is_empty() || trimmed.len() <= 10 {
                return Vec::new();
            }

            vec![ExamSegmentationCard {
                question_label: "全页内容".to_string(),
                bbox: ExamCardBBox {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
                ocr_text: Some(trimmed.to_string()),
                tags: vec![],
                extra_metadata: Some(json!({
                    "fallback_mode": "full_page_text",
                    "engine": engine_type.as_str()
                })),
                card_id: format!("fp_p{}_r0", page_index),
            }]
        };

        // S6 fix: 统一使用适配器解析所有引擎类型，消除旧解析器重复
        let adapter = OcrAdapterFactory::create(engine_type);
        let spans = match adapter.parse_response(
            content,
            img_w,
            img_h,
            page_index,
            page_image_path,
            OcrMode::Grounding,
        ) {
            Ok(result) => {
                let crate::ocr_adapters::OcrPageResult {
                    regions,
                    markdown_text,
                    ..
                } = result;
                let cards = convert_regions_to_cards(regions);
                if !cards.is_empty() {
                    self.emit_deepseek_debug(
                        "info",
                        "parse",
                        page_index,
                        &format!(
                            "适配器解析成功 ({}): {} 个区域",
                            engine_type.as_str(),
                            cards.len()
                        ),
                        None,
                    );
                    return Ok(cards);
                }
                // 没有坐标区域，回退到全页文本
                let text = markdown_text.as_deref().unwrap_or(content);
                return Ok(fallback_full_page(text));
            }
            Err(e) => {
                self.emit_deepseek_debug(
                    "warn",
                    "parse",
                    page_index,
                    &format!(
                        "适配器解析失败 ({}): {}, 尝试旧解析器回退",
                        engine_type.as_str(),
                        e
                    ),
                    None,
                );
                // 兼容回退：使用旧的 DeepSeek 解析器
                parse_deepseek_grounding(content)
            }
        };

        self.emit_deepseek_debug(
            "info",
            "parse",
            page_index,
            &format!("解析结果: {} 个 spans", spans.len()),
            None,
        );

        if spans.is_empty() {
            self.emit_deepseek_debug(
                "warn",
                "parse",
                page_index,
                &format!(
                    "⚠️ 未解析到 grounding 标记，使用纯文本模式 (engine: {:?})",
                    engine_type
                ),
                None,
            );

            return Ok(fallback_full_page(content));
        }

        // 坐标转换
        self.emit_deepseek_debug(
            "info",
            "convert",
            page_index,
            &format!("图片尺寸: {}x{}", img_w, img_h),
            None,
        );
        let regions = project_to_pixels(&spans, img_w, img_h);
        self.emit_deepseek_debug(
            "info",
            "convert",
            page_index,
            &format!("转换结果: {} 个 regions", regions.len()),
            None,
        );

        // 转换为 ExamSegmentationCard
        let cards = regions
            .iter()
            .enumerate()
            .map(|(idx, region)| {
                if region.bbox_0_1_xywh.len() != 4 {
                    return None;
                }

                Some(ExamSegmentationCard {
                    question_label: if region.label.is_empty() {
                        format!("区域{}", idx)
                    } else {
                        region.label.clone()
                    },
                    bbox: ExamCardBBox {
                        x: region.bbox_0_1_xywh[0] as f32,
                        y: region.bbox_0_1_xywh[1] as f32,
                        width: region.bbox_0_1_xywh[2] as f32,
                        height: region.bbox_0_1_xywh[3] as f32,
                    },
                    ocr_text: Some(region.text.clone()),
                    tags: vec![],
                    extra_metadata: None,
                    card_id: format!("ds_p{}_r{}", page_index, idx),
                })
            })
            .flatten()
            .collect::<Vec<_>>();

        self.emit_deepseek_debug(
            "info",
            "result",
            page_index,
            &format!("DeepSeek-OCR 识别到 {} 个原始区域", cards.len()),
            None,
        );

        Ok(cards)
    }

    /// 使用文本模型对 DeepSeek-OCR 识别的区域进行题目分组
    /// 返回：合并后的题目列表
    async fn group_regions_by_llm(
        &self,
        regions: &[ExamSegmentationCard],
        page_index: usize,
        ocr_service: &crate::exam_sheet_ocr_service::ExamSheetOcrService,
        grouping_prompt: Option<&str>,
        grouping_focus: Option<&str>,
    ) -> Result<Vec<ExamSegmentationCard>> {
        // 构建 prompt（支持外部覆盖：优先使用 ExamSheetSegmentationOptions 的 grouping_prompt/focus）
        let prompt = ocr_service.build_grouping_prompt(regions, grouping_prompt, grouping_focus);

        self.emit_deepseek_debug(
            "debug",
            "grouping",
            page_index,
            "LLM 分组 prompt 全量",
            Some(json!({
                "prompt": &prompt
            })),
        );

        // 切换为"对话模型"作为文本分组模型
        let config = self.get_model2_config().await?;
        self.emit_deepseek_debug(
            "info",
            "grouping",
            page_index,
            &format!("使用对话模型: {}", config.model),
            None,
        );

        let messages = vec![json!({
            "role": "user",
            "content": prompt
        })];

        // 区域合并任务不需要推理模式，直接跳过 apply_reasoning_config
        // 不调用该函数，确保不会添加任何推理相关参数
        let request_body = json!({
            "model": config.model,
            "messages": messages,
            "temperature": 0.0,
            "max_tokens": 2048,
            "stream": false,
        });

        let adapter: Box<dyn ProviderAdapter> = match config.model_adapter.as_str() {
            "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
            "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
            _ => Box::new(crate::providers::OpenAIAdapter),
        };

        let preq = adapter
            .build_request(
                &config.base_url,
                &config.api_key,
                &config.model,
                &request_body,
            )
            .map_err(|e| Self::provider_error("DeepSeek-OCR 分组请求构建失败", e))?;

        let mut request_builder = self.client.post(&preq.url);
        for (k, v) in preq.headers {
            request_builder = request_builder.header(k, v);
        }
        let response = request_builder
            .json(&preq.body)
            .send()
            .await
            .map_err(|e| AppError::network(format!("DeepSeek-OCR 分组请求失败: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AppError::llm(format!(
                "DeepSeek-OCR 分组接口返回错误: {} - {}",
                status, error_text
            )));
        }

        let response_text = response
            .text()
            .await
            .map_err(|e| AppError::llm(format!("读取 DeepSeek-OCR 分组响应失败: {}", e)))?;

        let response_json: serde_json::Value = serde_json::from_str(&response_text)
            .map_err(|e| AppError::llm(format!("解析 DeepSeek-OCR 分组响应JSON失败: {}", e)))?;

        let openai_like_json = if config.model_adapter == "google" {
            crate::adapters::gemini_openai_converter::convert_gemini_nonstream_response_to_openai(
                &response_json,
                &config.model,
            )
            .map_err(|e| AppError::llm(format!("Gemini响应转换失败: {}", e)))?
        } else if matches!(config.model_adapter.as_str(), "anthropic" | "claude") {
            crate::providers::convert_anthropic_response_to_openai(&response_json, &config.model)
                .ok_or_else(|| AppError::llm("解析Anthropic响应失败".to_string()))?
        } else {
            response_json.clone()
        };

        let content_str = openai_like_json["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| AppError::llm("DeepSeek-OCR 分组模型返回内容为空"))?
            .trim();

        self.emit_deepseek_debug(
            "debug",
            "grouping",
            page_index,
            "LLM 返回内容",
            Some(json!({ "content": content_str })),
        );

        // 解析分组结果
        let groups = ocr_service.parse_grouping_result(content_str)?;

        self.emit_deepseek_debug(
            "info",
            "grouping",
            page_index,
            &format!("LLM 分组结果: {} 个题目", groups.len()),
            Some(json!({ "groups": &groups })),
        );

        // 根据分组结果合并区域
        let grouped_cards = ocr_service.merge_regions_by_groups(regions, groups, page_index);

        Ok(grouped_cards)
    }

    fn parse_exam_segmentation_response(
        content: &str,
        expected_pages: usize,
        page_offset: usize,
    ) -> Result<ExamSegmentationOutput> {
        let trimmed = content.trim();

        fn push_candidate(candidates: &mut Vec<String>, candidate: String) {
            if !candidate.is_empty() && !candidates.iter().any(|existing| existing == &candidate) {
                candidates.push(candidate);
            }
        }

        let mut candidates: Vec<String> = Vec::new();
        push_candidate(&mut candidates, trimmed.to_string());
        push_candidate(
            &mut candidates,
            parser::enhanced_clean_json_response(trimmed),
        );

        let mut repaired_candidates: Vec<String> = Vec::new();
        for candidate in &candidates {
            if let Some(repaired) = Self::repair_exam_segmentation_json(candidate) {
                repaired_candidates.push(repaired);
            }
        }
        for candidate in repaired_candidates {
            push_candidate(&mut candidates, candidate);
        }

        let try_parse = |candidate: &str| -> Option<ExamSegmentationOutput> {
            if let Ok(mut value) = serde_json::from_str::<Value>(candidate) {
                for _ in 0..2 {
                    if let Some(inner) = value.as_str() {
                        if let Ok(parsed_inner) = serde_json::from_str::<Value>(inner) {
                            value = parsed_inner;
                            continue;
                        }
                    }
                    break;
                }

                if let Ok(pages) =
                    Self::convert_exam_segmentation_pages(&value, expected_pages, page_offset)
                {
                    return Some(ExamSegmentationOutput {
                        pages,
                        raw: Some(value),
                    });
                }
            }
            None
        };

        for candidate in &candidates {
            if let Some(output) = try_parse(candidate) {
                return Ok(output);
            }
        }

        // 兜底：从文本中提取一个看起来像包含 pages/cards 的 JSON 片段
        if let Some(extracted) = Self::smart_extract_exam_pages_json_from_text(trimmed) {
            let mut extracted_candidates: Vec<String> = Vec::new();
            push_candidate(&mut extracted_candidates, extracted.clone());
            push_candidate(
                &mut extracted_candidates,
                parser::enhanced_clean_json_response(&extracted),
            );

            for candidate in extracted_candidates.clone() {
                if let Some(repaired) = Self::repair_exam_segmentation_json(&candidate) {
                    push_candidate(&mut extracted_candidates, repaired);
                }
            }

            for candidate in &extracted_candidates {
                if let Some(output) = try_parse(candidate) {
                    return Ok(output);
                }
            }
        }

        Err(AppError::with_details(
            AppErrorType::LLM,
            format!(
                "未能解析题目集识别结果，内容预览: {}",
                Self::preview_response(trimmed)
            ),
            json!({
                "raw": trimmed,
                "preview": Self::preview_response(trimmed),
                "expectedPages": expected_pages,
                "pageOffset": page_offset,
            }),
        ))
    }

    fn convert_exam_segmentation_pages(
        root: &Value,
        expected_pages: usize,
        page_offset: usize,
    ) -> Result<Vec<ExamSegmentationPage>> {
        // 统一收集候选页：支持根为 {pages: [...] }、根数组、或单页对象
        // 并且展开任何被错误嵌套在页对象内部的 pages 字段（你截图中的情况）。
        let mut queue: Vec<Value> = Vec::new();
        if let Some(pages_node) = root.get("pages").and_then(|v| v.as_array()) {
            queue.extend(pages_node.iter().cloned());
        } else if let Some(arr) = root.as_array() {
            queue.extend(arr.iter().cloned());
        } else if root.is_object() {
            queue.push(root.clone());
        }

        if queue.is_empty() {
            return Err(AppError::llm("模型未返回有效的 pages 数组"));
        }

        // 结果集合
        let mut collected_page_nodes: Vec<Value> = Vec::new();
        while let Some(node) = queue.pop() {
            if let Some(nested) = node.get("pages").and_then(|v| v.as_array()) {
                // 展开错误嵌套的 pages
                for child in nested.iter() {
                    queue.push(child.clone());
                }
            }

            // 只有包含 cards/segments 的对象才视为真正的页
            if node.get("cards").and_then(|v| v.as_array()).is_some()
                || node.get("segments").and_then(|v| v.as_array()).is_some()
            {
                collected_page_nodes.push(node);
            }
        }

        if collected_page_nodes.is_empty() {
            return Err(AppError::llm("模型未返回任何题目页"));
        }

        collected_page_nodes.sort_by(|a, b| {
            let ai = a
                .get("page_index")
                .and_then(|v| v.as_i64())
                .unwrap_or(i64::MAX);
            let bi = b
                .get("page_index")
                .and_then(|v| v.as_i64())
                .unwrap_or(i64::MAX);
            ai.cmp(&bi)
        });

        let mut pages = Vec::new();
        for (idx, page_value) in collected_page_nodes.into_iter().enumerate() {
            let raw_page_index = page_value
                .get("page_index")
                .and_then(|v| match v {
                    Value::Number(num) => num.as_f64(),
                    Value::String(text) => {
                        let trimmed = text.trim();
                        if trimmed.is_empty() {
                            None
                        } else {
                            trimmed.parse::<f64>().ok().or_else(|| {
                                let digits: String =
                                    trimmed.chars().filter(|c| c.is_ascii_digit()).collect();
                                if digits.is_empty() {
                                    None
                                } else {
                                    digits.parse::<f64>().ok()
                                }
                            })
                        }
                    }
                    _ => None,
                })
                .map(|v| if v.is_sign_negative() { 0.0 } else { v });

            let chunk_len = expected_pages.max(1);
            let target_index = page_offset + idx.min(chunk_len.saturating_sub(1));
            let bounds_start = page_offset;
            let bounds_end = page_offset + chunk_len.saturating_sub(1);

            let mut candidates: Vec<usize> = Vec::new();

            if let Some(raw_float) = raw_page_index {
                let raw_rounded = raw_float.round() as isize;
                let raw_clamped = raw_rounded.max(0) as usize;

                // 假设模型返回全局 0 基页码
                candidates.push(raw_clamped);

                // 假设模型返回全局 1 基页码
                if raw_clamped > 0 {
                    candidates.push(raw_clamped - 1);
                }

                // 假设模型返回局部 0 基页码
                candidates.push(page_offset + raw_clamped);

                // 假设模型返回局部 1 基页码
                if raw_clamped > 0 {
                    candidates.push(page_offset + raw_clamped - 1);
                }
            }

            // 默认回退：使用当前枚举顺序
            candidates.push(target_index);

            candidates.sort_unstable();
            candidates.dedup();

            let page_index = candidates
                .into_iter()
                .filter(|candidate| *candidate >= bounds_start && *candidate <= bounds_end)
                .min_by_key(|candidate| candidate.abs_diff(target_index))
                .unwrap_or(target_index);

            let mut cards: Vec<ExamSegmentationCard> = Vec::new();
            let mut candidate_cards: Vec<Value> = Vec::new();
            if let Some(obj) = page_value.as_object() {
                if let Some(arr) = obj.get("cards").and_then(|v| v.as_array()) {
                    candidate_cards.extend(arr.clone());
                } else if let Some(arr) = obj.get("segments").and_then(|v| v.as_array()) {
                    candidate_cards.extend(arr.clone());
                }
            }
            if candidate_cards.is_empty() {
                if page_value.is_array() {
                    candidate_cards.extend(page_value.as_array().unwrap().clone());
                } else {
                    candidate_cards.push(page_value.clone());
                }
            }

            for (card_idx, card_value) in candidate_cards.into_iter().enumerate() {
                if let Some(card) = Self::parse_segmentation_card(&card_value, card_idx) {
                    cards.push(card);
                }
            }

            if !cards.is_empty() {
                pages.push(ExamSegmentationPage { page_index, cards });
            }
        }

        if pages.is_empty() {
            return Err(AppError::llm("模型未返回任何题目卡片"));
        }

        Ok(pages)
    }
    fn repair_exam_segmentation_json(candidate: &str) -> Option<String> {
        use regex::Regex;

        let mut repaired = candidate.to_string();
        let mut changed = false;

        let pattern_page_index = Regex::new(r#"\]\s*,\s*\"page_index\""#).unwrap();
        let replaced = pattern_page_index
            .replace_all(&repaired, "]}, {\"page_index\"")
            .to_string();
        if replaced != repaired {
            repaired = replaced;
            changed = true;
        }

        let pattern_missing_comma = Regex::new(r#"\}\s*\{\s*\"page_index\""#).unwrap();
        let replaced = pattern_missing_comma
            .replace_all(&repaired, "}, {\"page_index\"")
            .to_string();
        if replaced != repaired {
            repaired = replaced;
            changed = true;
        }

        if changed {
            Some(repaired)
        } else {
            None
        }
    }
    /// 从文本中智能提取包含 pages/cards 的 JSON 片段
    fn smart_extract_exam_pages_json_from_text(text: &str) -> Option<String> {
        Self::extract_balanced_json_with_key(text, "pages", &["\"cards\"", "\"segments\""])
    }

    fn extract_balanced_json_with_key(
        text: &str,
        key: &str,
        required_substrings: &[&str],
    ) -> Option<String> {
        let key_pattern = format!("\"{}\"", key);
        let mut index = 0usize;
        let bytes = text.as_bytes();

        while index < bytes.len() {
            match bytes[index] {
                b'{' => {
                    if let Some((candidate, end)) =
                        Self::extract_balanced_segment(text, index, b'{', b'}')
                    {
                        if candidate.contains(&key_pattern)
                            && required_substrings
                                .iter()
                                .any(|needle| candidate.contains(needle))
                        {
                            return Some(candidate);
                        }
                        index = end;
                        continue;
                    } else {
                        break;
                    }
                }
                b'[' => {
                    if let Some((candidate, end)) =
                        Self::extract_balanced_segment(text, index, b'[', b']')
                    {
                        if candidate.contains(&key_pattern)
                            && required_substrings
                                .iter()
                                .any(|needle| candidate.contains(needle))
                        {
                            return Some(candidate);
                        }
                        index = end;
                        continue;
                    } else {
                        break;
                    }
                }
                _ => {}
            }
            index += 1;
        }

        None
    }

    fn extract_balanced_segment(
        text: &str,
        start: usize,
        opening: u8,
        closing: u8,
    ) -> Option<(String, usize)> {
        let bytes = text.as_bytes();
        if start >= bytes.len() || bytes[start] != opening {
            return None;
        }

        let mut depth = 0i32;
        let mut in_string = false;
        let mut escape = false;
        let mut index = start;

        while index < bytes.len() {
            let byte = bytes[index];

            if in_string {
                if escape {
                    escape = false;
                } else if byte == b'\\' {
                    escape = true;
                } else if byte == b'"' {
                    in_string = false;
                }
            } else {
                if byte == b'"' {
                    in_string = true;
                } else if byte == opening {
                    depth += 1;
                } else if byte == closing {
                    depth -= 1;
                    if depth == 0 {
                        let end = index + 1;
                        return Some((text[start..end].to_string(), end));
                    } else if depth < 0 {
                        return None;
                    }
                }
            }

            index += 1;
        }

        None
    }

    fn parse_segmentation_card(card_value: &Value, index: usize) -> Option<ExamSegmentationCard> {
        let obj = card_value.as_object()?;

        let label_sources = ["question_label", "question_number", "label", "title", "qid"];
        let mut question_label = label_sources
            .iter()
            .find_map(|key| obj.get(*key).and_then(|v| v.as_str()))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("Q{}", index + 1));

        if question_label.chars().all(|c| c.is_ascii_digit()) {
            question_label = format!("第{}题", question_label);
        }

        let bbox_value = obj
            .get("bbox")
            .or_else(|| obj.get("bbox_2d"))
            .or_else(|| obj.get("bbox2d"))
            .or_else(|| obj.get("region"))
            .or_else(|| obj.get("box"))
            .or_else(|| obj.get("area"))?
            .clone();
        let bbox = Self::parse_bbox_value(&bbox_value)?;

        let ocr_text = obj
            .get("ocr_text")
            .or_else(|| obj.get("text"))
            .or_else(|| obj.get("content"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let tags = Self::collect_tags(
            obj.get("tags")
                .or_else(|| obj.get("knowledge_points"))
                .or_else(|| obj.get("question_tags")),
        );

        let extra = Self::collect_extra_metadata(
            obj,
            &[
                "question_label",
                "question_number",
                "label",
                "title",
                "qid",
                "bbox",
                "bbox_2d",
                "bbox2d",
                "region",
                "box",
                "area",
                "ocr_text",
                "text",
                "content",
                "tags",
                "knowledge_points",
                "question_tags",
            ],
        );

        Some(ExamSegmentationCard {
            question_label,
            bbox,
            ocr_text,
            tags,
            extra_metadata: extra,
            card_id: format!("card_{}", index),
        })
    }

    fn collect_tags(value: Option<&Value>) -> Vec<String> {
        let mut tags = Vec::new();
        if let Some(v) = value {
            if let Some(arr) = v.as_array() {
                for item in arr {
                    if let Some(s) = item.as_str() {
                        let candidate = s.trim();
                        if !candidate.is_empty() {
                            tags.push(candidate.to_string());
                        }
                    }
                }
            } else if let Some(s) = v.as_str() {
                for part in s.split(|c| c == ',' || c == '|' || c == ';') {
                    let candidate = part.trim();
                    if !candidate.is_empty() {
                        tags.push(candidate.to_string());
                    }
                }
            }
        }
        tags
    }

    fn collect_extra_metadata(obj: &Map<String, Value>, known: &[&str]) -> Option<Value> {
        let mut extra = Map::new();
        for (key, value) in obj.iter() {
            if !known.iter().any(|known_key| key == known_key) {
                extra.insert(key.clone(), value.clone());
            }
        }
        if extra.is_empty() {
            None
        } else {
            Some(Value::Object(extra))
        }
    }
    fn parse_bbox_value(value: &Value) -> Option<ExamCardBBox> {
        if let Some(arr) = value.as_array() {
            let numbers: Vec<f32> = arr
                .iter()
                .filter_map(|v| v.as_f64().map(|n| n as f32))
                .collect();
            if numbers.len() >= 4 {
                let x = Self::sanitize_coord(numbers[0]);
                let y = Self::sanitize_coord(numbers[1]);
                let width = Self::sanitize_coord(numbers[2]);
                let height = Self::sanitize_coord(numbers[3]);
                return Some(ExamCardBBox {
                    x,
                    y,
                    width,
                    height,
                });
            }
        }

        if let Some(obj) = value.as_object() {
            let x = Self::sanitize_coord(
                Self::get_number(obj, &["x", "left", "x1", "start_x"]).unwrap_or(0.0),
            );
            let y = Self::sanitize_coord(
                Self::get_number(obj, &["y", "top", "y1", "start_y"]).unwrap_or(0.0),
            );

            let width_value = Self::get_number(obj, &["width", "w"])
                .or_else(|| {
                    let x2 = Self::get_number(obj, &["x2", "right", "end_x"])?;
                    let diff = x2 - x;
                    if diff.abs() <= f32::EPSILON {
                        None
                    } else {
                        Some(diff)
                    }
                })
                .unwrap_or(1.0);

            let height_value = Self::get_number(obj, &["height", "h"])
                .or_else(|| {
                    let y2 = Self::get_number(obj, &["y2", "bottom", "end_y"])?;
                    let diff = y2 - y;
                    if diff.abs() <= f32::EPSILON {
                        None
                    } else {
                        Some(diff)
                    }
                })
                .unwrap_or(1.0);

            let width = Self::sanitize_length(width_value);
            let height = Self::sanitize_length(height_value);

            return Some(ExamCardBBox {
                x,
                y,
                width,
                height,
            });
        }

        if let Some(text) = value.as_str() {
            let nums: Vec<f32> = text
                .split(|c| c == ',' || c == '|' || c == ';' || c == ' ')
                .filter_map(|part| part.trim().parse::<f32>().ok())
                .collect();
            if nums.len() >= 4 {
                let bbox = Value::Array(nums.iter().map(|n| Value::from(*n)).collect());
                return Self::parse_bbox_value(&bbox);
            }
        }

        None
    }

    fn get_number(map: &Map<String, Value>, keys: &[&str]) -> Option<f32> {
        for key in keys {
            if let Some(value) = map.get(*key) {
                if let Some(num) = value.as_f64() {
                    return Some(num as f32);
                }
                if let Some(text) = value.as_str() {
                    if let Ok(parsed) = text.trim().parse::<f32>() {
                        return Some(parsed);
                    }
                }
            }
        }
        None
    }

    fn sanitize_coord(value: f32) -> f32 {
        if !value.is_finite() {
            0.0
        } else if value.is_nan() {
            0.0
        } else {
            value
        }
    }

    fn sanitize_length(value: f32) -> f32 {
        let v = Self::sanitize_coord(value).abs();
        if v == 0.0 {
            1.0
        } else {
            v
        }
    }
}
