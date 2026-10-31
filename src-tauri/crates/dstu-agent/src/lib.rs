//! Deep Student Agent 层 crate（layer `agent`）。
//!
//! 承载 chat_v2 编排引擎（pipeline、工具环、执行器框架、审批、工作区、技能、命令处理器等），
//! 文件保持拆分前 `src/chat_v2/` 下的原目录结构。38 个域执行器文件
//! （anki / qbank / notes / research / tutor / media / sync / memory / learning / vision）
//! 与 `handlers/canvas_handlers.rs` 留在 app，经 `chat_v2::pipeline::ExecutorRoster` 由 app 的
//! `agent_wiring::roster::AppExecutorRoster` 注入，分发顺序与拆分前逐字一致。
//!
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致：app 的 `src/chat_v2/mod.rs`、
//! `src/chat_v2/tools/mod.rs`、`src/chat_v2/handlers/mod.rs` 三个门面以
//! `pub use dstu_agent::chat_v2::…::*;` 重导出，`generate_handler!` 路径不变。
//!
//! 分层约束（scripts/check-crate-layers.mjs）：agent 不得依赖任何 `layer = "domain"` 的
//! crate，也不得引用 app（`AppState` 等）；跨域回调走 dstu-kernel 的 `Slot` / `HookSet`，
//! 在 app 的 `extensions.rs` 注册。

// 大型 json! 审计块（local shell 工具结果等）需要更深的宏展开余量（与 app 一致）。
#![recursion_limit = "512"]

pub mod chat_v2; // Chat V2 - 新版聊天后端模块（基于 Block 架构）
pub mod system_notification; // 统一系统通知策略（automations / kill_switch 与 app 启动路径共用）

// 拆分前这些模块通过 `crate::X` 引用低层 crate 的模块（app lib.rs 的 `pub use dstu_x::y;`），
// 这里保留原路径，使搬过来的文件里的 `crate::<module>` 不需要改写。
pub(crate) use dstu_core::{canonical_tools, models, prompt_contracts, text_escape, token_source};
pub(crate) use dstu_docs::document_parser;
pub(crate) use dstu_llm::{llm_manager, ocr_adapters};
#[cfg(feature = "mcp")]
pub(crate) use dstu_mcp::mcp;
pub(crate) use dstu_mcp::tools;
pub(crate) use dstu_memory::memory;
pub(crate) use dstu_platform::background_tasks;
pub(crate) use dstu_security::secure_store;
pub(crate) use dstu_storage::{
    backup_common, database, feature_flags, file_manager, injection_budget, llm_usage,
    unified_file_manager,
};
pub(crate) use dstu_util::utils;
pub(crate) use dstu_vfs::{dstu, pdf_protocol, vfs};

/// 与 app `browser` 模块的 `policy`（= `dstu_core::net_policy` 重导出）对应：
/// SSRF 判定正源，`fetch_executor` / `mcp_propose_executor` 按原路径 `crate::browser::policy` 引用。
pub(crate) mod browser {
    pub(crate) use dstu_core::net_policy as policy;
}

/// 与 app `data_governance` 模块里的 `pub use dstu_storage::{…}` 对应（同样按
/// `data_governance` feature 门控）：`workspace/database.rs` 的 `file_deletion_queue`
/// 与各单测的 `migration::coordinator` / `schema_registry` 按原路径引用。
#[cfg(feature = "data_governance")]
pub(crate) mod data_governance {
    pub(crate) use dstu_storage::{file_deletion_queue, migration, schema_registry};
}

// ── app `AppHandle`（由 app `lib.rs` 在 `set_global_app_handle` 旁边注入）──
//
// 本 crate 不能反向依赖 app 的 `get_global_app_handle()`。pipeline（托管 Lance store）、
// finalizer、prompt_builder、skills 四处统一读这里的句柄；注入时机与旧全局句柄完全相同。
static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// 保存 app 的 `AppHandle`（幂等：先设置者生效，与旧全局句柄一致）。
pub fn set_app_handle(handle: tauri::AppHandle) {
    let _ = APP_HANDLE.set(handle);
}

/// 读取 app 的 `AppHandle`；未设置时为 `None`（等价旧 `crate::get_global_app_handle()`，
/// 保留原名使搬过来的调用点不需要改写）。
pub(crate) fn get_global_app_handle() -> Option<&'static tauri::AppHandle> {
    APP_HANDLE.get()
}
