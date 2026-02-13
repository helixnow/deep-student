/// 作文批改管线 - 核心业务逻辑
///
/// ★ 2026-02-02 边缘状态修复：
/// - PP-1: 添加 Prompt 输入净化，防止注入
/// - M-8: 评分边界校验，防止除零
/// - PP-2: 评分正则支持属性顺序变化
use futures_util::StreamExt;
use regex::Regex;
use serde_json::json;
use std::sync::Arc;

/// ★ PP-1: 作文输入最大字符数（与前端保持一致）
const MAX_INPUT_CHARS: usize = 50000;
/// 上一轮反馈最大字符数（防止上下文膨胀）
/// ★ 从 4000 放宽到 8000，避免正常批改结果被截断导致丢失评分信息
const MAX_PREVIOUS_RESULT_CHARS: usize = 8000;

use crate::llm_manager::{ApiConfig, LLMManager};
use crate::models::AppError;
use crate::providers::ProviderAdapter;
// ★ VFS 统一存储（2025-12-07）
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::VfsEssayRepo;
use crate::vfs::types::VfsCreateEssayParams;

use super::events::GradingEventEmitter;
use super::types::{
    canonical_mode_id, get_builtin_grading_modes, get_default_grading_mode, DimensionScore,
    GradingMode, GradingRequest, GradingResponse, ParsedScore, MARKER_INSTRUCTIONS,
    SCORE_FORMAT_INSTRUCTIONS,
};

