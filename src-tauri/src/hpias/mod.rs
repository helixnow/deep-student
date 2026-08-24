//! HPIAS 深度研究后端模块（事件 emit + pipeline orchestrator）

pub mod events;
pub mod orchestrator;
pub mod payloads;
pub mod service;

pub use events::{HpiasEventEmitter, HPIAS_EVENT_CHANNEL};
pub use orchestrator::HpiasPipelineOrchestrator;
pub use payloads::{
    build_pipeline_timeline, extract_question_from_intent, intent_has_research_blocks,
};
pub use service::{
    create_research_backend, HpiasResearchBackend, HpiasResearchSessionRequest,
    StubHpiasResearchService,
};
