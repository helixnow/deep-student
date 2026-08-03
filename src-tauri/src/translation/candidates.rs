//! 多候选翻译 - 为对照/择优 UI（ComparisonView 等）提供备选译文后端基础
//!
//! 职责：
//! - 对同一源文本并发产出 1~3 个风格取向不同的候选译文（precise/natural/concise）
//! - 每个候选独立流式回传增量，前端按 candidate_index 分桶渲染
//! - 不写 VFS、不复用 standalone 翻译事件名，互不干扰
//!
//! 事件契约（事件名：`translation_candidates_{session_id}`，payload tag = "type"）：
//! - candidate_data / candidate_complete / candidate_error：单候选粒度
//! - complete（含全部候选与 detected_lang）/ cancelled / error：整次调用终态
//!
//! 取消：调用 `cancel_translation_candidates(session_id)`，
//! 或对单个候选调用通用 `cancel_stream`（事件名见 `candidate_stream_event`）。

use futures_util::future::join_all;
use tauri::{Emitter, State, Window};
use tracing::{info, warn};

use crate::commands::AppState;
use crate::models::AppError;

use super::pipeline::{
    build_system_prompt, build_user_prompt, detect_source_lang, stream_translate_inner,
    StreamOptions, StreamStatus,
};
use super::types::{
    TranslationCandidate, TranslationCandidatesEvent, TranslationCandidatesResponse,
    TranslationRequest,
};

/// 候选数量上限（取消命令按该上限广播，勿随意下调）
pub(crate) const MAX_CANDIDATES: u32 = 3;
/// 多候选场景文本上限：候选是精读/择优场景，超长文本请走 standalone 分段管线
const MAX_CANDIDATE_TEXT_CHARS: usize = 8_000;

/// (标签, 温度, 附加风格指令)
const CANDIDATE_PROFILES: [(&str, f32, &str); 3] = [
    (
        "precise",
        0.2,
        "For this version: prioritize accuracy and faithfulness to the source. \
         Keep terminology exact and stay close to the original sentence structure.",
    ),
    (
        "natural",
        0.7,
        "For this version: prioritize natural, idiomatic fluency in the target language. \
         You may freely restructure sentences as a native writer would.",
    ),
    (
        "concise",
        0.5,
        "For this version: prefer concise, polished phrasing while preserving the full meaning. \
         Trim redundancy where the source allows.",
    ),
];

fn candidates_event_name(session_id: &str) -> String {
    format!("translation_candidates_{}", session_id)
}

/// 单个候选的内部取消事件名（供 `cancel_stream` / `cancel_translation_candidates` 使用）
pub(crate) fn candidate_stream_event(session_id: &str, index: u32) -> String {
    format!("translation_candidates_{}__c{}", session_id, index)
}

fn emit_candidates_event(window: &Window, session_id: &str, payload: TranslationCandidatesEvent) {
    let event = candidates_event_name(session_id);
    if let Err(e) = window.emit(&event, payload) {
        warn!("[TranslationCandidates] 发送事件失败 ({}): {}", event, e);
    }
}

enum CandidateOutcome {
    Done(String),
    Failed {
        message: String,
        code: Option<String>,
    },
    Cancelled,
}

