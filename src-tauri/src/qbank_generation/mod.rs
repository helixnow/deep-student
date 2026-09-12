/// 题目集 AI 出题模块 - 后台任务管线
///
/// 职责：
/// - 按参数（题量/题型分布/难度/知识点/参考资料）生成题目 JSON
/// - 逐题校验后落库为「任务结果」，前端通过全局任务事件 + 轮询取用
/// - 入库由前端确认后调用既有 qbank_batch_create_questions（source_type=ai_generated）
///
/// 2026-09-09 后台化改造（决策见 docs/dev/ai-qbank-generation-v3-plan-2026-09-08.md §三）：
/// - `qbank_ai_generate_questions` 立即返回 task_id，任务体用 `background_tasks::spawn` 执行
/// - 事件出口从窗口级 SSE 流改为全局 `qbank_generation_task_event`
/// - 任务状态与结果落 vfs.db 的 `qbank_generation_tasks` 表（关闭面板/重启可恢复）
///
/// 与 qbank_grading 的关系：复用相同的流式管线骨架（stream + ProviderAdapter + 取消机制），
/// 独立的任务表与事件命名空间。
pub mod events;
pub mod pipeline;
pub mod reference;
pub mod task_repo;
pub mod types;

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::llm_manager::LLMManager;
use crate::models::AppError;
use crate::vfs::database::VfsDatabase;
use task_repo::GenerationTaskView;
use types::QbankGenerationRequest;

/// 启动恢复：把中断的 queued/running 任务标记为 failed
///
/// 应用重启后旧任务已不可能继续执行，必须收敛，否则前端会一直显示「生成中」。
pub fn recover_interrupted_tasks(vfs_db: &VfsDatabase) {
    if let Err(e) = task_repo::recover_interrupted_tasks(vfs_db) {
        log::warn!("[QbankGeneration] 启动恢复中断任务失败: {}", e);
    }
}

/// 提交 AI 出题任务（立即返回任务视图，后台执行）
#[tauri::command]
pub async fn qbank_ai_generate_questions(
    request: QbankGenerationRequest,
    app: AppHandle,
    state: State<'_, crate::commands::AppState>,
) -> Result<GenerationTaskView, AppError> {
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::database("VFS 数据库未初始化".to_string()))?
        .clone();
    let llm = state.llm_manager.clone();

    let task_id = format!("task_{}", nanoid::nanoid!(10));
    let stream_event = format!("qbank_generation_stream_{}", request.stream_session_id);
    let request_json = serde_json::to_string(&request)
        .map_err(|e| AppError::validation(format!("序列化出题请求失败: {}", e)))?;

    let record = task_repo::create_task(
        &vfs_db,
        &task_id,
        &request.exam_id,
        &request_json,
        &stream_event,
    )
    .map_err(|e| AppError::database(e.to_string()))?;
    let view = GenerationTaskView::from(record);

    log::info!(
        "[QbankGeneration] 提交后台出题任务: id={}, exam={}, specs={}, max_questions={}",
        task_id,
        request.exam_id,
        request.specs.len(),
        request.max_questions
    );

    let app_handle = app.clone();
    let vfs_db_bg = vfs_db.clone();
    spawn_generation_task(app_handle, vfs_db_bg, llm, task_id, request, stream_event);

    Ok(view)
}

/// 启动后台出题任务（命令层与对话工具共用）
///
/// 用 `background_tasks::spawn` 追踪，保证应用退出时不会被静默杀死。
pub fn spawn_generation_task(
    app: AppHandle,
    vfs_db: Arc<VfsDatabase>,
    llm: Arc<LLMManager>,
    task_id: String,
    request: QbankGenerationRequest,
    stream_event: String,
) {
    crate::background_tasks::spawn(async move {
        execute_generation_task(app, vfs_db, llm, task_id, request, stream_event).await;
    });
}

