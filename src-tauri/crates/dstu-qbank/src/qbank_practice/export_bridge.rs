use std::collections::HashMap;
use std::sync::LazyLock;

use base64::Engine;
use serde::Serialize;
use tauri::{Emitter, Manager};
use tokio::sync::{oneshot, Mutex};

use crate::models::AppError;
use crate::question_bank_service::GeneratedPaper;

struct PendingExport {
    title: String,
    format: String,
    sender: oneshot::Sender<Result<String, String>>,
}
static EXPORTS: LazyLock<Mutex<HashMap<String, PendingExport>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Serialize)]
struct ExportRequest {
    request_id: String,
    paper: GeneratedPaper,
    format: String,
    include_answers: bool,
    include_explanations: bool,
}

pub async fn export_for_tool(
    window: &tauri::Window,
    paper: &GeneratedPaper,
    format: &str,
    include_answers: bool,
    include_explanations: bool,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    EXPORTS.lock().await.insert(
        id.clone(),
        PendingExport {
            title: paper.title.clone(),
            format: format.to_string(),
            sender,
        },
    );
    if let Err(error) = window.emit(
        "qbank-export-paper",
        ExportRequest {
            request_id: id.clone(),
            paper: paper.clone(),
            format: format.to_string(),
            include_answers,
            include_explanations,
        },
    ) {
        EXPORTS.lock().await.remove(&id);
        return Err(format!("Paper export surface unavailable: {error}"));
    }
    let result = tokio::time::timeout(std::time::Duration::from_secs(120), receiver).await;
    EXPORTS.lock().await.remove(&id);
    result
        .map_err(|_| "Paper export timed out; no file was reported as created".to_string())?
        .map_err(|_| "Paper export was interrupted".to_string())?
}

#[tauri::command]
pub async fn qbank_complete_paper_export(
    request_id: String,
    data: Option<String>,
    error: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let Some(pending) = EXPORTS.lock().await.remove(&request_id) else {
        return Err(AppError::validation("Export request expired"));
    };
    let result = (|| -> Result<String, String> {
        if let Some(error) = error {
            return Err(error);
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.as_deref().unwrap_or_default())
            .map_err(|e| e.to_string())?;
        let extension = match pending.format.as_str() {
            "pdf" if bytes.starts_with(b"%PDF-") => "pdf",
            "word" if bytes.starts_with(b"PK") => "docx",
            "markdown" if !bytes.is_empty() && std::str::from_utf8(&bytes).is_ok() => "md",
            _ => return Err("Invalid generated paper file".into()),
        };
        let title: String = pending
            .title
            .chars()
            .map(|c| {
                if c.is_control() || "\\/:*?\"<>|".contains(c) {
                    '_'
                } else {
                    c
                }
            })
            .take(80)
            .collect();
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("exports")
            .join("qbank");
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let path = directory.join(format!("{title}-{request_id}.{extension}"));
        let temp = path.with_extension("tmp");
        std::fs::write(&temp, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, &path).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().to_string())
    })();
    let _ = pending.sender.send(result);
    Ok(())
}
