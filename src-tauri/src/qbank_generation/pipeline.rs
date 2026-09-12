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
use std::time::Instant;

use crate::llm_manager::{build_provider_adapter, ApiConfig, LLMManager};
use crate::models::AppError;
use crate::providers::ProviderAdapter;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::VfsExamRepo;

use super::reference::collect_references;
use super::types::{
    build_generation_user_prompt, parse_generation_output, QbankGenerationRequest,
    QbankGenerationResponse, ReferenceImage, GENERATION_SYSTEM_PROMPT,
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
}

/// 运行 AI 出题管线（纯任务执行器，不发任何前端事件）
///
/// 2026-09-09 后台化：事件出口收敛到调用方（命令层发全局任务事件、工具层返回结果），
/// 管线只负责「跑完并返回结果」。
///
/// 返回：
/// - `Ok(Some(response))`：正常完成
/// - `Ok(None)`：被取消（上层据此把任务标记为 cancelled）
/// - `Err(e)`：失败（上层据此把任务标记为 failed）
pub async fn run_qbank_generation(
    request: QbankGenerationRequest,
    deps: QbankGenerationDeps,
) -> Result<Option<QbankGenerationResponse>, AppError> {
    // 1. 题目集元信息 + 现有题目样本（变式参考）
    let (exam_name, existing_samples) = collect_exam_context(&deps.vfs_db, &request.exam_id)
        .map_err(|e| AppError::database(e.to_string()))?;

    // 2. 获取模型配置（提前：参考资料收集需要知道模型是否支持视觉）
    let config = resolve_generation_config(&deps.llm, request.model_config_id.as_ref()).await?;
    let api_key = deps.llm.decrypt_api_key(&config.api_key)?;

    // 3. 收集参考资料（注入模式解析：sha256 查重 / 文本层 / 多模态页面图）
    let references = collect_references(&deps.vfs_db, &request, config.is_multimodal)
        .await
        .map_err(|e| AppError::database(e.to_string()))?;

    // 4. 构造 Prompt
    let system_prompt = GENERATION_SYSTEM_PROMPT.to_string();
    let user_prompt = build_generation_user_prompt(
        &exam_name,
        &existing_samples,
        &request,
        &references.texts,
        &references.images,
    );

    // 5. 流式调用 LLM
    let mut accumulated = String::new();
    let stream_event = format!("qbank_generation_stream_{}", request.stream_session_id);

    let stream_status = stream_generate(
        &config,
        &api_key,
        &system_prompt,
        &user_prompt,
        &references.images,
        &stream_event,
        deps.llm.clone(),
        |chunk| {
            accumulated.push_str(&chunk);
        },
    )
    .await?;

    if matches!(stream_status, StreamStatus::Cancelled) {
        log::info!("[QbankGeneration] 出题被取消：exam={}", request.exam_id);
        return Ok(None);
    }

    if matches!(stream_status, StreamStatus::Incomplete) && accumulated.trim().is_empty() {
        return Err(AppError::llm(
            "AI 出题流式响应异常中断，结果不完整。请检查网络连接后重试。".to_string(),
        ));
    }

    // S-014: 二次检查取消状态
    if deps.llm.consume_pending_cancel(&stream_event).await {
        log::info!("[QbankGeneration] 流完成后发现已取消，丢弃结果");
        return Ok(None);
    }

    // 5. 解析 JSON 数组 + 逐题校验（单题失败剔除并记录，不整体失败）
    let mut response = parse_generation_output(&accumulated, request.max_questions)
        .map_err(|e| AppError::llm(format!("AI 出题结果解析失败：{}", e)))?;
    if response.drafts.is_empty() {
        return Err(AppError::llm(
            "AI 生成的题目全部未通过校验，请调整要求后重试。".to_string(),
        ));
    }
    response.exam_id = request.exam_id.clone();

    // 6. 返回结果（事件与落库由调用方处理：命令层写任务表 + 发全局任务事件）
    log::info!(
        "[QbankGeneration] 出题完成：exam={}, drafts={}, rejected={}, used_references={}, skipped_references={}",
        response.exam_id,
        response.drafts.len(),
        response.rejected_count,
        references.used_count(),
        references.skipped.len()
    );

    response.skipped_references = references.skipped.clone();
    response.used_reference_count = references.used_count();
    Ok(Some(response))
}

