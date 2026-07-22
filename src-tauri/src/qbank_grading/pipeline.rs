/// 题目集 AI 评判管线 - 核心业务逻辑
///
/// 复用 essay_grading 的流式管线骨架：
/// - stream_grade: SSE 流解析 + tokio::select! 取消
/// - ProviderAdapter: 多供应商适配
/// - S-014 竞态防护
/// - M-064 不完整流检测
use futures_util::StreamExt;
use regex::Regex;
use rusqlite::{params, OptionalExtension};
use serde_json::json;
use std::sync::Arc;

use crate::llm_manager::{build_provider_adapter, ApiConfig, LLMManager};
use crate::models::AppError;
use crate::providers::ProviderAdapter;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{AnswerSubmission, Question, VfsQuestionRepo};

use super::events::QbankGradingEmitter;
use super::types::{
    QbankGradingMode, QbankGradingRequest, QbankGradingResponse, Verdict, ANALYZE_SYSTEM_PROMPT,
    GRADE_SYSTEM_PROMPT,
};

/// 建连/响应头超时：send() 在收到响应头后即完成，不限制流式 body 时长
const REQUEST_HEADER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
/// 流式空闲超时：相邻两个 SSE 数据块之间的最大等待时间
const STREAM_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

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
    // 错误传播完整性：任何前置失败都要同时发 error 事件，
    // 保证只监听流事件（不 await invoke 结果）的前端也能拿到可读错误。
    let emit_and_return = |err: AppError| -> AppError {
        deps.emitter
            .emit_error(&request.stream_session_id, err.message.clone());
        err
    };

    // 1. 获取题目信息
    let question = VfsQuestionRepo::get_question(&deps.vfs_db, &request.question_id)
        .map_err(|e| emit_and_return(AppError::database(e.to_string())))?
        .ok_or_else(|| {
            emit_and_return(AppError::not_found(format!(
                "题目不存在: {}",
                request.question_id
            )))
        })?;

    // 2. 校验 submission 归属并获取当前答案（必须绑定到本次 submission）
    let current_submission = match get_submission_by_id(&deps.vfs_db, &request.submission_id) {
        Ok(Some(sub)) => sub,
        Ok(None) => {
            return Err(emit_and_return(AppError::not_found(format!(
                "作答记录不存在: {}",
                request.submission_id
            ))));
        }
        Err(e) => return Err(emit_and_return(e)),
    };
    if current_submission.question_id != request.question_id {
        return Err(emit_and_return(AppError::validation(format!(
            "作答记录 {} 不属于题目 {}",
            request.submission_id, request.question_id
        ))));
    }

    // 3. 获取作答历史（最近 5 条）
    let submissions = VfsQuestionRepo::get_submissions(&deps.vfs_db, &request.question_id, 5)
        .map_err(|e| emit_and_return(AppError::database(e.to_string())))?;

    // 4. 构造 Prompt
    let (system_prompt, user_prompt) =
        build_prompts(&question, &current_submission, &submissions, &request.mode)
            .map_err(&emit_and_return)?;

    // 5. 获取模型配置
    let config = resolve_grading_config(&deps.llm, request.model_config_id.as_ref())
        .await
        .map_err(&emit_and_return)?;
    let api_key = deps
        .llm
        .decrypt_api_key(&config.api_key)
        .map_err(&emit_and_return)?;

    // 6. 流式调用 LLM
    let mut accumulated = String::new();
    let stream_event = format!("qbank_grading_stream_{}", request.stream_session_id);

    let stream_status = match stream_grade(
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
    .await
    {
        Ok(status) => status,
        Err(e) => {
            deps.emitter
                .emit_error(&request.stream_session_id, e.message.clone());
            return Err(e);
        }
    };

    if matches!(stream_status, StreamStatus::Cancelled) {
        deps.emitter.emit_cancelled(&request.stream_session_id);
        return Ok(None);
    }

    if matches!(stream_status, StreamStatus::Incomplete) {
        // 🔧 #56: 仅在没有任何累积文本时才报错；已有文本则继续走后续校验/持久化，
        // 避免"解析先流式出现、随后整段消失"。grade 模式仍由下方 verdict 校验兜底。
        if accumulated.trim().is_empty() {
            let err = AppError::llm(
                "AI 评判流式响应异常中断，结果不完整。请检查网络连接后重试。".to_string(),
            );
            deps.emitter
                .emit_error(&request.stream_session_id, err.message.clone());
            return Err(err);
        }
        log::warn!(
            "[QbankGrading] SSE 流缺少完成哨兵但已累积 {} 字符，保留结果继续处理（#56）",
            accumulated.len()
        );
    }

    // S-014: 二次检查取消状态
    if deps.llm.consume_pending_cancel(&stream_event).await {
        log::info!("[QbankGrading] 流完成后发现已取消，丢弃结果");
        deps.emitter.emit_cancelled(&request.stream_session_id);
        return Ok(None);
    }

    // 7. 解析结构化输出
    let (verdict, score) = if request.mode == QbankGradingMode::Grade {
        parse_verdict_and_score(&accumulated)
    } else {
        (None, None)
    };

    if request.mode == QbankGradingMode::Grade && verdict.is_none() {
        let err = AppError::llm(
            "AI 评判结果缺少有效 verdict 标签（需为 correct|partial|incorrect）。".to_string(),
        );
        deps.emitter
            .emit_error(&request.stream_session_id, err.message.clone());
        return Err(err);
    }

    // 8. 持久化（SAVEPOINT 原子写入，任一失败即回滚并报错）
    let conn = match deps.vfs_db.get_conn_safe() {
        Ok(c) => c,
        Err(e) => {
            let err = AppError::database(format!("获取数据库连接失败: {}", e));
            deps.emitter
                .emit_error(&request.stream_session_id, err.message.clone());
            return Err(err);
        }
    };

    if let Err(e) = conn.execute("SAVEPOINT qbank_grading_persist", []) {
        let err = AppError::database(format!("创建 SAVEPOINT 失败: {}", e));
        deps.emitter
            .emit_error(&request.stream_session_id, err.message.clone());
        return Err(err);
    }

    let persist_result = (|| -> Result<(), AppError> {
        let now = chrono::Utc::now().to_rfc3339();

        // ① 更新 AI 缓存
        // Analyze 模式不产生分数，保留已有 ai_score（避免"先评判后解析"把评分缓存清空）
        let updated = if request.mode == QbankGradingMode::Grade {
            conn.execute(
                r#"UPDATE questions SET ai_feedback = ?1, ai_score = ?2, ai_graded_at = ?3, updated_at = ?3
                   WHERE id = ?4 AND deleted_at IS NULL"#,
                params![&accumulated, score, &now, &request.question_id],
            )
        } else {
            conn.execute(
                r#"UPDATE questions SET ai_feedback = ?1, ai_graded_at = ?2, updated_at = ?2
                   WHERE id = ?3 AND deleted_at IS NULL"#,
                params![&accumulated, &now, &request.question_id],
            )
        }
        .map_err(|e| AppError::database(format!("保存 AI 反馈失败: {}", e)))?;
        if updated == 0 {
            return Err(AppError::not_found(format!(
                "题目不存在或已删除: {}",
                request.question_id
            )));
        }

        // Grade 模式：② 更新 submission 正误 + ③ 更新 question 正误
        if request.mode == QbankGradingMode::Grade {
            let v = verdict
                .as_ref()
                .ok_or_else(|| AppError::llm("缺少评判 verdict".to_string()))?;
            let is_correct_val: i32 = if v.is_correct() { 1 } else { 0 };

            // ② 更新 submission（严格绑定 question_id，防止串题写入）
            let submission_updated = conn
                .execute(
                    "UPDATE answer_submissions SET is_correct = ?1, grading_method = 'ai' WHERE id = ?2 AND question_id = ?3",
                    params![is_correct_val, &request.submission_id, &request.question_id],
                )
                .map_err(|e| AppError::database(format!("更新 submission 正误失败: {}", e)))?;
            if submission_updated == 0 {
                return Err(AppError::not_found(format!(
                    "作答记录不存在或不属于该题目: {}",
                    request.submission_id
                )));
            }

            // ③ 更新 question（仅当 is_correct 为 NULL 时递增 correct_count，防止重复计数）
            let question_updated = conn
                .execute(
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
                    params![is_correct_val, &now, &request.question_id],
                )
                .map_err(|e| AppError::database(format!("更新题目正误失败: {}", e)))?;
            if question_updated == 0 {
                return Err(AppError::not_found(format!(
                    "题目不存在或已删除: {}",
                    request.question_id
                )));
            }
        }

        // ④ S-030 口径：AI 评判写入了 ai_feedback/is_correct，与 submit_answer 一样
        // 需标记同步状态并重算 content hash，否则云同步会用远端旧值覆盖本次评判结果。
        crate::question_sync_service::QuestionSyncService::mark_as_modified_with_conn(
            &conn,
            &request.question_id,
        )
        .map_err(|e| AppError::database(format!("标记同步状态失败: {}", e)))?;
        crate::question_sync_service::QuestionSyncService::update_content_hash_with_conn(
            &conn,
            &request.question_id,
        )
        .map_err(|e| AppError::database(format!("更新内容哈希失败: {}", e)))?;

        conn.execute("RELEASE qbank_grading_persist", [])
            .map_err(|e| AppError::database(format!("提交评判事务失败: {}", e)))?;
        Ok(())
    })();

    if let Err(e) = persist_result {
        let _ = conn.execute("ROLLBACK TO qbank_grading_persist", []);
        let _ = conn.execute("RELEASE qbank_grading_persist", []);
        deps.emitter
            .emit_error(&request.stream_session_id, e.message.clone());
        return Err(e);
    }

    // 刷新统计缓存（事务外执行，非关键）
    if request.mode == QbankGradingMode::Grade && verdict.is_some() {
        if let Err(e) = VfsQuestionRepo::refresh_stats(&deps.vfs_db, &question.exam_id) {
            log::warn!("[QbankGrading] 刷新统计失败: {}", e);
        }
    }

    // AI 判错时自动创建（或复用）SM-2 复习计划，与 question_bank_service.rs
    // submit_answer 自动判分路径的 I1 修复对称：此前 AI 判错的题只置 status='review'
    // 而不进复习计划，错题永远不会出现在间隔复习队列里。失败不阻塞评判流程。
    if request.mode == QbankGradingMode::Grade && verdict.as_ref().is_some_and(|v| !v.is_correct())
    {
        let review_service =
            crate::review_plan_service::ReviewPlanService::new(Arc::clone(&deps.vfs_db));
        if let Err(e) = review_service.get_or_create_plan(&request.question_id, &question.exam_id) {
            log::warn!(
                "[QbankGrading] AI 判错后创建复习计划失败: question_id={}, err={}",
                request.question_id,
                e
            );
        }
    }

    let verdict_str = verdict.as_ref().map(|v| match v {
        Verdict::Correct => "correct".to_string(),
        Verdict::Partial => "partial".to_string(),
        Verdict::Incorrect => "incorrect".to_string(),
    });

    // 9. 发送完成事件
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

/// 解析评判使用的模型配置
///
/// 优先级：请求显式指定 > 模型分配表中的 qbank 评判模型 > Model2 默认配置。
async fn resolve_grading_config(
    llm: &LLMManager,
    model_config_id: Option<&String>,
) -> Result<ApiConfig, AppError> {
    if let Some(model_id) = model_config_id {
        let configs = llm.get_api_configs().await?;
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
        if found.is_reranker {
            return Err(AppError::llm(format!(
                "重排序模型不支持 AI 评判: {}",
                model_id
            )));
        }
        return Ok(found);
    }

    let assignments = llm.get_model_assignments().await?;
    if let Some(model_id) = assignments.qbank_ai_grading_model_config_id {
        let configs = llm.get_api_configs().await?;
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
        Ok(found)
    } else {
        llm.get_model2_config().await
    }
}

/// 构造评判 Prompt
fn build_prompts(
    question: &Question,
    current_submission: &AnswerSubmission,
    submissions: &[AnswerSubmission],
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
        user_prompt.push('\n');
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

    // 当前答案（严格使用本次 submission 的答案，避免读取到 questions.user_answer 的竞态值）
    let label = match mode {
        QbankGradingMode::Grade => "## 学生答案（待评判）",
        QbankGradingMode::Analyze => match current_submission.is_correct {
            Some(true) => "## 学生答案（正确）",
            Some(false) => "## 学生答案（错误）",
            None => "## 学生答案（待评判）",
        },
    };
    user_prompt.push_str(label);
    user_prompt.push('\n');
    user_prompt.push_str(&current_submission.user_answer);
    user_prompt.push_str("\n\n");

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
        user_prompt.push('\n');
    }

    Ok((system_prompt, user_prompt))
}

