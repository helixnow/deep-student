/// 题目集 AI 出题管线 - 核心业务逻辑
///
/// MVP 方案（docs/dev/ai-question-generation-feasibility-2026-09-07.md §四）：
/// - 骨架与 qbank_grading::pipeline 一致（SSE 流解析 + tokio::select! 取消 + 120s 超时）
/// - 不直接落库：解析校验后的草稿通过 complete 事件回传前端预览，
///   用户确认后由前端调用既有 qbank_batch_create_questions 入库
///   （source_type=ai_generated，可行文档 §二 的既有路径）
/// - 模型解析复用 qbank_ai_grading 槽（§二 模型槽位复用点），Model2 兜底
use futures_util::StreamExt;
use serde_json::json;
use std::sync::Arc;

use crate::llm_manager::{build_provider_adapter, ApiConfig, LLMManager};
use crate::models::AppError;
use crate::providers::ProviderAdapter;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::VfsExamRepo;

use super::events::QbankGenerationEmitter;
use super::types::{
    build_generation_user_prompt, parse_generation_output, QbankGenerationRequest,
    QbankGenerationResponse, GENERATION_SYSTEM_PROMPT,
};

/// 建连/响应头超时：send() 在收到响应头后即完成，不限制流式 body 时长
const REQUEST_HEADER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
/// 流式空闲超时：相邻两个 SSE 数据块之间的最大等待时间
const STREAM_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamStatus {
    Completed,
    Cancelled,
    Incomplete,
}

/// 出题管线依赖
pub struct QbankGenerationDeps {
    pub llm: Arc<LLMManager>,
    pub vfs_db: Arc<VfsDatabase>,
    pub emitter: QbankGenerationEmitter,
}