type VfsResult<T> = Result<T, crate::vfs::VfsError>;

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

/// 解析出题使用的模型配置
///
/// 优先级（2026-09-09 新增出题专用槽位）：
/// 请求显式指定 > `qbank_ai_generation_model_config_id` 出题槽
/// > `qbank_ai_grading_model_config_id` 批改槽 > Model2 默认配置。
async fn resolve_generation_config(
    llm: &LLMManager,
    model_config_id: Option<&String>,
) -> Result<ApiConfig, AppError> {
    if let Some(model_id) = model_config_id {
        log::info!("[QbankGeneration] 使用请求显式指定的模型: {}", model_id);
        return resolve_generation_config_by_id(llm, model_id).await;
    }

    let assignments = llm.get_model_assignments().await?;
    if let Some(model_id) = assignments.qbank_ai_generation_model_config_id.as_deref() {
        log::info!("[QbankGeneration] 使用出题专用模型槽位: {}", model_id);
        return resolve_generation_config_by_id(llm, model_id).await;
    }
    if let Some(model_id) = assignments.qbank_ai_grading_model_config_id.as_deref() {
        log::info!(
            "[QbankGeneration] 出题槽位未设置，回退批改槽位: {}",
            model_id
        );
        return resolve_generation_config_by_id(llm, model_id).await;
    }
    log::info!("[QbankGeneration] 出题/批改槽位均未设置，回退 Model2 默认配置");
    llm.get_model2_config().await
}

/// 按配置 ID 解析并校验（存在 / 启用 / 非嵌入非重排序）
async fn resolve_generation_config_by_id(
    llm: &LLMManager,
    model_id: &str,
) -> Result<ApiConfig, AppError> {
    let configs = llm.get_api_configs().await?;
    let found = configs
        .into_iter()
        .find(|c| c.id == model_id)
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
    Ok(found)
}

/// 构造 user 消息：无图片时纯文本；有页面图参考资料时用多模态 content 数组
/// （格式与对话侧 model2_pipeline 一致，`sanitize_openai_request_body` 只清理 tools，
/// messages 数组原样透传）
fn build_user_message(user_prompt: &str, images: &[ReferenceImage]) -> serde_json::Value {
    if images.is_empty() {
        return json!({ "role": "user", "content": user_prompt });
    }
    let mut content = vec![json!({ "type": "text", "text": user_prompt })];
    for image in images {
        content.push(json!({
            "type": "image_url",
            "image_url": { "url": format!("data:{};base64,{}", image.media_type, image.base64) }
        }));
    }
    json!({ "role": "user", "content": content })
}

