//! 掌握度中间层（A-P0 / A-P1）
//!
//! append-only `mastery_events` + 聚合 `mastery_states`，
//! 将题库 / FSRS 成绩确定性回流到 learner_profile.weak_points，
//! 并对 FSRS 调度做有界应用层 due 偏置（见 [`bias`]）。

pub mod bias;
pub mod service;
pub mod types;

pub use bias::{
    apply_mastery_due_bias, mastery_due_bias_delta_ms, mastery_queue_priority_key, queue_sort_key,
    MAX_ADVANCE_FRAC, MAX_ADVANCE_MS, MAX_DELAY_FRAC, MAX_DELAY_MS, MIN_BIASABLE_INTERVAL_MS,
};
pub use service::MasteryService;
pub use types::{
    MasteryEvent, MasteryOutcome, MasteryOverviewSummary, MasteryPriorityReviewItem, MasterySource,
    MasteryState, MasteryWeakEvidence,
};


/// 学习者可见的掌握度概览（此前掌握度只供 AI 读取，学习者看不到自己的薄弱知识点）。
#[tauri::command]
pub async fn mastery_get_overview(
    limit: Option<u32>,
    vfs_db: tauri::State<'_, std::sync::Arc<crate::vfs::database::VfsDatabase>>,
) -> Result<types::MasteryOverviewSummary, String> {
    service::MasteryService::new(vfs_db.inner().clone())
        .overview_summary(limit.unwrap_or(6).clamp(1, 30) as usize)
        .map_err(|e| e.to_string())
}