fn get_submission_by_id(
    db: &VfsDatabase,
    submission_id: &str,
) -> Result<Option<AnswerSubmission>, AppError> {
    let conn = db
        .get_conn_safe()
        .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;

    conn.query_row(
        r#"
        SELECT id, question_id, user_answer, is_correct, grading_method, submitted_at
        FROM answer_submissions
        WHERE id = ?1
        "#,
        params![submission_id],
        |row| {
            let is_correct: Option<i32> = row.get(3)?;
            Ok(AnswerSubmission {
                id: row.get(0)?,
                question_id: row.get(1)?,
                user_answer: row.get(2)?,
                is_correct: is_correct.map(|v| v != 0),
                grading_method: row.get(4)?,
                submitted_at: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(|e| AppError::database(format!("查询作答记录失败: {}", e)))
}

/// 解析 verdict 和 score
///
/// 提示词要求标签出现在反馈"最末尾"，但模型偶尔会在正文中先复述标签格式；
/// 取最后一个匹配以符合"末尾标签为准"的语义。
fn parse_verdict_and_score(result: &str) -> (Option<Verdict>, Option<i32>) {
    // 解析 <verdict>correct|partial|incorrect</verdict>
    let verdict = Regex::new(r"<verdict>\s*(correct|partial|incorrect)\s*</verdict>")
        .ok()
        .and_then(|re| re.captures_iter(result).last())
        .and_then(|cap| cap.get(1))
        .and_then(|m| Verdict::from_str(m.as_str()));

    // 解析 <score value="N"/>
    let score = Regex::new(r#"<score\s+value="(\d+)"\s*/>"#)
        .ok()
        .and_then(|re| re.captures_iter(result).last())
        .and_then(|cap| cap.get(1))
        .and_then(|m| m.as_str().parse::<i32>().ok())
        .map(|s| s.clamp(0, 100)); // 范围裁剪

    (verdict, score)
}

/// 🔧 #56: 检测 SSE 数据块是否携带 finish_reason（非 null）。
///
/// 部分 OpenAI 兼容网关只发 `finish_reason: "stop"` 而不发 `data: [DONE]` 哨兵，
/// 此时也应视为流正常完成，避免把完整结果误判为 Incomplete 而丢弃。
fn sse_block_signals_finish(line: &str) -> bool {
    let Some(data) = line.lines().find_map(|line| {
        line.strip_prefix("data:")
            .map(|data| data.strip_prefix(' ').unwrap_or(data))
    }) else {
        return false;
    };
    let Ok(json_data) = serde_json::from_str::<serde_json::Value>(data) else {
        return false;
    };
    json_data["choices"]
        .as_array()
        .map(|choices| {
            choices
                .iter()
                .any(|c| c["finish_reason"].as_str().is_some())
        })
        .unwrap_or(false)
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

        let mut request_body = json!({
            "model": config.model,
            "messages": messages,
            "temperature": 0.3,
            "max_tokens": crate::llm_manager::effective_max_tokens(
                config.max_output_tokens,
                config.max_tokens_limit,
            )
            .min(8192),
            "stream": true,
        });

        crate::llm_manager::LLMManager::apply_reasoning_config(&mut request_body, config, None);

        let adapter: Box<dyn ProviderAdapter> = build_provider_adapter(config);

        let mut preq = llm
            .prepare_provider_request(
                adapter.as_ref(),
                config,
                &request_body,
                Some(api_key),
                Some(stream_event),
                "评判请求构建失败",
            )
            .await?;

        let client = llm.get_http_client();

        if llm.consume_pending_cancel(stream_event).await {
            return Ok(StreamStatus::Cancelled);
        }
        let mut cancel_rx = llm.subscribe_cancel_stream(stream_event).await;

        let response = if preq.is_codex() {
            llm.send_codex_stream_request_with_single_refresh(
                &mut preq,
                Some(std::time::Duration::from_secs(300)),
            )
            .await?
        } else {
            let mut header_map = reqwest::header::HeaderMap::new();
            for (k, v) in &preq.headers {
                if let (Ok(name), Ok(val)) = (
                    reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                    reqwest::header::HeaderValue::from_str(v),
                ) {
                    header_map.insert(name, val);
                }
            }

            // 建连/首包超时：send() 在响应头返回时完成，不会截断后续流式 body
            tokio::time::timeout(
                REQUEST_HEADER_TIMEOUT,
                client
                    .post(&preq.url)
                    .headers(header_map)
                    .json(&preq.body)
                    .send(),
            )
            .await
            .map_err(|_| {
                AppError::llm(format!(
                    "评判请求超时（{} 秒未收到响应），请检查网络后重试",
                    REQUEST_HEADER_TIMEOUT.as_secs()
                ))
            })?
            .map_err(|e| AppError::llm(format!("评判请求失败: {}", e)))?
        };

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AppError::llm(format!(
                "评判 API 返回错误 {}: {}",
                status, error_text
            )));
        }

        let mut stream = response.bytes_stream();
        let mut sse_buffer = crate::utils::sse_buffer::SseEventBuffer::new();
        let mut stream_ended = false;
        let mut cancelled = false;
        // 🔧 #56: 部分 OpenAI 兼容网关只发 finish_reason 不发 `data: [DONE]` 哨兵。
        // 观察到 finish_reason 即视为正常完成，避免把完整结果误判为 Incomplete 而丢弃。
        let mut finish_observed = false;

        // 处理单个 SSE 块：返回 true 表示流已结束
        let handle_sse_block =
            |line: &str, on_chunk: &mut F, finish_observed: &mut bool| -> bool {
                if line.is_empty() {
                    return false;
                }

                if crate::utils::sse_buffer::SseEventBuffer::check_done_marker(line) {
                    return true;
                }

                if sse_block_signals_finish(line) {
                    *finish_observed = true;
                }

                let events = adapter.parse_stream(line);
                let mut done = false;
                for event in events {
                    match event {
                        crate::providers::StreamEvent::ContentChunk(content) => {
                            on_chunk(content);
                        }
                        crate::providers::StreamEvent::Done => {
                            done = true;
                        }
                        _ => {}
                    }
                }
                done
            };

        // watch sender 一旦被清理（Err），停止轮询该分支，
        // 否则 changed() 每次立即返回 Err 会让 select 空转成忙等。
        let mut cancel_watch_alive = true;

        while !stream_ended && !cancelled {
            if llm.consume_pending_cancel(stream_event).await {
                cancelled = true;
                break;
            }

            tokio::select! {
                changed = cancel_rx.changed(), if cancel_watch_alive => {
                    match changed {
                        Ok(()) => {
                            if *cancel_rx.borrow() {
                                cancelled = true;
                            }
                        }
                        Err(_) => {
                            cancel_watch_alive = false;
                        }
                    }
                }
                chunk_result = tokio::time::timeout(STREAM_IDLE_TIMEOUT, stream.next()) => {
                    match chunk_result {
                        Ok(Some(chunk)) => {
                            let bytes = chunk.map_err(|e| AppError::llm(format!("读取流失败: {}", e)))?;
                            for line in sse_buffer.process_bytes(&bytes) {
                                if handle_sse_block(&line, &mut on_chunk, &mut finish_observed) {
                                    stream_ended = true;
                                    break;
                                }
                            }
                        }
                        Ok(None) => {
                            break;
                        }
                        Err(_) => {
                            // 空闲超时：服务端长时间不发数据，视为网络故障而非无限等待
                            return Err(AppError::llm(format!(
                                "AI 评判流式响应超时（{} 秒无数据），请检查网络后重试",
                                STREAM_IDLE_TIMEOUT.as_secs()
                            )));
                        }
                    }
                }
            }
        }

        if cancelled {
            return Ok(StreamStatus::Cancelled);
        }

        // 流自然关闭后 flush 残留事件（最后一个事件可能只有单换行或没有空行）。
        if !stream_ended {
            for remaining in sse_buffer.flush() {
                if handle_sse_block(&remaining, &mut on_chunk, &mut finish_observed) {
                    stream_ended = true;
                    break;
                }
            }
        }

        if stream_ended || finish_observed {
            Ok(StreamStatus::Completed)
        } else {
            log::warn!("[QbankGrading] SSE 流未收到 DONE 标记或 finish_reason 就结束，结果可能不完整");
            Ok(StreamStatus::Incomplete)
        }
    }
    .await;

    llm.clear_cancel_stream(stream_event).await;

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sse_block_signals_finish_detects_stop() {
        assert!(sse_block_signals_finish(
            r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"#
        ));
        assert!(sse_block_signals_finish(
            r#"data: {"choices":[{"delta":{"content":"末尾"},"finish_reason":"length"}]}"#
        ));
        assert!(sse_block_signals_finish(
            "event: message\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}"
        ));
    }

    #[test]
    fn test_sse_block_signals_finish_ignores_normal_chunks() {
        assert!(!sse_block_signals_finish(
            r#"data: {"choices":[{"delta":{"content":"abc"},"finish_reason":null}]}"#
        ));
        assert!(!sse_block_signals_finish("data: [DONE]"));
        assert!(!sse_block_signals_finish(": keep-alive"));
        assert!(!sse_block_signals_finish(""));
        assert!(!sse_block_signals_finish("data: not-json"));
    }

    #[test]
    fn test_parse_verdict_and_score() {
        let (verdict, score) =
            parse_verdict_and_score("分析过程…… <verdict>partial</verdict> <score value=\"65\"/>");
        assert!(matches!(verdict, Some(Verdict::Partial)));
        assert_eq!(score, Some(65));

        let (verdict, score) = parse_verdict_and_score("没有任何标签的纯文本");
        assert!(verdict.is_none());
        assert!(score.is_none());
    }

    #[test]
    fn test_parse_verdict_and_score_takes_last_match() {
        // 模型在正文中复述了标签格式，末尾的标签才是结论
        let text = "输出格式为 <verdict>correct</verdict> <score value=\"100\"/>。\n\
                    经过对比，学生答案部分正确。\n\
                    <verdict>partial</verdict>\n<score value=\"55\"/>";
        let (verdict, score) = parse_verdict_and_score(text);
        assert!(matches!(verdict, Some(Verdict::Partial)));
        assert_eq!(score, Some(55));
    }

    #[test]
    fn test_parse_verdict_and_score_clamps_range() {
        let (_, score) =
            parse_verdict_and_score("<verdict>correct</verdict> <score value=\"150\"/>");
        assert_eq!(score, Some(100));
    }
}