/// 流式调用 LLM（骨架与 qbank_grading::stream_grade 一致；独立成模块私有实现，
/// 避免 MVP 阶段先抽公共库牵动 essay/qbank 两处既有管线——可行文档 §四 分界决策点）
async fn stream_generate<F>(
    config: &ApiConfig,
    api_key: &str,
    system_prompt: &str,
    user_prompt: &str,
    images: &[ReferenceImage],
    stream_event: &str,
    llm: Arc<LLMManager>,
    mut on_chunk: F,
) -> Result<StreamStatus, AppError>
where
    F: FnMut(String),
{
    // 出题流式调用阶段计时基线，配合 [QbankGeneration] 各阶段日志定位阻塞点
    // （安卓曾现 tokio 饿死 + connection aborted，需精确阶段耗时）。
    let t0 = Instant::now();
    let _stage = |t: &Instant, stage: &str, extra: &str| {
        log::info!(
            "[QbankGeneration][stream-g] {}: {:.1}s{}",
            stage,
            t.elapsed().as_secs_f32(),
            extra
        );
    };

    let result = async {
        let messages = vec![
            json!({ "role": "system", "content": system_prompt }),
            build_user_message(user_prompt, images),
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
        _stage(
            &t0,
            "prompt+body",
            &format!(
                " body_bytes={} ref_images={}",
                request_body.to_string().len(),
                images.len()
            ),
        );

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
        _stage(
            &t0,
            "prepare_provider_request",
            &format!(" url={}", preq.url),
        );

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

            log::info!(
                "[QbankGeneration][stream-g] sending POST {} body_bytes={}",
                preq.url,
                preq.body.to_string().len()
            );

            // 建连/首包超时：send() 在响应头返回时完成，不会截断后续流式 body
            let send_result = tokio::time::timeout(
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
            .map_err(|e| AppError::llm(format!("出题请求失败: {}", e)))?;
            _stage(&t0, "headers_received", "");
            send_result
        };

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AppError::llm(format!(
                "出题 API 返回错误 {}: {}",
                status, error_text
            )));
        }
        _stage(&t0, "status_ok", &format!(" http={}", response.status()));

        let mut stream = response.bytes_stream();
        let mut sse_buffer = crate::utils::sse_buffer::SseEventBuffer::new();
        let mut stream_ended = false;
        let mut cancelled = false;
        let mut finish_observed = false;

        // SSE 收流：按 10s 递增栅栏记录数据块进度，定位流中途停摆点
        // （安卓曾现流读到一半后 tokio 饿死 → connection aborted）。
        let mut first_chunk = true;
        let mut chunk_count: u64 = 0;
        let mut last_chunk_at = Instant::now();
        let mut stall_bucket = 0u32;

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
                            // 数据块进度栅栏：首块 + 每累计 10s 一记，覆盖大响应慢速流
                            let bytes = chunk.map_err(|e| AppError::llm(format!("读取流失败: {}", e)))?;
                            chunk_count += 1;
                            let now = Instant::now();
                            if first_chunk {
                                first_chunk = false;
                                _stage(&t0, "first_chunk", &format!(" bytes={}", bytes.len()));
                                last_chunk_at = now;
                            } else {
                                let bucket = (now.duration_since(last_chunk_at).as_secs() / 10) as u32;
                                if bucket > stall_bucket {
                                    stall_bucket = bucket;
                                    log::info!(
                                        "[QbankGeneration][stream-g] chunk#{}: {:.1}s since last chunk, elapsed {:.1}s",
                                        chunk_count,
                                        now.duration_since(last_chunk_at).as_secs_f32(),
                                        now.duration_since(t0).as_secs_f32()
                                    );
                                }
                            }
                            for line in sse_buffer.process_bytes(&bytes) {
                                if handle_sse_block(&line, &mut on_chunk, &mut finish_observed) {
                                    stream_ended = true;
                                    break;
                                }
                            }
                        }
                        Ok(None) => {
                            _stage(&t0, "stream_eof", &format!(" total_chunks={}", chunk_count));
                            break;
                        }
                        Err(_) => {
                            // 空闲超时：服务端长时间不发数据，视为网络故障而非无限等待
                            log::error!(
                                "[QbankGeneration][stream-g] stream idle timeout after {:.1}s idle / {:.1}s total; chunks={}; this maps to 'connection aborted' style loss",
                                STREAM_IDLE_TIMEOUT.as_secs_f32(),
                                t0.elapsed().as_secs_f32(),
                                chunk_count
                            );
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

        _stage(
            &t0,
            "stream_done",
            &format!(" status={:?} chunks={}", stream_ended, chunk_count),
        );

        if stream_ended || finish_observed {
            Ok(StreamStatus::Completed)
        } else {
            log::warn!("[QbankGeneration] SSE 流未收到 DONE 标记或 finish_reason 就结束，结果可能不完整；total={:.1}s", t0.elapsed().as_secs_f32());
            Ok(StreamStatus::Incomplete)
        }
    }
    .await;

    llm.clear_cancel_stream(stream_event).await;

    _stage(&t0, "stream_generate_done", "");
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
