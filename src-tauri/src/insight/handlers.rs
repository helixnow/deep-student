//! 灵感卡 Tauri 命令层

use tauri::State;

use crate::commands::AppState;
use crate::models::AppError;

use super::service::InsightService;
use super::types::*;

type Result<T> = std::result::Result<T, AppError>;

fn make_service(state: &AppState) -> Result<InsightService> {
    let vfs = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::database("VFS 数据库未初始化"))?;
    Ok(InsightService::new(vfs.clone()))
}

/// 创建灵感卡草稿（采集入口：用户主动沉淀 / 引导提取 / AI 草稿）
#[tauri::command]
pub async fn insight_create_draft(
    input: InsightDraftInput,
    state: State<'_, AppState>,
) -> Result<InsightCard> {
    make_service(&state)?.create_draft(input)
}

/// 确认认领（可附带编辑，编辑产生新 revision）
#[tauri::command]
pub async fn insight_confirm(
    insight_id: String,
    edits: Option<InsightCorrectInput>,
    state: State<'_, AppState>,
) -> Result<InsightCard> {
    make_service(&state)?.confirm(&insight_id, edits)
}

/// 纠正（新 revision；派生原则进复审队列）
#[tauri::command]
pub async fn insight_correct(
    insight_id: String,
    input: InsightCorrectInput,
    state: State<'_, AppState>,
) -> Result<InsightCard> {
    make_service(&state)?.correct(&insight_id, input)
}

/// 删除（墓碑 + 派生传播，不物理删除）
#[tauri::command]
pub async fn insight_delete(insight_id: String, state: State<'_, AppState>) -> Result<()> {
    make_service(&state)?.delete(&insight_id)
}

/// 单卡详情（含当前修订）
#[tauri::command]
pub async fn insight_get(
    insight_id: String,
    state: State<'_, AppState>,
) -> Result<Option<InsightCard>> {
    make_service(&state)?.get_insight(&insight_id)
}

/// 列表（浏览）
#[tauri::command]
pub async fn insight_list(
    status: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<InsightCard>> {
    make_service(&state)?.list_insights(
        status.as_deref(),
        limit.unwrap_or(100),
        offset.unwrap_or(0),
    )
}

#[tauri::command]
pub async fn insight_list_revisions(
    insight_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<InsightRevision>> {
    make_service(&state)?.list_revisions(&insight_id)
}

#[tauri::command]
pub async fn insight_list_evidence(
    insight_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<InsightEvidence>> {
    make_service(&state)?.list_evidence(&insight_id)
}

#[tauri::command]
pub async fn insight_list_relations(
    insight_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<InsightRelation>> {
    make_service(&state)?.list_relations(&insight_id)
}

#[tauri::command]
pub async fn insight_list_events(
    insight_id: String,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<InsightEvent>> {
    make_service(&state)?.list_events(&insight_id, limit.unwrap_or(50))
}

/// 反馈（有用/没用/不适用——三本账分列）
#[tauri::command]
pub async fn insight_record_feedback(
    insight_id: String,
    feedback: String,
    session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    make_service(&state)?.record_feedback(&insight_id, &feedback, session_id.as_deref())
}

/// 建立关系（v1 手动边：同方法/同错因/反例）
#[tauri::command]
pub async fn insight_add_relation(
    from_id: String,
    to_id: String,
    relation_type: String,
    scope: Option<String>,
    evidence: Option<String>,
    state: State<'_, AppState>,
) -> Result<String> {
    make_service(&state)?.add_relation(
        &from_id,
        &to_id,
        &relation_type,
        scope.as_deref(),
        evidence.as_deref(),
    )
}

/// 运行一批巩固任务（阶段三：闲时 worker 入口；前端在确认/纠正后或空闲时调用）
#[tauri::command]
pub async fn insight_run_jobs(batch_size: Option<u32>, state: State<'_, AppState>) -> Result<u32> {
    let vfs = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::database("VFS 数据库未初始化"))?;
    let worker = super::jobs::InsightJobWorker::new(vfs.clone(), Some(state.anki_database.clone()));
    let processed = worker.run_once(batch_size.unwrap_or(5) as usize, &|| true)?;
    Ok(processed as u32)
}
