//! legacy 回退注入（模型不支持工具调用）时使用的 web_search 调用点。
//!
//! 实现位于上层 `tools` 模块（它依赖 llm_manager，llm_manager 不能反向引用它），
//! 由 `tools::install_web_search_fallback()` 注册：`extensions::register_extensions()`
//! 的 `WebSearchFallbackPlugin` 在 `run()` 第一行安装；`ChatV2Pipeline::new` 也会调用
//! （幂等），覆盖直接构造流水线的测试。
//!
//! 注册机制是 `dstu-kernel` 的单提供方 [`Slot`]（替代原 `OnceLock<WebSearchFallbackFn>`）：
//! 先注册者生效，`Disposer` 由注册方持有。

use crate::database::Database;
use crate::models::RagSourceInfo;
use dstu_kernel::{Disposer, Slot, SlotOccupied};
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// 与 `tools::Tool::invoke` 相同的返回：(成功, 数据, 错误, 用量, 引用, 注入文本)
pub type WebSearchToolResult = (
    bool,
    Option<Value>,
    Option<String>,
    Option<Value>,
    Option<Vec<RagSourceInfo>>,
    Option<String>,
);

/// 回退注入调用 web_search 所需的上下文
pub struct WebSearchFallbackRequest<'a> {
    pub db: &'a Database,
    pub window: Option<&'a tauri::Window>,
    pub stream_event: &'a str,
    pub memory_enabled: Option<bool>,
    pub args: &'a Value,
}

/// web_search 回退实现（原 `WebSearchFallbackFn` 函数指针的 trait 化）。
pub trait WebSearchFallback: Send + Sync {
    fn call<'a>(
        &'a self,
        req: WebSearchFallbackRequest<'a>,
    ) -> Pin<Box<dyn Future<Output = WebSearchToolResult> + Send + 'a>>;
}

static WEB_SEARCH_FALLBACK: Slot<dyn WebSearchFallback> = Slot::new();

/// 注册 web_search 实现（幂等：只有第一次注册生效）。
///
/// 返回的 `Disposer` 必须由注册方持有（插件 `Scope` 或 `tools` 的进程级
/// `OnceLock`）；立即丢弃会立刻注销。
pub fn register_web_search_fallback(
    fallback: Arc<dyn WebSearchFallback>,
) -> Result<Disposer, SlotOccupied> {
    WEB_SEARCH_FALLBACK.provide(fallback)
}

pub(crate) fn registered_web_search_fallback() -> Option<Arc<dyn WebSearchFallback>> {
    WEB_SEARCH_FALLBACK.get()
}
