//! 掌握度中间层（A-P0 / A-P1）
//!
//! append-only `mastery_events` + 聚合 `mastery_states`，
//! 将题库 / FSRS 成绩确定性回流到 learner_profile.weak_points，
//! 并对 FSRS 调度做有界应用层 due 偏置（见 [`bias`]）。

pub mod bias;
pub mod service;
pub mod types;

pub use bias::{
    apply_mastery_due_bias, mastery_due_bias_delta_ms, mastery_queue_priority_key,
    MAX_ADVANCE_FRAC, MAX_ADVANCE_MS, MAX_DELAY_FRAC, MAX_DELAY_MS, MIN_BIASABLE_INTERVAL_MS,
};
pub use service::MasteryService;
pub use types::{
    MasteryEvent, MasteryOutcome, MasteryOverviewSummary, MasteryPriorityReviewItem, MasterySource,
    MasteryState, MasteryWeakEvidence,
};
