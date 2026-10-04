//! 媒体讲义（docs/dev/media-learning §3）与笔记 → Word 导出命令。
//!
//! - `handout_llm_complete`：讲义写作的一次性文本调用（对话模型 model2 槽位；
//!   `json_mode` 控制 GPT 系 `response_format=json_object`，摘要/大纲走纯文本）。
//! - `handout_vlm_caption`：帧说明（视觉模型，沿用题目导入的 VLM 选型链）。
//! - `handout_cancel` / `handout_release`：按前端运行 ID 取消在途调用（drop future 即中断 HTTP）。
//! - `notes_export_docx`：笔记 Markdown 由前端转为 DOCX spec，本命令解析 `notes_assets/` 图片并生成字节。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use base64::{engine::general_purpose, Engine};
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::commands::AppState;
use crate::models::AppError;

type Result<T> = std::result::Result<T, AppError>;

/// 单张帧图 base64 上限（约 6 MB 原图），防止误传整段视频
const MAX_FRAME_BASE64_LEN: usize = 8 * 1024 * 1024;
/// 单次提示词上限（字符）
const MAX_PROMPT_CHARS: usize = 120_000;

fn registry() -> &'static Mutex<HashMap<String, CancellationToken>> {
    static REG: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn token_for(request_id: Option<&str>) -> CancellationToken {
    match request_id {
        Some(id) if !id.is_empty() => {
            let mut map = registry().lock().unwrap_or_else(|p| p.into_inner());
            map.entry(id.to_string()).or_default().clone()
        }
        _ => CancellationToken::new(),
    }
}

fn cancelled_error() -> AppError {
    AppError::validation("cancelled")
}

async fn run_cancellable<F>(token: CancellationToken, fut: F) -> Result<String>
where
    F: std::future::Future<Output = Result<crate::models::StandardModel2Output>>,
{
    if token.is_cancelled() {
        return Err(cancelled_error());
    }
    tokio::select! {
        _ = token.cancelled() => Err(cancelled_error()),
        out = fut => {
            let out = out?;
            if out.cancelled {
                return Err(cancelled_error());
            }
            Ok(out.assistant_message)
        }
    }
}

fn check_prompt(prompt: &str) -> Result<()> {
    if prompt.trim().is_empty() {
        return Err(AppError::validation("prompt is empty"));
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(AppError::validation("prompt too long"));
    }
    Ok(())
}

#[tauri::command]
pub async fn handout_llm_complete(
    prompt: String,
    json_mode: Option<bool>,
    request_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<String> {
    check_prompt(&prompt)?;
    let token = token_for(request_id.as_deref());
    let llm = state.llm_manager.clone();
    run_cancellable(token, async move {
        llm.call_model2_raw_prompt_opts(
            &prompt,
            json_mode.unwrap_or(false),
            crate::llm_usage::CallerType::Other("media_handout".to_string()),
            "media_handout",
        )
        .await
    })
    .await
}

#[tauri::command]
pub async fn handout_vlm_caption(
    prompt: String,
    image_base64: String,
    mime: Option<String>,
    request_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<String> {
    check_prompt(&prompt)?;
    if image_base64.is_empty() || image_base64.len() > MAX_FRAME_BASE64_LEN {
        return Err(AppError::validation("invalid frame image"));
    }
    let token = token_for(request_id.as_deref());
    let llm = state.llm_manager.clone();
    let config = crate::vlm_grounding_service::VlmGroundingService::new(llm.clone())
        .get_vlm_config()
        .await?;
    let payload = crate::llm_manager::ImagePayload {
        mime: mime.unwrap_or_else(|| "image/jpeg".to_string()),
        base64: image_base64,
    };
    run_cancellable(token, async move {
        llm.call_raw_prompt_with_config_id_and_images(
            &config.id,
            &prompt,
            vec![payload],
            crate::llm_usage::CallerType::Other("media_handout_vlm".to_string()),
        )
        .await
    })
    .await
}

#[tauri::command]
pub async fn handout_cancel(request_id: String) -> Result<()> {
    token_for(Some(&request_id)).cancel();
    Ok(())
}

#[tauri::command]
pub async fn handout_release(request_id: String) -> Result<()> {
    registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&request_id);
    Ok(())
}

/// 前端把笔记 Markdown 转成 DOCX spec；`image` 块可带 `src`（`notes_assets/…` 相对路径），
/// 由此处经 `get_image_as_base64`（限制在应用数据目录内）解析为 `data`。返回 DOCX 的 base64。
#[tauri::command]
pub async fn notes_export_docx(
    mut spec: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<String> {
    if let Some(blocks) = spec.get_mut("blocks").and_then(|v| v.as_array_mut()) {
        for block in blocks.iter_mut() {
            if block.get("type").and_then(|v| v.as_str()) != Some("image") {
                continue;
            }
            let has_data = block
                .get("data")
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.is_empty());
            if has_data {
                continue;
            }
            let Some(src) = block
                .get("src")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
            else {
                continue;
            };
            if src.starts_with("http://") || src.starts_with("https://") {
                continue; // 不联网取图：退化为占位文字
            }
            match state.file_manager.get_image_as_base64(&src).await {
                Ok(data_url) => {
                    block["data"] = serde_json::Value::String(data_url);
                }
                Err(e) => {
                    tracing::warn!("[notes_export_docx] image unavailable: {} ({})", src, e);
                }
            }
        }
    }
    let bytes = tokio::task::spawn_blocking(move || {
        crate::document_parser::DocumentParser::generate_docx_from_spec(&spec)
    })
    .await
    .map_err(|e| AppError::internal(format!("docx task failed: {}", e)))?
    .map_err(|e| AppError::internal(e.to_string()))?;
    Ok(general_purpose::STANDARD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancel_marks_shared_token() {
        let t = token_for(Some("run-a"));
        assert!(!t.is_cancelled());
        handout_cancel("run-a".into()).await.unwrap();
        assert!(t.is_cancelled());
        assert!(token_for(Some("run-a")).is_cancelled());
        handout_release("run-a".into()).await.unwrap();
        assert!(!token_for(Some("run-a")).is_cancelled());
        handout_release("run-a".into()).await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_token_short_circuits() {
        let t = CancellationToken::new();
        t.cancel();
        let r = run_cancellable(t, async {
            Ok(crate::models::StandardModel2Output {
                assistant_message: "x".into(),
                raw_response: None,
                chain_of_thought_details: None,
                cancelled: false,
            })
        })
        .await;
        assert!(r.is_err());
    }
}