/// 后台任务体：跑管线 → 写任务表 → 发全局事件 →（可选）系统通知
async fn execute_generation_task(
    app: AppHandle,
    vfs_db: Arc<VfsDatabase>,
    llm: Arc<LLMManager>,
    task_id: String,
    request: QbankGenerationRequest,
    _stream_event: String,
) {
    // 阶段计时：区分后台任务是否被调度、以及每段耗时
    // （安卓曾现后台任务提交后长时间无进度 → tokio 饿死 connection aborted）。
    let task_start = std::time::Instant::now();
    log::info!(
        "[QbankGeneration][task-exec] task body started: id={}",
        task_id
    );

    if let Err(e) = task_repo::mark_running(&vfs_db, &task_id) {
        log::warn!(
            "[QbankGeneration] 标记任务运行中失败: id={}, {}",
            task_id,
            e
        );
    }
    emit_current_task(&app, &vfs_db, &task_id);

    let exam_id = request.exam_id.clone();
    let deps = pipeline::QbankGenerationDeps {
        llm,
        vfs_db: vfs_db.clone(),
    };
    let result = pipeline::run_qbank_generation(request, deps).await;
    let pipeline_elapsed = task_start.elapsed();
    log::info!(
        "[QbankGeneration][task-exec] pipeline returned: id={} after {:.1}s, ok={}",
        task_id,
        pipeline_elapsed.as_secs_f32(),
        result.is_ok()
    );

    match result {
        Ok(Some(response)) => {
            if let Err(e) = task_repo::mark_completed(
                &vfs_db,
                &task_id,
                &response.drafts,
                response.rejected_count,
                &response.rejection_reasons,
                &response.skipped_references,
                response.used_reference_count,
            ) {
                log::error!(
                    "[QbankGeneration] 写任务完成状态失败: id={}, {}",
                    task_id,
                    e
                );
            }
        }
        Ok(None) => {
            // pipeline 内部已处理取消信号
            if let Err(e) = task_repo::mark_cancelled(&vfs_db, &task_id) {
                log::warn!("[QbankGeneration] 标记任务取消失败: id={}, {}", task_id, e);
            }
        }
        Err(e) => {
            if let Err(mark_err) = task_repo::mark_failed(&vfs_db, &task_id, &e.message) {
                log::error!(
                    "[QbankGeneration] 标记任务失败状态出错: id={}, {}",
                    task_id,
                    mark_err
                );
            }
        }
    }

    // 收尾事件：前端据此刷新任务卡片 / 弹出完成提示
    emit_current_task(&app, &vfs_db, &task_id);
    log::info!(
        "[QbankGeneration] 后台任务结束: id={}, exam={}, total={:.1}s",
        task_id,
        exam_id,
        task_start.elapsed().as_secs_f32()
    );
}

/// 读取任务当前状态并发全局事件
fn emit_current_task(app: &AppHandle, vfs_db: &VfsDatabase, task_id: &str) {
    match task_repo::get_task(vfs_db, task_id) {
        Ok(Some(record)) => events::emit_task_event(app, &GenerationTaskView::from(record)),
        Ok(None) => log::warn!("[QbankGeneration] 任务不存在，无法发事件: {}", task_id),
        Err(e) => log::warn!("[QbankGeneration] 读取任务失败: id={}, {}", task_id, e),
    }
}

/// 查询单个任务（轮询兜底 + 重开面板恢复用）
#[tauri::command]
pub async fn qbank_get_generation_task(
    task_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<Option<GenerationTaskView>, AppError> {
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::database("VFS 数据库未初始化".to_string()))?;
    task_repo::get_task(vfs_db, &task_id)
        .map(|opt| opt.map(GenerationTaskView::from))
        .map_err(|e| AppError::database(e.to_string()))
}

/// 列出题目集的任务（按创建时间倒序）
#[tauri::command]
pub async fn qbank_list_generation_tasks(
    exam_id: String,
    limit: Option<usize>,
    state: State<'_, crate::commands::AppState>,
) -> Result<Vec<GenerationTaskView>, AppError> {
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::database("VFS 数据库未初始化".to_string()))?;
    let limit = limit.unwrap_or(20).min(100);
    task_repo::list_tasks(vfs_db, &exam_id, limit)
        .map(|tasks| tasks.into_iter().map(GenerationTaskView::from).collect())
        .map_err(|e| AppError::database(e.to_string()))
}

/// 取消任务（向 LLM 流发取消信号，后台任务收尾后发 cancelled 事件）
#[tauri::command]
pub async fn qbank_cancel_generation_task(
    task_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<Option<GenerationTaskView>, AppError> {
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::database("VFS 数据库未初始化".to_string()))?;

    let Some(record) =
        task_repo::get_task(vfs_db, &task_id).map_err(|e| AppError::database(e.to_string()))?
    else {
        log::warn!("[QbankGeneration] 取消任务时任务不存在: {}", task_id);
        return Ok(None);
    };

    if record.status.is_terminal() {
        log::info!(
            "[QbankGeneration] 任务已处于终态，无需取消: id={}, status={}",
            task_id,
            record.status.as_str()
        );
        return Ok(Some(GenerationTaskView::from(record)));
    }

    log::info!(
        "[QbankGeneration] 请求取消任务: id={}, stream_event={}",
        task_id,
        record.stream_event
    );
    state
        .llm_manager
        .request_cancel_stream(&record.stream_event)
        .await;

    Ok(Some(GenerationTaskView::from(record)))
}
