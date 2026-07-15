//! FSRS 闪卡复习 Tauri 命令（M2）
//!
//! 参数使用 camelCase，与前端约定一致。
//!
//! R1-04 / docs/dev/acr：写操作成功后 emit `fsrs://changed`（DESIGN §5.6）。

use crate::commands::AppState;
use crate::fsrs_review_service::{
    FsrsDueCard, FsrsEnqueueResult, FsrsEnqueuedCard, FsrsRateResult, FsrsReviewService, FsrsStats,
    FsrsSuspendResult, FsrsUndoResult,
};
use crate::models::AppError;
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

type Result<T> = std::result::Result<T, AppError>;

fn build_fsrs_changed_payload_after_write(
    did_write: bool,
    source: &str,
    action: &str,
    cards: &[(&str, &str)],
    fallback_entity_ids: &[String],
) -> Option<Value> {
    if !did_write {
        return None;
    }

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

    Some(json!({
        "source": source,
        "action": action,
        "entityIds": entity_ids,
        "cardStateIds": card_state_ids,
        "cards": cards,
    }))
}

/// R1-04：域事件载荷符合 DESIGN §5.6，并同时携带 Anki ID 与 FSRS state ID。
fn emit_fsrs_changed(
    app: &AppHandle,
    did_write: bool,
    source: &str,
    action: &str,
    cards: &[(&str, &str)],
    fallback_entity_ids: &[String],
) {
    let Some(payload) = build_fsrs_changed_payload_after_write(
        did_write,
        source,
        action,
        cards,
        fallback_entity_ids,
    ) else {
        return;
    };
    if let Err(e) = app.emit("fsrs://changed", payload) {
        log::debug!("[fsrs_review] Failed to emit fsrs://changed: {}", e);
    }
}

fn build_fsrs_enqueue_changed_payload(
    result: &FsrsEnqueueResult,
    loaded_cards: &[FsrsEnqueuedCard],
    source: &str,
) -> Option<Value> {
    if result.enqueued_state_ids.is_empty() {
        return None;
    }

    let cards_by_state_id: HashMap<&str, &FsrsEnqueuedCard> = loaded_cards
        .iter()
        .map(|card| (card.id.as_str(), card))
        .collect();
    let cards: Option<Vec<&FsrsEnqueuedCard>> = result
        .enqueued_state_ids
        .iter()
        .map(|state_id| cards_by_state_id.get(state_id.as_str()).copied())
        .collect();
    let cards = cards?;
    let entity_ids: Vec<&str> = cards
        .iter()
        .map(|card| card.anki_card_id.as_str())
        .collect();
    let card_state_ids: Vec<&str> = cards.iter().map(|card| card.id.as_str()).collect();

    Some(json!({
        "source": source,
        "action": "enqueue",
        "entityIds": entity_ids,
        "cardStateIds": card_state_ids,
        "cards": cards,
    }))
}

