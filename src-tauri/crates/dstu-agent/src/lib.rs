//! Deep Student Agent 层 crate（layer `agent`）。
//!
//! step 10 的目标：承载 chat_v2 编排引擎（pipeline、工具环、执行器框架、审批、工作区、
//! 技能等，约 174 个文件），文件保持 `chat_v2/` 下的原目录结构。38 个域执行器
//! （anki / qbank / notes / research / tutor / media / sync / memory / learning / vision）
//! 留在 app，经 `chat_v2::tools::roster::ExecutorRoster` 由 app 的
//! `agent_wiring::roster::AppExecutorRoster` 注入，分发顺序与拆分前逐字一致。
//!
//! 分层约束（scripts/check-crate-layers.mjs）：agent 不得依赖任何 `layer = "domain"` 的
//! crate；跨域回调走 dstu-kernel 的 `Slot` / `HookSet`，在 app 的 `extensions.rs` 注册。
//!
//! 当前为 P0 空骨架，尚未被 app 依赖；模块由 L5 搬入。
