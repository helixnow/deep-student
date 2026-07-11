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
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

type Result<T> = std::result::Result<T, AppError>;

fn build_fsrs_changed_payload(
    source: &str,
    action: &str,
    cards: &[(&str, &str)],
    fallback_entity_ids: &[String],
) -> Value {
    let entity_ids: Vec<&str> = if cards.is_empty() {
        fallback_entity_ids.iter().map(String::as_str).collect()
    } else {
        cards
            .iter()
            .map(|(_, anki_card_id)| *anki_card_id)
            .collect()
    };
    let card_state_ids: Vec<&str> = cards.iter().map(|(state_id, _)| *state_id).collect();
    let cards: Vec<Value> = cards
        .iter()
        .map(|(state_id, anki_card_id)| {
            json!({
                "id": state_id,
                "ankiCardId": anki_card_id,
            })
        })
        .collect();

    json!({
        "source": source,
        "action": action,
        "entityIds": entity_ids,
        "cardStateIds": card_state_ids,
        "cards": cards,
    })
}

/// R1-04：域事件载荷符合 DESIGN §5.6，并同时携带 Anki ID 与 FSRS state ID。
fn emit_fsrs_changed(
    app: &AppHandle,
    source: &str,
    action: &str,
    cards: &[(&str, &str)],
    fallback_entity_ids: &[String],
) {
    let payload = build_fsrs_changed_payload(source, action, cards, fallback_entity_ids);
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
    let cards: Vec<(&str, &str)> = result
        .states
        .iter()
        .map(|s| (s.id.as_str(), s.anki_card_id.as_str()))
        .collect();
    // 用户侧 invoke：source=user；若 states 为空则 entityIds 回落到传入的 Anki ID。
    emit_fsrs_changed(&app, "user", "enqueue", &cards, &ankiCardIds);
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
    let cards = [(
        result.card_state.id.as_str(),
        result.card_state.anki_card_id.as_str(),
    )];
    emit_fsrs_changed(&app, "user", "rate", &cards, &[]);
    Ok(result)
}

/// 获取 FSRS 统计
#[tauri::command]
pub async fn fsrs_get_stats(state: State<'_, AppState>) -> Result<FsrsStats> {
    let service = FsrsReviewService::new(state.anki_database.clone());
    service.get_stats()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changed_payload_keeps_anki_and_state_ids_distinct() {
        let payload =
            build_fsrs_changed_payload("user", "enqueue", &[("state-123", "anki-456")], &[]);

        assert_eq!(payload["entityIds"], json!(["anki-456"]));
        assert_eq!(payload["cardStateIds"], json!(["state-123"]));
        assert_eq!(
            payload["cards"],
            json!([{"id": "state-123", "ankiCardId": "anki-456"}])
        );
    }

    #[test]
    fn changed_payload_falls_back_to_requested_anki_ids_without_states() {
        let fallback = vec!["anki-missing-state".to_string()];
        let payload = build_fsrs_changed_payload("user", "enqueue", &[], &fallback);

        assert_eq!(payload["entityIds"], json!(["anki-missing-state"]));
        assert_eq!(payload["cardStateIds"], json!([]));
        assert_eq!(payload["cards"], json!([]));
    }
}