fn emit_fsrs_enqueue_changed(
    app: &AppHandle,
    service: &FsrsReviewService,
    result: &FsrsEnqueueResult,
) {
    let loaded_cards = match service.get_enqueued_cards(result) {
        Ok(cards) => cards,
        Err(error) => {
            log::debug!(
                "[fsrs_review] Failed to load newly enqueued cards for fsrs://changed: {}",
                error
            );
            return;
        }
    };
    let Some(payload) = build_fsrs_enqueue_changed_payload(result, &loaded_cards, "user") else {
        return;
    };
    if let Err(error) = app.emit("fsrs://changed", payload) {
        log::debug!("[fsrs_review] Failed to emit fsrs://changed: {}", error);
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
    emit_fsrs_enqueue_changed(&app, &service, &result);
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
    emit_fsrs_changed(&app, true, "user", "rate", &cards, &[]);
    Ok(result)
}

/// 撤销调用方确认仍为最新的一次评分。
#[tauri::command]
#[allow(non_snake_case)]
pub async fn fsrs_undo_last_review(
    app: AppHandle,
    expectedLogId: String,
    cardStateId: String,
    state: State<'_, AppState>,
) -> Result<FsrsUndoResult> {
    let service = FsrsReviewService::new(state.anki_database.clone());
    let result = service.undo_last_review(&expectedLogId, &cardStateId)?;
    let cards = [(result.state.id.as_str(), result.state.anki_card_id.as_str())];
    emit_fsrs_changed(&app, result.changed, "user", "undo", &cards, &[]);
    Ok(result)
}

/// 暂停一张 FSRS 卡片。重复暂停为无写入的成功结果。
#[tauri::command]
#[allow(non_snake_case)]
pub async fn fsrs_suspend_card(
    app: AppHandle,
    cardStateId: String,
    state: State<'_, AppState>,
) -> Result<FsrsSuspendResult> {
    let service = FsrsReviewService::new(state.anki_database.clone());
    let result = service.suspend_card(&cardStateId)?;
    let cards = [(result.state.id.as_str(), result.state.anki_card_id.as_str())];
    emit_fsrs_changed(&app, result.changed, "user", "suspend", &cards, &[]);
    Ok(result)
}

/// 恢复一张已暂停的 FSRS 卡片。重复恢复为无写入的成功结果。
#[tauri::command]
#[allow(non_snake_case)]
pub async fn fsrs_unsuspend_card(
    app: AppHandle,
    cardStateId: String,
    state: State<'_, AppState>,
) -> Result<FsrsSuspendResult> {
    let service = FsrsReviewService::new(state.anki_database.clone());
    let result = service.unsuspend_card(&cardStateId)?;
    let cards = [(result.state.id.as_str(), result.state.anki_card_id.as_str())];
    emit_fsrs_changed(&app, result.changed, "user", "unsuspend", &cards, &[]);
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
        let payload = build_fsrs_changed_payload_after_write(
            true,
            "user",
            "enqueue",
            &[("state-123", "anki-456")],
            &[],
        )
        .expect("write emits");

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
        let payload =
            build_fsrs_changed_payload_after_write(true, "user", "enqueue", &[], &fallback)
                .expect("write emits");

        assert_eq!(payload["entityIds"], json!(["anki-missing-state"]));
        assert_eq!(payload["cardStateIds"], json!([]));
        assert_eq!(payload["cards"], json!([]));
    }

    #[test]
    fn changed_payload_is_suppressed_without_a_write() {
        let fallback = vec!["anki-skipped".to_string()];
        assert!(
            build_fsrs_changed_payload_after_write(false, "user", "enqueue", &[], &fallback,)
                .is_none()
        );
    }

    #[test]
    fn enqueue_changed_payload_contains_only_new_state_with_card_content() {
        let result = FsrsEnqueueResult {
            enqueued: 1,
            skipped: 1,
            enqueued_state_ids: vec!["state-new".to_string()],
            // The command still returns the full mixed batch to its caller.
            states: Vec::new(),
            review_cards: Vec::new(),
        };
        let loaded_cards = vec![
            FsrsEnqueuedCard {
                id: "state-skipped".to_string(),
                anki_card_id: "anki-skipped".to_string(),
                front: "old front".to_string(),
                back: "old back".to_string(),
                tags: vec!["old".to_string()],
                text: None,
                template_id: None,
                extra_fields: HashMap::new(),
                images: Vec::new(),
                is_error_card: false,
                error_content: None,
            },
            FsrsEnqueuedCard {
                id: "state-new".to_string(),
                anki_card_id: "anki-new".to_string(),
                front: "new front".to_string(),
                back: "new back".to_string(),
                tags: vec!["new".to_string()],
                text: None,
                template_id: None,
                extra_fields: HashMap::new(),
                images: Vec::new(),
                is_error_card: false,
                error_content: None,
            },
        ];

        let payload = build_fsrs_enqueue_changed_payload(&result, &loaded_cards, "user")
            .expect("mixed enqueue emits its new state");
        assert_eq!(payload["entityIds"], json!(["anki-new"]));
        assert_eq!(payload["cardStateIds"], json!(["state-new"]));
        assert_eq!(
            payload["cards"],
            json!([{
                "id": "state-new",
                "ankiCardId": "anki-new",
                "front": "new front",
                "back": "new back",
                "tags": ["new"],
                "extraFields": {},
                "images": [],
                "isErrorCard": false
            }])
        );
        assert!(!payload["cards"][0]["front"]
            .as_str()
            .expect("front text")
            .is_empty());
        assert!(!payload["cards"][0]["back"]
            .as_str()
            .expect("back text")
            .is_empty());

        let skipped_only = FsrsEnqueueResult {
            enqueued: 0,
            skipped: 1,
            enqueued_state_ids: Vec::new(),
            states: Vec::new(),
            review_cards: loaded_cards.clone(),
        };
        assert!(build_fsrs_enqueue_changed_payload(&skipped_only, &loaded_cards, "user").is_none());
    }
}
