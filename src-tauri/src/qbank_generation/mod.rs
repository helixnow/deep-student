/// 题目集 AI 出题模块 - 独立流式管线
///
/// 职责：
/// - 按参数（题量/题型分布/难度/知识点）流式生成题目 JSON
/// - 逐题校验后通过 complete 事件回传前端预览（不直接落库）
/// - 入库由前端确认后调用既有 qbank_batch_create_questions（source_type=ai_generated）
///
/// 与 qbank_grading 的关系：
/// - 复用相同的流式管线骨架（stream + ProviderAdapter + 取消机制）
/// - 独立的 Prompt 模板、JSON 校验与事件命名空间（qbank_generation_stream_）
pub mod events;
pub mod pipeline;
pub mod types;

use tauri::{State, Window};

use crate::models::AppError;
use events::QbankGenerationEmitter;
use types::{QbankGenerationRequest, QbankGenerationResponse};

/// 流式 AI 出题命令
#[tauri::command]
pub async fn qbank_ai_generate_questions(
    request: QbankGenerationRequest,
    window: Window,
    state: State<'_, crate::commands::AppState>,
) -> Result<Option<QbankGenerationResponse>, AppError> {
    log::info!(
        "[QbankGeneration] 开始 AI 出题：exam={}, specs={}",
        request.exam_id,
        request.specs.len()
    );

    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::database("VFS 数据库未初始化".to_string()))?;

    let deps = pipeline::QbankGenerationDeps {
        llm: state.llm_manager.clone(),
        vfs_db: vfs_db.clone(),
        emitter: QbankGenerationEmitter::new(window),
    };

    let result = pipeline::run_qbank_generation(request.clone(), deps).await?;

    if let Some(ref response) = result {
        log::info!(
            "[QbankGeneration] 出题完成：drafts={}, rejected={}",
            response.drafts.len(),
            response.rejected_count
        );
    } else {
        log::info!("[QbankGeneration] 用户取消出题：exam={}", request.exam_id);
    }

    Ok(result)
}

/// 取消 AI 出题
#[tauri::command]
pub async fn qbank_cancel_generation(
    stream_event_name: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<(), AppError> {
    log::info!("[QbankGeneration] 取消出题流: {}", stream_event_name);
    state
        .llm_manager
        .request_cancel_stream(&stream_event_name)
        .await;
    Ok(())
}
