/// 题目集 AI 评判管线 - 核心业务逻辑
///
/// 复用 essay_grading 的流式管线骨架：
/// - stream_grade: SSE 流解析 + tokio::select! 取消
/// - ProviderAdapter: 多供应商适配
/// - S-014 竞态防护
/// - M-064 不完整流检测
///
/// ## 判分落库依赖（Wave2-E r4-02）
///
/// Grade 模式的判分落库不再手写 UPDATE（旧实现只处理 NULL→true +1，
/// false→true 不加、true→false 不减，且不写 mastery 事件），统一改为调用
/// 共享原语 `QuestionBankService::apply_submission_verdict_in_tx`（r4-01 按
/// r1-06 §2 从 regrade_submission_in_tx 抽取，`&self` 方法，接受裸
/// Connection / Transaction 两种调用方）。原语内完成：submission 判定 +
/// grading_method + RowSync 推进、correct_count 差值（±1 / MAX(0,·) 防负，
/// 以 submission 旧 is_correct 为基准）、状态 CASE、S-030 同步标记 +
/// content hash、mastery 事件（幂等键 me_qbank_{submission_id}，本文件不
/// 重复插）、refresh_stats_with_conn。事务外副作用（SM-2 复习计划、
/// learner_profile 回流）由本文件按 `VerdictApplyOutcome` 的
/// needs_review_plan / mastery_state 标记执行。
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

    let persist_result = persist_grading_result(
        &conn,
        &deps.vfs_db,
        &question,
        &request.mode,
        &request.submission_id,
        &accumulated,
        verdict.as_ref(),
        score,
    )
    .and_then(|outcome| {
        conn.execute("RELEASE qbank_grading_persist", [])
            .map_err(|e| AppError::database(format!("提交评判事务失败: {}", e)))?;
        Ok(outcome)
    });

    let verdict_outcome = match persist_result {
        Ok(outcome) => outcome,
        Err(e) => {
            let _ = conn.execute("ROLLBACK TO qbank_grading_persist", []);
            let _ = conn.execute("RELEASE qbank_grading_persist", []);
            deps.emitter
                .emit_error(&request.stream_session_id, e.message.clone());
            return Err(e);
        }
    };
    drop(conn);

    // 统计刷新已由原语在事务内完成（refresh_stats_with_conn），
    // 此处不再做事务外二次刷新。

    if let Some(outcome) = &verdict_outcome {
        // AI 判错时自动创建（或复用）SM-2 复习计划，与人工改判路径对称
        // （needs_review_plan 由原语按新判定给出）。失败不阻塞评判流程。
        if outcome.needs_review_plan {
            let review_service =
                crate::review_plan_service::ReviewPlanService::new(Arc::clone(&deps.vfs_db));
            if let Err(e) =
                review_service.get_or_create_plan(&request.question_id, &question.exam_id)
            {
                log::warn!(
                    "[QbankGrading] AI 判错后创建复习计划失败: question_id={}, err={}",
                    request.question_id,
                    e
                );
            }
        }

        // mastery 状态回流 learner_profile（与 regrade_submission_in_tx 同口径，
        // 事务外执行，失败不阻塞）。
        if let Some(state) = &outcome.mastery_state {
            let mastery = crate::mastery::MasteryService::new(Arc::clone(&deps.vfs_db));
            if let Err(e) = mastery.sync_learner_profile(state) {
                log::warn!(
                    "[QbankGrading] mastery profile 回流失败: question_id={}, err={}",
                    request.question_id,
                    e
                );
            }
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

/// 持久化评判结果（在调用方开启的 SAVEPOINT/事务内执行，可单测）。
///
/// - 两种模式都写 AI 缓存（ai_feedback / ai_score / ai_graded_at）；
/// - Grade 模式的判分落库（submission 判定 + grading_method='ai'、
///   correct_count 差值 ±1 / MAX(0,·) 防负、状态 CASE、S-030 同步标记、
///   content hash、mastery 事件、统计刷新）统一复用
///   `QuestionBankService::apply_submission_verdict_in_tx`，与人工改判同口径；
///   mastery 事件由原语写入（幂等键），本函数不重复插；
/// - Analyze 模式只写 ai_feedback，自行补 S-030 同步标记 + content hash。
///
/// 返回 Grade 模式下原语给出的 `VerdictApplyOutcome`（Analyze 为 None），
/// 供调用方在事务外接 SM-2 复习计划与 learner_profile 回流。
fn persist_grading_result(
    conn: &rusqlite::Connection,
    vfs_db: &Arc<VfsDatabase>,
    question: &Question,
    mode: &QbankGradingMode,
    submission_id: &str,
    feedback: &str,
    verdict: Option<&Verdict>,
    score: Option<i32>,
) -> Result<Option<crate::question_bank_service::VerdictApplyOutcome>, AppError> {
    let now = chrono::Utc::now().to_rfc3339();

    // ① 更新 AI 缓存
    // Analyze 模式不产生分数，保留已有 ai_score（避免"先评判后解析"把评分缓存清空）
    let updated = if *mode == QbankGradingMode::Grade {
        conn.execute(
            r#"UPDATE questions SET ai_feedback = ?1, ai_score = ?2, ai_graded_at = ?3, updated_at = ?3
               WHERE id = ?4 AND deleted_at IS NULL"#,
            params![feedback, score, &now, &question.id],
        )
    } else {
        conn.execute(
            r#"UPDATE questions SET ai_feedback = ?1, ai_graded_at = ?2, updated_at = ?2
               WHERE id = ?3 AND deleted_at IS NULL"#,
            params![feedback, &now, &question.id],
        )
    }
    .map_err(|e| AppError::database(format!("保存 AI 反馈失败: {}", e)))?;
    if updated == 0 {
        return Err(AppError::not_found(format!(
            "题目不存在或已删除: {}",
            question.id
        )));
    }

    if *mode != QbankGradingMode::Grade {
        // Analyze 只改了 ai_feedback：S-030 口径需标记同步并重算 content hash，
        // 否则云同步会用远端旧值覆盖本次解析结果。
        // （Grade 模式下这两步由判分原语在同一事务内完成，不重复调用。）
        crate::question_sync_service::QuestionSyncService::mark_as_modified_with_conn(
            conn,
            &question.id,
        )
        .map_err(|e| AppError::database(format!("标记同步状态失败: {}", e)))?;
        crate::question_sync_service::QuestionSyncService::update_content_hash_with_conn(
            conn,
            &question.id,
        )
        .map_err(|e| AppError::database(format!("更新内容哈希失败: {}", e)))?;
        return Ok(None);
    }

    let v = verdict.ok_or_else(|| AppError::llm("缺少评判 verdict".to_string()))?;

    // 事务内重读 submission，以其"旧 is_correct"为差值基准（r1-06 §2）：
    // 流式评判耗时较长，期间用户可能已自评/再提交；沿用评判开始前的旧快照
    // 或题目级 is_correct 都会算错差值方向。同时校验归属，防止串题写入。
    let submission = get_submission_by_id_with_conn(conn, submission_id)?
        .ok_or_else(|| AppError::not_found(format!("作答记录不存在: {}", submission_id)))?;
    if submission.question_id != question.id {
        return Err(AppError::validation(format!(
            "作答记录 {} 不属于题目 {}",
            submission_id, question.id
        )));
    }

    // ②③④ 判分落库统一走共享原语（替换旧的"仅 NULL→true +1"手写 UPDATE）：
    // false→true +1、true→false -1（MAX(0,·) 防负）、状态 CASE、
    // mark_as_modified + content hash、mastery 事件（幂等键，原语已写，此处
    // 不重复插）、refresh_stats 全部由原语在同一事务内完成，
    // 保证 AI 判分与人工改判计数完全一致。
    let outcome = crate::question_bank_service::QuestionBankService::new(Arc::clone(vfs_db))
        .apply_submission_verdict_in_tx(conn, question, &submission, v.is_correct(), "ai", &now)?;
    Ok(Some(outcome))
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
    get_submission_by_id_with_conn(&conn, submission_id)
}

fn get_submission_by_id_with_conn(
    conn: &rusqlite::Connection,
    submission_id: &str,
) -> Result<Option<AnswerSubmission>, AppError> {
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

    // ========================================================================
    // persist_grading_result：判分落库统一走共享原语
    // `QuestionBankService::apply_submission_verdict_in_tx`（r4-02）。
    //
    // 旧实现的单向守卫（"仅 is_correct IS NULL 时 +1"）已删除，其防重复语义
    // 由原语的同向幂等短路承接（见 first_verdict_null_to_true 的二次调用断言）；
    // false→true / true→false 两个此前被判丢的方向在下面分别补测。
    // ========================================================================

    fn setup_persist_db() -> (tempfile::TempDir, Arc<VfsDatabase>) {
        let (tmp, db) = crate::vfs::database::setup_migrated_test_db();
        (tmp, Arc::new(db))
    }

    /// 造一道带标签的题目并落下首次作答基线。
    ///
    /// - `first_verdict = Some(_)`：走 `submit_answer` 自评 override，
    ///   真实写入基线计数与首判 mastery 事件（幂等键 me_qbank_{submission_id}）；
    /// - `first_verdict = None`：直接插一条待判定 submission（is_correct IS NULL）。
    ///
    /// 返回重新加载后的 Question（携带最新计数）与 submission_id。
    fn seed_question_with_submission(
        db: &Arc<VfsDatabase>,
        first_verdict: Option<bool>,
    ) -> (Question, String) {
        let conn = db.get_conn_safe().expect("conn");
        let exam_id = format!("exam_{}", nanoid::nanoid!(6));
        conn.execute(
            "INSERT INTO exam_sheets (
                id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at
             ) VALUES (?1, 'pipeline persist test', 'completed', ?2, '{}', '{}', ?3, ?3)",
            params![exam_id, format!("temp_{exam_id}"), "2020-01-01T00:00:00Z"],
        )
        .expect("seed exam");
        drop(conn);

        let question = VfsQuestionRepo::create_question(
            db,
            &crate::vfs::repos::question_repo::CreateQuestionParams {
                exam_id,
                card_id: None,
                question_label: Some("1".into()),
                content: "简述牛顿第二定律".into(),
                options: None,
                answer: Some("F = ma".into()),
                explanation: None,
                structured_data: None,
                question_type: None,
                difficulty: None,
                tags: Some(vec!["牛顿定律".into()]),
                source_type: None,
                source_ref: None,
                images: None,
                parent_id: None,
            },
        )
        .expect("create question");

        let submission_id = match first_verdict {
            Some(v) => {
                crate::question_bank_service::QuestionBankService::new(Arc::clone(db))
                    .submit_answer(&question.id, "学生答案", Some(v), None)
                    .expect("submit baseline answer")
                    .submission_id
            }
            None => {
                let conn = db.get_conn_safe().expect("conn");
                VfsQuestionRepo::insert_submission_with_conn(
                    &conn,
                    &question.id,
                    "学生答案",
                    None,
                    "auto",
                    None,
                )
                .expect("insert pending submission")
            }
        };

        let question = VfsQuestionRepo::get_question(db, &question.id)
            .expect("reload question")
            .expect("question exists");
        (question, submission_id)
    }

    fn question_counters(
        conn: &rusqlite::Connection,
        question_id: &str,
    ) -> (i64, Option<i64>, String, i64) {
        conn.query_row(
            "SELECT correct_count, is_correct, status, attempt_count FROM questions WHERE id = ?1",
            params![question_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .expect("query question counters")
    }

    fn submission_state(conn: &rusqlite::Connection, submission_id: &str) -> (Option<i64>, String) {
        conn.query_row(
            "SELECT is_correct, grading_method FROM answer_submissions WHERE id = ?1",
            params![submission_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("query submission state")
    }

    /// 未删除 mastery 事件按 outcome 计数（幂等键前缀 me_qbank_{submission_id}；
    /// 换判纠正的修订事件带 _rN 后缀，同属该前缀）。
    fn live_mastery_events(conn: &rusqlite::Connection, submission_id: &str, outcome: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM mastery_events
             WHERE id LIKE ?1 AND outcome = ?2 AND deleted_at IS NULL",
            params![format!("me_qbank_{}%", submission_id), outcome],
            |r| r.get(0),
        )
        .expect("count mastery events")
    }

    /// NULL→true 首判：+1、状态推进、mastery 事件由原语写入；
    /// 同一 submission 重跑 AI 评判不重复计数（旧 NULL 守卫语义由原语幂等承接）。
    #[test]
    fn persist_grade_first_verdict_null_to_true_counts_once() {
        let (_tmp, db) = setup_persist_db();
        let (question, submission_id) = seed_question_with_submission(&db, None);
        let conn = db.get_conn_safe().expect("conn");

        let outcome = persist_grading_result(
            &conn,
            &db,
            &question,
            &QbankGradingMode::Grade,
            &submission_id,
            "解析…<verdict>correct</verdict><score value=\"90\"/>",
            Some(&Verdict::Correct),
            Some(90),
        )
        .expect("persist should succeed")
        .expect("grade mode returns outcome");

        let (correct_count, is_correct, status, _) = question_counters(&conn, &question.id);
        assert_eq!(correct_count, 1, "首判答对 correct_count +1");
        assert_eq!(is_correct, Some(1));
        assert_eq!(status, "in_progress");

        let (sub_correct, method) = submission_state(&conn, &submission_id);
        assert_eq!(sub_correct, Some(1));
        assert_eq!(method, "ai");

        // mastery 事件由原语写入，pipeline 不重复插 → 恰好 1 条
        assert_eq!(live_mastery_events(&conn, &submission_id, "correct"), 1);
        assert!(!outcome.needs_review_plan, "判对不需要复习计划");

        // 同向重跑（同一 submission 再评一次 correct）不得再 +1
        let question = VfsQuestionRepo::get_question(&db, &question.id)
            .expect("reload")
            .expect("exists");
        persist_grading_result(
            &conn,
            &db,
            &question,
            &QbankGradingMode::Grade,
            &submission_id,
            "重评…<verdict>correct</verdict><score value=\"92\"/>",
            Some(&Verdict::Correct),
            Some(92),
        )
        .expect("re-run persist");
        let (correct_count, _, _, _) = question_counters(&conn, &question.id);
        assert_eq!(correct_count, 1, "重复评判不得重复计数");
        assert_eq!(live_mastery_events(&conn, &submission_id, "correct"), 1);
    }

    /// false→true 换判：旧实现漏掉的 +1 方向（is_correct=0 非 NULL 时不加）。
    #[test]
    fn persist_grade_false_to_true_increments_correct_count() {
        let (_tmp, db) = setup_persist_db();
        let (question, submission_id) = seed_question_with_submission(&db, Some(false));
        assert_eq!(question.correct_count, 0);
        assert_eq!(question.is_correct, Some(false));
        let baseline_attempts = question.attempt_count as i64;
        let conn = db.get_conn_safe().expect("conn");

        let outcome = persist_grading_result(
            &conn,
            &db,
            &question,
            &QbankGradingMode::Grade,
            &submission_id,
            "其实答对了…<verdict>correct</verdict><score value=\"85\"/>",
            Some(&Verdict::Correct),
            Some(85),
        )
        .expect("persist should succeed")
        .expect("grade mode returns outcome");

        let (correct_count, is_correct, status, attempt_count) =
            question_counters(&conn, &question.id);
        assert_eq!(correct_count, 1, "false→true 必须 +1（与人工改判同口径）");
        assert_eq!(is_correct, Some(1));
        assert_eq!(status, "in_progress");
        assert_eq!(attempt_count, baseline_attempts, "换判不新增作答次数");

        let (sub_correct, method) = submission_state(&conn, &submission_id);
        assert_eq!(sub_correct, Some(1));
        assert_eq!(method, "ai");

        // 换判走原语的纠正分路（record_qbank_verdict_correction_with_conn）：
        // 首判 wrong 信号被 tombstone，存活事件恰 1 条 _rN correct 修订，
        // 方向跟随最新判定而非被 ON CONFLICT DO NOTHING 锁死在首判。
        assert_eq!(
            live_mastery_events(&conn, &submission_id, "correct"),
            1,
            "换判后存活信号必须是 correct 修订事件"
        );
        assert_eq!(
            live_mastery_events(&conn, &submission_id, "wrong"),
            0,
            "首判 wrong 信号必须被 tombstone"
        );
        assert!(!outcome.needs_review_plan);
    }

    /// true→false 换判：旧实现漏掉的 -1 方向（correct_count 残留）。
    #[test]
    fn persist_grade_true_to_false_decrements_correct_count() {
        let (_tmp, db) = setup_persist_db();
        let (question, submission_id) = seed_question_with_submission(&db, Some(true));
        assert_eq!(question.correct_count, 1);
        assert_eq!(question.is_correct, Some(true));
        let baseline_attempts = question.attempt_count as i64;
        let conn = db.get_conn_safe().expect("conn");

        let outcome = persist_grading_result(
            &conn,
            &db,
            &question,
            &QbankGradingMode::Grade,
            &submission_id,
            "其实答错了…<verdict>incorrect</verdict><score value=\"20\"/>",
            Some(&Verdict::Incorrect),
            Some(20),
        )
        .expect("persist should succeed")
        .expect("grade mode returns outcome");

        let (correct_count, is_correct, status, attempt_count) =
            question_counters(&conn, &question.id);
        assert_eq!(correct_count, 0, "true→false 必须 -1（MAX(0,·) 防负）");
        assert_eq!(is_correct, Some(0));
        assert_eq!(status, "review", "判错必须进入 review 状态");
        assert_eq!(attempt_count, baseline_attempts, "换判不新增作答次数");

        let (sub_correct, method) = submission_state(&conn, &submission_id);
        assert_eq!(sub_correct, Some(0));
        assert_eq!(method, "ai");

        // 同上：换判纠正分路——首判 correct 被 tombstone，存活信号翻到 wrong。
        assert_eq!(
            live_mastery_events(&conn, &submission_id, "wrong"),
            1,
            "换判后存活信号必须是 wrong 修订事件"
        );
        assert_eq!(
            live_mastery_events(&conn, &submission_id, "correct"),
            0,
            "首判 correct 信号必须被 tombstone"
        );
        assert!(
            outcome.needs_review_plan,
            "判错需在事务外接 SM-2 复习计划（与人工改判对称）"
        );
    }
}
