//! Agent 组装层（step 10）：app 向 chat_v2 编排引擎注入域能力的唯一位置。
//!
//! chat_v2 pipeline（将搬入 dstu-agent）不再直接引用域执行器与域服务，而是由这里组装：
//! - [`roster`]：生产执行器花名册 `AppExecutorRoster`（`ChatV2Pipeline::with_executor_roster`）
//!   与启动期花名册自检；
//! - [`services`]：pipeline / `ExecutionContext` 的 `Services` 容器（NotesManager、
//!   QuestionBankService）；
//! - [`plugins`]：Canvas 笔记读取口与 Insight 被动提示等域能力实现（槽位型能力由
//!   `extensions.rs` 组合根注册）。
//!
//! app 只做组装与注册，不在这里写业务逻辑。

// `roster.rs` 的花名册函数体逐字搬自 `chat_v2/pipeline.rs`，其中的
// `super::tools::…` / `super::skill_market_client::…` 路径经这里的私有导入解析。
use crate::chat_v2::{skill_market_client, tools};

pub mod plugins;
pub mod roster;
pub mod services;

#[cfg(test)]
mod tests;
