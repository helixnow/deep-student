//! Insight Recall v2 —— 灵感库（阶段一：可信记录）
//!
//! 设计规格：docs/dev/insight-recall/README.md
//!
//! 边界纪律：
//! - 灵感卡不进入记忆根文件夹子树（存储隔离，防记忆注入绕过披露阶梯）；
//! - 已认领灵感不被任何自动演化路径改写；
//! - 删除走墓碑 + 派生传播，永不自动物理删除。

pub mod disclosure;
pub mod handlers;
pub mod jobs;
pub mod recall;
pub mod repo;
pub mod service;
pub mod types;

pub use disclosure::{DisclosureOutcome, DisclosurePolicy, SilenceReason};
pub use jobs::InsightJobWorker;
pub use recall::{InsightRecallService, RecallCandidate};
pub use service::InsightService;
pub use types::{
    DisclosureLevel, EvidenceKind, InsightCard, InsightCorrectInput, InsightDraftInput,
    InsightEvent, InsightEventType, InsightEvidence, InsightEvidenceInput, InsightOwnership,
    InsightRelation, InsightRevision, InsightStatus, RelationType, VerificationState,
};

#[cfg(test)]
mod tests;