/// 批改管线依赖
pub struct GradingDeps {
    pub llm: Arc<LLMManager>,
    pub vfs_db: Arc<VfsDatabase>, // ★ VFS 统一存储
    pub emitter: GradingEventEmitter,
    pub custom_modes: Vec<GradingMode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamStatus {
    Completed,
    Cancelled,
    /// ★ M-064: 流未收到 DONE 标记就结束（网络中断/服务端异常）
    Incomplete,
}

/// 运行批改管线
pub async fn run_grading(
    request: GradingRequest,
    deps: GradingDeps,
) -> Result<Option<GradingResponse>, AppError> {
    // 1. 获取批阅模式
    let grading_mode = get_grading_mode(&request.mode_id, &deps.custom_modes);

    // 2. 构造批改 Prompt
    let (system_prompt, user_prompt) = build_grading_prompts(&request, &grading_mode)?;

    // 3. 获取模型配置
    // 优先使用用户选择的模型，否则默认使用 Model2
    let config = if let Some(ref model_id) = request.model_config_id {
        // 用户指定了模型
        let configs = deps.llm.get_api_configs().await?;
        let found = configs
            .into_iter()
            .find(|c| c.id == *model_id)
            .ok_or_else(|| AppError::llm(format!("未找到模型配置: {}", model_id)))?;
        // ★ M-055: 校验模型是否启用且非嵌入模型
        if !found.enabled {
            return Err(AppError::llm(format!("模型配置已禁用: {}", model_id)));
        }
        if found.is_embedding {
            return Err(AppError::llm(format!(
                "嵌入模型不支持作文批改: {}",
                model_id
            )));
        }
        found
    } else {
        // 默认使用 Model2
        deps.llm.get_model2_config().await?
    };
    let api_key = deps.llm.decrypt_api_key(&config.api_key)?;

    // 4. 流式调用 LLM
    let mut accumulated = String::new();
    let stream_event = format!("essay_grading_stream_{}", request.stream_session_id);

    let stream_status = stream_grade(
        &config,
        &api_key,
        &system_prompt,
        &user_prompt,
        &stream_event,
        deps.llm.clone(),
        |chunk| {
            accumulated.push_str(&chunk);
            deps.emitter
                .emit_data(&request.stream_session_id, chunk, accumulated.clone());
        },
    )
    .await?;

    if matches!(stream_status, StreamStatus::Cancelled) {
        deps.emitter.emit_cancelled(&request.stream_session_id);
        return Ok(None);
    }

    // ★ M-064: 流未正常完成（未收到 DONE 标记），不保存不完整的结果
    if matches!(stream_status, StreamStatus::Incomplete) {
        println!(
            "⚠️ [EssayGrading] 流式响应未完成，丢弃不完整结果（已累积 {} 字符）",
            accumulated.len()
        );
        return Err(AppError::llm(
            "批改流式响应异常中断，结果不完整。请检查网络连接后重试。".to_string(),
        ));
    }

    // ★ S-014: 二次检查取消状态，防止流完成后、保存前的竞态窗口内幽灵写入
    // stream_grade 内部已 clear_cancel_channel，若此后前端才发出取消请求，
    // 信号会落入 cancel_registry（polling 备用通道），此处一次性消费即可捕获。
    if deps.llm.consume_pending_cancel(&stream_event).await {
        log::info!("[EssayGrading] 流完成后发现已取消，丢弃结果");
        deps.emitter.emit_cancelled(&request.stream_session_id);
        return Ok(None);
    }

    // 5. 解析评分
    let parsed_score = parse_score_from_result(&accumulated, &grading_mode);
    let overall_score = parsed_score.as_ref().map(|s| s.total);
    let parsed_score_json = parsed_score
        .as_ref()
        .and_then(|s| serde_json::to_string(s).ok());

    // 6. ★ 保存到 VFS（完全移除旧数据库）
    let created_at = chrono::Utc::now().to_rfc3339();

    // M-053 fix: 获取会话信息，错误不再静默——会话不存在时拒绝写入
    let session = VfsEssayRepo::get_session(&deps.vfs_db, &request.session_id)
        .map_err(|e| AppError::database(format!("获取会话失败: {}", e)))?;
    let session = match session {
        Some(s) => s,
        None => {
            return Err(AppError::not_found(format!(
                "会话不存在: {}",
                request.session_id
            )));
        }
    };

    let title = Some(if request.round_number > 1 {
        format!("{} (第{}轮)", session.title, request.round_number)
    } else {
        session.title.clone()
    });
    let essay_type = session.essay_type.clone().or_else(|| {
        let trimmed = request.essay_type.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    let grade_level = session.grade_level.clone().or_else(|| {
        let trimmed = request.grade_level.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    let custom_prompt = request
        .custom_prompt
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| session.custom_prompt.clone());
    let vfs_params = VfsCreateEssayParams {
        title,
        essay_type,
        content: request.input_text.clone(),
        grading_result: Some(serde_json::json!({
            "result": accumulated.clone(),
            "overall_score": overall_score,
            "dimension_scores": parsed_score_json.clone(),
        })),
        score: overall_score.map(|s| s as i32),
        session_id: Some(request.session_id.clone()),
        round_number: request.round_number,
        grade_level,
        custom_prompt,
        dimension_scores: parsed_score_json
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok()),
    };

    let essay = VfsEssayRepo::create_essay(&deps.vfs_db, vfs_params)
        .map_err(|e| AppError::database(format!("VFS 保存失败: {}", e)))?;

    let round_id = essay.id.clone();
    println!("✅ [EssayGrading] VFS 保存成功: essay_id={}", round_id);

    // 7. 发送完成事件
    deps.emitter.emit_complete(
        &request.stream_session_id,
        round_id.clone(),
        accumulated.clone(),
        overall_score,
        parsed_score_json.clone(),
        created_at.clone(),
    );

    Ok(Some(GradingResponse {
        round_id,
        session_id: request.session_id,
        round_number: request.round_number,
        grading_result: accumulated,
        overall_score,
        dimension_scores_json: parsed_score_json,
        created_at,
    }))
}

/// 获取批阅模式
fn get_grading_mode(mode_id: &Option<String>, custom_modes: &[GradingMode]) -> GradingMode {
    match mode_id {
        Some(id) => {
            let canonical_id = canonical_mode_id(id);
            if let Some(custom) = custom_modes.iter().find(|m| m.id == canonical_id) {
                return custom.clone();
            }
            get_builtin_grading_modes()
                .into_iter()
                .find(|m| m.id == canonical_id)
                .unwrap_or_else(get_default_grading_mode)
        }
        None => get_default_grading_mode(),
    }
}

/// 从批改结果中解析评分
///
/// ★ M-8 修复（2026-02-02）：添加边界校验，防止除零和无效数值
fn parse_score_from_result(result: &str, mode: &GradingMode) -> Option<ParsedScore> {
    // 匹配 <score total="X" max="Y">...</score>
    // ★ PP-2 改进：支持属性顺序变化
    let score_regex = Regex::new(r#"<score\s+(?:total="([^"]+)"\s+max="([^"]+)"|max="([^"]+)"\s+total="([^"]+)")[^>]*>([\s\S]*?)</score>"#).ok()?;
    let dim_regex =
        Regex::new(r#"<dim\s+name="([^"]+)"\s+score="([^"]+)"\s+max="([^"]+)"[^>]*>([^<]*)</dim>"#)
            .ok()?;

    let score_match = score_regex.captures(result)?;

    // 处理两种属性顺序：total-max 或 max-total
    let (total_str, max_str, dims_content) = if score_match.get(1).is_some() {
        // 顺序：total="X" max="Y"
        (
            score_match.get(1)?.as_str(),
            score_match.get(2)?.as_str(),
            score_match.get(5)?.as_str(),
        )
    } else {
        // 顺序：max="Y" total="X"
        (
            score_match.get(4)?.as_str(),
            score_match.get(3)?.as_str(),
            score_match.get(5)?.as_str(),
        )
    };

    let total: f32 = total_str.parse().ok()?;
    let max_total: f32 = max_str.parse().ok()?;

    // ★ M-8: 边界校验
    // ★ 二轮修复：添加 NaN/Infinity 检查
    if !max_total.is_finite() || max_total <= 0.0 {
        println!(
            "⚠️ [EssayGrading] 评分解析：max_total 无效 ({})，跳过",
            max_total
        );
        return None;
    }
    if !total.is_finite() {
        println!("⚠️ [EssayGrading] 评分解析：total 无效 ({})，跳过", total);
        return None;
    }

    // ★ M-058: 校验 max_total 与模式配置的一致性，以模式配置为权威值
    let mode_max = if mode.total_max_score.is_finite() && mode.total_max_score > 0.0 {
        mode.total_max_score
    } else {
        log::warn!(
            "[EssayGrading] 模式配置的 total_max_score ({}) 无效，回退使用解析值 ({})",
            mode.total_max_score,
            max_total
        );
        max_total // 回退：LLM 解析值已通过上面的 finite+>0 检查
    };
    if (max_total - mode_max).abs() > 0.01 {
        log::warn!(
            "[EssayGrading] 解析的 max_total ({}) 与模式配置 ({}) 不一致，以模式配置为准",
            max_total,
            mode_max
        );
    }

    // 限制在有效范围内（以模式配置的 total_max_score 为上界）
    if total > mode_max {
        log::warn!(
            "[EssayGrading] 解析的分数 {} 超出模式最大值 {}，修正为最大值",
            total,
            mode_max
        );
    }
    if total < 0.0 {
        log::warn!("[EssayGrading] 解析的分数 {} 为负数，修正为 0", total);
    }
    let total = total.max(0.0).min(mode_max);

    // 解析维度评分
    let mut dimensions = Vec::new();
    for cap in dim_regex.captures_iter(dims_content) {
        let name = cap.get(1)?.as_str().to_string();
        let score: f32 = cap.get(2)?.as_str().parse().ok()?;
        let max_score: f32 = cap.get(3)?.as_str().parse().ok()?;
        let comment = cap
            .get(4)
            .map(|m| m.as_str().trim().to_string())
            .filter(|s| !s.is_empty());

        // ★ M-8: 维度评分也需要边界校验
        // ★ 二轮修复：添加 NaN/Infinity 检查
        if !max_score.is_finite() || max_score <= 0.0 {
            continue; // 跳过无效维度
        }
        if !score.is_finite() {
            continue; // 跳过无效分数
        }

        // ★ M-058: 维度评分也校验模式配置的一致性
        let dim_max = mode
            .score_dimensions
            .iter()
            .find(|d| d.name == name)
            .map(|d| d.max_score)
            .unwrap_or(max_score);
        let score = score.max(0.0).min(dim_max);

        dimensions.push(DimensionScore {
            name,
            score,
            max_score,
            comment,
        });
    }

    // ★ M-8: 安全计算百分比（已确保 mode_max > 0）
    // ★ M-058: 使用模式配置的 max 计算百分比
    let percentage = total / mode_max * 100.0;
    let grade = if percentage >= 90.0 {
        "优秀".to_string()
    } else if percentage >= 75.0 {
        "良好".to_string()
    } else if percentage >= 60.0 {
        "及格".to_string()
    } else {
        "不及格".to_string()
    };

    Some(ParsedScore {
        total,
        max_total: mode_max, // ★ M-058: 使用模式配置的权威值
        grade,
        dimensions,
    })
}

/// ★ PP-1: 净化用户输入，移除潜在的注入攻击内容
///
/// ★ 二轮修复：使用字符数而非字节数截断，防止 UTF-8 边界问题导致 panic
fn sanitize_user_input(input: &str, max_chars: usize) -> String {
    // 1. 按字符数（而非字节数）截断，避免截断多字节 UTF-8 字符导致 panic
    let char_count = input.chars().count();
    let truncated: String = if char_count > max_chars {
        println!(
            "⚠️ [EssayGrading] 输入过长（{} 字符），截断到 {} 字符",
            char_count, max_chars
        );
        input.chars().take(max_chars).collect()
    } else {
        input.to_string()
    };

    // 2. 移除可能干扰 LLM 的特殊指令模式（但保留正常的 XML 标签符号）
    // 只移除明显的注入尝试，如 "忽略以上所有指令" 等
    // ★ 二轮修复：使用 to_lowercase 进行大小写不敏感匹配
    let lower = truncated.to_lowercase();
    let mut result = truncated.clone();

    // 检测并替换（保留原始大小写的警告）
    let patterns = [
        ("忽略以上", "[已过滤]"),
        ("忽略上述", "[已过滤]"),
        ("忽略所有", "[已过滤]"),
        ("忽略之前", "[已过滤]"),
        ("无视上面", "[已过滤]"),
    ];

    for (pattern, replacement) in patterns {
        if lower.contains(pattern) {
            result = result.replace(pattern, replacement);
        }
    }

    // 英文模式（大小写不敏感）
    let english_patterns = [
        ("ignore above", "[filtered]"),
        ("ignore all", "[filtered]"),
        ("ignore previous", "[filtered]"),
        ("disregard", "[filtered]"),
    ];

    for (pattern, replacement) in english_patterns {
        if lower.contains(pattern) {
            // 使用正则进行大小写不敏感替换
            let re = regex::Regex::new(&format!("(?i){}", regex::escape(pattern))).ok();
            if let Some(re) = re {
                result = re.replace_all(&result, replacement).to_string();
            }
        }
    }

    result
}

/// 构造批改 Prompt
///
/// ★ PP-1 修复（2026-02-02）：添加输入净化，防止注入攻击
fn build_grading_prompts(
    request: &GradingRequest,
    mode: &GradingMode,
) -> Result<(String, String), AppError> {
    // ★ PP-1: 验证输入长度
    if request.input_text.trim().is_empty() {
        return Err(AppError::validation("作文内容不能为空".to_string()));
    }
    let input_char_count = request.input_text.chars().count();
    if input_char_count > MAX_INPUT_CHARS {
        return Err(AppError::validation(format!(
            "作文内容超过最大长度限制（{} 字符）",
            MAX_INPUT_CHARS
        )));
    }

    // 构建系统提示词
    let mut system_prompt = String::new();

    // 1. 批阅模式的系统提示词
    system_prompt.push_str(&mode.system_prompt);
    system_prompt.push_str("\n\n");

    // 2. 添加标记符使用说明
    system_prompt.push_str(MARKER_INSTRUCTIONS);
    system_prompt.push_str("\n");

    // 3. 添加评分格式说明，包含该模式的评分维度
    system_prompt.push_str(SCORE_FORMAT_INSTRUCTIONS);
    system_prompt.push_str("\n\n该模式的评分维度（总分 ");
    system_prompt.push_str(&mode.total_max_score.to_string());
    system_prompt.push_str(" 分）：\n");
    for dim in &mode.score_dimensions {
        system_prompt.push_str(&format!("- {}（{}分）", dim.name, dim.max_score));
        if let Some(desc) = &dim.description {
            system_prompt.push_str(&format!("：{}", desc));
        }
        system_prompt.push_str("\n");
    }

    // 4. 添加学生提问解答指令
    system_prompt.push_str("\n学生提问解答：\n");
    system_prompt.push_str("如果学生在作文尾部附加了提问、疑惑或请求（例如\"老师，这里我不太确定该怎么写\"、\"请问这个词用得对吗\"等），你需要在批改解析中对这些问题逐一进行解答，帮助学生理解和改进。注意区分正文内容与尾部提问，提问部分不纳入评分。\n");

    // 5. 如果有用户自定义 prompt，追加（限制长度并净化）
    if let Some(custom) = &request.custom_prompt {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            // ★ PP-1: 限制自定义 prompt 长度为 2000 字符
            let sanitized = sanitize_user_input(trimmed, 2000);
            system_prompt.push_str("\n用户额外要求：\n");
            system_prompt.push_str(&sanitized);
        }
    }

    // 构造用户提示
    let mut user_prompt = String::new();

    // 如果有作文题干（限制长度）
    if let Some(topic) = &request.topic {
        let trimmed = topic.trim();
        if !trimmed.is_empty() {
            // ★ PP-1: 限制题目长度为 1000 字符
            let sanitized = sanitize_user_input(trimmed, 1000);
            user_prompt.push_str("【作文题目】\n");
            user_prompt.push_str(&sanitized);
            user_prompt.push_str("\n\n---\n\n");
        }
    }

    // 如果有上一轮上下文，加入供 AI 对比参考
    let has_previous_context =
        request.previous_input.is_some() || request.previous_result.is_some();
    if has_previous_context {
        if let Some(prev_input) = &request.previous_input {
            let trimmed = prev_input.trim();
            if !trimmed.is_empty() {
                let sanitized = sanitize_user_input(trimmed, MAX_PREVIOUS_RESULT_CHARS);
                user_prompt.push_str("【上一轮学生原文】\n");
                user_prompt.push_str(&sanitized);
                user_prompt.push_str("\n\n");
            }
        }
        if let Some(prev) = &request.previous_result {
            let trimmed = prev.trim();
            if !trimmed.is_empty() {
                let sanitized = sanitize_user_input(trimmed, MAX_PREVIOUS_RESULT_CHARS);
                user_prompt.push_str("【上一轮批改反馈】\n");
                user_prompt.push_str(&sanitized);
                user_prompt.push_str("\n\n");
            }
        }
        user_prompt.push_str("---\n\n");
        user_prompt.push_str("以下为学生修改后的新版本，请对比上一轮原文，关注学生的改进与仍存在的问题，给出针对性批改。\n\n");
    }

    // 兼容旧版：根据作文类型和年级补充提示（空值不添加）
    let essay_type_hint = match request.essay_type.as_str() {
        "narrative" => "这是一篇记叙文。",
        "argumentative" => "这是一篇议论文。",
        "expository" => "这是一篇说明文。",
        _ => "",
    };

    let grade_hint = match request.grade_level.as_str() {
        "middle_school" => "请按照初中生的标准进行评判。",
        "high_school" => "请按照高中生的标准进行评判。",
        "college" => "请按照大学生的标准进行评判。",
        _ => "",
    };

    if !essay_type_hint.is_empty() || !grade_hint.is_empty() {
        user_prompt.push_str(&format!("{} {}\n\n", essay_type_hint, grade_hint));
    }

    // ★ PP-1: 作文内容本身不做净化（保留原始内容以便正确批改）
    user_prompt.push_str(&format!("【学生作文】\n{}", request.input_text));

    Ok((system_prompt, user_prompt))
}

/// 流式批改（核心逻辑）
async fn stream_grade<F>(
    config: &ApiConfig,
    api_key: &str,
    system_prompt: &str,
    user_prompt: &str,
    stream_event: &str,
    llm: Arc<LLMManager>,
    mut on_chunk: F,
) -> Result<StreamStatus, AppError>
where
    F: FnMut(String),
{
    let result = async {
        // 构造消息
        let messages = vec![
            json!({
                "role": "system",
                "content": system_prompt
            }),
            json!({
                "role": "user",
                "content": user_prompt
            }),
        ];

        // 构造请求体
        let request_body = json!({
            "model": config.model,
            "messages": messages,
            "temperature": 0.7,
            "max_tokens": config.max_output_tokens,
            "stream": true,
        });

        // 选择适配器
        let adapter: Box<dyn ProviderAdapter> = match config.model_adapter.as_str() {
            "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
            "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
            _ => Box::new(crate::providers::OpenAIAdapter),
        };

        // 构造 HTTP 请求
        let preq = adapter
            .build_request(&config.base_url, api_key, &config.model, &request_body)
            .map_err(|e| AppError::llm(format!("批改请求构建失败: {}", e)))?;

        let mut header_map = reqwest::header::HeaderMap::new();
        for (k, v) in preq.headers.iter() {
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                reqwest::header::HeaderValue::from_str(v),
            ) {
                header_map.insert(name, val);
            }
        }

        // 复用 LLMManager 配置好的 HTTP 客户端
        let client = llm.get_http_client();

        // 注册取消监听
        llm.consume_pending_cancel(stream_event).await;
        let mut cancel_rx = llm.subscribe_cancel_stream(stream_event).await;

        // 发送流式请求
        let response = client
            .post(&preq.url)
            .headers(header_map)
            .json(&preq.body)
            .send()
            .await
            .map_err(|e| AppError::llm(format!("批改请求失败: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AppError::llm(format!(
                "批改 API 返回错误 {}: {}",
                status, error_text
            )));
        }

        // 解析 SSE 流
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut stream_ended = false;
        let mut cancelled = false;

        while !stream_ended && !cancelled {
            if llm.consume_pending_cancel(stream_event).await {
                cancelled = true;
                break;
            }

            tokio::select! {
                changed = cancel_rx.changed() => {
                    if changed.is_ok() && *cancel_rx.borrow() {
                        cancelled = true;
                    }
                }
                chunk_result = stream.next() => {
                    match chunk_result {
                        Some(chunk) => {
                            let bytes = chunk.map_err(|e| AppError::llm(format!("读取流失败: {}", e)))?;
                            buffer.push_str(&String::from_utf8_lossy(&bytes));

                            while let Some(pos) = buffer.find("\n\n") {
                                let line = buffer[..pos].trim().to_string();
                                buffer = buffer[pos + 2..].to_string();

                                if line.is_empty() {
                                    continue;
                                }

                                if line == "data: [DONE]" {
                                    stream_ended = true;
                                    break;
                                }

                                let events = adapter.parse_stream(&line);
                                for event in events {
                                    match event {
                                        crate::providers::StreamEvent::ContentChunk(content) => {
                                            on_chunk(content);
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
                        }
                        None => {
                            break;
                        }
                    }
                }
            }
        }

        if cancelled {
            return Ok(StreamStatus::Cancelled);
        }

        // ★ M-064: 区分正常完成和流意外中断
        if stream_ended {
            Ok(StreamStatus::Completed)
        } else {
            println!("⚠️ [EssayGrading] SSE 流未收到 DONE 标记就结束，结果可能不完整");
            Ok(StreamStatus::Incomplete)
        }
    }.await;

    llm.clear_cancel_stream(stream_event).await;

    result
}
