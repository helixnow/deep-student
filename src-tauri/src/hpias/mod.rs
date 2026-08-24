//! HPIAS 深度研究后端模块（事件 emit + 未来 pipeline 扩展点）

pub mod events;

pub use events::{HpiasEventEmitter, HPIAS_EVENT_CHANNEL};
