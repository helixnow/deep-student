/// 题目集 AI 评判管线 - 核心业务逻辑
///
/// 复用 essay_grading 的流式管线骨架：
/// - stream_grade: SSE 流解析 + tokio::select! 取消
/// - ProviderAdapter: 多供应商适配
/// - S-014 竞态防护
/// - M-064 不完整流检测
use futures_util::StreamExt;
use regex::Regex;
use serde_json::json;
use std::sync::Arc;

use crate::llm_manager::{ApiConfig, LLMManager};
use crate::models::AppError;
use crate::providers::ProviderAdapter;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::VfsQuestionRepo;

use super::events::QbankGradingEmitter;
use super::types::{
    QbankGradingMode, QbankGradingRequest, QbankGradingResponse, Verdict, ANALYZE_SYSTEM_PROMPT,
    GRADE_SYSTEM_PROMPT,
};

/// 评判管线依赖
pub struct QbankGradingDeps {
    pub llm: Arc<LLMManager>,
    pub vfs_db: Arc<VfsDatabase>,
    pub emitter: QbankGradingEmitter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamStatus {
    Completed,
    Cancelled,
    Incomplete,
}

/// 运行 AI 评判管线
pub async fn run_qbank_grading(
    request: QbankGradingRequest,
    deps: QbankGradingDeps,
) -> Result<Option<QbankGradingResponse>, AppError> {
    // 1. 获取题目信息
    let question = VfsQuestionRepo::get_question(&deps.vfs_db, &request.question_id)
        .map_err(|e| AppError::database(e.to_string()))?
        .ok_or_else(|| AppError::not_found(format!("题目不存在: {}", request.question_id)))?;

    // 2. 获取作答历史（最近 5 条）
    let submissions = VfsQuestionRepo::get_submissions(&deps.vfs_db, &request.question_id, 5)
        .map_err(|e| AppError::database(e.to_string()))?;

    // 3. 构造 Prompt
    let (system_prompt, user_prompt) = build_prompts(&question, &submissions, &request.mode)?;

    // 4. 获取模型配置
    let config = if let Some(ref model_id) = request.model_config_id {
        let configs = deps.llm.get_api_configs().await?;
        let found = configs
            .into_iter()
            .find(|c| c.id == *model_id)
            .ok_or_else(|| AppError::llm(format!("未找到模型配置: {}", model_id)))?;
        if !found.enabled {
            return Err(AppError::llm(format!("模型配置已禁用: {}", model_id)));
        }
        if found.is_embedding {
            return Err(AppError::llm(format!(
                "嵌入模型不支持 AI 评判: {}",
                model_id
            )));
        }
        found
    } else {
        let assignments = deps.llm.get_model_assignments().await?;
        if let Some(model_id) = assignments.qbank_ai_grading_model_config_id {
            let configs = deps.llm.get_api_configs().await?;
            let found = configs
                .into_iter()
                .find(|c| c.id == model_id)
                .ok_or_else(|| AppError::llm(format!("未找到模型配置: {}", model_id)))?;
            if found.is_embedding {
                return Err(AppError::llm(format!(
                    "嵌入模型不支持 AI 评判: {}",
                    model_id
                )));
            }
            if found.is_reranker {
                return Err(AppError::llm(format!(
                    "重排序模型不支持 AI 评判: {}",
                    model_id
                )));
            }
            found
        } else {
            deps.llm.get_model2_config().await?
        }
    };
    let api_key = deps.llm.decrypt_api_key(&config.api_key)?;

    // 5. 流式调用 LLM
    let mut accumulated = String::new();
    let stream_event = format!("qbank_grading_stream_{}", request.stream_session_id);

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

    if matches!(stream_status, StreamStatus::Incomplete) {
        log::warn!(
            "[QbankGrading] 流式响应未完成，丢弃不完整结果（已累积 {} 字符）",
            accumulated.len()
        );
        return Err(AppError::llm(
            "AI 评判流式响应异常中断，结果不完整。请检查网络连接后重试。".to_string(),
        ));
    }

    // S-014: 二次检查取消状态
    if deps.llm.consume_pending_cancel(&stream_event).await {
        log::info!("[QbankGrading] 流完成后发现已取消，丢弃结果");
        deps.emitter.emit_cancelled(&request.stream_session_id);
        return Ok(None);
    }

    // 6. 解析结构化输出
    let (verdict, score) = if request.mode == QbankGradingMode::Grade {
        parse_verdict_and_score(&accumulated)
    } else {
        (None, None)
    };

    // 7. 持久化（使用同一连接 + 事务确保一致性）
    match deps.vfs_db.get_conn_safe() {
        Ok(conn) => {
            if let Err(e) = conn.execute_batch("BEGIN") {
                log::warn!("[QbankGrading] 事务开始失败: {}", e);
            }

            let now = chrono::Utc::now().to_rfc3339();

            // ① 更新 AI 缓存
            if let Err(e) = conn.execute(
                r#"UPDATE questions SET ai_feedback = ?1, ai_score = ?2, ai_graded_at = ?3, updated_at = ?3
                   WHERE id = ?4 AND deleted_at IS NULL"#,
                rusqlite::params![&accumulated, score, &now, &request.question_id],
            ) {
                log::warn!("[QbankGrading] 保存 AI 反馈失败: {}", e);
            }

            // Grade 模式：② 更新 submission 正误 + ③ 更新 question 正误
            if request.mode == QbankGradingMode::Grade {
                if let Some(ref v) = verdict {
                    let is_correct = v.is_correct();
                    let is_correct_val: i32 = if is_correct { 1 } else { 0 };

                    // ② 更新 submission
                    if let Err(e) = conn.execute(
                        "UPDATE answer_submissions SET is_correct = ?1, grading_method = 'ai' WHERE id = ?2",
                        rusqlite::params![is_correct_val, &request.submission_id],
                    ) {
                        log::warn!("[QbankGrading] 更新 submission 正误失败: {}", e);
                    }

                    // ③ 更新 question（仅当 is_correct 为 NULL 时递增 correct_count，防止重复计数）
                    if let Err(e) = conn.execute(
                        r#"
                        UPDATE questions SET
                            is_correct = ?1,
                            correct_count = CASE
                                WHEN is_correct IS NULL AND ?1 = 1 THEN correct_count + 1
                                ELSE correct_count
                            END,
                            status = CASE
                                WHEN ?1 = 0 THEN 'review'
                                WHEN (CASE WHEN is_correct IS NULL AND ?1 = 1 THEN correct_count + 1 ELSE correct_count END) >= 2 THEN 'mastered'
                                ELSE 'in_progress'
                            END,
                            updated_at = ?2
                        WHERE id = ?3 AND deleted_at IS NULL
                        "#,
                        rusqlite::params![is_correct_val, &now, &request.question_id],
                    ) {
                        log::warn!("[QbankGrading] 更新 question 正误失败: {}", e);
                    }
                }
            }

            if let Err(e) = conn.execute_batch("COMMIT") {
                log::warn!("[QbankGrading] 事务提交失败: {}", e);
            }

            // 刷新统计缓存（事务外执行，非关键）
            if request.mode == QbankGradingMode::Grade && verdict.is_some() {
                if let Err(e) = VfsQuestionRepo::refresh_stats(&deps.vfs_db, &question.exam_id) {
                    log::warn!("[QbankGrading] 刷新统计失败: {}", e);
                }
            }
        }
        Err(e) => {
            log::warn!("[QbankGrading] 获取数据库连接失败，跳过持久化: {}", e);
        }
    }

    let verdict_str = verdict.as_ref().map(|v| match v {
        Verdict::Correct => "correct".to_string(),
        Verdict::Partial => "partial".to_string(),
        Verdict::Incorrect => "incorrect".to_string(),
    });

    // 8. 发送完成事件
    deps.emitter.emit_complete(
        &request.stream_session_id,
        request.submission_id.clone(),
        verdict_str.clone(),
        score,
        accumulated.clone(),
    );

    Ok(Some(QbankGradingResponse {
        submission_id: request.submission_id,
        verdict,
        score,
        feedback: accumulated,
    }))
}

/// 构造评判 Prompt
fn build_prompts(
    question: &crate::vfs::repos::Question,
    submissions: &[crate::vfs::repos::AnswerSubmission],
    mode: &QbankGradingMode,
) -> Result<(String, String), AppError> {
    let system_prompt = match mode {
        QbankGradingMode::Grade => GRADE_SYSTEM_PROMPT.to_string(),
        QbankGradingMode::Analyze => ANALYZE_SYSTEM_PROMPT.to_string(),
    };

    let mut user_prompt = String::new();

    // 题目内容
    user_prompt.push_str("## 题目\n");
    user_prompt.push_str(&question.content);
    user_prompt.push_str("\n\n");

    // 题型
    user_prompt.push_str(&format!("## 题型\n{:?}\n\n", question.question_type));

    // 选项（如果有）
    if let Some(ref options) = question.options {
        user_prompt.push_str("## 选项\n");
        for opt in options {
            user_prompt.push_str(&format!("{}. {}\n", opt.key, opt.content));
        }
        user_prompt.push_str("\n");
    }

    // 参考答案
    if let Some(ref answer) = question.answer {
        user_prompt.push_str("## 参考答案\n");
        user_prompt.push_str(answer);
        user_prompt.push_str("\n\n");
    }

    // 参考解析
    if let Some(ref explanation) = question.explanation {
        user_prompt.push_str("## 参考解析\n");
        user_prompt.push_str(explanation);
        user_prompt.push_str("\n\n");
    }

    // 当前答案
    if let Some(ref user_answer) = question.user_answer {
        let label = match mode {
            QbankGradingMode::Grade => "## 学生答案（待评判）",
            QbankGradingMode::Analyze => {
                if question.is_correct == Some(true) {
                    "## 学生答案（正确）"
                } else {
                    "## 学生答案（错误）"
                }
            }
        };
        user_prompt.push_str(label);
        user_prompt.push_str("\n");
        user_prompt.push_str(user_answer);
        user_prompt.push_str("\n\n");
    }

    // 历次作答记录
    if !submissions.is_empty() {
        user_prompt.push_str("## 历次作答记录\n");
        for (i, sub) in submissions.iter().enumerate() {
            let correct_str = match sub.is_correct {
                Some(true) => "正确",
                Some(false) => "错误",
                None => "待评判",
            };
            user_prompt.push_str(&format!(
                "第{}次：答案=\"{}\"，结果={}，方式={}，时间={}\n",
                i + 1,
                sub.user_answer,
                correct_str,
                sub.grading_method,
                sub.submitted_at,
            ));
        }
        user_prompt.push_str("\n");
    }

    Ok((system_prompt, user_prompt))
}

/// 解析 verdict 和 score
fn parse_verdict_and_score(result: &str) -> (Option<Verdict>, Option<i32>) {
    // 解析 <verdict>correct|partial|incorrect</verdict>
    let verdict = Regex::new(r"<verdict>\s*(correct|partial|incorrect)\s*</verdict>")
        .ok()
        .and_then(|re| re.captures(result))
        .and_then(|cap| cap.get(1))
        .and_then(|m| Verdict::from_str(m.as_str()));

    // 解析 <score value="N"/>
    let score = Regex::new(r#"<score\s+value="(\d+)"\s*/>"#)
        .ok()
        .and_then(|re| re.captures(result))
        .and_then(|cap| cap.get(1))
        .and_then(|m| m.as_str().parse::<i32>().ok())
        .map(|s| s.max(0).min(100)); // 范围裁剪

    (verdict, score)
}

/// 流式调用 LLM（复用 essay_grading 的 stream_grade 实现）
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
        let messages = vec![
            json!({ "role": "system", "content": system_prompt }),
            json!({ "role": "user", "content": user_prompt }),
        ];

        let request_body = json!({
            "model": config.model,
            "messages": messages,
            "temperature": 0.3,
            "max_tokens": config.max_output_tokens.min(8192),
            "stream": true,
        });

        let adapter: Box<dyn ProviderAdapter> = match config.model_adapter.as_str() {
            "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
            "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
            _ => Box::new(crate::providers::OpenAIAdapter),
        };

        let preq = adapter
            .build_request(&config.base_url, api_key, &config.model, &request_body)
            .map_err(|e| AppError::llm(format!("评判请求构建失败: {}", e)))?;

        let mut header_map = reqwest::header::HeaderMap::new();
        for (k, v) in preq.headers.iter() {
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                reqwest::header::HeaderValue::from_str(v),
            ) {
                header_map.insert(name, val);
            }
        }

        let client = llm.get_http_client();

        llm.consume_pending_cancel(stream_event).await;
        let mut cancel_rx = llm.subscribe_cancel_stream(stream_event).await;

        let response = client
            .post(&preq.url)
            .headers(header_map)
            .json(&preq.body)
            .send()
            .await
            .map_err(|e| AppError::llm(format!("评判请求失败: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AppError::llm(format!(
                "评判 API 返回错误 {}: {}",
                status, error_text
            )));
        }

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

        if stream_ended {
            Ok(StreamStatus::Completed)
        } else {
            log::warn!("[QbankGrading] SSE 流未收到 DONE 标记就结束，结果可能不完整");
            Ok(StreamStatus::Incomplete)
        }
    }
    .await;

    llm.clear_cancel_stream(stream_event).await;

    result
}