/// 命令：多候选翻译（并发流式）
///
/// # 参数
/// - `request`: 与 `translate_text_stream` 相同的请求结构（复用术语表/风格/领域字段）
/// - `num_candidates`: 候选数（默认 2，范围 1~3）
///
/// # 返回
/// 全部候选（含失败候选）；同时通过事件流实时回传增量。
#[tauri::command]
pub async fn translate_text_candidates(
    request: TranslationRequest,
    num_candidates: Option<u32>,
    window: Window,
    state: State<'_, AppState>,
) -> Result<TranslationCandidatesResponse, AppError> {
    if request.session_id.trim().is_empty() {
        return Err(AppError::validation("session_id 不能为空"));
    }
    if request.text.trim().is_empty() {
        return Err(AppError::validation("翻译文本不能为空"));
    }
    let text_chars = request.text.chars().count();
    if text_chars > MAX_CANDIDATE_TEXT_CHARS {
        return Err(AppError::validation(format!(
            "多候选翻译文本过长（{} 字符，最大 {}）",
            text_chars, MAX_CANDIDATE_TEXT_CHARS
        )));
    }

    let n = num_candidates.unwrap_or(2).clamp(1, MAX_CANDIDATES);
    let session_id = request.session_id.clone();
    info!(
        "[TranslationCandidates] start session={} src={} tgt={} chars={} n={}",
        session_id, request.src_lang, request.tgt_lang, text_chars, n
    );

    let detected_lang = if request.src_lang == "auto" {
        detect_source_lang(&request.text).map(|s| s.to_string())
    } else {
        None
    };

    let config = match state.llm_manager.get_translation_model_config().await {
        Ok(cfg) => cfg,
        Err(e) => {
            let msg = format!("翻译模型未配置：{}", e);
            emit_candidates_event(
                &window,
                &session_id,
                TranslationCandidatesEvent::Error {
                    message: msg.clone(),
                    code: Some("model_not_configured".to_string()),
                },
            );
            return Err(AppError::llm(msg));
        }
    };
    let api_key = match state.llm_manager.decrypt_api_key(&config.api_key) {
        Ok(k) => k,
        Err(e) => {
            let msg = format!("API 密钥解密失败：{}", e);
            emit_candidates_event(
                &window,
                &session_id,
                TranslationCandidatesEvent::Error {
                    message: msg.clone(),
                    code: Some("api_key_error".to_string()),
                },
            );
            return Err(AppError::llm(msg));
        }
    };

    let base_system_prompt = build_system_prompt(&request);
    let user_prompt = build_user_prompt(&request, &request.text);

    let llm = state.llm_manager.clone();
    let config_ref = &config;
    let api_key_ref = api_key.as_str();
    let user_prompt_ref = user_prompt.as_str();

    let candidate_futures = (0..n).map(|idx| {
        let (label, temperature, instruction) = CANDIDATE_PROFILES[idx as usize];
        let system_prompt = format!("{}\n\n{}", base_system_prompt, instruction);
        let cand_event = candidate_stream_event(&session_id, idx);
        let window = window.clone();
        let llm = llm.clone();
        let session_id = session_id.clone();

        async move {
            let options = StreamOptions {
                temperature,
                ..StreamOptions::default()
            };
            let mut accum = String::new();
            let status = stream_translate_inner(
                config_ref,
                api_key_ref,
                &system_prompt,
                user_prompt_ref,
                &cand_event,
                llm.clone(),
                &options,
                |chunk| {
                    accum.push_str(&chunk);
                    emit_candidates_event(
                        &window,
                        &session_id,
                        TranslationCandidatesEvent::CandidateData {
                            candidate_index: idx,
                            label: label.to_string(),
                            delta: chunk,
                        },
                    );
                },
            )
            .await;
            llm.clear_cancel_artifacts(&cand_event).await;

            let outcome = match status {
                Ok(StreamStatus::Completed) => {
                    if accum.trim().is_empty() {
                        CandidateOutcome::Failed {
                            message: "翻译服务返回空结果".to_string(),
                            code: Some("empty_result".to_string()),
                        }
                    } else {
                        CandidateOutcome::Done(accum)
                    }
                }
                Ok(StreamStatus::Cancelled) => CandidateOutcome::Cancelled,
                Ok(StreamStatus::Incomplete) => CandidateOutcome::Failed {
                    message: "候选译文流式响应异常中断，结果不完整".to_string(),
                    code: Some("stream_incomplete".to_string()),
                },
                Err(f) => CandidateOutcome::Failed {
                    message: f.message,
                    code: Some(f.code),
                },
            };

            match &outcome {
                CandidateOutcome::Done(text) => {
                    emit_candidates_event(
                        &window,
                        &session_id,
                        TranslationCandidatesEvent::CandidateComplete {
                            candidate_index: idx,
                            label: label.to_string(),
                            text: text.clone(),
                        },
                    );
                }
                CandidateOutcome::Failed { message, code } => {
                    emit_candidates_event(
                        &window,
                        &session_id,
                        TranslationCandidatesEvent::CandidateError {
                            candidate_index: idx,
                            label: label.to_string(),
                            message: message.clone(),
                            code: code.clone(),
                        },
                    );
                }
                CandidateOutcome::Cancelled => {}
            }

            (idx, label, outcome)
        }
    });

    let results = join_all(candidate_futures).await;

    let mut candidates: Vec<TranslationCandidate> = Vec::with_capacity(results.len());
    let mut cancelled = false;
    let mut success_count = 0usize;
    let mut first_failure: Option<(String, Option<String>)> = None;
    for (idx, label, outcome) in results {
        match outcome {
            CandidateOutcome::Done(text) => {
                success_count += 1;
                candidates.push(TranslationCandidate {
                    index: idx,
                    label: label.to_string(),
                    text,
                    error: None,
                });
            }
            CandidateOutcome::Failed { message, code } => {
                if first_failure.is_none() {
                    first_failure = Some((message.clone(), code));
                }
                candidates.push(TranslationCandidate {
                    index: idx,
                    label: label.to_string(),
                    text: String::new(),
                    error: Some(message),
                });
            }
            CandidateOutcome::Cancelled => {
                cancelled = true;
            }
        }
    }
    candidates.sort_by_key(|c| c.index);

    let created_at = chrono::Utc::now().to_rfc3339();

    if cancelled {
        emit_candidates_event(&window, &session_id, TranslationCandidatesEvent::Cancelled);
        info!("[TranslationCandidates] cancelled session={}", session_id);
        return Ok(TranslationCandidatesResponse {
            session_id,
            candidates,
            detected_lang,
            cancelled: true,
            created_at,
        });
    }

    if success_count == 0 {
        let (message, code) =
            first_failure.unwrap_or_else(|| ("多候选翻译失败，请重试".to_string(), None));
        emit_candidates_event(
            &window,
            &session_id,
            TranslationCandidatesEvent::Error {
                message: message.clone(),
                code,
            },
        );
        warn!(
            "[TranslationCandidates] all failed session={} msg={}",
            session_id, message
        );
        return Err(AppError::llm(message));
    }

    emit_candidates_event(
        &window,
        &session_id,
        TranslationCandidatesEvent::Complete {
            candidates: candidates.clone(),
            detected_lang: detected_lang.clone(),
        },
    );
    info!(
        "[TranslationCandidates] complete session={} ok={}/{}",
        session_id,
        success_count,
        candidates.len()
    );

    Ok(TranslationCandidatesResponse {
        session_id,
        candidates,
        detected_lang,
        cancelled: false,
        created_at,
    })
}

/// 命令：取消一次多候选翻译（对该 session 的全部候选广播取消信号）
#[tauri::command]
pub async fn cancel_translation_candidates(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<bool, AppError> {
    info!("[TranslationCandidates] cancel session={}", session_id);
    for idx in 0..MAX_CANDIDATES {
        let event = candidate_stream_event(&session_id, idx);
        state.llm_manager.request_cancel_stream(&event).await;
    }
    Ok(true)
}
