/// 题目集 AI 评判模块 - 独立流式管线
///
/// 职责：
/// - 主观题：自动流式 AI 评判（判定正误 + 评分 + 反馈）
/// - 客观题：手动触发 AI 解析（解题思路 + 知识点分析）
///
/// 与 essay_grading 的关系：
/// - 复用相同的流式管线骨架（stream_grade + ProviderAdapter + 取消机制）
/// - 独立的 Prompt 模板和结果解析逻辑
/// - 独立的事件名命名空间（qbank_grading_stream_）
pub mod events;
pub mod pipeline;
pub mod types;

use tauri::{State, Window};

use crate::models::AppError;
use events::QbankGradingEmitter;
use types::{QbankGradingRequest, QbankGradingResponse};

/// 流式 AI 评判命令
#[tauri::command]
pub async fn qbank_ai_grade(
    request: QbankGradingRequest,
    window: Window,
    state: State<'_, crate::commands::AppState>,
) -> Result<Option<QbankGradingResponse>, AppError> {
    log::info!(
        "[QbankGrading] 开始 AI 评判：question={}, mode={:?}",
        request.question_id,
        request.mode
    );

    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::database("VFS 数据库未初始化".to_string()))?;

    let deps = pipeline::QbankGradingDeps {
        llm: state.llm_manager.clone(),
        vfs_db: vfs_db.clone(),
        emitter: QbankGradingEmitter::new(window),
    };

    let result = pipeline::run_qbank_grading(request.clone(), deps).await?;

    if let Some(ref response) = result {
        log::info!(
            "[QbankGrading] 评判完成：verdict={:?}, score={:?}",
            response.verdict,
            response.score
        );
    } else {
        log::info!(
            "[QbankGrading] 用户取消评判：question={}",
            request.question_id
        );
    }

    Ok(result)
}

/// 取消 AI 评判
#[tauri::command]
pub async fn qbank_cancel_grading(
    stream_event_name: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<(), AppError> {
    log::info!("[QbankGrading] 取消评判流: {}", stream_event_name);
    state
        .llm_manager
        .request_cancel_stream(&stream_event_name)
        .await;
    Ok(())
}