/// 运行 AI 出题管线
pub async fn run_qbank_generation(
    request: QbankGenerationRequest,
    deps: QbankGenerationDeps,
) -> Result<Option<QbankGenerationResponse>, AppError> {
    // 错误传播完整性：任何前置失败都要同时发 error 事件，
    // 保证只监听流事件（不 await invoke 结果）的前端也能拿到可读错误。
    let emit_and_return = |err: AppError| -> AppError {
        deps.emitter
            .emit_error(&request.stream_session_id, err.message.clone());
        err
    };

    // 1. 题目集元信息 + 现有题目样本（变式参考）
    let (exam_name, existing_samples) = collect_exam_context(&deps.vfs_db, &request.exam_id)
        .map_err(|e| emit_and_return(AppError::database(e.to_string())))?;

    // 2. 构造 Prompt
    let system_prompt = GENERATION_SYSTEM_PROMPT.to_string();
    let user_prompt = build_generation_user_prompt(&exam_name, &existing_samples, &request);

    // 3. 获取模型配置
    let config = resolve_generation_config(&deps.llm, request.model_config_id.as_ref())
        .await
        .map_err(&emit_and_return)?;
    let api_key = deps
        .llm
        .decrypt_api_key(&config.api_key)
        .map_err(&emit_and_return)?;

    // 4. 流式调用 LLM
    let mut accumulated = String::new();
    let stream_event = format!("qbank_generation_stream_{}", request.stream_session_id);

    let stream_status = match stream_generate(
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

    if matches!(stream_status, StreamStatus::Incomplete) && accumulated.trim().is_empty() {
        let err = AppError::llm(
            "AI 出题流式响应异常中断，结果不完整。请检查网络连接后重试。".to_string(),
        );
        deps.emitter
            .emit_error(&request.stream_session_id, err.message.clone());
        return Err(err);
    }

    // S-014: 二次检查取消状态
    if deps.llm.consume_pending_cancel(&stream_event).await {
        log::info!("[QbankGeneration] 流完成后发现已取消，丢弃结果");
        deps.emitter.emit_cancelled(&request.stream_session_id);
        return Ok(None);
    }

    // 5. 解析 JSON 数组 + 逐题校验（单题失败剔除并记录，不整体失败）
    let mut response =
        parse_generation_output(&accumulated, request.max_questions).map_err(|e| {
            let err = AppError::llm(format!("AI 出题结果解析失败：{}", e));
            deps.emitter
                .emit_error(&request.stream_session_id, err.message.clone());
            err
        })?;
    if response.drafts.is_empty() {
        let err = AppError::llm("AI 生成的题目全部未通过校验，请调整要求后重试。".to_string());
        deps.emitter
            .emit_error(&request.stream_session_id, err.message.clone());
        return Err(err);
    }
    response.exam_id = request.exam_id.clone();

    // 6. 发送完成事件（不落库，前端预览确认后自行调 qbank_batch_create_questions）
    deps.emitter.emit_complete(
        &request.stream_session_id,
        response.exam_id.clone(),
        response.drafts.clone(),
        response.rejected_count,
        response.rejection_reasons.clone(),
    );

    log::info!(
        "[QbankGeneration] 出题完成：exam={}, drafts={}, rejected={}",
        response.exam_id,
        response.drafts.len(),
        response.rejected_count
    );

    Ok(Some(response))
}

/// 题目集名称 + 现有题目样本（based_on_existing 时给 prompt 出变式参考）
fn collect_exam_context(vfs_db: &VfsDatabase, exam_id: &str) -> VfsResult<(String, Vec<String>)> {
    use crate::vfs::repos::{QuestionFilters, VfsQuestionRepo};

    let exam_name = VfsExamRepo::get_exam_sheet(vfs_db, exam_id)
        .ok()
        .flatten()
        .and_then(|sheet| sheet.exam_name)
        .unwrap_or_else(|| "未命名题目集".to_string());

    let mut samples = Vec::new();
    let filters = QuestionFilters::default();
    if let Ok(result) = VfsQuestionRepo::list_questions(vfs_db, exam_id, &filters, 1, 10) {
        for question in result.questions {
            let mut sample = question.content.clone();
            if sample.len() > 120 {
                sample.truncate(120);
                sample.push('…');
            }
            samples.push(sample);
        }
    }
    Ok((exam_name, samples))
}

type VfsResult<T> = Result<T, crate::vfs::VfsError>;

/// 解析出题使用的模型配置
///
/// 优先级：请求显式指定 > 模型分配表中的 qbank_ai_grading 槽 > Model2 默认配置。
/// （与 qbank_grading::resolve_grading_config 同构；出题 MVP 复用批改模型槽，
/// 避免新增 ModelAssignments 字段与 UI 的长期成本，见可行文档 §三-4）
async fn resolve_generation_config(
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
        if found.is_embedding || found.is_reranker {
            return Err(AppError::llm(format!(
                "嵌入/重排序模型不支持 AI 出题: {}",
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
        if found.is_embedding || found.is_reranker {
            return Err(AppError::llm(format!(
                "嵌入/重排序模型不支持 AI 出题: {}",
                model_id
            )));
        }
        Ok(found)
    } else {
        llm.get_model2_config().await
    }
}

/// 流式调用 LLM（骨架与 qbank_grading::stream_grade 一致；独立成模块私有实现，
/// 避免 MVP 阶段先抽公共库牵动 essay/qbank 两处既有管线——可行文档 §四 分界决策点）
async fn stream_generate<F>(
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
            "temperature": 0.7,
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
                "出题请求构建失败",
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
                    "出题请求超时（{} 秒未收到响应），请检查网络后重试",
                    REQUEST_HEADER_TIMEOUT.as_secs()
                ))
            })?
            .map_err(|e| AppError::llm(format!("出题请求失败: {}", e)))?
        };

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AppError::llm(format!(
                "出题 API 返回错误 {}: {}",
                status, error_text
            )));
        }

        let mut stream = response.bytes_stream();
        let mut sse_buffer = crate::utils::sse_buffer::SseEventBuffer::new();
        let mut stream_ended = false;
        let mut cancelled = false;
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
                                "AI 出题流式响应超时（{} 秒无数据），请检查网络后重试",
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
            log::warn!("[QbankGeneration] SSE 流未收到 DONE 标记或 finish_reason 就结束，结果可能不完整");
            Ok(StreamStatus::Incomplete)
        }
    }
    .await;

    llm.clear_cancel_stream(stream_event).await;

    result
}

/// 🔧 检测 SSE 数据块是否携带 finish_reason（非 null）。
/// 与 qbank_grading::pipeline::sse_block_signals_finish 同逻辑（见 #56）。
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
