//! FSRS 闪卡复习 Tauri 命令（M2）
//!
//! 参数使用 camelCase，与前端约定一致。
//!
//! R1-04 / docs/dev/acr：写操作成功后 emit `fsrs://changed`（DESIGN §5.6）。

use crate::commands::AppState;
use crate::fsrs_review_service::{
    FsrsDueCard, FsrsEnqueueResult, FsrsRateResult, FsrsReviewService, FsrsStats,
};
use crate::models::AppError;
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

type Result<T> = std::result::Result<T, AppError>;

/// R1-04：域事件载荷符合 DESIGN §5.6
fn emit_fsrs_changed(app: &AppHandle, source: &str, action: &str, entity_ids: &[String]) {
    let payload = json!({
        "source": source,
        "action": action,
        "entityIds": entity_ids,
    });
    if let Err(e) = app.emit("fsrs://changed", payload) {
        log::debug!("[fsrs_review] Failed to emit fsrs://changed: {}", e);
    }
}

/// 将 anki 卡片入队到 FSRS 调度
#[tauri::command]
#[allow(non_snake_case)]
pub async fn fsrs_enqueue_cards(
    app: AppHandle,
    ankiCardIds: Vec<String>,
    state: State<'_, AppState>,
) -> Result<FsrsEnqueueResult> {
    // FSRS 表在 mistakes/anki 库，必须用 anki_database
    let service = FsrsReviewService::new(state.anki_database.clone());
    let result = service.enqueue_cards(&ankiCardIds)?;
    let entity_ids: Vec<String> = result
        .states
        .iter()
        .map(|s| s.anki_card_id.clone())
        .collect();
    // 用户侧 invoke：source=user；若 states 为空则回落传入的 ankiCardIds
    let ids = if entity_ids.is_empty() {
        ankiCardIds
    } else {
        entity_ids
    };
    emit_fsrs_changed(&app, "user", "enqueue", &ids);
    Ok(result)
}

/// 获取到期卡片
#[tauri::command]
pub async fn fsrs_get_due(
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<FsrsDueCard>> {
    let service = FsrsReviewService::new(state.anki_database.clone());
    service.get_due(limit)
}

/// 对卡片评分（写 state + log 事务）
#[tauri::command]
#[allow(non_snake_case)]
pub async fn fsrs_rate(
    app: AppHandle,
    cardStateId: String,
    rating: u8,
    durationMs: Option<i64>,
    state: State<'_, AppState>,
) -> Result<FsrsRateResult> {
    let service = FsrsReviewService::new(state.anki_database.clone());
    let result = service.rate(&cardStateId, rating, durationMs)?;
    emit_fsrs_changed(
        &app,
        "user",
        "rate",
        &[result.card_state.anki_card_id.clone()],
    );
    Ok(result)
}

/// 获取 FSRS 统计
#[tauri::command]
pub async fn fsrs_get_stats(state: State<'_, AppState>) -> Result<FsrsStats> {
    let service = FsrsReviewService::new(state.anki_database.clone());
    service.get_stats()
}
